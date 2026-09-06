/* sw.js — r2novel Service Worker（PWA 离线支持）
 *
 * 策略：
 *   - 静态壳（/、CSS/JS/manifest/icons）：stale-while-revalidate（先返回缓存，后台刷新）
 *   - /api/*、/opds、/export/* 一律网络直走，不缓存（鉴权 + 强动态，响应均 no-store）
 *   - 跨域请求直接 pass-through
 *   - 章节正文 / 整本书目不在 SW 缓存，由前端 IndexedDB（offline.js）按需存
 *
 * 离线能用的真正保障来自离线整本下载（IndexedDB），SW 只是「静态壳可缓存」。
 */
const CACHE = 'r2novel-shell-v5';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/main.js',
  '/js/app.js',
  '/js/store.js',
  '/js/reader.js',
  '/js/cleaner.js',
  '/js/offline.js',
  '/js/ui.js',
  '/js/exporter.js',
  '/js/shared-const.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 动态/鉴权内容一律网络直走，绝不缓存（API、OPDS feed、整本导出——响应均 no-store）
  if (url.pathname.startsWith('/api/') || url.pathname === '/opds' || url.pathname.startsWith('/export/')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }
  // 静态：stale-while-revalidate
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        // 离线且从未缓存过 → 兜底 503，避免 respondWith 解析出 undefined 抛错
        .catch(() => cached || new Response('', { status: 503 }));
      return cached || network;
    })
  );
});