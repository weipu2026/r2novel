/**
 * r2novel — 书架列表 / 建书
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { TRASH_DAYS, CHAPTER_MAX, TAG_MAX } from '../../public/js/shared-const.js';
import { normTitle } from '../../public/js/shared-text.js';
import { json, readJsonBody } from '../core/base.js';
import { KEY } from '../core/const.js';
import { putStatus } from '../store/book.js';
import { indexEntryFromMeta } from '../store/entry.js';
import { openIndex } from '../store/open.js';
import { safeStr, shardCapExceeded, readIndex, newId } from '../store/shard.js';

/* ---------------- 书架 / 建书 ---------------- */


/** 书架摘要（含置顶与进度镜像；排序由前端负责） */
async function apiBooks(store, env) {
  const idx = await openIndex(store);
  // #144 P2-7：回收站保留期以服务端生效值为准（env.TRASH_DAYS 可覆盖默认），前端徽章/确认
  // 文案不再硬编码 shared-const 的默认值 —— 运维调整后「剩 N 天」才不会系统性说谎。
  return json({ books: idx.books, trashDays: Number(env.TRASH_DAYS) || TRASH_DAYS });
}

/**
 * 建书。客户端已在浏览器端完成清洗+分章。
 * body { title, author, tags[], chapters:[title...], wordCount, cleanVer }
 * 同名在架书 → duplicate=true + book 摘要（客户端引导「新建 / 更新」）
 * 返回 { id, chapterKeys, duplicate, book? }
 */
async function apiCreateBook(req, env, store) {
  const bj = await readJsonBody(req, 2 * 1024 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const title = safeStr(body.title, 120);
  if (!title) return json({ error: '书名不能为空' }, 400);
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, CHAPTER_MAX) : [];
  if (!chapters.length) return json({ error: '没有章节' }, 400);

  // #144 P3（天花板标注）：判重走全量索引（openIndex = root + K 片，K≈ceil(本数/500)）。
  // 2 万本 ≈ 41 片 → 1(root)+41(片)+固定开销已贴近 50 子请求硬顶；千本级（2 片）完全无忧。
  // 若未来书库真到万级，需按 normTitle 建辅助映射而不是全量拉——当前规模不值得为此
  // 多维护一个分片结构。
  // #145 P3-1：判重全量读 1+K（同 apiTagsList），K≥50 读不动直接 500。先探 root。
  const over = await shardCapExceeded(store);
  if (over) return json({ error: `书库分片过多（${over} 片），暂时无法新建书籍` }, 409);
  const index = await readIndex(store);
  const nt = normTitle(title);
  const dup = (index.books || []).find((b) => normTitle(b.title) === nt);
  if (dup) {
    return json({
      ok: true,
      duplicate: true,
      book: indexEntryFromMeta(dup), // index 条目字段齐全，直接复用车架摘要（多带 pinned/cleanVer，无害）
      // 占位 id：客户端若选「新建」，需要重新调用一次（本次直接返回提示）
      needCreate: true,
    });
  }

  return createBookRecord(store, body);
}

async function createBookRecord(store, body) {
  const title = safeStr(body.title, 120);
  const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, CHAPTER_MAX) : [];
  const id = newId();
  const now = Date.now();
  const chTable = chapters.map((t, i) => ({ key: String(i + 1), title: safeStr(t, 120) || '第' + (i + 1) + '章' }));
  const meta = {
    id,
    title,
    author: safeStr(body.author, 60),
    note: safeStr(body.note, 500),
    tags: Array.isArray(body.tags) ? body.tags.map((t) => safeStr(t, 30)).filter(Boolean).slice(0, TAG_MAX) : [],
    wordCount: Number(body.wordCount) || 0,
    cleanVer: Number(body.cleanVer) || 1,
    createdAt: now,
    updatedAt: now,
    pinned: !!body.pinned,
    status: 'creating',
    chapters: chTable,
  };
  // 新 id 的首次写：此刻盘上还没有这本书，不存在「并发读—改—写」面 → 刻意**不**走 mutateMeta
  // （CAS 只会白花一次读）。同类的首发路径见 apiPutChapter / apiBlob 等。
  await Promise.all([store.putText(KEY.book(id), JSON.stringify(meta)), putStatus(store, id, 'creating')]);
  return json({ ok: true, duplicate: false, id, chapterKeys: chTable.map((c) => c.key) });
}

/** 上传一章：body 为清洗后文本（utf-8）
 * 只放行「建书/更新中」（creating）的书：已发布书若走这里直写正文，
 * 会绕过就地编辑的字数修正 / cleanVer+1 / index 镜像同步，造成长期不一致。 */

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { apiBooks, apiCreateBook };
