/* _harness.mjs — 测试公共脚手架（内存 store / 请求构造 / 调用与登录）
 *
 * 7 个 API 测试文件原本各带一份逐字重复的 ~70 行脚手架，改一处要改七处（已出现过漂移风险）。
 * 统一收敛到这里。
 *
 * 注意：文件名不以 .test.mjs 结尾，因此 `npm test`（node --test "test/*.test.mjs"）不会把它
 * 当作测试文件执行。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleRequest } from '../src/router.js';

export const BASE = 'http://r2novel.test';

/** 单测环境：BRUTE_LIMIT 放开防爆破，避免用例之间互相触发锁定 */
export const ENV = {
  ADMIN_PASSWORD: 'test-pass',
  SESSION_SECRET: 'test-secret-0123456789abcdef',
  SESSION_DAYS: '30',
  MAX_UPLOAD: '52428800',
  MAX_CHAPTER: '2097152', // 2MB
  BRUTE_LIMIT: '100',
  BRUTE_LOCK_MS: '1000',
  TRASH_DAYS: '15',
  serveStatic: async () => null,
};

/** 内存 store：模拟 R2 / 文件系统的适配层。
 * list 返回全量（truncated:false）——真实分页语义由 scale-fixes.test.mjs 的 pagedStore 专测。 */
export function memStore() {
  const m = new Map();
  return {
    async getText(k) {
      const v = m.get(k);
      if (v === undefined) return null;
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async getBytes(k) {
      const v = m.get(k);
      if (v === undefined) return null;
      return v instanceof Uint8Array ? v : new TextEncoder().encode(String(v));
    },
    async putText(k, s) {
      m.set(k, s);
    },
    /** etag = 内容 sha1（与 R2/ dev-server 同语义）；直接改 _map 造数也不会让 etag 失真。
     * 实现刻意**建在 getText / putText 之上**（this.*）：测试里对这两个方法的探针（写入计数、
     * 制造「并发写在途」窗口）与故障注入因此**天然覆盖 CAS 路径**——否则每个用例都得记得再包一层
     * putTextIf/getTextWithEtag，漏一个就静默漏计（实测：CAS 化后 6 个用例齐挂，全是探针漏看）。 */
    async getTextWithEtag(k) {
      const text = await this.getText(k);
      if (text == null) return null;
      return { text, etag: createHash('sha1').update(Buffer.from(text, 'utf8')).digest('hex') };
    },
    async putTextIf(k, s, etag) {
      // 前置条件直接看 m（不经 this.getText）：CAS 的条件判定在 R2 是 onlyIf 由服务端求值，
      // **不额外产生读子请求**；若从 this.getText 走，读计数用例会把这一次内部判定也算进去。
      // 三种语义与 router.js 的 store 契约一致：undefined=无条件写、null=不存在才写、字符串=CAS
      const cur = m.get(k);
      if (etag === null && cur !== undefined) return null; // 不存在才写，但已经有了
      if (typeof etag === 'string') {
        if (cur === undefined) return null;
        const text = typeof cur === 'string' ? cur : new TextDecoder().decode(cur);
        if (createHash('sha1').update(Buffer.from(text, 'utf8')).digest('hex') !== etag) return null;
      }
      await this.putText(k, s); // 走 this.* → 写入探针与故障注入可见
      return { etag: createHash('sha1').update(Buffer.from(s, 'utf8')).digest('hex') };
    },
    async putBytes(k, b) {
      m.set(k, b);
    },
    async delete(k) {
      m.delete(k);
    },
    async openRead(k) {
      const v = m.get(k);
      if (v === undefined) return null;
      const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
      return new Response(bytes).body; // ReadableStream，模拟 R2 object.body
    },
    async list(prefix = '') {
      const out = [];
      for (const [k, v] of m) {
        if (k.startsWith(prefix)) out.push({ key: k, size: typeof v === 'string' ? v.length : v.byteLength });
      }
      return { objects: out, truncated: false, pages: 1, cursor: null };
    },
    _map: m,
  };
}

/** 构造请求：body 支持 string / Uint8Array / ReadableStream（chunked）/ 普通对象（自动 JSON） */
export function req(path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('Cookie', cookie);
  const opts = { method, headers: h };
  if (body !== undefined) {
    const passthrough = body instanceof ReadableStream || typeof body === 'string' || body instanceof Uint8Array;
    opts.body = passthrough ? body : JSON.stringify(body);
    if (!passthrough && !h.has('content-type')) h.set('content-type', 'application/json');
    if (body instanceof ReadableStream) opts.duplex = 'half';
  }
  return new Request(BASE + path, opts);
}

/** 调用路由并解析响应（JSON 优先，失败回落纯文本） */
export const call = async (store, r) => {
  const res = await handleRequest(r, ENV, store);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers, text };
};

/** 登录并返回可复用的 Cookie 头 */
export async function login(store) {
  const r = await call(store, req('/api/login', { method: 'POST', body: { password: ENV.ADMIN_PASSWORD } }));
  assert.equal(r.status, 200);
  const m = /rn_session=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  assert.ok(m, '应下发 rn_session cookie');
  return 'rn_session=' + m[1];
}

/* ---------------- 造数助手（新测试专用单点） ----------------
 * 历史上 10 个测试文件各抄一份 makeReadyBook，签名（tags 在第 4 还是第 5 参）、正文文本、
 * 是否 PUT raw、返回形状（{id,title} / {id,keys} / 裸 id）已参差 —— 新测试一律用这里的实现，
 * 存量旧副本逐轮迁移，**不要再新增副本**。
 * 返回 { id, title, keys }（keys = 章节 key 列表）：只取 id 的调用点写 `const { id } = …`。 */

/** 只建书（草稿态，不含正文 / raw / 发布）——给需要走 bulk 等自定义路径的用例当起点。
 *  @returns {Promise<{id: string, keys: string[]}>} */
export async function makeDraftBook(store, cookie, title, n = 2, tags = []) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  const r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', tags, chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id: r.data.id, keys: Array.from({ length: n }, (_, i) => String(i + 1)) };
}

/** 造一本「可直接读」的书：建书 → 逐章 PUT 正文 → PUT raw → 发布。
 *  @param n 章节数（默认 2） @param tags 标签数组（默认空）
 *  @returns {Promise<{id: string, title: string, keys: string[]}>} */
export async function makeReadyBook(store, cookie, title, n = 2, tags = []) {
  const { id, keys } = await makeDraftBook(store, cookie, title, n, tags);
  for (const k of keys) {
    await call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PUT', cookie, body: '第' + k + '章正文' }));
  }
  await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('raw-' + title) }));
  const r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id, title, keys };
}

/* ---------------- v2 分片索引读写助手（测试观察/造数用） ----------------
 * v2 起 index 不再是单个 meta/index.json，而是 meta/idx/root.json + s<N>.json。
 * 测试要「看一眼书架摘要」或「整体改写摘要造数」，统一走这两个助手，禁止再硬编码 v1 key。
 * 注意：服务端首次 openIndex 才会触发 v1→v2 迁移；在迁移前 readIdxBooks 返回 null。 */

export async function readIdxBooks(store) {
  const rootRaw = await store.getText('meta/idx/root.json');
  if (rootRaw == null) return null;
  const root = JSON.parse(rootRaw);
  const out = [];
  for (let i = 0; i < root.shards; i++) {
    const raw = await store.getText(`meta/idx/s${i}.json`);
    if (raw == null) continue;
    out.push(...JSON.parse(raw).books);
  }
  return out;
}

/** 多分片布局造数：groups=[[书…],[书…]] → n 号片写 s<n>.json + .bak，root/bak 一并写齐。
 * writeIdxBooks 是它的单片特例；「分片分散/规模化」类用例（预算裁剪、只读一片、自愈成本）用它造数。 */
export async function writeIdxShards(store, groups) {
  const map = {};
  for (let n = 0; n < groups.length; n++) {
    const body = JSON.stringify({ books: groups[n] });
    await store.putText(`meta/idx/s${n}.json`, body);
    await store.putText(`meta/idx/s${n}.json.bak`, body);
    for (const b of groups[n]) map[b.id] = n;
  }
  const root = JSON.stringify({ v: 2, shards: groups.length, map });
  await store.putText('meta/idx/root.json', root);
  await store.putText('meta/idx/root.json.bak', root);
}

/** 整库覆盖为给定 books（单分片；测试造数，书数远小于 500 上限）。root/bak 一并写齐。 */
export async function writeIdxBooks(store, books) {
  const body = JSON.stringify({ books });
  const root = JSON.stringify({ v: 2, shards: 1, map: Object.fromEntries(books.map((b) => [b.id, 0])) });
  await store.putText('meta/idx/s0.json', body);
  await store.putText('meta/idx/s0.json.bak', body);
  await store.putText('meta/idx/root.json', root);
  await store.putText('meta/idx/root.json.bak', root);
}

/** 子请求计数器：包一层 store，统计 get/put/list 次数。
 * Cloudflare 单请求 50 子请求硬顶是结构性约束，只有**数**才能证明「开销与书库规模无关」。 */
export function countStore(base) {
  const c = { get: 0, put: 0, list: 0 };
  return {
    ...base,
    getText: (k) => { c.get++; return base.getText(k); },
    putText: (k, v) => { c.put++; return base.putText(k, v); },
    list: (p, m, cur) => { c.list++; return base.list(p, m, cur); },
    _count: c,
  };
}
