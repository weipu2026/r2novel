/* upload/index.js — 上传域的对外唯一入口
 *
 * app.js 只 import 这一个文件：
 *   init(caps) —— 注入宿主能力（切视图 / 刷书架 / 弹层 / 标签 chips）并绑定上传页自己的
 *                 DOM 事件。上传页有哪些控件、点了谁触发什么，从此是 upload/ 内部的事。
 *   openUpload / rewashConfirm / openChapterEditor —— 书架侧要用的三个入口。
 *
 * 依赖方向：app.js → upload/（单向）。upload/ 各模块之间也只向下依赖 dom / store / ui / cleaner。
 */
import { els } from '../dom.js';
import { toast } from '../ui.js';
import { provide } from './ctx.js';
import { handleFiles, onFileChosen, onPasteText } from './files.js';
import { runPreview } from './preview.js';
import { openEncPick } from './prepare.js';
import { onConfirm } from './upload.js';
import * as upSession from './session.js';

export { openUpload } from './files.js';
export { rewashConfirm } from './rewash.js';
export { openChapterEditor } from './editor.js';

/** app.init 调用一次：注入宿主能力 + 绑定上传页事件。重复调用只刷新宿主能力，绝不重复绑事件 */
let _bound = false;
export function init(caps) {
  provide(caps);
  if (_bound) return; // 幂等守卫：document 级 paste 等全局监听尤其不能叠绑

  // 上传事件
  els.upCancel.addEventListener('click', () => caps.showView('shelf'));
  els.upFile.addEventListener('change', onFileChosen);
  els.upConfirm.addEventListener('click', onConfirm);
  els.upClean.addEventListener('change', () => {
    els.upCleanOpts.classList.toggle('off', !els.upClean.checked);
    runPreview();
  });
  els.upCleanOpts.addEventListener('change', () => runPreview());
  els.upNoSplit.addEventListener('change', () => runPreview());
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
    if (upSession.isBusy()) return; // 上传进行中：一律不换会话
    if (!els.upPrev.classList.contains('hidden')) return; // 预览已出则忽略（避免误触覆盖已选文件）
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    onPasteText(e);
  });
}
