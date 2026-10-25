/**
 * r2novel — HTTP 响应 / 请求体 / 编码 / 客户端 IP / etag 存储助手
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { IDX_SAVE_TRIES, KEY } from './const.js';


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
  const gz = req.headers.get('x-content-gzip') === '1';
  // 声明值快速拒绝只对**明文**有意义：gzip 请求的 content-length 是压缩后长度，与这里的
  // maxBytes（解压产物上限）不同量纲 —— 文本压缩比远大于 1，合法 gzip 体几乎不可能超过
  // 解压上限，拿它比只会把合法请求误拒成 413（#145 P3-13）。gzip 的长度护栏由下面的
  // 流式计数负责（解压产物超限即中断管道）。
  if (!gz && declared > maxBytes) throw new Error('请求体超过上限');
  if (!req.body) return new Uint8Array(0);
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

/** 读取 JSON 请求体（带上限）。返回 { body } 或 { err, status }——err 时调用方直接回错误。
 * 动机：下面 9 个 JSON 路由原本 `req.json()` 全量入内存后才校验，持有效会话者发几十 MB 的
 * JSON 就能把 128MB isolate 打穿（与 readBodyBytes 注释里的 OOM 面同源，只是藏在了 json()
 * 里）。这些路由的合法载荷都远小于上限，超限即 413、非法 JSON 即 400。 */
async function readJsonBody(req, maxBytes) {
  let text;
  try {
    text = await readBodyText(req, maxBytes);
  } catch (e) {
    if (e && (e.message === '请求体超过上限' || e.message === '解压后超过上限')) return { err: '请求体过大', status: 413 };
    return { err: '请求体读取失败', status: 400 };
  }
  try {
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { err: '请求体不是合法 JSON', status: 400 };
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
  const cf = req.headers.get('CF-Connecting-IP');
  if (cf) return cf; // 生产（CF 边缘）：真实客户端 IP，不可伪造
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    // dev / 自建反代：取**最后**一段。代理链上越靠后越是离服务端最近的一跳（自家反代
    // 追加的），客户端预置的伪造段都在前面。仍可被完全控制 xff 的来源伪造，但比取整条
    // 字符串（每种伪造组合都是一个新「IP」，爆破计数键形同虚设）门槛高得多（#145 P3-7）。
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'unknown';
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

/* ---------------- 元信息的原子「读—改—写」：mutateMeta（#140 · D1 统一收口） ----------------
 * 为什么需要它：`读 meta → 改内存对象 → 写回` 之间**没有 await 让出点**时，JS 单线程的 microtask
 * FIFO 会让这段在调度层面几乎原子（实测：20 路独立 socket 真并发 × 40ms 读窗口，20 本 meta 的
 * cleanVer 精确 +20，零覆盖）；但那只是**巧合**——任何人往中间插一个 await（读旧正文算字数、
 * 迁移进度、清孤儿）就立刻变成真实覆盖窗口（apiPatchChapter 改正文那条路径本来就有 2 个 await），
 * Workers 多 isolate 部署下更是必然丢。本函数把这条隐式约束换成显式保证：所有 meta 写统一走它。
 *
 * ⚠️ 不变式（加/改调用点前必读）：
 *  · mutate 必须是**可重放的纯内存变换**：只改传进来的 meta；不得在其中 await 任何存储操作
 *    ——既破坏原子性，重放时还会重复副作用。要先落正文 / 迁移进度 / 清孤儿的，放在调用之前
 *    （副作用本身必须幂等），或放在返回之后的补偿步骤里。
 *  · 结果必须**每次都从 meta 重新推导**（幂等），不能用「增量叠加」式逻辑：冲突时会重放。
 *  · 不可重放的副作用先例：apiBookMeta 要在**每次重试里**重跑 sweepOrphans（删除）→ 它保留
 *    自管循环（语义与本函数一致），不强行套用。
 *
 * mutate(meta) 的返回：`{ out, dirty }`
 *  · `dirty === false` → 无需落盘，按成功返回（并发已达成同一结果时的幂等短路）
 *  · `abort: Response` → 立即返回该响应、不写盘（校验失败、并发删章等）
 *  · `out` → 原样带回给调用方（如 index patch）
 * pre：调用方已经读过一次（守卫读）→ 传 { text, etag } 复用，省一次子请求；更重要的是让 CAS
 * 覆盖**从那次读开始**的整个窗口——中间会 await 写正文/迁移进度，冲突即重读重放。
 * 重试用尽 → `{ ok:false, code:'conflict' }` 交调用方回 409：meta 的失效方向必须偏保守，
 * 宁可让用户重试，也不能把一份可能过期的整份 meta 写回去（会复活并发者刚删掉的章）。
 * 约定与 updateTrash 同源（`{ out, dirty }` + tries 循环），全仓只有这一种读—改—写写法。
 */
async function mutateMeta(store, id, mutate, pre = null, tries = IDX_SAVE_TRIES) {
  let snapshot = pre;
  for (let i = 0; i < tries; i++) {
    const cur = snapshot || (await getWithEtag(store, KEY.book(id)));
    snapshot = null;
    const meta = cur ? tryParseJson(cur.text) : null;
    if (!meta) return { ok: false, code: 'missing' };
    const r = mutate(meta) || {};
    if (r.abort) return { ok: false, abort: r.abort };
    if (r.dirty === false) return { ok: true, meta, out: r.out, skipped: true };
    const w = await putIf(store, KEY.book(id), JSON.stringify(meta), cur.etag);
    if (w.ok) return { ok: true, meta, out: r.out };
  }
  return { ok: false, code: 'conflict' };
}

/** mutateMeta 失败的统一响应：校验类失败原样返回；缺书 404；重试用尽 409 */
const metaFail = (m, msg = '并发冲突，请重试') =>
  m.abort || (m.code === 'missing' ? json({ error: '书不存在' }, 404) : json({ error: msg }, 409));

async function readJson(store, key, fallback) {
  const t = await store.getText(key);
  if (t == null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}
const tryParseJson = (t) => {
  try {
    return t != null ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { json, notFound, dropBody, readBodyBytes, readBodyText, readJsonBody, enc, escXml, safeEqual, b64urlEncode, b64urlDecode, clientIp, getWithEtag, putIf, mutateMeta, metaFail, readJson, tryParseJson };
