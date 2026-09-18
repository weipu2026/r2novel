/* review-fix11.test.mjs — #133 前端组的可单测部分（服务端配套 + 纯逻辑）
 *
 * 覆盖：
 *   L6  离线队列的迟到进度不得回退更新的云端进度（在线路径行为不变）
 *   L17 书在离线期间被编辑（cleanVer 变）→ 旧章号的回放必须丢弃
 *   L15 残留清理的续调契约：预算裁剪（deferred）与「确认拒删」（skipped）分开；
 *       store.js 的 purgeOrphansAll 逐轮累加 skipped、轮次用尽如实回传 pending
 *   L14 标签上限来自 shared-const 单一来源，服务端按上限截断
 *   M6  store.js 的 logout 不得吞错（会话没清就不许谎报成功）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY } from '../src/router.js';
import { TAG_MAX } from '../public/js/shared-const.js';
import { memStore, req, call, login, readIdxBooks } from './_harness.mjs';

async function makeReadyBook(store, cookie, title, n) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', tags: [], chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  const id = r.data.id;
  for (let i = 0; i < n; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '第' + (i + 1) + '章正文' }));
  }
  await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('raw-' + title) }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return { id };
}

const getProg = async (store, cookie, id) => (await call(store, req(`/api/progress/${id}`, { cookie }))).data;

test('L6：离线队列的迟到进度不得回退更新的云端进度', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '迟到进度', 6);

  // 云端已有较新进度（第 5 章）
  let r = await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 5, ratio: 0.5 } }));
  assert.equal(r.status, 200);
  assert.equal((await getProg(store, cookie, id)).ch, 5);

  // 离线队列回放：带一个更旧的 updatedAt（离线期间排队的第 2 章）
  r = await call(
    store,
    req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0.1, updatedAt: Date.now() - 60000 } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.skipped, 'stale', '迟到写入必须被识别为陈旧');
  assert.equal((await getProg(store, cookie, id)).ch, 5, '更新的云端进度不得被迟到回放覆盖');

  // 队列里的值比云端新 → 正常落地（不是一律拒绝）
  r = await call(
    store,
    req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 6, ratio: 0.2, updatedAt: Date.now() + 60000 } })
  );
  assert.equal(r.data.skipped, undefined);
  assert.equal((await getProg(store, cookie, id)).ch, 6, '更新的回放应当落地');

  // 在线正常路径（不带 updatedAt/cleanVer）：无条件覆盖，行为与从前完全一致
  r = await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0 } }));
  assert.equal(r.data.skipped, undefined);
  assert.equal((await getProg(store, cookie, id)).ch, 1, '在线写入不受对账影响');
});

test('L17：书在离线期间被编辑过 → 旧章号的回放必须丢弃', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '版本失配', 5);

  // 入队那一刻的版本是 1；期间书被就地编辑 → cleanVer 变 2
  const before = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  let r = await call(
    store,
    req(`/api/books/${id}/chapters/2`, { method: 'PATCH', cookie, body: { title: '第二章 改过的题名' } })
  );
  assert.equal(r.status, 200);
  const after = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.equal(after.cleanVer, before.cleanVer + 1, '就地编辑必须 cleanVer+1');

  // 带旧 cleanVer 的回放 → 丢弃（章号已失去意义，写了就是"进度±1"）
  r = await call(
    store,
    req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.3, updatedAt: Date.now(), cleanVer: before.cleanVer } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.skipped, 'cleanVer');
  assert.equal((await getProg(store, cookie, id)).ch, 0, '版本失配的回放不得写坏进度');

  // 带当前版本的回放 → 正常落地
  r = await call(
    store,
    req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.3, updatedAt: Date.now(), cleanVer: after.cleanVer } })
  );
  assert.equal(r.data.skipped, undefined);
  assert.equal((await getProg(store, cookie, id)).ch, 3);
});

test('L15：残留清理回传 deferred —— 预算裁剪与「确认拒删」分开', async () => {
  const store = memStore();
  const cookie = await login(store);
  await makeReadyBook(store, cookie, '占位书', 1); // 让索引存在（端点会全量打开索引）

  const keys = [];
  for (let i = 0; i < 60; i++) {
    const k = `text/ghost${i}/1.txt`;
    await store.putText(k, 'x');
    keys.push(k);
  }

  let r = await call(store, req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: keys } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.deleted > 0, '应有实际删除');
  assert.ok(Array.isArray(r.data.deferred), 'deferred 必须是数组（前端据此续调）');
  assert.ok(r.data.deferred.length > 0, '60 个超出单请求预算 → 必有余项待续调');
  assert.equal(
    r.data.deleted + r.data.deferred.length + r.data.skipped,
    keys.length,
    '已删 + 待续 + 拒删 三类之和必须等于输入数（不漏不重）'
  );

  // 像前端那样循环消费 deferred，直到清空
  let pending = r.data.deferred;
  for (let i = 0; i < 10 && pending.length; i++) {
    const r2 = await call(store, req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: pending } }));
    pending = r2.data.deferred || [];
  }
  assert.equal(pending.length, 0, '续调必须能清空（否则残留永远删不完）');
});

test('L15：活书的伴生对象仍算「拒删」（skipped），不得进入 deferred', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '活书', 2);

  // 活书的 raw 与仍在章表内的正文：确认不该删 → skipped
  const r = await call(
    store,
    req('/api/diag/orphans', { method: 'DELETE', cookie, body: { objects: [`raw/${id}.txt`, `text/${id}/1.txt`] } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.deleted, 0, '活书伴生对象不得被删');
  assert.equal(r.data.skipped, 2);
  assert.deepEqual(r.data.deferred, [], '拒删不是预算问题，不得进 deferred（否则前端会无限重试）');
});

test('L14：标签上限来自 shared-const 单一来源，服务端按上限截断', async () => {
  assert.equal(TAG_MAX, 10);
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '标签上限', 2);

  const many = Array.from({ length: TAG_MAX + 4 }, (_, i) => 't' + i);
  const r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { tags: many } }));
  assert.equal(r.status, 200);
  const meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.equal(meta.tags.length, TAG_MAX, `服务端必须按 TAG_MAX(${TAG_MAX}) 截断`);

  // 批量改标签走同一常量（审计点名的就是这条路径）
  const r2 = await call(
    store,
    req('/api/books/batch', { method: 'POST', cookie, body: { ids: [id], action: 'setTags', tags: many } })
  );
  assert.equal(r2.status, 200);
  const meta2 = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.equal(meta2.tags.length, TAG_MAX, '批量路径同样按 TAG_MAX 截断');
});

test('M6：store.js 的 logout 不得吞错（会话没清就不许谎报成功）', async () => {
  const { api } = await import('../public/js/store.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  try {
    await assert.rejects(() => api.logout(), (e) => e instanceof TypeError && /network down/.test(e.message));
  } finally {
    globalThis.fetch = realFetch;
  }

  // 服务端 500 同样必须抛出（而不是被吞成 {ok:true}）
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => api.logout(), (e) => e.status === 500);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('L15：前端续调必须逐轮累加 skipped —— 被后一轮的 0 覆盖就丢了「仍在引用中」的真值', async () => {
  const { api } = await import('../public/js/store.js');
  const realFetch = globalThis.fetch;

  const keys = Array.from({ length: 100 }, (_, i) => `text/ghost${i}/1.txt`);
  // 第 1 轮：预算只够删 20，另有 60 个确认拒删（活书伴生 / 章表内正文），20 个被裁进 deferred。
  // 第 2 轮：传入的正是那 20 个（全部可删）→ deleted=20、skipped=0。
  // ⚠️ 关键判别点：累加写法得 skipped=60；写成 `skipped = r.skipped` 会被第 2 轮的 0 抹成 0。
  const round1 = { ok: true, deleted: 20, skipped: 60, deferred: keys.slice(80) };
  const round2 = { ok: true, deleted: 20, skipped: 0, deferred: [] };
  const seen = [];
  let n = 0;
  globalThis.fetch = async (path, opts) => {
    assert.equal(path, '/api/diag/orphans');
    assert.equal(opts.method, 'DELETE');
    seen.push(JSON.parse(opts.body).objects);
    const payload = n++ === 0 ? round1 : round2;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let res;
  try {
    res = await api.purgeOrphansAll(keys);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(n, 2, '两轮即可清空，不应多打请求');
  assert.deepEqual(seen[0], keys, '第 1 轮必须带全量候选');
  assert.deepEqual(seen[1], round1.deferred, '第 2 轮必须只带上一轮的 deferred（原样续调）');
  assert.equal(res.done, 40, '已删数应逐轮累加');
  assert.equal(res.skipped, 60, 'skipped 必须逐轮累加（写成 = 会得 0）');
  assert.deepEqual(res.pending, [], 'deferred 空 → 没有未处理项');
});

test('L15：轮次用尽仍在 deferred 的必须原样回传，不得谎报清空', async () => {
  const { api } = await import('../public/js/store.js');
  const realFetch = globalThis.fetch;

  const keys = ['text/a/1.txt', 'text/b/1.txt'];
  // 服务端每轮都只裁 1 个（模拟大库长尾）：永远删不完，pending 必须如实回传
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, deleted: 0, skipped: 0, deferred: keys.slice(1) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  let res;
  try {
    res = await api.purgeOrphansAll(keys, 3); // 只给 3 轮
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(res.pending, keys.slice(1), '轮次用尽时必须如实回传未处理项（前端据此提示"可再点一次"）');
});
