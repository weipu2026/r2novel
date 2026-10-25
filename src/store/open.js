/**
 * r2novel — 索引打开与自愈：v1 迁移 / root 重建 / openIndex
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { putIf, getWithEtag, tryParseJson } from '../core/base.js';
import { IDX_SHARD_MAX, KEY_IDX } from '../core/const.js';
import { readIndexRaw, makeHandle, loadIdxShard, looksRoot } from './shard.js';

async function migrateV1(store, { rootEtag = null } = {}) {
  // #144 P3（天花板标注）：迁移是**全量一次性**写（每分片 2 写 + v1 bak + root），分片数 K
  // 大时单请求放不下 → 依赖下方的幂等重跑续传（openIndex 见 root 缺失即重跑，已写的分片
  // putIf 无条件覆盖、无害）。生产已在 v2 上，此路径只在全新库/回档时走到，未做分批化。
  const { json: legacy, raw } = await readIndexRaw(store);
  const books = (legacy.books || []).filter((b) => b && b.id);
  const chunks = [];
  for (let i = 0; i < books.length; i += IDX_SHARD_MAX) chunks.push(books.slice(i, i + IDX_SHARD_MAX));
  const root = { v: 2, shards: chunks.length, map: {} };
  chunks.forEach((arr, n) => {
    for (const b of arr) root.map[b.id] = n;
  });
  // 写序：分片（含片 bak）与 v1 留档先落，**root 最后提交**。root 是「布局已就绪」的指针，
  // 与分片同批并发写而中途失败就会留下「root 说有 2 片、分片一个都没写」——那一状态下 root
  // 看着合法，自愈链把缺失片当空片（书架永久为空），发布还要撞 save() 的拒写 → 500。
  // 现在的顺序下最坏只是白写一遍分片：下次 openIndex 见 root 缺失，重跑一次迁移（幂等）。
  const pre = [];
  if (raw != null) pre.push(store.putText(KEY_IDX.v1Bak, raw));
  // 分片带版本号落盘（putIf 无条件写，只是把新版本号收下来给紧随其后的那次写用）
  const etags = await Promise.all(
    chunks.map(async (arr, n) => {
      const body = JSON.stringify({ books: arr });
      const res = await putIf(store, KEY_IDX.shard(n), body, undefined);
      await store.putText(KEY_IDX.shardBak(n), body); // 首份内容即 bak 基线
      return res.etag;
    })
  );
  await Promise.all(pre);
  // root 的条件写按调用场景区分（这点由 fix8b 才真正生效——此前「null」被三端 store 当成无条件写）：
  //   · rootEtag === null（首次迁移/新库，盘上没有 root）→ 「不存在才写」：两个请求同时触发迁移
  //     只有一个落盘，输的那个读回落盘的那份（迁移幂等）；
  //   · rootEtag 是字符串（resumeMigration 续传，盘上那个不完整的 root 就在那儿）→ CAS 覆盖它。
  //     这里**不能**用「不存在才写」：写入会直接失败，盘上 root 仍是「shards 虚高」的旧布局，
  //     而分片已按 v1 重切 —— 指针领先于盘，是 save() 注释里那个「无人能修」的状态。
  let w = await putIf(store, KEY_IDX.root, JSON.stringify(root), rootEtag);
  if (!w.ok) {
    const again = await getWithEtag(store, KEY_IDX.root);
    w = { ok: true, etag: again ? again.etag : undefined };
  }
  return makeHandle(
    store,
    root,
    chunks.map((arr, n) => ({ n, raw: JSON.stringify({ books: arr }), books: arr, mainEtag: etags[n] })),
    { rootRaw: null, rootEtag: w.etag }
  );
}

/** root 与 root.bak 双坏（极罕见）：由分片内容重建 root。分片文件名即分片号，成员归属从片内容推导。
 * 每片都经 loadIdxShard（含片 bak 回落）——重建是最后一环，不能比常规读更容易丢字节。 */
async function rebuildIdxRoot(store) {
  const l = await store.list('meta/idx/', 2);
  // 片号从「主片名」与「片 bak 名」两处一起收集：主片被外部删掉而片 bak 还在时，只认主片名会把
  // 那一整片从 map 里抹掉——本来可救的字节被重建动作自己丢掉。
  const nums = new Set();
  for (const o of l.objects) {
    const m = /^meta\/idx\/s(\d+)\.json(?:\.bak)?$/.exec(o.key);
    if (m) nums.add(Number(m[1]));
  }
  // 逐片走 loadIdxShard（主片 → 片 bak 回落），不再自己 getText/parse：重建路径必须与常规读共用
  // 同一套自愈判据，否则「主片坏、片 bak 好」时重建会拿空数组覆盖真相（P2-2）。
  // 主片与片 bak 都读不出的片 → books:[]：其书在 R2 的 meta/正文仍在，会以「无主书」出现在残留
  // 扫描里、经回收站找回；片号本身保留（不把「读不到」当成「确认没有」）。
  const shards = await Promise.all([...nums].sort((a, b) => a - b).map((n) => loadIdxShard(store, n)));
  // 片号有空洞（主片与片 bak 都被外部删掉）时补空占位片：重建后 root.shards 必须 = 最大片号+1，
  // 而全量加载是按 0..root.shards-1 逐个读的——少一格就会让高号片（内容完好）永远读不到。
  const hasN = new Set(shards.map((s) => s.n));
  const topN = shards.length ? shards[shards.length - 1].n : -1;
  for (let n = 0; n <= topN; n++) if (!hasN.has(n)) shards.push({ n, raw: undefined, books: [], missing: true });
  shards.sort((a, b) => a.n - b.n);
  const root = { v: 2, shards: shards.length, map: {} };
  for (const s of shards) for (const b of s.books) root.map[b.id] = s.n;
  const rootRaw = JSON.stringify(root);
  // 重建是最后一环：无条件写（上面已经确定性读出了全部片），但要把新版本号收下来交给 handle
  const writes = [putIf(store, KEY_IDX.root, rootRaw, undefined)];
  if (shards.length) writes.push(store.putText(KEY_IDX.rootBak, rootRaw)); // 空恢复结果同样不留 bak（见 makeHandle）
  const [w] = await Promise.all(writes);
  return makeHandle(store, root, shards, { rootRaw: shards.length ? rootRaw : null, rootEtag: w.etag });
}

/** 迁移续传：root 声称有分片、但 meta/idx/ 下**一个 s*.json 对象都不存在**，且 v1 快照里有书
 * → 认定「分片一次都没写成的半途迁移」（旧版把 root 与分片并发写，root 可能先落），重跑一次。
 * 只在确认没有任何分片对象时才动：存在任何分片对象就交给自愈链，绝不覆盖可能可抢救的字节。 */
async function resumeMigration(store, rootEtag = null) {
  const l = await store.list('meta/idx/', 2);
  if (l.objects.some((o) => /^meta\/idx\/s\d+\.json/.test(o.key))) return null;
  const { json: legacy } = await readIndexRaw(store);
  if (!(legacy.books || []).some((b) => b && b.id)) return null;
  // 续传时盘上 root 已存在（就是不完整的那份）→ 把它的版本号带下去做 CAS 覆盖（见 migrateV1）
  return migrateV1(store, { rootEtag });
}

/**
 * 打开书架索引。默认全量（root + 全部分片）；{ single: id } 单书模式只读 root + 该书所在片
 * （热路径：进度镜像/就地编辑/PATCH/软删/恢复——写只碰一片）；{ ids } 并集模式（批量治理）。
 * { single: id, append: true } 追加模式：调用方保证该书不在索引里（发布新书 / 回收站恢复），
 * 片里没有它时**不再退化成全量加载**——一片就够写，让这两个端点的开销与书库规模无关（P2-5）。
 */
export async function openIndex(store, opts = {}) {
  // opts.rootRaw：调用方（批量接口）已经读过一次 root 用来核预算，传进来复用，省 1 子请求；
  // 显式传 undefined（而不是 null）才重新读——null 表示「root 确实不存在」，语义不同。
  // opts.rootEtag：与 rootRaw 配套的版本号（批量接口复用那次读时一起传进来）。
  // 注意：即使下面的 root 内容实际来自 root.bak，CAS 目标仍是**主 root 对象**，所以这里记的是
  // 主对象的版本（不存在 → null，表示「不存在才写」；老 store 无版本 → undefined，不加条件）。
  let rootRaw;
  let rootEtag;
  if (opts.rootRaw !== undefined) {
    rootRaw = opts.rootRaw;
    rootEtag = opts.rootEtag;
  } else {
    const o = await getWithEtag(store, KEY_IDX.root);
    rootRaw = o ? o.text : null;
    rootEtag = o ? o.etag : null;
  }
  let root = rootRaw != null ? tryParseJson(rootRaw) : null;
  let rootSrc = rootRaw;
  if (!looksRoot(root)) {
    const bak = await getWithEtag(store, KEY_IDX.rootBak);
    const rb = bak ? tryParseJson(bak.text) : null;
    if (looksRoot(rb)) {
      root = rb;
      rootSrc = bak.text;
    }
  }
  // 判据必须是 looksRoot 而不是真值判断：root.json 里是「合法 JSON 但不是 root 形状」
  //（如 []、{"v":2} 缺 map、误放的 v1 快照）时，tryParseJson 返回真值、上面 1038 的
  // bak 回落也救不了（rb 同样不 looksRoot）—— 直接用这个假 root 会在 root.map[...] 上
  // 抛 TypeError，所有 /api 一律 500，且没有任何写盘动作能让自愈链触发。
  if (!looksRoot(root)) {
    // root 缺失（新装 / v1）→ 迁移；root 与 bak 双坏 → 由分片重建
    if (rootRaw == null) {
      // ⚠️ 第四轮审计：「root 缺失」不等于「从未迁移」。migrateV1 会**无条件覆盖 s0..sK**，
      // 数据源是迁移时冻结的 meta/index.json —— 若迁移早已完成、之后又新增过书，而 root.json
      // 被外部误删，重放迁移会把整库索引回滚到那一刻（新增条目全丢，正文还在但索引不认）。
      // 反方向（root 在、分片全丢）有 resumeMigration 的「盘上无任何分片才动」保护，这一侧也必须
      // 有对称守卫：v1Bak 存在 ⇒ 迁移发生过 ⇒ 走「由分片重建」（幂等，以盘上分片为真相）。
      const v1bak = await getWithEtag(store, KEY_IDX.v1Bak);
      if (v1bak) return rebuildIdxRoot(store);
      // ⚠️ R150 P1-2：v1Bak 只在「迁移时确实读到过 v1 原文」才写（migrateV1 里 raw != null 才留档）。
      // 从头就是 v2 的库（生产正是这种）根本没有 v1Bak —— root 与 root.bak 双失时旧逻辑会落到
      // migrateV1，而它读不到 v1 index.json（books 为空）→ 写出 { v:2, shards:0, map:{} }：
      // **一个空 root 覆盖掉「root 不存在」这个本来可自愈的状态**，盘上分片全在、书架却永久 0 本，
      // 而且此后每次 open 都认为布局合法。判据必须与 resumeMigration 同一把尺：盘上还有分片
      // 就以盘为准重建（幂等，以分片内容为真相）。list 被截断时不敢断言「一个分片都没有」，
      // 同样走重建（重建自己会再 list 一次）。
      const l = await store.list('meta/idx/', 2);
      const hasShard = l.objects.some((o) => /^meta\/idx\/s\d+\.json(?:\.bak)?$/.test(o.key));
      if (hasShard || l.truncated) return rebuildIdxRoot(store);
      return migrateV1(store);
    }
    return rebuildIdxRoot(store);
  }

  if (opts.single) {
    // 单书模式：书已在片 → 该片；新书（恢复场景）→ 最后一片
    const n = Number.isInteger(root.map[opts.single]) ? root.map[opts.single] : Math.max(0, root.shards - 1);
    const shard = root.shards > 0 ? await loadIdxShard(store, n) : { n: 0, raw: null, books: [] };
    if (root.shards === 0) {
      root.shards = 1;
      shard.n = 0;
    }
    if (shard.books.some((b) => b && b.id === opts.single) || opts.append) {
      // 单书模式只加载一片 → 对账只做「补/改 map」，不做死指针摘除（看不到全局，会误删）。
      // opts.append：调用方已保证这个 id 不在索引里（发布新书 / 回收站恢复），要的是「能写进一片」；
      // 没有它时缺书会落到下面的全量加载（1+K 子请求）——2 万本/40 片下逼近 50 硬顶（P2-5）。
      // map 里有指针却在该片找不到（指针错位）时，append 让 upsert 往那片补条目，比全量加载
      // 更贴合「让 map 与分片内容自洽」，也不会多出一条同 id 记录。
      return makeHandle(store, root, [shard], { single: opts.single, rootRaw: rootSrc, rootEtag, partial: true });
    }
    // 兜底：指针说「在 n 片」而 n 片里根本没有它（指针错位/落后一代）。单书模式看不到全局、
    // 自己修不了它 —— 表现为书架看得见、点进去 404。这里**不返回**，落到下面的全量加载一次，
    // 借构造期对账 ① 把 map 修齐（代价是这一次多读 K-1 片，且只在异常态发生）。
  } else if (opts.ids) {
    const want = [...new Set(opts.ids.map((id) => root.map[id]).filter((n) => Number.isInteger(n) && n >= 0))];
    const shards = await Promise.all(want.sort((a, b) => a - b).map((n) => loadIdxShard(store, n)));
    return makeHandle(store, root, shards, { rootRaw: rootSrc, rootEtag, partial: true });
  }

  const shardNums = Array.from({ length: root.shards }, (_, i) => i);
  const shards = await Promise.all(shardNums.map((n) => loadIdxShard(store, n)));
  // 半途迁移的续传（只在全量模式下判定，且分片**一个都不存在**才算，见 resumeMigration）
  if (shards.length && shards.every((s) => s.missing)) {
    const resumed = await resumeMigration(store, rootEtag); // 复用上面那次 root 读的版本号
    if (resumed) return resumed;
  }
  // 死指针摘除（reconcileIdx ②）的安全前提：root.shards 覆盖了**磁盘上全部分片**。盘上若还有
  // 未被加载的片（指针落后一代 / 半写残留），「本片确凿读到却没有」的书其实住在那些片里，摘除
  // 就是误删。这里只做**廉价预筛**（纯内存）：map 条目数 vs 已加载片的书数 —— 只有前者更大
  // （确实存在「map 说有、已加载片里没有」的条目）时才多花 1 次 list 去数盘上分片数；
  // 正常路径（两者相等）零额外开销。
  let prunable = true;
  const loadedBooks = shards.reduce((n, x) => n + x.books.length, 0);
  if (Object.keys(root.map).length > loadedBooks) {
    try {
      const l = await store.list('meta/idx/', 2);
      const onDisk = l.objects.filter((o) => /^meta\/idx\/s\d+\.json$/.test(o.key)).length;
      if (!l.truncated && onDisk > root.shards) {
        // 盘上分片数**多于** root.shards：指针落后一代（半写残留 / 旧 bak 回落）。此时高号片里的书
        // 既看不见也点不动（加载哪些片由 root.shards 决定），map 里虽还留着它们却永远不会被读。
        // 直接按盘上文件重建一次 root（幂等：rebuildIdxRoot 以文件名推导 shards 与各片归属）。
        return rebuildIdxRoot(store);
      }
      prunable = !l.truncated && onDisk <= root.shards;
    } catch {
      prunable = false; // 数不出来就不摘（保守优先）
    }
  }
  // full 模式覆盖全部分片 → 对账可做完整（含死指针摘除），且 root 原文复用不再重读
  return makeHandle(store, root, shards, { rootRaw: rootSrc, rootEtag, prunable });
}


