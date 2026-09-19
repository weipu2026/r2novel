/* review-fix140.test.mjs — C 档并发核实结论（桌面/r2novel-C档并发核实-2026-09-19.md）D1/D2/D3 的单测
 *
 * 背景：全仓 meta 写原有 7 处「readBook → 改内存对象 → putText 整份覆盖」。实测它们**当下撞不上**，
 * 但那只是「读后到写前没有 await 让出点」的巧合 —— 任何人插一个 await 就变成真实覆盖窗口。
 * #140 抽出 mutateMeta（CAS + 冲突重读重放）把 7 处（+把原本手写 CAS 的 apiPatchBook）统一收口。
 *
 * 本文件的每条用例都用同一个手法制造那个窗口：**让「对 meta 的第一次读」返回陈旧快照，并在读到
 * 之后立刻落地一次外部写**（staleRead 助手）——这就是「另一台设备/另一个标签页刚好在读完之后写了」。
 * 旧写法（无条件整份覆盖）必然把外部写吃掉 → 用例翻红；新写法重读重放 → 两边都不丢。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore, req, call, login, makeReadyBook, countStore } from './_harness.mjs';
import { KEY } from '../src/router.js';

const bookMeta = (store, cookie, id) => call(store, req(`/api/books/${id}`, { cookie }));
const patchChapter = (store, cookie, id, k, body) => call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PATCH', cookie, body }));
const insertChapter = (store, cookie, id, body) => call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body }));
const deleteChapter = (store, cookie, id, k) => call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'DELETE', cookie }));
const updateChapters = (store, cookie, id, body) => call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body }));
const publish = (store, cookie, id) => call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
const getChapter = (store, cookie, id, k) => call(store, req(`/api/books/${id}/chapters/${k}`, { cookie }));
const batchBooks = (store, cookie, body) => call(store, req('/api/books/batch', { method: 'POST', cookie, body }));
const tagsMerge = (store, cookie, body) => call(store, req('/api/tags', { method: 'POST', cookie, body }));

/** 直读 meta（绕开 apiBookMeta —— 它自己会顺带清一批孤儿，会把前置状态改掉） */
const rawMeta = async (store, id) => JSON.parse(await store.getText(KEY.book(id)));

/**
 * 注入「陈旧读 + 外部并发写」：对 key 的**第一次**读，先返回写之前的快照，随后立刻把外部改动落盘。
 * 这正是被修的那个窗口（读完成之后、写回之前，另一台设备 / 另一个标签页写了同一份 meta）。
 * 两个读入口都要挂：新写法走 getTextWithEtag（要 etag 做 CAS），旧写法走 getText。
 */
function staleRead(store, key, foreign) {
  let fired = false;
  async function inject(k) {
    if (fired || k !== key) return;
    fired = true; // 先置位：inject 内部再读同一个 key 时不再递归注入
    const t = await store.getText(k);
    if (t == null) return;
    const m = JSON.parse(t);
    foreign(m);
    await store.putText(k, JSON.stringify(m)); // 外部写：无条件（模拟旧客户端 / 另一实例）
  }
  const og = store.getText.bind(store);
  const oge = store.getTextWithEtag.bind(store);
  store.getText = async (k) => {
    const r = await og(k); // 先取旧快照
    await inject(k); // 再落地外部写 —— 调用方拿到的是陈旧值
    return r;
  };
  store.getTextWithEtag = async (k) => {
    const r = await oge(k);
    await inject(k);
    return r;
  };
  return store;
}

/* ───────── D1-① 就地改章标题（原为无条件整份覆盖） ───────── */

test('D1 改章标题：读之后发生的外部写不得被整份覆盖吃掉（CAS 重读重放）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, 'CAS-改标题', 2);
  const before = await rawMeta(store, id);

  staleRead(store, KEY.book(id), (m) => {
    m.note = '外部写的备注';
    m.star = true;
  });
  const r = await patchChapter(store, cookie, id, keys[0], { title: '改过的标题' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const after = await rawMeta(store, id);
  assert.equal(after.chapters[0].title, '改过的标题', '本次修改必须落地（重放而非放弃）');
  assert.equal(after.note, '外部写的备注', '并发写入的 note 不得被整份覆盖吃掉');
  assert.equal(after.star, true, '并发写入的 star 不得被吃掉');
  assert.equal(after.cleanVer, (before.cleanVer || 1) + 1, 'cleanVer 只能 +1：重放不得叠加');
  assert.equal(after.chapterCount, before.chapterCount);
  assert.equal(after.chapters.length, 2);
});

/* ───────── D1-② append：起点按当前盘面重算 ───────── */

test('D1 append：起点按当前盘面重算 —— 不撞并发 writer 的 key，也不丢它的章表', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'CAS-append', 3);

  // 外部并发写：章表已变成 1..10（模拟另一台设备刚做完 replace + append）
  staleRead(store, KEY.book(id), (m) => {
    m.chapters = Array.from({ length: 10 }, (_, i) => ({ key: String(i + 1), title: '外部章' + (i + 1) }));
    m.chapterCount = 10;
  });
  const r = await updateChapters(store, cookie, id, { op: 'append', chapters: ['续章A', '续章B'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const ks = r.data.chapterKeys;
  assert.equal(ks.length, 12, '外部 10 章必须保留，本次追加 2 章 → 12（旧写法从陈旧快照算起点 → 只剩 5 章）');
  assert.equal(new Set(ks).size, 12, 'key 不得重复：旧写法算出 4/5，正好撞在外部章表上');
  assert.equal(ks[10], '11', '新章 key 必须避开盘上已有的最大数字 key');
  assert.equal(ks[11], '12');
});

/* ───────── D1-③ 插章：插入位按当前盘面重算 ───────── */

test('D1 插章：插入位按当前盘面重算 —— 并发删章不插错位、也不复活被删的章', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, 'CAS-插章', 3);

  staleRead(store, KEY.book(id), (m) => {
    m.chapters = m.chapters.filter((c) => c.key !== keys[0]);
    m.chapterCount = m.chapters.length;
  });
  const r = await insertChapter(store, cookie, id, { after: keys[1], title: '插在第二章后', content: 'X' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const after = await rawMeta(store, id);
  const ks = after.chapters.map((c) => c.key);
  assert.ok(!ks.includes(keys[0]), '并发删掉的章不得被旧快照复活');
  assert.equal(ks.indexOf(r.data.key), ks.indexOf(keys[1]) + 1, '新章必须紧跟参照章');
  assert.equal(after.chapters.length, 3);
});

/* ───────── D1-④ 删章：并发已删同一章 → 幂等短路 ───────── */

test('D1 删章：并发已删同一章 → 幂等短路，不重复扣字数、也不白写一次盘', async () => {
  const base = memStore();
  const cookie = await login(base);
  const { id, keys } = await makeReadyBook(base, cookie, 'CAS-删章', 3);
  const before = await rawMeta(base, id);

  // 计数从这一刻起：外部写 = 1 次 put；幂等短路**不该**再多写一次 meta（子请求是硬成本）
  const store = countStore(base);
  staleRead(store, KEY.book(id), (m) => {
    m.chapters = m.chapters.filter((c) => c.key !== keys[2]);
    m.chapterCount = m.chapters.length;
    m.wordCount = 777; // 哨兵：外部 writer 扣完字数后的值
  });
  const r = await deleteChapter(store, cookie, id, keys[2]);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const after = await rawMeta(base, id);
  assert.equal(after.chapters.length, 2);
  assert.equal(after.wordCount, 777, '同一章不得被扣两次字数（旧写法会再减一遍）');
  assert.equal(after.cleanVer, before.cleanVer, '短路时不写盘 → cleanVer 不变（重放不得叠加/空转）');
  assert.equal(store._count.put, 1, '幂等短路必须**不写盘**：除外部那一次外不得再有 meta 写');
});

/* ───────── D1-⑤ 发布：meta 写走 CAS ───────── */

test('D1 发布：meta 写走 CAS —— 并发编辑不被写回旧章表复活', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, 'CAS-发布', 3);

  staleRead(store, KEY.book(id), (m) => {
    m.chapters = m.chapters.filter((c) => c.key !== keys[2]);
    m.chapterCount = 2;
    m.note = '外部备注';
  });
  const r = await publish(store, cookie, id);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const after = await rawMeta(store, id);
  assert.ok(!after.chapters.some((c) => c.key === keys[2]), '并发删掉的章不得被 publish 用旧章表写回');
  assert.equal(after.note, '外部备注');
  assert.equal(after.status, 'ready');
  assert.equal(after.chapterCount, 2);
});

/* ───────── D3 sweepOrphans 防御：脏孤儿表不得误删在用正文 ───────── */

test('D3 sweepOrphans 防御：孤儿表里混进章表在用的 key → 绝不删在用正文', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id, keys } = await makeReadyBook(store, cookie, '脏孤儿表', 3);

  // 历史脏数据（#139 修复前写入的 meta）：孤儿表与章表重叠
  const m = await rawMeta(store, id);
  m.orphans = [keys[0], '999'];
  await store.putText(KEY.book(id), JSON.stringify(m));

  const r = await bookMeta(store, cookie, id); // 触发惰性清理
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await getChapter(store, cookie, id, keys[0])).status, 200, '章表仍在引用的正文不得被当孤儿删掉');
  assert.equal((await getChapter(store, cookie, id, '999')).status, 404);

  const after = await rawMeta(store, id);
  assert.equal(after.orphans, undefined, '整表都是「其实在用」的 key → 应作废，不再反复扫');
  assert.ok(after.chapters.some((c) => c.key === keys[0]), '章表不得被改动');
});

/* ───────── D1-⑥ 批量打标签：每本 CAS ───────── */

test('D1 批量打标签：并发的旁路字段不被吃掉（每本独立 CAS）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'CAS-批量', 2, ['旧标签']);

  staleRead(store, KEY.book(id), (m) => {
    m.star = true;
    m.note = '外部备注';
  });
  const r = await batchBooks(store, cookie, { ids: [id], action: 'addTags', tags: ['新标签'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.updated, 1);

  const after = await rawMeta(store, id);
  assert.deepEqual(after.tags.slice().sort(), ['新标签', '旧标签'].sort());
  assert.equal(after.star, true, '并发写入的 star 不得被批量写吃掉');
  assert.equal(after.note, '外部备注');
});

/* ───────── D1-⑦ 标签改名：每本 CAS ───────── */

test('D1 标签改名：并发的旁路字段不被吃掉', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'CAS-改标签', 2, ['甲']);

  staleRead(store, KEY.book(id), (m) => {
    m.note = '外部备注';
    m.star = true;
  });
  const r = await tagsMerge(store, cookie, { from: '甲', to: '乙' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.updated, 1);

  const after = await rawMeta(store, id);
  assert.deepEqual(after.tags, ['乙']);
  assert.equal(after.note, '外部备注', '并发写入的 note 不得被吃掉');
  assert.equal(after.star, true);
});

/* ───────── 护栏：重试用尽 → 409（不死循环、也不静默当成功） ───────── */

test('护栏 mutateMeta：重试用尽 → 409（有界重试，不静默写回一份可能过期的盘面）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'CAS-用尽', 2);

  const origPutIf = store.putTextIf.bind(store);
  let casCalls = 0;
  store.putTextIf = async (k, s, etag) => {
    if (k === KEY.book(id)) {
      casCalls++;
      return null; // 每次 CAS 都失败（模拟持续抖动）
    }
    return origPutIf(k, s, etag);
  };
  const r = await patchChapter(store, cookie, id, '1', { title: '永远写不进去' });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.error, '并发冲突，请重试');
  assert.equal(casCalls, 3, '必须重试 IDX_SAVE_TRIES=3 次后放弃');

  const after = await rawMeta(store, id);
  assert.equal(after.chapters[0].title, '第1章 章1', '写不进去就不该有任何字段被改');
});
