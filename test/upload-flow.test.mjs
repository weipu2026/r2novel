/* upload-flow.test.mjs — 上传链路（files → prepare → preview → upload）的行为级回归（#146）
 *
 * 为什么需要：这条链路上的四条缺陷都**没有抛错、没有日志**，界面照常渲染，只有比对「真实发出的
 * 请求 / 会话里的预览数据 / DOM 的 disabled 态」才能分辨。只做源码断言的话，
 * 「append 覆盖了原件」和「换文件后标题没跟」这类问题永远抓不到。
 *
 * 用 test/_dom-stub.mjs 驱动真实模块（不 mock 被测代码），只替换网络层 api 与宿主能力 host。
 * 每条用例都验过「把修复改回去必然变红」。
 *
 * 覆盖：
 *   P2-1 编码选择跨文件残留（选文件 / 批量逐本）→ 整本乱码入库
 *   P2-2 append 写原件 → 「重新清洗」用追加片段替换整本正文
 *   P2-3 书名不跟随新文件 → 「标题A / 正文B」
 *   P2-6 上传在飞时不锁预览行 → 改动被冻结快照静默丢弃
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeModalBox, deferred, El, NOP } from './_dom-stub.mjs';

installDom();
/* preview.js 用 `new Option(text, value)` 建编码下拉项 —— 桩里没有浏览器的 Option 构造器。
 * 构造函数返回对象即覆盖 this，所以直接返回一个 option 元素即可。 */
globalThis.Option = function Option(text, value) {
  const el = new El('option');
  el.textContent = text;
  el.text = text;
  el.value = value;
  return el;
};

const { els } = await import('../public/js/dom.js');
const { provide } = await import('../public/js/upload/ctx.js');
const { bindToast } = await import('../public/js/ui.js');
const { api } = await import('../public/js/store.js');
const upSession = await import('../public/js/upload/session.js');
const { invalidateAutoEnc } = await import('../public/js/upload/preview.js');
const { prepareFile } = await import('../public/js/upload/prepare.js');
const { handleFiles, onPasteText, openUpload } = await import('../public/js/upload/files.js');
const { onConfirm } = await import('../public/js/upload/upload.js');

/* ── toast 观测点 ── */
const toastEl = new El('div');
bindToast(toastEl);

/* ── 宿主桩 ── */
const HOST = {
  showView: NOP,
  loadShelf: async () => {},
  getBooks: () => [], // 书架为空 → 永远走「新建」，不弹同名窗（同名路径不是本轮被测对象）
  openModal: NOP,
  closeModal: NOP,
  confirmModal: async () => true,
  syncPresetChips: NOP,
  refreshPresetTags: NOP,
  parseTagInput: (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean),
};
provide(HOST);

/* ── 夹具 ── */
const BOOK = { id: 'n_1', title: '已有书' };
const UTF8 = (s) => new TextEncoder().encode(s);
const UTF8_BYTES = UTF8('第一章 中文\n这是正文。\n第二章 再见\n又一段正文。\n');
/* GBK：'第一章 中文\n测试正文。\n'（码位手工核验，与 test/cleaner.test.mjs 的样本同源） */
const GBK_BYTES = Uint8Array.from([
  0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a,
  0xb2, 0xe2, 0xca, 0xd4, 0xd5, 0xfd, 0xce, 0xc4, 0xa1, 0xa3, 0x0a,
]);
/** File 的最小替身：被测代码只用到 name 与 arrayBuffer() */
const fileOf = (name, bytes) => ({
  name,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

function freshEls() {
  const mk = (tag) => new El(tag);
  Object.assign(els, {
    upTitle: mk('input'), upAuthor: mk('input'), upTags: mk('input'), upNote: mk('textarea'),
    upClean: mk('input'), upCleanOpts: mk('div'), upKeepRaw: mk('input'), upNoSplit: mk('input'),
    upEncoding: mk('select'), upPrev: mk('div'), upDetected: mk('div'), encWrap: mk('div'),
    encManual: mk('div'), upProgWrap: mk('div'), upProgBar: mk('div'), upProgText: mk('div'),
    upConfirm: mk('button'), upList: mk('ul'), upStats: mk('div'), upFile: mk('input'),
    upForm: mk('form'), upHead: mk('h2'), upUpdateHint: mk('div'), upload: mk('div'),
    modalBox: makeModalBox(),
  });
  // 关掉「自动清洗排版」：currentCleanOpts 里的 input[name=cleanitem]:checked 是属性/伪类选择器，
  // 桩按设计 fail-fast；本轮四条修复都与清洗无关，关掉即可（解码/分章照常跑）。
  els.upClean.checked = false;
  els.upKeepRaw.checked = true;
  els.upForm.reset = () => { for (const k of ['upTitle', 'upAuthor', 'upTags', 'upNote']) els[k].value = ''; };
}

/** 每条用例都从「刚进入上传页」的真实状态开始 */
function resetAll() {
  freshEls();
  upSession.clear();
  upSession.setUploading(false);
  upSession.setImporting(false);
  upSession.setReading(false);
  upSession.setCreatedId(null);
  upSession.setRawReq(null);
  invalidateAutoEnc();
  openUpload(); // 走真实入口：清表单 + resetAutoTitle + 编码下拉重建
}

/** 网络层替身：记录所有请求；putChapters 可挂闸门（用于「请求在飞时」取证） */
function makeApi({ oldKeys = ['old1'], holdPut = null } = {}) {
  const calls = { putRaw: [], putChapters: [], create: [], update: [], publish: [] };
  api.createBook = async (p) => {
    calls.create.push(p);
    return { id: 'n_new', chapterKeys: p.chapters.map((_, i) => 'k' + (i + 1)) };
  };
  api.updateChapters = async (id, body) => {
    calls.update.push({ id, body });
    const n = body.chapters.length;
    const keys = body.op === 'append'
      ? [...oldKeys, ...Array.from({ length: n }, (_, i) => 'new' + (i + 1))]
      : Array.from({ length: n }, (_, i) => 'k' + (i + 1));
    return { chapterKeys: keys };
  };
  api.putChapters = async (id, items) => {
    calls.putChapters.push({ id, items });
    if (holdPut) await holdPut.promise;
    return { count: items.length };
  };
  api.putRaw = async (id, bytes) => { calls.putRaw.push({ id, bytes }); return { ok: true }; };
  api.publish = async (id) => { calls.publish.push(id); return {}; };
  api.deleteBook = async () => ({ ok: true });
  return calls;
}

const previewRows = () => els.upList.querySelectorAll('input, textarea, button');

/* ════════════ P2-2：append 绝不覆盖原件 ════════════ */

test('P2-2 append 不得写原件；整本替换必须照写（别修过头）', async () => {
  resetAll();
  const calls = makeApi({ oldKeys: ['old1'] });
  await prepareFile(fileOf('第二卷.txt', UTF8_BYTES));

  // 追加：走 uploadToExisting(id, 'append')
  upSession.current().updating = { id: BOOK.id, op: 'append', book: BOOK };
  await onConfirm();
  assert.equal(calls.update[0].body.op, 'append');
  assert.equal(calls.putRaw.length, 0,
    'append 写了原件 → 之后「重新清洗」会用这次的追加片段替换整本正文（老章全丢，且无任何提示）');
  // 追加只传新章（旧章 keys 不重传），否则正文会被重复写一遍
  assert.deepEqual(calls.putChapters[0].items.map((x) => x.key), ['new1', 'new2']);

  // 对照：整本替换照常写原件 —— 修复不能把「重洗」能力一起阉掉
  resetAll();
  const c2 = makeApi();
  await prepareFile(fileOf('第二卷.txt', UTF8_BYTES));
  upSession.current().updating = { id: BOOK.id, op: 'replace', book: BOOK };
  await onConfirm();
  assert.equal(c2.update[0].body.op, 'replace');
  assert.equal(c2.putRaw.length, 1, 'replace 必须写原件（重洗的数据源）');
  assert.equal(c2.putRaw[0].id, BOOK.id);
});

/* ════════════ P2-6：上传一开始就锁预览行 ════════════ */

test('P2-6 上传的同步段就要锁住预览行，结束后（含失败）放行', async () => {
  resetAll();
  const gate = deferred();
  makeApi({ holdPut: gate });
  await prepareFile(fileOf('锁测试.txt', UTF8_BYTES));
  assert.ok(previewRows().length > 0, '预览必须渲染出可编辑行');
  assert.ok(previewRows().every((el) => el.disabled === false), '刚渲染完必须可编辑（R8 的回归基线）');

  const p = onConfirm(); // 同步段在第一个 await 之前就执行完
  assert.ok(previewRows().every((el) => el.disabled === true),
    '上传在飞时预览行必须全部禁用：否则改标题/删章会写进 session.preview，而入库用的是冻结快照 → 改动被静默丢弃');
  assert.equal(els.upConfirm.disabled, true);

  gate.resolve();
  await p;
  assert.ok(previewRows().every((el) => el.disabled === false), '上传结束必须放行');
});

test('P2-6 上传失败后同样放行预览行（用户要能改完重试）', async () => {
  resetAll();
  const calls = makeApi();
  api.putChapters = async () => { throw new Error('boom'); };
  await prepareFile(fileOf('失败书.txt', UTF8_BYTES));
  await onConfirm();
  assert.ok(toastEl.textContent.includes('上传失败'), '失败要有提示');
  assert.ok(previewRows().every((el) => el.disabled === false), '失败后必须放行（否则预览区永久只读）');
  assert.equal(calls.putRaw.length, 1, '本次是新建流程，原件照常上传');
});

/* ════════════ P2-1：编码选择不得跨文件残留 ════════════ */

test('P2-1 手选编码后换文件，必须回到自动检测（否则整本乱码入库）', async () => {
  resetAll();
  makeApi();
  els.upEncoding.value = 'gb18030'; // 模拟用户上一本手选了 GB18030
  invalidateAutoEnc();
  await handleFiles([fileOf('第二本.txt', UTF8_BYTES)]);
  const pv = upSession.current().preview;
  assert.equal(pv.encoding, 'utf-8', '换文件后仍按上一本手选的 gb18030 解 → 整本乱码，且检测行还写着「已按 gb18030 解析」');
  assert.ok(pv.chapters.some((c) => (c.content || '').includes('这是正文')), '正文必须是可读中文');
});

test('P2-1 批量导入逐本复位编码（批量没有下拉 UI，用户连发现的机会都没有）', async () => {
  resetAll();
  const calls = makeApi();
  els.upEncoding.value = 'gb18030';
  invalidateAutoEnc();
  await handleFiles([fileOf('批量一.txt', UTF8_BYTES), fileOf('批量二.txt', UTF8_BYTES)]);
  assert.equal(calls.create.length, 2, '两本都应入库');
  const texts = calls.putChapters.flatMap((c) => c.items.map((i) => i.text)).join('\n');
  assert.ok(texts.includes('这是正文'), '批量里第一本之后的编码必须复位到自动检测');
  assert.equal((texts.match(/这是正文/g) || []).length, 2, '两本都要解对（各含一处「这是正文」）');
});

test('P2-1 GBK 文件本身仍能被自动识别（复位不等于放弃检测）', async () => {
  resetAll();
  makeApi();
  await handleFiles([fileOf('gbk书.txt', GBK_BYTES)]);
  const pv = upSession.current().preview;
  assert.equal(pv.encoding, 'gb18030');
  assert.ok(pv.chapters.some((c) => (c.content || '').includes('测试正文')));
});

/* ════════════ P2-3：书名跟随新文件 ════════════ */

test('P2-3 书名跟随新文件；用户手输的书名不被覆盖', async () => {
  resetAll();
  makeApi();
  await handleFiles([fileOf('第一本.txt', UTF8_BYTES)]);
  assert.equal(els.upTitle.value, '第一本');

  await handleFiles([fileOf('第二本.txt', UTF8_BYTES)]);
  assert.equal(els.upTitle.value, '第二本',
    '换文件后标题仍是上一本的文件名 → 入库成「标题A / 正文B」（预览面板几乎不可辨）');

  els.upTitle.value = '我自己的书名';
  await handleFiles([fileOf('第三本.txt', UTF8_BYTES)]);
  assert.equal(els.upTitle.value, '我自己的书名', '用户手输的书名一律不得被文件名覆盖');
});

test('P2-3 粘贴文本时，标题若是上一本自动带出的文件名则换成粘贴标题', async () => {
  resetAll();
  makeApi();
  await handleFiles([fileOf('上一本.txt', UTF8_BYTES)]);
  assert.equal(els.upTitle.value, '上一本');
  onPasteText({ clipboardData: { getData: () => '粘贴的正文\n第二段。' }, preventDefault: NOP });
  assert.ok(els.upTitle.value.startsWith('粘贴文本_'),
    '粘贴后标题仍是「上一本」→ 又是标题A/正文B');
  assert.ok(toastEl.textContent.length >= 0); // 仅确保 paste 路径跑通（toast 内容不参与断言）
});

/* ════════════ 反向对照：文件名里的扩展名剥离 ════════════ */

test('P2-3 扩展名剥离仍生效（.txt/.text 大小写不敏感）', async () => {
  resetAll();
  makeApi();
  await handleFiles([fileOf('书名.TEXT', UTF8_BYTES)]);
  assert.equal(els.upTitle.value, '书名');
});
