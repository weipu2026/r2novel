/**
 * r2novel — 防爆破（IP 哈希计数 + 指数退避锁）
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { clientIp, getWithEtag, tryParseJson, putIf } from './base.js';
import { KEY } from './const.js';

/* ---------------- 防爆破（R2 持久化：跨 isolate/重启有效；指数退避防长期锁死） ----------------
 * 计数按客户端 IP 的 SHA-256 前缀（不存明文 IP）。
 * fail 计数带 15 分钟滑动窗口：隔了一刻钟再试，重新计次，不累积冤枉。
 * 连错 BRUTE_LIMIT 次 → 锁 BRUTE_LOCK_MS × 2^(strikes-1)，封顶 BRUTE_LOCK_MAX_MS（默认 1 小时）。
 * 锁定期内即使口令正确也 429（防止绕过限速试探）；成功登录即清零。
 */
const BRUTE_FAIL_WINDOW = 15 * 60000;
const BRUTE_MAX_IPS = 5000; // brute.json 最多保留的 IP 记录数（防分布式伪造 IP 撑大文件）

const bruteCfg = (env) => ({
  limit: Number(env.BRUTE_LIMIT) || 5,
  lockMs: Number(env.BRUTE_LOCK_MS) || 10 * 60 * 1000,
  lockMaxMs: Number(env.BRUTE_LOCK_MAX_MS) || 60 * 60 * 1000,
});

async function ipHash(req) {
  const ip = clientIp(req);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('brute:' + ip));
  return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 归一变体：清掉过期条目 + 按数量截断（文件保持极小）。缺失/损坏 → 空表。 */
function normalizeBrute(b) {
  const now = Date.now();
  const ips = {};
  for (const [k, rec] of Object.entries((b && b.ips) || {})) {
    if ((rec.until || 0) > now || (rec.updatedAt || 0) > now - BRUTE_FAIL_WINDOW) ips[k] = rec;
  }
  // 上限保护：超量时按最近活跃裁掉最旧的（防御分布式伪造 IP 让 brute.json 无限膨胀）。
  // ⚠️ 锁定中的记录（until 在未来）**不参与淘汰**：按 updatedAt 排会把「失败满额刚锁上、
  // 但 updatedAt 较旧」的记录先删掉 → 锁静默解除（#145 P3-7，需 >5000 伪造 IP 才触发，
  // 但方向必须是「宁可文件大一点也不放锁」）。
  const entries = Object.entries(ips).filter(([, rec]) => (rec.until || 0) <= now);
  if (entries.length > BRUTE_MAX_IPS) {
    entries.sort((a, b2) => (a[1].updatedAt || 0) - (b2[1].updatedAt || 0));
    for (const [k] of entries.slice(0, entries.length - BRUTE_MAX_IPS)) delete ips[k];
  }
  return { ips };
}

/** brute.json 的「读—改—写」：CAS 乐观锁 + 冲突重放（M2）。
 * 原实现拿 bruteCheck 读到的旧快照整文件覆盖：N 个并发失败各自数到 1、互相覆盖，实际只记 1 次
 * —— 爆破预算被放大 N 倍（外部审计探针复现）。这里每轮重读最新状态，再叠自己这一次失败。
 * mutate(b) 就地改 b，返回 { out, dirty }：dirty=false 表示「无需写」（如本来就没有记录）。 */
async function updateBrute(store, mutate, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const cur = await getWithEtag(store, KEY.BRUTE);
    const b = normalizeBrute(cur && tryParseJson(cur.text));
    const r = mutate(b);
    if (r.dirty === false) return r.out;
    // cur === null → 「不存在才写」：并发的首次失败只有一个落盘，其余重试时读到对手的结果再叠加
    const w = await putIf(store, KEY.BRUTE, JSON.stringify(b), cur ? cur.etag : null);
    if (w.ok) return r.out;
  }
  // 重试耗尽（极端抖动）：无条件写一次——limiter 的失效方向必须偏保守（宁可多记也不放过）
  const cur = await getWithEtag(store, KEY.BRUTE);
  const b = normalizeBrute(cur && tryParseJson(cur.text));
  const r = mutate(b);
  // 耗尽路径同样守 dirty（2026-09-17 复查 F5）：并发对手可能刚清掉/改掉记录，
  // 无条件写会把读—写间隙里别人写的内容整份吃掉（与 updateTrash 的守卫对称）。
  if (r.dirty !== false) await store.putText(KEY.BRUTE, JSON.stringify(b));
  return r.out;
}

/** 鉴权前的**一次性尝试预留**（R150 P2-1）：先原子占掉一次尝试额度，再比对口令。
 * 旧实现是「bruteCheck 只读检查 → 比口令 → 失败才 bruteFail 计数」：一批并发请求会全部通过
 * 检查再各自补记 —— 实测 BRUTE_LIMIT=5 下 12 并发 = 12 次口令猜测被执行（写侧 CAS 只保证
 * 「计数不丢」，不保证「不多放猜测」）。预留把「检查」与「计数」并成一次 CAS，于是
 * 「每窗口 limit 次」才真正等于「能被执行的猜测次数上限」。
 * 语义与旧实现逐条对齐：
 *   · 涨到 limit 的那一次**仍然放行**（旧实现也是比完这一次才锁），锁在这一次就落盘 →
 *     下一次请求立刻 429；若这一次口令恰好正确，调用方的 bruteClear 会把记录整个删掉
 *     （预留的那一次一并抹去，不会误锁）；
 *   · 锁定期内一律 429 且**不写盘**（dirty:false）—— 否则每个拿错口令的请求都白写一次 brute.json；
 *   · 滑动窗口 / 锁过期重置 / strikes 指数翻倍的判据原样保留。
 * 代价：成功登录多 1 次写（预留）。登录是低频路径，换「并发猜测上限真的成立」值得。
 * 返回 { locked, retryAfterMs }。 */
async function bruteTry(req, env, store) {
  const cfg = bruteCfg(env);
  const now = Date.now();
  const h = await ipHash(req);
  return updateBrute(store, (b) => {
    const cur = b.ips[h];
    if (cur && cur.until > now) return { dirty: false, out: { locked: true, retryAfterMs: cur.until - now } };
    const rec = cur || { fail: 0, until: 0, strikes: 0 };
    if (rec.until > 0 && rec.until <= now) {
      rec.fail = 0; // 上一轮锁已过期 → 重新计次
      rec.until = 0;
    }
    if (now - (rec.updatedAt || 0) > BRUTE_FAIL_WINDOW) rec.fail = 0; // 滑动窗口：隔久了重新计次
    rec.fail += 1;
    rec.updatedAt = now;
    if (rec.fail >= cfg.limit) {
      rec.strikes = (rec.strikes || 0) + 1;
      rec.until = now + Math.min(cfg.lockMs * 2 ** (rec.strikes - 1), cfg.lockMaxMs);
      rec.fail = 0;
    }
    b.ips[h] = rec;
    return { out: { locked: false } };
  });
}

/** 登录成功：清掉该 IP 的失败记录（无记录则不写——成功登录是热路径，不白花一次写） */
async function bruteClear(req, store) {
  const h = await ipHash(req);
  await updateBrute(store, (b) => {
    if (!b.ips[h]) return { out: null, dirty: false };
    delete b.ips[h];
    return { out: null };
  });
}


/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { bruteTry, bruteClear };
