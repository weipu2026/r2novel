/**
 * r2novel — meta → 书架索引摘要条目
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

function indexEntryFromMeta(meta, extra = {}) {
  return {
    id: meta.id,
    title: meta.title,
    author: meta.author,
    tags: meta.tags || [],
    pinned: !!meta.pinned,
    finished: !!meta.finished,
    // 阅读状态三态：true 已读完 / false 明确未读完 / undefined 走自动判定
    readDone: meta.readDone === undefined ? undefined : !!meta.readDone,
    // 星标＝私人收藏标记。与阅读状态（readDone）/ 完结（finished）互不相干，也镜像进 index，
    // 这样书架筛选不必逐本读 meta（与 pinned/finished 同一套「摘要即真相」策略）。
    star: !!meta.star,
    chapterCount: meta.chapterCount || (meta.chapters || []).length,
    wordCount: meta.wordCount || 0,
    cleanVer: meta.cleanVer || 1,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...extra,
  };
}

/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { indexEntryFromMeta };
