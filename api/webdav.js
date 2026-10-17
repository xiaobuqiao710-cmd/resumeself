/**
 * Vercel Serverless Function · WebDAV 无状态转发代理
 * ------------------------------------------------------------------
 * 为什么需要它：浏览器（尤其公网 https 页面）直接请求网盘 WebDAV（如坚果云）
 * 会被 CORS 拦截——实测坚果云对预检 OPTIONS 直接返回 401 且不含 access-control-allow-*。
 * 本函数在服务端转发 WebDAV 请求，绕过浏览器同源限制，让「换设备/手机」也能同步。
 *
 * 隐私：本函数无状态——不写磁盘、不缓存、不记录凭据与响应体，仅把请求透传到
 * 用户自己的网盘并把结果原样返回。数据最终只存在用户自己的 WebDAV 网盘里。
 *
 * 安全（站点改成面向所有人之后重做过一轮，三条都是必要的）：
 *   ① **目标地址白名单校验**：只允许 http/https，拒绝本机/内网/链路本地/云元数据。
 *      注意必须做**规范化后的**判断 —— 只比对字面量会被这些写法绕过：
 *      `http://2130706433/`（十进制整数）、`http://0x7f000001/`、`http://127.1/`、
 *      `http://[::1]/`（new URL 保留方括号）、以及无点号的单标签主机名。
 *   ② **CORS 收敛**：原先回 `Access-Control-Allow-Origin: *`，等于任何网站都能用
 *      访客的浏览器把这个函数当免费代理（借 Vercel 的出口 IP 绕过各种 IP 限制）。
 *      现在只对本站来源回 CORS 头，其他来源直接 403。
 *   ③ **请求体上限**：PUT 的 body 直接进内存，不设上限可以被打爆。
 *
 * 说明：不带 Origin 的请求（curl 等非浏览器调用）仍放行 —— 浏览器不会为跨站请求
 * 省略 Origin，所以「借用访客浏览器」这条路已经被 ② 堵死；而无 Origin 放行是为了
 * 兼容某些浏览器对同源 POST 不带 Origin 的情况，堵掉它会直接打断正常功能。
 */

const ALLOWED_METHODS = ['GET', 'PUT', 'PROPFIND', 'MKCOL', 'DELETE', 'HEAD'];

/** 请求体上限（字符）：同步备份是几百 KB 量级，8MB 足够且留足余量 */
const MAX_BODY_CHARS = 8 * 1024 * 1024;

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<propfind xmlns="DAV:"><prop><resourcetype/><getlastmodified/><getcontentlength/></prop></propfind>';

/** 默认允许的来源；新增自定义域名时可用环境变量 QZ_ALLOWED_ORIGINS 覆盖（逗号分隔，支持 * 通配前缀） */
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  /* 当前正式域名：Vercel 项目已改名为 resumeself，默认域名随之变成 resumeself.vercel.app。
     改项目名时如果忘了同步这一行，站点本身照常打开，只有「网盘同步」会 403 —— 属于最难想到的一类故障。 */
  'https://resumeself.vercel.app',
  'https://resumeself-*.vercel.app',
  /* 旧域名：改名后 Vercel 已不再提供，但留着不碍事（旧标签页/书签仍可能带着它发请求） */
  'https://qiuzhao-cloud.vercel.app',
  'https://qiuzhao-cloud-*.vercel.app',
  /* 曾经绑过 resumeself.com / www.resumeself.com，但该域名从未注册（解析 NXDOMAIN），
     永远不可能成为合法的 Origin，已移除。将来买了自定义域名再加回来。 */
];

function allowedOrigins() {
  const raw = process.env.QZ_ALLOWED_ORIGINS;
  if (!raw || !String(raw).trim()) return DEFAULT_ORIGINS;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 精确匹配，或 `*` 只出现在前缀位置的通配（如 https://qiuzhao-cloud-*.vercel.app） */
function originAllowed(origin) {
  if (!origin) return false;
  for (const rule of allowedOrigins()) {
    if (!rule.includes('*')) {
      if (rule === origin) return true;
      continue;
    }
    const [pre, post = ''] = rule.split('*');
    if (origin.startsWith(pre) && origin.endsWith(post) && origin.length >= pre.length + post.length) return true;
  }
  return false;
}

/**
 * 判断主机名是否指向本机/内网。
 * 入参是 `new URL(...).hostname`（IPv6 会带方括号，例如 `[::1]`）。
 */
function isPrivateHost(rawHost) {
  const h = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;

  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;

  /* 单标签主机名（没有点）：只可能靠内网搜索域解析，正常 WebDAV 服务商都是完整域名 */
  if (!h.includes('.') && !h.includes(':')) return true;

  /* 纯数字 / 0x 开头的整数形式 IP：128.0.0.1 可写成 2130706433、0x7f000001 等 */
  if (/^\d+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/.test(h)) return true;

  /* IPv4 各段十进制/十六进制/八进制混合写法，例如 127.1 */
  if (/^\d+(\.\d+){1,3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;   // 解析不确定：一律拒绝
    const [a, b] = parts;
    if (a === 0 || a === 127 || a === 10 || a === 255) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;                             // 运营商级 NAT
    return false;
  }

  /* IPv6：回环 / 未指定 / 链路本地 / 唯一本地 / IPv4 映射 */
  if (h.includes(':')) {
    const v6 = h;
    if (v6 === '::' || v6 === '::1') return true;
    if (/^0(:0)*:0*1$/.test(v6)) return true;                                      // 0:0:0:0:0:0:0:1
    if (/^fe[89ab]/.test(v6)) return true;                                         // fe80::/10
    if (/^f[cd]/.test(v6)) return true;                                            // fc00::/7
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateHost(mapped[1]);                                   // IPv4 映射回 IPv4 判断
    if (/^::ffff:/i.test(v6)) return true;                                         // 映射成十六进制写法：保守拒绝
    return false;
  }

  return false;
}

export default async function handler(req, res) {
  const origin = req.headers && (req.headers.origin || req.headers.Origin);
  const originOk = originAllowed(origin);

  /* 来源在名单内才回 CORS 头；不在名单内不回，浏览器自然会拦下响应。
     不在名单内且带了 Origin 的，直接 403 —— 明确拒绝，不留模糊地带。 */
  if (originOk) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin) {
    return res.status(403).json({ error: '来源不被允许' });
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let payload;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_CHARS) return res.status(413).json({ error: '请求体过大' });
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }

  const { method, url, username, password, body, depth } = payload;

  if (!url || typeof url !== 'string') return res.status(400).json({ error: '缺少目标 url' });
  const m = String(method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(m)) return res.status(400).json({ error: `不支持的方法：${m}` });

  let target;
  try { target = new URL(url); } catch { return res.status(400).json({ error: 'url 非法' }); }
  if (!/^https?:$/.test(target.protocol)) return res.status(400).json({ error: '仅允许 http/https 目标' });
  if (isPrivateHost(target.hostname)) return res.status(400).json({ error: '目标地址不允许（本机/内网）' });

  const headers = {};
  if (username != null && password != null && String(username).length) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  }
  if (depth != null) headers['Depth'] = String(depth);

  let reqBody;
  if (m === 'PUT') {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    reqBody = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  } else if (m === 'PROPFIND') {
    headers['Content-Type'] = 'application/xml; charset=utf-8';
    reqBody = PROPFIND_BODY;
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), { method: m, headers, body: reqBody });
  } catch (e) {
    return res.status(502).json({ error: '转发失败：' + String((e && e.message) || e) });
  }

  const text = await upstream.text().catch(() => '');
  if (originOk) res.setHeader('Access-Control-Allow-Origin', origin);
  return res.status(200).json({
    status: upstream.status,
    ok: upstream.ok,
    body: text.length > 5_000_000 ? text.slice(0, 5_000_000) : text,
  });
}
