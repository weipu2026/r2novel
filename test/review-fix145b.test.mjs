/* review-fix145b.test.mjs — 2026-10-16 #145 复验收尾 R1–R6 的定向回归
 *
 * 判据落在「请求本身 / 判定分支 / 盘面终态」上；每条都对应「改回旧写法必然不通过」。
 * 竞态用例用 store 钩子在**确定性时机**（restore 的 trash 摘除写落盘前一刻）注入并发动作。
 *
 * A 组 · 行为级（HTTP 驱动 router）：
 *   R1  append 回放令牌的章节签名：同令牌换拆分 → 409 指路 replace；legacy 无 sig → 409；
 *       同令牌同拆分仍正常回放（不得误伤）
 *   R2  插章正文写失败补偿：409 + 章表/字数回退 + 无正文残留
 *   R3  restore 摘除写前的三种并发：purge 删光 → 409 回滚；并发恢复成功 → 200 不回滚；
 *       恢复后再软删 → 409「已被再次删除」
 *   R4  publish 两个 409 出口前同步 status 副档（st/<id>）；同名终判全量读故障 fail-open
 *   R5  同名终判的 K 门控：K=1 照跑（409）；K=5 跳过（200）
 *
 * B 组 · 源码级判据（正则带函数体结构，防注释同名喂假绿）：
 *   R1~R6 的写序/门控锚点（回放 sig、补偿 mutateMeta、vanished/redo 分流、
 *   putStatus 两处、shardCount<=4、trashRow 三态文案）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memStore, req, call, login, makeReadyBook, makeDraftBook, readIdxBooks, writeIdxShards, writeIdxBooks } from './_harness.mjs';
import { KEY } from '../src/router.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 仓库文件是 CRLF：断言正则里的 \n 必须在归一后匹配（否则多行正则静默失配 = 假红）
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const routerSrc = () => read('src/router.js');
const rawMeta = async (store, id) => JSON.parse(await store.getText(KEY.book(id)));
const restore = (store, cookie, id) => call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
const softDel = (store, cookie, id) => call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
const purgeOnce = (store, cookie, id) => call(store, req(`/api/trash/${id}`, { method: 'DELETE', cookie }));
const insertCh = (store, cookie, id, body) => call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body }));
const publish = (store, cookie, id) => call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
const publishBook = async (store, cookie, title, n = 2) => {
  const { id, keys } = await makeDraftBook(store, cookie, title, n);
  for (const k of keys) await call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PUT', cookie, body: '第' + k + '章正文' }));
  return { id, keys };
};

/** 在「restore 对 trash 的摘除写」真正落盘前一刻执行并发动作（嵌套调用不递归触发）。
 *  判据 = 写入内容里该书已不在 trash（标记写带条目 → 不命中；嵌套 purge/restore 的
 *  摘除写 → nested 保护）。返回还原函数，调用方 finally 必须调用。 */
const hookRestoreStrip = (store, id, action) => {
  const origIf = store.putTextIf.bind(store);
  let armed = true;
  let nested = false;
  store.putTextIf = async (k, s, etag) => {
    if (k === KEY.TRASH && armed && !nested) {
      let strip = false;
      try {
        strip = !(JSON.parse(s).books || []).some((b) => b.id === id);
      } catch {
        /* 写坏的内容不拦 */
      }
      if (strip) {
        armed = false;
        nested = true;
        try {
          await action();
        } finally {
          nested = false;
        }
      }
    }
    return origIf(k, s, etag);
  };
  return () => {
    store.putTextIf = origIf;
  };
};

/* ==================== A 组 · 行为级 ==================== */

test('R1 同令牌同拆分仍正常回放（签名判据不得误伤幂等重试）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '签名回放书', 3);
  const body = { op: 'append', chapters: ['续一章', '续二章'], wordCount: 20, batch: 'a1b2c3d4e5f60718' };
  const r1 = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body }));
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const r2 = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body }));
  assert.equal(r2.status, 200, '同文件同拆分重试 → 令牌+签名都匹配，必须照常回放（P2-9 语义不被 R1 破坏）');
  assert.deepEqual(r2.data.chapterKeys, r1.data.chapterKeys);
  assert.equal((await rawMeta(store, id)).chapters.length, 5, '不得二次追加');
});

test('R1 同令牌换拆分 → 409 指路 replace；章表/字数/pending 全部不动', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '换拆重试书', 3);
  const batch = '0f1e2d3c4b5a6978';
  await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['续一', '续二'], wordCount: 20, batch } }));
  const sigBefore = (await rawMeta(store, id)).pending.sig;
  assert.ok(sigBefore, '登记必须带章节签名');

  // 同一批令牌（文件内容没变），但客户端改了分章拆分：5 章变 3 章
  const r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['续一', '续二', '续三'], wordCount: 30, batch } }));
  assert.equal(r.status, 409, '令牌只覆盖文件字节：回放老 keys 会让新正文覆写老章、队尾新章阅读 404');
  assert.match(r.data.error, /整本替换/, '错误必须指路 replace（replace 不依赖令牌，天然覆盖这种重试）');

  const meta = await rawMeta(store, id);
  assert.equal(meta.chapters.length, 5, '章表不得追加');
  assert.equal(meta.wordCount, 50, '字数不得累加');
  assert.equal(meta.pending.keys.length, 5, '登记保持原样（客户端可带同令牌 + 同拆分续传正文）');

  // 指路真的走得通：replace 不受令牌约束
  const rp = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['新甲', '新乙'], wordCount: 6 } }));
  assert.equal(rp.status, 200, JSON.stringify(rp.data));
  assert.equal((await rawMeta(store, id)).pending, undefined, 'replace 全量重写 → 作废登记');
});

test('R1 legacy pending 无 sig（老数据）→ fail-closed 409，不裸奔回放', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '老登记书', 2);
  const batch = 'deadbeefcafe1234';
  await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['续一'], wordCount: 5, batch } }));
  // 模拟升级前落盘的登记（无 sig 字段）：直接改 _map（etag 由内容现算，不失真）
  const raw = await store.getText(KEY.book(id));
  const m = JSON.parse(raw);
  delete m.pending.sig;
  store._map.set(KEY.book(id), JSON.stringify(m));

  const r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['续一'], wordCount: 5, batch } }));
  assert.equal(r.status, 409, 'legacy 登记没有签名可比 → 宁可拒绝回放指路 replace，也不按「令牌相同」放行');
  assert.match(r.data.error, /整本替换/);
  assert.equal((await rawMeta(store, id)).chapters.length, 3, '旧章表不得动');
});

test('R2 插章正文 putText 抛错 → 409 且章表/字数回退、无正文残留', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '插章补偿书', 3);
  const w0 = (await rawMeta(store, id)).wordCount;

  // 只让**正文对象**写失败（模拟 R2 故障/瞬时不可用）；meta 的 CAS 与补偿照常走
  const origPut = store.putText.bind(store);
  store.putText = async (k, s) => {
    if (k.startsWith(`text/${id}/`)) throw new Error('r2 down');
    return origPut(k, s);
  };
  try {
    const r = await insertCh(store, cookie, id, { title: '插入章', content: '插入的正文内容' });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match(r.data.error, /正文写入失败/);
  } finally {
    store.putText = origPut;
  }

  const meta = await rawMeta(store, id);
  assert.equal(meta.chapters.length, 3, '悬挂章必须被补偿摘除（不摘 → 阅读 404，客户端重试还换新 key → 同章重复）');
  assert.equal(meta.chapterCount, 3);
  assert.equal(meta.wordCount, w0, '字数必须回退（不补偿则永久多计）');
  const listed = await store.list(`text/${id}/`);
  assert.equal(listed.objects.length, 3, '不得留下无主正文（孤儿清扫只扫登记的 key，这里干净删条目就够了）');
});

test('R3-a 摘除写前并发 purge 删光摘条目 → 409 且索引回滚（vanished 分流）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '竞态删光甲', 2);
  await softDel(store, cookie, id);
  assert.ok(JSON.parse(store._map.get(KEY.TRASH)).books.some((b) => b.id === id), '前置：在回收站');

  const unhook = hookRestoreStrip(store, id, async () => {
    // restore 的摘除写落盘前一刻，另一台设备的彻底删除跑完整个流程（CAS 标记 → 删批 →
    // 删 raw/meta/progress/st → 摘条目）。2 章书一轮删完，续调防御性收敛。
    let pr = await purgeOnce(store, cookie, id);
    let guard = 0;
    while (!pr.data.done && guard++ < 20) pr = await purgeOnce(store, cookie, id);
    assert.equal(pr.data.done, true, 'purge 应删光摘条目');
  });
  try {
    const r = await restore(store, cookie, id);
    assert.equal(r.status, 409, 'purge 摘条目后重放 → vanished raced：upsert 的副本是幽灵（正文已删，点开 404）');
    assert.match(r.data.error, /正在被彻底删除/);
  } finally {
    unhook();
  }
  const idx = await readIdxBooks(store);
  assert.ok(!idx.some((b) => b.id === id), 'raced 后必须回滚索引里的 upsert 副本');
  assert.equal(JSON.parse(store._map.get(KEY.TRASH)).books.length, 0, 'purge 已摘条目');
  assert.equal(await store.getText(KEY.book(id)), null, 'purge 已删 meta（readBook 分流：本体没了才判回滚）');
});

test('R3-b 摘除写前并发恢复成功 → 外层 200，不得回滚合法条目', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '竞态双恢复', 2);
  await softDel(store, cookie, id);

  const unhook = hookRestoreStrip(store, id, async () => {
    // 同一时刻另一台设备的恢复完整成功（索引 upsert + trash 摘除）
    const inner = await restore(store, cookie, id);
    assert.equal(inner.status, 200, '内层恢复应成功');
  });
  try {
    const r = await restore(store, cookie, id);
    assert.equal(r.status, 200, ' vanished 但本体还在 = 并发恢复已达成同一目标 → 放行（无脑回滚会删掉合法在架条目）');
  } finally {
    unhook();
  }
  const idx = await readIdxBooks(store);
  assert.ok(idx.some((b) => b.id === id), '书应留在书架（两次恢复的 upsert 内容相同，幂等）');
  assert.equal(JSON.parse(store._map.get(KEY.TRASH)).books.length, 0, '条目已由内层恢复摘除');
});

test('R3-c 摘除写前并发恢复+再软删 → 409「已被再次删除」且回滚索引', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '竞态再软删', 2);
  await softDel(store, cookie, id);
  const deletedAt0 = JSON.parse(store._map.get(KEY.TRASH)).books[0].deletedAt;

  const unhook = hookRestoreStrip(store, id, async () => {
    assert.equal((await restore(store, cookie, id)).status, 200, '内层恢复成功');
    const del = await softDel(store, cookie, id);
    assert.equal(del.status, 200, '随后又被软删一次（新条目 deletedAt 更新）');
  });
  try {
    const r = await restore(store, cookie, id);
    assert.equal(r.status, 409, '重放看到 deletedAt 变更 → 这次摘除不该生效（吃掉它会让书既不在架也不在回收站）');
    assert.equal(r.data.error, '该书已被再次删除，恢复已中止');
  } finally {
    unhook();
  }
  const idx = await readIdxBooks(store);
  assert.ok(!idx.some((b) => b.id === id), '索引回滚：书不在架（最后一次索引写是再软删的 remove）');
  const t = JSON.parse(store._map.get(KEY.TRASH)).books;
  assert.ok(t.some((b) => b.id === id && b.deletedAt !== deletedAt0), '回收站条目必须保留（并发再软删写回的那份）');
});

test('R4-a publish 的 trash 复检 409 → status 副档同步 ready（否则目录能开、每章 409）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await publishBook(store, cookie, '副档对齐书', 2);

  // CAS 写 meta 成功的同一刻书被并发软删（复刻 P1-2 注入）：publish 走到 trash2 复检
  const origIf = store.putTextIf.bind(store);
  let armed = true;
  store.putTextIf = async (k, s, etag) => {
    if (armed && k === KEY.book(id)) {
      armed = false;
      assert.equal((await softDel(store, cookie, id)).status, 200, '并发软删应成功');
    }
    return origIf(k, s, etag);
  };
  try {
    const r = await publish(store, cookie, id);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match(r.data.error, /回收站/);
  } finally {
    store.putTextIf = origIf;
  }
  assert.equal((await rawMeta(store, id)).status, 'ready', 'meta 已在 CAS 写成 ready');
  assert.equal(JSON.parse(await store.getText(KEY.st(id))).s, 'ready', '副档必须对齐 meta：apiBookMeta 判 meta、apiChapter 判副档，滞后就「目录能开每章 409」');
});

test('R4-b 同名终判的全量读瞬时故障 → fail-open 放行（不 500，下一轮发布会再判）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await publishBook(store, cookie, '终判抖动的书', 2);
  // 两片布局：同名在架书在 s0，draft 不在 root.map（append 到末片 s1，入口不读 s0）
  await writeIdxShards(store, [[{ id: 'other_1', title: '终判抖动的书', author: '别人', chapterCount: 1, wordCount: 9, pinned: false, prog: null }], []]);

  const origGet = store.getText.bind(store);
  let failed = 0;
  store.getText = async (k) => {
    if (k === 'meta/idx/s0.json') {
      failed++;
      throw new Error('readIndex transient');
    }
    return origGet(k);
  };
  try {
    const r = await publish(store, cookie, id);
    assert.equal(r.status, 200, '终判是纵深一环：瞬时抖动好过 meta 已 ready 后再冒 500（无故障时这本来会 409，见 R5-a）');
  } finally {
    store.getText = origGet;
  }
  assert.ok(failed > 0, '故障必须真的注入进 readIndex 的全量读（没打到就是空炮）');
});

test('R5-a K=1 同名人书在架 → publish 409 且副档同步（终判照跑）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await publishBook(store, cookie, '撞名书架书', 2);
  await writeIdxBooks(store, [{ id: 'other_a', title: '撞名书架书', author: '别人', chapterCount: 1, wordCount: 9, pinned: false, prog: null }]);

  const r = await publish(store, cookie, id);
  assert.equal(r.status, 409, 'create 期判重互不可见时，发布首刊的同名终判是最后一道闸');
  assert.match(r.data.error, /同名/);
  assert.equal(JSON.parse(await store.getText(KEY.st(id))).s, 'ready', 'clash 409 前副档同样要对齐 meta');
  assert.ok(!(await readIdxBooks(store)).some((b) => b.id === id), '不得 upsert 上架');
});

test('R5-b K=5 分片 → 同名终判跳过（publish 200，代价优先于重复卡检查）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await publishBook(store, cookie, '大片库撞名书', 2);
  await writeIdxShards(store, [
    [{ id: 'other_b', title: '大片库撞名书', author: '别人', chapterCount: 1, wordCount: 9, pinned: false, prog: null }],
    [],
    [],
    [],
    [],
  ]);

  const r = await publish(store, cookie, id);
  assert.equal(r.status, 200, 'K>4 时全量读 1+K + 账面最坏会贴/撞 50 硬顶 → 跳过终判（create 判重 + askDup 已覆盖绝大部分）');
  const books = await readIdxBooks(store);
  assert.equal(books.filter((b) => b.title === '大片库撞名书').length, 2, '两本同名并存 —— 证明终判这轮确实被跳过了');
});

/* ==================== B 组 · 源码级 ==================== */

test('B-R1 apiUpdateChapters：回放分支核对 sig，登记带 sig', () => {
  const src = routerSrc();
  assert.match(src, /const batchSig = \(arr\) =>/, '签名函数必须存在');
  const u = src.indexOf('async function apiUpdateChapters(');
  const body = src.slice(u, src.indexOf('\nasync function', u + 10));
  assert.match(body, /const sig = batchSig\(chapters\);/, '签名从当前 chapters 现推（客户端零改动）');
  assert.match(body, /if \(mm\.pending\.sig !== sig\) \{\s*\n\s*return \{ abort: json\(\{ error: '章节划分与上次上传不一致，请改用「整本替换」重试' \}, 409\) \};/, '回放前核对签名');
  assert.match(body, /mm\.pending = \{ batch, keys: mm\.chapters\.map\(\(c\) => c\.key\), sig \};/, '登记必须带 sig');
});

test('B-R2 apiInsertChapter：正文落盘失败 → 补偿 mutateMeta（tries=2 + 并发已删守卫）', () => {
  const src = routerSrc();
  const ins = src.indexOf('async function apiInsertChapter(');
  const body = src.slice(ins, src.indexOf('\nasync function', ins + 10));
  const putAt = body.indexOf('await store.putText(KEY.text(id, key), content)');
  assert.ok(putAt > 0, '正文 CAS 后落盘');
  const tail = body.slice(putAt);
  assert.match(tail, /try \{[\s\S]{0,200}await mutateMeta\(/, '失败路径要补偿摘除');
  assert.match(tail, /const i = chIndex\(meta, key\);\s*\n\s*if \(i < 0\) return \{ dirty: false \};/, '已被并发删掉 → 不补偿（守卫）');
  assert.match(tail, /meta\.wordCount = Math\.max\(0, \(Number\(meta\.wordCount\) \|\| 0\) - w\);/, '字数回退');
  assert.match(tail, /\},\s*\n\s*null,\s*\n\s*2 \/\/ 失败路径的尽力补偿/, 'tries=2：罕见失败不放大开销');
});

test('B-R3 apiRestore：vanished/redo 分流 + readBook 判据 + 两条文案', () => {
  const src = routerSrc();
  const r = src.indexOf('async function apiRestore(');
  const body = src.slice(r, src.indexOf('\nasync function', r + 10));
  assert.match(body, /if \(i < 0\) return \{ dirty: false, out: \{ raced: true, vanished: true \} \};/, '条目消失要报 vanished（旧代码回 {dirty:false} 无 out → raced 不触发）');
  assert.match(body, /if \(t\.books\[i\]\.deletedAt !== entry\.deletedAt\) return \{ dirty: false, out: \{ raced: true, redo: true \} \};/, 'deletedAt 变更要报 redo');
  assert.match(body, /if \(marked\.vanished\) rollback = !\(await readBook\(store, id\)\);/, '本体分流：purge 删光才回滚，并发恢复成功要放行');
  assert.match(body, /该书已被再次删除，恢复已中止/, 'redo 文案');
  assert.match(body, /该书正在被彻底删除，恢复已中止/, 'vanished+回滚文案');
});

test('B-R4 apiPublish：两处 409 前 putStatus ready + 终判 readIndex try/catch', () => {
  const src = routerSrc();
  const p = src.indexOf('async function apiPublish(');
  const body = src.slice(p, src.indexOf('\nasync function', p + 10));
  const syncs = body.match(/putStatus\(store, id, 'ready'\)\.catch\(\(\) => \{\}\)/g) || [];
  assert.ok(syncs.length >= 2, 'trash2 复检与 clash 两个 409 出口前都要同步副档');
  // ⚠️ #145 R9 后同一文案的 409 出口变成 3 处（入口快照 / trash2 复检 / 重放被回收站拒绝），
  // 原来的「lastIndexOf = 复检那一处」启发式随之失准（会指到函数末尾的新出口）。
  // 改为**结构锚点**定位：先找到 trash2 那次读，再核它那一小段里的 409 与副档同步写序。
  const t2 = body.indexOf('const trash2 = await readTrash(store)');
  assert.ok(t2 > 0, '找不到 trash2 复检');
  const t2Blk = body.slice(t2, t2 + 700);
  const t2msg = t2Blk.indexOf('该书在回收站中，请先恢复再发布');
  assert.ok(t2msg > 0, 'trash2 复检命中时必须 409');
  const t2sync = t2Blk.lastIndexOf("putStatus(store, id, 'ready')", t2msg);
  assert.ok(t2sync > 0 && t2sync < t2msg, 'trash2 复检 409 之前要同步副档');
  const clash409 = body.indexOf('书架已有同名');
  assert.ok(clash409 > t2, '写序：trash2 复检在 upsert/同名终判之前');
  assert.ok(body.lastIndexOf("putStatus(store, id, 'ready')", clash409) > clash409 - 400, 'clash 409 之前要同步副档');
  assert.match(body, /let full = null;\s*\n\s*try \{\s*\n\s*full = await readIndex\(store\);/, '全量读必须 try/catch（瞬时抖动 fail-open）');
  assert.match(body, /if \(full\) \{/, '读失败 → full 保持 null → 跳过终判');
});

test('B-R5 apiPublish：同名终判 K≤4 门控', () => {
  const src = routerSrc();
  const p = src.indexOf('async function apiPublish(');
  const body = src.slice(p, src.indexOf('\nasync function', p + 10));
  assert.match(body, /if \(!old && Number\(idx\.shardCount\) <= 4\) \{/, '只查首刊且 K≤4（最坏 49 贴顶；原 8 会 52~53 撞平台硬失败）');
});

test('B-R6 trashRow：purging 占用标记的三态副标题', () => {
  const app = read('public/js/app.js');
  const t = app.indexOf('function trashRow(');
  const body = app.slice(t, app.indexOf('\nfunction', t + 10));
  assert.match(body, /b\.purging && !b\.purge/, '在飞 purge（计数 0 + purging:true）要单列一态');
  assert.match(body, /'正在彻底删除，暂不可恢复'/, '文案：正文其实完好，不能说「已部分清除」');
  assert.match(body, /正文已部分清除（\$\{b\.purge\} 章待清），无法恢复/, '有剩余计数的老语义保留');
});
