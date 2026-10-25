/**
 * r2novel — 章节增删改查 / 上传 / 发布
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { MAX_CHAPTER_BYTES, BULK_CHAPTER_BATCH, MAX_UPLOAD_BYTES, CHAPTER_MAX, TAG_MAX } from '../../public/js/shared-const.js';
import { countWords as wordsOf, normTitle } from '../../public/js/shared-text.js';
import {
  dropBody,
  json,
  readBodyBytes,
  readBodyText,
  enc,
  readJsonBody,
  getWithEtag,
  tryParseJson,
  mutateMeta,
  metaFail,
  putIf,
} from '../core/base.js';
import { KEY, ORPHAN_BATCH, IDX_SAVE_TRIES } from '../core/const.js';
import { readBook, putStatus, readStatus } from '../store/book.js';
import { indexEntryFromMeta } from '../store/entry.js';
import { sweepOrphansBatch, sweepOrphans } from '../store/gc.js';
import { openIndex } from '../store/open.js';
import { inTrash, indexHas, safeStr, readTrash, readIndex, newId } from '../store/shard.js';

async function apiPutChapter(req, env, store, id, key) {
  const meta = await readBook(store, id);
  if (!meta) {
    await dropBody(req);
    return json({ error: '书不存在' }, 404);
  }
  if (meta.status === 'ready') {
    await dropBody(req);
    return json({ error: '书已发布，请改用章节编辑接口' }, 409);
  }
  // #145 P3-3：半成品书被软删后（条目在 trash 等 purge）续传的正文会被 purge 一并删掉 —— 白写
  if (await inTrash(store, id)) {
    await dropBody(req);
    return json({ error: '书已删除，无法续传正文' }, 409);
  }
  // 只放行章表内 key：建书/更新期往表外 key 塞正文会生成「publish 后无人认领」的孤儿对象
  if (!(Array.isArray(meta.chapters) ? meta.chapters : []).some((c) => c.key === key)) {
    await dropBody(req);
    return json({ error: '章节不在章表中' }, 404);
  }
  const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
  // 有界读取（含声明值快速拒绝）：旧实现先 req.arrayBuffer() 整体读入再判大小，超限时内存已吃满
  let buf;
  try {
    buf = await readBodyBytes(req, max);
  } catch (e) {
    if (e && (e.message === '请求体超过上限' || e.message === '解压后超过上限')) return json({ error: '章节超过上限' }, 413);
    return json({ error: '章节内容读取失败' }, 400);
  }
  const text = new TextDecoder().decode(buf);
  const words = wordsOf(text);
  await store.putText(KEY.text(id, key), text);
  return json({ ok: true, words });
}

/** 批量上传正文（连续上传优化）：一次读 meta + 批量写。
 * 请求数从「每章 1 个」降到「每 BULK_CHAPTER_BATCH 章 1 个」（Free 计划硬配额是请求数/天），
 * 单章 PUT 保留兼容。规则与单章一致：只放行 creating、只收章表内 key、每章 ≤ MAX_CHAPTER。
 * 全部校验通过后才落盘，避免超限造成半批次写。最坏子请求 = 2 读（meta + inTrash 的
 * trash，#145 P3-3 起多一次）+ BULK_CHAPTER_BATCH 并发写 = 42（≤50）。 */
async function apiPutChapters(req, env, store, id) {
  const T0 = Date.now();
  const maxTotal = 16 * 1024 * 1024; // 单批正文字节护栏（body/内存）
  // 解压护栏 36MB：正文 ≤16MB，但 JSON 转义在「纯 ASCII + 高频换行」正文上最坏逐字节翻倍
  //（\n → \\n，16MB → 32MB）+ 键名/结构开销 —— 旧值 24MB 会把这类**合法**批次误拒成 413
  //（2026-10-01 审计复算：16×2=32 > 24，原注释「最坏翻倍也已覆盖」与数学不符）。挡 gzip 炸弹不变。
  let body;
  try {
    body = JSON.parse(await readBodyText(req, 36 * 1024 * 1024));
  } catch (e) {
    if (e && (e.message === '解压后超过上限' || e.message === '请求体超过上限')) return json({ error: '请求体过大' }, 413);
    return json({ error: '无效的请求体' }, 400);
  }
  const list = Array.isArray(body.chapters) ? body.chapters : [];
  if (!list.length) return json({ error: '没有章节' }, 400);
  if (list.length > BULK_CHAPTER_BATCH) return json({ error: `单批最多 ${BULK_CHAPTER_BATCH} 章` }, 413);
  const meta = await readBook(store, id);
  const tMeta = Date.now() - T0;
  if (!meta) return json({ error: '书不存在' }, 404);
  if (meta.status === 'ready') return json({ error: '书已发布，请改用章节编辑接口' }, 409);
  // #145 P3-3：同 apiPutChapter —— 被软删等 purge 的半成品书，批量续传的正文同样是白写
  if (await inTrash(store, id)) return json({ error: '书已删除，无法续传正文' }, 409);
  const table = new Set((Array.isArray(meta.chapters) ? meta.chapters : []).map((c) => c.key));
  const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
  const items = [];
  let total = 0;
  for (const it of list) {
    const key = String((it && it.key) != null ? it.key : ''); // 防御 null 元素（旧版写法会在 it=null 时读 it.key 崩溃）
    if (!table.has(key)) return json({ error: `章节 ${key} 不在章表中` }, 404);
    const text = it && typeof it.text === 'string' ? it.text : '';
    const size = enc.encode(text).byteLength;
    total += size;
    if (size > max || total > maxTotal) return json({ error: '章节超过上限' }, 413);
    items.push({ key, text });
  }
  // 批内并发写：子请求数不变（仍 ≤BULK_CHAPTER_BATCH），耗时从串行 N×RTT 降为一次并发
  const T1 = Date.now();
  await Promise.all(items.map((it) => store.putText(KEY.text(id, it.key), it.text)));
  const tPut = Date.now() - T1;
  // 响应不带逐章 words：前端只用 count，而对 ≤12MB 批正文逐章跑正则统计是纯 CPU 浪费
  // （规模化后每本书几十批，累计可省数秒 CPU——Free 计划 10ms CPU/请求的贴边场景）。
  // 字数入库时信任客户端 cleaner 统计，与 publish 同一策略。
  // t 为服务端分阶段耗时（meta 读一段含 body 解压/解析；批内并发写正文），与 publish 的 t 字段同用途：慢链路诊断。
  // put 的耗时形态可区分「并发写被分波排队」（减批有救）vs「单次 R2 写本身慢」（减批反亏）。
  return json({ ok: true, count: items.length, t: { meta: tMeta, put: tPut, total: Date.now() - T0 } });
}

/** 上传原件（原始字节留档，重洗/恢复依据）。前端大文件 gzip 传输（x-content-gzip 标记）：
 * 解压护栏 = MAX_UPLOAD（解压产物超限即中断流，防 gzip 炸弹），解压后按明文落盘——
 * 存储格式不变（重洗读原件零改动，旧数据天然兼容）。 */
async function apiPutRaw(req, env, store, id) {
  // R150 P3-6：补齐另两个正文端点（apiPutChapter / apiUpdateChapters）都有的三道守卫。旧实现
  // 只校验 id 形状 —— 任意合法 id 都能写一份 ≤50MB 的原件：书不存在 → 白占空间，还会在
  // 「检查残留」里留下一份无法归属的 raw 对象；书在回收站 → purge 连 raw 一起删（白传）；
  // 书已发布 → 原件与章表从此不对版，「重新清洗」会用过期原件覆盖整本正文。
  // 上传时序保证不误伤：两条上传链路都是先 create / updateChapters（置 creating）再传原件。
  const meta = await readBook(store, id);
  if (!meta) {
    await dropBody(req);
    return json({ error: '书不存在' }, 404);
  }
  if (meta.status === 'ready') {
    await dropBody(req);
    return json({ error: '书已发布，请先用「更新已有书」上传' }, 409);
  }
  if (await inTrash(store, id)) {
    await dropBody(req);
    return json({ error: '书已删除，无法上传原件' }, 409);
  }
  const max = Number(env.MAX_UPLOAD) || MAX_UPLOAD_BYTES;
  // 声明值/流式超限都在 readBodyBytes 内处理（含 413 映射），此处不再自行 dropBody 排空——
  // 排空超大体等于把它读进内存，反而制造 OOM 面
  let buf;
  try {
    buf = await readBodyBytes(req, max);
  } catch (e) {
    if (e && (e.message === '解压后超过上限' || e.message === '请求体超过上限')) return json({ error: `原件超过上限 ${(max / 1048576) | 0}MB` }, 413);
    if (e && e.message === '请求体解压失败') return json({ error: '原件解压失败' }, 400);
    return json({ error: '原件读取失败' }, 400);
  }
  if (!buf.byteLength) return json({ error: '空文件' }, 400);
  await store.putBytes(KEY.raw(id), new Uint8Array(buf));
  return json({ ok: true, size: buf.byteLength });
}

/** 取原件（重洗用；前端用 cleaner 重新处理） */
async function apiRawGet(store, id) {
  const buf = await store.getBytes(KEY.raw(id));
  if (buf == null) return json({ error: '原件不存在' }, 404);
  return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
}

/** append 幂等令牌的**章节签名**（#145 复验 R1）：客户端令牌只由文件内容派生
 * （SHA-256 前 8 字节），覆盖不到「同一文件改分章再重试」——同令牌命中回放早退分支时，
 * 老 keys 回给新 chapters：客户端 startKeyIdx = 旧keys数 − 新章数 把新正文写到老章上
 * （老章被覆写），队尾新章拿不到 key（阅读 404）。签名随 meta.pending 登记，回放时比对；
 * 不一致 → 409 指路「整本替换」（replace 不依赖令牌，天然 covers 这种重试）。 */
const batchSig = (arr) => {
  let h = 5381; // djb2：非加密散列，防「无意撞车」不防恶意构造（令牌本身也只是稳定性用途）
  const list = Array.isArray(arr) ? arr : [];
  for (const t of list) {
    const str = String(t);
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    h = ((h * 33) ^ 10) >>> 0; // 章间分隔符：防 ['ab','c'] 与 ['a','bc'] 同哈希
  }
  return list.length + ':' + h.toString(16);
};

/** 进度迁移的统一写法（R150 P2-1）：读—判—**条件写**，冲突重读重判，updatedAt 每次现取。
 * 旧的三条路径（replace 迁移 / 插章 / 删章）各自 getText → putText **无条件覆盖**：读者正读到
 * 这一章（apiProgressPut 每次换章都写）时整份覆盖掉那次写入 —— 阅读位置莫名跳回/跳前进；
 * updatedAt 若取请求开始时刻还会比盘上值更旧，时间轴倒退让进度 OCC 的 baseAt 判据失效。
 * 重试用尽 → 放弃迁移（在线写优先于迁移）。map(p) 返回新进度，或 null（= 不需要改，别碰盘）。 */
async function migrateProgress(store, id, map) {
  for (let attempt = 0; ; attempt++) {
    let p = null;
    let etag;
    try {
      const got = await getWithEtag(store, KEY.progress(id));
      etag = got ? got.etag : null;
      if (got && got.text) p = JSON.parse(got.text);
    } catch {
      return; // 无进度 / 损坏 → 不迁移
    }
    if (!p || !Number.isFinite(p.ch)) return;
    const next = map(p);
    if (!next) return;
    const res = await putIf(store, KEY.progress(id), JSON.stringify(next), etag);
    if (res.ok) return;
    if (attempt + 1 >= IDX_SAVE_TRIES) return;
  }
}


/**
 * 更新已有书章节表（DR-06）。POST /api/books/:id/chapters
 * body { op:'replace'|'append', chapters:[title...], wordCount?, cleanVer?, title?, author?, tags? }
 * - replace：章节表整体重建 key=1..n（客户端随后重传全部正文覆盖）；进度按同名标题尽力保留
 * - append ：旧章保留，新章 key 从旧章数+1 续接（连载补新章）
 * 都会置 status='creating'（publish 前暂不可读），cleanVer+1 使缓存失效。
 */
async function apiUpdateChapters(req, env, store, id) {
  const bj = await readJsonBody(req, 2 * 1024 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  // R150 P3-1：op 缺字段时按 replace 兜底（老客户端兼容），但**显式给了值就必须合法**。
  // 旧实现把拼错的值（'apend'）也当 replace = 整表重建 + 进度迁移，与 /api/books/batch 对
  // action 的严格白名单不一致，而这里的后果更重：用户本想「追加」却把全书章表重建了。
  if (body.op !== undefined && body.op !== 'append' && body.op !== 'replace') {
    return json({ error: 'op 只能是 append 或 replace' }, 400);
  }
  const op = body.op === 'append' ? 'append' : 'replace';
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, CHAPTER_MAX) : [];
  if (!chapters.length) return json({ error: '没有章节' }, 400);
  // #145 P2-9：append 幂等令牌（客户端按文件内容哈希派生的稳定值）。「章表已追加、正文 bulk
  // 上传失败」之后用户重试会再选「追加」→ 服务端不幂等 → 章表尾部又追加同一批 → 书架两套
  // 相同章节、第一套全是空壳（阅读 404），且 creating 态的书进不了编辑器，只能整本 replace
  // 重传自救。令牌随 CAS 落到 meta.pending，同令牌再来直接回放已登记的 keys。
  // ⚠️ 令牌只覆盖文件字节、不覆盖章节划分（R1）：回放要核对 batchSig，同一文件改过拆分
  // 再重试必须拒绝回放（指路 replace），否则新正文覆写老章、队尾新章阅读 404。
  const batch = typeof body.batch === 'string' && /^[0-9a-f]{16}$/.test(body.batch) ? body.batch : '';

  if (!(await indexHas(store, id))) return json({ error: '书不在书架（可能已删除或未发布）' }, 404);

  const gotCh = await getWithEtag(store, KEY.book(id));
  const meta = gotCh ? tryParseJson(gotCh.text) : null;
  if (!meta) return json({ error: '书不存在' }, 404);
  const oldCh = Array.isArray(meta.chapters) ? meta.chapters : [];
  const oldTitles = oldCh.map((c) => c.title);
  const now = Date.now();

  // 阶段 A（副作用，只做一次）：先清一批孤儿正文释放 key 空间。删除幂等；清不掉的会留在
  // sweptA.left 里，由下面的变换**避让它们的 key**——否则新章正文会被后续 sweep 当成孤儿删掉，
  // 而章表仍引用它们 → 阅读 404（#139 实测：60 章 replace 成 10 章后直接 append 50 章，丢 24 章）。
  // replace 的候选 = **仅**已登记的孤儿（被新表挤掉的旧章不在此清理，见下方 ⚠️）。
  const newKeySet = op === 'append' ? null : new Set(chapters.map((_, i) => String(i + 1)));
  // ⚠️ 第四轮审计 P1：这里**绝不能**把「被新表挤掉的旧章」放进待删集合。删除是副作用，
  // 而 CAS（mutateMeta，下方阶段 C）随时可能因并发冲突返回 409 —— 那时章表一个字都没改、
  // 仍引用着这些 key，正文却已被物理删掉（R2 删除不可逆）→ 书显示 N 章、点开 404，
  // 而用户只看到一句「并发冲突，请重试」。
  // 正确做法：只清**已登记**的孤儿；被新表挤掉的旧章由阶段 C 的 cand 登记进 mm.orphans
  // （CAS 成功后才落盘），再由 publish / apiBookMeta 的惰性清扫删除。与 #144 P3 在
  // apiDeleteChapter 里「删正文挪到 CAS 之后」是同一条纪律。
  const preKeys = new Set(Array.isArray(meta.orphans) ? meta.orphans : []);
  // 活键 = 清完后**仍会被章表引用**的 key：append=现有章（一本都不删）；replace=新表 key。
  // 传给 sweepOrphansBatch 让「活键防御」在这条路径也生效（F2，见该函数注释）。
  // R150 P3-3：replace 的活键必须取**新旧并集**。CAS 成功前盘上仍是旧章表；若历史脏数据存在
  // orphans ∩ chapters 重叠，只按新表算活键会把旧表仍在引用的正文在 CAS **之前**物理删掉，
  // 随后 409（并发冲突）也回滚不了正文 —— 书显示旧章数、点开 404。并集只让本轮少删几个
  //（多留的对象由后续 sweep 收口），方向保守。
  const sweepLive = newKeySet ? Array.from(newKeySet).concat(oldCh.map((c) => c.key)) : oldCh.map((c) => c.key);
  // ⚠️ 上限一律 ORPHAN_BATCH，append 也不例外（2026-10-06 审计 P1-4）。曾对 append 传
  // Infinity「一次清完」，但每章一次 store.delete 就是一个**子请求**：300 章书 replace 成
  // 3 章（orphans≈273）后点「追加章节」→ 单请求发 276 个 delete → 撞穿 50 硬顶 → 500，
  // 且 mutateMeta 从未执行、章表不变（用户只看到「追加失败」）。
  // 正确性不依赖「一批删完」：下面的 append key 起点已把 sweptA.left 纳入 maxNum 避让，
  // 清不完的 key 会被避让并留在 mm.orphans 里续清。
  const sweptA = await sweepOrphansBatch(store, id, Array.from(preKeys), ORPHAN_BATCH, sweepLive);

  // 阶段 B 已挪到 CAS 成功之后（#144 P3）：replace 的进度迁移原先放在 CAS **之前**，
  // mutateMeta 因冲突 409/重试耗尽未生效时进度却已被改写（同名迁移失败还压回第 1 章）
  // —— 章表没变、阅读进度先丢了。CAS 成功后才迁移，失败路径零副作用。

  // 阶段 C：CAS 变换（纯内存；冲突时会被**重放** —— 所有结果都从 meta 现推，绝不增量叠加）
  // R1：章节签名与令牌一起登记/回放比对（见 batchSig）——只哈希文件字节的令牌拦不住
  // 「同一文件改分章再重试」，那种重试回放老 keys 会把新正文写进老章、队尾新章 404。
  const sig = batchSig(chapters);
  const m = await mutateMeta(
    store,
    id,
    (mm) => {
      const cur = Array.isArray(mm.chapters) ? mm.chapters : [];
      if (op === 'append') {
        // 同令牌重放（#145 P2-9）：上一次尝试已把这批章追加进章表（pending 登记了当时的全量
        // keys），只是正文没传完 → 这次不再追加、不重复计字数，直接把当时那批 keys 回给客户端
        // 续传正文。判据落在盘面（mm.pending）上，天然抗重放与并发。
        if (batch && mm.pending && mm.pending.batch === batch && Array.isArray(mm.pending.keys)) {
          // R1：回放前核对章节签名。不一致说明客户端换过拆分（或换了文件撞了哈希）——
          // 回放老 keys 会让新正文覆写老章、队尾新章拿不到 key（阅读 404）→ 拒绝并指路
          // 整本替换（replace 全量重写章表，不依赖令牌，覆盖这种重试）。
          if (mm.pending.sig !== sig) {
            return { abort: json({ error: '章节划分与上次上传不一致，请改用「整本替换」重试' }, 409) };
          }
          return { out: mm.pending.keys.slice() };
        }
        // key 起点在**当前盘面**上重算：并发 append 过的话，沿用旧起点会撞 key（新正文覆盖旧章）。
        // 起点取「现有数字 key 最大值 +1」与「章数+1」的较大者：就地删除会让数字 key 变稀疏
        // （如 [1,3]），只按章数推算会撞上已存在的 key。孤儿 key 一并避让（见阶段 A）。
        let maxNum = 0;
        for (const c of cur) {
          const n = Number(c.key);
          if (Number.isInteger(n) && n > maxNum) maxNum = n;
        }
        for (const k of [...(Array.isArray(mm.orphans) ? mm.orphans : []), ...sweptA.left]) {
          const n = Number(k);
          if (Number.isInteger(n) && n > maxNum) maxNum = n;
        }
        // R150 P3-5：append 也要复核单本上限。chapters 已按 CHAPTER_MAX 截断，但**累加后**的
        // 总章数从来没人查 —— create / replace 都截断，只有 append 能让章表无限增长。
        // ⚠️ 判据必须在上面令牌回放分支**之后**：回放时 cur 已含上次追加的那批，会误判超限。
        if (cur.length + chapters.length > CHAPTER_MAX) {
          return { abort: json({ error: '章节数超过上限（' + CHAPTER_MAX + ' 章）', count: cur.length }, 409) };
        }
        const startKey = Math.max(cur.length + 1, maxNum + 1);
        const add = chapters.map((t, i) => ({ key: String(startKey + i), title: safeStr(t, 120) || '第' + (startKey + i) + '章' }));
        mm.chapters = cur.concat(add);
        // 登记本批次（#145 P2-9）：publish 成功时清除；期间同令牌重放走上面的早退分支。
        if (batch) mm.pending = { batch, keys: mm.chapters.map((c) => c.key), sig };
      } else {
        delete mm.pending; // replace 全量重写章表：旧批次的半成品登记一并作废
        const newCh = chapters.map((t, i) => ({ key: String(i + 1), title: safeStr(t, 120) || '第' + (i + 1) + '章' }));
        mm.chapters = newCh;
        // 孤儿登记：并上「并发 writer 已登记的」+「本次没清掉的」+「被新表挤掉的旧章」，
        // 再剔除**章表仍引用**的 key（历史脏数据可能让孤儿表与章表重叠 → sweep 会删掉在用的正文）
        // 以及本次已确实删掉的 key（免得反复发无效删除）。
        const live = new Set(newCh.map((c) => c.key));
        const cand = new Set([...(Array.isArray(mm.orphans) ? mm.orphans : []), ...sweptA.left, ...cur.map((c) => c.key)]);
        for (const k of live) cand.delete(k);
        for (const k of sweptA.swept) cand.delete(k);
        if (cand.size) mm.orphans = Array.from(cand);
        else delete mm.orphans;
      }
      if (body.title !== undefined) mm.title = safeStr(body.title, 120) || mm.title;
      if (body.author !== undefined) mm.author = safeStr(body.author, 60);
      if (body.note !== undefined && body.note !== null) mm.note = safeStr(body.note, 500);
      if (body.tags !== undefined) {
        mm.tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [];
      }
      if (body.wordCount !== undefined) {
        // append 只传新增部分的字数 → 在旧字数上累加；replace 传的是整本字数 → 直接采用
        // 两条分支都要夹到 ≥0：异常/恶意客户端传负数会把总字数写成负值（replace 原本就夹了，append 漏了）
        mm.wordCount = Math.max(
          0,
          op === 'append' ? (Number(mm.wordCount) || 0) + (Number(body.wordCount) || 0) : Number(body.wordCount) || 0
        );
      }
      mm.cleanVer = (Number(mm.cleanVer) || 0) + 1;
      mm.updatedAt = now;
      mm.status = 'creating'; // publish 前不可读
      return { out: mm.chapters.map((c) => c.key) };
    },
    gotCh
  );
  if (!m.ok) return metaFail(m);
  // 状态副档单独写：它只是「可读性」的廉价判定，与 meta 短暂不一致的后果与原先同类。
  // 进度迁移（replace 专用）与它并行：CAS 已成功，章表必然变 → 迁移不会白做。
  const progP =
    op !== 'append'
      ? migrateProgress(store, id, (p) => {
          // 进度尽力保留（ch 为 1-based 章节号）：旧进度所在章的标题在新表里若同名则迁移，
          // 找不到同名章 → 回到第 1 章；旧进度越界（脏数据）则原样保留不动。
          if (!(p.ch >= 1) || p.ch > oldCh.length) return null;
          const newTitles = chapters.map((t, i) => safeStr(t, 120) || '第' + (i + 1) + '章');
          const ni = newTitles.findIndex((t) => t === oldTitles[Math.floor(p.ch) - 1]);
          return ni >= 0
            ? { ch: ni + 1, ratio: Math.min(1, Math.max(0, Number(p.ratio) || 0)), updatedAt: Date.now() }
            : { ch: 1, ratio: 0, updatedAt: Date.now() };
        })
      : Promise.resolve();
  await Promise.all([progP, putStatus(store, id, 'creating')]);
  return json({ ok: true, op, cleanVer: m.meta.cleanVer, chapterKeys: m.out });
}

/**
 * 发布：抽样校验首/中/尾章存在 → 写 index（先 .bak）。
 * 字数信任客户端 cleaner 统计（meta.wordCount）——绝不逐章回读（R2 子请求上限）。
 */
async function apiPublish(req, env, store, id) {
  const T0 = Date.now();
  const meta0 = await readBook(store, id);
  if (!meta0) return json({ error: '书不存在' }, 404);
  if (!meta0.chapters || !meta0.chapters.length) return json({ error: '书还没有章节' }, 400);
  const tMeta = Date.now() - T0;
  const keys = meta0.chapters.map((c) => c.key);
  const samples = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]].filter((k, i, arr) => arr.indexOf(k) === i);
  // 三个互不依赖的读并行（原实现串行 3 程）：抽样正文 + 索引（single+append：root + 1 片）+ 回收站
  // （2026-10-01 审计 P3：软删书可被 API 层 publish「复活」成在架+在回收站双态，
  // 随后 purgeOnce 会删掉一本在架书 —— 前端流程到不了这里（编辑入口有 indexHas 守卫），API 层必须自守）。
  // ⚠️ 这只是**快照**检查（#145 P1-2 实锤）：检查之后到 CAS 完成还有整整一段 sweepOrphans +
  // mutateMeta 的 RTT 窗口，书可能在期间被并发软删 → 下面的 upsert 前还会复检一次（见后）。
  // progress 镜像源不在并行读里取（#145 P3-4）：那份快照早于 CAS，期间用户可能已在别的设备
  // 换了章（旧快照会把书架角标写回退）→ CAS 成功后单独重读。
  const T1 = Date.now();
  const [sampled, idx, trash] = await Promise.all([
    Promise.all(samples.map((k) => store.getText(KEY.text(id, k)))),
    openIndex(store, { single: id, append: true }),
    readTrash(store).catch(() => ({ books: [] })),
  ]);
  if (trash.books.some((b) => b.id === id)) return json({ error: '该书在回收站中，请先恢复再发布' }, 409);
  const tVerify = Date.now() - T1;
  for (let i = 0; i < samples.length; i++) {
    if (sampled[i] == null) return json({ error: `章节 ${samples[i]} 未上传，发布中止` }, 409);
  }
  // 阶段 A（副作用）：清一批孤儿正文 + 记下「已清掉 / 没清掉」两类 key（见 sweepOrphansBatch）
  // 活键 = 现有章表 key（publish 不动章表，凡被章表引用的正文一律不删，F2）
  const sweptA = await sweepOrphansBatch(
    store,
    id,
    meta0.orphans,
    ORPHAN_BATCH,
    (meta0.chapters || []).map((c) => c.key)
  );
  const T2 = Date.now();
  // 阶段 B：CAS 写 meta。原来这条写是无条件整份覆盖 —— 与并发的就地编辑/批量标签撞上时，后写者会
  // 连**章表**一起写回旧版（并发删掉的章被复活）。改成 CAS 后冲突即重读重放，盘面收敛到最新。
  const m = await mutateMeta(
    store,
    id,
    (meta) => {
      if (!meta.chapters || !meta.chapters.length) return { abort: json({ error: '书还没有章节' }, 400) };
      meta.chapterCount = meta.chapters.length;
      meta.wordCount = Math.max(Number(meta.wordCount) || 0, 0);
      meta.status = 'ready';
      delete meta.pending; // #145 P2-9：publish 是一次完整入库的终点，清掉 append 批次登记
      meta.updatedAt = Date.now();
      // 清不掉的 + 并发 writer 新登记的 → 继续登记（下次惰性清）；章表仍引用的、本次已删的一律剔除
      const live = new Set(meta.chapters.map((c) => c.key));
      const cand = new Set([...(Array.isArray(meta.orphans) ? meta.orphans : []), ...sweptA.left]);
      for (const k of live) cand.delete(k);
      for (const k of sweptA.swept) cand.delete(k);
      if (cand.size) meta.orphans = Array.from(cand);
      else delete meta.orphans;
    },
    null
  );
  if (!m.ok) return metaFail(m);
  const meta = m.meta;
  // 索引条目以「刚 CAS 成功的这份 meta」为准（它才是权威盘面）
  const old = idx.get(id);
  let prog = old && old.prog;
  // #145 P3-4：进度镜像在 **CAS 之后**重读。入口并行那份快照早于本次 CAS 发生，期间用户可能
  // 已在另一台设备换了章 —— 用旧快照会把书架角标写回退（阅读位置与书架显示短暂矛盾）。
  try {
    const pt = await store.getText(KEY.progress(id)).catch(() => null);
    if (pt) {
      const p = JSON.parse(pt);
      if (p && Number.isFinite(p.ch)) prog = { ch: p.ch, ratio: p.ratio || 0, updatedAt: p.updatedAt || 0 };
    }
  } catch {
    /* 读取失败沿用旧镜像 */
  }
  // #145 P1-2：TOCTOU 收尾复检。入口的 trash 快照检查之后，sweepOrphans + mutateMeta 的多次
  // RTT 窗口里该书可能被并发软删（软删只写 trash、不碰 meta，这边的 CAS 照常成功）→ 此时若
  // 直接 upsert，书被「复活」成在架+回收站双态，随后回收站过期清理会删掉一本**在架**书的
  // 正文与 meta（书架留幽灵）。复检放在 upsert 前最后一步，判据与入口一致、成本 1 次读。
  // 失败落点：CAS 已成功（meta 已 ready），书留在回收站里可恢复可重试 —— 安全侧。
  const trash2 = await readTrash(store).catch(() => ({ books: [] }));
  if (trash2.books.some((b) => b.id === id)) {
    // R4：meta.status 已在 CAS 里写成 ready，副档（st/<id>）滞后会让「目录能开、每章
    // 409」——apiBookMeta 判 meta、apiChapter 判副档。拒绝前尽力同步副档；书留回收站
    // 可恢复、可重发发布，失败落在安全侧。
    await putStatus(store, id, 'ready').catch(() => {});
    return json({ error: '该书在回收站中，请先恢复再发布' }, 409);
  }
  // #145 P3-6：同名在架终判。createBook 的判重只读索引快照，两个标签页同书名并发新建时两份
  // creating 书互相不可见、都会通过判重；各自发布时这里才是第一处「两份都已在架可见」的
  // 判定点。命中 → 拒绝上架并指路（客户端失败分支会把半成品移入回收站，用户改名或删一本后
  // 重传即可），不再静默产出两张同名卡。
  // 判据要全量索引（1+K 读）→ 两重门控：① 只查**首次发布**（old 空）——重复发布时书早就在
  //   架，后来者想同名上架过不了它自己那次首刊，本处再查纯属重复劳动（restore 直通索引是
  //   唯一绕路，而恢复是用户显式动作、撞名由 create 期判重兜）；
  //   ② K≤4（≈2000 本）才做。账面最坏（不含全量读）44：入口 readBook 1 + 抽样 3 +
  //      单书索引 2 + trash 1 + 孤儿删 ≤24 + mutateMeta 3 试 6 + 进度重读 1 + trash2 1 +
  //      putStatus 1 + idx.save 4；再加全量读 1+K → K≤4 时 49，贴 50 硬顶。
  //      （#145 复验 R5：原注释「~35 + ≤9」漏计孤儿批与 CAS 重试，实算 K≤8 时 52~53 > 50，
  //      按错误算术放行；3500+ 本 + 24 孤儿 + 3 次 CAS 冲突的复合最坏会撞平台硬失败。）
  //   更大库跳过（create 期判重 + 客户端 askDup 已覆盖绝大部分，且万本级库上「读全量索引换
  //   重复卡检查」的代价高于收益 —— 与 opds 的熔断同一判据）。
  //   ⚠️ idx.save 撞索引 CAS 冲突会自重放（openIndex 2 读 + 4 写/次，默认最多 2 次）——
  //   那是并发彩票开销、不随 K 增长，此处不计；两个标签页同时发布时后发者可能撞 50 硬顶
  //   回 500，重发即愈合（P2-6 的选择：宁可重放也不整片覆盖）。
  //   single 模式句柄没有全量 books（访问即抛），必须另开全量读。
  if (!old && Number(idx.shardCount) <= 4) {
    // R4：全量读瞬时故障 → fail-open。同名终判是 create 期判重 + 客户端 askDup 之外的
    // 纵深一环，丢一次检查好过在 meta 已 ready 之后冒 500（下一轮发布会再判）。
    let full = null;
    try {
      full = await readIndex(store);
    } catch {
      /* 瞬时抖动：跳过终判，不阻断发布 */
    }
    if (full) {
      const clash = (full.books || []).find((b) => b.id !== id && normTitle(b.title) === normTitle(meta.title));
      if (clash) {
        await putStatus(store, id, 'ready').catch(() => {}); // 同 trash2 分支：副档对齐 meta
        return json({ error: '书架已有同名的《' + clash.title + '》，请改名或删除其中一本后再发布' }, 409);
      }
    }
  }
  idx.upsert(id, indexEntryFromMeta(meta, { pinned: !!(old && old.pinned) || !!meta.pinned, prog }));
  // 两个互不依赖的写并行：状态副档 ∥ 索引（脏分片 + bak + root 如有成员变化）。
  // 任一写失败的后果与原「副档先行」分析同类：可读/409 短暂不一致，重试发布即愈合
  // #145 R9：save 撞 CAS 冲突会自己重放（默认最多 2 次），而重放的 upsert 是无条件上架 ——
  // 上面两处 trash 复检**都在这段窗口之前**。allowUpsert 让重放前再复检一次回收站：命中就不写盘，
  // 书留在回收站（不会双态）。成本只在「撞冲突」这条并发彩票路径上多 1 读 + 1 读 trash，
  // 下面 49 的账面（不含重放开销，见上）不受影响。
  const [, saved] = await Promise.all([
    putStatus(store, id, 'ready'),
    idx.save({
      bak: true,
      allowUpsert: async () => !(await readTrash(store).catch(() => ({ books: [] }))).books.some((b) => b.id === id),
    }),
  ]);
  if (saved && Array.isArray(saved.skipped) && saved.skipped.includes(id)) {
    // 重放期间书进了回收站：索引里没有它（无副本可对齐），meta.status 却已在 CAS 里写成 ready。
    // 与上面两处 409 同一处理：先把副档对齐 meta（否则「目录能开、每章 409」），再按在回收站拒绝。
    await putStatus(store, id, 'ready').catch(() => {});
    return json({ error: '该书在回收站中，请先恢复再发布' }, 409);
  }
  const tWrite = Date.now() - T2;
  // 不再回传 books 快照（见上：为它做全量读会在 2 万本量级撞 50 子请求硬顶）。前端 upload.js /
  // upload/files.js 两处都有 `if (pub.books) … else loadShelf()` 兜底，新旧前后端任意组合都安全。
  // t 为服务端分阶段耗时（meta 读 / 校验+读 / 写含 meta CAS），供慢链路诊断
  return json({
    ok: true,
    id,
    wordCount: meta.wordCount,
    chapterCount: meta.chapterCount,
    cleanVer: meta.cleanVer,
    t: { meta: tMeta, verify: tVerify, write: tWrite, total: Date.now() - T0 },
  });
}

/** 上传中断后「恢复到可读态」（R150 P1-3）。
 *
 * 背景：apiUpdateChapters 先把 meta.status 与状态副档**一起**写成 creating（publish 前不可读），
 * 之后客户端才 bulk 传正文、最后 publish。弱网在 bulk 阶段中断（移动网络最常见的失败点）时，
 * 书就永久停在 creating：读章 409「书正在更新中」、章节编辑器 409、回收站恢复 409 ——
 * 用户看到的是「书还在、点开提示更新中」，除了整本重传没有任何自救路径。
 *
 * 这里只恢复**可读性**，不假装回滚了正文：replace 阶段同名 key 的正文可能已被新内容覆盖，
 * 那部分不可逆（客户端会提示「缺失的章节请重新上传或重新清洗」）。append 是真正可回的：
 * 追加的章是队尾新增 key、旧章一字未动 → 按客户端给的本批次章数截断回去。
 *
 * 幂等：不是 creating 一律 noop（发布已成功 / 已被上一次回滚修好 / 并发回滚）。
 * 不乱改章表：只有 append + 令牌对得上 + 章数在范围内时才截断。 */
async function apiRollback(req, env, store, id) {
  const bj = await readJsonBody(req, 64 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body || {};
  const meta0 = await readBook(store, id);
  if (!meta0) return json({ error: '书不存在' }, 404);
  if (meta0.status !== 'creating') return json({ ok: true, noop: true, status: meta0.status });
  const idx = await openIndex(store, { single: id });
  const op = body.op === 'append' ? 'append' : 'replace';
  const count = Math.floor(Number(body.count) || 0);
  const words = Math.max(0, Math.floor(Number(body.wordCount) || 0));
  const batch = typeof body.batch === 'string' ? body.batch : '';
  const m = await mutateMeta(
    store,
    id,
    (meta) => {
      if (meta.status !== 'creating') return { abort: json({ ok: true, noop: true, status: meta.status }) };
      const cur = Array.isArray(meta.chapters) ? meta.chapters : [];
      // 令牌对得上才敢截断：pending 是**本批次**登记（同令牌重试会回放同一批 keys），
      // 跨批次误删会把别人刚追加的章删掉。
      if (op === 'append' && count > 0 && count <= cur.length && meta.pending && (!batch || meta.pending.batch === batch)) {
        meta.chapters = cur.slice(0, cur.length - count);
        meta.wordCount = Math.max(0, (Number(meta.wordCount) || 0) - words);
      }
      meta.chapterCount = (Array.isArray(meta.chapters) ? meta.chapters : []).length;
      meta.wordCount = Math.max(0, Number(meta.wordCount) || 0);
      meta.status = 'ready';
      delete meta.pending;
      meta.updatedAt = Date.now();
    },
    null
  );
  if (!m.ok) return metaFail(m);
  const meta = m.meta;
  const old = idx.get(id);
  idx.upsert(id, indexEntryFromMeta(meta, { pinned: !!(old && old.pinned) || !!meta.pinned, prog: old && old.prog }));
  // 副档与索引同一步对齐：只写 meta 不写副档会留下「目录能开、每章 409」的错位。
  await Promise.all([putStatus(store, id, 'ready'), idx.save({ bak: true })]);
  return json({ ok: true, rolledBack: true, chapterCount: meta.chapterCount, wordCount: meta.wordCount });
}

/** 单书目录（章节表）——只读已发布书；顺带惰性清理 replace 遗留的孤儿章节 */
async function apiBookMeta(store, id, req) {
  const got = await getWithEtag(store, KEY.book(id));
  let meta = got ? tryParseJson(got.text) : null;
  if (!meta) return json({ error: '书不存在' }, 404);
  if (meta.status !== 'ready') return json({ error: '书正在更新中，请稍后重试' }, 409);
  // #145 P3-11：同 apiTrashList —— 目录 GET 顺带的孤儿清扫同样只在同源请求里做。
  // 语义与 apiTrashList 逐字一致：**要求 positive 同源证据**（老客户端无该头 → 保守跳过）。
  const maySweep = req && req.headers.get('sec-fetch-site') === 'same-origin';
  if (maySweep && Array.isArray(meta.orphans) && meta.orphans.length) {
    // 写回走 CAS：这次写回与并发的 PATCH（星标/置顶/readDone/备注）都是「读—改—写 meta」，
    // 无条件整份覆盖时后写者会吃掉前者的字段（用户看到「刚改的星标没了」）。
    // 冲突 → 重读新盘面、再扫一次（删孤儿幂等，重放不会放大）→ 用新版本号写。
    // ⚠️ 本处**刻意不用** mutateMeta：sweepOrphans 是删除副作用，且它的结果决定写回内容，
    // 必须在**每次重试里重跑** → 违反「纯内存可重放」不变式（见 mutateMeta 的注释）。 */
    // 语义与 mutateMeta 一致：冲突重读重放、用尽即止。
    let etag = got.etag;
    // ⚠️ 每轮 sweepOrphans 最多 24 个 delete，且删除**不会**让重读的 orphans 变短（key 仍在表里
    // 直到 CAS 成功写回）→ 3 轮冲突 ≈ 3×(24+1) + 2 次重读 ≈ 77 子请求 → 目录 GET 直接 500
    //（2026-10-06 审计 P2-2）。子请求预算必须在**多轮之间分配**（#144 P2-4）：旧公式
    // 「46-(attempt+1)*2」三轮都 ≥40 > ORPHAN_BATCH，Math.min 恒取 24、收窄分支永远不可达。
    // 现按总预算扣减：入口读 meta 已花 1；每轮 batch(≤24) + putIf(1)，冲突再扣重读(1)。
    // 46 = 1 入口读 + 24删 + 1写 + 1重读 + 18删 + 1写 = 46，第三轮预算见底即停
    //（与「重试用尽时残留 orphans 不影响读取」的既有语义一致，下次 GET/PATCH 再扫）。
    let budget = 46 - 1;
    for (let attempt = 0; ; attempt++) {
      const batch = Math.min(ORPHAN_BATCH, budget - 1); // 留 1 给本轮 putIf
      if (batch < 1) break; // 预算不足：不再删（残留 orphans 不影响读取）
      await sweepOrphans(store, meta, batch);
      budget -= batch + 1;
      const res = await putIf(store, KEY.book(id), JSON.stringify(meta), etag);
      if (res.ok) break;
      // 重试用尽：孤儿正文已删，meta 里残留的 orphans 字段不影响读取（下次 GET/PATCH 会再扫）
      if (attempt + 1 >= IDX_SAVE_TRIES) break;
      if (budget < 2) break; // 凑不出「重读 1 + 下轮最少删 1 写 1」
      const again = await getWithEtag(store, KEY.book(id));
      budget -= 1;
      const fresh = again ? tryParseJson(again.text) : null;
      if (!fresh) break; // 期间书被删了 → 不再写回
      // 并发 replace/publish 把 status 改回了 creating：既不能用这份半成品盘面写回，更不能把它
      // 当 ready 返回（客户端会拿着半成品章表去读，读到的章 404）。判据与函数开头保持一致 → 409。
      if (fresh.status !== 'ready') return json({ error: '书正在更新中，请稍后重试' }, 409);
      meta = fresh;
      etag = again.etag;
      if (!Array.isArray(meta.orphans) || !meta.orphans.length) break; // 新盘面已无孤儿
    }
  }
  const { orphans, ...view } = meta;
  return json(view);
}

/** 改元信息（书名/作者/标签/置顶/备注/阅读状态）——PATCH，同步 index（单书模式：只碰该书所在分片） */
async function apiPatchBook(req, store, id) {
  const bj = await readJsonBody(req, 256 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const idx = await openIndex(store, { single: id });
  if (!idx.get(id)) return json({ error: '书不在书架（可能已删除或未发布）' }, 404);
  // 读—改—写走 CAS（见 mutateMeta）：并发的 GET 目录可能正在写回孤儿清理，两边都无条件整份覆盖
  // 时后写者会吃掉前者的字段（表现为「刚改的星标没了」）。PATCH 是**字段级合并**、重放幂等，
  // 所以冲突时重读新盘面重放即可，任何一方都不丢。
  const m = await mutateMeta(store, id, (meta) => {
    const patch = {};
    if (body.title !== undefined) {
      const t = safeStr(body.title, 120);
      if (t) {
        meta.title = t;
        patch.title = t;
      }
    }
    if (body.author !== undefined) {
      meta.author = safeStr(body.author, 60);
      patch.author = meta.author;
    }
    if (body.note !== undefined) {
      meta.note = safeStr(body.note, 500);
      patch.note = meta.note;
    }
    if (body.tags !== undefined) {
      meta.tags = Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [];
      patch.tags = meta.tags;
    }
    if (body.pinned !== undefined) {
      meta.pinned = !!body.pinned;
      patch.pinned = meta.pinned;
    }
    if (body.finished !== undefined) {
      meta.finished = !!body.finished;
      patch.finished = meta.finished;
    }
    // 「已读完」＝我的阅读状态，与 finished（这本书本身写完了）是两回事，故单独一个字段。
    // 三态：true 强制已读完 / false 强制未读完（用来摘掉自动判定出来的标记）/ 缺省走自动判定。
    // null ＝ **清除**该字段，回到自动判定——第三个出口必须存在，否则手动标错一次就永久锁死。
    // 为什么用 null 而不是省略字段：JSON.stringify 会把 undefined 的键整个丢掉，服务端看到的
    // 就成了「没这个字段」= 什么都不做，客户端根本无法表达「删除」；而 false 的语义是
    // 「强制未读完」，与「没标过」不是一回事（前端 readState 按三态分别处理）。
    // 老书没有该字段 → undefined → 自动回落判定，天然兼容，无需迁移。
    if (body.readDone !== undefined) {
      if (body.readDone === null) {
        delete meta.readDone;
        patch.readDone = null; // null 作「删除」哨兵传给下面的 index patch
      } else {
        meta.readDone = !!body.readDone;
        patch.readDone = !!body.readDone;
      }
    }
    if (body.star !== undefined) {
      meta.star = !!body.star;
      patch.star = !!meta.star;
    }
    meta.updatedAt = Date.now();
    patch.updatedAt = meta.updatedAt;
    return { out: patch };
  });
  if (!m.ok) return metaFail(m);
  const patch = m.out;

  idx.patch(id, (b) => ({
    ...b,
    title: patch.title !== undefined ? patch.title : b.title,
    author: patch.author !== undefined ? patch.author : b.author,
    tags: patch.tags !== undefined ? patch.tags : b.tags,
    pinned: patch.pinned !== undefined ? patch.pinned : !!b.pinned,
    finished: patch.finished !== undefined ? patch.finished : !!b.finished,
    // null ＝ 清除：置成 undefined，JSON 序列化时该键直接消失，前端据此回落自动判定
    readDone: patch.readDone === null ? undefined : patch.readDone !== undefined ? patch.readDone : b.readDone,
    star: patch.star !== undefined ? patch.star : !!b.star,
    updatedAt: patch.updatedAt,
  }));
  await idx.save({ bak: true });
  return json({ ok: true });
}

/** 读一章正文。?v=cleanVer 做缓存击穿，rewash 后立即生效
 * 只放行已发布书：replace/append 期间书处于 creating，旧正文不应被读到（与 bookMeta/export 一致）；
 * 也避免「replace 后旧 key 正文残留、发布抽样未命中」时旧正文顶着新章表长期被读。 */
async function apiChapter(store, id, key) {
  // 只读状态副档（~20B）判定可读性：千本规模下每章 GET 省一次全量 meta JSON.parse
  // （2000 章书 meta≈1MB，在 Free 10ms CPU 上是主要开销）。副档缺失时回落 meta 并补档。
  const st = await readStatus(store, id);
  if (st == null) return json({ error: '章节不存在' }, 404);
  if (st !== 'ready') return json({ error: '书正在更新中，请稍后重试' }, 409);
  const t = await store.getText(KEY.text(id, key));
  if (t == null) return json({ error: '章节不存在' }, 404);
  // 章节正文可长缓存：URL 已带 ?v=cleanVer 作为失效键（任何编辑/重洗都会 cleanVer+1），
  // 回翻章节/重开书籍零网络请求；cleanVer 变化 → URL 变化 → 缓存天然失效
  return new Response(t, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' },
  });
}

/* ---------------- v1.1：已发布书的章节就地编辑（改标题/改正文/插入/删除） ----------------
 * 就地编辑 ≠ replace 整表重建：新章用 newId 生成独立 key，既有章节 key 永不重排，
 * 只写 meta 章表数组 + 受影响的正文对象 → 单次操作子请求 ≤10，远在 50 预算内。
 * 仅放行 status==='ready' 的已发布书（书全程保持可读）；半成品走 /chapters 整表通道。
 * 一致性规则：
 *   - 标题传空 → 自动兜底「第 N 章」（N=当前位置 1-based）
 *   - 改正文/删章按旧正文实际字数修正 meta.wordCount（读一次旧章，预算内）
 *   - cleanVer+1：失效阅读缓存与 PWA 离线整本（前端提示重新下载）
 *   - 插入/删除改变后续章号 → 云端进度按规则迁移（index 进度镜像一并更新）
 */
function chIndex(meta, key) {
  const arr = Array.isArray(meta.chapters) ? meta.chapters : [];
  return arr.findIndex((c) => c.key === key);
}

/** 就地编辑前提：书在架 + 存在 + 已发布；返回 { meta, cur } 或 { resp }（直接作为响应）。
 *  一并把原始 { text, etag } 交给调用方复用为 mutateMeta 的 pre：既省一次子请求，也让 CAS 覆盖
 *  「从这次守卫读开始」的整个窗口（这中间会 await 写正文 / 迁移进度 —— 那正是并发窗口所在）。 */
async function editableMeta(store, id) {
  if (!(await indexHas(store, id))) {
    return { resp: json({ error: '书不在书架（可能已删除或未发布）' }, 404) };
  }
  const cur = await getWithEtag(store, KEY.book(id));
  const meta = cur ? tryParseJson(cur.text) : null;
  if (!meta) return { resp: json({ error: '书不存在' }, 404) };
  if (meta.status !== 'ready') return { resp: json({ error: '书正在更新中，请稍后重试' }, 409) };
  return { meta, cur };
}

/** 就地编辑后同步书架摘要：单书模式打开（只碰该书分片）→ 重建该条目（章数/字数/更新时间 + 保留 pinned/进度镜像） */
async function syncIndexAfterEdit(store, meta) {
  // 首波两读并行（该书分片 + progress），第二波两写并行（bak + 分片）——4 程 → 2 波
  const [idx, ptRaw] = await Promise.all([
    openIndex(store, { single: meta.id }),
    store.getText(KEY.progress(meta.id)).catch(() => null),
  ]);
  let prog;
  try {
    if (ptRaw) {
      const p = JSON.parse(ptRaw);
      if (p && Number.isFinite(p.ch)) prog = { ch: p.ch, ratio: p.ratio || 0, updatedAt: p.updatedAt || 0 };
    }
  } catch {
    /* 无进度则沿用原镜像 */
  }
  // 书在「守卫通过之后、这次 patch 之前」被并发软删摘出索引时，patch 会抛非冲突错误 → 500，
  // 而正文与 meta 已经写完（响应说失败、盘上已改）。软删语义已吸收这次编辑，索引条目已由删除
  // 流程摘掉，跳过同步即可——与 apiPatchBook / apiProgressPut 的 get() 守卫对齐
  // （2026-09-17 二次复查 R2）。
  if (idx.get(meta.id)) {
    idx.patch(meta.id, (b) => ({ ...indexEntryFromMeta(meta), pinned: !!b.pinned, prog: prog || b.prog }));
    await idx.save({ bak: true });
  }
}

/** 插入章后迁移进度：原进度章在插入位之后 → 章号 +1（章正文未变） */
const shiftProgressOnInsert = (store, id, at) =>
  migrateProgress(store, id, (p) =>
    p.ch >= 1 && p.ch - 1 >= at ? { ch: p.ch + 1, ratio: p.ratio || 0, updatedAt: Date.now() } : null
  );

/** 删除章后迁移进度：进度在被删章之后 → 章号 -1；删的恰是进度章 → 原地顶替；
 *  新章数 newLen 用于把越界进度（删末章后 ch > 章数）压回新末章——书架角标直接读
 *  progress 镜像，不 clamp 就会显示「读到 5/4 章」这类越界数字。 */
const shiftProgressOnDelete = (store, id, di, newLen) =>
  migrateProgress(store, id, (p) => {
    if (!(p.ch >= 1)) return null;
    let ch = p.ch;
    if (ch - 1 > di) ch -= 1; // 被删章之后 → 前移
    if (ch > newLen) ch = newLen; // 删的是末章/进度章且越界 → 压回新末章
    if (ch === p.ch) return null; // 位置没变就别碰盘（旧实现每次都重写，白推进 updatedAt）
    return { ch, ratio: p.ratio || 0, updatedAt: Date.now() };
  });

/** PATCH /api/books/:id/chapters/:key — 就地改标题 / 改正文（body: { title?, content? }） */
async function apiPatchChapter(req, env, store, id, key) {
  const g = await editableMeta(store, id);
  if (!g.meta) return g.resp;
  if (chIndex(g.meta, key) < 0) return json({ error: '章节不存在' }, 404);
  const bj = await readJsonBody(req, 6 * 1024 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const hasTitle = typeof body.title === 'string';
  const hasContent = typeof body.content === 'string';
  if (!hasTitle && !hasContent) return json({ error: '没有要修改的内容' }, 400);

  // #145 P2-10：字数账改成「以章条目上的 words 为基线」+ 正文落盘后移到 CAS 成功之后。
  // 旧写序的三个坑：① 正文先落盘，CAS 冲突耗尽返回 409 后客户端重试，从盘上读到的「旧正文」
  // 其实是第一次刚写的新正文 → 增量算成 0 → meta.wordCount 永久少计一次（注释自称的
  // 「客户端重试即自愈」对 cleanVer 成立、对字数不成立）；② 两个设备并发编辑同一章时
  // 增量各自相对于自己的读值，双算/漏算；③ CAS 失败但正文已改，meta 与盘面短暂不一致还要
  // 靠 diag 兜。现在：baseline 随 meta 原子落盘（mutate 纯内存可重放），正文只在 CAS
  // 成功后才写 —— 失败时盘上仍是旧正文，重试重新算增量即自愈；正文写失败回 409 让客户端
  // 重试（此时 words 基线已是新值，重试增量 0、不会双算，补写后收敛）。
  let newWords = 0;
  let oldWordsDisk = 0; // 仅作「章条目尚无 words 基线」时的兜底（老数据首次修改）
  if (hasContent) {
    const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
    if (enc.encode(body.content).byteLength > max) return json({ error: '章节超过上限' }, 413);
    oldWordsDisk = wordsOf(await store.getText(KEY.text(id, key)));
    newWords = wordsOf(body.content);
  }
  const m = await mutateMeta(
    store,
    id,
    (meta) => {
      const i = chIndex(meta, key);
      if (i < 0) return { abort: json({ error: '章节不存在' }, 404) }; // 并发删章 → 不写回
      if (hasTitle) {
        const t = body.title.trim();
        meta.chapters[i].title = t ? safeStr(t, 120) : '第' + (i + 1) + '章';
      }
      if (hasContent) {
        const prev = Number.isFinite(meta.chapters[i].words) ? meta.chapters[i].words : oldWordsDisk;
        meta.wordCount = Math.max(0, (Number(meta.wordCount) || 0) + newWords - prev);
        meta.chapters[i].words = newWords;
      }
      meta.cleanVer = (Number(meta.cleanVer) || 1) + 1;
      meta.updatedAt = Date.now();
      return { out: meta.chapters[i].title };
    },
    g.cur
  );
  if (!m.ok) return metaFail(m);
  if (hasContent) {
    try {
      await store.putText(KEY.text(id, key), body.content);
    } catch {
      // meta 的字数已含新值而正文没写上：报 409 让客户端重试（words 基线已登记 → 重试
      // 增量 0、不双算，正文补写后收敛）。不静默成功 —— 那会让书架字数与阅读内容长期不符。
      return json({ error: '正文写入失败，请重试' }, 409);
    }
  }
  await syncIndexAfterEdit(store, m.meta);
  return json({ ok: true, title: m.out, cleanVer: m.meta.cleanVer, wordCount: m.meta.wordCount });
}

/** POST /api/books/:id/chapters/insert — 插入一章（body: { after?: key|null, title?, content? }）
 * 新章获得独立 key（不与数字 key 冲突），老章 key 与正文全部保持不动。 */
async function apiInsertChapter(req, env, store, id) {
  const g = await editableMeta(store, id);
  if (!g.meta) return g.resp;
  const bj = await readJsonBody(req, 6 * 1024 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const titleRaw = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!titleRaw && !content) return json({ error: '章节标题和正文不能都为空' }, 400);
  const max = Number(env.MAX_CHAPTER) || MAX_CHAPTER_BYTES;
  if (enc.encode(content).byteLength > max) return json({ error: '章节超过上限' }, 413);
  const afterKey = body.after === undefined || body.after === null || body.after === '' ? null : String(body.after);
  const gArr = Array.isArray(g.meta.chapters) ? g.meta.chapters : [];
  const gAt = afterKey ? gArr.findIndex((c) => c.key === afterKey) + 1 : gArr.length;
  if (afterKey && gAt === 0) return json({ error: '参照章节不存在' }, 404);

  const key = newId(); // 只生成一次：重放时若换 key，盘上会留下孤儿正文
  // #145 P3-5：正文落盘挪到 CAS 成功之后。旧写序先落盘再 CAS —— 若 mutateMeta 冲突耗尽
  // 返回 409，这个没人引用的正文对象已写在盘上，而 meta.orphans 只由 replace/sweep 登记，
  // 孤儿清扫（sweepOrphans 只扫 meta.orphans）永远扫不到它 → 只能靠 diag 全量列找。
  // 后移后失败路径零对象残留；「参照章被并发删 → 退化为追加」的分支本来也不该 abort。
  const m = await mutateMeta(
    store,
    id,
    (meta) => {
      if (!Array.isArray(meta.chapters)) meta.chapters = [];
      const arr = meta.chapters;
      // 插入位按**当前盘面**重算：并发插入/删除之后，照旧下标插会插错位置
      let at = arr.length;
      if (afterKey) {
        const j = arr.findIndex((c) => c.key === afterKey);
        // 参照章被并发删了 → 退化为追加（新章正文已落盘，这里不能 abort 留下孤儿）
        at = j >= 0 ? j + 1 : arr.length;
      }
      at = Math.max(0, Math.min(at, arr.length));
      // 缺省标题按**实际插入位**推导（纯内存，重放安全）：守卫读的 gAt 在重放后可能不再是真实位置
      const title = titleRaw ? safeStr(titleRaw, 120) : '第' + (at + 1) + '章';
      // #145 P2-10：章条目登记 words 基线（实测字数）。后续改这一章时字数差从条目上取，
      // 不再回頭读正文 —— 读盘值在「正文已写、meta CAS 失败、客户端重试」的场景里会把
      // 新正文当旧值算出 0 增量（字数永久少计）。老数据无 words 时按盘面兜底（见 apiPatchChapter）。
      // R150 P3-5：插入同样复核单本上限（create / replace 都截断到 CHAPTER_MAX，只有 insert 从不看）
      if (arr.length >= CHAPTER_MAX) return { abort: json({ error: '章节数超过上限（' + CHAPTER_MAX + ' 章）' }, 409) };
      arr.splice(at, 0, { key, title, words: wordsOf(content) });
      meta.chapterCount = arr.length;
      meta.wordCount = (Number(meta.wordCount) || 0) + wordsOf(content);
      meta.cleanVer = (Number(meta.cleanVer) || 1) + 1;
      meta.updatedAt = Date.now();
      return { out: { at, count: arr.length } };
    },
    g.cur
  );
  if (!m.ok) return metaFail(m);
  // 正文落盘（见上：CAS 成功之后）。失败要单独报：章已入表而正文缺失 → 阅读 404，
  // 客户端可重试插入（幂等由同键 key 生成一次保证不了重试语义，但失败面已最小化）。
  try {
    await store.putText(KEY.text(id, key), content); // 空正文也落盘（阅读时提示无内容，不 404）
  } catch {
    // R2 补偿：章已随 CAS 入表而正文没写上 → 悬挂章（阅读 404），且客户端重试插入会换
    // 新 key（newId 每请求一次）→ 同章重复、先插的那套成空壳。尽力摘除条目回退字数，
    // 把失败路径收敛到「什么都没发生」；补偿自身失败也不掩盖 409（编辑器可手删悬挂章，
    // countWords(null)=0 已实测可删）。key 从未有正文落盘 → 不必登记 meta.orphans
    // （孤儿清扫只扫登记过的 key，这里删条目就干净了）。
    try {
      await mutateMeta(
        store,
        id,
        (meta) => {
          const i = chIndex(meta, key);
          if (i < 0) return { dirty: false }; // 已被并发删掉 → 无需补偿
          const w = Number.isFinite(meta.chapters[i].words) ? meta.chapters[i].words : wordsOf(content);
          meta.wordCount = Math.max(0, (Number(meta.wordCount) || 0) - w);
          meta.chapters.splice(i, 1);
          meta.chapterCount = meta.chapters.length;
          meta.cleanVer = (Number(meta.cleanVer) || 1) + 1;
          meta.updatedAt = Date.now();
          return {};
        },
        null,
        2 // 失败路径的尽力补偿：tries 收窄，别把罕见的 R2 抖动放大成额外子请求
      );
    } catch {
      /* 补偿尽力而为：409 照常返回，客户端重试或进编辑器手删 */
    }
    return json({ error: '正文写入失败，请重试' }, 409);
  }
  // 进度迁移放在 CAS 成功之后、用**实际插入位** m.out.at（F4）：原先放在 CAS 之前用守卫读的
  // gAt —— 重放后参照章被并发移动/删除时迁移阈值偏 1 章，且 409/冲突时进度被白迁。progress
  // 与 meta 是两个文件，迁移只读进度自身、与 meta 写序无关 → 放成功之后语义不变、失败面更小。
  await shiftProgressOnInsert(store, id, m.out.at);
  await syncIndexAfterEdit(store, m.meta);
  return json({ ok: true, key, title: m.meta.chapters[m.out.at].title, chapterCount: m.out.count, cleanVer: m.meta.cleanVer });
}

/** DELETE /api/books/:id/chapters/:key — 删除一章（正文一并清除） */
async function apiDeleteChapter(store, id, key) {
  const g = await editableMeta(store, id);
  if (!g.meta) return g.resp;
  const gArr = Array.isArray(g.meta.chapters) ? g.meta.chapters : [];
  const gi = gArr.findIndex((c) => c.key === key);
  if (gi < 0) return json({ error: '章节不存在' }, 404);
  if (gArr.length <= 1) return json({ error: '至少保留一章' }, 400);
  const oldWords = wordsOf(await store.getText(KEY.text(id, key))); // 兜底基线：条目无 words 时用
  // #144 P3：正文删除从 CAS **之前**挪到成功之后 —— 旧写序里并发把章删到只剩 1 章时
  // mutateMeta 会短路（i>=0 且 arr.length<=1 → 返回 ok + chapterCount:1），而正文已在
  // 前一步被删 → 客户端拿到「成功」、章表却仍引用已删正文（阅读 404）。改序后 CAS 成功
  // 意味着该 key 必已不在章表，此时才删正文；若进程中断在两者之间，残留正文变成孤儿、
  // 由孤儿清扫兜底（章表不含的 key 才会被清，方向安全）。
  const m = await mutateMeta(
    store,
    id,
    (meta) => {
      const arr = Array.isArray(meta.chapters) ? meta.chapters : [];
      const i = arr.findIndex((c) => c.key === key);
      // 并发已删掉同一章 → 结果已达成：短路成功，不写盘、不重复扣字数（幂等）
      if (i < 0 || arr.length <= 1) return { dirty: false, out: { chapterCount: arr.length } };
      // #145 P2-10：扣减基线优先取条目上的 words（与 apiPatchChapter 同一口径；重放时盘面
      // 可能已被并发 patch 更新过条目 words，用读盘旧值会双扣/漏扣）。
      const w = Number.isFinite(arr[i].words) ? arr[i].words : oldWords;
      meta.wordCount = Math.max(0, (Number(meta.wordCount) || 0) - w);
      arr.splice(i, 1);
      meta.chapterCount = arr.length;
      meta.cleanVer = (Number(meta.cleanVer) || 1) + 1;
      meta.updatedAt = Date.now();
      return { out: { di: i, chapterCount: arr.length } };
    },
    g.cur
  );
  if (!m.ok) return metaFail(m);
  if (!m.skipped) {
    // 正文删除（见上：CAS 成功后才删）
    await store.delete(KEY.text(id, key));
    // 进度迁移放在 CAS 成功之后、用**实际删除位** m.out.di（与插入路径的 F4 同一修法）：
    // 原先放在 CAS 之前用守卫读的 gi —— 409/冲突耗尽时章没删成、进度却已被白迁（阅读位置
    // 错一章）；并发双删时还会在已迁移的值上再迁一次。skipped（并发已删）则不迁——对方已迁。
    await shiftProgressOnDelete(store, id, m.out.di, m.out.chapterCount);
    await syncIndexAfterEdit(store, m.meta);
  }
  return json({ ok: true, chapterCount: m.out.chapterCount, cleanVer: m.meta.cleanVer, wordCount: m.meta.wordCount });
}


/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { apiPutChapter, apiPutChapters, apiPutRaw, apiRawGet, apiUpdateChapters, apiPublish, apiRollback, apiBookMeta, apiPatchBook, apiChapter, apiPatchChapter, apiInsertChapter, apiDeleteChapter };
