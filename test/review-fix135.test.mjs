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
import { memStore, req, login, call, makeDraftBook, makeReadyBook, ENV } from './_harness.mjs';

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

/* ---------------- 657f3f4 批量 patch 守卫的实证判定（2026-09-18 生产前审计） ----------------
 * 657f3f4 在 apiBatchBooks / apiTagsMerge 的 patch 循环前加了 `if (!idx.get(id))` 守卫，理由是
 * 「inShelf 守卫到 patch 之间隔着 2N 个子请求，期间书被并发软删 → patch 抛非冲突错 → 500」。
 * 实证：该窗口**不存在** —— openIndex 在 inShelf 之前已打开，两者之间只 await 各书 meta 写入
 * （不触碰 shardBooks），外部并发只能改盘面、改不了这份内存快照。守卫因此恒不触发（防御性保留）。
 * 真正吸收并发软删的是 save() 重放路径的 again.get 守卫（F2）。下面两条锁死这个结论：
 *   ① 并发软删发生在 meta 写窗口内 → 必须 200，且 updated 不把被删书算进去；
 *   ② 守卫的计数不得被 save() 的返回值覆盖（旧写法 `patchSkip = r.skipped.length` 会清零）。
 */
const ROOT_KEY = 'meta/idx/root.json';

/** 在「写某本书 meta」那一刻把该书从索引摘掉，模拟另一标签页刚软删（盘面变更，非快照变更） */
function injectSoftDeleteAt(base, victim, flag) {
  return {
    ...base,
    async putText(k, s) {
      if (!flag.fired && k === `meta/${victim}.json`) {
        flag.fired = true;
        const root = JSON.parse(await base.getText(ROOT_KEY));
        const si = root.map[victim];
        const raw = JSON.parse(await base.getText(`meta/idx/s${si}.json`));
        raw.books = raw.books.filter((b) => b.id !== victim);
        delete root.map[victim];
        await base.putText(`meta/idx/s${si}.json`, JSON.stringify(raw));
        await base.putText(ROOT_KEY, JSON.stringify(root));
      }
      return base.putText(k, s);
    },
  };
}

test('批量 patch 撞并发软删：必须 200，且 updated 不得把已被摘出索引的书算进去', async () => {
  const base = memStore();
  const cookie = await login(base);
  const bs = [];
  for (const t of ['甲书', '乙书', '丙书']) bs.push(await makeReadyBook(base, cookie, t, 1));
  const victim = bs[1].id;
  const flag = { fired: false };

  const r = await call(
    injectSoftDeleteAt(base, victim, flag),
    req('/api/books/batch', {
      method: 'POST',
      cookie,
      body: { ids: bs.map((b) => b.id), action: 'addTags', tags: ['探针'] },
    })
  );
  assert.equal(flag.fired, true, '并发软删注入必须真的触发过（否则这条用例没有判别力）');
  assert.equal(r.status, 200, '盘上已改却报 500 = 文案与盘面不符：' + JSON.stringify(r.data));
  assert.equal(r.data.updated, 2, '三本里一本被并发摘出 → 只许计两本：' + JSON.stringify(r.data));
  assert.equal(r.data.skipped, 1, '被摘掉的那本必须计入 skipped：' + JSON.stringify(r.data));
  // 盘面核对：三本 meta 都已带标签（写波在 patch 之前，与被删与否无关）
  for (const b of bs) {
    assert.deepEqual(JSON.parse(await base.getText(`meta/${b.id}.json`)).tags, ['探针']);
  }
  // 被并发软删的书不得被写回索引
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(await base.getText(ROOT_KEY)).map, victim), false);
});

test('批量 patch 的「书仍在架」守卫当前不可达（架构不变量：快照不随盘面变更）', async () => {
  // 这条锁的是**结构性事实**，不是死代码分支本身 —— 所以它是可判别的：
  // 判据 = 「并发软删发生在 meta 写窗口内时，idx 快照里那本书仍在」。
  //   若将来 openIndex 改成惰性取片（快照会随盘面变），下面的 updated 会从 2 变成 1 或报 500，
  //   本用例翻红 → 提示必须重新审视 657f3f4 那两处守卫的计数口径（届时 patchSkip 是否被覆盖
  //   才有意义）。当前实现用 `patchSkip += r.skipped.length`（累加）而非覆盖，正是为那种情况预备的。
  const base = memStore();
  const cookie = await login(base);
  const bs = [];
  for (const t of ['丁书', '戊书', '己书']) bs.push(await makeReadyBook(base, cookie, t, 1));
  const victim = bs[1].id;
  const flag = { fired: false };

  const r = await call(
    injectSoftDeleteAt(base, victim, flag),
    req('/api/books/batch', {
      method: 'POST',
      cookie,
      body: { ids: bs.map((b) => b.id), action: 'addTags', tags: ['计数'] },
    })
  );
  assert.equal(flag.fired, true, '并发软删注入必须真的触发过');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 快照仍含被并发摘掉的那本 → 三本都走了 patch 路径 → 计数由 save 重放路径（F2）修正为 2
  assert.equal(r.data.updated, 2, 'updated 必须由 F2 重放路径修正，而非新增守卫：' + JSON.stringify(r.data));
  assert.equal(r.data.skipped, 1, JSON.stringify(r.data));
  for (const b of bs) {
    assert.deepEqual(JSON.parse(await base.getText(`meta/${b.id}.json`)).tags, ['计数']);
  }
  // 被并发软删的书不得被写回索引（F2 守卫已把它从 opLog 里摘掉）
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(await base.getText(ROOT_KEY)).map, victim), false);
});
