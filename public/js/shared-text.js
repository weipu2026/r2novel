/* shared-text.js — 前后端共用的**纯文本判据**（零依赖、无 DOM、Worker 与浏览器都能 import）
 *
 * 为什么单列：`normTitle` / `countWords` 原先在两端**各存一份逐字相同的实现** ——
 *   router.js 侧 `wordsOf`（增量字数修正）/ `normTitle`（同名判重）
 *   public/js 侧 `cleaner.countWords`（报绝对字数）/ `dom.normTitle`
 * 逐字相同却各存一份 ⇒ 改一边就系统性漂移且**无人报错**（典型症状：「前端显示 1.2 万字、
 * 后端镜像说 1.1 万」这种对不上）。收敛到此处后两端 import 同一份，判据只有一个真相。
 */

/** 书名归一化（判重用：忽略所有空白） */
export const normTitle = (s) => String(s || '').replace(/\s+/g, '');

/** 字数 = 去掉全部空白后的字符数（中文按字计）。null / undefined / 空串均记 0。 */
export function countWords(text) {
  if (text == null || text === '') return 0;
  return String(text).replace(/\s/g, '').length;
}
