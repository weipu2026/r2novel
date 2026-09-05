/* api.test.mjs — Worker 路由逻辑单测（内存 store，模拟 R2/文件系统） */
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
  BRUTE_LIMIT: '100', // 单测放开防爆破，避免干扰
  BRUTE_LOCK_MS: '1000',
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
    async openRead(k) {
      const v = m.get(k);
      if (v === undefined) return null;
      const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
      return new Response(bytes).body; // ReadableStream，模拟 R2 object.body
    },
    _map: m,
  };
}

function req(path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('Cookie', cookie);
  let opts = { method, headers: h };
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
  const sc = r.headers.get('set-cookie') || '';
  const m = /rn_session=([^;]+)/.exec(sc);
  assert.ok(m, '应下发 rn_session cookie');
  return 'rn_session=' + m[1];
}

test('鉴权：未登录一律 401，口令错 401，口令对返回 cookie', async () => {
  const store = memStore();
  let r = await call(store, req('/api/books'));
  assert.equal(r.status, 401);
  r = await call(store, req('/api/login', { method: 'POST', body: { password: 'wrong' } }));
  assert.equal(r.status, 401);
  const cookie = await login(store);
  assert.ok(cookie.length > 20);
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200);
});

test('全流程：建书 → 传章 → 传 raw → 发布 → 书架/目录/读章/进度', async () => {
  const store = memStore();
  const cookie = await login(store);

  // 建书
  let r = await call(
    store,
    req('/api/books', {
      method: 'POST',
      cookie,
      body: { title: '测试书', author: '某甲', tags: ['玄幻', '完结'], chapters: ['第一章 起', '第二章 承', '第三章 合'], wordCount: 66, cleanVer: 1 },
    })
  );
  assert.equal(r.status, 200);
  const { id, chapterKeys } = r.data;
  assert.deepEqual(chapterKeys, ['1', '2', '3']);

  // 未发布前书架为空
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.data.books.length, 0);

  // 传章
  for (let i = 0; i < 3; i++) {
    r = await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: `第${i + 1}章正文内容。` }));
    assert.equal(r.status, 200);
    assert.ok(r.data.words > 0);
  }
  // raw
  r = await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('原文件字节'), headers: { 'content-type': 'application/octet-stream' } }));
  assert.equal(r.status, 200);

  // 发布
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.chapterCount, 3);
  assert.ok(r.data.wordCount >= 6);

  // 书架有书
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.data.books.length, 1);
  assert.equal(r.data.books[0].title, '测试书');
  assert.equal(r.data.books[0].chapterCount, 3);

  // 目录（单书 meta）
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.chapters.length, 3);
  assert.equal(r.data.chapters[2].title, '第三章 合');
  assert.equal(r.data.status, 'ready');

  // 读章
  r = await call(store, req(`/api/books/${id}/chapters/2`, { cookie }));
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('第2章正文内容'));

  // 进度
  r = await call(store, req(`/api/progress/${id}`, { cookie }));
  assert.equal(r.data.ch, 0);
  r = await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0.55 } }));
  assert.equal(r.status, 200);
  r = await call(store, req(`/api/progress/${id}`, { cookie }));
  assert.equal(r.data.ch, 2);
  assert.ok(Math.abs(r.data.ratio - 0.55) < 1e-6);

  // index.bak：首次发布前无 index（无可备份），二次发布后才留下快照
  assert.ok(!store._map.has('meta/index.json.bak'));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.ok(store._map.has('meta/index.json.bak'), '二次 publish 应留下 .bak 快照');
  assert.equal(JSON.parse(store._map.get('meta/index.json.bak')).books.length, 1);

  // 退出后 401
  await call(store, req('/api/logout', { method: 'POST', cookie }));
  r = await call(store, req('/api/books'));
  assert.equal(r.status, 401);
});

test('发布完整性：缺章时 publish 拒绝', async () => {
  const store = memStore();
  const cookie = await login(store);
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title: '缺章书', chapters: ['一', '二', '三', '四', '五'] } })
  );
  const id = r.data.id;
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '一章' }));
  await call(store, req(`/api/books/${id}/chapters/2`, { method: 'PUT', cookie, body: '二章' }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 409);
  assert.ok(/未上传/.test(r.data.error || ''));
});

test('参数校验：空书名 / 无章节 400，非法方法 405', async () => {
  const store = memStore();
  const cookie = await login(store);
  let r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '', chapters: ['a'] } }));
  assert.equal(r.status, 400);
  r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '书名', chapters: [] } }));
  assert.equal(r.status, 400);
  r = await call(store, req('/api/books', { method: 'DELETE', cookie }));
  assert.equal(r.status, 405);
});

/* ================= OPDS / 整本导出（第三方阅读器通道） ================= */

const basic = (user, pass) => 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
const basicNoUser = (pass) => 'Basic ' + Buffer.from(':' + pass).toString('base64');

/** 造一本 3 章书入库（cookie 登录）→ 返回 { id, cookie, store } */
async function seedBook(store) {
  const cookie = await login(store);
  let r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '测试书', author: '某甲', tags: ['玄幻'], chapters: ['第一章 起', '第二章 承', '第三章 合'], wordCount: 66 } }));
  const id = r.data.id;
  for (let i = 0; i < 3; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '第' + (i + 1) + '章正文，含中文与英文 abc。' }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return { id, cookie, store };
}

test('OPDS：无凭据 401 + WWW-Authenticate；Basic 对口令 200；错口令 401', async () => {
  const { store } = await seedBook(memStore());
  let r = await call(store, req('/opds'));
  assert.equal(r.status, 401);
  assert.ok((r.headers.get('www-authenticate') || '').startsWith('Basic'), '401 应带 WWW-Authenticate 引导 App 弹登录');
  r = await call(store, req('/opds', { headers: { authorization: basic('reader', 'test-pass') } }));
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('atom+xml'));
  r = await call(store, req('/opds', { headers: { authorization: basic('reader', 'nope') } }));
  assert.equal(r.status, 401);
  r = await call(store, req('/opds', { headers: { authorization: basicNoUser('test-pass') } }));
  assert.equal(r.status, 200, '只发口令（无用户名）也应通过');
});

test('OPDS：feed 含书目 entry 与 acquisition 链接，XML 特殊字符全部转义', async () => {
  const { store } = await seedBook(memStore());
  const cookie = await login(store);
  // & 会穿过 safeStr 入库；< > " ' 会被入库清洗剥掉——模拟"绕过清洗的历史脏数据"直接篡改 index，
  // 验证 feed 层 escXml 兜底：无论库里的标题多脏，输出必须是合法 XML
  const idx = JSON.parse(store._map.get('meta/index.json'));
  const b = idx.books[0];
  b.title = 'A<B>&"C\'';
  b.author = 'x<y';
  b.tags = ['t&1', 't<2'];
  store._map.set('meta/index.json', JSON.stringify(idx));
  const r = await call(store, req('/opds', { headers: { authorization: basic('r', 'test-pass') } }));
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('A&lt;B&gt;&amp;&quot;C&apos;'), '书名特殊字符必须全部转义');
  assert.ok(r.text.includes('x&lt;y'), '作者特殊字符必须转义');
  assert.ok(r.text.includes('t&amp;1') && r.text.includes('t&lt;2'), '标签特殊字符必须转义');
  assert.ok(!r.text.includes('<title>A<B>&"C'), '不得出现未转义原始字符');
  assert.ok(r.text.includes('/export/'), '每书应带 acquisition 下载链接');
  assert.ok(r.text.includes('3 章 · 66 字'), 'summary 应含章数与字数');
});

test('OPDS：Basic 连错触发防爆破锁定（锁定期正确口令也 429 + Retry-After）', async () => {
  const env = { ...ENV, BRUTE_LIMIT: '3', BRUTE_LOCK_MS: '60000' };
  const store = memStore();
  await seedBook(store);
  for (let i = 0; i < 3; i++) {
    const s = await handleRequest(req('/opds', { headers: { authorization: basic('r', 'bad-' + i) } }), env, store);
    assert.equal(s.status, 401);
  }
  const locked = await handleRequest(req('/opds', { headers: { authorization: basic('r', 'test-pass') } }), env, store);
  assert.equal(locked.status, 429, '锁定期内即使口令正确也拒绝');
  assert.ok(Number(locked.headers.get('retry-after')) > 0, '应带 Retry-After');
});

test('OPDS：中文口令 Basic 鉴权（UTF-8 还原路径）', async () => {
  const env = { ...ENV, ADMIN_PASSWORD: '口令中文123' };
  const store = memStore();
  const ok = await handleRequest(req('/opds', { headers: { authorization: basic('r', '口令中文123') } }), env, store);
  assert.equal(ok.status, 200, '中文口令经 UTF-8 还原后应通过');
  const bad = await handleRequest(req('/opds', { headers: { authorization: basic('r', '口令中文124') } }), env, store);
  assert.equal(bad.status, 401, '中文口令错一位应拒绝');
});

test('整本导出：Basic 拉取全文 = 书头 + 逐章标题 + 正文（顺序完整）', async () => {
  const { id, store } = await seedBook(memStore());
  const r = await call(store, req(`/export/${id}.txt`, { headers: { authorization: basic('r', 'test-pass') } }));
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('text/plain'));
  assert.ok((r.headers.get('content-disposition') || '').includes('attachment'), '应声明附件下载');
  assert.ok(r.text.startsWith('测试书\n作者：某甲\n共 3 章'), '应以书头开始');
  assert.ok(r.text.includes('\n第一章 起\n\n第1章正文'), '章标题后应接正文');
  const i1 = r.text.indexOf('第1章正文');
  const i2 = r.text.indexOf('第2章正文');
  const i3 = r.text.indexOf('第3章正文');
  assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0, '三章正文都应存在');
  assert.ok(i1 < i2 && i2 < i3, '章节顺序必须正确');
});

test('整本导出：Cookie 会话可访问；非法 id 404；无正文书 404', async () => {
  const { id, cookie, store } = await seedBook(memStore());
  let r = await call(store, req(`/export/${id}.txt`, { cookie }));
  assert.equal(r.status, 200, 'Cookie 会话（浏览器场景）也应可下载');
  r = await call(store, req('/export/nope.txt', { headers: { authorization: basic('r', 'test-pass') } }));
  assert.equal(r.status, 404);
  const store2 = memStore();
  const cookie2 = await login(store2);
  let c = await call(store2, req('/api/books', { method: 'POST', cookie2, body: { title: '空书', chapters: ['x'] } }));
  r = await call(store2, req(`/export/${c.data.id}.txt`, { headers: { authorization: basic('r', 'test-pass') } }));
  assert.equal(r.status, 404, '无章节正文的书不可导出');
});
