/* index-shards.test.mjs — 书架索引 v2 分片存储专项单测
 *
 * 覆盖五组行为（对应 router.js「书架索引：v2 分片存储」节）：
 *   1. v1→v2 迁移：零手工、books 原样、v1 原文留档、index.json 冻结保留（回滚窗口）
 *   2. 写放大消除：单书 PATCH 只写所在分片（他片字节不动）；进度镜像单书模式 bak 不写
 *   3. 损坏自愈：root 坏→bak 兜底；root+bak 双坏→由分片重建；分片坏→片 bak 兜底；
 *      分片+片 bak 双坏→该片书从书架消失但 meta 保全（成「无主书」可经回收站找回），
 *      且**绝不静默写空片**（v1 的真数据丢失路径）
 *   4. 满片拆分：>500 本自动对半拆成两片
 *   5. 批量预算裁剪：目标散在多片时按 48 子请求预算贪心裁剪，rest 续调
 *   6. diag 排除：分片文件不进「无主书」清单
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY } from '../src/router.js';
import { memStore, req, call, login, readIdxBooks, writeIdxBooks } from './_harness.mjs';

const ROOT = 'meta/idx/root.json';
const ROOT_BAK = 'meta/idx/root.json.bak';
const shard = (n) => `meta/idx/s${n}.json`;

/** 直接种一份 v1 单文件索引 + 对应 meta（books 条目字段须够 apiBooks/批量用） */
async function seedV1(store, books) {
  store._map.set('meta/index.json', JSON.stringify({ books }));
  for (const b of books) {
    store._map.set(
      KEY.book(b.id),
      JSON.stringify({
        id: b.id,
        title: b.title,
        author: b.author || '',
        tags: b.tags || [],
        chapters: Array.from({ length: b.chapterCount || 1 }, (_, i) => ({ key: String(i + 1), title: '第' + (i + 1) + '章' })),
        chapterCount: b.chapterCount || 1,
        wordCount: b.wordCount || 1,
        createdAt: b.createdAt || 1700000000000,
        updatedAt: b.updatedAt || 1700000000000,
        status: 'ready',
      })
    );
  }
}

const mkBook = (i) => ({
  id: 'b' + String(i).padStart(4, '0'),
  title: '书' + i,
  author: 'a',
  tags: [],
  pinned: false,
  finished: false,
  star: false,
  chapterCount: 1,
  wordCount: 1,
  createdAt: 1700000000000 + i,
  updatedAt: 1700000000000 + i,
});

test('迁移：v1 → v2 零手工，books 原样、v1 原文留档、index.json 冻结保留', async () => {
  const store = memStore();
  const cookie = await login(store);
  const v1books = [mkBook(1), mkBook(2), mkBook(3)];
  await seedV1(store, v1books);
  const v1raw = store._map.get('meta/index.json');

  const r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.data.books.map((b) => b.id),
    v1books.map((b) => b.id),
    '迁移后书架摘要与 v1 一致'
  );
  assert.equal(JSON.parse(store._map.get(ROOT)).v, 2, 'root 应是 v2');
  assert.ok(store._map.has(shard(0)), '分片文件应已写出');
  assert.equal(store._map.get('meta/index.json.v1.bak'), v1raw, 'v1 原文应留档双保险');
  assert.equal(store._map.get('meta/index.json'), v1raw, 'v1 本体冻结保留（旧代码回滚窗口）');
  assert.ok(store._map.has(shard(0) + '.bak'), '分片 bak 应落首份内容');

  // 迁移一次后不再重复迁移（root 已存在，直接走分片）
  const r2 = await call(store, req('/api/books', { cookie }));
  assert.equal(r2.data.books.length, 3);
});

test('写放大：单书 PATCH 只写所在分片，他片字节不动；镜像写不落 bak', async () => {
  const store = memStore();
  const cookie = await login(store);
  await seedV1(store, Array.from({ length: 3 }, (_, i) => mkBook(i + 1)));
  await call(store, req('/api/books', { cookie })); // 触发迁移 → 单片 s0
  // 手工造成两片：直接重写布局（s0 两本 + s1 一本）
  const books = await readIdxBooks(store);
  await store._map.set(
    shard(0),
    JSON.stringify({ books: [books[0], books[1]] })
  );
  await store._map.set(
    shard(1),
    JSON.stringify({ books: [books[2]] })
  );
  await store._map.set(ROOT, JSON.stringify({ v: 2, shards: 2, map: { [books[0].id]: 0, [books[1].id]: 0, [books[2].id]: 1 } }));
  const s1Before = store._map.get(shard(1));
  const writes = [];
  const orig = store.putText.bind(store);
  store.putText = async (k, s) => {
    writes.push(k);
    return orig(k, s);
  };

  // PATCH s0 里的书 → 只应写 s0(+bak)，绝无 s1
  writes.length = 0;
  const p = await call(store, req(`/api/books/${books[0].id}`, { method: 'PATCH', cookie, body: { pinned: true } }));
  assert.equal(p.status, 200);
  assert.ok(writes.includes(shard(0)) && writes.includes(shard(0) + '.bak'), '脏分片应连 bak 一起写');
  assert.ok(!writes.some((k) => k.startsWith(shard(1))), '无关分片一个字节都不该动');
  assert.equal(store._map.get(shard(1)), s1Before, 's1 字节级不变');

  // 进度镜像（换章）→ 只写所在分片本体，不写 bak（v1 镜像语义延续）；progress 真值文件照常写
  writes.length = 0;
  await call(store, req(`/api/progress/${books[2].id}`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0.5 } }));
  assert.deepEqual(
    writes.filter((k) => k.startsWith('meta/idx/')),
    [shard(1)],
    '镜像写=恰好一次分片本体，无 bak'
  );
});

test('自愈：root 坏→bak 兜底；root+bak 双坏→由分片重建；分片坏→片 bak 兜底', async () => {
  const store = memStore();
  const cookie = await login(store);
  await seedV1(store, [mkBook(1), mkBook(2)]);
  await call(store, req('/api/books', { cookie })); // 迁移

  // ① root 坏 → bak 兜底
  await store._map.set(ROOT, '{corrupt!');
  let r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.books.length, 2, 'root 损坏应由 bak 兜底');

  // ② root + root.bak 双坏 → 由分片内容重建
  await store._map.set(ROOT, '{corrupt!');
  await store._map.set(ROOT_BAK, '{also corrupt');
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.books.length, 2, '双坏应由分片重建');
  assert.equal(JSON.parse(store._map.get(ROOT)).shards, 1, '重建后 root 应已写回');

  // ③ 分片坏 → 片 bak 兜底（只读回退：读路径不产生写，坏文件等下次合法写入时自愈）
  const goodBooks = JSON.parse(store._map.get(shard(0) + '.bak')).books;
  await store._map.set(shard(0), '{broken');
  r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.books.length, 2, '分片损坏应由片 bak 兜底');
  assert.deepEqual(JSON.parse(store._map.get(shard(0) + '.bak')).books, goodBooks, '片 bak 应完好');
});

test('自愈极限：分片+片bak 双坏 → 该片书退出书架但 meta 保全，且后续写拒绝覆盖空片', async () => {
  const store = memStore();
  const cookie = await login(store);
  await seedV1(store, [mkBook(1), mkBook(2)]);
  await call(store, req('/api/books', { cookie })); // 迁移：两本都在 s0

  await store._map.set(shard(0), '{broken');
  await store._map.set(shard(0) + '.bak', '{broken too');

  const r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 200);
  assert.equal(r.data.books.length, 0, '唯一分片深度损坏 → 书架为空（不 500，让用户能看到问题）');
  assert.ok(store._map.has(KEY.book('b0001')), 'meta 本体必须保全');

  // 该书进度镜像 PUT：书不在架 → ok:true 且不写任何分片（绝不把空片固化）
  const before = store._map.get(shard(0));
  const p = await call(store, req(`/api/progress/b0001`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0.5 } }));
  assert.equal(p.status, 200);
  assert.equal(store._map.get(shard(0)), before, '深度损坏的分片绝不被静默覆写');

  // meta 还在 → 「无主书」路径可找回（这里只验证 meta 存活这个前提）
  const meta = JSON.parse(store._map.get(KEY.book('b0001')));
  assert.equal(meta.title, '书1');
});

test('满片拆分：>500 本自动对半拆；拆后读写正常', async () => {
  const store = memStore();
  const cookie = await login(store);
  const books = Array.from({ length: 501 }, (_, i) => mkBook(i));
  await seedV1(store, books);
  await call(store, req('/api/books', { cookie })); // 迁移过程中即触发拆分
  const root = JSON.parse(store._map.get(ROOT));
  assert.equal(root.shards, 2, '501 本应对半拆成 2 片');
  const s0 = JSON.parse(store._map.get(shard(0))).books.length;
  const s1 = JSON.parse(store._map.get(shard(1))).books.length;
  assert.equal(s0 + s1, 501, '拆分不丢书');
  assert.ok(s0 <= 500 && s1 <= 500, '单片不超上限');
  // 拆后 patch 尾部书（在 s1）正常
  const last = books[500].id;
  const p = await call(store, req(`/api/books/${last}`, { method: 'PATCH', cookie, body: { star: true } }));
  assert.equal(p.status, 200);
  const after = (await readIdxBooks(store)).find((b) => b.id === last);
  assert.equal(after.star, true);
});

test('批量预算：18 本散在多片时按预算裁剪，rest 续调；meta 只写已处理的书', async () => {
  const store = memStore();
  const cookie = await login(store);
  const books = Array.from({ length: 2001 }, (_, i) => mkBook(i)); // 迁移 → 5 片（500×4+1）
  await seedV1(store, books);
  await call(store, req('/api/books', { cookie }));
  const root = JSON.parse(store._map.get(ROOT));
  assert.equal(root.shards, 5);

  // 18 个目标：s0 取 5 本、s1~s3 各 4 本（17 本，est=1+3×4+2×17=47 ✓）、s4 取 1 本
  // （新片 k=5：est=1+3×5+2×18=50 ✗）→ 恰好裁到 17 本
  const ids = [];
  for (let j = 0; j < 5; j++) ids.push(books[j].id);
  for (let s = 1; s < 4; s++) for (let j = 0; j < 4; j++) ids.push(books[s * 500 + j].id);
  ids.push(books[2000].id);

  const r = await call(
    store,
    req('/api/books/batch', { method: 'POST', cookie, body: { ids, action: 'setFinished', finished: true } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.updated, 17, '预算内恰好处理 17 本');
  assert.equal(r.data.rest, 1, '剩余 1 本续调');
  // meta 只写已处理的书
  assert.equal(JSON.parse(store._map.get(KEY.book(ids[16]))).finished, true);
  assert.notEqual(JSON.parse(store._map.get(KEY.book(ids[17]))).finished, true, '被裁掉的书不应被写');
  // 索引摘要同步
  const after = await readIdxBooks(store);
  assert.equal(after.find((b) => b.id === ids[0]).finished, true);
});

test('diag：索引分片与 v1 留档不进「无主书」清单', async () => {
  const store = memStore();
  const cookie = await login(store);
  await seedV1(store, [mkBook(1), mkBook(2)]);
  await call(store, req('/api/books', { cookie }));
  const r = await call(store, req('/api/diag/orphans', { cookie }));
  assert.equal(r.status, 200);
  const ids = (r.data.orphanBooks || []).map((b) => b.id);
  assert.equal(ids.length, 0, '分片文件不应被当成无主书：' + ids.join(','));
});
