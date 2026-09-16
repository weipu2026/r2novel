/* index-shards.test.mjs — 书架索引 v2 分片存储专项单测
 *
 * 覆盖五组行为（对应 router.js「书架索引：v2 分片存储」节）：
 *   1. v1→v2 迁移：零手工、books 原样、v1 原文留档、index.json 冻结保留（回滚窗口）
 *   2. 写放大消除：单书 PATCH 只写所在分片（他片字节不动）；进度镜像单书模式 bak 不写
 *   3. 损坏自愈：root 坏→bak 兜底；root+bak 双坏→由分片重建；分片坏→片 bak 兜底；
 *      分片+片 bak 双坏→该片书从书架消失但 meta 保全（成「无主书」可经回收站找回），
 *      且**绝不静默写空片**（v1 的真数据丢失路径）
 *   4. 满片拆分：迁移是 500/片整块切；迁移后再发布新书才走 upsert，满片对半拆
 *   5. 批量预算裁剪：目标散在多片时按 48 子请求预算贪心裁剪，deferred 原样回传并可续调到底
 *   6. diag 排除：分片文件不进「无主书」清单
 *   7. 第三轮审计加固（每条都有实测事故背书）：
 *      a. 空布局（shards:0）不进 root bak —— 否则 root 一坏就回落到「合法空书架」并覆盖首片
 *      b. map 与分片内容对账 —— 否则出现「书架看得见、点进去 404」的僵尸条目并被固化
 *      c. 迁移写序（root 最后提交）+ 半途中断可续传；片文件缺失（≠损坏）允许重建写入
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

/** 走完整流程建一本**已发布**的书：create → 逐章上传正文 → 上传原件 → publish。
 * 只发 POST /api/books 拿不到 ready（publish 会校验样例章节已上传 → 409），
 * 而 upsert 索引条目只发生在 publish/编辑同步那一步。 */
async function mkReady(store, cookie, title, n = 1) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200, 'create: ' + JSON.stringify(r.data));
  const id = r.data.id;
  for (let i = 0; i < n; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: chapters[i] + '正文' }));
  }
  await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: new TextEncoder().encode('raw-' + title) }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200, 'publish: ' + JSON.stringify(r.data));
  return id;
}

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

test('满片拆分：迁移整块切（500/片）；迁移后新发布触发 upsert 对半拆；拆后读写正常', async () => {
  const store = memStore();
  const cookie = await login(store);
  const books = Array.from({ length: 500 }, (_, i) => mkBook(i));
  await seedV1(store, books);
  await call(store, req('/api/books', { cookie })); // 迁移：整块切，500 本一片
  let root = JSON.parse(store._map.get(ROOT));
  assert.equal(root.shards, 1, '迁移是 500/片整块切，正好 500 本不拆片');
  assert.equal(JSON.parse(store._map.get(shard(0))).books.length, 500);
  assert.equal(JSON.parse(store._map.get(shard(0) + '.bak')).books.length, 500, '首份内容即 bak 基线');

  // 第 501 本：走 **upsert** 路径（新发布的书），这才真正覆盖「满片对半拆」那段代码
  const nid = await mkReady(store, cookie, '第五百零一本');
  root = JSON.parse(store._map.get(ROOT));
  assert.equal(root.shards, 2, '满片后新增 → 对半拆成两片');
  const s0 = JSON.parse(store._map.get(shard(0))).books;
  const s1 = JSON.parse(store._map.get(shard(1))).books;
  assert.equal(s0.length + s1.length, 501, '拆分不丢书');
  assert.ok(s0.length <= 500 && s1.length <= 500, '单片不超上限');
  assert.equal(root.map[nid], 1, '新书归属尾片');
  assert.equal(s1[s1.length - 1].id, nid, '新书是尾片最后一本');

  // 拆后读写正常（尾部书 PATCH 命中尾片）
  const p = await call(store, req(`/api/books/${nid}`, { method: 'PATCH', cookie, body: { star: true } }));
  assert.equal(p.status, 200);
  const after = (await readIdxBooks(store)).find((b) => b.id === nid);
  assert.equal(after.star, true);
  assert.equal((await readIdxBooks(store)).length, 501);
});

test('批量预算：18 本散在多片时按预算裁剪，deferred 原样回传并可续调到底', async () => {
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
  assert.deepEqual(r.data.deferred, [ids[17]], '被裁掉的 id 必须**原样回传**：只回传数量而前端不消费＝静默丢书');
  assert.equal(r.data.skipped, 0, 'skipped 只算「在架却改不成」的，不含被裁的');
  // meta 只写已处理的书
  assert.equal(JSON.parse(store._map.get(KEY.book(ids[16]))).finished, true);
  assert.notEqual(JSON.parse(store._map.get(KEY.book(ids[17]))).finished, true, '被裁掉的书不应被写');
  // 索引摘要同步
  const after = await readIdxBooks(store);
  assert.equal(after.find((b) => b.id === ids[0]).finished, true);

  // 续调（客户端 batch-queue.js 的做法）：把 deferred 发回来 → 一本不落
  const r2 = await call(
    store,
    req('/api/books/batch', { method: 'POST', cookie, body: { ids: r.data.deferred, action: 'setFinished', finished: true } })
  );
  assert.equal(r2.data.updated, 1);
  assert.deepEqual(r2.data.deferred, []);
  assert.equal(r2.data.skipped, 0);
  for (const id of ids) assert.equal(JSON.parse(store._map.get(KEY.book(id))).finished, true, `${id} 应已落库`);

  // 不在架的 id 进 skipped 而非 deferred（否则客户端会无限重试同一个死 id）
  const r3 = await call(
    store,
    req('/api/books/batch', { method: 'POST', cookie, body: { ids: ['b9999999'], action: 'setFinished', finished: true } })
  );
  assert.equal(r3.data.updated, 0);
  assert.equal(r3.data.skipped, 1);
  assert.deepEqual(r3.data.deferred, []);
});

test('root bak：空布局（shards:0）不进 bak —— root 一坏不得回落到「合法空书架」', async () => {
  const store = memStore();
  const cookie = await login(store);
  await seedV1(store, []); // 空 v1 → 迁移出 root {v:2,shards:0,map:{}}
  await call(store, req('/api/books', { cookie }));
  assert.equal(JSON.parse(store._map.get(ROOT)).shards, 0, '空库迁移 → shards:0');
  assert.ok(!store._map.has(ROOT_BAK), '迁移首写没有「写前布局」→ 不留 bak');

  // 发布第一本：写前 root 是 shards:0 的空布局，同样不该当 bak
  const id1 = await mkReady(store, cookie, '第一本');
  assert.equal(JSON.parse(store._map.get(ROOT)).shards, 1);
  assert.ok(!store._map.has(ROOT_BAK), '空布局当 bak → 回退即「合法但空」的假书架（实测会清空书架并覆盖首片）');

  // 真相：此刻 root 损坏 → 由分片重建（分片完好，本该能找回这本）
  await store._map.set(ROOT, '{corrupt');
  const r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.data.books.length, 1, 'root 损坏应能由分片找回，而不是 0 本');

  // 第二次成员变更：写前 root 已是真布局 → bak 正常写入，自愈链恢复完整
  await mkReady(store, cookie, '第二本');
  const bak = JSON.parse(store._map.get(ROOT_BAK));
  assert.ok(bak && bak.shards > 0 && bak.map[id1] !== undefined, 'bak 已是真布局（含首书）');
});

test('对账：map 落后于分片内容 → 不再有「书架看得见、点进去 404」的僵尸条目', async () => {
  const store = memStore();
  const cookie = await login(store);
  await seedV1(store, [mkBook(1), mkBook(2)]);
  await call(store, req('/api/books', { cookie })); // 迁移：两本都在 s0
  const all = await readIdxBooks(store);

  // 造「root 落后一代」（bak 回落 / 半写失败的形态）：map 只认得第一本
  const stale = JSON.stringify({ v: 2, shards: 1, map: { [all[0].id]: 0 } });
  await store._map.set(ROOT, stale);
  await store._map.set(ROOT_BAK, stale);

  let r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.data.books.length, 2, 'books 读分片全文 → 两本都在架');
  const p = await call(store, req(`/api/books/${all[1].id}`, { method: 'PATCH', cookie, body: { star: true } }));
  assert.equal(p.status, 200, '第二本必须可改（修复前 404「书不在书架」）');
  assert.equal(JSON.parse(store._map.get(ROOT)).map[all[1].id], 0, '对账把缺失的 map 条目补回来并落盘');

  // 反向：map 里的死指针（分片里没有这本书）在全量模式下被摘除，不再污染 indexHas
  await call(store, req(`/api/books/${all[0].id}`, { method: 'PATCH', cookie, body: { tags: ['x'] } }));
  await store._map.set(ROOT, JSON.stringify({ v: 2, shards: 1, map: { [all[0].id]: 0, ghost: 0 } }));
  r = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: 'x', to: 'y' } }));
  assert.equal(r.status, 200);
  const root = JSON.parse(store._map.get(ROOT));
  assert.ok(!('ghost' in root.map), '死指针应被摘除');
  assert.ok(root.map[all[1].id] !== undefined, '真书不能跟着被摘掉');
});

test('迁移写序（root 最后提交）+ 半途中断可续传；片文件缺失允许重建写入', async () => {
  // ① 写序：分片与 v1 留档都**落地之后**才轮到 root。
  //    判据不能是「调用顺序」——旧写法（root 与分片同批 Promise.all）也是最后才调 root 的 putText，
  //    真正要防的是**并发**：写到一半中断会留下「root 说有 N 片、分片一个都没落」。所以这里看
  //    「root 的 putText 开始时，还有没有别的索引写在途」。
  const store = memStore();
  const cookie = await login(store);
  await seedV1(store, [mkBook(1), mkBook(2), mkBook(3)]);
  let inFlight = 0;
  const atRootStart = [];
  const orig = store.putText.bind(store);
  store.putText = async (k, s) => {
    inFlight++;
    if (k === ROOT) atRootStart.push(inFlight);
    await new Promise((r) => setTimeout(r, 1)); // 给出「并发写同时在途」的观察窗口
    inFlight--;
    return orig(k, s);
  };
  await call(store, req('/api/books', { cookie }));
  store.putText = orig;
  assert.equal(atRootStart.length, 1, 'root 只写一次');
  assert.equal(atRootStart[0], 1, 'root 写入时不得有其它索引写仍在途（并发＝中断即「root 指向缺失分片」）');

  // ② 续传：造「root 说 2 片、meta/idx/ 下一个分片对象都没有」的中断态
  const s2 = memStore();
  const c2 = await login(s2);
  await seedV1(s2, [mkBook(1), mkBook(2), mkBook(3)]);
  await s2._map.set(ROOT, JSON.stringify({ v: 2, shards: 2, map: { b0001: 0, b0002: 0, b0003: 1 } }));
  const r = await call(s2, req('/api/books', { cookie: c2 }));
  assert.equal(r.status, 200);
  assert.equal(r.data.books.length, 3, 'v1 快照还在 → 续传重迁，而不是永久空书架');
  assert.ok(s2._map.has(shard(0)), '分片已重写');
  assert.equal(
    JSON.parse(s2._map.get(ROOT)).shards,
    1,
    '重迁按 v1 重新整块切 → 3 本 1 片（不再沿用中断态那个假 2 片）'
  );
  await mkReady(s2, c2, '续传后新增'); // 内部断言 publish=200：修复前 save() 拒写 → 无信息 500

  // 反向：只要还有一个分片对象存在（哪怕内容坏），就不重迁——绝不覆盖可能可抢救的字节
  const s3 = memStore();
  const c3 = await login(s3);
  await seedV1(s3, [mkBook(1)]);
  await s3._map.set(ROOT, JSON.stringify({ v: 2, shards: 2, map: { b0001: 0 } }));
  await s3._map.set(shard(0), '{broken');
  const r3 = await call(s3, req('/api/books', { cookie: c3 }));
  assert.equal(r3.status, 200);
  assert.equal(r3.data.books.length, 0, '分片对象存在（哪怕坏）→ 交自愈链，不重迁');

  // ③ 片文件缺失（≠损坏）：没有可丢的内容 → 允许重建写入，全库不再永久卡死
  const s4 = memStore();
  const c4 = await login(s4);
  await call(s4, req('/api/books', { cookie: c4 })); // 空库迁移
  s4._map.delete('meta/index.json'); // 连 v1 快照也没有 → 无从续传
  await s4._map.set(ROOT, JSON.stringify({ v: 2, shards: 2, map: {} }));
  await mkReady(s4, c4, '缺失片后新增'); // 内部断言 publish=200：片与片 bak 都不存在＝没有可丢的内容
  assert.equal((await call(s4, req('/api/books', { cookie: c4 }))).data.books.length, 1);
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
