/* review-fix138.test.mjs — 2026-09-19 第三方审计（桌面/审计报告.md）「P1+P2 共 9 处」修复的单测
 *
 * 每条用例都是「改回旧写法必然不通过」的判据：
 *   P1-1 进度 OCC：带 baseAt（＝本设备上次从服务端读到的 updatedAt）的旧认知写入不得覆盖更新的
 *        盘上进度；被拒时把真值回传给客户端对账；不带 baseAt 仍是无条件覆盖（老客户端/探针兼容）；
 *        被拒不得污染书架进度镜像（否则角标会跟着回退）。
 *   P2-8 meta PATCH 走 CAS：并发方在窗口内写下的字段不被整份覆盖吃掉，本次 patch 也照样落地。
 *   P2-7 批量队列把单批失败的错误交出来 —— 调用方才能把「会话过期（401）」与「半成品书」分开。
 *   P2-9 离线导出：服务端不可用时用本地整本缓存拼正文；没给缓存就如实抛错（不静默出空本）。
 * 另见 read-done.test.mjs：P1-2 的 readDone:null 清除出口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore, req, call, login, readIdxBooks, makeReadyBook } from './_harness.mjs';
import { fetchChaptersAll } from '../public/js/store.js';
import { runBatched } from '../public/js/batch-queue.js';

const getProg = async (store, cookie, id) => (await call(store, req(`/api/progress/${id}`, { cookie }))).data;
const putProg = (store, cookie, id, body) => call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body }));
const progOf = async (store, id) => {
  const books = await readIdxBooks(store);
  const b = (books || []).find((x) => x.id === id);
  return b ? b.prog : null;
};

test('P1-1 OCC：拿旧认知（过期 baseAt）写入 → 拒写 + 回传真值，不覆盖另一台设备的新进度', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OCC进度', 6);

  // ① 基线 0（服务端本来没有进度）→ 正常写入，且必须回传本次 updatedAt（客户端据此推进基线）
  let r = await putProg(store, cookie, id, { ch: 5, ratio: 0.5, baseAt: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.data.skipped, undefined, '基线为 0 且盘上无进度时应正常写入');
  assert.ok(Number(r.data.updatedAt) > 0, '成功写入必须回传 updatedAt，否则客户端下一次写入会被自己刚写的版本拒掉');
  const v1 = Number(r.data.updatedAt);

  // ② 后台久置的旧标签页醒来，拿着过期基线写旧位置（第 2 章）→ 必须拒写
  r = await putProg(store, cookie, id, { ch: 2, ratio: 0.1, baseAt: 0 });
  assert.equal(r.data.skipped, 'occ', '拿旧认知来写必须被识别为过期');
  assert.equal(r.data.prog.ch, 5, '拒写响应要带回盘上真值，供客户端立即对账');
  assert.equal((await getProg(store, cookie, id)).ch, 5, '另一台设备的新进度不得被旧标签页覆盖');

  // ③ 客户端对账后（基线跟上）再写 → 落地（拒写不是「这台设备从此不能写」）
  r = await putProg(store, cookie, id, { ch: 3, ratio: 0.3, baseAt: v1 });
  assert.equal(r.data.skipped, undefined);
  assert.equal((await getProg(store, cookie, id)).ch, 3, '对账后的写入必须能落地');
});

test('P1-1 OCC：被拒的写入不得污染书架进度镜像（否则角标跟着回退）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OCC镜像', 6);

  await putProg(store, cookie, id, { ch: 5, ratio: 0.5, baseAt: 0 });
  assert.equal((await progOf(store, id)).ch, 5);

  const r = await putProg(store, cookie, id, { ch: 2, ratio: 0.1, baseAt: 0 });
  assert.equal(r.data.skipped, 'occ');
  const p = await progOf(store, id);
  assert.equal(p.ch, 5, '被拒的写入必须早于镜像写就返回 —— 镜像回退会让书架角标与真值不一致');
  assert.equal(p.ratio, 0.5);
});

test('P1-1 OCC：不带 baseAt 仍是无条件覆盖（老客户端 / 外部探针向后兼容）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OCC兼容', 6);

  await putProg(store, cookie, id, { ch: 5, ratio: 0.5 });
  const r = await putProg(store, cookie, id, { ch: 1, ratio: 0 });
  assert.equal(r.data.skipped, undefined, '三个字段一个都不带 → 行为与从前完全一致');
  assert.equal((await getProg(store, cookie, id)).ch, 1);
});

test('P1-1 OCC：离线队列的两条判据不受影响（stale / cleanVer 语义保持）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OCC离线', 6);

  await putProg(store, cookie, id, { ch: 5, ratio: 0.5 });
  // 迟到回放：带更旧的客户端时间 → 仍报 stale（且此时 baseAt 不存在，走的是老路径）
  let r = await putProg(store, cookie, id, { ch: 2, ratio: 0.1, updatedAt: Date.now() - 60000 });
  assert.equal(r.data.skipped, 'stale');
  assert.equal((await getProg(store, cookie, id)).ch, 5);
  // 内容版本失配 → 仍报 cleanVer
  r = await putProg(store, cookie, id, { ch: 6, ratio: 0.1, cleanVer: 99 });
  assert.equal(r.data.skipped, 'cleanVer');
});

test('P2-8 meta PATCH 走 CAS：并发方在窗口内写的字段不被吃掉，本次 patch 也落地', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '并发meta', 2);
  const key = `meta/${id}.json`;

  const origIf = store.putTextIf.bind(store);
  const origPut = store.putText.bind(store);
  let casCalls = 0;
  let raced = false;
  store.putTextIf = async (k, s, etag) => {
    if (k !== key) return origIf(k, s, etag);
    casCalls++;
    if (!raced) {
      // 第一次写：先让「并发方」的整份写落盘（模拟并发的 GET 目录写回孤儿清理），
      // 本次 CAS 必然失败 → 实现必须重读重放，而不是把并发方的改动整份盖掉
      raced = true;
      const cur = JSON.parse(await store.getText(k));
      await origPut(k, JSON.stringify({ ...cur, note: '并发方写的备注' }));
      return null;
    }
    return origIf(k, s, etag);
  };

  const r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: true } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(casCalls >= 2, `meta 写回必须带版本号（CAS）并在冲突后重放，实测 putTextIf 调用 ${casCalls} 次`);
  const meta = JSON.parse(await store.getText(key));
  assert.equal(meta.note, '并发方写的备注', '并发方在窗口内写的字段不得被整份覆盖');
  assert.equal(meta.star, true, '本次 patch 也必须落地（重读重放）');
});

test('P2-7 批量队列：单批错误必须交出来分类，失败语义不变', async () => {
  const seen = [];
  const err = new Error('HTTP 401');
  err.status = 401;
  const r = await runBatched(['a', 'b'], 18, async () => { throw err; }, null, (e) => seen.push(e));
  assert.equal(seen.length, 1, '单批失败要回调一次原始错误');
  assert.equal(seen[0].status, 401, '调用方据此把 401 与「半成品书」分开');
  assert.deepEqual(r, { ok: 0, fail: 2 }, '失败语义不变：整批计入 fail');
  // 不传 onError → 与从前完全一致（向后兼容）
  assert.deepEqual(await runBatched(['a'], 18, async () => { throw err; }), { ok: 0, fail: 1 });
});

test('P2-9 离线导出：服务端不可用时用本地整本缓存拼出正文（IndexedDB 兜底层真的被用上）', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    const meta = { id: 'bk1', title: '离线书', cleanVer: 3, chapters: [{ key: '1', title: '第1章' }, { key: '2', title: '第2章' }] };
    const cache = new Map([['1', '第一章正文']]); // 只缓存了一章，第 2 章缺失
    const { meta: got, texts, missing } = await fetchChaptersAll('bk1', null, {
      book: async () => meta,
      chapter: async (k) => (cache.has(k) ? cache.get(k) : null),
    });
    assert.equal(got.title, '离线书');
    assert.equal(got.id, 'bk1', '离线记录只存 bookId，必须补回 id 供后续取章');
    assert.deepEqual(texts, ['第一章正文', ''], '有缓存的章用缓存，无缓存的章如实留空');
    assert.equal(missing, 1, '缺章要计数（调用方据此提示），不能假装整本都拿到了');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('P2-9 离线导出：没有离线源时，服务端不可用必须如实抛错（不静默导出空本）', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(() => fetchChaptersAll('bk1', null), /fetch failed/, '没有兜底数据源时不得静默出空本');
  } finally {
    globalThis.fetch = origFetch;
  }
});
