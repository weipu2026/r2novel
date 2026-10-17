/* upload/prepare.js — 选文件之后的本地准备（读字节 / 人工指定编码 / 重洗提示）
 *
 * prepareFile 读入字节建会话 → runPreview 清洗分章。两者是「同一个动作的下半段」，
 * 分文件只为把「取字节」与「渲染预览」两块复杂度隔开。
 */
import { els } from '../dom.js';
import * as upSession from './session.js';
import { runPreview, invalidateAutoEnc } from './preview.js';

/* #146 P2-3：「上一次由文件名自动填进标题框的值」。用来区分「用户手输的书名」与「上一本书自动
 * 带出的文件名」—— 旧实现只看标题框是否为空，换第二本书时标题仍是第一本的文件名 → 「标题A/正文B」。
 * 用户一旦手改，标题值就不再等于它 → 之后的换文件一律不动用户的书名。 */
let lastAutoTitle = null;
/** 进上传页时清空（标题框已被 form.reset 清空，记忆必须同步清） */
export function resetAutoTitle() {
  lastAutoTitle = null;
}
/** 当前值是不是「我们自动填的」（空串不算：空标题必须回填） */
export function isAutoTitle(v) {
  return !!lastAutoTitle && v === lastAutoTitle;
}
/** 自动填书名并记下这次填的值 */
export function setAutoTitle(v) {
  els.upTitle.value = v;
  lastAutoTitle = v;
}

export function hint(text) {
  els.upUpdateHint.textContent = text;
  els.upUpdateHint.classList.remove('hidden');
}

export async function prepareFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const auto = file.name.replace(/\.(txt|text)$/i, '').trim();
  // #146 P2-3：标题框空**或仍是上一本自动带出的文件名**时才回填；用户手输的书名一律不动
  if (!els.upTitle.value.trim() || isAutoTitle(els.upTitle.value.trim())) setAutoTitle(auto);
  upSession.begin({ title: els.upTitle.value.trim(), bytes: buf, updating: null, keepRaw: true });
  els.upUpdateHint.classList.add('hidden');
  runPreview();
}

/** 手动指定编码：展开下拉并填入常见编码（自动检测异常时人工纠正用） */
export function openEncPick() {
  invalidateAutoEnc(); // 用户已表达手选意图：即便之后选回与自动检测相同的编码，也按手动口径走
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
