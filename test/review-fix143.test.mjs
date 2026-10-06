/* review-fix143.test.mjs — 2026-10-06 全站审计（#143）修复的断言护栏
 *
 * 本轮修的东西有一个共同特征：**都是「静默失败」型缺陷**——不抛异常、不打日志、界面照常渲染，
 * 只有在特定时序/输入下才丢数据。所以断言必须落在「盘面/返回值本身」上，不能只判「没抛错」。
 *
 * 覆盖：
 *   P0-1  上传成功后 createdId 残留 → 下一条链路失败时误删已成功入库的书
 *   P1-2  清洗三条正文丢失（URL 行整段删 / 裸「本书」段删 / 合空行+合并断行粘连）
 *   P1-3  冻结章节必须是深拷贝（同引用会让上传中改预览穿透进本次上传）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, DEFAULT_CLEAN_OPTS } from '../public/js/cleaner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ============ P0-1：createdId 残留 ============ */

test('P0-1 upload.js：上传成功路径必须清 createdId（否则被下一条链路的 catch 当半成品删掉）', () => {
  const src = read('public/js/upload/upload.js');
  // 切出 onConfirm 的成功分支（clear() 之前那一段）
  const okBranch = src.slice(src.indexOf('upSession.setUploading(false); // 上传已成功'), src.indexOf('upSession.clear();'));
  assert.match(okBranch, /setCreatedId\(null\)/,
    '成功分支在 upSession.clear() 之前必须 setCreatedId(null)');
});

test('P0-1 files.js：批量导入循环前必须清 createdId', () => {
  const src = read('public/js/upload/files.js');
  const i = src.indexOf('async function importBatch');
  assert.ok(i > 0, '找不到 importBatch');
  const body = src.slice(i, i + 4000);
  const loopAt = body.indexOf('for (let i = 0; i < n; i++)');
  assert.ok(loopAt > 0, '找不到批量循环');
  const beforeLoop = body.slice(Math.max(0, loopAt - 400), loopAt);
  assert.match(beforeLoop, /setCreatedId\(null\)/,
    '批量循环开始前必须先清残留的半成品 id（第一本就失败时 catch 会按它删书）');
});

/* ============ P1-2：清洗三条正文丢失 ============ */

test('P1-2 stripSite 不得因整行含 URL 就删掉整段正文', () => {
  const para = '他打开 https://example.com/forum/123 看了一眼，然后关掉了电脑。心里想着晚上要去买点菜回来做饭。';
  const kept = cleanText(`第一章\n${para}\n`, { ...DEFAULT_CLEAN_OPTS, stripSite: true });
  assert.ok(kept.includes('买点菜'),
    `含 URL 的正文段被整行删除了：${JSON.stringify(kept)}`);
});

test('P1-2 stripSite 不得删掉以裸「本书」开头的正文首句', () => {
  const kept = cleanText('第一章 起点\n本书主角叫林风，今年十八岁，性格温和。\n他走进了教室。\n',
    { ...DEFAULT_CLEAN_OPTS, stripSite: true });
  assert.ok(kept.includes('林风'), `裸「本书…」开头的正文被删了：${JSON.stringify(kept)}`);
});

test('P1-2 stripSite 仍要真的删掉书站广告行（别把修复做过头）', () => {
  const kept = cleanText('第一章\n【笔趣阁】www.example.com\n他走进了教室。\n',
    { ...DEFAULT_CLEAN_OPTS, stripSite: true });
  assert.ok(!kept.includes('笔趣阁'), '书站广告行应被删除');
  assert.ok(kept.includes('他走进了教室'), '正常正文必须保留');
});

test('P1-2 joinSoft 必须排在 collapseBlank 之前（否则段落边界证据被抹光、两段粘成一坨）', () => {
  // 样本必须选「段内各行都以句末标点结尾」的形态：joinSoft 的落段有两条路径 ——
  // ① 遇空行 ② 上一行以句末标点结尾。若样本不含句末标点，顺序写反（collapseBlank 在前）
  // 与写对的输出**完全相同** → 这条断言就成了零判别力的假保障
  // （2026-10-06 反向探针实测：把断句判据改坏仍然全绿，即此坑）。
  const raw = '他低头看着碗。\n他继续说。\n\n第二段第一行\n第二段第二行。\n';
  const both = cleanText(raw, { ...DEFAULT_CLEAN_OPTS, collapseBlank: true, joinSoft: true });
  assert.ok(!both.includes('他继续说。\n他继续说。'),
    `段内断行未被合并：${JSON.stringify(both)}`);
  assert.ok(both.split('\n').length >= 2,
    `同时勾「合空行 + 合并断行」时两段被粘成一坨：${JSON.stringify(both)}`);
  // 正对照 A：只开 joinSoft（保留空行）→ 段内合并、段间仍是两行（空行被消耗成边界而非保留）
  const joinOnly = cleanText(raw, { ...DEFAULT_CLEAN_OPTS, collapseBlank: false, joinSoft: true });
  assert.ok(joinOnly.includes('他低头看着碗。\n他继续说。\n第二段'),
    `单开 joinSoft 时段内合并/段间分段异常：${JSON.stringify(joinOnly)}`);
  // 正对照 B：默认档（joinSoft 关）不受本次改动影响
  const blankOnly = cleanText(raw, { ...DEFAULT_CLEAN_OPTS, joinSoft: false });
  assert.ok(blankOnly.includes('第二段第一行\n第二段第二行。'),
    `默认档行为被 joinSoft 改动影响：${JSON.stringify(blankOnly)}`);
});

/* ============ P1-3：冻结章节必须是深拷贝 ============ */

test('P1-3 frozenChapters 必须是深拷贝，不能是同一引用', () => {
  for (const [rel, needle] of [
    ['public/js/upload/upload.js', 'session.frozenChapters = session.preview.chapters'],
    ['public/js/upload/files.js', 'sess.frozenChapters = sess.preview.chapters'],
  ]) {
    const src = read(rel);
    const i = src.indexOf(needle);
    assert.ok(i > 0, `${rel}: 找不到 ${needle}`);
    const line = src.slice(i, src.indexOf('\n', i));
    assert.match(line, /\.map\(\s*\(c\)\s*=>\s*\(\s*\{\s*\.\.\.c\s*\}\s*\)\s*\)/,
      `${rel}: 冻结章节必须 .map 深拷贝，实得「${line.trim()}」`);
  }
});

test('P1-3 深拷贝语义实证：冻结后改标题/删章都不影响本次上传用的那份', () => {
  // 复刻修复后的语义（同引用会穿透，深拷贝不会）
  const preview = { chapters: [{ title: '第一章', content: 'A' }, { title: '第二章', content: 'B' }] };
  const session = { preview };
  session.frozenChapters = session.preview.chapters.map((c) => ({ ...c }));
  // 用户在上传中改了标题并删掉第 1 章
  preview.chapters[0].title = '被改过的标题';
  preview.chapters.splice(0, 1);
  assert.equal(session.frozenChapters.length, 2, '冻结数组长度不该被 splice 改掉');
  assert.equal(session.frozenChapters[0].title, '第一章', '冻结副本的标题不该被穿透改写');
  assert.equal(session.frozenChapters[0].content, 'A');
});

test('P1-3 上传在飞时预览行控件必须被禁用', () => {
  const src = read('public/js/upload/preview.js');
  assert.match(src, /function lockPreviewRows\(ul\)/, '缺少 lockPreviewRows');
  const i = src.indexOf('if (upSession.isBusy()) lockPreviewRows(ul);');
  assert.ok(i > 0, 'renderPreviewChapters 未在渲染完成后调用 lockPreviewRows');
  // 锁必须发生在所有行渲染之后（addLi 追加之后），否则一行都锁不到
  const before = src.slice(0, i);
  assert.ok(before.lastIndexOf('ul.appendChild(addLi);') > before.lastIndexOf('chs.slice(0, MAX_PREVIEW).forEach'),
    '锁定调用必须在全部行（含末尾追加行）渲染完之后');
  assert.match(src, /querySelectorAll\('input, textarea, button'\)/, '锁定范围必须覆盖 input/textarea/button');
});

/* ============ P1-6 / P1-7 / P2：前端 401 收敛与弹层残留 ============ */

test('P1-6 finishLogout 必须先关弹层再切视图（遮罩否则盖住登录页 + 私人数据残留）', () => {
  const src = read('public/js/app.js');
  const i = src.indexOf('async function finishLogout()');
  assert.ok(i > 0, '找不到 finishLogout');
  const j = src.indexOf('async function expireSession()', i);
  const body = src.slice(i, j > 0 ? j : i + 2000);
  const closeAt = body.indexOf('closeModal();');
  const viewAt = body.indexOf("showView('login');");
  assert.ok(closeAt > 0, 'finishLogout 未调用 closeModal()');
  assert.ok(viewAt > 0, 'finishLogout 未切登录视图');
  assert.ok(closeAt < viewAt, 'closeModal 必须在 showView(\'login\') 之前调用');
  assert.match(body, /busyDone\(\)/, 'finishLogout 未解除 busy 遮罩');
});

test('P1-7 四处 catch 必须接入 handleAuth（英文 unauthorized 死循环）', () => {
  const src = read('public/js/app.js');
  // 逐个函数切片，检查其 catch 块内是否调 handleAuth
  const cases = [
    ['openTagMgr', 'data = await api.tags();'],
    ['openDiag', 'diagData = await diagScanAll'],
    ['tagMergeRun', 'const r = await api.tagsMerge(from, to);'],
  ];
  for (const [fn, anchor] of cases) {
    const i = src.indexOf(`function ${fn}(`);
    assert.ok(i > 0, `找不到 ${fn}`);
    const slice = src.slice(i, i + 2600);
    const a = slice.indexOf(anchor);
    assert.ok(a > 0, `${fn}: 找不到锚点 ${anchor}`);
    // 从锚点往后找该函数内的 catch 块
    const catchAt = slice.indexOf('} catch (e) {', a);
    assert.ok(catchAt > 0, `${fn}: 锚点后没有 catch`);
    const catchBody = slice.slice(catchAt, catchAt + 320);
    assert.match(catchBody, /handleAuth\(e\)/, `${fn} 的 catch 未收敛 401`);
  }
  // tagMergeRun 额外要求：handleAuth 之后必须 return（否则 openTagMgr 再 401 一次）
  const tm = src.slice(src.indexOf('function tagMergeRun('), src.indexOf('function tagMergeRun(') + 2600);
  const cAt = tm.indexOf('} catch (e) {');
  const seg = tm.slice(cAt, cAt + 420);
  assert.match(seg, /if \(handleAuth\(e\)\) return;/, 'tagMergeRun 的 handleAuth 后必须 return');
  const guardAt = seg.indexOf('if (handleAuth(e)) return;');
  const reopenAt = seg.indexOf('await openTagMgr();');
  assert.ok(guardAt >= 0 && reopenAt > guardAt, 'return 必须排在 openTagMgr 之前');
  // renderShelfError 的重试钮
  const rs = src.slice(src.indexOf('function renderShelfError('), src.indexOf('function renderShelfError(') + 900);
  assert.match(rs, /handleAuth\(e2\)/, 'renderShelfError 的重试回调未收敛 401');
});

test('P1-7 收敛总数不得回退（handleAuth 覆盖 401 的调用点）', () => {
  const src = read('public/js/app.js');
  const n = (src.match(/handleAuth\(/g) || []).length;
  assert.ok(n >= 16, `handleAuth 调用点仅 ${n} 处，上轮审计后应 ≥16（新增 openTagMgr/openDiag/tagMergeRun/renderShelfError）`);
});

test('P2 finishLogout 必须复位排序下拉框（静态 DOM 不随视图重建）', () => {
  const src = read('public/js/app.js');
  const body = src.slice(src.indexOf('async function finishLogout()'), src.indexOf('async function expireSession()'));
  assert.match(body, /els\.sortSel\.value = 'recent';/, '未复位 sortSel');
  assert.ok(body.indexOf("els.sortSel.value = 'recent';") < body.indexOf("showView('login');"), '复位应在切视图前或至少同处');
});

test('P2 tagMergeRun 必须有零进展退出（后端 remaining>0 且 updated=0 的已知组合）', () => {
  const src = read('public/js/app.js');
  const body = src.slice(src.indexOf('function tagMergeRun('), src.indexOf('function tagMergeRun(') + 2600);
  assert.match(body, /const before = updated;/, '缺少本轮增量基线');
  assert.match(body, /if \(updated === before\) break;/, '缺少零进展退出');
});

/* ============ P3 ============ */

test('P3 store.js 不得再暴露吞错版 getProgress（会伪装成「服务端没有进度」）', () => {
  const src = read('public/js/store.js');
  assert.ok(src.indexOf('getProgress: (id)') < 0, '吞错版 getProgress 仍在（应删除，只保留 strict 版）');
  assert.match(src, /getProgressStrict:/, 'strict 版必须保留');
});

test('P3 esc 必须转义单引号（纵深防御）', async () => {
  const { esc } = await import('../public/js/dom.js');
  assert.equal(esc("a'b"), 'a&#39;b');
  assert.equal(esc('<x>'), '&lt;x&gt;');
});

test('P3 boot 的 401 分支必须走 finishLogout（清快照而不是裸切视图）', () => {
  const src = read('public/js/app.js');
  const body = src.slice(src.indexOf('async function boot()'), src.indexOf('async function boot()') + 1400);
  assert.match(body, /if \(e instanceof ApiError && e\.status === 401\) await finishLogout\(\);/,
    'boot 的 401 分支未走 finishLogout');
});

test('P3 clearTrashFlow 进度条总数要算上已清的那 1 本', () => {
  const src = read('public/js/app.js');
  assert.match(src, /if \(!total\) total = Math\.max\(remaining \+ 1, 1\);/,
    '总数未补偿「后端每轮清 1 本后才返回 remaining」');
});
