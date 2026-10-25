/* review-fix150d.test.mjs — #150 批次4：上传中断后的「恢复到可读态」（P1-3）+ 清洗缓存释放接线（P2-8）
 *
 * P1-3 的判据落在**用户能不能把书读回来**上：中途失败后读书不再 409、章表与字数退回原样
 * （append 是真回滚）/ 保持新表（replace 的正文覆盖不可逆，只能恢复可读性）。
 * P2-7 的 Worker 看门狗是浏览器行为，见 .ui-tests/ui-150d.mjs；这里只钉「接线」（谁调谁）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEY } from '../src/core/const.js';
import { memStore, req, call, login, makeReadyBook } from './_harness.mjs';

const read = (p) => readFileSync(p, 'utf8');
const mj = async (store, id) => JSON.parse(await store.getText(KEY.book(id)));

test('P1-3 append 中断：回滚后可读，章表与字数退回原样（真回滚）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '追加中断书', 3);
  const before = await mj(store, id);

  // 客户端把追加提交上去（章表 + status 一起变 creating），随后正文 bulk 失败
  const up = await call(store, req(`/api/books/${id}/chapters`, {
    method: 'POST', cookie,
    body: { op: 'append', chapters: ['新章一', '新章二'], wordCount: 500, batch: 'aabbccdd11223344' },
  }));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const mid = await mj(store, id);
  assert.equal(mid.chapters.length, 5, '追加已写进章表');
  assert.equal(mid.status, 'creating');
  const readMid = await call(store, req(`/api/books/${id}/chapters/1`, { cookie }));
  assert.equal(readMid.status, 409, '这就是「卡住」的表现：正文还在，却读不了');

  const rb = await call(store, req(`/api/books/${id}/rollback`, {
    method: 'POST', cookie,
    body: { op: 'append', count: 2, wordCount: 500, batch: 'aabbccdd11223344' },
  }));
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  assert.equal(rb.data.rolledBack, true);
  const after = await mj(store, id);
  assert.equal(after.status, 'ready', '必须离开 creating');
  assert.equal(after.chapters.length, 3, '追加的 2 章必须退回（旧章一字未动，append 可逆）');
  assert.equal(after.chapterCount, 3);
  assert.equal(after.wordCount, before.wordCount, '字数要倒扣回原值，否则书架显示凭空多 500 字');
  const readAfter = await call(store, req(`/api/books/${id}/chapters/1`, { cookie }));
  assert.equal(readAfter.status, 200, '用户必须能把书读回来');
});

test('P1-3 replace 中断：恢复可读并保持新章表（同名 key 的正文覆盖不可逆）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '替换中断书', 3);
  const up = await call(store, req(`/api/books/${id}/chapters`, {
    method: 'POST', cookie,
    body: { op: 'replace', chapters: ['重排一', '重排二'], wordCount: 800 },
  }));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await mj(store, id)).chapters.length, 2);

  const rb = await call(store, req(`/api/books/${id}/rollback`, { method: 'POST', cookie, body: { op: 'replace' } }));
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  const after = await mj(store, id);
  assert.equal(after.status, 'ready');
  assert.equal(after.chapters.length, 2, '不装作回滚了正文：章表保持新表，正文由用户重传/重洗');
  const readAfter = await call(store, req(`/api/books/${id}/chapters/1`, { cookie }));
  assert.equal(readAfter.status, 200);
});

test('P1-3 回滚幂等：本来就不是 creating 的书一律 noop，不改任何字段', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '正常书', 2);
  const before = await mj(store, id);
  const r = await call(store, req(`/api/books/${id}/rollback`, { method: 'POST', cookie, body: { op: 'append', count: 1 } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.noop, true, '发布已成功 / 已被上一次回滚修好 → 不能重复动手');
  const after = await mj(store, id);
  assert.equal(after.chapters.length, before.chapters.length);
  assert.equal(after.cleanVer, before.cleanVer, '不得因为一次多余的 rollback 改动版本号');
});

test('P1-3 令牌对不上时只恢复状态，绝不截断章表（防跨批次误删）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '跨批次书', 3);
  await call(store, req(`/api/books/${id}/chapters`, {
    method: 'POST', cookie,
    body: { op: 'append', chapters: ['甲一', '甲二'], wordCount: 100, batch: 'aaaaaaaaaaaaaaaa' },
  }));
  // 另一个批次的回滚撞进来（同一次上传的两次尝试、或另一个标签页）
  const rb = await call(store, req(`/api/books/${id}/rollback`, {
    method: 'POST', cookie,
    body: { op: 'append', count: 2, wordCount: 100, batch: 'bbbbbbbbbbbbbbbb' },
  }));
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  const after = await mj(store, id);
  assert.equal(after.status, 'ready', '状态仍要恢复（书不能留在不可读态）');
  assert.equal(after.chapters.length, 5, '但不是我这批追加的章，一个都不许删');
});

test('P2-8 disposeCleaner 必须同时释放 Worker 与 cleaner 的检测缓存', () => {
  const cc = read('public/js/cleaner-client.js');
  assert.match(cc, /export function disposeCleaner\(\) \{\s*\n\s*killWorker\(/, 'disposeCleaner 要走统一失效路径（在途请求全拒）');
  assert.match(cc, /cleaner\.clearDetMemo\(\);/, 'disposeCleaner 必须释放 detMemo（否则登出后仍留着一整本书的正文）');
  // 三个「消息永远回不来」的死法都要结算（P2-7 的行为验证在真机套件里，这里钉接线）
  assert.match(cc, /worker\.onerror = \(e\) => killWorker\(/, 'onerror 必须走 killWorker');
  assert.match(cc, /worker\.onmessageerror = \(\) => killWorker\(/, 'onmessageerror 必须结算在途请求（这条路径 onmessage 不会触发）');
  assert.match(cc, /timer = setTimeout\(\(\) => killWorker\(/, '必须有看门狗定时器（Worker 卡死时没有任何回调）');
  const c = read('public/js/cleaner.js');
  assert.match(c, /export function clearDetMemo\(\) \{\s*\n\s*detMemo = null;/, 'clearDetMemo 必须真的把缓存置空');
});
