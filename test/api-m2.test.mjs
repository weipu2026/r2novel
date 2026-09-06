/* api-m2.test.mjs — M2 书库管理 API 单测（内存 store 模拟 R2/文件系统） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { BULK_CHAPTER_BATCH } from '../public/js/shared-const.js';

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
  assert.equal(r.data.done, false, '45 章 > 30 上限 → 首批未完成');
  assert.equal(r.data.remaining, 15);
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

test('M2：批量上传章节（bulk）—— 一次校验一次写，正文可读，章表外 key 拒收', async () => {
  const store = memStore();
  const cookie = await login(store);
  const r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '批量书', chapters: ['第1章', '第2章'], wordCount: 10, cleanVer: 1 } }));
  assert.equal(r.status, 200);
  const id = r.data.id;

  const up = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: { chapters: [{ key: '1', text: '批量正文一' }, { key: '2', text: '批量正文二' }] },
    })
  );
  assert.equal(up.status, 200);
  assert.equal(up.data.count, 2);

  const bad = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: { chapters: [{ key: '99', text: 'x' }] } })
  );
  assert.equal(bad.status, 404, '章表外 key 拒收');

  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  const t = await call(store, req(`/api/books/${id}/chapters/2`, { cookie }));
  assert.equal(t.text, '批量正文二');
});

test('M2：PATCH finished —— meta 与书架条目同步，完结状态可持久化', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '完结书', 3);

  let shelf = await call(store, req('/api/books', { cookie }));
  assert.equal(shelf.data.books.find((b) => b.id === id).finished, false, '默认未完结');

  const p = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { finished: true } }));
  assert.equal(p.status, 200);

  shelf = await call(store, req('/api/books', { cookie }));
  assert.equal(shelf.data.books.find((b) => b.id === id).finished, true, '书架条目应同步 finished');
  const meta = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(meta.data.finished, true, 'meta 应持久化 finished');
});

test('M2：bulk 单批上限 —— 超过 BULK_CHAPTER_BATCH 拒收 413，恰好达限放行', async () => {
  const store = memStore();
  const cookie = await login(store);
  const r = await call(store, req('/api/books', {
    method: 'POST',
    cookie,
    body: { title: '批量上限书', chapters: Array.from({ length: BULK_CHAPTER_BATCH + 1 }, (_, i) => '第' + (i + 1) + '章'), wordCount: BULK_CHAPTER_BATCH + 1 },
  }));
  assert.equal(r.status, 200);
  const id = r.data.id;

  const many = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: { chapters: Array.from({ length: BULK_CHAPTER_BATCH + 1 }, (_, i) => ({ key: String(i + 1), text: 'x' })) },
    })
  );
  assert.equal(many.status, 413, '超过单批上限应拒收');

  const ok = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, {
      method: 'POST',
      cookie,
      body: { chapters: Array.from({ length: BULK_CHAPTER_BATCH }, (_, i) => ({ key: String(i + 1), text: 'y' })) },
    })
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.data.count, BULK_CHAPTER_BATCH, '恰好达限应放行');
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

/* ================= v1.1：已发布书章节就地编辑 ================= */

const wc = (s) => String(s || '').replace(/\s/g, '').length;

test('v1.1：PATCH 章节标题+正文 → 同步 meta/字数/cleanVer/书架摘要，书保持可读', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '就地编辑书', 3);
  const oldMeta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;

  const newContent = '这是改过的第二章正文，字数会变。abc123';
  let r = await call(store, req(`/api/books/${id}/chapters/2`, { method: 'PATCH', cookie, body: { title: '第二章 新题名', content: newContent } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.title, '第二章 新题名');
  assert.equal(r.data.cleanVer, oldMeta.cleanVer + 1, 'cleanVer +1');

  const meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.equal(meta.status, 'ready', '就地编辑后书保持已发布可读');
  assert.equal(meta.chapters.length, 3, '章节数不变');
  assert.equal(meta.chapters[1].title, '第二章 新题名');
  const oldW = wc('第2章正文内容，用于测试。');
  assert.equal(meta.wordCount, oldMeta.wordCount - oldW + wc(newContent), '字数按新旧差修正');

  r = await call(store, req(`/api/books/${id}/chapters/2`, { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.text, newContent, '正文已覆盖');

  // 书架摘要镜像字数
  const books = (await call(store, req('/api/books', { cookie }))).data.books;
  const b = books.find((x) => x.id === id);
  assert.equal(b.wordCount, meta.wordCount, 'index 字数镜像同步');
});

test('v1.1：PATCH 仅标题 / 空标题兜底第N章 / 无修改内容 400', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '改题书', 2);
  const before = (await call(store, req(`/api/books/${id}`, { cookie }))).data;

  let r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PATCH', cookie, body: { title: '   ' } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.title, '第1章', '空标题兜底为第 N 章');

  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.data.wordCount, before.wordCount, '仅改标题不动字数');

  r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PATCH', cookie, body: {} }));
  assert.equal(r.status, 400, '无修改内容拒绝');

  r = await call(store, req(`/api/books/${id}/chapters/99`, { method: 'PATCH', cookie, body: { title: 'x' } }));
  assert.equal(r.status, 404, '不存在的章 404');

  // 半成品状态不可就地编辑：
  //   a) 未发布书不在书架 → 404
  const fresh = (await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '半成品书', chapters: ['第一章'], wordCount: 1 } }))).data;
  r = await call(store, req(`/api/books/${fresh.id}/chapters/1`, { method: 'PATCH', cookie, body: { title: 'x' } }));
  assert.equal(r.status, 404, '未发布书不在书架 → 404');
  //   b) replace 重建后（在架但 creating）→ 409
  await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['新章'], wordCount: 1 } }));
  r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PATCH', cookie, body: { title: 'x' } }));
  assert.equal(r.status, 409, '在架但 creating（替换中）→ 409');

  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  r = await call(store, req(`/api/books/${id}/chapters/2`, { method: 'PATCH', cookie, body: { title: 'x' } }));
  assert.equal(r.status, 404, '软删后 404');
});

test('v1.1：INSERT 中部/末尾插入（独立 key），章序/字数/书架同步，进度顺移', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '插章书', 3);
  const oldMeta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.5 } }));

  const body = '插入的正文。';
  let r = await call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body: { after: '1', title: '第一章 补', content: body } }));
  assert.equal(r.status, 200);
  assert.ok(r.data.key.startsWith('n_'), '新章用独立 n_ key，不与数字 key 冲突');
  assert.equal(r.data.chapterCount, 4);

  let meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.deepEqual(meta.chapters.map((c) => c.key), ['1', r.data.key, '2', '3'], '插入后老章 key 稳定不动');
  assert.equal(meta.chapters[1].title, '第一章 补');
  assert.equal(meta.wordCount, oldMeta.wordCount + wc(body), '字数累加');

  r = await call(store, req(`/api/books/${id}/chapters/${r.data.key}`, { cookie }));
  assert.equal(r.text, body, '新章正文可取');

  // 进度迁移：插在第 3 章之前 → ch 3 → 4
  const prog = (await call(store, req(`/api/progress/${id}`, { cookie }))).data;
  assert.equal(prog.ch, 4, '插入后进度章号顺移 +1');

  // 末尾追加（不传 after）
  r = await call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body: { title: '尾章', content: '尾。' } }));
  assert.equal(r.status, 200);
  meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.equal(meta.chapters.length, 5);
  assert.equal(meta.chapters[4].title, '尾章');

  // 校验边界
  r = await call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body: {} }));
  assert.equal(r.status, 400, '标题与正文都为空拒绝');
  r = await call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body: { after: 'nope', title: 'x', content: 'y' } }));
  assert.equal(r.status, 404, '参照章节不存在 404');
});

test('v1.1：DELETE 章节 → 字数/书架同步、正文清除、进度回退；末章不可删', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '删章书', 3);
  const oldMeta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.4 } }));

  let r = await call(store, req(`/api/books/${id}/chapters/2`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.chapterCount, 2);
  assert.ok(!store._map.has(`text/${id}/2.txt`), '被删章正文对象已清除');

  let meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.deepEqual(meta.chapters.map((c) => c.key), ['1', '3'], '数组移除且老章 key 不动');
  assert.equal(meta.wordCount, oldMeta.wordCount - wc('第2章正文内容，用于测试。'), '字数扣减');

  const books = (await call(store, req('/api/books', { cookie }))).data.books;
  const b = books.find((x) => x.id === id);
  assert.equal(b.chapterCount, 2, '书架章数镜像同步');

  // 进度迁移：ch3 在被删章(idx1)之后 → 2
  const prog = (await call(store, req(`/api/progress/${id}`, { cookie }))).data;
  assert.equal(prog.ch, 2, '删除后进度章号回退 -1');

  // 末章不可删 / 不存在章 404
  const only = (await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '单章书', chapters: ['仅一章'], wordCount: 3 } }))).data;
  await call(store, req(`/api/books/${only.id}/chapters/1`, { method: 'PUT', cookie, body: '单章正文' }));
  await call(store, req(`/api/books/${only.id}/publish`, { method: 'POST', cookie }));
  r = await call(store, req(`/api/books/${only.id}/chapters/1`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 400, '至少保留一章');

  r = await call(store, req(`/api/books/${id}/chapters/9`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 404);
});

test('M2：F17 append 起点避让稀疏 key —— 删章后再追加不覆盖旧章正文', async () => {
  const store = memStore();
  const cookie = await login(store);
  const bk = (await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '稀疏key书', chapters: ['第1章', '第2章', '第3章'], wordCount: 30 } }))).data;
  const id = bk.id;
  const bodies = ['一一', '二二二', '三三三三'];
  for (let i = 1; i <= 3; i++) await call(store, req(`/api/books/${id}/chapters/${i}`, { method: 'PUT', cookie, body: bodies[i - 1] }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));

  // 就地删除第 2 章 → 章表 key 变稀疏 [1,3]
  await call(store, req(`/api/books/${id}/chapters/2`, { method: 'DELETE', cookie }));
  let meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.deepEqual(meta.chapters.map((c) => c.key), ['1', '3'], '删除后 key 稀疏');

  // append 2 章：按「章数+1」会算出 startKey=3 → 撞已有 key 3（旧实现会覆盖第 3 章正文）
  const r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['第4章', '第5章'], wordCount: 10 } }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.chapterKeys, ['1', '3', '4', '5'], 'append 起点取最大数字 key+1');

  await call(store, req(`/api/books/${id}/chapters/4`, { method: 'PUT', cookie, body: '四四四四四' }));
  await call(store, req(`/api/books/${id}/chapters/5`, { method: 'PUT', cookie, body: '五五五五五五' }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.deepEqual(meta.chapters.map((c) => c.key), ['1', '3', '4', '5']);
  assert.equal(store._map.get(`text/${id}/3.txt`), '三三三三', '旧第 3 章正文未被 append 的新 key 覆盖');
});

test('M2：F18 已发布书禁止走建书通道直写正文（PUT /chapters/:key → 409）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const bk = (await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '发布态保护', chapters: ['第一章'], wordCount: 2 } }))).data;
  const id = bk.id;
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '原正文' }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));

  // 发布后直写正文必须被拒（否则绕过字数/cleanVer/index 同步）
  let r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '直写覆盖' }));
  assert.equal(r.status, 409, 'ready 书拒绝 PUT 正文');
  assert.equal(store._map.get(`text/${id}/1.txt`), '原正文', '正文未被直写覆盖');

  // 就地编辑通道照常可用
  r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PATCH', cookie, body: { content: '改后正文' } }));
  assert.equal(r.status, 200);
  assert.equal(store._map.get(`text/${id}/1.txt`), '改后正文');

  // 不存在的书 → 404（不是 409）
  r = await call(store, req('/api/books/n_notexist/chapters/1', { method: 'PUT', cookie, body: 'x' }));
  assert.equal(r.status, 404);
});

test('M2：F19 未上架的半成品书也能软删+彻底清除（上传中途失败不留孤儿）', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 建书 → 只传部分正文 → 不 publish：停在 creating 且不在 index
  const bk = (await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '半成品书', chapters: ['第一章', '第二章'], wordCount: 5 } }))).data;
  const id = bk.id;
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '半成品正文' }));
  let r = await call(store, req('/api/books', { cookie }));
  assert.ok(!(r.data.books || []).some((b) => b.id === id), '半成品不在书架');

  // 软删必须接纳它（旧实现因不在 index 直接 404 → 数据永远删不掉）
  r = await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 200, '未上架半成品也能软删');
  r = await call(store, req('/api/trash', { cookie }));
  const entry = (r.data.books || []).find((b) => b.id === id);
  assert.ok(entry && entry.restorable, '进入回收站且可恢复');

  // 彻底删除 → meta 与已传正文一并清除（purge 按批续调，书小则一次 done）
  let remaining = 1;
  let guard = 0;
  while (remaining > 0 && guard++ < 10) {
    const rr = await call(store, req(`/api/trash/${id}`, { method: 'DELETE', cookie }));
    remaining = rr.data.remaining || 0;
  }
  assert.equal(store._map.has(`meta/${id}.json`), false, 'meta 已清除');
  assert.equal(store._map.has(`text/${id}/1.txt`), false, '已传正文已清除');
});

test('M2：F20 未发布书（半成品）进回收站后不可恢复（避免书架孤儿）', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 建书不发布 → creating，软删入回收站
  const bk = (await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '半成品B', chapters: ['第一章'], wordCount: 2 } }))).data;
  const id = bk.id;
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  let r = await call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
  assert.equal(r.status, 409, 'creating 书不可恢复');
  assert.equal(r.data.error.includes('尚未发布'), true, '提示未发布');
  // 书仍留在回收站，可彻底删除
  r = await call(store, req('/api/trash', { cookie }));
  assert.ok((r.data.books || []).some((b) => b.id === id), '仍在回收站');
  // 对照：已发布书软删后照常可恢复
  const ok = await makeReadyBook(store, cookie, '可恢复书', 2);
  await call(store, req(`/api/books/${ok.id}`, { method: 'DELETE', cookie }));
  r = await call(store, req(`/api/books/${ok.id}/restore`, { method: 'POST', cookie }));
  assert.equal(r.status, 200, 'ready 书可恢复');
});

test('M2：F21 建书/更新期 PUT 章表外 key → 404（堵孤儿正文来源）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const bk = (await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '表外书', chapters: ['第一章', '第二章'], wordCount: 2 } }))).data;
  const id = bk.id;
  // key=99 不在章表（表内只有 1、2）→ 拒绝落盘
  let r = await call(store, req(`/api/books/${id}/chapters/99`, { method: 'PUT', cookie, body: '孤儿正文' }));
  assert.equal(r.status, 404, '章表外 key 拒绝');
  assert.equal(store._map.has(`text/${id}/99.txt`), false, '未产生孤儿对象');
  // 表内 key 照常可传
  r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '正常正文' }));
  assert.equal(r.status, 200);
  await call(store, req(`/api/books/${id}/chapters/2`, { method: 'PUT', cookie, body: '正文二' }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200, '正常流程 publish 不受影响');
});

test('M2：F22 就地删除末章后云端进度压回章数内（书架角标不越界）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '进度越界书', 3);
  // 读到第 3 章（末章）并把进度上报云端
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.5 } }));
  // 就地删除末章（key=3）→ 剩 2 章，进度应被压回 2 而不是留在 3
  let r = await call(store, req(`/api/books/${id}/chapters/3`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.chapterCount, 2);
  r = await call(store, req(`/api/progress/${id}`, { cookie }));
  assert.equal(r.data.ch, 2, '末章删除后进度压回新末章');
  // 书在书架镜像也同步为 2 章（索引已更新）
  r = await call(store, req('/api/books', { cookie }));
  const entry = (r.data.books || []).find((b) => b.id === id);
  assert.equal(entry.chapterCount, 2);
  // 删除中间章（key=1，进度 2 在其后）→ 进度前移为 1
  r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 200);
  r = await call(store, req(`/api/progress/${id}`, { cookie }));
  assert.equal(r.data.ch, 1, '删前章进度前移');
});
