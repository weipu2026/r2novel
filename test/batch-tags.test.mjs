/* batch-tags.test.mjs — 书架批量操作 + 标签治理 API 单测
 * 覆盖：批量加/去/整设标签（index 镜像同步）、批量完结状态、批量软删、
 *       参数校验（空 ids / 未知 action / 空标签 / 非 bool finished）、
 *       标签全量清单（不截断）、合并去重双向、改名、删除、分批 remaining、鉴权
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore, req, call, login } from './_harness.mjs';

async function makeReadyBook(store, cookie, title, tags = []) {
  const chapters = ['第1章 甲', '第2章 乙'];
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', tags, chapters, wordCount: 20, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  const id = r.data.id;
  for (let i = 0; i < 2; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '正文' + (i + 1) }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return id;
}

const shelf = async (store, cookie) => (await call(store, req('/api/books', { cookie }))).data.books;

/* ---------------- 批量操作 ---------------- */

test('batch：未登录 401', async () => {
  const store = memStore();
  const r = await call(store, req('/api/books/batch', { method: 'POST', body: { ids: ['x'], action: 'setFinished', finished: true } }));
  assert.equal(r.status, 401);
});

test('batch：参数校验（空 ids / 未知 action / 空标签 / 缺 finished / 非法 id 过滤）', async () => {
  const store = memStore();
  const cookie = await login(store);
  let r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: [], action: 'delete' } }));
  assert.equal(r.status, 400);
  r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: ['a'], action: 'hack' } }));
  assert.equal(r.status, 400);
  r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: ['a'], action: 'addTags', tags: [] } }));
  assert.equal(r.status, 400);
  r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: ['a'], action: 'setFinished' } }));
  assert.equal(r.status, 400);
  // 全部非法 id → 400（无合法书可选）
  r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: ['../etc'], action: 'delete' } }));
  assert.equal(r.status, 400);
});

test('batch：addTags 合并去重、meta 与 index 镜像同步', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id1 = await makeReadyBook(store, cookie, '书一', ['玄幻']);
  const id2 = await makeReadyBook(store, cookie, '书二', []);

  let r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: [id1, id2], action: 'addTags', tags: ['玄幻', '系统', '都市'] } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.updated, 2);

  const b1 = (await shelf(store, cookie)).find((b) => b.id === id1);
  const b2 = (await shelf(store, cookie)).find((b) => b.id === id2);
  assert.deepEqual(b1.tags, ['玄幻', '系统', '都市'], '已有标签不重复，顺序保持');
  assert.deepEqual(b2.tags, ['玄幻', '系统', '都市']);
  // meta 本体同步
  const meta1 = JSON.parse(await store.getText(`meta/${id1}.json`));
  assert.deepEqual(meta1.tags, ['玄幻', '系统', '都市']);
});

test('batch：removeTags 只删指定标签；setTags 整体替换（含清空）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '书A', ['玄幻', '系统', '都市']);

  let r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: [id], action: 'removeTags', tags: ['系统'] } }));
  assert.equal(r.status, 200);
  assert.deepEqual((await shelf(store, cookie)).find((b) => b.id === id).tags, ['玄幻', '都市']);

  r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: [id], action: 'setTags', tags: ['女频'] } }));
  assert.deepEqual((await shelf(store, cookie)).find((b) => b.id === id).tags, ['女频']);

  r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: [id], action: 'setTags', tags: [] } }));
  assert.deepEqual((await shelf(store, cookie)).find((b) => b.id === id).tags, [], 'setTags 允许清空');
});

test('batch：setFinished 状态切换；软删进回收站且 index 摘除', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id1 = await makeReadyBook(store, cookie, '书B');
  const id2 = await makeReadyBook(store, cookie, '书C');

  let r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: [id1, id2], action: 'setFinished', finished: true } }));
  assert.equal(r.data.updated, 2);
  let s = await shelf(store, cookie);
  assert.ok(s.find((b) => b.id === id1).finished === true);
  assert.ok(s.find((b) => b.id === id2).finished === true);

  // 批量软删
  r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: [id1, id2], action: 'delete' } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.updated, 2);
  s = await shelf(store, cookie);
  assert.equal(s.length, 0, '书架应清空');
  const trash = (await call(store, req('/api/trash', { cookie }))).data.books;
  assert.equal(trash.length, 2, '两本书都应进回收站');
  assert.ok(trash.every((b) => b.deletedAt > 0));
});

/* ---------------- 标签治理 ---------------- */

test('tags：未登录 401；清单不截断且带计数', async () => {
  const store = memStore();
  let r = await call(store, req('/api/tags'));
  assert.equal(r.status, 401);

  const cookie = await login(store);
  await makeReadyBook(store, cookie, '书D', ['玄幻', '系统']);
  await makeReadyBook(store, cookie, '书E', ['玄幻', '名著']);
  await makeReadyBook(store, cookie, '书F', ['都市', '系统', '仙侠', '武侠', '历史', '科幻', '游戏', '军事', '同人', '女频']);
  await makeReadyBook(store, cookie, '书G', ['末世', '无限流']);
  r = await call(store, req('/api/tags', { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 14, '超过 12 个也应全量返回（不受前端 top12 截断影响）');
  const m = new Map(r.data.tags.map((t) => [t.tag, t.count]));
  assert.equal(m.get('玄幻'), 2);
  assert.equal(m.get('系统'), 2);
  assert.equal(m.get('名著'), 1);
  // 计数降序
  const counts = r.data.tags.map((t) => t.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('tags：merge 合并去重（双向顺序）+ meta/index 同步 + remaining 分批', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id1 = await makeReadyBook(store, cookie, '书G', ['玄幻小说', '玄幻']);
  const id2 = await makeReadyBook(store, cookie, '书H', ['玄幻小说', '都市']);

  let r = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: '玄幻小说', to: '玄幻' } }));
  assert.equal(r.status, 200);
  assert.equal(r.data.updated, 2);
  assert.equal(r.data.remaining, 0);

  const s = await shelf(store, cookie);
  assert.deepEqual(s.find((b) => b.id === id1).tags, ['玄幻'], '反向排列也去重为单标签');
  assert.deepEqual(s.find((b) => b.id === id2).tags, ['玄幻', '都市'], '目标不存在时替换到原位置');
  // meta 本体同步
  const meta = JSON.parse(await store.getText(`meta/${id1}.json`));
  assert.deepEqual(meta.tags, ['玄幻']);
});

test('tags：merge 改名与删除；from/to 相同 400', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = await makeReadyBook(store, cookie, '书I', ['旧名']);

  // 改名 = 合并到不存在的新名
  let r = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: '旧名', to: '新名' } }));
  assert.equal(r.data.updated, 1);
  assert.deepEqual((await shelf(store, cookie)).find((b) => b.id === id).tags, ['新名']);

  // 删除 = to 为空
  r = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: '新名', to: '' } }));
  assert.equal(r.data.updated, 1);
  assert.deepEqual((await shelf(store, cookie)).find((b) => b.id === id).tags, []);

  // 相同名拒绝
  r = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: 'a', to: 'a' } }));
  assert.equal(r.status, 400);
});
