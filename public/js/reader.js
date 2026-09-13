/* reader.js — 双端阅读器（桌面：左目录+右正文 / 手机：沉浸滚读）
 * 滚读 + 进度（8s 节流 / 切后台立即存 / 离线入队回网上送）+ 目录分页 + 4 主题/字号
 * + 键盘导航（桌面）+ 上下工具栏常驻 + 预取 + PWA 离线兜底 + 导出
 */
import { api, local, fetchChaptersAll, ApiError } from './store.js';
import { offline, bindOnlineFlush } from './offline.js';
import { busy, busyDone } from './ui.js';
import { exportBookTxt } from './exporter.js';

const THEMES = [
  { key: 'paper', name: '羊皮纸', bg: '#f6f1e5', fg: '#3b3424' },
  { key: 'white', name: '白', bg: '#ffffff', fg: '#26262a' },
  { key: 'green', name: '护眼绿', bg: '#dcecdd', fg: '#223324' },
  { key: 'night', name: '夜间', bg: '#16181c', fg: '#b8bec6' },
];

const TOC_PAGE = 50; // 目录分页（移动抽屉 / 桌面侧栏各自独立）

const state = {
  book: null,
  chapters: [],
  cur: 0,
  cache: new Map(),
  inflight: new Map(), // 进行中的章节请求：同章并发合并，翻章可搭后台预取的顺风车
  toc: { draw: TOC_PAGE, side: TOC_PAGE }, // 两个目录容器各自的已渲染量
  dirty: false,
  lastSave: 0,
  failedIdx: null, // 加载失败的章（下标）：失败章不算「读到」，切后台/滚动不得把进度写过去
  pref: { ...defaultPref(), ...local.getPref() },
};

const CACHE_MAX = 40; // 内存章缓存上限（LRU，防千章书无限膨胀）

function defaultPref() {
  return { fs: 18, lh: 1.95, theme: 'paper' };
}

/* ---------- DOM ---------- */
let els = {};
let onNav = null;
const mqDesktop = () => matchMedia('(min-width: 900px)').matches;

let flushBound = false;

export function bindReader(root, navCb) {
  els = {
    root,
    topTitle: root.querySelector('#readTopTitle'),
    scroll: root.querySelector('#readScroll'),
    art: root.querySelector('#readArt'),
    side: root.querySelector('#readSide'),
    sideTitle: root.querySelector('#sideTitle'),
    sideOpen: root.querySelector('#sideOpen'),
    sideOpenTitle: root.querySelector('#sideOpenTitle'),
    sideList: root.querySelector('#sideTocList'),
    sideMore: root.querySelector('#sideTocMore'),
    drawer: root.querySelector('#tocDrawer'),
    drawerList: root.querySelector('#tocList'),
    tocTitle: root.querySelector('#tocTitle'),
    tocMore: root.querySelector('#tocMore'),
    tip: root.querySelector('#readTip'),
    prog: root.querySelector('#readProg'),
    progFill: root.querySelector('#readProgFill'),
    prefPanel: root.querySelector('#prefPanel'),
    ppFs: root.querySelector('#ppFs'),
    ppLh: root.querySelector('#ppLh'),
    ppFsRange: root.querySelector('#ppFsRange'),
    ppLhRange: root.querySelector('#ppLhRange'),
    ppThemes: root.querySelector('#ppThemes'),
  };
  onNav = navCb;
  root.addEventListener('click', (e) => {
    const th = e.target.closest('[data-th]');
    if (th) {
      setTheme(th.dataset.th);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'prev') goto(state.cur - 1);
    else if (act === 'next') goto(state.cur + 1);
    else if (act === 'toc') (mqDesktop() ? toggleSide : openToc)();
    else if (act === 'tocClose') closeToc();
    else if (act === 'back') {
      closeToc();
      if (onNav) onNav();
    }
    else if (act === 'pref') togglePref();
    else if (act === 'prefClose') closePref();
    else if (act === 'fontUp') setFont(1);
    else if (act === 'fontDown') setFont(-1);
    else if (act === 'download') downloadCurrent();
    else if (act === 'export') exportCurrentText();
  });
  // 桌面侧栏
  root.querySelector('#sideClose').addEventListener('click', () => collapseSide());
  els.sideOpen.addEventListener('click', () => expandSide());
  els.sideMore.addEventListener('click', () => {
    state.toc.side += TOC_PAGE;
    fillToc(els.sideList, state.toc.side);
    els.sideMore.classList.toggle('hidden', state.chapters.length <= state.toc.side);
  });
  els.tocMore.addEventListener('click', () => {
    state.toc.draw += TOC_PAGE;
    fillToc(els.drawerList, state.toc.draw);
    els.tocMore.classList.toggle('hidden', state.chapters.length <= state.toc.draw);
  });
  // 设置面板滑杆：拖动实时预览（值域与钳制在 setFontSize/setLineHeight 内）
  if (els.ppFsRange) els.ppFsRange.addEventListener('input', () => setFontSize(els.ppFsRange.value));
  if (els.ppLhRange) els.ppLhRange.addEventListener('input', () => setLineHeight(els.ppLhRange.value));
  bindProgLine();
  // 点正文：只用于关掉设置浮层。
  // 工具栏已改为常驻，不再轻点隐藏/唤出——原实现把 fixed 工具栏 translateY 滑出屏幕，
  // 但正文区 #readScroll 的 top/bottom 是写死的，滑走后上下反而露出与正文不同色的两条
  // 底带，正文区一点没变大：视觉脏、纯亏。详见 css 里 .read-top/.read-bar 处注释。
  els.scroll.addEventListener('click', (e) => {
    // 点到交互元素（按钮/输入框/选择区）不算「轻点正文」
    if (e.target.closest && e.target.closest('button, a, input, textarea, select, .ch-retry')) return;
    if (!els.prefPanel.classList.contains('hidden') || !els.drawer.classList.contains('hidden')) {
      closePref();
    }
  });
  els.scroll.addEventListener('scroll', onScroll);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);
  window.addEventListener('keydown', onKey);
  // 阅读中窗口跨断点：桌面 ⇄ 手机 自动切换侧栏显隐
  matchMedia('(min-width: 900px)').addEventListener?.('change', (e) => {
    if (!els.side) return;
    const on = e.matches;
    els.side.classList.toggle('hidden', !on);
    if (on && state.book) {
      els.root.classList.remove('side-collapsed');
      renderSideToc();
      requestAnimationFrame(() => scrollSideCur());
    }
  });
  if (!flushBound) {
    flushBound = true;
    bindOnlineFlush((id, p) => api.putProgress(id, p));
  }
}

/* ---------- 打开一本书 ---------- */
let openSeq = 0; // 递增令牌：只有最新一次 openBook 允许写 state/渲染
export async function openBook(id) {
  const seq = ++openSeq;
  let meta;
  try {
    meta = await api.bookMeta(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    // 网络失败 → 用本地整本缓存的书目打开（离线场景）
    const off = await offline.getBook(id).catch(() => null);
    if (off) meta = { ...off, id }; // IndexedDB 记录只存 bookId，补齐 id 供后续取章
    else throw e;
  }
  if (seq !== openSeq) return; // meta 等待期间用户已开了别的书：本次打开整体作废
  if (!meta.chapters || !meta.chapters.length) throw new Error('这本书还没有可读章节');
  state.book = meta;
  state.chapters = meta.chapters.map((c, i) => ({ ...c, i }));
  state.cache.clear();
  state.inflight.clear();
  state.cur = 0;
  state.toc = { draw: TOC_PAGE, side: TOC_PAGE };

  // 恢复进度（本地 / 云端均为 1-based 章节号，取较新；0/-1 视为未读首章）
  const clampCh = (x) => Math.max(0, Math.min(state.chapters.length - 1, x));
  let ch = 0;
  let ratio = 0;
  const lp = local.getProg(id);
  if (lp && lp.updatedAt && Number.isFinite(lp.ch)) {
    ch = clampCh((lp.ch || 1) - 1);
    ratio = lp.ratio || 0;
  }
  const sp = await api.getProgress(id);
  if (seq !== openSeq) return; // 进度请求等待期间已切书：同样作废（尚未渲染，不影响新书）
  if (sp && sp.updatedAt && Number.isFinite(sp.ch) && (!lp || sp.updatedAt > (lp.updatedAt || 0))) {
    ch = clampCh((sp.ch || 1) - 1);
    ratio = sp.ratio || 0;
  }
  state.cur = ch;

  els.topTitle.textContent = meta.title;
  els.sideTitle.textContent = meta.title;
  els.sideOpenTitle.textContent = Array.from(meta.title || '目')[0];
  // 桌面：展开目录侧栏；移动端保持隐藏（走抽屉）
  const desktop = mqDesktop();
  els.side.classList.toggle('hidden', !desktop);
  els.root.classList.toggle('side-collapsed', !desktop);
  els.root.dataset.book = id;
  els.root.classList.remove('hidden');
  renderDrawerToc();
  if (desktop) {
    renderSideToc();
    requestAnimationFrame(() => scrollSideCur());
  }
  applyPref();
  await renderChapter(ch, ratio);
}

async function renderChapter(idx, restoreRatio) {
  if (idx < 0 || idx >= state.chapters.length) return;
  state.cur = idx;
  state.failedIdx = null; // 新一次渲染先按「会成功」处理，失败路径再标记
  updateProgressLine(); // 章号此刻已定，成功/失败两路都该反映当前位置
  els.art.innerHTML = '';
  const ch = state.chapters[idx];
  let text;
  try {
    text = await loadChapter(idx);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      showTip('会话过期，请重新登录', 2000);
      throw e;
    }
    // 等待期间用户已翻到别的章：本次失败作废（否则重试提示会盖在新章正文上）
    if (state.cur !== idx) return;
    // 失败章标记：saveProgress 见到「当前章＝失败章」一律跳过——否则切后台会把
    // 进度写成「读到该章 0%」，覆盖掉此前的真实位置（跨设备继续阅读会跳错章）
    state.failedIdx = idx;
    // 网络失败且无离线缓存：给出可点的重试入口（文案与行为对齐）
    const retry = document.createElement('p');
    retry.className = 'ch-retry';
    retry.textContent = '本章加载失败，点按重试';
    retry.addEventListener('click', () => {
      retry.textContent = '重试中…';
      renderChapter(idx, 0).catch(() => {});
    });
    els.art.replaceChildren(retry);
    return;
  }
  // 加载是异步的：若等待期间用户已翻到别的章（快速连点「下一章」/目录连点），
  // 本次结果直接作废——否则会出现「显示的是旧章正文，而 state.cur 与随后落盘的
  // 进度却记的是新章」，既错位又会把云端进度写坏。
  if (state.cur !== idx) return;
  const docFrag = renderParas(text, els.art, makeChHead(idx));
  els.art.replaceChildren(docFrag);
  // 翻章淡入：消除内容瞬间替换的生硬感（重排触发重播动画；系统减动效时 CSS 侧自动关闭）
  els.art.classList.remove('fade-in');
  void els.art.offsetWidth;
  els.art.classList.add('fade-in');
  els.scroll.scrollTop = 0;
  if (restoreRatio && restoreRatio > 0) {
    // 恢复滚动到目标比例后再存进度：若在此处（滚动位置仍是 0）就保存，
    // 会把云端进度比例覆盖成 0（章节号对、比例丢——跨设备继续阅读会跳回章首）
    requestAnimationFrame(() => {
      const el = els.scroll;
      el.scrollTop = restoreRatio * (el.scrollHeight - el.clientHeight) || 0;
      saveProgress();
    });
  } else {
    saveProgress(); // 翻章即同步云端（一章一次写，频率低）：保证「继续阅读/最近在读」跨设备准确
  }
  markCur();
  // 预取下一章（静默）
  if (idx + 1 < state.chapters.length) loadChapter(idx + 1).catch(() => {});
}

async function loadChapter(idx) {
  const ch = state.chapters[idx];
  const hit = state.cache.get(ch.key);
  if (hit !== undefined) return hit;
  // 同一章的并发请求合并为一次（翻章/目录跳转撞上后台预取时，直接搭同一请求）
  const pending = state.inflight.get(ch.key);
  if (pending) return pending;
  const task = (async () => {
    try {
      const t = await api.chapter(state.book.id, ch.key, state.book.cleanVer || 1);
      cachePut(ch.key, t);
      // 若该书已整本离线，顺带更新缓存
      offline.cacheChapterIfDownloaded(state.book.id, ch.key, t).catch(() => {});
      return t;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw e;
      // 网络失败 → 离线缓存兜底
      const off = await offline.getChapter(state.book.id, ch.key).catch(() => null);
      if (off != null) {
        cachePut(ch.key, off);
        return off;
      }
      throw e;
    }
  })();
  state.inflight.set(ch.key, task);
  try {
    return await task;
  } finally {
    state.inflight.delete(ch.key);
  }
}

/* ---------- 进度线（底栏上沿细线：看全书位置 + 点/拖跳章） ----------
 * 手机底栏按钮位已满，故不加按钮：细线同时承担「看进度」与「跳章」。
 * 拖动中只更新浮标文案，松手才真正 goto——拖动不触发渲染，长书也不卡。 */
function updateProgressLine() {
  const n = state.chapters.length || 1;
  const i = Math.min(state.cur, n - 1);
  if (els.progFill) els.progFill.style.width = Math.max(0.6, ((i + 1) / n) * 100) + '%';
  if (els.prog) {
    els.prog.setAttribute('aria-valuemax', String(n));
    els.prog.setAttribute('aria-valuenow', String(i + 1));
  }
}

function bindProgLine() {
  const p = els.prog;
  if (!p) return;
  let dragging = false;
  const targetOf = (e) => {
    const n = state.chapters.length;
    if (!n) return 0;
    const r = p.getBoundingClientRect();
    const t = (e.clientX - r.left) / Math.max(1, r.width); // 可能略微越界，下面夹取
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  };
  const label = (i) => `第 ${i + 1}/${state.chapters.length} 章`;
  p.addEventListener('pointerdown', (e) => {
    if (!state.book || !state.chapters.length) return;
    dragging = true;
    if (p.setPointerCapture) p.setPointerCapture(e.pointerId); // 移出热区仍能收到 move/up
    showTip(label(targetOf(e)), 1400);
    e.preventDefault(); // 防触发页面滚动（配合 CSS touch-action:none）
  });
  p.addEventListener('pointermove', (e) => {
    if (dragging) showTip(label(targetOf(e)), 1400);
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    const i = targetOf(e);
    showTip(label(i), 1200);
    if (i !== state.cur) goto(i);
  };
  p.addEventListener('pointerup', finish);
  p.addEventListener('pointercancel', () => {
    dragging = false;
  });
}

/** 写入章缓存（LRU：命中提升为最新，超上限淘汰最久未读的章） */
function cachePut(key, text) {
  state.cache.delete(key);
  state.cache.set(key, text);
  while (state.cache.size > CACHE_MAX) {
    const oldest = state.cache.keys().next().value;
    if (oldest === undefined) break;
    state.cache.delete(oldest);
  }
}

/* 章节头：章名 + 第 x/y 章 + 全文进度（章首计） */
function makeChHead(idx) {
  const len = state.chapters.length;
  const head = document.createElement('header');
  head.className = 'ch-head';
  const h = document.createElement('h2');
  h.textContent = state.chapters[idx].title || ('第' + (idx + 1) + '章');
  const meta = document.createElement('div');
  meta.className = 'ch-meta';
  meta.textContent = `第 ${idx + 1} / ${len} 章 · 全文 ${Math.max(0, Math.min(99, Math.round((idx / len) * 100)))}%`;
  head.appendChild(h);
  head.appendChild(meta);
  return head;
}

function renderParas(text, target, head) {
  const frag = document.createDocumentFragment();
  if (head) frag.appendChild(head);
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const p = document.createElement('p');
    p.textContent = s;
    frag.appendChild(p);
  }
  if (!frag.childNodes.length || frag.childNodes.length === 1) {
    const p = document.createElement('p');
    p.textContent = '（本章无内容）';
    frag.appendChild(p);
  }
  return frag;
}

/* ---------- 目录（移动抽屉 + 桌面侧栏共用渲染） ---------- */
function buildTocItem(i) {
  const c = state.chapters[i];
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'toc-item' + (i === state.cur ? ' cur' : '') + (i < state.cur ? ' read' : '');
  b.textContent = c.title;
  b.dataset.idx = String(i);
  b.addEventListener('click', () => {
    const fromSide = !!(b.closest && b.closest('#readSide'));
    if (!fromSide) closeToc();
    goto(i);
  });
  return b;
}

/** 增量渲染目录到 until（从已有列表末尾续接） */
function fillToc(ul, until) {
  const end = Math.min(until, state.chapters.length);
  const children = ul.children;
  const start = children.length ? Number(children[children.length - 1].dataset.idx) + 1 : 0;
  for (let i = start; i < end; i++) {
    const li = document.createElement('li');
    li.dataset.idx = String(i); // 增量续接时按 li 上的 idx 定位，避免读错层级
    li.appendChild(buildTocItem(i));
    ul.appendChild(li);
  }
}

function renderDrawerToc() {
  // 已加载量只增不减：重开抽屉保留「加载更多」进度，只需保证当前章可见
  state.toc.draw = Math.max(state.toc.draw, TOC_PAGE, state.cur + 1);
  els.drawerList.innerHTML = '';
  fillToc(els.drawerList, state.toc.draw);
  els.tocTitle.textContent = state.book.title;
  els.tocMore.classList.toggle('hidden', state.chapters.length <= state.toc.draw);
}

function renderSideToc() {
  state.toc.side = Math.max(state.toc.side, TOC_PAGE, state.cur + 1);
  els.sideList.innerHTML = '';
  fillToc(els.sideList, state.toc.side);
  els.sideMore.classList.toggle('hidden', state.chapters.length <= state.toc.side);
}

/** 翻章后同步两处目录的 当前章/已读 高亮 */
function markCur() {
  for (const ul of [els.drawerList, els.sideList]) {
    if (!ul) continue;
    for (const li of ul.children) {
      const i = Number(li.firstChild.dataset.idx);
      li.firstChild.classList.toggle('cur', i === state.cur);
      li.firstChild.classList.toggle('read', i < state.cur);
    }
  }
}

/** 桌面侧栏滚动到当前章（保持可视） */
function scrollSideCur() {
  const cur = els.sideList && els.sideList.querySelector('.cur');
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
}

function openToc() {
  closePref();
  renderDrawerToc();
  const list = els.drawerList;
  list.scrollTop = 0;
  const item = list.querySelectorAll('.toc-item')[Math.min(state.cur, state.toc.draw - 1)];
  if (item && item.scrollIntoView) {
    setTimeout(() => item.scrollIntoView({ block: 'center' }), 30);
  }
  els.drawer.classList.remove('hidden');
}

function closeToc() {
  els.drawer.classList.add('hidden');
}

/* ---------- 桌面目录侧栏 折叠/展开 ---------- */
function toggleSide() {
  if (els.root.classList.contains('side-collapsed')) expandSide();
  else collapseSide();
}

function collapseSide() {
  closePref();
  els.root.classList.add('side-collapsed');
}

function expandSide() {
  els.root.classList.remove('side-collapsed');
  requestAnimationFrame(() => scrollSideCur());
}

/* ---------- 字号 / 行距 / 背景 ---------- */
let appliedTheme = null; // 主题未变时跳过重建偏好面板
function applyPref() {
  const root = els.root;
  const th = THEMES.find((t) => t.key === state.pref.theme) || THEMES[0];
  // 注：字号/行距直接写在 #readArt 的内联样式上（下面两行）——曾往根节点设 --fs/--lh
  // 但全 CSS 无消费者，纯属死变量，已删
  root.style.setProperty('--read-bg', th.bg);
  root.style.setProperty('--read-fg', th.fg);
  // 工具栏/设置面板的毛玻璃底：当前主题色 + 97% 不透明（hex8）。
  // 移动端 backdrop-filter 在 transform 动画中可能丢采样被合成成白条，
  // 可读性必须不依赖 blur——97% 近实色兜底，blur 只做质感增强
  root.style.setProperty('--read-chrome', th.bg + 'F7');
  els.art.style.fontSize = state.pref.fs + 'px';
  els.art.style.lineHeight = String(state.pref.lh);
  if (els.ppFsRange) els.ppFsRange.value = String(state.pref.fs);
  if (els.ppLhRange) els.ppLhRange.value = String(state.pref.lh);
  if (appliedTheme !== state.pref.theme) {
    appliedTheme = state.pref.theme;
    renderPrefPanel();
  }
}

const FS_MIN = 10, FS_MAX = 30, LH_MIN = 1.5, LH_MAX = 2.6;

function setFont(d) {
  state.pref.fs = Math.min(FS_MAX, Math.max(FS_MIN, state.pref.fs + d));
  savePref();
  applyPref();
}

/** 滑杆直接设定（设置面板拖动实时预览） */
function setFontSize(v) {
  state.pref.fs = Math.min(FS_MAX, Math.max(FS_MIN, Math.round(Number(v) || state.pref.fs)));
  savePref();
  applyPref();
}
function setLineHeight(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  state.pref.lh = Math.round(Math.min(LH_MAX, Math.max(LH_MIN, n)) * 100) / 100;
  savePref();
  applyPref();
}

function setTheme(key) {
  if (!THEMES.some((t) => t.key === key)) return;
  state.pref.theme = key;
  savePref();
  applyPref();
  showTip('背景：' + (THEMES.find((t) => t.key === key) || {}).name, 900);
}

/* 阅读设置面板：同步当前字号/行距文本与背景色块 */
function renderPrefPanel() {
  if (!els.ppFs || !els.ppLh || !els.ppThemes) return;
  els.ppFs.textContent = state.pref.fs;
  els.ppLh.textContent = state.pref.lh.toFixed(2);
  const cur = state.pref.theme;
  els.ppThemes.innerHTML = '';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.th = t.key;
    b.className = 'pp-theme' + (t.key === cur ? ' on' : '');
    b.title = t.name;
    b.style.background = t.bg;
    b.style.color = t.fg;
    els.ppThemes.appendChild(b);
  }
}

function togglePref() {
  const panel = els.prefPanel;
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    renderPrefPanel();
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

function closePref() {
  if (els.prefPanel) els.prefPanel.classList.add('hidden');
}

function savePref() {
  local.setPref(state.pref);
}

/* ---------- 进度 ---------- */
function curRatio() {
  const el = els.scroll;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
}

function onScroll() {
  if (!state.book) return;
  // 进度节流保存（上下工具栏已常驻，滚动只负责存进度）
  const now = Date.now();
  if (now - state.lastSave > 8000) {
    state.lastSave = now;
    saveProgress();
  }
}

function onHidden() {
  saveProgress();
}

/* 进度：state.cur 为数组下标（0-based），落盘统一转 1-based 章节号。
 * 本地镜像 + 云端同步一体：翻章立即上云（保证「继续阅读/最近在读」跨设备准确），
 * 滚动中由 8s 节流与切后台触发；离线入队、回网补传。 */
function saveProgress() {
  if (!state.book) return;
  if (state.failedIdx !== null && state.failedIdx === state.cur) return; // 失败章不算读到
  const p = { ch: state.cur + 1, ratio: curRatio(), updatedAt: Date.now() };
  local.setProg(state.book.id, p);
  if (navigator.onLine === false) {
    // 离线：入队，回网自动上送
    offline.queueProgress(state.book.id, p).catch(() => {});
    return;
  }
  api
    .putProgress(state.book.id, { ch: p.ch, ratio: p.ratio })
    .catch(() => offline.queueProgress(state.book.id, p).catch(() => {}));
}

function goto(idx) {
  if (idx < 0 || idx >= state.chapters.length) return;
  saveProgress();
  renderChapter(idx, 0).catch((e) => {
    if (e instanceof ApiError && e.status === 401) showTip('会话过期，请重新登录', 2000);
  });
  markCur();
  if (mqDesktop() && !els.root.classList.contains('side-collapsed')) {
    requestAnimationFrame(() => scrollSideCur());
  }
}

/* ---------- 键盘导航（桌面；连键盘手机同样生效） ---------- */
function onKey(e) {
  if (!els.root || els.root.classList.contains('hidden')) return;
  // 带 Ctrl/⌘/Alt 的组合键属于浏览器/系统快捷键（Ctrl+T 新标签、Ctrl+PageUp/Down 切标签、
  // Alt+←/→ 前进后退），必须整类放行：这些分支里 't'/' '/PageUp/PageDown 的 key 与单键相同，
  // 不挡就会「顺手」把侧栏或抽屉掀开、把章节翻掉。Shift 刻意不排除——下面的 'T' 分支
  // 就是为了 CapsLock/Shift 敲出来的大写 T 仍然能开目录。
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const inBtn = !!(t && t.closest && t.closest('button, a'));
  const overlay = !els.drawer.classList.contains('hidden') || !els.prefPanel.classList.contains('hidden');

  if (e.key === 'Escape') {
    closePref();
    closeToc();
    e.preventDefault();
    return;
  }
  if (overlay) return; // 浮层打开时不劫持方向键（Esc 已处理）

  switch (e.key) {
    case ' ': {
      if (inBtn) return; // 让空格正常触发聚焦按钮
      e.preventDefault();
      page(1);
      break;
    }
    case 'PageDown': {
      if (!inBtn) {
        e.preventDefault();
        page(1);
      }
      break;
    }
    case 'PageUp': {
      if (!inBtn) {
        e.preventDefault();
        page(-1);
      }
      break;
    }
    case 'ArrowRight': if (!inBtn) goto(state.cur + 1); break;
    case 'ArrowLeft': if (!inBtn) goto(state.cur - 1); break;
    case 't':
    case 'T': (mqDesktop() ? toggleSide : toggleDrawerKey)(); break;
  }
}

function page(dir) {
  const el = els.scroll;
  el.scrollTop += dir * el.clientHeight * 0.9;
}

/** 键盘 T 在移动端开/关目录抽屉 */
function toggleDrawerKey() {
  if (els.drawer.classList.contains('hidden')) openToc();
  else closeToc();
}

/* ---------- 下载整本离线（PWA）/ 导出 txt ---------- */
async function downloadCurrent() {
  const book = state.book;
  if (!book) return;
  if (navigator.onLine === false) {
    showTip('当前离线，请联网后下载整本', 2000);
    return;
  }
  busy(0.02, `下载《${book.title}》整本…`);
  try {
    const { meta, texts, missing = 0 } = await fetchChaptersAll(book.id, (p) => busy(p, `拉取章节… ${Math.round(p * 100)}%`));
    // 若本地旧缓存章节数与新版不一致（重洗后），先整体清掉再写入，避免残留旧章
    const old = await offline.getBook(meta.id).catch(() => null);
    if (old && old.chapterCount !== meta.chapterCount) {
      await offline.delBook(meta.id);
    }
    await offline.saveBook(meta);
    await offline.putChapters(meta.id, meta.chapters.map((c, i) => ({ key: c.key, text: texts[i] })));
    state.cache.clear(); // 离线缓存已含全部章
    showTip(missing ? `已离线《${meta.title}》，但有 ${missing} 章缺失，请重试` : `已离线《${meta.title}》共 ${meta.chapters.length} 章，断网也能读`, 2600);
  } catch (e) {
    showTip('下载失败：' + (e.message || e), 2800);
  } finally {
    busyDone();
  }
}

async function exportCurrentText() {
  const book = state.book;
  if (!book) return;
  busy(0.02, `导出《${book.title}》…`);
  try {
    const title = await exportBookTxt(book.id, (p) => busy(p, `拉取章节… ${Math.round(p * 100)}%`));
    showTip('已导出《' + title + '》，可在下载中查看', 2000);
  } catch (e) {
    showTip('导出失败：' + (e.message || e), 2800);
  } finally {
    busyDone();
  }
}

let tipTimer = null;
function showTip(msg, ms = 2000) {
  els.tip.textContent = msg;
  els.tip.classList.add('show');
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => els.tip.classList.remove('show'), ms);
}
