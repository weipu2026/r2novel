/* cleaner-offload.test.mjs — 清洗 Worker 分流的关键不变量（#149 P1-B）
 *
 * Node 里没有 Worker，所以这里测的是：
 *   ① 阈值判定（小文件不折腾 Worker，大文件必须走）
 *   ② **回退路径与同步路径结果完全一致** —— 这条是防漂移的核心：
 *      两条路径跑的是同一份 cleaner.js，但入口不同（一个直接调、一个经 postMessage），
 *      一旦哪天有人给 Worker 单独加参数、或忘了透传 opts，结果就会悄悄分叉。
 *      浏览器里 Worker 那条路走的是同一份 processBook，所以这里的等价性也覆盖了它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { processBook } from '../public/js/cleaner.js';
import { needsWorker, processBookOff, OFFLOAD_BYTES } from '../public/js/cleaner-client.js';

const SAMPLE = '第1章 起风\n\n他站在城墙下，看着远处的烽火。\n\n第2章 落雨\n\n风从北面吹过来，带着沙土的味道。\n';

test('needsWorker：阈值判定（1.5 MB 以下同步更快，以上必须进 Worker）', () => {
  assert.equal(OFFLOAD_BYTES, 1.5 * 1024 * 1024, '阈值单点');
  assert.equal(needsWorker(null), false, '空值不该判成需要 Worker');
  assert.equal(needsWorker(new Uint8Array(0)), false);
  assert.equal(needsWorker(new Uint8Array(OFFLOAD_BYTES - 1)), false, '阈值之下走同步');
  assert.equal(needsWorker(new Uint8Array(OFFLOAD_BYTES)), true, '达到阈值即走 Worker（>= 而非 >）');
});

test('processBookOff：无 Worker 环境回退同步，结果与 processBook 逐字段一致', async () => {
  const bytes = new TextEncoder().encode(SAMPLE);
  const opts = { fallbackTitle: '测试书' };
  const sync = processBook(bytes, opts);
  const off = await processBookOff(bytes, opts);
  assert.deepEqual(off, sync, '回退路径必须与同步路径完全等价（章节内容/编码/字数/候选全比）');
  assert.equal(off.chapters.length, 2, '样本应切成 2 章');
});

test('processBookOff：opts 必须真的透传（forceEncoding / pattern 不被吞）', async () => {
  const bytes = new TextEncoder().encode(SAMPLE);
  const byNone = await processBookOff(bytes, { fallbackTitle: '测试书', pattern: 'none' });
  assert.equal(byNone.chapters.length, 1, 'pattern=none 应整本一章');
  const syncNone = processBook(bytes, { fallbackTitle: '测试书', pattern: 'none' });
  assert.deepEqual(byNone, syncNone);
});
