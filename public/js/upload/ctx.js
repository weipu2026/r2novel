/* upload/ctx.js — 宿主能力注入点（upload/ 与 app.js 之间的单向依赖）
 *
 * upload/ 各模块不 import app.js，否则与 app.js 形成循环依赖；改由 app.init 一次性把
 * 「宿主能力」注入这里，各模块通过 host() 取用。宿主能力 = app.js 域的功能（切视图、
 * 刷书架、弹层、标签 chips 等）；DOM 引用与纯小工具见 ../dom.js。
 *
 * 未注入就调用属编程错误 → fail loud，不静默用空对象兜底（否则错误点会被推到很远的地方）。
 */
let _host = null;

/** app.init 调用一次（在 `els` 填充完毕之后即可安全调用） */
export function provide(host) {
  _host = host;
  return host;
}

/** 取宿主能力 */
export function host() {
  if (!_host) throw new Error('upload 模块未初始化：app.init 需先调用 uploadCtx.provide(...)');
  return _host;
}
