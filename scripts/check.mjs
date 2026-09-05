/* check.mjs — 跨平台语法检查：node --check 遍历 src/public/scripts/test */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'data-dev' || name === '.git') continue;
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
