/* review-fix143b.test.mjs — 2026-10-06 审计（#143）后端修复的断言护栏
 *
 * 与前端那批同源：子请求预算类缺陷的判据必须落在「实际发出的子请求数」上，
 * 而不是「代码里写了个上限」。故本文件大量使用 countStore（test/_harness 提供）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memStore, call, req, login, countStore } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const routerSrc = () => read('src/router.js');

/* ============ P1-4：append 的孤儿清扫上限 ============ */

test('P1-4 append 路径的孤儿清扫不得用 Infinity（一次 N 个 delete 会撞穿 50 子请求）', () => {
  const src = routerSrc();
  assert.ok(!/sweepOrphansBatch\([^)]*Infinity/.test(src),
    '仍有调用点给 sweepOrphansBatch 传 Infinity（每章一次 delete = 一个子请求）');
  // 且必须传 ORPHAN_BATCH（分批上限常量）
  assert.match(src, /sweepOrphansBatch\(store, id, Array\.from\(preKeys\), ORPHAN_BATCH, sweepLive\)/,
    'append 与 replace 应用同一个分批上限');
});

test('P1-4 孤儿 key 多时 append 仍能在预算内完成（30 章上限 × 分批）', async () => {
  const store = memStore();
  const cookie = await login(store);
  // 建书并发布
  const mk = async (n) => {
    const r = await call(store, req('/api/books', {
      method: 'POST', cookie,
      body: { title: '书' + n, chapters: Array.from({ length: 5 }, (_, i) => '第' + (i + 1) + '章'), wordCount: 50 },
    }));
    for (let i = 0; i < 5; i++) {
      await call(store, req(`/api/books/${r.data.id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '正文' + i }));
    }
    await call(store, req(`/api/books/${r.data.id}/publish`, { method: 'POST', cookie }));
    return r.data.id;
  };
  const id = await mk(1);
  // replace 成 2 章 → 登记 3 个孤儿
  const r = await call(store, req(`/api/books/${id}/chapters`, {
    method: 'POST', cookie, body: { op: 'replace', chapters: ['第1章', '第2章'], wordCount: 20 },
  }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 再 append 5 章
  const r2 = await call(store, req(`/api/books/${id}/chapters`, {
    method: 'POST', cookie, body: { op: 'append', chapters: ['新1', '新2', '新3', '新4', '新5'] },
  }));
  assert.equal(r2.status, 200, 'replace→append 链路必须 200（旧的 Infinity 上限在此规模不会超限，但要保证不报错）');
  assert.equal(r2.data.chapterKeys.length, 7, '章表应为 2 + 5');
});

/* ============ P1-5：批量操作的预算与 retry 语义 ============ */

test('P1-5 全量打开时按「本批真正需要的片数」计费（大库不被 shardCount 压死）', () => {
  const src = routerSrc();
  const i = src.indexOf('async function apiBatchBooks(');
  assert.ok(i > 0);
  const body = src.slice(i, i + 4200);
  assert.match(body, /needShards/,
    '预算计费必须按目标实际所在片数（needShards），不能直接用 shardCount');
  assert.match(body, /const extra = healthy \? 1 \+ \(needShards\.size > 0 \? needShards\.size : 1\) : 1 \+ h\.shardCount \+ 4;/,
    '只有 root 健康时才退差；自愈路径必须按 4 + shardCount 全额计费（否则实测 53 > 50 越顶）');
});

test('P1-5 retry 只在真自愈时置位（离架 id 导致的正常全量打开不是自愈）', () => {
  const src = routerSrc();
  const i = src.indexOf('async function apiBatchBooks(');
  const body = src.slice(i, src.indexOf('async function ', i + 100));
  const m = /const retry = ([^;]+);/.exec(body);
  assert.ok(m, '找不到 retry 赋值');
  assert.match(m[1], /rebuilt === true/,
    'retry 判据必须是「确实重建过 root」，而不是 extra>0（离架 id 也会 extra>0）');
  assert.ok(!/rootInfo\.extra > 0 && processed\.length === 0/.test(body),
    '旧的 extra>0 判据仍在（会把正常续跑误报成自愈轮，客户端耗尽重试后整批判失败）');
});

test('P1-5 含离架 id 的大库批量：至少能处理一本（不再静默全灭）', async () => {
  const base = memStore();
  const cookie = await login(base);
  // 造 8 本书（2 片规模足以触发全量路径：map 缺一条 → 走 openIndex）
  const books = [];
  for (let i = 0; i < 8; i++) {
    const r = await call(base, req('/api/books', {
      method: 'POST', cookie, body: { title: '批量书' + i, chapters: ['第1章'], wordCount: 10 },
    }));
    for (let c = 1; c <= 1; c++) {
      await call(base, req(`/api/books/${r.data.id}/chapters/${c}`, { method: 'PUT', cookie, body: '正文' }));
    }
    await call(base, req(`/api/books/${r.data.id}/publish`, { method: 'POST', cookie }));
    books.push(r.data.id);
  }
  // 把一个不存在的 id 混进 batch（模拟离架/幽灵 id）
  const ids = [...books.slice(0, 3), 'ghost_no_such_id'];
  const store = countStore(base);
  const r = await call(store, req('/api/books/batch', {
    method: 'POST', cookie, body: { ids, action: 'setFinished', finished: true },
  }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.updated >= 1, `含离架 id 时至少应处理一本（实测 updated=${r.data.updated}）`);
  const used = store._count.get + store._count.put + store._count.list;
  assert.ok(used <= 50, `子请求必须 ≤ 50（实测 ${used}）`);
  assert.ok(!r.data.retry, '离架 id 不是自愈，不该置 retry（否则客户端白耗一次重试）');
});

/* ============ P2-1 / P3-1 / P3-2：purge 的续扫与判据 ============ */

test('P2-1 purgeOnce 的前缀列取页数必须受限且带续扫游标', () => {
  const src = routerSrc();
  assert.ok(!/store\.list\(prefix, 50\)/.test(src),
    '仍有 list(prefix, 50)：50 页 = 50 个子请求，单它就撞穿 50 硬顶');
  assert.match(src, /store\.list\(prefix, 8, purgeCursor\)/,
    '必须限页并传续扫游标（剩余章节靠 purgeCursor 逐窗接着列）');
  assert.match(src, /purgeCursor: nextCursor/,
    'CAS 标记必须带上下一窗游标，否则续扫状态随进程终止丢失');
});

test('P2-1 游标不得塞进 purge 数组当哨兵（会被当章 key 删掉且随批丢失 → 永不推进）', () => {
  const src = routerSrc();
  assert.ok(!/keys\.push\(`[^`]*cursor:/.test(src), '仍有把游标塞进 keys 的哨兵写法');
  assert.match(src, /if \(left\.length \|\| nextCursor\)/,
    'done 判定必须同时看「本窗没删完」与「还有没列到的章节」');
});

test('P2-1/P3-1 恢复判据与 purge 的 done 判据同源（purge 非空或游标非空即不可恢复）', () => {
  const src = routerSrc();
  const i = src.indexOf('async function apiRestore(');
  const body = src.slice(i, i + 1500);
  assert.match(body, /Array\.isArray\(entry\.purge\) && entry\.purge\.length/,
    'apiRestore 必须用「有剩余待清」而不是「purge 字段存在」（空数组为真会让一次中断的书永久不可恢复）');
  assert.match(body, /entry\.purgeCursor/,
    'apiRestore 也必须把「还有没列到的章节」算作不可恢复');
  // apiTrashList 的 restorable 同步
  const j = src.indexOf('async function apiTrashList(');
  const list = src.slice(j, j + 1200);
  assert.match(list, /restorable: !\(Array\.isArray\(b\.purge\) && b\.purge\.length\) && !b\.purgeCursor/,
    'apiTrashList 的 restorable 必须与 apiRestore 同判据');
});

test('P3-2 purgeOnce 不得再保留已成死参数的 trash 形参', () => {
  const src = routerSrc();
  assert.match(src, /async function purgeOnce\(store, id, maxDel = PURGE_BATCH\)/,
    'purgeOnce 签名应去掉 trash 形参（函数体全部走重读）');
  assert.ok(!/purgeOnce\(store, trash,/.test(src), '仍有调用点按旧签名传 trash');
  // 只数**调用**（定义形参是 `store, id, maxDel`，调用点是 `store, b.id` / `store, id` 等）：
  // 判据 = 前面不是 `function purgeOnce`
  const calls = [...src.matchAll(/(?<!function )purgeOnce\(store, [^)]*\)/g)].map((m) => m[0]);
  assert.equal(calls.length, 3, `purgeOnce 调用点应恰好 3 处（sweepTrash / apiTrashPurge / apiTrashClear），实测 ${calls.length}：${calls.join(' | ')}`);
});

test('P2-1 回归：45 章大书彻底删除仍分批收敛（purge 预算护栏没破坏分批语义）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const r = await call(store, req('/api/books', {
    method: 'POST', cookie,
    body: { title: 'purge 大书', chapters: Array.from({ length: 45 }, (_, i) => '第' + (i + 1) + '章'), wordCount: 450 },
  }));
  const id = r.data.id;
  for (let i = 1; i <= 45; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i}`, { method: 'PUT', cookie, body: '正文' + i }));
  }
  await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  await call(store, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  const cs = countStore(store);
  let p = await call(cs, req(`/api/trash/${id}`, { method: 'DELETE', cookie }));
  const usedFirst = cs._count.get + cs._count.put + cs._count.list;
  assert.equal(p.status, 200);
  assert.equal(p.data.done, false, '45 章 > 30 上限 → 首批未完成');
  assert.ok(usedFirst <= 50, `首批子请求必须 ≤ 50（实测 ${usedFirst}）`);
  p = await call(store, req(`/api/trash/${id}`, { method: 'DELETE', cookie }));
  assert.equal(p.data.done, true, '续调后完成');
  assert.ok(!store._map.has(`text/${id}/1.txt`), '正文已清');
  assert.ok(!store._map.has(`meta/${id}.json`), 'meta 已清');
});

/* ============ P2-2：孤儿清扫重放预算 ============ */

test('P2-2 孤儿清扫的 CAS 重放必须按剩余预算收窄批量（否则 3 轮 ≈77 子请求 → 500）', () => {
  const src = routerSrc();
  const i = src.indexOf('async function apiBookMeta(');
  const body = src.slice(i, i + 3200);
  assert.match(body, /const room = 46 - \(attempt \+ 1\) \* 2;/,
    '必须按轮次预留「重读 + putIf」预算');
  assert.match(body, /Math\.min\(ORPHAN_BATCH, room\)/,
    '每轮批量必须被剩余预算收窄');
  assert.match(body, /if \(attempt > 0 && room < 8\) break;/,
    '预算不足必须停止重放（残留 orphans 不影响读取）');
});

/* ============ P2-3：reconcileIdx 复杂度 ============ */

test('P2-3 reconcileIdx ② 不得在每片循环内全量物化 Object.keys(root.map)', () => {
  const src = routerSrc();
  const i = src.indexOf('function reconcileIdx(');
  const j = src.indexOf('function makeHandle(', i);
  const body = src.slice(i, j);
  assert.match(body, /const mapIds = Object\.keys\(root\.map\);/,
    'mapIds 必须提到循环外物化一次');
  const loopStart = body.indexOf('for (let si = 0');
  const after = body.slice(loopStart);
  // ⚠️ 判据必须排除**注释里**的字样（这段代码的注释本身就写着 Object.keys(root.map)），
  // 只认「把它当值用」的形态：赋值右侧、for...of/of 调用参数。铁律 41：断言范围要收窄到目标。
  const codeOnly = after
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.ok(!/=\s*Object\.keys\(root\.map\)/.test(codeOnly) && !/of\s+Object\.keys\(root\.map\)/.test(codeOnly),
    '循环体内仍把 Object.keys(root.map) 当值用 → O(K×N)（40 片/2 万本实测 135ms，超 Workers Free 10ms CPU 预算）');
  assert.match(body, /if \(id in root\.map && root\.map\[id\] === n && !owner\.has\(id\)\)/,
    '用 `in` 复查存在性（map 在循环内被 delete，不能缓存值）');
});

/* ============ P2-4 / P2-5：diag 与 opds 的预算前置 ============ */

test('P2-4 残留扫描的 list 页数必须在发起前按剩余预算裁剪', () => {
  const src = routerSrc();
  const i = src.indexOf('async function apiDiagOrphans(');
  const body = src.slice(i, i + 4200);
  const listAt = body.indexOf('await Promise.all([');
  const capAt = body.indexOf('pageCap(');
  assert.ok(capAt > 0 && capAt < listAt, '页数裁剪必须发生在 Promise.all 之前（事后记账管不到已发请求）');
  assert.match(body, /wantMeta > 0 \? store\.list\('meta\/', wantMeta\)/,
    'meta 前缀的 list 必须用裁剪后的页数');
});

test('P2-5 OPDS 目录必须有子请求预算护栏（48 分片 ≈2.4 万本时 2+48 > 50）', () => {
  const src = routerSrc();
  const i = src.indexOf('async function opdsCatalog(');
  const body = src.slice(i, i + 1600);
  assert.match(body, /Number\(probed\.shards\) > 40/, '必须按分片数设阈值');
  assert.match(body, /return json\(\{ error: '书库过大/, '超阈值回 409 + 指引，而不是抛到 Worker 顶层');
});

/* ============ 结构性不变量 ============ */

test('store 三原语签名未被本轮改动破坏', () => {
  const src = routerSrc();
  // purgeOnce 的 maxDel 默认值与常量一致性
  assert.match(src, /const PURGE_BATCH = DELETE_BATCH;/, 'PURGE_BATCH 仍应等于 DELETE_BATCH');
  assert.match(src, /async function purgeOnce\(store, id, maxDel = PURGE_BATCH\)/,
    'purgeOnce 默认批量应取 PURGE_BATCH');
});
