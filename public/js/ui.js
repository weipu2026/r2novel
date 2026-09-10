/* ui.js — 全站共用 UI 小件：忙碌层 + 文本下载（app / reader 共用，消除双份实现） */

const ui = { bar: null, text: null, mask: null };

/** 由 app.init 绑定一次忙碌层三元素 */
export function bindBusy({ bar, text, mask }) {
  ui.bar = bar;
  ui.text = text;
  ui.mask = mask;
}

/** pct：0~1 的比例；传 null/非有限值表示「进度不可知」——只更新文案，不动进度条。
 * 夹到 0~1 并防 NaN（曾经把文案串当 pct 传 → width:'NaN%' 进度条失效）。 */
export function busy(pct, text) {
  if (ui.bar && Number.isFinite(pct)) {
    const p = Math.min(1, Math.max(0, Number(pct)));
    ui.bar.style.width = Math.round(p * 100) + '%';
  }
  if (ui.text) ui.text.textContent = text || '处理中…';
  if (ui.mask) ui.mask.classList.remove('hidden');
}

export function busyDone() {
  if (ui.mask) ui.mask.classList.add('hidden');
  // 复位进度条：否则下次打开忙碌层会先显示上一次的残留宽度，直到首次 busy 更新
  if (ui.bar) ui.bar.style.width = '0%';
}

/** 触发浏览器下载一个 Blob（整本导出走它，避免把大文本整份读进 JS 字符串） */
export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 800);
}

/** 触发浏览器下载一段文本 */
export function downloadText(text, filename) {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}
