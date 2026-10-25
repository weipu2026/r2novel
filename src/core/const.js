/**
 * r2novel — 常量表：R2 key 布局 / 上限 / 批大小
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { json } from './base.js';

const SESSION_COOKIE = 'rn_session';

export const KEY = {
  INDEX: 'meta/index.json',
  INDEX_BAK: 'meta/index.json.bak',
  TRASH: 'meta/trash.json',
  BRUTE: 'meta/sec/brute.json',
  book: (id) => `meta/${id}.json`,
  // 章节读取用的状态副档（meta/sec/ 前缀被 diag 扫描排除，不会成「无主书」误报）：
  // 让 GET 章节只读 ~20B 判定可读性，免每章请求都全量解析 meta（2000 章书 meta≈1MB JSON.parse/次）
  st: (id) => `meta/sec/st/${id}.json`,
  text: (id, key) => `text/${id}/${key}.txt`,
  raw: (id) => `raw/${id}.txt`,
  progress: (id) => `progress/${id}.json`,
};
const IDX_SHARD_MAX = 500; // 单片书数上限；1000 本=2 片、5000 本=10 片，全量读 1+n 个子请求始终远低于 50
const KEY_IDX = {
  root: 'meta/idx/root.json',
  rootBak: 'meta/idx/root.json.bak',
  v1Bak: 'meta/index.json.v1.bak',
  shard: (n) => `meta/idx/s${n}.json`,
  shardBak: (n) => `meta/idx/s${n}.json.bak`,
};
/** save() 因 CAS 冲突最多重放几次（含首次）。正常一次就成，第二次兜住并发，第三次只对极端抖动。 */
const IDX_SAVE_TRIES = 3;
const DELETE_BATCH = 30; // 单请求/单次惰性清理最多删除的正文对象数（加固定开销后仍远低于 Free 50 子请求红线）
const PURGE_BATCH = DELETE_BATCH; // 彻底删除单批上限（留余量给 raw/meta/progress/trash 写入）
const ORPHAN_BATCH = 24; // replace 遗留孤儿惰性清理单批（publish/更新/目录读取顺带清，分批清完）

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { SESSION_COOKIE, IDX_SHARD_MAX, KEY_IDX, IDX_SAVE_TRIES, PURGE_BATCH, ORPHAN_BATCH };
