/* audit.test.mjs — 全站审计回归测试（路径注入 / sweep 续清 / 进度语义 / 发布镜像） */
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
  const sc = r.headers.get('set-cookie') || '';
  const m = /rn_session=([^;]+)/.exec(sc);
  assert.ok(m, '应下发 rn_session cookie');
  return 'rn_session=' + m[1];
}

/** 建一本 ready 书（N 章 + 发布） */
async function makeBook(store, cookie, title, n, chapters) {
  const chs = chapters || Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', chapters: chs, wordCount: n * 10, cleanVer: 1 } }));
  assert.equal(r.status, 200);
  const id = r.data.id;
  for (let i = 0; i < chs.length; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '正文' + (i + 1) }));
  }
  await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('raw-' + title) }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return { id, title };
}

test('审计：路径注入 —— 含 .. / 非法字符的 id 与 key 一律 404', async () => {
  const store = memStore();
  const cookie = await login(store);
  const evil = [
    ['PUT', '/api/books/..%2F..%2Fetc/chapters/1'],
    ['GET', '/api/books/..%2Fsecret/chapters/1'],
    ['GET', '/api/books/..%2Fsecret'],
    ['GET', '/api/books/a%2Fb'],
    ['GET', '/api/progress/..%2F..%2Findex'],
    ['DELETE', '/api/trash/..%2F..%2Fmeta'],
    ['GET', '/api/books/ok-id/raw/../x'],
    ['POST', '/api/books/..%2F..%2Fmeta/restore'],
  ];
  for (const [method, p] of evil) {
    // decodeURIComponent 后 URL.pathname 仍是字面 ..；正则 [^/]+ 会被 '/' 隔断
    // 这里模拟真实恶意请求（未编码的 .. 路径段）
    const r = await call(store, req(p, { method, cookie }));
    assert.equal(r.status, 404, `${method} ${p} 应为 404，实际 ${r.status}`);
  }
  // URL 编码的 %2E%2E 也不能进入存储 key
  const enc = await call(store, req('/api/books/%2e%2e%2fsecret', { cookie }));
  assert.equal(enc.status, 404);
  // 未登录也不能探测
  const anon = await call(store, req('/api/books/..%2Fsecret'));
  assert.equal(anon.status, 401, '未登录应先 401');
});

test('审计：sweep —— 已进入 purge 分段的过期书会被继续清理直至清空', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeBook(store, cookie, '多章书', 45);
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie })); // 软删

  // 手动删一批制造 purge 中段（45 章 > 40 上限）
  let r = await call(store, req(`/api/trash/${id}`, { method: 'DELETE', cookie }));
  assert.equal(r.data.done, false, '首删 40 章未完');
  assert.equal(r.data.remaining, 5);

  // 把这本书的 deletedAt 改到 16 天前（过期）
  const trash = JSON.parse(store._map.get('meta/trash.json'));
  trash.books[0].deletedAt = Date.now() - 16 * 86400000;
  store._map.set('meta/trash.json', JSON.stringify(trash));

  // 书架 GET 触发 sweep：purge 中的过期书也继续删
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200);
  assert.ok(!store._map.has(`text/${id}/41.txt`), 'sweep 应继续删除 purge 中剩余的章');
  assert.ok(!store._map.has(`meta/${id}.json`), '清完后 meta 应被删除');
  assert.ok(!store._map.has('meta/trash.json') || JSON.parse(store._map.get('meta/trash.json')).books.length === 0, 'trash 应已移除该书');
});

test('审计：replace 重洗 —— 进度越界旧值不覆盖；同名迁移保持 ratio', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeBook(store, cookie, '迁移书', 3, ['第A章', '第B章', '第C章']);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0.4 } })); // 在第 2 章

  // 新表：第A章 保住了、B/C 被改
  let r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['第A章', '全新章X', '全新章Y'] } }));
  assert.equal(r.status, 200);
  for (let i = 0; i < 3; i++) await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '新' + i }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  r = await call(store, req(`/api/progress/${id}`, { cookie }));
  assert.equal(r.data.ch, 1, '旧进度在第 2 章（第B章），新表无同名 → 应回首章');

  // 再重洗：把进度迁到有同名标题的位置
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0.7 } })); // 第 1 章 = 第A章
  r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['序章', '第A章', '尾章'] } }));
  for (let i = 0; i < 3; i++) await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: 'x' + i }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  r = await call(store, req(`/api/progress/${id}`, { cookie }));
  assert.equal(r.data.ch, 2, '第A章 同名迁移到新表第 2 章');
  assert.ok(Math.abs(r.data.ratio - 0.7) < 1e-6, 'ratio 应保留');
});

test('审计：publish 后书架镜像以 progress 文件实时值为准', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeBook(store, cookie, '镜像书', 3);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0.3 } }));
  // 重洗（replace 重排章节）后 publish
  await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['甲', '乙', '丙'] } }));
  for (let i = 0; i < 3; i++) await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: 't' + i }));
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  const r = await call(store, req('/api/books', { cookie }));
  const b = r.data.books.find((x) => x.id === id);
  assert.ok(b && b.prog, '书架应有进度镜像');
  assert.equal(b.prog.ch, 1, '重洗后进度重置为第 1 章，镜像应同步而非保留旧值 2');
});

test('审计：append 追章 —— 全书字数 = 旧字数 + 新增字数（而非被覆盖）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeBook(store, cookie, '追章书', 3); // wordCount = 30
  // 追加 2 章，客户端只上报新增部分字数 20
  let r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['第4章', '第5章'], wordCount: 20 } }));
  assert.equal(r.status, 200);
  for (const k of ['4', '5']) await call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PUT', cookie, body: '追加正文' + k }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.wordCount, 50, '追章后应为 30 + 20 = 50，而非 20');
  const shelf = await call(store, req('/api/books', { cookie }));
  const b = shelf.data.books.find((x) => x.id === id);
  assert.equal(b.wordCount, 50, '书架镜像应一致');
});

test('审计：replace 章节数变少 —— 孤儿正文先清一批、publish 清完、meta 不残留', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeBook(store, cookie, '缩水书', 45); // 原 45 章（key 1..45）
  let r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['新的一章'] } }));
  assert.equal(r.status, 200);
  // updateChapters 当场清一批（40 个）：key 2..41 应被删，42..45 留待惰性
  for (const k of [2, 41]) assert.ok(!store._map.has(`text/${id}/${k}.txt`), `孤儿章 ${k} 应在首批被删`);
  for (const k of [42, 45]) assert.ok(store._map.has(`text/${id}/${k}.txt`), `孤儿章 ${k} 应留待下一批`);
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '新正文' }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  // publish 清剩余一批：42..45 全没了
  for (const k of [42, 43, 44, 45]) assert.ok(!store._map.has(`text/${id}/${k}.txt`), `孤儿章 ${k} 应在 publish 时清掉`);
  const meta = JSON.parse(store._map.get(`meta/${id}.json`));
  assert.ok(!('orphans' in meta), 'meta 不应残留 orphans 字段');
  r = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(r.status, 200);
  assert.ok(!('orphans' in r.data), 'bookMeta 响应不应暴露 orphans');
});

test('审计：进度镜像 —— 书不在架不写 index；位置无变化跳过全量重写', async () => {
  const writes = { index: 0 };
  const raw = memStore();
  const store = {
    ...raw,
    async putText(k, s) {
      if (k === 'meta/index.json') writes.index++;
      return raw.putText(k, s);
    },
  };
  const cookie = await login(store);
  const { id } = await makeBook(store, cookie, '进度降频书', 3);
  writes.index = 0; // 建书阶段的写不计
  // 首次上报：书在架且无镜像 → 应写 1 次 index
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0.5 } }));
  assert.equal(writes.index, 1, '首次上报应写一次 index');
  // 同位置重复上报（阅读中 8s 节流的重复值）→ 跳过
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0.5 } }));
  assert.equal(writes.index, 1, '位置无变化不应重写 index');
  // 换章 → 写
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0 } }));
  assert.equal(writes.index, 2, '换章应更新镜像');
  // 不在架的书（未发布的新 id）→ 不写 index
  await call(store, req('/api/progress/n_ghostbook', { method: 'PUT', cookie, body: { ch: 1, ratio: 0.1 } }));
  assert.equal(writes.index, 2, '书不在书架不应重写 index');
});

test('安全：防爆破（连错锁定 / 锁定期正确口令也 429 / 状态持久化 / 指数退避 / 成功登录清零）', async () => {
  const store = memStore();
  const env = { ...ENV, BRUTE_LIMIT: '3', BRUTE_LOCK_MS: '30000', BRUTE_LOCK_MAX_MS: '600000' };
  const call2 = async (r) => {
    const res = await handleRequest(r, env, store);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };
  const bad = () => req('/api/login', { method: 'POST', body: { password: 'wrong' } });

  // 连错 3 次 → 第 4 次被锁
  for (let i = 0; i < 3; i++) {
    const r = await call2(bad());
    assert.equal(r.status, 401, '第 ' + (i + 1) + ' 次错口令应 401');
  }
  let r = await call2(bad());
  assert.equal(r.status, 429, '达到上限后应 429');
  assert.ok(r.data.error.includes('分钟'), '429 应带等待时间提示');
  assert.ok(r.headers.get('Retry-After'), '429 应带 Retry-After');

  // 锁定期内即使口令正确也拒绝（防绕过限速试探）
  r = await call2(req('/api/login', { method: 'POST', body: { password: ENV.ADMIN_PASSWORD } }));
  assert.equal(r.status, 429, '锁定期内正确口令也应 429');

  // 状态持久化到 store（跨重启/机房有效），且 IP 已哈希不落明文
  const raw = store._map.get('meta/sec/brute.json');
  assert.ok(raw, '锁定状态应持久化到 meta/sec/brute.json');
  assert.ok(!raw.includes('127.0.0.1') && !raw.includes('unknown'), '不应存明文 IP');

  // 模拟第一轮锁过期 → 再连错 3 次 → strikes=2，锁定时长翻倍（30s×2=60s）
  const bf = JSON.parse(raw);
  const h = Object.keys(bf.ips)[0];
  bf.ips[h].until = Date.now() - 1;
  store._map.set('meta/sec/brute.json', JSON.stringify(bf));
  for (let i = 0; i < 3; i++) await call2(bad());
  const bf2 = JSON.parse(store._map.get('meta/sec/brute.json'));
  assert.equal(bf2.ips[h].strikes, 2, '第二次锁定 strikes 应为 2');
  assert.ok(bf2.ips[h].until - Date.now() > 45000, '锁定时长应指数翻倍（约 60s）');

  // 成功登录清零：新库失败 2 次（未达上限）→ 正确登录 → 失败记录应被清掉
  const store2 = memStore();
  const call3 = async (r) => (await handleRequest(r, env, store2)).status;
  await call3(bad());
  await call3(bad());
  assert.equal(await call3(req('/api/login', { method: 'POST', body: { password: ENV.ADMIN_PASSWORD } })), 200);
  const bf3 = JSON.parse(store2._map.get('meta/sec/brute.json') || '{"ips":{}}');
  assert.equal(Object.keys(bf3.ips).length, 0, '成功登录应清掉失败记录');
});
