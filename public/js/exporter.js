/* exporter.js — 导出整本清洗后 txt（书架 exportBook 使用）
 * 优先走服务端流式端点 GET /export/<id>.txt（1 个请求，逐章流式拼好）；
 * 服务端不可用时（离线 / 书未发布 404）回退浏览器逐章拉取拼接（IndexedDB 缓存离线可用）。 */
import { fetchChaptersAll } from './store.js';
import { downloadText, downloadBlob } from './ui.js';

/** 拉全章 → 拼 txt → 触发浏览器下载。返回书名。 */
export async function exportBookTxt(id, onProg) {
  try {
    const r = await fetch(`/export/${encodeURIComponent(id)}.txt`);
    if (r.ok) {
      // 流式端点的成果直接以 Blob 落盘：整本最大 50MB，读成字符串会再占一份内存
      const blob = await r.blob();
      const head = await blob.slice(0, 4096).text(); // 书名只从头 4KB 的第一行取
      const title = (head.split('\n', 1)[0] || '').trim() || 'book';
      downloadBlob(blob, title + '.txt');
      return title;
    }
    // 404（未发布/半成品）等情况 → 落到客户端兜底
  } catch {
    /* 离线/网络失败 → 客户端兜底 */
  }
  const { meta, texts, missing = 0 } = await fetchChaptersAll(id, onProg);
  const parts = [];
  parts.push(meta.title + (meta.author ? '　作者：' + meta.author : ''));
  parts.push('');
  meta.chapters.forEach((c, i) => {
    parts.push(c.title || '第' + (i + 1) + '章');
    parts.push('');
    parts.push(String(texts[i] || ''));
    parts.push('');
  });
  downloadText(parts.join('\n'), (meta.title || 'book') + '.txt');
  if (missing) console.warn(`导出《${meta.title}》有 ${missing} 章拉取失败（对应章节为空），可稍后重试`);
  return meta.title;
}
