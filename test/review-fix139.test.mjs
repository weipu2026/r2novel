/* review-fix139.test.mjs — 2026-09-19 回归审计（桌面/r2novel-回归审计-2026-09-19.md）「A 组 + B 组」修复的单测
 *
 * 每条用例都是「改回旧写法必然不通过」的判据：
 *   A3 孤儿避让：replace 减章后尚未清完的孤儿 key 仍在盘上，append 必须避开它们的 key 空间，
 *      否则新章正文会被后续 sweep 当作孤儿删掉（章表仍引用 → 阅读 404）。
 *   B1 apiBookMeta CAS 重读：并发 replace 把 status 改回 creating 时，不得把半成品盘面当 ready 返回。
 *   B4 OCC 原子化：progress 的「读—判—写」必须是 CAS —— 窗口内的并发写不得被后写者吃掉（TOCTOU 收口）；
 *      重试用尽要回传真值供对账，不带任何对账字段时保持无条件写（老客户端行为与子请求预算不变）。
 *   A2 netDown：单次 fetch reject 不得放大成「整本剩余章节缺失」；连续失败才断链，且断链后有周期探测。
 *   A2b 导出：缺章数必须回传调用方（不能只 console.warn 而界面照样显示「已导出」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore, req, call, login, makeReadyBook } from './_harness.mjs';
import { KEY } from '../src/router.js';
import { fetchChaptersAll } from '../public/js/store.js';
import { exportBookTxt } from '../public/js/exporter.js';

const putProg = (store, cookie, id, body) => call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body }));
const getProg = async (store, cookie, id) => (await call(store, req(`/api/progress/${id}`, { cookie }))).data;
const bookMeta = (store, cookie, id) => call(store, req(`/api/books/${id}`, { cookie }));
const updateChapters = (store, cookie, id, body) => call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body }));
const putChapterText = (store, cookie, id, k, text) => call(store, req(`/api/books/${id}/chapters/${k}`, { method: 'PUT', cookie, body: text }));
const publish = (store, cookie, id) => call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
const getChapter = (store, cookie, id, k) => call(store, req(`/api/books/${id}/chapters/${k}`, { cookie }));

/** 直读 meta（绕开 apiBookMeta —— 它自己会顺带清一批孤儿，会把前置状态改掉） */
const rawMeta = async (store, id) => JSON.parse(await store.getText(KEY.book(id)));

/* ────────────────── A3：孤儿 key 与 append 的 key 空间重叠（数据丢失） ────────────────── */

test('A3 孤儿避让：replace 减章后未清完就 append → 新章正文不得被孤儿清理误删', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '孤儿重叠-正常', 60);

  // ① replace 成 10 章：orphans = 11..60（50 个），本次请求内只清一批（24 个）→ 余下留在 meta.orphans
  let r = await updateChapters(store, cookie, id, { op: 'replace', chapters: Array.from({ length: 10 }, (_, i) => '新章' + (i + 1)) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const k of r.data.chapterKeys) await putChapterText(store, cookie, id, k, 'REPLACED-' + k);
  const left = (await rawMeta(store, id)).orphans || [];
  assert.ok(left.length > 0, `前置：replace 分批清理后盘上仍留有孤儿（实际 ${left.length} 个）`);

  // ② 未清完就 append 50 章（连载补章），逐章写正文
  r = await updateChapters(store, cookie, id, { op: 'append', chapters: Array.from({ length: 50 }, (_, i) => '续章' + (i + 1)) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 返回的是**全表** key（原 10 + 新 50）：新章是追加在末尾的那 50 个
  assert.equal(r.data.chapterKeys.length, 60, 'append 后章表 = 原 10 章 + 新 50 章');
  const keys = r.data.chapterKeys.slice(-50);
  for (const k of keys) await putChapterText(store, cookie, id, k, 'APPENDED-' + k);

  // ③ publish（顺带清孤儿）后逐章读回：章表引用却读不到 = 正文被当孤儿删了
  await publish(store, cookie, id);
  const gone = [];
  for (const k of keys) if ((await getChapter(store, cookie, id, k)).status !== 200) gone.push(k);
  assert.equal(gone.length, 0, `章表引用但正文已被孤儿清理删掉的章：${gone.join(',')}`);
});

test('A3 孤儿避让（清理失败时的兜底）：sweep 删不动也必须靠 key 避让保住新章', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '孤儿重叠-故障', 60);
  let r = await updateChapters(store, cookie, id, { op: 'replace', chapters: Array.from({ length: 10 }, (_, i) => '新章' + (i + 1)) });
  for (const k of r.data.chapterKeys) await putChapterText(store, cookie, id, k, 'REPLACED-' + k);
  assert.ok(((await rawMeta(store, id)).orphans || []).length > 0, '前置：盘上留有孤儿');

  // 故障注入：append 期间的孤儿清理删不动（模拟存储故障）→ 只能靠 key 避让兜住新章
  const origDelete = store.delete.bind(store);
  store.delete = async (k) => {
    if (String(k).startsWith('text/')) throw new Error('storage down');
    return origDelete(k);
  };
  r = await updateChapters(store, cookie, id, { op: 'append', chapters: Array.from({ length: 50 }, (_, i) => '续章' + (i + 1)) });
  store.delete = origDelete;
  assert.equal(r.status, 200, '清理失败不得让 append 整条挂掉');
  const keys = r.data.chapterKeys.slice(-50); // 新加的 50 章
  for (const k of keys) await putChapterText(store, cookie, id, k, 'APPENDED-' + k);

  await publish(store, cookie, id);
  const gone = [];
  for (const k of keys) if ((await getChapter(store, cookie, id, k)).status !== 200) gone.push(k);
  assert.equal(gone.length, 0, `清不掉孤儿时新章更必须避开它们的 key，实际丢失：${gone.join(',')}`);
});

/* ────────────────── B1：目录的 CAS 重读必须复查 status ────────────────── */

test('B1 apiBookMeta CAS 重读：并发 replace 期间不得把半成品（creating）当 ready 返回', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '目录CAS', 3);
  const key = KEY.book(id);

  // 造出「meta 带孤儿」这一前提（只有这条路径才会走 CAS 写回）
  const m = await rawMeta(store, id);
  m.orphans = ['999'];
  await store.putText(key, JSON.stringify(m));

  // 模拟并发：我们的 CAS 写回失败（版本已变），且窗口内盘上 status 被改回 creating
  const origIf = store.putTextIf.bind(store);
  let armed = true;
  store.putTextIf = async (k, s, etag) => {
    if (armed && k === key) {
      armed = false;
      const cur = await rawMeta(store, id);
      cur.status = 'creating';
      await origIf(key, JSON.stringify(cur), undefined);
      return null; // 本次 CAS 失败 → 触发重读重扫
    }
    return origIf(k, s, etag);
  };

  const r = await bookMeta(store, cookie, id);
  assert.equal(r.status, 409, '重读到 creating 版本时必须回 409，不能 200 返回半成品章表');
  assert.match(String(r.data.error), /更新中/);
});

/* ────────────────── B4：进度 OCC 的读—判—写原子化 ────────────────── */

test('B4 OCC 原子化：读—判—写窗口内的并发写不得被覆盖（TOCTOU 收口）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OCC原子', 6);
  const pkey = KEY.progress(id);

  // 模拟并发方恰好在我们「读完、写之前」落盘了一份更新的进度
  const concurrentAt = Date.now() + 60000;
  const origIf = store.putTextIf.bind(store);
  let armed = true;
  store.putTextIf = async (k, s, etag) => {
    if (armed && k === pkey) {
      armed = false;
      await origIf(pkey, JSON.stringify({ ch: 6, ratio: 0.9, updatedAt: concurrentAt }), undefined);
      return null; // 我们的 CAS 失败：版本在窗口内被改过
    }
    return origIf(k, s, etag);
  };

  const r = await putProg(store, cookie, id, { ch: 2, ratio: 0.1, baseAt: 0 });
  assert.equal(r.data.skipped, 'occ', '窗口内的并发写推进了盘面 → 本次旧认知写入必须被拒');
  const after = await getProg(store, cookie, id);
  assert.equal(after.ch, 6, '并发方的新进度不得被覆盖（旧实现的「读—判—无条件写」会把它写掉）');
});

test('B4 重试用尽：连续 CAS 冲突 → 回传真值供对账，不假装写成功', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OCC重试', 6);
  const pkey = KEY.progress(id);
  const prevAt = Date.now() - 5000;
  await store.putText(pkey, JSON.stringify({ ch: 6, ratio: 0.9, updatedAt: prevAt }));

  const origIf = store.putTextIf.bind(store);
  let tries = 0;
  store.putTextIf = async (k, s, etag) => {
    if (k === pkey) {
      tries++;
      return null; // 永远冲突
    }
    return origIf(k, s, etag);
  };

  // baseAt 比盘上更新 → 首次判定必须放行（否则测的就不是「重试用尽」而是「OCC 拒写」）
  const r = await putProg(store, cookie, id, { ch: 2, ratio: 0.1, baseAt: prevAt + 1 });
  assert.equal(r.data.skipped, 'occ', '重试用尽必须回传 skipped + 真值，让客户端对账');
  assert.equal(r.data.prog.ch, 6, '回传的必须是盘上真值');
  assert.ok(tries >= 2, `必须真的重试过（实际 putTextIf 调用 ${tries} 次）`);
  assert.equal((await getProg(store, cookie, id)).ch, 6, '盘上进度不得被改动');
});

test('B4 兼容：不带任何对账字段 → 不读盘、无条件覆盖（老客户端行为与子请求预算不变）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, 'OCC兼容', 6);
  const pkey = KEY.progress(id);
  await store.putText(pkey, JSON.stringify({ ch: 6, ratio: 0.9, updatedAt: Date.now() + 60000 }));

  let reads = 0;
  const origGet = store.getText.bind(store);
  store.getText = async (k) => {
    if (k === pkey) reads++;
    return origGet(k);
  };

  const r = await putProg(store, cookie, id, { ch: 2, ratio: 0.1 });
  assert.equal(r.data.skipped, undefined);
  assert.equal(reads, 0, '无条件写路径不得多做一次读（老客户端行为与子请求预算都不能变）');
  assert.equal((await getProg(store, cookie, id)).ch, 2, '无条件路径的语义就是覆盖');
});

/* ────────────────── A2：netDown 的阈值与恢复探测 ────────────────── */

test('A2 netDown：单次瞬时抖动不得被放大成「整本剩余章节缺失」', async () => {
  const origFetch = globalThis.fetch;
  const chapters = Array.from({ length: 20 }, (_, i) => ({ key: String(i + 1), title: '第' + (i + 1) + '章' }));
  const meta = { id: 'bk1', title: '抖动书', cleanVer: 1, chapters };
  let chapterCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/chapters/')) {
      chapterCalls++;
      if (chapterCalls === 1) throw new TypeError('fetch failed'); // 只让第 1 个请求抖动
      return new Response('正文', { status: 200 });
    }
    return new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await fetchChaptersAll('bk1', null);
    assert.equal(chapterCalls, 20, '一次瞬时失败后仍应逐章尝试（旧实现一票否决，请求数掉到并发数 8）');
    assert.equal(r.missing, 1, '只有真失败的那一章算缺失');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('A2 netDown：连续失败才断链，且断链后仍有周期探测（链路恢复能回到网络路径）', async () => {
  const origFetch = globalThis.fetch;
  const chapters = Array.from({ length: 40 }, (_, i) => ({ key: String(i + 1), title: '第' + (i + 1) + '章' }));
  const meta = { id: 'bk2', title: '断链书', cleanVer: 1, chapters };
  let chapterCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/chapters/')) {
      chapterCalls++;
      throw new TypeError('fetch failed'); // 全失败 → 应当尽快断链
    }
    return new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await fetchChaptersAll('bk2', null);
    assert.ok(chapterCalls > 8, `断链后必须仍有周期探测（否则链路恢复也永远回不到网络路径），实际 ${chapterCalls} 次`);
    assert.ok(chapterCalls < 40, `断链必须生效：40 章不该逐章硬发（实际 ${chapterCalls} 次）`);
    assert.equal(r.missing, 40, '全失败 → 全部如实计入缺失');
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* ────────────────── A2b：导出缺章必须回传给调用方 ────────────────── */

test('A2b 导出：缺章数必须回传调用方（不能只 console.warn 而界面显示「已导出」）', async () => {
  const origFetch = globalThis.fetch;
  const origDoc = globalThis.document;
  const origCreate = globalThis.URL.createObjectURL;
  const origRevoke = globalThis.URL.revokeObjectURL;
  const origWarn = console.warn;
  const meta = { id: 'bk1', title: '导出书', cleanVer: 1, chapters: [{ key: '1', title: '第1章' }, { key: '2', title: '第2章' }] };
  globalThis.document = { createElement: () => ({ click() {}, remove() {}, href: '', download: '' }), body: { appendChild() {} } };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
  console.warn = () => {};
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/export/')) return new Response('nope', { status: 404 }); // 服务端流式端点不可用
    if (u.includes('/chapters/')) {
      const key = decodeURIComponent(u.split('/chapters/')[1].split('?')[0]);
      if (key === '2') throw new TypeError('fetch failed'); // 第 2 章取不到
      return new Response('正文' + key, { status: 200 });
    }
    return new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await exportBookTxt('bk1', null);
    assert.equal(res.title, '导出书');
    assert.equal(res.missing, 1, '缺章数必须回传给调用方（旧实现只 console.warn，界面照样提示「已导出」）');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.document = origDoc;
    globalThis.URL.createObjectURL = origCreate;
    globalThis.URL.revokeObjectURL = origRevoke;
    console.warn = origWarn;
  }
});
