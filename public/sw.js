/* sw.js — r2novel Service Worker（PWA 离线支持）
 *
 * 策略：
 *   - 静态壳（/、CSS/JS/manifest/icons，含 SHELL 与 LAZY 两部分）：stale-while-revalidate
 *     —— LAZY 里的模块第一次被 fetch 时同样走这条链路，所以"用过一次就能离线"
 *   - /api/*、/opds、/export/* 一律网络直走，不缓存（鉴权 + 强动态，响应均 no-store）
 *   - 跨域请求直接 pass-through
 *   - 章节正文 / 整本书目不在 SW 缓存，由前端 IndexedDB（offline.js）按需存
 *
 * 离线能用的真正保障来自离线整本下载（IndexedDB），SW 只是「静态壳可缓存」。
 */
const CACHE = 'r2novel-shell-v15';
/* 离线壳 = 首屏真正会用到的那批（#149 代码分割后从 29 项收缩到 17 项）。
 * 判据不是"文件存在就预缓存"，而是"打开首页会不会用到"—— 预缓存用不到的模块，
 * 等于让首访为"也许永远不会点"的功能付流量。 */
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/main.js',
  '/js/app.js',
  '/js/dom.js',
  '/js/store.js',
  '/js/offline.js',
  '/js/ui.js',
  '/js/exporter.js',
  '/js/shared-const.js',
  '/js/shared-text.js', // dom.js 静态 re-export normTitle → 首屏依赖
  '/js/batch-queue.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

/* 按需加载的模块（#149 代码分割）：首屏不下载，第一次用到时由下面的 fetch handler
 * 走 stale-while-revalidate 自动入缓存 —— 之后断网照常可用，离线能力不受影响。
 * 唯一的前置条件是"装完从没打开过任何书就断网"，而那种状态下本来也没有离线书可读
 * （下载整本的入口都在阅读器内部，必然先加载过 reader.js）。
 *
 * check.mjs ⑤ 对这份清单是硬约束：
 *   SHELL ∪ LAZY 必须覆盖 public/ 全部静态资源 · SHELL ∩ LAZY = ∅ ·
 *   LAZY 里的模块不得出现在静态 import 图里（否则它其实是首屏依赖，标成懒加载只是骗门禁）。 */
const LAZY = [
  '/js/reader.js',
  '/js/cleaner.js',
  '/js/upload/index.js',
  '/js/upload/files.js',
  '/js/upload/preview.js',
  '/js/upload/prepare.js',
  '/js/upload/upload.js',
  '/js/upload/editor.js',
  '/js/upload/session.js',
  '/js/upload/rewash.js',
  '/js/upload/payload.js',
  '/js/upload/ctx.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // 逐资源容错缓存：addAll 是"一损俱损"——慢网络/代理下单个资源失败会毁掉整个缓存，
    // 之后每个静态资源都回落网络 → 打开明显变慢。改为单个 add，失败只影响该资源。
    // 分类处理：js/css/HTML/manifest 部署后必须拿到最新 → cache:'no-cache' 强制回源校验 ETag；
    // icons 几乎不变且 HTTP 层有 7 天缓存 → 走默认缓存（命中即用，不重复下载），
    // 部署后 install 的重下量从 14 降到 11，首开负担更小。
    //
    // ⚠️ 这里原先是 'reload'（语义是"跳过一切缓存、强制完整重下"）。代价很实在：首访时页面
    // 刚通过 modulepreload 与 import 图把 20 多个模块下过一遍，install 又把同一批 body 完整
    // 重下一遍 —— 实测 25 个重复请求、约 135 KB br 的纯浪费（见 .ui-tests/measure-firstload.mjs）。
    // 'no-cache' 只要求"必须回源校验"：内容没变时服务端回 304（线上 /js/app.js 带
    // If-None-Match 实测 304、传输 0 字节），部署后"拿最新"的保证一点没丢 —— ETag 变了自然
    // 拿到 200 与新 body。两者唯一的差别只是不再重复搬运未变的 body。
    caches
      .open(CACHE)
      .then((c) =>
        Promise.allSettled(
          SHELL.map((u) =>
            c.add(new Request(u, u.endsWith('.png') ? undefined : { cache: 'no-cache' }))
          )
        )
      )
      .then(() => self.skipWaiting())
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
  // only-if-cached 只允许 same-origin：其它组合交给浏览器默认处理，
  // 否则下面的 fetch 会抛 TypeError（被 catch 吞成 503，掩盖真实原因）
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  // 动态/鉴权内容一律网络直走，绝不缓存（API、OPDS feed、整本导出——响应均 no-store）
  // #145 P2-6：/opds 与 /opds/ 两种形态都要放过。服务端正则 /^\/opds\/?$/ 两种都服务、
  // wrangler 的 run_worker_first 也同时列了两种；订阅地址常带尾斜杠。漏放 /opds/ → 已鉴权的
  // 目录（含全部书名/章数/字数的 atom+xml）落入下面的 stale-while-revalidate，cache.put
  // 不理会 no-store → 登出后乃至离线再访问仍从 SW 缓存返回完整目录，直到下次部署换版本。
  if (url.pathname.startsWith('/api/') || url.pathname === '/opds' || url.pathname === '/opds/' || url.pathname.startsWith('/export/')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }
  // 静态：stale-while-revalidate
  //
  // 后台刷新的 Promise 必须挂进 event.waitUntil：命中缓存时我们立刻 return cached，
  // respondWith 随之结束、事件生命周期结束，浏览器可以马上终止这个 SW —— 游离的
  // 后台 fetch / cache.put 会被直接丢弃。原先只把它挂在 respondWith 链上，等于把
  // 「部署后首个导航就拿到新 JS」做成了时灵时不灵（命中缓存时 cache.put 常常没落盘，
  // 用户继续跑旧代码，且一直开着的 tab 永远不会重载 app.js）。
  const cacheP = caches.open(CACHE);
  // put 必须单独成链并交给 waitUntil 等待：只在 fetch 的 then 里顺手起 Promise 是不够的——
  // 那个 put 链仍是游离的，命中缓存时 respondWith 立即由缓存返回、事件随 fetch 结束而终止，
  // 游离的 cache.put 会被浏览器丢弃（v13 的修复不彻底，真因就在这里）。
  // 结构：respondWith 只等 fetch（命中缓存零延迟）；waitUntil = fetch 之后再加等 put 落盘。
  let putP = null;
  const networkP = fetch(req, { cache: 'no-cache' }).then((res) => {
    // cache:'no-cache' = 每次强制条件校验（ETag/304），绕开浏览器 HTTP 缓存的
    // max-age 窗口（5 分钟），否则部署后首个导航仍可能拿到旧 JS/CSS
    if (res && res.status === 200) {
      // clone 必须在返回前做（响应体只能 clone 一次）：一份给 put，一份继续往外走
      putP = cacheP.then((c) => c.put(req, res.clone())).catch(() => {});
    }
    return res;
  });
  event.waitUntil(networkP.then(() => putP, () => {}));
  event.respondWith(
    cacheP.then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      // 未缓存过（首次访问/缓存被清理）→ 沿用同一个在途请求；离线时兜底 503，
      // 避免 respondWith 解析出 undefined 抛错
      try {
        return await networkP;
      } catch {
        return new Response('', { status: 503 });
      }
    })
  );
});