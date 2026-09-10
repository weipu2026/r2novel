/* _harness.mjs — 测试公共脚手架（内存 store / 请求构造 / 调用与登录）
 *
 * 7 个 API 测试文件原本各带一份逐字重复的 ~70 行脚手架，改一处要改七处（已出现过漂移风险）。
 * 统一收敛到这里。
 *
 * 注意：文件名不以 .test.mjs 结尾，因此 `npm test`（node --test "test/*.test.mjs"）不会把它
 * 当作测试文件执行。
 */
import assert from 'node:assert/strict';
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
