/* body-limit.test.mjs — 请求体护栏回归：流式有界读取（防 OOM / gzip 炸弹）
 *
 * 背景：/api/login 是唯一免鉴权入口，旧实现只看 Content-Length，chunked（不声明长度）
 * 的超大请求会被 req.arrayBuffer() 整体读进内存 → Worker 128MB 上限被打爆。
 * 现改为流式计数读取：超限瞬间中断管道。本文件锁定该行为不回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { BASE, ENV, memStore, req, call, login } from './_harness.mjs';

/** 用 CompressionStream 生成 gzip 字节（前端上传原件走的正是这条路径） */
async function gzip(str) {
  const cs = new CompressionStream('gzip');
  const buf = await new Response(new Response(str).body.pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

function streamBody(totalBytes, chunk = 8192) {
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= totalBytes) {
        ctrl.close();
        return;
      }
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      ctrl.enqueue(new Uint8Array(n).fill(0x61)); // 'a'
    },
  });
}

test('login：声明 Content-Length 超 64KB → 413（快速拒绝路径）', async () => {
  const store = memStore();
  const big = JSON.stringify({ password: 'x'.repeat(70000) });
  const r = await call(store, req('/api/login', { method: 'POST', body: big }));
  assert.equal(r.status, 413);
});

test('login：chunked 无 Content-Length 的超大请求 → 413（旧实现可被绕过）', async () => {
  const store = memStore();
  const r = await call(
    store,
    req('/api/login', { method: 'POST', body: streamBody(200000), headers: { 'content-type': 'application/json' } })
  );
  assert.equal(r.status, 413);
});

test('login：正常小体积体仍可登录（护栏不误伤）', async () => {
  const store = memStore();
  const cookie = await login(store);
  assert.ok(cookie.length > 20);
});

test('login：非法 JSON → 401 口令错误（不泄露解析细节）', async () => {
  const store = memStore();
  const r = await call(store, req('/api/login', { method: 'POST', body: 'not-json{' }));
  assert.equal(r.status, 401);
});

test('单章 PUT：明文超 MAX_CHAPTER → 413，且不落盘', async () => {
  const store = memStore();
  const cookie = await login(store);
  const c = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: JSON.stringify({ title: '超限测试', chapters: ['第1章'] }) })
  );
  assert.equal(c.status, 200);
  const { id } = c.data;
  const r = await call(store, req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: streamBody(3 * 1024 * 1024) }));
  assert.equal(r.status, 413);
  assert.equal(store._map.get(`text/${id}/1.txt`), undefined, '超限章节不应落盘');
});

test('单章 PUT：小体积 gzip 体正常解压入库（解压路径不回归）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const c = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: JSON.stringify({ title: 'gzip测试', chapters: ['第1章'] }) })
  );
  assert.equal(c.status, 200);
  const { id } = c.data;
  const payload = '你好，世界。'.repeat(50);
  const gz = await gzip(payload);
  const r = await call(
    store,
    req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: gz, headers: { 'x-content-gzip': '1' } })
  );
  assert.equal(r.status, 200);
  assert.equal(store._map.get(`text/${id}/1.txt`), payload);
});

test('单章 PUT：gzip 炸弹（压缩体 3KB → 解压 3MB）→ 413', async () => {
  const store = memStore();
  const cookie = await login(store);
  const c = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: JSON.stringify({ title: '炸弹测试', chapters: ['第1章'] }) })
  );
  assert.equal(c.status, 200);
  const { id } = c.data;
  const gz = await gzip('a'.repeat(3 * 1024 * 1024));
  assert.ok(gz.byteLength < 64 * 1024, `压缩体应远小于上限，实际 ${gz.byteLength}`);
  const r = await call(
    store,
    req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: gz, headers: { 'x-content-gzip': '1' } })
  );
  assert.equal(r.status, 413);
  assert.equal(store._map.get(`text/${id}/1.txt`), undefined, '炸弹不应落盘');
});

test('单章 PUT：gzip 数据损坏 → 400（不误报为超限）', async () => {
  const store = memStore();
  const cookie = await login(store);
  const c = await call(
    store,
    req('/api/books', { method: 'POST', cookie, body: JSON.stringify({ title: '损坏测试', chapters: ['第1章'] }) })
  );
  assert.equal(c.status, 200);
  const { id } = c.data;
  const bad = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
  const r = await call(
    store,
    req(`/api/books/${id}/chapters/1`, { method: 'PUT', cookie, body: bad, headers: { 'x-content-gzip': '1' } })
  );
  assert.equal(r.status, 400);
});
