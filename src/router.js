/**
 * r2novel — 共享路由核心（Worker 与本地 dev-server 共用）
 *
 * 所有数据都走 /api/* + 会话 Cookie 鉴权；R2/文件系统只由外层适配。
 *
 * R2 key 布局：
 *   meta/idx/root.json       书架索引 v2 根：{ v:2, shards:n, map:{ id: 分片号 } }（含 .bak）
 *   meta/idx/s<N>.json       书架摘要分片（≤500 本/片，含 .bak；条目含 pinned / 进度镜像 prog）
 *   meta/index.json(.bak)    v1 单文件索引——迁移后**冻结不再读写**，留作旧代码回滚窗口的只读快照；
 *                            迁移时另存 meta/index.json.v1.bak 双保险
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

import { CHAPTER_MAX, MAX_CHAPTER_BYTES, BULK_CHAPTER_BATCH, BATCH_BOOKS_MAX, MAX_UPLOAD_BYTES, EXPORT_MAX_CHAPTERS, TRASH_DAYS, READ_DONE_RATIO, TAG_MAX } from '../public/js/shared-const.js';
// 纯文本判据（与前端同一份实现）—— 勿在此文件另写一遍，两端判据漂移是静默的
import { normTitle, countWords as wordsOf } from '../public/js/shared-text.js';

const SESSION_COOKIE = 'rn_session';

export const KEY = {
  INDEX: 'meta/index.json',
  INDEX_BAK: 'meta/index.json.bak',
  TRASH: 'meta/trash.json',
  BRUTE: 'meta/sec/brute.json',
  book: (id) => `meta/${id}.json`,
  // 章节读取用的状态副档（meta/sec/ 前缀被 diag 扫描排除，不会成「无主书」误报）：
  // 让 GET 章节只读 ~20B 判定可读性，免每章请求都全量解析 meta（2000 章书 meta≈1MB JSON.parse/次）
  st: (id) => `meta/sec/st/${id}.json`,
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

/** 丢弃请求体：cancel 掉流即可，绝不能 arrayBuffer() 排空——排空等于把（可能超大且未经
 * 校验的）请求体整体读进内存，免鉴权 401 / 校验失败路径上就是一个人为的 OOM 面
 * （Workers 内存 128MB，与 readBodyBytes 的流式护栏同一个道理）。cancel 让运行时立即
 * 回收上游，两端（Workers / Node undici）语义一致。 */
async function dropBody(req) {
  try {
    if (req.body && !req.bodyUsed) await req.body.cancel();
  } catch {
    /* 流异常忽略 */
  }
}

/** 读取请求体字节；带 x-content-gzip 标记时解压（产物超过 maxBytes 即中断流）。
 * 护栏动机：①gzip 炸弹（KB 级压缩体解压成 GB）②明文超大请求（客户端可不发 Content-Length，
 * chunked 绕过声明值检查）——两者都会把 Worker 内存（128MB）打爆。
 * 实现：全程流式 + 计数 TransformStream，超限瞬间 error 掉管道，上游读取/解压随之取消，
 * 内存占用恒有界（旧实现先 req.arrayBuffer() 整体读入再判大小，护栏作用在事后，挡不住 OOM）。
 * 错误语义（调用方按 message 映射状态码）：
 *   解压后超过上限 / 请求体超过上限 → 413；请求体解压失败 → 400。 */
async function readBodyBytes(req, maxBytes) {
  // 声明值快速拒绝：省一次完整流读取（合法客户端都会带 Content-Length）。
  // 注意此处**不能** dropBody——排空即 req.arrayBuffer() 整体读入，等于把超大体吃进内存，
  // 与护栏目的相悖；直接回 413 由运行时处置未消费的请求体即可。
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('请求体超过上限');
  if (!req.body) return new Uint8Array(0);
  const gz = req.headers.get('x-content-gzip') === '1';
  let over = false;
  let n = 0;
  let src = req.body;
  if (gz) {
    try {
      src = src.pipeThrough(new DecompressionStream('gzip'));
    } catch {
      throw new Error('请求体解压失败');
    }
  }
  const counted = src.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        n += chunk.byteLength;
        if (n > maxBytes) {
          over = true;
          throw new Error('body-over-limit');
        }
        ctrl.enqueue(chunk);
      },
    })
  );
  try {
    return await new Response(counted).arrayBuffer();
  } catch {
    if (over) throw new Error(gz ? '解压后超过上限' : '请求体超过上限');
    throw new Error(gz ? '请求体解压失败' : '请求体读取失败');
  }
}

/** 读取（可选 gzip 的）请求体文本：readBodyBytes 的文本版。 */
async function readBodyText(req, maxBytes) {
  const buf = await readBodyBytes(req, maxBytes);
  return new TextDecoder().decode(buf);
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

/* ---------------- store 乐观锁原语（2026-09-17 外部审计 P2-6 / M2） ----------------
 * 病根：R2 没有事务，而「读—改—写」遍布索引与计数文件。两个并发请求各自「读旧值 → 改 →
 * 整文件写回」时，后写者会静默吃掉前者的改动（实测：两个标签页同时发布 → 其中一本从书架消失）。
 * store 契约（三端一致：worker R2 / dev-server fs / 测试 memStore）：
 *   · getTextWithEtag(key) → { text, etag } | null    读原文 + 版本号（一次 get 拿两样，不多花子请求）
 *   · putTextIf(key, text, etag) → { etag } | null     带 etag → 仅当当前版本相等才写（CAS）；
 *                                                      etag 为 null → 仅当对象不存在才写；
 *                                                      etag 为 undefined → 无条件写。失败返回 null。
 * etag 是**内容相关**的（R2 普通 put = 内容 MD5；fs/memStore = 内容 sha1）：内容不变则 etag 不变。
 * CAS 是**可选能力**：老 store / 外部探针没实现时退化为无条件写（行为等于旧版），
 * 所以本文件不用到处写 `if (store.putTextIf)`。
 * 为什么不是「自增版本号」当 etag：测试/脚本会直接改存储造数，内容派生的 etag 才不会被绕过。 */
async function getWithEtag(store, key) {
  if (store.getTextWithEtag) return await store.getTextWithEtag(key);
  const t = await store.getText(key);
  return t == null ? null : { text: t, etag: undefined };
}
/** 条件写：返回 { ok, etag }；ok=false 表示版本已变（或该存在的还不存在）→ 调用方重读重放 */
async function putIf(store, key, text, etag) {
  if (!store.putTextIf) {
    await store.putText(key, text);
    return { ok: true, etag: undefined };
  }
  const r = await store.putTextIf(key, text, etag);
  return r ? { ok: true, etag: r.etag } : { ok: false, etag: null };
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

/** 归一变体：清掉过期条目 + 按数量截断（文件保持极小）。缺失/损坏 → 空表。 */
function normalizeBrute(b) {
  const now = Date.now();
  const ips = {};
  for (const [k, rec] of Object.entries((b && b.ips) || {})) {
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

/** 读取爆破状态（顺手清掉过期条目 + 按数量截断，文件保持极小） */
async function readBrute(store) {
  return normalizeBrute(await readJson(store, KEY.BRUTE, { ips: {} }));
}

/** brute.json 的「读—改—写」：CAS 乐观锁 + 冲突重放（M2）。
 * 原实现拿 bruteCheck 读到的旧快照整文件覆盖：N 个并发失败各自数到 1、互相覆盖，实际只记 1 次
 * —— 爆破预算被放大 N 倍（外部审计探针复现）。这里每轮重读最新状态，再叠自己这一次失败。
 * mutate(b) 就地改 b，返回 { out, dirty }：dirty=false 表示「无需写」（如本来就没有记录）。 */
async function updateBrute(store, mutate, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const cur = await getWithEtag(store, KEY.BRUTE);
    const b = normalizeBrute(cur && tryParseJson(cur.text));
    const r = mutate(b);
    if (r.dirty === false) return r.out;
    // cur === null → 「不存在才写」：并发的首次失败只有一个落盘，其余重试时读到对手的结果再叠加
    const w = await putIf(store, KEY.BRUTE, JSON.stringify(b), cur ? cur.etag : null);
    if (w.ok) return r.out;
  }
  // 重试耗尽（极端抖动）：无条件写一次——limiter 的失效方向必须偏保守（宁可多记也不放过）
  const cur = await getWithEtag(store, KEY.BRUTE);
  const b = normalizeBrute(cur && tryParseJson(cur.text));
  const r = mutate(b);
  // 耗尽路径同样守 dirty（2026-09-17 复查 F5）：并发对手可能刚清掉/改掉记录，
  // 无条件写会把读—写间隙里别人写的内容整份吃掉（与 updateTrash 的守卫对称）。
  if (r.dirty !== false) await store.putText(KEY.BRUTE, JSON.stringify(b));
  return r.out;
}

/** 登录前检查：是否被锁。返回 { locked, retryAfterMs, b } */
async function bruteCheck(req, env, store) {
  const b = await readBrute(store);
  const rec = b.ips[await ipHash(req)];
  if (rec && rec.until > Date.now()) return { locked: true, retryAfterMs: rec.until - Date.now(), b };
  return { locked: false, b };
}

/** 记一次失败：达标即锁，时长指数翻倍 */
async function bruteFail(req, env, store) {
  const cfg = bruteCfg(env);
  const now = Date.now();
  const h = await ipHash(req);
  return updateBrute(store, (b) => {
    const rec = b.ips[h] || { fail: 0, until: 0, strikes: 0 };
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
    b.ips[h] = rec;
    return { out: { locked, retryAfterMs: rec.until > now ? rec.until - now : 0 } };
  });
}

/** 登录成功：清掉该 IP 的失败记录（无记录则不写——成功登录是热路径，不白花一次写） */
async function bruteClear(req, store) {
  const h = await ipHash(req);
  await updateBrute(store, (b) => {
    if (!b.ips[h]) return { out: null, dirty: false };
    delete b.ips[h];
    return { out: null };
  });
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

/** 字数统计（去所有空白后计数）—— 实现单点在 shared-text.js 的 countWords，与前端 cleaner 同一份；
 *  此处以别名 wordsOf import，调用点（增量字数修正）保持原样。 */

async function readJson(store, key, fallback) {
  const t = await store.getText(key);
  if (t == null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}
/* ---------------- 书架索引：v2 分片存储（千本级写放大消除 + 损坏自愈） ----------------
 * v1 是单文件 meta/index.json，任何一本书的任何改动都要全量重写（千本 ≈300KB/次），
 * 且 readIndexRaw 解析失败会静默回落空书架、下一次写把空架固化 —— 真·数据丢失路径。
 * v2 分片后：
 *   写 = 只写脏分片（+片级 bak）+ 成员变化时的 root（+bak），写放大 O(全库)→O(分片)；
 *   读 = root + 分片聚合，GET /api/books 响应形状不变（前端零改动）；
 *   自愈 = root 坏→root.bak→由分片内容重建；分片坏→片.bak→仍坏则**按空片处理且拒绝写入**
 *         （书在 R2 里的 meta 都还在，会以「无主书」出现在残留扫描，经回收站即可找回）。
 * 迁移：首次 openIndex 发现 root 不存在 → 读 v1 index 切片写 root/分片，零手工、用户无感；
 *       index.json 本体保留不动（回滚旧代码时仍有完整只读快照）。
 */
const IDX_SHARD_MAX = 500; // 单片书数上限；1000 本=2 片、5000 本=10 片，全量读 1+n 个子请求始终远低于 50
const KEY_IDX = {
  root: 'meta/idx/root.json',
  rootBak: 'meta/idx/root.json.bak',
  v1Bak: 'meta/index.json.v1.bak',
  shard: (n) => `meta/idx/s${n}.json`,
  shardBak: (n) => `meta/idx/s${n}.json.bak`,
};
const tryParseJson = (t) => {
  try {
    return t != null ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};
const looksRoot = (r) =>
  !!r && r.v === 2 && Number.isInteger(r.shards) && r.shards >= 0 && r.map && typeof r.map === 'object';

const readIndex = (store) => openIndex(store).then((h) => ({ books: h.books }));

const readTrash = (store) => readJson(store, KEY.TRASH, { books: [] });

/** trash 原文 → { books: [...] }（缺失/损坏/结构不对一律当空表，与 readJson 同判据） */
const parseTrash = (t) => {
  const j = t != null ? tryParseJson(t) : null;
  return j && Array.isArray(j.books) ? j : { books: [] };
};

/**
 * trash.json 的「读—改—写」（CAS 乐观锁 + 冲突重放）。与 updateBrute 同源：整文件无条件覆盖写
 * 会让并发的两次「摘条目」互相吃掉对方 —— 被吃掉的那本书既不在索引也不在回收站，UI 里彻底消失
 * （meta/正文还在 R2，只能靠「检查残留」找回）。软删 / 批量软删 / 恢复 / 彻底删除都会碰它。
 * mutate(t) 就地改 t 并返回 { out, dirty }；dirty === false 表示无需落盘。
 * ⚠️ mutate **可能被重放多次**：结果必须每次都从 t 重新推导，外层计数要累加就先清零。
 * pre：调用方已经读过一次（恢复要先按 id 找到条目）→ 传进来复用，省一次子请求；冲突重试时重新读。
 */
async function updateTrash(store, mutate, tries = 3, pre = null) {
  let snapshot = pre;
  for (let i = 0; i < tries; i++) {
    const cur = snapshot || (await getWithEtag(store, KEY.TRASH));
    snapshot = null;
    const t = parseTrash(cur && cur.text);
    const r = mutate(t);
    if (r.dirty === false) return r.out;
    const w = await putIf(store, KEY.TRASH, JSON.stringify(t), cur ? cur.etag : null);
    if (w.ok) return r.out;
  }
  // 重试耗尽（极端抖动）：再读一次最新状态叠加后无条件写。这里的失效方向必须偏保守 ——
  // 宁可多留一条可恢复记录，也不能把用户刚删的书从回收站里静默抹掉，所以不像索引那样直接抛错。
  const cur = await getWithEtag(store, KEY.TRASH);
  const t = parseTrash(cur && cur.text);
  const r = mutate(t);
  if (r.dirty !== false) await store.putText(KEY.TRASH, JSON.stringify(t));
  return r.out;
}

/** v1 单文件读取（迁移专用）：原文 + 解析一次拿两样 */
async function readIndexRaw(store) {
  const t = await store.getText(KEY.INDEX);
  let json = { books: [] };
  try {
    json = t != null ? JSON.parse(t) : { books: [] };
  } catch {
    json = { books: [] };
  }
  return { json, raw: t };
}

/** 书在架上的廉价判定：只读 root（1 次）。root 缺失/损坏时回落 openIndex（顺手迁移/自愈）。 */
async function indexHas(store, id) {
  const raw = await store.getText(KEY_IDX.root);
  if (raw != null) {
    const root = tryParseJson(raw);
    if (looksRoot(root)) return Number.isInteger(root.map[id]);
  }
  const h = await openIndex(store);
  return !!h.get(id);
}

/** 构造期对账：分片文件内容与 root.map 是**两处真相**（bak 回落、写盘半途失败都会让二者错位），
 * 而 books 读分片全文、get/patch/indexHas 只认 map —— 错位即「书架看得见、点进去 404」，
 * 下一次成员变更还会把错位 map 写回 root 把它固化。这里以「已读到的分片内容」为准把 map 修齐：
 *   ① 片里有、map 缺失或指向别片 → 补/改（同一 id 出现在多片时以**片号最小的那份**为准，
 *      其余副本摘除，免得书架出现两张同样的卡）
 *   ② map 里有、但该书所属分片**内容确凿读到**（raw 是字符串）却没这本书 → 摘除死指针
 * ② 的 raw 判据刻意放过「片缺失(raw===null)」与「片双坏(raw===undefined)」：那两种是
 * 「读不到」而不是「确认没有」，据此摘除会误删真书；partial=true（单书/并集模式只加载了
 * 部分分片）时同样只做 ①。返回 map 是否有改动（调用方据此置 rootDirty）。
 * 副作用：多片重复的 id 会从后出现的片里摘掉并标记该片脏（下次 save 时顺手清干净）。 */
function reconcileIdx(root, shardBooks, shardNo, shardRaw, dirty, partial, prunable = true) {
  let changed = false;
  const owner = new Set();
  for (let si = 0; si < shardBooks.length; si++) {
    const n = shardNo[si];
    const arr = shardBooks[si];
    const keep = [];
    for (const b of arr) {
      if (!b || !b.id) continue;
      if (owner.has(b.id)) {
        dirty.add(si); // 同 id 多片副本（半写/回滚产物）：只留最早那片
        continue;
      }
      owner.add(b.id);
      keep.push(b);
      if (root.map[b.id] !== n) {
        root.map[b.id] = n;
        changed = true;
      }
    }
    if (keep.length !== arr.length) shardBooks[si] = keep;
    // ② 的安全前提是「root.shards 覆盖了磁盘上全部分片」：若盘上还有未被加载的片，那么
    // 「本片确凿读到却没有」的书很可能只是**住在那些没加载的片里**，据此摘除＝误删真书
    // （实测：指针落后一代时 501 本被摘成 251 本）。prunable=false（调用方已查明盘上分片数
    // 大于 root.shards）时整段跳过。
    if (partial || !prunable || typeof shardRaw[si] !== 'string') continue;
    for (const id of Object.keys(root.map)) {
      if (root.map[id] === n && !owner.has(id)) {
        delete root.map[id];
        changed = true;
      }
    }
  }
  return changed;
}

function makeHandle(store, root, shards, opts = {}) {
  const shardBooks = shards.map((s) => s.books);
  const shardRaw = shards.map((s) => s.raw); // 各片原文（写 bak 用；null=新片）
  const shardMissing = shards.map((s) => !!s.missing); // 片与片 bak 都不存在（≠损坏：没有可丢的内容）
  const shardNo = shards.map((s) => s.n);
  // 各片主文件的版本号（CAS 用）。判据：**只有拿到了真实版本号的片才加条件**——新建片（拆片/首片）
  // 与「片文件本来就不存在」都没有可对号的旧版本，无条件写才会收敛：否则上次失败留下的孤儿片
  // （写成了但没进 root）会让重试永远撞「版本已变」，把一次瞬时冲突变成持续 500。
  const shardEtag = shards.map((s) => (typeof s.mainEtag === 'string' && s.mainEtag ? s.mainEtag : undefined));
  const dirty = new Set();
  let rootDirty = false;
  // 改动意图日志：save() 撞上 CAS 冲突时，用它在新盘面上重放这一轮的改动（见 save / saveOnce）。
  // 三条写方法各记一条，且必须**幂等**——upsert（已在架即原位覆盖）、patch（由 patchFn 重算）、
  // remove（删两次等价）。重放而不是把重试交给调用方：调用方只关心「最终索引里有哪些书」，
  // 不关心中途撞了几次冲突；做在 save() 里也意味着 7 个 mutate+save 调用点一次全覆盖。
  const opLog = [];
  // root 当前原文（rootDirty 写 bak 的「写前状态」）。null=此前 root 不存在（迁移/新库），
  // 此时没有可备份的旧布局——绝不能拿「空 root」当 bak（回退会得到合法但空的假布局），
  // 跳过一次 root bak，自愈链会落到「由分片重建」。
  let rootRaw = opts.rootRaw != null ? opts.rootRaw : null;
  // root 的版本号（openIndex 读 root 时拿到；migrate/rebuild 自己写完 root 后拿到新值）。
  // 非字符串 → 不做条件（理由同 shardEtag：没有可对号的旧版本）。
  let rootEtag = typeof opts.rootEtag === 'string' && opts.rootEtag ? opts.rootEtag : undefined;
  // 上面那条禁忌的**另一半**：root 存在但 shards:0（迁移空库后发布第一本书时正是这状态）
  // 同样没有值得备份的旧布局。实测过：拿它当 bak，一次 root 损坏就回落到「合法空书架」——
  // 书架 0 本，再发布还会覆盖首片，首书条目永久消失。判据＝「写前 root 是有效布局且至少 1 片」；
  // 每次 save 落盘后按新 root 重算。
  const parsedRootRaw = rootRaw != null ? tryParseJson(rootRaw) : null;
  let rootBakUsable = !!looksRoot(parsedRootRaw) && parsedRootRaw.shards > 0;
  if (reconcileIdx(root, shardBooks, shardNo, shardRaw, dirty, !!opts.partial, opts.prunable !== false)) rootDirty = true;

  const siOfShardNo = (n) => shardNo.indexOf(n);

  // 冲突重试时用哪套「打开参数」重读盘面：与首次调用**同模式**（single 保持 single，不让单书
  // 热路径在重试时退化成全量读），但必须丢掉 rootRaw/rootEtag —— 那是上一轮的快照，带着它
  // 重试＝拿旧状态重放，必然再撞一次冲突。
  const reopenOpts = () => {
    if (opts.single) return { single: opts.single, append: !!opts.append };
    if (opts.ids) return { ids: opts.ids };
    return {};
  };

  const h = {
    shardCount: root.shards, // 全量分片数（diag 等预算敏感方核算子请求用）
    root, // 预算敏感调用方（批量/标签）读 map 核算分片跨度用；勿直接改
    get books() {
      if (opts.single) throw new Error('单书模式无全量 books（应改用 full 模式）');
      return shardBooks.flat();
    },
    get(id) {
      const si = siOfShardNo(root.map[id]);
      if (si < 0) return undefined;
      return shardBooks[si].find((b) => b.id === id);
    },
    /** 原位替换/追加条目。已在架 → 保持原位（比 v1 的「删了再 push 到末尾」更稳定）；
     * 新成员 → 追加到最后一片，满片对半拆（拆分保持片内顺序，全局顺序在拆分处重排——前端本来就要排序，无感） */
    upsert(id, entry) {
      opLog.push({ op: 'upsert', id, entry });
      let si = siOfShardNo(root.map[id]);
      if (si >= 0) {
        const arr = shardBooks[si];
        const i = arr.findIndex((b) => b.id === id);
        if (i >= 0) arr[i] = entry;
        else arr.push(entry);
        dirty.add(si);
        return;
      }
      if (!shardBooks.length) {
        shardNo.push(root.shards); // 首片
        shardBooks.push([]);
        shardRaw.push(null);
        shardEtag.push(undefined); // 新片：盘上还没有 → 无条件写（不必 CAS，也无从 CAS）
        shardMissing.push(false); // 新片：文件还不存在，但里面没有可丢的内容（≠坏片的读不到）
        root.shards += 1;
      }
      const t = shardBooks.length - 1; // 最后一片
      shardBooks[t].push(entry);
      root.map[id] = shardNo[t];
      dirty.add(t);
      rootDirty = true;
      if (shardBooks[t].length > IDX_SHARD_MAX) {
        // 对半拆：尾半移入新片（文件号取 root.shards 顺延）
        const arr = shardBooks[t];
        const tail = arr.splice(Math.ceil(arr.length / 2));
        const newN = root.shards;
        shardNo.push(newN);
        shardBooks.push(tail);
        shardRaw.push(null);
        shardEtag.push(undefined); // 新片（无条件写，理由同上）
        for (const b of tail) root.map[b.id] = newN;
        root.shards = newN + 1;
        dirty.add(t);
        dirty.add(shardNo.length - 1);
      }
    },
    /** 原位打补丁（entry 对象由 patchFn 返回替换），书必须在已加载的片里 */
    patch(id, patchFn) {
      opLog.push({ op: 'patch', id, fn: patchFn });
      const b = h.get(id);
      if (!b) throw new Error(`patch: 书 ${id} 不在已加载分片中`);
      const si = siOfShardNo(root.map[id]);
      shardBooks[si][shardBooks[si].findIndex((x) => x.id === id)] = patchFn(b);
      dirty.add(si);
      return shardBooks[si].find((x) => x.id === id);
    },
    remove(id) {
      opLog.push({ op: 'remove', id });
      const si = siOfShardNo(root.map[id]);
      if (si < 0) return false;
      const arr = shardBooks[si];
      const i = arr.findIndex((b) => b.id === id);
      delete root.map[id];
      rootDirty = true;
      if (i < 0) return false;
      arr.splice(i, 1);
      dirty.add(si);
      return true;
    },
    /** 落盘：只写脏分片（bak=该片写前原文）+ 成员变化时的 root（bak=写前原文）。
     * bak:false 用于进度镜像这类高频小写（v1 语义：镜像不写 bak）。
     * replay:false → 撞 CAS 冲突不自己重放，直接抛给调用方（全量模式端点用，见 apiTagsMerge）。
     * replay: 数字 → 最多自己重放几次（预算敏感端点用，见 apiBatchBooks）。默认 2 次；重放次数
     *   直接决定子请求上界，所以预留了重放开销的调用方必须把它限死，预留才是精确值。
     * 返回 { skipped:[id...] }：重放时被跳过（书已被并发删除）的 patch id，供调用方修正计数。 */
    async save({ bak = true, replay = true, attempt = 0 } = {}) {
      try {
        await saveOnce(bak);
      } catch (e) {
        // 索引 CAS 冲突（盘面被别人改过，P2-6：两个标签页同时发布 → 后写者整文件覆盖前者）：
        // 重开索引拿新盘面 → 按 opLog 重放本轮的改动 → 再写一次。attempt 是内部计数，调用方别传。
        const maxReplay = replay === false ? 0 : typeof replay === 'number' ? replay : IDX_SAVE_TRIES - 1;
        if (!isIdxConflict(e) || attempt + 1 > maxReplay) throw e;
        const again = await openIndex(store, reopenOpts());
        const skipped = [];
        for (const o of opLog) {
          if (o.op === 'upsert') again.upsert(o.id, o.entry);
          else if (o.op === 'patch') {
            // 重放时书可能已被并发软删（新盘面的 map 里没有它）——patch 对不在架的书会抛
            // 非冲突错误 → 500。软删语义已吸收这次改动，跳过即可（2026-09-17 复查 F2）。
            if (again.get(o.id)) again.patch(o.id, o.fn);
            else skipped.push(o.id);
          } else again.remove(o.id);
        }
        // replay 必须带下去：否则嵌套那层用默认的 2 次重放，限次形同虚设（实测会多写一次 root）
        const sub = await again.save({ bak, replay, attempt: attempt + 1 });
        // 本 handle 的待落盘改动已由 again 那份落盘 → 清空，免得再次 save 拿旧内存态覆盖回去
        dirty.clear();
        rootDirty = false;
        opLog.length = 0;
        // 嵌套那层重放的是同一份 opLog（超集）→ 优先用它报的 skipped
        const miss = (sub && sub.skipped) || skipped;
        return miss.length ? { skipped: miss } : undefined;
      }
      // 落盘成功：本轮意图已持久化 → **必须清空 opLog**（2026-09-17 二次复查 R4）。留着它，
      // 同一个 handle 再 save 一次并撞冲突时，会把上一轮的陈旧改动（旧快照）一起重放回盘上，
      // 把并发方在这期间写的值覆盖掉——正是本轮在修的那类丢失更新。
      opLog.length = 0;
      return undefined;
    },
  };
  return h;

  /** 真正的落盘（原 save 主体）。被 save 包在 try 里以处理 CAS 冲突重放；单独拿出来是因为
   * 函数声明会提升，可以写在 return 之后，把「冲突重放」与「写序铁律」两件事分开表述。 */
  async function saveOnce(bak) {
      // 写序铁律（2026-09-16 审计修复）——**指针(root)先落、数据(分片)后落**。
      // 这里是「更新」路径，与 migrateV1（首次创建）的写序**相反**，不要照抄那边：
      //   · 数据先、指针后 + 指针写失败 → 磁盘「数据新、指针旧」。全量加载只到旧 shards，
      //     而 reconcileIdx ② 会把「指针说在本片、本片确凿读到却没有」的书当死指针摘掉，
      //     残缺指针随即被落盘固化（实测：501 本 → 251 本，分片文件还在但索引不认）。
      //   · 指针先、数据后 + 数据写失败 → 指针指着的内容未更新，对账 ①/② 都能自愈、书不会消失，
      //     最坏等于该次操作没生效（可重试）。
      // ① 前置校验必须早于任何写：否则「root 已更新、某片因双坏被跳过」会把指针推到与新数据不一致的位置。
      for (const si of dirty) {
        // 片**双坏**（读到字节但解析不了）→ 拒绝覆盖，留人工抢救的余地；片与片 bak **都不存在**
        // （迁移半途/外部删除）→ 没有可丢的内容，允许重建写入，否则一个缺失的片文件会让全库
        // 永久无法发布（save 一律 throw → 500）。
        if (shardRaw[si] === undefined && !shardMissing[si]) {
          throw new Error(`分片 ${shardNo[si]} 内容损坏且无备份，拒绝覆盖（避免固化数据丢失）`);
        }
      }
      // ② 写序（2026-09-17 审计补完）：判据不是「直觉上哪个更稳」，而是**失败后落在哪一侧**：
      //   · 指针领先于盘（root.shards > 盘上分片数）→ **无人能修**：resumeMigration 要求全部分片
      //     缺失、预筛的 onDisk > root.shards 是反方向、对账 ② 又刻意跳过「读不到」的片。实测 501 本
      //     的库拆片时 s1 写失败 → 重启只剩 251 本可见，且下一次 save 把僵尸指针固化。
      //   · 指针落后于盘（盘上分片数 > root.shards）→ 有覆盖：预筛走 rebuildIdxRoot 按盘重建 ✓
      //   · 只改既有片（shards 不变）→ 指针先落是对的：数据写失败时指针指着的内容没变，等于本次没生效
      // 因此：**本次新建了分片（首片/拆片）时，顺序必须是「新片 → 既有片 → root」**，让任何一种
      // 单点失败都落在「等于本次没发生」或「有人管」的一侧；没有新片时沿用「root 先、数据后」。
      // null=本次新建、盘上还没有；undefined=缺失片（missing，无内容可丢，同样该走「新片先落」序，
      // 否则 root.map 指向尚未重建的片=指针领先于盘。双坏片走不到这里（前置校验已拒绝覆盖）。
      // （2026-09-17 复查 F7）
      const fresh = [...dirty].filter((si) => shardRaw[si] == null);
      const writeRoot = async () => {
        if (!rootDirty) return;
        const next = JSON.stringify(root);
        // root 走 CAS（P2-6 的关键一步）：两个并发发布都会改 root，谁后写谁吃掉对方 —— 版本号一变
        // 就报冲突，由 withIdxRetry 重读重放。bak 是「写前状态」的快照（内容就是旧 root），不做 CAS。
        const jobs = [putIf(store, KEY_IDX.root, next, rootEtag)];
        if (bak && rootBakUsable) jobs.push(store.putText(KEY_IDX.rootBak, rootRaw));
        const [res] = await Promise.all(jobs);
        if (!res.ok) throw idxConflict('root');
        rootRaw = next;
        rootEtag = res.etag;
        rootBakUsable = root.shards > 0; // 落盘后「写前状态」即新布局
        rootDirty = false;
      };
      const writeShards = async (list) => {
        const jobs = [];
        for (const si of list) {
          const body = JSON.stringify({ books: shardBooks[si] });
          // 分片也走 CAS：同一片被两个请求并发读—改—写时，后写者会吃掉前者的书条目。
          const bakP = bak ? store.putText(KEY_IDX.shardBak(shardNo[si]), shardRaw[si] != null ? shardRaw[si] : body) : null;
          // 防悬挂 rejection（2026-09-17 复查 F6）：主片 putIf 若以 rejection 失败，下面的 .then
          // 不执行 → bakP 无人接管 → unhandledRejection 可打死 dev-server。先挂空 catch 占住
          // 处理位；成功分支里仍会 await bakP 拿真实结果（bak 写失败照旧让本次 save 失败）。
          if (bakP) bakP.catch(() => {});
          jobs.push(
            putIf(store, KEY_IDX.shard(shardNo[si]), body, shardEtag[si]).then(async (res) => {
              if (!res.ok) throw idxConflict('shard ' + shardNo[si]);
              if (bakP) await bakP;
              shardEtag[si] = res.etag;
              shardRaw[si] = body;
              shardMissing[si] = false;
              dirty.delete(si);
            })
          );
        }
        await Promise.all(jobs);
      };
      if (fresh.length) {
        await writeShards(fresh); // 新片先落：失败 ⇒ root 与既有片都没动，等于本次没发生
        await writeShards([...dirty]); // 既有片（放 root 之前：root 落后于盘有自愈覆盖）
        await writeRoot();
      } else {
        await writeRoot(); // 指针先落（既有片路径，第四轮审计的结论）
        await writeShards([...dirty]);
      }
  }
}

/** 读单个分片（带 bak 回落）。两级都坏 → broken（raw=undefined）：调用方 save() 会拒绝覆盖，
 * 书的 meta 本体仍在 R2，经「检查残留→无主书→移入回收站→恢复」可重建索引条目。
 * 两级**都不存在**（missing）→ 同样 raw=undefined，但语义是「没有内容可丢」，允许重新写入。 */
/** 索引并发冲突：CAS 版本已变（有人先写了）。必须由 withIdxRetry 捕获后重读重放，不该冒到 HTTP 层。 */
const idxConflict = (what) => Object.assign(new Error('索引并发冲突（' + what + '）'), { code: 'IDX_CONFLICT' });
const isIdxConflict = (e) => !!e && e.code === 'IDX_CONFLICT';
/** save() 因 CAS 冲突最多重放几次（含首次）。正常一次就成，第二次兜住并发，第三次只对极端抖动。 */
const IDX_SAVE_TRIES = 3;

/* 并发重放：原 withIdxRetry 已删除 —— 它需要每个调用点自己把 mutate 包成闭包，7 处漏一处就等于
 * 那一处并发丢更新照旧。现在重放做在 makeHandle.save() 内部（opLog），调用点零改动且新增端点自动覆盖。 */

async function loadIdxShard(store, n) {
  const main = await getWithEtag(store, KEY_IDX.shard(n));
  const j = main ? tryParseJson(main.text) : null;
  // mainEtag：主片文件的版本号（写盘 CAS 用）。注意它只代表**主片当时**的状态——即便下文回落到
  // 片 bak，CAS 目标仍是主片（把 bak 内容写回主片时，必须先确认主片没被别人改过）。
  const mainEtag = main ? main.etag : null;
  if (j && Array.isArray(j.books)) return { n, raw: main.text, books: j.books, mainEtag };
  const bak = await getWithEtag(store, KEY_IDX.shardBak(n));
  const jb = bak ? tryParseJson(bak.text) : null;
  if (jb && Array.isArray(jb.books)) return { n, raw: bak.text, books: jb.books, mainEtag };
  // broken：不落盘、不静默清空；missing：片与片 bak 都不存在（迁移中断/被外部删除）
  return { n, raw: undefined, books: [], mainEtag, missing: main == null && bak == null };
}

/** v1 → v2 迁移 + 新库初始化（root 不存在时的唯一入口）。
 * 迁移把 v1 books 按序**均匀整块**切片（500/片），v1 原文另存 v1Bak，index.json 本体冻结保留。
 * 不走「逐本 append + 满片拆」——那会留下一串 251/250 的参差片；整块切布局确定、一次写齐。
 * root 首次落盘没有「写前状态」→ 不写 root bak（自愈链有「由分片重建」兜底）。 */
async function migrateV1(store, { rootEtag = null } = {}) {
  const { json: legacy, raw } = await readIndexRaw(store);
  const books = (legacy.books || []).filter((b) => b && b.id);
  const chunks = [];
  for (let i = 0; i < books.length; i += IDX_SHARD_MAX) chunks.push(books.slice(i, i + IDX_SHARD_MAX));
  const root = { v: 2, shards: chunks.length, map: {} };
  chunks.forEach((arr, n) => {
    for (const b of arr) root.map[b.id] = n;
  });
  // 写序：分片（含片 bak）与 v1 留档先落，**root 最后提交**。root 是「布局已就绪」的指针，
  // 与分片同批并发写而中途失败就会留下「root 说有 2 片、分片一个都没写」——那一状态下 root
  // 看着合法，自愈链把缺失片当空片（书架永久为空），发布还要撞 save() 的拒写 → 500。
  // 现在的顺序下最坏只是白写一遍分片：下次 openIndex 见 root 缺失，重跑一次迁移（幂等）。
  const pre = [];
  if (raw != null) pre.push(store.putText(KEY_IDX.v1Bak, raw));
  // 分片带版本号落盘（putIf 无条件写，只是把新版本号收下来给紧随其后的那次写用）
  const etags = await Promise.all(
    chunks.map(async (arr, n) => {
      const body = JSON.stringify({ books: arr });
      const res = await putIf(store, KEY_IDX.shard(n), body, undefined);
      await store.putText(KEY_IDX.shardBak(n), body); // 首份内容即 bak 基线
      return res.etag;
    })
  );
  await Promise.all(pre);
  // root 的条件写按调用场景区分（这点由 fix8b 才真正生效——此前「null」被三端 store 当成无条件写）：
  //   · rootEtag === null（首次迁移/新库，盘上没有 root）→ 「不存在才写」：两个请求同时触发迁移
  //     只有一个落盘，输的那个读回落盘的那份（迁移幂等）；
  //   · rootEtag 是字符串（resumeMigration 续传，盘上那个不完整的 root 就在那儿）→ CAS 覆盖它。
  //     这里**不能**用「不存在才写」：写入会直接失败，盘上 root 仍是「shards 虚高」的旧布局，
  //     而分片已按 v1 重切 —— 指针领先于盘，是 save() 注释里那个「无人能修」的状态。
  let w = await putIf(store, KEY_IDX.root, JSON.stringify(root), rootEtag);
  if (!w.ok) {
    const again = await getWithEtag(store, KEY_IDX.root);
    w = { ok: true, etag: again ? again.etag : undefined };
  }
  return makeHandle(
    store,
    root,
    chunks.map((arr, n) => ({ n, raw: JSON.stringify({ books: arr }), books: arr, mainEtag: etags[n] })),
    { rootRaw: null, rootEtag: w.etag }
  );
}

/** root 与 root.bak 双坏（极罕见）：由分片内容重建 root。分片文件名即分片号，成员归属从片内容推导。
 * 每片都经 loadIdxShard（含片 bak 回落）——重建是最后一环，不能比常规读更容易丢字节。 */
async function rebuildIdxRoot(store) {
  const l = await store.list('meta/idx/', 2);
  // 片号从「主片名」与「片 bak 名」两处一起收集：主片被外部删掉而片 bak 还在时，只认主片名会把
  // 那一整片从 map 里抹掉——本来可救的字节被重建动作自己丢掉。
  const nums = new Set();
  for (const o of l.objects) {
    const m = /^meta\/idx\/s(\d+)\.json(?:\.bak)?$/.exec(o.key);
    if (m) nums.add(Number(m[1]));
  }
  // 逐片走 loadIdxShard（主片 → 片 bak 回落），不再自己 getText/parse：重建路径必须与常规读共用
  // 同一套自愈判据，否则「主片坏、片 bak 好」时重建会拿空数组覆盖真相（P2-2）。
  // 主片与片 bak 都读不出的片 → books:[]：其书在 R2 的 meta/正文仍在，会以「无主书」出现在残留
  // 扫描里、经回收站找回；片号本身保留（不把「读不到」当成「确认没有」）。
  const shards = await Promise.all([...nums].sort((a, b) => a - b).map((n) => loadIdxShard(store, n)));
  // 片号有空洞（主片与片 bak 都被外部删掉）时补空占位片：重建后 root.shards 必须 = 最大片号+1，
  // 而全量加载是按 0..root.shards-1 逐个读的——少一格就会让高号片（内容完好）永远读不到。
  const hasN = new Set(shards.map((s) => s.n));
  const topN = shards.length ? shards[shards.length - 1].n : -1;
  for (let n = 0; n <= topN; n++) if (!hasN.has(n)) shards.push({ n, raw: undefined, books: [], missing: true });
  shards.sort((a, b) => a.n - b.n);
  const root = { v: 2, shards: shards.length, map: {} };
  for (const s of shards) for (const b of s.books) root.map[b.id] = s.n;
  const rootRaw = JSON.stringify(root);
  // 重建是最后一环：无条件写（上面已经确定性读出了全部片），但要把新版本号收下来交给 handle
  const writes = [putIf(store, KEY_IDX.root, rootRaw, undefined)];
  if (shards.length) writes.push(store.putText(KEY_IDX.rootBak, rootRaw)); // 空恢复结果同样不留 bak（见 makeHandle）
  const [w] = await Promise.all(writes);
  return makeHandle(store, root, shards, { rootRaw: shards.length ? rootRaw : null, rootEtag: w.etag });
}

/** 迁移续传：root 声称有分片、但 meta/idx/ 下**一个 s*.json 对象都不存在**，且 v1 快照里有书
 * → 认定「分片一次都没写成的半途迁移」（旧版把 root 与分片并发写，root 可能先落），重跑一次。
 * 只在确认没有任何分片对象时才动：存在任何分片对象就交给自愈链，绝不覆盖可能可抢救的字节。 */
async function resumeMigration(store, rootEtag = null) {
  const l = await store.list('meta/idx/', 2);
  if (l.objects.some((o) => /^meta\/idx\/s\d+\.json/.test(o.key))) return null;
  const { json: legacy } = await readIndexRaw(store);
  if (!(legacy.books || []).some((b) => b && b.id)) return null;
  // 续传时盘上 root 已存在（就是不完整的那份）→ 把它的版本号带下去做 CAS 覆盖（见 migrateV1）
  return migrateV1(store, { rootEtag });
}

/**
 * 打开书架索引。默认全量（root + 全部分片）；{ single: id } 单书模式只读 root + 该书所在片
 * （热路径：进度镜像/就地编辑/PATCH/软删/恢复——写只碰一片）；{ ids } 并集模式（批量治理）。
 * { single: id, append: true } 追加模式：调用方保证该书不在索引里（发布新书 / 回收站恢复），
 * 片里没有它时**不再退化成全量加载**——一片就够写，让这两个端点的开销与书库规模无关（P2-5）。
 */
export async function openIndex(store, opts = {}) {
  // opts.rootRaw：调用方（批量接口）已经读过一次 root 用来核预算，传进来复用，省 1 子请求；
  // 显式传 undefined（而不是 null）才重新读——null 表示「root 确实不存在」，语义不同。
  // opts.rootEtag：与 rootRaw 配套的版本号（批量接口复用那次读时一起传进来）。
  // 注意：即使下面的 root 内容实际来自 root.bak，CAS 目标仍是**主 root 对象**，所以这里记的是
  // 主对象的版本（不存在 → null，表示「不存在才写」；老 store 无版本 → undefined，不加条件）。
  let rootRaw;
  let rootEtag;
  if (opts.rootRaw !== undefined) {
    rootRaw = opts.rootRaw;
    rootEtag = opts.rootEtag;
  } else {
    const o = await getWithEtag(store, KEY_IDX.root);
    rootRaw = o ? o.text : null;
    rootEtag = o ? o.etag : null;
  }
  let root = rootRaw != null ? tryParseJson(rootRaw) : null;
  let rootSrc = rootRaw;
  if (!looksRoot(root)) {
    const bak = await getWithEtag(store, KEY_IDX.rootBak);
    const rb = bak ? tryParseJson(bak.text) : null;
    if (looksRoot(rb)) {
      root = rb;
      rootSrc = bak.text;
    }
  }
  if (!root) {
    // root 缺失（新装 / v1）→ 迁移；root 与 bak 双坏 → 由分片重建
    if (rootRaw == null) return migrateV1(store);
    return rebuildIdxRoot(store);
  }

  if (opts.single) {
    // 单书模式：书已在片 → 该片；新书（恢复场景）→ 最后一片
    const n = Number.isInteger(root.map[opts.single]) ? root.map[opts.single] : Math.max(0, root.shards - 1);
    const shard = root.shards > 0 ? await loadIdxShard(store, n) : { n: 0, raw: null, books: [] };
    if (root.shards === 0) {
      root.shards = 1;
      shard.n = 0;
    }
    if (shard.books.some((b) => b && b.id === opts.single) || opts.append) {
      // 单书模式只加载一片 → 对账只做「补/改 map」，不做死指针摘除（看不到全局，会误删）。
      // opts.append：调用方已保证这个 id 不在索引里（发布新书 / 回收站恢复），要的是「能写进一片」；
      // 没有它时缺书会落到下面的全量加载（1+K 子请求）——2 万本/40 片下逼近 50 硬顶（P2-5）。
      // map 里有指针却在该片找不到（指针错位）时，append 让 upsert 往那片补条目，比全量加载
      // 更贴合「让 map 与分片内容自洽」，也不会多出一条同 id 记录。
      return makeHandle(store, root, [shard], { single: opts.single, rootRaw: rootSrc, rootEtag, partial: true });
    }
    // 兜底：指针说「在 n 片」而 n 片里根本没有它（指针错位/落后一代）。单书模式看不到全局、
    // 自己修不了它 —— 表现为书架看得见、点进去 404。这里**不返回**，落到下面的全量加载一次，
    // 借构造期对账 ① 把 map 修齐（代价是这一次多读 K-1 片，且只在异常态发生）。
  } else if (opts.ids) {
    const want = [...new Set(opts.ids.map((id) => root.map[id]).filter((n) => Number.isInteger(n) && n >= 0))];
    const shards = await Promise.all(want.sort((a, b) => a - b).map((n) => loadIdxShard(store, n)));
    return makeHandle(store, root, shards, { rootRaw: rootSrc, rootEtag, partial: true });
  }

  const shardNums = Array.from({ length: root.shards }, (_, i) => i);
  const shards = await Promise.all(shardNums.map((n) => loadIdxShard(store, n)));
  // 半途迁移的续传（只在全量模式下判定，且分片**一个都不存在**才算，见 resumeMigration）
  if (shards.length && shards.every((s) => s.missing)) {
    const resumed = await resumeMigration(store, rootEtag); // 复用上面那次 root 读的版本号
    if (resumed) return resumed;
  }
  // 死指针摘除（reconcileIdx ②）的安全前提：root.shards 覆盖了**磁盘上全部分片**。盘上若还有
  // 未被加载的片（指针落后一代 / 半写残留），「本片确凿读到却没有」的书其实住在那些片里，摘除
  // 就是误删。这里只做**廉价预筛**（纯内存）：map 条目数 vs 已加载片的书数 —— 只有前者更大
  // （确实存在「map 说有、已加载片里没有」的条目）时才多花 1 次 list 去数盘上分片数；
  // 正常路径（两者相等）零额外开销。
  let prunable = true;
  const loadedBooks = shards.reduce((n, x) => n + x.books.length, 0);
  if (Object.keys(root.map).length > loadedBooks) {
    try {
      const l = await store.list('meta/idx/', 2);
      const onDisk = l.objects.filter((o) => /^meta\/idx\/s\d+\.json$/.test(o.key)).length;
      if (!l.truncated && onDisk > root.shards) {
        // 盘上分片数**多于** root.shards：指针落后一代（半写残留 / 旧 bak 回落）。此时高号片里的书
        // 既看不见也点不动（加载哪些片由 root.shards 决定），map 里虽还留着它们却永远不会被读。
        // 直接按盘上文件重建一次 root（幂等：rebuildIdxRoot 以文件名推导 shards 与各片归属）。
        return rebuildIdxRoot(store);
      }
      prunable = !l.truncated && onDisk <= root.shards;
    } catch {
      prunable = false; // 数不出来就不摘（保守优先）
    }
  }
  // full 模式覆盖全部分片 → 对账可做完整（含死指针摘除），且 root 原文复用不再重读
  return makeHandle(store, root, shards, { rootRaw: rootSrc, rootEtag, prunable });
}


async function readBook(store, id) {
  const raw = await store.getText(KEY.book(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 状态副档读写：{ s: 'ready'|'creating' }，~20B。写点与 meta.status 赋值点一一对应（建书/更新/发布）。
 * 副档缺失/损坏 → 回落全量 meta 并补写副档（存量书一次性迁移），meta 也没有 → null。 */
const putStatus = (store, id, s) => store.putText(KEY.st(id), JSON.stringify({ s }));
async function readStatus(store, id) {
  try {
    const t = await store.getText(KEY.st(id));
    if (t) {
      const s = JSON.parse(t);
      if (s && (s.s === 'ready' || s.s === 'creating')) return s.s;
    }
  } catch {
    /* 副档异常 → 回落 meta */
  }
  const meta = await readBook(store, id);
  if (!meta) return null;
  await putStatus(store, id, meta.status).catch(() => {}); // 尽力补档：失败不影响本次判定
  return meta.status;
}


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
  // 公开端点加固：合法登录体不足 100 字节。走有界流式读取——即使客户端用 chunked
  // 不声明 Content-Length，超大请求也会在 64KB 处被中断，不会读满内存。
  // （本端点是唯一免鉴权入口，OOM 防护优先级最高；旧实现只看 content-length，可被绕过。）
  let body;
  try {
    body = JSON.parse(await readBodyText(req, 65536));
  } catch (e) {
    if (e && (e.message === '请求体超过上限' || e.message === '解压后超过上限')) return json({ error: '请求体过大' }, 413);
    body = {}; // 非法 JSON / 读取解压失败 → 统一走「口令错误」，不泄露内部细节
  }
  const pass = String(body.password || '');
  const admin = env.ADMIN_PASSWORD;
  if (!admin || !safeEqual(pass, admin)) {
    if (admin) await bruteFail(req, env, store);
    return json({ error: '口令错误' }, 401);
  }
  await bruteClear(req, store);
  const days = Number(env.SESSION_DAYS) || 30;
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
 * ⚠️ 只**读** trash 参数，不再改动它（条目摘除与 purge 续传标记都走 updateTrash，落在最新的
 * 那一份上）。调用方要判断「这本书删完没有」请看返回的 done，**别**去看自己那份 books.length
 * ——旧实现靠这里 splice 的副作用，CAS 化之后那个副作用就没有了。
 */
async function purgeOnce(store, trash, id, maxDel = PURGE_BATCH) {
  const idx = trash.books.findIndex((b) => b.id === id);
  if (idx < 0) return { entry: null, deleted: 0, done: true, remaining: 0 };
  let entry = trash.books[idx];
  let keys = Array.isArray(entry.purge) && entry.purge.length ? entry.purge : null;
  if (!keys) {
    const meta = await readBook(store, id);
    if (meta) {
      // 彻底删除要覆盖正文章节 + replace 遗留的孤儿章节，避免 R2 残留
      keys = (meta.chapters || []).map((c) => c.key).concat(Array.isArray(meta.orphans) ? meta.orphans : []);
    } else {
      // meta 已丢失（手工删除/损坏）：不能空手交差——否则 text/<id>/ 下所有正文永久残留，
      // 而回收站条目却已被摘除，只能靠 diag 兜底。按前缀列全量回收（上限 50 页≈5 万章）
      const prefix = `text/${id}/`;
      const listed = await store.list(prefix, 50).catch(() => ({ objects: [] }));
      keys = (listed.objects || []).map((o) => o.key.slice(prefix.length).replace(/\.txt$/, ''));
    }
  }
  const batch = keys.slice(0, maxDel);
  // 并发删除：子请求数不变，耗时从串行 N 次往返降为一批并发
  await Promise.all(batch.map((k) => store.delete(KEY.text(id, k))));
  const left = keys.slice(batch.length);
  let deleted = batch.length;
  let done = false;
  if (left.length) {
    entry = { ...entry, purge: left };
    await updateTrash(store, (t) => {
      const i = t.books.findIndex((b) => b.id === id);
      if (i < 0) return { dirty: false }; // 并发已把它清掉
      t.books[i] = { ...t.books[i], purge: left };
      return {};
    });
  } else {
    done = true;
    await Promise.all([store.delete(KEY.raw(id)), store.delete(KEY.book(id)), store.delete(KEY.progress(id)), store.delete(KEY.st(id))]);
    await updateTrash(store, (t) => {
      const i = t.books.findIndex((b) => b.id === id);
      if (i < 0) return { dirty: false };
      t.books.splice(i, 1);
      return {};
    });
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
    // 阅读状态三态：true 已读完 / false 明确未读完 / undefined 走自动判定
    readDone: meta.readDone === undefined ? undefined : !!meta.readDone,
    // 星标＝私人收藏标记。与阅读状态（readDone）/ 完结（finished）互不相干，也镜像进 index，
    // 这样书架筛选不必逐本读 meta（与 pinned/finished 同一套「摘要即真相」策略）。
    star: !!meta.star,
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
  const idx = await openIndex(store);
  return json({ books: idx.books });
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
    tags: Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [],
    wordCount: Number(body.wordCount) || 0,
    cleanVer: Number(body.cleanVer) || 1,
    createdAt: now,
    updatedAt: now,
    pinned: !!body.pinned,
    status: 'creating',
    chapters: chTable,
  };
  await Promise.all([store.putText(KEY.book(id), JSON.stringify(meta)), putStatus(store, id, 'creating')]);
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
  const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
  // 有界读取（含声明值快速拒绝）：旧实现先 req.arrayBuffer() 整体读入再判大小，超限时内存已吃满
  let buf;
  try {
    buf = await readBodyBytes(req, max);
  } catch (e) {
    if (e && (e.message === '请求体超过上限' || e.message === '解压后超过上限')) return json({ error: '章节超过上限' }, 413);
    return json({ error: '章节内容读取失败' }, 400);
  }
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
  const T0 = Date.now();
  const maxTotal = 16 * 1024 * 1024; // 单批正文字节护栏（body/内存）
  // 解压护栏 24MB：正文 ≤16MB + JSON 转义/键名开销余量（换行转义 \n 最坏翻倍也已覆盖），
  // 挡住 gzip 炸弹同时绝不误伤合法批次
  let body;
  try {
    body = JSON.parse(await readBodyText(req, 24 * 1024 * 1024));
  } catch (e) {
    if (e && (e.message === '解压后超过上限' || e.message === '请求体超过上限')) return json({ error: '请求体过大' }, 413);
    return json({ error: '无效的请求体' }, 400);
  }
  const list = Array.isArray(body.chapters) ? body.chapters : [];
  if (!list.length) return json({ error: '没有章节' }, 400);
  if (list.length > BULK_CHAPTER_BATCH) return json({ error: `单批最多 ${BULK_CHAPTER_BATCH} 章` }, 413);
  const meta = await readBook(store, id);
  const tMeta = Date.now() - T0;
  if (!meta) return json({ error: '书不存在' }, 404);
  if (meta.status === 'ready') return json({ error: '书已发布，请改用章节编辑接口' }, 409);
  const table = new Set((Array.isArray(meta.chapters) ? meta.chapters : []).map((c) => c.key));
  const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
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
  const T1 = Date.now();
  await Promise.all(items.map((it) => store.putText(KEY.text(id, it.key), it.text)));
  const tPut = Date.now() - T1;
  // 响应不带逐章 words：前端只用 count，而对 ≤12MB 批正文逐章跑正则统计是纯 CPU 浪费
  // （规模化后每本书几十批，累计可省数秒 CPU——Free 计划 10ms CPU/请求的贴边场景）。
  // 字数入库时信任客户端 cleaner 统计，与 publish 同一策略。
  // t 为服务端分阶段耗时（meta 读一段含 body 解压/解析；批内并发写正文），与 publish 的 t 字段同用途：慢链路诊断。
  // put 的耗时形态可区分「并发写被分波排队」（减批有救）vs「单次 R2 写本身慢」（减批反亏）。
  return json({ ok: true, count: items.length, t: { meta: tMeta, put: tPut, total: Date.now() - T0 } });
}

/** 上传原件（原始字节留档，重洗/恢复依据）。前端大文件 gzip 传输（x-content-gzip 标记）：
 * 解压护栏 = MAX_UPLOAD（解压产物超限即中断流，防 gzip 炸弹），解压后按明文落盘——
 * 存储格式不变（重洗读原件零改动，旧数据天然兼容）。 */
async function apiPutRaw(req, env, store, id) {
  const max = Number(env.MAX_UPLOAD) || MAX_UPLOAD_BYTES;
  // 声明值/流式超限都在 readBodyBytes 内处理（含 413 映射），此处不再自行 dropBody 排空——
  // 排空超大体等于把它读进内存，反而制造 OOM 面
  let buf;
  try {
    buf = await readBodyBytes(req, max);
  } catch (e) {
    if (e && (e.message === '解压后超过上限' || e.message === '请求体超过上限')) return json({ error: `原件超过上限 ${(max / 1048576) | 0}MB` }, 413);
    if (e && e.message === '请求体解压失败') return json({ error: '原件解压失败' }, 400);
    return json({ error: '原件读取失败' }, 400);
  }
  if (!buf.byteLength) return json({ error: '空文件' }, 400);
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

  if (!(await indexHas(store, id))) return json({ error: '书不在书架（可能已删除或未发布）' }, 404);

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
    meta.tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [];
  }
  if (body.wordCount !== undefined) {
    // append 只传新增部分的字数 → 在旧字数上累加；replace 传的是整本字数 → 直接采用
    // 两条分支都要夹到 ≥0：异常/恶意客户端传负数会把总字数写成负值（replace 原本就夹了，append 漏了）
    meta.wordCount = Math.max(
      0,
      op === 'append' ? (Number(meta.wordCount) || 0) + (Number(body.wordCount) || 0) : Number(body.wordCount) || 0
    );
  }
  meta.cleanVer = (Number(meta.cleanVer) || 0) + 1;
  meta.updatedAt = now;
  meta.status = 'creating'; // publish 前不可读
  await Promise.all([store.putText(KEY.book(id), JSON.stringify(meta)), putStatus(store, id, 'creating')]);
  return json({ ok: true, op, cleanVer: meta.cleanVer, chapterKeys: meta.chapters.map((c) => c.key) });
}

/**
 * 发布：抽样校验首/中/尾章存在 → 写 index（先 .bak）。
 * 字数信任客户端 cleaner 统计（meta.wordCount）——绝不逐章回读（R2 子请求上限）。
 */
async function apiPublish(req, env, store, id) {
  const T0 = Date.now();
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书不存在' }, 404);
  if (!meta.chapters || !meta.chapters.length) return json({ error: '书还没有章节' }, 400);
  const tMeta = Date.now() - T0;
  const keys = meta.chapters.map((c) => c.key);
  const samples = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]].filter((k, i, arr) => arr.indexOf(k) === i);
  // 三个互不依赖的读并行（原实现串行 3 程）：抽样正文 + 索引（single+append：root + 1 片）+ progress 镜像源。
  // 发布是导入链路里最高频的写，索引原来按 full 打开只为顺带在响应里回传整张 books 快照 → 2 万本/40 片
  // 实测 52 个子请求，越过 Cloudflare 的 50 硬顶（P2-5）。改为「新书追加到最后一片」，发布开销与书库
  // 规模**无关**；代价是上传收尾多一次 GET /api/books（前端两处都已有兜底分支）。
  const T1 = Date.now();
  const [sampled, idx, ptRaw] = await Promise.all([
    Promise.all(samples.map((k) => store.getText(KEY.text(id, k)))),
    openIndex(store, { single: id, append: true }),
    store.getText(KEY.progress(id)).catch(() => null),
  ]);
  const tVerify = Date.now() - T1;
  for (let i = 0; i < samples.length; i++) {
    if (sampled[i] == null) return json({ error: `章节 ${samples[i]} 未上传，发布中止` }, 409);
  }
  meta.chapterCount = keys.length;
  meta.wordCount = Math.max(Number(meta.wordCount) || 0, 0);
  meta.status = 'ready';
  meta.updatedAt = Date.now();
  if (Array.isArray(meta.orphans) && meta.orphans.length) await sweepOrphans(store, meta);
  // 书架角标镜像以 progress 文件当前值为准（rewash/replace 可能刚重置过进度）
  const old = idx.get(id);
  let prog = old && old.prog;
  try {
    if (ptRaw) {
      const p = JSON.parse(ptRaw);
      if (p && Number.isFinite(p.ch)) prog = { ch: p.ch, ratio: p.ratio || 0, updatedAt: p.updatedAt || 0 };
    }
  } catch {
    /* 读取失败沿用旧镜像 */
  }
  idx.upsert(id, indexEntryFromMeta(meta, { pinned: !!(old && old.pinned) || !!meta.pinned, prog }));
  // 三个互不依赖的写并行：状态副档 ∥ meta ∥ 索引（脏分片 + bak + root 如有成员变化）。
  // 任一写失败的后果与原「副档先行」分析同类：可读/409 短暂不一致，重试发布即愈合
  const T2 = Date.now();
  await Promise.all([putStatus(store, id, 'ready'), store.putText(KEY.book(id), JSON.stringify(meta)), idx.save({ bak: true })]);
  const tWrite = Date.now() - T2;
  // 不再回传 books 快照（见上：为它做全量读会在 2 万本量级撞 50 子请求硬顶）。前端 upload.js /
  // upload/files.js 两处都有 `if (pub.books) … else loadShelf()` 兜底，新旧前后端任意组合都安全。
  // t 为服务端分阶段耗时（meta 读 / 校验+读 / 写），供慢链路诊断
  return json({
    ok: true,
    id,
    wordCount: meta.wordCount,
    chapterCount: meta.chapterCount,
    cleanVer: meta.cleanVer,
    t: { meta: tMeta, verify: tVerify, write: tWrite, total: Date.now() - T0 },
  });
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

/** 改元信息（书名/作者/标签/置顶）——PATCH，同步 index（单书模式：只碰该书所在分片） */
async function apiPatchBook(req, store, id) {
  const body = await req.json().catch(() => ({}));
  const idx = await openIndex(store, { single: id });
  if (!idx.get(id)) return json({ error: '书不在书架（可能已删除或未发布）' }, 404);
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
    meta.tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [];
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
  // 「已读完」＝我的阅读状态，与 finished（这本书本身写完了）是两回事，故单独一个字段。
  // 三态：true 强制已读完 / false 强制未读完（用来摘掉自动判定出来的标记）/ 缺省走自动判定。
  // 老书没有该字段 → undefined → 自动回落判定，天然兼容，无需迁移。
  if (body.readDone !== undefined) {
    meta.readDone = !!body.readDone;
    patch.readDone = !!body.readDone;
  }
  if (body.star !== undefined) {
    meta.star = !!body.star;
    patch.star = !!body.star;
  }
  meta.updatedAt = Date.now();
  patch.updatedAt = meta.updatedAt;
  await store.putText(KEY.book(id), JSON.stringify(meta));

  idx.patch(id, (b) => ({
    ...b,
    title: patch.title !== undefined ? patch.title : b.title,
    author: patch.author !== undefined ? patch.author : b.author,
    tags: patch.tags !== undefined ? patch.tags : b.tags,
    pinned: patch.pinned !== undefined ? patch.pinned : !!b.pinned,
    finished: patch.finished !== undefined ? patch.finished : !!b.finished,
    readDone: patch.readDone !== undefined ? patch.readDone : b.readDone,
    star: patch.star !== undefined ? patch.star : !!b.star,
    updatedAt: patch.updatedAt,
  }));
  await idx.save({ bak: true });
  return json({ ok: true });
}

/** 读一章正文。?v=cleanVer 做缓存击穿，rewash 后立即生效
 * 只放行已发布书：replace/append 期间书处于 creating，旧正文不应被读到（与 bookMeta/export 一致）；
 * 也避免「replace 后旧 key 正文残留、发布抽样未命中」时旧正文顶着新章表长期被读。 */
async function apiChapter(store, id, key) {
  // 只读状态副档（~20B）判定可读性：千本规模下每章 GET 省一次全量 meta JSON.parse
  // （2000 章书 meta≈1MB，在 Free 10ms CPU 上是主要开销）。副档缺失时回落 meta 并补档。
  const st = await readStatus(store, id);
  if (st == null) return json({ error: '章节不存在' }, 404);
  if (st !== 'ready') return json({ error: '书正在更新中，请稍后重试' }, 409);
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
  if (!(await indexHas(store, id))) {
    return { resp: json({ error: '书不在书架（可能已删除或未发布）' }, 404) };
  }
  const meta = await readBook(store, id);
  if (!meta) return { resp: json({ error: '书不存在' }, 404) };
  if (meta.status !== 'ready') return { resp: json({ error: '书正在更新中，请稍后重试' }, 409) };
  return { meta };
}

/** 就地编辑后同步书架摘要：单书模式打开（只碰该书分片）→ 重建该条目（章数/字数/更新时间 + 保留 pinned/进度镜像） */
async function syncIndexAfterEdit(store, meta) {
  // 首波两读并行（该书分片 + progress），第二波两写并行（bak + 分片）——4 程 → 2 波
  const [idx, ptRaw] = await Promise.all([
    openIndex(store, { single: meta.id }),
    store.getText(KEY.progress(meta.id)).catch(() => null),
  ]);
  let prog;
  try {
    if (ptRaw) {
      const p = JSON.parse(ptRaw);
      if (p && Number.isFinite(p.ch)) prog = { ch: p.ch, ratio: p.ratio || 0, updatedAt: p.updatedAt || 0 };
    }
  } catch {
    /* 无进度则沿用原镜像 */
  }
  // 书在「守卫通过之后、这次 patch 之前」被并发软删摘出索引时，patch 会抛非冲突错误 → 500，
  // 而正文与 meta 已经写完（响应说失败、盘上已改）。软删语义已吸收这次编辑，索引条目已由删除
  // 流程摘掉，跳过同步即可——与 apiPatchBook / apiProgressPut 的 get() 守卫对齐
  // （2026-09-17 二次复查 R2）。
  if (idx.get(meta.id)) {
    idx.patch(meta.id, (b) => ({ ...indexEntryFromMeta(meta), pinned: !!b.pinned, prog: prog || b.prog }));
    await idx.save({ bak: true });
  }
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
    const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
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
  const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
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
  // 离线队列回放的对账（L6 / L17）：只有客户端带上「原写入时间」或「入队时的内容版本」时才做。
  //   · 迟到：盘上真值的 updatedAt 比它新 → 丢弃。离线期间排队、回网后迟到的旧值不能把更新的
  //     进度回退（同一设备上也成立：联网后先读了新章，随后队列才回放）。
  //   · 版本不符：该书在离线期间被编辑/重洗（cleanVer 变了）→ 旧章号已失去意义 → 丢弃，
  //     否则进度会落在错误的章上（表现为跨设备编辑后进度 ±1）。
  // 在线正常写入不带这两个字段 → 零额外读，行为与从前完全一致（无条件覆盖）。
  const clientAt = Number(body.updatedAt) || 0;
  const clientVer = Number(body.cleanVer) || 0;
  if (clientAt || clientVer) {
    const prev = await store.getText(KEY.progress(id)).catch(() => null);
    const pv = tryParseJson(prev);
    if (pv && clientAt && (Number(pv.updatedAt) || 0) > clientAt) return json({ ok: true, skipped: 'stale' });
    if (clientVer) {
      const m = await readBook(store, id).catch(() => null);
      if (m && Number(m.cleanVer || 1) !== clientVer) return json({ ok: true, skipped: 'cleanVer' });
    }
  }
  const data = { ch, ratio, updatedAt: Date.now() };
  await store.putText(KEY.progress(id), JSON.stringify(data));

  // 书架进度角标镜像：只在「换章」时写该书所在分片（单书模式）。章内滚动只写 progress 小文件（真值），
  // 不再写镜像 —— 消除写放大（千本规模分片≈150KB/次，长章滚几屏就是几十次），
  // 同时收窄分片读-改-写与 publish 并发时的覆盖窗口。
  // 代价：镜像百分比停留在最近一次换章时的值（书架角标「第几章」仍准确；恢复阅读读 progress 真值，不受影响）。
  try {
    const idx = await openIndex(store, { single: id });
    const book = idx.get(id);
    if (!book) return json({ ok: true });
    // 越界进度压回末章（镜像供书架角标直接显示，不能出现「读到 999/10 章」）
    // 恶意/异常客户端可能直接 PUT 超章数 ch；正常前端已 clamp，这里做服务端兜底。
    const cap = Number(book.chapterCount) || 0;
    const mch = cap > 0 && ch > cap ? cap : ch;
    const cur = book.prog;
    // 刷新条件＝「换章」或「读完状态翻转」。
    // 原实现只有前者：而读完一本书的典型动作是停在末章继续往下滚到底——章号不变、
    // 只有 ratio 变，原条件永远不成立 → 书架镜像的 ratio 停在旧值，角标「已读完」
    // 在实践中几乎永远点不亮。补上状态翻转后：跨过阈值那一刻多写恰 1 次镜像，
    // 已读完后继续滚动不再写，仍然不产生写放大（这正是当初只在换章时写的动机）。
    const isDone = cap > 0 && mch >= cap && ratio >= READ_DONE_RATIO;
    const curDone =
      !!cur && cap > 0 && Math.min(Number(cur.ch) || 0, cap) >= cap && (Number(cur.ratio) || 0) >= READ_DONE_RATIO;
    if (!cur || cur.ch !== mch || curDone !== isDone) {
      idx.patch(id, (b) => ({ ...b, prog: { ch: mch, ratio, updatedAt: data.updatedAt } }));
      await idx.save({ bak: false }); // 镜像写沿用 v1 语义：不写 bak（progress 真值文件才是权威）
    }
  } catch {
    /* ignore */
  }
  return json({ ok: true });
}

/* ---------------- 批量操作 / 标签治理（分片预算核账后裁剪，客户端按 deferred/remaining 续调） ---------------- */

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
  const tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [];
  // setTags 允许空数组（清空标签），其余两种必须给非空标签
  if (action !== 'setTags' && action !== 'setFinished' && action !== 'delete' && !tags.length) {
    return json({ error: '请填写标签' }, 400);
  }
  if (action === 'setFinished' && body.finished === undefined) return json({ error: '缺少 finished' }, 400);

  const batch = ids.slice(0, BATCH_BOOKS_MAX);
  // 分片版预算核算：先拿 root.map（1 读；开索引时把这份原文传进去复用，不再读第二次），
  // 把 targets 裁到子请求预算内再开索引。
  // 非删除：1(root) + k 片读 + 2N(meta 读+写) + 2k(片写+bak) = 1+3k+2N ≤ 48
  // 删除：  1(root) + k 片读 + 1(trash 读) + 2k(片写+bak) + 2(root 写+bak) + 1(trash 写) = 5+3k ≤ 48
  // 被裁掉的 id 必须**原样回传**（deferred）让客户端排回队列续调——v1 单文件时代 k 恒为 1 用不着算，
  // 分片后 18 本随机目标可能散在多片；「裁掉却不告诉客户端」＝静默丢书（v2 实测：18 本散 5 片只处理 16 本）。
  // 不在架（回收站/半成品）的书既不占预算也不进 deferred：重试多少次都不在架，会死循环。
  //
  // 廉价预筛的前提是「root.map 就是可信的在架名单」。它有两个失效态：
  //   · map 缺条目（P2-3）——root 从 .bak 回落后要等对账 ① 才补上，或盘上分片比 root.shards 多。
  //     此时确实在架的书会被判 offShelf：既不处理也不 deferred，前端把它计成「失败（可能是半成品
  //     书）」且不重试，标签/完结状态永远改不动。
  //   · root 深度坏（P2-4）——自愈（rebuildIdxRoot 的 list + 逐片读 + root 写）也吃子请求，
  //     原公式当成 0，实测越过 50 硬顶。
  // 两种都改为先做一次**全量打开**（含自愈与对账）拿到真相，并把该 handle 复用到本批操作（不再
  // 第二次开索引）；这次多花的子请求从预算里预扣。正常态（map 覆盖全部目标）仍只读 1 次 root。
  const rootInfo = await (async () => {
    const cur = await getWithEtag(store, KEY_IDX.root);
    const raw = cur ? cur.text : null;
    const rootEtag = cur ? cur.etag : null;
    const root = tryParseJson(raw);
    if (looksRoot(root) && batch.every((id) => Number.isInteger(root.map[id]))) {
      return { root, raw, rootEtag, extra: 0, handle: null }; // 廉价路径：map 覆盖了全部目标，可当在架名单用
    }
    // 全量打开（rootRaw/rootEtag 复用上面那次读，省 1 读）：root 不可解析时顺带走 root.bak → 由分片重建。
    const h = await openIndex(store, { rootRaw: raw, rootEtag });
    // 预扣已花的子请求：1（root 读）+ K（全量片读）+ 不可解析时 1（root.bak）+ 重建 1（list）+ 2（root/root.bak 写）
    const extra = 1 + h.shardCount + (looksRoot(root) ? 0 : 4);
    return { root: h.root, raw: null, rootEtag: null, extra, handle: h };
  })();
  const shardNoOf = (id) => (Number.isInteger(rootInfo.root.map[id]) ? rootInfo.root.map[id] : null);
  const budget = Math.max(0, 48 - rootInfo.extra); // 预扣掉的（自愈/全量读）不再给本批用
  const shardSet = new Set();
  const processed = [];
  const offShelf = new Set();
  for (const id of batch) {
    const n = shardNoOf(id);
    if (n == null) {
      offShelf.add(id); // 不在架（含回收站/半成品）——沿用 v1 语义由 inShelf 过滤，不占预算
      continue;
    }
    const newS = shardSet.has(n) ? shardSet.size : shardSet.size + 1;
    // 预扣一次 CAS 冲突重放的开销（2026-09-17 复查 F3）：save() 撞冲突会重开索引
    // （root 1 读 + 跨片读）并重写（root 1 写 + 每脏片 2 写）≈ 2+3*newS。不预留的话，
    // 顶格批量撞冲突 → 重放把总子请求顶破 Workers 50 上限。
    // ⚠️ 这个预留**只在「最多重放一次」时才成立**——所以下面 save() 一律传 replay:1
    // （2026-09-17 二次复查 R3 实测：默认允许 2 次重放，6 片删除连续两次冲突时达 ~56 > 50）。
    const replay = 2 + 3 * newS;
    const est = (action === 'delete' ? 5 + 3 * newS : 1 + 3 * newS + 2 * (processed.length + 1)) + replay;
    if (est > budget) break;
    shardSet.add(n);
    processed.push(id);
  }
  const processedSet = new Set(processed);
  const deferredInBatch = batch.filter((id) => !processedSet.has(id) && !offShelf.has(id));
  const deferred = deferredInBatch.concat(ids.slice(BATCH_BOOKS_MAX)); // 预算裁掉的 + 超单批上限的尾巴
  // 自愈轮：本批的预算全花在修 root 上了（大库下预扣直接吃光）→ 一本没动，但盘面已修好。
  // 明确告诉客户端「这一批退回不是死局，再发一次」，否则 runBatched 会把整批退回当零进展收手（P2-4）。
  const retry = rootInfo.extra > 0 && processed.length === 0;
  // 已经全量打开的 handle 直接复用（是 { ids } 模式的超集），绝不第二次开索引
  const openOpts = { ids: processed, ...(rootInfo.raw != null ? { rootRaw: rootInfo.raw, rootEtag: rootInfo.rootEtag } : {}) };
  const idx = rootInfo.handle || (await openIndex(store, openOpts));
  const inShelf = new Set(processed.filter((id) => !!idx.get(id)));
  const targets = processed.filter((id) => inShelf.has(id));
  const remain = batch.length - deferredInBatch.length; // 本批「该处理」的本数（不含被裁/超限）

  if (action === 'delete') {
    const n = await batchSoftDelete(store, idx, targets);
    return json({ ok: true, updated: n, skipped: remain - n, deferred, ...(retry ? { retry: true } : {}) });
  }

  // 读一波全并行（20 本 = 20 次并发 GET，替代逐本串行 20 程），meta 缺失的书跳过
  const metas = await Promise.all(targets.map((id) => readBook(store, id)));
  const now = Date.now();
  const patches = new Map();
  const writes = [];
  for (let i = 0; i < targets.length; i++) {
    const meta = metas[i];
    if (!meta) continue;
    if (action === 'addTags') {
      const set = new Set(meta.tags || []);
      for (const t of tags) set.add(t);
      meta.tags = Array.from(set).slice(0, TAG_MAX);
    } else if (action === 'removeTags') {
      const rm = new Set(tags);
      meta.tags = (meta.tags || []).filter((t) => !rm.has(t));
    } else if (action === 'setTags') {
      meta.tags = tags;
    } else if (action === 'setFinished') {
      meta.finished = !!body.finished;
    }
    meta.updatedAt = now;
    writes.push(store.putText(KEY.book(targets[i]), JSON.stringify(meta))); // 写一波全并行
    patches.set(targets[i], { tags: meta.tags || [], finished: !!meta.finished, updatedAt: meta.updatedAt });
  }
  if (writes.length) await Promise.all(writes);

  let patchSkip = 0;
  if (patches.size) {
    // 这里与上方的 inShelf 守卫读的是**同一份内存快照**：openIndex 在 inShelf 之前已打开，
    // 两者之间只 await 各书 meta 写入（不触碰 shardBooks），而外部并发只能改盘面、改不了
    // 这份快照 → 守卫恒不触发（2026-09-18 生产前审计以「移除守卫后并发软删用例仍全绿」坐实，
    // 回归见 test/review-fix135.test.mjs 的「守卫当前不可达」用例）。
    // 保留它只作防御：若日后 openIndex 改成惰性取片，这里会重新变成真实窗口。
    // 真正覆盖「并发软删」的是下面 save() 的重放路径（F2 的 again.get 守卫）——它才读新盘面。
    for (const [id, p] of patches) {
      if (!idx.get(id)) { patchSkip++; continue; }
      idx.patch(id, (b) => ({ ...b, ...p }));
    }
    // 重放时书被并发删除 → 该 patch 被跳过（F2）→ 不能计入 updated，否则文案与实际盘面不符
    // （2026-09-17 二次复查 R5）
    // replay:1：预算只按「一次重放」预扣，次数必须一起限死（R3）；第二次冲突冒成 409 让客户端重试
    const r = await idx.save({ bak: true, replay: 1 });
    // 累加而非覆盖：上面守卫跳过的书没有进 opLog，因此不会出现在 r.skipped 里，两批互不重叠。
    // 用覆盖的话，守卫一旦真的命中，它的计数就被静默抹掉 → updated 多报（2026-09-18 审计）。
    if (r && r.skipped) patchSkip += r.skipped.length;
  }
  const updated = patches.size - patchSkip;
  return json({ ok: true, updated, skipped: remain - updated, deferred, ...(retry ? { retry: true } : {}) });
}

/** 批量软删：索引分片摘除成员 + trash 一次写入（不读各书 meta，index 条目即摘要）。
 * 返回实际入回收站的本数——响应体（含续调信息 deferred）只在 apiBatchBooks 一处拼装。 */
async function batchSoftDelete(store, idx, targets) {
  if (!targets.length) return 0;
  // 先取条目（remove 之后索引里就没有了；trash 条目 = index 摘要 + deletedAt）
  const entries = new Map();
  for (const id of targets) {
    const e = idx.get(id);
    if (e) entries.set(id, e);
  }
  for (const id of targets) idx.remove(id);
  await idx.save({ bak: true, replay: 1 }); // 同上：delete 的预算（5+3k）只预扣一次重放（R3）
  // trash 走 CAS（见 updateTrash）：并发的另一次软删不会把这一批条目吃掉
  let n = 0;
  await updateTrash(store, (t) => {
    n = 0; // mutate 可能被重放 → 计数每次从零重算，绝不累加
    for (const id of targets) {
      const ei = t.books.findIndex((x) => x.id === id);
      if (ei >= 0) {
        // 批量目标全部来自在架书 → 条目已存在只可能是「恢复×批量删」竞态（书刚被恢复流程
        // 写回索引）→ 刷新 deletedAt 让恢复流程的摘条目作废，同 apiSoftDelete 的判据（F1）。
        t.books[ei] = { ...t.books[ei], deletedAt: Date.now() };
        n++;
        continue;
      }
      const entry = entries.get(id);
      if (entry) {
        t.books.push({ ...entry, deletedAt: Date.now() });
        n++;
      }
    }
    return { dirty: n > 0 };
  });
  return n;
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

  const idx = await openIndex(store);
  const hit = idx.books.filter((b) => (b.tags || []).includes(from));
  if (!hit.length) return json({ ok: true, updated: 0, remaining: 0 });

  // 分片版预算：已花 1+K（root+全部分片，标签命中必须全库扫）；
  // 每处理一本 +2（meta 读+写），每新增一个脏分片 +2（片写+bak）→ 1+K+2N+2k ≤ 48 贪心裁剪
  const shardNoOf = (id) => (Number.isInteger(idx.root.map[id]) ? idx.root.map[id] : -1);
  const shardSet = new Set();
  const targets = [];
  for (const b of hit) {
    const n = shardNoOf(b.id);
    const newS = shardSet.has(n) ? shardSet.size : shardSet.size + 1;
    // 预算只算**本次实际要发的**请求：1（root 读）+ K（全片读——标签命中必须全库扫）+ 每本 2
    // （meta 读+写）+ 每脏片 2（片写+bak）。
    // ⚠️ **不预扣冲突重放开销**（2026-09-17 二次复查 R1，实测复现）：全量模式的重放要重读 root+K 片
    // 再重写（≈2+K+2k），K 大时（2 万本/40 片）连 1 本都装不下 → 预留会让本端点**恒零进展**
    // （K≥20 时 updated 恒为 0，前端 guard<60 白跑 60 轮全库扫描，共 ~2460 子请求）。
    // 冲突改由 save({replay:false}) 抛给本端点 → 返回可续调响应（下面），前端循环重发即可。
    if (1 + idx.shardCount + 2 * (targets.length + 1) + 2 * newS > 48) break;
    shardSet.add(n);
    targets.push(b);
  }
  if (!targets.length) return json({ ok: true, updated: 0, remaining: hit.length });
  // 读一波全并行（替代逐本串行，同 apiBatchBooks）
  const metas = await Promise.all(targets.map((b) => readBook(store, b.id)));
  const now = Date.now();
  const patches = new Map();
  const writes = [];
  for (let i = 0; i < targets.length; i++) {
    const b = targets[i];
    const meta = metas[i];
    if (!meta) continue;
    const out = [];
    for (const t of meta.tags || []) {
      if (t === from) {
        if (to && !out.includes(to)) out.push(to); // 改名/合并：落到目标标签（已存在则不重复）
        continue;
      }
      // to 不能在此无条件跳过：index 声明 from 但 meta 已无 from（meta 写波成功、idx.save
      // 失败的残留态，重试必然命中）时，跳过会把书上的 to 清掉。去重由 includes 保证——
      // from 分支 push to 前已查重、这里放行 to 也不会重复。
      if (!out.includes(t)) out.push(t);
    }
    meta.tags = out.slice(0, TAG_MAX);
    meta.updatedAt = now;
    writes.push(store.putText(KEY.book(b.id), JSON.stringify(meta))); // 写一波全并行
    patches.set(b.id, { tags: meta.tags, updatedAt: meta.updatedAt });
  }
  if (writes.length) await Promise.all(writes);

  // 与 apiBatchBooks 同因：这里与 hit 过滤读的是同一份内存快照（openIndex 在过滤前已打开，
  // 中间只 await 各书 meta 写入），外部并发改不了它 → 守卫恒不触发（2026-09-18 审计实测）。
  // 保留作防御；真正覆盖并发软删的是下面 idx.save 的冲突 catch（replay:false → 交回客户端重发）。
  let mergeSkip = 0;
  if (patches.size) {
    for (const [id, p] of patches) {
      if (!idx.get(id)) { mergeSkip++; continue; }
      idx.patch(id, (x) => ({ ...x, ...p }));
    }
    try {
      // 全量模式**不自己做冲突重放**：重放开销（重读 root+K 片 + 重写）在 K 大时会把 50 子请求
      // 顶破，反而拿不到能续调的响应。本端点本来就按 remaining 分段推进、前端循环到 remaining=0
      // 才收手（app.js 的 tagMergeRun），meta 写入也是幂等的 → 冲突时交回客户端重发一轮补齐索引
      // （2026-09-17 二次复查 R1）。
      await idx.save({ bak: true, replay: false });
    } catch (e) {
      if (!isIdxConflict(e)) throw e;
      // meta 那批已经写完（幂等，重发会重算），索引没落盘 → 报 0 并让前端重发一轮
      return json({ ok: true, updated: 0, remaining: hit.length, retry: true });
    }
  }
  return json({ ok: true, updated: patches.size - mergeSkip, remaining: Math.max(0, hit.length - targets.length) });
}

/* ---------------- 回收站 API ---------------- */

/** 软删：index 摘除 → trash（正文/meta/raw 全保留，可恢复）
 * 也接纳「未上架的半成品书」（上传中途失败停在 creating、不在 index）：
 * 这类书若不能进回收站就永远删不掉、也看不见，只能留成孤儿数据。 */
async function apiSoftDelete(store, id) {
  const idx = await openIndex(store, { single: id }); // 单书模式：root + 该书所在片
  const b = idx.get(id);
  const meta = b ? null : await readBook(store, id);
  if (!b && !meta) return json({ error: '书不存在或已删除' }, 404);
  // 只在架书才需要从索引摘除（半成品书本就不在索引，摘除无效果，跳过分片写）
  if (b) {
    idx.remove(id);
    await idx.save({ bak: true });
  }
  // trash 走 CAS（见 updateTrash）：并发的两次软删不会互相覆盖（否则有本书会彻底消失）
  await updateTrash(store, (t) => {
    const i = t.books.findIndex((x) => x.id === id);
    if (i >= 0) {
      // 条目已在且书**不在架**（恢复流程还没把书写回）→ 纯 no-op（双击删除/惰性清理抢先）。
      // 书**在架**说明刚被恢复流程写回索引（恢复×再软删竞态）→ 本次删除是真实意图，
      // 必须刷新 deletedAt 制造版本变化：并发恢复流程随后的「摘条目」CAS 会撞冲突，
      // 重放时看到 deletedAt 已变而放弃（2026-09-17 复查 F1）——否则恢复会把这条唯一的
      // 记录摘掉，书既不在架也不在回收站。
      if (!b) return { dirty: false };
      t.books[i] = { ...t.books[i], deletedAt: Date.now() };
      return {};
    }
    t.books.push({ ...(b || indexEntryFromMeta(meta)), deletedAt: Date.now() });
    return {};
  });
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
  // 读一次连版本号一起拿（下面写回走 CAS 用得上；复用这份快照不再多读一次，读取量守住 P2-5 的个位数）
  const trashCur = await getWithEtag(store, KEY.TRASH);
  const trash = parseTrash(trashCur && trashCur.text);
  const trashIdx = trash.books.findIndex((b) => b.id === id);
  if (trashIdx < 0) return json({ error: '回收站里没有这本书' }, 404);
  const entry = trash.books[trashIdx];
  if (entry.purge) return json({ error: '该书的正文已部分清除，无法完整恢复' }, 409);
  // 软删自半成品（第三轮起可软删 creating 书）：trash 条目来自 indexEntryFromMeta，无 status 字段。
  // 一律以 meta 本体为准：只有已发布书恢复才有阅读/继续编辑入口，其余只会变书架孤儿。
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书本体数据缺失，无法恢复' }, 404);
  if (meta.status !== 'ready') {
    return json({ error: '该书尚未发布，无法恢复；如不再需要请在回收站中彻底删除' }, 409);
  }
  // 写序（P2-7）：**索引先落，trash 摘条目后落**。反过来的话 idx.save() 失败时书已经从 trash 摘掉、
  // 又没进索引 → 书架与回收站同时看不到它（用户本意是「找回」，结果唯一记录也被删；meta/正文虽在，
  // 只能走「检查残留」）。与 apiSoftDelete 的「索引先落」同一判据：让失败落在「trash 条目还在、可重试」
  // 的一侧。
  // append: id 来自回收站 ⇒ 索引里必定没有它（软删先摘索引后写 trash）→ 不必全量加载，只读 root + 末片；
  // 原实现（single 缺书 → 全量加载）在 2 万本/40 片下是 1+K 个子请求，逼近 50 硬顶（P2-5）。
  const idx = await openIndex(store, { single: id, append: true });
  const { purge, deletedAt, ...rest } = entry;
  idx.upsert(id, { ...rest }); // 已在架（重复恢复）则原位覆盖，语义与 v1 的去重 push 一致
  await idx.save({ bak: true });
  // 入口那次读的版本号带下来复用（pre）：冲突时 updateTrash 自己重读重放，不会多花一次读
  await updateTrash(
    store,
    (t) => {
      const i = t.books.findIndex((b) => b.id === id);
      if (i < 0) return { dirty: false };
      // 我读快照之后它又被并发软删了一次（deletedAt 变了）→ 这次「摘除」不该生效：
      // 否则会把别人刚写回的条目吃掉，书既不在架也不在回收站（2026-09-17 复查 F1）。
      if (t.books[i].deletedAt !== entry.deletedAt) return { dirty: false };
      t.books.splice(i, 1);
      return {};
    },
    3,
    trashCur
  );
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
 * 只处理 1 本：彻底删除的固定开销（readBook + raw/meta/progress 删除 + updateTrash）会叠在
 * 章删除之上，逐本累积轻松超 Free 50 子请求红线；一本一本清最稳。 */
async function apiTrashClear(store) {
  const trash = await readTrash(store);
  if (!trash.books.length) return json({ ok: true, deleted: 0, remaining: 0 });
  const r = await purgeOnce(store, trash, trash.books[0].id, PURGE_BATCH);
  // 剩余数自己算：purgeOnce 不再改调用方的副本（见其文档注释）→ done=true 即「这本已彻底删完、条目已摘」
  const remaining = r.done ? trash.books.length - 1 : trash.books.length;
  return json({ ok: true, deleted: r.deleted, remaining });
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
const DIAG_SYS_KEYS = new Set([KEY.INDEX, KEY.INDEX_BAK, KEY.TRASH, KEY_IDX.v1Bak]);
// meta/idx/ 是书架索引 v2 的分片（root + s<N>），meta/index.json.v1.bak 是迁移留档——都不是书 meta
const DIAG_SYS_PREFIXES = ['meta/idx/', 'meta/index.json'];
// list 预算拆两类：meta/raw/progress 是「书数级」对象（每本各 1 个，千本 = 各 1 页）→ 给足预算保证完整；
// text/ 是「章数级」大头（每章 1 个，千本 50 章 = 50 页）→ 只给部分页数，截断即 incomplete（宁漏勿错）
const DIAG_META_PAGE_BUDGET = 3; // meta/raw/progress 各自翻页上限（每页 ≤1000 对象 → 覆盖约 3000 本）
const DIAG_TEXT_PAGE_BUDGET = 12; // text/ 单请求翻页上限（每页 ≤1000 对象）；超预算回传 textCursor 由前端续扫
const DIAG_SUB_BUDGET = 45; // 扫描/删除单请求子请求软预算
// 回验预算比总预算更紧：旧实现回验与删除共用同一计数器，待删清单里活书 key 一多，
// 回验就把预算吃满 → 删除阶段 `deleted=0`，本可零成本删除的非活书残留被白白跳过（清理变慢）。
// 给回验单独设上限，余下预算留给删除。
const DIAG_VALIDATE_BUDGET = 30;

async function apiDiagOrphans(url, store) {
  try {
    return await doDiagScan(store, url.searchParams.get('textCursor') || '');
  } catch (e) {
    // 扫描过程本身失败（R2 超限/超时等）→ 透传真实原因，前端可展示而非笼统 HTTP 503
    return json({ error: '残留扫描失败：' + (e && e.message ? e.message : e) }, 502);
  }
}

async function doDiagScan(store, textCursor = '') {
  const cont = !!textCursor; // 续扫窗：跳过 meta/raw/progress（书数级前缀，首页已完整），只扫 text/ 下一窗
  const idx = await openIndex(store); // 全量：root + K 个分片（K 计入预算）
  const index = { books: idx.books };
  const budget = { used: 2 + idx.shardCount, incomplete: false }; // root+分片读 + trash 读（续扫窗同样需要 live 集合）
  const bump = () => {
    if (budget.used >= DIAG_SUB_BUDGET) {
      budget.incomplete = true;
      return false;
    }
    budget.used++;
    return true;
  };
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
  // 给足预算保证无主书/已删残留永远完整；text/ 是「章数级」大头（每章 1 个，3 万章 = 30 页
  // > 单请求预算）→ 每窗只扫 DIAG_TEXT_PAGE_BUDGET 页，超出回传 textCursor，前端循环续扫直到 null。
  // 注意 meta/ 续扫窗也要重列：无主书 id 集合必须每窗重推，否则无主书的跨窗正文会被
  // 误判成「可直接删的 residue」（无主书本应移入回收站保全正文）——只多花 1-3 个子请求。
  const NO_LIST = { objects: [], truncated: false, pages: 0, cursor: null };
  const [lMeta, lRaw, lProg, lText] = await Promise.all([
    store.list('meta/', DIAG_META_PAGE_BUDGET),
    cont ? NO_LIST : store.list('raw/', DIAG_META_PAGE_BUDGET),
    cont ? NO_LIST : store.list('progress/', DIAG_META_PAGE_BUDGET),
    store.list('text/', DIAG_TEXT_PAGE_BUDGET, textCursor),
  ]);
  budget.used += lMeta.pages + lRaw.pages + lProg.pages + lText.pages;
  if (lMeta.truncated || lRaw.truncated || lProg.truncated) budget.incomplete = true;

  // meta/{id}.json → 无主书（系统 meta 文件排除）。候选先收集、预算内批量并发回读：
  // 预算尽则剩余标 unknown（宁漏勿错），已允许的并发一次读完（RTT 从串行 N 次降到一次）。
  // 续扫窗只重推 orphanSet 不再回读 meta 内容，orphanBooks 明细只在首页上报（前端只合并首页）。
  const orphanCands = [];
  const orphanSet = new Set();
  for (const o of lMeta.objects) {
    if (DIAG_SYS_KEYS.has(o.key) || o.key.startsWith('meta/sec/') || DIAG_SYS_PREFIXES.some((p) => o.key.startsWith(p))) continue;
    const id = o.key.slice(5, -5); // 去 'meta/' 前缀与 '.json' 后缀
    if (live.has(id)) continue;
    orphanSet.add(id);
    orphanCands.push({ o, id, canRead: !cont && bump() });
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
        // 续扫窗跳过：无主书正文已随首页 orphanBooks 呈现（跨窗大书可能少量少计「关联正文 N 段」，展示层小误差），
        // 绝不能落到 residue——无主书正文是要保全的，误列可删残留会被「删除全部」清掉
        if (!cont) {
          const ob = orphanBooks.find((b) => b.id === id);
          ob.texts = (ob.texts || 0) + items.length;
          ob.textBytes = (ob.textBytes || 0) + items.reduce((s, x) => s + x.size, 0);
        }
      } else {
        for (const it of items) residue.push({ key: it.key, size: it.size });
      }
      continue;
    }
    liveTextIds.push({ id, items });
  }
  // 活书正文分类：预算内并发 readBook（子请求数不变，RTT 从串行 N 次降到一次）
  let skippedBooks = 0;
  const liveMeta = await Promise.all(
    liveTextIds.map((x) => (bump() ? readBook(store, x.id) : Promise.resolve(null)))
  );
  for (let i = 0; i < liveTextIds.length; i++) {
    const { id, items } = liveTextIds[i];
    const m = liveMeta[i];
    if (!m) {
      // 预算尽 / meta 读不到：该书的窗内对象无法核验。计入 skippedBooks → incomplete，
      // 前端会提示「部分书未能核验」而不是静默漏检（宁漏勿错，但要说出来）。
      skippedBooks++;
      continue;
    }
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
    // text/ 下一窗的续扫游标：null = text/ 已扫完。前端循环带上它续调，直到 null，
    // 期间把 residue/chapterOrphans 增量合并（orphanBooks/summary 只在首页有意义）。
    textCursor: lText.cursor || null,
    scannedPages: lText.pages,
    skippedBooks,
    incomplete: budget.incomplete || skippedBooks > 0,
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

  const idx = await openIndex(store); // 全量：root + K 分片
  const index = { books: idx.books };
  const trash = await readTrash(store);
  const live = new Set([...(index.books || []), ...(trash.books || [])].map((b) => b.id));
  let used = 2 + idx.shardCount; // 已读 root+分片 + trash
  const metaCache = new Map(); // 同一本书多个删除 key 只回验一次
  const toDelete = [];
  // 因预算未处理的对象（可续调）——与「确认拒删」分开回传：原实现两者混在 skipped 里，
  // 前端只能把它说成"被跳过"，被裁掉的残留永远删不完（L15）。
  const deferred = [];
  for (let i = 0; i < ok.length; i++) {
    const k = ok[i];
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
      if (used >= DIAG_VALIDATE_BUDGET) {
        // 回验预算尽：不回验也不删（宁漏勿错）。余下全部原样回传，交给下一轮继续。
        deferred.push(...ok.slice(i));
        break;
      }
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
    if (used >= DIAG_SUB_BUDGET) {
      deferred.push(k); // 总预算含删除本身，防超 50 子请求红线：未删的原样回传续调
      continue;
    }
    used++;
    await store.delete(k);
    deleted++;
  }
  // skipped 语义收窄为「确认不该删」（活书伴生对象 / 仍在章表内的正文）：预算裁剪的已挪进 deferred
  return json({ ok: true, deleted, skipped: ok.length - deleted - deferred.length, deferred });
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
      if (admin) await bruteFail(req, env, store);
      return { ok: false, status: 401 };
    }
    await bruteClear(req, store);
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

/** GET /opds — OPDS 1.2 目录（?p=N 分页，每页 OPDS_PAGE 条；阅读器按 rel="next" 自动翻页）
 * 千本全量单 feed ≈300KB XML，第三方阅读器解析吃力 → 分页必备。feedUpdated 仍取全库最新时间。 */
const OPDS_PAGE = 100;

async function opdsCatalog(req, env, store) {
  const auth = await opdsAuth(req, env, store);
  if (!auth.ok) return auth.status === 429 ? opdsLocked(auth.retryAfterMs) : opds401();
  const index = await readIndex(store);
  const books = (index.books || []).slice().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const page = Math.min(10000, Math.max(1, parseInt(new URL(req.url).searchParams.get('p'), 10) || 1));
  const slice = books.slice((page - 1) * OPDS_PAGE, page * OPDS_PAGE);
  const href = (n) => (n <= 1 ? '/opds' : `/opds?p=${n}`);
  const hasNext = page * OPDS_PAGE < books.length;
  // feed 级 updated 用内容的最新时间（而非当前时间）：固定值让阅读器按条件请求判断
  // 「feed 没变化」，避免每次拉取都被误判有更新而反复全量重拉
  // 用 reduce 而非 Math.max(...spread)：超大库（十万级）spread 会抛 RangeError（调用栈溢出）
  const feedUpdated = books.length
    ? books.reduce((mx, b) => Math.max(mx, b.updatedAt || b.createdAt || 0), 0)
    : Date.now();
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
  const nav = [
    `  <link rel="self" href="${href(page)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    `  <link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    hasNext ? `  <link rel="next" href="${href(page + 1)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>` : '',
    page > 1 ? `  <link rel="previous" href="${href(page - 1)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>` : '',
  ].filter(Boolean).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:r2novel:opds:p${page}</id>
  <title>私人书屋${page > 1 ? `（第 ${page} 页）` : ''}</title>
  <updated>${new Date(feedUpdated).toISOString()}</updated>
  <author><name>私人书屋</name></author>
${nav}
${slice.map(entry).join('\n')}
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
    if (req.method === 'GET') return apiDiagOrphans(url, store);
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

  if (p.startsWith('/api/')) {
    // 顶层兜底（2026-09-17 复查 F4）：未捕获异常必须以 JSON 返回，而不是让 Workers 冒 1101
    // HTML——前端拿到 JSON 才能展示真实错误；索引并发冲突耗尽映射 409（客户端可重试）。
    try {
      return await handleApi(req, env, store, url, p);
    } catch (e) {
      // 复查 P3（精确化）：内部异常 message 只对**已认证**请求透传——泄露面在 /api/login
      // 这类鉴权之前的路径（未认证者也可能读到分片损坏/key 越界等运维细节）；站长本人
      // （单管理员站）仍要看到真实错误，F4 的初衷就是「前端能展示真实错误」，有测试护栏
      // （review-fix9 F4 / index-shards 写序两处）。真实堆栈进日志；409 判据保留
      // （IDX_CONFLICT 的 message 无害，且客户端要靠 409 重试）。
      const authed = await verifyCookie(req, env).catch(() => false);
      console.error('[api] 未捕获异常:', e && e.stack ? e.stack : e);
      return json(
        { error: authed && e && e.message ? e.message : '服务器内部错误' },
        isIdxConflict(e) ? 409 : 500
      );
    }
  }

  // 静态资源交给外层（Workers: ASSETS / dev: 静态文件服务）
  if (req.method === 'GET' || req.method === 'HEAD') {
    const resp = await env.serveStatic(req, url);
    if (resp) return resp;
  }
  return notFound();
}
