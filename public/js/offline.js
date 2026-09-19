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
/** 打开（并缓存）连接。
 *  ⚠️ 失败的 promise **不能留在缓存里**：原实现 reject 后 dbPromise 仍是那个 rejected promise，
 *  之后每次 openDB() 都直接返回它 → 隐私模式 / 配额耗尽触发一次失败，整个会话的离线能力
 *  （读缓存、入队回放）就全废了，刷新页面之前无法自愈。失败时清掉缓存，让下次调用重新尝试。 */
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
  }).catch((e) => {
    dbPromise = null; // 交回「未打开」状态：瞬时失败（配额回收、隐私模式切换）下次调用可恢复
    throw e; // 本次调用仍如实失败，调用方的降级路径不变
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
  /** 入队一条离线进度（同一本书只保留最新一条，last-write-wins）
   * 拆成「只读取旧 → 只写新」两个事务：IDB 事务在 await 让出后会被浏览器自动提交，
   * 在同一事务内跨 await 再 put/delete 会抛 TransactionInactiveError（离线进度丢失）。 */
  async queueProgress(bookId, p, cleanVer) {
    const rows = (await inTx('progQueue', 'readonly', (os, rp) => rp(os.getAll()))) || [];
    const drop = [];
    let at = Date.now();
    for (const r of rows) {
      if (r.bookId === bookId) drop.push(r.at);
      if (r.at >= at) at = r.at + 1; // keyPath=at 必须唯一：同毫秒入队会互相覆盖
    }
    // cleanVer 是入队那一刻该书的内容版本（L17）：离线期间书被编辑/重洗过 → 回网时章号已失去
    // 意义，服务端凭它丢弃这条陈旧进度（否则会用旧章号覆盖掉编辑后的进度，表现为"进度±1"）。
    const rec = { bookId, ch: p.ch, ratio: p.ratio, updatedAt: p.updatedAt, cleanVer, at };
    await inTx('progQueue', 'readwrite', (os) => {
      for (const k of drop) os.delete(k);
      os.put(rec);
    });
  },
  /** 清空全部离线数据（登出）：正文缓存 + 书目快照 + 待上送队列。
   *  共享设备上退出了还能断网读已下载正文，是真实的隐私缺口。 */
  async clearAll() {
    await inTx('chapters', 'readwrite', (os) => os.clear());
    await inTx('books', 'readwrite', (os) => os.clear());
    await inTx('progQueue', 'readwrite', (os) => os.clear());
  },
  /** 回网上送离线进度；send(bookId,{ch,ratio,updatedAt,cleanVer}) 抛错则保留 */
  async drainProgress(send) {
    const rows = (await inTx('progQueue', 'readonly', (os, p) => p(os.getAll()))) || [];
    let ok = 0;
    for (const r of rows) {
      try {
        // 把原写入时间与内容版本一并上送（L6/L17）：服务端据此丢弃"比盘上更旧"的迟到进度，
        // 以及"书已被编辑过"的失效章号——离线队列的回放不再能回退进度。
        await send(r.bookId, { ch: r.ch, ratio: r.ratio, updatedAt: r.updatedAt, cleanVer: r.cleanVer });
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
