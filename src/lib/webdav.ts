/**
 * WebDAV 网盘同步客户端
 * ------------------------------------------------------------------
 * 通过本站的 Vercel 转发函数 `/api/webdav` 间接访问用户自己的网盘（绕过浏览器 CORS）。
 * 凭据仅保存在本机浏览器 localStorage；数据最终只存在用户自己的网盘里。
 * 典型用法：设备A「上传备份」→ 设备B/手机「下载恢复」，实现换设备可见。
 */

export interface WebdavConfig {
  server: string;    // WebDAV 根地址，如 https://dav.jianguoyun.com/dav/
  username: string;  // 账号（坚果云为注册邮箱）
  password: string;  // 应用密码（坚果云需在「安全选项→第三方应用管理」生成，非登录密码）
  path: string;      // 远程备份文件相对路径，如 qiuzhao-sync/data.json
  lastSync?: string; // 上次成功同步时间（ISO）
}

export interface WebdavProvider { id: string; label: string; server: string; hint: string; }

/** 常见 WebDAV 网盘预设：选择后自动填充服务器地址 */
export const WEBDAV_PROVIDERS: WebdavProvider[] = [
  { id: 'jianguoyun', label: '坚果云', server: 'https://dav.jianguoyun.com/dav/', hint: '密码填「应用密码」：坚果云网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用，生成后填入（不是登录密码）。' },
  { id: 'infinicloud', label: 'InfiniCLOUD', server: 'https://your-storage-box.infcloud.net/', hint: '使用 InfiniCloud WebDAV，账号为邮箱，密码为 WebDAV 专用密码。' },
  { id: 'custom', label: '自定义 / Nextcloud 自建', server: '', hint: '自建 Nextcloud/ownCloud 填 https://你的域名/remote.php/dav/files/用户名/ ；其他标准 WebDAV 填完整根地址。' },
];

export const DEFAULT_WEBDAV: WebdavConfig = {
  server: WEBDAV_PROVIDERS[0].server,
  username: '',
  password: '',
  path: 'qiuzhao-sync/data.json',
};

const LS = 'qz.webdav';

export function getWebdavConfig(): WebdavConfig {
  try { return { ...DEFAULT_WEBDAV, ...(JSON.parse(localStorage.getItem(LS) || '{}') as Partial<WebdavConfig>) }; }
  catch { return { ...DEFAULT_WEBDAV }; }
}
export function setWebdavConfig(c: WebdavConfig) {
  try { localStorage.setItem(LS, JSON.stringify(c)); } catch { /* ignore */ }
}
export function detectWebdavProvider(server: string): WebdavProvider {
  const s = (server || '').replace(/\/$/, '');
  return WEBDAV_PROVIDERS.find((p) => p.server && s === p.server.replace(/\/$/, '')) || WEBDAV_PROVIDERS[WEBDAV_PROVIDERS.length - 1];
}

/** 本站转发函数地址（生产为 Vercel Serverless Function） */
const PROXY = '/api/webdav';

interface DavResult { status: number; ok: boolean; body: string; }

function joinUrl(server: string, path: string): string {
  return `${server.replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** 统一的代理调用；代理本身不可达（如本地预览无函数）时给出明确提示 */
async function callProxy(payload: Record<string, unknown>): Promise<DavResult> {
  let res: Response;
  try {
    res = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('无法访问转发接口 /api/webdav（网络错误）。请确认通过已部署的正式网址访问。');
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error('转发接口 /api/webdav 不可用（返回非 JSON，可能尚未部署或在本地预览）。请在正式部署网址下使用网盘同步。');
  }
  const r = (await res.json().catch(() => ({}))) as DavResult & { error?: string };
  if (r && r.error && r.status == null) throw new Error(r.error);
  return { status: r.status ?? res.status, ok: !!r.ok, body: r.body ?? '' };
}

/**
 * 把 WebDAV 报错按「用户下一步该做什么」分类，供 UI 决定展示方式与给什么快捷动作。
 * 诊断信息本质是一段要读的文字（往往还带云端真实目录列表），不该塞进单行徽标里被截断。
 */
export function davErrorKind(msg: string): 'auth' | 'path' | 'server' | 'config' | 'other' {
  /* 「压根没填」必须排在「密码不对」前面。`请填写账号与应用密码` 里同时含有「应用密码」，
     旧顺序会把它判成 auth，于是空配置点「先测试连接」看到的大标题是「账号或应用密码不对」
     —— 引导用户去重置一个他从来没填过的密码。分类错了，后面的建议就全指向错的地方。 */
  if (/请填|请先填|不可用|非 JSON|转发接口|网络错误/.test(msg)) return 'config';
  if (/401|403|账号或应用密码|应用密码/.test(msg)) return 'auth';
  if (/404|409|路径|目录/.test(msg)) return 'path';
  if (/5\d\d|服务器错误/.test(msg)) return 'server';
  return 'other';
}

function explainStatus(status: number): string {
  if (status === 401 || status === 403) return '账号或应用密码不正确（401/403）。坚果云请使用「应用密码」而非登录密码；密码失效后重新生成再填这里。';
  if (status === 404) return '远程路径不存在（404）。请检查备份文件路径，或先在网盘中创建对应文件夹。';
  if (status === 405) return '方法不被允许（405）。请确认服务器地址是 WebDAV 根地址。';
  if (status === 409) return '云端没有这个目录（409）。常见原因：①这个文件夹是在本机新建的，坚果云客户端没运行就还没上传到云；②路径写法与云端不一致。可点下方「浏览网盘目录」直接看云端到底有什么。';
  if (status === 507) return '网盘容量不足（507）。请清理网盘空间后重试。';
  if (status >= 500) return `网盘服务器错误（${status}），请稍后重试。`;
  return `WebDAV 返回 ${status}`;
}

/** 网盘条目（用于目录浏览） */
export interface DavEntry { name: string; path: string; isDir: boolean; size?: number; modified?: string; }

/**
 * 列出网盘某个目录下的内容（PROPFIND Depth:1）。
 * 用途：路径报 409/404 时，直接把云端真实存在的目录与文件列出来让用户点选，
 * 不用靠猜路径——这也是排查「本机文件夹还没同步上云」最快的方式。
 */
export async function listDav(cfg: WebdavConfig, dirPath = ''): Promise<DavEntry[]> {
  if (!cfg.server.trim()) throw new Error('请填写 WebDAV 服务器地址');
  if (!cfg.username.trim() || !cfg.password) throw new Error('请先在「设置 → 数据与备份 → 网盘同步」填写账号与应用密码');
  const base = cfg.server.replace(/\/$/, '');
  const dir = dirPath.replace(/^\/+|\/+$/g, '');
  const url = dir ? `${joinUrl(cfg.server, dir)}/` : `${base}/`;
  const r = await callProxy({ method: 'PROPFIND', url, username: cfg.username, password: cfg.password, depth: 1 });
  if (r.status === 401 || r.status === 403) throw new Error('账号或应用密码不正确（401）。坚果云请使用「应用密码」（网页版 → 账户信息 → 安全选项 → 添加应用），不是登录密码。');
  if (!(r.status >= 200 && r.status < 300)) throw new Error(explainStatus(r.status));

  const basePath = (() => { try { return new URL(base + '/').pathname; } catch { return '/'; } })();
  const blocks = r.body.match(/<[^>]*:?response[\s>][\s\S]*?<\/[^>]*:?response>/gi) || [];
  const out: DavEntry[] = [];
  for (const b of blocks) {
    const hrefM = b.match(/<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i);
    if (!hrefM) continue;
    let href = hrefM[1].trim();
    try { href = decodeURIComponent(href); } catch { /* 保持原样 */ }
    const rel = href.startsWith(basePath) ? href.slice(basePath.length) : href.replace(/^\/+/, '');
    const clean = rel.replace(/\/+$/, '');
    if (!clean || clean === dir) continue;                      // 跳过目录自身
    const name = clean.split('/').pop() || clean;
    const sizeM = b.match(/<[^>]*:?getcontentlength[^>]*>(\d+)</i);
    const modM = b.match(/<[^>]*:?getlastmodified[^>]*>([^<]+)</i);
    out.push({
      name, path: clean,
      isDir: /<[^>]*:?collection\s*\/?>/i.test(b) || /<[^>]*:?collection>/i.test(b),
      size: sizeM ? Number(sizeM[1]) : undefined,
      modified: modM ? modM[1] : undefined,
    });
  }
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1));
}

/** 测试连接：对根地址 PROPFIND，验证凭据与地址是否可用 */
export async function testWebdav(cfg: WebdavConfig): Promise<string> {
  if (!cfg.server.trim()) throw new Error('请先填写 WebDAV 服务器地址');
  if (!cfg.username.trim() || !cfg.password) throw new Error('请填写账号与应用密码');
  const r = await callProxy({ method: 'PROPFIND', url: cfg.server.replace(/\/$/, '') + '/', username: cfg.username, password: cfg.password, depth: 0 });
  if (r.status >= 200 && r.status < 300) return '连接正常';
  throw new Error(explainStatus(r.status));
}

/** 上传备份：把本机数据 JSON 通过 PUT 写入网盘（必要时先创建父目录） */
export async function pushBackup(cfg: WebdavConfig, json: string): Promise<void> {
  if (!cfg.server.trim() || !cfg.path.trim()) throw new Error('请填写服务器地址与备份文件路径');
  if (!cfg.username.trim() || !cfg.password) throw new Error('请填写账号与应用密码');
  const parent = cfg.path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  if (parent) {
    // 尽力创建父目录；已存在（405/409）忽略
    await callProxy({ method: 'MKCOL', url: joinUrl(cfg.server, parent), username: cfg.username, password: cfg.password }).catch(() => undefined);
  }
  const r = await callProxy({ method: 'PUT', url: joinUrl(cfg.server, cfg.path), username: cfg.username, password: cfg.password, body: json });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(explainStatus(r.status));
}

const LS_DOC = 'qz.jobsDocPath';

/**
 * 汇总表在网盘上的默认路径。
 *
 * **必须与发布桥实际写出的文件名一致**：`scripts/qz-publish.mjs` 的目标是
 *   `~/Nutstore Files/我的坚果云/秋招数据/2027届秋招信息汇总.md`
 * 所以这里必须带「2027届」前缀。此前写的是 `秋招数据/秋招信息汇总.md`（少了年份），
 * 结果是：每次启动都先 404 一次，再靠 `discoverSyncDoc` 扫目录兜底才找到 ——
 * 能跑通纯属侥幸，扫描一失败（limitDav 报错 / 文件放得比两层还深）整条自动同步就报「未找到」，
 * 而且用户看到的是第一条 404，完全对不上「文件明明就在网盘里」。
 *
 * 路径是相对 WebDAV 根（坚果云为 `/dav/`，它直接对应同步文件夹根）。
 * 首次使用建议在「从网盘同步」里用目录浏览直接点选文件，省得猜路径 ——
 * 点选后 `setSyncDocPath` 会把它记住，后续都走这个路径。
 */
export const DEFAULT_SYNC_DOC = '秋招数据/2027届秋招信息汇总.md';

/**
 * 「岗位汇总表」在网盘上的路径。
 * 把自己整理的岗位汇总表放在网盘里，网页端就能一键拉取并解析，
 * 不用再从桌面手动选文件（浏览器无法读取本机磁盘，这是唯一的真正自动化通道）。
 */
export function getSyncDocPath(): string {
  try { return localStorage.getItem(LS_DOC) || DEFAULT_SYNC_DOC; }
  catch { return DEFAULT_SYNC_DOC; }
}
export function setSyncDocPath(p: string) {
  try { localStorage.setItem(LS_DOC, p.trim()); } catch { /* ignore */ }
}

/** 从网盘读取任意文本文件（用于拉取汇总表 / 日报 Markdown） */
export async function pullText(cfg: WebdavConfig, path: string): Promise<string> {
  const p = (path || '').trim();
  if (!cfg.server.trim() || !p) throw new Error('请填写服务器地址与网盘文件路径');
  if (!cfg.username.trim() || !cfg.password) throw new Error('请先在「设置 → 网盘同步」填写坚果云账号与应用密码');
  const r = await callProxy({ method: 'GET', url: joinUrl(cfg.server, p), username: cfg.username, password: cfg.password });
  if (r.status === 404) throw new Error(`网盘上没有这个文件（404）：${p}\n请把汇总表放到坚果云该路径下，或修改路径。`);
  if (!(r.status >= 200 && r.status < 300)) throw new Error(explainStatus(r.status));
  if (!r.body || !r.body.trim()) throw new Error('网盘上的文件是空的。');
  return r.body;
}

/** 下载恢复：从网盘 GET 备份 JSON，返回原文供 importAll 使用 */
export async function pullBackup(cfg: WebdavConfig): Promise<string> {
  if (!cfg.server.trim() || !cfg.path.trim()) throw new Error('请填写服务器地址与备份文件路径');
  if (!cfg.username.trim() || !cfg.password) throw new Error('请填写账号与应用密码');
  const r = await callProxy({ method: 'GET', url: joinUrl(cfg.server, cfg.path), username: cfg.username, password: cfg.password });
  if (r.status === 404) throw new Error('网盘上还没有备份文件（404）。请先在另一台设备点「上传备份」。');
  if (!(r.status >= 200 && r.status < 300)) throw new Error(explainStatus(r.status));
  if (!r.body || !r.body.trim()) throw new Error('网盘上的备份文件为空。');
  return r.body;
}
