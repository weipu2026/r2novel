/* star.test.mjs — 「星标」（私人收藏标记）单测
 *
 * 星标与 pinned / finished / readDone 走同一套「meta 为准 + index 镜像」策略：
 * 筛选发生在书架（只读 index 摘要），所以镜像必须跟 meta 同步落盘，否则会出现
 * 「标了星标、刷新就丢」——那正是这次要防的回归。
 *
 * 覆盖：标星双向同步 / 可取消 / 部分更新不误清 / 老书向后兼容 / 与阅读状态互不干扰 /
 *       章节编辑（syncIndexAfterEdit 路径）后星标仍在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY } from '../src/router.js';
import { memStore, req, call, login } from './_harness.mjs';

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
  return id;
}

/** 书架摘要条目（前端筛选就读这里，不看 meta） */
const shelfEntry = async (store, cookie, id) => {
  const r = await call(store, req('/api/books', { cookie }));
  return (r.data.books || []).find((b) => b.id === id);
};

test('星标：PATCH star=true → meta 与 index 镜像双向同步', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '标星之书', 2);

  assert.ok(!(await shelfEntry(store, cookie, id)).star, '初始不该是星标');
  const r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: true } }));
  assert.equal(r.status, 200);

  const meta = await call(store, req(`/api/books/${id}`, { cookie }));
  assert.equal(meta.data.star, true, 'meta.star 应为 true');
  assert.equal((await shelfEntry(store, cookie, id)).star, true, 'index 镜像应同步（书架筛选的数据源）');
});

test('星标：可取消（star=false 两边一起回 false）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '先标后取消', 2);
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: true } }));
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: false } }));

  assert.equal((await call(store, req(`/api/books/${id}`, { cookie }))).data.star, false);
  assert.equal((await shelfEntry(store, cookie, id)).star, false);
});

test('星标：部分更新语义 —— 改书名不碰星标，改星标不碰书名', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '部分更新书', 2);
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: true } }));

  // 只改标题：star 必须保住（apiPatchBook 用 !== undefined 判定，缺字段即不动）
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { title: '改过的书名' } }));
  let e = await shelfEntry(store, cookie, id);
  assert.equal(e.star, true, 'PATCH 未带 star 时星标不该被清掉');
  assert.equal(e.title, '改过的书名');

  // 只改星标：标题不受影响
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: false } }));
  e = await shelfEntry(store, cookie, id);
  assert.equal(e.star, false);
  assert.equal(e.title, '改过的书名', '取消星标不该动书名');
});

test('星标：老书没有 star 字段 → 不报错、判定为未标星，且可直接补标', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '老书兼容', 2);

  // 手工抹掉 meta/index 里的 star，模拟加字段之前入库的书
  const idx = JSON.parse(await store.getText('meta/index.json'));
  for (const b of idx.books) delete b.star;
  await store.putText('meta/index.json', JSON.stringify(idx));
  const meta = JSON.parse(await store.getText(KEY.book(id)));
  delete meta.star;
  await store.putText(KEY.book(id), JSON.stringify(meta));

  const r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200, '缺 star 字段不该让书架 500');
  const e = (r.data.books || []).find((b) => b.id === id);
  assert.ok(!e.star, '缺字段应判定为未标星');

  // 老书照样能补标（不需要任何迁移脚本）
  const p = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: true } }));
  assert.equal(p.status, 200);
  assert.equal((await shelfEntry(store, cookie, id)).star, true);
});

test('星标：与阅读状态互不干扰（标星不改 readDone / 进度镜像）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '双标记书', 3);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0.5 } }));
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { readDone: true } }));

  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: true } }));
  const e = await shelfEntry(store, cookie, id);
  assert.equal(e.star, true);
  assert.equal(e.readDone, true, '标星不该动 readDone');
  assert.ok(e.prog && e.prog.ch === 2, '标星不该动进度镜像');

  // 反过来：摘掉「已读完」也不该动星标
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { readDone: false } }));
  const e2 = await shelfEntry(store, cookie, id);
  assert.equal(e2.star, true, '改阅读状态不该动星标');
  assert.equal(e2.readDone, false);
});

test('星标：编辑章节（syncIndexAfterEdit 重建摘要）后星标仍在', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '编辑后保星', 3);
  await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { star: true } }));

  // 改一章标题 → 走 syncIndexAfterEdit，整个 index 条目会被 indexEntryFromMeta 重建
  const r = await call(
    store,
    req(`/api/books/${id}/chapters/2`, { method: 'PATCH', cookie, body: { title: '第二章 改过', content: '新正文内容' } })
  );
  assert.equal(r.status, 200);
  assert.equal((await shelfEntry(store, cookie, id)).star, true, '摘要重建后星标必须还在');

  // 删一章也走同一条路径
  const d = await call(store, req(`/api/books/${id}/chapters/3`, { method: 'DELETE', cookie }));
  assert.equal(d.status, 200);
  assert.equal((await shelfEntry(store, cookie, id)).star, true, '删章后星标必须还在');
});
