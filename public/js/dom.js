/* dom.js — DOM 引用注册表 + 极简 DOM / 文本小工具（app 与 upload/ 各模块共用）
 *
 * 为什么单独成模块：`els` 不是 app.js 的私有状态，而是全站 DOM 引用的注册表
 * （app.init 里一次性填充）。上传域拆成 upload/ 之后同样要用它，以及 $ / $$ / esc /
 * normTitle 这几个到处都在用的小工具 —— 放这里让两端直接 import，避免把「查 DOM 的能力」
 * 靠参数层层传递。
 */
export const els = {};

export const $ = (sel, scope) => (scope || document).querySelector(sel);
export const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

/** HTML 转义（拼 innerHTML 时必须走它） */
export const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 书名归一化（判重用：忽略所有空白） */
export const normTitle = (s) => String(s || '').replace(/\s+/g, '');

/** 细线 SVG 图标（与阅读工具栏同款语言）：受控字面量，非用户输入，innerHTML 安全。
 *  放共享层的原因：**app.js（标签管理弹层）与 upload/（preview / editor）两端都在用** ——
 *  原先它是 app.js 的模块级常量，上传域拆出时随 pvIconBtnSvg 一起被搬走，导致 app.js 成了
 *  「引用了但没 import」的悬空引用（标签管理弹层一开就 ReferenceError）。 */
export const IC = {
  plus: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  pen: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3l4 4L8 20l-5 1 1-5z"/></svg>',
  arrow: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m0 0l-5-5m5 5l-5 5"/></svg>',
};
