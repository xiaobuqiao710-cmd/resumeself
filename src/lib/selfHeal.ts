/* 版本自愈 · selfHeal
 *
 * 背景：SPA 页面一旦打开就会长期停留在内存里的旧 bundle。发新版（Vercel 新部署）后，
 * 上一版带哈希的懒加载 chunk 已被删除，旧标签页再点开某个板块就会报
 * "Failed to fetch dynamically imported module: /assets/Bank-xxxx.js"（或 ChunkLoadError）。
 * 这不是数据坏了，只是「页面是旧版、服务器只有新版」。
 *
 * 处理：凡是这类错误，一律自动硬刷新到最新版；用 sessionStorage 冷却，避免网络异常时刷新死循环。
 * 数据是写穿 localStorage 的（store 每次变更同步落盘），刷新不会丢数据。
 */

/** 典型的「bundle 过期」错误特征 */
const STALE_ERR = /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed|Unable to preload CSS/i;

export function isStaleChunkError(msg?: unknown): boolean {
  return STALE_ERR.test(String(msg ?? ''));
}

function take(key: string, cooldown: number): boolean {
  try {
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - last < cooldown) return false;
    sessionStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** 硬刷新：让当前 SW 去更新，并给 URL 加时间戳以绕开 SW 离线壳缓存与浏览器缓存 */
export async function hardReload(reason: string): Promise<void> {
  console.warn('[秋招中心] 自动刷新到最新版：' + reason);
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs || []).map((r) => r.update().catch(() => undefined)));
  } catch { /* 忽略 */ }
  try {
    const u = new URL(location.href);
    u.searchParams.set('_v', String(Date.now()));
    location.replace(u.toString());
  } catch {
    location.reload();
  }
}

/** 懒加载失败的自愈：返回 true 表示已经触发刷新 */
export function healIfStale(msg?: unknown, cooldown = 15_000): boolean {
  if (!isStaleChunkError(msg)) return false;
  if (!take('qz.heal.at', cooldown)) return false;
  void hardReload('chunk 加载失败');
  return true;
}

/** 用户点「刷新到最新版」 */
export function reloadToLatest(): void {
  void hardReload('手动刷新');
}

/** 版本复查：比较当前 index-*.js 与服务器上的最新 index.html，发现新版就刷新 */
export async function checkNewVersion(cooldown = 60_000): Promise<void> {
  try {
    const res = await fetch(`index.html?_upd=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const latest = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    if (!latest) return;
    const current = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.src || '';
    if (!current.endsWith(latest) && take('qz.ver.at', cooldown)) {
      void hardReload('检测到新版本');
    }
  } catch { /* 离线或网络受限时静默跳过 */ }
}
