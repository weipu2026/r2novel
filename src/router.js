/**
 * r2novel — 共享路由核心（Worker 与本地 dev-server 共用）
 *
 * 所有数据都走 /api/* + 会话 Cookie 鉴权；R2/文件系统只由外层适配。
 *
 * R2 key 布局：
 *   meta/idx/root.json       书架索引 v2 根：{ v:2, shards:n, map:{ id: 分片号 } }（含 .bak）
 *   meta/idx/s<N>.json       书架摘要分片（≤500 本/片，含 .bak；条目含 pinned / 进度镜像 prog）
 *   meta/index.json(.bak)    v1 单文件索引——迁移后**冻结不再读写**，留作旧代码回滚窗口的只读快照；
 *                            迁移时另存 meta/index.json.v1.bak 双保险
 *   meta/trash.json          回收站（软删书，15 天惰性清理）
 *   meta/<bookId>.json       单书元数据（章节目录表）
 *   text/<bookId>/<key>.txt  清洗后正文章节
 *   raw/<bookId>.txt         上传原件（留档 / 重洗）
 *   progress/<bookId>.json   阅读进度 {ch, ratio, updatedAt}
 *
 * store 接口（外层注入）：
 *   getText(key) -> string|null    putText(key, str)
 *   getBytes(key) -> Uint8Array|null   putBytes(key, bytes)
 *   openRead(key) -> ReadableStream|null   按 key 打开字节流（整本导出流式拼章用）
 *   delete(key)
 *
 * 子请求预算纪律（Workers Free 单请求 ≤50 个子请求）：
 *   - publish 只抽样 3 章校验，字数信任客户端 cleaner 统计，绝不逐章回读统计；
 *   - 彻底删除单批 ≤30 章、惰性清扫每请求 ≤1 本、孤儿批次 ≤24，逐书固定开销
 *     （readBook + raw/meta/progress 删除 + 写 trash）叠加核账过，单路径最坏仍远低于 50；
 *     剩余 keys 存 trash 条目 purge 字段，客户端续调直至 done。
 *
 * 模块地图（#149 P2 拆分，本文件只剩路由表）：
 *   core/   常量 · HTTP/请求体/etag 助手 · 防爆破 · 会话鉴权   —— 无业务语义，被上面单向依赖
 *   store/  索引分片与自愈 · 单书 meta · 摘要条目 · 删除清理   —— 数据真源，不碰 HTTP
 *   api/    一类端点一个文件（auth/books/chapters/progress/batch/trash/diag/opds）
 *   本文件   handleApi 分发 + handleRequest 入口；对外仍 re-export KEY/openIndex/diagPageAlloc
 */

import { apiLogin, apiLogout } from './api/auth.js';
import { apiBatchBooks, apiTagsList, apiTagsMerge } from './api/batch.js';
import { apiBooks, apiCreateBook } from './api/books.js';
import {
  apiPutRaw,
  apiRawGet,
  apiPublish,
  apiRollback,
  apiUpdateChapters,
  apiInsertChapter,
  apiPutChapters,
  apiPutChapter,
  apiChapter,
  apiPatchChapter,
  apiDeleteChapter,
  apiBookMeta,
  apiPatchBook,
} from './api/chapters.js';
import { apiDiagOrphans, apiPurgeOrphans } from './api/diag.js';
import { opdsCatalog, opdsExport } from './api/opds.js';
import { apiProgressGet, apiProgressPut } from './api/progress.js';
import { apiTrashList, apiTrashClear, apiRestore, apiSoftDelete, apiTrashPurge } from './api/trash.js';
import { verifyCookie } from './core/auth.js';
import { dropBody, json, notFound } from './core/base.js';
import { isSafeId, isIdxConflict } from './store/shard.js';


export { KEY } from './core/const.js';
export { openIndex } from './store/open.js';
export { diagPageAlloc } from './api/diag.js';
/* ---------------- 路由 ---------------- */

async function handleApi(req, env, store, url, p) {
  if (p === '/api/login') {
    if (req.method !== 'POST') {
      await dropBody(req);
      return json({ error: 'method' }, 405);
    }
    return apiLogin(req, env, store);
  }

  if (!(await verifyCookie(req, env))) {
    await dropBody(req);
    return json({ error: 'unauthorized' }, 401);
  }

  // #145 R12：POST 之外的 method 必须显式 405。原写法把条件写成「p === … && method === 'POST'」，
  // 其他 method 不匹配就**穿过整条路由链**落到末尾的 404（客户端拿到的是「没有这个端点」，
  // 而不是「方法不对」）。与 P3-9 的口径对齐：子路由 method 不匹配一律 405。
  if (p === '/api/logout') {
    if (req.method === 'POST') return apiLogout(req);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  if (p === '/api/books') {
    if (req.method === 'GET') return apiBooks(store, env);
    if (req.method === 'POST') return apiCreateBook(req, env, store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  if (p === '/api/trash') {
    if (req.method === 'GET') return apiTrashList(store, env, req);
    if (req.method === 'POST' && url.searchParams.get('action') === 'clear') return apiTrashClear(store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // 批量操作（书架多选）：必须在 /api/books/:id 之前匹配，否则 'batch' 会被当成书 id
  if (p === '/api/books/batch') {
    if (req.method === 'POST') return apiBatchBooks(req, store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // 标签治理：GET 全量清单（不截断）/ POST 合并·改名·删除（to 为空即删除）
  if (p === '/api/tags') {
    if (req.method === 'GET') return apiTagsList(store);
    if (req.method === 'POST') return apiTagsMerge(req, store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // 残留诊断：GET 全库扫描分类 / DELETE 批量删无主对象（书架「检查残留」）
  if (p === '/api/diag/orphans') {
    if (req.method === 'GET') return apiDiagOrphans(url, store);
    if (req.method === 'DELETE') return apiPurgeOrphans(req, store);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mRaw = /^\/api\/books\/([^/]+)\/raw$/.exec(p);
  if (mRaw && !isSafeId(mRaw[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mRaw && req.method === 'PUT') return apiPutRaw(req, env, store, mRaw[1]);
  if (mRaw && req.method === 'GET') return apiRawGet(store, mRaw[1]);
  // #145 R12：同上 —— PUT/GET 之外（POST / DELETE / PATCH…）原来会穿到末尾的 404；补上本子路由
  // 的 405 出口（/publish、/restore、/chapters 等分支都有，这两个漏了）。
  if (mRaw) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mPublish = /^\/api\/books\/([^/]+)\/publish$/.exec(p);
  if (mPublish && !isSafeId(mPublish[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mPublish && req.method === 'POST') return apiPublish(req, env, store, mPublish[1]);
  if (mPublish) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // R150 P1-3：更新中断后把书从 creating 恢复到可读态（幂等）
  const mRollback = /^\/api\/books\/([^/]+)\/rollback$/.exec(p);
  if (mRollback && !isSafeId(mRollback[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mRollback && req.method === 'POST') return apiRollback(req, env, store, mRollback[1]);
  if (mRollback) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mRestore = /^\/api\/books\/([^/]+)\/restore$/.exec(p);
  if (mRestore && !isSafeId(mRestore[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mRestore && req.method === 'POST') return apiRestore(store, mRestore[1]);
  if (mRestore) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mChapters = /^\/api\/books\/([^/]+)\/chapters$/.exec(p);
  if (mChapters && !isSafeId(mChapters[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mChapters && req.method === 'POST') return apiUpdateChapters(req, env, store, mChapters[1]);
  if (mChapters) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // 章节就地编辑：插入（v1.1）。注意必须在单章 /chapters/:key 之前匹配，否则 'insert' 会被当成 key
  const mIns = /^\/api\/books\/([^/]+)\/chapters\/insert$/.exec(p);
  if (mIns && !isSafeId(mIns[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mIns && req.method === 'POST') return apiInsertChapter(req, env, store, mIns[1]);
  if (mIns) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  // 批量上传正文（连续上传优化）：同样必须在单章 /chapters/:key 之前匹配，否则 'bulk' 会被当成 key
  const mBulk = /^\/api\/books\/([^/]+)\/chapters\/bulk$/.exec(p);
  if (mBulk && !isSafeId(mBulk[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mBulk && req.method === 'POST') return apiPutChapters(req, env, store, mBulk[1]);
  if (mBulk) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mCh = /^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/.exec(p);
  if (mCh && (!isSafeId(mCh[1]) || !isSafeId(mCh[2]))) {
    await dropBody(req);
    return notFound();
  }
  if (mCh && req.method === 'PUT') return apiPutChapter(req, env, store, mCh[1], mCh[2]);
  if (mCh && req.method === 'GET') return apiChapter(store, mCh[1], mCh[2]);
  if (mCh && req.method === 'PATCH') return apiPatchChapter(req, env, store, mCh[1], mCh[2]);
  if (mCh && req.method === 'DELETE') return apiDeleteChapter(store, mCh[1], mCh[2]);
  if (mCh) {
    // 第四轮审计：其余子路由（/chapters、/insert、/bulk、/raw、/publish、/trash/:id…）都有
    // 405 兜底，只有这里漏了 → POST 会穿透到末尾的 404，客户端把「方法不对」读成「端点不存在」。
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mBook = /^\/api\/books\/([^/]+)$/.exec(p);
  if (mBook && !isSafeId(mBook[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mBook) {
    if (req.method === 'GET') return apiBookMeta(store, mBook[1], req);
    if (req.method === 'PATCH') return apiPatchBook(req, store, mBook[1]);
    if (req.method === 'DELETE') return apiSoftDelete(store, mBook[1]);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mPurge = /^\/api\/trash\/([^/]+)$/.exec(p);
  if (mPurge && !isSafeId(mPurge[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mPurge) {
    if (req.method === 'DELETE') return apiTrashPurge(store, mPurge[1]);
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  const mProg = /^\/api\/progress\/([^/]+)$/.exec(p);
  if (mProg && !isSafeId(mProg[1])) {
    await dropBody(req);
    return notFound();
  }
  if (mProg && req.method === 'GET') return apiProgressGet(store, mProg[1]);
  if (mProg && req.method === 'PUT') return apiProgressPut(req, store, mProg[1]);
  if (mProg) {
    await dropBody(req);
    return json({ error: 'method' }, 405);
  }

  await dropBody(req);
  return json({ error: 'not found' }, 404);
}

export async function handleRequest(req, env, store) {
  const url = new URL(req.url);
  const p = url.pathname;

  // OPDS / 整本导出（第三方阅读器通道，独立于 /api/*）
  if (/^\/opds\/?$/.test(p)) {
    if (req.method !== 'GET') {
      await dropBody(req);
      return json({ error: 'method' }, 405);
    }
    // #145 P3-10：这条路径不在下面 /api/ 的 try 内（第三方阅读器通道，走独立鉴权）→ R2
    // 瞬时抖动时异常会冒到 Worker 顶层，阅读器收到平台默认 HTML 500 页。包一层转 JSON。
    try {
      return await opdsCatalog(req, env, store);
    } catch (e) {
      console.error('[opds] 未捕获异常:', e && e.stack ? e.stack : e);
      return json({ error: '目录生成失败，请稍后重试' }, 502);
    }
  }
  const mExp = /^\/export\/([^/]+)\.txt$/.exec(p);
  if (mExp) {
    if (!isSafeId(mExp[1])) {
      await dropBody(req);
      return notFound();
    }
    if (req.method !== 'GET') {
      await dropBody(req);
      return json({ error: 'method' }, 405);
    }
    // #145 P3-10：同 opds —— 导出链路（逐章 R2 流式拼接）的瞬时故障也转 JSON，别冒 HTML 500。
    try {
      return await opdsExport(req, env, store, mExp[1]);
    } catch (e) {
      console.error('[export] 未捕获异常:', e && e.stack ? e.stack : e);
      return json({ error: '导出失败，请稍后重试' }, 502);
    }
  }

  if (p.startsWith('/api/')) {
    // 顶层兜底（2026-09-17 复查 F4）：未捕获异常必须以 JSON 返回，而不是让 Workers 冒 1101
    // HTML——前端拿到 JSON 才能展示真实错误；索引并发冲突耗尽映射 409（客户端可重试）。
    try {
      return await handleApi(req, env, store, url, p);
    } catch (e) {
      // 复查 P3（精确化）：内部异常 message 只对**已认证**请求透传——泄露面在 /api/login
      // 这类鉴权之前的路径（未认证者也可能读到分片损坏/key 越界等运维细节）；站长本人
      // （单管理员站）仍要看到真实错误，F4 的初衷就是「前端能展示真实错误」，有测试护栏
      // （review-fix9 F4 / index-shards 写序两处）。真实堆栈进日志；409 判据保留
      // （IDX_CONFLICT 的 message 无害，且客户端要靠 409 重试）。
      const authed = await verifyCookie(req, env).catch(() => false);
      console.error('[api] 未捕获异常:', e && e.stack ? e.stack : e);
      return json(
        { error: authed && e && e.message ? e.message : '服务器内部错误' },
        isIdxConflict(e) ? 409 : 500
      );
    }
  }

  // 静态资源交给外层（Workers: ASSETS / dev: 静态文件服务）
  if (req.method === 'GET' || req.method === 'HEAD') {
    const resp = await env.serveStatic(req, url);
    if (resp) return resp;
  }
  return notFound();
}
