/* batch-queue.js — 批量操作的「分批 + 后端预算裁剪续调」队列（纯逻辑，无 DOM，node 可直接 import 单测）
 *
 * 为什么单独成模块：POST /api/books/batch 受 Cloudflare「单次请求 48 子请求」硬顶约束，
 * 目标散在多分片时会**贪心裁剪**——只处理预算内的前 N 本，其余 id 放在 `deferred` 里回传。
 * 「把 deferred 排回队列继续处理」这段逻辑以前不存在（app.js 只把差数计成「失败：可能是半成品书」），
 * 被裁的书就**静默丢了**：v2 分片后书库 ≥1501 本（4 片起）、18 个目标散在 5 片上时实测只处理 16 本，
 * 且用户看到的是「2 本失败（可能是半成品书）」——不会去重试，那 2 本书的标签/完结状态永远改不动。
 * 逻辑放这儿是为了能测：`test/batch-queue.test.mjs` 用假后端复刻同一套裁剪规则来跑（含反证：
 * 不读 deferred 的旧写法在同一后端下必然少处理 1 本）。
 */

/**
 * 分批调用 send 直到全部处理完（含后端预算裁剪的续调）。
 * @param {string[]} ids 全部目标 id
 * @param {number} pageSize 单批上限（= BATCH_BOOKS_MAX，后端也只认这么多）
 * @param {(batch: string[]) => Promise<{updated?: number, deferred?: string[]}>} send 单批请求
 * @param {(done: number, total: number) => void} [onProgress] 进度回调（done=已出队数量）
 * @returns {Promise<{ok: number, fail: number}>} ok=后端 updated 之和（真正落库的本数），
 *          fail=选了但没落库的本数（不在架/半成品/被裁后仍失败）
 */
export async function runBatched(ids, pageSize, send, onProgress) {
  const total = ids.length;
  const size = Math.max(1, Math.floor(Number(pageSize)) || 1);
  let queue = ids.slice();
  let ok = 0;
  let rounds = 0;
  // 防御性上限：正常每轮至少推进 1 本（单本预算 est=6，永远进得了 48 的顶），total*2 纯属兜底，
  // 防止「后端行为诡异 + 每轮只退 1 本」把页面卡在忙碌层里出不来。
  const maxRounds = total * 2 + 8;
  while (queue.length && rounds++ < maxRounds) {
    const batch = queue.slice(0, size);
    const rest = queue.slice(batch.length);
    let resp = null;
    try {
      resp = await send(batch);
    } catch {
      resp = null; // 单批失败：整批计入失败、不原地重试（沿用旧行为，避免网络抖动时死磕）
    }
    ok += Number(resp && resp.updated) || 0;
    // 只认「本轮真的发出去的 id」里回传的 deferred：后端回传别的东西也不会污染队列
    const deferred = resp && Array.isArray(resp.deferred) ? resp.deferred.filter((id) => batch.includes(id)) : [];
    if (deferred.length >= batch.length) break; // 整批被退回＝零进展，再试还是同样结果，收手
    queue = deferred.concat(rest);
    if (onProgress) onProgress(total - queue.length, total);
  }
  return { ok, fail: Math.max(0, total - ok) };
}
