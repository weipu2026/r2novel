/* _dom-stub.mjs — 前端 UI 模块测试用的极简 DOM 桩（零依赖，与 _harness.mjs 并列）
 *
 * 为什么需要它：upload/ 下的 UI 模块（editor / session / rewash）在 test/ 里零引用，
 * 而它们的状态机缺陷（按钮禁用态、重绘丢状态、迟到 DOM 写）藏在运行时状态迁移里，
 * 五道静态门禁与既有服务端测试都碰不到。仓库零依赖（不引 jsdom），
 * 就在 Node 里搭一层「够真的」DOM，用真实代码路径驱动被测模块。
 *
 * 语义上刻意贴近浏览器 —— 下面几条**必须**与浏览器一致，否则结论不可信：
 *   · querySelectorAll 先按逗号分组，每组再做「后代链」匹配。
 *     早期版本先按空白切分，把 `input.ce-title, .ce-row button, ...` 切碎成一条都不命中，
 *     于是 editor.js 的 ceApplyLock 在桩里一个元素都没接管，错判成「按钮状态正常」（假阴性）。
 *   · innerHTML 赋值解析出真实元素树（而非只存字符串），使弹层骨架与 app.js 的
 *     openModal(html) 行为一致；模板改了 id/class 会跟着失配，不会静默通过。
 *   · 被禁用的控件不派发 click/input/change（浏览器语义）—— 「按钮没被禁用住」这类缺陷
 *     能靠行为级断言（服务端调用次数）抓住，前提就是这条。
 *   · 事件派发同步返回、不等 handler 的 promise（浏览器语义），测试才好「在请求在飞时介入」。
 *
 * 用法：installDom() → 建 modalBox → 每步用 setModalHTML 模拟 openModal → flush() 推进异步。
 */

export const NOP = () => {};

export class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) { const v = on === undefined ? !this.s.has(c) : !!on; if (v) this.s.add(c); else this.s.delete(c); return v; }
}

export class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.style = { setProperty: NOP, removeProperty: NOP };
    this.attributes = {};
    this._listeners = {};
    this._handlerErrors = [];
    this._id = '';
    this._disabled = false;
    this.value = '';
    this.textContent = '';
    this.type = '';
    this.title = '';
    this.placeholder = '';
    this.rows = 0;
    this._html = '';
  }
  get className() { return Array.from(this.classList.s).join(' '); }
  set className(v) { this.classList.s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get disabled() { return this._disabled; }
  set disabled(v) { this._disabled = !!v; }
  get id() { return this._id; }
  set id(v) { this._id = String(v); }
  set innerHTML(v) {
    for (const c of this.childNodes) c.parentNode = null; // 真实 DOM：被替换的子树与父节点解链
    this.childNodes = [];
    this._html = String(v);
  }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { if (k === 'id') this._id = String(v); this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this); }
  addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); }

  /** 浏览器语义：被禁用的控件不派发这些事件；派发同步返回（不等 async handler 的 promise） */
  dispatch(t, ev = {}) {
    if (this._disabled && SUPPRESSED_WHEN_DISABLED.has(t)) return false;
    const e = { type: t, target: this, currentTarget: this, preventDefault: NOP, stopPropagation: NOP, ...ev };
    for (const f of this._listeners[t] || []) {
      const r = f(e);
      if (r && typeof r.then === 'function') r.catch((err) => this._handlerErrors.push(err)); // 不让未处理拒绝污染测试
    }
    return true;
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0]; }

  querySelectorAll(sel) {
    const out = new Set();
    for (const group of String(sel).split(',').map((s) => s.trim()).filter(Boolean)) {
      let cur = [this];
      for (const part of group.split(/\s+/).filter(Boolean)) {
        const next = [];
        for (const base of cur) collect(base, part, next);
        cur = Array.from(new Set(next));
        if (!cur.length) break;
      }
      cur.forEach((n) => out.add(n));
    }
    return Array.from(out);
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return matchesSimple(this, sel); }
  focus() {}
  scrollIntoView() {}
}

const SUPPRESSED_WHEN_DISABLED = new Set(['click', 'mousedown', 'mouseup', 'dblclick', 'input', 'change', 'submit', 'keydown', 'keyup']);

function collect(root, sel, out) {
  for (const c of root.children) {
    if (matchesSimple(c, sel)) out.push(c);
    collect(c, sel, out);
  }
}

/** 单条简单选择器（tag / #id / .class / tag.class，可组合）——供 matches 与 collect 共用
 *  ⚠️ 标签名要吃「字母开头 + 数字」（h3 / h1 / svg 的 hN），早期写成 `[a-zA-Z]*` 就漏了 h3，
 *  于是 `querySelector('h3')` 恒为 null —— 又一个只会在特定断言上现形的桩失真。 */
export function matchesSimple(el, selRaw) {
  for (const sel of String(selRaw).split(',')) {
    const sel2 = sel.trim();
    if (!sel2) continue;
    const m = /^([a-zA-Z][\w]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/.exec(sel2);
    if (!m) continue;
    const [, tag, id, classes] = m;
    if (tag && el.tagName !== tag.toUpperCase()) continue;
    if (id && el._id !== id) continue;
    const cls = classes ? classes.split('.').filter(Boolean) : [];
    if (cls.some((c) => !el.classList.contains(c))) continue;
    return true;
  }
  return false;
}

/* ── HTML 解析（够用即可：标签 / 属性 / 文本，支持 void 元素与自闭合） ── */

const VOID_TAGS = new Set(['INPUT', 'BR', 'IMG', 'HR', 'META', 'LINK', 'SOURCE']);
const TAG_RE = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>|([^<]+)/g;
const ATTR_RE = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function applyAttrs(el, s) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(s))) {
    const k = m[1];
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    if (k === 'id') el.id = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
}

export function parseHTML(html) {
  const roots = [];
  const stack = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(String(html)))) {
    if (m[3] !== undefined) { // 文本节点
      const t = m[3];
      const p = stack[stack.length - 1];
      if (p && t.trim()) p.textContent += t;
      continue;
    }
    const tag = m[1].toUpperCase();
    if (m[0][1] === '/') { // 闭合标签：弹到该标签的上一层
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tagName === tag) { stack.length = i; break; }
      continue;
    }
    const el = new El(tag);
    applyAttrs(el, m[2] || '');
    const parent = stack[stack.length - 1];
    if (parent) parent.appendChild(el); else roots.push(el);
    if (!VOID_TAGS.has(tag) && !m[0].endsWith('/>')) stack.push(el);
  }
  return roots;
}

/** 模拟 app.js 的 openModal(html)：整块替换内容（真实实现是 modalBox.innerHTML = html） */
export function setModalHTML(box, html) {
  for (const c of box.childNodes) c.parentNode = null;
  box.childNodes = [];
  box._html = String(html);
  for (const el of parseHTML(html)) box.appendChild(el);
  return box;
}

/** 模拟 app.js 的 closeModal()：清空内容 */
export function clearModal(box) {
  for (const c of box.childNodes) c.parentNode = null;
  box.childNodes = [];
  box._html = '';
  return box;
}

/* ── 全局环境 ── */

export function installDom() {
  globalThis.document = {
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: NOP,
    body: new El('body'),
  };
  globalThis.window = { addEventListener: NOP };
  globalThis.matchMedia = () => ({ matches: false, addEventListener: NOP });
  // toast / 去抖等会挂 setTimeout：包装成 unref 版，避免测试进程被挂住不退出
  if (!globalThis.__stPatched) {
    globalThis.__stPatched = true;
    const realST = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => {
      const h = realST(fn, ms, ...a);
      if (h && typeof h.unref === 'function') h.unref();
      return h;
    };
  }
}

/** 建一个空的 #modalBox（每步用 setModalHTML 注入弹层骨架） */
export function makeModalBox() {
  const box = new El('div');
  box.id = 'modalBox';
  return box;
}

/* ── 测试小工具 ── */

/** 推进异步：让 await 链上的续体跑完 */
export async function flush(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** 手动可控的 promise（用于「请求在飞时」介入） */
export function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const btnsOf = (root) => root.querySelectorAll('button');
export const btnBy = (root, pred) => btnsOf(root).find(pred) || null;
export const rowsOf = (box) => box.querySelectorAll('.ce-row');

/** 给元素的 disabled 挂写日志（返回日志数组）；须在目标元素当前值就绪后调用 */
export function watchDisabled(el) {
  const log = [];
  let d = el._disabled;
  Object.defineProperty(el, 'disabled', {
    get() { return d; },
    set(v) {
      v = !!v;
      if (v === d) return;
      log.push({ from: d, to: v });
      d = v;
    },
  });
  return log;
}
