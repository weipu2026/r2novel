/* check.mjs — 跨平台门禁，`npm run check` 一次跑完两项：
 *   ① 语法门禁：node --check 递归遍历全仓库（跳过 node_modules / .git / .ui-tests / shots / .wrangler / data-*）
 *   ② 模块一致性：只查浏览器侧 public/**\/*.js —— node --check 只看语法，抓不到下面三类「运行时才炸」的缺陷，
 *      而且它们常常被 try/catch 吞成静默失败（页面零报错、功能静默失效），必须靠静态检查提前拦：
 *        a) 命名导入 / 再导出 的名字在目标模块里根本不存在（如 upload/rewash.js 漏 export）；
 *           副作用导入 `import './x.js'` 与 `export * from './y.js'` 无法校验名字，只校验**路径存在性**
 *        b) 全大写常量被引用却既没 import 也没声明（如 files.js 漏 import CHAPTER_MAX）。
 *           判据 = token 总长 ≥4，**或**该名字在 public/ 里确实被 export 过（覆盖 IC 这类短名常量）
 *        c) upload/ 里绕过 ctx.host() 直接调用宿主能力（app.js 顶层函数 / init 注入的那批）
 *      已知边界（有意不处理，改动前先想清楚）：`export { default as X } from` 会被 exp.names 判成
 *      未导出而误报（exportsOf 只记 hasDefault 布尔）；`host()['showName']` 括号式访问绕过规则 c。
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
/** init() 注入给 upload/ 的宿主能力 —— 从 app.js 的 `initUpload({ ... })` 实参里**自动抽取**，
 *  不再手写镜像（手写的那份在 app.js 改了注入名单后极易忘记同步）。识别 ES6 简写与 `k: v` 两种写法。 */
const HOST_CAPS = (() => {
  const p = path.join(PUBLIC, 'js', 'app.js');
  if (!fs.existsSync(p)) return [];
  const code = stripCode(fs.readFileSync(p, 'utf8')); // 函数声明会提升，可先用后定义
  const i = code.indexOf('initUpload(');
  if (i < 0) return [];
  const open = code.indexOf('(', i);
  let depth = 0, close = -1;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')') { depth--; if (!depth) { close = k; break; } }
  }
  if (close < 0) return [];
  const out = new Set();
  for (const m of code.slice(open + 1, close).matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?=[:,}]|$)/g)) out.add(m[1]);
  return [...out];
})();

const publicFiles = [];
(function walkPublic(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkPublic(p);
    else if (e.name.endsWith('.js')) publicFiles.push(path.resolve(p));
  }
})(PUBLIC);

/** public/ 下所有被 export 的全大写常量名 —— 规则 b 靠它覆盖「短名常量漏 import」（如 2 字符的 IC） */
const exportedCaps = (() => {
  const out = new Set();
  for (const f of publicFiles) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+([A-Z][A-Z0-9_]*)/gm)) out.add(m[1]);
    for (const m of s.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(',')) {
        const t = part.trim(); if (!t) continue;
        const n = t.split(/\s+as\s+/).pop().trim();
        if (/^[A-Z][A-Z0-9_]*$/.test(n)) out.add(n);
      }
    }
  }
  return out;
})();

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
  // 副作用导入（无绑定）与 `export * from`：名字无从校验，但**路径存在性必须校验**——
  // 路径写错时整张模块图在运行时才炸，node --check 完全看不到
  for (const m of raw.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    if (!getExports(path.resolve(path.dirname(f), spec))) say('MISSING FILE', `${rel} -> ${spec}（副作用导入）`);
  }
  for (const m of raw.matchAll(/^[ \t]*export\s*\*\s*from\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    if (!getExports(path.resolve(path.dirname(f), spec))) say('MISSING FILE', `${rel} -> ${spec}（export * 再导出）`);
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
  // 判据 = token 总长 ≥4 **或** 该名字在 public/ 里确实被 export 过。后者让 IC 这类短名常量漏 import
  // 也能被抓到，同时不会把 GET / ID / OK 之类「不是常量」的大写词误报成未定义。
  const GLOBAL_OK = new Set(['JSON', 'URLSearchParams', 'NaN', 'Infinity']);
  const usedCaps = new Set([...code.matchAll(/(?<![\w$.])([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]));
  for (const n of usedCaps) {
    if (imported.has(n) || declared.has(n) || GLOBAL_OK.has(n)) continue;
    if (n.length >= 4 || exportedCaps.has(n)) say('UNDEF CONST', `${rel} 引用 ${n} 但既未 import 也未声明（运行时 ReferenceError）`);
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

/* ══════════════ ③ SW SHELL 清单一致性 ══════════════
 * SHELL 是离线壳的预缓存清单，历来靠手写维护——「新增模块忘了加进 SHELL」与
 * 「漏搬常量」同族（手写镜像必漂移），且离线用户只会表现为断网后打不开，平时毫无症状。
 * 这里不做手写镜像，而是**双向比对**：
 *   期望集合 = public/ 下全部可预缓存静态资源（js / css / manifest / icons / index.html；
 *             排除 _headers —— CF 配置文件非页面资源；排除 sw.js —— SW 不预缓存自身）。
 *   SW_MISSING：期望集合里有、SHELL 没有 → 离线壳缺文件（新模块上线离线不可用）
 *   SW_UNKNOWN：SHELL 里有、public/ 没有 → 清单指向已删除/改名文件（404 白缓存）
 * index.html 特例：'/' 与 '/index.html' 都算覆盖（现清单两者并存，不必二选一）。
 */
{
  const swPath = path.join(PUBLIC, 'sw.js');
  const m = fs.readFileSync(swPath, 'utf8').match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  if (!m) {
    say('SW SHELL', 'sw.js 里找不到 SHELL 数组定义');
  } else {
    const shell = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    const shellSet = new Set(shell);
    if (shellSet.size !== shell.length) say('SW SHELL', `SHELL 存在重复条目：${shell.filter((v, i) => shell.indexOf(v) !== i).join(' ')}`);

    // 期望集合：public/ 下静态资源（排除 _headers / sw.js）
    const assets = [];
    (function walkAssets(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkAssets(p);
        else {
          const rel = '/' + path.relative(PUBLIC, p).split(path.sep).join('/');
          if (rel === '/_headers' || rel === '/sw.js') continue;
          if (/\.(js|css|webmanifest|png|svg|woff2?)$/.test(rel) || rel === '/index.html') assets.push(rel);
        }
      }
    })(PUBLIC);

    const covered = (asset) =>
      asset === '/index.html' ? shellSet.has('/') || shellSet.has('/index.html') : shellSet.has(asset);
    for (const a of assets) if (!covered(a)) say('SW MISSING', `静态资源 ${a} 不在 SHELL 预缓存清单（离线壳缺文件）`);

    const expected = new Set(assets);
    for (const s of shellSet) {
      if (s === '/' || s === '/index.html') continue; // index.html 的两种写法都合法
      if (!expected.has(s)) say('SW UNKNOWN', `SHELL 条目 ${s} 在 public/ 下不存在（404 白缓存，多为改名/删除后忘清）`);
    }
  }
}

if (problems) {
  console.log(`\nCHECK_FAIL · total problems=${problems}`);
  process.exit(1);
}
console.log('SHELL_OK · 清单与 public/ 静态资源一致');
