/* 秋招网申辅助中心 · Service Worker
 * 目标：手机加到桌面后能秒开、弱网可用；不改动任何数据（数据仍在浏览器的
 * localStorage 与你的坚果云 WebDAV 里，SW 只缓存页面静态资源）。
 *
 * v2 关键修正（v1 会把旧版 index.html 连同旧 chunk 引用一起缓存住，
 * 新部署上线后旧标签页点开板块就报 "Failed to fetch dynamically imported module"）：
 *   1. 不再预缓存 HTML 外壳；每次成功导航都用 no-store 拉最新的 HTML 覆盖缓存 → 离线兜底永远是最近一版；
 *   2. `/assets/*` 是按内容哈希命名的不可变文件，cache-first 安全；
 *      但只缓存 200 且非 HTML 的响应，避免把「SPA 回退出来的 HTML」当成 JS 存起来；
 *   3. 换版本即清掉旧缓存，并主动 skipWaiting + clients.claim，让新 SW 立刻接管。
 */
const CACHE = 'qz-shell-v2';
const SHELL = ['/manifest.webmanifest', '/favicon.svg'];
const MAX_ASSETS = 160;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

/** 只缓存「真实存在的静态文件」，绝不缓存 HTML 回退页 */
function cacheable(res) {
  if (!res || !res.ok || res.status !== 200) return false;
  const ct = res.headers.get('content-type') || '';
  return !ct.includes('text/html');
}

/** 网络优先（绕开 HTTP 缓存），失败时回退到最近一次的离线外壳 */
async function handleNavigate(req) {
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => undefined);
    }
    return res;
  } catch {
    const hit = await caches.match('/');
    if (hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>离线</title>'
      + '<div style="font:15px/1.9 -apple-system,sans-serif;padding:40px;text-align:center">'
      + '当前处于离线状态，且本机还没有可用的离线副本。<br>连上网络后刷新即可。</div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

/** 哈希资源：缓存优先，未命中再走网络并落缓存 */
async function handleAsset(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (cacheable(res)) {
      const copy = res.clone();
      caches.open(CACHE).then(async (c) => {
        await c.put(req, copy);
        const keys = await c.keys();
        if (keys.length > MAX_ASSETS) await c.delete(keys[0]);
      }).catch(() => undefined);
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // 邮件桥 / WebDAV 转发不缓存

  if (req.mode === 'navigate') {
    e.respondWith(handleNavigate(req));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(handleAsset(req));
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || new Response('', { status: 504 }))),
  );
});
