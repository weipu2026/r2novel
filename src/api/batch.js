/**
 * r2novel — 批量操作 / 标签治理
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { TAG_MAX, BATCH_BOOKS_MAX } from '../../public/js/shared-const.js';
import { readJsonBody, json, getWithEtag, tryParseJson, mutateMeta } from '../core/base.js';
import { KEY_IDX } from '../core/const.js';
import { openIndex } from '../store/open.js';
import { isSafeId, safeStr, looksRoot, updateTrash, shardCapExceeded, readIndex, probeIdxRoot, isIdxConflict } from '../store/shard.js';

/* ---------------- 批量操作 / 标签治理（分片预算核账后裁剪，客户端按 deferred/remaining 续调） ---------------- */

/**
 * 批量操作：一次请求改多本书（标签增删/整设、完结状态、软删）。
 * 只写一次 index（含快照），避免 N 次请求产生 N 次 index 写放大与丢失更新窗口。
 * body: { ids: [...], action: 'addTags'|'removeTags'|'setTags'|'setFinished'|'delete', tags?, finished? }
 */
async function apiBatchBooks(req, store) {
  const bj = await readJsonBody(req, 2 * 1024 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const idsRaw = Array.isArray(body.ids) ? body.ids : null;
  if (!idsRaw || !idsRaw.length) return json({ error: '请先选择要操作的书' }, 400);
  const ids = Array.from(new Set(idsRaw.map((x) => String(x)).filter((x) => isSafeId(x))));
  if (!ids.length) return json({ error: '没有合法的书 id' }, 400);

  const action = String(body.action || '');
  if (!['addTags', 'removeTags', 'setTags', 'setFinished', 'delete'].includes(action)) {
    return json({ error: '未知操作' }, 400);
  }
  const tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [];
  // setTags 允许空数组（清空标签），其余两种必须给非空标签
  if (action !== 'setTags' && action !== 'setFinished' && action !== 'delete' && !tags.length) {
    return json({ error: '请填写标签' }, 400);
  }
  if (action === 'setFinished' && body.finished === undefined) return json({ error: '缺少 finished' }, 400);

  const batch = ids.slice(0, BATCH_BOOKS_MAX);
  // 分片版预算核算：先拿 root.map（1 读；开索引时把这份原文传进去复用，不再读第二次），
  // 把 targets 裁到子请求预算内再开索引。
  // 非删除：1(root) + k 片读 + 2N(meta 读+写) + 2k(片写+bak) = 1+3k+2N ≤ 48
  // 删除：  1(root) + k 片读 + 1(trash 读) + 2k(片写+bak) + 2(root 写+bak) + 1(trash 写) = 5+3k ≤ 48
  // 被裁掉的 id 必须**原样回传**（deferred）让客户端排回队列续调——v1 单文件时代 k 恒为 1 用不着算，
  // 分片后 18 本随机目标可能散在多片；「裁掉却不告诉客户端」＝静默丢书（v2 实测：18 本散 5 片只处理 16 本）。
  // 不在架（回收站/半成品）的书既不占预算也不进 deferred：重试多少次都不在架，会死循环。
  //
  // 廉价预筛的前提是「root.map 就是可信的在架名单」。它有两个失效态：
  //   · map 缺条目（P2-3）——root 从 .bak 回落后要等对账 ① 才补上，或盘上分片比 root.shards 多。
  //     此时确实在架的书会被判 offShelf：既不处理也不 deferred，前端把它计成「失败（可能是半成品
  //     书）」且不重试，标签/完结状态永远改不动。
  //   · root 深度坏（P2-4）——自愈（rebuildIdxRoot 的 list + 逐片读 + root 写）也吃子请求，
  //     原公式当成 0，实测越过 50 硬顶。
  // 两种都改为先做一次**全量打开**（含自愈与对账）拿到真相，并把该 handle 复用到本批操作（不再
  // 第二次开索引）；这次多花的子请求从预算里预扣。正常态（map 覆盖全部目标）仍只读 1 次 root。
  const rootInfo = await (async () => {
    const cur = await getWithEtag(store, KEY_IDX.root);
    const raw = cur ? cur.text : null;
    const rootEtag = cur ? cur.etag : null;
    const root = tryParseJson(raw);
    // 廉价路径的判据只认「**这些 id 在 map 里都指向某个片**」（2026-10-06 审计 P1-5）。
    // 已软删/幽灵 id 在下面 shardNoOf 里会被归入 offShelf（不占预算、不进 deferred），
    // 却曾让 `batch.every(...)` 为假 → 强制全量 openIndex → extra = 1 + shardCount →
    // 37 分片时 budget=10 < 单本估算 11 → break → processed=[] → **整批一本都没打标**
    //（实测 shards=37 时 ok:0 fail:4）。
    // ⚠️ 判据必须区分两种「不在 map」：
    //   · `undefined`（map 里根本没这个键）→ 指针落后一代，**书可能仍在架**（既有 P2-3
    //     回归用例钉的就是这个：片里有、map 缺，全量打开后由对账 ① 补回）→ 必须走全量；
    //   · 有值但不是整数（脏值）→ 同上也走全量。
    // 把 undefined 当「离架」会重新引入 P2-3 的静默跳过，故这里只看「值不是合法片号」。
    if (looksRoot(root) && batch.every((id) => Number.isInteger(root.map[id]))) {
      return { root, raw, rootEtag, extra: 0, handle: null, rebuilt: false };
    }
    // 全量打开（rootRaw/rootEtag 复用上面那次读，省 1 读）：root 不可解析时顺带走 root.bak → 由分片重建。
    // ⚠️ root.bak 必须在 openIndex **之前**读：rebuildIdxRoot 会把 root 与 root.bak 一起写成
    // 合法内容，事后再读就永远看到「bak 是好的」→ rebuilt 恒 false，自愈轮信号彻底失效
    // （实测：root+bak 双坏的 40 片大库本应 retry=true，改完却是 undefined）。
    const bak = looksRoot(root) ? null : await getWithEtag(store, KEY_IDX.rootBak);
    const bakOk = looksRoot(bak ? tryParseJson(bak.text) : null);
    const h = await openIndex(store, { rootRaw: raw, rootEtag });
    // 预扣已花的子请求：1（root 读）+ K（全量片读）+ 不可解析时 1（root.bak）+ 重建 1（list）+ 2（root/root.bak 写）
    // ⚠️ 但要**按需退差**，且只在 **root 健康**（looksRoot 为真）时退（2026-10-06 审计 P1-5）：
    // 全量打开后本批真正需要的片只有「目标 id 所在的那些片」，其余是为离架 id / map 缺条目
    // 白读的。大库（≥37 片）时按 `1 + shardCount` 计费会把 budget 压到个位数 → 连一本都
    // 处理不了（实测 ok:0 fail:4，整批静默全灭）。
    // **自愈路径（root 深度坏）不退差**：那里 rebuildIdxRoot 真的把 40 片全读了一遍
    // （1 root + 1 bak + 1 list + K 片读 + 2 写 = 4 + K），退差会让预算虚高 → 实测 53 > 50
    // 越顶（既有 P2-4 回归用例钉的就是这个）。
    const needShards = new Set();
    for (const id of batch) {
      const n = h.root.map[id];
      if (Number.isInteger(n)) needShards.add(n);
    }
    const healthy = looksRoot(root);
    // ⚠️ 第四轮审计：健康 root 但**有目标 id 不在 map** 时，上面的 openIndex 走的是**全量**模式
    // （1 + K 次读已经真实发生），而这里只按 needShards 计费 → 已花的 K 次读被当成没花，
    // 剩余预算虚高 → 大库（K≥35）时整批写操作撞 50 子请求硬顶 → 整批 500。
    // 「退差」只在**真的一本就够、不需要全量读**的场景才成立；既然已经全量读了，就必须按实际计费。
    // ⚠️ root **深度坏**（raw 解析失败）时 root 为 null → 直接 `root.map[id]` 抛 TypeError，
    // 整批 500。而这条路径正是「自愈轮」——最不能挂的地方。先判 looksRoot 再取 map。
    const needAll = !looksRoot(root) || !batch.every((id) => Number.isInteger(root.map[id]));
    const extra = healthy
      ? needAll
        ? 1 + h.shardCount
        : 1 + (needShards.size > 0 ? needShards.size : 1)
      : 1 + h.shardCount + 4;
    // rebuilt 只在「root 深度坏、被 rebuildIdxRoot 确定性重建」时为真。openIndex 对健康 root
    // 也可能因目标不在 map 而全量打开（extra>0 但没重建）——那不是自愈（2026-10-06 审计 P1-5）
    // R150 P3-5：rebuilt 只认「真自愈」—— root 深度坏**且连 root.bak 也不可用**，那才是
    // rebuildIdxRoot 真的跑了一遍（list + 逐片读 + 2 写）。仅主 root 不可解析但 bak 好时，
    // openIndex 只是回落 bak（多 1 次读），盘面一个字都没改；旧判据把它也算自愈轮 → 白扣预算
    // 并把 retry:true 传给客户端，客户端再发一次拿到完全相同的盘面，无进展重试一次。
    return { root: h.root, raw: null, rootEtag: null, extra, handle: h, rebuilt: !looksRoot(root) && !bakOk };
  })();
  const shardNoOf = (id) => (Number.isInteger(rootInfo.root.map[id]) ? rootInfo.root.map[id] : null);
  const budget = Math.max(0, 48 - rootInfo.extra); // 预扣掉的（自愈/全量读）不再给本批用
  const shardSet = new Set();
  const processed = [];
  const offShelf = new Set();
  for (const id of batch) {
    const n = shardNoOf(id);
    if (n == null) {
      offShelf.add(id); // 不在架（含回收站/半成品）——沿用 v1 语义由 inShelf 过滤，不占预算
      continue;
    }
    const newS = shardSet.has(n) ? shardSet.size : shardSet.size + 1;
    // 预扣一次 CAS 冲突重放的开销（2026-09-17 复查 F3）：save() 撞冲突会重开索引
    // （root 1 读 + 跨片读）并重写（root 1 写 + 每脏片 2 写）≈ 2+3*newS。不预留的话，
    // 顶格批量撞冲突 → 重放把总子请求顶破 Workers 50 上限。
    // ⚠️ 这个预留**只在「最多重放一次」时才成立**——所以下面 save() 一律传 replay:1
    // （2026-09-17 二次复查 R3 实测：默认允许 2 次重放，6 片删除连续两次冲突时达 ~56 > 50）。
    const replay = 2 + 3 * newS;
    // #145 P3-2：mutateMeta 走 tries=2（下方调用点），单本最坏不是「读+写」2 个子请求，而是
    // 「读+写败+读+写」4 个（CAS 撞一次冲突）。原预扣 2/本 —— 两个并发批量打同一批书时会
    // 越过 48 账面、把整个 Worker 请求顶穿 50 硬顶（失效方向是超限，不安全）。
    // 预扣改 4/本：失效方向变成「本批少处理几本、余进 deferred」，是安全的那一侧。
    const est = (action === 'delete' ? 5 + 3 * newS : 1 + 3 * newS + 4 * (processed.length + 1)) + replay;
    if (est > budget) break;
    shardSet.add(n);
    processed.push(id);
  }
  const processedSet = new Set(processed);
  const deferredInBatch = batch.filter((id) => !processedSet.has(id) && !offShelf.has(id));
  const deferred = deferredInBatch.concat(ids.slice(BATCH_BOOKS_MAX)); // 预算裁掉的 + 超单批上限的尾巴
  // 自愈轮：本批的预算全花在修 root 上了（大库下预扣直接吃光）→ 一本没动，但盘面已修好。
  // 明确告诉客户端「这一批退回不是死局，再发一次」，否则 runBatched 会把整批退回当零进展收手（P2-4）。
  // 「自愈轮」只认**真自愈**（root 深度坏、被确定性重建过）。判据不能是 extra>0 ——
  // 离架 id 导致的正常全量打开同样 extra>0（2026-10-06 审计 P1-5），会把「本批因预算裁剪
  // 而正常续跑」误报成自愈轮：客户端 batch-queue.js 只容忍一次 retry，第二轮拿到同样的
  // retry:true 就 break → 把整批（含完全正常的书）报成失败。
  const retry = rootInfo.rebuilt === true && processed.length === 0;
  // 已经全量打开的 handle 直接复用（是 { ids } 模式的超集），绝不第二次开索引
  const openOpts = { ids: processed, ...(rootInfo.raw != null ? { rootRaw: rootInfo.raw, rootEtag: rootInfo.rootEtag } : {}) };
  const idx = rootInfo.handle || (await openIndex(store, openOpts));
  const inShelf = new Set(processed.filter((id) => !!idx.get(id)));
  const targets = processed.filter((id) => inShelf.has(id));
  const remain = batch.length - deferredInBatch.length; // 本批「该处理」的本数（不含被裁/超限）

  if (action === 'delete') {
    const n = await batchSoftDelete(store, idx, targets);
    return json({ ok: true, updated: n, skipped: remain - n, deferred, ...(retry ? { retry: true } : {}) });
  }

  // 每本「读—改—写」走 CAS（20 本并行）：与旧的 readBook + putText **同为 2 个子请求/本**，
  // 子请求预算不变（见下方预扣注释），但消掉了「两条并发批量互相吃字段」——旧写法无条件整份覆盖，
  // 后写者吃掉前者的改动（表现为「刚打的标签少了一个」）。
  const now = Date.now();
  const patches = new Map();
  const results = await Promise.all(
    targets.map((id) =>
      mutateMeta(store, id, (meta) => {
        if (action === 'addTags') {
          const set = new Set(meta.tags || []);
          for (const t of tags) set.add(t);
          meta.tags = Array.from(set).slice(0, TAG_MAX);
        } else if (action === 'removeTags') {
          const rm = new Set(tags);
          meta.tags = (meta.tags || []).filter((t) => !rm.has(t));
        } else if (action === 'setTags') {
          meta.tags = tags;
        } else if (action === 'setFinished') {
          meta.finished = !!body.finished;
        }
        meta.updatedAt = now;
        return { out: { tags: meta.tags || [], finished: !!meta.finished, updatedAt: meta.updatedAt } };
      }, null, 2) // tries=2：批量路径的重试读/写要计入子请求预算（每本预算按 1 读 1 写预扣，
      // 3 次重试撞满会翻倍越顶；2 次在「宁可早失败」与预算安全之间取平衡，失效方向安全）
    )
  );
  for (let i = 0; i < targets.length; i++) {
    // 缺书 / 重试用尽的书**不计入 patches** → updated 不虚报（旧写法无条件写，永远算成功）
    if (results[i].ok) patches.set(targets[i], results[i].out);
  }

  let patchSkip = 0;
  if (patches.size) {
    // 这里与上方的 inShelf 守卫读的是**同一份内存快照**：openIndex 在 inShelf 之前已打开，
    // 两者之间只 await 各书 meta 写入（不触碰 shardBooks），而外部并发只能改盘面、改不了
    // 这份快照 → 守卫恒不触发（2026-09-18 生产前审计以「移除守卫后并发软删用例仍全绿」坐实，
    // 回归见 test/review-fix135.test.mjs 的「守卫当前不可达」用例）。
    // 保留它只作防御：若日后 openIndex 改成惰性取片，这里会重新变成真实窗口。
    // 真正覆盖「并发软删」的是下面 save() 的重放路径（F2 的 again.get 守卫）——它才读新盘面。
    for (const [id, p] of patches) {
      if (!idx.get(id)) { patchSkip++; continue; }
      idx.patch(id, (b) => ({ ...b, ...p }));
    }
    // 重放时书被并发删除 → 该 patch 被跳过（F2）→ 不能计入 updated，否则文案与实际盘面不符
    // （2026-09-17 二次复查 R5）
    // replay:1：预算只按「一次重放」预扣，次数必须一起限死（R3）；第二次冲突冒成 409 让客户端重试
    const r = await idx.save({ bak: true, replay: 1 });
    // 累加而非覆盖：上面守卫跳过的书没有进 opLog，因此不会出现在 r.skipped 里，两批互不重叠。
    // 用覆盖的话，守卫一旦真的命中，它的计数就被静默抹掉 → updated 多报（2026-09-18 审计）。
    if (r && r.skipped) patchSkip += r.skipped.length;
  }
  const updated = patches.size - patchSkip;
  return json({ ok: true, updated, skipped: remain - updated, deferred, ...(retry ? { retry: true } : {}) });
}

/** 批量软删：索引分片摘除成员 + trash 一次写入（不读各书 meta，index 条目即摘要）。
 * 返回实际入回收站的本数——响应体（含续调信息 deferred）只在 apiBatchBooks 一处拼装。 */
async function batchSoftDelete(store, idx, targets) {
  if (!targets.length) return 0;
  // 先取条目（remove 之后索引里就没有了；trash 条目 = index 摘要 + deletedAt）
  const entries = new Map();
  for (const id of targets) {
    const e = idx.get(id);
    if (e) entries.set(id, e);
  }
  for (const id of targets) idx.remove(id);
  await idx.save({ bak: true, replay: 1 }); // 同上：delete 的预算（5+3k）只预扣一次重放（R3）
  // trash 走 CAS（见 updateTrash）：并发的另一次软删不会把这一批条目吃掉
  let n = 0;
  await updateTrash(store, (t) => {
    n = 0; // mutate 可能被重放 → 计数每次从零重算，绝不累加
    for (const id of targets) {
      const ei = t.books.findIndex((x) => x.id === id);
      if (ei >= 0) {
        // 批量目标全部来自在架书 → 条目已存在只可能是「恢复×批量删」竞态（书刚被恢复流程
        // 写回索引）→ 刷新 deletedAt 让恢复流程的摘条目作废，同 apiSoftDelete 的判据（F1）。
        t.books[ei] = { ...t.books[ei], deletedAt: Date.now() };
        n++;
        continue;
      }
      const entry = entries.get(id);
      if (entry) {
        t.books.push({ ...entry, deletedAt: Date.now() });
        n++;
      }
    }
    return { dirty: n > 0 };
  });
  return n;
}

/** 全量标签清单（不截断：前端导航栏只显示 top12，治理页需要看到全部） */
async function apiTagsList(store) {
  // #145 P3-1：全量读 1+K，K≥50 直接 500（读都读不动）。先探 root。
  const over = await shardCapExceeded(store);
  if (over) return json({ error: `书库分片过多（${over} 片），标签清单暂不可用` }, 409);
  const index = await readIndex(store);
  const m = new Map();
  for (const b of index.books || []) {
    for (const t of b.tags || []) m.set(t, (m.get(t) || 0) + 1);
  }
  const tags = Array.from(m.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([tag, count]) => ({ tag, count }));
  return json({ tags, total: tags.length });
}

/**
 * 标签治理：合并 / 改名 / 删除（to 为空串即删除）。
 * 只改受影响书，超出单请求预算时返回 remaining，前端续调即可。
 */
async function apiTagsMerge(req, store) {
  const bj = await readJsonBody(req, 256 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const from = safeStr(body.from, 30);
  const to = safeStr(body.to, 30);
  if (!from) return json({ error: '请指定要处理的标签' }, 400);
  if (to && to === from) return json({ error: '源标签与目标相同' }, 400);

  // #145 R11：熔断判据必须在**全量读之前**。原实现先 openIndex（1+K 读）再判 1+K+4>48 —— 判超限时
  // 已经把 1+K 个子请求烧在「马上要拒绝」的那次读上（K=44 时 45 读，白烧）。先探 root（1 读）拿同一个
  // 判据：超限立刻 409；未超限把这次读的 rootRaw/rootEtag 喂回 openIndex，净开销与原来一致。
  const probe = await probeIdxRoot(store);
  if (1 + probe.shards + 4 > 48) {
    return json({ error: `书库分片过多（${probe.shards} 片），标签合并超出单请求预算，请稍后重试` }, 409);
  }
  const idx = await openIndex(store, probe.opts);
  // #145 P3-1：1+K+4 > 48 时连一本都装不下（每本 2 + 每脏片 2 的最低开销）→ updated 恒 0。
  // 原实现返回 ok+updated:0+remaining:N，前端零进展守卫每轮仍要白跑一次全库扫描。
  // 超限明确报错，让前端立刻停。
  // ⚠️ 这条**留着**（不是死代码）：探针复用失败时（root 读失败 → shards 未知 → 按未超限放行）
  // 只有这里能拿到权威的 idx.shardCount 兜底。
  if (1 + idx.shardCount + 4 > 48) {
    return json({ error: `书库分片过多（${idx.shardCount} 片），标签合并超出单请求预算，请稍后重试` }, 409);
  }
  const hit = idx.books.filter((b) => (b.tags || []).includes(from));
  if (!hit.length) return json({ ok: true, updated: 0, remaining: 0 });

  // 分片版预算：已花 1+K（root+全部分片，标签命中必须全库扫）；
  // 每处理一本 +2（meta 读+写），每新增一个脏分片 +2（片写+bak）→ 1+K+2N+2k ≤ 48 贪心裁剪
  const shardNoOf = (id) => (Number.isInteger(idx.root.map[id]) ? idx.root.map[id] : -1);
  const shardSet = new Set();
  const targets = [];
  for (const b of hit) {
    const n = shardNoOf(b.id);
    const newS = shardSet.has(n) ? shardSet.size : shardSet.size + 1;
    // 预算只算**本次实际要发的**请求：1（root 读）+ K（全片读——标签命中必须全库扫）+ 每本 2
    // （meta 读+写）+ 每脏片 2（片写+bak）。
    // ⚠️ **不预扣冲突重放开销**（2026-09-17 二次复查 R1，实测复现）：全量模式的重放要重读 root+K 片
    // 再重写（≈2+K+2k），K 大时（2 万本/40 片）连 1 本都装不下 → 预留会让本端点**恒零进展**
    // （K≥20 时 updated 恒为 0，前端 guard<60 白跑 60 轮全库扫描，共 ~2460 子请求）。
    // 冲突改由 save({replay:false}) 抛给本端点 → 返回可续调响应（下面），前端循环重发即可。
    // #145 P3-2：同上 —— mutateMeta tries=2，每本最坏 4 个子请求（读+写败+读+写）而非 2。
    if (1 + idx.shardCount + 4 * (targets.length + 1) + 2 * newS > 48) break;
    shardSet.add(n);
    targets.push(b);
  }
  if (!targets.length) return json({ ok: true, updated: 0, remaining: hit.length });
  // 每本「读—改—写」走 CAS（并行；子请求数与旧 readBook + putText 相同，见上方预扣注释）
  const now = Date.now();
  const patches = new Map();
  const results = await Promise.all(
    targets.map((b) =>
      mutateMeta(store, b.id, (meta) => {
        const next = [];
        for (const t of meta.tags || []) {
          if (t === from) {
            if (to && !next.includes(to)) next.push(to); // 改名/合并：落到目标标签（已存在则不重复）
            continue;
          }
          // to 不能在此无条件跳过：index 声明 from 但 meta 已无 from（meta 写波成功、idx.save
          // 失败的残留态，重试必然命中）时，跳过会把书上的 to 清掉。去重由 includes 保证——
          // from 分支 push to 前已查重、这里放行 to 也不会重复。
          if (!next.includes(t)) next.push(t);
        }
        meta.tags = next.slice(0, TAG_MAX);
        meta.updatedAt = now;
        return { out: { tags: meta.tags, updatedAt: meta.updatedAt } };
      }, null, 2) // tries=2：同 apiBatchBooks —— 批量路径重试开销计入子请求预算
    )
  );
  for (let i = 0; i < targets.length; i++) if (results[i].ok) patches.set(targets[i].id, results[i].out);

  // 与 apiBatchBooks 同因：这里与 hit 过滤读的是同一份内存快照（openIndex 在过滤前已打开，
  // 中间只 await 各书 meta 写入），外部并发改不了它 → 守卫恒不触发（2026-09-18 审计实测）。
  // 保留作防御；真正覆盖并发软删的是下面 idx.save 的冲突 catch（replay:false → 交回客户端重发）。
  let mergeSkip = 0;
  if (patches.size) {
    for (const [id, p] of patches) {
      if (!idx.get(id)) { mergeSkip++; continue; }
      idx.patch(id, (x) => ({ ...x, ...p }));
    }
    try {
      // 全量模式**不自己做冲突重放**：重放开销（重读 root+K 片 + 重写）在 K 大时会把 50 子请求
      // 顶破，反而拿不到能续调的响应。本端点本来就按 remaining 分段推进、前端循环到 remaining=0
      // 才收手（app.js 的 tagMergeRun），meta 写入也是幂等的 → 冲突时交回客户端重发一轮补齐索引
      // （2026-09-17 二次复查 R1）。
      await idx.save({ bak: true, replay: false });
    } catch (e) {
      if (!isIdxConflict(e)) throw e;
      // meta 那批已经写完（幂等，重发会重算），索引没落盘 → 报 0 并让前端重发一轮
      return json({ ok: true, updated: 0, remaining: hit.length, retry: true });
    }
  }
  // #144 P3：meta CAS 失败（results 无 ok）的书既没生效、也不在 remaining 里 —— 剩余命中
  // 恰好全是失败书时 remaining=0，前端（tagMergeRun）提前收手，这几本书的 from 标签永久残留。
  // 失败数加回 remaining，让下一轮重调把它们再扫进来（meta 写入幂等，重算无害）。
  const failed = targets.length - patches.size;
  return json({
    ok: true,
    updated: patches.size - mergeSkip,
    remaining: Math.max(0, hit.length - targets.length + failed),
  });
}


/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { apiBatchBooks, apiTagsList, apiTagsMerge };
