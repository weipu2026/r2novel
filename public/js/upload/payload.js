/* payload.js — 建书 payload 的**单一组装点**（单文件上传 与 批量导入 共用）
 *
 * 原先 `upload.js` 的 `collectPayload()` 与 `files.js` 的 importBatch 各写一份同构字面量：
 * chapters 截断 / wordCount / cleanVer 三条表达式**逐字重复**，标题与标签的来源却已悄然不同
 * （一个读 DOM 输入框、一个用文件解析出的值）—— 加字段要改两处，**漏一处是静默的**
 * （服务端收不到新字段，且不报错）。此处只保留「从字段组装 payload」这一步，
 * 「字段从哪来」仍由各调用点决定（那才是真正的语义差异）。
 */
import { CHAPTER_MAX } from '../shared-const.js';

/** @param {{title:string, author:string, tags:string[], note:string, chapters:Array, words:number}} f
 *  chapters 为预览章节数组（取每章 title）；words 取预览实时维护的字数（唯一事实源） */
export function buildBookPayload({ title, author, tags, note, chapters, words }) {
  return {
    title,
    author,
    tags,
    note,
    chapters: (chapters || []).slice(0, CHAPTER_MAX).map((c) => c.title),
    wordCount: words || 0,
    cleanVer: 1,
  };
}
