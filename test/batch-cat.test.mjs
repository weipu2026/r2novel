/* batch-cat.test.mjs —— 批量上传章节（bulk）与分类/完结（finished）边界回归
 * 只覆盖 api-m2.test.mjs 未覆盖的边界：拒绝路径、防半批次、超限、鉴权、值收敛。
 * 与 api-m2.test.mjs 同款内存 store，零外部依赖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { BULK_CHAPTER_BATCH } from '../public/js/shared-const.js';
import { maybeGzip } from '../public/js/store.js';

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
    opts.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
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

test('bulk：超过单批上限（BULK_CHAPTER_BATCH+1）拒收 413', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 造 BULK_CHAPTER_BATCH+1 章的大纲，只测「条数超限」这一层（key 合法性在条数校验之后）
  const chapters = Array.from({ length: BULK_CHAPTER_BATCH + 1 }, (_, i) => '第' + (i + 1) + '章');
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
      body: { chapters: Array.from({ length: BULK_CHAPTER_BATCH + 1 }, (_, i) => ({ key: String(i + 1), text: 'x' })) },
    })
  );
  assert.equal(big.status, 413, '单批超限应 413');
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

test('maybeGzip：中文文本必须被压缩（收益用字节数判断，防字符数误判）', async () => {
  // 中文 1 字 = 3 UTF-8 字节；若按字符数比较会把大文本误判为「无收益」→ 不压缩（曾为真实 bug）
  const zh = '第'.repeat(100000); // 10 万汉字 ≈ 300KB 字节
  const plain = await maybeGzip(zh);
  assert.equal(plain.gzip, true, '中文大文本应压缩');
  assert.ok(plain.body.length < zh.length, 'gzip 后应显著小于原文');

  // 小 body 不压缩
  const small = await maybeGzip('small');
  assert.equal(small.gzip, false);
  assert.equal(small.body, 'small');

  // Uint8Array（putRaw 路径）同样正确
  const raw = new TextEncoder().encode('A'.repeat(200000));
  const pr = await maybeGzip(raw);
  assert.equal(pr.gzip, true);
  assert.ok(pr.body.length < raw.length);
});

test('bulk：gzip 压缩请求体与明文等效（慢链路上行优化回归）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeDraftBook(store, cookie, '压缩书', 2);
  const stream = new Response(JSON.stringify({ chapters: keys.map((k) => ({ key: k, text: '压缩正文' + k })) }))
    .body.pipeThrough(new CompressionStream('gzip'));
  const body = new Uint8Array(await new Response(stream).arrayBuffer());
  assert.ok(body.length < 256, 'gzip 应显著缩小 body');

  const r = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body, headers: { 'x-content-gzip': '1' } })
  );
  assert.equal(r.status, 200, 'gzip bulk 应正常入库');
  assert.equal(r.data.count, 2);
  // 章节正文只读已发布书 → 先 publish 再验证解压内容
  const p = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(p.status, 200, '抽样校验应通过（解压内容真实落盘）');
  const t = await call(store, req(`/api/books/${id}/chapters/${keys[0]}`, { cookie }));
  assert.equal(t.text, '压缩正文1', '解压后的正文应与明文一致');

  // 未打标记的 gzip 字节必须被拒（JSON.parse 失败 → 400），防止压缩数据被当明文静默误存
  const bad = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body, headers: { 'x-content-gzip': '0' } })
  );
  assert.equal(bad.status, 400);
});

test('bulk：gzip 炸弹被解压护栏拦截（KB 级压缩体不得解压成超限内存）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeDraftBook(store, cookie, '炸弹书', 1);
  // 25MB 高度可压文本 → 压缩后仅 ~25KB，解压超过 bulk 24MB 护栏
  const bombSrc = 'A'.repeat(25 * 1024 * 1024);
  const gz = new Uint8Array(
    await new Response(new Response(bombSrc).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  );
  assert.ok(gz.length < 100 * 1024, '炸弹压缩体应远小于原文（否则构造无效）');

  const r = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: gz, headers: { 'x-content-gzip': '1' } })
  );
  assert.equal(r.status, 413, '解压超限应 413 而非解压到底（内存有界）');

  // 损坏的 gzip（标记了但不是 gzip 数据）→ 400
  const corrupt = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      headers: { 'x-content-gzip': '1' },
    })
  );
  assert.equal(corrupt.status, 400);
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
