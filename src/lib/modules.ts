/**
 * 懒加载板块的统一入口。
 *
 * 为什么单独抽一层：`React.lazy` 与「空闲预取」必须用**同一批**动态 import，
 * 否则 Vite 会为同一模块产出两份 chunk，预取就白做了。
 *
 * 预取解决的是离线可用性：板块 chunk 只有在「在线打开过一次」之后才会被
 * Service Worker 缓存，于是手机上装了 PWA、在地铁里点开没访问过的板块，
 * 会直接撞上「渲染出错」错误卡（实测：岗位库 / 备考题库 / 网申资料库 三个板块全崩）。
 * 顺带的好处是在线切换板块不再有首次加载的空白帧。
 */
export const MODULE_LOADERS = {
  Database: () => import('../components/modules/Database'),
  Applications: () => import('../components/modules/Applications'),
  Jobs: () => import('../components/modules/Jobs'),
  Bank: () => import('../components/modules/Bank'),
  Calendar: () => import('../components/modules/Calendar'),
  MailCenter: () => import('../components/modules/MailCenter'),
  Resume: () => import('../components/modules/Resume'),
  Insights: () => import('../components/modules/Insights'),
  Offers: () => import('../components/modules/Offers'),
  Interviews: () => import('../components/modules/Interviews'),
  Checklist: () => import('../components/modules/Checklist'),
  Versions: () => import('../components/modules/Versions'),
  Contacts: () => import('../components/modules/Contacts'),
  JobsImport: () => import('../components/modules/JobsImport'),
  FileImport: () => import('../components/modules/FileImport'),
} as const;

type Conn = { saveData?: boolean; effectiveType?: string };

/**
 * 空闲时逐个预取板块 chunk（串行 + 间隔，避免和首屏渲染抢带宽）。
 * 省流模式、2G 弱网、离线状态下直接跳过——移动流量不该为了「可能离线」而埋单。
 */
export async function prefetchModules(): Promise<void> {
  try {
    const conn = (navigator as Navigator & { connection?: Conn }).connection;
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;
    if (!navigator.onLine) return;
  } catch { /* 读不到连接信息就按默认可预取处理 */ }

  for (const load of Object.values(MODULE_LOADERS)) {
    if (!navigator.onLine) return;
    try { await load(); } catch { return; }        // 网络异常/离线：静默停下，下次打开再试
    await new Promise((r) => setTimeout(r, 120));
  }
}
