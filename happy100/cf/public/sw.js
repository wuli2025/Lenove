/* 幸福小事 · 离线缓存
   ───────────────────────────────────────────────────────────────
   代码类（html/js/css）走「网络优先」：有网就永远拿最新的，
   这样我改了东西你刷新一下就能拿到，不会卡在旧版本；
   没网时回落到缓存，照样能用。
   图片走「缓存优先」，反正它们不怎么变，还省流量。
   同步和发信接口一律不碰。
   ─────────────────────────────────────────────────────────────── */
const CACHE = 'happy100-v6';

const SHELL = [
  './', './index.html', './styles.css', './app.js', './data.js', './sync.js', './manifest.webmanifest',
];
const MEDIA = [
  './art/icon-192.png', './art/icon-512.png', './art/hero.jpg', './art/report.jpg',
  './art/empty.jpg', './art/celebrate.jpg', './art/splash.jpg',
  './art/cat-morning.jpg', './art/cat-brain.jpg', './art/cat-body.jpg',
  './art/cat-emotion.jpg', './art/cat-social.jpg', './art/cat-home.jpg', './art/cat-night.jpg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll([...SHELL, ...MEDIA]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isCode = url =>
  /\.(html|js|css|webmanifest)$/.test(url.pathname) ||
  url.pathname === '/' || url.pathname.endsWith('/');

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;          // 同步 / 发信永远走网络
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate' || isCode(url)) {
    // 网络优先
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // 图片等：缓存优先
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
