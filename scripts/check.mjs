/* check.mjs — 跨平台语法检查：node --check 递归遍历全仓库（跳过 node_modules/data-dev/.git/.ui-tests） */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    // .ui-tests 是 gitignored 的本地浏览器测试目录，一次性诊断脚本不参与语法门禁
    if (name === 'node_modules' || name === 'data-dev' || name === '.git' || name === '.ui-tests') continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
}
walk(ROOT);
for (const f of files.sort()) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
}
console.log(`SYNTAX_OK · ${files.length} files`);
