/**
 * r2novel — 回收站彻底删除 / 孤儿章节惰性清扫
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { TRASH_DAYS } from '../../public/js/shared-const.js';
import { getWithEtag } from '../core/base.js';
import { PURGE_BATCH, KEY, ORPHAN_BATCH } from '../core/const.js';
import { readBook } from './book.js';
import { parseTrash, updateTrash, readTrash } from './shard.js';

/* ---------------- 回收站惰性清理 / 彻底删除（分批，尊重 50 子请求预算） ---------------- */


/**
 * 对 trash 里一本书执行一批彻底删除。返回 { entry(更新后), deleted, done, remaining }。
 * remaining>0 表示还需续调（章节太多分批）。
 * ⚠️ 只**读** trash 参数，不再改动它（条目摘除与 purge 续传标记都走 updateTrash，落在最新的
 * 那一份上）。调用方要判断「这本书删完没有」请看返回的 done，**别**去看自己那份 books.length
 * ——旧实现靠这里 splice 的副作用，CAS 化之后那个副作用就没有了。
 */
async function purgeOnce(store, id, maxDel = PURGE_BATCH) {
  // 防恢复竞态（2026-10-01 审计 P2 + 2026-10-16 #145 P1-1）：调用方传入的 trash 快照可能已
  // 过时，而下面的删除动作是无条件 store.delete —— 若并发「恢复」恰好在此窗口把书放回书架，
  // 这里会把**在架书**的正文乃至 meta/progress 删光，书架留下一本点不开的空壳。
  // 处置两步关死 TOCTOU：① 重读最新 trash，条目已被摘走（恢复成功）→ 放弃；
  // ② 删除前先 CAS 写「占用标记」**purging: true**（独立字段，见下）——恢复侧见 purging 即
  //    409，标记与删除之间的窗口里恢复不可能再插进来；CAS 冲突重放期间条目被摘走则放弃。
  // ⚠️ 占用标记**不能**再混写在 purge: left 里（#145 P1-1 实锤的回归）：本批一次删完时 left
  // 恒为空数组，`purge: []` 既是「在飞 purge 的稳定中间态」又是「进程中断的崩溃残留」——
  // 两种盘面完全同形，只认 purge.length 的判据会被每一次在飞 purge 稳定穿透（恢复×彻底删除
  // 并发 → 书被 upsert 回架而正文已删 → 书架留点开 404 的幽灵）。purge 数组只保留「续删
  // 剩余 keys」的既有语义。
  const fresh = await getWithEtag(store, KEY.TRASH);
  const t0 = parseTrash(fresh && fresh.text);
  const i0 = t0.books.findIndex((b) => b.id === id);
  if (i0 < 0) return { entry: null, deleted: 0, done: true, remaining: 0 };
  let entry = t0.books[i0];
  let keys = Array.isArray(entry.purge) && entry.purge.length ? entry.purge : null;
  // 续扫游标（2026-10-06 审计 P2-1）：meta 已丢失且章节数超过单窗列取上限时，剩余章节靠
  // cursor 逐窗接着列。游标存在**条目字段**上而非塞进 purge 数组当哨兵 —— 哨兵会被当章 key
  // 删掉（删了个不存在的对象）且随本批丢失 → 下一轮从头列 → 永不推进（死循环）。
  const purgeCursor = typeof entry.purgeCursor === 'string' ? entry.purgeCursor : '';
  let nextCursor = '';
  if (!keys) {
    const meta = await readBook(store, id);
    if (meta) {
      // 彻底删除要覆盖正文章节 + replace 遗留的孤儿章节，避免 R2 残留
      keys = (meta.chapters || []).map((c) => c.key).concat(Array.isArray(meta.orphans) ? meta.orphans : []);
    } else {
      // meta 已丢失（手工删除/损坏）：不能空手交差——否则 text/<id>/ 下所有正文永久残留，
      // 而回收站条目却已被摘除，只能靠 diag 兜底。按前缀列全量回收（上限 50 页≈5 万章）
      // ⚠️ 页数必须受限（2026-10-06 审计 P2-1）：每页 list 就是一个子请求，maxPages=50
      // 意味着最多 50 次，加 PURGE_BATCH=30 个 delete 与 trash/meta/raw/progress 的固定开销
      // 必然超限 → 500，且每次都卡在同一处 = 这本书永远清不掉（实测 2 万章即 54 个子请求，
      // 而 CHAPTER_MAX 的设计上限就是 2 万）。降到 8 页（8000 章）：列到的进本批 keys，
      // 没列到的用 meta 里可能存在的 orphans 无从得知 → 靠 list 返回的 cursor 续扫窗登记。
      const prefix = `text/${id}/`;
      // ⚠️ 列不出来**不能**当成「没有章节」（R150 P2-3）：那会让本批 keys 为空 → left 为空 →
      // done=true → 删掉 meta/raw/book/progress 并摘走回收站条目，而 text/<id>/ 下的正文一个都
      // 没删，且从此再无任何线索能定位它们（条目没了，残留扫描也认不出这是谁的书）。
      // 列失败＝存储抖动，报错让调用方稍后重试；此时占用标记还没写，盘面干净、重试无需补偿。
      const listed = await store.list(prefix, 8, purgeCursor).catch(() => null);
      if (!listed) throw new Error('回收站正文清单读取失败，请稍后重试');
      keys = (listed.objects || []).map((o) => o.key.slice(prefix.length).replace(/\.txt$/, ''));
      // 还有没列到的：游标随 CAS 标记写进条目，下一轮从这里续（幂等：已删的 key 删第二次无害）
      nextCursor = (listed && listed.truncated && listed.cursor) || '';
    }
  } else {
    // #144 P1-1：上轮登记的续扫游标必须随条目带过来 —— 否则本窗 keys 恰好删完时
    // nextCursor 落空、CAS else 分支剥掉游标并摘除条目，8000 章（list 8 页窗）之外的
    // 正文永久残留。带上游标后：left 空 + 游标非空 → done=false（purge:[] + 游标保留），
    // 下一轮 entry.purge 为空数组自然回落到上面的 listing 分支从游标续列。
    nextCursor = purgeCursor;
  }
  const batch = keys.slice(0, maxDel);
  const left = keys.slice(batch.length);
  // 占用标记先行：写序依据与索引「指针先落」同一判据 —— 让失败落在可重试的一侧。
  // 标记写成功后 restore 必 409；进程中断的话 purge 标记已在，下次惰性清理按 left 续删（幂等）。
  const marked = await updateTrash(
    store,
    (t) => {
      const i = t.books.findIndex((b) => b.id === id);
      if (i < 0) return { dirty: false, out: { gone: true } }; // 已被并发恢复摘走 → 放弃本次删除
      // purging 是占用标记（#145 P1-1）：done 摘条目时随条目消失 → 「条目在 ⇒ 可能在飞」与
      // 「条目不在 ⇒ 一定没在飞」一一对应，恢复侧判据不再有歧义。
      if (nextCursor) t.books[i] = { ...t.books[i], purge: left, purgeCursor: nextCursor, purging: true };
      else {
        const { purgeCursor: _drop, ...rest } = t.books[i]; // 全部列完 → 丢弃游标（别留脏字段）
        void _drop;
        t.books[i] = { ...rest, purge: left, purging: true };
      }
      return { out: { gone: false } };
    },
    3,
    fresh
  );
  if (marked && marked.gone) return { entry: null, deleted: 0, done: true, remaining: 0 };
  entry = { ...entry, purge: left };
  // 并发删除：子请求数不变，耗时从串行 N 次往返降为一批并发
  await Promise.all(batch.map((k) => store.delete(KEY.text(id, k))));
  let deleted = batch.length;
  let done = false;
  // 「还有待清」= 本窗没删完（left 非空）**或** 还有没列到的章节（nextCursor 非空）。
  // 只看 left 会让「本窗恰好删完、后面还有 1 万章」被判成 done → 摘掉条目 → 正文永久残留。
  if (left.length || nextCursor) {
    done = false; // 标记已写（purge: left / purgeCursor），下次续删
  } else {
    done = true;
    await Promise.all([store.delete(KEY.raw(id)), store.delete(KEY.book(id)), store.delete(KEY.progress(id)), store.delete(KEY.st(id))]);
    await updateTrash(store, (t) => {
      const i = t.books.findIndex((b) => b.id === id);
      if (i < 0) return { dirty: false };
      t.books.splice(i, 1);
      return {};
    });
  }
  // remaining 的语义是「还要不要续调」，不是「本窗还剩几个 key」（R150 P2-3）：只改一批就删完、
  // 但还有没列到的章节时（left 为空、nextCursor 非空、done=false），旧实现返回 0 → 前端
  // while (remaining > 0) 当场收手 → 8000 章以外的正文永久残留。done=false 一律至少报 1。
  return { entry, deleted, done, remaining: done ? 0 : Math.max(1, left.length) };
}

/** 惰性清理：把超过 TRASH_DAYS 的书清掉一批（无 cron，靠业务请求时机触发）
 * 注意：进行中（purging 占用标记 / purge 数组非空）的书也要继续清，否则 >30 章的书会中途
 * 卡死在回收站（purge 数组为空但 purging 在的半成品标记同样续删 —— 幂等）。
 * 预算由调用方控制（sweepTrashSafe 限定 maxBooks=1）：本函数本身按默认 batch 推进。 */
async function sweepTrash(store, env, maxBooks = 1) {
  const trash = await readTrash(store);
  if (!trash.books.length) return;
  const ttl = (Number(env.TRASH_DAYS) || TRASH_DAYS) * 86400000;
  const now = Date.now();
  const expired = trash.books.filter((b) => now - (b.deletedAt || 0) > ttl);
  for (const b of expired.slice(0, maxBooks)) {
    await purgeOnce(store, b.id);
  }
}

/* ---------------- 孤儿章节清理（replace 后章节数变少时旧正文对象残留） ---------------- */

/** 对一本书的一批孤儿 key 执行删除；只改 meta.orphans，持久化由调用方负责。返回剩余数。 */
async function sweepOrphans(store, meta, max = ORPHAN_BATCH) {
  const keys = Array.isArray(meta.orphans) ? meta.orphans : [];
  if (!keys.length) return 0;
  // 防御：孤儿表与章表理论上互斥（replace 登记时已按新章表过滤），但历史脏数据（#139 修复前
  // 写入的 meta）可能重叠 —— 删掉章表仍在引用的正文就是阅读 404。宁可漏删（下次再扫），绝不误删。
  const live = new Set((Array.isArray(meta.chapters) ? meta.chapters : []).map((c) => c.key));
  const cand = keys.filter((k) => !live.has(k));
  if (!cand.length) {
    delete meta.orphans; // 全是「其实在用」的 key → 整表作废，不再反复扫
    return 0;
  }
  const batch = cand.slice(0, max);
  await Promise.all(batch.map((k) => store.delete(KEY.text(meta.id, k))));
  const left = cand.slice(batch.length);
  if (left.length) meta.orphans = left;
  else delete meta.orphans;
  return left.length;
}

/** 清一批孤儿正文（删除幂等，属副作用 → **不进** mutateMeta 的纯变换）→ 返回 { swept, left }：
 *  · swept = 本次确实删掉的 key 集合（据此从待清表里剔除，避免反复无效删）
 *  · left  = 没清掉的（存储故障时 = 全部，方向保守：继续登记，并让新章避让它们的 key）
 *  max 传 Infinity 表示「一次清完」（append 前要腾出完整 key 空间）。
 *  liveKeys：**清完后仍会被章表引用的 key 集合**（append=现有章 key；replace=新表 key；
 *  publish=现有章 key）。以「伪 chapters」传给 sweepOrphans，让它的活键防御在这里也生效 ——
 *  #140 复查（F2）：tmp 不带 chapters 时防御恒空，历史脏数据里 orphans ∩ 章表重叠的 key 会被
 *  误删正文（append 流程客户端不重传旧章 → 阅读 404）。 */
async function sweepOrphansBatch(store, id, keys, max, liveKeys = null) {
  const pre = Array.from(new Set(Array.isArray(keys) ? keys : []));
  if (!pre.length) return { swept: new Set(), left: [] };
  const live = Array.isArray(liveKeys) ? liveKeys : [];
  const tmp = { id, orphans: pre.slice(), chapters: live.map((k) => ({ key: k })) };
  try {
    await sweepOrphans(store, tmp, max);
  } catch {
    return { swept: new Set(), left: pre }; // 删除失败：一个都不算已清
  }
  const left = Array.isArray(tmp.orphans) ? tmp.orphans : [];
  // swept 按真实删除数从 pre 头部切（sweepOrphans 只删 cand 前缀）；防御剔掉的活键既没删也没留，
  // 不落在这两类里 → 用「pre − left − live」算，而不是 pre.length − left.length（会把活键算成已删）。
  const leftSet = new Set(left);
  const liveSet = new Set(live);
  const swept = new Set(pre.filter((k) => !leftSet.has(k) && !liveSet.has(k)));
  return { swept, left };
}


/** 惰性清理是"顺手"动作：删除失败不应阻断读取，包一层降级。
 * 只挂在回收站列表（apiTrashList）触发：书架 GET 不再等待清扫——超期大书的
 * 多批 R2 删除（每请求 ≤1 本）不会拖慢首屏；超期书本已过期，晚几天清无妨。
 * 每请求最多推进 1 本（batch ≤30）：逐本书的固定开销（readBook+写trash 等）
 * 叠上去多本必爆 50，1 本最坏 ~33 才稳。剩余靠下一请求继续（purge 字段续清）。 */
const sweepTrashSafe = (store, env) => sweepTrash(store, env, 1).catch(() => {});

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { purgeOnce, sweepOrphans, sweepOrphansBatch, sweepTrashSafe };
