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
    return request('/api/logout', { method: 'POST' }).catch(() => ({ ok: true }));
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
  async putChapter(id, key, text) {
    const r = await request(`/api/books/${encodeURIComponent(id)}/chapters/${encodeURIComponent(key)}`, { method: 'PUT', body: text });
    return r;
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
  putProgress(id, data) {
    return request('/api/progress/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  },
  // 残留诊断（书架「检查残留」）
  diagOrphans: () => request('/api/diag/orphans'),
  purgeOrphans(keys) {
    return request('/api/diag/orphans', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objects: keys }) });
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
      localStorage.setItem(LS.shelf, JSON.stringify({ books, at: Date.now() }));
    } catch {
      /* 容量满则忽略（快照只是提速，非关键数据） */
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
};

export function fmtWords(n) {
  if (!n) return '0 字';
  return n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万字' : n + ' 字';
}

/**
 * 并发拉取一本书全部章节正文（导出/整本离线共用）。
 * 返回 { meta, texts }；texts[i] 与 meta.chapters[i] 对应。
 */
export async function fetchChaptersAll(id, onProg) {
  const meta = await api.bookMeta(id);
  const chapters = meta.chapters || [];
  const n = chapters.length;
  if (!n) throw new Error('这本书还没有章节');
  const texts = new Array(n);
  const CONC = 8;
  let cursor = 0;
  let done = 0;
  let missing = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, n) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= n) break;
        try {
          texts[idx] = await api.chapter(id, chapters[idx].key, meta.cleanVer || 1);
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) throw e;
          texts[idx] = ''; // 单章失败不阻断整本
          missing++;
        }
        done++;
        if (onProg && (done % 12 === 0 || done === n)) onProg(done / n);
      }
    })
  );
  return { meta, texts, missing };
}
