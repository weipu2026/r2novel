/* review-fix147.test.mjs — 功能评审 #147 四组修复的回归
 *
 * 四组问题的共同点：**都不会抛错、界面照常渲染**，只有比对「会话是否建立 / DOM 的禁用态与原因 /
 * 搜索命中的集合 / 继续阅读的取数来源」才能分辨。所以 A/B 的纯函数直接从源码抽出后**真跑**
 * （而不是断言源码里出现了某个字符串），C 用 DOM 桩驱动真实上传链路。
 *
 *   A 搜索只匹配书名/标签 + 多词不分词 → 按作者搜 0 本、「诡秘 之主」0 本
 *   B 首/末章翻页按钮看着可用却毫无反应 → 用户分不清「到头了」还是「卡死」
 *   C 0 字节文件进预览死路（灰按钮没有任何原因说明）
 *   D 「继续阅读」取全量 books → 筛选生效时与网格互相矛盾
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, makeModalBox, El, NOP } from './_dom-stub.mjs';

installDom();
globalThis.Option = function Option(text, value) {
  const el = new El('option');
  el.textContent = text;
  el.value = value;
  return el;
};

const APP_SRC = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const READER_SRC = readFileSync(new URL('../public/js/reader.js', import.meta.url), 'utf8');

/** 从源码里按名字取出一个顶层函数声明（按花括号配平，不用固定字符窗口 —— 函数一变长就击穿） */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '源码里找不到 function ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号未配平: ' + name);
}

/* ════════════ A：搜索范围与分词 ════════════ */

const matchTerms = new Function('return ' + extractFn(APP_SRC, 'matchTerms'))();
const BOOKS = [
  { title: '剑来', author: '烽火戏诸侯', tags: ['仙侠', '玄幻'], note: '' },
  { title: '雪中悍刀行', author: '烽火戏诸侯', tags: ['武侠'], note: '已读完，想再看一遍' },
  { title: '诡秘之主', author: '爱潜水的乌贼', tags: ['西幻'], note: '' },
];

const hit = (terms) => BOOKS.filter((b) => matchTerms(b, terms.map((t) => t.toLowerCase())));

test('A1 作者字段参与匹配（旧实现只查 title/tags → 0 本）', () => {
  assert.deepEqual(hit(['烽火戏诸侯']).map((b) => b.title), ['剑来', '雪中悍刀行']);
});

test('A2 备注字段参与匹配', () => {
  assert.deepEqual(hit(['想再看一遍']).map((b) => b.title), ['雪中悍刀行']);
});

test('A3 多词按 AND 分词（旧实现整串 includes → 「诡秘 之主」0 本）', () => {
  assert.deepEqual(hit(['诡秘', '之主']).map((b) => b.title), ['诡秘之主']);
  // 跨字段组词也要命中：作者 + 书名
  assert.deepEqual(hit(['乌贼', '诡秘']).map((b) => b.title), ['诡秘之主']);
  // AND 不是 OR：任一词不命中就整条不命中
  assert.equal(hit(['诡秘', '不存在的词']).length, 0);
});

test('A4 字段之间不得串味（分隔符必须挡跨字段命中）', () => {
  // 书名尾字（来）+ 作者首字（烽）拼起来是「来烽」，任何单一字段里都不存在
  assert.equal(hit(['来烽']).length, 0, '字段拼接让「书名尾 + 作者头」误命中 → 分隔符没起作用');
  assert.equal(hit(['烽来']).length, 0);
});

test('A5 filteredBooks 走 matchTerms 且不再保留旧的整串 includes', () => {
  const fn = extractFn(APP_SRC, 'filteredBooks');
  assert.ok(fn.includes('matchTerms(b, terms)'), 'filteredBooks 必须调用 matchTerms');
  assert.ok(/split\(\/\\s\+\//.test(fn), '查询必须按空白分词');
  assert.ok(!fn.includes('const q = ui.q.toLowerCase();'), '旧的整串 includes 写法还在');
  assert.deepEqual(hit([]), BOOKS, '空查询不过滤（terms 为空时不能把书架清空）');
});

/* ════════════ B：翻页按钮的「到头」状态 ════════════ */

/** 抽取 syncStepBtns 并用假 els 执行：只依赖 els.btnPrev / els.btnNext 两个对象 */
function runSyncStepBtns(i, len) {
  const fake = {
    els: {
      btnPrev: { setAttribute: (k, v) => { fake.prev[k] = v; } },
      btnNext: { setAttribute: (k, v) => { fake.next[k] = v; } },
    },
    prev: {},
    next: {},
  };
  const fn = new Function('els', 'return ' + extractFn(READER_SRC, 'syncStepBtns'))(fake.els);
  fn(i, len);
  return { prev: fake.prev, next: fake.next };
}

test('B1 单章书：两个箭头都标到头（旧实现全绿、点了没反应）', () => {
  const r = runSyncStepBtns(0, 1);
  assert.equal(r.prev['aria-disabled'], 'true');
  assert.equal(r.next['aria-disabled'], 'true');
});

test('B2 首章只有「上一章」到头、末章只有「下一章」到头', () => {
  const first = runSyncStepBtns(0, 12);
  assert.equal(first.prev['aria-disabled'], 'true');
  assert.equal(first.next['aria-disabled'], 'false');

  const last = runSyncStepBtns(11, 12);
  assert.equal(last.prev['aria-disabled'], 'false');
  assert.equal(last.next['aria-disabled'], 'true');

  const mid = runSyncStepBtns(5, 12);
  assert.equal(mid.prev['aria-disabled'], 'false');
  assert.equal(mid.next['aria-disabled'], 'false');
});

test('B3 章表未加载（len=0）时两个箭头都到头，不能反着标成可用', () => {
  const r = runSyncStepBtns(0, 0);
  assert.equal(r.prev['aria-disabled'], 'true');
  assert.equal(r.next['aria-disabled'], 'true');
});

test('B4 状态必须随章号更新（updateProgressLine 里调用），且越界要有提示', () => {
  const upd = extractFn(READER_SRC, 'updateProgressLine');
  assert.ok(upd.includes('syncStepBtns('), 'updateProgressLine 没同步按钮状态 → 按钮永远保持初始态');
  const gt = extractFn(READER_SRC, 'goto');
  assert.ok(!/if \(idx < 0 \|\| idx >= state\.chapters\.length\) return;/.test(gt), 'goto 越界仍然静默 return');
  assert.ok(gt.includes('已经是第一章') && gt.includes('已经是最后一章'), 'goto 越界没有给用户任何提示');
  // 提示背后必须是 showTip（阅读器自己的 tip 通道），不能是 console
  assert.ok(/showTip\(/.test(gt));
});

/* ════════════ C：空文件上传（DOM 桩驱动真实链路） ════════════ */

const { els } = await import('../public/js/dom.js');
const { provide } = await import('../public/js/upload/ctx.js');
const { bindToast } = await import('../public/js/ui.js');
const { api } = await import('../public/js/store.js');
const upSession = await import('../public/js/upload/session.js');
const { invalidateAutoEnc } = await import('../public/js/upload/preview.js');
const { prepareFile } = await import('../public/js/upload/prepare.js');

const toastEl = new El('div');
bindToast(toastEl);
provide({ showView: NOP, loadShelf: async () => {}, getBooks: () => [], openModal: NOP, closeModal: NOP, confirmModal: async () => true, syncPresetChips: NOP, refreshPresetTags: NOP, parseTagInput: () => [] });
api.createBook = async () => ({ id: 'x', chapterKeys: [] });

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
  els.upClean.checked = false; // 「自动清洗」关掉：干净样本与清洗无关，也避开桩不支持的伪类选择器
  els.upKeepRaw.checked = true;
  els.upForm.reset = () => { for (const k of ['upTitle', 'upAuthor', 'upTags', 'upNote']) els[k].value = ''; };
  els.upPrev.classList.add('hidden'); // 模拟「刚进入上传页」
  toastEl.textContent = '';
  toastEl.classList.remove('show');
}

function resetAll() {
  freshEls();
  upSession.clear();
  upSession.setUploading(false);
  upSession.setImporting(false);
  upSession.setReading(false);
  invalidateAutoEnc();
}

const fileOf = (name, bytes) => ({
  name,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
const UTF8 = (s) => new TextEncoder().encode(s);

test('C1 0 字节文件：不建会话、不进预览、明确提示（旧实现进预览死路）', async () => {
  resetAll();
  await prepareFile(fileOf('empty.txt', new Uint8Array(0)));

  assert.equal(upSession.current(), null, '空文件仍然建了会话 → 用户会看到「0 章 · 0 字」的预览');
  assert.equal(els.upPrev.classList.contains('hidden'), true, '空文件不该展开预览面板');
  assert.equal(els.upConfirm.disabled, true);
  assert.match(els.upConfirm.getAttribute('title') || '', /空/, '禁用了却不说原因');
  assert.match(toastEl.textContent, /空文件/, '没有 toast 说明是文件本身的问题');
  assert.match(toastEl.textContent, /empty\.txt/, '提示里要带文件名，否则批量场景不知道中招的是哪个');
});

test('C2 换到正常文件后必须恢复正常（别修过头）', async () => {
  resetAll();
  // 必须先真的走一遍空文件：否则夹具是新建的、本来就没有 title，测不出「残留」
  await prepareFile(fileOf('empty.txt', new Uint8Array(0)));
  assert.ok(els.upConfirm.getAttribute('title'), '前置：空文件该留下禁用原因');

  await prepareFile(fileOf('ok.txt', UTF8('第一章 开始\n\n' + '正文。'.repeat(80) + '\n\n第二章 继续\n\n' + '又一段。'.repeat(80))));
  assert.ok(upSession.current(), '正常文件必须建立会话');
  assert.equal(els.upPrev.classList.contains('hidden'), false, '正常文件必须展开预览');
  assert.equal(els.upConfirm.disabled, false, '有章节却禁用确认按钮');
  assert.ok(!els.upConfirm.getAttribute('title'), '正常态残留了空文件那次的禁用原因');
});

test('C3 有字节但清洗后 0 章（纯空白）：禁用必须写明原因', async () => {
  resetAll();
  await prepareFile(fileOf('blank.txt', UTF8('   \n\n   \t  \n\n  ')));
  const sess = upSession.current();
  assert.ok(sess, '有字节就该建会话（这条不是空文件拦截的范围）');
  assert.equal(sess.preview.chapters.length, 0, '纯空白文件应当解析出 0 章');
  assert.equal(els.upConfirm.disabled, true);
  assert.match(els.upConfirm.getAttribute('title') || '', /没有可入库的章节/, '0 章时按钮是灰的但没有任何说明');
});

/* ════════════ D：继续阅读跟随筛选 ════════════ */

test('D1 继续阅读必须取自 filteredBooks()，不能是全量 books', () => {
  const fn = extractFn(APP_SRC, 'renderShelf');
  assert.ok(fn.includes('const reading = filteredBooks()'), '继续阅读仍从全量 books 取数 → 与筛选结果矛盾');
  assert.ok(!/const reading = books\b/.test(fn), '旧的「全量 books」写法还在');
  // 取数之后必须仍然按「有进度 + 未读完 + 最近阅读」三条过滤，改数据源不等于放松条件
  assert.ok(fn.includes('b.prog && b.prog.updatedAt > 0 && readState(b) !== \'done\''), '过滤条件被弱化');
  assert.ok(fn.includes('.slice(0, 3)'), '继续阅读仍应只取前 3 本');
});

test('D2 filteredBooks 本身不受影响地支持全部筛选维度', () => {
  const fn = extractFn(APP_SRC, 'filteredBooks');
  for (const k of ['ui.tag', 'ui.finished', 'ui.readState', 'ui.star']) {
    assert.ok(fn.includes(k), '筛选维度缺失：' + k);
  }
});
