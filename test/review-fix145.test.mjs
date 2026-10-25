/* review-fix145.test.mjs — 2026-10-16 #145 轮全站审计修复的定向回归（P1×2 + P2×9 + P3×13）
 *
 * 判据落在「请求本身 / 判定分支 / 盘面终态」上；每条都对应「改回旧写法必然不通过」
 * （反向探针 probe-reverse-fix145.py 逐条变异验证，还原后 sha 逐字节一致）。
 *
 * A 组 · 行为级（HTTP 驱动 router；竞态用 store 钩子在**确定性时机**注入并发动作）：
 *   P1-1  purging 占用标记：在飞 → 409；纯 purge:[] 崩溃残留 → 放行；快照后竞态 → 重放拦下并回滚索引
 *   P1-2  publish upsert 前 trash 复检：CAS 窗口内被并发软删 → 409，不成「在架+回收站」双态
 *   P2-9  append 幂等令牌：同 batch 回放不重复追加；replace/publish 作废登记；非 16hex 忽略
 *   P2-10 改章：CAS 冲突耗尽 → 409 且正文不落盘；原样重试 → 字数全额修正（不吞差）
 *   P3-3  软删半成品书续传正文（单章/bulk）→ 409；未删的半成品照常可写
 *   P3-4  replace 进度迁移 CAS 化：迁移窗口内的并发阅读写入不被覆盖
 *   P3-5  插章 CAS 失败 → 409 且新章正文零残留
 *   P3-6  首刊同名终判：并发新建的同名书第二本发布 409
 *   P3-8  trash.json 结构坏（{}/[]/null/books:null）列表与 publish 不 500
 *   P3-9  method 不匹配 405；非法 id 带 body → 404 正常收尾（dropBody）
 *   P3-10 /opds、/export 瞬时故障回 JSON 502；worker 入口兜底回 JSON 500
 *   P3-11 惰性清理三态门控：same-origin 才触发（trash sweep 与孤儿清扫两条路径）
 *   P3-1  分片数 K>40 熔断：tags(list/merge)/createBook/diag(scan+purge) 全 409
 *
 * B 组 · 源码级判据（正则带函数体结构，防注释同名喂假绿；覆盖前端难驱动的修复）：
 *   P2-3/4/5/6/7/8、P3-12（前端）、P2-9（客户端派生）、P3-2/3-7（router 内部）、
 *   以及 A 组各修复的写序/门控锚点（P1-1/P1-2/P3-4/P3-5/P3-6/P3-11）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memStore, req, call, login, makeReadyBook, makeDraftBook, readIdxBooks, ENV, BASE } from './_harness.mjs';
import { KEY } from '../src/router.js';
import { countWords } from '../public/js/shared-text.js';
import { srcAll } from './_src-all.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 仓库文件是 CRLF：断言正则里的 \n 必须在归一后匹配（否则多行正则静默失配 = 假红）
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
// #149 P2 拆分后，被测实现分散在 src/{core,store,api}；srcAll() 按原声明顺序拼接
const routerSrc = () => srcAll();
const rawMeta = async (store, id) => JSON.parse(await store.getText(KEY.book(id)));
const getProg = async (store, cookie, id) => (await call(store, req(`/api/progress/${id}`, { cookie }))).data;
const putCh = (store, cookie, id, k, text) => call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PUT', cookie, body: text }));
const patchCh = (store, cookie, id, k, body) => call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PATCH', cookie, body }));
const publish = (store, cookie, id) => call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
const setTrash = (store, fn) => {
  const t = JSON.parse(store._map.get(KEY.TRASH));
  fn(t);
  store._map.set(KEY.TRASH, JSON.stringify(t));
  return t;
};

/* ==================== A 组 · 行为级 ==================== */

test('P1-1 在飞占用标记（purging:true + purge:[]）：restore 必须 409 且不进索引', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '占用书', 2);
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie })); // 软删
  // 手工铺成 purgeOnce 的在飞中间态：占用标记独立字段 purging + 本批恰好删完（left=[]）
  // —— 「在飞 purge 的稳定中间态」与「进程中断的崩溃残留」盘面同形，只认 purge.length 会稳定穿透
  setTrash(store, (t) => {
    t.books[0].purging = true;
    t.books[0].purge = [];
  });

  const r = await call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
  assert.equal(r.status, 409, 'purge:[] 是在飞占用态，只比 length 会被穿透 → 恢复×彻底删除并发删光正文');
  const idx = await readIdxBooks(store);
  assert.ok(!idx.some((b) => b.id === id), '拒绝后不得把书 upsert 进索引（否则书架留点开 404 的幽灵）');
  const list = await call(store, req('/api/trash', { cookie }));
  assert.equal(list.data.books[0].restorable, false, 'restorable 必须与 apiRestore 同判据（#145 P1-1 三处同步）');
  assert.equal(list.data.books[0].purging, true, '列表态要透出占用标记');
});

test('P1-1 纯 purge:[] 崩溃残留（无 purging）：按「正文完好」放行恢复', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '崩溃残留书', 2);
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  // 2026-10-06 之前版本的崩溃态：purge:[] 无 purging。判据不能退回「字段存在」（那会让一次
  // 中断的书永久不可恢复），也不能只看长度忽略占用标记 —— 两类状态必须分离。
  setTrash(store, (t) => {
    t.books[0].purge = [];
  });

  const r = await call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
  assert.equal(r.status, 200, '无占用标记的 purge:[] 是崩溃残留 → 正文完好，应放行');
  const idx = await readIdxBooks(store);
  assert.ok(idx.some((b) => b.id === id), '恢复后应回到书架');
  assert.equal(JSON.parse(store._map.get(KEY.TRASH)).books.length, 0, '恢复成功 → 条目摘除');
});

test('P1-1 真竞态：restore 快照读之后 purge 才写占用标记 → CAS 重放必须检出让路并回滚索引', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '竞态书', 45); // 45 > 30：首批删不完，条目带占用标记留下
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));

  const og = store.getTextWithEtag.bind(store);
  let armed = true;
  store.getTextWithEtag = async (k) => {
    if (armed && k === KEY.TRASH) {
      armed = false;
      // restore 读 trash 快照的同一刹那，另一台设备的彻底删除开飞
      // （CAS 写占用标记 → 删 30 章 → 条目带 purging + purge:left 留下）
      await call(store, req(`/api/trash/${id}`, { method: 'DELETE', cookie }));
    }
    return og(k);
  };
  try {
    const r = await call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
    assert.equal(r.status, 409, '重放看到占用标记必须 raced → 409（只比 deletedAt 会穿透：purgeOnce 不动 deletedAt）');
    const idx = await readIdxBooks(store);
    assert.ok(!idx.some((b) => b.id === id), 'raced 后必须回滚 upsert 的索引副本（残缺书在架比不在架更糟）');
    const t = JSON.parse(store._map.get(KEY.TRASH));
    assert.ok(t.books.some((b) => b.id === id && b.purging), '权威记录应留在回收站（带占用标记，等 sweep 续清）');
  } finally {
    store.getTextWithEtag = og;
  }
});

test('P1-2 真竞态：publish 的 CAS 窗口内书被并发软删 → upsert 前复检必须 409，不成双态', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeDraftBook(store, cookie, '半成品发布书', 2); // creating：不在索引
  for (const k of keys) await putCh(store, cookie, id, k, '正文' + k);

  const origIf = store.putTextIf.bind(store);
  let armed = true;
  store.putTextIf = async (k, s, etag) => {
    if (armed && k === KEY.book(id)) {
      armed = false;
      // publish 的 meta CAS 写成功这一刻，另一台设备在书架删掉这本书
      // （软删只写 trash、不碰 meta → 这边的 CAS 照常成功）
      await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
    }
    return origIf(k, s, etag);
  };
  try {
    const r = await publish(store, cookie, id);
    assert.equal(r.status, 409, 'CAS 之后还有整个 sweepOrphans+mutateMeta 窗口 → upsert 前必须复检 trash');
    const idx = await readIdxBooks(store);
    assert.ok(!idx.some((b) => b.id === id), '不得 upsert → 在架+回收站双态（purge 后会删掉一本在架书）');
    const t = JSON.parse(store._map.get(KEY.TRASH));
    assert.ok(t.books.some((b) => b.id === id), '书应留在回收站：可恢复、可重试，失败落在安全侧');
  } finally {
    store.putTextIf = origIf;
  }
});

test('P2-9 append 幂等令牌：同 batch 重放不重复追加（章表/字数/keys 全同）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '追章书', 3);
  const w0 = (await rawMeta(store, id)).wordCount;
  const batch = 'a1b2c3d4e5f60718'; // 客户端按文件内容 SHA-256 前 8 字节派生的 16 hex
  const body = { op: 'append', chapters: ['续一章', '续二章'], wordCount: 20, batch };

  const r1 = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body }));
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  // 第一次 append 成功、正文 bulk 上传中途网络失败 → 用户重试再选「追加」：同令牌再来
  const r2 = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body }));
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.deepEqual(r2.data.chapterKeys, r1.data.chapterKeys, '同令牌必须回放已登记的 keys，不得再追加（旧实现尾追加两遍、第一套空壳阅读 404）');

  const meta = await rawMeta(store, id);
  assert.equal(meta.chapters.length, 5, '章表只追加一次（原 3 + 新 2）');
  assert.equal(meta.wordCount, w0 + 20, '字数只加一次');
  assert.equal(meta.pending.batch, batch, '批次登记在 meta.pending（publish 成功时清除）');
  assert.equal(meta.pending.keys.length, 5, '登记的是当时的全量 keys');
});

test('P2-9 replace 作废旧批次登记；publish 是幂等登记的终点', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '重洗书', 3);
  const batch = '0f1e2d3c4b5a6978';
  await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['续'], wordCount: 5, batch } }));
  assert.equal((await rawMeta(store, id)).pending.batch, batch, '前置：登记在');

  // replace 全量重写章表 → 半成品登记一并作废
  let r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['新甲', '新乙'], wordCount: 6 } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await rawMeta(store, id)).pending, undefined, 'replace 后 pending 应作废');

  // 作废后再带旧令牌 append：按新批次正常追加（不再是「回放」）
  r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['再续'], wordCount: 3, batch } }));
  assert.equal(r.status, 200);
  assert.equal((await rawMeta(store, id)).chapters.length, 3, '旧令牌已作废 → 正常追加一章');

  // publish 要抽样校验首/中/尾章存在 → 先把所有新章正文补上
  const m2 = await rawMeta(store, id);
  for (const c of m2.chapters) await putCh(store, cookie, id, c.key, '正文' + c.key);
  await publish(store, cookie, id);
  assert.equal((await rawMeta(store, id)).pending, undefined, 'publish 是完整入库的终点，登记应被清掉');
});

test('P2-9 batch 非 16 位 hex → 忽略（不登记 pending、不早退回放）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '脏令牌书', 2);
  for (const bad of ['zz', 'A1B2C3D4E5F60718', 'a1b2c3d4e5f6071', 'a1b2c3d4e5f607189']) {
    let r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['x'], wordCount: 1, batch: bad } }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const meta = await rawMeta(store, id);
  assert.equal(meta.pending, undefined, '非法令牌不得登记 pending（登记了反而把回放语义露给乱传的客户端）');
  assert.equal(meta.chapters.length, 6, '四个非法批次各追加一章（不幂等 —— 与不带令牌的既有行为一致）');
});

test('P2-10 改章 CAS 冲突耗尽 → 409 且正文不落盘（旧写序先落盘 → 重试增量算成 0）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, '改字书', 2);
  const tkey = KEY.text(id, keys[0]);
  const oldText = await store.getText(tkey);

  // 让 meta CAS 永远失败：并发方持续改无关字段推进版本号
  const origIf = store.putTextIf.bind(store);
  store.putTextIf = async (k, s, etag) => {
    if (k === KEY.book(id)) {
      const cur = JSON.parse(await store.getText(k));
      cur.note = '并发方';
      await origIf(k, JSON.stringify(cur), undefined);
      return null; // 我们的 CAS 失败 → mutateMeta 重试耗尽
    }
    return origIf(k, s, etag);
  };
  try {
    const r = await patchCh(store, cookie, id, keys[0], { content: '新正文内容' });
    assert.equal(r.status, 409);
    assert.equal(await store.getText(tkey), oldText, '正文不得先于 CAS 落盘（旧写序下 409 后盘上已是新正文 → 重试增量 0 → 字数永久少计）');
  } finally {
    store.putTextIf = origIf;
  }
});

test('P2-10 重试自愈：CAS 失败一次后原样重发 → 字数全额修正（旧实现把增量吞成 0）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, '重试书', 2);
  const w0 = (await rawMeta(store, id)).wordCount;
  const delta = countWords('新正文内容') - countWords(await store.getText(KEY.text(id, keys[0])));

  // 第一次 patch：CAS 冲突耗尽 → 409（客户端照旧原样重发）
  const origIf = store.putTextIf.bind(store);
  let armed = true;
  store.putTextIf = async (k, s, etag) => {
    if (armed && k === KEY.book(id)) {
      const cur = JSON.parse(await store.getText(k));
      cur.note = '并发方';
      await origIf(k, JSON.stringify(cur), undefined);
      return null; // 我们的 CAS 失败 → mutateMeta 重试耗尽
    }
    return origIf(k, s, etag);
  };
  try {
    const r1 = await patchCh(store, cookie, id, keys[0], { content: '新正文内容' });
    assert.equal(r1.status, 409);
  } finally {
    store.putTextIf = origIf;
  }
  const r2 = await patchCh(store, cookie, id, keys[0], { content: '新正文内容' }); // 原样重发
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const meta = await rawMeta(store, id);
  assert.equal(meta.wordCount, w0 + delta, '重试必须按新内容全额修正（旧实现：正文已落盘 → 重试读到「旧正文」= 新正文 → 增量 0 → 少计一次）');
  assert.equal(meta.chapters[0].words, countWords('新正文内容'), '章条目登记 words 基线（随 meta 原子落盘）');
  assert.equal(await store.getText(KEY.text(id, keys[0])), '新正文内容');
});

test('P2-10 老数据兜底与删章扣减：条目无 words 时按盘面兜底，之后以条目为基线扣减', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, '兜底书', 2);
  const w0 = (await rawMeta(store, id)).wordCount;
  // 老数据：章条目没有 words 字段（P2-10 之前创建的书）
  const m = await rawMeta(store, id);
  delete m.chapters[0].words;
  delete m.chapters[1].words;
  await store.putText(KEY.book(id), JSON.stringify(m));

  const r1 = await patchCh(store, cookie, id, keys[0], { content: '改动后的第一章正文' });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const w1 = (await rawMeta(store, id)).wordCount;
  assert.equal(w1, w0 + countWords('改动后的第一章正文') - countWords('第1章正文'), '老数据首次修改按盘面兜底算增量');

  // 删另一章：扣减基线取条目 words（此时第 1 章已登记，第 2 章仍是老数据 → 盘面兜底）
  const r2 = await call(store, req(`/api/books/${id}/chapters/${keys[1]}`, { method: 'DELETE', cookie }));
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const after = await rawMeta(store, id);
  assert.equal(after.chapters.length, 1);
  assert.equal(after.wordCount, w1 - countWords('第2章正文'), '删章按基线扣减（条目优先、盘面兜底）');
});

test('P3-3 软删半成品书续传正文 → 409（purge 时连 meta 一并删，白写）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeDraftBook(store, cookie, '半成品书', 2);
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie })); // 软删 creating 书 → 条目进 trash 等 purge

  const r = await putCh(store, cookie, id, keys[0], '迟到的正文');
  assert.equal(r.status, 409, '单章直写路径必须挡掉「已软删等 purge」的书');
  assert.ok(!store._map.has(KEY.text(id, keys[0])), '不得落盘');
  const rb = await call(
    store,
    req(`/api/books/${id}/chapters/bulk`, { method: 'POST', cookie, body: { chapters: [{ key: keys[0], text: '迟到的正文' }] } })
  );
  assert.equal(rb.status, 409, 'bulk 路径同判');
  assert.ok(!store._map.has(KEY.text(id, keys[0])), 'bulk 也不得落盘');

  // 对照：未软删的半成品书照常可写（守卫不能误伤正常上传）
  const fresh = await makeDraftBook(store, cookie, '正常半成品', 2);
  const ok = await putCh(store, cookie, fresh.id, fresh.keys[0], '正常正文');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(await store.getText(KEY.text(fresh.id, fresh.keys[0])), '正常正文');
});

test('P3-4 replace 进度迁移 CAS 化：迁移窗口内的并发阅读写入不得被覆盖', async () => {
  const store = memStore();
  const cookie = await login(store);
  const r0 = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '迁移书', chapters: ['甲章', '乙章', '丙章'], wordCount: 30 } }));
  const id = r0.data.id;
  for (const k of ['1', '2', '3']) await putCh(store, cookie, id, k, '正文' + k);
  await publish(store, cookie, id);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 2, ratio: 0.4 } })); // 在第 2 章

  // 迁移「读进度」的那一刻，另一台设备刚好写下新进度（读到的快照是旧的）
  const og = store.getText.bind(store);
  let armed = true;
  store.getText = async (k) => {
    const r = await og(k);
    if (armed && k === KEY.progress(id)) {
      armed = false;
      await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.9 } }));
    }
    return r; // 把陈旧快照交给迁移逻辑
  };
  try {
    const r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['甲章', '乙章', '丙章'] } }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  } finally {
    store.getText = og;
  }
  const p = await getProg(store, cookie, id);
  assert.equal(p.ch, 3, '迁移必须 putIf 条件写并重读重放（旧实现无条件 putText → 并发写的 ch=3 被迁移旧快照覆盖成 ch=2）');
  assert.equal(p.ratio, 0.9, 'ratio 一并保留（不被旧快照的 0.4 覆盖）');
});

test('P3-4 publish 的索引进度镜像以 CAS 后重读为准（入口快照早于 CAS → 角标回退）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '镜像书', 3);
  await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0.1 } }));

  // 模拟「publish 的 meta CAS 已写、镜像还没读」的窗口里用户在另一设备换了章
  const og = store.getText.bind(store);
  let casDone = false;
  let fired = false;
  const origIf = store.putTextIf.bind(store);
  store.putTextIf = async (k, s, etag) => {
    if (k === KEY.book(id)) casDone = true;
    return origIf(k, s, etag);
  };
  store.getText = async (k) => {
    if (!fired && casDone && k === KEY.progress(id)) {
      fired = true;
      await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 3, ratio: 0.8 } }));
    }
    return og(k);
  };
  try {
    const r = await publish(store, cookie, id);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  } finally {
    store.putTextIf = origIf;
    store.getText = og;
  }
  const idx = await readIdxBooks(store);
  const entry = idx.find((b) => b.id === id);
  assert.equal(entry.prog.ch, 3, '镜像必须取 CAS 后重读的值（旧实现用入口快照 ch=1 → 书架角标短暂回退）');
});

test('P3-5 插章 CAS 冲突耗尽 → 409 且新章正文零残留（旧写序先落盘 → 孤儿清扫永远扫不到）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, '插章书', 3);
  const oldCount = [...store._map.keys()].filter((k) => k.startsWith(`text/${id}/`)).length;

  const origIf = store.putTextIf.bind(store);
  store.putTextIf = async (k, s, etag) => {
    if (k === KEY.book(id)) {
      const cur = JSON.parse(await store.getText(k));
      cur.note = '并发方';
      await origIf(k, JSON.stringify(cur), undefined);
      return null;
    }
    return origIf(k, s, etag);
  };
  try {
    const r = await call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body: { title: '新插章', content: '新章正文' } }));
    assert.equal(r.status, 409);
  } finally {
    store.putTextIf = origIf;
  }
  const texts = [...store._map.keys()].filter((k) => k.startsWith(`text/${id}/`));
  assert.equal(texts.length, oldCount, '不得留下没人引用的新章正文（meta.orphans 只由 replace/sweep 登记 → 孤儿清扫扫不到它）');
  const meta = await rawMeta(store, id);
  assert.equal(meta.chapters.length, 3, '章表不变');
});

test('P3-6 首刊同名终判：并发新建的同名书，第二本发布必须 409', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 两个标签页同书名并发新建：create 期判重互相看不到对方（两份 creating 书都不在索引）→ 都放行
  const a = await makeDraftBook(store, cookie, '同名书', 2);
  const b = await makeDraftBook(store, cookie, '同名书', 2);
  for (const k of a.keys) await putCh(store, cookie, a.id, k, '甲本正文' + k);
  for (const k of b.keys) await putCh(store, cookie, b.id, k, '乙本正文' + k);

  const ra = await publish(store, cookie, a.id);
  assert.equal(ra.status, 200, JSON.stringify(ra.data));
  const rb = await publish(store, cookie, b.id);
  assert.equal(rb.status, 409, '首刊 upsert 前必须全量终判同名（旧实现 → 书架两张同名卡）');
  assert.match(String(rb.data.error), /同名/);

  const idx = await readIdxBooks(store);
  assert.ok(idx.some((x) => x.id === a.id), '第一本在架');
  assert.ok(!idx.some((x) => x.id === b.id), '第二本不得上架');
});

test('P3-8 readTrash 形状校验：trash.json 结构坏时列表与 publish 链路不 500', async () => {
  for (const bad of ['{}', '[]', 'null', '{"books":null}', '{"books":"x"}']) {
    const store = memStore();
    const cookie = await login(store);
    const { id } = await makeReadyBook(store, cookie, '坏trash书', 2);
    await store.putText(KEY.TRASH, bad); // 合法 JSON、结构错（readJson 不校验形状）
    const r = await call(store, req('/api/trash', { cookie }));
    assert.equal(r.status, 200, `${bad} → 列表应 200`);
    assert.deepEqual(r.data.books, [], `${bad} → 归一为空表`);
    // publish 的回收站守卫同走 readTrash（旧实现 TypeError → 500）
    const p = await publish(store, cookie, id);
    assert.equal(p.status, 200, `${bad} → publish 不应 500`);
  }
});

test('P3-9 method 不匹配回 405；非法 id 带 body → 404 正常收尾（dropBody 排空）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const wrong = [
    ['PATCH', '/api/login', { password: 'x' }],
    ['PUT', '/api/trash/whatever', { a: 1 }],
    ['DELETE', '/api/progress/whatever', { a: 1 }],
    ['GET', '/api/books/x/publish', undefined],
  ];
  for (const [method, p, body] of wrong) {
    const r = await call(store, req(p, { method, cookie, body }));
    assert.equal(r.status, 405, `${method} ${p} 应 405（子路由 method 不匹配不能落到 404）`);
  }
  // 非法 id + 带 body：notFound 前必须排空 body（其余 404 点都有，漏了就挂着请求体返回）
  const r = await call(store, req('/api/books/..%2F..%2Fetc', { method: 'PATCH', cookie, body: { x: 1 } }));
  assert.equal(r.status, 404, '非法 id → 404');
});

test('P3-10 /opds、/export 瞬时故障回 JSON 502；worker 入口兜底回 JSON 500', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OPDS书', 2);
  // R2 瞬时抖动：所有读抛错
  const broken = { ...store, getText: async () => { throw new Error('r2 down'); } };
  const r1 = await call(broken, req('/opds', { cookie }));
  assert.equal(r1.status, 502, '/opds 应转 JSON 502（旧行为：异常冒到顶层 → 平台默认 HTML 500）');
  assert.match(r1.headers.get('content-type') || '', /json/);
  const r2 = await call(broken, req(`/export/${id}.txt`, { cookie }));
  assert.equal(r2.status, 502, '/export 同判');
  assert.match(r2.headers.get('content-type') || '', /json/);

  // worker 入口兜底：env 绑定缺失 → 内部炸裂也必须回 JSON
  const { default: worker } = await import('../src/worker.js');
  const env = { ...ENV, NOVELS: null, ASSETS: { fetch: async () => new Response('asset') } };
  const r3 = await worker.fetch(new Request(BASE + '/api/books', { headers: { Cookie: cookie } }), env);
  assert.equal(r3.status, 500);
  assert.match(r3.headers.get('content-type') || '', /json/, '入口异常也要 JSON，别冒 HTML 500');
});

test('P3-11 惰性清理三态门控：只有同源请求触发 trash sweep（跨站/无头不蹭删除副作用）', async () => {
  const cases = [
    ['same-origin', true],
    ['cross-site', false],
    [null, false], // 老客户端没有该头
  ];
  for (const [site, swept] of cases) {
    const store = memStore();
    const cookie = await login(store);
    const { id } = await makeReadyBook(store, cookie, '过期书', 2);
    await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie })); // 软删
    setTrash(store, (t) => {
      t.books[0].deletedAt = Date.now() - 16 * 86400000; // 超过 TRASH_DAYS=15
    });
    const r = site
      ? await call(store, req('/api/trash', { cookie, headers: { 'sec-fetch-site': site } }))
      : await call(store, new Request(BASE + '/api/trash', { headers: { Cookie: cookie } }));
    assert.equal(r.status, 200);
    const left = JSON.parse(store._map.get(KEY.TRASH)).books.length;
    assert.equal(!store._map.has(KEY.text(id, '1')), swept, `sec-fetch-site=${site} 时 sweep ${swept ? '应触发' : '不应触发'}`);
    assert.equal(!store._map.has(KEY.book(id)), swept, 'meta 清理与正文同步');
    assert.equal(left === 0, swept, '清完后回收站条目摘除；未触发时条目原样留在');
  }
});

test('P3-11 孤儿清扫同源门控：跨站 GET 目录不触发清扫（SameSite=Lax 下跨站顶层 GET 带 Cookie）', async () => {
  const mk = async () => {
    const store = memStore();
    const cookie = await login(store);
    const { id } = await makeReadyBook(store, cookie, '孤儿书', 2);
    // 铺一个孤儿（replace 遗留）：meta.orphans 非空 → 同源 GET 会顺手清
    const m = await rawMeta(store, id);
    m.orphans = ['999'];
    await store.putText(KEY.book(id), JSON.stringify(m));
    await store.putText(KEY.text(id, '999'), '孤儿正文');
    return { store, cookie, id };
  };
  const same = await mk();
  const r1 = await call(same.store, req(`/api/books/${same.id}`, { cookie: same.cookie, headers: { 'sec-fetch-site': 'same-origin' } }));
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.ok(!same.store._map.has(KEY.text(same.id, '999')), '同源 GET 应顺手清掉孤儿正文');
  assert.equal((await rawMeta(same.store, same.id)).orphans, undefined, '孤儿表作废');

  const cross = await mk();
  const r2 = await call(cross.store, req(`/api/books/${cross.id}`, { cookie: cross.cookie, headers: { 'sec-fetch-site': 'cross-site' } }));
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.ok(cross.store._map.has(KEY.text(cross.id, '999')), '跨站 GET 不得触发清扫（读请求的写副作用要收敛）');
});

test('P3-1 分片数熔断：K>40 时 tags/create/diag 全回 409（不 500、不死循环续调）', async () => {
  const store = memStore();
  const cookie = await login(store);
  await store.putText('meta/idx/root.json', JSON.stringify({ v: 2, shards: 49, map: {} }));
  const probes = [
    ['GET', '/api/tags', undefined],
    ['POST', '/api/tags', { from: '甲', to: '乙' }],
    ['POST', '/api/books', { title: '新书', chapters: ['第一章'] }],
    ['GET', '/api/diag/orphans', undefined],
    ['DELETE', '/api/diag/orphans', { objects: ['text/deadbeef/1'] }],
  ];
  for (const [method, p, body] of probes) {
    const r = await call(store, req(p, { method, cookie, body }));
    assert.equal(r.status, 409, `${method} ${p} 应熔断 409（实测 ${r.status}）`);
    assert.ok(r.data.error, '必须带可操作指引');
  }
});

/* ==================== B 组 · 源码级判据 ==================== */

test('P1-1 purgeOnce 写占用标记两处 + restore/restorable 三处判据同源', () => {
  const src = routerSrc();
  const p = src.indexOf('async function purgeOnce(');
  const body = src.slice(p, src.indexOf('\nasync function', p + 10));
  assert.match(body, /purge: left, purgeCursor: nextCursor, purging: true/, 'CAS 标记必须带 purging（nextCursor 分支）');
  assert.match(body, /t\.books\[i\] = \{ \.\.\.rest, purge: left, purging: true \};/, 'CAS 标记必须带 purging（全部列完分支）');
  // 恢复侧三处：入口判据 / CAS 重放判据 / 列表 restorable
  const r = src.indexOf('async function apiRestore(');
  assert.match(src.slice(r, r + 1500), /if \(entry\.purging \|\|/, 'apiRestore 入口判据认 purging');
  assert.match(src.slice(r, r + 4000), /if \(t\.books\[i\]\.purging \|\|/, 'apiRestore 重放判据认 purging');
  const l = src.indexOf('async function apiTrashList(');
  assert.match(src.slice(l, l + 1200), /restorable: !b\.purging &&/, 'apiTrashList restorable 认 purging');
});

test('P1-2 publish 的 trash 复检在 upsert 之前（快照检查之后还有整个 mutateMeta 窗口）', () => {
  const src = routerSrc();
  const p = src.indexOf('async function apiPublish(');
  const body = src.slice(p, src.indexOf('\nasync function', p + 10));
  const cas = body.indexOf('const m = await mutateMeta(');
  const recheck = body.indexOf('const trash2 = await readTrash(store)');
  const upsert = body.indexOf('idx.upsert(id, indexEntryFromMeta');
  assert.ok(cas > 0 && recheck > cas && upsert > recheck, '写序必须是 mutateMeta → trash2 复检 → upsert（复检漏一步就会把软删书复活上架）');
  assert.match(body, /trash2\.books\.some\(\(b\) => b\.id === id\)/, '复检判据与入口一致');
  // progress 镜像源也必须在 CAS 之后（P3-4）：入口并行块里不得再取 ptRaw
  assert.ok(!/ptRaw/.test(body), 'publish 不得再从入口并行块取进度快照（CAS 后单独重读）');
  assert.match(body, /const pt = await store\.getText\(KEY\.progress\(id\)\)/, 'CAS 后重读进度');
});

test('P3-4 replace 进度迁移：每轮重读 + putIf 条件写 + updatedAt 现取', () => {
  const src = routerSrc();
  const u = src.indexOf('async function apiUpdateChapters(');
  const body = src.slice(u, src.indexOf('\nasync function', u + 10));
  assert.match(body, /const got = await getWithEtag\(store, KEY\.progress\(id\)\);/, '每轮重读现版本');
  assert.match(body, /const res = await putIf\(store, KEY\.progress\(id\), JSON\.stringify\(next\), etag\);/, '必须 putIf 条件写');
  assert.ok(!/store\.putText\(KEY\.progress\(id\)/.test(body), '不得无条件 putText（并发阅读写入会被覆盖）');
  assert.ok(!/updatedAt: now/.test(body), '不得复用请求开始时的 now（时间轴倒退让进度 OCC 的 baseAt 判据失效）');
  assert.match(body, /updatedAt: Date\.now\(\)/, '每次重试现取时间');
});

test('P3-5 插章/改章的正文落盘都在 CAS 成功之后', () => {
  const src = routerSrc();
  const ins = src.indexOf('async function apiInsertChapter(');
  const insBody = src.slice(ins, src.indexOf('\nasync function', ins + 10));
  const insCas = insBody.indexOf('const m = await mutateMeta(');
  const insPut = insBody.indexOf('await store.putText(KEY.text(id, key), content)');
  assert.ok(insCas > 0 && insPut > insCas, '插章正文必须 CAS 后才落盘');
  assert.match(insBody, /return json\(\{ error: '正文写入失败，请重试' \}, 409\);/, '落盘失败要单独报 409（不得静默成功：章已入表而正文缺失 → 阅读 404）');
  const pat = src.indexOf('async function apiPatchChapter(');
  const patBody = src.slice(pat, src.indexOf('\nasync function', pat + 10));
  const patCas = patBody.indexOf('const m = await mutateMeta(');
  const patPut = patBody.indexOf('await store.putText(KEY.text(id, key), body.content)');
  assert.ok(patCas > 0 && patPut > patCas, '改章正文必须 CAS 后才落盘');
});

test('P3-2 批量路径每本预扣 4（mutateMeta tries=2 最坏 4 子请求）+ tries 实参', () => {
  const src = routerSrc();
  const b = src.indexOf('async function apiBatchBooks(');
  const body = src.slice(b, src.indexOf('\nasync function', b + 10));
  assert.match(body, /const est = \(action === 'delete' \? 5 \+ 3 \* newS : 1 \+ 3 \* newS \+ 4 \* \(processed\.length \+ 1\)\) \+ replay;/, '非删除路径每本预扣 4（原 2：撞冲突时越过 48 账面）');
  assert.match(body, /\}, null, 2\)/, 'mutateMeta 调用必须显式 tries=2');
  const t = src.indexOf('async function apiTagsMerge(');
  assert.match(src.slice(t, t + 4800), /\}, null, 2\)/, 'tagsMerge 同样 tries=2');
});

test('P3-7 clientIp 取 xff 最后一段；brute 截断不淘汰锁定中的记录', () => {
  const src = routerSrc();
  const c = src.indexOf('function clientIp(req)');
  const cBody = src.slice(c, c + 700);
  assert.match(cBody, /parts\[parts\.length - 1\]/, '必须取代理链最后一段（取整条 xff 让每种伪造组合都是新「IP」，爆破计数键形同虚设）');
  const n = src.indexOf('function normalizeBrute(');
  const nBody = src.slice(n, n + 900);
  assert.match(nBody, /\.filter\(\(\[, rec\]\) => \(rec\.until \|\| 0\) <= now\)/, '淘汰名单必须排除锁定中的记录（按 updatedAt 裁会把刚锁上的记录删掉 → 锁静默解除）');
});

test('P3-3 两条正文直写路径都有 trash 守卫（且不用 indexHas —— creating 书不进索引）', () => {
  const src = routerSrc();
  assert.match(src, /const inTrash = async \(store, id\) =>/, '守卫判据要收口成共用函数');
  const put1 = src.indexOf('async function apiPutChapter(');
  const b1 = src.slice(put1, src.indexOf('\nasync function', put1 + 10));
  assert.match(b1, /if \(await inTrash\(store, id\)\)/, 'apiPutChapter 必须查 trash');
  const put2 = src.indexOf('async function apiPutChapters(');
  const b2 = src.slice(put2, src.indexOf('\nasync function', put2 + 10));
  assert.match(b2, /if \(await inTrash\(store, id\)\)/, 'apiPutChapters 必须查 trash');
  // 两个函数体里不得出现 indexHas（creating 书压根不进索引，用了会把正常上传全拦成 404）
  assert.ok(!/indexHas/.test(b1) && !/indexHas/.test(b2), 'put 路径不得用 indexHas');
});

test('P2-3 reader 内 401 三处收敛到 sessionExpired（下载/导出/goto 不再显示英文 unauthorized）', () => {
  const r = read('public/js/reader.js');
  assert.match(r, /function sessionExpired\(\) \{/, '统一收敛出口必须存在');
  assert.match(r, /export function setOnExpire\(fn\) \{/, '收敛回调可注入（reader 不 import app.js，避免环依赖）');
  const dl = r.indexOf('async function downloadCurrent(');
  const dlBody = r.slice(dl, r.indexOf('\nasync function', dl + 10));
  assert.match(dlBody, /if \(e instanceof ApiError && e\.status === 401\) \{\s*\n\s*sessionExpired\(\);\s*\n\s*return;/, '下载 401 → 收敛并 return（不得再落到英文 message 透传，用户被困阅读器）');
  const ex = r.indexOf('async function exportCurrentText(');
  const exBody = r.slice(ex, r.indexOf('\nasync function', ex + 10));
  assert.match(exBody, /if \(e instanceof ApiError && e\.status === 401\) \{\s*\n\s*sessionExpired\(\);\s*\n\s*return;/, '导出 401 → 收敛');
  const gt = r.indexOf('function goto(idx)');
  const gtBody = r.slice(gt, r.indexOf('\nfunction', gt + 10));
  assert.match(gtBody, /if \(e instanceof ApiError && e\.status === 401\) sessionExpired\(\);/, '翻章 401 → 收敛（中文提示 + 收敛，与 loadChapter 范式一致）');
});

test('P2-4/P2-5 删书 catch 补 handleAuth；finishLogout 推进 shelfSeq；bindReader 后注入 onExpire', () => {
  const app = read('public/js/app.js');
  const del = app.indexOf('await api.deleteBook(b.id);');
  const delBody = app.slice(del, del + 700);
  assert.match(delBody, /if \(handleAuth\(e\)\) return;/, '「移入回收站」的 catch 必须有 handleAuth（会话失效重试永远失败，还弹误导性业务 toast）');
  const f = app.indexOf('async function finishLogout(');
  const fBody = app.slice(f, f + 1600);
  assert.match(fBody, /shelfSeq\+\+;/, '登出必须推进世代（否则在途 loadShelf 的 200 把前任书架写回 localStorage）');
  // #149：bindReader / setOnExpire 一起搬进 ensureReader 的 then 里。
  // 顺序仍要守 —— onExpire 必须在 bindReader 之后注入（reader 内部用同一个 state 存回调）。
  const erStart = app.indexOf('function ensureReader()');
  const erEnd = app.indexOf('function closeReaderIfLoaded()', erStart);
  assert.ok(erStart > 0 && erEnd > erStart, '找不到 ensureReader 的边界锚点（closeReaderIfLoaded）');
  const erBody = app.slice(erStart, erEnd);
  assert.match(erBody, /m\.bindReader\(/, 'ensureReader 必须绑定阅读器根节点');
  assert.match(erBody, /m\.setOnExpire\(\(\) => expireSession\(\)\)/, 'bindReader 后必须注入会话过期收敛回调');
  assert.ok(erBody.indexOf('m.bindReader(') < erBody.indexOf('m.setOnExpire('), 'onExpire 必须在 bindReader 之后注入');
});

test('P2-6 sw 白名单放行 /opds 与 /opds/ 两种形态', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /url\.pathname === '\/opds' \|\| url\.pathname === '\/opds\/'/, '漏放 /opds/ → 已鉴权 OPDS 全目录进 SW 缓存，登出后仍可读');
});

test('P2-7 prepareFile 读字节窗口有忙态（handleFiles try/finally 成对置位）', () => {
  const f = read('public/js/upload/files.js');
  const h = f.indexOf('export async function handleFiles(');
  const body = f.slice(h, f.indexOf('\nasync function', h + 10));
  assert.match(body, /upSession\.setReading\(true\);/, '读字节窗口开始前置忙态');
  assert.match(body, /\} finally \{[\s\S]{0,200}upSession\.setReading\(false\);/, '异常路径也要还原（try/finally 成对）');
  const s = read('public/js/upload/session.js');
  assert.match(s, /return _uploading \|\| _importing \|\| _reading;/, 'isBusy 必须含读字节窗口（双选重叠 → 「书名 A / 正文 B」坏书）');
});

test('P2-8/P3-12 前端世代守卫与批量导入收尾', () => {
  const ed = read('public/js/upload/editor.js');
  const sv = ed.indexOf("save.addEventListener('click'");
  const svBody = ed.slice(sv, sv + 1600);
  assert.match(svBody, /if \(ceAliveAt\(gen\)\) \{[\s\S]{0,400}ceState\.dirty = true;/, '标题保存 await 后的状态写入必须有世代守卫（迟到响应会把旧书字数写进新弹层）');
  const ins = ed.indexOf('async function ceInsert(');
  const insBody = ed.slice(ins, ed.indexOf('\nasync function', ins + 10));
  assert.match(insBody, /if \(ceAliveAt\(gen\)\)\s*\{?\s*\n?\s*ceState\.dirty = true;/, 'ceInsert 的 dirty 置位同样要守卫');
  const fi = read('public/js/upload/files.js');
  const ib = fi.indexOf('async function importBatch(');
  const ibBody = fi.slice(ib, fi.indexOf('\nasync function', ib + 10));
  assert.match(ibBody, /els\.upNoSplit\.checked = !!prevNoSplit;/, '确认弹窗取消后必须还原「不分章」勾选态（#141 的复位发生在弹窗前，白还原）');
  assert.match(ibBody, /failTitles\.push\(title\);/, '解析出 0 章的文件要留名');
  assert.match(ibBody, /未解析出章节：\$\{failTitles\.join\('、'\)\}/, '收尾 toast 要点名（只计 fail++ 时用户看不到任何原因）');
});

test('P2-9 客户端按文件内容派生稳定批次令牌（SHA-256 前 8 字节 hex）', () => {
  const u = read('public/js/upload/upload.js');
  assert.match(u, /crypto\.subtle\.digest\('SHA-256', session\.bytes\)/, '令牌必须由文件内容派生（同一文件重试 → 同令牌 → 服务端回放）');
  assert.match(u, /\.slice\(0, 8\)\.map\(\(b\) => b\.toString\(16\)\.padStart\(2, '0'\)\)\.join\(''\)/, '前 8 字节 → 16 位 hex（与服务端 \/^[0-9a-f]{16}$\/ 对齐）');
  assert.match(u, /\.\.\.\(batch \? \{ batch \} : \{\}\)/, '只在 append 且派生出令牌时带上');
});

test('P3-11 两处惰性清理的同源门控语义一致（都要求 positive same-origin 证据）', () => {
  const src = routerSrc();
  const t = src.indexOf('async function apiTrashList(');
  assert.match(src.slice(t, t + 1200), /req && req\.headers\.get\('sec-fetch-site'\) === 'same-origin'/, '回收站 sweep 门控');
  const b = src.indexOf('async function apiBookMeta(');
  assert.match(src.slice(b, b + 1200), /const maySweep = req && req\.headers\.get\('sec-fetch-site'\) === 'same-origin';/, '孤儿清扫门控（与 trash 侧逐字一致，不吃 !req 兜底）');
});
