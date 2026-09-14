/* upload/upload.js — 上传核心链路（入库 / 同名处理 / 章节 bulk / 原件留档 / 发布）
 *
 * 链路：collectPayload 组装 payload → createAndUpload（或 uploadToExisting 替换/追加）
 *      → uploadChapters → uploadBulkAndRaw（正文 bulk 与原件 raw 并行）→ finalizeUpload 发布。
 *
 * 两条不许破坏的约定（都踩过坑）：
 *   1. 全程只认调用方传进来的 session 快照，绝不读 upSession.current() —— 上传期间当前会话
 *      可能已被换文件/粘贴替换，读它就会产出「标题A / 正文B」的坏书且全程无报错。
 *   2. 原件（raw）是可选附件：失败降级为 { rawFailed:true } 警告，绝不让它把整本正文一起删掉。
 */
import { els, $, esc, normTitle } from '../dom.js';
import { api, fmtWords } from '../store.js';
import { CHAPTER_MAX, BULK_CHAPTER_BATCH } from '../shared-const.js';
import { toast } from '../ui.js';
import { host } from './ctx.js';
import * as upSession from './session.js';

function collectPayload(session) {
  const preview = session.preview; // 唯一调用点 onConfirm 必传 session 快照；不兜底当前会话，宁可 fail loud
  if (preview.chapters.length > CHAPTER_MAX) toast(`章节数超过上限 ${CHAPTER_MAX}，多余章节将被截断`, 2600);
  return {
    title: els.upTitle.value.trim() || session.title,
    author: els.upAuthor.value.trim(),
    tags: host().parseTagInput(els.upTags.value),
    note: els.upNote.value.trim(),
    chapters: preview.chapters.slice(0, CHAPTER_MAX).map((c) => c.title),
    // 字数由 refreshPreviewStats 在每次编辑后实时维护（预览可编辑后它是唯一事实源）
    wordCount: preview.words || 0,
    cleanVer: 1,
  };
}

export function setProg(pct, text) {
  els.upProgBar.style.width = Math.round(pct * 100) + '%';
  els.upProgText.textContent = text;
}

export async function onConfirm() {
  if (upSession.isImporting()) return; // 批量导入中：runPreview 会重启用确认按钮，这里兜底屏蔽
  if (upSession.isUploading()) return; // 已有一次上传在飞：防重复提交
  const cur = upSession.current();
  if (!cur || !cur.preview || !cur.preview.chapters.length) return;
  // 冻结本次会话快照：此后每次 await 之后都从 session（这份快照）取数据，而非 session 模块的当前值。
  // 即便期间当前会话被换文件/重置，本次上传仍用当初确认的那份，从根上杜绝串台。
  const session = cur;
  const payload = collectPayload(session);
  const keepRaw = els.upKeepRaw.checked;
  upSession.setCreatedId(null);
  upSession.setUploading(true);
  els.upConfirm.disabled = true;
  els.upProgWrap.classList.remove('hidden');

  try {
    let pub = null;
    if (session.updating && session.updating.id) {
      pub = await uploadToExisting(session.updating.id, session.updating.op, payload, keepRaw, session);
    } else {
      const dup = host().getBooks().find((b) => normTitle(b.title) === normTitle(payload.title));
      if (dup) {
        const mode = await askDup(dup);
        if (!mode) {
          els.upProgWrap.classList.add('hidden');
          els.upConfirm.disabled = false;
          return;
        }
        if (mode === 'new') pub = await createAndUpload(payload, keepRaw, session);
        else pub = await uploadToExisting(dup.id, mode, payload, keepRaw, session);
      } else {
        pub = await createAndUpload(payload, keepRaw, session);
      }
    }
    upSession.setUploading(false); // 上传已成功：先解冻再刷书架，loadShelf 期间用户即可开始下一次上传
    toast(pub && pub.rawFailed ? '《' + payload.title + '》已入库，但原件上传失败，重洗不可用' : '《' + payload.title + '》已入库', 2200);
    upSession.clear();
    els.upFile.value = '';
    host().showView('shelf');
    // publish 响应已带回发布后的 books 快照 → 直接渲染书架，省一次 GET /api/books（慢链路 ≈2s）
    if (pub && pub.books) await host().loadShelf({ books: pub.books }).catch(() => {});
    else await host().loadShelf().catch(() => {}); // 兜底：旧版 worker 无 books 字段时走原刷新路径
  } catch (e) {
    // 新建流程中途失败 → 书停在 creating 且从未进书架：看不见、回收站也清不掉。
    // 移入回收站，让用户能看见并彻底删除（或重试），不留孤儿数据。
    if (upSession.createdId()) {
      await api.deleteBook(upSession.createdId()).catch(() => {});
      upSession.setCreatedId(null);
    }
    els.upProgWrap.classList.add('hidden');
    els.upConfirm.disabled = false;
    toast('上传失败：' + (e.message || e), 3200);
  } finally {
    upSession.setUploading(false); // 无论成败都解冻上传会话
  }
}

/** 同名提示（F3/F4）：更新(替换/追加) 还是 另存新书 */
function askDup(dup) {
  return new Promise((resolve) => {
    host().openModal(`
      <h3>发现同名书籍</h3>
      <p class="modal-sub">书架已有《${esc(dup.title)}》（${dup.chapterCount} 章 · ${fmtWords(dup.wordCount)}）。要新建一本还是更新它？</p>
      <div class="m-row"><button class="primary" id="dpReplace" type="button">整本替换</button><span class="grow muted">用新文件覆盖《${esc(dup.title)}》，按章节名尽力保留进度</span></div>
      <div class="m-row"><button class="ghost" id="dpAppend" type="button">追加章节</button><span class="grow muted">保留原章，新章节从末尾续接（适合补连载）</span></div>
      <div class="m-row"><button class="ghost" id="dpNew" type="button">另存副本</button><span class="grow muted">自动加「（副本）」编号存为新书</span></div>
      <div class="m-acts"><button class="ghost" id="dpCancel" type="button">取消</button></div>`);
    const pick = (mode) => { host().closeModal(); resolve(mode); };
    $('#dpReplace', els.modalBox).addEventListener('click', () => pick('replace'));
    $('#dpAppend', els.modalBox).addEventListener('click', () => pick('append'));
    $('#dpNew', els.modalBox).addEventListener('click', () => pick('new'));
    $('#dpCancel', els.modalBox).addEventListener('click', () => { host().closeModal(); resolve(null); });
  });
}

async function createAndUpload(payload, keepRaw, session) {
  const created = await api.createBook(payload);
  if (created.duplicate && created.needCreate && created.book) {
    const mode = await askDup(created.book);
    if (!mode) throw new Error('已取消');
    if (mode === 'new') {
      // 服务端同名拦截 → 自动加「（副本）」编号直至接受（防御旧书单竞态下的同名）
      let k = 1;
      let created2 = { duplicate: true };
      while (created2.duplicate && k <= 50) { // 上限防御：极端情况下不至于打空转请求
        const t = payload.title + '（副本' + (k === 1 ? '' : k) + '）';
        created2 = await api.createBook({ ...payload, title: t });
        k++;
      }
      if (created2.duplicate) throw new Error('无法创建副本（同名冲突过多）');
      upSession.setCreatedId(created2.id);
      return uploadChapters(created2.id, created2.chapterKeys, keepRaw, session);
    }
    return uploadToExisting(created.book.id, mode, payload, keepRaw, session);
  }
  upSession.setCreatedId(created.id);
  return uploadChapters(created.id, created.chapterKeys, keepRaw, session);
}

async function uploadToExisting(id, op, payload, keepRaw, session) {
  // append 不覆盖书名/作者/标签（保留旧书的）；replace 全量带
  const body = op === 'append' ? { op, chapters: payload.chapters, wordCount: payload.wordCount } : { op, ...payload };
  const updated = await api.updateChapters(id, body);
  const keys = updated.chapterKeys || [];
  const n = payload.chapters.length; // 本次实际要传的正文数
  const startKeyIdx = keys.length - n; // replace→0（全部重传）；append→旧章数（只传新章）
  if (startKeyIdx < 0) throw new Error('章节表与正文不匹配，已中止');
  // 必须走 finalizeUpload 合并（而非只回传 rawFailed）：替换/追加/重洗流程依赖响应里的
  // books 快照免刷新书架，漏掉会静默退化成一次全量 GET /api/books（慢链路 ~2s）
  const rawRes = await uploadBulkAndRaw(id, keys.slice(startKeyIdx), keepRaw, session);
  return finalizeUpload(id, rawRes);
}

/** 章节正文与原件留档互不依赖 → 并行上传（原件藏在正文传输窗口里，不再独占一程 RTT，
 *  慢链路下省掉 raw 请求的全部串行等待）；两者都落定后才发布，避免半成品发布。
 *  bulk 失败时仍等原件落定再抛错，让清理（删书）在无在途写的情况下进行，不留竞态孤儿。
 *  raw 是可选附件（不勾「保留原件」就没有，书照样合法）→ 失败不算上传失败：
 *  返回 { rawFailed:true }，由调用方决定提示文案；书照常发布，仅重洗不可用。
 *  （旧实现 raw 失败 throw → onConfirm 兜底 deleteBook，会因非必需附件失败删掉整本正文。） */
async function uploadBulkAndRaw(id, keys, keepRaw, session) {
  // 一律用会话快照（session），不读 upSession.current() —— 上传期间当前会话可能已被换掉
  if (!session) throw new Error('上传会话已失效，请重新选择文件');
  const rawP = keepRaw && session.bytes ? api.putRaw(id, session.bytes) : null;
  // raw 在后台并行传输：bulk 进度文字里捎带原件状态，慢链路下 20s 黑箱不再像卡死
  upSession.setRawReq(rawP);
  if (rawP) setProg(0, `上传章节 0/${keys.length}（原件传输中…）`);
  let bulkErr = null;
  try {
    await uploadMany(id, keys, session.preview.chapters);
  } catch (e) {
    bulkErr = e;
  }
  let rawFailed = false;
  if (rawP) {
    try {
      await rawP;
    } catch {
      rawFailed = true; // raw 失败降级为警告，不再向上抛
    }
  }
  upSession.setRawReq(null);
  if (bulkErr) throw bulkErr;
  return { rawFailed };
}

/** raw 请求是否仍在途（仅用于进度文案；rawP 只在 uploadBulkAndRaw 内可见，故挂到会话状态） */
function rawInFlight() {
  return upSession.rawReq() != null;
}

/** 收尾：发布（创建/替换/追加/批量导入共用）。返回 publish 响应与 rawFailed 合并结果。 */
async function finalizeUpload(id, rawRes) {
  setProg(1, '发布中…');
  const pub = await api.publish(id);
  return { ...rawRes, ...pub }; // rawFailed + books/wordCount 等发布结果
}

export async function uploadChapters(id, keys, keepRaw, session) {
  const rawRes = await uploadBulkAndRaw(id, keys, keepRaw, session);
  return finalizeUpload(id, rawRes);
}

/** 批量上传章节正文（bulk 接口，按批切 + 3 批在途流水线）：
 * 服务端 meta 校验从「每章一次」收敛到「每批一次」，请求数也从每章 1 个降到每批 1 个，
 * 连续上传大幅减负（Free 计划请求数/天是硬配额）。
 * 并发：慢链路（CF 边缘 RTT 200ms+）下纯串行会在等服务端响应时闲置上行，
 * 3 批在途把上行带宽喂满；批与批的 key 互不相同、服务端只是并发写独立对象，乱序到达无影响。
 * 批大小自适应（2026-09-09 实测驱动）：同一请求内服务端 R2 并发写被压到 ~3 个，
 * 小书（≤40 章）只有 1 批时 9 章写 3.4s（t.put=3386ms）全挤在一个请求里排队。
 * 批大小 = min(40, max(2, ceil(n/3)))：小书拆成 3 个并发请求各写 ~1 波，
 * 写阶段大幅提前；大书（千章级）仍 40 章/批，避免每批 0.7s meta 读拖累总量。
 * 分批双护栏：章数 ≤ BULK_CHAPTER_BATCH（与后端共享常量对齐，防 413 拒收），
 * 且批字节 ≤ 12MB——后端 bulk 单批还有 16MB 总字节护栏，40 章×1.9MB 最坏 76MB 会撞上；
 * 按字节再切批，保证任何大书都能上传而不被单批上限误伤。 */
async function uploadMany(id, keys, chapters) {
  const n = keys.length;
  if (!n) return;
  const CONC = 3; // 在途批数：再高对单用户上行收益递减，且抬高手机端内存峰值
  // 自适应批大小（见上注释）；min 保证大书不退化，max(2,·) 保证小书也能拆出 ≥2 个并发请求
  const BATCH = Math.min(BULK_CHAPTER_BATCH, Math.max(2, Math.ceil(n / CONC)));
  const BATCH_BYTES = 12 * 1024 * 1024; // 批字节护栏（< 后端 16MB maxTotal，留 JSON 转义余量）
  const enc = new TextEncoder();

  // 第一步：按护栏把批次边界全部算好（[start,end) 区间，纯本地零网络）
  const bounds = [];
  let i = 0;
  while (i < n) {
    const start = i;
    let bytes = 0;
    while (i < n && i - start < BATCH) {
      const c = chapters[i];
      const text = c && c.content != null ? c.content : '';
      const size = enc.encode(text).byteLength;
      // 至少发 1 章（单章 ≤FIT 上限远小于预算），之后字节将超则切下一批
      if (i > start && bytes + size > BATCH_BYTES) break;
      bytes += size;
      i++;
    }
    bounds.push([start, i]);
  }

  // 第二步：3 个 worker 从队列领批并发上传（单线程 JS，next 游标无竞态）
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < bounds.length) {
      const [s, e] = bounds[next++];
      const items = [];
      for (let k = s; k < e; k++) {
        const c = chapters[k];
        items.push({ key: keys[k], text: c && c.content != null ? c.content : '' });
      }
      const r = await api.putChapters(id, items);
      done += (r && r.count) || 0;
      setProg(done / n, `上传章节 ${done}/${n}${rawInFlight() ? '（原件传输中…）' : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, bounds.length) }, worker));
}
