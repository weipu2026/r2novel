/* app.js — 登录 / 书架（M2 管理）/ 上传 / 回收站 / 阅读入口（电脑上传为主，手机阅读为主） */
import { api, local, fmtWords, ApiError } from './store.js';
import * as cleaner from './cleaner.js';
import * as reader from './reader.js';
import { bindBusy, busy, busyDone } from './ui.js';
import { exportBookTxt } from './exporter.js';

const $ = (sel, scope) => (scope || document).querySelector(sel);
const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));
const normTitle = (s) => String(s || '').replace(/\s+/g, '');

const PAGE = 60; // 书库分页

const els = {};
let books = []; // 全量在架书（服务端已含 pinned/prog 镜像）
let ui = { sort: 'recent', q: '', tag: '', page: 1 };

export function init() {
  ['login', 'shelf', 'upload', 'trash'].forEach((v) => {
    els[v] = $('#view-' + v);
  });
  els.readRoot = $('#view-read');
  els.loginPwd = $('#loginPwd');
  els.loginBtn = $('#loginBtn');
  els.loginErr = $('#loginErr');
  els.logoutBtn = $('#logoutBtn');
  els.uploadBtn = $('#uploadBtn');
  els.trashBtn = $('#trashBtn');
  els.continueCard = $('#continueCard');
  els.continueWrap = $('#continueWrap');
  els.grid = $('#bookGrid');
  els.shelfCount = $('#shelfCount');
  els.searchInput = $('#searchInput');
  els.sortSel = $('#sortSel');
  els.tagCloud = $('#tagCloud');
  els.filterNote = $('#filterNote');
  els.loadMoreBtn = $('#loadMoreBtn');
  els.trashCount = $('#trashCount');
  els.trashList = $('#trashList');
  els.trashBack = $('#trashBack');
  els.trashClear = $('#trashClear');
  els.sheet = $('#sheet');
  els.modalMask = $('#modalMask');
  els.modalBox = $('#modalBox');
  els.busyMask = $('#busyMask');
  els.busyBar = $('#busyBar');
  els.busyText = $('#busyText');
  els.toast = $('#toast');

  // upload view
  els.upHead = $('#upTitleHead');
  els.upFile = $('#upFile');
  els.upForm = $('#upForm');
  els.upDrop = $('#upDrop');
  els.upTitle = $('#upTitle');
  els.upAuthor = $('#upAuthor');
  els.upTags = $('#upTags');
  els.upNote = $('#upNote');
  els.upClean = $('#upClean');
  els.upCleanOpts = $('#upCleanOpts');
  els.upEncoding = $('#upEncoding');
  els.encWrap = $('#encWrap');
  els.encManual = $('#encManual');
  els.upDetected = $('#upDetected');
  els.upPrev = $('#upPrev');
  els.upStats = $('#upStats');
  els.upList = $('#upList');
  els.upKeepRaw = $('#upKeepRaw');
  els.upCancel = $('#upCancel');
  els.upConfirm = $('#upConfirm');
  els.upProgWrap = $('#upProgWrap');
  els.upProgBar = $('#upProgBar');
  els.upProgText = $('#upProgText');
  els.upUpdateHint = $('#upUpdateHint');

  // 左上角品牌：任何视图点击都回到书架（书架点击即刷新）
  $$('.top .brand').forEach((b) => b.addEventListener('click', () => {
    showView('shelf');
    loadShelf().catch(() => {});
  }));

  // 书架事件
  els.login.addEventListener('submit', doLogin);
  els.logoutBtn.addEventListener('click', logout);
  els.uploadBtn.addEventListener('click', () => openUpload());
  els.trashBtn.addEventListener('click', openTrash);
  els.trashBack.addEventListener('click', () => { showView('shelf'); loadShelf().catch(() => {}); });
  els.trashClear.addEventListener('click', clearTrashFlow);
  els.searchInput.addEventListener('input', () => { ui.q = els.searchInput.value.trim(); ui.page = 1; renderShelf(); });
  els.sortSel.addEventListener('change', () => { ui.sort = els.sortSel.value; ui.page = 1; renderShelf(); });
  els.loadMoreBtn.addEventListener('click', () => { ui.page++; renderShelf(); });

  // 上传事件
  els.upCancel.addEventListener('click', () => showView('shelf'));
  els.upFile.addEventListener('change', onFileChosen);
  els.upConfirm.addEventListener('click', onConfirm);
  els.upClean.addEventListener('change', () => {
    els.upCleanOpts.classList.toggle('off', !els.upClean.checked);
    runPreview();
  });
  els.upCleanOpts.addEventListener('change', () => runPreview());
  els.upEncoding.addEventListener('change', () => runPreview());
  els.encManual.addEventListener('click', openEncPick);
  els.upForm.addEventListener('submit', (e) => e.preventDefault());
  // 拖拽
  for (const ev of ['dragenter', 'dragover']) {
    els.upDrop.addEventListener(ev, (e) => { e.preventDefault(); els.upDrop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    els.upDrop.addEventListener(ev, (e) => { e.preventDefault(); els.upDrop.classList.remove('over'); });
  }
  els.upDrop.addEventListener('drop', (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) handleFiles(files).catch((err) => toast('读取失败：' + err.message, 2500));
  });
  // 上传页内任意处粘贴整段文本 → 直接当书（书名输入框等表单控件内粘贴除外）
  document.addEventListener('paste', (e) => {
    if (els.upload.classList.contains('hidden')) return; // 仅上传页生效
    if (!els.upPrev.classList.contains('hidden')) return; // 预览已出则忽略（避免误触覆盖已选文件）
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    onPasteText(e);
  });

  reader.bindReader(els.readRoot, onNavBack);
  bindBusy({ bar: els.busyBar, text: els.busyText, mask: els.busyMask });
  boot();
}

function onNavBack() {
  showView('shelf');
  loadShelf().catch(() => {});
}

async function boot() {
  try {
    const data = await api.books(); // 一次拉取，鉴权预检 + 首屏数据共用
    showView('shelf');
    await loadShelf(data);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) showView('login');
    else {
      showView('login');
      els.loginErr.textContent = '连接服务器失败';
    }
  }
}

function showView(name) {
  ['login', 'shelf', 'upload', 'trash'].forEach((v) => els[v].classList.add('hidden'));
  els.readRoot.classList.add('hidden');
  els.sheet.classList.add('hidden');
  if (name === 'read') els.readRoot.classList.remove('hidden');
  else els[name].classList.remove('hidden');
}

/* ---------- 登录 ---------- */
async function doLogin(e) {
  e.preventDefault();
  els.loginErr.textContent = '';
  const pwd = els.loginPwd.value.trim();
  if (!pwd) return;
  els.loginBtn.disabled = true;
  try {
    await api.login(pwd);
    els.loginPwd.value = '';
    showView('shelf');
    await loadShelf();
  } catch (err) {
    els.loginErr.textContent = err.message || '登录失败';
  } finally {
    els.loginBtn.disabled = false;
  }
}

async function logout() {
  await api.logout();
  showView('login');
}

/* ---------- 书架 ---------- */
const PALETTE = ['#d97757', '#c2518c', '#7d66c9', '#4e8fd8', '#2f9e8f', '#4f9d4f', '#d0a43a', '#8a7a5c'];
function colorOf(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

async function loadShelf(data) {
  if (!data) data = await api.books();
  books = data.books || [];
  // 校正可能失效的筛选项
  if (ui.tag && !books.some((b) => (b.tags || []).includes(ui.tag))) ui.tag = '';
  ui.page = 1;
  renderShelf();
}

function filteredBooks() {
  let list = books;
  if (ui.q) {
    const q = ui.q.toLowerCase();
    list = list.filter((b) => b.title.toLowerCase().includes(q) || (b.tags || []).some((t) => t.toLowerCase().includes(q)));
  }
  if (ui.tag) list = list.filter((b) => (b.tags || []).includes(ui.tag));
  return list;
}

function sortedBooks(list) {
  const sorters = {
    recent: (a, b) => (b.prog && b.prog.updatedAt || 0) - (a.prog && a.prog.updatedAt || 0),
    updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    words: (a, b) => (b.wordCount || 0) - (a.wordCount || 0),
    title: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh'),
  };
  const s = sorters[ui.sort] || sorters.updated;
  const pinned = list.filter((b) => b.pinned).sort(s);
  const rest = list.filter((b) => !b.pinned).sort(s);
  return pinned.concat(rest);
}

function renderShelf() {
  els.shelfCount.textContent = books.length ? `共 ${books.length} 本 · ${fmtWords(books.reduce((s, b) => s + (b.wordCount || 0), 0))}` : '';

  // 最近阅读（继续阅读位）
  const last = local.getLast();
  const lastBook = last && books.find((b) => b.id === last.id);
  els.continueWrap.classList.toggle('hidden', !lastBook);
  if (lastBook) {
    // 用书架完整数据渲染（local 里只存了 id/书名，缺章数/字数/进度，会显示成 0）
    els.continueCard.innerHTML = '';
    els.continueCard.appendChild(makeCard(lastBook, true));
  }

  const list = sortedBooks(filteredBooks());
  els.filterNote.textContent = ui.q || ui.tag ? `筛选出 ${list.length} 本` : '';
  renderTagCloud();
  renderGrid(list);
}

function renderGrid(list) {
  const grid = els.grid;
  grid.innerHTML = '';
  const shown = list.slice(0, ui.page * PAGE);
  for (const b of shown) grid.appendChild(makeCard(b, false));
  const hasMore = shown.length < list.length;
  els.loadMoreBtn.classList.toggle('hidden', !hasMore);
  if (!list.length) {
    if (!books.length) {
      // 整个书库为空 → 居中引导卡（不会因网格窄格断行）
      const box = document.createElement('div');
      box.className = 'empty-state';
      const logo = document.createElement('div');
      logo.className = 'es-logo';
      logo.textContent = '书';
      const strong = document.createElement('strong');
      strong.textContent = '书库还是空的';
      const p = document.createElement('p');
      p.textContent = '上传你的第一本 txt 小说，自动分章、清洗排版，之后在电脑和手机上都能随时接着读。';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '＋ 上传第一本书';
      btn.addEventListener('click', () => openUpload());
      box.append(logo, strong, p, btn);
      grid.appendChild(box);
    } else {
      const p = document.createElement('p');
      p.className = 'empty muted';
      p.textContent = '没有匹配的书';
      grid.appendChild(p);
    }
  }
}

function tagCounts() {
  const m = new Map();
  for (const b of books) {
    for (const t of b.tags || []) m.set(t, (m.get(t) || 0) + 1);
  }
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).slice(0, 12);
}

function renderTagCloud() {
  const cloud = els.tagCloud;
  cloud.innerHTML = '';
  const tags = tagCounts();
  if (!tags.length) return;
  tags.forEach(([t, n]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${t} ${n}`;
    b.classList.toggle('on', ui.tag === t);
    b.addEventListener('click', () => {
      ui.tag = ui.tag === t ? '' : t;
      ui.page = 1;
      renderShelf();
    });
    cloud.appendChild(b);
  });
}

function progBadgeText(b) {
  const p = b.prog;
  if (!p || !p.updatedAt) return '';
  const cc = b.chapterCount || 0;
  const done = p.ch >= cc && cc > 0 && p.ratio > 0.96;
  if (done) return '已读完';
  if (p.ch <= 0) return '';
  const pct = p.ch >= cc ? Math.round((p.ratio || 0) * 100) : Math.round(((p.ch - 1 + (p.ratio || 0)) / cc) * 100);
  return `读到 ${p.ch}/${cc} 章 · ${Math.max(1, Math.min(99, pct))}%`;
}

function makeCard(b, big) {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'card' + (big ? ' big' : '') + (b.pinned ? ' pinned' : '');
  const block = document.createElement('span');
  block.className = 'card-block';
  block.style.background = colorOf(b.title);
  block.textContent = Array.from((b.title || '书'))[0];
  const info = document.createElement('span');
  info.className = 'card-info';
  const t = document.createElement('em');
  t.textContent = b.title;
  const m = document.createElement('small');
  const tags = (b.tags || []).slice(0, 2).join(' · ');
  m.textContent = [tags, `${b.chapterCount || 0} 章`, fmtWords(b.wordCount)].filter(Boolean).join(' · ');
  info.appendChild(t);
  info.appendChild(m);
  c.appendChild(block);
  c.appendChild(info);
  const badge = progBadgeText(b);
  if (badge) {
    const p = document.createElement('span');
    p.className = 'prog-badge' + (badge === '已读完' ? ' done' : '');
    p.textContent = badge;
    c.appendChild(p);
  }
  if (!big) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'card-more';
    more.textContent = '⋯';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openSheet(b);
    });
    c.appendChild(more);
  }
  c.addEventListener('click', () => openRead(b.id));
  return c;
}

async function openRead(id) {
  try {
    showView('read');
    await reader.openBook(id);
  } catch (e) {
    showView('shelf');
    if (e instanceof ApiError && e.status === 401) {
      toast('会话过期，请重新登录', 2500);
      showView('login');
    } else {
      toast('打开失败：' + (e.message || e), 2500);
    }
  }
}

/* ---------- 底部操作单 ---------- */
function openSheet(b) {
  const isPin = !!b.pinned;
  els.sheet.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sheet-title';
  title.textContent = b.title;
  els.sheet.appendChild(title);
  const items = [
    { text: '阅读', act: () => { closeSheet(); openRead(b.id); } },
    { text: isPin ? '取消置顶' : '置顶到书架顶部', act: async () => { closeSheet(); await safePatch(b.id, { pinned: !isPin }); } },
    { text: '编辑信息（书名/作者/标签/备注）', act: () => { closeSheet(); openEditModal(b); } },
    { text: '导出清洗后的 txt', act: () => { closeSheet(); exportBook(b); } },
    { text: '重新清洗（用原件重排）', act: () => { closeSheet(); rewash(b); } },
  ];
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = it.text;
    btn.addEventListener('click', it.act);
    els.sheet.appendChild(btn);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = '移入回收站';
  del.addEventListener('click', async () => {
    closeSheet();
    if (await confirmModal(`把《${b.title}》移入回收站？15 天内可恢复。`)) {
      try {
        await api.deleteBook(b.id);
        toast('已移入回收站', 1600);
        await loadShelf();
      } catch (e) {
        toast('删除失败：' + (e.message || e), 2500);
      }
    }
  });
  els.sheet.appendChild(del);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'dim';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeSheet);
  els.sheet.appendChild(cancel);
  els.sheet.classList.remove('hidden');
}

function closeSheet() {
  els.sheet.classList.add('hidden');
}

async function safePatch(id, patch) {
  try {
    await api.patchBook(id, patch);
    await loadShelf();
    if (patch.pinned !== undefined) toast(patch.pinned ? '已置顶' : '已取消置顶', 1400);
  } catch (e) {
    toast('操作失败：' + (e.message || e), 2500);
  }
}

/* ---------- 编辑信息模态 ---------- */
async function openEditModal(b) {
  let note = '';
  try {
    const meta = await api.bookMeta(b.id);
    if (meta) note = meta.note || '';
  } catch {
    /* 用书架摘要（无 note 则空） */
  }
  openModal(`
    <h3>编辑信息</h3>
    <p class="modal-sub">《${esc(b.title)}》 · ${b.chapterCount || 0} 章</p>
    <div class="m-field"><label>书名</label><input id="mdTitle" value="${esc(b.title)}"></div>
    <div class="m-field"><label>作者</label><input id="mdAuthor" value="${esc(b.author || '')}"></div>
    <div class="m-field"><label>标签（逗号分隔）</label><input id="mdTags" value="${esc((b.tags || []).join(', '))}"></div>
    <div class="m-field"><label>备注</label><input id="mdNote" value="${esc(note)}" placeholder="这本书的备注（个人备忘）"></div>
    <div class="m-acts">
      <button class="ghost" id="mdCancel" type="button">取消</button>
      <button class="primary" id="mdOk" type="button">保存</button>
    </div>`);
  $('#mdCancel', els.modalBox).addEventListener('click', closeModal);
  $('#mdOk', els.modalBox).addEventListener('click', async () => {
    const patch = {
      title: $('#mdTitle', els.modalBox).value.trim(),
      author: $('#mdAuthor', els.modalBox).value.trim(),
      tags: $('#mdTags', els.modalBox).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      note: $('#mdNote', els.modalBox).value.trim(),
    };
    if (!patch.title) return toast('书名不能为空', 1600);
    closeModal();
    await safePatch(b.id, patch);
  });
}

/* ---------- 模态通用 ---------- */
function openModal(html) {
  els.modalBox.innerHTML = html;
  els.modalMask.classList.remove('hidden');
}
function closeModal() {
  els.modalMask.classList.add('hidden');
}
function confirmModal(text, okText = '确定') {
  return new Promise((resolve) => {
    openModal(`
      <h3>确认</h3>
      <p class="modal-sub" style="font-size:14px">${esc(text)}</p>
      <div class="m-acts">
        <button class="ghost" id="cfNo" type="button">取消</button>
        <button class="primary" id="cfYes" type="button">${esc(okText)}</button>
      </div>`);
    $('#cfNo', els.modalBox).addEventListener('click', () => { closeModal(); resolve(false); });
    $('#cfYes', els.modalBox).addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- 导出清洗后 txt（F13，共用 exporter.js） ---------- */
async function exportBook(b) {
  try {
    busy(0.02, `正在导出《${b.title}》…`);
    const title = await exportBookTxt(b.id, (p) => busy(p, `拉取章节… ${Math.round(p * 100)}%`));
    toast(`《${title}》已导出`, 1800);
  } catch (e) {
    toast('导出失败：' + (e.message || e), 2800);
  } finally {
    busyDone();
  }
}

/* ---------- 回收站 ---------- */
async function openTrash() {
  showView('trash');
  await loadTrash();
}

async function loadTrash() {
  const data = await api.trash();
  const list = data.books || [];
  els.trashCount.textContent = list.length ? `${list.length} 本` : '';
  const wrap = els.trashList;
  wrap.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty muted';
    p.textContent = '回收站是空的';
    wrap.appendChild(p);
    return;
  }
  for (const b of list) {
    wrap.appendChild(trashRow(b));
  }
}

function trashRow(b) {
  const row = document.createElement('div');
  row.className = 'trash-item';
  const info = document.createElement('div');
  info.className = 'grow';
  const t = document.createElement('div');
  t.className = 't-title';
  t.textContent = b.title;
  const sub = document.createElement('div');
  sub.className = 't-sub' + (b.restorable ? '' : ' warn');
  const when = new Date(b.deletedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  sub.textContent = b.restorable ? `删除于 ${when} · ${b.chapterCount} 章` : `正文已部分清除（${b.purge} 章待清），无法恢复`;
  info.appendChild(t);
  info.appendChild(sub);
  row.appendChild(info);
  const acts = document.createElement('div');
  acts.className = 't-acts';
  if (b.restorable) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'ghost';
    restore.textContent = '恢复';
    restore.addEventListener('click', async () => {
      try {
        await api.restore(b.id);
        toast('已恢复', 1400);
        await loadTrash();
      } catch (e) {
        toast('恢复失败：' + (e.message || e), 2500);
      }
    });
    acts.appendChild(restore);
  }
  const purge = document.createElement('button');
  purge.type = 'button';
  purge.className = 'ghost';
  purge.textContent = '彻底删除';
  purge.addEventListener('click', () => purgeOne(b));
  acts.appendChild(purge);
  row.appendChild(acts);
  return row;
}

async function purgeOne(b) {
  if (!(await confirmModal(`彻底删除《${b.title}》？正文与原件将一并清除，无法恢复。`, '彻底删除'))) return;
  try {
    let remaining = 1;
    let guard = 0;
    while (remaining > 0 && guard++ < 1000) {
      const r = await api.purgeTrash(b.id);
      remaining = r.remaining || 0;
    }
    toast(remaining ? '删除未完成，请重试' : '已彻底删除', 1400);
    await loadTrash();
  } catch (e) {
    toast('删除失败：' + (e.message || e), 2500);
  }
}

async function clearTrashFlow() {
  if (!(await confirmModal('清空回收站？所有书籍正文将彻底删除，无法恢复。', '清空'))) return;
  try {
    busy(0.1, '正在清空…');
    let remaining = 1;
    let guard = 0;
    while (remaining > 0 && guard++ < 1000) {
      const r = await api.clearTrash();
      remaining = r.remaining || 0;
      busy(Math.max(0.05, 1 - remaining / 10), remaining ? `清空中…剩余 ${remaining} 本` : '完成');
    }
    toast(remaining ? '清空未完成，请重试' : '回收站已清空', 1500);
    await loadTrash();
  } catch (e) {
    toast('清空失败：' + (e.message || e), 2500);
  } finally {
    busyDone();
  }
}

/* ================= 上传流程 ================= */

// 上传会话：{ title, bytes, preview, updating:null|{id,op,book}, keepRaw }
let pending = null;

function openUpload(opts = {}) {
  showView('upload');
  els.upForm.reset();
  els.upFile.value = '';
  els.upClean.checked = true;
  els.upCleanOpts.classList.remove('off');
  els.upKeepRaw.checked = true;
  els.upPrev.classList.add('hidden');
  els.upDetected.textContent = '';
  els.encWrap.classList.add('hidden');
  els.encManual.classList.add('hidden');
  els.upEncoding.innerHTML = '<option value="auto">自动检测</option>';
  els.upUpdateHint.classList.add('hidden');
  els.upProgWrap.classList.add('hidden');
  els.upConfirm.disabled = true;
  pending = null;
  if (opts.book) {
    // 重新清洗入口
    pending = {
      updating: { id: opts.book.id, op: 'replace', book: opts.book },
      bytes: null,
      keepRaw: true,
    };
    els.upHead.textContent = '重新清洗';
    els.upTitle.value = opts.book.title || '';
    els.upAuthor.value = opts.book.author || '';
    els.upTags.value = (opts.book.tags || []).join(', ');
    els.upNote.value = opts.book.note || '';
    hint(`正在用原件重新清洗《${opts.book.title}》，确认后整本替换`);
    busy(0.05, '下载原件…');
    api.rawBytes(opts.book.id)
      .then((bytes) => {
        pending.bytes = bytes;
        runPreview();
      })
      .catch((e) => {
        toast('原件下载失败（可能未留档）：' + (e.message || e), 3000);
        showView('shelf');
      })
      .finally(busyDone);
    return;
  }
  els.upHead.textContent = '上传小说';
  const hint2 = els.upUpdateHint;
  hint2.classList.add('hidden');
}

function hint(text) {
  els.upUpdateHint.textContent = text;
  els.upUpdateHint.classList.remove('hidden');
}

async function handleFiles(files) {
  if (!files.length) return;
  const f = files[0];
  if (files.length > 1) toast('一次处理一本，已选用第一个文件：' + f.name, 2800);
  pending = null;
  els.upPrev.classList.add('hidden');
  await prepareFile(f);
}

function onFileChosen() {
  handleFiles(Array.from(els.upFile.files || [])).catch((e) => toast('读取失败：' + e.message, 2500));
}

function onPasteText(e) {
  const txt = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  if (!txt || !txt.trim()) return;
  e.preventDefault();
  if (!els.upTitle.value) els.upTitle.value = '粘贴文本_' + new Date().toISOString().slice(0, 10);
  pending = {
    title: els.upTitle.value.trim(),
    bytes: new TextEncoder().encode(txt),
    keepRaw: false,
    updating: null,
  };
  hint('已粘贴文本（不计原件留档）');
  runPreview();
}

async function prepareFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!els.upTitle.value) {
    els.upTitle.value = file.name.replace(/\.(txt|text)$/i, '').trim();
  }
  pending = { title: els.upTitle.value.trim(), bytes: buf, updating: null, keepRaw: true };
  els.upUpdateHint.classList.add('hidden');
  runPreview();
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

/** 手动指定编码：展开下拉并填入常见编码（自动检测异常时人工纠正用） */
function openEncPick() {
  const enc = els.upEncoding;
  const have = Array.from(enc.options).map((o) => o.value);
  for (const c of ['utf-8', 'gb18030', 'big5']) {
    if (!have.includes(c)) enc.appendChild(new Option(c, c));
  }
  if (!have.includes('auto')) enc.insertBefore(new Option('自动检测', 'auto'), enc.firstChild);
  enc.value = 'auto';
  els.encManual.classList.add('hidden');
  els.encWrap.classList.remove('hidden');
}

function runPreview() {
  if (!pending || !pending.bytes) return;
  // 总开关「自动清洗排版」：关闭则整链不套清理（只按编码解码 + 分章）
  const useClean = els.upClean.checked;
  const cleanOpts = useClean ? currentCleanOpts() : { clean: false };
  let forceEncoding = els.upEncoding.value;
  if (forceEncoding === 'auto') forceEncoding = null;
  const t0 = Date.now();
  const r = cleaner.processBook(pending.bytes, {
    fallbackTitle: pending.title,
    cleanOpts,
    forceEncoding,
  });
  // 服务端单章上限 2MB：超大章（整本一章兜底等）先按 UTF-8 字节边界自动分段，避免 413 中断留下半成品书
  const fit = cleaner.fitChapters(r.chapters);
  if (fit.extra > 0) r.fitNote = `含 ${fit.extra} 个超大单章，已自动分段`;
  r.chapters = fit.chapters;
  pending.preview = r;
  pending.cleanOpts = cleanOpts;
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
  els.encWrap.classList.toggle('hidden', !showSel);
  // 无歧义时隐藏下拉，但保留「手动指定编码」小入口（自动结果异常时可干预）
  els.encManual.classList.toggle('hidden', showSel);
  els.upDetected.textContent = manual
    ? (r.chapters.length
        ? `已按 ${cur} 编码解析${r.replaced ? '，含 ' + r.replaced + ' 个乱码符' : ''}`
        : `按 ${cur} 编码解析失败，请换一种或改回自动检测`)
    : `检测编码：${r.encoding}${r.replaced ? '，含 ' + r.replaced + ' 个乱码符' : ''} · 分章规则：${r.detected || '未识别（整本一章）'} · 处理 ${ms}ms`;
  els.upStats.textContent = `${r.chapters.length} 章 · ${fmtWords(r.words)}${r.fitNote ? ' · ' + r.fitNote : ''}`;

  const ul = els.upList;
  ul.innerHTML = '';
  const MAX_PREVIEW = 500;
  r.chapters.slice(0, MAX_PREVIEW).forEach((c, i) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'ch-no';
    n.textContent = String(i + 1);
    const t = document.createElement('span');
    t.className = 'ch-t';
    t.textContent = c.title || '(无题)';
    const w = document.createElement('span');
    w.className = 'ch-w';
    w.textContent = fmtWords(cleaner.countWords(c.content));
    li.appendChild(n);
    li.appendChild(t);
    li.appendChild(w);
    ul.appendChild(li);
  });
  if (r.chapters.length > MAX_PREVIEW) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `…共 ${r.chapters.length} 章，确认后全部上传`;
    ul.appendChild(li);
  }

  els.upPrev.classList.remove('hidden');
  els.upConfirm.disabled = !r.chapters.length;
  const isUpd = !!(pending.updating && pending.updating.id);
  els.upConfirm.textContent = isUpd
    ? (pending.updating.op === 'append' ? `追加到《${pending.updating.book.title}》` : `整本替换《${pending.updating.book.title}》`)
    : '确认入库';
}

function collectPayload() {
  const preview = pending.preview;
  return {
    title: els.upTitle.value.trim() || pending.title,
    author: els.upAuthor.value.trim(),
    tags: els.upTags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    note: els.upNote.value.trim(),
    chapters: preview.chapters.map((c) => c.title),
    wordCount: preview.words,
    cleanVer: 1,
  };
}

function setProg(pct, text) {
  els.upProgBar.style.width = Math.round(pct * 100) + '%';
  els.upProgText.textContent = text;
}

async function onConfirm() {
  if (!pending || !pending.preview || !pending.preview.chapters.length) return;
  const payload = collectPayload();
  const keepRaw = els.upKeepRaw.checked;
  els.upConfirm.disabled = true;
  els.upProgWrap.classList.remove('hidden');

  try {
    if (pending.updating && pending.updating.id) {
      await uploadToExisting(pending.updating.id, pending.updating.op, payload, keepRaw);
    } else {
      const dup = books.find((b) => normTitle(b.title) === normTitle(payload.title));
      if (dup) {
        const mode = await askDup(dup);
        if (!mode) {
          els.upProgWrap.classList.add('hidden');
          els.upConfirm.disabled = false;
          return;
        }
        if (mode === 'new') await createAndUpload(payload, keepRaw);
        else await uploadToExisting(dup.id, mode, payload, keepRaw);
      } else {
        await createAndUpload(payload, keepRaw);
      }
    }
    toast('《' + payload.title + '》已入库', 2200);
    pending = null;
    els.upFile.value = '';
    showView('shelf');
    await loadShelf();
  } catch (e) {
    els.upProgWrap.classList.add('hidden');
    els.upConfirm.disabled = false;
    toast('上传失败：' + (e.message || e), 3200);
  }
}

/** 同名提示（F3/F4）：更新(替换/追加) 还是 另存新书 */
function askDup(dup) {
  return new Promise((resolve) => {
    openModal(`
      <h3>发现同名书籍</h3>
      <p class="modal-sub">书架已有《${esc(dup.title)}》（${dup.chapterCount} 章 · ${fmtWords(dup.wordCount)}）。要新建一本还是更新它？</p>
      <div class="m-row"><button class="primary" id="dpReplace" type="button">整本替换</button><span class="grow muted">用新文件覆盖《${esc(dup.title)}》，按章节名尽力保留进度</span></div>
      <div class="m-row"><button class="ghost" id="dpAppend" type="button">追加章节</button><span class="grow muted">保留原章，新章节从末尾续接（适合补连载）</span></div>
      <div class="m-row"><button class="ghost" id="dpNew" type="button">另存副本</button><span class="grow muted">自动加「（副本）」编号存为新书</span></div>
      <div class="m-acts"><button class="ghost" id="dpCancel" type="button">取消</button></div>`);
    const pick = (mode) => { closeModal(); resolve(mode); };
    $('#dpReplace', els.modalBox).addEventListener('click', () => pick('replace'));
    $('#dpAppend', els.modalBox).addEventListener('click', () => pick('append'));
    $('#dpNew', els.modalBox).addEventListener('click', () => pick('new'));
    $('#dpCancel', els.modalBox).addEventListener('click', () => { closeModal(); resolve(null); });
  });
}

async function createAndUpload(payload, keepRaw) {
  const created = await api.createBook(payload);
  if (created.duplicate && created.needCreate && created.book) {
    const mode = await askDup(created.book);
    if (!mode) throw new Error('已取消');
    if (mode === 'new') {
      // 服务端同名拦截 → 自动加「（副本）」编号直至接受（防御旧书单竞态下的同名）
      let k = 1;
      let created2 = { duplicate: true };
      while (created2.duplicate) {
        const t = payload.title + '（副本' + (k === 1 ? '' : k) + '）';
        created2 = await api.createBook({ ...payload, title: t });
        k++;
      }
      return uploadChapters(created2.id, created2.chapterKeys, payload, keepRaw);
    }
    return uploadToExisting(created.book.id, mode, payload, keepRaw);
  }
  return uploadChapters(created.id, created.chapterKeys, payload, keepRaw);
}

async function uploadToExisting(id, op, payload, keepRaw) {
  // append 不覆盖书名/作者/标签（保留旧书的）；replace 全量带
  const body = op === 'append' ? { op, chapters: payload.chapters, wordCount: payload.wordCount } : { op, ...payload };
  const updated = await api.updateChapters(id, body);
  const keys = updated.chapterKeys || [];
  const n = payload.chapters.length; // 本次实际要传的正文数
  const startKeyIdx = keys.length - n; // replace→0（全部重传）；append→旧章数（只传新章）
  if (startKeyIdx < 0) throw new Error('章节表与正文不匹配，已中止');
  await uploadMany(id, keys.slice(startKeyIdx), pending.preview.chapters);
  if (keepRaw && pending.bytes) {
    setProg(1, '上传原件…');
    await api.putRaw(id, pending.bytes);
  }
  setProg(1, '发布中…');
  await api.publish(id);
}

async function uploadChapters(id, keys, payload, keepRaw) {
  await uploadMany(id, keys, pending.preview.chapters);
  if (keepRaw && pending.bytes) {
    setProg(1, '上传原件…');
    await api.putRaw(id, pending.bytes);
  }
  setProg(1, '发布中…');
  await api.publish(id);
}

/** 并发窗口上传章节正文（默认 4 并发），按完成比例推进度 */
async function uploadMany(id, keys, chapters) {
  const n = keys.length;
  if (!n) return;
  const CONC = 4;
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < n) {
      const i = cursor++;
      try {
        await api.putChapter(id, keys[i], chapters[i] && chapters[i].content != null ? chapters[i].content : '');
      } finally {
        done++;
        setProg(done / n, `上传章节 ${done}/${n}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, n) }, worker));
}

/* ---------- 重洗（raw → 前端重新清洗 → 整本替换） ---------- */
async function rewash(b) {
  let full = b;
  try {
    const meta = await api.bookMeta(b.id);
    if (meta) full = { ...b, author: meta.author || b.author, note: meta.note || '' };
  } catch {
    /* meta 拉取失败也不阻断（用书架摘要） */
  }
  // 原件存在性与下载由 openUpload 内部处理（失败会提示并退回书架），
  // 不在这里预下载探测——那会把整个原件白拉一遍（重洗 = 原件下载两次）
  openUpload({ book: full });
}

/* ---------- toast ---------- */
let toastTimer = null;
export function toast(msg, ms = 2000) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}
