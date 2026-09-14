/* app.js — 登录 / 书架（分类·批量·标签·诊断）/ 回收站 / 阅读入口；上传域见 upload/ */
import { api, local, fmtWords, ApiError } from './store.js';
import { BATCH_BOOKS_MAX, TRASH_DAYS, READ_DONE_RATIO } from './shared-const.js';
import * as reader from './reader.js';
import { bindBusy, bindToast, busy, busyDone, toast } from './ui.js';
import { exportBookTxt } from './exporter.js';
import { els, $, $$, esc, normTitle, IC } from './dom.js';
import { init as initUpload, openUpload, rewashConfirm, openChapterEditor } from './upload/index.js';

const PAGE = 60; // 书库分页

/** 上传/批量改标签/编辑信息三处的可选标签 chips：数据源 = 库里实际存在的标签
 * （GET /api/tags 按使用频次取 top 20）。无内置兜底——一本书都没打标签时就不显示，
 * 继续手动输入；打新标签/标签治理后 chips 自动跟随。快照存 localStorage（打开即显）。 */
const PRESET_SRC = 20;
let presetTags = [];
let presetTagsAt = 0; // 上次云端刷新时间（导航切换时去重，避免同一波操作连发多次 GET /api/tags）
let presetTagsInflight = null;

let books = []; // 全量在架书（服务端已含 pinned/prog 镜像）
let ui = { sort: 'recent', q: '', tag: '', finished: '', readState: '', star: false, page: 1 };

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
  els.readFilter = $('#readFilter');
  els.filterNote = $('#filterNote');
  els.loadMoreBtn = $('#loadMoreBtn');
  els.trashCount = $('#trashCount');
  els.trashList = $('#trashList');
  els.trashBack = $('#trashBack');
  els.trashClear = $('#trashClear');
  els.sheet = $('#sheet');
  els.modalMask = $('#modalMask');
  els.modalBox = $('#modalBox');

  // 弹层通用关闭：遮罩空白处点击 / Esc。确认弹层走「取消」语义（resolve(false)），
  // 其余弹层直接关；sheet（底部操作菜单）只挂 Esc，避免与打开它的按钮点击冒泡互踩。
  els.modalMask.addEventListener('click', (e) => {
    if (e.target === els.modalMask) modalDismiss();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.sheet.classList.contains('hidden')) {
      closeSheet();
      return;
    }
    if (!els.modalMask.classList.contains('hidden')) modalDismiss();
  });

  els.busyMask = $('#busyMask');
  els.busyBar = $('#busyBar');
  els.busyText = $('#busyText');
  els.toast = $('#toast');
  bindToast(els.toast);

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
  // 视口变化时操作单还开着 → 重新贴回触发按钮（否则它会停在旧坐标上）
  window.addEventListener('resize', () => {
    if (els.sheet.classList.contains('hidden')) return;
    if (!sheetAnchor) {
      clearSheetPos(); // 从桌面缩到手机：必须清内联样式，退回底部操作单
      return;
    }
    placeSheet(sheetAnchor);
  });
  // 书架滚动：桌面锚定操作单是 fixed 定位、不跟随锚点，滚动后会"飘"在旧坐标上 →
  // 滚动即关闭。只关锚定模式（sheetAnchor 非空）；手机底部操作单保持不动（本就固定在底部）。
  const shelfBody = $('.shelf-body', els.shelf);
  if (shelfBody) {
    shelfBody.addEventListener(
      'scroll',
      () => {
        if (sheetAnchor && !els.sheet.classList.contains('hidden')) closeSheet();
      },
      { passive: true }
    );
  }
  els.modalBox.addEventListener('click', onDiagBoxClick); // 残留诊断面板动作委托（常驻单例，只绑一次）
  els.bbExit.addEventListener('click', exitBatchMode);
  els.bbAll.addEventListener('click', () => {
    const list = sortedBooks(filteredBooks()); // 过滤+排序只算一次（百本量级下重复算一遍纯浪费）
    for (const b of list) selected.add(b.id);
    syncBatchBar();
    renderGrid(list);
  });
  els.bbInvert.addEventListener('click', () => {
    const list = sortedBooks(filteredBooks());
    for (const b of list) {
      if (selected.has(b.id)) selected.delete(b.id);
      else selected.add(b.id);
    }
    syncBatchBar();
    renderGrid(list);
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

  // 上传域（upload/）：注入宿主能力 + 绑定上传页自己的事件（切视图 / 刷书架 / 弹层 / 标签 chips）
  initUpload({
    showView,
    loadShelf,
    getBooks: () => books,
    openModal,
    closeModal,
    confirmModal,
    syncPresetChips,
    refreshPresetTags,
    parseTagInput,
  });

  reader.bindReader(els.readRoot, onNavBack);
  bindBusy({ bar: els.busyBar, text: els.busyText, mask: els.busyMask });
  presetTags = local.getPresetTags();
  renderPresetChips();
  boot(); // 预设标签的云端刷新挪进 boot 登录校验成功之后（登录前调用必 401，白费一个请求）
}

function onNavBack() {
  // 先关掉阅读器再切视图：closeReader 清掉 state.book，让它挂在 document / window 上的
  // visibilitychange 与 pagehide 监听彻底停写。漏掉这一步 → 返回书架后切后台仍会写进度，
  // 且比例读的是已 display:none 的正文区（scrollHeight 与 clientHeight 同为 0），
  // 把云端「末章 + 读完比例」覆盖成「末章 0%」。
  reader.closeReader();
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
    refreshPresetTags(); // 已确认登录 → 云端标签覆盖本地快照（打新标签/治理后 chips 跟进）
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

let shelfSeq = 0; // 并发去重：只应用最后一次 loadShelf 的结果，过期响应直接丢弃
async function loadShelf(data) {
  const seq = ++shelfSeq;
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
  // 等待期间又发起了新的 loadShelf（连点品牌/操作后立即刷新等）：本次响应已过期，
  // 丢弃——否则旧数据会把刚 PATCH 的星标/置顶「点了又没了」，刷新才恢复
  if (seq !== shelfSeq) return;
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
  if (ui.readState) list = list.filter((b) => readState(b) === ui.readState);
  if (ui.star) list = list.filter((b) => !!b.star);
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

  // 继续阅读：有进度且**还没读完**的书，按云端最后阅读时间倒序取前 3（prog 镜像，电脑/手机一致）。
  // 读完的书不再占「继续阅读」位——读完了就该从待读队列退出去（手动标记读完后同样退出）。
  const reading = books
    .filter((b) => b.prog && b.prog.updatedAt > 0 && readState(b) !== 'done')
    .sort((a, b) => (b.prog.updatedAt || 0) - (a.prog.updatedAt || 0))
    .slice(0, 3);
  els.continueWrap.classList.toggle('hidden', !reading.length);
  if (reading.length) {
    els.continueCard.innerHTML = '';
    for (const b of reading) els.continueCard.appendChild(makeCard(b));
  }

  const list = sortedBooks(filteredBooks());
  els.filterNote.textContent = ui.q || ui.tag || ui.finished || ui.readState || ui.star ? `筛选出 ${list.length} 本` : '';
  renderReadFilter();
  renderTagCloud();
  renderGrid(list);
}

function renderGrid(list) {
  const grid = els.grid;
  grid.innerHTML = '';
  const shown = list.slice(0, ui.page * PAGE);
  for (const b of shown) grid.appendChild(makeCard(b));
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

/** 阅读状态计数：给筛选 chips 用（一眼看出还剩多少没看） */
function readCounts() {
  const c = { unread: 0, reading: 0, done: 0, star: 0 };
  for (const b of books) {
    c[readState(b)]++;
    if (b.star) c.star++;
  }
  return c;
}

/** 阅读状态筛选行：全部 / 未读 N / 在读 N / 已读完 N。
 * 「全部」是本页的总重置入口——它同时清掉 tag / finished / readState / star 四个维度
 * （标签云行里原来的「全部」已挪走，避免两处同名按钮语义打架）；
 * 其余三个是单选，再点同一个即取消筛选。计数让「书多了还剩哪些没看」一眼可见。 */
function renderReadFilter() {
  const box = els.readFilter;
  if (!box) return;
  box.innerHTML = '';
  const c = readCounts();
  const mk = (label, on, act) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('on', !!on);
    b.addEventListener('click', act);
    return b;
  };
  box.appendChild(
    mk('全部', !ui.readState && !ui.tag && !ui.finished && !ui.star && !ui.q, () => {
      ui.readState = '';
      ui.tag = '';
      ui.finished = '';
      ui.star = false;
      ui.q = '';
      els.searchInput.value = ''; // 搜索框一并清空（「全部」= 五维总重置）
      ui.page = 1;
      renderShelf();
    })
  );
  const one = (label, val, n) =>
    mk(`${label} ${n}`, ui.readState === val, () => {
      ui.readState = ui.readState === val ? '' : val;
      ui.page = 1;
      renderShelf();
    });
  box.appendChild(one('未读', 'unread', c.unread));
  box.appendChild(one('在读', 'reading', c.reading));
  box.appendChild(one('已读完', 'done', c.done));
}

/** 分类导航栏：星标（独立维度）+ 状态频道（完结/连载中）+ 全部标签 chips。
 * 星标放这行行首而非阅读状态行（2026-09-13）：手机端「★星标 / 完结 / 连载中」三个
 * 「组织动作」正好凑一行（分隔符在手机断点改整行断行，标签从下一行起排），
 * 阅读状态行只剩 全部/未读/在读/已读完，一行放得下。逻辑不变：仍是自己的开关，
 * 「全部」总重置（renderReadFilter）照旧把它清掉。 */
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
  // 注：「全部」总重置按钮已挪到阅读状态筛选行（renderReadFilter）——
  // 由它统一清除 tag / finished / readState / star 四个维度，避免两处「全部」语义打架。
  // 星标是独立维度（一本「已读完」的书同样可以打星），不走互斥切换、自己管开关。
  // 计数为 0 也常驻显示——藏起来用户就不知道有这功能，也就永远不会去标星。
  const starBtn = mk(`★ 星标 ${readCounts().star}`, ui.star);
  starBtn.classList.add('star-chip');
  starBtn.addEventListener('click', () => {
    ui.star = !ui.star;
    ui.page = 1;
    renderShelf();
  });
  cloud.appendChild(starBtn);
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

/** 云端刷新预设标签：取使用频次 top N，写快照并重渲染；未登录/网络失败静默保留快照。
 * 去重：3 秒内重复调用（boot 后立即进上传页/编辑弹层等）不再发请求；并发调用复用同一 Promise。
 * 传 force=true 可绕过（标签治理等需立即反映结果的场景）。 */
async function refreshPresetTags(force = false) {
  if (!force && presetTagsInflight) return presetTagsInflight;
  if (!force && Date.now() - presetTagsAt < 3000) return;
  presetTagsAt = Date.now();
  const task = (async () => {
    try {
      const data = await api.tags();
      presetTags = (data.tags || []).slice(0, PRESET_SRC).map((t) => t.tag);
      local.setPresetTags(presetTags);
      renderPresetChips();
    } catch {
      /* 保留本地快照（可能为空 → 不显示 chips） */
    } finally {
      // 只清理「仍然是自己」的引用：force 刷新会覆盖 presetTagsInflight，
      // 无条件置 null 会把后来者的引用一并抹掉，使并发复用/去重失效
      if (presetTagsInflight === task) presetTagsInflight = null;
    }
  })();
  presetTagsInflight = task;
  return task;
}

/** 阅读状态：'unread' 未读 / 'reading' 在读 / 'done' 已读完。
 * 已读完＝手动标记（b.readDone，来自 PATCH /api/books/:id，已镜像进 index）优先；
 * 否则按「停在末章 && 本章滚动比例 ≥ READ_DONE_RATIO」自动判定。
 * 阈值放宽到 0.9（原 0.96）：手机末章末尾常有留白，原阈值下「读完」几乎点不亮。
 * 注意：书架上的 b.prog 是 index 进度镜像，章内滚动不实时刷新（为消除写放大做的取舍），
 * 所以角标只报章号、不再报百分比——章号是准的（仅换章时变），百分比注定滞后。 */
function readState(b) {
  if (b.readDone === true) return 'done';
  // readDone === false：用户明确标过「未读完」→ 强制不判为读完（用于摘掉自动判定出来的标记）
  if (b.readDone === false) return b.prog && b.prog.updatedAt ? 'reading' : 'unread';
  const p = b.prog;
  if (!p || !p.updatedAt) return 'unread';
  const cc = b.chapterCount || 0;
  if (p.ch <= 0 || cc <= 0) return 'reading';
  // 就地删章后 progress 章号可能略超当前章数（服务端会压回，历史脏数据/竞态窗口仍可能越界）：
  // 展示层 clamp，避免角标出现「读到 5/4 章」这类自相矛盾的数字
  const ch = Math.min(p.ch, cc);
  return ch >= cc && (p.ratio || 0) >= READ_DONE_RATIO ? 'done' : 'reading';
}

function progBadgeText(b, compact) {
  const st = readState(b);
  if (st === 'unread') return '';
  if (st === 'done') return '✓ 已读完';
  const cc = b.chapterCount || 0;
  if (cc <= 0) return '在读';
  const first = Math.min(b.prog.ch || 0, cc);
  // 章号为 0/负（脏数据，或只标了「在读」还没真正翻过章）时不编造「读到 1/N 章」
  if (first <= 0) return '在读';
  // compact：手机端用的紧凑形态（「1234/1988」），比长文案省约 48px。
  // 它是「元信息四项不删减」的一半前提，另一半是手机端整行降到 11px（见 style.css）——
  // 只做这一半仍会差 9px，末尾「452 万」会被省略号吃掉。
  return compact ? `${first}/${cc}` : `读到 ${first}/${cc} 章`;
}

function makeCard(b) {
  // 卡片本体必须是 div（role=button）而不是 <button>：卡内还要放 ⋯ 按钮，
  // HTML 禁止交互元素嵌套（button>button 非法，部分浏览器/读屏的焦点与点击语义会异常）
  const c = document.createElement('div');
  c.className =
    'card' +
    (b.pinned ? ' pinned' : '') +
    (readState(b) === 'done' ? ' read-done' : '') +
    (batchMode ? ' picking' : '') +
    (selected.has(b.id) ? ' picked' : '');
  const block = document.createElement('span');
  block.className = 'card-block';
  block.style.background = colorOf(b.title);
  block.textContent = Array.from((b.title || '书'))[0];
  const info = document.createElement('span');
  info.className = 'card-info';
  const t = document.createElement('em');
  t.textContent = b.title;
  // 元信息行容器：桌面端只是 <small> 的无害外壳（角标在其内部绝对定位，不参与排版），
  // 手机端则是「2 行卡片」的承载者——进度角标从独占第 3 行改为 inline 落在这行的右端。
  const metaRow = document.createElement('span');
  metaRow.className = 'card-meta-row';
  const m = document.createElement('small');
  const tags = (b.tags || []).slice(0, 2).join(' · ');
  // 「完结」标记从卡面撤掉后，元信息行在桌面最紧只有 143px（882px 视口），余量刚好归零；
  // 故把「3.2 万字」省成「3.2 万」再回收约 11px——「万」本身已表量级，不歧义。
  // 一万以下仍保留「845 字」（纯数字看不懂）。fmtWords 是 store.js 的共享函数，
  // 书架总计 / 上传统计 / 章节编辑器等处照旧，这里只做卡片局部精简。
  const wc = fmtWords(b.wordCount).replace(/ 万字$/, ' 万');
  m.textContent = [tags, `${b.chapterCount || 0} 章`, wc].filter(Boolean).join(' · ');
  metaRow.appendChild(m);
  info.appendChild(t);
  info.appendChild(metaRow);
  // 卡面不再放「完结」标记：它固定占 34px + 4px 间距 = 元信息行宽的 27%，
  // 一出现就把末尾的「3.2 万」挤掉（实测 `完结 · 仙侠 · 12 章 · 3.2 万字` 需 148px > 可用 143px）。
  // 它属于「书本身的属性」而不是我的标记，改成按需查看更合适——筛选行「完结 / 连载中」频道、
  // 编辑弹窗的「已完结」勾选框、批量标记三处都能看能改，服务端 finished 字段不受影响。
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
      p.className = 'prog-badge' + (readState(b) === 'done' ? ' done' : '');
      // 长/短两套文案都渲染出来，由 CSS 按屏宽显隐（手机显短、桌面显长）。
      // 不用 JS 判屏宽：窗口尺寸变化时无需重渲染，也不会出现「文案滞后于断点」。
      // 两者相同时（✓ 已读完 / 在读）只放一份纯文本、不打类 ——
      // 打了类就会在手机上被 .pb-full{display:none} 连唯一那份一起隐藏掉。
      const compact = progBadgeText(b, true);
      if (compact === badge) {
        p.textContent = badge;
      } else {
        const full = document.createElement('span');
        full.className = 'pb-full';
        full.textContent = badge;
        const short = document.createElement('span');
        short.className = 'pb-compact';
        short.textContent = compact;
        p.append(full, short);
      }
      metaRow.appendChild(p);
      // 桌面端用「有没有角标」决定 ★ 落点（有角标就下移一行）。
      // 原先是 `.prog-badge + .card-star` 相邻选择器：角标一挪进 .card-meta-row 就失效，
      // 且相邻关系是静默的（插个元素就错位）。改成显式类，谁也不用再数兄弟顺序。
      c.classList.add('has-badge');
    }
    // 星标＝金色 ★ 浮层（绝对定位，不进文档流）。原「★ 星标」胶囊与「完结」同行时，
    // 标记行会把卡片撑高 26px（桌面一排高低不齐、手机单卡多占 24px），浮层则完全不影响卡高。
    // 须是 .card 直接子元素：挂在 .card-block 里会被 `.read-done` 的 grayscale 一起灰掉。
    if (b.star) {
      const s = document.createElement('span');
      s.className = 'card-star';
      s.setAttribute('role', 'img');
      s.setAttribute('aria-label', '已加星标');
      s.textContent = '★';
      c.appendChild(s);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'card-more';
    more.textContent = '⋯';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      // 传触发按钮本身：桌面端操作单要贴着它展开（右上角 ⋯ 就在右上角弹，卡片 ⋯ 就在卡片旁弹）
      openSheet(b, e.currentTarget);
    });
    c.appendChild(more);
    c.addEventListener('click', () => openRead(b.id));
  }
  // div 卡片的键盘可达性（原 <button> 自带，改 div 后补上）：Enter/Space 触发与点击一致。
  // 只在本体聚焦时响应（e.target !== c 的按键属于卡内 ⋯ 按钮，由它自己处理）。
  c.setAttribute('role', 'button');
  c.tabIndex = 0;
  c.addEventListener('keydown', (e) => {
    if (e.target !== c || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (batchMode) {
      if (selected.has(b.id)) selected.delete(b.id);
      else selected.add(b.id);
      c.classList.toggle('picked', selected.has(b.id));
      const tick = c.querySelector('.pick-tick');
      if (tick) tick.textContent = selected.has(b.id) ? '✓' : '';
      syncBatchBar();
    } else {
      openRead(b.id);
    }
  });
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

/* ---------- 操作单（手机＝底部操作单 / 桌面＝贴着触发按钮的下拉） ---------- */
function openSheet(b, anchor) {
  const isPin = !!b.pinned;
  els.sheet.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sheet-title';
  title.textContent = b.title;
  els.sheet.appendChild(title);
  const items = [
    { text: '阅读', act: () => { closeSheet(); openRead(b.id); } },
    {
      text: readState(b) === 'done' ? '标记为未读完' : '标记为已读完',
      act: async () => {
        const next = readState(b) !== 'done';
        closeSheet();
        await markReadDone(b, next);
      },
    },
    { text: isPin ? '取消置顶' : '置顶到书架顶部', act: async () => { closeSheet(); await safePatch(b.id, { pinned: !isPin }); } },
    { text: b.star ? '取消星标' : '标为星标', act: async () => { closeSheet(); await safePatch(b.id, { star: !b.star }); } },
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
  placeSheet(anchor); // 必须摘掉 hidden 之后再量尺寸，否则宽高都是 0
}

/* ---------- 操作单定位 ----------
 * 手机（<900px）：底部操作单，拇指够得到，别动。
 * 桌面（≥900px）：改成贴住触发按钮的下拉——原来固定贴在屏幕底部居中，
 * 离右上角的 ⋯ 横跨半个屏幕，鼠标要跑一趟才够得着。
 * 定位相关样式一律写内联，关闭时清干净；否则残留的 left/top 会盖住响应式 CSS，
 * 手机端会莫名其妙跑到屏幕中间去。 */
const SHEET_POS_PROPS = ['left', 'top', 'right', 'bottom', 'transform', 'visibility'];
let sheetAnchor = null;

function clearSheetPos() {
  for (const k of SHEET_POS_PROPS) els.sheet.style.removeProperty(k);
}

function placeSheet(anchor) {
  const s = els.sheet;
  if (window.innerWidth < 900 || !anchor) {
    sheetAnchor = null;
    s.classList.remove('anchored');
    clearSheetPos();
    return;
  }
  sheetAnchor = anchor;
  s.classList.add('anchored');
  s.style.visibility = 'hidden'; // 先量尺寸再摆位，避免在旧坐标上闪一下
  const w = s.offsetWidth;
  const h = s.offsetHeight;
  const a = anchor.getBoundingClientRect();
  const M = 12; // 离视口边缘的最小留白
  const left = Math.max(M, Math.min(a.right - w, window.innerWidth - M - w)); // 右边缘对齐按钮，再夹进视口
  let top = a.bottom + 8;
  if (top + h > window.innerHeight - M) {
    const up = a.top - 8 - h; // 下方放不下就翻到按钮上方；上下都放不下时贴住底边
    top = up >= M ? up : Math.max(M, window.innerHeight - M - h);
  }
  s.style.left = Math.round(left) + 'px';
  s.style.top = Math.round(top) + 'px';
  s.style.right = 'auto';
  s.style.bottom = 'auto';
  s.style.transform = 'none';
  s.style.visibility = '';
}

function closeSheet() {
  sheetAnchor = null;
  els.sheet.classList.remove('anchored');
  clearSheetPos();
  els.sheet.classList.add('hidden');
}

async function safePatch(id, patch) {
  try {
    await api.patchBook(id, patch);
    await loadShelf();
    if (patch.pinned !== undefined) toast(patch.pinned ? '已置顶' : '已取消置顶', 1400);
    if (patch.star !== undefined) toast(patch.star ? '已加星标' : '已取消星标', 1400);
  } catch (e) {
    toast('操作失败：' + (e.message || e), 2500);
  }
}

/** 手动标记「已读完」/ 摘掉标记（PATCH readDone）。
 * 存在的意义：自动判定依赖进度（停在末章且滚动过阈值），跳着看、听书、或想手动归档时
 * 手动标记是唯一可靠的兜底。三态由服务端与 readState 共同保证：
 * true 强制已读完 / false 强制未读完 / 缺省走自动判定。 */
async function markReadDone(b, done) {
  try {
    await api.patchBook(b.id, { readDone: done });
    await loadShelf();
    toast(done ? '已标记为读完' : '已取消「已读完」标记', 1600);
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
/** 遮罩点击 / Esc 的统一退出：优先点「取消」按钮，让弹层自己把 Promise resolve 掉；其余直接关。
 *  ⚠️ 必须同时认 #dpCancel —— 那是「发现同名书籍」弹层（askDup）的取消键。只认 #cfNo 的话，
 *  用遮罩/Esc 关掉同名弹层时既不 resolve 也不复位上传态：onConfirm 永久卡在 await askDup 上，
 *  isUploading() 恒真 → 确认按钮锁死、后续选文件/粘贴全被 isBusy() 拦掉，只能刷新页面。 */
function modalDismiss() {
  const cancel = $('#dpCancel', els.modalBox) || $('#cfNo', els.modalBox);
  if (cancel) {
    cancel.click();
    return;
  }
  closeModal();
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
function openMoreSheet(ev) {
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
  placeSheet(ev && ev.currentTarget); // 桌面上贴住右上角那个 ⋯
}

function syncBatchBar() {
  els.bbCount.textContent = String(selected.size);
  // 未选书时禁用全部动作按钮（视觉+语义同步）
  const dis = selected.size === 0;
  for (const b of [els.bbTags, els.bbDone, els.bbOngoing, els.bbDelete]) b.disabled = dis;
}

/** 批量执行：分批调用批量 API（每批 BATCH_PAGE 本 = BATCH_BOOKS_MAX），busy 进度反馈；完成后刷新书架 */
async function batchRun(action, payload, confirmText) {
  if (!selected.size) return;
  const ids = Array.from(selected);
  if (!(await confirmModal(confirmText, '执行'))) return;
  busy(0, `批量操作中… 0/${ids.length}`);
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
      busy(Math.min(i + BATCH_PAGE, ids.length) / ids.length, `批量操作中… ${Math.min(i + BATCH_PAGE, ids.length)}/${ids.length}`);
    }
  } finally {
    busyDone();
  }
  exitBatchMode();
  refreshPresetTags(true); // 标签可能变了：强制刷新 chips（不阻塞后面的书架刷新）
  await loadShelf().catch(() => {}); // 刷新失败不吞结果提示
  toast(fail ? `完成 ${ok} 本，${fail} 本失败（可能是半成品书）` : `已更新 ${ok} 本`, 2600);
}

/** 批量改标签：输入标签（逗号分隔）→ 添加到所选书 / 从所选书移除 */
function batchEditTags() {
  if (!selected.size) return;
  openModal(`
    <h3>批量改标签 <span class="muted">(${selected.size} 本)</span></h3>
    <div class="m-field">
      <input id="btInput" type="text" placeholder="多个标签用逗号分隔，如：玄幻, 完结自用" autocomplete="off">
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
        <input class="tm-input" type="text" placeholder="改名 / 合并到…" autocomplete="off">
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

/** 标签合并执行：remaining>0 时自动续调直到清完（每批 18 本受子请求预算约束）；
 * guard 用尽仍有剩余 → 明确提示续跑，不再静默截断 */
async function tagMergeRun(from, to) {
  busy(0, '更新书籍标签…');
  let updated = 0;
  let left = 0;
  try {
    for (let guard = 0; guard < 60; guard++) {
      const r = await api.tagsMerge(from, to);
      updated += r.updated || 0;
      left = r.remaining || 0;
      // 总量需首轮响应后才能得知（updated + remaining）；无总量时只更新文案、不推进度条
      const total = updated + left;
      busy(total ? updated / total : 1, total ? `更新书籍标签… ${updated}/${total}` : '更新书籍标签…');
      if (!left) break;
    }
  } catch (e) {
    busyDone();
    toast('失败：' + (e.message || e), 2600);
    // 确认弹层已把标签管理弹层顶掉并关闭：失败时若不重建，用户会被留在
    // 「没有任何弹层」的书架上，看不到标签、也不知从哪重试
    await openTagMgr();
    return;
  }
  busyDone();
  refreshPresetTags(true); // 治理后 chips 必须立即跟进（绕过 3 秒去重）
  await loadShelf().catch(() => {}); // 刷新失败不吞结果提示
  toast(left ? `已更新 ${updated} 本，仍有 ${left} 本未处理——请重试一次` : to ? `已更新 ${updated} 本` : `已从 ${updated} 本书上移除`, 2600);
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

/** 全库扫描（含大库 text/ 分窗续扫）：循环带上服务端回传的 textCursor，直到 null 扫完。
 * 期间把 residue/chapterOrphans 增量合并（orphanBooks/summary 只在首页有意义），onPage 回调做进度展示。
 * onPage 返回 false 表示中止（用户在扫描途中关闭弹层）→ 立刻停止后续请求，
 * 不再白烧服务端请求配额，并置 incomplete 标记本次结果不完整。 */
async function diagScanAll(onPage) {
  let merged = null;
  let cursor = '';
  let incomplete = false;
  for (let guard = 0; guard < 200; guard++) {
    const d = await api.diagOrphans(cursor);
    if (!merged) {
      merged = d;
    } else {
      merged.residue = (merged.residue || []).concat(d.residue || []);
      merged.chapterOrphans = (merged.chapterOrphans || []).concat(d.chapterOrphans || []);
      merged.scannedAt = d.scannedAt;
      merged.scannedPages = (merged.scannedPages || 0) + (d.scannedPages || 0);
    }
    incomplete = incomplete || !!d.incomplete;
    cursor = d.textCursor || '';
    if (!cursor) break;
    if (onPage && onPage(merged) === false) {
      incomplete = true; // 用户中止：结果不完整，不再继续翻页
      break;
    }
  }
  merged.incomplete = incomplete;
  return merged;
}

async function openDiag() {
  openModal('<h3>残留检查</h3><p class="modal-sub">正在扫描全库对象…</p>');
  try {
    diagData = await diagScanAll((m) => {
      if (els.modalMask.classList.contains('hidden')) return false; // 已关闭 → 中止后续扫描
      const el = $('.modal-sub', els.modalBox);
      if (el) el.textContent = `正在扫描全库对象… 已扫 ${m.scannedPages || 0} 页，暂发现 ${(m.residue || []).length + (m.chapterOrphans || []).length} 项残留`;
      return true;
    });
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
    diagData = await diagScanAll(null);
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
    <p class="modal-sub">扫描于 ${new Date(d.scannedAt).toLocaleString()} · 在架 ${d.liveBooks} 本 ${badge}${d.incomplete ? '<span class="diag-tag diag-tag-orphan"> · 部分书因预算所限未能核验，结果可能不完整</span>' : ''}</p>
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
    // 不套 esc()：confirmModal 内部已统一转义，再 esc 一次会把 & 显示成 &amp;
    if (!(await confirmModal(`把未入架的书《${title || '未命名'}》移入回收站？可在回收站恢复或彻底删除。`, '移入回收站'))) return;
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
    let total = 0; // 首次返回的剩余量即总数：此前 hardcode /10，书多时进度条全程卡在 5%
    let guard = 0;
    while (remaining > 0 && guard++ < 1000) {
      const r = await api.clearTrash();
      remaining = r.remaining || 0;
      if (!total) total = Math.max(remaining, 1);
      busy(Math.min(0.99, Math.max(0.05, 1 - remaining / total)), remaining ? `清空中…剩余 ${remaining} 本` : '完成');
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

// 上传会话状态（会话对象 / uploading / importing / createdId / rawInflightReq）
// 统一由 upload/session.js 持有：本文件只通过它的 API 读写，不再有模块级裸变量。
// 会话对象形状：{ title, bytes, preview, updating:null|{id,op,book}, keepRaw, cleanOpts }

