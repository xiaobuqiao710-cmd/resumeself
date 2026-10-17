/**
 * `/api/webdav` 转发接口的安全回归测试（零依赖，直接 import 处理函数，不打网络）。
 *
 * 为什么要有它：这个接口是站点上**唯一一段服务端代码**，而且是公开可访问的。
 * 它一旦被绕过，后果是拿 Vercel 的机器去请求任意地址（SSRF）——可以打内网、读云元数据，
 * 或者被别的网站借用访客浏览器当免费代理。这几类问题的修法都很容易在后续重构里被改回去，
 * 所以固化成可一键运行的测试。
 *
 * 跑法：
 *   node scripts/qa-webdav-guard.mjs
 * 改动 api/webdav.js 之后**必须**跑一遍。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, '..', 'api', 'webdav.js'));
const handler = mod.default;

/* 把真实网络拦掉：只要处理函数走到了 fetch，就说明它没在守卫处拦下 */
let fetched = [];
globalThis.fetch = async (u) => {
  fetched.push(String(u));
  return { status: 200, ok: true, text: async () => 'OK' };
};

function mkRes() {
  return {
    code: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

async function call(payload, origin, method = 'POST') {
  fetched = [];
  const res = mkRes();
  const body = payload === undefined ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload));
  await handler({ method, body, headers: origin ? { origin } : {} }, res);
  return { code: res.code, body: res.body, fetched: [...fetched], acao: res.headers['access-control-allow-origin'] };
}

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) fail++; };
const SITE = 'https://resumeself.vercel.app';

console.log('── A. SSRF：这些目标一个都不许发出去 ──');
const BLOCKED = [
  ['http://127.0.0.1:8080/x', '点分回环'],
  ['http://localhost/x', 'localhost'],
  ['http://2130706433/x', '十进制整数形式的 127.0.0.1'],
  ['http://0x7f000001/x', '十六进制形式的 127.0.0.1'],
  ['http://017700000001/x', '八进制形式的 127.0.0.1'],
  ['http://127.1/x', '短写 127.1'],
  ['http://[::1]/x', 'IPv6 回环（new URL 保留方括号，最容易漏）'],
  ['http://[0:0:0:0:0:0:0:1]/x', 'IPv6 回环（全写）'],
  ['http://[::ffff:127.0.0.1]/x', 'IPv4 映射回环'],
  ['http://[fd00::1]/x', 'IPv6 唯一本地'],
  ['http://[fe80::1]/x', 'IPv6 链路本地'],
  ['http://169.254.169.254/latest/meta-data/', '云元数据'],
  ['http://10.0.0.5/x', '内网 10/8'],
  ['http://192.168.1.1/x', '内网 192.168/16'],
  ['http://172.16.3.4/x', '内网 172.16/12'],
  ['http://100.64.1.1/x', '运营商级 NAT'],
  ['http://metadata.google.internal/x', 'GCP 元数据域名'],
  ['http://intranet/x', '无点号主机名'],
  ['ftp://dav.jianguoyun.com/x', '非 http(s) 协议'],
];
for (const [url, label] of BLOCKED) {
  const r = await call({ method: 'GET', url });
  ok(r.code === 400 && r.fetched.length === 0,
    `${label.padEnd(28)} → HTTP ${r.code}${r.fetched.length ? ' ❌ 漏到 ' + r.fetched[0] : ''}`);
}

console.log('\n── B. 正常 WebDAV 目标必须放行 ──');
{
  const r = await call({ method: 'PROPFIND', url: 'https://dav.jianguoyun.com/dav/我的坚果云/' }, SITE);
  ok(r.code === 200 && r.fetched.length === 1, `坚果云 PROPFIND → HTTP ${r.code}，已转发 ${r.fetched.length} 次`);
}
{
  const r = await call({ method: 'GET', url: 'https://my.nextcloud.example.com/remote.php/dav/' }, SITE);
  ok(r.code === 200 && r.fetched.length === 1, `自建 Nextcloud → HTTP ${r.code}，已转发 ${r.fetched.length} 次`);
}

console.log('\n── C. CORS：不能变成任何网站都能借用的免费代理 ──');
{
  const r = await call({ method: 'GET', url: 'https://dav.jianguoyun.com/dav/' }, 'https://evil.example.com');
  ok(r.code === 403 && !r.acao && r.fetched.length === 0,
    `陌生来源 → HTTP ${r.code}，ACAO=${r.acao || '(无)'}，未转发`);
}
{
  const r = await call({ method: 'GET', url: 'https://dav.jianguoyun.com/dav/' }, SITE);
  ok(r.acao === SITE, `本站来源 → ACAO 回显 ${r.acao}`);
}
{
  const r = await call({ method: 'GET', url: 'https://dav.jianguoyun.com/dav/' }, 'https://qiuzhao-cloud-abc123-xiaobuqiao710.vercel.app');
  ok(r.code === 200 && !!r.acao, `预览部署（通配规则）→ HTTP ${r.code}，ACAO=${r.acao}`);
}
{
  const r = await call({ method: 'GET', url: 'https://dav.jianguoyun.com/dav/' }, null);
  ok(r.code === 200 && !r.acao, `无 Origin（curl 等）→ HTTP ${r.code}，不回调头，因此无法被跨站借用`);
}
{
  const r = await call(undefined, SITE, 'OPTIONS');
  ok(r.code === 204, `预检 OPTIONS → HTTP ${r.code}`);
}
{
  const r = await call(undefined, 'https://evil.example.com', 'OPTIONS');
  ok(r.code === 403, `陌生来源预检 → HTTP ${r.code}`);
}

console.log('\n── D. 方法与体积 ──');
{
  const r = await call({ method: 'MKCOL', url: 'https://dav.jianguoyun.com/dav/x/' }, null);
  ok(r.code === 200, `允许的方法 MKCOL → HTTP ${r.code}`);
}
{
  const r = await call({ method: 'TRACE', url: 'https://dav.jianguoyun.com/dav/' }, null);
  ok(r.code === 400, `不允许的方法 TRACE → HTTP ${r.code}`);
}
{
  const r = await call('x'.repeat(9 * 1024 * 1024), null);
  ok(r.code === 413, `超过 8MB 的请求体 → HTTP ${r.code}`);
}
{
  const r = await call('{不是JSON', null);
  ok(r.code === 400, `非法 JSON → HTTP ${r.code}`);
}

console.log(`\n${fail === 0 ? '全部通过 ✅' : `❌ ${fail} 项失败`}（共 ${BLOCKED.length + 11} 项）`);
process.exit(fail === 0 ? 0 : 1);
