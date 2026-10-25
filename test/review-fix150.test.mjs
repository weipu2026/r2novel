/* review-fix150.test.mjs — #150 投产终检「A 档：索引与回收站数据安全」的定向回归
 *
 * 判据一律落在**行为 / 我发出的请求**上，不靠「文件里出现过某字符串」：
 *   P1-1  新分片不得无条件写：片号已被占时必须读回合并，而不是整片覆盖
 *   P1-2  root 与 root.bak 双失 + 没有 v1Bak（从头就是 v2 的库）不得被判成「新库」迁成空书架
 *   P2-2  looksRoot 必须挡住「合法 JSON 但形状不对」的 root（数组 map / 离谱的 shards）
 *   P2-2  writeRoot 的 bak 必须在 CAS 成功之后才写（失败方一个字节都不许动）
 *   P2-3  purgeOnce：list 失败不许当「没有章节」；remaining 必须与 done 同口径
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, PURGE_BATCH } from '../src/core/const.js';
import { openIndex } from '../src/store/open.js';
import { purgeOnce } from '../src/store/gc.js';
import { memStore, readIdxBooks, writeIdxBooks } from './_harness.mjs';

const ROOT = 'meta/idx/root.json';
const ROOT_BAK = 'meta/idx/root.json.bak';
const shard = (n) => `meta/idx/s${n}.json`;

const entry = (id) => ({ id, title: '书' + id, author: '', tags: [], chapterCount: 1, wordCount: 1 });
const full500 = () => Array.from({ length: 500 }, (_, i) => entry('f' + String(i).padStart(3, '0')));

/* ---------------- P1-1：新分片必须「不存在才写」 ---------------- */

test('P1-1 首片（全新库的第一本书）的写入条件必须是「不存在才写」（etag=null）', async () => {
  const base = memStore();
  const seen = [];
  const store = {
    ...base,
    putTextIf: (k, s, etag) => {
      seen.push([k, etag === null ? 'null' : etag === undefined ? 'undef' : 'cas']);
      return base.putTextIf(k, s, etag);
    },
  };
  const h = await openIndex(store); // 空库 → 迁移出 shards:0 的合法 root
  assert.equal(h.shardCount, 0);
  h.upsert('first', entry('first'));
  await h.save();
  const w = seen.filter(([k, e]) => k === shard(0) && e !== 'cas');
  assert.equal(w.length, 1, '首片应只写一次，实际：' + JSON.stringify(seen));
  assert.equal(w[0][1], 'null',
    '首片写入必须是「不存在才写」：无条件写会让两路并发的首次发布互相整片覆盖');
});

test('P1-1 拆片新建分片的写入条件必须是「不存在才写」（etag=null），不能是无条件写', async () => {
  const base = memStore();
  await writeIdxBooks(base, full500());
  const seen = [];
  // 探针打在**请求参数**上：无条件写 = etag undefined；「不存在才写」= null；CAS = 字符串
  const store = {
    ...base,
    putTextIf: (k, s, etag) => {
      seen.push([k, etag === null ? 'null' : etag === undefined ? 'undef' : 'cas']);
      return base.putTextIf(k, s, etag);
    },
  };
  const h = await openIndex(store);
  h.upsert('newbook', entry('newbook')); // 500 满 → 对半拆，新片是 s1
  await h.save();
  const s1Writes = seen.filter(([k]) => k === shard(1));
  assert.equal(s1Writes.length, 1, '拆片应只写一次新片，实际：' + JSON.stringify(seen));
  assert.equal(s1Writes[0][1], 'null',
    '新片写入必须是「不存在才写」：无条件写会让两路并发在同一片号上新建时后到者整片覆盖先到者');
});

test('P1-1 片号已被占（孤儿片/并发同号）→ 读回合并，盘上的书一本都不许丢', async () => {
  const store = memStore();
  await writeIdxBooks(store, full500());
  // 造一枚「孤儿片」：s1 存在但不在 root.map 里（上一轮 save 写成了新片、root 却没写成）。
  // 这与「并发请求在同一号码上新建了片」走的是**同一条分支**（putIf 条件失败 → 读回合并）——
  // 测试替身的 putTextIf 不是服务端原子求值，能确定复现的只有这一侧。
  const orphan = [entry('orph1'), entry('orph2')];
  const obody = JSON.stringify({ books: orphan });
  await store.putText(shard(1), obody);
  await store.putText(shard(1) + '.bak', obody);

  const h = await openIndex(store);
  h.upsert('newbook', entry('newbook')); // 满片拆分 → 新片号正好是 1（已被占）
  await h.save();

  const books = await readIdxBooks(store);
  const ids = new Set(books.map((b) => b.id));
  assert.equal(books.length, 503, '251（s0 留下）+ 252（s1：孤儿 2 + 尾半 250）= 503，实际 ' + books.length);
  for (const id of ['orph1', 'orph2', 'newbook']) assert.ok(ids.has(id), '合并后必须保留 ' + id);
  const root = JSON.parse(await store.getText(ROOT));
  assert.equal(root.shards, 2);
  assert.equal(root.map.orph1, 1, '被接回的孤儿书必须同时进 map，否则书架要等下一次对账才看得见');
  assert.equal(root.map.orph2, 1);
  assert.equal(root.map.newbook, 1);
});

/* ---------------- P1-2：root 双失不得判成新库 ---------------- */

test('P1-2 root + root.bak 双失且无 v1Bak → 由分片重建（而不是迁成空书架）', async () => {
  const store = memStore();
  const books = [entry('b1'), entry('b2')];
  await writeIdxBooks(store, books);
  store._map.delete(ROOT);
  store._map.delete(ROOT_BAK);
  // 关键前提：v1Bak 只在「迁移时读到过 v1 原文」才写 —— 从头就是 v2 的库没有它。
  assert.equal(store._map.has('meta/index.json.v1.bak'), false, '构造前提：无 v1Bak');

  const h = await openIndex(store);
  assert.deepEqual(h.books.map((b) => b.id).sort(), ['b1', 'b2'],
    'root 双失必须按盘上分片重建；旧实现落到 migrateV1 → 读不到 v1 index.json → 写出空 root，书架永久 0 本');
  const root = JSON.parse(await store.getText(ROOT));
  assert.equal(root.shards, 1, '重建必须把 root 写回盘（后续请求不再走自愈链）');
  assert.equal(root.map.b1, 0);
});

/* ---------------- P2-2：looksRoot 收紧 ---------------- */

test('P2-2 root 形状不对（map 是数组 / shards 离谱）一律不认，必须走自愈链', async () => {
  // ① map 是数组：[] 也满足 typeof === 'object'，旧实现会当成合法 root → get(id) 恒 undefined
  {
    const store = memStore();
    await writeIdxBooks(store, [entry('b1'), entry('b2')]);
    await store.putText(ROOT, JSON.stringify({ v: 2, shards: 1, map: [] }));
    await store.putText(ROOT_BAK, JSON.stringify({ v: 2, shards: 1, map: [] }));
    const h = await openIndex(store);
    assert.equal(h.books.length, 2);
    // 判据不能只看 h.get()：reconcile ① 会顺手把 map[id] 补上，坏 root 也能「看起来正常」。
    // 真正的伤害在写回：数组 map 上的 root.map[id] = n 是**非索引属性**，JSON.stringify 直接丢掉
    // —— 于是入库指针永远写不进去（书架看得见、点进去 404）。所以要断言 root 被改写成合法布局。
    const healed = JSON.parse(await store.getText(ROOT));
    assert.equal(Array.isArray(healed.map), false, 'map 是数组的假 root 必须由自愈链重建成对象 map');
    assert.equal(healed.map.b1, 0);
  }
  // ② shards 超过护栏值：全量加载会按它 Array.from → 一个被写坏的巨大值足以当场 OOM
  {
    const store = memStore();
    await writeIdxBooks(store, [entry('b1'), entry('b2')]);
    await store.putText(ROOT, JSON.stringify({ v: 2, shards: 1200, map: {} }));
    await store.putText(ROOT_BAK, JSON.stringify({ v: 2, shards: 1200, map: {} }));
    const h = await openIndex(store);
    assert.equal(h.books.length, 2, 'shards 离谱的假 root 必须被识破后由分片重建');
    assert.equal(JSON.parse(await store.getText(ROOT)).shards, 1);
  }
});

/* ---------------- P2-2：root.bak 必须是「上一次成功写入前」的状态 ---------------- */

test('P2-2 撞 CAS 失败的那一路不许改写 root.bak（否则 bak 落后两代，日后回落即静默丢布局）', async () => {
  const store = memStore();
  await writeIdxBooks(store, [entry('b1')]);
  const stale = await openIndex(store); // 停在 R0（故意最后一个提交，先拿到陈旧快照）
  const hA = await openIndex(store);
  hA.upsert('b2', entry('b2'));
  await hA.save();
  const R1 = await store.getText(ROOT);
  const hB = await openIndex(store); // 看到 R1
  hB.upsert('b3', entry('b3'));
  await hB.save();
  const R2 = await store.getText(ROOT);
  assert.notEqual(R2, R1);
  assert.equal(await store.getText(ROOT_BAK), R1, 'bak 应等于上一次成功写入前的 root');

  stale.upsert('b9', entry('b9'));
  await assert.rejects(
    () => stale.save({ replay: false }),
    (e) => e && e.code === 'IDX_CONFLICT',
    '陈旧快照保存必须撞冲突（不许静默覆盖）'
  );
  assert.equal(await store.getText(ROOT), R2, '失败方不得改 root');
  assert.equal(await store.getText(ROOT_BAK), R1, '失败方也不得把 bak 覆盖成自己那份更旧的快照');
});

/* ---------------- P2-3：purgeOnce 的 list 失败与 remaining 口径 ---------------- */

test('P2-3 purgeOnce：正文清单列不出来时不许当「没有章节」（否则 meta 一删正文永久失联）', async () => {
  const store = memStore();
  const id = 'x1';
  const trashBody = JSON.stringify({ books: [{ id, title: 't', deletedAt: 1 }] });
  await store.putText(KEY.TRASH, trashBody);
  await store.putText(KEY.text(id, '1'), '正文');
  const broken = {
    ...store,
    list: async () => {
      throw new Error('R2 抖动');
    },
  };
  await assert.rejects(() => purgeOnce(broken, id), /清单读取失败/, 'list 失败必须报错，不能静默当成空');
  const after = JSON.parse(await store.getText(KEY.TRASH));
  assert.equal(after.books.length, 1, '回收站条目必须还在（旧实现会摘掉它，正文从此无主）');
  assert.ok(store._map.has(KEY.text(id, '1')), '正文当然也还在');
});

test('P2-3 purgeOnce：本窗删完但还有没列到的章节时，remaining 必须 > 0 与 done 同口径', async () => {
  const store = memStore();
  const id = 'x2';
  await store.putText(KEY.TRASH, JSON.stringify({ books: [{ id, title: 't', deletedAt: 1 }] }));
  // 恰好一窗（PURGE_BATCH 条）且 list 报 truncated：left 为空但游标非空 → done=false
  const objs = Array.from({ length: PURGE_BATCH }, (_, i) => ({ key: KEY.text(id, String(i + 1)), size: 4 }));
  const paged = { ...store, list: async () => ({ objects: objs, truncated: true, pages: 1, cursor: 'c1' }) };
  for (const o of objs) await store.putText(o.key, '正文');

  const r = await purgeOnce(paged, id);
  assert.equal(r.done, false, '还有没列到的章节 → done 必须为 false');
  assert.ok(r.remaining > 0,
    'remaining 是「还要不要续调」：done=false 却报 0 会让前端 while(remaining>0) 当场收手，窗外正文永久残留');
  const after = JSON.parse(await store.getText(KEY.TRASH));
  assert.equal(after.books.length, 1, '条目不许被摘（还没删完）');
  assert.equal(after.books[0].purgeCursor, 'c1', '游标必须落盘，下一轮从这里续列');
});
