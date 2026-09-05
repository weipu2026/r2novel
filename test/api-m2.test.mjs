/* api-m2.test.mjs — M2 书库管理 API 单测（内存 store 模拟 R2/文件系统） */
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

/** 快捷建一本 ready 书（传 N 章 + 发布） */
async function makeReadyBook(store, cookie, title, n, tags = []) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', tags, chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, false);
  const id = r.data.id;
  for (let i = 0; i < n; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '第' + (i + 1) + '章正文内容，用于测试。' }));
  }
  await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('raw-' + title) }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return { id, title };
}

test('M2：同名建书返回 duplicate 提示（F4 去重入口）', async () => {
  const store = memStore();
  const cookie = await login(store);
  await makeReadyBook(store, cookie, '同名之书', 2);
  let r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '同名 之 书', chapters: ['x'], wordCount: 1 } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, true, '去空白同名应命中 duplicate');
  assert.ok(r.data.book && r.data.book.id);
  // 无同名 → duplicate false
  r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '一本新书', chapters: ['x'], wordCount: 1 } }));
  assert.equal(r.data.duplicate, false);
  assert.ok(r.data.id);
});

test('M2：PATCH 改名/作者/标签/置顶 → 同步 index 与 meta', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '待改书', 3);
  let r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { title: '新书名', tags: ['奇幻'], pinned: true } }));
  assert.equal(r.status, 200);
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.data.title, '新书名');
  assert.deepEqual(r.data.tags, ['奇幻']);
  assert.equal(r.data.pinned, true);
  r = await call(store, req('/api/books', { cookie }));
  const b = r.data.books.find((x) => x.id === id);
  assert.equal(b.title, '新书名');
  assert.equal(b.pinned, true, '书架条目应有 pinned');
});

test('M2：进度 PUT 后 index 条目带 prog 镜像（书架角标数据源）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '进度镜像书', 5);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.4 } }));
  const r = await call(store, req('/api/books', { cookie }));
  const b = r.data.books.find((x) => x.id === id);
  assert.ok(b.prog, 'index 条目应有 prog 镜像');
  assert.equal(b.prog.ch, 3);
  assert.ok(b.prog.updatedAt > 0);
});

test('M2：更新章节表 replace（进度按同名标题保留）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '替换书', 3);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0.5 } }));
  let r = await call(
    store,
    req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['第2章 章2', '第1章 章1', '新章 终'], wordCount: 30 } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.chapterKeys.length, 3);
  for (let i = 0; i < 3; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '新版正文' + (i + 1) }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.cleanVer, 2, 'replace 后 cleanVer 应 +1');
  r = await call(store, req(`/api/progress/${id}`, { cookie }));
  assert.equal(r.data.ch, 1, '进度应迁移到同名标题所在新位置');
  assert.ok(Math.abs(r.data.ratio - 0.5) < 1e-6);
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.status, 200);
});

test('M2：更新章节表 append（续接连载，旧章保留）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '连载书', 2);
  let r = await call(
    store,
    req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['第3章 新三', '第4章 新四'] } })
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.chapterKeys.slice(0, 2), ['1', '2'], '旧章 key 不动');
  assert.deepEqual(r.data.chapterKeys.slice(2), ['3', '4'], '新章从旧章数+1 续接');
  for (const k of ['3', '4']) {
    await call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PUT', cookie, body: '追加正文' + k }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.chapterCount, 4);
  const meta = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(meta.data.chapters[3].title, '第4章 新四');
  // append 不迁移进度：旧进度仍指第 2 章
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0 } }));
});

test('M2：软删 → 回收站 → 恢复（正文不动）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '删删书', 2);
  let r = await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 200);
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.data.books.some((b) => b.id === id), false, '书架已移除');
  r = await call(store, req('/api/trash', { cookie }));
  assert.ok(r.data.books.some((b) => b.id === id && b.restorable), '回收站可见且可恢复');
  assert.ok(store._map.has(`text/${id}/1.txt`), '软删不删正文');
  assert.ok(store._map.has(`raw/${id}.txt`), '软删不删 raw');
  r = await call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.data.books.some((b) => b.id === id), true, '恢复回书架');
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.status, 200, '恢复后立即可读');
});

test('M2：彻底删除分批 + 清空（purge 预算回归）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const a = await makeReadyBook(store, cookie, '大书A', 45);
  const b = await makeReadyBook(store, cookie, '大书B', 10);
  for (const x of [a.id, b.id]) await call(store, req(`/api/books/${x}`, { method: 'DELETE', cookie }));

  let r = await call(store, req(`/api/trash/${a.id}`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.done, false, '45 章 > 40 上限 → 首批未完成');
  assert.equal(r.data.remaining, 5);
  r = await call(store, req(`/api/trash/${a.id}`, { method: 'DELETE', cookie }));
  assert.equal(r.data.done, true, '续调后完成');
  assert.ok(!store._map.has(`text/${a.id}/1.txt`), '正文已清');
  assert.ok(!store._map.has(`meta/${a.id}.json`), 'meta 已清');

  r = await call(store, req('/api/trash?action=clear', { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.remaining, 0, '一次清空');
  r = await call(store, req('/api/trash', { cookie }));
  assert.equal(r.data.books.length, 0);
});

test('M2：>50 章大书 publish 通过（子请求预算修复回归）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const chapters = Array.from({ length: 55 }, (_, i) => '第' + (i + 1) + '章');
  let r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '五十五章书', chapters, wordCount: 555 } }));
  const id = r.data.id;
  for (let i = 0; i < 55; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '正文' + i }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.chapterCount, 55);
  assert.equal(r.data.wordCount, 555, '字数用上报值，不回读全部章');
});

test('M2：对已软删书 PATCH/update 拒绝', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '已删书', 2);
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  let r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { pinned: true } }));
  assert.equal(r.status, 404);
  r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['新'] } }));
  assert.equal(r.status, 404);
});

test('M2：回收站条目彻底删除后再恢复 → 404（幂等）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '删两次书', 2);
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  await call(store, req(`/api/trash/${id}`, { method: 'DELETE', cookie }));
  let r = await call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
  assert.equal(r.status, 404);
});

test('M2：F16 备注 —— 建书保存 note / PATCH 更新 / GET 返回', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 建书带 note
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title: '备注书', author: '作者甲', note: '初版备注', tags: ['奇幻'], chapters: ['第一章'], wordCount: 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  const id = r.data.id;
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '正文。' }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));

  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.data.note, '初版备注', 'meta 应带建书时的 note');

  // PATCH 改 note
  r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { note: '更新后的备注' } }));
  assert.equal(r.status, 200);
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.data.note, '更新后的备注', 'PATCH 后 meta.note 更新');

  // note 可清空
  r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { note: '' } }));
  assert.equal(r.status, 200);
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.data.note, '', 'note 可清空');

  // 书架摘要不含 note（index 保持精简）
  r = await call(store, req('/api/books', { cookie }));
  const b = r.data.books.find((x) => x.id === id);
  assert.ok(!('note' in b), 'index 摘要不携带 note');
});

test('M2：F16 备注 —— replace 重洗带 note / append 保留旧 note', async () => {
  const store = memStore();
  const cookie = await login(store);
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title: '备注连载', note: '旧备注', chapters: ['第1章', '第2章'], wordCount: 20 } })
  );
  const id = r.data.id;
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '一。' }));
  await call(store, req(`/api/books/${id}/chapters/2`, { method: 'PUT', cookie, body: '二。' }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));

  // append 新章：note 不带 → 保留旧
  r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['第3章'] } }));
  assert.equal(r.status, 200);
  await call(store, req(`/api/books/${id}/chapters/3`, { method: 'PUT', cookie, body: '三。' }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.data.note, '旧备注', 'append 不携带 note 时保留原备注');

  // replace（模拟重洗全量提交）带 note → 覆盖
  r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['新1'], note: '重洗备注', wordCount: 5 } }));
  assert.equal(r.status, 200);
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '新正文。' }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.data.note, '重洗备注', 'replace 携带 note 时覆盖');
});
