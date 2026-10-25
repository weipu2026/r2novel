/**
 * r2novel — OPDS 目录 / 整本流式导出
 *
 * 由 src/router.js 拆分而来（#149 P2）。这里只放这一件事的实现；
 * 路由/参数校验留在 src/router.js，跨模块约定见各函数注释。
 */

import { EXPORT_MAX_CHAPTERS } from '../../public/js/shared-const.js';
import { verifyCookie } from '../core/auth.js';
import { safeEqual, json, enc, getWithEtag, tryParseJson, escXml } from '../core/base.js';
import { bruteCheck, bruteFail, bruteClear } from '../core/brute.js';
import { KEY, KEY_IDX } from '../core/const.js';
import { readBook } from '../store/book.js';
import { openIndex } from '../store/open.js';
import { looksRoot, readIndex } from '../store/shard.js';

async function opdsAuth(req, env, store) {
  if (await verifyCookie(req, env)) return { ok: true };
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get('authorization') || '');
  if (m) {
    const st = await bruteCheck(req, env, store);
    if (st.locked) return { ok: false, status: 429, retryAfterMs: st.retryAfterMs };
    let pair = '';
    try {
      const bin = atob(m[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      pair = new TextDecoder().decode(bytes); // UTF-8 还原（中文口令也正确）
    } catch {
      return { ok: false, status: 401 };
    }
    const pass = pair.slice(pair.indexOf(':') + 1); // 用户名任意（含空），只认冒号后的口令
    const admin = env.ADMIN_PASSWORD;
    if (!admin || !safeEqual(pass, admin)) {
      if (admin) await bruteFail(req, env, store);
      return { ok: false, status: 401 };
    }
    await bruteClear(req, store);
    return { ok: true };
  }
  return { ok: false, status: 401 };
}

const opds401 = () =>
  new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r2novel", charset="UTF-8"' } });

const opdsLocked = (retryAfterMs) =>
  json({ error: '尝试次数过多，请稍后再试' }, 429, { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) });

/** 把异步生成器产出的字节源（Uint8Array 或 ReadableStream）按序泵成一个 ReadableStream。
 *  惰性：一段读尽才拉下一段——整本导出不会一次性打开全部章节流（尊重 R2 单请求操作上限）。 */
function pumpParts(gen) {
  const it = gen[Symbol.asyncIterator]();
  let cur = null; // 当前章 ReadableStream
  let reader = null;

  async function nextPart(controller) {
    const { done, value } = await it.next();
    if (done) {
      controller.close();
      return;
    }
    if (value instanceof Uint8Array) {
      if (value.byteLength) controller.enqueue(value);
      return; // 等下次 pull 再取下一段
    }
    cur = value;
    reader = value.getReader();
    await pumpChapter(controller);
  }
  async function pumpChapter(controller) {
    const { done, value } = await reader.read();
    if (done) {
      reader = null;
      cur = null;
      await nextPart(controller); // 读尽本段 → 立即接下一段
      return;
    }
    controller.enqueue(value); // 背压：推一块就交还，下一块由 pull 再次驱动
  }
  return new ReadableStream({
    pull(controller) {
      return reader ? pumpChapter(controller) : nextPart(controller);
    },
    cancel() {
      if (reader) {
        try {
          reader.cancel('client-abort');
        } catch {
          /* ignore */
        }
        reader = null;
      }
      if (it.return) it.return().catch(() => {});
    },
  });
}

/** 整本 TXT 的字节源序列（书头 + 逐章标题块 + 章正文流 + 结尾） */
async function* exportParts(meta, store) {
  const title = meta.title || '未命名';
  const head = `${title}\n${meta.author ? '作者：' + meta.author + '\n' : ''}共 ${meta.chapters.length} 章 · ${meta.wordCount || 0} 字\n\n`;
  yield enc.encode(head);
  for (const c of meta.chapters) {
    yield enc.encode(`\n${c.title}\n\n`);
    const s = await store.openRead(KEY.text(meta.id, c.key));
    if (s) yield s;
  }
  yield enc.encode('\n');
}

/** GET /export/<id>.txt — 整本下载（流式拼章，Basic/Cookie 皆可）
 * 只放行已发布（status='ready'）的书：半成品/更新中的书可能缺正文或正在被覆盖，
 * 不应从阅读器下载通道泄露出去。 */
async function opdsExport(req, env, store, id) {
  const auth = await opdsAuth(req, env, store);
  if (!auth.ok) return auth.status === 429 ? opdsLocked(auth.retryAfterMs) : opds401();
  const meta = await readBook(store, id);
  if (!meta || meta.status !== 'ready' || !Array.isArray(meta.chapters) || !meta.chapters.length) {
    return json({ error: '书不存在或不可下载' }, 404);
  }
  // Free 计划单请求 ≤50 子请求：整本流式导出逐章开 R2 流（1 章 = 1 子请求），
  // 超出剩余预算会让流在中段报错 → 客户端拿到截断/失败文件。明确拒绝并指引网页端
  // 导出（exportBookTxt 收到非 200 会自动回退到逐章拉取，网页端不受影响）。
  if (meta.chapters.length > EXPORT_MAX_CHAPTERS) {
    return json({ error: `本书 ${meta.chapters.length} 章超过整本流式导出上限（${EXPORT_MAX_CHAPTERS} 章），请在网页中使用「导出」功能` }, 409);
  }
  return new Response(pumpParts(exportParts(meta, store)), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent((meta.title || 'book') + '.txt')}`,
    },
  });
}

/** GET /opds — OPDS 1.2 目录（?p=N 分页，每页 OPDS_PAGE 条；阅读器按 rel="next" 自动翻页）
 * 千本全量单 feed ≈300KB XML，第三方阅读器解析吃力 → 分页必备。feedUpdated 仍取全库最新时间。 */
const OPDS_PAGE = 100;

async function opdsCatalog(req, env, store) {
  const auth = await opdsAuth(req, env, store);
  if (!auth.ok) return auth.status === 429 ? opdsLocked(auth.retryAfterMs) : opds401();
  // ⚠️ 子请求预算（2026-10-06 审计 P2-5）：全量读索引 = 1 + K（K=分片数），而这条路径原先
  // **零预算核算**（注释只考虑了 XML 体积）→ 48 分片（≈2.4 万本）时 2 + 48 > 50 直接抛错，
  // 且 /opds 不在 handleApi 的 try 内 → 冒到 Worker 顶层，第三方阅读器订阅整体失效。
  // 超阈值直接回 409 + 可操作指引（先探 root，不额外读片）。
  const probe = await getWithEtag(store, KEY_IDX.root);
  const probed = tryParseJson(probe && probe.text);
  if (looksRoot(probed) && Number(probed.shards) > 40) {
    return json({ error: '书库过大，OPDS 目录已暂停订阅（分片数超限）。请改用网页端阅读。' }, 409);
  }
  const index = probe ? await openIndex(store, { rootRaw: probe.text, rootEtag: probe.etag }) : await readIndex(store);
  // #144 P3：两侧口径必须一致 —— 旧写法 b 侧 updatedAt 优先、a 侧却 createdAt 优先，
  // 「a 从未更新、b 更新过」这类组合会排出与时间无关的伪序。降序（新在前）。
  const books = (index.books || []).slice().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const page = Math.min(10000, Math.max(1, parseInt(new URL(req.url).searchParams.get('p'), 10) || 1));
  const slice = books.slice((page - 1) * OPDS_PAGE, page * OPDS_PAGE);
  const href = (n) => (n <= 1 ? '/opds' : `/opds?p=${n}`);
  const hasNext = page * OPDS_PAGE < books.length;
  // feed 级 updated 用内容的最新时间（而非当前时间）：固定值让阅读器按条件请求判断
  // 「feed 没变化」，避免每次拉取都被误判有更新而反复全量重拉
  // 用 reduce 而非 Math.max(...spread)：超大库（十万级）spread 会抛 RangeError（调用栈溢出）
  const feedUpdated = books.length
    ? books.reduce((mx, b) => Math.max(mx, b.updatedAt || b.createdAt || 0), 0)
    : Date.now();
  const entry = (b) => {
    const ts = b.updatedAt || b.createdAt || Date.now();
    const author = b.author ? `      <author><name>${escXml(b.author)}</name></author>\n` : '';
    const cats = (b.tags || []).map((t) => `      <category term="${escXml(t)}" label="${escXml(t)}"/>\n`).join('');
    return `    <entry>
      <title>${escXml(b.title || '未命名')}</title>
      <id>urn:r2novel:book:${escXml(b.id)}</id>
      <updated>${new Date(ts).toISOString()}</updated>
${author}${cats}      <summary>${b.chapterCount || 0} 章 · ${b.wordCount || 0} 字</summary>
      <link rel="http://opds-spec.org/acquisition" href="/export/${encodeURIComponent(b.id)}.txt" type="text/plain" title="下载整本 TXT"/>
    </entry>`;
  };
  const nav = [
    `  <link rel="self" href="${href(page)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    `  <link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`,
    hasNext ? `  <link rel="next" href="${href(page + 1)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>` : '',
    page > 1 ? `  <link rel="previous" href="${href(page - 1)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>` : '',
  ].filter(Boolean).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:r2novel:opds:p${page}</id>
  <title>私人书屋${page > 1 ? `（第 ${page} 页）` : ''}</title>
  <updated>${new Date(feedUpdated).toISOString()}</updated>
  <author><name>私人书屋</name></author>
${nav}
${slice.map(entry).join('\n')}
</feed>
`;
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/atom+xml; profile=opds-catalog; kind=acquisition; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}


/* 供其他模块 / router.js 使用（集中导出，避免改动声明行） */
export { opdsExport, opdsCatalog };
