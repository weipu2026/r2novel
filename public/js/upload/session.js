/* upload/session.js — 上传会话状态的唯一事实源
 *
 * 这里只存 5 个值：当前会话对象 / uploading / importing / createdId / 在途原件请求。
 * 它们从前是 app.js 的模块级裸变量，被 900+ 行上传代码共享读写 —— 本项目历史上所有
 * 上传类竞态 BUG（换文件串台、同名弹窗挂死、批量并发）都长在这几个变量的交叉处。
 *
 * 收敛成 API 之后：
 *   1. 「现在能不能开始新一次会话」只有一个判据 isBusy()，三个入场口（选文件 / 拖入 / 粘贴）
 *      共用它 —— 新增入口不会再漏检查某个标志位；
 *   2. 上传链路只认自己手里的会话快照（begin 建立的那个对象），不认 current() 的当前值，
 *      从根上杜绝「标题取自 A、正文取自 B」；
 *   3. 谁在什么时候改了哪个标志，全库搜 API 名即可定位。
 *
 * 会话对象形状：{ title, bytes, preview, updating:null|{id,op,book}, keepRaw, cleanOpts }
 */

let _sess = null; // 当前上传会话（预览 / 确认 / 上传全程用它）
let _uploading = false; // 单文件 / 重洗上传在飞 → 冻结「换文件 / 粘贴 / 拖入」
let _importing = false; // 批量导入循环进行中 → 冻结「确认入库」按钮
let _createdId = null; // 本次「新建」出来的书 id：入库中途失败时用它把半成品移入回收站
let _rawReq = null; // 在途的原件上传请求（仅用于进度文案）

/** 当前会话对象（可变：调用方按需就地写 bytes / preview / updating）；无会话时 null */
export function current() {
  return _sess;
}

/** 建立（或替换）会话，返回该对象 */
export function begin(sess) {
  _sess = sess;
  return sess;
}

/** 丢弃会话（上传完成 / 批量结束 / 重新进入上传页） */
export function clear() {
  _sess = null;
}

/** 是否有上传任务在飞：三个入场口的统一判据（uploading ∪ importing） */
export function isBusy() {
  return _uploading || _importing;
}

export function isUploading() {
  return _uploading;
}

export function setUploading(v) {
  _uploading = !!v;
}

export function isImporting() {
  return _importing;
}

export function setImporting(v) {
  _importing = !!v;
}

/** 半成品书 id：入库中途失败时用它移入回收站，避免留下「书架看不见、回收站也清不掉」的孤儿 */
export function createdId() {
  return _createdId;
}

export function setCreatedId(id) {
  _createdId = id;
}

/** 在途原件请求 promise（仅 uploadBulkAndRaw 期间非空） */
export function rawReq() {
  return _rawReq;
}

export function setRawReq(p) {
  _rawReq = p;
}
