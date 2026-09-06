/* store.js — r2novel API 客户端（登录 + 书架/章节/进度） */
const j = (r) => r.json().catch(() => ({}));

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
  async putRaw(id, bytes) {
    return request(`/api/books/${encodeURIComponent(id)}/raw`, { method: 'PUT', body: bytes });
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
};

/* 本地镜像：进度 / 最近打开 / 阅读偏好（离线与杀后台兜底） */
const LS = {
  prog: (id) => 'rn_prog_' + id,
  last: 'rn_last_book',
  pref: 'rn_read_pref',
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
  getLast() {
    try {
      return JSON.parse(localStorage.getItem(LS.last)) || null;
    } catch {
      return null;
    }
  },
  setLast(v) {
    try {
      localStorage.setItem(LS.last, JSON.stringify(v));
    } catch {
      /* ignore */
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
