/* diag.test.mjs — 残留诊断 API（书架「检查残留」）单测
 * 覆盖：全空库 / 无主书（creating）/ 已删残留对象 / 章节孤儿 / 批量删除 /
 *       无主书移入回收站 / 未登录 401 / meta 前缀拒删 / 活书正常正文不误报
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
      return out;
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

/** 快捷建一本 ready 书（传 N 章 + 发布），返回 id */
async function makeReadyBook(store, cookie, title, n) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', tags: [], chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  const id = r.data.id;
  for (let i = 0; i < n; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '正文' + (i + 1) }));
  }
  await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('raw-' + title) }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return { id, title };
}

const diag = async (store, cookie) => (await call(store, req('/api/diag/orphans', { cookie }))).data;

test('diag：未登录 401', async () => {
  const store = memStore();
  const r = await call(store, req('/api/diag/orphans'));
  assert.equal(r.status, 401);
});

test('diag：空库一切干净，活书正常正文不误报', async () => {
  const store = memStore();
  const cookie = await login(store);
  let d = await diag(store, cookie);
  assert.equal(d.summary.residue + d.summary.orphanBooks + d.summary.chapterOrphans, 0);

  await makeReadyBook(store, cookie, '正常书', 3);
  d = await diag(store, cookie);
  assert.equal(d.summary.orphanBooks, 0, 'ready 书在架，不算无主书');
  assert.equal(d.summary.chapterOrphans, 0, '活书正常章节正文不得误报');
  assert.equal(d.summary.residue, 0);
  assert.equal(d.liveBooks, 1);
});

test('diag：未发布半成品（creating）记为无主书，可移入回收站', async () => {
  const store = memStore();
  const cookie = await login(store);
  const r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title: '半成品', chapters: ['第1章'], wordCount: 10 } })
  );
  assert.equal(r.status, 200);
  const id = r.data.id;

  const d = await diag(store, cookie);
  assert.equal(d.summary.orphanBooks, 1);
  const ob = d.orphanBooks[0];
  assert.equal(ob.id, id);
  assert.equal(ob.status, 'creating');

  // 移入回收站（软删接纳无主书）→ 无主书清零、回收站 +1
  const s = await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  assert.equal(s.status, 200);
  const d2 = await diag(store, cookie);
  assert.equal(d2.summary.orphanBooks, 0);
  const t = await call(store, req('/api/trash', { cookie }));
  assert.equal(t.data.books.length, 1);
});

test('diag：已删书的伴生残留与无 meta 正文可列出并批量删除', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 造一个「已删干净」参照：建书 → 软删 → 回收站彻底删除 → 全库应无残留
  const { id } = await makeReadyBook(store, cookie, '将删之书', 2);
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie })); // 移入回收站
  await call(store, req(`/api/trash/${id}`, { method: 'DELETE', cookie })); // 彻底删除
  let d = await diag(store, cookie);
  assert.equal(d.summary.residue + d.summary.orphanBooks + d.summary.chapterOrphans, 0, '正常删书路径不得留下任何残留');

  // 手工塞三类「漏删/中断」对象（模拟历史缺陷产物）
  store._map.set('text/n_res001/k_orphan.txt', '残留正文');
  store._map.set('raw/n_res001.txt', '残留 raw');
  store._map.set('progress/n_res001.json', '{"ch":1,"ratio":0}');
  d = await diag(store, cookie);
  assert.equal(d.summary.residue, 3);
  const keys = d.residue.map((o) => o.key).sort();
  assert.deepEqual(keys, ['progress/n_res001.json', 'raw/n_res001.txt', 'text/n_res001/k_orphan.txt']);

  // 批量删除
  const del = await call(store, req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: keys } }));
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, 3);
  const d2 = await diag(store, cookie);
  assert.equal(d2.summary.residue, 0);
});

test('diag：活书章表外正文记为章节孤儿，可删；meta 前缀拒删', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, title } = await makeReadyBook(store, cookie, '孤儿宿主', 2);

  store._map.set(`text/${id}/zz_ghost.txt`, '孤儿正文'); // 章表外 key
  const d = await diag(store, cookie);
  assert.equal(d.summary.chapterOrphans, 1);
  assert.equal(d.chapterOrphans[0].key, `text/${id}/zz_ghost.txt`);
  assert.equal(d.chapterOrphans[0].bookTitle, title);
  assert.equal(d.chapterOrphans[0].known, false, '不在 meta.orphans 登记的未登记孤儿');

  const key = `text/${id}/zz_ghost.txt`;
  const del = await call(store, req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: [key] } }));
  assert.equal(del.data.deleted, 1);
  const d2 = await diag(store, cookie);
  assert.equal(d2.summary.chapterOrphans, 0);

  // meta/* 前缀必须拒删（防止误删书元数据/系统文件）→ 无合法对象，400 且零删除
  const bad = await call(
    store,
    req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: [`meta/${id}.json`, 'meta/index.json'] } })
  );
  assert.equal(bad.status, 400, 'meta 前缀对象必须整体拒绝');
});

test('diag：DELETE 空列表 / 非法 body 校验', async () => {
  const store = memStore();
  const cookie = await login(store);
  let r = await call(store, req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: [] } }));
  assert.equal(r.status, 400);
  r = await call(store, req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: ['../meta/x.json'] } }));
  assert.equal(r.status, 400);
});

test('diag：活书当前章节正文 / raw / progress 经 DELETE 一律拒删', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '拒删书', 2);

  // 当前章节正文 + 活书原件 + 进度 → 全部拒删（防扫描后竞态误删活书数据）
  const del = await call(
    store,
    req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: [`text/${id}/1.txt`, `raw/${id}.txt`, `progress/${id}.json`] } })
  );
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, 0, '活书当前章节/raw/progress 一律拒删');
  assert.equal(del.data.skipped, 3);

  // 正文未被删，仍能读到
  const t1 = await call(store, req(`/api/books/${id}/chapters/1`, { cookie }));
  assert.equal(t1.text, '正文1');
  // 扫描依旧干净（无残留可清理）
  const d = await diag(store, cookie);
  assert.equal(d.summary.residue, 0);
});

test('diag：书多导致预算耗尽时返回 incomplete 而非报错', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 造 45 本未入架半成品：无主 meta 逐本 readBook → 顶到 DIAG_SUB_BUDGET
  for (let i = 0; i < 45; i++) {
    const r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '孤儿' + i, chapters: ['第1章'], wordCount: 10 } }));
    assert.equal(r.status, 200);
  }
  const d = await diag(store, cookie);
  assert.equal(d.incomplete, true, '预算耗尽应标记 incomplete 而非抛错');
  assert.equal(d.summary.orphanBooks, 45, '无主书条目仍全部列出（未读取的标 unknown）');
});
