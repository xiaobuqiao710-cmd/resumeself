import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/components.css';
/* skins.css 必须排在 components.css **之后**：皮肤的变量层与 components.css 里那批
   `:root[data-theme="light"] …` 覆盖是同特异性的，靠文档顺序分胜负（见 skins.css 顶部约定 ①）。 */
import './styles/skins.css';
/* 今日总览（首页）自己的骨架样式，排在 skins.css 之后：它只引用变量，
   皮肤层要能覆盖到它。其余 12 个模块的样式仍在 components.css 里。 */
import './styles/dashboard.css';
/* 日历屏的骨架样式，与首页同一套语言（浅格 + 细网格线 + 单行事件条）。 */
import './styles/calendar.css';
import { applySkinToDocument, readSavedSkin } from './lib/skins';
import { checkNewVersion, healIfStale, reloadToLatest } from './lib/selfHeal';
import { prefetchModules } from './lib/modules';
import { healScrollLock } from './components/ui/Kit';

/* 首屏就把皮肤铺上。
   权威数据（跟着账号同步的那份）要等登录 + 云端读回来才知道，但皮肤是**第一眼**就要对的：
   不在这里先写一次，用户每次打开都会看到默认皮肤、再闪成自己选的那套。 */
applySkinToDocument(readSavedSkin());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/* ---------- 部署更新守卫 + 版本自愈 ----------
 * SPA 页面一旦打开会长期停留在内存中的旧 bundle。发新版后：
 *   ① 旧标签页看到的还是旧界面（曾出现「模态框修了却仍显示旧样式」）；
 *   ② 旧版按哈希命名的懒加载 chunk 已被新部署删除，点开板块就会
 *      "Failed to fetch dynamically imported module: /assets/Bank-xxxx.js"。
 * 三重保险：懒加载报错即刻自愈刷新、焦点/联网/每 60 秒复查版本、SW 换班后刷新。 */
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault?.();
  healIfStale('vite:preloadError');
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string } | string | undefined;
  healIfStale(typeof r === 'string' ? r : r?.message || '');
});

let lastCheck = 0;
function scheduleCheck() {
  const now = Date.now();
  if (now - lastCheck < 30_000) return;
  lastCheck = now;
  if (document.visibilityState !== 'visible') return;
  void checkNewVersion();
}
window.addEventListener('focus', scheduleCheck);
window.addEventListener('online', scheduleCheck);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleCheck();
});
// 长时间挂在页面上（不切换标签页）时也要能发现新版
window.setInterval(scheduleCheck, 60_000);

/* 兜底自愈：清掉可能残留的滚动锁（旧版本在「两层弹窗叠加」路径上会把 .app__scroll
   的 overflow 永久留在 hidden，表现为整站无法上下滑动）。 */
healScrollLock();

/* 板块 chunk 空闲预取：让「手机装成 PWA 后离线也能打开任意板块」成立。
   懒加载的板块只有在在线打开过一次后才会进 SW 缓存，否则离线点开就是一张「渲染出错」错误卡。 */
if (import.meta.env.PROD) {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void prefetchModules(), { timeout: 5000 });
  else window.setTimeout(() => void prefetchModules(), 3000);
}

/* PWA：注册 Service Worker（仅生产环境），手机可「加到主屏幕」离线秒开 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  /* 首次访问时 SW 安装完会立刻接管（clients.claim），此时也会触发 controllerchange ——
     那只是「第一次装上」，不是「有新版本」，不该刷新（否则新访客刚打开就被刷一次）。 */
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 忽略注册失败 */ });
  });
  // 新 SW 接管（= 新部署已上线）后刷新一次，避免外壳与 chunk 版本错配
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    try {
      const last = Number(sessionStorage.getItem('qz.sw.at') || 0);
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem('qz.sw.at', String(Date.now()));
    } catch { /* ignore */ }
    reloadToLatest();
  });
}
