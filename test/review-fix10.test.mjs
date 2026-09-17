/* review-fix10.test.mjs — 2026-09-17 第二轮复检（审 2bc54df「修复本身」）的回归用例。
 *
 * 为什么单独一个文件：这批缺陷的共同点是**只在特定规模/时序下才出现**，既有用例
 * （batch-tags 只造 2 本书、分片预算用例只造 3 片）根本碰不到预算边界——
 * 上一轮 177 条全绿而「标签治理在大库上恒零进展」的回归照样溜过去了。
 *
 * 每条都先在旧实现上红、新实现上绿（反向探针 probe-reverse-fix10.py 逐条验证）：
 *   R1 大分片库标签合并必须推进（K≥20；旧公式下 updated 恒为 0）
 *   R2 编辑章节撞并发软删 → 不得 500 而盘上已改
 *   R3 预算敏感端点必须限死重放次数（连续两次冲突时子请求不得越界）
 *   R4 save() 成功后必须清 opLog（否则复用 handle 会重放上一轮陈旧改动）
 *   R5 重放跳过的 patch 不得计入 updated
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore, req, call, login, writeIdxShards, readIdxBooks, countStore } from './_harness.mjs';
import { openIndex } from '../src/router.js';

const ROOT = 'meta/idx/root.json';
const SHARD = (n) => `meta/idx/s${n}.json`;
const TRASH = 'meta/trash.json';

const mkEntry = (i, tags = []) => ({
  id: 'b' + String(i).padStart(4, '0'),
  title: '书' + i,
  author: 'a',
  tags,
  pinned: false,
  finished: false,
  star: false,
  chapterCount: 1,
  wordCount: 1,
  createdAt: 1700000000000 + i,
  updatedAt: 1700000000000 + i,
});

async function makeReadyBook(store, cookie, title, n = 1, tags = []) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', tags, chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.id;
  for (let i = 0; i < n; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '第' + (i + 1) + '章正文内容。' }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id, title };
}

/** 6 本已发布书各占一片 —— 预算最吃紧的形状（每加一本就是一个新脏分片） */
async function sixShardLib() {
  const base = memStore();
  const counted = countStore(base);
  const cookie = await login(counted);
  const books = [];
  for (let i = 1; i <= 6; i++) books.push(await makeReadyBook(counted, cookie, '批量书' + i, 1));
  await writeIdxShards(counted, books.map((b, i) => [{ ...mkEntry(i + 1), id: b.id, title: b.title }]));
  return { base, counted, cookie, books };
}

const spent = (counted) => counted._count.get + counted._count.put;

/* ---------------- R1：大分片库上的标签治理 ---------------- */

test('R1 标签合并：K=20 片（≈1 万本量级）仍必须推进，不得恒零进展', async () => {
  const base = memStore();
  const store = countStore(base);
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '标签书', 1, ['x']);

  // 手工铺成 20 片：书在 s0，其余为空片（root.shards=20，等价于曾经的 1 万本库）
  const groups = Array.from({ length: 20 }, (_, i) => (i === 0 ? [{ ...mkEntry(1, ['x']), id }] : []));
  await writeIdxShards(store, groups);

  const before = spent(store);
  const r = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: 'x', to: 'y' } }));
  const used = spent(store) - before;

  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.updated, 1, '必须真的改动一本（旧公式下恒为 0）');
  assert.equal(r.data.remaining, 0);
  const meta = JSON.parse(await store.getText(`meta/${id}.json`));
  assert.deepEqual(meta.tags, ['y'], 'meta 也必须改到');
  assert.ok(used <= 50, `子请求 ${used} 越界`);
});

test('R1 标签合并撞 CAS 冲突：返回可续调响应（不 500），重发一轮后补齐', async () => {
  const base = memStore();
  const counted = countStore(base);
  const cookie = await login(counted);
  const { id } = await makeReadyBook(counted, cookie, '冲突书', 1, ['x']);
  await writeIdxShards(counted, Array.from({ length: 20 }, (_, i) => (i === 0 ? [{ ...mkEntry(1, ['x']), id }] : [])));

  // 只让第一次分片条件写失败 → 制造一次 CAS 冲突（改标签只碰分片、不动 root.map，
  // 所以 writeRoot 会早退，冲突必然发生在分片写上）；全量模式不做内部重放 → 端点必须回可续调响应
  let fired = false;
  const store = {
    ...counted,
    async putTextIf(k, s, e) {
      if (!fired && k === SHARD(0)) {
        fired = true;
        counted._count.put++; // 失败的条件写在生产里同样是一次子请求，计数要诚实
        return null;
      }
      return counted.putTextIf(k, s, e);
    },
  };

  const r1 = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: 'x', to: 'y' } }));
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.updated, 0);
  assert.equal(r1.data.remaining, 1);
  assert.equal(r1.data.retry, true, '必须明确告诉客户端「再发一次」而不是静默零进展');
  assert.equal(JSON.parse(await counted.getText(`meta/${id}.json`)).tags[0], 'y', 'meta 侧那批写入已完成');

  // 前端 tagMergeRun 就是靠 remaining>0 续调的：重发一轮把索引补齐
  const r2 = await call(store, req('/api/tags', { method: 'POST', cookie, body: { from: 'x', to: 'y' } }));
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.equal(r2.data.updated, 1);
  assert.equal(r2.data.remaining, 0);
  assert.deepEqual(JSON.parse(await counted.getText(`meta/${id}.json`)).tags, ['y']);
});

/* ---------------- R2：编辑章节 × 并发软删 ---------------- */

test('R2 编辑章节撞并发软删：不得 500（盘上已改却报失败）', async () => {
  const base = memStore();
  const store = countStore(base);
  const cookie = await login(store);
  const { id } = await makeReadyBook(store, cookie, '被并发删的书', 1);

  // 在「meta 写盘」这一刻把书从索引摘掉（模拟另一个标签页刚软删），再让本次请求继续跑下去
  let fired = false;
  const injected = {
    ...store,
    async putText(k, s) {
      if (!fired && k === `meta/${id}.json`) {
        fired = true;
        const root = JSON.parse(await base.getText(ROOT));
        delete root.map[id];
        await base.putText(SHARD(0), JSON.stringify({ books: [] }));
        await base.putText(ROOT, JSON.stringify(root));
      }
      return store.putText(k, s);
    },
  };

  const r = await call(injected, req(`/api/books/${id}/chapters/1`, { method: 'PATCH', cookie, body: { title: '改后的标题' } }));
  assert.equal(r.status, 200, '旧实现会抛「书不在已加载分片中」→ 500：' + JSON.stringify(r.data));
  const meta = JSON.parse(await base.getText(`meta/${id}.json`));
  assert.equal(meta.chapters[0].title, '改后的标题', '正文/meta 确实写进去了（响应必须与之相符）');
  assert.equal(
    await base.getText(ROOT).then((t) => !!JSON.parse(t).map[id]),
    false,
    '书已被并发软删摘除，索引不该被写回'
  );
});

/* ---------------- R3：预算敏感端点必须限死重放次数 ---------------- */

test('R3 删除批量：一次重放 + trash 重试耗尽，子请求仍不越界且真的删掉', async () => {
  const { counted, cookie, books } = await sixShardLib();

  let rootFails = 0;
  let trashFails = 0;
  const store = {
    ...counted,
    async putTextIf(k, s, e) {
      if (k === ROOT && rootFails < 1) {
        rootFails++;
        counted._count.put++; // 失败的条件写也是一次子请求
        return null; // 一次索引 CAS 冲突 → 逼出一次重放
      }
      if (k === TRASH && trashFails < 3) {
        trashFails++;
        counted._count.put++; // 逼出 updateTrash 的重试轮与耗尽兜底
        return null;
      }
      return counted.putTextIf(k, s, e);
    },
  };

  const before = spent(counted);
  const r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: books.map((b) => b.id), action: 'delete' } }));
  const used = spent(counted) - before;

  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(rootFails, 1, '那次冲突必须真的发生过');
  assert.equal(trashFails, 3, 'trash 的重试轮必须真的跑过');
  assert.ok(r.data.updated >= 1, '不得因为预扣过狠而零进展：' + JSON.stringify(r.data));
  assert.ok(used <= 48, `子请求 ${used} 越过预算硬线`);
});

test('R3 删除批量：连续两次索引冲突不得把子请求顶破 50（重放次数必须限死）', async () => {
  const { counted, cookie, books } = await sixShardLib();

  let rootFails = 0;
  const store = {
    ...counted,
    async putTextIf(k, s, e) {
      if (k === ROOT && rootFails < 2) {
        rootFails++;
        counted._count.put++;
        return null; // 连续两次冲突：旧写法（默认允许 2 次重放）会一路重放到底
      }
      return counted.putTextIf(k, s, e);
    },
  };

  const before = spent(counted);
  const r = await call(store, req('/api/books/batch', { method: 'POST', cookie, body: { ids: books.map((b) => b.id), action: 'delete' } }));
  const used = spent(counted) - before;

  assert.equal(rootFails, 2, '两次冲突都必须真的发生过');
  assert.ok(used <= 50, `子请求 ${used} 越过 Workers 50 硬顶（敞开了重放就会踩到）`);
  assert.ok([200, 409].includes(r.status), `不得 500/1101，只允许「成功」或「可重试的 409」：${r.status} ${JSON.stringify(r.data)}`);
  // 放弃重放时必须是「什么都没落盘」，不能留半套：索引里 6 本都还在，删了一次也没生效
  const left = await readIdxBooks(counted);
  assert.equal(left.filter((b) => books.some((x) => x.id === b.id)).length, 6, '放弃重放时必须整体未生效，不得半套');
});

test('R3 批量改标签（非删除路径）：连续两次冲突同样不得顶破 50', async () => {
  const { counted, cookie, books } = await sixShardLib();

  let shardFails = 0;
  const store = {
    ...counted,
    async putTextIf(k, s, e) {
      // 改标签只碰分片（root.map 不变 → 不写 root），冲突必然发生在分片写上。
      // 只盯 s0：同一片在**每一轮**都失败，才能逼出「第二次冲突」（若在同一轮里失败两片，
      // 只会触发一次重放，测不出限次）。
      if (shardFails < 2 && k === SHARD(0)) {
        shardFails++;
        counted._count.put++;
        return null;
      }
      return counted.putTextIf(k, s, e);
    },
  };

  const before = spent(counted);
  const r = await call(
    store,
    req('/api/books/batch', { method: 'POST', cookie, body: { ids: books.map((b) => b.id), action: 'addTags', tags: ['x'] } })
  );
  const used = spent(counted) - before;

  assert.equal(shardFails, 2, '两次冲突都必须真的发生过');
  assert.ok(used <= 48, `子请求 ${used} 越过预算硬线（敞开了重放就会踩到）`);
  assert.ok([200, 409].includes(r.status), `不得 500/1101：${r.status} ${JSON.stringify(r.data)}`);

  // 分片是**并行写**的：冲突中断时可能已有若干片落盘（不像删除路径那样 root 先写、一失败即中止），
  // 所以这里不能断言「整体未生效」。能保证的是「不丢更新 + 可收敛」——重发一轮（无注入）后，
  // 本批覆盖到的书必须全部带上标签。另注：6 本里只有 5 本进得了预算（第 6 本被裁成 deferred）。
  const r2 = await call(
    counted,
    req('/api/books/batch', { method: 'POST', cookie, body: { ids: books.map((b) => b.id), action: 'addTags', tags: ['x'] } })
  );
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const left = await readIdxBooks(counted);
  assert.ok(
    left.filter((b) => (b.tags || []).includes('x')).length >= 5,
    '重发一轮后必须收敛：本批覆盖到的书都要带上标签'
  );
});

/* ---------------- R4：save() 成功后必须清空 opLog ---------------- */

test('R4 同一 handle 二次 save：冲突重放不得重放上一轮的陈旧改动', async () => {
  const store = memStore();
  const a = mkEntry(1);
  const b = mkEntry(2);
  await writeIdxShards(store, [[a, b]]);

  const h = await openIndex(store);
  h.upsert(a.id, { ...a, tags: ['第一轮'] });
  await h.save();

  // 并发方在这期间改了 A（并让该片版本变化 → 下一次 save 必撞冲突）
  await store.putText(SHARD(0), JSON.stringify({ books: [{ ...a, tags: ['并发方'] }, b] }));

  h.upsert(b.id, { ...b, tags: ['第二轮'] });
  await h.save(); // 撞冲突 → 重放；旧实现会把第一轮那份陈旧 A 快照一起写回

  const shard = JSON.parse(await store.getText(SHARD(0)));
  const gotA = shard.books.find((x) => x.id === a.id);
  const gotB = shard.books.find((x) => x.id === b.id);
  assert.deepEqual(gotA.tags, ['并发方'], '并发方写的值被上一轮的陈旧 opLog 覆盖 = 丢失更新');
  assert.deepEqual(gotB.tags, ['第二轮'], '本轮改动要照常落盘');
});

/* ---------------- R5：重放跳过的 patch 不得计入 updated ---------------- */

test('R5 批量改标签：重放时被并发删除的书不计入 updated', async () => {
  const base = memStore();
  const counted = countStore(base);
  const cookie = await login(counted);
  const b1 = await makeReadyBook(counted, cookie, '甲', 1);
  const b2 = await makeReadyBook(counted, cookie, '乙', 1);
  const a = { ...mkEntry(1), id: b1.id };
  const b = { ...mkEntry(2), id: b2.id };
  await writeIdxShards(counted, [[a, b]]);

  // 本批第一次分片写：先把甲从索引摘掉（模拟并发软删），再让写入失败 → 逼出重放
  let fired = false;
  const store = {
    ...counted,
    async putTextIf(k, s, e) {
      if (!fired && k === SHARD(0)) {
        fired = true;
        await base.putText(SHARD(0), JSON.stringify({ books: [b] }));
        await base.putText(ROOT, JSON.stringify({ v: 2, shards: 1, map: { [b.id]: 0 } }));
        counted._count.put++;
        return null;
      }
      return counted.putTextIf(k, s, e);
    },
  };

  const r = await call(
    store,
    req('/api/books/batch', { method: 'POST', cookie, body: { ids: [b1.id, b2.id], action: 'addTags', tags: ['x'] } })
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.updated, 1, '甲已被并发删除、patch 被跳过，不能算进 updated：' + JSON.stringify(r.data));
  assert.equal(r.data.skipped, 1);
});
