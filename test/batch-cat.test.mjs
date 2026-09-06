/* batch-cat.test.mjs —— 批量上传章节（bulk）与分类/完结（finished）边界回归
 * 只覆盖 api-m2.test.mjs 未覆盖的边界：拒绝路径、防半批次、超限、鉴权、值收敛。
 * 与 api-m2.test.mjs 同款内存 store，零外部依赖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';

const BASE = 'http://r2novel.test';
const ENV = {
  ADMIN_PASSWORD: 'test-pass',
  SESSION_SECRET: 'test-secret-0123456789abcdef',
  SESSION_DAYS: '30',
  MAX_UPLOAD: '52428800',
  MAX_CHAPTER: '2097152',
  BRUTE_LIMIT: '100',
  BRUTE_LOCK_MS: '1000',
  TRASH_DAYS: '15',
  serveStatic: async () => null,
};

function memStore() {
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
    _map: m,
  };
}

function req(path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('Cookie', cookie);
  const opts = { method, headers: h };
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!h.has('content-type') && typeof body !== 'string') h.set('content-type', 'application/json');
  }
  return new Request(BASE + path, opts);
}

const call = async (store, r) => {
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

async function login(store) {
  const r = await call(store, req('/api/login', { method: 'POST', body: { password: 'test-pass' } }));
  assert.equal(r.status, 200);
  const m = /rn_session=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  return 'rn_session=' + m[1];
}

/** 建一本 creating 书（未发布，可 bulk 上传），返回 { id, keys } */
async function makeDraftBook(store, cookie, title, n = 3) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章');
  const r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  return { id: r.data.id, keys: Array.from({ length: n }, (_, i) => String(i + 1)) };
}

async function makeReadyBook(store, cookie, title, n = 2) {
  const { id, keys } = await makeDraftBook(store, cookie, title, n);
  await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: { chapters: keys.map((k) => ({ key: k, text: '正文' + k })) },
    })
  );
  const p = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(p.status, 200);
  return { id, keys };
}

/* ---------------- 批量上传（bulk）边界 ---------------- */

test('bulk：空批次与缺失 chapters 均 400', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeDraftBook(store, cookie, '空批书');

  const empty = await call(store, req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: { chapters: [] } }));
  assert.equal(empty.status, 400, '空数组应 400');

  const missing = await call(store, req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: {} }));
  assert.equal(missing.status, 400, '缺 chapters 字段应 400');
});

test('bulk：超过单批上限（40 章）拒收 413', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 造 41 章的大纲，只测「条数超限」这一层（key 合法性在条数校验之后）
  const chapters = Array.from({ length: 41 }, (_, i) => '第' + (i + 1) + '章');
  const r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title: '超限书', chapters, wordCount: 100, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  const id = r.data.id;

  const big = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: { chapters: Array.from({ length: 41 }, (_, i) => ({ key: String(i + 1), text: 'x' })) },
    })
  );
  assert.equal(big.status, 413, '单批 >40 章应 413');
});

test('bulk：已发布（ready）的书 409，必须走章节编辑接口', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, '已发布书', 2);

  const r = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: { chapters: [{ key: keys[0], text: '改正文' }] } })
  );
  assert.equal(r.status, 409, 'ready 书不得再 bulk 灌正文');
});

test('bulk：不存在的书 404；未登录 401', async () => {
  const store = memStore();
  const cookie = await login(store);

  const missing = await call(
    store,
    req('/api/books/n_doesnotexist/chapters/bulk', { method: 'POST', cookie, body: { chapters: [{ key: '1', text: 'x' }] } })
  );
  assert.equal(missing.status, 404);

  const { id, keys } = await makeDraftBook(store, cookie, '鉴权书', 1);
  const anon = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, { method: 'POST', body: { chapters: [{ key: keys[0], text: 'x' }] } })
  );
  assert.equal(anon.status, 401, '未登录不得 bulk 上传');
});

test('bulk：批次内任一章非法 → 整批拒绝，且合法章不落盘（防半批次）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeDraftBook(store, cookie, '半批书', 3);

  const mixed = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: {
        chapters: [
          { key: keys[0], text: '合法一' },
          { key: '999', text: '越界章' },
        ],
      },
    })
  );
  assert.equal(mixed.status, 404, '含非法 key 应整批 404');
  assert.equal(await store.getText(`text/${id}/${keys[0]}.txt`), null, '合法章也不得被写入（防半批次）');

  // 整批合法则应全部落盘
  const ok = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: { chapters: keys.map((k) => ({ key: k, text: '正文' + k })) },
    })
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.data.count, 3);
  for (const k of keys) {
    assert.equal(await store.getText(`text/${id}/${k}.txt`), '正文' + k, `章 ${k} 应已落盘`);
  }
});

test('bulk：单章超过 MAX_CHAPTER 上限 413', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeDraftBook(store, cookie, '大章书', 1);

  const orig = ENV.MAX_CHAPTER;
  ENV.MAX_CHAPTER = '10'; // 10 字节上限
  try {
    const r = await call(
      store,
      req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: { chapters: [{ key: keys[0], text: '这段正文明显超过十个字节' }] } })
    );
    assert.equal(r.status, 413, '超单章上限应 413');
    assert.equal(await store.getText(`text/${id}/${keys[0]}`), null, '超限章不得落盘');
  } finally {
    ENV.MAX_CHAPTER = orig;
  }
});

test('bulk：返回逐章字数，与正文一致（空格不计）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeDraftBook(store, cookie, '字数书', 2);

  const r = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: { chapters: [{ key: keys[0], text: 'abcde' }, { key: keys[1], text: 'a b c' }] },
    })
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.words, [5, 3], 'words 应为去空白后的逐章字数（空格不计）');
  assert.equal(r.data.count, 2);
});

/* ---------------- 分类 / 完结（finished）边界 ---------------- */

test('finished：可来回切换（true → false），meta 与书架条目同步', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '连载书', 2);

  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { finished: true } }));
  let shelf = await call(store, req('/api/books', { cookie }));
  assert.equal(shelf.data.books.find((b) => b.id === id).finished, true);

  const off = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { finished: false } }));
  assert.equal(off.status, 200);
  shelf = await call(store, req('/api/books', { cookie }));
  assert.equal(shelf.data.books.find((b) => b.id === id).finished, false, '应能取消完结');
  const meta = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(meta.data.finished, false, 'meta 应同步取消');
});

test('finished：非布尔值收敛为布尔（字符串/数字不污染数据）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '收敛书', 2);

  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { finished: 'yes' } }));
  let meta = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(meta.data.finished, true, "字符串 'yes' 应收敛为 true");

  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { finished: 0 } }));
  meta = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(meta.data.finished, false, '数字 0 应收敛为 false');
  assert.equal(typeof meta.data.finished, 'boolean', 'finished 必须是布尔，不能是原样值');
});

test('finished：未登录 401；不存在的书 404', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '鉴权完结书', 2);

  const anon = await call(store, req(`/api/books/${id}`, { method: 'PATCH', body: { finished: true } }));
  assert.equal(anon.status, 401);

  const missing = await call(store, req('/api/books/n_nope', { method: 'PATCH', cookie, body: { finished: true } }));
  assert.equal(missing.status, 404);
});

test('finished：与 pinned 双向互不覆盖（改一个不得清掉另一个）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '互不覆盖书', 2);

  // 先标记完结 + 置顶
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { finished: true } }));
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { pinned: true } }));

  let b = (await call(store, req('/api/books', { cookie }))).data.books.find((x) => x.id === id);
  assert.equal(b.finished, true, '改 pinned 后 finished 应保留');
  assert.equal(b.pinned, true, 'pinned 应生效');

  // 反向：只改 finished 时 pinned 不得被清
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { finished: false } }));
  b = (await call(store, req('/api/books', { cookie }))).data.books.find((x) => x.id === id);
  assert.equal(b.finished, false);
  assert.equal(b.pinned, true, '改 finished 后 pinned 应保留');
});
