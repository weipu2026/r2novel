/* scale-fixes.test.mjs — 规模化修复（2026-09-07）单测
 * 覆盖：① 章节读取状态副档（creating 挡读 / publish 放行 / 老书无副档回落补档）
 *       ② 进度镜像只在换章时重写 index（章内滚动不碰 index，消除写放大）
 *       ③ diag 大库分窗续扫（textCursor 回传 + 续扫分类完整）
 *       ④ OPDS 目录分页（p1 100 条 + rel next；p2 剩余 + rel previous）
 */
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

/** 分页包装：把 memStore 的「单页全量」list 包成真实 R2 语义（每页 pageSize 个、按 key 排序、
 * 必须回传 cursor 才能翻页）——专门用来测 diag 分窗续扫，本地 fs/memStore 永远踩不到该路径。 */
function pagedStore(base, pageSize = 20) {
  return {
    getText: base.getText.bind(base),
    getBytes: base.getBytes.bind(base),
    putText: base.putText.bind(base),
    putBytes: base.putText.bind(base),
    delete: base.delete.bind(base),
    async list(prefix = '', maxPages = 0, cursor = '') {
      const keys = [...base._map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const after = cursor ? keys.findIndex((k) => k > cursor) : 0;
      const start = after === -1 ? keys.length : after;
      const end = maxPages > 0 ? Math.min(keys.length, start + maxPages * pageSize) : keys.length;
      const out = keys.slice(start, end).map((k) => {
        const v = base._map.get(k);
        return { key: k, size: typeof v === 'string' ? v.length : v.byteLength };
      });
      return { objects: out, truncated: end < keys.length, pages: Math.ceil((end - start) / pageSize), cursor: end < keys.length ? keys[end - 1] : null };
    },
    _map: base._map,
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

async function makeReadyBook(store, cookie, title, n) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', chapters, wordCount: n * 10, cleanVer: 1 } }));
  assert.equal(r.status, 200);
  const id = r.data.id;
  for (let i = 0; i < n; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '第' + (i + 1) + '章正文内容，用于测试。' }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return id;
}

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

/* ---------------- ① 章节读取状态副档 ---------------- */

test('副档：creating 挡读 409，publish 放行 200 并写入 {s:ready} 副档', async () => {
  const store = memStore();
  const cookie = await login(store);
  const chapters = ['第一章 x'];
  const r0 = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '副档书', chapters, wordCount: 5 } }));
  const id = r0.data.id;
  // 未发布（creating）：副档已写入，章节挡读
  let st = JSON.parse(await store.getText(`meta/sec/st/${id}.json`));
  assert.equal(st.s, 'creating', '建书时应写 creating 副档');
  let r = await call(store, req(`/api/books/${id}/chapters/1`, { cookie }));
  assert.equal(r.status, 409, 'creating 状态应挡读');
  // 发布 → 200 且副档翻转
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '正文' }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  st = JSON.parse(await store.getText(`meta/sec/st/${id}.json`));
  assert.equal(st.s, 'ready', '发布后副档应为 ready');
  r = await call(store, req(`/api/books/${id}/chapters/1`, { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.text, '正文');
});

test('副档：老书无副档时回落 meta 判定并补写副档（一次性迁移）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '老书', 2);
  store._map.delete(`meta/sec/st/${id}.json`); // 模拟存量书
  const r = await call(store, req(`/api/books/${id}/chapters/1`, { cookie }));
  assert.equal(r.status, 200, '无副档应回落 meta 放行 ready 书');
  const st = JSON.parse(await store.getText(`meta/sec/st/${id}.json`));
  assert.equal(st.s, 'ready', '回落时应补写副档');
});

/* ---------------- ② 进度镜像只在换章时更新 ---------------- */

test('镜像：章内比例变动 >2% 不重写 index 镜像，换章才更新（真值仍在 progress 文件）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '镜像书', 5);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.4 } }));
  let b = JSON.parse(await store.getText('meta/index.json')).books.find((x) => x.id === id);
  assert.equal(b.prog.ch, 3);
  assert.ok(Math.abs(b.prog.ratio - 0.4) < 1e-6, '首次换章应建立镜像');
  const savedAt = b.prog.updatedAt;

  // 同章内滚到 0.95（变动远超旧 2% 阈值）→ 镜像不动
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.95 } }));
  b = JSON.parse(await store.getText('meta/index.json')).books.find((x) => x.id === id);
  assert.ok(Math.abs(b.prog.ratio - 0.4) < 1e-6, '章内滚动不应重写 index 镜像');
  assert.equal(b.prog.updatedAt, savedAt, '镜像 updatedAt 不应变化');

  // 真值文件照常更新
  let p = JSON.parse(await store.getText(`progress/${id}.json`));
  assert.ok(Math.abs(p.ratio - 0.95) < 1e-6, 'progress 真值应随滚动更新');

  // 换章 → 镜像更新
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 4, ratio: 0.1 } }));
  b = JSON.parse(await store.getText('meta/index.json')).books.find((x) => x.id === id);
  assert.equal(b.prog.ch, 4, '换章应更新镜像章号');
  assert.ok(Math.abs(b.prog.ratio - 0.1) < 1e-6, '换章应更新镜像比例');
});

/* ---------------- ③ diag 分窗续扫 ---------------- */

test('diag：text 超单窗预算回传 textCursor，续扫后残留/孤儿分类完整', async () => {
  const base = memStore();
  const cookie = await login(base);
  const liveId = await makeReadyBook(base, cookie, '续扫活书', 3);
  // 260 个无主 text 对象（10 段一本 × 26 本「已删书」）→ text/ 共 263 个对象
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 10; j++) base._map.set(`text/dead${i}/c${j}.txt`, 'x'.repeat(10));
  }
  // 活书章表外孤儿（应在续扫窗内被找出）
  base._map.set(`text/${liveId}/zzz-orphan.txt`, 'orphan-body');
  const store = pagedStore(base, 20); // 每页 20 → 263+ 对象 = 14 页 > 单窗 12 页

  const r1 = await call(store, req('/api/diag/orphans', { cookie }));
  assert.equal(r1.status, 200);
  assert.ok(r1.data.textCursor, '第一窗应回传续扫 cursor');
  assert.equal(r1.data.incomplete, false, '分窗续扫设计下第一窗不算不完整');
  // 第一窗：孤儿的 key 按 id 排序在 dead* 之后？不——liveId 在 dead* 之前或之后都可能，不假设，只验证合并后完整

  const r2 = await call(store, req(`/api/diag/orphans?textCursor=${encodeURIComponent(r1.data.textCursor)}`, { cookie }));
  assert.equal(r2.status, 200);
  assert.equal(r2.data.textCursor, null, '第二窗应扫完（cursor 为 null）');

  // 合并两窗结果验证完整性
  const residue = [...r1.data.residue, ...r2.data.residue];
  const chOrphans = [...r1.data.chapterOrphans, ...r2.data.chapterOrphans];
  const deadKeys = residue.filter((o) => o.key.startsWith('text/dead'));
  assert.equal(deadKeys.length, 260, '260 个无主 text 对象应全部被扫出（无重复、无遗漏）');
  assert.equal(new Set(deadKeys.map((o) => o.key)).size, 260, '续扫合并不应产生重复');
  assert.equal(chOrphans.length, 1, '活书孤儿应被找出');
  assert.equal(chOrphans[0].key, `text/${liveId}/zzz-orphan.txt`);
});

test('diag：未登录 401，textCursor 参数不影响鉴权', async () => {
  const store = memStore();
  const r = await call(store, req('/api/diag/orphans?textCursor=abc'));
  assert.equal(r.status, 401);
});

test('diag：无主书跨窗正文不得误判为 residue（无主书正文须保全，走移入回收站路径）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const liveId = await makeReadyBook(base, cookie, '跨窗活书', 2);
  // 260 个无主 text 填充（dead* 排序在前），再放一本无主书 zzorphan（meta 在、书不在架），
  // 其正文 key 排在 dead* 之后 → 必然落入第二窗
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 10; j++) base._map.set(`text/dead${i}/c${j}.txt`, 'x'.repeat(10));
  }
  base._map.set('meta/zzorphan.json', JSON.stringify({ id: 'zzorphan', title: '断头书', status: 'creating', chapters: [{ key: 'k1' }], tags: [] }));
  for (let j = 0; j < 5; j++) base._map.set(`text/zzorphan/k${j}.txt`, 'y');
  const store = pagedStore(base, 20);

  const r1 = await call(store, req('/api/diag/orphans', { cookie }));
  assert.ok(r1.data.textCursor, '应进入续扫');
  const r2 = await call(store, req(`/api/diag/orphans?textCursor=${encodeURIComponent(r1.data.textCursor)}`, { cookie }));
  assert.equal(r2.data.textCursor, null, '第二窗应扫完');

  const residue = [...r1.data.residue, ...r2.data.residue];
  assert.equal(residue.filter((o) => o.key.startsWith('text/zzorphan')).length, 0, '无主书正文绝不能进 residue（会被「删除全部」清掉）');
  const ob = r1.data.orphanBooks.find((b) => b.id === 'zzorphan');
  assert.ok(ob, '无主书明细应来自首页 orphanBooks');
  assert.ok(!ob.texts, '跨窗正文不在首页计数（展示层小误差，可接受）');
  // 活书正文不误报
  assert.equal(residue.filter((o) => o.key.startsWith(`text/${liveId}/`)).length, 0, '活书正文不得进 residue');
});

/* ---------------- ④ OPDS 分页 ---------------- */

test('opds：150 本书 → p1 恰 100 条 + rel next；p2 剩余 50 条 + rel previous', async () => {
  const store = memStore();
  const books = [];
  for (let i = 0; i < 150; i++) {
    books.push({ id: 'b' + String(i).padStart(3, '0'), title: '书' + i, author: 'a', tags: [], chapterCount: 1, wordCount: 1, createdAt: 1700000000000 + i, updatedAt: 1700000000000 + i });
  }
  store._map.set('meta/index.json', JSON.stringify({ books }));
  const auth = { headers: { authorization: basic('r', 'test-pass') } };

  const r1 = await call(store, req('/opds', auth));
  assert.equal(r1.status, 200);
  assert.equal((r1.text.match(/<entry>/g) || []).length, 100, '第一页应恰 100 条');
  assert.match(r1.text, /rel="next" href="\/opds\?p=2"/, '应有 next 链接');
  assert.doesNotMatch(r1.text, /rel="previous"/, '第一页不应有 previous');

  const r2 = await call(store, req('/opds?p=2', auth));
  assert.equal((r2.text.match(/<entry>/g) || []).length, 50, '第二页应剩 50 条');
  assert.match(r2.text, /rel="previous"/, '第二页应有 previous 链接');
  assert.doesNotMatch(r2.text, /rel="next"/, '第二页不应有 next');

  // 翻页内容不重叠：p1 首条是最新书、p2 末条是最旧书
  assert.match(r1.text, /<title>书149</, 'p1 应含最新书');
  assert.match(r2.text, /<title>书0</, 'p2 应含最旧书');
});

/* ---------------- ⑤ 上传链路提速（2026-09-08） ---------------- */

test('publish 响应回传发布后的 books 快照（前端免二次 GET /api/books）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const chapters = ['第一章 a', '第二章 b', '第三章 c'];
  let r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '快照书', chapters, wordCount: 30 } }));
  const id = r.data.id;
  await call(store, req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: { chapters: [{ key: '1', text: 'a' }, { key: '2', text: 'b' }, { key: '3', text: 'c' }] } }));

  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.books), '响应应含 books 快照');
  assert.equal(r.data.books.length, 1, '快照应含刚发布的书');
  assert.equal(r.data.books[0].id, id);
  assert.equal(r.data.books[0].chapterCount, 3);
  assert.equal(r.data.books[0].wordCount, 30);
  // 快照与 GET /api/books 结构一致（前端 loadShelf({books}) 等价于旧刷新路径）。
  // updatedAt 归一后再比：两次请求落在不同毫秒属正常，不能作为差异
  const norm = (arr) => JSON.parse(JSON.stringify(arr)).map((b) => ({ ...b, updatedAt: 0 }));
  r = await call(store, req('/api/books', { cookie }));
  const get1 = norm(r.data.books);
  const pub2 = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.deepEqual(norm(pub2.data.books), get1, '快照应与书架 GET 一致');
  // t 分阶段耗时存在（诊断字段）
  assert.ok(pub2.data.t && typeof pub2.data.t.total === 'number', '应含分阶段耗时 t');
});
