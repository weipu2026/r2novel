/* editor-ui.test.mjs — 章节编辑器（upload/editor.js）的 DOM 桩回归测试
 *
 * 背景：2026-10-13 源码审计（R2novel 源码审计报告.md）在 upload/editor.js 里找到 3 处
 * 运行时缺陷，而该文件在 test/ 里**零引用** —— 五道静态门禁不执行状态迁移，缺陷因此长期漏过。
 * 本文件用 test/_dom-stub.mjs 驱动**真实代码路径**，把缺陷钉死成回归判据。
 *
 * 每条用例都满足「把修复改回去必然变红」：
 *   缺陷 1  「保存本章」成功后按钮被 ceBusy('') 的解锁还原成可点 → 再点发出与库内逐字节相同的 PATCH
 *   缺陷 2  结构变更（插章/删章）整表重绘后，未保存的正文改动静默丢失 / 缓存命中不回填（空白框）
 *   缺陷 3  请求在飞时关弹层 → 迟到 DOM 写抛 TypeError 被 catch 吞成「保存失败/插入失败」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  installDom, makeModalBox, setModalHTML, clearModal, flush, deferred,
  btnBy, rowsOf, El, NOP,
} from './_dom-stub.mjs';

installDom();

const { els } = await import('../public/js/dom.js');
const { provide } = await import('../public/js/upload/ctx.js');
const { bindToast } = await import('../public/js/ui.js');
const { api } = await import('../public/js/store.js');
const { openChapterEditor } = await import('../public/js/upload/editor.js');

/* ── toast 观测点（bindToast 之后它就是可读 DOM 文本，第一等证据） ── */
const toastEl = new El('div');
bindToast(toastEl);
const toastText = () => toastEl.textContent;

/* ── 宿主桩：忠实复刻 app.js 的弹层世代令牌语义（openModal/closeModal 各推进一次） ── */
let seq = 0;
const HOST = {
  showView: NOP,
  loadShelf: async () => {},
  getBooks: () => [],
  openModal: (html) => { seq++; setModalHTML(els.modalBox, html); },
  closeModal: () => { seq++; clearModal(els.modalBox); },
  confirmModal: async () => true,
  syncPresetChips: NOP,
  refreshPresetTags: NOP,
  parseTagInput: (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean),
  modalGen: () => seq,
  modalTake: () => ++seq,
};
provide(HOST);

/* ── 被测书籍与夹具 ── */
const BOOK = { id: 'n_1', title: '测试书' };
const CH1 = { key: '1', title: '第一章' };
const CH2 = { key: '2', title: '第二章' };
const T1 = '第一章的正文。';
const T2 = '第二章的正文。';

function makeApi({ patchOk = true, insertOk = true, onPatch = null, onInsert = null } = {}) {
  const calls = { patch: [], insert: [], del: [], chapter: [] };
  // 章表是**可变的**：插章/删章后 bookMeta 必须反映新表，否则「重绘」这一步在夹具里就不成立
  let chapters = [{ ...CH1 }, { ...CH2 }];
  api.bookMeta = async () => ({
    id: BOOK.id, title: BOOK.title, cleanVer: 1,
    chapterCount: chapters.length, wordCount: 10, chapters: chapters.map((c) => ({ ...c })),
  });
  api.chapter = async (id, key) => { calls.chapter.push(key); return key === CH1.key ? T1 : T2; };
  api.patchChapter = async (id, key, body) => {
    calls.patch.push({ key, body });
    if (onPatch) await onPatch();
    if (!patchOk) throw new Error('boom');
    return { title: body.title ?? (key === CH1.key ? CH1.title : CH2.title), wordCount: 20 };
  };
  api.insertChapter = async (id, body) => {
    calls.insert.push(body);
    if (onInsert) await onInsert();
    if (!insertOk) throw new Error('boom');
    const at = body.after ? chapters.findIndex((c) => c.key === body.after) + 1 : chapters.length;
    chapters.splice(at, 0, { key: 'new' + (chapters.length + 1), title: '新章' });
    return { title: '新章' };
  };
  api.deleteChapter = async (id, key) => {
    calls.del.push(key);
    chapters = chapters.filter((c) => c.key !== key);
    return { chapterCount: chapters.length, wordCount: 5 };
  };
  return calls;
}

/** 打开编辑器并返回第一行的关键控件（正文按钮 / 输入框 / 保存钮） */
async function openEditor() {
  els.modalBox = makeModalBox();
  toastEl.textContent = '';
  await openChapterEditor(BOOK);
  await flush();
  const row0 = rowsOf(els.modalBox)[0];
  return {
    row0,
    ta: row0.querySelector('textarea'),
    saveBtn: btnBy(row0, (b) => b.textContent === '保存本章'),
    bodyBtn: btnBy(row0, (b) => b.textContent === '正文'),
  };
}

/** node 是否仍挂在 root 子树里（桩没有 isConnected，用父链判断） */
const inTree = (node, root) => { for (let p = node; p; p = p.parentNode) if (p === root) return true; return false; };

/** 弹层统计行的文本（#ceStat） */
const ceStatLine = () => { const el = els.modalBox.querySelector('#ceStat'); return el ? el.textContent : ''; };

/* ══════════════════ 桩自检（防重犯假阴性） ══════════════════ */

test('桩自检：ceApplyLock 的逗号分组选择器必须真的命中「保存本章」', async () => {
  makeApi();
  const { saveBtn } = await openEditor();
  const hit = els.modalBox.querySelectorAll('input.ce-title, .ce-row button, #ceAppend, #ceDone');
  assert.ok(hit.length > 0, '选择器在桩里一条都不命中 → 桩失真，绝不能拿它的结论当证据');
  assert.ok(hit.includes(saveBtn), '「保存本章」（.ce-row button）必须被选中，否则解锁会放过它 → 假阴性');
  assert.ok(hit.includes(els.modalBox.querySelector('#ceAppend')), '#ceAppend 应被选中');
  assert.ok(hit.includes(els.modalBox.querySelector('#ceDone')), '#ceDone 应被选中');
});

test('桩自检：被禁用的控件不得派发 click（否则「禁用住按钮」的行为断言无意义）', () => {
  const b = new El('button');
  let n = 0;
  b.addEventListener('click', () => n++);
  b.disabled = true;
  b.dispatch('click');
  assert.equal(n, 0, '禁用态必须拦掉 click（浏览器语义）');
  b.disabled = false;
  b.dispatch('click');
  assert.equal(n, 1);
});

test('桩自检：HTML 解析必须产出真实元素树（含 hN 这类「字母+数字」标签）', () => {
  const box = makeModalBox();
  setModalHTML(box, '<div><h3>标题</h3><p id="ceStat" class="ce-stat modal-sub"></p></div><button id="ceDone" class="ghost">完成</button>');
  assert.ok(box.querySelector('h3'), 'h3 必须能被选中（桩曾因标签正则不吃数字而漏掉）');
  assert.equal(box.querySelector('h3').textContent, '标题', '文本节点必须落到元素上');
  assert.equal(box.querySelector('#ceStat').className, 'ce-stat modal-sub', 'class 属性必须解析');
  assert.equal(box.querySelector('button.ghost').id, 'ceDone', 'tag.class 组合选择器');
  assert.equal(box.querySelector('#ceDone').textContent, '完成');
});

test('契约哨兵：app.js 必须把弹层世代令牌注入 upload 域（modalGen/modalTake）', () => {
  const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const at = src.indexOf('initUpload({');
  assert.ok(at > 0, '找不到 initUpload 调用点');
  const caps = src.slice(at, at + 800);
  assert.match(caps, /modalGen/, 'initUpload 实参缺 modalGen —— editor.js 的世代校验拿不到号');
  assert.match(caps, /modalTake/, 'initUpload 实参缺 modalTake');
  assert.match(src, /function openModal\(html\) \{\s*modalSeq\+\+/, 'openModal 必须推进世代号');
  assert.match(src, /function closeModal\(\) \{\s*modalSeq\+\+/, 'closeModal 必须推进世代号（关闭也要作废在途写）');
});

/* ══════════════════ 缺陷 1：保存成功后按钮被解锁 ══════════════════ */

test('缺陷1：保存成功后「保存本章」必须保持禁用，再点不得发出零变化 PATCH', async () => {
  const calls = makeApi();
  const { ta, saveBtn, bodyBtn } = await openEditor();
  bodyBtn.dispatch('click');
  await flush();

  ta.value = '改过的正文';
  ta.dispatch('input');
  await flush();
  assert.equal(saveBtn.disabled, false, '有改动 → 保存钮应可点');

  saveBtn.dispatch('click');
  await flush();
  assert.equal(calls.patch.length, 1, '保存请求应只发一次');
  assert.equal(calls.patch[0].body.content, '改过的正文');

  // ★ 核心断言：旧实现在 finally 的 ceBusy('') 解锁时把它还原成 false
  assert.equal(saveBtn.disabled, true, '保存成功后必须禁用（内容已与库内一致，无改动可存）');
  assert.match(toastText(), /已保存/);

  // 行为级复核：浏览器不会为 disabled 控件派发 click → 不得再多一次请求
  saveBtn.dispatch('click');
  await flush();
  assert.equal(calls.patch.length, 1, '二次点击不得发出与库内逐字节相同的 PATCH（服务端 cleanVer 空转）');
});

test('缺陷1：保存失败后「保存本章」必须恢复可点（允许重试）', async () => {
  const calls = makeApi({ patchOk: false });
  const { ta, saveBtn, bodyBtn } = await openEditor();
  bodyBtn.dispatch('click');
  await flush();

  ta.value = '改过的正文';
  ta.dispatch('input');
  await flush();

  saveBtn.dispatch('click');
  await flush();
  assert.equal(calls.patch.length, 1);
  assert.equal(saveBtn.disabled, false, '失败必须放行重试（否则比原缺陷更严重）');
  assert.match(toastText(), /保存失败/);

  saveBtn.dispatch('click');
  await flush();
  assert.equal(calls.patch.length, 2, '重试应真的再发一次请求');
});

/* ══════════════════ 缺陷 2：重绘丢失正文编辑状态 ══════════════════ */

test('缺陷2a：未保存的正文改动，在插章重绘后仍必须保留（展开即见）', async () => {
  makeApi();
  const { row0, ta, bodyBtn } = await openEditor();
  bodyBtn.dispatch('click');
  await flush();
  assert.equal(ta.value, T1, '首次展开应拉到服务端正文');

  ta.value = '我改了一半还没保存';
  ta.dispatch('input');
  await flush();

  const insBtn = btnBy(row0, (b) => b.title === '在本章后插入一章');
  assert.ok(insBtn, '找得到插章按钮');
  insBtn.dispatch('click');
  await flush();

  const rows2 = rowsOf(els.modalBox);
  assert.equal(rows2.length, 3, '插章后应有 3 行');
  const ta2 = rows2[0].querySelector('textarea');
  assert.equal(inTree(ta, els.modalBox), false, '重绘后旧 textarea 已脱离文档');

  btnBy(rows2[0], (b) => b.textContent === '正文').dispatch('click');
  await flush();
  assert.equal(ta2.value, '我改了一半还没保存', '★ 重绘后展开必须回填未保存的草稿（旧实现静默丢失）');
});

test('缺陷2b：重绘后展开一个「已缓存但从未改动」的章节 → 必须回填而非空白', async () => {
  const calls = makeApi();
  const { row0, bodyBtn } = await openEditor();

  // 展开第 1 章（写缓存），收起
  bodyBtn.dispatch('click');
  await flush();
  bodyBtn.dispatch('click');
  await flush();
  assert.equal(calls.chapter.length, 1, '第 1 章正文只拉一次（此后走缓存）');

  const insBtn = btnBy(row0, (b) => b.title === '在本章后插入一章');
  insBtn.dispatch('click');
  await flush();

  const rows2 = rowsOf(els.modalBox);
  assert.equal(rows2.length, 3);
  const ta2 = rows2[0].querySelector('textarea');
  assert.equal(ta2.value, '', '新 textarea 天生为空');

  btnBy(rows2[0], (b) => b.textContent === '正文').dispatch('click');
  await flush();
  assert.equal(ta2.value, T1, '★ 缓存命中也要回填（旧实现缓存命中分支根本不设 ta.value → 空白框；在此输入再保存会整章覆盖）');
  assert.equal(calls.chapter.length, 1, '回填应来自缓存，不得再拉一次');
  assert.equal(btnBy(rows2[0], (b) => b.textContent === '保存本章').disabled, true, '内容与库内一致 → 保存钮应禁用');
});

test('缺陷2 回归：保存成功后重绘 → 展开必须显示刚保存的内容（不得回填过期值）', async () => {
  makeApi();
  const { row0, ta, saveBtn, bodyBtn } = await openEditor();
  bodyBtn.dispatch('click');
  await flush();

  ta.value = '新版正文';
  ta.dispatch('input');
  await flush();
  saveBtn.dispatch('click');
  await flush();

  const insBtn = btnBy(row0, (b) => b.title === '在本章后插入一章');
  insBtn.dispatch('click');
  await flush();

  const rows2 = rowsOf(els.modalBox);
  const ta2 = rows2[0].querySelector('textarea');
  btnBy(rows2[0], (b) => b.textContent === '正文').dispatch('click');
  await flush();
  assert.equal(ta2.value, '新版正文', '回填的应是刚保存的新值');
  assert.equal(btnBy(rows2[0], (b) => b.textContent === '保存本章').disabled, true, '保存过 → 无改动可存');
});

/* ══════════════════ 缺陷 3：请求在飞时关弹层 → 成功被误报为失败 ══════════════════ */

test('缺陷3：保存请求在飞时关掉弹层 → 服务端已成功，不得报「保存失败」', async () => {
  const gate = deferred();
  const calls = makeApi({ onPatch: () => gate.promise });
  const { ta, saveBtn, bodyBtn } = await openEditor();
  bodyBtn.dispatch('click');
  await flush();

  ta.value = '正文有改动';
  ta.dispatch('input');
  await flush();

  saveBtn.dispatch('click');
  await flush();
  assert.equal(calls.patch.length, 1, '请求已在飞');

  toastEl.textContent = '';
  // 用户按 Esc / 点遮罩 → app.modalDismiss() → closeModal()
  HOST.closeModal();
  await flush();

  gate.resolve(); // 服务端此刻才返回成功
  await flush();

  assert.equal(calls.patch.length, 1, '请求只发了一次（用户没有、也不该重试）');
  assert.doesNotMatch(toastText(), /失败/, '★ 服务端已成功，不得因弹层已关时写 DOM 抛错而误报失败');
  assert.match(toastText(), /已保存/);
});

test('缺陷3：插章请求在飞时关掉弹层 → 不得报「插入失败」（否则用户重试会插出重复章节）', async () => {
  const gate = deferred();
  const calls = makeApi({ onInsert: () => gate.promise });
  const { row0 } = await openEditor();

  const insBtn = btnBy(row0, (b) => b.title === '在本章后插入一章');
  insBtn.dispatch('click');
  await flush();
  assert.equal(calls.insert.length, 1, '插章请求已在飞');

  toastEl.textContent = '';
  HOST.closeModal(); // 关闭弹层
  await flush();

  gate.resolve();
  await flush();

  assert.doesNotMatch(toastText(), /失败/, '★ 服务端已插成功，不得误报失败');
  assert.equal(calls.insert.length, 1, '★ 不得让用户以为失败而重试（旧实现重试即产生重复章节）');
});

test('缺陷3：插章在飞时用户换了别的弹层 → 迟到重绘不得清空别人的弹层内容', async () => {
  const gate = deferred();
  const calls = makeApi({ onInsert: () => gate.promise });
  const { row0 } = await openEditor();

  const insBtn = btnBy(row0, (b) => b.title === '在本章后插入一章');
  insBtn.dispatch('click');
  await flush();

  // 用户关掉编辑器并打开了「编辑信息」弹层（openModal 推进世代号）
  setModalHTML(els.modalBox, '<h3>编辑信息</h3><p id="mdTitle">x</p>');
  await flush();

  gate.resolve();
  await flush();

  assert.ok(els.modalBox.querySelector('h3'), '别的弹层标题必须还在');
  assert.equal(els.modalBox.querySelector('#ceList'), null, '★ 迟到重绘不得把 ceList 塞进别人的弹层');
  assert.doesNotMatch(toastText(), /失败/);
  assert.equal(calls.insert.length, 1);
});

test('缺陷3 加固：插章在飞时关闭并重新打开同一个编辑器 → 旧响应不得改写新弹层', async () => {
  const gate = deferred();
  const calls = makeApi({ onInsert: () => gate.promise });
  const { row0 } = await openEditor();

  btnBy(row0, (b) => b.title === '在本章后插入一章').dispatch('click');
  await flush();
  assert.equal(calls.insert.length, 1, '插章请求已在飞');
  assert.equal(rowsOf(els.modalBox).length, 2, '关闭前：弹层显示原 2 章');

  // 用户关掉弹层，紧接着又把它打开（新弹层里同样有 #ceStat / #ceList）
  HOST.closeModal();
  await flush();
  await openChapterEditor(BOOK);
  await flush();
  assert.equal(rowsOf(els.modalBox).length, 2, '重开后：显示的仍是 2 章');
  assert.match(ceStatLine(), /测试书/);

  // 第一次那个在飞请求此刻才返回（服务端已插成功 → 章表变 3 章）
  gate.resolve();
  await flush();

  // ★ 世代校验必须比较「捕获值」：模块级 ceGen 已被重开刷新，拿它比较会误判成还活着，
  //   于是这条迟到重绘会把新弹层的章表改写成旧状态（3 章），而用户看到的是别人的数据。
  assert.equal(rowsOf(els.modalBox).length, 2, '★ 迟到重绘不得改写重开后的新弹层');
  assert.match(ceStatLine(), /2 章/, '统计行也必须仍是新弹层的');
  assert.doesNotMatch(toastText(), /失败/);
});

test('缺陷3 加固：连点两本书的「编辑章节」→ 只显示最后点的那本（入口世代校验）', async () => {
  const gateA = deferred();
  makeApi();
  api.bookMeta = async (id) => {
    if (id === 'n_A') {
      await gateA.promise; // 先点的那本「慢」
      return { id: 'n_A', title: '书A', cleanVer: 1, chapterCount: 1, wordCount: 1, chapters: [{ key: '1', title: 'A1' }] };
    }
    return { id: 'n_B', title: '书B', cleanVer: 1, chapterCount: 2, wordCount: 9, chapters: [{ key: '1', title: 'B1' }, { key: '2', title: 'B2' }] };
  };
  els.modalBox = makeModalBox();
  toastEl.textContent = '';

  const pA = openChapterEditor({ id: 'n_A', title: '书A' }); // 先点（慢）
  await flush();
  await openChapterEditor({ id: 'n_B', title: '书B' }); // 后点（快）
  await flush();
  assert.match(ceStatLine(), /书B/, '后点的那本应立即显示');
  assert.equal(rowsOf(els.modalBox).length, 2);

  gateA.resolve();
  await pA;
  await flush();
  assert.match(ceStatLine(), /书B/, '★ 先点、后返回的那次必须整体作废（最后一次点击获胜）');
  assert.doesNotMatch(ceStatLine(), /书A/);
  assert.equal(rowsOf(els.modalBox).length, 2, '章表仍应是书B的 2 章');
});

/* ══════════════════ 缺陷 4：跨弹层的忙态残留与缓存污染（2026-10-16 审计修复） ══════════════════
 * 忙态计数 ceLock 与正文缓存 ceBase / ceDraft 都是**模块级**的：弹层被关掉时若还有请求在飞，
 * 状态会跨过「关闭 → 重开」这道边界漏到下一个弹层上。三条用例各钉一个后果。 */

test('缺陷4：保存请求在飞时关闭并重开编辑器 → 新弹层不得被旧请求的忙态锁住', async () => {
  const gate = deferred();
  const calls = makeApi({ onPatch: () => gate.promise });
  const { ta, saveBtn, bodyBtn } = await openEditor();
  bodyBtn.dispatch('click');
  await flush();
  ta.value = '正文有改动';
  ta.dispatch('input');
  await flush();
  saveBtn.dispatch('click'); // 请求在飞：ceLock = 1
  await flush();
  assert.equal(calls.patch.length, 1, '保存请求已在飞');

  // 用户关掉编辑器（此刻 ceLock 仍为 1），紧接着重开同一本书
  HOST.closeModal();
  await flush();
  const again = await openEditor();

  // ★ 核心断言：新弹层一打开就必须可用。旧实现里 ceLock 残留 1 → renderCeList → ceApplyLock
  //   把新弹层的输入框与按钮全部禁掉（最长等到旧请求超时，用户只会觉得界面坏了）。
  assert.equal(els.modalBox.querySelector('#ceAppend').disabled, false, '★ 重开后「追加一章」不得被旧请求的残留锁禁掉');
  assert.equal(els.modalBox.querySelector('#ceDone').disabled, false, '★ 重开后「完成」不得被禁');
  assert.equal(again.row0.querySelector('input.ce-title').disabled, false, '★ 重开后标题输入框不得被禁');
  assert.equal(again.saveBtn.disabled, true, '保存钮仍应是「无改动可存」的初始禁用，而不是被锁住');

  // 旧请求此刻才返回：它的解锁既不得改新弹层的锁，也不得清新弹层的忙态文字
  gate.resolve();
  await flush();
  assert.equal(els.modalBox.querySelector('#ceAppend').disabled, false, '旧请求返回后新弹层必须仍可用');
  assert.doesNotMatch(toastText(), /失败/);
});

test('缺陷4：旧请求的解锁不得清掉新弹层的忙态文字', async () => {
  const gateOld = deferred();
  makeApi({ onPatch: () => gateOld.promise });
  const { ta, saveBtn, bodyBtn } = await openEditor();
  bodyBtn.dispatch('click');
  await flush();
  ta.value = '旧弹层的改动';
  ta.dispatch('input');
  await flush();
  saveBtn.dispatch('click'); // 旧请求在飞
  await flush();

  HOST.closeModal();
  await flush();

  // 重开，并在新弹层里发起它自己的保存（忙态文字应当挂在 #ceBusy 上）
  const gateNew = deferred();
  api.patchChapter = async () => { await gateNew.promise; return { title: 'x', wordCount: 1 }; };
  const again = await openEditor();
  again.bodyBtn.dispatch('click');
  await flush();
  again.ta.value = '新弹层的改动';
  again.ta.dispatch('input');
  await flush();
  again.saveBtn.dispatch('click');
  await flush();
  const busy = () => els.modalBox.querySelector('#ceBusy').textContent;
  assert.equal(busy(), '保存正文…', '新弹层应显示自己的忙态');

  // ★ 旧请求返回：els.modalBox 是共享容器，#ceBusy 取到的是新弹层的那个 —— 不得被旧解锁清空
  gateOld.resolve();
  await flush();
  assert.equal(busy(), '保存正文…', '★ 旧请求的解锁不得清新弹层的忙态文字');

  gateNew.resolve();
  await flush();
  assert.equal(busy(), '', '新弹层自己的请求结束后才清空');
});

test('缺陷4：关掉一本书的编辑器再开另一本 → 迟到响应不得把旧书正文写进新书缓存', async () => {
  const gate = deferred();
  makeApi({ onPatch: () => gate.promise });
  const { ta, saveBtn, bodyBtn } = await openEditor(); // 书 n_1
  bodyBtn.dispatch('click');
  await flush();
  ta.value = '书一的第一章正文';
  ta.dispatch('input');
  await flush();
  saveBtn.dispatch('click');
  await flush();

  HOST.closeModal();
  await flush();

  // 换另一本书：章 key 同样是 '1' —— ceBase 是模块级 Map，重开时 clear 过
  api.bookMeta = async () => ({
    id: 'n_2', title: '另一本', cleanVer: 1, chapterCount: 1, wordCount: 3,
    chapters: [{ key: '1', title: '乙书第一章' }],
  });
  api.chapter = async () => '书二的第一章正文';
  await openChapterEditor({ id: 'n_2', title: '另一本' });
  await flush();

  gate.resolve(); // 旧书那个保存请求此刻才返回 → 不得写 ceBase['1']
  await flush();

  const row = rowsOf(els.modalBox)[0];
  btnBy(row, (b) => b.textContent === '正文').dispatch('click');
  await flush();
  assert.equal(row.querySelector('textarea').value, '书二的第一章正文', '★ 必须显示新书自己的正文，而不是被旧书的迟到响应污染成「书一的第一章正文」');
});

test('契约哨兵：ceBusy 的每个调用点都必须显式传弹层世代号', () => {
  const src = fs.readFileSync(new URL('../public/js/upload/editor.js', import.meta.url), 'utf8');
  const bad = [];
  src.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('*')) return; // 注释里的示例不算
    if (s.includes('ceBusy(') && !s.includes('function ceBusy(') && !s.includes(', gen)')) bad.push((i + 1) + ': ' + s);
  });
  assert.equal(bad.length, 0, '漏传世代号会让忙态锁静默失效（永远不匹配 ceLockGen）：\n' + bad.join('\n'));
  // 反向自检：确认真扫到了调用点，否则上面可能因为「一条都没匹配上」而假绿
  const hit = src.split('\n').filter((l) => l.includes("ceBusy('") && !l.trim().startsWith('//'));
  assert.ok(hit.length >= 8, '应扫到 8 个调用点，实际只扫到 ' + hit.length + ' —— 判据失效？');
});
