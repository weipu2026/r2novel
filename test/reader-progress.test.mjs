/* reader-progress.test.mjs — 阅读进度的 OCC 基线三态（#146 P2-4）
 *
 * 缺陷背景：服务端对「这本书还没有进度」回的是 EMPTY_PROG `{ch:0,ratio:0,updatedAt:0}`（一个**成功**的
 * 读），而不是 null。旧代码用 `if (!sp || !sp.updatedAt) return;` 把「读失败」与「确认没有进度」
 * 混成一类 → openBook 两次读失败置上的 progBase.failed 永远洗不掉 → drainProgress 的
 * `if (progBase.failed) return` 会把本设备对**整本书**的进度写全部丢弃：用户读完一本、退出、
 * 换设备打开，进度还停在原处，全程无任何提示。
 *
 * 判据落在纯函数 progBaseline 的三态上（行为级），外加调用点的接线断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './_dom-stub.mjs';

installDom(); // reader.js 顶层会读 localStorage（无守卫但 try/catch），需要最小 DOM 环境

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { progBaseline } = await import('../public/js/reader.js');

const EMPTY_PROG = { ch: 0, ratio: 0, updatedAt: 0 }; // src/router.js 的同名字面量

test('P2-4 progBaseline：读失败 → null（不动基线，failed 保持）', () => {
  assert.equal(progBaseline('b1', null), null);
  assert.equal(progBaseline('b1', undefined), null);
});

test('P2-4 progBaseline：EMPTY_PROG 是「已知的没有进度」，必须解除 failed', () => {
  const b = progBaseline('b1', EMPTY_PROG);
  assert.deepEqual(b, { id: 'b1', at: 0, known: true, failed: false });
  assert.equal(b.known, true, 'known:true 才能让 drainProgress 放行后续写入');
  assert.equal(b.failed, false, 'failed 必须清掉，否则整本书的进度写永远被丢弃');
});

test('P2-4 progBaseline：真值基线推进到服务端 updatedAt', () => {
  assert.deepEqual(progBaseline('b2', { ch: 3, ratio: 0.5, updatedAt: 1780000000000 }),
    { id: 'b2', at: 1780000000000, known: true, failed: false });
  // updatedAt 缺失但对象存在：按 0 处理（等价「没有进度」），仍是 known
  assert.deepEqual(progBaseline('b2', { ch: 1, ratio: 0 }), { id: 'b2', at: 0, known: true, failed: false });
});

test('P2-4 syncFromServer 必须用三态判据，不得把 updatedAt===0 当成「不用对账」', () => {
  const src = read('public/js/reader.js');
  const i = src.indexOf('async function syncFromServer(');
  assert.ok(i > 0, '找不到 syncFromServer');
  const j = src.indexOf('\n/* 进度：state.cur', i);
  const body = src.slice(i, j > 0 ? j : i + 3000);
  assert.doesNotMatch(body, /if \(!sp \|\| !sp\.updatedAt\) return;/, '旧写法把「读失败」与「没有进度」混为一类');
  assert.match(body, /const nb = progBaseline\(book\.id, sp\);/, '必须走三态判据');
  assert.match(body, /if \(!nb\) return;/, '读失败才 return');
  assert.match(body, /if \(!nb\.at\) return;/, 'EMPTY_PROG：基线归零后没有位置可同步，避免用 ch:0 去跳章');
  // 基线「只推进不回灌」仍要保住：已知基线且服务端更旧 → 不动
  assert.match(body, /progBase\.known && nb\.at <= progBase\.at/, '基线不得回灌');
});

test('P2-4 openBook 的初始基线复用同一份语义（读失败 → known:false + failed:true）', () => {
  const src = read('public/js/reader.js');
  assert.match(src, /progBase = sp \? progBaseline\(id, sp\) : \{ id, at: 0, known: false, failed: true \};/,
    'openBook 必须复用 progBaseline，否则两处语义会漂移');
});
