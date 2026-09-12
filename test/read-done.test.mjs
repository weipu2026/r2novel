/* read-done.test.mjs — 「已读完」进度镜像单测
 *
 * 背景（真 BUG）：apiProgressPut 的 index 进度镜像，原刷新条件是「章号变了才写」。
 * 而读完一本书的典型动作是停在末章继续往下滚到底——章号不变、只有 ratio 变，
 * 原条件永远不成立 → 书架镜像的 ratio 停在旧值，「已读完」角标在实践中几乎点不亮。
 * 现补上「读完状态翻转」这个刷新条件。
 *
 * 覆盖：末章跨过阈值即落盘 / 已读完后继续滚不写（保持零写放大）/
 *       阈值边界（0.89 不算、0.9 才算）/ 状态回退（往回翻）也落盘 / 换章仍照旧写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore, req, call, login } from './_harness.mjs';
import { READ_DONE_RATIO } from '../public/js/shared-const.js';

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

/** 读 index 里该书的进度镜像（书架角标就是从这里取数的） */
async function progOf(store, id) {
  const idx = JSON.parse(await store.getText('meta/index.json'));
  const b = (idx.books || []).find((x) => x.id === id);
  return b ? b.prog : null;
}

const put = (store, cookie, id, ch, ratio) =>
  call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch, ratio } }));

test('镜像：末章滚过「读完阈值」即落盘（原 BUG——章号不变则永不写）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '读完镜像A', 3);

  // 停在末章中部：换章 → 照旧写镜像
  let r = await put(store, cookie, id, 3, 0.5);
  assert.equal(r.status, 200);
  assert.equal((await progOf(store, id)).ratio, 0.5);

  // 关键场景：章号不变（仍是末章），只把比例滚过阈值——这正是「读完」的真实动作。
  // 修复前这里不会写 index，镜像停留在 0.5。
  await put(store, cookie, id, 3, 0.95);
  const after = await progOf(store, id);
  assert.equal(after.ratio, 0.95, '读完状态翻转必须落盘，否则书架角标永远点不亮');
  assert.equal(after.ch, 3);
});

test('镜像：已读完后继续滚不再写索引（保持零写放大）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '读完镜像B', 3);

  await put(store, cookie, id, 3, 0.95); // 成为已读完，落盘
  assert.equal((await progOf(store, id)).ratio, 0.95);

  await put(store, cookie, id, 3, 0.97); // 章号不变、状态未翻转 → 不该写
  await put(store, cookie, id, 3, 0.99);
  assert.equal((await progOf(store, id)).ratio, 0.95, '已读完后的滚动不应再重写 index（写放大）');
});

test('镜像：阈值边界——0.89 不算读完，跨到 0.9 才算；回退也会落盘', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '读完镜像C', 3);
  assert.ok(READ_DONE_RATIO > 0.89 && READ_DONE_RATIO <= 0.9, '阈值应落在 (0.89, 0.9]');

  await put(store, cookie, id, 3, 0.89);
  assert.equal((await progOf(store, id)).ratio, 0.89, '未到阈值：写（首次建镜像）');

  await put(store, cookie, id, 3, 0.9);
  assert.equal((await progOf(store, id)).ratio, 0.9, '恰好跨过阈值：翻转 → 写');

  await put(store, cookie, id, 3, 0.93);
  assert.equal((await progOf(store, id)).ratio, 0.9, '已在阈上：状态未翻转 → 不写');

  // 往回翻（读完 → 在读）同样是状态翻转，应落盘
  await put(store, cookie, id, 2, 0.1);
  const back = await progOf(store, id);
  assert.equal(back.ratio, 0.1, '状态回退也应刷新镜像');
  assert.equal(back.ch, 2, '换章照旧写');
});

test('镜像：无章数的书不会被误判为已读完', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '读完镜像D', 2);

  // 手工把 index 里的 chapterCount 抹成 0，模拟历史脏数据
  const idx = JSON.parse(await store.getText('meta/index.json'));
  const books = (idx.books || []).map((b) => (b.id === id ? { ...b, chapterCount: 0, prog: undefined } : b));
  await store.putText('meta/index.json', JSON.stringify({ books }));

  await put(store, cookie, id, 1, 1);
  const p = await progOf(store, id);
  assert.ok(p, '无章数时也会建镜像（换章路径），但绝不写成「读完」');
  assert.equal(p.ch, 1);
});

/* ---------------- 手动标记（readDone 三态） ---------------- */

test('手动标记：PATCH readDone 同时落到 meta 与 index 镜像', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '手动标记A', 2);

  let r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { readDone: true } }));
  assert.equal(r.status, 200);
  assert.equal((await progOf(store, id)), undefined, '标记不碰进度镜像');

  let idx = JSON.parse(await store.getText('meta/index.json'));
  assert.equal(idx.books.find((b) => b.id === id).readDone, true, 'index 镜像应带 readDone');

  const meta = (await call(store, req(`/api/books/${id}`, { cookie }))).data;
  assert.equal(meta.readDone, true, 'meta 侧也要写，否则后续从 meta 重建 index 会丢标记');

  // 摘掉标记（false 是「强制未读完」，不等于「没标过」）
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { readDone: false } }));
  idx = JSON.parse(await store.getText('meta/index.json'));
  assert.equal(idx.books.find((b) => b.id === id).readDone, false, 'false 必须显式保留（用于摘掉自动判定的标记）');
});

test('手动标记：无关的 patch 不会凭空写入 readDone（老书天然兼容）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '手动标记B', 2);

  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { pinned: true } }));
  const idx = JSON.parse(await store.getText('meta/index.json'));
  const b = idx.books.find((x) => x.id === id);
  assert.equal(b.pinned, true);
  assert.equal('readDone' in b, false, '没标记过的书不该出现该字段——前端据此回落自动判定');
});

test('手动标记：新建书的 index 条目不含 readDone（走自动判定）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '手动标记C', 2);

  const idx = JSON.parse(await store.getText('meta/index.json'));
  const b = idx.books.find((x) => x.id === id);
  assert.equal('readDone' in b, false);
  assert.equal(b.finished, false, 'finished（书是否完结）是另一个维度，不该被牵连');
});
