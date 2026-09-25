/* upload/preview.js — 清洗预览：分章结果渲染 + 预览可编辑（改标题 / 改正文 / 增删章）
 *
 * 纯「会话 → DOM」的单向渲染：所有状态都在 session 的会话对象里（preview.chapters 是本次
 * 入库的唯一事实源），这里只负责把它画出来、把编辑写回去。
 * pvIconBtn / pvIconBtnSvg 被「编辑章节」复用（同款细线图标按钮语言）。
 */
import { els, $$, IC } from '../dom.js';
import { fmtWords } from '../store.js';
import * as cleaner from '../cleaner.js';
import * as upSession from './session.js';

/* 「我们自动写进下拉框的编码值」（见 runPreview 开头的 forceEncoding 判定）。
 * 模块级而非会话级：跨会话残留无害——新会话 files.js 会把下拉重置为 'auto'，首跑即覆盖。 */
let lastAutoSet = null;

/** 手动指定编码入口（openEncPick）调用：用户已表达「我要手选」，此后下拉值 ≠ 'auto' 一律算手动 */
export function invalidateAutoEnc() {
  lastAutoSet = null;
}

function currentCleanOpts() {
  const o = { ...cleaner.DEFAULT_CLEAN_OPTS };
  const chosen = new Set($$('input[name=cleanitem]:checked', els.upCleanOpts).map((i) => i.value));
  o.stripMarkdown = chosen.has('md');
  o.stripRefMarks = chosen.has('ref');
  o.cleanGarbled = chosen.has('garbled');
  o.collapseBlank = chosen.has('blank');
  o.indent = chosen.has('indent');
  o.joinSoft = chosen.has('join');
  o.unifyQuotes = chosen.has('quote');
  o.stripSite = chosen.has('site');
  return o;
}

export function runPreview() {
  const sess = upSession.current(); // 本函数作用域内下方已有 const cur（当前编码），故这里用 sess
  if (!sess || !sess.bytes) return;
  // 总开关「自动清洗排版」：关闭则整链不套清理（只按编码解码 + 分章）
  const useClean = els.upClean.checked;
  const cleanOpts = useClean ? currentCleanOpts() : { clean: false };
  // 编码是否「用户手动指定」：下拉框的 value 会被本函数**自动写入**检测结果，
  // 若只看 value !== 'auto'，下一次任何重跑（切换清洗项/不分章）都会把自动写入的值
  // 误读成用户手选，静默钉死编码、检测行文案也跟着变。lastAutoSet 记录「我们写的值」，
  // 与之相等即视为自动；用户真正在 下拉里换选 时 change 事件带来新值 ≠ lastAutoSet 才算手动。
  let forceEncoding = els.upEncoding.value;
  if (forceEncoding === 'auto' || forceEncoding === lastAutoSet) forceEncoding = null;
  const t0 = Date.now();
  const r = cleaner.processBook(sess.bytes, {
    fallbackTitle: sess.title,
    cleanOpts,
    forceEncoding,
    // 「不分章」：分章规则切错时的逃生门 —— 整本一章，取消勾选即恢复自动分章
    pattern: els.upNoSplit && els.upNoSplit.checked ? 'none' : 'auto',
  });
  // 服务端单章上限 2MB：超大章（整本一章兜底等）先按 UTF-8 字节边界自动分段，避免 413 中断留下半成品书
  const fit = cleaner.fitChapters(r.chapters);
  if (fit.extra > 0) r.fitNote = `含 ${fit.extra} 个超大单章，已自动分段`;
  r.chapters = fit.chapters;
  sess.preview = r;
  sess.cleanOpts = cleanOpts;
  const ms = Date.now() - t0;

  // 编码下拉：只在该出手时才出现 ——
  // · 自动检测且结果唯一（其余候选都解不出/分数极低）→ 纯文本展示，无下拉
  // · 自动检测存在歧义候选 / 曾手动指定过 → 显示下拉可切换
  const encSel = els.upEncoding;
  const manual = !!forceEncoding;
  const cur = forceEncoding || r.encoding;
  const pool = manual
    ? ['utf-8', 'gb18030', 'big5']
    : (r.candidates || []).filter((c) => c.encoding !== 'auto' && c.score > -100).map((c) => c.encoding);
  if (manual && !pool.includes(cur)) pool.unshift(cur);
  const showSel = manual || pool.some((c) => c !== cur);
  encSel.innerHTML = '';
  encSel.appendChild(new Option('自动检测', 'auto'));
  for (const c of pool) encSel.appendChild(new Option(c, c));
  encSel.value = cur;
  // 记录「本轮我们自动写入的值」：用户手动换选后该记录作废（见函数开头的 forceEncoding 判定）
  lastAutoSet = manual ? null : cur;
  els.encWrap.classList.toggle('hidden', !showSel);
  // 无歧义时隐藏下拉，但保留「手动指定编码」小入口（自动结果异常时可干预）
  els.encManual.classList.toggle('hidden', showSel);
  els.upDetected.textContent = manual
    ? (r.chapters.length
        ? `已按 ${cur} 编码解析${r.replaced ? '，含 ' + r.replaced + ' 个乱码符' : ''}`
        : `按 ${cur} 编码解析失败，请换一种或改回自动检测`)
    : `检测编码：${r.encoding}${r.replaced ? '，含 ' + r.replaced + ' 个乱码符' : ''} · 分章规则：${r.detected === 'none' ? '不分章（整本一章）' : (r.detected || '未识别（整本一章）')} · 处理 ${ms}ms`;

  if (upSession.isImporting()) {
    // 批量导入：预览面板整段不可见（反馈走上传进度条），这里只需会话里的 preview 数据。
    // 跳过 renderPreviewChapters 的 ≤500 行 DOM 重建（每本一次，纯无效开销，大库批量导入会明显卡顿）
    els.upPrev.classList.add('hidden');
    return;
  }
  els.upPrev.classList.remove('hidden');
  // 统计与列表交给 renderPreviewChapters 实时维护（预览可编辑后章数/字数会变）
  renderPreviewChapters();
}

/* 预览可编辑（改标题 / 改正文 / 增删章）：预览只是本地数组，直接改当前会话的
 * preview.chapters，确认后走原入库通道。超过 MAX_PREVIEW 章只渲染前 500 行，确认时仍整本上传。 */
const MAX_PREVIEW = 500;

function refreshPreviewStats() {
  const pv = upSession.current().preview;
  const chs = pv.chapters;
  const words = chs.reduce((s, c) => s + cleaner.countWords(c.content || ''), 0);
  pv.words = words; // 入库 payload 从此处读取
  els.upStats.textContent = `${chs.length} 章 · ${fmtWords(words)}${pv.fitNote ? ' · ' + pv.fitNote : ''}`;
}

function updateConfirmBtn() {
  const cur = upSession.current();
  const chs = cur && cur.preview ? cur.preview.chapters : [];
  els.upConfirm.disabled = !chs.length;
  const isUpd = !!(cur && cur.updating && cur.updating.id);
  els.upConfirm.textContent = isUpd
    ? (cur.updating.op === 'append' ? `追加到《${cur.updating.book.title}》` : `整本替换《${cur.updating.book.title}》`)
    : '确认入库';
}

export function pvIconBtn(text, title, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pv-btn' + (danger ? ' danger' : '');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** 图标版小按钮（与 pvIconBtn 同构，内容为 SVG） */
export function pvIconBtnSvg(name, title, onClick, danger) {
  const b = pvIconBtn('', title, onClick, danger);
  b.innerHTML = IC[name];
  return b;
}

function buildPreviewRow(ch, i) {
  const li = document.createElement('li');
  li.className = 'pv-row';
  const line = document.createElement('div');
  line.className = 'pv-line';
  const n = document.createElement('span');
  n.className = 'ch-no';
  n.textContent = String(i + 1);
  const input = document.createElement('input');
  input.className = 'ch-t';
  input.placeholder = '第' + (i + 1) + '章';
  input.value = ch.title || '';
  input.addEventListener('input', () => { ch.title = input.value; });
  const w = document.createElement('span');
  w.className = 'ch-w';
  const wcText = () => { w.textContent = fmtWords(cleaner.countWords(ch.content || '')); };
  wcText();
  const bodyBox = document.createElement('div');
  bodyBox.className = 'pv-body hidden';
  const ta = document.createElement('textarea');
  ta.rows = 8;
  ta.placeholder = '本章正文（清洗后的内容，将原样入库；标题留空则按位置自动命名）';
  ta.value = ch.content || '';
  ta.addEventListener('input', () => { ch.content = ta.value; wcText(); });
  bodyBox.appendChild(ta);
  line.append(
    n,
    input,
    w,
    pvIconBtnSvg('pen', '编辑正文', () => {
      bodyBox.classList.toggle('hidden');
      if (!bodyBox.classList.contains('hidden')) ta.focus();
    }),
    pvIconBtnSvg('plus', '在本章后插入一章', () => insertPreviewAfter(i)),
    pvIconBtnSvg('x', '删除本章', () => {
      upSession.current().preview.chapters.splice(i, 1);
      renderPreviewChapters();
    }, true)
  );
  li.append(line, bodyBox);
  return li;
}

/** 在第 i 章（0-based）之后插一个空章；-1/空列表时插在最前 */
function insertPreviewAfter(i) {
  upSession.current().preview.chapters.splice(i + 1, 0, { title: '', content: '' });
  renderPreviewChapters();
  const rows = $$('#upList .pv-row');
  const t = rows[i + 1] && rows[i + 1].querySelector('.ch-t');
  if (t) {
    t.focus();
    t.scrollIntoView({ block: 'nearest' });
  }
}

function appendPreview() {
  upSession.current().preview.chapters.push({ title: '', content: '' });
  renderPreviewChapters();
  const rows = $$('#upList .pv-row');
  const t = rows[rows.length - 1] && rows[rows.length - 1].querySelector('.ch-t');
  if (t) {
    t.focus();
    t.scrollIntoView({ block: 'nearest' });
  }
}

function renderPreviewChapters() {
  const ul = els.upList;
  ul.innerHTML = '';
  const chs = upSession.current().preview.chapters;
  chs.slice(0, MAX_PREVIEW).forEach((c, i) => ul.appendChild(buildPreviewRow(c, i)));
  if (chs.length > MAX_PREVIEW) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `…共 ${chs.length} 章，确认后全部上传`;
    ul.appendChild(li);
  }
  const addLi = document.createElement('li');
  addLi.className = 'pv-add';
  addLi.appendChild(pvIconBtn('＋ 在末尾追加一章', '追加到末尾', appendPreview));
  ul.appendChild(addLi);
  refreshPreviewStats();
  updateConfirmBtn();
}
