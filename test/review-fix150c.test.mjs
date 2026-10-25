/* review-fix150c.test.mjs — #150 批次3 里可以纯逻辑单测的部分：批量队列「401 立刻收手」。
 * 其余（视图令牌 / 面板复位 / clamp / 操作单锚点 / 选择三入口）是 DOM 行为，见
 * .ui-tests/ui-150c.mjs（真机 21 项）。这里只钉队列语义，判据落在「我发了几次请求」上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatched } from '../public/js/batch-queue.js';

const mkIds = (n) => Array.from({ length: n }, (_, i) => 'b' + i);
const err401 = () => Object.assign(new Error('unauthorized'), { status: 401 });

test('P2-11 onError 返回 true：立刻收手，后续批次一个都不发', async () => {
  const sent = [];
  const ids = mkIds(60);
  const r = await runBatched(ids, 18, async (batch) => {
    sent.push(batch.length);
    throw err401();
  }, null, (e) => (e.status === 401 ? true : false));
  // 旧实现：60 本 / 18 → 4 批全发（1500 本 = 84 个必 401 的请求，遮罩跑到 100% 才跳登录页）
  assert.equal(sent.length, 1, '只该发第一批，实测 ' + sent.length);
  assert.equal(r.aborted, true, '必须告诉调用方这是「中止」而不是「全失败」');
  assert.equal(r.ok, 0);
  assert.equal(r.fail, 60, '没处理的本数照实计入 fail（调用方据此不报「已更新」）');
});

test('P2-11 收手只认严格 true：回调返回数组长度（真值）不得中断队列', async () => {
  const sent = [];
  const ids = mkIds(60);
  const seen = [];
  const r = await runBatched(ids, 18, async (batch) => {
    sent.push(batch.length);
    throw new Error('boom');
  }, null, (e) => seen.push(e)); // push 返回数组长度：真值但不是 true
  assert.equal(sent.length, 4, '60 本 / 18 = 4 批都要发出去，实测 ' + sent.length);
  assert.equal(r.aborted, undefined, '不得误判成「调用方要求收手」');
  assert.equal(r.fail, 60);
  assert.equal(seen.length, 4, '每批失败都要回调一次（分类语义不变）');
});

test('P2-11 中途收手：已成功的本数必须保留，不得清零', async () => {
  let n = 0;
  const ids = mkIds(40);
  const r = await runBatched(ids, 10, async (batch) => {
    n++;
    if (n === 2) throw err401();
    return { updated: batch.length };
  }, null, (e) => e.status === 401);
  assert.equal(r.ok, 10, '第一批 10 本已落库，收手不影响它们');
  assert.equal(r.fail, 30, 'fail = 总数 - ok');
  assert.equal(r.aborted, true);
});
