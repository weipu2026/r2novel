/* review-fix135.test.mjs — #135 收口组
 *
 * M1：限额解析的 NaN 安全。旧写法 `Number(env.MAX_CHAPTER || DEFAULT)` 里的 `||` 只挡空字符串，
 *     挡不住非数字串 —— `Number('2MB')` = NaN，而 `len > NaN` 恒为 false →
 *     **上限直接消失且不报任何错**（人类手滑写 "2MB" 是很自然的动作，wrangler.toml 旁正好有
 *     「请求体上限 100MB」的注释）。正确写法 `Number(env.MAX_CHAPTER) || DEFAULT`：
 *     空串与非数字串都回落到 shared-const 的默认值。
 *
 * 收敛单点：normTitle / countWords 原先在两端各存一份逐字相同的实现（改一边静默漂移），
 *     现收敛到 shared-text.js —— 用**引用相等**证明两端确实是同一份，而不是各存一份。
 *
 * 同批的另两条门禁（CONST DUP / ENV PARSE / STORE API）是静态检查，其判别力由
 * `.ui-tests/probe-reverse-fix135-gates.py` 的故障注入验证（注入 → 必报该 tag → 还原）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { MAX_CHAPTER_BYTES, CHAPTER_MAX } from '../public/js/shared-const.js';
import { memStore, req, login, makeDraftBook, ENV } from './_harness.mjs';

test('M1：env.MAX_CHAPTER 写成非数字串时必须回落默认值（否则上限静默失效）', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 草稿态：单章 PUT 只放行 creating + 章表内 key（书发布后再 PUT 是 409）
  const { id, keys } = await makeDraftBook(store, cookie, '限额书', 1);
  const over = 'x'.repeat(MAX_CHAPTER_BYTES + 1024); // 略超 shared-const 的默认上限
  const put = (maxEnv) =>
    handleRequest(
      req(`/api/books/${id}/chapters/${keys[0]}`, { method: 'PUT', cookie, body: over }),
      { ...ENV, MAX_CHAPTER: maxEnv },
      store
    );

  // ① 判别力所在：非数字串 → 回落默认值 → 必须拦下。
  //    旧写法这里得 200（NaN 比较恒 false，上限形同不存在）
  assert.equal((await put('2MB')).status, 413, '非数字上限必须回落默认值并拦下超限章');
  // ② 正对照：合法数字串按值生效
  assert.equal((await put(String(MAX_CHAPTER_BYTES))).status, 413);
  // ③ 正对照：上限放宽到两倍 → 必须放行（证明是按值比较，而不是「把功能整个关掉」）
  assert.equal((await put(String(MAX_CHAPTER_BYTES * 2))).status, 200);
});

test('收敛：normTitle / countWords 在两端是同一份实现（引用相等）', async () => {
  const dom = await import('../public/js/dom.js');
  const cleaner = await import('../public/js/cleaner.js');
  const text = await import('../public/js/shared-text.js');
  assert.equal(dom.normTitle, text.normTitle, 'dom.js 必须再导出共享实现，而不是自己存一份');
  assert.equal(cleaner.countWords, text.countWords, 'cleaner.js 必须再导出共享实现，而不是自己存一份');
  // 语义护栏：null / undefined / 空白串均为 0，非空串按去掉空白后的字符数
  assert.equal(text.countWords(null), 0);
  assert.equal(text.countWords('   '), 0);
  assert.equal(text.countWords('你好 世界\n再来一段'), 8);
  assert.equal(text.normTitle('  我 的 书 名 '), '我的书名');
});

test('收敛：buildBookPayload 单点组装（截断到上限 + 字数 + cleanVer）', async () => {
  const { buildBookPayload } = await import('../public/js/upload/payload.js');
  const chapters = Array.from({ length: CHAPTER_MAX + 5 }, (_, i) => ({ title: '第' + (i + 1) + '章' }));
  const p = buildBookPayload({ title: 'T', author: 'A', tags: ['t'], note: 'n', chapters, words: 123 });
  assert.equal(p.chapters.length, CHAPTER_MAX, '章节名必须截断到单本上限');
  assert.equal(p.chapters[0], '第1章');
  assert.equal(p.chapters.at(-1), '第' + CHAPTER_MAX + '章');
  assert.equal(p.wordCount, 123);
  assert.equal(p.cleanVer, 1);
  assert.equal(p.title, 'T');
  // 空输入不得抛：缺 chapters / words 时给安全默认
  const q = buildBookPayload({ title: 'T2' });
  assert.deepEqual(q.chapters, []);
  assert.equal(q.wordCount, 0);
});
