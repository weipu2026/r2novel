/**
 * r2novel — 书架索引 v2：分片存储 / 摘要对账 / handle 保存
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { getWithEtag, tryParseJson, readJson, putIf, json } from '../core/base.js';
import { KEY_IDX, KEY, IDX_SHARD_MAX, IDX_SAVE_TRIES } from '../core/const.js';
import { openIndex } from './open.js';

/* ---------------- 数据读写助手 ---------------- */

/** 路由参数白名单：id / 章节 key 仅允许 URL 安全字符，杜绝存储路径注入（dev fs / R2 key） */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const isSafeId = (s) => SAFE_ID.test(s || '');

function newId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let n = 0;
  for (let i = 0; i < b.length; i++) n = n * 256 + b[i];
  return 'n_' + n.toString(36); // 全程保留（约 13 位 base36），不做无谓截断
}

const safeStr = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>"'\\/]/g, '').slice(0, max).trim();

/** 字数统计（去所有空白后计数）—— 实现单点在 shared-text.js 的 countWords，与前端 cleaner 同一份；
 *  此处以别名 wordsOf import，调用点（增量字数修正）保持原样。 */

/* ---------------- 书架索引：v2 分片存储（千本级写放大消除 + 损坏自愈） ----------------
 * v1 是单文件 meta/index.json，任何一本书的任何改动都要全量重写（千本 ≈300KB/次），
 * 且 readIndexRaw 解析失败会静默回落空书架、下一次写把空架固化 —— 真·数据丢失路径。
 * v2 分片后：
 *   写 = 只写脏分片（+片级 bak）+ 成员变化时的 root（+bak），写放大 O(全库)→O(分片)；
 *   读 = root + 分片聚合，GET /api/books 响应形状不变（前端零改动）；
 *   自愈 = root 坏→root.bak→由分片内容重建；分片坏→片.bak→仍坏则**按空片处理且拒绝写入**
 *         （书在 R2 里的 meta 都还在，会以「无主书」出现在残留扫描，经回收站即可找回）。
 * 迁移：首次 openIndex 发现 root 不存在 → 读 v1 index 切片写 root/分片，零手工、用户无感；
 *       index.json 本体保留不动（回滚旧代码时仍有完整只读快照）。
 */
const looksRoot = (r) =>
  !!r && r.v === 2 && Number.isInteger(r.shards) && r.shards >= 0 && r.map && typeof r.map === 'object';

const readIndex = (store) => openIndex(store).then((h) => ({ books: h.books }));

// #145 P3-1：分片数熔断线（与 opds 原有 inline 检查同一把尺）。全量读索引 = 1+K 个子请求，
// K≥49 直接顶穿平台 50 硬顶；且各端点自身还要花 trash 读 / meta 读 / list 页 —— 早在 50 之前
// 就已无预算干活（diag room=0、purge deleted=0、tags updated=0）。41 片 ≈2.05 万本：
// 超限的端点先探 root（1 次读）再决定，报 409 + 可操作指引，而不是 502/500 或死循环续调。
const IDX_SHARD_CAP = 40;
/** 探测 root 声明的分片数（1 次读，**不读分片**）。给「熔断判据必须在全量读之前」的端点用。
 * 返回 { shards, opts }：
 *   · shards = 分片数；探不出（读失败 / 缺失 / 双坏）→ 0 = 「未知」→ 调用方按未超限继续，交给
 *     openIndex 自己的自愈链（bak → 由分片重建）去处理；
 *   · opts 可直接喂给 openIndex(store, opts) 复用这次读（省 1 子请求）。**读失败时是 undefined**：
 *     那种情况下 rootRaw=null 只表示「没读到」，当成「root 不存在」喂进去会让 openIndex 误判成
 *     新装库去 migrateV1（把 v2 分片库当 v1 重迁）—— 所以宁可不复用。
 *   #145 R11：原实现（只认主 root、探不出即 fail-open 返回 0）在 root 损坏时会让熔断线彻底失效，
 *   而 root 损坏恰恰是要走「由分片重建」→ 必然全量读分片的最坏场景。故这里补一次 bak 兜底，
 *   只为拿分片数这个判据；内容仍由 openIndex 统一走它自己的 bak/重建语义，不在这里复述。 */
async function probeIdxRoot(store) {
  let probe;
  try {
    probe = await getWithEtag(store, KEY_IDX.root);
  } catch {
    return { shards: 0, opts: undefined }; // 读失败：不复用、不判超限（别把「没读到」当「不存在」）
  }
  const raw = probe ? probe.text : null;
  const opts = { rootRaw: raw, rootEtag: probe ? probe.etag : null };
  const root = raw != null ? tryParseJson(raw) : null;
  if (looksRoot(root)) return { shards: Number(root.shards), opts };
  const bak = await getWithEtag(store, KEY_IDX.rootBak).catch(() => null);
  const rb = bak ? tryParseJson(bak.text) : null;
  return { shards: looksRoot(rb) ? Number(rb.shards) : 0, opts };
}

/** 探测 root 分片数是否超熔断线。返回超限时的分片数（0 = 未超限 / 探不出）。
 * cap 默认是全站熔断线；个别端点自己的预算判据更松/更紧时按自己那条传（见 apiTagsMerge /
 * apiPurgeOrphans —— 探针只负责把**该端点的既有判据**前移，不改变判据本身）。 */
async function shardCapExceeded(store, cap = IDX_SHARD_CAP) {
  const p = await probeIdxRoot(store);
  return p.shards > cap ? p.shards : 0;
}

const readTrash = (store) =>
  readJson(store, KEY.TRASH, { books: [] }).then((j) => (j && Array.isArray(j.books) ? j : { books: [] }));

/** #145 P3-3：建书/更新期（creating）书才有正文直写路径（已发布书被 status==='ready' 的 409
 * 挡住）。但 creating 书被软删后条目就躺在 trash.json 里等 purge —— 此时续传的正文全是白写：
 * purgeOnce 连 meta 带 text/<id>/ 前缀一并删。补一道 trash 守卫挡掉这个竞态窗口。
 * ⚠️ 不能照抄 apiUpdateChapters 的 indexHas —— creating 书压根不进索引（建书只写 meta+status，
 * 进索引是 publish/restore 的事），用了会把每一次正常上传都拦成 404。 */
const inTrash = async (store, id) => {
  const t = await readTrash(store).catch(() => ({ books: [] }));
  return (t.books || []).some((b) => b.id === id);
};

/** trash 原文 → { books: [...] }（缺失/损坏/结构不对一律当空表，与 readJson 同判据） */
const parseTrash = (t) => {
  const j = t != null ? tryParseJson(t) : null;
  return j && Array.isArray(j.books) ? j : { books: [] };
};

/**
 * trash.json 的「读—改—写」（CAS 乐观锁 + 冲突重放）。与 updateBrute 同源：整文件无条件覆盖写
 * 会让并发的两次「摘条目」互相吃掉对方 —— 被吃掉的那本书既不在索引也不在回收站，UI 里彻底消失
 * （meta/正文还在 R2，只能靠「检查残留」找回）。软删 / 批量软删 / 恢复 / 彻底删除都会碰它。
 * mutate(t) 就地改 t 并返回 { out, dirty }；dirty === false 表示无需落盘。
 * ⚠️ mutate **可能被重放多次**：结果必须每次都从 t 重新推导，外层计数要累加就先清零。
 * pre：调用方已经读过一次（恢复要先按 id 找到条目）→ 传进来复用，省一次子请求；冲突重试时重新读。
 */
async function updateTrash(store, mutate, tries = 3, pre = null) {
  let snapshot = pre;
  for (let i = 0; i < tries; i++) {
    const cur = snapshot || (await getWithEtag(store, KEY.TRASH));
    snapshot = null;
    const t = parseTrash(cur && cur.text);
    const r = mutate(t);
    if (r.dirty === false) return r.out;
    const w = await putIf(store, KEY.TRASH, JSON.stringify(t), cur ? cur.etag : null);
    if (w.ok) return r.out;
  }
  // 重试耗尽（极端抖动）：再读一次最新状态叠加后无条件写。这里的失效方向必须偏保守 ——
  // 宁可多留一条可恢复记录，也不能把用户刚删的书从回收站里静默抹掉，所以不像索引那样直接抛错。
  const cur = await getWithEtag(store, KEY.TRASH);
  const t = parseTrash(cur && cur.text);
  const r = mutate(t);
  if (r.dirty !== false) await store.putText(KEY.TRASH, JSON.stringify(t));
  return r.out;
}

/** v1 单文件读取（迁移专用）：原文 + 解析一次拿两样 */
async function readIndexRaw(store) {
  const t = await store.getText(KEY.INDEX);
  let json = { books: [] };
  try {
    json = t != null ? JSON.parse(t) : { books: [] };
  } catch {
    json = { books: [] };
  }
  return { json, raw: t };
}

/** 书在架上的廉价判定：只读 root（1 次）。root 缺失/损坏时回落 openIndex（顺手迁移/自愈）。 */
async function indexHas(store, id) {
  const raw = await store.getText(KEY_IDX.root);
  if (raw != null) {
    const root = tryParseJson(raw);
    if (looksRoot(root)) return Number.isInteger(root.map[id]);
  }
  const h = await openIndex(store);
  return !!h.get(id);
}

/** 构造期对账：分片文件内容与 root.map 是**两处真相**（bak 回落、写盘半途失败都会让二者错位），
 * 而 books 读分片全文、get/patch/indexHas 只认 map —— 错位即「书架看得见、点进去 404」，
 * 下一次成员变更还会把错位 map 写回 root 把它固化。这里以「已读到的分片内容」为准把 map 修齐：
 *   ① 片里有、map 缺失或指向别片 → 补/改（同一 id 出现在多片时以**片号最小的那份**为准，
 *      其余副本摘除，免得书架出现两张同样的卡）
 *   ② map 里有、但该书所属分片**内容确凿读到**（raw 是字符串）却没这本书 → 摘除死指针
 * ② 的 raw 判据刻意放过「片缺失(raw===null)」与「片双坏(raw===undefined)」：那两种是
 * 「读不到」而不是「确认没有」，据此摘除会误删真书；partial=true（单书/并集模式只加载了
 * 部分分片）时同样只做 ①。返回 map 是否有改动（调用方据此置 rootDirty）。
 * 副作用：多片重复的 id 会从后出现的片里摘掉并标记该片脏（下次 save 时顺手清干净）。 */
function reconcileIdx(root, shardBooks, shardNo, shardRaw, dirty, partial, prunable = true) {
  let changed = false;
  const owner = new Set();
  const mapIds = Object.keys(root.map); // 提到循环外：② 要遍历它，K 片不该物化 K 次（2026-10-06 审计 P2-3）
  for (let si = 0; si < shardBooks.length; si++) {
    const n = shardNo[si];
    const arr = shardBooks[si];
    const keep = [];
    for (const b of arr) {
      if (!b || !b.id) continue;
      if (owner.has(b.id)) {
        dirty.add(si); // 同 id 多片副本（半写/回滚产物）：只留最早那片
        continue;
      }
      owner.add(b.id);
      keep.push(b);
      if (root.map[b.id] !== n) {
        root.map[b.id] = n;
        changed = true;
      }
    }
    if (keep.length !== arr.length) shardBooks[si] = keep;
    // ② 的安全前提是「root.shards 覆盖了磁盘上全部分片」：若盘上还有未被加载的片，那么
    // 「本片确凿读到却没有」的书很可能只是**住在那些没加载的片里**，据此摘除＝误删真书
    // （实测：指针落后一代时 501 本被摘成 251 本）。prunable=false（调用方已查明盘上分片数
    // 大于 root.shards）时整段跳过。
    if (partial || !prunable || typeof shardRaw[si] !== 'string') continue;
    // ② 必须遍历整个 map，但**每片重建一次 Object.keys(root.map) 是 O(K×N)**：40 片 / 2 万本
    // = 80 万次（实测 135ms），而 Workers Free 单请求 CPU 预算只有 10ms —— 净效果是把
    // 「2 万本」从「能跑」变成「CPU 顶格」（2026-10-06 审计 P2-3）。改用循环外的 mapIds；
    // map 会在循环内被 delete，故用 `in` 复查存在性（不缓存值）。
    for (const id of mapIds) {
      if (id in root.map && root.map[id] === n && !owner.has(id)) {
        delete root.map[id];
        changed = true;
      }
    }
  }
  return changed;
}

function makeHandle(store, root, shards, opts = {}) {
  const shardBooks = shards.map((s) => s.books);
  const shardRaw = shards.map((s) => s.raw); // 各片原文（写 bak 用；null=新片）
  const shardMissing = shards.map((s) => !!s.missing); // 片与片 bak 都不存在（≠损坏：没有可丢的内容）
  const shardNo = shards.map((s) => s.n);
  // 各片主文件的版本号（CAS 用）。判据：**只有拿到了真实版本号的片才加条件**——新建片（拆片/首片）
  // 与「片文件本来就不存在」都没有可对号的旧版本，无条件写才会收敛：否则上次失败留下的孤儿片
  // （写成了但没进 root）会让重试永远撞「版本已变」，把一次瞬时冲突变成持续 500。
  const shardEtag = shards.map((s) => (typeof s.mainEtag === 'string' && s.mainEtag ? s.mainEtag : undefined));
  const dirty = new Set();
  let rootDirty = false;
  // 改动意图日志：save() 撞上 CAS 冲突时，用它在新盘面上重放这一轮的改动（见 save / saveOnce）。
  // 三条写方法各记一条，且必须**幂等**——upsert（已在架即原位覆盖）、patch（由 patchFn 重算）、
  // remove（删两次等价）。重放而不是把重试交给调用方：调用方只关心「最终索引里有哪些书」，
  // 不关心中途撞了几次冲突；做在 save() 里也意味着 7 个 mutate+save 调用点一次全覆盖。
  const opLog = [];
  // root 当前原文（rootDirty 写 bak 的「写前状态」）。null=此前 root 不存在（迁移/新库），
  // 此时没有可备份的旧布局——绝不能拿「空 root」当 bak（回退会得到合法但空的假布局），
  // 跳过一次 root bak，自愈链会落到「由分片重建」。
  let rootRaw = opts.rootRaw != null ? opts.rootRaw : null;
  // root 的版本号（openIndex 读 root 时拿到；migrate/rebuild 自己写完 root 后拿到新值）。
  // 非字符串 → 不做条件（理由同 shardEtag：没有可对号的旧版本）。
  let rootEtag = typeof opts.rootEtag === 'string' && opts.rootEtag ? opts.rootEtag : undefined;
  // 上面那条禁忌的**另一半**：root 存在但 shards:0（迁移空库后发布第一本书时正是这状态）
  // 同样没有值得备份的旧布局。实测过：拿它当 bak，一次 root 损坏就回落到「合法空书架」——
  // 书架 0 本，再发布还会覆盖首片，首书条目永久消失。判据＝「写前 root 是有效布局且至少 1 片」；
  // 每次 save 落盘后按新 root 重算。
  const parsedRootRaw = rootRaw != null ? tryParseJson(rootRaw) : null;
  let rootBakUsable = !!looksRoot(parsedRootRaw) && parsedRootRaw.shards > 0;
  if (reconcileIdx(root, shardBooks, shardNo, shardRaw, dirty, !!opts.partial, opts.prunable !== false)) rootDirty = true;

  const siOfShardNo = (n) => shardNo.indexOf(n);

  // 冲突重试时用哪套「打开参数」重读盘面：与首次调用**同模式**（single 保持 single，不让单书
  // 热路径在重试时退化成全量读），但必须丢掉 rootRaw/rootEtag —— 那是上一轮的快照，带着它
  // 重试＝拿旧状态重放，必然再撞一次冲突。
  const reopenOpts = () => {
    if (opts.single) return { single: opts.single, append: !!opts.append };
    if (opts.ids) return { ids: opts.ids };
    return {};
  };

  const h = {
    shardCount: root.shards, // 全量分片数（diag 等预算敏感方核算子请求用）
    root, // 预算敏感调用方（批量/标签）读 map 核算分片跨度用；勿直接改
    get books() {
      if (opts.single) throw new Error('单书模式无全量 books（应改用 full 模式）');
      return shardBooks.flat();
    },
    get(id) {
      const si = siOfShardNo(root.map[id]);
      if (si < 0) return undefined;
      return shardBooks[si].find((b) => b.id === id);
    },
    /** 原位替换/追加条目。已在架 → 保持原位（比 v1 的「删了再 push 到末尾」更稳定）；
     * 新成员 → 追加到最后一片，满片对半拆（拆分保持片内顺序，全局顺序在拆分处重排——前端本来就要排序，无感） */
    upsert(id, entry) {
      opLog.push({ op: 'upsert', id, entry });
      let si = siOfShardNo(root.map[id]);
      if (si >= 0) {
        const arr = shardBooks[si];
        const i = arr.findIndex((b) => b.id === id);
        if (i >= 0) arr[i] = entry;
        else arr.push(entry);
        dirty.add(si);
        return;
      }
      if (!shardBooks.length) {
        shardNo.push(root.shards); // 首片
        shardBooks.push([]);
        shardRaw.push(null);
        shardEtag.push(undefined); // 新片：盘上还没有 → 无条件写（不必 CAS，也无从 CAS）
        shardMissing.push(false); // 新片：文件还不存在，但里面没有可丢的内容（≠坏片的读不到）
        root.shards += 1;
      }
      const t = shardBooks.length - 1; // 最后一片
      shardBooks[t].push(entry);
      root.map[id] = shardNo[t];
      dirty.add(t);
      rootDirty = true;
      if (shardBooks[t].length > IDX_SHARD_MAX) {
        // 对半拆：尾半移入新片（文件号取 root.shards 顺延）
        const arr = shardBooks[t];
        const tail = arr.splice(Math.ceil(arr.length / 2));
        const newN = root.shards;
        shardNo.push(newN);
        shardBooks.push(tail);
        shardRaw.push(null);
        shardEtag.push(undefined); // 新片（无条件写，理由同上）
        for (const b of tail) root.map[b.id] = newN;
        root.shards = newN + 1;
        dirty.add(t);
        dirty.add(shardNo.length - 1);
      }
    },
    /** 原位打补丁（entry 对象由 patchFn 返回替换），书必须在已加载的片里 */
    patch(id, patchFn) {
      opLog.push({ op: 'patch', id, fn: patchFn });
      const b = h.get(id);
      if (!b) throw new Error(`patch: 书 ${id} 不在已加载分片中`);
      const si = siOfShardNo(root.map[id]);
      shardBooks[si][shardBooks[si].findIndex((x) => x.id === id)] = patchFn(b);
      dirty.add(si);
      return shardBooks[si].find((x) => x.id === id);
    },
    remove(id) {
      opLog.push({ op: 'remove', id });
      const si = siOfShardNo(root.map[id]);
      if (si < 0) return false;
      const arr = shardBooks[si];
      const i = arr.findIndex((b) => b.id === id);
      delete root.map[id];
      rootDirty = true;
      if (i < 0) return false;
      arr.splice(i, 1);
      dirty.add(si);
      return true;
    },
    /** 落盘：只写脏分片（bak=该片写前原文）+ 成员变化时的 root（bak=写前原文）。
     * bak:false 用于进度镜像这类高频小写（v1 语义：镜像不写 bak）。
     * replay:false → 撞 CAS 冲突不自己重放，直接抛给调用方（全量模式端点用，见 apiTagsMerge）。
     * replay: 数字 → 最多自己重放几次（预算敏感端点用，见 apiBatchBooks）。默认 2 次；重放次数
     *   直接决定子请求上界，所以预留了重放开销的调用方必须把它限死，预留才是精确值。
     * allowUpsert: async (id)=>bool —— **只在重放路径**上问一次「这条 upsert 还该落盘吗」。重放跑在
     *   CAS 冲突之后，比首次写又多出一整段 RTT 窗口，期间盘面可能已变到「不该再上架」（apiPublish 的
     *   回收站复检过去正是被这段窗口绕过的）。返回 false → 该 id 计入 skipped，不写盘（#145 R9）。
     * 返回 { skipped:[id...] }：重放时被跳过（书已被并发删除 / 被 allowUpsert 否决）的 patch|upsert id。 */
    async save({ bak = true, replay = true, attempt = 0, allowUpsert = null } = {}) {
      try {
        await saveOnce(bak);
      } catch (e) {
        // 索引 CAS 冲突（盘面被别人改过，P2-6：两个标签页同时发布 → 后写者整文件覆盖前者）：
        // 重开索引拿新盘面 → 按 opLog 重放本轮的改动 → 再写一次。attempt 是内部计数，调用方别传。
        const maxReplay = replay === false ? 0 : typeof replay === 'number' ? replay : IDX_SAVE_TRIES - 1;
        if (!isIdxConflict(e) || attempt + 1 > maxReplay) throw e;
        const again = await openIndex(store, reopenOpts());
        const skipped = [];
        for (const o of opLog) {
          if (o.op === 'upsert') {
            // #145 R9：重放的 upsert 是**无条件上架**（patch 有 again.get 守卫、remove 幂等，只有它会
            // 把不在架的书加回去）。它跑在 CAS 冲突之后 —— publish 的两处回收站复检全在这之前，
            // 拦不到这段窗口 → 并发软删的书会被「复活」成在架+回收站双态，随后 purgeOnce 删掉在架书。
            // 由调用方带 allowUpsert 复检（publish 传回收站检查）；否决即计入 skipped。
            if (allowUpsert && !(await allowUpsert(o.id))) skipped.push(o.id);
            else again.upsert(o.id, o.entry);
          } else if (o.op === 'patch') {
            // 重放时书可能已被并发软删（新盘面的 map 里没有它）——patch 对不在架的书会抛
            // 非冲突错误 → 500。软删语义已吸收这次改动，跳过即可（2026-09-17 复查 F2）。
            if (again.get(o.id)) again.patch(o.id, o.fn);
            else skipped.push(o.id);
          } else again.remove(o.id);
        }
        // replay 必须带下去：否则嵌套那层用默认的 2 次重放，限次形同虚设（实测会多写一次 root）
        const sub = await again.save({ bak, replay, attempt: attempt + 1, allowUpsert });
        // 本 handle 的待落盘改动已由 again 那份落盘 → 清空，免得再次 save 拿旧内存态覆盖回去
        dirty.clear();
        rootDirty = false;
        opLog.length = 0;
        // 嵌套那层重放的是同一份 opLog（超集）→ 优先用它报的 skipped
        const miss = (sub && sub.skipped) || skipped;
        return miss.length ? { skipped: miss } : undefined;
      }
      // 落盘成功：本轮意图已持久化 → **必须清空 opLog**（2026-09-17 二次复查 R4）。留着它，
      // 同一个 handle 再 save 一次并撞冲突时，会把上一轮的陈旧改动（旧快照）一起重放回盘上，
      // 把并发方在这期间写的值覆盖掉——正是本轮在修的那类丢失更新。
      opLog.length = 0;
      return undefined;
    },
  };
  return h;

  /** 真正的落盘（原 save 主体）。被 save 包在 try 里以处理 CAS 冲突重放；单独拿出来是因为
   * 函数声明会提升，可以写在 return 之后，把「冲突重放」与「写序铁律」两件事分开表述。 */
  async function saveOnce(bak) {
      // 写序铁律（2026-09-16 审计修复）——**指针(root)先落、数据(分片)后落**。
      // 这里是「更新」路径，与 migrateV1（首次创建）的写序**相反**，不要照抄那边：
      //   · 数据先、指针后 + 指针写失败 → 磁盘「数据新、指针旧」。全量加载只到旧 shards，
      //     而 reconcileIdx ② 会把「指针说在本片、本片确凿读到却没有」的书当死指针摘掉，
      //     残缺指针随即被落盘固化（实测：501 本 → 251 本，分片文件还在但索引不认）。
      //   · 指针先、数据后 + 数据写失败 → 指针指着的内容未更新，对账 ①/② 都能自愈、书不会消失，
      //     最坏等于该次操作没生效（可重试）。
      // ① 前置校验必须早于任何写：否则「root 已更新、某片因双坏被跳过」会把指针推到与新数据不一致的位置。
      for (const si of dirty) {
        // 片**双坏**（读到字节但解析不了）→ 拒绝覆盖，留人工抢救的余地；片与片 bak **都不存在**
        // （迁移半途/外部删除）→ 没有可丢的内容，允许重建写入，否则一个缺失的片文件会让全库
        // 永久无法发布（save 一律 throw → 500）。
        if (shardRaw[si] === undefined && !shardMissing[si]) {
          throw new Error(`分片 ${shardNo[si]} 内容损坏且无备份，拒绝覆盖（避免固化数据丢失）`);
        }
      }
      // ② 写序（2026-09-17 审计补完）：判据不是「直觉上哪个更稳」，而是**失败后落在哪一侧**：
      //   · 指针领先于盘（root.shards > 盘上分片数）→ **无人能修**：resumeMigration 要求全部分片
      //     缺失、预筛的 onDisk > root.shards 是反方向、对账 ② 又刻意跳过「读不到」的片。实测 501 本
      //     的库拆片时 s1 写失败 → 重启只剩 251 本可见，且下一次 save 把僵尸指针固化。
      //   · 指针落后于盘（盘上分片数 > root.shards）→ 有覆盖：预筛走 rebuildIdxRoot 按盘重建 ✓
      //   · 只改既有片（shards 不变）→ 指针先落是对的：数据写失败时指针指着的内容没变，等于本次没生效
      // 因此：**本次新建了分片（首片/拆片）时，顺序必须是「新片 → 既有片 → root」**，让任何一种
      // 单点失败都落在「等于本次没发生」或「有人管」的一侧；没有新片时沿用「root 先、数据后」。
      // null=本次新建、盘上还没有；undefined=缺失片（missing，无内容可丢，同样该走「新片先落」序，
      // 否则 root.map 指向尚未重建的片=指针领先于盘。双坏片走不到这里（前置校验已拒绝覆盖）。
      // （2026-09-17 复查 F7）
      const fresh = [...dirty].filter((si) => shardRaw[si] == null);
      const writeRoot = async () => {
        if (!rootDirty) return;
        const next = JSON.stringify(root);
        // root 走 CAS（P2-6 的关键一步）：两个并发发布都会改 root，谁后写谁吃掉对方 —— 版本号一变
        // 就报冲突，由 withIdxRetry 重读重放。bak 是「写前状态」的快照（内容就是旧 root），不做 CAS。
        const jobs = [putIf(store, KEY_IDX.root, next, rootEtag)];
        if (bak && rootBakUsable) jobs.push(store.putText(KEY_IDX.rootBak, rootRaw));
        const [res] = await Promise.all(jobs);
        if (!res.ok) throw idxConflict('root');
        rootRaw = next;
        rootEtag = res.etag;
        rootBakUsable = root.shards > 0; // 落盘后「写前状态」即新布局
        rootDirty = false;
      };
      const writeShards = async (list) => {
        const jobs = [];
        for (const si of list) {
          const body = JSON.stringify({ books: shardBooks[si] });
          // 分片也走 CAS：同一片被两个请求并发读—改—写时，后写者会吃掉前者的书条目。
          const bakP = bak ? store.putText(KEY_IDX.shardBak(shardNo[si]), shardRaw[si] != null ? shardRaw[si] : body) : null;
          // 防悬挂 rejection（2026-09-17 复查 F6）：主片 putIf 若以 rejection 失败，下面的 .then
          // 不执行 → bakP 无人接管 → unhandledRejection 可打死 dev-server。先挂空 catch 占住
          // 处理位；成功分支里仍会 await bakP 拿真实结果（bak 写失败照旧让本次 save 失败）。
          if (bakP) bakP.catch(() => {});
          jobs.push(
            putIf(store, KEY_IDX.shard(shardNo[si]), body, shardEtag[si]).then(async (res) => {
              if (!res.ok) throw idxConflict('shard ' + shardNo[si]);
              if (bakP) await bakP;
              shardEtag[si] = res.etag;
              shardRaw[si] = body;
              shardMissing[si] = false;
              dirty.delete(si);
            })
          );
        }
        await Promise.all(jobs);
      };
      if (fresh.length) {
        await writeShards(fresh); // 新片先落：失败 ⇒ root 与既有片都没动，等于本次没发生
        await writeShards([...dirty]); // 既有片（放 root 之前：root 落后于盘有自愈覆盖）
        await writeRoot();
      } else {
        await writeRoot(); // 指针先落（既有片路径，第四轮审计的结论）
        await writeShards([...dirty]);
      }
  }
}

/** 读单个分片（带 bak 回落）。两级都坏 → broken（raw=undefined）：调用方 save() 会拒绝覆盖，
 * 书的 meta 本体仍在 R2，经「检查残留→无主书→移入回收站→恢复」可重建索引条目。
 * 两级**都不存在**（missing）→ 同样 raw=undefined，但语义是「没有内容可丢」，允许重新写入。 */
/** 索引并发冲突：CAS 版本已变（有人先写了）。必须由 withIdxRetry 捕获后重读重放，不该冒到 HTTP 层。 */
const idxConflict = (what) => Object.assign(new Error('索引并发冲突（' + what + '）'), { code: 'IDX_CONFLICT' });
const isIdxConflict = (e) => !!e && e.code === 'IDX_CONFLICT';

/* 并发重放：原 withIdxRetry 已删除 —— 它需要每个调用点自己把 mutate 包成闭包，7 处漏一处就等于
 * 那一处并发丢更新照旧。现在重放做在 makeHandle.save() 内部（opLog），调用点零改动且新增端点自动覆盖。 */

async function loadIdxShard(store, n) {
  const main = await getWithEtag(store, KEY_IDX.shard(n));
  const j = main ? tryParseJson(main.text) : null;
  // mainEtag：主片文件的版本号（写盘 CAS 用）。注意它只代表**主片当时**的状态——即便下文回落到
  // 片 bak，CAS 目标仍是主片（把 bak 内容写回主片时，必须先确认主片没被别人改过）。
  const mainEtag = main ? main.etag : null;
  if (j && Array.isArray(j.books)) return { n, raw: main.text, books: j.books, mainEtag };
  const bak = await getWithEtag(store, KEY_IDX.shardBak(n));
  const jb = bak ? tryParseJson(bak.text) : null;
  if (jb && Array.isArray(jb.books)) return { n, raw: bak.text, books: jb.books, mainEtag };
  // broken：不落盘、不静默清空；missing：片与片 bak 都不存在（迁移中断/被外部删除）
  return { n, raw: undefined, books: [], mainEtag, missing: main == null && bak == null };
}

/** v1 → v2 迁移 + 新库初始化（root 不存在时的唯一入口）。
 * 迁移把 v1 books 按序**均匀整块**切片（500/片），v1 原文另存 v1Bak，index.json 本体冻结保留。
 * 不走「逐本 append + 满片拆」——那会留下一串 251/250 的参差片；整块切布局确定、一次写齐。
 * root 首次落盘没有「写前状态」→ 不写 root bak（自愈链有「由分片重建」兜底）。 */

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { isSafeId, newId, safeStr, looksRoot, readIndex, probeIdxRoot, shardCapExceeded, readTrash, inTrash, parseTrash, updateTrash, readIndexRaw, indexHas, makeHandle, isIdxConflict, loadIdxShard };
