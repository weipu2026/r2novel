/* upload/prepare.js — 选文件之后的本地准备（读字节 / 人工指定编码 / 重洗提示）
 *
 * prepareFile 读入字节建会话 → runPreview 清洗分章。两者是「同一个动作的下半段」，
 * 分文件只为把「取字节」与「渲染预览」两块复杂度隔开。
 */
import { els } from '../dom.js';
import * as upSession from './session.js';
import { runPreview, invalidateAutoEnc } from './preview.js';

export function hint(text) {
  els.upUpdateHint.textContent = text;
  els.upUpdateHint.classList.remove('hidden');
}

export async function prepareFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!els.upTitle.value) {
    els.upTitle.value = file.name.replace(/\.(txt|text)$/i, '').trim();
  }
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
