/* review-fix146.test.mjs — 第四轮全站审计（#146）定向回归
 *
 * 覆盖 P2-5 / P3-5 / P3-6 / P2-7 / P2-8 / P3-7，以及 P3 批次里的 R15–R17。
 * 这些条目此前只改了实现、没有测试（一旦被后人"顺手简化"就会静默回归），故单列一文件。
 *
 * 断言口径：优先行为级（真跑一遍看结果），做不到的才落到源码文本 —— 落到源码文本时一律
 * 切「整段函数体」再匹配，绝不用固定 N 字符窗口（函数一长就击穿，本轮已踩过两次）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { srcAll } from './_src-all.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/** 从 head 起切出整段函数体（到下一个顶层 function/async function 为止） */
function bodyOf(src, head) {
  const i = src.indexOf(head);
  assert.ok(i > 0, `找不到锚点：${head}`);
  const ends = ['\nasync function ', '\nfunction ']
    .map((t) => src.indexOf(t, i + head.length))
    .filter((n) => n > i);
  return src.slice(i, ends.length ? Math.min(...ends) : i + 8000);
}

/* ---------------- P2-5：登出必须清掉「不随 grid 重建」的容器 ---------------- */

test('#146 P2-5 finishLogout 必须清掉继续阅读卡/书库规模/筛选条数/回收站（共享设备隐私残留）', () => {
  const body = bodyOf(read('public/js/app.js'), 'async function finishLogout()');
  const musts = [
    ["els.continueCard.innerHTML = ''", '继续阅读卡（书名 + 阅读进度）'],
    ["els.continueWrap.classList.add('hidden')", '继续阅读区的显隐'],
    ["els.shelfCount.textContent = ''", '书库规模「共 N 本 · X 万字」'],
    ["els.filterNote.textContent = ''", '筛选结果条数'],
    ["els.trashList.innerHTML = ''", '回收站列表（书名 + 删除时间）'],
    ["els.trashCount.textContent = ''", '回收站计数'],
  ];
  for (const [lit, why] of musts) assert.ok(body.includes(lit), `finishLogout 未清理 ${why}`);
  // doLogin 是「先 showView('shelf') 再 await loadShelf」→ 清理必须都发生在切登录视图之前，
  // 否则登录后的整个往返窗口里，新登录者看到的是前任的继续阅读书卡与书库规模。
  const loginAt = body.indexOf("showView('login');");
  assert.ok(loginAt > 0, 'finishLogout 未切登录视图');
  for (const [lit, why] of musts) assert.ok(body.indexOf(lit) < loginAt, `${why} 的清理必须在 showView('login') 之前`);
});

/* ---------------- P3-5：诊断「未能核验」桶 ---------------- */

test('#146 P3-5 服务端：清单截断时归属不明的对象进 unverified 桶，且把结果标成不完整', () => {
  const body = bodyOf(srcAll(), 'async function doDiagScan(');
  assert.match(
    body,
    /const pushResidue = \(o\) =>\s*\n\s*\(lMeta\.truncated \? unverified : residue\)\.push\(\{ key: o\.key, size: o\.size \}\);/,
    'text/raw/progress 三类必须统一走 pushResidue（截断时无法判断归属 → 不能当「已删书残留」）'
  );
  assert.equal(
    (body.match(/pushResidue\(/g) || []).length,
    3,
    'text / raw / progress 三处漏一处，截断时仍会把无主书正文或原件列成「可直接删」'
  );
  assert.ok(!/residue\.push\(\{ key: o\.key/.test(body), '仍有裸 residue.push —— 截断时会误列可删残留');
  assert.match(
    body,
    /summary = \{[^}]*unverified: unverified\.length/,
    'summary 必须带上 unverified 计数（前端标题/徽标据此展示）'
  );
  assert.match(
    body,
    /incomplete: [^\n]*\|\| unverified\.length > 0,/,
    'unverified 非空 → 必须置 incomplete（否则前端仍放开「删除全部」）'
  );
});

test('#146 P3-5 前端：未能核验的行不给任何删除入口，且不完整时禁用「删除全部」', () => {
  const src = read('public/js/app.js');

  // unvRow：故意不渲染删除按钮（归属没确认就删，同样可能删掉无主书的正文/原件）
  const i = src.indexOf('const unvRow = (o) =>');
  assert.ok(i > 0, '找不到 unvRow');
  const end = src.indexOf("</div></div></div>';", i);
  assert.ok(end > i, 'unvRow 切片失败');
  const row = src.slice(i, end + '</div></div></div>\';'.length);
  assert.ok(!row.includes('data-diag'), 'unvRow 不得渲染任何 data-diag 动作（含单删）');

  // 「删除全部」两个按钮都要拼 disabled 属性
  assert.match(src, /const delAllOff = d\.incomplete\s*\n?\s*\?/, 'delAllOff 必须由 d.incomplete 决定');
  assert.equal(
    (src.match(/\$\{delAllOff\}/g) || []).length,
    2,
    'residue 与 chapters 两个「删除全部」按钮都必须带 disabled'
  );

  // 处理器二次兜底：disabled 只是 UI 约定（键盘/脚本触发、将来复用入口都绕得过）
  const h = src.indexOf("} else if (act === 'del-all') {");
  assert.ok(h > 0, '找不到 del-all 分支');
  assert.match(src.slice(h, h + 500), /if \(diagData\.incomplete\) \{/, 'del-all 处理器必须二次兜底拦下不完整扫描');
});

test('#146 P3-6 diagRefresh 必须给扫描传中止回调（旧实现传 null → 弹层关了还在翻页烧配额）', () => {
  const body = bodyOf(read('public/js/app.js'), 'async function diagRefresh()');
  assert.match(body, /diagData = await diagScanAll\(\(\) => \{/, 'diagRefresh 必须传中止回调');
  assert.ok(!body.includes('diagScanAll(null)'), '不得再传 null');
  assert.match(
    body,
    /if \(seq !== modalSeq \|\| els\.modalMask\.classList\.contains\('hidden'\)\) return false;/,
    '中止判据必须与 openDiag 一致：换弹层、关弹层都停'
  );
});

/* ---------------- P2-7 / P2-8：冒烟脚本 ---------------- */

test('#146 P2-7 冒烟：登录没下发 cookie 必须当场判定（旧写法裸 m[1] 抛 TypeError，真因被淹掉）', () => {
  const src = read('scripts/smoke.mjs');
  const i = src.indexOf('if (!m) {');
  assert.ok(i > 0, '缺少 !m 分支');
  const blk = src.slice(i, src.indexOf("cookie = 'rn_session=' + m[1];", i));
  assert.ok(blk.includes('e.smoke = true;'), '异常必须打 smoke 标记（main 的 finally 据此照常清理）');
  assert.ok(blk.includes('throw e;'), '必须抛出让主流程停在这里，而不是带着空 cookie 一路 401');
  assert.ok(blk.includes('Set-Cookie'), '报错要带上 Set-Cookie 原文，否则线上排查不知是没下发还是键名不符');
  // cookie 赋值必须在 !m 分支之后（否则 m 为 null 时先崩）
  assert.ok(src.indexOf("cookie = 'rn_session=' + m[1];") > i, 'cookie 赋值必须在 null 守卫之后');
});

test('#146 P2-8 冒烟：清理与「清理后核对」必须用同一个正则（旧实现一严一宽 → CI 永久红）', () => {
  const src = read('scripts/smoke.mjs');
  assert.match(src, /const SMOKE_TITLE_RE = \/\^\(M2 测试书\|冒烟测试书\)\//, '清理/核对必须共用一条书名判据');
  assert.equal((src.match(/SMOKE_TITLE_RE\.test/g) || []).length, 2, '清理侧与核对侧各引用一次');
  assert.ok(!/\/测试书\/\.test\(x\.title/.test(src), '核对侧不得再用 /测试书/ 子串（用户真实书名含「测试书」→ 永远认为有残留）');
});

/* ---------------- P3-7：dev 服务器数据目录 ---------------- */

test('#146 P3-7 dev-server：R2NOVEL_DATA 必须规整成绝对路径（否则 ./ 前缀让所有 key 判越界）', () => {
  const src = read('scripts/dev-server.mjs');
  const m = /const DATA = ([^\n;]+);/.exec(src);
  assert.ok(m, '找不到 DATA 定义');
  assert.match(m[1], /^path\.resolve\(/, 'DATA 必须 path.resolve：path.join 会吃掉 ./ 前缀，而越界判据用的是未规整串');
});

/* ---------------- P3 批次：R15 / R16 / R17 ---------------- */

test('#146 R15 索引打开：缺 root 的判据必须是 looksRoot（合法 JSON 但形状不对同样是坏 root）', () => {
  const src = srcAll();
  assert.equal(
    (src.match(/if \(!looksRoot\(root\)\) \{/g) || []).length,
    2,
    '两处守卫（bak 回落前 / 回落失败后）都必须按 looksRoot 判'
  );
  assert.ok(!/if \(!root\) \{/.test(src), '不能退回真值判断：[]、{"v":2} 缺 map 都是真值但不是 root');
});

test('#146 R16 root 缺失时不得盲目重放迁移（v1Bak 存在 ⇒ 迁移发生过 ⇒ 由分片重建）', () => {
  const body = bodyOf(srcAll(), 'async function openIndex(');
  assert.match(
    body,
    /if \(rootRaw == null\) \{[\s\S]{0,600}?const v1bak = await getWithEtag\(store, KEY_IDX\.v1Bak\);[\s\S]{0,120}?if \(v1bak\) return rebuildIdxRoot\(store\);[\s\S]{0,80}?return migrateV1\(store\);/,
    '迁移会无条件覆盖 s0..sK（数据源是冻结的 v1 快照）→ root 被误删时重放会把整库索引回滚到迁移那一刻'
  );
});

test('#146 R17 章节集合路由（POST-only）必须 405 兜底并吃掉请求体', () => {
  const src = srcAll();
  const i = src.indexOf('if (mChapters && req.method === \'POST\') return apiUpdateChapters(');
  assert.ok(i > 0, '找不到 mChapters 的 POST 分支');
  const tail = src.slice(i, i + 260);
  assert.match(tail, /if \(mChapters\) \{[\s\S]{0,120}?await dropBody\(req\);[\s\S]{0,80}?return json\(\{ error: 'method' \}, 405\);/,
    '其余方法必须 405（旧实现落到 404：前端按「书不存在」提示，用户完全找不到原因）');
});
