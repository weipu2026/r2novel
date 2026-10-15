/* review-fix144.test.mjs — #144 轮修复的定向回归（P1×3 + P2 关键判据）
 * 判据落在「请求本身/判定分支」上，正则带结构（防注释同名喂假绿） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 仓库文件是 CRLF：断言正则里的 \n 必须在归一后匹配（否则多行正则静默失配 = 假红）
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const routerSrc = () => read('src/router.js');

test('P1-1 purgeOnce：keys 来自 purge 数组时必须继承续扫游标（否则 8000 章外正文永久残留）', () => {
  const src = routerSrc();
  const i = src.indexOf('async function purgeOnce(');
  const body = src.slice(i, i + 4200);
  // else 分支（keys 来自上轮 purge）：游标必须带回 nextCursor
  assert.match(body, /\} else \{\n\s*\/\/ #144 P1-1[\s\S]*?nextCursor = purgeCursor;/,
    'keys 来自 purge 时未继承 purgeCursor → 本窗删完即摘条目，list 窗外章节永久残留');
  // done 判据必须同时看 left 与 nextCursor（漏看 nextCursor 会提前摘条目）
  assert.match(body, /if \(left\.length \|\| nextCursor\)/, 'done 判据必须包含 nextCursor');
});

test('P1-2 apiRestore：CAS 重放必须检出 purge 占用标记并 409（只比 deletedAt 会穿透）', () => {
  const src = routerSrc();
  const i = src.indexOf('async function apiRestore(');
  const body = src.slice(i, i + 4000);
  assert.match(
    body,
    /if \(\(Array\.isArray\(t\.books\[i\]\.purge\) && t\.books\[i\]\.purge\.length\) \|\| t\.books\[i\]\.purgeCursor\) \{\n\s*return \{ dirty: false, out: \{ raced: true \} \};/,
    '重放 mutate 必须比对 purge 占用标记（purgeOnce 保留 deletedAt 不变 → 只比 deletedAt 会穿透）'
  );
  assert.match(body, /if \(marked && marked\.raced\)/, 'raced 信号必须被消费');
  assert.match(body, /idx\.remove\(id\)/, '竞态检出后必须回滚刚 upsert 的索引副本');
  assert.match(body, /恢复已中止.*409|409[\s\S]{0,40}恢复已中止/, '必须回 409 而不是 ok');
});

test('P1-3 editor 保存本章：请求体与基线推进必须用同一份快照（两读 ta.value 会静默丢字）', () => {
  const src = read('public/js/upload/editor.js');
  const i = src.indexOf("save.addEventListener('click'");
  const body = src.slice(i, i + 1400);
  assert.match(body, /const content = ta\.value;/, '保存前必须捕获内容快照');
  assert.ok(!/content: ta\.value/.test(body), '请求体不得再直接读 ta.value（必须用快照）');
  assert.match(body, /ceBase\.set\(ch\.key, content\);/, '基线必须推进到快照');
  assert.match(body, /if \(ceDraft\.get\(ch\.key\) === content\) ceDraft\.delete\(ch\.key\);/,
    '草稿只在等于刚保存内容时清（在飞期新输入必须保留）');
});

test('P2-8 ceInsert：插入成功后的刷新失败必须分段报错（共用 catch 会诱导重试真插两章）', () => {
  const src = read('public/js/upload/editor.js');
  const i = src.indexOf('async function ceInsert(');
  const body = src.slice(i, i + 1200);
  assert.match(body, /已插入，但章表刷新失败/, '刷新失败不得报「插入失败」');
  assert.match(body, /if \(!ceAliveAt\(gen\)\) return;[^\n]*\n\s*toast\('已插入/, 'toast 前必须有世代守卫');
});

test('P2-9 ceDelete/refreshCeFromServer：迟到响应直写 ceState 前必须有世代守卫', () => {
  const src = read('public/js/upload/editor.js');
  const d = src.indexOf('async function ceDelete(');
  const dBody = src.slice(d, d + 700);
  assert.match(dBody, /if \(!ceAliveAt\(gen\)\) return;\s*\n\s*ceState\.chapters =/, 'ceDelete 缺世代守卫');
  const r = src.indexOf('async function refreshCeFromServer(');
  const rBody = src.slice(r, r + 500);
  assert.match(rBody, /if \(!ceAliveAt\(gen\)\) return;[^\n]*\n\s*ceState\.chapters =/, 'refreshCeFromServer 缺世代守卫');
});

test('P2-10 uploadMany：任一批失败必须停机不再领新批，并等齐在飞批后统一抛出', () => {
  const src = read('public/js/upload/upload.js');
  const i = src.indexOf('async function uploadMany(');
  const body = src.slice(i, src.indexOf('async function', i + 10));
  assert.match(body, /while \(!aborted && next < bounds\.length\)/, 'worker 循环必须检查 aborted');
  assert.match(body, /if \(!firstErr\) firstErr = err;\s*\n\s*aborted = true;/, '失败必须记录首错并停机');
  assert.match(body, /await Promise\.all\(Array\.from\(\{ length: Math\.min\(CONC, bounds\.length\) \}, worker\)\);\s*\n\s*if \(firstErr\) throw firstErr;/,
    '必须等齐全部 worker 后统一抛首错（不许 Promise.all 早退 + 无人接 rejection）');
});

test('P2-6 快照健壮：getShelfCache 过滤残缺条目 + boot 快照渲染兜底', () => {
  const store = read('public/js/store.js');
  assert.match(store, /s\.books = s\.books\.filter\(\(b\) => b && typeof b\.id === 'string' && typeof b\.title === 'string' && b\.title\);/,
    '快照条目必须形状过滤（缺 id/title 会让 colorOf 抛 TypeError 瘫死首屏）');
  const app = read('public/js/app.js');
  const i = app.indexOf('async function boot()');
  const body = app.slice(i, i + 900);
  assert.match(body, /try \{\s*\n\s*showView\('shelf'\);\s*\n\s*renderShelf\(\);\s*\n\s*\} catch \{/,
    'boot 的快照渲染必须包 try（渲染在 try 外会让损坏快照瘫死首屏）');
});

test('P2-7 trashDays：前端徽章/文案改用服务端生效值', () => {
  const app = read('public/js/app.js');
  assert.match(app, /let trashDays = TRASH_DAYS;/, '必须有可更新的 trashDays 模块变量');
  assert.ok(!/`\$\{TRASH_DAYS\} 天内可恢复`/.test(app), '确认文案仍硬编码 TRASH_DAYS');
  assert.match(app, /trashDays - Math\.floor\(\(Date\.now\(\) - \(b\.deletedAt \|\| 0\)\) \/ 86400000\)/,
    '保留期徽章必须用 trashDays');
  const src = routerSrc();
  assert.match(src, /trashDays: Number\(env\.TRASH_DAYS\) \|\| TRASH_DAYS/, 'apiBooks/apiTrashList 必须回传生效值');
});

test('P3 后端：进度迁移在 CAS 后 / 删章正文在 CAS 后 / tagsMerge 失败计回 remaining / opds 口径一致', () => {
  const src = routerSrc();
  // P3-a：replace 进度迁移必须在 mutateMeta 之后
  const u = src.indexOf('async function apiUpdateChapters(');
  const uBody = src.slice(u, u + 6000);
  const casAt = uBody.indexOf('const m = await mutateMeta(');
  const progAt = uBody.indexOf('store.putText(KEY.progress(id)');
  assert.ok(casAt > 0 && progAt > casAt, 'replace 进度迁移必须在 CAS 之后（409 时不得改写进度）');
  // P3-b：删章正文删除必须在 mutateMeta 之后
  const d = src.indexOf('async function apiDeleteChapter(');
  const dBody = src.slice(d, d + 2400);
  const dCas = dBody.indexOf('const m = await mutateMeta(');
  const dDel = dBody.indexOf('await store.delete(KEY.text(id, key))');
  assert.ok(dCas > 0 && dDel > dCas, '删章正文必须 CAS 成功后才删（短路成功时正文不得已删）');
  // P3-c：tagsMerge 失败书必须加回 remaining
  const t = src.indexOf('async function apiTagsMerge(');
  const tBody = src.slice(t, t + 4800);
  assert.match(tBody, /const failed = targets\.length - patches\.size;/, '必须统计 meta 写失败数');
  assert.match(tBody, /hit\.length - targets\.length \+ failed/, '失败书必须加回 remaining');
  // P3-f：opds 排序两侧口径一致
  const o = src.indexOf('async function opdsCatalog(');
  const oBody = src.slice(o, o + 1600);
  assert.match(oBody, /\(b\.updatedAt \|\| b\.createdAt \|\| 0\) - \(a\.updatedAt \|\| a\.createdAt \|\| 0\)/,
    'opds 排序比较器两侧口径必须一致');
});

test('P3 前端：finishLogout 收敛阅读器 / exitBatchMode 不闪现 / placeSheet 防脱锚', () => {
  const app = read('public/js/app.js');
  const f = app.indexOf('async function finishLogout()');
  const fBody = app.slice(f, f + 1600);
  assert.match(fBody, /reader\.closeReader\(\);\s*\n\s*closeModal\(\);/, 'finishLogout 必须先收敛阅读器');
  const e = app.indexOf('function exitBatchMode(');
  const eBody = app.slice(e, e + 400);
  assert.match(eBody, /if \(rerender\) renderShelf\(\);/, 'exitBatchMode 必须可跳过重渲染');
  const p = app.indexOf('function placeSheet(');
  const pBody = app.slice(p, p + 500);
  assert.match(pBody, /if \(anchor && !anchor\.isConnected\) \{\s*\n\s*closeSheet\(\);/,
    '脱锚（detached）必须关单而不是按 (0,0) 摆位');
});

test('P3 reader：closeReader 清正文区；inflight 收尾只删仍属于自己的表项', () => {
  const src = read('public/js/reader.js');
  const c = src.indexOf('export function closeReader()');
  const cBody = src.slice(c, c + 700);
  assert.match(cBody, /els\.art\.innerHTML = '';/, 'closeReader 必须清正文区（换书窗口闪旧书正文）');
  const i = src.indexOf('state.inflight.set(ck, task)');
  const iBody = src.slice(i, i + 300);
  assert.match(iBody, /if \(state\.inflight\.get\(ck\) === task\) state\.inflight\.delete\(ck\);/,
    'inflight 收尾必须校验 ownership（旧任务迟到收尾不得误删新会话表项）');
});

test('P3 cleaner：joinSoft 英文补空格；utf-16 候选 replaced 整篇口径', () => {
  const src = read('public/js/cleaner.js');
  assert.match(src, /buf \+ ' ' \+ line : buf \+ line;/, '英文词间断行必须补空格');
  const i = src.indexOf("for (const lab of ['utf-16le', 'utf-16be'])");
  const body = src.slice(i, i + 700);
  assert.match(body, /countReplaced\(decodeText\(bin, lab\)\)/, 'utf-16 候选门槛必须用整篇 replaced');
});

test('P3 基建：dom-stub 三处 fail-fast/联动；smoke 轮询带间隔；dev-server 不再镜像 SESSION_DAYS', () => {
  const stub = read('test/_dom-stub.mjs');
  assert.match(stub, /for \(const el of parseHTML\(v\)\) this\.appendChild\(el\);/, 'innerHTML 必须解析子树');
  assert.match(stub, /if \(k === 'disabled'\) this\._disabled = true;/, 'setAttribute 必须联动 disabled');
  assert.match(stub, /尚不支持的选择器/, '不认识的选择器必须 fail-fast');
  const smoke = read('scripts/smoke.mjs');
  assert.match(smoke, /await sleep\(200\);\s*\n\s*r = await api\(`\/api\/trash\/\$\{id\}`/, 'purgeBook 轮询必须带间隔');
  assert.match(smoke, /cookie = m2 \? 'rn_session=' \+ m2\[1\] : '';/, 'm2 必须空判后再取');
  const dev = read('scripts/dev-server.mjs');
  assert.ok(!/SESSION_DAYS: '30'/.test(dev), 'SESSION_DAYS 不得手写镜像（会与 router 兜底漂移）');
  const check = read('scripts/check.mjs');
  assert.match(check, /导入了不存在的名字/, 'node 侧命名导入必须校验存在性');
  assert.ok((check.match(/process\.exit\(1\)/g) || []).length >= 4, 'HOST_CAPS/appTopFns 静默 return [] 必须 fail loud');
});
