/**
 * r2novel — 残留扫描 / 页分配诊断
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { json, readJsonBody } from '../core/base.js';
import { KEY, KEY_IDX } from '../core/const.js';
import { readBook } from '../store/book.js';
import { openIndex } from '../store/open.js';
import { shardCapExceeded, readTrash, probeIdxRoot } from '../store/shard.js';


/* ---------------- 残留诊断 / 孤儿清理（书架「检查残留」） ----------------
 * 只读扫描全库对象，与「应有对象」（index + trash + 各书章表/orphans）做差集，分三类：
 *   residue        已删书伴生残留：对象在但既无清单记录也无 meta（删书漏删 / 中断残留）→ 可直接删对象
 *   orphanBooks    无主书：meta 在但 id 不在 index/trash（上传中断 / index 写失败）→ 不直接删，走「移入回收站」
 *   chapterOrphans 活书章表外正文：key 不在 chapters/orphans 之外（replace 等遗留）→ 可直接删对象
 * 删除接口只收 text|raw|progress 前缀，绝不接受 meta/*（系统文件与书元数据不可经此删除）。
 * 子请求预算：Free 单请求 ≤50。逐书 readBook 与 list 分页都计入，预算将尽即标记 incomplete
 *   截断（宁漏勿错），避免大书库把「检查残留」点成 500。
 */
const DIAG_SYS_KEYS = new Set([KEY.INDEX, KEY.INDEX_BAK, KEY.TRASH, KEY_IDX.v1Bak]);
// meta/idx/ 是书架索引 v2 的分片（root + s<N>），meta/index.json.v1.bak 是迁移留档——都不是书 meta
const DIAG_SYS_PREFIXES = ['meta/idx/', 'meta/index.json'];
// list 预算拆两类：meta/raw/progress 是「书数级」对象（每本各 1 个，千本 = 各 1 页）→ 给足预算保证完整；
// text/ 是「章数级」大头（每章 1 个，千本 50 章 = 50 页）→ 只给部分页数，截断即 incomplete（宁漏勿错）
const DIAG_META_PAGE_BUDGET = 3; // meta/raw/progress 各自翻页上限（每页 ≤1000 对象 → 覆盖约 3000 本）
const DIAG_TEXT_PAGE_BUDGET = 12; // text/ 单请求翻页上限（每页 ≤1000 对象）；超预算回传 textCursor 由前端续扫
const DIAG_SUB_BUDGET = 45; // 扫描/删除单请求子请求软预算

/** 诊断扫描单窗的 list 页数分配（#144 复验修正）：抽成纯函数以便单测直接钉不变量。
 *  计费口径：meta 1 份、raw 与 progress **各** 1 份（wantSide 要按 ×2 计；续扫窗 cont 两者都
 *  不发起 → 0 份）、text 1 份。优先级 meta → raw/progress → text，但**保底 text ≥1 页**。
 *  不变量：① 发出的 list 总数（侧前缀 ×2）绝不超 room；② room ≥ 4 时 text ≥ 1 页 ——
 *  它为 0 时本窗 lText.cursor 恒 null，前端会把「没扫」当成「扫完」停循环；③ cont 时 wantSide 恒 0。 */
export function diagPageAlloc(room, cont) {
  const sideCap = cont ? 0 : DIAG_META_PAGE_BUDGET;
  let meta = Math.min(DIAG_META_PAGE_BUDGET, Math.max(0, room));
  let text = Math.min(DIAG_TEXT_PAGE_BUDGET, room > 0 ? 1 : 0); // 保底 1 页（见不变量 ②）
  let side = 0;
  const spare = () => room - meta - 2 * side - text;
  meta += Math.max(0, Math.min(spare(), DIAG_META_PAGE_BUDGET - meta)); // 余量按 meta → 侧前缀 → text 补页
  if (sideCap) side += Math.max(0, Math.min(Math.floor(spare() / 2), sideCap - side));
  text += Math.max(0, Math.min(spare(), DIAG_TEXT_PAGE_BUDGET - text));
  // 夹紧：实际会发出的 list 数（侧前缀两份）绝不超 room —— 宁可少列也不撞 50 子请求硬顶
  while (text > 0 && meta + 2 * side + text > room) text--;
  while (side > 0 && meta + 2 * side + text > room) side--;
  while (meta > 0 && meta + 2 * side + text > room) meta--;
  return { wantMeta: meta, wantSide: side, wantText: text };
}
// 回验预算比总预算更紧：旧实现回验与删除共用同一计数器，待删清单里活书 key 一多，
// 回验就把预算吃满 → 删除阶段 `deleted=0`，本可零成本删除的非活书残留被白白跳过（清理变慢）。
// 给回验单独设上限，余下预算留给删除。
const DIAG_VALIDATE_BUDGET = 30;

async function apiDiagOrphans(url, store) {
  try {
    return await doDiagScan(store, url.searchParams.get('textCursor') || '');
  } catch (e) {
    // 扫描过程本身失败（R2 超限/超时等）→ 透传真实原因，前端可展示而非笼统 HTTP 503
    return json({ error: '残留扫描失败：' + (e && e.message ? e.message : e) }, 502);
  }
}

async function doDiagScan(store, textCursor = '') {
  const cont = !!textCursor; // 续扫窗：跳过 meta/raw/progress（书数级前缀，首页已完整），只扫 text/ 下一窗
  // #145 P3-1：分片熔断。K≥49 时 openIndex 自己就 1+K=50 个子请求 → 502；K≥43 起预算
  // room=0，一页都扫不出还把结果标成「扫完」。与 opds 同一把尺，超限明确 409。
  const over = await shardCapExceeded(store);
  if (over) return json({ error: `书库分片过多（${over} 片），残留扫描已暂停。请改用网页端逐本检查。` }, 409);
  const idx = await openIndex(store); // 全量：root + K 个分片（K 计入预算）
  const index = { books: idx.books };
  const budget = { used: 2 + idx.shardCount, incomplete: false }; // root+分片读 + trash 读（续扫窗同样需要 live 集合）
  const bump = () => {
    if (budget.used >= DIAG_SUB_BUDGET) {
      budget.incomplete = true;
      return false;
    }
    budget.used++;
    return true;
  };
  const trash = await readTrash(store);
  const live = new Set();
  const titleOf = new Map();
  for (const b of [...(index.books || []), ...(trash.books || [])]) {
    live.add(b.id);
    if (!titleOf.has(b.id)) titleOf.set(b.id, b.title || '');
  }

  const residue = [];
  const chapterOrphans = [];
  const orphanBooks = [];
  // #146 P3-5：清单被截断时「无法判断归属」的对象进这里（只展示，前端不提供一键删除）
  const unverified = [];

  // 分前缀并发 list：meta/raw/progress 是「书数级」对象（每本各 1 个，千本各 1 页）→
  // 给足预算保证无主书/已删残留永远完整；text/ 是「章数级」大头（每章 1 个，3 万章 = 30 页
  // > 单请求预算）→ 每窗只扫 DIAG_TEXT_PAGE_BUDGET 页，超出回传 textCursor，前端循环续扫直到 null。
  // 注意 meta/ 续扫窗也要重列：无主书 id 集合必须每窗重推，否则无主书的跨窗正文会被
  // 误判成「可直接删的 residue」（无主书本应移入回收站保全正文）——只多花 1-3 个子请求。
  const NO_LIST = { objects: [], truncated: false, pages: 0, cursor: null };
  // ⚠️ 页预算必须在**发起前**按剩余额度裁剪（2026-10-06 审计 P2-4）：四个 list 是无条件并发
  // 发出、事后才 budget.used += pages，于是守卫管不到已发出去的请求 → 上界
  // 1(root) + shards + (3+3+3+12) 在 40 分片时 = 62 > 50 → 502，「检查残留」在大库直接不可用
  //（而这正是大库最需要的运维工具）。余量不足时按优先级压页数（text/ 是章数级大头，先压它）。
  const room = Math.max(0, 47 - budget.used);
  // #144 P2-5：分配优先级 meta/raw/progress（书数级）**优先**、text/ 吃剩余 —— 旧实现先把
  // room 分给 text（pageCap 先算 wantText），40 分片时 room=6 被 text 吃满 → meta/raw/
  // progress 一页不列，且 room≥4 不标 incomplete → 静默漏扫还谎报「扫完」。
  // 页数分配见 diagPageAlloc（含「raw/progress 计费 ×2」与「text 保底 1 页」两条不变量，
  // 前者防止大分片时账面漏算顶破 50 子请求硬顶，后者防止前端把「没扫」当「扫完」停循环）。
  const { wantMeta, wantSide, wantText } = diagPageAlloc(room, cont);
  // 不完整的判据：① 连四路最低页预算都不够；② 本窗根本没发起 text/ 的 list（wantText=0 →
  // NO_LIST.cursor=null，前端会把「没扫」当成「扫完」停循环）；③ 首页却连书数级前缀
  //（raw/progress）一页都没列到。三者都必须标，别谎报「扫完了」。
  if (room < 4 || wantText === 0 || (!cont && wantSide === 0)) budget.incomplete = true;
  const [lMeta, lRaw, lProg, lText] = await Promise.all([
    wantMeta > 0 ? store.list('meta/', wantMeta) : Promise.resolve(NO_LIST),
    cont || wantSide <= 0 ? NO_LIST : store.list('raw/', wantSide),
    cont || wantSide <= 0 ? NO_LIST : store.list('progress/', wantSide),
    wantText > 0 ? store.list('text/', wantText, textCursor) : Promise.resolve(NO_LIST),
  ]);
  budget.used += lMeta.pages + lRaw.pages + lProg.pages + lText.pages;
  if (lMeta.truncated || lRaw.truncated || lProg.truncated) budget.incomplete = true;
  // #146 P3-5：meta/ 清单被截断 ⇒ orphanSet（无主书 id 集合）不完整 ⇒「不在索引里」不再等价于
  // 「没有主」。典型误判：一本 creating 态的书（有 meta/raw/text 却还没进索引），若它的 meta 恰好
  // 落在被截掉的那一页之后，它的原件与正文就会被当成「可直接删的残留」，被「删除全部」永久抹掉 ——
  // 而无主书本该走「移入回收站」保全正文。这类只能进 unverified：展示出来，但不给批量删除入口。
  const pushResidue = (o) =>
    (lMeta.truncated ? unverified : residue).push({ key: o.key, size: o.size });

  // meta/{id}.json → 无主书（系统 meta 文件排除）。候选先收集、预算内批量并发回读：
  // 预算尽则剩余标 unknown（宁漏勿错），已允许的并发一次读完（RTT 从串行 N 次降到一次）。
  // 续扫窗只重推 orphanSet 不再回读 meta 内容，orphanBooks 明细只在首页上报（前端只合并首页）。
  const orphanCands = [];
  const orphanSet = new Set();
  for (const o of lMeta.objects) {
    if (DIAG_SYS_KEYS.has(o.key) || o.key.startsWith('meta/sec/') || DIAG_SYS_PREFIXES.some((p) => o.key.startsWith(p))) continue;
    const id = o.key.slice(5, -5); // 去 'meta/' 前缀与 '.json' 后缀
    if (live.has(id)) continue;
    orphanSet.add(id);
    orphanCands.push({ o, id, canRead: !cont && bump() });
  }
  const mArr = await Promise.all(orphanCands.map((c) => (c.canRead ? readBook(store, c.id) : Promise.resolve(null))));
  for (let i = 0; i < orphanCands.length; i++) {
    const { o, id } = orphanCands[i];
    const m = mArr[i];
    orphanBooks.push({
      id,
      key: o.key,
      size: o.size,
      status: m && m.status ? m.status : 'unknown',
      title: m && m.title ? m.title : '',
      chapterCount: m && Array.isArray(m.chapters) ? m.chapters.length : 0,
      wordCount: m && Number(m.wordCount) ? Number(m.wordCount) : 0,
    });
  }

  // text/{id}/{key}.txt → 章表外正文 / 无主正文
  const textById = new Map();
  for (const o of lText.objects) {
    const rest = o.key.slice(5);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue; // 非预期 key 形状，忽略
    const id = rest.slice(0, slash);
    if (!textById.has(id)) textById.set(id, []);
    textById.get(id).push({ key: o.key, size: o.size, chKey: rest.slice(slash + 1, -4) });
  }
  // 先分出无主正文（书连 meta 都没有 → 列为残留可直接删；有 meta（无主书）→ 正文随书进回收站，不单列）
  const liveTextIds = [];
  for (const [id, items] of textById) {
    if (!live.has(id)) {
      if (orphanSet.has(id)) {
        // 续扫窗跳过：无主书正文已随首页 orphanBooks 呈现（跨窗大书可能少量少计「关联正文 N 段」，展示层小误差），
        // 绝不能落到 residue——无主书正文是要保全的，误列可删残留会被「删除全部」清掉
        if (!cont) {
          const ob = orphanBooks.find((b) => b.id === id);
          ob.texts = (ob.texts || 0) + items.length;
          ob.textBytes = (ob.textBytes || 0) + items.reduce((s, x) => s + x.size, 0);
        }
      } else {
        for (const it of items) pushResidue(it);
      }
      continue;
    }
    liveTextIds.push({ id, items });
  }
  // 活书正文分类：预算内并发 readBook（子请求数不变，RTT 从串行 N 次降到一次）
  let skippedBooks = 0;
  const liveMeta = await Promise.all(
    liveTextIds.map((x) => (bump() ? readBook(store, x.id) : Promise.resolve(null)))
  );
  for (let i = 0; i < liveTextIds.length; i++) {
    const { id, items } = liveTextIds[i];
    const m = liveMeta[i];
    if (!m) {
      // 预算尽 / meta 读不到：该书的窗内对象无法核验。计入 skippedBooks → incomplete，
      // 前端会提示「部分书未能核验」而不是静默漏检（宁漏勿错，但要说出来）。
      skippedBooks++;
      continue;
    }
    const have = new Set((m.chapters || []).map((c) => c.key));
    const known = new Set(Array.isArray(m.orphans) ? m.orphans : []);
    for (const it of items) {
      if (have.has(it.chKey)) continue;
      chapterOrphans.push({
        key: it.key,
        size: it.size,
        bookId: id,
        bookTitle: titleOf.get(id) || '',
        known: known.has(it.chKey), // 已在 meta.orphans 登记（惰性清理会兜底）→ known
      });
    }
  }

  // raw/{id}.txt、progress/{id}.json → 无主残留（书数级前缀已完整列出，不存在截断漏检）
  for (const o of lRaw.objects) {
    const id = o.key.slice('raw/'.length).replace(/\.(txt|json)$/, '');
    if (!live.has(id) && !orphanSet.has(id)) pushResidue(o);
  }
  for (const o of lProg.objects) {
    const id = o.key.slice('progress/'.length).replace(/\.(txt|json)$/, '');
    if (!live.has(id) && !orphanSet.has(id)) pushResidue(o);
  }

  const summary = { residue: residue.length, orphanBooks: orphanBooks.length, chapterOrphans: chapterOrphans.length, unverified: unverified.length };
  return json({
    scannedAt: Date.now(),
    liveBooks: live.size,
    summary,
    residue,
    // 未能核验（清单截断）：只展示，不参与任何批量删除
    unverified,
    orphanBooks,
    chapterOrphans,
    // text/ 下一窗的续扫游标：null = text/ 已扫完。前端循环带上它续调，直到 null，
    // 期间把 residue/chapterOrphans 增量合并（orphanBooks/summary 只在首页有意义）。
    textCursor: lText.cursor || null,
    scannedPages: lText.pages,
    skippedBooks,
    incomplete: budget.incomplete || skippedBooks > 0 || unverified.length > 0,
  });
}

/** 批量删除已确认无引用的对象（text/raw/progress 前缀）。只删对象，不经书 meta。
 * 删除前回验：在架/回收站活书的当前章节正文、raw、progress 一律拒删——阻止「扫描后 append
 * 复用孤儿 key」的竞态把活书正文误删。非活书对象直接放行；预算将尽时剩余 key 不回验也不删。 */
async function apiPurgeOrphans(req, store) {
  const bj = await readJsonBody(req, 2 * 1024 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const keys = Array.isArray(body.objects) ? body.objects.map(String) : [];
  if (!keys.length) return json({ error: '没有要删除的对象' }, 400);
  const ok = keys.filter((k) => /^(?:text|raw|progress)\/[^/]/.test(k) && !/\.\./.test(k));
  if (!ok.length) return json({ error: '没有可删除的合法对象' }, 400);

  // #145 R11：与 apiTagsMerge 同一处问题 —— 熔断判据（2+K ≥ 45）也必须在全量读之前。先探 root
  // （1 读）：超限立刻 409，不再白烧 1+K；未超限把这次读喂回 openIndex，净开销与原来一致。
  // cap 用 DIAG_SUB_BUDGET - 3：本端点判据是「2 + K ≥ B」⇔「K > B-3」，与下面那条逐一对应。
  const probe = await probeIdxRoot(store);
  if (probe.shards > DIAG_SUB_BUDGET - 3) {
    return json({ error: `书库分片过多（${probe.shards} 片），本次无法在请求预算内完成清理，请稍后重试` }, 409);
  }
  const idx = await openIndex(store, probe.opts); // 全量：root + K 分片（root 那次读复用上面的探针）
  const index = { books: idx.books };
  const trash = await readTrash(store);
  const live = new Set([...(index.books || []), ...(trash.books || [])].map((b) => b.id));
  let used = 2 + idx.shardCount; // 已读 root+分片 + trash
  // #145 P3-1：2+K ≥ 删除预算（45）时本端点不可能有进展 —— 原实现会把全部对象原样回传
  // deferred，前端续调循环每轮一次全库扫描却 deleted=0（K≥43 起白烧 60 轮）。明确报错。
  // ⚠️ 同样留着做权威兜底（探针读失败 → shards 未知 → 上面放行，这里才拿得到真值）。
  if (used >= DIAG_SUB_BUDGET) {
    return json({ error: `书库分片过多（${idx.shardCount} 片），本次无法在请求预算内完成清理，请稍后重试` }, 409);
  }
  const metaCache = new Map(); // 同一本书多个删除 key 只回验一次
  const toDelete = [];
  // 因预算未处理的对象（可续调）——与「确认拒删」分开回传：原实现两者混在 skipped 里，
  // 前端只能把它说成"被跳过"，被裁掉的残留永远删不完（L15）。
  const deferred = [];
  for (let i = 0; i < ok.length; i++) {
    const k = ok[i];
    const parts = k.split('/');
    // id 解析：text/<id>/<key>.txt 的 id 是 parts[1]；raw/<id>.txt、progress/<id>.json 只有一个斜杠，
    // parts[1] 带扩展名，须剥掉才能对上 live 集合（否则活书的 raw/progress 会被误判为非活书而放行）
    const id = parts[0] === 'text' ? parts[1] || '' : String(parts[1] || '').replace(/\.(txt|json)$/, '');
    if (!live.has(id)) {
      toDelete.push(k); // 非活书伴生残留，无需回验
      continue;
    }
    if (parts[0] !== 'text') continue; // 活书的 raw/progress 拒删（原件/进度属该书）
    let meta = metaCache.get(id);
    if (metaCache.has(id)) {
      // 命中缓存
    } else {
      if (used >= DIAG_VALIDATE_BUDGET) {
        // 回验预算尽：不回验也不删（宁漏勿错）。余下全部原样回传，交给下一轮继续。
        deferred.push(...ok.slice(i));
        break;
      }
      used++;
      meta = await readBook(store, id);
      metaCache.set(id, meta);
    }
    if (!meta) continue; // 活书 meta 读不到：宁漏勿错，留待下次扫描
    const have = new Set((meta.chapters || []).map((c) => c.key));
    const chKey = parts.slice(2).join('/').replace(/\.txt$/, '');
    if (!have.has(chKey)) toDelete.push(k); // 章表外正文（含已登记孤儿）→ 可删（当前章节正文则拒删）
  }
  let deleted = 0;
  for (const k of toDelete) {
    if (used >= DIAG_SUB_BUDGET) {
      deferred.push(k); // 总预算含删除本身，防超 50 子请求红线：未删的原样回传续调
      continue;
    }
    used++;
    await store.delete(k);
    deleted++;
  }
  // skipped 语义收窄为「确认不该删」（活书伴生对象 / 仍在章表内的正文）：预算裁剪的已挪进 deferred
  return json({ ok: true, deleted, skipped: ok.length - deleted - deferred.length, deferred });
}

/* ---------------- OPDS 目录 / 整本导出（第三方阅读器通道） ----------------
 * 场景：手机阅读器 App（ReadEra/Librera/静读天下等）订阅私人书库，整本下载 TXT 本地读。
 * 鉴权：浏览器会话 Cookie 或 HTTP Basic Auth（阅读器 App 只认 Basic）。
 *   - 口令即 ADMIN_PASSWORD（与登录同口令、同一把防爆破 IP 锁）；
 *   - 比较走 safeEqual 恒时；失败照常计数，锁定期内即使口令正确也 429。
 * 整本导出为流式拼章：逐章 R2 字节流惰性串接，不经 JS 解码/编码（不烧 CPU、不占内存），
 *   章节标题等少量文本单独编码插入。
 */

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { apiDiagOrphans, apiPurgeOrphans };
