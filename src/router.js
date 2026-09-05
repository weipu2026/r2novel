/**
 * r2novel — 共享路由核心（Worker 与本地 dev-server 共用）
 *
 * 所有数据都走 /api/* + 会话 Cookie 鉴权；R2/文件系统只由外层适配。
 *
 * R2 key 布局：
 *   meta/index.json          书架摘要（在架书，含 pinned / 进度镜像 prog）
 *   meta/index.json.bak      发布/软删/恢复前自动备份
 *   meta/trash.json          回收站（软删书，15 天惰性清理）
 *   meta/<bookId>.json       单书元数据（章节目录表）
 *   text/<bookId>/<key>.txt  清洗后正文章节
 *   raw/<bookId>.txt         上传原件（留档 / 重洗）
 *   progress/<bookId>.json   阅读进度 {ch, ratio, updatedAt}
 *
 * store 接口（外层注入）：
 *   getText(key) -> string|null    putText(key, str)
 *   getBytes(key) -> Uint8Array|null   putBytes(key, bytes)
 *   openRead(key) -> ReadableStream|null   按 key 打开字节流（整本导出流式拼章用）
 *   delete(key)
 *
 * 子请求预算纪律（Workers Free 单请求 ≤50 个子请求）：
 *   - publish 只抽样 3 章校验，字数信任客户端 cleaner 统计，绝不逐章回读统计；
 *   - 彻底删除单批 ≤40 章，剩余 keys 存 trash 条目 purge 字段，客户端续调直至 done。
 */

const SESSION_COOKIE = 'rn_session';
const TRASH_DAYS = 15; // 回收站保留天数（惰性清理，无 cron）

export const KEY = {
  INDEX: 'meta/index.json',
  INDEX_BAK: 'meta/index.json.bak',
  TRASH: 'meta/trash.json',
  BRUTE: 'meta/sec/brute.json',
  book: (id) => `meta/${id}.json`,
  text: (id, key) => `text/${id}/${key}.txt`,
  raw: (id) => `raw/${id}.txt`,
  progress: (id) => `progress/${id}.json`,
};

/* ---------------- 基础工具（对齐 r2book 的健壮做法） ---------------- */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const notFound = () => new Response('Not Found', { status: 404 });

async function dropBody(req) {
  try {
    if (req.body && !req.bodyUsed) await req.arrayBuffer();
  } catch {
    /* 流异常忽略 */
  }
}

const enc = new TextEncoder();

/** XML 转义（OPDS Atom feed：书名/作者/标签/章节标题都可能是任意文本） */
const escXml = (s) =>
  String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** 恒时比较：长度差也进累积值、无提前退出，不泄露口令/签名长度 */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  const n = Math.max(x.length, y.length);
  let d = x.length ^ y.length;
  for (let i = 0; i < n; i++) d |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return d === 0;
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b + '==='.slice((b.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('x-forwarded-for') || 'unknown';
}

/* ---------------- 防爆破（R2 持久化：跨 isolate/重启有效；指数退避防长期锁死） ----------------
 * 计数按客户端 IP 的 SHA-256 前缀（不存明文 IP）。
 * fail 计数带 15 分钟滑动窗口：隔了一刻钟再试，重新计次，不累积冤枉。
 * 连错 BRUTE_LIMIT 次 → 锁 BRUTE_LOCK_MS × 2^(strikes-1)，封顶 BRUTE_LOCK_MAX_MS（默认 1 小时）。
 * 锁定期内即使口令正确也 429（防止绕过限速试探）；成功登录即清零。
 */
const BRUTE_FAIL_WINDOW = 15 * 60000;
const BRUTE_MAX_IPS = 5000;

const bruteCfg = (env) => ({
  limit: Number(env.BRUTE_LIMIT) || 5,
  lockMs: Number(env.BRUTE_LOCK_MS) || 10 * 60 * 1000,
  lockMaxMs: Number(env.BRUTE_LOCK_MAX_MS) || 60 * 60 * 1000,
});

async function ipHash(req) {
  const ip = clientIp(req);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('brute:' + ip));
  return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 读取爆破状态（顺手清掉过期条目，文件保持极小） */
async function readBrute(store) {
  const b = await readJson(store, KEY.BRUTE, { ips: {} });
  const now = Date.now();
  const ips = {};
  for (const [k, rec] of Object.entries(b.ips || {})) {
    if ((rec.until || 0) > now || (rec.updatedAt || 0) > now - BRUTE_FAIL_WINDOW) ips[k] = rec;
  }
  return { ips };
}
const writeBrute = (store, b) => store.putText(KEY.BRUTE, JSON.stringify(b));

/** 登录前检查：是否被锁。返回 { locked, retryAfterMs, b } */
async function bruteCheck(req, env, store) {
  const b = await readBrute(store);
  const rec = b.ips[await ipHash(req)];
  if (rec && rec.until > Date.now()) return { locked: true, retryAfterMs: rec.until - Date.now(), b };
  return { locked: false, b };
}

/** 记一次失败：达标即锁，时长指数翻倍 */
async function bruteFail(req, env, store, state) {
  const cfg = bruteCfg(env);
  const now = Date.now();
  const h = await ipHash(req);
  const rec = state.b.ips[h] || { fail: 0, until: 0, strikes: 0 };
  if (rec.until > 0 && rec.until <= now) {
    rec.fail = 0;
    rec.until = 0;
  }
  if (now - (rec.updatedAt || 0) > BRUTE_FAIL_WINDOW) rec.fail = 0; // 滑动窗口：隔久了重新计次
  rec.fail += 1;
  rec.updatedAt = now;
  let locked = false;
  if (rec.fail >= cfg.limit) {
    rec.strikes = (rec.strikes || 0) + 1;
    const lock = Math.min(cfg.lockMs * 2 ** (rec.strikes - 1), cfg.lockMaxMs);
    rec.until = now + lock;
    rec.fail = 0;
    locked = true;
  }
  state.b.ips[h] = rec;
  await writeBrute(store, state.b);
  return { locked, retryAfterMs: rec.until > now ? rec.until - now : 0 };
}

/** 登录成功：清掉该 IP 的失败记录（无记录则不写） */
async function bruteClear(req, store, state) {
  const h = await ipHash(req);
  if (!state.b.ips[h]) return;
  delete state.b.ips[h];
  await writeBrute(store, state.b);
}

/* ---------------- 会话鉴权（HMAC 无状态 Cookie，参照 r2book） ---------------- */

const hmacKeyCache = new Map();
async function getHmacKey(secret) {
  let k = hmacKeyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeyCache.set(secret, k);
  }
  return k;
}

async function hmac(secret, msg) {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyCookie(req, env) {
  const cookie = req.headers.get('Cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (!m) return false;
  const token = m[1];
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  if (!secret) return false;
  if (!safeEqual(sig, await hmac(secret, payload))) return false;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function cookieAttrs(req, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/* ---------------- 数据读写助手 ---------------- */

/** 路由参数白名单：id / 章节 key 仅允许 URL 安全字符，杜绝存储路径注入（dev fs / R2 key） */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const isSafeId = (s) => SAFE_ID.test(s || '');

function newId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let n = 0;
  for (let i = 0; i < b.length; i++) n = n * 256 + b[i];
  return 'n_' + n.toString(36); // 全程保留（约 13 位 base36），不做无谓截断
}

const safeStr = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>"'\\/]/g, '').slice(0, max).trim();

async function readJson(store, key, fallback) {
  const t = await store.getText(key);
  if (t == null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}
const readIndex = (store) => readJson(store, KEY.INDEX, { books: [] });
const readTrash = (store) => readJson(store, KEY.TRASH, { books: [] });

/** index 结构变更前统一快照（publish / 软删 / 恢复） */
async function writeIndexBak(store) {
  const t = await store.getText(KEY.INDEX);
  if (t != null) await store.putText(KEY.INDEX_BAK, t);
}
const writeIndex = (store, index) => store.putText(KEY.INDEX, JSON.stringify(index));
const writeTrash = (store, trash) => store.putText(KEY.TRASH, JSON.stringify(trash));

async function readBook(store, id) {
  const raw = await store.getText(KEY.book(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 书名规范化（去空白）→ 同名去重/更新提示用 */
const normTitle = (s) => String(s || '').replace(/\s+/g, '');

/* ---------------- 鉴权 API ---------------- */

async function apiLogin(req, env, store) {
  const st = await bruteCheck(req, env, store);
  if (st.locked) {
    // 锁定期内一律 429（即使口令正确），不给绕过限速试探的机会
    const min = Math.max(1, Math.ceil(st.retryAfterMs / 60000));
    return json({ error: `尝试次数过多，请约 ${min} 分钟后再试` }, 429, {
      'Retry-After': String(Math.ceil(st.retryAfterMs / 1000)),
    });
  }
  const body = await req.json().catch(() => ({}));
  const pass = String(body.password || '');
  const admin = env.ADMIN_PASSWORD;
  if (!admin || !safeEqual(pass, admin)) {
    if (admin) await bruteFail(req, env, store, st);
    return json({ error: '口令错误' }, 401);
  }
  await bruteClear(req, store, st);
  const days = Number(env.SESSION_DAYS || 30) || 30;
  const payload = b64urlEncode(JSON.stringify({ exp: Date.now() + days * 86400000 }));
  const sig = await hmac(env.SESSION_SECRET || admin, payload);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${payload}.${sig}; ${cookieAttrs(req, days * 86400)}`,
  });
}

const apiLogout = (req) =>
  json({ ok: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; ${cookieAttrs(req, 0)}` });

/* ---------------- 回收站惰性清理 / 彻底删除（分批，尊重 50 子请求预算） ---------------- */

const PURGE_BATCH = 40; // 每请求最多删的正文对象数（留余量给 raw/meta/progress/trash 写入）

/**
 * 对 trash 里一本书执行一批彻底删除。返回 { entry(更新后), deleted, done, remaining }。
 * remaining>0 表示还需续调（章节太多分批）。
 */
async function purgeOnce(store, trash, id, maxDel = PURGE_BATCH) {
  const idx = trash.books.findIndex((b) => b.id === id);
  if (idx < 0) return { entry: null, deleted: 0, done: true, remaining: 0 };
  let entry = trash.books[idx];
  let keys = Array.isArray(entry.purge) && entry.purge.length ? entry.purge : null;
  if (!keys) {
    const meta = await readBook(store, id);
    // 彻底删除要覆盖正文章节 + replace 遗留的孤儿章节，避免 R2 残留
    keys = meta
      ? (meta.chapters || []).map((c) => c.key).concat(Array.isArray(meta.orphans) ? meta.orphans : [])
      : [];
  }
  const batch = keys.slice(0, maxDel);
  for (const k of batch) await store.delete(KEY.text(id, k));
  const left = keys.slice(batch.length);
  let deleted = batch.length;
  let done = false;
  if (left.length) {
    entry = { ...entry, purge: left };
    trash.books[idx] = entry;
    await writeTrash(store, trash);
  } else {
    done = true;
    await store.delete(KEY.raw(id));
    await store.delete(KEY.book(id));
    await store.delete(KEY.progress(id));
    trash.books.splice(idx, 1);
    await writeTrash(store, trash);
  }
  return { entry, deleted, done, remaining: left.length };
}

/** 惰性清理：把超过 TRASH_DAYS 的书清掉一批（无 cron，靠业务请求时机触发）
 * 注意：进行中（purge 字段非空）的书也要继续清，否则 >40 章的书会中途卡死在回收站。 */
async function sweepTrash(store, env, maxBooks = 1) {
  const trash = await readTrash(store);
  if (!trash.books.length) return;
  const ttl = (Number(env.TRASH_DAYS) || TRASH_DAYS) * 86400000;
  const now = Date.now();
  const expired = trash.books.filter((b) => now - (b.deletedAt || 0) > ttl);
  for (const b of expired.slice(0, maxBooks)) {
    await purgeOnce(store, trash, b.id);
  }
}

/* ---------------- 孤儿章节清理（replace 后章节数变少时旧正文对象残留） ---------------- */

const ORPHAN_BATCH = 40; // 每次惰性清理最多删的孤儿对象数（尊重子请求预算）

/** 对一本书的一批孤儿 key 执行删除；只改 meta.orphans，持久化由调用方负责。返回剩余数。 */
async function sweepOrphans(store, meta, max = ORPHAN_BATCH) {
  const keys = Array.isArray(meta.orphans) ? meta.orphans : [];
  if (!keys.length) return 0;
  const batch = keys.slice(0, max);
  for (const k of batch) await store.delete(KEY.text(meta.id, k));
  const left = keys.slice(batch.length);
  if (left.length) meta.orphans = left;
  else delete meta.orphans;
  return left.length;
}

/* ---------------- 书架 / 建书 ---------------- */

function indexEntryFromMeta(meta, extra = {}) {
  return {
    id: meta.id,
    title: meta.title,
    author: meta.author,
    tags: meta.tags || [],
    pinned: !!meta.pinned,
    chapterCount: meta.chapterCount || (meta.chapters || []).length,
    wordCount: meta.wordCount || 0,
    cleanVer: meta.cleanVer || 1,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...extra,
  };
}

/** 惰性清理是"顺手"动作：删除失败不应阻断书架/回收站读取，包一层降级 */
const sweepTrashSafe = (store, env) => sweepTrash(store, env, 2).catch(() => {});

/** 书架摘要（含置顶与进度镜像；排序由前端负责） */
async function apiBooks(store, env) {
  await sweepTrashSafe(store, env);
  const index = await readIndex(store);
  return json({ books: index.books || [] });
}

/**
 * 建书。客户端已在浏览器端完成清洗+分章。
 * body { title, author, tags[], chapters:[title...], wordCount, cleanVer }
 * 同名在架书 → duplicate=true + book 摘要（客户端引导「新建 / 更新」）
 * 返回 { id, chapterKeys, duplicate, book? }
 */
async function apiCreateBook(req, env, store) {
  const body = await req.json().catch(() => ({}));
  const title = safeStr(body.title, 120);
  if (!title) return json({ error: '书名不能为空' }, 400);
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, 20000) : [];
  if (!chapters.length) return json({ error: '没有章节' }, 400);

  const index = await readIndex(store);
  const nt = normTitle(title);
  const dup = (index.books || []).find((b) => normTitle(b.title) === nt);
  if (dup) {
    return json({
      ok: true,
      duplicate: true,
      book: {
        id: dup.id,
        title: dup.title,
        author: dup.author,
        tags: dup.tags || [],
        chapterCount: dup.chapterCount,
        wordCount: dup.wordCount,
        createdAt: dup.createdAt,
        updatedAt: dup.updatedAt,
      },
      // 占位 id：客户端若选「新建」，需要重新调用一次（本次直接返回提示）
      needCreate: true,
    });
  }

  return createBookRecord(store, body);
}

async function createBookRecord(store, body) {
  const title = safeStr(body.title, 120);
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, 20000) : [];
  const id = newId();
  const now = Date.now();
  const chTable = chapters.map((t, i) => ({ key: String(i + 1), title: safeStr(t, 120) || '第' + (i + 1) + '章' }));
  const meta = {
    id,
    title,
    author: safeStr(body.author, 60),
    note: safeStr(body.note, 500),
    tags: Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, 10) : [],
    wordCount: Number(body.wordCount) || 0,
    cleanVer: Number(body.cleanVer) || 1,
    createdAt: now,
    updatedAt: now,
    pinned: !!body.pinned,
    status: 'creating',
    chapters: chTable,
  };
  await store.putText(KEY.book(id), JSON.stringify(meta));
  return json({ ok: true, duplicate: false, id, chapterKeys: chTable.map((c) => c.key) });
}

/** 上传一章：body 为清洗后文本（utf-8） */
async function apiPutChapter(req, env, store, id, key) {
  const max = Number(env.MAX_CHAPTER || 2097152);
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) {
    await dropBody(req);
    return json({ error: '章节超过上限' }, 413);
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) return json({ error: '章节超过上限' }, 413);
  const text = new TextDecoder().decode(buf);
  const words = String(text).replace(/\s/g, '').length;
  await store.putText(KEY.text(id, key), text);
  return json({ ok: true, words });
}

/** 上传原件（原始字节留档，重洗/恢复依据） */
async function apiPutRaw(req, env, store, id) {
  const max = Number(env.MAX_UPLOAD || 52428800);
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) {
    await dropBody(req);
    return json({ error: `原件超过上限 ${(max / 1048576) | 0}MB` }, 413);
  }
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ error: '空文件' }, 400);
  if (buf.byteLength > max) return json({ error: `原件超过上限 ${(max / 1048576) | 0}MB` }, 413);
  await store.putBytes(KEY.raw(id), new Uint8Array(buf));
  return json({ ok: true, size: buf.byteLength });
}

/** 取原件（重洗用；前端用 cleaner 重新处理） */
async function apiRawGet(store, id) {
  const buf = await store.getBytes(KEY.raw(id));
  if (buf == null) return json({ error: '原件不存在' }, 404);
  return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
}

/**
 * 更新已有书章节表（DR-06）。POST /api/books/:id/chapters
 * body { op:'replace'|'append', chapters:[title...], wordCount?, cleanVer?, title?, author?, tags? }
 * - replace：章节表整体重建 key=1..n（客户端随后重传全部正文覆盖）；进度按同名标题尽力保留
 * - append ：旧章保留，新章 key 从旧章数+1 续接（连载补新章）
 * 都会置 status='creating'（publish 前暂不可读），cleanVer+1 使缓存失效。
 */
async function apiUpdateChapters(req, env, store, id) {
  const body = await req.json().catch(() => ({}));
  const op = body.op === 'append' ? 'append' : 'replace';
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, 20000) : [];
  if (!chapters.length) return json({ error: '没有章节' }, 400);

  const index = await readIndex(store);
  const inShelf = (index.books || []).some((b) => b.id === id);
  if (!inShelf) return json({ error: '书不在书架（可能已删除或未发布）' }, 404);

  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书不存在' }, 404);
  const oldCh = Array.isArray(meta.chapters) ? meta.chapters : [];
  const oldTitles = oldCh.map((c) => c.title);
  const now = Date.now();

  if (op === 'append') {
    const startKey = oldCh.length + 1;
    const add = chapters.map((t, i) => ({ key: String(startKey + i), title: safeStr(t, 120) || '第' + (startKey + i) + '章' }));
    meta.chapters = oldCh.concat(add);
  } else {
    // 进度尽力保留（ch 为 1-based 章节号）：旧进度所在章的标题在新表里若同名则迁移，
    // 找不到同名章 → 回到第 1 章；旧进度越界（脏数据）则原样保留不动。
    const newCh = chapters.map((t, i) => ({ key: String(i + 1), title: safeStr(t, 120) || '第' + (i + 1) + '章' }));
    let oldProg = null;
    try {
      const pt = await store.getText(KEY.progress(id));
      if (pt) oldProg = JSON.parse(pt);
    } catch {
      /* 无进度或损坏则跳过迁移 */
    }
    if (oldProg && Number.isFinite(oldProg.ch) && oldProg.ch >= 1 && oldProg.ch <= oldCh.length) {
      const oldTitle = oldTitles[Math.floor(oldProg.ch) - 1];
      const ni = newCh.findIndex((c) => c.title === oldTitle);
      const next =
        ni >= 0
          ? { ch: ni + 1, ratio: Math.min(1, Math.max(0, Number(oldProg.ratio) || 0)), updatedAt: now }
          : { ch: 1, ratio: 0, updatedAt: now };
      await store.putText(KEY.progress(id), JSON.stringify(next));
    }
    meta.chapters = newCh;
    // 旧版多余章节正文成为孤儿对象：记录并在本次请求内先清一批，其余靠 bookMeta/publish 惰性清
    const newKeys = new Set(newCh.map((c) => c.key));
    const orphans = oldCh.map((c) => c.key).filter((k) => !newKeys.has(k));
    if (orphans.length) {
      meta.orphans = orphans;
      await sweepOrphans(store, meta);
    }
  }

  if (body.title !== undefined) meta.title = safeStr(body.title, 120) || meta.title;
  if (body.author !== undefined) meta.author = safeStr(body.author, 60);
  if (body.note !== undefined && body.note !== null) meta.note = safeStr(body.note, 500);
  if (body.tags !== undefined) {
    meta.tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, 10) : [];
  }
  if (body.wordCount !== undefined) {
    // append 只传新增部分的字数 → 在旧字数上累加；replace 传的是整本字数 → 直接采用
    meta.wordCount =
      op === 'append'
        ? (Number(meta.wordCount) || 0) + (Number(body.wordCount) || 0)
        : Number(body.wordCount) || 0;
  }
  meta.cleanVer = (Number(meta.cleanVer) || 0) + 1;
  meta.updatedAt = now;
  meta.status = 'creating'; // publish 前不可读
  await store.putText(KEY.book(id), JSON.stringify(meta));
  return json({ ok: true, op, cleanVer: meta.cleanVer, chapterKeys: meta.chapters.map((c) => c.key) });
}

/**
 * 发布：抽样校验首/中/尾章存在 → 写 index（先 .bak）。
 * 字数信任客户端 cleaner 统计（meta.wordCount）——绝不逐章回读（R2 子请求上限）。
 */
async function apiPublish(req, env, store, id) {
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书不存在' }, 404);
  if (!meta.chapters || !meta.chapters.length) return json({ error: '书还没有章节' }, 400);
  const keys = meta.chapters.map((c) => c.key);
  const samples = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]].filter((k, i, arr) => arr.indexOf(k) === i);
  for (const k of samples) {
    const t = await store.getText(KEY.text(id, k));
    if (t == null) return json({ error: `章节 ${k} 未上传，发布中止` }, 409);
  }
  meta.chapterCount = keys.length;
  meta.wordCount = Math.max(Number(meta.wordCount) || 0, 0);
  meta.status = 'ready';
  meta.updatedAt = Date.now();
  if (Array.isArray(meta.orphans) && meta.orphans.length) await sweepOrphans(store, meta);
  await store.putText(KEY.book(id), JSON.stringify(meta));

  const index = await readIndex(store);
  await writeIndexBak(store);
  const books = (index.books || []).filter((b) => b.id !== id);
  const old = (index.books || []).find((b) => b.id === id);
  // 书架角标镜像以 progress 文件当前值为准（rewash/replace 可能刚重置过进度）
  let prog = old && old.prog;
  try {
    const pt = await store.getText(KEY.progress(id));
    if (pt) {
      const p = JSON.parse(pt);
      if (p && Number.isFinite(p.ch)) prog = { ch: p.ch, ratio: p.ratio || 0, updatedAt: p.updatedAt || 0 };
    }
  } catch {
    /* 读取失败沿用旧镜像 */
  }
  books.push(indexEntryFromMeta(meta, { pinned: !!(old && old.pinned) || !!meta.pinned, prog }));
  await writeIndex(store, { books });
  return json({ ok: true, id, wordCount: meta.wordCount, chapterCount: meta.chapterCount, cleanVer: meta.cleanVer });
}

/** 单书目录（章节表）——只读已发布书；顺带惰性清理 replace 遗留的孤儿章节 */
async function apiBookMeta(store, id) {
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书不存在' }, 404);
  if (meta.status !== 'ready') return json({ error: '书正在更新中，请稍后重试' }, 409);
  if (Array.isArray(meta.orphans) && meta.orphans.length) {
    await sweepOrphans(store, meta);
    await store.putText(KEY.book(id), JSON.stringify(meta));
  }
  const { orphans, ...view } = meta;
  return json(view);
}

/** 改元信息（书名/作者/标签/置顶）——PATCH，同步 index */
async function apiPatchBook(req, store, id) {
  const body = await req.json().catch(() => ({}));
  const index = await readIndex(store);
  if (!(index.books || []).some((b) => b.id === id)) return json({ error: '书不在书架（可能已删除或未发布）' }, 404);
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书不存在' }, 404);
  const patch = {};
  if (body.title !== undefined) {
    const t = safeStr(body.title, 120);
    if (t) {
      meta.title = t;
      patch.title = t;
    }
  }
  if (body.author !== undefined) {
    meta.author = safeStr(body.author, 60);
    patch.author = meta.author;
  }
  if (body.note !== undefined) {
    meta.note = safeStr(body.note, 500);
    patch.note = meta.note;
  }
  if (body.tags !== undefined) {
    meta.tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, 10) : [];
    patch.tags = meta.tags;
  }
  if (body.pinned !== undefined) {
    meta.pinned = !!body.pinned;
    patch.pinned = meta.pinned;
  }
  meta.updatedAt = Date.now();
  patch.updatedAt = meta.updatedAt;
  await store.putText(KEY.book(id), JSON.stringify(meta));

  await writeIndexBak(store);
  const books = (index.books || []).map((b) => {
    if (b.id !== id) return b;
    return {
      ...b,
      title: patch.title !== undefined ? patch.title : b.title,
      author: patch.author !== undefined ? patch.author : b.author,
      tags: patch.tags !== undefined ? patch.tags : b.tags,
      pinned: patch.pinned !== undefined ? patch.pinned : !!b.pinned,
      updatedAt: patch.updatedAt,
    };
  });
  await writeIndex(store, { books });
  return json({ ok: true });
}

/** 读一章正文。?v=cleanVer 做缓存击穿，rewash 后立即生效 */
async function apiChapter(store, id, key) {
  const t = await store.getText(KEY.text(id, key));
  if (t == null) return json({ error: '章节不存在' }, 404);
  return new Response(t, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ---------------- 进度（DR-02：R2 小对象 + index 镜像供书架角标） ---------------- */

const EMPTY_PROG = { ch: 0, ratio: 0, updatedAt: 0 };

async function apiProgressGet(store, id) {
  const t = await store.getText(KEY.progress(id));
  if (t == null) return json(EMPTY_PROG);
  try {
    return json(JSON.parse(t));
  } catch {
    return json(EMPTY_PROG);
  }
}

async function apiProgressPut(req, store, id) {
  const body = await req.json().catch(() => ({}));
  const ch = Math.max(0, Math.floor(Number(body.ch) || 0));
  let ratio = Number(body.ratio);
  if (!Number.isFinite(ratio)) ratio = 0;
  ratio = Math.min(1, Math.max(0, ratio));
  const data = { ch, ratio, updatedAt: Date.now() };
  await store.putText(KEY.progress(id), JSON.stringify(data));

  // 书架进度角标镜像：只在「书确实在书架」且「位置有明显变化」（换章或比例变动 >2%）时
  // 才重写整个 index —— 降低写频、缩小与 publish 并发时全量覆盖的窗口
  try {
    const index = await readIndex(store);
    const book = (index.books || []).find((b) => b.id === id);
    if (!book) return json({ ok: true });
    const cur = book.prog;
    const changed = !cur || cur.ch !== ch || Math.abs((cur.ratio || 0) - ratio) > 0.02;
    if (changed) {
      const books = (index.books || []).map((b) => (b.id === id ? { ...b, prog: { ch, ratio, updatedAt: data.updatedAt } } : b));
      await writeIndex(store, { books });
    }
  } catch {
    /* ignore */
  }
  return json({ ok: true });
}

/* ---------------- 回收站 API ---------------- */

/** 软删：index 摘除 → trash（正文/meta/raw 全保留，可恢复） */
async function apiSoftDelete(store, id) {
  const index = await readIndex(store);
  const b = (index.books || []).find((x) => x.id === id);
  if (!b) return json({ error: '书不存在或已删除' }, 404);
  await writeIndexBak(store);
  const books = (index.books || []).filter((x) => x.id !== id);
  await writeIndex(store, { books });

  const trash = await readTrash(store);
  if (!trash.books.some((x) => x.id === id)) {
    trash.books.push({ ...b, deletedAt: Date.now() });
    await writeTrash(store, trash);
  }
  return json({ ok: true });
}

/** 回收站列表（顺带惰性清理） */
async function apiTrashList(store, env) {
  await sweepTrashSafe(store, env);
  const trash = await readTrash(store);
  const books = (trash.books || []).slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  const view = books.map((b) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    tags: b.tags || [],
    chapterCount: b.chapterCount,
    wordCount: b.wordCount,
    deletedAt: b.deletedAt,
    purge: Array.isArray(b.purge) ? b.purge.length : 0,
    restorable: !b.purge,
  }));
  return json({ books: view });
}

/** 恢复：trash → index（正文未删时） */
async function apiRestore(store, id) {
  const trash = await readTrash(store);
  const idx = trash.books.findIndex((b) => b.id === id);
  if (idx < 0) return json({ error: '回收站里没有这本书' }, 404);
  const entry = trash.books[idx];
  if (entry.purge) return json({ error: '该书的正文已部分清除，无法完整恢复' }, 409);
  trash.books.splice(idx, 1);
  await writeTrash(store, trash);

  const index = await readIndex(store);
  await writeIndexBak(store);
  const books = (index.books || []).filter((b) => b.id !== id);
  const { purge, deletedAt, ...rest } = entry;
  books.push({ ...rest });
  await writeIndex(store, { books });
  return json({ ok: true });
}

/** 彻底删除单本（分批，客户端按 remaining 续调） */
async function apiTrashPurge(store, id) {
  const trash = await readTrash(store);
  if (!trash.books.some((b) => b.id === id)) return json({ error: '回收站里没有这本书' }, 404);
  const r = await purgeOnce(store, trash, id);
  return json({ ok: true, done: r.done, remaining: r.remaining, deleted: r.deleted });
}

/** 清空回收站（每请求尽力清，客户端按 remaining 续调直至 0） */
async function apiTrashClear(store) {
  const trash = await readTrash(store);
  let budget = PURGE_BATCH;
  let deleted = 0;
  for (let i = 0; i < (trash.books || []).length && budget > 0; ) {
    const b = trash.books[i];
    const r = await purgeOnce(store, trash, b.id, budget);
    deleted += r.deleted;
    budget -= Math.max(r.deleted, 1);
    if (!r.done) break; // 这一本就吃满预算，下一请求再来
  }
  const remaining = (await readTrash(store)).books.length;
  return json({ ok: true, deleted, remaining });
}

/* ---------------- OPDS 目录 / 整本导出（第三方阅读器通道） ----------------
 * 场景：手机阅读器 App（ReadEra/Librera/静读天下等）订阅私人书库，整本下载 TXT 本地读。
 * 鉴权：浏览器会话 Cookie 或 HTTP Basic Auth（阅读器 App 只认 Basic）。
 *   - 口令即 ADMIN_PASSWORD（与登录同口令、同一把防爆破 IP 锁）；
 *   - 比较走 safeEqual 恒时；失败照常计数，锁定期内即使口令正确也 429。
 * 整本导出为流式拼章：逐章 R2 字节流惰性串接，不经 JS 解码/编码（不烧 CPU、不占内存），
 *   章节标题等少量文本单独编码插入。
 */
async function opdsAuth(req, env, store) {
  if (await verifyCookie(req, env)) return { ok: true };
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get('authorization') || '');
  if (m) {
    const st = await bruteCheck(req, env, store);
    if (st.locked) return { ok: false, status: 429, retryAfterMs: st.retryAfterMs };
    let pair = '';
    try {
      const bin = atob(m[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      pair = new TextDecoder().decode(bytes); // UTF-8 还原（中文口令也正确）
    } catch {
      return { ok: false, status: 401 };
    }
    const pass = pair.slice(pair.indexOf(':') + 1); // 用户名任意（含空），只认冒号后的口令
    const admin = env.ADMIN_PASSWORD;
    if (!admin || !safeEqual(pass, admin)) {
      if (admin) await bruteFail(req, env, store, st);
      return { ok: false, status: 401 };
    }
    await bruteClear(req, store, st);
    return { ok: true };
  }
  return { ok: false, status: 401 };
}

const opds401 = () =>
  new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r2novel"' } });

const opdsLocked = (retryAfterMs) =>
  json({ error: '尝试次数过多，请稍后再试' }, 429, { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) });

/** 把异步生成器产出的字节源（Uint8Array 或 ReadableStream）按序泵成一个 ReadableStream。
 *  惰性：一段读尽才拉下一段——整本导出不会一次性打开全部章节流（尊重 R2 单请求操作上限）。 */
function pumpParts(gen) {
  const it = gen[Symbol.asyncIterator]();
  let cur = null; // 当前章 ReadableStream
  let reader = null;

  async function nextPart(controller) {
    const { done, value } = await it.next();
    if (done) {
      controller.close();
      return;
    }
    if (value instanceof Uint8Array) {
      if (value.byteLength) controller.enqueue(value);
      return; // 等下次 pull 再取下一段
    }
    cur = value;
    reader = value.getReader();
    await pumpChapter(controller);
  }
  async function pumpChapter(controller) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reader = null;
        cur = null;
        await nextPart(controller); // 读尽本段 → 立即接下一段
        return;
      }
      controller.enqueue(value); // 背压：推一块就交还，等下次 pull
      return;
    }
  }
  return new ReadableStream({
    pull(controller) {
      return reader ? pumpChapter(controller) : nextPart(controller);
    },
    cancel() {
      if (reader) {
        try {
          reader.cancel('client-abort');
        } catch {
          /* ignore */
        }
        reader = null;
      }
      if (it.return) it.return().catch(() => {});
    },
  });
}

/** 整本 TXT 的字节源序列（书头 + 逐章标题块 + 章正文流 + 结尾） */
async function* exportParts(meta, store) {
  const title = meta.title || '未命名';
  const head = `${title}\n${meta.author ? '作者：' + meta.author + '\n' : ''}共 ${meta.chapters.length} 章 · ${meta.wordCount || 0} 字\n\n`;
  yield enc.encode(head);
  for (const c of meta.chapters) {
    yield enc.encode(`\n${c.title}\n\n`);
    const s = await store.openRead(KEY.text(meta.id, c.key));
    if (s) yield s;
  }
  yield enc.encode('\n');
}

/** GET /export/<id>.txt — 整本下载（流式拼章，Basic/Cookie 皆可）
 * 只放行已发布（status='ready'）的书：半成品/更新中的书可能缺正文或正在被覆盖，
 * 不应从阅读器下载通道泄露出去。 */
async function opdsExport(req, env, store, id) {
  const auth = await opdsAuth(req, env, store);
  if (!auth.ok) return auth.status === 429 ? opdsLocked(auth.retryAfterMs) : opds401();
  const meta = await readBook(store, id);
  if (!meta || meta.status !== 'ready' || !Array.isArray(meta.chapters) || !meta.chapters.length) {
    return json({ error: '书不存在或不可下载' }, 404);
  }
  return new Response(pumpParts(exportParts(meta, store)), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent((meta.title || 'book') + '.txt')}`,
    },
  });
}

/** GET /opds — OPDS 1.2 目录（全量书目，每书一个 acquisition 下载链接） */
async function opdsCatalog(req, env, store) {
  const auth = await opdsAuth(req, env, store);
  if (!auth.ok) return auth.status === 429 ? opdsLocked(auth.retryAfterMs) : opds401();
  const index = await readIndex(store);
  const books = (index.books || []).slice().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const entry = (b) => {
    const ts = b.updatedAt || b.createdAt || Date.now();
    const author = b.author ? `      <author><name>${escXml(b.author)}</name></author>\n` : '';
    const cats = (b.tags || []).map((t) => `      <category term="${escXml(t)}" label="${escXml(t)}"/>\n`).join('');
    return `    <entry>
      <title>${escXml(b.title || '未命名')}</title>
      <id>urn:r2novel:book:${escXml(b.id)}</id>
      <updated>${new Date(ts).toISOString()}</updated>
${author}${cats}      <summary>${b.chapterCount || 0} 章 · ${b.wordCount || 0} 字</summary>
      <link rel="http://opds-spec.org/acquisition" href="/export/${encodeURIComponent(b.id)}.txt" type="text/plain" title="下载整本 TXT"/>
    </entry>`;
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:r2novel:opds</id>
  <title>私人书屋</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>私人书屋</name></author>
  <link rel="self" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
${books.map(entry).join('\n')}
</feed>
`;
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/* ---------------- 路由 ---------------- */

async function handleApi(req, env, store, url, p) {
  if (p === '/api/login') {
    if (req.method !== 'POST') {
      await dropBody(req);
      return json({ error: 'method' }, 405);
    }
    return apiLogin(req, env, store);
  }

  if (!(await verifyCookie(req, env))) {
    await dropBody(req);
    return json({ error: 'unauthorized' }, 401);
  }

  if (p === '/api/logout' && req.method === 'POST') return apiLogout(req);

  if (p === '/api/books') {
    if (req.method === 'GET') return apiBooks(store, env);
    if (req.method === 'POST') return apiCreateBook(req, env, store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  if (p === '/api/trash') {
    if (req.method === 'GET') return apiTrashList(store, env);
    if (req.method === 'POST' && url.searchParams.get('action') === 'clear') return apiTrashClear(store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mRaw = /^\/api\/books\/([^/]+)\/raw$/.exec(p);
  if (mRaw && !isSafeId(mRaw[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mRaw && req.method === 'PUT') return apiPutRaw(req, env, store, mRaw[1]);
  if (mRaw && req.method === 'GET') return apiRawGet(store, mRaw[1]);

  const mPublish = /^\/api\/books\/([^/]+)\/publish$/.exec(p);
  if (mPublish && !isSafeId(mPublish[1])) return notFound();
  if (mPublish && req.method === 'POST') return apiPublish(req, env, store, mPublish[1]);

  const mRestore = /^\/api\/books\/([^/]+)\/restore$/.exec(p);
  if (mRestore && !isSafeId(mRestore[1])) return notFound();
  if (mRestore && req.method === 'POST') return apiRestore(store, mRestore[1]);

  const mChapters = /^\/api\/books\/([^/]+)\/chapters$/.exec(p);
  if (mChapters && !isSafeId(mChapters[1])) return notFound();
  if (mChapters && req.method === 'POST') return apiUpdateChapters(req, env, store, mChapters[1]);

  const mCh = /^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/.exec(p);
  if (mCh && (!isSafeId(mCh[1]) || !isSafeId(mCh[2]))) {
    await dropBody(req);
    return notFound();
  }
  if (mCh && req.method === 'PUT') return apiPutChapter(req, env, store, mCh[1], mCh[2]);
  if (mCh && req.method === 'GET') return apiChapter(store, mCh[1], mCh[2]);

  const mBook = /^\/api\/books\/([^/]+)$/.exec(p);
  if (mBook && !isSafeId(mBook[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mBook) {
    if (req.method === 'GET') return apiBookMeta(store, mBook[1]);
    if (req.method === 'PATCH') return apiPatchBook(req, store, mBook[1]);
    if (req.method === 'DELETE') return apiSoftDelete(store, mBook[1]);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mPurge = /^\/api\/trash\/([^/]+)$/.exec(p);
  if (mPurge && !isSafeId(mPurge[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mPurge) {
    if (req.method === 'DELETE') return apiTrashPurge(store, mPurge[1]);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mProg = /^\/api\/progress\/([^/]+)$/.exec(p);
  if (mProg && !isSafeId(mProg[1])) return notFound();
  if (mProg && req.method === 'GET') return apiProgressGet(store, mProg[1]);
  if (mProg && req.method === 'PUT') return apiProgressPut(req, store, mProg[1]);

  await dropBody(req);
  return json({ error: 'not found' }, 404);
}

export async function handleRequest(req, env, store) {
  const url = new URL(req.url);
  const p = url.pathname;

  // OPDS / 整本导出（第三方阅读器通道，独立于 /api/*）
  if (/^\/opds\/?$/.test(p)) {
    if (req.method !== 'GET') {
      await dropBody(req);
      return json({ error: 'method' }, 405);
    }
    return opdsCatalog(req, env, store);
  }
  const mExp = /^\/export\/([^/]+)\.txt$/.exec(p);
  if (mExp) {
    if (!isSafeId(mExp[1])) return notFound();
    if (req.method !== 'GET') {
      await dropBody(req);
      return json({ error: 'method' }, 405);
    }
    return opdsExport(req, env, store, mExp[1]);
  }

  if (p.startsWith('/api/')) return handleApi(req, env, store, url, p);

  // 静态资源交给外层（Workers: ASSETS / dev: 静态文件服务）
  if (req.method === 'GET' || req.method === 'HEAD') {
    const resp = await env.serveStatic(req, url);
    if (resp) return resp;
  }
  return notFound();
}
