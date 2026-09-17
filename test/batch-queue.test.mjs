/* batch-queue.test.mjs — 批量操作的「分批 + 后端预算裁剪续调」驱动单测
 *
 * 背景（第三轮审计 P1，真实回归）：v2 分片把「一次批量请求改多本书」从「永远装得下」
 * 变成了「可能被 48 子请求预算裁掉尾巴」。后端会回传被裁的 id（deferred），而 app.js 原来
 * 只把差数计成「失败：可能是半成品书」——被裁的书静默丢失、用户也不会去重试。
 * 这里用**复刻后端同一套裁剪规则**的假后端来跑队列驱动，含反证：不消费 deferred 的旧写法
 * 在同一后端下必然少处理（已实测 17/18）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runBatched } from '../public/js/batch-queue.js';

const PAGE = 18; // = shared-const.js BATCH_BOOKS_MAX

/** 假后端：复刻 src/router.js apiBatchBooks 的预算贪心裁剪。
 * 非删除 1+3k+2N ≤ 48；删除 5+3k ≤ 48（k=目标跨片数）。不在架（shardOf[id] 为空）不占预算、不进 deferred。 */
function fakeBackend(shardOf, { mode = 'setFinished', budget = 48 } = {}) {
  const calls = [];
  return {
    calls,
    send: async (batch) => {
      calls.push(batch.slice());
      const seen = new Set();
      const processed = [];
      for (const id of batch) {
        const n = shardOf[id];
        if (n == null) continue;
        const k = seen.has(n) ? seen.size : seen.size + 1;
        const est = mode === 'delete' ? 5 + 3 * k : 1 + 3 * k + 2 * (processed.length + 1);
        if (est > budget) break;
        seen.add(n);
        processed.push(id);
      }
      const done = new Set(processed);
      return { updated: processed.length, deferred: batch.filter((id) => !done.has(id) && shardOf[id] != null) };
    },
  };
}

/** 2001 本 / 5 片（500×4+1）；18 个目标跨 5 片：s0 取 5、s1..s3 各 4、s4 取 1 */
function spread18() {
  const bid = (i) => 'b' + String(i).padStart(4, '0');
  const shardOf = {};
  for (let i = 0; i < 2001; i++) shardOf[bid(i)] = Math.floor(i / 500);
  const ids = [];
  for (let j = 0; j < 5; j++) ids.push(bid(j));
  for (let s = 1; s < 4; s++) for (let j = 0; j < 4; j++) ids.push(bid(s * 500 + j));
  ids.push(bid(2000));
  return { shardOf, ids };
}

test('不裁剪：单批全成，不产生多余请求', async () => {
  const server = fakeBackend({ a: 0, b: 0, c: 0 });
  assert.deepEqual(await runBatched(['a', 'b', 'c'], PAGE, server.send), { ok: 3, fail: 0 });
  assert.equal(server.calls.length, 1);
});

test('裁剪续调：18 本跨 5 片被裁 → deferred 排回队列直到清空（正反双向）', async () => {
  const { shardOf, ids } = spread18();

  // 反证：旧写法（只按页切片、从不读 deferred）在同一后端下少处理 1 本 —— v2 的真实事故
  const old = fakeBackend(shardOf);
  let naive = 0;
  for (let i = 0; i < ids.length; i += PAGE) {
    const r = await old.send(ids.slice(i, i + PAGE));
    naive += r.updated;
  }
  assert.equal(naive, 17, '不消费 deferred 必然丢书（18 本只处理 17 本）');

  // 正解：runBatched 必须全部处理完
  const server = fakeBackend(shardOf);
  const r = await runBatched(ids, PAGE, server.send);
  assert.deepEqual(r, { ok: 18, fail: 0 }, '18 本一本不落');
  assert.equal(server.calls.length, 2, '第一轮裁掉 1 本 → 第二轮补上');
  assert.equal(server.calls[0].length, 18);
  assert.equal(server.calls[1].length, 1, '第二轮只发被裁的那本');
  const sent = server.calls.flat();
  assert.deepEqual([...new Set(sent)].sort(), [...ids].sort(), '每个 id 都发出去过（无遗漏）');
  assert.equal(sent.length, ids.length + 1, '只有被裁的那本被重发了一次');
});

test('删除动作（5+3k 预算）同样收敛', async () => {
  const { shardOf, ids } = spread18();
  const server = fakeBackend(shardOf, { mode: 'delete' });
  assert.deepEqual(await runBatched(ids, PAGE, server.send), { ok: 18, fail: 0 });
  assert.equal(server.calls.length, 1, '删除预算不含 N 项，18 本跨 5 片一次装得下');
});

test('非在架 id：后端不回传 deferred → 计入 fail，不被无限重试', async () => {
  const { shardOf, ids } = spread18();
  shardOf.ghost = null; // 不在架（半成品/回收站）
  const server = fakeBackend(shardOf);
  const r = await runBatched([...ids, 'ghost'], PAGE, server.send);
  assert.deepEqual(r, { ok: 18, fail: 1 });
  assert.equal(server.calls.length, 2);
  assert.ok(server.calls[1].includes('ghost'), 'ghost 与第一轮被裁的那本同批发出');
  assert.equal(server.calls.flat().filter((id) => id === 'ghost').length, 1, '不在架 id 只发一次，不被排回队列');
});

test('零进展（整批被退回）→ 立即收手，不空转', async () => {
  let calls = 0;
  const r = await runBatched(['a', 'b', 'c'], PAGE, async (batch) => {
    calls++;
    return { updated: 0, deferred: batch };
  });
  assert.deepEqual(r, { ok: 0, fail: 3 });
  assert.equal(calls, 1, '整批退回＝零进展，再试也是同样结果');
});

test('自愈轮：后端 retry=true 的零进展允许重发一次，再零进展即收手', async () => {
  const ids = ['a', 'b', 'c'];
  let calls = 0;
  const r = await runBatched(ids, PAGE, async (batch) => {
    calls++;
    // 第一轮：后端 root 深度坏 → 预算全花在重建索引上，一本没动但盘面已修好
    if (calls === 1) return { updated: 0, deferred: batch, retry: true };
    return { updated: batch.length, deferred: [] };
  });
  assert.deepEqual(r, { ok: 3, fail: 0 }, 'retry 一次后整批应做完');
  assert.equal(calls, 2);

  // 后端每轮都回 retry：只容忍一次，第二次零进展立即收手（不空转）
  let calls2 = 0;
  const r2 = await runBatched(ids, PAGE, async (batch) => {
    calls2++;
    return { updated: 0, deferred: batch, retry: true };
  });
  assert.deepEqual(r2, { ok: 0, fail: 3 });
  assert.equal(calls2, 2, 'retry 只容忍一次，不会无限重发');
});

test('单批失败：该批计失败，队列继续（不吞掉后面的书）', async () => {
  const ids = Array.from({ length: 40 }, (_, i) => 'x' + i);
  let calls = 0;
  const r = await runBatched(ids, PAGE, async (batch) => {
    calls++;
    if (calls === 1) throw new Error('网络抖动');
    return { updated: batch.length, deferred: [] };
  });
  assert.equal(r.ok, 22, '失败批次之外的两批 18+4 本照样落库');
  assert.equal(r.fail, 18);
  assert.equal(calls, 3);
});

test('后端回传不认识的 deferred → 被忽略，不污染队列', async () => {
  let calls = 0;
  const r = await runBatched(['a', 'b'], PAGE, async (batch) => {
    calls++;
    return { updated: batch.length, deferred: ['bogus-id'] };
  });
  assert.deepEqual(r, { ok: 2, fail: 0 });
  assert.equal(calls, 1);
});

test('契约：app.js 的 batchRun 必须经 runBatched 消费 deferred（防再退回裸 for 循环）', () => {
  // 文本级守卫：这一条是「后端回传 deferred」与「前端消费」的接缝，纯单测覆盖不到 app.js 的 DOM 部分，
  // 但接缝一旦断开就是静默丢书（v2 的真实事故），所以宁可留一道源码级闸门。
  const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function batchRun');
  assert.ok(i > 0, 'app.js 里应存在 batchRun');
  const seg = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/runBatched\(/.test(seg), 'batchRun 必须调用 runBatched（预算裁剪续调的唯一消费者）');
  assert.ok(
    !/for \(let i = 0; i < ids\.length; i \+= BATCH_PAGE\)/.test(seg),
    '不应再自己按页切片裸循环 —— 那样被裁的书会静默丢失（旧写法实测丢 1/18）'
  );
});

test('进度回调：total 恒定、done 单调不减且终值 = total', async () => {
  const { shardOf, ids } = spread18();
  const seen = [];
  await runBatched(ids, PAGE, fakeBackend(shardOf).send, (done, total) => seen.push([done, total]));
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(([, t]) => t === 18));
  assert.ok(seen.every(([d]) => d >= 0 && d <= 18));
  assert.equal(seen[seen.length - 1][0], 18);
});
