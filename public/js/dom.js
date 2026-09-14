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
