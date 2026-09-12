/* 前后端共用的数值协议 —— 数字只此一处定义。
 * src/router.js（后端 Worker/dev-server）与 public/js/*.js（前端浏览器）共同 import：
 *   router.js 经 '../public/js/shared-const.js'、前端经 './shared-const.js'。
 * 目的：杜绝「后端 DELETE_BATCH=30 vs 前端 BATCH=40」这类前后端数字漂移 bug。
 * 任何改动都会同时生效于两端；改前请确认后端预算（子请求 ≤50）仍然成立。
 */

/** 单本章表上限（章节数） */
export const CHAPTER_MAX = 20000;

/** 单章正文上限（字节，2MB）—— 后端 env.MAX_CHAPTER 的默认值 */
export const MAX_CHAPTER_BYTES = 2097152;

/** 前端超大章预切阈值（字节）：须 < MAX_CHAPTER_BYTES 留上传余量（fitChapters） */
export const FIT_CHAPTER_BYTES = 1900000;

/** 批量上传正文单批上限（章）：POST /chapters/bulk 与前端 uploadMany 共用。
 * 预算：1 读 + 40 并发写 = 41 子请求 ≤50；批内写是并发的，批大小不拖慢单批耗时 */
export const BULK_CHAPTER_BATCH = 40;

/** 书架批量操作单批上限（本）：POST /api/books/batch 与前端 BATCH_PAGE 共用 */
export const BATCH_BOOKS_MAX = 18;

/** 原件单次上传上限（字节，50MB）—— 后端 env.MAX_UPLOAD 的默认值 */
export const MAX_UPLOAD_BYTES = 52428800;

/** 整本流式导出章节上限（Free 计划子请求护栏） */
export const EXPORT_MAX_CHAPTERS = 40;

/** 回收站保留天数（超期由业务请求时机惰性清除；env.TRASH_DAYS 可覆盖此默认值） */
export const TRASH_DAYS = 15;

/** 「已读完」判定阈值：停在末章且本章滚动比例 ≥ 此值即视为读完。
 * 前后端必须一致——前端书架角标（app.js readState）与后端进度镜像刷新
 * （router.js apiProgressPut）各判一次，阈值漂移会出现「角标说读完了但镜像不刷新」的错位。
 * 取 0.9 而非 1：手机端末章末尾常带留白/padding，滚到底未必精确到 1，太严会导致读完也点不亮。 */
export const READ_DONE_RATIO = 0.9;
