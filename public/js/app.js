/* app.js — 登录 / 书架（M2 管理）/ 上传 / 回收站 / 阅读入口（电脑上传为主，手机阅读为主） */
import { api, local, fmtWords, ApiError } from './store.js';
import { BULK_CHAPTER_BATCH, BATCH_BOOKS_MAX, CHAPTER_MAX, TRASH_DAYS } from './shared-const.js';
import * as cleaner from './cleaner.js';
import * as reader from './reader.js';
import { bindBusy, busy, busyDone } from './ui.js';
import { exportBookTxt } from './exporter.js';
import { offline } from './offline.js';

const $ = (sel, scope) => (scope || document).querySelector(sel);
const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));
const normTitle = (s) => String(s || '').replace(/\s+/g, '');

const PAGE = 60; // 书库分页

/** 上传/批量改标签/编辑信息三处的可选标签 chips：数据源 = 库里实际存在的标签
 * （GET /api/tags 按使用频次取 top 20）。无内置兜底——一本书都没打标签时就不显示，
 * 继续手动输入；打新标签/标签治理后 chips 自动跟随。快照存 localStorage（打开即显）。 */
const PRESET_SRC = 20;
let presetTags = [];

const els = {};
let books = []; // 全量在架书（服务端已含 pinned/prog 镜像）
let ui = { sort: 'recent', q: '', tag: '', finished: '', page: 1 };

export function init() {
  ['login', 'shelf', 'upload', 'trash'].forEach((v) => {
    els[v] = $('#view-' + v);
  });
  els.readRoot = $('#view-read');
  els.loginPwd = $('#loginPwd');
  els.loginBtn = $('#loginBtn');
  els.loginErr = $('#loginErr');
  els.moreBtn = $('#moreBtn');
  els.uploadBtn = $('#uploadBtn');
  els.batchBar = $('#batchBar');
  els.bbCount = $('#bbCount');
  els.bbAll = $('#bbAll');
  els.bbInvert = $('#bbInvert');
  els.bbTags = $('#bbTags');
  els.bbDone = $('#bbDone');
  els.bbOngoing = $('#bbOngoing');
  els.bbDelete = $('#bbDelete');
  els.bbExit = $('#bbExit');
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
  els.upTagChips = $('#upTagChips');
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
  els.uploadBtn.addEventListener('click', () => openUpload());
  els.moreBtn.addEventListener('click', openMoreSheet);
  els.modalBox.addEventListener('click', onDiagBoxClick); // 残留诊断面板动作委托（常驻单例，只绑一次）
  els.bbExit.addEventListener('click', exitBatchMode);
  els.bbAll.addEventListener('click', () => {
    for (const b of filteredBooks()) selected.add(b.id);
    syncBatchBar();
    renderGrid(sortedBooks(filteredBooks()));
  });
  els.bbInvert.addEventListener('click', () => {
    for (const b of filteredBooks()) {
      if (selected.has(b.id)) selected.delete(b.id);
      else selected.add(b.id);
    }
    syncBatchBar();
    renderGrid(sortedBooks(filteredBooks()));
  });
  els.bbTags.addEventListener('click', batchEditTags);
  els.bbDone.addEventListener('click', () => batchRun('setFinished', { finished: true }, `把 ${selected.size} 本书标记为「已完结」？`));
  els.bbOngoing.addEventListener('click', () => batchRun('setFinished', { finished: false }, `把 ${selected.size} 本书标记为「连载中」？`));
  els.bbDelete.addEventListener('click', () => batchRun('delete', {}, `把 ${selected.size} 本书移入回收站？15 天内可恢复`));
  els.trashBack.addEventListener('click', () => { showView('shelf'); loadShelf().catch(() => {}); });
  els.trashClear.addEventListener('click', clearTrashFlow);
  // 搜索防抖：千本规模下每次按键全量过滤+重建网格，150ms 合并输入更顺滑
  let searchTimer = null;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.q = els.searchInput.value.trim(); ui.page = 1; renderShelf(); }, 150);
  });
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
  presetTags = local.getPresetTags();
  renderPresetChips();
  refreshPresetTags(); // 异步：登录态确认后以云端标签覆盖快照（未登录时静默失败）
  boot();
}

function onNavBack() {
  showView('shelf');
  loadShelf().catch(() => {});
}

async function boot() {
  // 打开提速：有本地快照 → 先渲染书架（老用户秒开），网络校验登录态后按需切换
  const snap = local.getShelfCache();
  if (snap) {
    books = snap.books;
    tagCache = null;
    showView('shelf');
    renderShelf();
  }
  try {
    const data = await api.books(); // 一次拉取，鉴权预检 + 首屏数据共用
    showView('shelf');
    await loadShelf(data);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) showView('login');
    else if (snap) {
      // 网络失败但有快照 → 留在快照书架（可离线浏览，操作时会再报网络错误）
      toast('网络异常，当前显示本地缓存的书架', 2600);
    } else {
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
const colorCache = new Map(); // 按书名缓存封面色，避免上千本书重复哈希
function colorOf(title) {
  const hit = colorCache.get(title);
  if (hit) return hit;
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  const c = PALETTE[h % PALETTE.length];
  colorCache.set(title, c);
  return c;
}

async function loadShelf(data) {
  if (!data) {
    // 打开提速：先用本地快照渲染上次的书架（打开即有内容），网络刷新后覆盖
    const snap = local.getShelfCache();
    if (snap) {
      books = snap.books;
      tagCache = null;
      renderShelf();
    }
    data = await api.books();
  }
  books = data.books || [];
  tagCache = null; // books 已更新 → 标签计数缓存失效，下次 renderShelf 重算
  local.setShelfCache(books);
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
  if (ui.finished === 'done') list = list.filter((b) => b.finished);
  if (ui.finished === 'ongoing') list = list.filter((b) => !b.finished);
  return list;
}

/** 默认「最近」排序键：最后阅读时间 ∨ 创建时间 —— 没读过的书退回按新书排，避免全 0 退化成上传顺序 */
const recentKey = (x) => Math.max((x.prog && x.prog.updatedAt) || 0, x.createdAt || 0);

function sortedBooks(list) {
  const sorters = {
    recent: (a, b) => recentKey(b) - recentKey(a),
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

  // 继续阅读：所有有进度的书按「云端最后阅读时间」倒序取前 3（prog 镜像，电脑/手机一致）
  const reading = books
    .filter((b) => b.prog && b.prog.updatedAt > 0)
    .sort((a, b) => (b.prog.updatedAt || 0) - (a.prog.updatedAt || 0))
    .slice(0, 3);
  els.continueWrap.classList.toggle('hidden', !reading.length);
  if (reading.length) {
    els.continueCard.innerHTML = '';
    for (const b of reading) els.continueCard.appendChild(makeCard(b, false));
  }

  const list = sortedBooks(filteredBooks());
  els.filterNote.textContent = ui.q || ui.tag || ui.finished ? `筛选出 ${list.length} 本` : '';
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

let tagCache = null; // 标签计数缓存：books 变化（loadShelf）时才重算，筛选/翻页不重复 O(n) 扫描
function tagCounts() {
  if (tagCache) return tagCache;
  const m = new Map();
  for (const b of books) {
    for (const t of b.tags || []) m.set(t, (m.get(t) || 0) + 1);
  }
  tagCache = Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).slice(0, 12);
  return tagCache;
}

/** 分类导航栏（方向1）：状态频道（全部/完结/连载中）+ 全部标签 chips */
function renderTagCloud() {
  const cloud = els.tagCloud;
  cloud.innerHTML = '';
  const mk = (label, on) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('on', !!on);
    return b;
  };
  const stateBtn = (label, val) => {
    const b = mk(label, ui.finished === val);
    b.addEventListener('click', () => {
      ui.finished = ui.finished === val ? '' : val;
      ui.page = 1;
      renderShelf();
    });
    cloud.appendChild(b);
  };
  const all = mk('全部', !ui.tag && !ui.finished);
  all.addEventListener('click', () => {
    ui.tag = '';
    ui.finished = '';
    ui.page = 1;
    renderShelf();
  });
  cloud.appendChild(all);
  stateBtn('完结', 'done');
  stateBtn('连载中', 'ongoing');
  const tags = tagCounts();
  if (tags.length) {
    cloud.appendChild(docEle('span', 'tagcloud-sep', '·'));
    tags.forEach(([t, n]) => {
      const b = mk(`${t} ${n}`, ui.tag === t);
      b.addEventListener('click', () => {
        ui.tag = ui.tag === t ? '' : t;
        ui.page = 1;
        renderShelf();
      });
      cloud.appendChild(b);
    });
  }
}

/** 小工具：造 <tag class=...>text</tag> */
function docEle(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/* ---------- 上传表单的常用分类点选（方向2） ---------- */
/** 解析逗号分隔的标签输入（全角/半角逗号皆可，去空白去空项）——唯一实现 */
const parseTagInput = (v) =>
  String(v == null ? '' : v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
/** 按 input 当前值点亮/熄灭 container 里的标签 chips（on 状态随输入同步——唯一实现） */
function syncChipsOn(container, input) {
  const have = new Set(parseTagInput(input.value));
  for (const c of container.children) c.classList.toggle('on', have.has(c.textContent));
}
/** 按输入框当前值点亮/熄灭预设分类 chips */
function syncPresetChips() {
  if (!els.upTagChips) return;
  syncChipsOn(els.upTagChips, els.upTags);
}
/** 生成点选标签 chips（编辑信息 / 批量改标签 / 上传页三处共用）：
 * 点选 toggle 写入 input（逗号分隔），on 状态由 syncOn 回调随输入同步；
 * 空列表整块隐藏；textContent 渲染无注入面。 */
function renderTagPickChips(container, input, syncOn) {
  container.classList.toggle('hidden', !presetTags.length);
  for (const t of presetTags) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.addEventListener('click', () => {
      const have = new Set(parseTagInput(input.value));
      if (have.has(t)) have.delete(t);
      else have.add(t);
      input.value = Array.from(have).join(', ');
      syncOn();
    });
    container.appendChild(b);
  }
}
/** 渲染预设分类 chips：点选即写入标签输入框（与自定义输入共存）；空列表整块隐藏 */
function renderPresetChips() {
  if (!els.upTagChips) return;
  els.upTagChips.innerHTML = '';
  renderTagPickChips(els.upTagChips, els.upTags, syncPresetChips);
  syncPresetChips();
}

/** 云端刷新预设标签：取使用频次 top N，写快照并重渲染；未登录/网络失败静默保留快照 */
async function refreshPresetTags() {
  try {
    const data = await api.tags();
    presetTags = (data.tags || []).slice(0, PRESET_SRC).map((t) => t.tag);
    local.setPresetTags(presetTags);
    renderPresetChips();
  } catch {
    /* 保留本地快照（可能为空 → 不显示 chips） */
  }
}

function progBadgeText(b) {
  const p = b.prog;
  if (!p || !p.updatedAt) return '';
  const cc = b.chapterCount || 0;
  if (p.ch <= 0 || cc <= 0) return '';
  // 就地删章后 progress 章号可能略超当前章数（服务端会压回，历史脏数据/竞态窗口仍可能越界）：
  // 展示层 clamp，避免角标出现「读到 5/4 章」这类自相矛盾的数字
  const ch = Math.min(p.ch, cc);
  const done = ch >= cc && p.ratio > 0.96;
  if (done) return '已读完';
  const pct = ch >= cc ? Math.round((p.ratio || 0) * 100) : Math.round(((ch - 1 + (p.ratio || 0)) / cc) * 100);
  return `读到 ${ch}/${cc} 章 · ${Math.max(1, Math.min(99, pct))}%`;
}

function makeCard(b, big) {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'card' + (big ? ' big' : '') + (b.pinned ? ' pinned' : '') + (batchMode ? ' picking' : '') + (selected.has(b.id) ? ' picked' : '');
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
  if (b.finished) {
    const f = document.createElement('span');
    f.className = 'finish-pill';
    f.textContent = '完结';
    info.appendChild(f);
  }
  c.appendChild(block);
  c.appendChild(info);
  if (batchMode) {
    const tick = document.createElement('span');
    tick.className = 'pick-tick';
    tick.textContent = selected.has(b.id) ? '✓' : '';
    c.appendChild(tick);
    // 批量模式下点卡片 = 勾选/取消（不进阅读）
    c.addEventListener('click', () => {
      if (selected.has(b.id)) selected.delete(b.id);
      else selected.add(b.id);
      c.classList.toggle('picked', selected.has(b.id));
      tick.textContent = selected.has(b.id) ? '✓' : '';
      syncBatchBar();
    });
  } else {
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
  }
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
    { text: '编辑章节（标题/正文/增删章）', act: () => { closeSheet(); openChapterEditor(b); } },
    { text: '导出清洗后的 txt', act: () => { closeSheet(); exportBook(b); } },
    { text: '重新清洗（用原件重排）', act: () => { closeSheet(); rewashConfirm(b); } },
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
  refreshPresetTags(); // 打开弹层顺带后台刷新可选标签（快照先显示，与进上传页同款逻辑）
  let note = '';
  let finished = !!b.finished;
  try {
    const meta = await api.bookMeta(b.id);
    if (meta) {
      note = meta.note || '';
      if (typeof meta.finished === 'boolean') finished = meta.finished;
    }
  } catch {
    /* 用书架摘要（无 note 则空） */
  }
  openModal(`
    <h3>编辑信息</h3>
    <p class="modal-sub">《${esc(b.title)}》 · ${b.chapterCount || 0} 章</p>
    <div class="m-field"><label>书名</label><input id="mdTitle" value="${esc(b.title)}"></div>
    <div class="m-field"><label>作者</label><input id="mdAuthor" value="${esc(b.author || '')}"></div>
    <div class="m-field"><label>标签（逗号分隔，可点选）</label><input id="mdTags" value="${esc((b.tags || []).join(', '))}">
      <div id="mdTagChips" class="tag-chips"></div>
    </div>
    <div class="m-field"><label class="finish-row"><span>已完结</span><input type="checkbox" id="mdFinished" ${finished ? 'checked' : ''}></label></div>
    <div class="m-field"><label>备注</label><input id="mdNote" value="${esc(note)}" placeholder="这本书的备注（个人备忘）"></div>
    <div class="m-acts">
      <button class="ghost" id="mdCancel" type="button">取消</button>
      <button class="primary" id="mdOk" type="button">保存</button>
    </div>`);
  // 可选标签 chips：点选 toggle 写回输入框，高亮跟随输入值（该书已打的标签一眼可见）
  const mdTags = $('#mdTags', els.modalBox);
  const mdChips = $('#mdTagChips', els.modalBox);
  const syncMdChips = () => syncChipsOn(mdChips, mdTags);
  renderTagPickChips(mdChips, mdTags, syncMdChips);
  syncMdChips();
  $('#mdCancel', els.modalBox).addEventListener('click', closeModal);
  $('#mdOk', els.modalBox).addEventListener('click', async () => {
    const patch = {
      title: $('#mdTitle', els.modalBox).value.trim(),
      author: $('#mdAuthor', els.modalBox).value.trim(),
      tags: parseTagInput(mdTags.value),
      note: $('#mdNote', els.modalBox).value.trim(),
      finished: $('#mdFinished', els.modalBox).checked,
    };
    if (!patch.title) return toast('书名不能为空', 1600);
    closeModal();
    await safePatch(b.id, patch);
  });
}

/* ---------- 模态通用 ---------- */
function openModal(html) {
  els.modalBox.classList.remove('ce', 'diag'); // 清掉上个弹层可能加的加宽类
  els.modalBox.innerHTML = html;
  els.modalMask.classList.remove('hidden');
}
function closeModal() {
  els.modalBox.classList.remove('ce', 'diag');
  els.modalBox.innerHTML = ''; // 清掉内容，避免下次 openModal 前残留误读/误显
  els.modalMask.classList.add('hidden');
}
function confirmModal(text, okText = '确定') {
  return new Promise((resolve) => {
    openModal(`
      <h3>确认</h3>
      <p class="modal-sub confirm-text">${esc(text)}</p>
      <div class="m-acts">
        <button class="ghost" id="cfNo" type="button">取消</button>
        <button class="primary" id="cfYes" type="button">${esc(okText)}</button>
      </div>`);
    $('#cfNo', els.modalBox).addEventListener('click', () => { closeModal(); resolve(false); });
    $('#cfYes', els.modalBox).addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- 书架批量操作（多选治理：加/去标签、完结状态、软删） ---------- */
let batchMode = false;
const selected = new Set();
const BATCH_PAGE = BATCH_BOOKS_MAX; // 与后端共享常量对齐（shared-const.js），分批避免子请求预算爆

function enterBatchMode() {
  batchMode = true;
  selected.clear();
  els.batchBar.classList.remove('hidden');
  syncBatchBar();
  renderShelf();
  toast('批量模式：点书勾选，再点取消', 2000);
}

function exitBatchMode() {
  batchMode = false;
  selected.clear();
  els.batchBar.classList.add('hidden');
  renderShelf();
}

/** 顶栏「⋯」收纳菜单：低频治理入口统一收进来，顶栏只留「＋ 上传」+「⋯」 */
function openMoreSheet() {
  els.sheet.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sheet-title';
  title.textContent = '更多';
  els.sheet.appendChild(title);
  const items = [
    { text: '回收站', act: openTrash },
    { text: '标签管理', act: openTagMgr },
    { text: '检查残留', act: openDiag },
    { text: '批量管理', act: enterBatchMode },
    { text: '退出登录', act: logout, danger: true },
  ];
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (it.danger) btn.className = 'danger';
    btn.textContent = it.text;
    btn.addEventListener('click', () => {
      closeSheet();
      it.act();
    });
    els.sheet.appendChild(btn);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'dim';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeSheet);
  els.sheet.appendChild(cancel);
  els.sheet.classList.remove('hidden');
}

function syncBatchBar() {
  els.bbCount.textContent = String(selected.size);
  // 未选书时禁用全部动作按钮（视觉+语义同步）
  const dis = selected.size === 0;
  for (const b of [els.bbTags, els.bbDone, els.bbOngoing, els.bbDelete]) b.disabled = dis;
}

/** 批量执行：分批调用批量 API（每批 20），busy 进度反馈；完成后刷新书架 */
async function batchRun(action, payload, confirmText) {
  if (!selected.size) return;
  const ids = Array.from(selected);
  if (!(await confirmModal(confirmText, '执行'))) return;
  busy(`批量操作中… 0/${ids.length}`);
  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < ids.length; i += BATCH_PAGE) {
      const batch = ids.slice(i, i + BATCH_PAGE);
      try {
        const r = await api.batchBooks(batch, action, payload);
        ok += r.updated || 0;
        fail += batch.length - (r.updated || 0);
      } catch {
        fail += batch.length;
      }
      busy(`批量操作中… ${Math.min(i + BATCH_PAGE, ids.length)}/${ids.length}`);
    }
  } finally {
    busyDone();
  }
  exitBatchMode();
  await loadShelf().catch(() => {}); // 刷新失败不吞结果提示
  toast(fail ? `完成 ${ok} 本，${fail} 本失败（可能是半成品书）` : `已更新 ${ok} 本`, 2600);
}

/** 批量改标签：输入标签（逗号分隔）→ 添加到所选书 / 从所选书移除 */
function batchEditTags() {
  if (!selected.size) return;
  openModal(`
    <h3>批量改标签 <span class="muted">(${selected.size} 本)</span></h3>
    <div class="m-field">
      <input id="btInput" class="input" type="text" placeholder="多个标签用逗号分隔，如：玄幻, 完结自用" autocomplete="off">
      <div id="btChips" class="tag-chips"></div>
      <p class="modal-sub">「添加」把标签加到所选书；「移除」从所选书去掉这些标签</p>
    </div>
    <div class="m-acts">
      <button class="ghost" id="btCancel" type="button">取消</button>
      <button class="ghost" id="btRemove" type="button" disabled>移除</button>
      <button class="primary" id="btAdd" type="button" disabled>添加</button>
    </div>`);
  const input = $('#btInput', els.modalBox);
  const chips = $('#btChips', els.modalBox);
  const btnAdd = $('#btAdd', els.modalBox);
  const btnRemove = $('#btRemove', els.modalBox);
  const parse = () => parseTagInput(input.value);
  const sync = () => {
    const has = parse().length > 0;
    btnAdd.disabled = !has;
    btnRemove.disabled = !has;
  };
  // 预设 chips 点选写入输入框（与上传表单/编辑信息共用同一数据源与交互）
  renderTagPickChips(chips, input, () => {
    syncChipsOn(chips, input);
    sync();
  });
  input.addEventListener('input', sync);
  $('#btCancel', els.modalBox).addEventListener('click', closeModal);
  const go = async (action) => {
    const tags = parse();
    if (!tags.length) return;
    closeModal();
    const verb = action === 'addTags' ? '添加' : '移除';
    await batchRun(action, { tags }, `给 ${selected.size} 本书${verb}标签：${tags.join('、')}？`);
  };
  btnAdd.addEventListener('click', () => go('addTags'));
  btnRemove.addEventListener('click', () => go('removeTags'));
}

/* ---------- 标签管理（全量清单 + 改名/合并/删除，治理碎片标签） ---------- */
async function openTagMgr() {
  openModal('<h3>标签管理</h3><p class="modal-sub">加载中…</p>');
  let data;
  try {
    data = await api.tags();
  } catch (e) {
    openModal(`<h3>标签管理</h3><p class="modal-sub">加载失败：${esc(e.message || e)}</p>
      <div class="m-acts"><button class="ghost" id="tmErrClose" type="button">关闭</button></div>`);
    $('#tmErrClose', els.modalBox).addEventListener('click', closeModal);
    return;
  }
  renderTagMgr(data);
}

function renderTagMgr(data) {
  const rows = (data.tags || [])
    .map(
      (t) => `
      <div class="tm-row" data-tag="${esc(t.tag)}">
        <span class="tm-name" title="${esc(t.tag)}">${esc(t.tag)}</span>
        <span class="tm-count">${t.count} 本</span>
        <input class="input tm-input" type="text" placeholder="改名 / 合并到…" autocomplete="off">
        <button class="ghost slim tm-go" type="button" title="把「${esc(t.tag)}」改成或合并到左侧输入的标签">${IC.arrow}</button>
        <button class="ghost slim tm-del danger" type="button" title="从所有书上移除该标签">${IC.x}</button>
      </div>`
    )
    .join('');
  openModal(`
    <h3>标签管理 <span class="muted">(${data.total || 0} 个标签)</span></h3>
    <p class="modal-sub">输入新名字点 → 即改名；输入已有标签名点 → 即合并；点 × 从全部书上移除。所有改动会同步到每一本书。</p>
    <div class="tm-list">${rows || '<p class="empty muted">还没有任何标签</p>'}</div>
    <div class="m-acts">
      <button class="ghost" id="tmReload" type="button">刷新</button>
      <button class="primary" id="tmClose" type="button">完成</button>
    </div>`);
  $('#tmClose', els.modalBox).addEventListener('click', closeModal);
  $('#tmReload', els.modalBox).addEventListener('click', openTagMgr);
  for (const row of $$('.tm-row', els.modalBox)) {
    const tag = row.dataset.tag;
    const input = $('.tm-input', row);
    const go = async () => {
      const to = input.value.trim();
      if (!to) {
        toast('先输入新标签名', 1600);
        return;
      }
      if (to === tag) {
        toast('名字没变', 1600);
        return;
      }
      const existing = (data.tags || []).some((x) => x.tag === to);
      const verb = existing ? `合并进「${to}」` : `改名为「${to}」`;
      if (!(await confirmModal(`把「${tag}」${verb}？改动会应用到所有打了这个标签的书`, '执行'))) return;
      await tagMergeRun(tag, to);
    };
    $('.tm-go', row).addEventListener('click', go);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    $('.tm-del', row).addEventListener('click', async () => {
      if (!(await confirmModal(`从所有书上移除标签「${tag}」？`, '移除'))) return;
      await tagMergeRun(tag, '');
    });
  }
}

/** 标签合并执行：remaining>0 时自动续调直到清完（每批 20 本受子请求预算约束） */
async function tagMergeRun(from, to) {
  busy('更新书籍标签…');
  let updated = 0;
  try {
    for (let guard = 0; guard < 60; guard++) {
      const r = await api.tagsMerge(from, to);
      updated += r.updated || 0;
      if (!r.remaining) break;
    }
  } catch (e) {
    busyDone();
    toast('失败：' + (e.message || e), 2600);
    return;
  }
  busyDone();
  await loadShelf().catch(() => {}); // 刷新失败不吞结果提示
  toast(to ? `已更新 ${updated} 本` : `已从 ${updated} 本书上移除`, 2400);
  // 确认弹层（confirmModal 共用 modalBox）已把标签管理弹层顶掉并关闭：
  // 无条件重新拉取渲染，既"操作后刷新结果"，也保证改名/合并后的后续操作基于最新行名
  await openTagMgr();
}

/* ---------- 残留诊断（书架「检查残留」：只读扫描 + 删无主对象 / 无主书移入回收站） ---------- */
let diagData = null; // 最近一次扫描结果（删除 / 移入回收站动作读取）
const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
};
const diagShort = (key) => {
  const s = String(key || '');
  return s.length > 64 ? s.slice(0, 30) + '…' + s.slice(-26) : s;
};

async function openDiag() {
  openModal('<h3>残留检查</h3><p class="modal-sub">正在扫描全库对象…</p>');
  try {
    diagData = await api.diagOrphans();
    if (els.modalMask.classList.contains('hidden')) return; // 扫描期间用户已关闭
    renderDiag();
  } catch (e) {
    if (els.modalMask.classList.contains('hidden')) return;
    els.modalBox.innerHTML = `<h3>残留检查</h3>
      <p class="modal-sub">扫描失败：${esc(e.message || e)}</p>
      <div class="m-acts"><button class="ghost" id="diagErrClose" type="button">关闭</button></div>`;
    $('#diagErrClose', els.modalBox).addEventListener('click', closeModal);
  }
}

async function diagRefresh() {
  try {
    diagData = await api.diagOrphans();
  } catch (e) {
    toast('扫描失败：' + (e.message || e), 2200);
    return;
  }
  renderDiag(); // 无论面板当前是否可见都渲染（调用方需保证面板开着；可见性由 openDiag 入口控制）
}

function renderDiag() {
  const d = diagData;
  const rs = d.residue || [];
  const obs = d.orphanBooks || [];
  const cos = d.chapterOrphans || [];
  const unregCos = cos.filter((o) => !o.known); // 未登记的孤儿才一键清；已登记的交给惰性清理
  const total = rs.length + obs.length + cos.length;
  const badge = total ? `<span class="diag-badge diag-badge-warn">发现 ${total} 项残留</span>` : `<span class="diag-badge diag-badge-ok">一切干净</span>`;

  const sec = (dotCls, title, n, bodyHtml) => `<div class="diag-sec">
    <p class="diag-sec-head"><span class="diag-dot ${dotCls}"></span>${esc(title)}<span class="diag-count">${n}</span></p>
    ${bodyHtml}</div>`;

  const objRow = (o, extra) => `<div class="diag-row">
    <div class="diag-row-main">
      <code class="diag-key" title="${esc(o.key)}">${esc(diagShort(o.key))}</code>
      <div class="diag-row-sub">${fmtBytes(o.size)}${extra || ''}</div>
    </div>
    <button class="ghost slim" type="button" data-diag="del-one" data-key="${esc(o.key)}">删除</button>
  </div>`;

  const bookRow = (b) => `<div class="diag-row">
    <div class="diag-row-main">
      <span class="diag-name">${esc(b.title || '（未命名）')}</span>
      <div class="diag-row-sub">${fmtBytes(b.size)} · ${b.chapterCount || 0} 章 · ${esc(b.status)}${b.texts ? ` · 关联正文 ${b.texts} 段` : ''}</div>
    </div>
    <button class="ghost slim" type="button" data-diag="move-book" data-id="${esc(b.id)}" data-title="${esc(b.title || '')}">移入回收站</button>
  </div>`;

  const chTag = (o) => (o.known ? ' · <span class="diag-tag">已在惰性清理名单</span>' : ' · <span class="diag-tag diag-tag-orphan">未登记</span>');

  let body;
  if (!total) {
    body = `<p class="diag-clean">库中无残留文件：所有对象都能被书架或回收站引用到。</p>`;
  } else {
    body = sec('diag-dot-red', '已删书的残留对象', rs.length,
      rs.length ? `<div class="diag-rows">${rs.map((o) => objRow(o, '')).join('')}</div>
        <p class="diag-group-acts"><button class="ghost slim" type="button" data-diag="del-all" data-what="residue">删除全部 ${rs.length} 项</button></p>`
        : '<p class="diag-none">无</p>')
      + sec('diag-dot-amber', '未入架的无主书', obs.length,
        obs.length ? `<div class="diag-rows">${obs.map((b) => bookRow(b)).join('')}</div>`
          : '<p class="diag-none">无</p>')
      + sec('diag-dot-gray', '章节孤儿', cos.length,
        cos.length ? `<div class="diag-rows">${cos.map((o) => objRow(o, ` · ${esc(o.bookTitle || o.bookId)}${chTag(o)}`)).join('')}</div>
          ${unregCos.length ? `<p class="diag-group-acts"><button class="ghost slim" type="button" data-diag="del-all" data-what="chapters">删除未登记孤儿 ${unregCos.length} 项</button></p>` : '<p class="diag-group-acts muted">已登记孤儿由惰性清理自动删除</p>'}`
          : '<p class="diag-none">无（自动惰性清理工作正常）</p>');
  }

  openModal(`<h3>残留检查</h3>
    <p class="modal-sub">扫描于 ${new Date(d.scannedAt).toLocaleString()} · 在架 ${d.liveBooks} 本 ${badge}${d.incomplete ? '<span class="diag-tag diag-tag-orphan"> · 对象过多，扫描按预算截断、部分结果不完整</span>' : ''}</p>
    <div class="diag-body">${body}</div>
    <div class="m-acts">
      <button class="ghost" id="diagRefreshBtn" type="button">重新扫描</button>
      <button class="primary" id="diagCloseBtn" type="button">关闭</button>
    </div>`);
  els.modalBox.classList.add('diag'); // 诊断面板加宽（openModal 会先清掉旧类）
  $('#diagCloseBtn', els.modalBox).addEventListener('click', closeModal);
  $('#diagRefreshBtn', els.modalBox).addEventListener('click', () => diagRefresh());
}

/* modalBox 上一次性委托：诊断动作（由 init 绑定；diagData 为空时忽略） */
async function onDiagBoxClick(e) {
  const btn = e.target.closest('[data-diag]');
  if (!btn || !diagData) return;
  const act = btn.dataset.diag;
  if (act === 'del-one') {
    const key = btn.dataset.key;
    if (!(await confirmModal(`永久删除无主对象「${diagShort(key)}」？此操作不可恢复。`, '删除'))) return;
    try {
      const r1 = await api.purgeOrphans([key]);
      toast(r1 && r1.deleted ? '已删除 1 个对象' : '对象已在引用中，未删除', 1400);
      await diagRefresh();
    } catch (err) {
      toast('删除失败：' + (err.message || err), 2400);
    }
  } else if (act === 'del-all') {
    const src = btn.dataset.what === 'residue' ? diagData.residue : (diagData.chapterOrphans || []).filter((o) => !o.known);
    const keys = src.map((o) => o.key);
    if (!keys.length) return;
    if (!(await confirmModal(`永久删除 ${keys.length} 个无主对象？此操作不可恢复。`, '全部删除'))) return;
    try {
      const r = await api.purgeOrphans(keys);
      const done = (r && r.deleted) || 0;
      const skipped = (r && r.skipped) || 0;
      toast((done ? `已删除 ${done} 个对象` : '没有可删除的对象') + (skipped ? `（${skipped} 个被跳过）` : ''), 1600);
      await diagRefresh();
    } catch (err) {
      toast('删除失败：' + (err.message || err), 2400);
    }
  } else if (act === 'move-book') {
    const id = btn.dataset.id;
    const title = btn.dataset.title;
    if (!(await confirmModal(`把未入架的书《${esc(title || '未命名')}》移入回收站？可在回收站恢复或彻底删除。`, '移入回收站'))) return;
    try {
      await api.deleteBook(id); // 服务端 softDelete 已支持无主书
      toast('已移入回收站', 1600);
      await diagRefresh();
    } catch (err) {
      toast('操作失败：' + (err.message || err), 2400);
    }
  }
}

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
  try {
    await loadTrash();
  } catch (e) {
    els.trashList.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty muted';
    p.textContent = '加载失败：' + (e.message || e);
    els.trashList.appendChild(p);
  }
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
    // 保留期徽章：还剩几天可恢复（≤3 天红色警示）——免去用户心算 15 天期限
    const left = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - (b.deletedAt || 0)) / 86400000));
    const ttl = document.createElement('span');
    ttl.className = 'ttl-badge' + (left <= 3 ? ' warn' : '');
    ttl.textContent = left > 0 ? `剩 ${left} 天` : '即将清除';
    acts.appendChild(ttl);
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
let importing = false; // 批量导入进行中：屏蔽「确认入库」，防止与批量循环并发操作 pending
// 本次「新建」出来的书 id：入库中途失败时用它把半成品移入回收站（否则它不在书架、也清不掉）
let createdId = null;

function openUpload(opts = {}) {
  showView('upload');
  refreshPresetTags(); // 每次进上传页后台刷新 top20（快照先显示，不阻塞；打了新标签立刻跟进）
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
  syncPresetChips(); // 重洗/新建都会重置标签输入 → 同步常用分类 chips 高亮
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
    syncPresetChips();
    els.upNote.value = opts.book.note || '';
    hint(`正在用原件重新清洗《${opts.book.title}》，确认后整本替换`);
    busy(0.05, '下载原件…');
    const bookId = opts.book.id;
    const sameSession = () => !!(pending && pending.updating && pending.updating.id === bookId);
    api.rawBytes(bookId)
      .then((bytes) => {
        // 下载期间用户可能又选了别的文件（pending 已被替换）→ 丢弃这次回调，避免数据串台
        if (!sameSession()) return;
        pending.bytes = bytes;
        runPreview();
      })
      .catch((e) => {
        if (!sameSession()) return; // 同理：会话已切换就别把用户踢回书架
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
  if (files.length > 1) {
    await importBatch(files);
    return;
  }
  const f = files[0];
  pending = null;
  els.upPrev.classList.add('hidden');
  await prepareFile(f);
}

/** 多文件批量导入（P1）：串行逐本 cleaner → 自动入库，一次一本避免浏览器内存峰值叠加。
 * 作者/标签/备注取上传表单当前值，作为这一批的统一默认值；书名取文件名；
 * 与书架同名的自动跳过（批量不逐本弹窗）。上传复用 bulk 通道。 */
async function importBatch(files) {
  const n = files.length;
  const author = els.upAuthor.value.trim();
  const tags = parseTagInput(els.upTags.value);
  const note = els.upNote.value.trim();
  const keepRaw = els.upKeepRaw.checked;
  const summary = `作者「${author || '空'}」· 标签「${tags.join('、') || '空'}」· 备注「${note || '空'}」`;
  if (!(await confirmModal(`将对 ${n} 本书批量导入。书名取文件名，以下信息统一应用到这批：${summary}。与书架同名的自动跳过。继续？`, `导入 ${n} 本`))) return;

  let ok = 0;
  let skip = 0;
  let fail = 0;
  importing = true;
  els.upProgWrap.classList.remove('hidden');
  els.upConfirm.disabled = true;
  try {
    for (let i = 0; i < n; i++) {
      const file = files[i];
      const title = file.name.replace(/\.(txt|text)$/i, '').trim() || ('未命名_' + (i + 1));
      setProg(i / n, `处理 ${i + 1}/${n}：《${title}》`);
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        pending = { title, bytes: buf, updating: null, keepRaw };
        runPreview();
        els.upConfirm.disabled = true; // runPreview→updateConfirmBtn 会重启用按钮，这里再压住
        const preview = pending.preview;
        if (!preview || !preview.chapters.length) {
          fail++;
          continue;
        }
        const payload = {
          title,
          author,
          tags,
          note,
          chapters: preview.chapters.slice(0, CHAPTER_MAX).map((c) => c.title),
          wordCount: preview.words || 0,
          cleanVer: 1,
        };
        const created = await api.createBook(payload);
        if (created.duplicate && created.needCreate && created.book) {
          skip++; // 同名 → 跳过（批量不弹窗确认）
          continue;
        }
        createdId = created.id;
        await uploadChapters(created.id, created.chapterKeys, keepRaw);
        createdId = null;
        ok++;
      } catch (e) {
        fail++;
        if (createdId) {
          // 失败时把停在 creating 的半成品移入回收站，不留孤儿数据
          await api.deleteBook(createdId).catch(() => {});
          createdId = null;
        }
      }
      setProg((i + 1) / n, `完成 ${ok + skip + fail}/${n}（成功 ${ok}）`);
    }
  } finally {
    importing = false;
    els.upProgWrap.classList.add('hidden');
    els.upConfirm.disabled = false;
  }
  pending = null;
  els.upFile.value = '';
  toast([`成功 ${ok} 本`, skip ? `同名跳过 ${skip} 本` : '', fail ? `失败 ${fail} 本` : ''].filter(Boolean).join(' · '), 3200);
  showView('shelf');
  await loadShelf().catch(() => {}); // 刷新失败不吞结果提示
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

  els.upPrev.classList.remove('hidden');
  // 统计与列表交给 renderPreviewChapters 实时维护（预览可编辑后章数/字数会变）
  renderPreviewChapters();
}

/* ---------- v1.1：分章预览可编辑（改标题 / 改正文 / 增删章） ----------
 * 预览只是本地数组，直接改 pending.preview.chapters，确认后走原入库通道。 */
const MAX_PREVIEW = 500;

function refreshPreviewStats() {
  const chs = pending.preview.chapters;
  const words = chs.reduce((s, c) => s + cleaner.countWords(c.content || ''), 0);
  pending.preview.words = words; // 入库 payload 从此处读取
  els.upStats.textContent = `${chs.length} 章 · ${fmtWords(words)}${pending.preview.fitNote ? ' · ' + pending.preview.fitNote : ''}`;
}

function updateConfirmBtn() {
  const chs = pending && pending.preview ? pending.preview.chapters : [];
  els.upConfirm.disabled = !chs.length;
  const isUpd = !!(pending && pending.updating && pending.updating.id);
  els.upConfirm.textContent = isUpd
    ? (pending.updating.op === 'append' ? `追加到《${pending.updating.book.title}》` : `整本替换《${pending.updating.book.title}》`)
    : '确认入库';
}

function pvIconBtn(text, title, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pv-btn' + (danger ? ' danger' : '');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** 细线 SVG 图标（与阅读工具栏同款语言）：受控字面量，非用户输入，innerHTML 安全 */
const IC = {
  plus: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  pen: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3l4 4L8 20l-5 1 1-5z"/></svg>',
  arrow: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m0 0l-5-5m5 5l-5 5"/></svg>',
};
/** 图标版小按钮（与 pvIconBtn 同构，内容为 SVG） */
function pvIconBtnSvg(name, title, onClick, danger) {
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
      pending.preview.chapters.splice(i, 1);
      renderPreviewChapters();
    }, true)
  );
  li.append(line, bodyBox);
  return li;
}

/** 在第 i 章（0-based）之后插一个空章；-1/空列表时插在最前 */
function insertPreviewAfter(i) {
  pending.preview.chapters.splice(i + 1, 0, { title: '', content: '' });
  renderPreviewChapters();
  const rows = $$('#upList .pv-row');
  const t = rows[i + 1] && rows[i + 1].querySelector('.ch-t');
  if (t) {
    t.focus();
    t.scrollIntoView({ block: 'nearest' });
  }
}

function appendPreview() {
  pending.preview.chapters.push({ title: '', content: '' });
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
  const chs = pending.preview.chapters;
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

function collectPayload() {
  const preview = pending.preview;
  if (preview.chapters.length > CHAPTER_MAX) toast(`章节数超过上限 ${CHAPTER_MAX}，多余章节将被截断`, 2600);
  return {
    title: els.upTitle.value.trim() || pending.title,
    author: els.upAuthor.value.trim(),
    tags: parseTagInput(els.upTags.value),
    note: els.upNote.value.trim(),
    chapters: preview.chapters.slice(0, CHAPTER_MAX).map((c) => c.title),
    // 字数由 refreshPreviewStats 在每次编辑后实时维护（预览可编辑后它是唯一事实源）
    wordCount: preview.words || 0,
    cleanVer: 1,
  };
}

function setProg(pct, text) {
  els.upProgBar.style.width = Math.round(pct * 100) + '%';
  els.upProgText.textContent = text;
}

async function onConfirm() {
  if (importing) return; // 批量导入中：runPreview 会重启用确认按钮，这里兜底屏蔽
  if (!pending || !pending.preview || !pending.preview.chapters.length) return;
  const payload = collectPayload();
  const keepRaw = els.upKeepRaw.checked;
  createdId = null;
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
    await loadShelf().catch(() => {}); // 刷新失败不吞入库结果（书已成功，稍后重进书架即见）
  } catch (e) {
    // 新建流程中途失败 → 书停在 creating 且从未进书架：看不见、回收站也清不掉。
    // 移入回收站，让用户能看见并彻底删除（或重试），不留孤儿数据。
    if (createdId) {
      await api.deleteBook(createdId).catch(() => {});
      createdId = null;
    }
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
      while (created2.duplicate && k <= 50) { // 上限防御：极端情况下不至于打空转请求
        const t = payload.title + '（副本' + (k === 1 ? '' : k) + '）';
        created2 = await api.createBook({ ...payload, title: t });
        k++;
      }
      if (created2.duplicate) throw new Error('无法创建副本（同名冲突过多）');
      createdId = created2.id;
      return uploadChapters(created2.id, created2.chapterKeys, keepRaw);
    }
    return uploadToExisting(created.book.id, mode, payload, keepRaw);
  }
  createdId = created.id;
  return uploadChapters(created.id, created.chapterKeys, keepRaw);
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
  await finalizeUpload(id, keepRaw);
}

/** 收尾：原件留档（可选）+ 发布（创建/替换/追加/批量导入共用） */
async function finalizeUpload(id, keepRaw) {
  if (keepRaw && pending.bytes) {
    setProg(1, '上传原件…');
    await api.putRaw(id, pending.bytes);
  }
  setProg(1, '发布中…');
  await api.publish(id);
}

async function uploadChapters(id, keys, keepRaw) {
  await uploadMany(id, keys, pending.preview.chapters);
  await finalizeUpload(id, keepRaw);
}

/** 批量上传章节正文（bulk 接口，分批串行）：
 * 服务端 meta 校验从「每章一次」收敛到「每批一次」，请求数也从每章 1 个降到每批 1 个，
 * 连续上传大幅减负（Free 计划请求数/天是硬配额）。
 * 分批双护栏：章数 ≤ BULK_CHAPTER_BATCH（与后端共享常量对齐，防 413 拒收），
 * 且批字节 ≤ 12MB——后端 bulk 单批还有 16MB 总字节护栏，40 章×1.9MB 最坏 76MB 会撞上；
 * 按字节再切批，保证任何大书都能上传而不被单批上限误伤。 */
async function uploadMany(id, keys, chapters) {
  const n = keys.length;
  if (!n) return;
  const BATCH = BULK_CHAPTER_BATCH; // 与后端共享常量对齐（shared-const.js）
  const BATCH_BYTES = 12 * 1024 * 1024; // 批字节护栏（< 后端 16MB maxTotal，留 JSON 转义余量）
  const enc = new TextEncoder();
  let done = 0;
  let i = 0;
  while (i < n) {
    const items = [];
    let bytes = 0;
    while (items.length < BATCH && i < n) {
      const c = chapters[i];
      const text = c && c.content != null ? c.content : '';
      const size = enc.encode(text).byteLength;
      // 至少发 1 章（单章 ≤FIT 上限远小于预算），之后字节将超则切下一批
      if (items.length && bytes + size > BATCH_BYTES) break;
      items.push({ key: keys[i], text });
      bytes += size;
      i++;
    }
    const r = await api.putChapters(id, items);
    done += (r && r.count) || 0;
    setProg(done / n, `上传章节 ${done}/${n}`);
  }
}

/* ---------- 重洗（raw → 前端重新清洗 → 整本替换） ---------- */
async function rewashConfirm(b) {
  // v1.1：手动章节编辑后重洗会整体重建 → 先确认，避免静默覆盖人工改动
  const ok = await confirmModal('重新清洗会用原件重建整本书的分章与正文，此前手动修改的章节标题/正文会被覆盖。继续？');
  if (ok) rewash(b);
}

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

/* ---------- v1.1：书架「编辑章节」（已发布书就地编辑：改标题/改正文/插章/删章） ---------- */
const ceState = { id: null, bookTitle: '', chapters: [], count: 0, words: 0, dirty: false };
const ceBodies = new Map(); // 已拉取的章节正文缓存 key -> text

function ceStatText() {
  return `《${ceState.bookTitle}》 · ${ceState.count} 章 · ${fmtWords(ceState.words)} · 改动即时保存`;
}

async function openChapterEditor(b) {
  let meta;
  try {
    meta = await api.bookMeta(b.id);
  } catch (e) {
    toast('打开失败：' + (e.message || e), 2600);
    return;
  }
  ceState.id = b.id;
  ceState.bookTitle = b.title;
  ceState.chapters = (meta.chapters || []).map((c) => ({ key: c.key, title: c.title }));
  ceState.count = meta.chapterCount || ceState.chapters.length;
  ceState.words = meta.wordCount || 0;
  ceState.dirty = false;
  ceBodies.clear();
  openModal(`
    <div class="ce-head">
      <h3>编辑章节</h3>
      <p id="ceStat" class="ce-stat modal-sub"></p>
    </div>
    <ul id="ceList" class="ce-list"></ul>
    <div class="ce-foot">
      <button class="pv-btn" id="ceAppend" type="button">＋ 在末尾追加一章</button>
      <span class="ce-busy" id="ceBusy"></span>
      <button class="ghost" id="ceDone" type="button">完成</button>
    </div>`);
  els.modalBox.classList.add('ce');
  $('#ceStat', els.modalBox).textContent = ceStatText();
  $('#ceAppend', els.modalBox).addEventListener('click', () => ceInsert(null));
  $('#ceDone', els.modalBox).addEventListener('click', finishChapterEditor);
  renderCeList();
}

function ceBusy(text) {
  const el = $('#ceBusy', els.modalBox);
  if (el) el.textContent = text || '';
}

function renderCeList() {
  const ul = $('#ceList', els.modalBox);
  if (!ul) return;
  ul.innerHTML = '';
  if (!ceState.chapters.length) {
    const li = document.createElement('li');
    li.className = 'ce-empty muted';
    li.textContent = '（暂无章节）';
    ul.appendChild(li);
    return;
  }
  ceState.chapters.forEach((ch, i) => ul.appendChild(ceBuildRow(ch, i)));
}

/** 构造一行章节：序号 + 标题输入 + 正文/插章/删章按钮 +（可展开的正文编辑区） */
function ceBuildRow(ch, i) {
  const li = document.createElement('li');
  li.className = 'ce-row';
  const line = document.createElement('div');
  line.className = 'ce-line';
  const idx = document.createElement('span');
  idx.className = 'ch-no';
  idx.textContent = String(i + 1);
  const input = document.createElement('input');
  input.className = 'ce-title';
  input.placeholder = '第' + (i + 1) + '章';
  input.value = ch.title;
  input.addEventListener('change', async () => {
    const v = input.value.trim();
    if (v === ch.title) return;
    const old = ch.title;
    input.value = ch.title; // 未成功前先回显旧值
    ceBusy('保存标题…');
    try {
      const r = await api.patchChapter(ceState.id, ch.key, { title: v });
      ch.title = r.title; // 服务端兜底（空标题 → 第 N 章）后的规范值
      ceState.words = r.wordCount;
      ceState.dirty = true;
      input.value = ch.title;
      $('#ceStat', els.modalBox).textContent = ceStatText();
      toast('标题已保存', 1200);
    } catch (e) {
      input.value = old;
      toast('保存失败：' + (e.message || e), 2600);
    } finally {
      ceBusy('');
    }
  });

  // 正文编辑区（懒加载：首次展开才拉正文）
  const bodyBox = document.createElement('div');
  bodyBox.className = 'ce-body hidden';
  const ta = document.createElement('textarea');
  ta.rows = 8;
  bodyBox.appendChild(ta);
  const acts = document.createElement('div');
  acts.className = 'ce-body-acts';
  const tip = document.createElement('span');
  tip.className = 'pv-tip';
  tip.textContent = '替换本章正文（UTF-8 文本）';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'pv-save';
  save.textContent = '保存本章';
  save.disabled = true;
  let bodyOpen = false;
  ta.addEventListener('input', () => { save.disabled = false; });
  // 清洗排版：本地跑 cleaner.cleanText 后回填（与上传页同一套默认规则）。
  // 所见即所得，用户主动点才洗，不会覆盖自己排的版；回填后需点「保存本章」才入库。
  const cleanBtn = document.createElement('button');
  cleanBtn.type = 'button';
  cleanBtn.className = 'pv-btn';
  cleanBtn.textContent = '清洗排版';
  cleanBtn.title = '用与上传页相同的规则清洗本章（去[x]脚注/Markdown/多余空行/站点残留等）。可反复点，保存后生效。';
  cleanBtn.addEventListener('click', () => {
    const cleaned = cleaner.cleanText(ta.value, cleaner.DEFAULT_CLEAN_OPTS);
    if (cleaned === ta.value) {
      toast('正文已是干净格式', 1200);
      return;
    }
    ta.value = cleaned;
    save.disabled = false; // 内容已变，放行保存
    toast('已清洗排版，保存后生效', 1400);
  });
  save.addEventListener('click', async () => {
    ceBusy('保存正文…');
    save.disabled = true;
    try {
      const r = await api.patchChapter(ceState.id, ch.key, { content: ta.value });
      ceBodies.set(ch.key, ta.value);
      ceState.words = r.wordCount;
      ceState.dirty = true;
      $('#ceStat', els.modalBox).textContent = ceStatText();
      toast('本章正文已保存', 1400);
    } catch (e) {
      save.disabled = false;
      toast('保存失败：' + (e.message || e), 2600);
    } finally {
      ceBusy('');
    }
  });
  acts.append(tip, cleanBtn, save);
  bodyBox.append(ta, acts);

  const toggleBody = async () => {
    if (bodyOpen) {
      bodyBox.classList.add('hidden');
      bodyOpen = false;
      return;
    }
    if (!ceBodies.has(ch.key)) {
      ta.value = '';
      try {
        const meta0 = await api.bookMeta(ceState.id); // 拉最新 cleanVer 防缓存击穿失效
        const txt = await api.chapter(ceState.id, ch.key, meta0.cleanVer || 1);
        ceBodies.set(ch.key, txt);
        ta.value = txt;
      } catch (e) {
        toast('正文加载失败：' + (e.message || e), 2600);
        return;
      }
    }
    // 重开时若还保留着未保存的修改 → 不动内容也不启用保存钮之外的干扰
    if (ta.value === (ceBodies.get(ch.key) || '')) save.disabled = true;
    bodyBox.classList.remove('hidden');
    bodyOpen = true;
    ta.focus();
  };

  // 删除：双段确认（3s 内再点一次才执行）
  const delBtn = pvIconBtnSvg('x', '删除本章（连点两次确认）', () => {}, true);
  let armed = false;
  let armTimer = null;
  delBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      delBtn.textContent = '确认删除'; // 文字提示比图标更醒目
      armTimer = setTimeout(() => {
        armed = false;
        delBtn.innerHTML = IC.x; // 恢复图标
      }, 3200);
      return;
    }
    clearTimeout(armTimer);
    ceDelete(ch);
  });

  const editBtn = pvIconBtn('正文', '查看 / 替换本章正文', () => toggleBody().catch(() => {}));
  const insBtn = pvIconBtnSvg('plus', '在本章后插入一章', () => ceInsert(ch.key));
  line.append(idx, input, editBtn, insBtn, delBtn);
  li.append(line, bodyBox);
  return li;
}

async function ceDelete(ch) {
  ceBusy('删除中…');
  try {
    const r = await api.deleteChapter(ceState.id, ch.key);
    ceState.chapters = ceState.chapters.filter((c) => c.key !== ch.key);
    ceState.count = r.chapterCount;
    ceState.words = r.wordCount;
    ceState.dirty = true;
    ceBodies.delete(ch.key);
    $('#ceStat', els.modalBox).textContent = ceStatText();
    renderCeList();
    toast('已删除本章', 1400);
  } catch (e) {
    toast('删除失败：' + (e.message || e), 2600);
  } finally {
    ceBusy('');
  }
}

async function ceInsert(afterKey) {
  ceBusy('插入中…');
  try {
    const body = afterKey ? { after: afterKey, title: '新章', content: '' } : { title: '新章', content: '' };
    const r = await api.insertChapter(ceState.id, body);
    ceState.dirty = true;
    await refreshCeFromServer(); // 以服务端为唯一事实源刷新顺序/编号/字数
    toast('已插入「' + r.title + '」，可改标题/正文', 1600);
  } catch (e) {
    toast('插入失败：' + (e.message || e), 2600);
  } finally {
    ceBusy('');
  }
}

/** 结构变化后以服务端为准刷新章表（顺序/编号/字数） */
async function refreshCeFromServer() {
  const meta = await api.bookMeta(ceState.id);
  ceState.chapters = (meta.chapters || []).map((c) => ({ key: c.key, title: c.title }));
  ceState.count = meta.chapterCount || ceState.chapters.length;
  ceState.words = meta.wordCount || 0;
  $('#ceStat', els.modalBox).textContent = ceStatText();
  renderCeList();
}

async function finishChapterEditor() {
  const { id, dirty } = ceState;
  closeModal();
  if (!dirty) return;
  await loadShelf().catch(() => {});
  const off = await offline.getBook(id).catch(() => null);
  toast(off ? '已保存。若曾下载离线整本，请到阅读页重新 ⤓ 离线 同步' : '已保存', 2800);
}

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg, ms = 2000) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}
