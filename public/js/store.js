/* store.js — r2novel API 客户端（登录 + 书架/章节/进度） */
const j = (r) => r.json().catch(() => ({}));

/** 大请求体 gzip 压缩（慢链路上行提速 3~4 倍）：
 * body 统一先归一成字节再比较收益——字符串的 length 是「字符数」不是「字节数」，
 * 中文 1 字 = UTF-8 3 字节，若用字符数比较会把中文文本误判成「压缩无收益」而不压缩。
 * body ≥64KB 且浏览器支持 CompressionStream 才压（老 WebView 自动降级原样发）；
 * gzip 后不小于原文也不白包一层。返回 { body, gzip }——gzip=false 时 body 保持原样
 * （putRaw 的输入本就是 Uint8Array，不能靠类型判断是否压缩过）。服务端按 x-content-gzip 标记头
 * 识别解压；用自定义头而非标准 Content-Encoding——避免 Cloudflare 边缘对标准头的不可控行为。 */
const GZIP_MIN = 64 * 1024;
export async function maybeGzip(body) {
  const plain = { body, gzip: false };
  if (typeof CompressionStream === 'undefined') return plain;
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  if (bytes.length < GZIP_MIN) return plain;
  try {
    const stream = new Response(bytes).body.pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    return buf.length < bytes.length ? { body: buf, gzip: true } : plain;
  } catch {
    return plain; // 压缩失败不阻断上传，降级明文
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message || ('HTTP ' + status));
    this.status = status;
  }
}

async function request(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401 && !path.startsWith('/api/login')) throw new ApiError(401, 'unauthorized');
  const data = await j(res);
  if (!res.ok) throw new ApiError(res.status, data.error || ('HTTP ' + res.status));
  return data;
}

export const api = {
  async login(password) {
    return request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  },
  async logout() {
    // 不吞错：清 cookie 的唯一途径就是这次请求成功（Set-Cookie 由服务端下发、且是 HttpOnly，
    // 前端无法自行清除）。原来吞成 {ok:true} 会让 UI 显示「已登出」而会话仍然有效——
    // 刷新页面即带旧 cookie 回到书架，共享设备上是真实风险。
    return request('/api/logout', { method: 'POST' });
  },
  books: () => request('/api/books'),
  bookMeta: (id) => request('/api/books/' + encodeURIComponent(id)),
  chapter(id, key, cleanVer) {
    return fetch(`/api/books/${encodeURIComponent(id)}/chapters/${encodeURIComponent(key)}?v=${cleanVer}`, { credentials: 'same-origin' }).then((r) => {
      if (r.status === 401) throw new ApiError(401, 'unauthorized');
      if (!r.ok) throw new ApiError(r.status, 'HTTP ' + r.status);
      return r.text();
    });
  },
  createBook(payload) {
    return request('/api/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  },
  async putChapters(id, chapters) {
    // 批量上传（≤服务端单批上限）：连续上传时 meta 校验从每章一次收敛到每批一次
    const { body, gzip } = await maybeGzip(JSON.stringify({ chapters }));
    return request(`/api/books/${encodeURIComponent(id)}/chapters/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(gzip ? { 'x-content-gzip': '1' } : {}) },
      body,
    });
  },
  async putRaw(id, bytes) {
    const { body, gzip } = await maybeGzip(bytes);
    return request(`/api/books/${encodeURIComponent(id)}/raw`, {
      method: 'PUT',
      headers: gzip ? { 'x-content-gzip': '1' } : {},
      body,
    });
  },
  publish: (id) => request(`/api/books/${encodeURIComponent(id)}/publish`, { method: 'POST' }),
  // M2：书库管理
  patchBook(id, patch) {
    return request(`/api/books/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  },
  updateChapters(id, payload) {
    return request(`/api/books/${encodeURIComponent(id)}/chapters`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  },
  // v1.1：已发布书章节就地编辑
  patchChapter(id, key, patch) {
    return request(`/api/books/${encodeURIComponent(id)}/chapters/${encodeURIComponent(key)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  },
  insertChapter(id, payload) {
    return request(`/api/books/${encodeURIComponent(id)}/chapters/insert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  },
  deleteChapter(id, key) {
    return request(`/api/books/${encodeURIComponent(id)}/chapters/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },
  deleteBook: (id) => request(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  trash: () => request('/api/trash'),
  restore: (id) => request(`/api/books/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  purgeTrash: (id) => request(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearTrash: () => request('/api/trash?action=clear', { method: 'POST' }),
  async rawBytes(id) {
    const res = await fetch(`/api/books/${encodeURIComponent(id)}/raw`, { credentials: 'same-origin' });
    if (res.status === 401) throw new ApiError(401, 'unauthorized');
    if (!res.ok) throw new ApiError(res.status, 'HTTP ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  },
  getProgress: (id) => request('/api/progress/' + encodeURIComponent(id)).catch(() => ({ ch: 0, ratio: 0, updatedAt: 0 })),
  /** 严格版（不吞错）：需要区分「服务端就是没有进度」与「这次读失败」时必须用它。
   *  阅读器的 OCC 基线只能来自「真的读到了」——把读失败当成「服务端没有进度」（updatedAt 0），
   *  会让这台设备的首次写入被服务端判成「拿旧认知来写」而永久拒掉（见 router.js 的 apiProgressPut）。 */
  getProgressStrict: (id) => request('/api/progress/' + encodeURIComponent(id)),
  putProgress(id, data) {
    return request('/api/progress/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  },
  // 残留诊断（书架「检查残留」）
  // 大库 text/ 超单请求预算 → 服务端回传 textCursor，前端循环带上续扫直到 null
  diagOrphans(textCursor) {
    return request('/api/diag/orphans' + (textCursor ? `?textCursor=${encodeURIComponent(textCursor)}` : ''));
  },
  purgeOrphans(keys) {
    return request('/api/diag/orphans', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objects: keys }) });
  },
  /** 残留清理（L15）：服务端按子请求预算分批，装不下的原样回传 deferred。
   *  原实现把 deferred 与「确认拒删」（skipped）混在一个计数里，前端只能一律说成"被跳过"，
   *  于是被裁掉的残留永远删不完。这里循环消费 deferred 直到清空（maxRounds 防死循环）。
   *  ⚠️ skipped 必须**逐轮累加**：每轮传入的是上一轮的 deferred（互不相交），相加即真值；
   *  写成 `=` 会被后面几轮的 0 覆盖，把"仍在引用中"的真实数量抹掉。
   *  返回 { done 已删, skipped 确认拒删, pending 仍未处理完（轮次用尽，可再点一次） }。 */
  async purgeOrphansAll(keys, maxRounds = 60) {
    let done = 0;
    let skipped = 0;
    let pending = Array.isArray(keys) ? keys : [];
    for (let g = 0; g < maxRounds && pending.length; g++) {
      const r = await this.purgeOrphans(pending);
      done += (r && r.deleted) || 0;
      skipped += (r && r.skipped) || 0;
      pending = r && Array.isArray(r.deferred) ? r.deferred : [];
    }
    return { done, skipped, pending };
  },
  // 书架批量操作（多选治理）：addTags / removeTags / setTags / setFinished / delete
  batchBooks(ids, action, payload = {}) {
    return request('/api/books/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, action, ...payload }),
    });
  },
  // 标签治理：全量清单（不截断）+ 合并/改名/删除（to 为空即删除）
  tags: () => request('/api/tags'),
  tagsMerge(from, to) {
    return request('/api/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) });
  },
};

/* 本地镜像：进度 / 阅读偏好 / 书架与预设标签快照（离线与打开提速兜底） */
const LS = {
  prog: (id) => 'rn_prog_' + id,
  pref: 'rn_read_pref',
  shelf: 'rn_shelf_cache',
  presetTags: 'rn_preset_tags',
};
// localStorage 一般 5MB/源（部分浏览器按 UTF-16 计只给 ~2.5M 字符）。书架快照超此上限即跳过写入，
// 并提示一次——旧实现直接 setItem，超限抛 QuotaExceededError 被 catch 静默吞掉，
// 大库「秒开快照」会无声失效（看起来有快照其实没有）。
const SHELF_CACHE_MAX_CHARS = 1000000;
let shelfCacheWarned = false;
export const local = {
  getProg(id) {
    try {
      return JSON.parse(localStorage.getItem(LS.prog(id))) || null;
    } catch {
      return null;
    }
  },
  setProg(id, p) {
    try {
      localStorage.setItem(LS.prog(id), JSON.stringify(p));
    } catch {
      /* 存不下忽略 */
    }
  },
  getPref() {
    try {
      return JSON.parse(localStorage.getItem(LS.pref)) || {};
    } catch {
      return {};
    }
  },
  setPref(p) {
    try {
      localStorage.setItem(LS.pref, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  },
  /** 书架快照（打开提速：先渲染上次的书架，网络刷新后覆盖；仅本地本人数据） */
  getShelfCache() {
    try {
      const s = JSON.parse(localStorage.getItem(LS.shelf));
      return s && Array.isArray(s.books) ? s : null;
    } catch {
      return null;
    }
  },
  setShelfCache(books) {
    try {
      const payload = JSON.stringify({ books, at: Date.now() });
      if (payload.length > SHELF_CACHE_MAX_CHARS) {
        // 超限必须把**旧快照删掉**再返回：只「跳过写入」的话，localStorage 里那份远古快照会一直
        // 留着，网络失败时（boot / loadShelf 的快照兜底路径）会长期显示过期书架且永不更新。
        // 宁可不给快照（如实走网络），也不要给一份错的。
        try {
          localStorage.removeItem(LS.shelf);
        } catch {
          /* 清不掉也不影响下面仍走网络 */
        }
        if (!shelfCacheWarned) {
          shelfCacheWarned = true;
          console.warn(`书架快照过大（${payload.length} 字符 > ${SHELF_CACHE_MAX_CHARS}），已清除旧快照并跳过本地缓存，本次及后续将走网络加载`);
        }
        return false;
      }
      localStorage.setItem(LS.shelf, payload);
      return true;
    } catch {
      /* 容量满 / 隐私模式禁用存储：快照只是提速，非关键数据 */
      return false;
    }
  },
  /** 预设标签快照（上传页 chips：库里实际标签 top N，云端刷新后覆盖） */
  getPresetTags() {
    try {
      const s = JSON.parse(localStorage.getItem(LS.presetTags));
      return Array.isArray(s) ? s : [];
    } catch {
      return [];
    }
  },
  setPresetTags(tags) {
    try {
      localStorage.setItem(LS.presetTags, JSON.stringify(tags));
    } catch {
      /* 容量满则忽略 */
    }
  },
  /** 登出清理（L18）：书架快照 / 预设标签 / 各书进度镜像都是私人数据，共享设备上不留痕迹。
   *  注意作用域——只清本地镜像，云端真值（进度、meta、正文）照旧，重新登录即拉回。 */
  clearAll() {
    try {
      localStorage.removeItem(LS.pref);
      localStorage.removeItem(LS.shelf);
      localStorage.removeItem(LS.presetTags);
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('rn_prog_')) drop.push(k);
      }
      for (const k of drop) localStorage.removeItem(k);
    } catch {
      /* 隐私模式禁用存储：本就无数据可清 */
    }
  },
};

export function fmtWords(n) {
  if (!n) return '0 字';
  return n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万字' : n + ' 字';
}

/**
 * 并发拉取一本书全部章节正文（导出/整本离线共用）。
 * 返回 { meta, texts, missing }；texts[i] 与 meta.chapters[i] 对应。
 *
 * offlineSrc（可选）：{ book: () => Promise<meta|null>, chapter: (key) => Promise<string|null> }。
 * 为什么由调用方注入、而不是这里直接 import offline.js：① 本函数要能在 node 单测里直接 import，
 * 不该顺带牵出 IndexedDB/DOM；② store.js 是 offline.js 的上游，反向引用会形成模块环。
 * 传了它，「服务端不可用时用本地整本缓存兜底」才是真的——exporter.js 顶部那句「IndexedDB
 * 缓存离线可用」此前是**虚假承诺**：离线时首句 api.bookMeta 必抛，已下载的正文一次都没被读过。
 */
export async function fetchChaptersAll(id, onProg, offlineSrc) {
  const offBook = offlineSrc ? () => offlineSrc.book().catch(() => null) : null;
  const offChapter = offlineSrc ? (key) => offlineSrc.chapter(key).catch(() => null) : null;
  let meta;
  try {
    meta = await api.bookMeta(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    // 服务端不可用（离线 / 未发布 404）→ 本地整本缓存的章表兜底
    //（offline.getBook 的记录只带 bookId，补 id 供后续取章）
    const off = offBook ? await offBook() : null;
    if (!off) throw e;
    meta = { ...off, id };
  }
  const chapters = meta.chapters || [];
  const n = chapters.length;
  if (!n) throw new Error('这本书还没有章节');
  const texts = new Array(n);
  const CONC = 8;
  let cursor = 0;
  let done = 0;
  let missing = 0;
  // 链路不通（fetch 直接 reject）时不再逐章空发请求——离线导出千章书会先发一千个注定失败的请求。
  // 但「一次失败＝链路已断」是**过强**的判据：单次 reject（切网瞬间、边缘抖动、请求被取消）不足以
  // 证明整条链路断了，一票否决会把一次瞬时抖动放大成「整本剩余章节全部判缺失」（实测 20 章只让
  // 第 1 次失败 → 13 章被判缺失，请求数从 20 掉到 8）。所以：
  //   · 连续 NET_DOWN_AFTER 次非 ApiError 失败才判定断链（成功一次即清零；ApiError 说明服务端
  //     有响应、链路是通的，同样清零）；
  //   · 判定后也不是永久放弃：每 NET_PROBE_EVERY 章放一次**真实探测请求**，成功即恢复网络路径。
  const NET_DOWN_AFTER = 4;
  const NET_PROBE_EVERY = 12;
  let netFails = 0; // 连续的非 ApiError 失败数
  let netDown = false; // 已判定断链：暂停逐章请求，只留周期探测
  let probes = 0; // 断链后的探测计数
  await Promise.all(
    Array.from({ length: Math.min(CONC, n) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= n) break;
        const key = chapters[idx].key;
        // 断链后每 NET_PROBE_EVERY 章放一次真实请求：网络恢复了就及时回到网络路径，
        // 而不是拿本地缓存拼完剩下的几百章。（++probes 而非 probes++：置位后紧接着的那一章
        // 不探测，否则等于判据没生效。）
        const probe = netDown && ++probes % NET_PROBE_EVERY === 0;
        try {
          if (netDown && !probe) throw new Error('offline');
          texts[idx] = await api.chapter(id, key, meta.cleanVer || 1);
          netFails = 0;
          netDown = false; // 探测成功（或本就在网络路径）→ 链路可用，回到逐章请求
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) throw e;
          if (e instanceof ApiError) netFails = 0; // 服务端有业务响应 → 链路是通的
          else if (++netFails >= NET_DOWN_AFTER) netDown = true;
          // 单章失败 → 先看本地整本缓存里有没有这一章（离线导出的关键一步）
          const off = offChapter ? await offChapter(key) : null;
          if (off != null) {
            texts[idx] = off;
          } else {
            texts[idx] = ''; // 单章失败不阻断整本
            missing++;
          }
        }
        done++;
        if (onProg && (done % 12 === 0 || done === n)) onProg(done / n);
      }
    })
  );
  return { meta, texts, missing };
}
