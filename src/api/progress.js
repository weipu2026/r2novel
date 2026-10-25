/**
 * r2novel — 阅读进度读写
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { READ_DONE_RATIO } from '../../public/js/shared-const.js';
import { json, readJsonBody, getWithEtag, tryParseJson, putIf } from '../core/base.js';
import { KEY, IDX_SAVE_TRIES } from '../core/const.js';
import { readBook } from '../store/book.js';
import { openIndex } from '../store/open.js';

/* ---------------- 进度（DR-02：R2 小对象 + index 镜像供书架角标） ---------------- */

const EMPTY_PROG = { ch: 0, ratio: 0, updatedAt: 0 };

async function apiProgressGet(store, id) {
  const t = await store.getText(KEY.progress(id));
  if (t == null) return json(EMPTY_PROG);
  try {
    return json(JSON.parse(t));
  } catch {
    return json(EMPTY_PROG);
  }
}

async function apiProgressPut(req, store, id) {
  const bj = await readJsonBody(req, 16 * 1024);
  if (bj.err) return json({ error: bj.err }, bj.status);
  const body = bj.body;
  const ch = Math.max(0, Math.floor(Number(body.ch) || 0));
  let ratio = Number(body.ratio);
  if (!Number.isFinite(ratio)) ratio = 0;
  ratio = Math.min(1, Math.max(0, ratio));
  // 三条对账判据。前两条只对**离线队列回放**生效（L6 / L17，行为不动），
  // 第三条是在线写入的并发控制（OCC），修的是本次审计定位到的跨设备覆盖：
  //
  //   · clientAt（离线队列带「原写入时间」）：离线期间排队、回网后迟到的旧值不能把更新的进度
  //     回退（同一设备上也成立：联网后先读了新章，随后队列才回放）。
  //   · clientVer（离线队列带「入队时的内容版本」）：该书在离线期间被编辑/重洗（cleanVer 变了）
  //     → 旧章号已失去意义 → 丢弃，否则进度会落在错误的章上（表现为跨设备编辑后进度 ±1）。
  //   · baseAt（在线写入带「本设备上次从服务端读到的 updatedAt」）：盘上真值比客户端**所知道的
  //     版本**新 → 这台设备是拿着过期认知来写的 → 拒写并把真值回传，让它对账后再来。
  //     场景：后台久置的旧标签页一醒（visibilitychange / pagehide 都会触发保存）就用旧位置
  //     无条件覆盖另一台设备刚写的新进度，读者感知为「读到哪跳回去了」。
  //
  // ⚠️ baseAt 与 clientAt 的本质差别：baseAt 是**服务端自己写过的时间**，全程只与服务端时间比，
  //    不受客户端时钟快慢影响；clientAt 是客户端时间，只适用于「离线期间产生的改动」这一种场景
  //    ——在线路径若照抄它，客户端时钟慢于服务端时会把正常写入误判成过期而丢弃，进度反而更不可靠。
  // ⚠️ 被拒时**不**把盘上真值当新 baseAt 回灌给客户端：那样它下一次写入就会覆盖，正是要修的事。
  //    基线只在两处推进：写入成功（响应回传的 updatedAt），或客户端亲眼从服务端读到
  //    （reader.js 的 syncFromServer 对账）。
  // 三个字段一个都不带 → 无条件覆盖：老客户端与外部探针的行为完全不变（向后兼容）。
  const hasBase = body.baseAt !== undefined && body.baseAt !== null;
  const baseAt = Number(body.baseAt) || 0;
  const clientAt = Number(body.updatedAt) || 0;
  const clientVer = Number(body.cleanVer) || 0;
  let data;
  if (!hasBase && !clientAt && !clientVer) {
    // 一个对账字段都不带 → 无条件覆盖：老客户端与外部探针的行为**完全不变**（连读子请求数都一致）
    data = { ch, ratio, updatedAt: Date.now() };
    await store.putText(KEY.progress(id), JSON.stringify(data));
  } else {
    // 带了对账字段 → 读—判—写必须**原子**。原实现是「读 → 判 → 无条件写」，属 TOCTOU：两个并发
    // 请求可以都读到同一个 prevAt、都通过检查、都写，后写者胜 —— 跨设备覆盖的窗口原封不动留着。
    // progress 本身支持 putTextIf（CAS，条件由存储端求值、不额外产生读子请求），冲突就重读重判：
    // 三个判据只用服务端时间与服务端内容版本，重放幂等，不放大任何副作用。
    for (let attempt = 0; ; attempt++) {
      const got = await getWithEtag(store, KEY.progress(id));
      const pv = got ? tryParseJson(got.text) : null;
      const prevAt = pv ? Number(pv.updatedAt) || 0 : 0;
      if (pv && clientAt && prevAt > clientAt) return json({ ok: true, skipped: 'stale', prog: pv });
      if (hasBase && prevAt > baseAt) return json({ ok: true, skipped: 'occ', prog: pv });
      if (clientVer) {
        const m = await readBook(store, id).catch(() => null);
        if (m && Number(m.cleanVer || 1) !== clientVer) return json({ ok: true, skipped: 'cleanVer' });
      }
      // updatedAt 每次重试都重取：用循环外那一份会让落盘时间**比并发写推进过的值更旧**，
      // 时间轴倒退会让后续的 prevAt > baseAt 判据失去意义。
      data = { ch, ratio, updatedAt: Date.now() };
      // 文件不存在时 etag 传 null（仅当不存在才写）→ 正好挡住「另一个请求刚把它建出来」的竞态
      const res = await putIf(store, KEY.progress(id), JSON.stringify(data), got ? got.etag : null);
      if (res.ok) break;
      if (attempt + 1 >= IDX_SAVE_TRIES) {
        // 重试用尽（同一本书的写极端密集）：放弃这一次，但必须回传盘上真值让客户端对账 ——
        // 否则客户端按响应推进基线、以为写成功了，下一次写入反而被「自己以为的版本」拒掉。
        return json({ ok: true, skipped: 'occ', prog: pv });
      }
    }
  }

  // 书架进度角标镜像：只在「换章」时写该书所在分片（单书模式）。章内滚动只写 progress 小文件（真值），
  // 不再写镜像 —— 消除写放大（千本规模分片≈150KB/次，长章滚几屏就是几十次），
  // 同时收窄分片读-改-写与 publish 并发时的覆盖窗口。
  // 代价：镜像百分比停留在最近一次换章时的值（书架角标「第几章」仍准确；恢复阅读读 progress 真值，不受影响）。
  try {
    const idx = await openIndex(store, { single: id });
    const book = idx.get(id);
    // 书不在架（已删/未发布）：书架镜像无处可写，但进度**真值已落盘** → updatedAt 照回。
    // 不回的话客户端基线跟不上，它下一次写入会被自己刚写的版本拒掉（白跑一次对账）。
    if (!book) return json({ ok: true, updatedAt: data.updatedAt });
    // 越界进度压回末章（镜像供书架角标直接显示，不能出现「读到 999/10 章」）
    // 恶意/异常客户端可能直接 PUT 超章数 ch；正常前端已 clamp，这里做服务端兜底。
    const cap = Number(book.chapterCount) || 0;
    const mch = cap > 0 && ch > cap ? cap : ch;
    const cur = book.prog;
    // 刷新条件＝「换章」或「读完状态翻转」。
    // 原实现只有前者：而读完一本书的典型动作是停在末章继续往下滚到底——章号不变、
    // 只有 ratio 变，原条件永远不成立 → 书架镜像的 ratio 停在旧值，角标「已读完」
    // 在实践中几乎永远点不亮。补上状态翻转后：跨过阈值那一刻多写恰 1 次镜像，
    // 已读完后继续滚动不再写，仍然不产生写放大（这正是当初只在换章时写的动机）。
    const isDone = cap > 0 && mch >= cap && ratio >= READ_DONE_RATIO;
    const curDone =
      !!cur && cap > 0 && Math.min(Number(cur.ch) || 0, cap) >= cap && (Number(cur.ratio) || 0) >= READ_DONE_RATIO;
    if (!cur || cur.ch !== mch || curDone !== isDone) {
      idx.patch(id, (b) => ({ ...b, prog: { ch: mch, ratio, updatedAt: data.updatedAt } }));
      await idx.save({ bak: false }); // 镜像写沿用 v1 语义：不写 bak（progress 真值文件才是权威）
    }
  } catch {
    /* ignore */
  }
  // updatedAt 必须回传：客户端拿它推进 OCC 基线（否则下一次写入会被自己刚写的这个版本拒掉）
  return json({ ok: true, updatedAt: data.updatedAt });
}


/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { apiProgressGet, apiProgressPut };
