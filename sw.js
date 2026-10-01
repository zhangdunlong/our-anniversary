/* ==========================================================================
   sw.js —— Service Worker 离线缓存
   --------------------------------------------------------------------------
   策略（刻意做了区分，避免常见坑）：
     · 导航请求（HTML）→ 网络优先，失败回落到缓存。
        这样部署新版后用户刷新立刻拿到新内容，断网时也能打开。
     · 静态资源（CSS / JS / 音频 / 图标）→ 缓存优先 + 后台更新。
        首屏零请求、秒开；同时后台静默拉新，下次访问即最新。
     · 只处理同源 GET 请求，不碰任何跨域 / 非 GET 请求。

   缓存版本号：改动静态资源后把 VERSION 加一，即可强制全量更新。
   ========================================================================== */

const VERSION = 'v1.0.0';
const CACHE_NAME = 'love-' + VERSION;

// 预缓存清单：首屏必需的最小集合
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles/tokens.css',
  './src/styles/base.css',
  './src/styles/layout.css',
  './src/styles/components.css',
  './src/config/site.config.js',
  './src/main.js',
  './src/core/dom.js',
  './src/core/store.js',
  './src/core/bus.js',
  './src/core/time.js',
  './src/core/raf.js',
  './src/core/reveal.js',
  './src/modules/theme.js',
  './src/modules/starfield.js',
  './src/modules/hearts.js',
  './src/modules/counter.js',
  './src/modules/letter.js',
  './src/modules/gallery.js',
  './src/modules/music.js',
  './src/modules/anniversaries.js',
  './src/modules/timeline.js',
  './src/modules/daily-quote.js',
  './src/modules/milestone.js',
  './src/modules/share-poster.js',
  './src/modules/confetti.js',
  './src/modules/easter-egg.js',
  './src/modules/visit-stats.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

/* ---------------------------------------------------------------- 安装 */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // 逐个 add，单个失败不影响整体（例如音频文件较大或临时 404）
      return Promise.all(
        PRECACHE.map(function (url) {
          return cache.add(new Request(url, { cache: 'reload' }))
            .catch(function () { /* 忽略单个资源失败 */ });
        })
      );
    }).then(function () {
      return self.skipWaiting();   // 新 SW 立即接管，避免用户看到旧版本
    })
  );
});

/* ---------------------------------------------------------------- 激活 */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== CACHE_NAME && key.indexOf('love-') === 0) {
            return caches.delete(key);   // 清掉旧版本缓存
          }
          return null;
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ---------------------------------------------------------------- 请求拦截 */
self.addEventListener('fetch', function (event) {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 只接管同源

  // 音频走「仅缓存 + 网络」，不做预缓存（体积大，按需缓存即可）
  const isNavigation = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') > -1;

  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match('./index.html');
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      const network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });

      return hit || network;
    })
  );
});

/* ---------------------------------------------------------------- 消息通道 */
self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
