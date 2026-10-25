/**
 * srcAll() —— 把 src/ 下全部模块按「拆分前 router.js 的声明顺序」拼成一份源码文本。
 *
 * 为什么需要它：#149 P2 把 src/router.js（3780 行）拆成 src/{core,store,api}/*.js。
 * 一批哨兵测试（review-fix143b/144/145/145b/146）是用 `indexOf('async function X(')`
 * 到「下一处 async function」切片来钉不变量的 —— 代码搬家后 router.js 里已经找不到它们。
 * 这里按原顺序拼接，切片语义与拆分前逐字一致（拼接顺序错会改变「下一处 async function」是谁，
 * 断言就会悄悄失准），所以 ORDER 改动必须同步核对声明顺序。
 *
 * 自检：src/ 里如果出现 ORDER 未列出的 .js，直接抛错 —— 否则新模块会从哨兵覆盖面里静默漏掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// 与拆分前 router.js 的行序一一对应（见 .ui-tests/split-router.mjs 的 MODULES 区间表）
const ORDER = [
  'core/const.js',
  'core/base.js',
  'core/brute.js',
  'core/auth.js',
  'store/shard.js',
  'store/open.js',
  'store/book.js',
  'api/auth.js',
  'store/gc.js',
  'store/entry.js',
  'api/books.js',
  'api/chapters.js',
  'api/progress.js',
  'api/batch.js',
  'api/trash.js',
  'api/diag.js',
  'api/opds.js',
  'router.js',
  'worker.js', // Worker 入口（原本就不属于 router.js，排在最后，不影响任何函数切片）
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(path.relative(SRC, p).split(path.sep).join('/'));
  }
  return out;
}

let checked = false;
export function srcAll() {
  if (!checked) {
    const found = walk(SRC).sort();
    const listed = [...ORDER].sort();
    if (found.join(',') !== listed.join(',')) {
      throw new Error(
        `src/_src-all.mjs 的 ORDER 与 src/ 实际文件不一致\n  漏列: ${found.filter((f) => !listed.includes(f)).join(', ') || '(无)'}\n  多列: ${listed.filter((f) => !found.includes(f)).join(', ') || '(无)'}`
      );
    }
    checked = true;
  }
  return ORDER.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n')).join('\n');
}
