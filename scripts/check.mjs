/* check.mjs — 跨平台门禁，`npm run check` 一次跑完两项：
 *   ① 语法门禁：node --check 递归遍历全仓库（跳过 node_modules / .git / .ui-tests / shots / .wrangler / data-*）
 *   ② 模块一致性：只查浏览器侧 public/**\/*.js —— node --check 只看语法，抓不到下面三类「运行时才炸」的缺陷，
 *      而且它们常常被 try/catch 吞成静默失败（页面零报错、功能静默失效），必须靠静态检查提前拦：
 *        a) 命名导入 / 再导出 的名字在目标模块里根本不存在（如 upload/rewash.js 漏 export）
 *        b) 全大写常量被引用却既没 import 也没声明（如 files.js 漏 import CHAPTER_MAX）
 *        c) upload/ 里绕过 ctx.host() 直接调用宿主能力（app.js 顶层函数 / init 注入的那批）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ══════════════ ① 语法门禁 ══════════════ */

const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    // .ui-tests 是 gitignored 的本地浏览器测试目录，一次性诊断脚本不参与语法门禁
    if (name === 'node_modules' || name === '.git' || name === '.ui-tests' || name === 'shots' || name === '.wrangler') continue;
    if (/^data(-|$)/.test(name)) continue; // 本地临时数据目录（data-dev / data-uireg / data-regX …）
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

/* ══════════════ ② public 模块一致性 ══════════════ */

const PUBLIC = path.join(ROOT, 'public');
/** init() 注入给 upload/ 的宿主能力（改 app.js 的注入名单时同步改这里） */
const HOST_CAPS = ['showView', 'loadShelf', 'getBooks', 'openModal', 'closeModal', 'confirmModal', 'syncPresetChips', 'refreshPresetTags', 'parseTagInput'];

const publicFiles = [];
(function walkPublic(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkPublic(p);
    else if (e.name.endsWith('.js')) publicFiles.push(path.resolve(p));
  }
})(PUBLIC);

/** 去掉注释与字符串字面量（模板串保留 ${...} 内的表达式），避免把文案当成标识符 */
function stripCode(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1 ');
  s = s.replace(/`(?:[^`\\]|\\.)*`/g, (m) => {
    const exprs = [...m.matchAll(/\$\{([\s\S]*?)\}/g)].map((x) => x[1]).join('; ');
    return ' ' + exprs + ' ';
  });
  s = s.replace(/'(?:[^'\\\n]|\\.)*'/g, ' ');
  s = s.replace(/"(?:[^"\\\n]|\\.)*"/g, ' ');
  return s;
}

function exportsOf(src) {
  const names = new Set();
  let hasDefault = false;
  for (const m of src.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      const n = t.split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  for (const m of src.matchAll(/^[ \t]*export\s+default\b/gm)) hasDefault = true;
  const starReexport = /^[ \t]*export\s*\*\s*from/m.test(src);
  return { names, hasDefault, starReexport };
}

const cache = new Map();
function getExports(abs) {
  if (!cache.has(abs)) cache.set(abs, fs.existsSync(abs) ? exportsOf(fs.readFileSync(abs, 'utf8')) : null);
  return cache.get(abs);
}

/** app.js 顶层「函数」名（函数声明 + 箭头函数常量）：这些是上传域只能经 host() 访问的宿主能力 */
const appTopFns = (() => {
  const p = path.join(PUBLIC, 'js', 'app.js');
  if (!fs.existsSync(p)) return [];
  const code = stripCode(fs.readFileSync(p, 'utf8'));
  const out = new Set();
  for (const m of code.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of code.matchAll(/(?:^|\n)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) out.add(m[1]);
  return [...out];
})();

let problems = 0;
const say = (tag, msg) => { console.log(`${tag.padEnd(14)} ${msg}`); problems++; };

for (const f of publicFiles) {
  const raw = fs.readFileSync(f, 'utf8');
  const rel = path.relative(PUBLIC, f);
  const code = stripCode(raw);

  // ---- 收集本模块的导入绑定 ----
  const imported = new Set();
  const reImport = /^[ \t]*import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  for (const m of raw.matchAll(reImport)) {
    const clause = m[1].trim();
    const spec = m[2];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) for (const part of braced[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      imported.add(t.split(/\s+as\s+/).pop().trim());
    }
    const side = clause.replace(/\{[^}]*\}/, '').replace(/^\*/, '').trim();
    if (side) {
      const nm = side.split(/\s+as\s+/).pop().replace(/[,\s]/g, '');
      if (nm) imported.add(nm);
    }
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(f), spec);
      const exp = getExports(target);
      if (!exp) say('MISSING FILE', `${rel} -> ${spec}`);
      else if (!exp.starReexport) {
        if (/^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause) && !exp.hasDefault) say('NO DEFAULT', `${rel} -> ${spec}`);
        if (braced) for (const part of braced[1].split(',')) {
          const t = part.trim(); if (!t) continue;
          const name = t.split(/\s+as\s+/)[0].trim();
          if (!exp.names.has(name)) say('NO EXPORT', `${rel} 引入 { ${name} } 但 ${path.relative(PUBLIC, target)} 未导出`);
        }
      }
    }
  }
  // 再导出链
  for (const m of raw.matchAll(/^[ \t]*export\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec);
    const exp = getExports(target);
    if (!exp) { say('MISSING FILE', `${rel} -> ${spec}`); continue; }
    if (exp.starReexport) continue;
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      const [orig, alias] = t.split(/\s+as\s+/).map((x) => x.trim());
      if (!exp.names.has(orig)) say('NO RE-EXPORT', `${rel} 再导出 { ${orig}${alias ? ' as ' + alias : ''} } 但 ${path.relative(PUBLIC, target)} 未导出`);
      imported.add(alias || orig);
    }
  }
  // 本模块任何位置声明的标识符（含函数内、含 `const A = 1, B = 2` 多声明符）
  const declared = new Set();
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([^;]{0,400})/g)) {
    let depth = 0, cur = '';
    const parts = [];
    for (const ch of m[1]) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    for (const p of parts) {
      const id = p.trim().match(/^\{?\s*([A-Za-z_$][\w$]*)/);
      if (id) declared.add(id[1]);
    }
  }
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])class\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])import\s*\{([^}]*)\}/g)) for (const p of m[1].split(',')) { const t = p.trim(); if (t) declared.add(t.split(/\s+as\s+/).pop().trim()); }

  // ---- a/b) 全大写常量被引用却既没导入也没声明（排除成员访问 a.B 与 JS 内建全局）----
  const GLOBAL_OK = new Set(['JSON', 'URLSearchParams', 'NaN', 'Infinity']);
  const usedCaps = new Set([...code.matchAll(/(?<![\w$.])([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]));
  for (const n of usedCaps) {
    if (!imported.has(n) && !declared.has(n) && !GLOBAL_OK.has(n)) say('UNDEF CONST', `${rel} 引用 ${n} 但既未 import 也未声明（运行时 ReferenceError）`);
  }

  // ---- c) upload/ 里调用宿主能力必须走 host().NAME( ----
  if (rel.includes(`upload${path.sep}`)) {
    for (const cap of HOST_CAPS) {
      const re = new RegExp(`(?<![\\w$.])${cap}\\s*\\(`, 'g');
      if (re.test(code)) say('HOST CALL', `${rel} 直接调用 ${cap}( )，应改成 host().${cap}( )`);
    }
    for (const n of appTopFns) {
      if (imported.has(n) || declared.has(n)) continue;
      const re = new RegExp(`(?<![\\w$.])${n}\\s*\\(`, 'g');
      if (re.test(code)) say('HOST CALL', `${rel} 直接调用 app.js 的 ${n}( )，应改成 host().${n}( )`);
    }
  }
}

if (problems) {
  console.log(`\nMODULE_FAIL · scanned=${publicFiles.length} problems=${problems}`);
  process.exit(1);
}
console.log(`MODULE_OK · ${publicFiles.length} files`);
