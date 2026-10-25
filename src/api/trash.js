/**
 * r2novel — 回收站 API
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { TRASH_DAYS } from '../../public/js/shared-const.js';
import { json, getWithEtag } from '../core/base.js';
import { KEY, PURGE_BATCH } from '../core/const.js';
import { readBook } from '../store/book.js';
import { indexEntryFromMeta } from '../store/entry.js';
import { sweepTrashSafe, purgeOnce } from '../store/gc.js';
import { openIndex } from '../store/open.js';
import { updateTrash, readTrash, parseTrash } from '../store/shard.js';

/* ---------------- 回收站 API ---------------- */

/** 软删：index 摘除 → trash（正文/meta/raw 全保留，可恢复）
 * 也接纳「未上架的半成品书」（上传中途失败停在 creating、不在 index）：
 * 这类书若不能进回收站就永远删不掉、也看不见，只能留成孤儿数据。 */
async function apiSoftDelete(store, id) {
  const idx = await openIndex(store, { single: id }); // 单书模式：root + 该书所在片
  const b = idx.get(id);
  const meta = b ? null : await readBook(store, id);
  if (!b && !meta) return json({ error: '书不存在或已删除' }, 404);
  // 只在架书才需要从索引摘除（半成品书本就不在索引，摘除无效果，跳过分片写）
  if (b) {
    idx.remove(id);
    await idx.save({ bak: true });
  }
  // trash 走 CAS（见 updateTrash）：并发的两次软删不会互相覆盖（否则有本书会彻底消失）
  await updateTrash(store, (t) => {
    const i = t.books.findIndex((x) => x.id === id);
    if (i >= 0) {
      // 条目已在且书**不在架**（恢复流程还没把书写回）→ 纯 no-op（双击删除/惰性清理抢先）。
      // 书**在架**说明刚被恢复流程写回索引（恢复×再软删竞态）→ 本次删除是真实意图，
      // 必须刷新 deletedAt 制造版本变化：并发恢复流程随后的「摘条目」CAS 会撞冲突，
      // 重放时看到 deletedAt 已变而放弃（2026-09-17 复查 F1）——否则恢复会把这条唯一的
      // 记录摘掉，书既不在架也不在回收站。
      if (!b) return { dirty: false };
      t.books[i] = { ...t.books[i], deletedAt: Date.now() };
      return {};
    }
    t.books.push({ ...(b || indexEntryFromMeta(meta)), deletedAt: Date.now() });
    return {};
  });
  return json({ ok: true });
}

/** 回收站列表（顺带惰性清理） */
async function apiTrashList(store, env, req) {
  // #145 P3-11：SameSite=Lax 下跨站**顶层 GET** 仍会带 Cookie —— 任何人用 <img>/重定向
  // 链让已登录浏览器打这个 GET，都会顺手触发惰性彻底删除。无读侧泄露（不回传数据），
  // 但「读请求触发写副作用」本身就该收敛。判据 sec-fetch-site：现代浏览器对同源 fetch /
  // 导航都发 same-origin，跨站顶层导航发 cross-site；老客户端没有该头 → 保守跳过清理
  // （列表展示不依赖清理结果，最坏是过期书晚一批被清）。
  if (req && req.headers.get('sec-fetch-site') === 'same-origin') await sweepTrashSafe(store, env);
  const trash = await readTrash(store);
  const books = (trash.books || []).slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  const view = books.map((b) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    tags: b.tags || [],
    chapterCount: b.chapterCount,
    wordCount: b.wordCount,
    deletedAt: b.deletedAt,
    purge: Array.isArray(b.purge) ? b.purge.length : 0,
    purging: !!b.purging,
        // 与 apiRestore 判据一致（#145 P1-1）：purging 占用标记 / purge 非空 / 还有续扫游标 ⇒ 不可恢复
    restorable: !b.purging && !(Array.isArray(b.purge) && b.purge.length) && !b.purgeCursor,
  }));
  return json({ books: view, trashDays: Number(env.TRASH_DAYS) || TRASH_DAYS });
}

/** 恢复：trash → index（正文未删时）
 * 只放行已发布（status='ready'）的书：半成品/更新中的书恢复回书架后既读不了（bookMeta 409）
 * 也没有继续上传的入口，只会变成书架上一本点不开的孤儿。 */
async function apiRestore(store, id) {
  // 读一次连版本号一起拿（下面写回走 CAS 用得上；复用这份快照不再多读一次，读取量守住 P2-5 的个位数）
  const trashCur = await getWithEtag(store, KEY.TRASH);
  const trash = parseTrash(trashCur && trashCur.text);
  const trashIdx = trash.books.findIndex((b) => b.id === id);
  if (trashIdx < 0) return json({ error: '回收站里没有这本书' }, 404);
  const entry = trash.books[trashIdx];
  // 判据（2026-10-16 #145 P1-1）：**purging 占用标记**优先，另两项是「已删到一半」的实质态。
  // purgeOnce 的写序是「CAS 写占用标记 → 删正文 → 摘条目」。占用标记以前混写在 purge: left 里，
  // 而本批一次删完时 left 恒为 `[]`（≤30 章的书每次都是）——「在飞 purge 的稳定中间态」与
  // 「进程中断的崩溃残留」两种盘面完全同形，只认 purge.length 的判据会被**每一次**在飞 purge
  // 稳定穿透（恢复×彻底删除并发 → 书被 upsert 回索引而正文/ meta 已删 → 点开 404 的幽灵书）。
  //   · purging === true ⇒ 有 purge 在飞或崩在中途 → 拒绝恢复。下次 sweepTrash 会续删/清完，
  //     条目摘除时 purging 随条目消失，之后自然可恢复（崩溃后正文可能已删，拒绝才是安全方向）。
  //   · purge 非空 / purgeCursor 非空 ⇒ 已有一部分正文被删，同样拒绝。
  // 纯 `purge: []` 残留（无 purging，2026-10-06 之前版本的崩溃态）按「正文完好」放行 ——
  // 与当年改成 .length 判据的初衷一致；此后所有在飞标记都带 purging，两类状态不会再混。
  if (entry.purging || (Array.isArray(entry.purge) && entry.purge.length) || entry.purgeCursor) {
    return json({ error: '该书的正文已部分清除或正在被彻底删除，无法完整恢复' }, 409);
  }
  // 软删自半成品（第三轮起可软删 creating 书）：trash 条目来自 indexEntryFromMeta，无 status 字段。
  // 一律以 meta 本体为准：只有已发布书恢复才有阅读/继续编辑入口，其余只会变书架孤儿。
  const meta = await readBook(store, id);
  if (!meta) return json({ error: '书本体数据缺失，无法恢复' }, 404);
  if (meta.status !== 'ready') {
    return json({ error: '该书尚未发布，无法恢复；如不再需要请在回收站中彻底删除' }, 409);
  }
  // 写序（P2-7）：**索引先落，trash 摘条目后落**。反过来的话 idx.save() 失败时书已经从 trash 摘掉、
  // 又没进索引 → 书架与回收站同时看不到它（用户本意是「找回」，结果唯一记录也被删；meta/正文虽在，
  // 只能走「检查残留」）。与 apiSoftDelete 的「索引先落」同一判据：让失败落在「trash 条目还在、可重试」
  // 的一侧。
  // append: id 来自回收站 ⇒ 索引里必定没有它（软删先摘索引后写 trash）→ 不必全量加载，只读 root + 末片；
  // 原实现（single 缺书 → 全量加载）在 2 万本/40 片下是 1+K 个子请求，逼近 50 硬顶（P2-5）。
  const idx = await openIndex(store, { single: id, append: true });
  const { purge, deletedAt, ...rest } = entry;
  idx.upsert(id, { ...rest }); // 已在架（重复恢复）则原位覆盖，语义与 v1 的去重 push 一致
  await idx.save({ bak: true });
  // 入口那次读的版本号带下来复用（pre）：冲突时 updateTrash 自己重读重放，不会多花一次读
  const marked = await updateTrash(
    store,
    (t) => {
      const i = t.books.findIndex((b) => b.id === id);
      // R3：条目消失 / deletedAt 变更都必须按 raced 上报。旧代码两条都只回
      // { dirty: false }（无 out）→ 上层 raced 不触发 → 照常 ok:true，而索引里已
      // upsert 的副本留着：purgeOnce 摘条目时正文/meta 已删光 → 点开 404 的幽灵书；
      // deletedAt 变更则可能与回收站条目构成双态（日后 purge 删掉一本在架书）。
      // vanished 留给调用方分流：另一台设备的恢复刚摘掉条目时书合法在架，
      // 无脑回滚会把合法条目删掉（见下方 readBook 判据）。
      if (i < 0) return { dirty: false, out: { raced: true, vanished: true } };
      // 我读快照之后它又被并发软删了一次（deletedAt 变了）→ 这次「摘除」不该生效：
      // 否则会把别人刚写回的条目吃掉，书既不在架也不在回收站（2026-09-17 复查 F1）。
      if (t.books[i].deletedAt !== entry.deletedAt) return { dirty: false, out: { raced: true, redo: true } };
      // #144 P1-2 + #145 P1-1：purgeOnce 的占用（purging / purge:left / purgeCursor）**保留
      // deletedAt 不变**，只比 deletedAt 的重放会穿透 —— 恢复这边刚把书 upsert 回索引，并发
      // purge 那边正在删它的正文（本批 ≤30 章已删）。#144 的判据只认 purge.length，对 ≤30 章
      // 的书恒为空数组、稳定漏检（#145 实锤）；purging 独立字段后两类占用都逃不掉。检出占用
      // ⇒ 放弃摘除并向调用方报 raced：索引侧回滚 remove，状态收敛回「只在回收站、已被占」。
      if (t.books[i].purging || (Array.isArray(t.books[i].purge) && t.books[i].purge.length) || t.books[i].purgeCursor) {
        return { dirty: false, out: { raced: true } };
      }
      t.books.splice(i, 1);
      return {};
    },
    3,
    trashCur
  );
  if (marked && marked.raced) {
    // 条目消失（vanished）有两种成分，读一次 meta 分流：
    //   · 本体没了 ⇒ purgeOnce 删光正文/meta 之后才摘的条目 → 我们的 upsert 是
    //     幽灵，必须回滚（书架上点开 404，比「不在架」更糟）；
    //   · 本体还在 ⇒ 另一台设备的恢复刚摘掉条目（书合法在架）→ 回滚反而删掉
    //     合法条目 → 放行（幂等：两次恢复的upsert 内容相同）。
    let rollback = true;
    if (marked.vanished) rollback = !(await readBook(store, id));
    if (rollback) {
      // 索引 CAS 冲突这里不再重试重放——竞态窗口本就极窄，尽力回滚即可，trash 里的
      // 条目（带占用标记）始终是权威记录。
      try {
        idx.remove(id);
        await idx.save({ bak: true });
      } catch {
        /* 回滚失败不掩盖主结果：409 照常返回，diag 的孤儿清扫可兜底 */
      }
      return json({ error: marked.redo ? '该书已被再次删除，恢复已中止' : '该书正在被彻底删除，恢复已中止' }, 409);
    }
    return json({ ok: true }); // 并发恢复已达成同一目标，trash 条目已由它摘除
  }
  return json({ ok: true });
}

/** 彻底删除单本（分批，客户端按 remaining 续调） */
async function apiTrashPurge(store, id) {
  const trash = await readTrash(store);
  if (!trash.books.some((b) => b.id === id)) return json({ error: '回收站里没有这本书' }, 404);
  const r = await purgeOnce(store, id);
  return json({ ok: true, done: r.done, remaining: r.remaining, deleted: r.deleted });
}

/** 清空回收站（每请求推进 1 本，客户端按 remaining 续调直至 0）
 * 只处理 1 本：彻底删除的固定开销（readBook + raw/meta/progress 删除 + updateTrash）会叠在
 * 章删除之上，逐本累积轻松超 Free 50 子请求红线；一本一本清最稳。 */
async function apiTrashClear(store) {
  const trash = await readTrash(store);
  if (!trash.books.length) return json({ ok: true, deleted: 0, remaining: 0 });
  const r = await purgeOnce(store, trash.books[0].id, PURGE_BATCH);
  // 剩余数自己算：purgeOnce 不再改调用方的副本（见其文档注释）→ done=true 即「这本已彻底删完、条目已摘」
  const remaining = r.done ? trash.books.length - 1 : trash.books.length;
  return json({ ok: true, deleted: r.deleted, remaining });
}

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { apiSoftDelete, apiTrashList, apiRestore, apiTrashPurge, apiTrashClear };
