/* offline.js — PWA 离线支撑（IndexedDB，零依赖）
 *
 * 存储：
 *   chapters  : keyPath [bookId, chKey] → {bookId,chKey,text,at}  整本离线后可离线读
 *   books     : keyPath bookId          → 书目快照（章表）
 *   progQueue : keyPath at              → 离线期间进度，回网上送（last-write-wins）
 */
const DB = 'r2novel';
const VER = 1;

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chapters')) {
        const s = db.createObjectStore('chapters', { keyPath: ['bookId', 'chKey'] });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('progQueue')) db.createObjectStore('progQueue', { keyPath: 'at' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const reqP = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function inTx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const os = t.objectStore(storeName);
    let ret;
    try {
      ret = fn(os, reqP);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(ret);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const offline = {
  async saveBook(meta) {
    await inTx('books', 'readwrite', (os) => {
      os.put({ bookId: meta.id, title: meta.title, cleanVer: meta.cleanVer || 1, wordCount: meta.wordCount || 0, chapterCount: meta.chapters.length, chapters: meta.chapters.map((c) => ({ key: c.key, title: c.title })), at: Date.now() });
    });
  },
  async getBook(bookId) {
    return inTx('books', 'readonly', (os, p) => p(os.get(bookId)));
  },
  async putChapter(bookId, chKey, text) {
    await inTx('chapters', 'readwrite', (os) => {
      os.put({ bookId, chKey, text, at: Date.now() });
    });
  },
  async putChapters(bookId, list) {
    await inTx('chapters', 'readwrite', (os) => {
      for (const it of list) os.put({ bookId, chKey: it.key, text: it.text, at: Date.now() });
    });
  },
  async getChapter(bookId, chKey) {
    const r = await inTx('chapters', 'readonly', (os, p) => p(os.get([bookId, chKey])));
    return r ? r.text : null;
  },
  async listBookKeys(bookId) {
    return inTx('chapters', 'readonly', (os, p) => {
      const idx = os.index('bookId');
      return p(idx.getAllKeys(IDBKeyRange.only(bookId)));
    });
  },
  async delBook(bookId) {
    const keys = (await this.listBookKeys(bookId)) || [];
    await inTx('chapters', 'readwrite', (os) => {
      for (const k of keys) os.delete(k);
    });
    await inTx('books', 'readwrite', (os) => {
      os.delete(bookId);
    });
  },
  /** 缓存某章（若该书已被离线化） */
  async cacheChapterIfDownloaded(bookId, chKey, text) {
    const b = await this.getBook(bookId);
    if (!b) return false;
    await this.putChapter(bookId, chKey, text);
    return true;
  },
  async queueProgress(bookId, p) {
    await inTx('progQueue', 'readwrite', async (os, p2) => {
      const all = (await p2(os.getAll())) || [];
      for (const r of all) if (r.bookId === bookId) os.delete(r.at);
      os.put({ bookId, ch: p.ch, ratio: p.ratio, updatedAt: p.updatedAt, at: Date.now() });
    });
  },
  /** 回网上送离线进度；send(bookId,{ch,ratio}) 抛错则保留 */
  async drainProgress(send) {
    const rows = (await inTx('progQueue', 'readonly', (os, p) => p(os.getAll()))) || [];
    let ok = 0;
    for (const r of rows) {
      try {
        await send(r.bookId, { ch: r.ch, ratio: r.ratio });
        await inTx('progQueue', 'readwrite', (os) => os.delete(r.at));
        ok++;
      } catch {
        /* 下次再试 */
      }
    }
    return ok;
  },
};

/** 联网恢复时自动上送离线进度（幂等，可多次调用） */
export function bindOnlineFlush(send) {
  if (typeof window === 'undefined') return;
  const flush = () => {
    if (navigator.onLine !== false) offline.drainProgress(send).catch(() => {});
  };
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush();
  });
}
