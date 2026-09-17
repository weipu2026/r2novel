/* review-fix9.test.mjs — 2026-09-17 晚复查（82833cb 之后的 F1-F7 修复）回归用例。
 * 每条用例都先在旧实现上红、新实现上绿（反向探针 probe-reverse-fix9.py 逐条验证过）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memStore, req, call, login, writeIdxShards, ENV } from './_harness.mjs';

const ROOT = 'meta/idx/root.json';
const SHARD = (n) => `meta/idx/s${n}.json`;
const TRASH = 'meta/trash.json';
const BRUTE = 'meta/sec/brute.json';

const mkEntry = (i) => ({
  id: 'b' + String(i).padStart(4, '0'),
  title: '书' + i,
  author: 'a',
  tags: [],
  pinned: false,
  finished: false,
  star: false,
  chapterCount: 1,
  wordCount: 1,
  createdAt: 1700000000000 + i,
  updatedAt: 1700000000000 + i,
});

async function makeReadyBook(store, cookie, title, n) {
  const chapters = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '章 章' + (i + 1));
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title, author: '作者', chapters, wordCount: n * 10, cleanVer: 1 } })
  );
  assert.equal(r.status, 200);
  const id = r.data.id;
  for (let i = 0; i < n; i++) {
    await call(store, req(`/api/books/${id}/chapters/${i + 1}`, { method: 'PUT', cookie, body: '第' + (i + 1) + '章正文内容，用于测试。' }));
  }
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  return { id, title };
}

/* ── F4：/api/* 顶层兜底 —— 未捕获异常必须以 JSON 500 返回，而非 Cloudflare 1101 HTML ── */
test('F4：未捕获异常转 JSON 500 且错误信息可见（旧实现裸抛 → call 直接 reject）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const store = {
    ...base,
    async getText(k) {
      if (k === ROOT) throw new Error('inject boom');
      return base.getText(k);
    },
  };
  const r = await call(store, req('/api/books', { cookie }));
  assert.equal(r.status, 500, '必须以 500 响应（旧实现异常冒到 handleRequest 之外，Workers 冒 1101 HTML）');
  assert.match(String(r.data && r.data.error), /inject boom/, '真实错误信息必须进 JSON body，前端才能展示');
  assert.match(String(r.headers.get('content-type') || ''), /json/i, '响应必须是 JSON');
});

/* ── F2：save() 重放 patch 撞上并发软删 → 跳过而不是 500 ──
 * 交错（确定性注入）：A 改名的分片 CAS 写「失败一次」，失败前并发方 B 抢先软删了同一本书
 * → A 重放时书已不在盘面 map 里。旧实现 again.patch 抛「不在已加载分片」→ 500。 */
test('F2：重放 patch 撞并发软删必须跳过（不得 500）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const { id } = await makeReadyBook(base, cookie, '重放甲', 2);
  let fired = false;
  const store = {
    ...base,
    async putTextIf(k, s, e) {
      if (!fired && k.startsWith('meta/idx/s')) {
        fired = true;
        // 并发方 B：抢在 A 的写落盘前软删同一本书（走 base，不受注入影响）
        const del = await call(base, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
        assert.equal(del.status, 200, '并发软删应成功（此刻书还在盘上）');
        return null; // 版本已变 → A 的 save 撞 CAS 冲突 → 重放
      }
      return base.putTextIf(k, s, e);
    },
  };
  const r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { title: '改名' } }));
  assert.equal(r.status, 200, '重放撞软删必须跳过（旧实现 again.patch 抛错 → 500）');
  // 软删语义保持：索引与书架都没有它，trash 里有
  const shelf = await call(base, req('/api/books', { cookie }));
  assert.equal(shelf.data.books.filter((x) => x.id === id).length, 0, '书应保持已删（软删赢下竞态）');
  assert.ok(JSON.parse(base._map.get(TRASH)).books.some((x) => x.id === id), 'trash 里必须有它');
});

/* ── F1：恢复撞并发再软删 → 不得把刚写回的 trash 条目吃掉 ──
 * 交错：A 恢复的**分片写成功后**、trash CAS 前，并发方 B 把同一本书又软删了一次
 * （trash 出现 deletedAt 更新的新条目）。A 的 trash CAS 撞冲突 → 重放。旧实现按 id
 * splice 把 B 的新条目吃掉 → 书既不在架也不在回收站。 */
test('F1：恢复×并发软删，trash 条目必须保留（不得书架回收站两不见）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const { id } = await makeReadyBook(base, cookie, '恢复甲', 2);
  let r = await call(base, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
  assert.equal(r.status, 200);

  let fired = false;
  const store = {
    ...base,
    async putTextIf(k, s, e) {
      const res = await base.putTextIf(k, s, e);
      if (!fired && res && k.startsWith('meta/idx/s')) {
        fired = true;
        // 并发方 B：A 的索引写刚落盘（书被写回索引），B 立刻又软删一次
        const del = await call(base, req(`/api/books/${id}`, { method: 'DELETE', cookie }));
        assert.equal(del.status, 200, '并发再软删应成功');
      }
      return res;
    },
  };
  r = await call(store, req(`/api/books/${id}/restore`, { method: 'POST', cookie }));
  assert.equal(r.status, 200);
  const shelf = await call(base, req('/api/books', { cookie }));
  assert.equal(shelf.data.books.filter((x) => x.id === id).length, 0, '并发软删应赢下索引（最后一次索引写是 B 的 remove）');
  const trash = JSON.parse(base._map.get(TRASH)).books;
  assert.ok(
    trash.some((x) => x.id === id),
    'trash 条目必须保留（旧实现重放 splice 只认 id → 把 B 刚写回的条目吃掉，书彻底消失）'
  );
});

/* ── F5：updateBrute 耗尽路径守 dirty —— 并发已清空的记录不得凭空写回 ──
 * putIf 恒失败（连续 4 次 CAS 冲突）→ 走耗尽路径；耗尽重读时记录已被并发方清走
 * → mutate 返回 dirty:false。旧实现不检查、无条件 putText，把整份空表写回。 */
test('F5：brute 耗尽路径 dirty:false 不得写盘', async () => {
  const base = memStore();
  await call(base, req('/api/login', { method: 'POST', body: { password: 'wrong' } })); // 记 1 次失败
  const before = base._map.get(BRUTE);
  assert.ok(before && before.includes('"fail":1'), '前置：失败记录已落盘');

  let casFails = 0;
  const store = {
    ...base,
    async putTextIf() {
      casFails++;
      return null; // 恒冲突
    },
    async getText(k) {
      if (k === BRUTE && casFails >= 4) return null; // 耗尽重读：记录已被并发 clear 清走
      return base.getText(k);
    },
  };
  const r = await call(store, req('/api/login', { method: 'POST', body: { password: ENV.ADMIN_PASSWORD } }));
  assert.equal(r.status, 200, '登录应成功（并触发 bruteClear）');
  assert.equal(casFails, 4, '前置：确实走了 4 次 CAS 冲突 + 耗尽路径');
  assert.equal(
    base._map.get(BRUTE),
    before,
    '耗尽路径 dirty:false 必须不写盘（旧实现无条件 putText 把并发状态整份覆盖）'
  );
});

/* ── F6：主片 CAS 写以 rejection 失败时，片 bak 的 rejection 必须有人接管 ──
 * 旧实现 bakP 只在 putIf 成功分支里 await —— putIf 一 rejection，bakP 成孤儿，
 * unhandledRejection 在 dev-server（Node ≥15）默认策略下会打死整个进程。 */
test('F6：bak 写 rejection 必须被接管（零 unhandledRejection）', async () => {
  const base = memStore();
  const cookie = await login(base);
  const { id } = await makeReadyBook(base, cookie, '悬挂甲', 2);
  const unhandled = [];
  const onUh = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUh);
  try {
    const store = {
      ...base,
      putText: (k, v) => {
        if (k === SHARD(0) + '.bak') return Promise.reject(new Error('inject bak fail'));
        return base.putText(k, v);
      },
      async putTextIf(k) {
        if (k === SHARD(0)) throw new Error('inject main fail'); // 主片写以 rejection（非返回 null）失败
        return base.putTextIf(k, arguments[1], arguments[2]);
      },
    };
    const r = await call(store, req(`/api/books/${id}`, { method: 'PATCH', cookie, body: { title: 'x' } }));
    assert.equal(r.status, 500, '主片写失败应让请求失败');
    await new Promise((r2) => setImmediate(r2));
    await new Promise((r2) => setImmediate(r2));
    assert.equal(unhandled.length, 0, 'bak 的 rejection 必须被接管（旧实现出现 unhandledRejection）');
  } finally {
    process.off('unhandledRejection', onUh);
  }
});

/* ── F7：fresh 判据必须覆盖「缺失片」（raw=undefined）—— 片先于 root 落盘 ──
 * 旧实现只认 raw===null（本次新建），缺失片（文件被外部删除，raw=undefined）退化成
 * 「root 先落」→ root.map 指向尚未重建的片 = 指针领先于盘。 */
test('F7：缺失片上发布必须「片先落、root 后落」', async () => {
  const base = memStore();
  const cookie = await login(base);
  await writeIdxShards(base, [[mkEntry(1)]]); // 1 片
  base._map.delete(SHARD(0));
  base._map.delete(SHARD(0) + '.bak'); // 主+bak 都删 = missing（有 bak 会走 broken 拒写，语义不同）

  const order = [];
  const store = {
    ...base,
    async putTextIf(k, s, e) {
      order.push(k);
      return base.putTextIf(k, s, e);
    },
  };
  // POST /api/books 只建半成品（不写索引）→ 必须跑完传章 + publish，新书才会进索引分片
  let r = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: { title: '缺失片新书', chapters: ['第一章'], wordCount: 5, cleanVer: 1 } })
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.id;
  await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: '第一章正文。' }));
  r = await call(store, req(`/api/books/${id}/publish`, { method: 'POST', cookie }));
  const iShard = order.indexOf(SHARD(0));
  const iRoot = order.indexOf(ROOT);
  assert.ok(iShard >= 0, '新书应写入缺失片（重建该片区）');
  assert.ok(iRoot >= 0, 'root 应被写（map 新增成员）');
  assert.ok(iShard < iRoot, '缺失片必须先于 root 落盘（旧实现 raw===null 判据漏掉 undefined → root 先落）');
});
