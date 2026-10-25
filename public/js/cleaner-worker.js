/* cleaner-worker.js — 清洗引擎的 Worker 壳（#149 P1-B）
 *
 * 只做一件事：把 processBook 搬到 Worker 里跑，让 10~50 MB 的解析不再冻结页面。
 * cleaner.js 本身**一行不改** —— 它仍是浏览器 / Node 共用的同步纯函数，
 * 464 条单测还跑在它上面（把纯函数改成 async 会把那层保护一起拆掉）。
 *
 * 消息契约（与 cleaner-client.js 对应）：
 *   收 { id, bytes, opts }
 *   发 { id, ok:true, result, ms } | { id, ok:false, error }
 */
import { processBook } from './cleaner.js';

self.onmessage = (e) => {
  const { id, bytes, opts } = e.data || {};
  try {
    const t0 = Date.now();
    const result = processBook(bytes, opts);
    self.postMessage({ id, ok: true, result, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
