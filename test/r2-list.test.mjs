/* r2-list.test.mjs — worker.js r2Store.list() 分页语义单测
 * 背景：真实 R2 bucket.list() 是「每页 ≤1000、必须回传 cursor 才翻到下一页」；
 * 本地 fs/memStore 的 list 不分页，测试全绿也踩不到该路径——
 * 曾因 list() 漏传 cursor 导致生产「检查残留」每页重复读第 1 页、1000 之后的对象永不出现。
 * 本测试用模拟真实分页语义的 mock bucket 锁死行为：cursor 必须回传、pages 计数准确、
 * maxPages 截断置 truncated、前缀过滤生效、maxPages=0 不截断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { r2Store } from '../src/worker.js';

/** 模拟真实 R2：每页 page_size 个对象，不传 cursor 永远返回第一页 */
function mockBucket(keys, pageSize = 2) {
  let calls = 0;
  return {
    calls: () => calls,
    async list(opts = {}) {
      calls++;
      const filtered = keys.filter((k) => (opts.prefix ? k.startsWith(opts.prefix) : true));
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = filtered.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        objects: page.map((k) => ({ key: k, size: k.length })),
        truncated: next < filtered.length,
        cursor: next < filtered.length ? String(next) : undefined,
      };
    },
    // 其余方法本测试不涉及
    async get() { return null; }, async put() {}, async delete() {},
  };
}

test('list：cursor 逐页回传，跨多页收集全部对象（漏传 cursor 会重复第 1 页）', async () => {
  const keys = ['text/a/1.txt', 'text/a/2.txt', 'text/a/3.txt', 'text/a/4.txt', 'text/b/1.txt'];
  const bucket = mockBucket(keys, 2);
  const r = await r2Store(bucket).list('text/', 0);
  assert.deepEqual(r.objects.map((o) => o.key), keys);
  assert.equal(r.truncated, false);
  assert.equal(r.pages, 3);
  assert.equal(bucket.calls(), 3);
});

test('list：maxPages 截断 → truncated=true 且 pages 计数准确', async () => {
  const keys = ['meta/1.json', 'meta/2.json', 'meta/3.json', 'meta/4.json', 'meta/5.json'];
  const bucket = mockBucket(keys, 2);
  const r = await r2Store(bucket).list('meta/', 2); // 每页 2 个，最多翻 2 页 → 4 个，第 5 个不可见
  assert.equal(r.objects.length, 4);
  assert.equal(r.truncated, true);
  assert.equal(r.pages, 2);
  assert.equal(bucket.calls(), 2);
});

test('list：maxPages=0 不截断，翻完全部页', async () => {
  const keys = Array.from({ length: 7 }, (_, i) => `progress/n_${i}.json`);
  const bucket = mockBucket(keys, 3);
  const r = await r2Store(bucket).list('progress/', 0);
  assert.equal(r.objects.length, 7);
  assert.equal(r.truncated, false);
  assert.equal(r.pages, 3);
});

test('list：前缀过滤生效（不传 prefix = 全库）', async () => {
  const keys = ['meta/index.json', 'raw/n_1.txt', 'text/n_1/1.txt'];
  const bucket = mockBucket(keys, 2);
  const all = await r2Store(bucket).list('', 0);
  assert.equal(all.objects.length, 3);
  const raw = await r2Store(bucket).list('raw/', 0);
  assert.deepEqual(raw.objects.map((o) => o.key), ['raw/n_1.txt']);
});

test('list：空库 → 空结果、不截断', async () => {
  const bucket = mockBucket([], 2);
  const r = await r2Store(bucket).list('text/', 5);
  assert.deepEqual(r.objects, []);
  assert.equal(r.truncated, false);
  assert.equal(r.pages, 1);
});
