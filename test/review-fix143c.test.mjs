/* review-fix143c.test.mjs — 2026-10-06 审计（#143）基建修复的断言护栏
 *
 * 基建类修复的判据特殊性：改对即绿、改错无人拦，且 CI 里没有测试能发现
 * → 断言必须把「手写镜像」变成可测契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 只取可执行代码行：剔除 // 注释、块注释行、以 * 开头的 JSDoc 续行。
 *  必须用它做「某写法是否残留」类判据 —— 这几段代码的**注释里正引用着旧写法**用于说明
 *  为何要改，全文匹配会把自己当成残留（铁律 41：断言范围要收窄到目标）。 */
const codeOnly = (src) => src
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/* ============ CI：SW 版本替换守卫 ============ */

test('CI：SW CACHE 替换的自校验必须比对本次期望值，而不是固定前缀', () => {
  const y = read('.github/workflows/deploy.yml');
  assert.match(y, /NEW_CACHE="r2novel-shell-\$\(date \+%s\)"/,
    '必须先把期望值算出来存进变量');
  assert.match(y, /grep -qxF "const CACHE = '\$\{NEW_CACHE\}';"/,
    '自校验必须整行精确匹配（-xF）；只 grep 前缀时，字面量变成 `\'v14\' + suffix` 就会假通过');
  // 旧的半死守卫不得残留。⚠️ 判据必须**只查命令行**：这段代码的注释里正引用着旧写法
  // （`grep -q "const CACHE = 'r2novel-shell-"`）用于说明为何要改，全文匹配会把自己当成残留
  //（铁律 41：断言范围要收窄到目标，别被同字符串喂出假红）。
  const cmdLines = y.split('\n').filter((l) => /^\s*if ! grep /.test(l) || /^\s*grep /.test(l));
  assert.ok(!cmdLines.some((l) => !l.includes('-qxF') && l.includes('r2novel-shell-')),
    `仍用「前缀存在」判据 → sed 未生效时也通过（这正是它注释声称要防的场景）：${cmdLines.join(' | ')}`);
});

test('CI：部署前必须 fail-fast 校验 secret（否则先上线空口令站、再在冒烟阶段失败）', () => {
  const y = read('.github/workflows/deploy.yml');
  const deployAt = y.indexOf('npx wrangler deploy');
  const secretAt = y.indexOf('wrangler secret list');
  assert.ok(secretAt > 0 && secretAt < deployAt,
    'wrangler secret list 预检必须在 deploy 之前');
  assert.match(y, /拒绝部署/, '预检失败必须显式拒绝部署');
  // 同步密钥步骤仍应在部署之后（Worker 要先存在）
  assert.ok(y.indexOf('secret put') > deployAt, 'secret put 仍需在 deploy 之后（保证 Worker 已存在）');
});

test('CI：deploy job 必须有 timeout-minutes（默认 360 分钟 = 卡死时白烧额度）', () => {
  const y = read('.github/workflows/deploy.yml');
  const job = y.slice(y.indexOf('  deploy:'), y.indexOf('  deploy:') + 400);
  assert.match(job, /timeout-minutes: \d+/, 'deploy job 缺 timeout-minutes');
  const m = /timeout-minutes: (\d+)/.exec(job);
  assert.ok(Number(m[1]) <= 60, `timeout-minutes=${m[1]} 过宽（冒烟最长约 5 分钟，30 留足余量）`);
});

/* ============ check.mjs 门禁判别力 ============ */

test('门禁 d)：SHELL 期望集必须用排除法（新资源类型不得静默漏报）', () => {
  const c = read('scripts/check.mjs');
  const i = c.indexOf('function walkAssets');
  const body = codeOnly(c.slice(i, i + 900)); // ⚠️ 注释里正写着旧白名单正则，判据必须只取代码行
  assert.ok(!/js\|css\|webmanifest\|png\|svg\|woff2/.test(body),
    '仍在用扩展名白名单：新增 .webp/.ico/.json 之类资源不会被报 SW MISSING（静默漏绿），'
    + '写进 SHELL 反而报 SW UNKNOWN 假阳性');
  assert.match(body, /rel === '\/_headers' \|\| rel === '\/sw\.js'\) continue;/,
    '只应排除 CF 配置与 SW 自身');
  assert.match(body, /assets\.push\(rel\);/, '其余全部收入期望集');
});

test('门禁 d)：HOST_CAPS 锚点缺失必须报错而不是静默返回空数组', () => {
  const c = read('scripts/check.mjs');
  const i = c.indexOf("code.indexOf('initUpload(')");
  assert.ok(i > 0, '找不到 HOST_CAPS 锚点');
  const body = codeOnly(c.slice(i - 200, i + 700)); // 同上：注释里引用了旧写法
  assert.ok(!/if \(i < 0\) return \[\];/.test(body),
    '锚点找不到时静默 return [] → 规则 c（upload 必须走 host()）整段空转、CI 全绿');
  assert.match(body, /process\.exit\(1\)|console\.error\('HOST CAPS'/,
    '锚点缺失必须显式失败');
});

test('门禁 ③：ENV PARSE 的报错文案要带上实际运算符（|| 还是 ??）', () => {
  const c = read('scripts/check.mjs');
  assert.match(c, /Number\(env\.X \$\{mm\[1\]\} D\)/,
    '文案把两种写法都印成 `||`，与实际代码不符，排查时会怀疑判据本身');
});

/* ============ dev-server env 键集 ============ */

test('dev-server 的 env 必须带 BRUTE_*/TRASH_DAYS（否则本地恒走硬编码兜底）', () => {
  const d = read('scripts/dev-server.mjs');
  const i = d.indexOf('const env = {');
  // ⚠️ 必须用 codeOnly：这段代码上方的**注释里正写着 BRUTE_LIMIT 等键名**（说明为何要补），
  // 直接 body.includes 会被注释喂出假绿（实测：把真键改名后测试仍全绿）。
  const body = codeOnly(d.slice(i, d.indexOf('};', i)));
  for (const k of ['BRUTE_LIMIT', 'BRUTE_LOCK_MS', 'BRUTE_LOCK_MAX_MS', 'TRASH_DAYS']) {
    assert.ok(body.includes(k), `dev-server env 缺 ${k}：本地测试会用硬编码兜底，与 wrangler.toml 漂移无告警`);
  }
  // 不得写死数值（那才是漂移源）
  assert.ok(!/BRUTE_LIMIT: '5'/.test(body), 'BRUTE_LIMIT 被写死 → 运维调 wrangler.toml 后本地仍按旧值跑');
});

test('dev-server 的 env 键集与 wrangler.toml [vars] 覆盖同一组可调项', () => {
  const d = read('scripts/dev-server.mjs');
  const w = read('wrangler.toml');
  const varsBlock = (w.match(/\[vars\]([\s\S]*?)(?=\n\[|$)/) || [, ''])[1];
  const tunable = [...varsBlock.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
  // MAX_UPLOAD / MAX_CHAPTER 由 shared-const 提供默认值，dev-server 用常量注入（既有设计）
  const skip = new Set(['MAX_UPLOAD', 'MAX_CHAPTER']);
  for (const k of tunable) {
    if (skip.has(k)) continue;
    const i = d.indexOf('const env = {');
    const body = codeOnly(d.slice(i, d.indexOf('};', i)));
    assert.ok(body.includes(k), `wrangler.toml 里的 ${k} 在 dev-server env 中缺失（本地与生产行为会分叉）`);
  }
});

/* ============ 无障碍：label 关联 ============ */

test('无障碍：上传表单 4 个输入框的 label 必须有关联（for 或包裹）', () => {
  const html = read('public/index.html');
  for (const id of ['upTitle', 'upAuthor', 'upTags', 'upNote']) {
    const re = new RegExp(`<label for="${id}">[^<]*</label><input id="${id}"`);
    assert.match(html, re, `#${id} 的 label 既无 for= 也非包裹形态（读屏只念 placeholder）`);
  }
});

test('无障碍：不得出现「label 与 input 兄弟且无 for」的组合（静默失联）', () => {
  const html = read('public/index.html');
  // 找所有 <label>X</label><input id="Y" 形态：必须有 for="Y"
  const re = /<label( for="(\w+)")?>([^<]*)<\/label><input id="(\w+)"/g;
  let m;
  const bad = [];
  while ((m = re.exec(html))) {
    if (m[2] !== m[4]) bad.push(`${m[4]}（label 文字「${m[3]}」）`);
  }
  assert.equal(bad.length, 0, `这些输入框的 label 未关联：${bad.join('、')}`);
  // 正对照：判据本身要能抓到「for 与 id 不匹配」（否则整条断言可能恒真而无判别力）
  const sample = '<label for="a">X</label><input id="b">';
  const bad2 = [...sample.matchAll(/<label( for="(\w+)")?>([^<]*)<\/label><input id="(\w+)"/g)]
    .filter((m) => m[2] !== m[4]);
  assert.equal(bad2.length, 1, '判据自检：for 与 id 不匹配的形态必须被抓到');
});

/* ============ smoke 轮询上限 ============ */

test('smoke：回收站轮询必须有次数上限（与 purgeBook 同一纪律）', () => {
  const s = read('scripts/smoke.mjs');
  assert.ok(!/while \(pr && pr\.data && pr\.data\.remaining > 0\)/.test(s),
    '仍有无上限 while：服务端零进展异常态下会永久自旋 → 冒烟跑到全局超时');
  assert.match(s, /for \(let i = 0; pr && pr\.data && pr\.data\.remaining > 0 && i < 60; i\+\+\)/,
    '轮询应带 i < 60 上限');
});
