/* review-fix150b.test.mjs — #150 C 档（API 层逻辑与幂等）的定向回归
 *
 * 判据落在行为 / 我发出的请求上：
 *   P2-1  限速原子化：并发错误口令只能被执行 limit 次
 *   P2-4  插章/删章的进度迁移走 CAS，不得覆盖读者刚写的位置
 *   P3-1  op 显式给错值必须 400（不许静默当 replace 整表重建）
 *   P3-2  append / insert 复核 CHAPTER_MAX
 *   P3-6  apiPutRaw 三道守卫（不存在 / 已发布 / 在回收站）
 *   P3-7  replace 的活键取新旧并集：CAS 失败时不得已删掉旧表仍在用的正文
 *   P3-8  书不在架时进度写入不得退化成全量读索引
 *   P3-9  OPDS 下载的 filename* 必须按 RFC 5987 编码 '()*
 *   P3-10 请求体是 JSON null → 400/401，不是 500
 *   P3-11 建书 wordCount 夹 ≥0、判重与落盘共用同一份规范化结果
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAPTER_MAX } from '../public/js/shared-const.js';
import { KEY, KEY_IDX } from '../src/core/const.js';
import { handleRequest } from '../src/router.js';
import { memStore, req, call, login, ENV, writeIdxBooks, writeIdxShards, makeReadyBook } from './_harness.mjs';

const ROOT = 'meta/idx/root.json';
const meta = (id, extra = {}) => ({ id, title: '书' + id, author: '', tags: [], chapterCount: 1, wordCount: 1, ...extra });

/* ---------------- P2-1 限速原子化 ---------------- */

test('P2-1 限速：并发错误口令只有 limit 次真正被执行，其余立刻 429', async () => {
  const base = memStore();
  const env = { ...ENV, BRUTE_LIMIT: '5', BRUTE_LOCK_MS: '60000', BRUTE_LOCK_MAX_MS: '600000' };
  // 撑开读—改—写窗口：12 个请求的首次读全部重叠在「计数还是 0」的那一刻 ——
  // 这正是旧实现（先只读检查、比完口令才补记）放行 12 次猜测的那个窗口。
  let slowLeft = 12;
  const store = {
    ...base,
    async getText(k) {
      const t = await base.getText(k);
      if (k === KEY.BRUTE && slowLeft-- > 0) await new Promise((r) => setTimeout(r, 3));
      return t;
    },
  };
  const bad = () => req('/api/login', { method: 'POST', body: { password: 'wrong' } });
  const rs = await Promise.all(Array.from({ length: 12 }, () => handleRequest(bad(), env, store).then((r) => r.status)));
  const compared = rs.filter((s) => s === 401).length;
  const rejected = rs.filter((s) => s === 429).length;
  assert.equal(compared + rejected, 12, '只该有两种结果：' + JSON.stringify(rs));
  assert.ok(compared <= 5, `被执行的口令猜测必须 ≤ BRUTE_LIMIT=5（实测 ${compared}；旧实现 12 路并发 = 12 次全执行）`);
  assert.ok(rejected >= 7, '超出额度的必须 429，实测 ' + rejected);
});

/* ---------------- P2-4 进度迁移走 CAS ---------------- */

test('P2-4 插章时的进度迁移不得覆盖读者刚写的位置（读—判—条件写）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const id = 'b0001';
  await base.putText(KEY.book(id), JSON.stringify({ ...meta(id), status: 'ready', chapters: [1, 2, 3, 4].map((n) => ({ key: String(n), title: '第' + n + '章' })) }));
  await base.putText(KEY.progress(id), JSON.stringify({ ch: 2, ratio: 0.1, updatedAt: Date.now() - 5000 }));
  await writeIdxBooks(base, [meta(id, { status: 'ready' })]);

  // 第一次读进度之后，模拟读者刚翻到第 4 章（CAS 基线因此失效）
  let bumped = false;
  const store = {
    ...base,
    async getTextWithEtag(k) {
      const r = await base.getTextWithEtag(k);
      if (k === KEY.progress(id) && !bumped) {
        bumped = true;
        await base.putText(KEY.progress(id), JSON.stringify({ ch: 4, ratio: 0.5, updatedAt: Date.now() }));
      }
      return r;
    },
  };
  const r = await call(store, req(`/api/books/${id}/chapters/insert`, { method: 'POST', cookie, body: { after: '1', title: '插在第二章前', content: '新章正文' } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = JSON.parse(await base.getText(KEY.progress(id)));
  // 插在第 1 章之后 → 插入位及其后的章号 +1：读者那次 ch=4 的写入应被迁成 5，
  // 而不是被迁移第一轮用的旧快照（ch=2→3）覆盖回去
  assert.equal(p.ch, 5, `必须基于读者最新的 ch=4 迁移（实测 ${p.ch}；旧实现无条件 putText 会把 ch=4 覆盖回 3）`);
});

/* ---------------- P3-1 op 白名单 ---------------- */

test('P3-1 op 显式给了非法值时 400，不得静默当 replace 整表重建', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = 'b0002';
  const chapters = [1, 2, 3].map((n) => ({ key: String(n), title: '第' + n + '章' }));
  await store.putText(KEY.book(id), JSON.stringify({ ...meta(id), status: 'creating', chapters }));
  await writeIdxBooks(store, [meta(id, { status: 'creating' })]);
  const r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'apend', chapters: ['新章'] } }));
  assert.equal(r.status, 400, '拼错的 op 必须显式失败（否则用户本想追加、全书章表却被重建）');
  const m = JSON.parse(await store.getText(KEY.book(id)));
  assert.equal(m.chapters.length, 3, '章表一个字都不许动');
});

/* ---------------- P3-2 CHAPTER_MAX ---------------- */

test('P3-2 append 复核 CHAPTER_MAX：满额后追加必须 409，章表不得越过上限', async () => {
  const store = memStore();
  const cookie = await login(store);
  const id = 'b0003';
  const chapters = Array.from({ length: CHAPTER_MAX }, (_, i) => ({ key: String(i + 1), title: 'c' + (i + 1) }));
  await store.putText(KEY.book(id), JSON.stringify({ ...meta(id), status: 'creating', chapters, chapterCount: CHAPTER_MAX }));
  await writeIdxBooks(store, [meta(id, { status: 'creating' })]);
  const r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'append', chapters: ['溢出章'] } }));
  assert.equal(r.status, 409, 'append 必须复核单本上限（create/replace 都截断，只有 append 能让章表无限长）');
  assert.equal(JSON.parse(await store.getText(KEY.book(id))).chapters.length, CHAPTER_MAX);

  // 插章同样复核（insert 走的是另一条 splice 路径，create/replace 的截断管不到它）
  const id2 = 'b0008';
  await store.putText(KEY.book(id2), JSON.stringify({ ...meta(id2), status: 'ready', chapters, chapterCount: CHAPTER_MAX }));
  await writeIdxBooks(store, [meta(id2, { status: 'ready' })]);
  const ins = await call(store, req(`/api/books/${id2}/chapters/insert`, { method: 'POST', cookie, body: { after: '1', title: '溢出章', content: '正文' } }));
  assert.equal(ins.status, 409, 'insert 也必须复核单本上限');
  assert.equal(JSON.parse(await store.getText(KEY.book(id2))).chapters.length, CHAPTER_MAX);
  assert.equal(store._map.has(KEY.text(id2, 'x')), false);
});

/* ---------------- P3-6 apiPutRaw 三道守卫 ---------------- */

test('P3-6 原件上传必须有「书存在 / 未发布 / 不在回收站」三道守卫', async () => {
  const store = memStore();
  const cookie = await login(store);
  const body = () => new TextEncoder().encode('raw-bytes');

  const ghost = await call(store, req('/api/books/n_ghost/raw', { method: 'PUT', cookie, body: body() }));
  assert.equal(ghost.status, 404, '书不存在必须 404（旧实现任意合法 id 都能写 ≤50MB 原件）');
  assert.equal(store._map.has(KEY.raw('n_ghost')), false, '不许落下无法归属的原件');

  const { id } = await makeReadyBook(store, cookie, '已发布书', 1);
  const onReady = await call(store, req(`/api/books/${id}/raw`, { method: 'PUT', cookie, body: body() }));
  assert.equal(onReady.status, 409, '已发布书的原件必须走「更新已有书」（否则原件与章表不对版）');

  const draft = 'b0004';
  await store.putText(KEY.book(draft), JSON.stringify({ ...meta(draft), status: 'creating', chapters: [{ key: '1', title: '第1章' }] }));
  await store.putText(KEY.TRASH, JSON.stringify({ books: [{ id: draft, title: 'x', deletedAt: Date.now() }] }));
  const inTrash = await call(store, req(`/api/books/${draft}/raw`, { method: 'PUT', cookie, body: body() }));
  assert.equal(inTrash.status, 409, '回收站里的书不许续传原件（purge 会连 raw 一起删，纯白传）');
  assert.equal(store._map.has(KEY.raw(draft)), false);
});

/* ---------------- P3-7 replace 活键取新旧并集 ---------------- */

test('P3-7 replace 在 CAS 失败前不得删掉旧章表仍在引用的正文（活键取并集）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const id = 'b0005';
  const chapters = [1, 2, 3].map((n) => ({ key: String(n), title: '第' + n + '章' }));
  // 历史脏数据：orphans 与章表重叠（第 3 章既在章表又在孤儿表里）
  await base.putText(KEY.book(id), JSON.stringify({ ...meta(id), status: 'creating', chapters, orphans: ['3'] }));
  for (const n of [1, 2, 3]) await base.putText(KEY.text(id, String(n)), '正文' + n);
  await writeIdxBooks(base, [meta(id, { status: 'creating' })]);
  // 让 meta 的 CAS 恒失败 → 本轮一定 409，章表一个字都不会改
  const store = { ...base, putTextIf: (k, s, e) => (k === KEY.book(id) ? null : base.putTextIf(k, s, e)) };

  const r = await call(store, req(`/api/books/${id}/chapters`, { method: 'POST', cookie, body: { op: 'replace', chapters: ['甲', '乙'] } }));
  assert.equal(r.status, 409, '前置：CAS 必须失败（章表未改）');
  assert.ok(base._map.has(KEY.text(id, '3')), '旧章表仍引用第 3 章 —— CAS 失败后它必须还在（删了就是阅读 404 且无法回滚）');
});

/* ---------------- P3-8 进度镜像先判在架 ---------------- */

test('P3-8 书不在架时进度写入不得退化成全量读索引', async () => {
  const base = memStore();
  const cookie = await login(base);
  await writeIdxShards(base, [[meta('b0006')], [meta('b0007')]]);
  const reads = [];
  const store = {
    ...base,
    async getText(k) {
      if (/^meta\/idx\/s\d+\.json$/.test(k)) reads.push(k);
      return base.getText(k);
    },
  };
  const r = await call(store, req('/api/progress/n_ghost', { method: 'PUT', cookie, body: { ch: 1, ratio: 0.2 } }));
  assert.equal(r.status, 200);
  assert.equal(reads.length, 0, '不在架的书不该读任何分片（旧实现单书模式找不到就回落全量 = 1+K），实际读了 ' + reads.join(','));
  assert.equal(r.data.updatedAt > 0, true, '进度真值仍要落盘并回传 updatedAt（客户端 OCC 基线）');
});

test('P3-8b 书在架时进度写入仍只读 1 次 root（判在架那次读必须透传给 openIndex）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const id = 'b0099';
  await base.putText(KEY.book(id), JSON.stringify({ ...meta(id), status: 'ready', chapters: [{ key: '1', title: '第1章' }] }));
  await writeIdxBooks(base, [meta(id, { status: 'ready' })]);
  let rootReads = 0;
  let shardReads = 0;
  const store = {
    ...base,
    async getText(k) {
      if (k === KEY_IDX.root) rootReads++;
      if (/^meta\/idx\/s\d+\.json$/.test(k)) shardReads++;
      return base.getText(k);
    },
    async getTextWithEtag(k) {
      if (k === KEY_IDX.root) rootReads++;
      if (/^meta\/idx\/s\d+\.json$/.test(k)) shardReads++;
      return base.getTextWithEtag(k);
    },
  };
  const r = await call(store, req(`/api/progress/${id}`, { method: 'PUT', cookie, body: { ch: 1, ratio: 0.3 } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 判在架读 1 次 root，openIndex 复用同一次读（不再自读）→ 合计仍是 1；
  // 若哪天把 rootRaw 透传丢了，这里会变成 2（热路径每个进度写入多花一个子请求）。
  assert.equal(rootReads, 1, 'root 只该被读 1 次（实测 ' + rootReads + '）');
  assert.equal(shardReads, 1, '在架书只该读它所在的那一片（实测 ' + shardReads + '）');
});

/* ---------------- P3-9 OPDS filename* ---------------- */

test('P3-9 下载文件名按 RFC 5987 编码括号（encodeURIComponent 不转义 ()*）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '测试(1)*书', 1);
  const basic = 'Basic ' + Buffer.from('r:' + ENV.ADMIN_PASSWORD).toString('base64');
  const r = await call(store, req(`/export/${id}.txt`, { headers: { authorization: basic } }));
  assert.equal(r.status, 200, r.text);
  const cd = r.headers.get('content-disposition') || '';
  assert.ok(cd.includes('%28') && cd.includes('%29'), '左/右括号必须百分号编码：' + cd);
  assert.ok(cd.includes('%2A'), '星号必须百分号编码（RFC 5987 的 attr-char 不含 *）：' + cd);
  assert.ok(!/filename\*=UTF-8''[^;]*[()*]/.test(cd), '不得出现未编码的 ()*：' + cd);
});

/* ---------------- P3-10 请求体为 JSON null ---------------- */

test('P3-10 请求体是 JSON null 时给 400/401，不是 500', async () => {
  const store = memStore();
  const cookie = await login(store);
  const created = await call(store, req('/api/books', { method: 'POST', cookie, body: null }));
  assert.equal(created.status, 400, 'null 请求体应落到「书名不能为空」，而不是 TypeError → 500');
  const bad = await call(store, req('/api/books', { method: 'POST', cookie, body: 'null' }));
  assert.equal(bad.status, 400);
  const loginNull = await call(store, req('/api/login', { method: 'POST', body: null }));
  assert.equal(loginNull.status, 401, '免鉴权入口更不能因一个 null 吐 500');
  // 注：/api/books 的 400 其实是 normalizeBookInput 兜的，测不到 readJsonBody 这一层。
  // 进度接口是直接读 body.ch 的 —— null 不兜成空对象就是 TypeError → 500。
  const prog = await call(store, req('/api/progress/n_nullbody', { method: 'PUT', cookie, body: null }));
  assert.equal(prog.status, 200, 'JSON null 走进度接口应兜成空对象（ch=0），不得 500');
});

/* ---------------- P3-11 建书规范化 ---------------- */

test('P3-11 建书：wordCount 夹 ≥0，判重与落盘共用同一份规范化结果', async () => {
  const store = memStore();
  const cookie = await login(store);
  const r = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: '  负字数书  ', chapters: ['只有一章'], wordCount: -5, cleanVer: 1 } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = JSON.parse(await store.getText(KEY.book(r.data.id)));
  assert.equal(m.wordCount, 0, 'wordCount 必须夹到 ≥0（Number(-5) || 0 会原样返回 -5）');
  assert.equal(m.title, '负字数书', '书名按规范化结果落盘（去首尾空白）');
  // 判重只看**在架**书（草稿不进索引）→ 先造一本已发布的同名书
  await makeReadyBook(store, cookie, '在架书', 1);
  const dup = await call(store, req('/api/books', { method: 'POST', cookie, body: { title: ' 在架书  ', chapters: ['另一章'] } }));
  assert.equal(dup.status, 200);
  assert.equal(dup.data.duplicate, true, '首尾空白不同的同名书必须判重（判重与落盘必须用同一份规范化结果）');
  assert.equal(dup.data.book.title, '在架书');
});
