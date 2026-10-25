/**
 * r2novel — 单书元数据与可读性副档的读取
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { KEY } from '../core/const.js';

async function readBook(store, id) {
  const raw = await store.getText(KEY.book(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 状态副档读写：{ s: 'ready'|'creating' }，~20B。写点与 meta.status 赋值点一一对应（建书/更新/发布）。
 * 副档缺失/损坏 → 回落全量 meta 并补写副档（存量书一次性迁移），meta 也没有 → null。 */
const putStatus = (store, id, s) => store.putText(KEY.st(id), JSON.stringify({ s }));
async function readStatus(store, id) {
  try {
    const t = await store.getText(KEY.st(id));
    if (t) {
      const s = JSON.parse(t);
      if (s && (s.s === 'ready' || s.s === 'creating')) return s.s;
    }
  } catch {
    /* 副档异常 → 回落 meta */
  }
  const meta = await readBook(store, id);
  if (!meta) return null;
  await putStatus(store, id, meta.status).catch(() => {}); // 尽力补档：失败不影响本次判定
  return meta.status;
}



/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { readBook, putStatus, readStatus };
