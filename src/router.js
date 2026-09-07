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
 *   - 彻底删除单批 ≤30 章、惰性清扫每请求 ≤1 本、孤儿批次 ≤24，逐书固定开销
 *     （readBook + raw/meta/progress 删除 + 写 trash）叠加核账过，单路径最坏仍远低于 50；
 *     剩余 keys 存 trash 条目 purge 字段，客户端续调直至 done。
 */

import { CHAPTER_MAX, MAX_CHAPTER_BYTES, BULK_CHAPTER_BATCH, BATCH_BOOKS_MAX, MAX_UPLOAD_BYTES, EXPORT_MAX_CHAPTERS } from '../public/js/shared-const.js';

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
const BRUTE_MAX_IPS = 5000; // brute.json 最多保留的 IP 记录数（防分布式伪造 IP 撑大文件）

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

/** 读取爆破状态（顺手清掉过期条目 + 按数量截断，文件保持极小） */
async function readBrute(store) {
  const b = await readJson(store, KEY.BRUTE, { ips: {} });
  const now = Date.now();
  const ips = {};
  for (const [k, rec] of Object.entries(b.ips || {})) {
    if ((rec.until || 0) > now || (rec.updatedAt || 0) > now - BRUTE_FAIL_WINDOW) ips[k] = rec;
  }
  // 上限保护：超量时按最近活跃裁掉最旧的（防御分布式伪造 IP 让 brute.json 无限膨胀）
  const entries = Object.entries(ips);
  if (entries.length > BRUTE_MAX_IPS) {
    entries.sort((a, b2) => (a[1].updatedAt || 0) - (b2[1].updatedAt || 0));
    for (const [k] of entries.slice(0, entries.length - BRUTE_MAX_IPS)) delete ips[k];
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

/** 字数统计：去所有空白后计数（与上传/就地编辑/插入共用，唯一实现） */
const wordsOf = (text) => String(text == null ? '' : text).replace(/\s/g, '').length;

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
  // 公开端点加固：合法登录体不足 100 字节，声明超大的请求直接拒收（不给恶意大 JSON 读进内存的机会）
  const cl = Number(req.headers.get('content-length') || 0);
  if (cl > 65536) {
    await dropBody(req);
    return json({ error: '请求体过大' }, 413);
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

const DELETE_BATCH = 30; // 单请求/单次惰性清理最多删除的正文对象数（加固定开销后仍远低于 Free 50 子请求红线）
const PURGE_BATCH = DELETE_BATCH; // 彻底删除单批上限（留余量给 raw/meta/progress/trash 写入）
const ORPHAN_BATCH = 24; // replace 遗留孤儿惰性清理单批（publish/更新/目录读取顺带清，分批清完）

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
  // 并发删除：子请求数不变，耗时从串行 N 次往返降为一批并发
  await Promise.all(batch.map((k) => store.delete(KEY.text(id, k))));
  const left = keys.slice(batch.length);
  let deleted = batch.length;
  let done = false;
  if (left.length) {
    entry = { ...entry, purge: left };
    trash.books[idx] = entry;
    await writeTrash(store, trash);
  } else {
    done = true;
    await Promise.all([store.delete(KEY.raw(id)), store.delete(KEY.book(id)), store.delete(KEY.progress(id))]);
    trash.books.splice(idx, 1);
    await writeTrash(store, trash);
  }
  return { entry, deleted, done, remaining: left.length };
}

/** 惰性清理：把超过 TRASH_DAYS 的书清掉一批（无 cron，靠业务请求时机触发）
 * 注意：进行中（purge 字段非空）的书也要继续清，否则 >30 章的书会中途卡死在回收站。
 * 预算由调用方控制（sweepTrashSafe 限定 maxBooks=1）：本函数本身按默认 batch 推进。 */
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

/** 对一本书的一批孤儿 key 执行删除；只改 meta.orphans，持久化由调用方负责。返回剩余数。 */
async function sweepOrphans(store, meta, max = ORPHAN_BATCH) {
  const keys = Array.isArray(meta.orphans) ? meta.orphans : [];
  if (!keys.length) return 0;
  const batch = keys.slice(0, max);
  await Promise.all(batch.map((k) => store.delete(KEY.text(meta.id, k))));
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
    finished: !!meta.finished,
    chapterCount: meta.chapterCount || (meta.chapters || []).length,
    wordCount: meta.wordCount || 0,
    cleanVer: meta.cleanVer || 1,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...extra,
  };
}

/** 惰性清理是"顺手"动作：删除失败不应阻断读取，包一层降级。
 * 只挂在回收站列表（apiTrashList）触发：书架 GET 不再等待清扫——超期大书的
 * 多批 R2 删除（每请求 ≤1 本）不会拖慢首屏；超期书本已过期，晚几天清无妨。
 * 每请求最多推进 1 本（batch ≤30）：逐本书的固定开销（readBook+写trash 等）
 * 叠上去多本必爆 50，1 本最坏 ~33 才稳。剩余靠下一请求继续（purge 字段续清）。 */
const sweepTrashSafe = (store, env) => sweepTrash(store, env, 1).catch(() => {});

/** 书架摘要（含置顶与进度镜像；排序由前端负责） */
async function apiBooks(store) {
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
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, CHAPTER_MAX) : [];
  if (!chapters.length) return json({ error: '没有章节' }, 400);

  const index = await readIndex(store);
  const nt = normTitle(title);
  const dup = (index.books || []).find((b) => normTitle(b.title) === nt);
  if (dup) {
    return json({
      ok: true,
      duplicate: true,
      book: indexEntryFromMeta(dup), // index 条目字段齐全，直接复用车架摘要（多带 pinned/cleanVer，无害）
      // 占位 id：客户端若选「新建」，需要重新调用一次（本次直接返回提示）
      needCreate: true,
    });
  }

  return createBookRecord(store, body);
}

async function createBookRecord(store, body) {
  const title = safeStr(body.title, 120);
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, CHAPTER_MAX) : [];
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

/** 上传一章：body 为清洗后文本（utf-8）
 * 只放行「建书/更新中」（creating）的书：已发布书若走这里直写正文，
 * 会绕过就地编辑的字数修正 / cleanVer+1 / index 镜像同步，造成长期不一致。 */
async function apiPutChapter(req, env, store, id, key) {
  const meta = await readBook(store, id);
  if (!meta) {
    await dropBody(req);
    return json({ error: '书不存在' }, 404);
  }
  if (meta.status === 'ready') {
    await dropBody(req);
    return json({ error: '书已发布，请改用章节编辑接口' }, 409);
  }
  // 只放行章表内 key：建书/更新期往表外 key 塞正文会生成「publish 后无人认领」的孤儿对象
  if (!(Array.isArray(meta.chapters) ? meta.chapters : []).some((c) => c.key === key)) {
    await dropBody(req);
    return json({ error: '章节不在章表中' }, 404);
  }
  const max = Number(env.MAX_CHAPTER || MAX_CHAPTER_BYTES);
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > max) {
    await dropBody(req);
    return json({ error: '章节超过上限' }, 413);
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) return json({ error: '章节超过上限' }, 413);
  const text = new TextDecoder().decode(buf);
  const words = wordsOf(text);
  await store.putText(KEY.text(id, key), text);
  return json({ ok: true, words });
}

/** 批量上传正文（连续上传优化）：一次读 meta + 批量写。
 * 请求数从「每章 1 个」降到「每 BULK_CHAPTER_BATCH 章 1 个」（Free 计划硬配额是请求数/天），
 * 单章 PUT 保留兼容。规则与单章一致：只放行 creating、只收章表内 key、每章 ≤ MAX_CHAPTER。
 * 全部校验通过后才落盘，避免超限造成半批次写。最坏子请求 = 1 读 + BULK_CHAPTER_BATCH 并发写。 */
async function apiPutChapters(req, env, store, id) {
  const body = await req.json().catch(() => ({}));
  const list = Array.isArray(body.chapters) ? body.chapters : [];
  if (!list.length) return json({ error: '没有章节' }, 400);
  if (list.length > BULK_CHAPTER_BATCH) return json({ error: `单批最多 ${BULK_CHAPTER_BATCH} 章` }, 413);
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书不存在' }, 404);
  if (meta.status === 'ready') return json({ error: '书已发布，请改用章节编辑接口' }, 409);
  const table = new Set((Array.isArray(meta.chapters) ? meta.chapters : []).map((c) => c.key));
  const max = Number(env.MAX_CHAPTER || MAX_CHAPTER_BYTES);
  const maxTotal = 16 * 1024 * 1024; // 单批总字节护栏（body/内存）
  const items = [];
  let total = 0;
  for (const it of list) {
    const key = String((it && it.key) != null ? it.key : ''); // 防御 null 元素（旧版写法会在 it=null 时读 it.key 崩溃）
    if (!table.has(key)) return json({ error: `章节 ${key} 不在章表中` }, 404);
    const text = it && typeof it.text === 'string' ? it.text : '';
    const size = enc.encode(text).byteLength;
    total += size;
    if (size > max || total > maxTotal) return json({ error: '章节超过上限' }, 413);
    items.push({ key, text });
  }
  // 批内并发写：子请求数不变（仍 ≤BULK_CHAPTER_BATCH），耗时从串行 N×RTT 降为一次并发
  await Promise.all(items.map((it) => store.putText(KEY.text(id, it.key), it.text)));
  return json({ ok: true, count: items.length, words: items.map((it) => wordsOf(it.text)) });
}

/** 上传原件（原始字节留档，重洗/恢复依据） */
async function apiPutRaw(req, env, store, id) {
  const max = Number(env.MAX_UPLOAD || MAX_UPLOAD_BYTES);
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
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, CHAPTER_MAX) : [];
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
    // 起点取「现有数字 key 最大值 +1」与「章数+1」的较大者：
    // 就地删除会让数字 key 变稀疏（如 [1,3]），只按章数推算会撞上已存在的 key → 新正文覆盖旧章
    let maxNum = 0;
    for (const c of oldCh) {
      const n = Number(c.key);
      if (Number.isInteger(n) && n > maxNum) maxNum = n;
    }
    const startKey = Math.max(oldCh.length + 1, maxNum + 1);
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
    // 负字数（异常客户端）在 replace 采用时即压回 0，不必等 publish 才修正
    meta.wordCount =
      op === 'append'
        ? (Number(meta.wordCount) || 0) + (Number(body.wordCount) || 0)
        : Math.max(0, Number(body.wordCount) || 0);
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
  const sampled = await Promise.all(samples.map((k) => store.getText(KEY.text(id, k))));
  for (let i = 0; i < samples.length; i++) {
    if (sampled[i] == null) return json({ error: `章节 ${samples[i]} 未上传，发布中止` }, 409);
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
  if (body.finished !== undefined) {
    meta.finished = !!body.finished;
    patch.finished = meta.finished;
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
      finished: patch.finished !== undefined ? patch.finished : !!b.finished,
      updatedAt: patch.updatedAt,
    };
  });
  await writeIndex(store, { books });
  return json({ ok: true });
}

/** 读一章正文。?v=cleanVer 做缓存击穿，rewash 后立即生效
 * 只放行已发布书：replace/append 期间书处于 creating，旧正文不应被读到（与 bookMeta/export 一致）；
 * 也避免「replace 后旧 key 正文残留、发布抽样未命中」时旧正文顶着新章表长期被读。 */
async function apiChapter(store, id, key) {
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '章节不存在' }, 404);
  if (meta.status !== 'ready') return json({ error: '书正在更新中，请稍后重试' }, 409);
  const t = await store.getText(KEY.text(id, key));
  if (t == null) return json({ error: '章节不存在' }, 404);
  // 章节正文可长缓存：URL 已带 ?v=cleanVer 作为失效键（任何编辑/重洗都会 cleanVer+1），
  // 回翻章节/重开书籍零网络请求；cleanVer 变化 → URL 变化 → 缓存天然失效
  return new Response(t, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' },
  });
}

/* ---------------- v1.1：已发布书的章节就地编辑（改标题/改正文/插入/删除） ----------------
 * 就地编辑 ≠ replace 整表重建：新章用 newId 生成独立 key，既有章节 key 永不重排，
 * 只写 meta 章表数组 + 受影响的正文对象 → 单次操作子请求 ≤10，远在 50 预算内。
 * 仅放行 status==='ready' 的已发布书（书全程保持可读）；半成品走 /chapters 整表通道。
 * 一致性规则：
 *   - 标题传空 → 自动兜底「第 N 章」（N=当前位置 1-based）
 *   - 改正文/删章按旧正文实际字数修正 meta.wordCount（读一次旧章，预算内）
 *   - cleanVer+1：失效阅读缓存与 PWA 离线整本（前端提示重新下载）
 *   - 插入/删除改变后续章号 → 云端进度按规则迁移（index 进度镜像一并更新）
 */
function chIndex(meta, key) {
  const arr = Array.isArray(meta.chapters) ? meta.chapters : [];
  return arr.findIndex((c) => c.key === key);
}

/** 就地编辑前提：书在架 + 存在 + 已发布；返回 { meta } 或 { resp }（直接作为响应） */
async function editableMeta(store, id) {
  const index = await readIndex(store);
  if (!(index.books || []).some((b) => b.id === id)) {
    return { resp: json({ error: '书不在书架（可能已删除或未发布）' }, 404) };
  }
  const meta = await readBook(store, id);
  if (!meta) return { resp: json({ error: '书不存在' }, 404) };
  if (meta.status !== 'ready') return { resp: json({ error: '书正在更新中，请稍后重试' }, 409) };
  return { meta };
}

/** 就地编辑后同步书架摘要：快照 → 重建该条目（章数/字数/更新时间 + 保留 pinned/进度镜像） */
async function syncIndexAfterEdit(store, meta) {
  const index = await readIndex(store);
  await writeIndexBak(store);
  let prog;
  try {
    const pt = await store.getText(KEY.progress(meta.id));
    if (pt) {
      const p = JSON.parse(pt);
      if (p && Number.isFinite(p.ch)) prog = { ch: p.ch, ratio: p.ratio || 0, updatedAt: p.updatedAt || 0 };
    }
  } catch {
    /* 无进度则沿用原镜像 */
  }
  const books = (index.books || []).map((b) =>
    b.id === meta.id ? { ...indexEntryFromMeta(meta), pinned: !!b.pinned, prog: prog || b.prog } : b
  );
  await writeIndex(store, { books });
}

/** 插入章后迁移进度：原进度章在插入位之后 → 章号 +1（章正文未变） */
async function shiftProgressOnInsert(store, id, at) {
  const t = await store.getText(KEY.progress(id));
  if (!t) return;
  try {
    const p = JSON.parse(t);
    if (p && Number.isFinite(p.ch) && p.ch >= 1 && p.ch - 1 >= at) {
      await store.putText(KEY.progress(id), JSON.stringify({ ch: p.ch + 1, ratio: p.ratio || 0, updatedAt: Date.now() }));
    }
  } catch {
    /* 损坏进度忽略 */
  }
}

/** 删除章后迁移进度：进度在被删章之后 → 章号 -1；删的恰是进度章 → 原地顶替；
 *  新章数 newLen 用于把越界进度（删末章后 ch > 章数）压回新末章——书架角标直接读
 *  progress 镜像，不 clamp 就会显示「读到 5/4 章」这类越界数字。 */
async function shiftProgressOnDelete(store, id, di, newLen) {
  const t = await store.getText(KEY.progress(id));
  if (!t) return;
  try {
    const p = JSON.parse(t);
    if (p && Number.isFinite(p.ch) && p.ch >= 1) {
      let ch = p.ch;
      if (ch - 1 > di) ch -= 1; // 被删章之后 → 前移
      if (ch > newLen) ch = newLen; // 删的是末章/进度章且越界 → 压回新末章
      await store.putText(KEY.progress(id), JSON.stringify({ ch, ratio: p.ratio || 0, updatedAt: Date.now() }));
    }
  } catch {
    /* ignore */
  }
}

/** PATCH /api/books/:id/chapters/:key — 就地改标题 / 改正文（body: { title?, content? }） */
async function apiPatchChapter(req, env, store, id, key) {
  const g = await editableMeta(store, id);
  if (!g.meta) return g.resp;
  const meta = g.meta;
  const i = chIndex(meta, key);
  if (i < 0) return json({ error: '章节不存在' }, 404);
  const body = await req.json().catch(() => ({}));
  const hasTitle = typeof body.title === 'string';
  const hasContent = typeof body.content === 'string';
  if (!hasTitle && !hasContent) return json({ error: '没有要修改的内容' }, 400);

  const ch = meta.chapters[i];
  if (hasTitle) {
    const t = body.title.trim();
    ch.title = t ? safeStr(t, 120) : '第' + (i + 1) + '章';
  }
  if (hasContent) {
    const max = Number(env.MAX_CHAPTER || MAX_CHAPTER_BYTES);
    if (enc.encode(body.content).byteLength > max) return json({ error: '章节超过上限' }, 413);
    const oldWords = wordsOf(await store.getText(KEY.text(id, key)));
    const newWords = wordsOf(body.content);
    await store.putText(KEY.text(id, key), body.content);
    meta.wordCount = Math.max(0, (Number(meta.wordCount) || 0) + newWords - oldWords);
  }
  meta.cleanVer = (Number(meta.cleanVer) || 1) + 1;
  meta.updatedAt = Date.now();
  await store.putText(KEY.book(id), JSON.stringify(meta));
  await syncIndexAfterEdit(store, meta);
  return json({ ok: true, title: ch.title, cleanVer: meta.cleanVer, wordCount: meta.wordCount });
}

/** POST /api/books/:id/chapters/insert — 插入一章（body: { after?: key|null, title?, content? }）
 * 新章获得独立 key（不与数字 key 冲突），老章 key 与正文全部保持不动。 */
async function apiInsertChapter(req, env, store, id) {
  const g = await editableMeta(store, id);
  if (!g.meta) return g.resp;
  const meta = g.meta;
  const body = await req.json().catch(() => ({}));
  const titleRaw = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!titleRaw && !content) return json({ error: '章节标题和正文不能都为空' }, 400);
  const max = Number(env.MAX_CHAPTER || MAX_CHAPTER_BYTES);
  if (enc.encode(content).byteLength > max) return json({ error: '章节超过上限' }, 413);

  if (!Array.isArray(meta.chapters)) meta.chapters = [];
  const arr = meta.chapters; // 必须挂在 meta 上：否则非数组边界下插入结果会丢失
  let at = arr.length; // 默认追加到末尾
  if (body.after !== undefined && body.after !== null && body.after !== '') {
    const j = arr.findIndex((c) => c.key === body.after);
    if (j < 0) return json({ error: '参照章节不存在' }, 404);
    at = j + 1;
  }
  const key = newId();
  const title = titleRaw || '第' + (at + 1) + '章';
  await shiftProgressOnInsert(store, id, at); // 先迁移进度，再改章表
  arr.splice(at, 0, { key, title: safeStr(title, 120) });
  meta.chapterCount = arr.length;
  meta.wordCount = (Number(meta.wordCount) || 0) + wordsOf(content);
  await store.putText(KEY.text(id, key), content); // 空正文也落盘（阅读时提示无内容，不 404）
  meta.cleanVer = (Number(meta.cleanVer) || 1) + 1;
  meta.updatedAt = Date.now();
  await store.putText(KEY.book(id), JSON.stringify(meta));
  await syncIndexAfterEdit(store, meta);
  return json({ ok: true, key, title: meta.chapters[at].title, chapterCount: meta.chapters.length, cleanVer: meta.cleanVer });
}

/** DELETE /api/books/:id/chapters/:key — 删除一章（正文一并清除） */
async function apiDeleteChapter(store, id, key) {
  const g = await editableMeta(store, id);
  if (!g.meta) return g.resp;
  const meta = g.meta;
  if (!Array.isArray(meta.chapters)) meta.chapters = [];
  const arr = meta.chapters;
  const i = arr.findIndex((c) => c.key === key);
  if (i < 0) return json({ error: '章节不存在' }, 404);
  if (arr.length <= 1) return json({ error: '至少保留一章' }, 400);
  const oldWords = wordsOf(await store.getText(KEY.text(id, key)));
  await shiftProgressOnDelete(store, id, i, arr.length - 1); // 先迁移进度（用删除前的下标与新章数），再改章表
  meta.wordCount = Math.max(0, (Number(meta.wordCount) || 0) - oldWords);
  await store.delete(KEY.text(id, key));
  arr.splice(i, 1);
  meta.chapterCount = arr.length;
  meta.cleanVer = (Number(meta.cleanVer) || 1) + 1;
  meta.updatedAt = Date.now();
  await store.putText(KEY.book(id), JSON.stringify(meta));
  await syncIndexAfterEdit(store, meta);
  return json({ ok: true, chapterCount: arr.length, cleanVer: meta.cleanVer, wordCount: meta.wordCount });
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
    // 越界进度压回末章（镜像供书架角标直接显示，不能出现「读到 999/10 章」）
    // 恶意/异常客户端可能直接 PUT 超章数 ch；正常前端已 clamp，这里做服务端兜底。
    const cap = Number(book.chapterCount) || 0;
    const mch = cap > 0 && ch > cap ? cap : ch;
    const cur = book.prog;
    const changed = !cur || cur.ch !== mch || Math.abs((cur.ratio || 0) - ratio) > 0.02;
    if (changed) {
      const books = (index.books || []).map((b) => (b.id === id ? { ...b, prog: { ch: mch, ratio, updatedAt: data.updatedAt } } : b));
      await writeIndex(store, { books });
    }
  } catch {
    /* ignore */
  }
  return json({ ok: true });
}

/* ---------------- 批量操作 / 标签治理（书架百本量级的治理工具） ---------------- */

/** 标签合并单请求上限（同样受 2N 约束；未完成的部分返回 remaining 让前端续调）。
 * 书架批量操作上限 BATCH_BOOKS_MAX 见 shared-const.js（前后端共用，防漂移）。 */
const TAG_MERGE_MAX = 18;

/**
 * 批量操作：一次请求改多本书（标签增删/整设、完结状态、软删）。
 * 只写一次 index（含快照），避免 N 次请求产生 N 次 index 写放大与丢失更新窗口。
 * body: { ids: [...], action: 'addTags'|'removeTags'|'setTags'|'setFinished'|'delete', tags?, finished? }
 */
async function apiBatchBooks(req, store) {
  const body = await req.json().catch(() => ({}));
  const idsRaw = Array.isArray(body.ids) ? body.ids : null;
  if (!idsRaw || !idsRaw.length) return json({ error: '请先选择要操作的书' }, 400);
  const ids = Array.from(new Set(idsRaw.map((x) => String(x)).filter((x) => isSafeId(x))));
  if (!ids.length) return json({ error: '没有合法的书 id' }, 400);

  const action = String(body.action || '');
  if (!['addTags', 'removeTags', 'setTags', 'setFinished', 'delete'].includes(action)) {
    return json({ error: '未知操作' }, 400);
  }
  const tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, 10) : [];
  // setTags 允许空数组（清空标签），其余两种必须给非空标签
  if (action !== 'setTags' && action !== 'setFinished' && action !== 'delete' && !tags.length) {
    return json({ error: '请填写标签' }, 400);
  }
  if (action === 'setFinished' && body.finished === undefined) return json({ error: '缺少 finished' }, 400);

  const batch = ids.slice(0, BATCH_BOOKS_MAX);
  const index = await readIndex(store);
  const inShelf = new Set((index.books || []).map((b) => b.id));
  const targets = batch.filter((id) => inShelf.has(id));

  if (action === 'delete') return batchSoftDelete(store, index, targets);

  const patches = new Map();
  for (const id of targets) {
    const meta = await readBook(store, id);
    if (!meta) continue;
    if (action === 'addTags') {
      const set = new Set(meta.tags || []);
      for (const t of tags) set.add(t);
      meta.tags = Array.from(set).slice(0, 10);
    } else if (action === 'removeTags') {
      const rm = new Set(tags);
      meta.tags = (meta.tags || []).filter((t) => !rm.has(t));
    } else if (action === 'setTags') {
      meta.tags = tags;
    } else if (action === 'setFinished') {
      meta.finished = !!body.finished;
    }
    meta.updatedAt = Date.now();
    await store.putText(KEY.book(id), JSON.stringify(meta));
    patches.set(id, { tags: meta.tags || [], finished: !!meta.finished, updatedAt: meta.updatedAt });
  }

  if (patches.size) {
    await writeIndexBak(store);
    const books = (index.books || []).map((b) => (patches.has(b.id) ? { ...b, ...patches.get(b.id) } : b));
    await writeIndex(store, { books });
  }
  return json({ ok: true, updated: patches.size, skipped: batch.length - targets.length, rest: Math.max(0, ids.length - batch.length) });
}

/** 批量软删：index 一次摘除 + trash 一次写入（不读各书 meta，index 条目即摘要） */
async function batchSoftDelete(store, index, targets) {
  if (!targets.length) return json({ ok: true, updated: 0, skipped: 0, rest: 0 });
  await writeIndexBak(store);
  const gone = new Set(targets);
  const books = (index.books || []).filter((b) => !gone.has(b.id));
  await writeIndex(store, { books });

  const trash = await readTrash(store);
  let n = 0;
  for (const id of targets) {
    if (trash.books.some((x) => x.id === id)) continue;
    const entry = (index.books || []).find((b) => b.id === id);
    if (entry) {
      trash.books.push({ ...entry, deletedAt: Date.now() });
      n++;
    }
  }
  if (n) await writeTrash(store, trash);
  return json({ ok: true, updated: n, skipped: 0, rest: 0 });
}

/** 全量标签清单（不截断：前端导航栏只显示 top12，治理页需要看到全部） */
async function apiTagsList(store) {
  const index = await readIndex(store);
  const m = new Map();
  for (const b of index.books || []) {
    for (const t of b.tags || []) m.set(t, (m.get(t) || 0) + 1);
  }
  const tags = Array.from(m.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([tag, count]) => ({ tag, count }));
  return json({ tags, total: tags.length });
}

/**
 * 标签治理：合并 / 改名 / 删除（to 为空串即删除）。
 * 只改受影响书，超出单请求预算时返回 remaining，前端续调即可。
 */
async function apiTagsMerge(req, store) {
  const body = await req.json().catch(() => ({}));
  const from = safeStr(body.from, 30);
  const to = safeStr(body.to, 30);
  if (!from) return json({ error: '请指定要处理的标签' }, 400);
  if (to && to === from) return json({ error: '源标签与目标相同' }, 400);

  const index = await readIndex(store);
  const hit = (index.books || []).filter((b) => (b.tags || []).includes(from));
  if (!hit.length) return json({ ok: true, updated: 0, remaining: 0 });

  const targets = hit.slice(0, TAG_MERGE_MAX);
  const patches = new Map();
  for (const b of targets) {
    const meta = await readBook(store, b.id);
    if (!meta) continue;
    const out = [];
    for (const t of meta.tags || []) {
      if (t === from) {
        if (to && !out.includes(to)) out.push(to); // 改名/合并：落到目标标签（已存在则不重复）
        continue;
      }
      if (to && t === to) continue; // 目标标签已出现过，去重
      if (!out.includes(t)) out.push(t);
    }
    meta.tags = out.slice(0, 10);
    meta.updatedAt = Date.now();
    await store.putText(KEY.book(b.id), JSON.stringify(meta));
    patches.set(b.id, { tags: meta.tags, updatedAt: meta.updatedAt });
  }

  if (patches.size) {
    await writeIndexBak(store);
    const books = (index.books || []).map((b) => (patches.has(b.id) ? { ...b, ...patches.get(b.id) } : b));
    await writeIndex(store, { books });
  }
  return json({ ok: true, updated: patches.size, remaining: Math.max(0, hit.length - targets.length) });
}

/* ---------------- 回收站 API ---------------- */

/** 软删：index 摘除 → trash（正文/meta/raw 全保留，可恢复）
 * 也接纳「未上架的半成品书」（上传中途失败停在 creating、不在 index）：
 * 这类书若不能进回收站就永远删不掉、也看不见，只能留成孤儿数据。 */
async function apiSoftDelete(store, id) {
  const index = await readIndex(store);
  const b = (index.books || []).find((x) => x.id === id);
  const meta = b ? null : await readBook(store, id);
  if (!b && !meta) return json({ error: '书不存在或已删除' }, 404);
  // 只在架书才需要从 index 摘除（半成品书本就不在 index，filter 结果不变，跳过两次无谓 R2 写）
  if (b) {
    await writeIndexBak(store);
    const books = (index.books || []).filter((x) => x.id !== id);
    await writeIndex(store, { books });
  }

  const trash = await readTrash(store);
  if (!trash.books.some((x) => x.id === id)) {
    trash.books.push({ ...(b || indexEntryFromMeta(meta)), deletedAt: Date.now() });
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

/** 恢复：trash → index（正文未删时）
 * 只放行已发布（status='ready'）的书：半成品/更新中的书恢复回书架后既读不了（bookMeta 409）
 * 也没有继续上传的入口，只会变成书架上一本点不开的孤儿。 */
async function apiRestore(store, id) {
  const trash = await readTrash(store);
  const idx = trash.books.findIndex((b) => b.id === id);
  if (idx < 0) return json({ error: '回收站里没有这本书' }, 404);
  const entry = trash.books[idx];
  if (entry.purge) return json({ error: '该书的正文已部分清除，无法完整恢复' }, 409);
  // 软删自半成品（第三轮起可软删 creating 书）：trash 条目来自 indexEntryFromMeta，无 status 字段。
  // 一律以 meta 本体为准：只有已发布书恢复才有阅读/继续编辑入口，其余只会变书架孤儿。
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书本体数据缺失，无法恢复' }, 404);
  if (meta.status !== 'ready') {
    return json({ error: '该书尚未发布，无法恢复；如不再需要请在回收站中彻底删除' }, 409);
  }
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

/** 清空回收站（每请求推进 1 本，客户端按 remaining 续调直至 0）
 * 只处理 1 本：彻底删除的固定开销（readBook + raw/meta/progress 删除 + writeTrash）会叠在
 * 章删除之上，逐本累积轻松超 Free 50 子请求红线；一本一本清最稳。 */
async function apiTrashClear(store) {
  const trash = await readTrash(store);
  if (!trash.books.length) return json({ ok: true, deleted: 0, remaining: 0 });
  const r = await purgeOnce(store, trash, trash.books[0].id, PURGE_BATCH);
  return json({ ok: true, deleted: r.deleted, remaining: trash.books.length });
}

/* ---------------- 残留诊断 / 孤儿清理（书架「检查残留」） ----------------
 * 只读扫描全库对象，与「应有对象」（index + trash + 各书章表/orphans）做差集，分三类：
 *   residue        已删书伴生残留：对象在但既无清单记录也无 meta（删书漏删 / 中断残留）→ 可直接删对象
 *   orphanBooks    无主书：meta 在但 id 不在 index/trash（上传中断 / index 写失败）→ 不直接删，走「移入回收站」
 *   chapterOrphans 活书章表外正文：key 不在 chapters/orphans 之外（replace 等遗留）→ 可直接删对象
 * 删除接口只收 text|raw|progress 前缀，绝不接受 meta/*（系统文件与书元数据不可经此删除）。
 * 子请求预算：Free 单请求 ≤50。逐书 readBook 与 list 分页都计入，预算将尽即标记 incomplete
 *   截断（宁漏勿错），避免大书库把「检查残留」点成 500。
 */
const DIAG_SYS_KEYS = new Set([KEY.INDEX, KEY.INDEX_BAK, KEY.TRASH]);
// list 预算拆两类：meta/raw/progress 是「书数级」对象（每本各 1 个，千本 = 各 1 页）→ 给足预算保证完整；
// text/ 是「章数级」大头（每章 1 个，千本 50 章 = 50 页）→ 只给部分页数，截断即 incomplete（宁漏勿错）
const DIAG_META_PAGE_BUDGET = 3; // meta/raw/progress 各自翻页上限（每页 ≤1000 对象 → 覆盖约 3000 本）
const DIAG_TEXT_PAGE_BUDGET = 20; // text/ 翻页上限（扫描约 20000 个章对象）
const DIAG_SUB_BUDGET = 45; // 扫描/删除单请求子请求软预算

async function apiDiagOrphans(store) {
  try {
    return await doDiagScan(store);
  } catch (e) {
    // 扫描过程本身失败（R2 超限/超时等）→ 透传真实原因，前端可展示而非笼统 HTTP 503
    return json({ error: '残留扫描失败：' + (e && e.message ? e.message : e) }, 502);
  }
}

async function doDiagScan(store) {
  const budget = { used: 2, incomplete: false }; // 2 = readIndex + readTrash
  const bump = () => {
    if (budget.used >= DIAG_SUB_BUDGET) {
      budget.incomplete = true;
      return false;
    }
    budget.used++;
    return true;
  };
  const index = await readIndex(store);
  const trash = await readTrash(store);
  const live = new Set();
  const titleOf = new Map();
  for (const b of [...(index.books || []), ...(trash.books || [])]) {
    live.add(b.id);
    if (!titleOf.has(b.id)) titleOf.set(b.id, b.title || '');
  }

  const residue = [];
  const chapterOrphans = [];
  const orphanBooks = [];

  // 分前缀并发 list：meta/raw/progress 是「书数级」对象（每本各 1 个，千本各 1 页）→
  // 给足预算保证无主书/已删残留永远完整；text/ 是「章数级」大头（每章 1 个，千本 50 章 = 50 页）
  // → 只给 DIAG_TEXT_PAGE_BUDGET 页，截断即标记 incomplete（宁漏勿错）。
  // 四个前缀互不依赖，并发翻页：list 总耗时从「全库 20 页串行」降为「书数级前缀几页 + text 预算内页」的并发最值。
  const [lMeta, lRaw, lProg, lText] = await Promise.all([
    store.list('meta/', DIAG_META_PAGE_BUDGET),
    store.list('raw/', DIAG_META_PAGE_BUDGET),
    store.list('progress/', DIAG_META_PAGE_BUDGET),
    store.list('text/', DIAG_TEXT_PAGE_BUDGET),
  ]);
  budget.used += lMeta.pages + lRaw.pages + lProg.pages + lText.pages;
  if (lMeta.truncated || lRaw.truncated || lProg.truncated || lText.truncated) budget.incomplete = true;

  // meta/{id}.json → 无主书（系统 meta 文件排除）。候选先收集、预算内批量并发回读：
  // 预算尽则剩余标 unknown（宁漏勿错），已允许的并发一次读完（RTT 从串行 N 次降到一次）
  const orphanCands = [];
  for (const o of lMeta.objects) {
    if (DIAG_SYS_KEYS.has(o.key) || o.key.startsWith('meta/sec/')) continue;
    const id = o.key.slice(5, -5); // 去 'meta/' 前缀与 '.json' 后缀
    if (live.has(id)) continue;
    orphanCands.push({ o, id, canRead: bump() });
  }
  const mArr = await Promise.all(orphanCands.map((c) => (c.canRead ? readBook(store, c.id) : Promise.resolve(null))));
  for (let i = 0; i < orphanCands.length; i++) {
    const { o, id } = orphanCands[i];
    const m = mArr[i];
    orphanBooks.push({
      id,
      key: o.key,
      size: o.size,
      status: m && m.status ? m.status : 'unknown',
      title: m && m.title ? m.title : '',
      chapterCount: m && Array.isArray(m.chapters) ? m.chapters.length : 0,
      wordCount: m && Number(m.wordCount) ? Number(m.wordCount) : 0,
    });
  }
  const orphanSet = new Set(orphanBooks.map((b) => b.id));

  // text/{id}/{key}.txt → 章表外正文 / 无主正文
  const textById = new Map();
  for (const o of lText.objects) {
    const rest = o.key.slice(5);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue; // 非预期 key 形状，忽略
    const id = rest.slice(0, slash);
    if (!textById.has(id)) textById.set(id, []);
    textById.get(id).push({ key: o.key, size: o.size, chKey: rest.slice(slash + 1, -4) });
  }
  // 先分出无主正文（书连 meta 都没有 → 列为残留可直接删；有 meta（无主书）→ 正文随书进回收站，不单列）
  const liveTextIds = [];
  for (const [id, items] of textById) {
    if (!live.has(id)) {
      if (orphanSet.has(id)) {
        const ob = orphanBooks.find((b) => b.id === id);
        ob.texts = (ob.texts || 0) + items.length;
        ob.textBytes = (ob.textBytes || 0) + items.reduce((s, x) => s + x.size, 0);
      } else {
        for (const it of items) residue.push({ key: it.key, size: it.size });
      }
      continue;
    }
    liveTextIds.push({ id, items });
  }
  // 活书正文分类：预算内并发 readBook（子请求数不变，RTT 从串行 N 次降到一次）
  const liveMeta = await Promise.all(
    liveTextIds.map((x) => (bump() ? readBook(store, x.id) : Promise.resolve(null)))
  );
  for (let i = 0; i < liveTextIds.length; i++) {
    const { id, items } = liveTextIds[i];
    const m = liveMeta[i];
    if (!m) continue; // 预算尽 / meta 读不到：宁漏勿错，留待下次扫描
    const have = new Set((m.chapters || []).map((c) => c.key));
    const known = new Set(Array.isArray(m.orphans) ? m.orphans : []);
    for (const it of items) {
      if (have.has(it.chKey)) continue;
      chapterOrphans.push({
        key: it.key,
        size: it.size,
        bookId: id,
        bookTitle: titleOf.get(id) || '',
        known: known.has(it.chKey), // 已在 meta.orphans 登记（惰性清理会兜底）→ known
      });
    }
  }

  // raw/{id}.txt、progress/{id}.json → 无主残留（书数级前缀已完整列出，不存在截断漏检）
  for (const o of lRaw.objects) {
    const id = o.key.slice('raw/'.length).replace(/\.(txt|json)$/, '');
    if (!live.has(id) && !orphanSet.has(id)) residue.push({ key: o.key, size: o.size });
  }
  for (const o of lProg.objects) {
    const id = o.key.slice('progress/'.length).replace(/\.(txt|json)$/, '');
    if (!live.has(id) && !orphanSet.has(id)) residue.push({ key: o.key, size: o.size });
  }

  const summary = { residue: residue.length, orphanBooks: orphanBooks.length, chapterOrphans: chapterOrphans.length };
  return json({
    scannedAt: Date.now(),
    liveBooks: live.size,
    summary,
    residue,
    orphanBooks,
    chapterOrphans,
    incomplete: budget.incomplete,
  });
}

/** 批量删除已确认无引用的对象（text/raw/progress 前缀）。只删对象，不经书 meta。
 * 删除前回验：在架/回收站活书的当前章节正文、raw、progress 一律拒删——阻止「扫描后 append
 * 复用孤儿 key」的竞态把活书正文误删。非活书对象直接放行；预算将尽时剩余 key 不回验也不删。 */
async function apiPurgeOrphans(req, store) {
  const body = await req.json().catch(() => ({}));
  const keys = Array.isArray(body.objects) ? body.objects.map(String) : [];
  if (!keys.length) return json({ error: '没有要删除的对象' }, 400);
  const ok = keys.filter((k) => /^(?:text|raw|progress)\/[^/]/.test(k) && !/\.\./.test(k));
  if (!ok.length) return json({ error: '没有可删除的合法对象' }, 400);

  const index = await readIndex(store);
  const trash = await readTrash(store);
  const live = new Set([...(index.books || []), ...(trash.books || [])].map((b) => b.id));
  let used = 2; // 已读 index + trash
  const metaCache = new Map(); // 同一本书多个删除 key 只回验一次
  const toDelete = [];
  for (const k of ok) {
    const parts = k.split('/');
    // id 解析：text/<id>/<key>.txt 的 id 是 parts[1]；raw/<id>.txt、progress/<id>.json 只有一个斜杠，
    // parts[1] 带扩展名，须剥掉才能对上 live 集合（否则活书的 raw/progress 会被误判为非活书而放行）
    const id = parts[0] === 'text' ? parts[1] || '' : String(parts[1] || '').replace(/\.(txt|json)$/, '');
    if (!live.has(id)) {
      toDelete.push(k); // 非活书伴生残留，无需回验
      continue;
    }
    if (parts[0] !== 'text') continue; // 活书的 raw/progress 拒删（原件/进度属该书）
    let meta = metaCache.get(id);
    if (metaCache.has(id)) {
      // 命中缓存
    } else {
      if (used >= DIAG_SUB_BUDGET) break; // 预算尽：不回验也不删（宁漏勿错）
      used++;
      meta = await readBook(store, id);
      metaCache.set(id, meta);
    }
    if (!meta) continue; // 活书 meta 读不到：宁漏勿错，留待下次扫描
    const have = new Set((meta.chapters || []).map((c) => c.key));
    const chKey = parts.slice(2).join('/').replace(/\.txt$/, '');
    if (!have.has(chKey)) toDelete.push(k); // 章表外正文（含已登记孤儿）→ 可删（当前章节正文则拒删）
  }
  let deleted = 0;
  for (const k of toDelete) {
    if (used >= DIAG_SUB_BUDGET) break; // 预算含删除本身，防超 50
    used++;
    await store.delete(k);
    deleted++;
  }
  return json({ ok: true, deleted, skipped: ok.length - deleted });
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
  new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r2novel", charset="UTF-8"' } });

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
    const { done, value } = await reader.read();
    if (done) {
      reader = null;
      cur = null;
      await nextPart(controller); // 读尽本段 → 立即接下一段
      return;
    }
    controller.enqueue(value); // 背压：推一块就交还，下一块由 pull 再次驱动
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
  // Free 计划单请求 ≤50 子请求：整本流式导出逐章开 R2 流（1 章 = 1 子请求），
  // 超出剩余预算会让流在中段报错 → 客户端拿到截断/失败文件。明确拒绝并指引网页端
  // 导出（exportBookTxt 收到非 200 会自动回退到逐章拉取，网页端不受影响）。
  if (meta.chapters.length > EXPORT_MAX_CHAPTERS) {
    return json({ error: `本书 ${meta.chapters.length} 章超过整本流式导出上限（${EXPORT_MAX_CHAPTERS} 章），请在网页中使用「导出」功能` }, 409);
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
  // feed 级 updated 用内容的最新时间（而非当前时间）：固定值让阅读器按条件请求判断
  // 「feed 没变化」，避免每次拉取都被误判有更新而反复全量重拉
  const feedUpdated = books.length ? Math.max(...books.map((b) => b.updatedAt || b.createdAt || 0)) : Date.now();
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
  <updated>${new Date(feedUpdated).toISOString()}</updated>
  <author><name>私人书屋</name></author>
  <link rel="self" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
${books.map(entry).join('\n')}
</feed>
`;
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/atom+xml; profile=opds-catalog; kind=acquisition; charset=utf-8',
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
    if (req.method === 'GET') return apiBooks(store);
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

  // 批量操作（书架多选）：必须在 /api/books/:id 之前匹配，否则 'batch' 会被当成书 id
  if (p === '/api/books/batch') {
    if (req.method === 'POST') return apiBatchBooks(req, store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // 标签治理：GET 全量清单（不截断）/ POST 合并·改名·删除（to 为空即删除）
  if (p === '/api/tags') {
    if (req.method === 'GET') return apiTagsList(store);
    if (req.method === 'POST') return apiTagsMerge(req, store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // 残留诊断：GET 全库扫描分类 / DELETE 批量删无主对象（书架「检查残留」）
  if (p === '/api/diag/orphans') {
    if (req.method === 'GET') return apiDiagOrphans(store);
    if (req.method === 'DELETE') return apiPurgeOrphans(req, store);
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

  // 章节就地编辑：插入（v1.1）。注意必须在单章 /chapters/:key 之前匹配，否则 'insert' 会被当成 key
  const mIns = /^\/api\/books\/([^/]+)\/chapters\/insert$/.exec(p);
  if (mIns && !isSafeId(mIns[1])) return notFound();
  if (mIns && req.method === 'POST') return apiInsertChapter(req, env, store, mIns[1]);

  // 批量上传正文（连续上传优化）：同样必须在单章 /chapters/:key 之前匹配，否则 'bulk' 会被当成 key
  const mBulk = /^\/api\/books\/([^/]+)\/chapters\/bulk$/.exec(p);
  if (mBulk && !isSafeId(mBulk[1])) return notFound();
  if (mBulk && req.method === 'POST') return apiPutChapters(req, env, store, mBulk[1]);

  const mCh = /^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/.exec(p);
  if (mCh && (!isSafeId(mCh[1]) || !isSafeId(mCh[2]))) {
    await dropBody(req);
    return notFound();
  }
  if (mCh && req.method === 'PUT') return apiPutChapter(req, env, store, mCh[1], mCh[2]);
  if (mCh && req.method === 'GET') return apiChapter(store, mCh[1], mCh[2]);
  if (mCh && req.method === 'PATCH') return apiPatchChapter(req, env, store, mCh[1], mCh[2]);
  if (mCh && req.method === 'DELETE') return apiDeleteChapter(store, mCh[1], mCh[2]);

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
