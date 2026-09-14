/* upload/rewash.js — 重洗：用原件重新清洗 → 整本替换
 *
 * 只做「确认 + 拉 meta 摘要」，真正的原件下载与清洗复用了上传页那条链路
 * （openUpload({book}) 内部会提示原件缺失并退回书架），因此这里不预探测原件，
 * 否则原件会被白拉一遍（重洗 = 原件下载两次）。
 */
import { api } from '../store.js';
import { host } from './ctx.js';
import { openUpload } from './files.js';

export async function rewashConfirm(b) {
  // v1.1：手动章节编辑后重洗会整体重建 → 先确认，避免静默覆盖人工改动
  const ok = await host().confirmModal('重新清洗会用原件重建整本书的分章与正文，此前手动修改的章节标题/正文会被覆盖。继续？');
  if (ok) rewash(b);
}

export async function rewash(b) {
  let full = b;
  try {
    const meta = await api.bookMeta(b.id);
    if (meta) full = { ...b, author: meta.author || b.author, note: meta.note || '' };
  } catch {
    /* meta 拉取失败也不阻断（用书架摘要） */
  }
  // 原件存在性与下载由 openUpload 内部处理（失败会提示并退回书架），
  // 不在这里预下载探测——那会把整个原件白拉一遍（重洗 = 原件下载两次）
  openUpload({ book: full });
}
