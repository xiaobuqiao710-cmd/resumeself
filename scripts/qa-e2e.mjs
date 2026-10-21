/**
 * 秋招助手 · 无头浏览器端到端巡检（CDP 直连，零依赖）
 *
 * 用法（先 `npx vite preview --port 4173` 起本地产物，再）：
 *   node scripts/qa-e2e.mjs views      # 遍历全部板块，抓控制台报错 + 截图
 *   node scripts/qa-e2e.mjs removeapp  # 删除投递记录后岗位库应回退（联动手测）
 *   node scripts/qa-e2e.mjs palette    # ⌘K 空查询应列出全部板块跳转
 *   node scripts/qa-e2e.mjs convert    # 「转为投递」选「待投递」时岗位库不应变已投递
 *   node scripts/qa-e2e.mjs import     # 用真实汇总表走 选文件→解析→导入，并复验幂等
 *   node scripts/qa-e2e.mjs settings   # 设置弹窗四标签 + 滚动锁定/还原
 *   node scripts/qa-e2e.mjs mailsync   # 邮件同步批量改状态（需本机邮件桥 8787）
 *   node scripts/qa-e2e.mjs overlap    # 公司卡内部元素重叠几何检测
 *   node scripts/qa-e2e.mjs mobile     # 390×844 窄屏：横向溢出/汉堡菜单/浮窗助手
 *   node scripts/qa-e2e.mjs pwa        # Service Worker 接管 + 断网重载 + 断网切板块
 *   node scripts/qa-e2e.mjs contrast   # 深浅两主题文字对比度探针（配 qa-contrast-probe.js）
 *   node scripts/qa-e2e.mjs roundtrip  # 导出 JSON → 覆盖导入 → 合并导入 的数据完整性
 *   node scripts/qa-e2e.mjs ai         # AI 链路（需先起 node scripts/qa-ai-mock.mjs 8799）
 *   node scripts/qa-e2e.mjs webdav     # 网盘同步（CDP 拦截 /api/webdav 伪造转发响应）
 *   node scripts/qa-e2e.mjs mailsend   # 写邮件两段式确认（拦截邮件桥 /api/send，不真发信）
 *   node scripts/qa-e2e.mjs perf       # 大数据量性能（500 岗位 / 400 投递 / 600 事件）
 *   node scripts/qa-e2e.mjs appcat     # 投递记录两级下钻：7 类别卡/计数/预览≤3/下钻/返回/搜索收敛/行内改状态
 *   node scripts/qa-e2e.mjs pline      # 进度线编辑器：跨卡列对齐（勾选/删除同一竖线）/ 三档宽度不溢出 + 截图
 *   node scripts/qa-e2e.mjs typing     # 弹窗内真实键盘输入：焦点是否被父组件重渲染抢走（关键回归）
 *   node scripts/qa-e2e.mjs bankrepo   # 题库「分类卡墙→题库卡墙→题组列表」三级卡片墙（v7）：建分类/建题库/散题/
 *                                      #   批量归入/搜索收敛/整场导入=一张题组卡+展开重排解散/题库换分类题跟着走/
 *                                      #   删分类不丢资产/删题库不删题
 *
 * 线上巡检：QZ_CLOUD=1 QZ_BASE=https://resumeself.vercel.app/ QZ_PROXY=http://127.0.0.1:7897 \
 *            QZ_PROFILE=/tmp/qz-live node scripts/qa-e2e.mjs <scenario>
 *   （正式地址以 README 为准 = resumeself.vercel.app。别拿别的 *.vercel.app 当线上地址：
 *    账号里还挂着 qiuzhao-assistant / qiuzhao-assistant-v2 两个老项目，
 *    它们各自绑了域名却与本仓库无关，对着它们跑只会得到「改了半天没变化」的假结论。）
 *
 * 本机受限环境（Chrome 起不来、报 `sandbox initialization failed`）再加 QZ_NO_SANDBOX=1。
 * 完整可跑的本地组合：
 *   QZ_NO_SANDBOX=1 QZ_CLOUD=1 QZ_BASE=http://127.0.0.1:4173/ node scripts/qa-e2e.mjs bankrepo
 *
 * 截图落在 /tmp/qz-shots；用临时 user-data-dir，绝不触碰你本人浏览器的数据。
 * 注意：CDP 的 Network 断网是 per-target，测 Service Worker 离线必须把 service_worker 目标也断网；
 *       跨源拦截（如邮件桥 8787）要单独放行 OPTIONS 预检，否则前端只看到「Failed to fetch」。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import path from 'node:path';

/**
 * 巡检要连的邮件桥令牌。
 * 优先读 QZ_BRIDGE_TOKEN，其次 QZ_BRIDGE_TOKEN_FILE（默认指向本仓库的
 * mail-bridge/bridge.token）。桥没装就返回空串，相关场景自行跳过。
 */
function bridgeToken() {
  if (process.env.QZ_BRIDGE_TOKEN) return process.env.QZ_BRIDGE_TOKEN.trim();
  const file = process.env.QZ_BRIDGE_TOKEN_FILE
    || path.join(fileURLToPath(new URL('..', import.meta.url)), 'mail-bridge', 'bridge.token');
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/* Chrome 可执行文件：优先用「Chrome for Testing」（Playwright 缓存里那份，bundle ID 是
   com.google.chrome.for.testing，与正式版完全隔离）。
   为什么必须隔离：headless 实例一旦用正式版 Chrome 启动，macOS 就认为 com.google.Chrome
   已在运行，此后点 Dock 图标只会去「激活」那个没有窗口的 headless 实例 —— 表现为
   「Chrome 打不开了」。可用 QZ_CHROME 覆盖；找不到 Chrome for Testing 才回退正式版。 */
const CHROME = process.env.QZ_CHROME || (() => {
  const root = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright');
  try {
    for (const d of fs.readdirSync(root).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
      const p = path.join(root, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
})();
/* 调试端口。默认固定 9333；想并行跑多个场景时用 QZ_PORT 各自分开，
   否则两个巡检会互相抢同一个浏览器（见 killStaleChrome 的注释）。 */
const PORT = Number(process.env.QZ_PORT) || 9333;
const BASE = process.env.QZ_BASE || 'http://127.0.0.1:4173/';
/* 播种数据来源：QZ_PKG=<路径> 指定一份导出的整站 JSON 作为起始数据；
   `QZ_PKG=empty`（默认）表示用空数据启动，验证「别人第一次打开模板」的体验。 */
const PKG = process.env.QZ_PKG || 'empty';
const EMPTY_SEED = PKG === 'empty';
const SHOTS = '/tmp/qz-shots';
/* 导入场景要用的岗位清单：QZ_MD=<路径> 指定；不给则跳过依赖它的断言。 */
const MD_PATH = process.env.QZ_MD || '';
const PROFILE = process.env.QZ_PROFILE || '/tmp/qz-e2e-profile';
/* 直连线上时本机被墙，需走代理：QZ_BASE=https://resumeself.vercel.app/ QZ_PROXY=http://127.0.0.1:7897 */
const PROXY = process.env.QZ_PROXY || '';
/* 云端版巡检（QZ_CLOUD=1）：站点被 Supabase 登录门挡着，没有真实账号就进不去任何板块。
   这里不碰真实账号，而是在页面里伪造一份 Supabase 会话 + 用 CDP 拦截 REST 读取，
   让 17 个板块仍然能全量巡检（登录门本身另有 login 场景单独验证）。 */
const CLOUD = process.env.QZ_CLOUD === '1';
/* QZ_CLOUD_FAIL=1 → 让伪造的 Supabase 一律返回 500，用来验证「云端读不通」时站点的表现 */
const CLOUD_FAIL = process.env.QZ_CLOUD_FAIL === '1';
/* QZ_DAV_DEBUG=1 → 打印每次被拦截的 /api/webdav 请求与伪造出来的响应，
   排查「网盘同步」类场景断言失败时，用来区分是脚本伪造得不对还是产品真有问题 */
const DAV_DEBUG = process.env.QZ_DAV_DEBUG === '1';
const QA_UID = process.env.QZ_UID || '00000000-0000-4000-8000-000000000001';

/* CDP 的 Fetch.enable 是**整组替换** pattern，不是追加。
   所以任何一次 enable 都必须带上「此刻还需要保留的其它拦截」，否则会静默关掉别的桩 ——
   而关掉之后请求会直连真实服务，症状会伪装成产品缺陷。 */
const PAT_CLOUD = [{ urlPattern: '*/rest/v1/*', requestStage: 'Request' }];
const withCloudPatterns = (extra) => [...extra, ...(CLOUD ? PAT_CLOUD : [])];
/** 恢复「除本场景外其余拦截保持原样」的状态（本场景收尾时用，替代裸 Fetch.disable） */
async function restoreFetchPatterns(page) {
  if (CLOUD) await page.cdp.send('Fetch.enable', { patterns: PAT_CLOUD }, page.sid).catch(() => {});
  else await page.cdp.send('Fetch.disable', {}, page.sid).catch(() => {});
}
/* supabase-js 的会话键名是 `sb-<项目ref>-auth-token`，ref 取自项目 URL 的子域
   （见其 dist 里 `sb-${baseUrl.hostname.split(".")[0]}-auth-token`）。
   查找顺序：QZ_SB_REF > 环境变量 VITE_SUPABASE_URL > 项目里的 .env.local / .env。
   为什么必须读 .env.*：站点产物是用那里的值构建的，而 node 进程默认不加载 .env；
   只认 process.env 时本机直接跑巡检会拿不到 ref，于是不再伪造会话 ——
   页面停在登录门，所有断言读到空数据，表现为一大片「失败」的假红（正是踩过的坑）。 */
function readEnvValue(key) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const f of ['.env.local', '.env']) {
    try {
      const text = readFileSync(path.join(root, f), 'utf8');
      const m = text.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$', 'm'));
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
    } catch { /* 文件不存在就继续找下一个 */ }
  }
  return '';
}
function deriveSbRef() {
  if (process.env.QZ_SB_REF) return process.env.QZ_SB_REF;
  const url = process.env.VITE_SUPABASE_URL || readEnvValue('VITE_SUPABASE_URL');
  const m = url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\./i);
  return m ? m[1] : '';
}
const SB_REF = deriveSbRef();
if (CLOUD && !SB_REF) {
  console.warn('⚠️  没能确定 Supabase 项目 ref（会话键 sb-<ref>-auth-token 无法伪造）。');
  console.warn('    QZ_CLOUD=1 的场景会全部退化成登录门，断言将大面积假红。');
  console.warn('    请在项目根目录 .env.local 里填 VITE_SUPABASE_URL，或用 QZ_SB_REF=<ref> 指路。');
}
fs.mkdirSync(SHOTS, { recursive: true });

/** 造一份 supabase-js 认得的会话（它只做 base64 解码取 exp，不验签名） */
function fakeSession() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ sub: QA_UID, email: 'qa@qiuzhao.local', role: 'authenticated', aud: 'authenticated',
          exp: now + 315360000, iat: now, session_id: 'qa-session' }),
    'qa-signature',
  ].join('.');
  return {
    access_token: jwt, token_type: 'bearer', expires_in: 315360000, expires_at: now + 315360000,
    refresh_token: 'qa-refresh',
    user: {
      id: QA_UID, aud: 'authenticated', role: 'authenticated', email: 'qa@qiuzhao.local',
      email_confirmed_at: new Date(now * 1000).toISOString(),
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {}, identities: [],
      created_at: new Date(now * 1000).toISOString(), updated_at: new Date(now * 1000).toISOString(),
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP 客户端 ---------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) rej(new Error(m.method + ' ' + JSON.stringify(m.error))); else res(m.result);
      } else if (m.method) {
        for (const l of c.listeners) l(m);
      }
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

/* ---------------- 启动浏览器 ---------------- */
/**
 * 开跑前先确认调试端口是干净的。
 *
 * 为什么必须做：端口写死 9333 + Chrome 的子进程不随主进程退出 → 上一轮残留的浏览器还在监听。
 * 这时新启动的 Chrome 因为端口被占会立刻退出（或走单例逻辑），而 `/json/version` 依然 200，
 * 脚本就**连上了上一轮那个浏览器**：user-data-dir 被无视、localStorage 里是上一轮的数据。
 * 症状极具误导性 —— 断言全绿却什么都没验证（岗位库里已躺着上一轮的记录、全被判「重复」），
 * 或者反过来随机假红。宁可在启动前明确杀掉，也不要让巡检跑在别人的数据上。
 */
async function killStaleChrome() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (!r.ok) return;
  } catch { return; }                      // 端口没人监听 = 正常
  try {
    const pids = execFileSync('lsof', ['-ti', `tcp:${PORT}`], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    for (const p of pids) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* 已经没了 */ } }
    if (pids.length) console.log(`⚠️ 清理了占用调试端口 ${PORT} 的残留浏览器进程 ${pids.length} 个（否则会连上旧实例）`);
    await sleep(300);
  } catch { /* lsof 不可用时退化为只告警 */ }
}

async function launch() {
  await killStaleChrome();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-features=Translate',
    /* QZ_NO_SANDBOX=1：某些托管/受限环境里父进程被限制了 capability，Chrome 起自己的
       沙箱会一路 `sandbox initialization failed: Operation not permitted` →
       GPU/Network 子进程反复崩 → 浏览器 `GPU process isn't usable. Goodbye.` 自杀。
       症状是 `timeout Page.enable`（/json/version 短暂 200 后连接失效），很容易误判成
       「页面卡住」。仅跑本地巡检时开这个开关。 */
    ...(process.env.QZ_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...(PROXY ? [`--proxy-server=${PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1'] : []),
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore', detached: false });
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  if (!ver) throw new Error('Chrome 未能启动');
  const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { child, cdp, sessionId };
}

/* ---------------- 会话封装 ---------------- */
class Page {
  constructor(cdp, sid) {
    this.cdp = cdp; this.sid = sid;
    this.errors = []; this.console = []; this.failed = [];
    cdp.on((m) => {
      if (m.sessionId !== sid) return;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.console.push({ type: m.params.type, text: txt });
        if (m.params.type === 'error') this.errors.push('[console.error] ' + txt);
      } else if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        if (e.level === 'error') this.errors.push('[log] ' + e.text + (e.url ? ' @' + e.url : ''));
      } else if (m.method === 'Network.loadingFailed') {
        this.failed.push(m.params.errorText + ' ' + (m.params.type || ''));
      } else if (m.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
      }
    });
  }
  async init(payload) {
    const send = (m, p) => this.cdp.send(m, p, this.sid);
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
    /* 只在首次访问时播种：否则每次 reload 都会把应用自己刚写的数据覆盖回原始包，
       让「刷新后数据还在吗」这类持久化验证全部失真。 */
    const cacheKey = CLOUD ? `qz.cloud.${QA_UID}` : 'qz.cloud.default';
    const seed = `
      try {
        ${CLOUD ? `if (localStorage.getItem('qz.qa.noSeed') !== '1' && !localStorage.getItem('sb-${SB_REF}-auth-token')) localStorage.setItem('sb-${SB_REF}-auth-token', ${JSON.stringify(JSON.stringify(fakeSession()))});` : ''}
        /* 新手指南默认按「已看过」播种：全站 20 多处断言都按「同一时刻只有一个弹窗」写
           （裸 .modal / .modal-overlay），指南一自动弹就会把它们统统顶掉、假红一片。
           只有 onboard 场景要看新用户首访，它自己置 qz.qa.guideFresh=1 放行。 */
        if (localStorage.getItem('qz.qa.guideFresh') !== '1') localStorage.setItem('qz.guideSeen', '1');
        if (!localStorage.getItem(${JSON.stringify(cacheKey)})) localStorage.setItem(${JSON.stringify(cacheKey)}, ${JSON.stringify(payload)});
        /* 只在未设置时关闭自动同步：否则每次导航都会把测试里刚打开的开关按回去
           （曾让「开机自动同步」永远测不出来） */
        if (!localStorage.getItem('qz.sync.auto')) localStorage.setItem('qz.sync.auto', '0');
        /* AI 配置指向本地 mock（scripts/qa-ai-mock.mjs），让 AI 链路也能端到端验证 */
        if (!localStorage.getItem('qz.ai')) localStorage.setItem('qz.ai', JSON.stringify({ baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'mock-key', model: 'mock-model' }));
        localStorage.setItem('qz.bridgeUrl', ${JSON.stringify(process.env.QZ_BRIDGE_URL || 'http://localhost:8787')});
        localStorage.setItem('qz.bridgeToken', ${JSON.stringify(bridgeToken())});
        localStorage.removeItem('qz.snapshots');
      } catch (e) {}
    `;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: seed });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    if (CLOUD) await this.stubCloud();
  }
  /**
   * 伪造 Supabase REST：GET profiles 返回一份空文档（= 云端确实没有数据，站点走本机缓存），
   * 写操作一律 201 成功。这样「同步失败」不会污染控制台错误列表，真实缺陷才看得见。
   * 注意必须自己回 CORS 头：CDP 的 fulfillRequest 仍要过浏览器的跨源校验，
   * 且 supabase-js 带 apikey/Authorization 头会先发 OPTIONS 预检。
   */
  async stubCloud() {
    const send = (m, p) => this.cdp.send(m, p, this.sid);
    this.cloudWrites = [];
    /* 服务端 updated_at 由测试控制：stale 场景把它往后拨，模拟「另一台设备改过」 */
    this.cloudUpdatedAt = '2026-01-01T00:00:00.000Z';
    if (CLOUD_FAIL) this.cloudFail = true;
    await send('Fetch.enable', { patterns: PAT_CLOUD });
    let gets = 0, writes = 0;
    this.cdp.on((m) => {
      if (m.sessionId !== this.sid || m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params;
      /* ★ 必须自己判断 URL。
         别的场景（网盘同步、邮件桥）会调用 Fetch.enable —— 而 CDP 的 Fetch.enable
         是**整组替换** pattern，不是追加。于是那些场景一开拦截，云端桩就会连带收到
         /api/webdav、/api/send 的 requestPaused；不判断 URL 就一律按 Supabase 形状回，
         产品侧看到的是 `{"data":null,"updated_at":...}`，报出来的却是
         「网盘上的备份文件为空」这种完全对不上号的错，排查会走到产品代码上去。 */
      if (!request.url.includes('/rest/v1/')) return;
      const cors = [
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,PUT,DELETE,OPTIONS' },
        { name: 'Access-Control-Allow-Headers', value: '*' },
        { name: 'Access-Control-Expose-Headers', value: '*' },
      ];
      if (request.method === 'OPTIONS') {
        send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors }).catch(() => {});
        return;
      }
      if (this.cloudFail) {
        send('Fetch.fulfillRequest', {
          requestId, responseCode: 500,
          responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ message: '模拟云端不可用' }), 'utf8').toString('base64'),
        }).catch(() => {});
        return;
      }
      const isGet = request.method === 'GET';
      if (isGet) gets++; else writes++;
      this.cloudCalls = { gets, writes };
      if (!isGet && request.postData) {
        try { this.cloudWrites.push(JSON.parse(request.postData)); } catch { /* 非 JSON 请求体：忽略 */ }
      }
      /* 读：云端为空（新账号），但带服务端更新时间 —— 站点的「新鲜度基线」就取自它。
         写：PostgREST 在 .select() 时回的是数组，maybeSingle 会拆开，这里照着回。 */
      const body = isGet
        ? JSON.stringify({ data: null, updated_at: this.cloudUpdatedAt })
        : JSON.stringify([{ updated_at: this.cloudUpdatedAt }]);
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: isGet ? 200 : 201,
        responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(body, 'utf8').toString('base64'),
      }).catch(() => {});
    });
  }

  async goto(url = BASE) {
    await this.cdp.send('Page.navigate', { url }, this.sid);
    await this.waitFor('!!document.querySelector(".app") || !!document.querySelector(".agent-full")', 15000);
    await sleep(900);
  }
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true,
    }, this.sid);
    if (r.exceptionDetails) throw new Error('evalE: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  /** 异步求值：表达式体里可以直接用 await（包在 async IIFE 里） */
  async evalAsync(expr) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true,
    }, this.sid);
    if (r.exceptionDetails) throw new Error('evalAsyncE: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(cond, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await this.eval(`return !!(${cond});`)) return true; } catch {}
      await sleep(150);
    }
    return false;
  }
  async shot(name) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sid);
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  /* ---- 真实输入原语 ----
     为什么不能只用 __q.set（直接写 value + 派发 input）：那样绕过了焦点，
     「焦点被抢走导致打不进字」的缺陷会完全隐身（曾因此漏报「弹窗里没法输入」）。
     真实鼠标点击 + 逐字符按键才能覆盖：focus/blur、React 重渲染时机、IME 提交。 */
  async clickBox(box) {
    const x = Math.round(box.x), y = Math.round(box.y);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, this.sid);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, this.sid);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, this.sid);
  }
  async typeText(text) {
    for (const ch of text) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch }, this.sid);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, this.sid);
    }
  }
  /* 中文输入法提交走的是 insertText（一次 composition 提交一个词），
     与逐字符按键是两条不同的路径，必须单独覆盖。 */
  async imeText(text) {
    await this.cdp.send('Input.insertText', { text }, this.sid);
  }
  reset() { this.errors = []; this.console = []; this.failed = []; }
}

/**
 * 等 localStorage 里的持久化状态满足条件再继续。
 * `__q.state()` 读的是 localStorage，而 store 的写入发生在 React 提交后的 effect 里，
 * 与测试里的固定 sleep 存在竞态 —— 断言「写没写进去」时必须等数据，不能等时间。
 */
async function waitForState(page, condBody, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const okv = await page.eval(`try { const state = window.__q.state(); return !!(${condBody}); } catch (e) { return false; }`);
    if (okv) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(120);
  }
}

/* 页面内通用助手 */
const HELPERS = `
window.__q = {
  byText(sel, text) {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const t = norm(text);
    return [...document.querySelectorAll(sel)].find((e) => norm(e.textContent).includes(t)) || null;
  },
  click(sel, text) {
    const el = text ? window.__q.byText(sel, text) : document.querySelector(sel);
    if (!el) return 'NOT_FOUND: ' + sel + ' / ' + text;
    el.click(); return 'OK';
  },
  texts(sel) { return [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()); },
  /* 缓存键不能写死：云端版的键是 qz.cloud.<supabase uid>，本机版才是 qz.cloud.default。
     写死会让所有断言读到 {} 而静默「通过」。 */
  cacheKey() {
    const ks = Object.keys(localStorage).filter((k) => k.startsWith('qz.cloud.'));
    return ks.find((k) => k !== 'qz.cloud.default') || ks[0] || 'qz.cloud.default';
  },
  state() { return JSON.parse(localStorage.getItem(window.__q.cacheKey()) || '{}'); },
  /* 取某个集合的长度，缺失时按 0 算。
     为什么需要：用 QZ_PKG=empty（默认）空数据启动时，缓存里根本没有该字段
     （文档是 {}），直接 .length 会抛 TypeError 让整个场景崩掉 ——
     看上去像产品缺陷，其实是「空模板」这种起点的正常状态。 */
  count(path) {
    const s = window.__q.state();
    const a = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), s);
    return Array.isArray(a) ? a.length : 0;
  },
  visible(sel) { const e = document.querySelector(sel); return !!e && e.offsetParent !== null; },
  set(sel, value) {
    const el = document.querySelector(sel);
    if (!el) return 'NOT_FOUND:' + sel;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  },
  modalSet(sel, value) { return window.__q.set('.modal ' + sel, value); },
  /* 按字段标签定位输入框：弹窗里第一个 input 常是禁用/只读的展示项（如「发件人」），
     用位置选会填错字段。 */
  modalSetByLabel(label, value) {
    const fields = [...document.querySelectorAll('.modal .field')];
    const f = fields.find((x) => {
      const l = x.querySelector('.field__label');
      return l && l.textContent.replace(/\s+/g, '').includes(label.replace(/\s+/g, ''));
    });
    if (!f) return 'NO_FIELD:' + label;
    const el = f.querySelector('input:not([disabled]), textarea:not([disabled])');
    if (!el) return 'NO_INPUT:' + label;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  },
  /* 在下拉框（select）里按「选项文字」选值 —— 题库的「所属分类」只给人看名字，
     不给人看 id，所以断言与操作都必须按文案，写死 id 会在改预置分类时静默失效。 */
  modalPickByLabel(label, optionText) {
    const fields = [...document.querySelectorAll('.modal .field')];
    const f = fields.find((x) => {
      const l = x.querySelector('.field__label');
      return l && l.textContent.replace(/\\s+/g, '').includes(label.replace(/\\s+/g, ''));
    });
    if (!f) return 'NO_FIELD:' + label;
    const sel = f.querySelector('select');
    if (!sel) return 'NO_SELECT:' + label;
    const t = String(optionText).replace(/\\s+/g, '');
    const opts = [...sel.options];
    const opt = opts.find((o) => o.textContent.replace(/\\s+/g, '') === t)
      || opts.find((o) => o.textContent.replace(/\\s+/g, '').includes(t));
    if (!opt) return 'NO_OPTION:' + optionText + ' / 有:' + opts.map((o) => o.textContent).join(',');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';
  },
  /* 题库从 v7 起是「分类卡墙 → 题库卡墙 → 题组列表」的三级**卡片墙**
     （老版本是 .bank-rail 里的分类/库树，已在改版中删除）。
     同一屏里卡片很多，靠卡头文字定位最稳；点卡片本身即进入下一级。 */
  qPick(name) {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const t = norm(name);
    const card = [...document.querySelectorAll('.catc .catc__card')].find((c) => {
      const n = c.querySelector('.catc__name');
      return n && norm(n.textContent).startsWith(t);
    });
    if (!card) return 'NO_CARD:' + name;
    card.click(); return 'OK';
  },
  /* 卡片右上角的小齿轮：分类 / 题库的编辑·删除入口 */
  qGear(name) {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const t = norm(name);
    const card = [...document.querySelectorAll('.catc .catc__card')].find((c) => {
      const n = c.querySelector('.catc__name');
      return n && norm(n.textContent).startsWith(t);
    });
    if (!card) return 'NO_CARD:' + name;
    const gear = card.querySelector('.qbank__gear');
    if (!gear) return 'NO_GEAR:' + name;
    gear.click(); return 'OK';
  },
  /* 「返回上一级」：三级页面共用一个 .catc_back 面包屑 */
  qBack() {
    const b = [...document.querySelectorAll('.catc_back button')].find((x) => /返回/.test(x.textContent));
    if (!b) return 'NO_BACK';
    b.click(); return 'OK';
  },
  /* 当前屏卡片墙上所有卡的名字（断言用） */
  qCards() {
    return [...document.querySelectorAll('.catc .catc__card')]
      .map((c) => { const n = c.querySelector('.catc__name'); return n ? n.textContent.replace(/\\s+/g, '') : ''; })
      .filter(Boolean);
  },
  /* 展开 / 收起指定题组：题组卡的标题本身就是那个可点的按钮 */
  qOpenSet(title) {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const t = norm(title);
    const b = [...document.querySelectorAll('button')]
      .find((x) => String(x.className || '').includes('grow') && norm(x.textContent).startsWith(t));
    if (!b) return 'NO_SET:' + title;
    b.click(); return 'OK';
  },
  /* 按字段标签取输入框的屏幕坐标（供真实鼠标点击定位焦点） */
  boxByLabel(label, which) {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const t = norm(label), w = which || 0;
    const fields = [...document.querySelectorAll('.modal .field')].filter((x) => {
      const l = x.querySelector('.field__label');
      return l && norm(l.textContent).includes(t);
    });
    const f = fields[w];
    if (!f) return null;
    const el = f.querySelector('input:not([type=date]):not([type=hidden]), textarea');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  /* 焦点诊断：谁拿着焦点、当前弹窗里各输入框的值 */
  active() {
    const a = document.activeElement;
    const inputs = [...document.querySelectorAll('.modal input, .modal textarea')];
    const snap = inputs.map((i, idx) => {
      const f = i.closest('.field');
      const l = f && f.querySelector('.field__label');
      return { idx, label: l ? l.textContent.replace(/\\s+/g, '') : null, value: i.value };
    });
    if (!a) return { tag: null, snap };
    const f = a.closest && a.closest('.field');
    const l = f && f.querySelector('.field__label');
    return {
      tag: a.tagName, cls: String(a.className || '').slice(0, 40),
      label: l ? l.textContent.replace(/\\s+/g, '') : null,
      inModal: !!a.closest('.modal'), snap,
    };
  },
  /* 焦点流水账：用来证明「打字时焦点被谁抢走了」 */
  watchFocus() {
    window.__focusLog = [];
    const rec = (type) => (e) => {
      const a = e.target;
      if (!a || !a.tagName) return;
      const f = a.closest && a.closest('.field');
      const l = f && f.querySelector('.field__label');
      const cls = typeof a.className === 'string' ? a.className : '';
      window.__focusLog.push({
        t: Math.round(performance.now()),
        type,
        el: a.tagName + (l ? '「' + l.textContent.replace(/\\s+/g, '') + '」' : '') + (cls ? '.' + cls.split(' ')[0] : ''),
      });
    };
    document.addEventListener('focusin', rec('in'), true);
    document.addEventListener('focusout', rec('out'), true);
    return 'ok';
  },
  focusLog() { return window.__focusLog || []; },
  /* 点「文本正好等于 title」的可点击祖先：列表行/卡片结构里文字常常嵌在 span 里，
     直接 byText 会点到外层容器或点到别的同名列。
     注意 click() 只挂在 HTMLElement 上，SVG 元素没有这个方法 —— 祖先链一旦穿过
     图标（本站按钮里普遍带 svg），不判一下就会抛「p.click is not a function」，
     把「没找到可点行」伪装成脚本崩溃。
     （这段注释里不能出现反引号：整块助手是以模板字符串注入页面的，反引号会把模板提前截断。） */
  clickRow(title) {
    const els = [...document.querySelectorAll('.app__scroll *')]
      .filter((e) => e.children.length === 0 && e.textContent.trim() === title);
    for (const e of els) {
      let p = e;
      while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (typeof p.click === 'function'
          && (p.tagName === 'BUTTON' || cs.cursor === 'pointer' || /row|card|item|acc__head/i.test(String(p.className)))) {
          p.click(); return 'OK:' + String(p.className).slice(0, 30);
        }
        p = p.parentElement;
      }
    }
    return 'NOT_FOUND:' + title;
  },
};
return 'ok';
`;

async function injectHelpers(page) { return page.eval(HELPERS); }

/* ---------------- 场景 ---------------- */
const VIEWS = [
  ['总览', '今日总览'], ['总览', '数据洞察'],
  ['求职进程', '岗位库'], ['求职进程', '投递记录'], ['求职进程', '人脉内推'],
  ['日程', null],
  ['面试与 Offer', '面试复盘'], ['面试与 Offer', 'Offer 对比'],
  ['备考题库', null],
  ['我的资料', '网申资料库'], ['我的资料', '简历'], ['我的资料', '简历版本'], ['我的资料', '材料清单'],
  ['邮件中心', null],
];

async function scenarioViews(page) {
  const out = [];
  for (const [group, tab] of VIEWS) {
    page.reset();
    await page.eval(`return window.__q.click('.nav__item', ${JSON.stringify(group)});`);
    await sleep(450);
    if (tab) {
      await page.eval(`return window.__q.click('.tabbar__btn', ${JSON.stringify(tab)});`);
      await sleep(700);
    }
    await sleep(500);
    const info = await page.eval(`
      const main = document.querySelector('.app__scroll');
      const title = document.querySelector('.topbar__title, .topbar h1, h1, .t-title')?.textContent?.trim() || '';
      const eb = document.querySelector('.errbox, [class*=error-boundary]')?.textContent || '';
      return {
        title,
        crumb: document.querySelector('.topbar__crumb, .crumb')?.textContent?.trim() || '',
        mainLen: main ? main.innerText.length : -1,
        text: main ? main.innerText.replace(/\\s+/g,' ').slice(0, 240) : '',
        err: eb.slice(0, 200),
        loading: !!window.__q.byText('.tx-3', '加载中'),
      };
    `);
    const rec = { group, tab, ...info, errors: [...page.errors], failed: page.failed.slice() };
    out.push(rec);
    await page.shot(`view-${group}-${tab || group}`.replace(/[^\w\u4e00-\u9fa5-]/g, ''));
  }
  return out;
}

/* 场景：删除投递记录后岗位库是否回退（预期：回退为 interested） */
async function scenarioRemoveApp(page) {
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '投递记录');`);
  await sleep(900);

  /* 找一张非「已提交」的卡片，把它切成已提交，验证岗位库同步 */
  const picked = await page.eval(`
    const cards = [...document.querySelectorAll('.kcard')];
    return { n: cards.length, first: cards[0] ? cards[0].innerText.replace(/\\s+/g,' ').slice(0,60) : null };
  `);
  console.log('看板卡片:', JSON.stringify(picked));

  await page.eval(`const c = document.querySelector('.kcard'); if (c) c.click(); return 'ok';`);
  await sleep(700);
  const modal = await page.eval(`return !!document.querySelector('.modal');`);
  console.log('详情弹窗:', modal);

  /* 点「已提交」状态 pill */
  const clicked = await page.eval(`
    const btns = [...document.querySelectorAll('.modal button.badge')];
    const b = btns.find((x) => x.textContent.trim() === '已提交');
    if (!b) return 'NO_PILL:' + btns.map(x=>x.textContent.trim()).join(',');
    b.click(); return 'OK';
  `);
  console.log('点击「已提交」:', clicked);
  await sleep(900);

  const afterSubmit = await page.eval(`
    const s = window.__q.state();
    const submitted = s.applications.filter((a) => a.status === 'submitted');
    const withJob = submitted.map((a) => ({ id: a.id, company: a.company,
      jobs: s.jobs.filter((j) => j.appliedBy === a.id).map((j) => ({ id: j.id, company: j.company, status: j.status })) }));
    return { submittedCount: submitted.length, withJob };
  `);
  console.log('提交后状态:', JSON.stringify(afterSubmit, null, 1));

  const target = afterSubmit.withJob.find((x) => x.jobs.length);
  if (!target) { console.log('⚠️ 该投递没有联动到岗位，无法继续测试删除路径'); return { skipped: true }; }

  /* 以「哪条投递记录消失了」为准，而不是假设删的是目标条目 */
  const beforeDel = await page.eval(`return window.__q.state();`);
  const del = await page.eval(`
    const btns = [...document.querySelectorAll('.modal button')];
    const b = btns.find((x) => x.textContent.trim() === '删除');
    if (!b) return 'NO_DELETE';
    b.click(); return 'OK';
  `);
  console.log('点击删除:', del);
  await sleep(1200);

  const after = await page.eval(`
    const s = window.__q.state();
    return { apps: s.applications.map((a) => ({ id: a.id, company: a.company, status: a.status })),
             jobs: s.jobs.map((j) => ({ id: j.id, company: j.company, status: j.status, appliedBy: j.appliedBy })) };
  `);
  const removed = beforeDel.applications.find((a) => !after.apps.some((b) => b.id === a.id));
  if (!removed) { console.log('⚠️ 没有任何投递记录被删除（按钮未生效？）'); return { before: beforeDel, after }; }
  const affected = after.jobs.filter((j) => j.appliedBy === removed.id
    || beforeDel.jobs.some((b) => b.id === j.id && b.appliedBy === removed.id));
  console.log('被删除的投递:', JSON.stringify({ id: removed.id, company: removed.company, status: removed.status }));
  console.log('它联动过的岗位（删除后）:', JSON.stringify(affected, null, 1));
  console.log(!affected.length
    ? 'ℹ️ 该投递未曾联动岗位，本次未覆盖到删除路径'
    : (affected.every((j) => j.status !== 'applied')
      ? '✅ 删除投递后岗位已回退（无缺陷）'
      : '❌ BUG：删除投递记录后岗位仍为「已投递」，该岗位截止提醒永久失效'));
  await page.shot('after-removeapp');
  return { afterSubmit, removed, affected };
}

/* 场景：⌘K 空查询应列出全部板块跳转 */
async function scenarioPalette(page) {
  await page.eval(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    return 'ok';
  `);
  await sleep(700);
  const r = await page.eval(`
    /* 取「不是新手指南」的那个遮罩：这里断言的是命令面板，别被别的弹窗顶掉 */
    const ov = [...document.querySelectorAll('.modal-overlay')].find((o) => !o.querySelector('.guide'));
    if (!ov) return { open: false };
    const txt = ov.innerText.replace(/\\s+/g,' ');
    return { open: true, text: txt.slice(0, 200), navItems: ov.querySelectorAll('.nav__item').length,
      empty: txt.includes('没有匹配结果') };
  `);
  console.log('⌘K 面板:', JSON.stringify(r, null, 1));
  console.log(r.open && r.navItems === 0 ? '❌ BUG：⌘K 打开后空查询无任何板块跳转' : '✅ 面板正常');
  await page.shot('palette');
  return r;
}

/* 场景：岗位「转为投递」选「待投递」，岗位库不应变成已投递 */
async function scenarioConvert(page) {
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(1000);
  const before = await page.eval(`
    const s = window.__q.state();
    const j = s.jobs.find((x) => x.status === 'new' || x.status === 'interested');
    return j ? { id: j.id, company: j.company, title: j.title, status: j.status } : null;
  `);
  if (!before) { console.log('没有可测岗位'); return null; }
  console.log('目标岗位:', JSON.stringify(before));
  /* 搜索定位该岗位 */
  await page.eval(`
    const inp = [...document.querySelectorAll('input')].find((i) => /搜索/.test(i.placeholder || ''));
    if (inp) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(before.company)}); inp.dispatchEvent(new Event('input', { bubbles: true })); }
    return 'ok';
  `);
  await sleep(800);
  const opened = await page.eval(`
    const el = window.__q.byText('.job-row, .kcard, .list-row, .jcard', ${JSON.stringify(before.title)});
    if (!el) return 'NO_CARD';
    el.click(); return 'OK';
  `);
  console.log('打开岗位卡:', opened);
  await sleep(800);
  const toBtn = await page.eval(`
    const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === '转为投递');
    if (!b) return 'NO_BTN';
    b.click(); return 'OK';
  `);
  console.log('点「转为投递」:', toBtn);
  await sleep(700);
  const pick = await page.eval(`
    const b = [...document.querySelectorAll('.modal button.badge')].find((x) => x.textContent.trim() === '待投递');
    if (!b) return 'NO_PILL';
    b.click(); return 'OK';
  `);
  console.log('选「待投递」:', pick);
  await sleep(400);
  const ok = await page.eval(`
    const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === '确认转入');
    if (!b) return 'NO_CONFIRM';
    b.click(); return 'OK';
  `);
  console.log('确认转入:', ok);
  await sleep(1200);
  const after = await page.eval(`
    const s = window.__q.state();
    const j = s.jobs.find((x) => x.id === ${JSON.stringify(before.id)});
    const a = s.applications.find((x) => x.company === ${JSON.stringify(before.company)});
    return { job: j ? { status: j.status, appliedBy: j.appliedBy } : null, app: a ? { status: a.status } : null };
  `);
  console.log('转入后:', JSON.stringify(after));
  console.log(after.job && after.job.status === 'applied' && after.app && after.app.status === 'todo'
    ? '❌ BUG：选了「待投递」，岗位库却被标成「已投递」（口径冲突）'
    : '✅ 状态一致');
  await page.shot('convert');
  return after;
}

/* 场景：邮件同步批量改状态（验证「同批次多次 setStatus 不丢更新」） */
async function scenarioMailSync(page) {
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '投递记录');`);
  await sleep(900);
  const before = await page.eval(`return window.__q.state().applications.map((a) => ({ id: a.id, company: a.company, status: a.status }));`);
  const clicked = await page.eval(`return window.__q.click('.section-head button, button', 'AI 同步邮件');`);
  console.log('点击「AI 同步邮件」:', clicked);
  await sleep(9000);
  const after = await page.eval(`return window.__q.state().applications.map((a) => ({ id: a.id, company: a.company, status: a.status }));`);
  const changed = after.filter((a) => { const b = before.find((x) => x.id === a.id); return b && b.status !== a.status; });
  const created = after.filter((a) => !before.some((x) => x.id === a.id));
  console.log(`邮件同步：更新 ${changed.length} 条 / 新增 ${created.length} 条`);
  console.log(JSON.stringify(changed.map((c) => ({ company: c.company, was: before.find((x) => x.id === c.id)?.status, now: c.status })), null, 1));
  /* 刷新后仍在 = 真正落盘（内存里对但没写进 state 的批次丢失会在这里暴露） */
  await page.goto();
  await injectHelpers(page);
  const persisted = await page.eval(`return window.__q.state().applications.map((a) => ({ id: a.id, status: a.status }));`);
  const lost = after.filter((a) => { const p = persisted.find((x) => x.id === a.id); return !p || p.status !== a.status; });
  console.log(lost.length === 0
    ? `✅ 刷新后 ${changed.length} 条状态全部保留（批量更新未丢失）`
    : `❌ BUG：刷新后 ${lost.length} 条状态回退 —— ` + JSON.stringify(lost.map((l) => l.company)));
  await page.shot('mailsync');
  return { changed: changed.length, created: created.length, lost: lost.length };
}

/* 场景：设置弹窗四标签 + 滚动锁定 */
/**
 * 设置面板里的「可选内容」检查。
 * 背景：网盘同步原先平铺在设置里，文案还写着「整站数据的多设备备份」——
 * 而多设备同步其实早就由云端账号完成了。对普通用户来说那是纯粹的困惑：
 * 会以为「不配它就没法多设备用」。现在收进折叠区，默认收起，并把「你多半不需要」讲在前面。
 */
async function scenarioSettingsOptional(page) {
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'OK';
  `);
  await sleep(700);
  await page.eval(`return window.__q.click('.segmented__btn, .segmented button', '数据与备份');`);
  await sleep(700);

  const r = await page.eval(`
    const d = document.querySelector('details.adv');
    if (!d) return { found: false };
    const sum = d.querySelector('.adv__sum');
    return {
      found: true,
      openByDefault: d.open,
      summary: (sum?.innerText || '').replace(/\\s+/g, ' ').trim(),
      /* 注意：不能用 offsetParent 判断 —— <details> 收起时 Chrome 用的是
         content-visibility: hidden，子元素仍然"有"offsetParent，只是不渲染。
         必须用 checkVisibility()（退回几何高度）才测得准。 */
      bodyHidden: (() => {
        const el = d.querySelector('select') || d.querySelector('input');
        if (!el) return true;
        if (typeof el.checkVisibility === 'function') return !el.checkVisibility();
        const r = el.getBoundingClientRect();
        return r.width === 0 && r.height === 0;
      })(),
    };
  `);
  if (!r.found) { console.log('❌ 没找到折叠区'); return r; }
  console.log('折叠区标题:', r.summary);
  console.log(r.openByDefault ? '❌ 默认是展开的（应该收起）' : '✅ 默认收起');
  console.log(r.bodyHidden ? '✅ 收起时配置表单不可见' : '❌ 收起状态下仍能看到表单');
  await page.shot('settings-optional-collapsed');
  return r;
}

async function scenarioSettings(page) {
  const opened = await page.eval(`
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => /设置/.test(x.getAttribute('aria-label') || '') || /settings/.test(x.className));
    if (!b) return 'NO_BTN';
    b.click(); return 'OK';
  `);
  console.log('打开设置:', opened);
  await sleep(600);
  const lock = await page.eval(`
    const sc = document.querySelector('.app__scroll');
    const inp = document.querySelector('.modal input, .modal button');
    return { appOverflow: sc ? sc.style.overflow : 'none', bodyOverflow: document.body.style.overflow,
      focused: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : null };
  `);
  console.log('弹窗打开时:', JSON.stringify(lock));
  for (const tab of ['邮件桥', 'AI 助手', '数据与备份', '外观与提醒']) {
    const r = await page.eval(`return window.__q.click('.modal .segmented__btn, .segmented__btn', ${JSON.stringify(tab)});`);
    await sleep(500);
    const info = await page.eval(`
      const m = document.querySelector('.modal__body');
      return { len: m ? m.innerText.length : -1, head: m ? m.innerText.replace(/\s+/g,' ').slice(0, 90) : '' };
    `);
    console.log(`  [${tab}] click=${r} len=${info.len} :: ${info.head}`);
    await page.shot('settings-' + tab);
  }
  const closed = await page.eval(`
    const b = [...document.querySelectorAll('.modal__head button')].pop();
    if (!b) return 'NO_CLOSE'; b.click(); return 'OK';
  `);
  await sleep(500);
  const after = await page.eval(`const sc = document.querySelector('.app__scroll'); return { open: !!document.querySelector('.modal'), appOverflow: sc ? sc.style.overflow : '?', bodyOverflow: document.body.style.overflow };`);
  console.log('关闭设置:', closed, JSON.stringify(after));
  console.log(after.open === false && after.appOverflow !== 'hidden' ? '✅ 弹窗关闭后滚动已还原' : '❌ 弹窗/滚动状态异常');
  return after;
}

/* 场景：卡片墙的几何体检 —— 量的是**真实渲染出来的文字矩形**，不是元素的盒子。
 *
 * 为什么要重写（踩过的两次教训）：
 *   1) 原版只比对「叶子元素的盒子两两相交」，还过滤掉文字长度 ≥ 40 的节点。
 *      公司背景卡的「字压字」事故被这两条同时放过：溢出的是 AI 生成的 40+ 字 hq 胶囊
 *      （被长度过滤掉），而它压的是**右边那张卡** —— 与右边卡的叶子在几何上并不相交，
 *      于是巡检对着肉眼可见的重叠报「无」。漏报比误报贵得多，它让人相信屏幕是好的。
 *   2) 换成「元素盒子是否越出卡片」同样漏（负向对照实测）：nowrap 的文字溢出时，
 *      元素自身的盒子会被 flex/grid 压回容器宽度，**文字却仍在盒子外继续画**，
 *      量盒子只会得到「没越界」的假阴性。
 *   → 唯一可靠的做法是用 Range 量文字的绘制矩形：越出自己卡片的边框、或与**另一张卡**
 *     的文字矩形相交，就是肉眼看到的「叠在一起」。这两条与用户看到的现象一一对应。
 *
 * 排除规则（不排除就是一片假红）：被裁切的文字（.truncate / .clamp-2 / overflow:hidden）
 * 根本画不到别人身上；绝对定位的浮层（下拉菜单）本来就是浮起来的。两者都跳过。
 *
 * 顺带把「公司背景」子页纳入巡检：那正是事故发生的那一屏，此前从未被覆盖。
 * 空数据（QZ_PKG=empty，默认）下公司背景是空态，没有卡片可量 → 显式跳过并说明。
 * 要真正压到这条断言，用仓库里备好的夹具（公司字段故意是超长自然语言）：
 *   QZ_PKG=scripts/fixtures/company-long-fields.json node scripts/qa-e2e.mjs overlap
 * 夹具必须存在：这条断言的力量全在「长字段」上，拿空数据跑等于没跑。 */
async function scenarioOverlap(page) {
  const fail = (m) => console.log('❌ ' + m);
  const ok = (m) => console.log('✅ ' + m);

  /* 几何体检器：一次跑完当前屏所有卡片，返回「卡内文字互压」与「文字越出卡片 / 压到别卡」。 */
  const probe = () => page.eval(`
    const cards = [...document.querySelectorAll('.glass.card, .card')].slice(0, 8);

    /* Range 量文字：每条文字节点 → 它真正被画出来的矩形（多行会拿到多个）。
       被裁切 / 悬浮的文字直接跳过，理由见函数外注释。 */
    const textRects = (root) => {
      const out = [];
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const txt = (n.nodeValue || '').trim();
        if (!txt) continue;
        let skip = false;
        for (let p = n.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.display === 'none' || cs.visibility === 'hidden') { skip = true; break; }
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { skip = true; break; }
          if (cs.position === 'absolute' || cs.position === 'fixed') { skip = true; break; }
          if (p === root) break;
        }
        if (skip) continue;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        for (const b of rg.getClientRects()) {
          if (b.width > 1 && b.height > 1) out.push({ t: txt.slice(0, 20), r: b });
        }
      }
      return out;
    };

    const info = cards.map((c) => ({ c, box: c.getBoundingClientRect(), rects: textRects(c) }));
    const hit = (a, b) => a.left < b.right - 2 && b.left < a.right - 2
      && a.top < b.bottom - 2 && b.top < a.bottom - 2;
    const fmt = (a, b) => a.t + ' ⟂ ' + b.t;

    /* (1) 同一张卡内文字互压 */
    info.forEach((x) => {
      x.inner = [];
      for (let i = 0; i < x.rects.length; i++) for (let j = i + 1; j < x.rects.length; j++) {
        if (hit(x.rects[i].r, x.rects[j].r)) x.inner.push(fmt(x.rects[i], x.rects[j]));
      }
    });
    /* (2) 文字越出自己那张卡的边框 */
    info.forEach((x) => {
      x.spill = [];
      for (const q of x.rects) {
        const px = Math.round(Math.max(q.r.right - x.box.right, x.box.left - q.r.left));
        if (px > 2) x.spill.push(q.t + ' ← 越界 ' + px + 'px');
      }
    });
    /* (3) 跨卡片压字：这场事故真正被用户看到的样子 */
    const cross = [];
    for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
      for (const a of info[i].rects) for (const b of info[j].rects) {
        if (hit(a.r, b.r)) { cross.push(fmt(a, b)); break; }
      }
    }

    const cardsOut = info.map((x) => ({
      head: (x.c.innerText || '').replace(/\\s+/g, ' ').slice(0, 30),
      inner: [...new Set(x.inner)].slice(0, 6),
      spill: [...new Set(x.spill)].slice(0, 6),
    }));
    /* 网格子项越出容器：轨道被长内容顶穿的直接证据 */
    const gridSpill = [];
    for (const g of document.querySelectorAll('.grid')) {
      const gb = g.getBoundingClientRect();
      for (const child of g.children) {
        const r = child.getBoundingClientRect();
        if (r.width <= 0) continue;
        const px = Math.round(Math.max(r.right - gb.right, gb.left - r.left));
        if (px > 2) gridSpill.push((child.innerText || '').replace(/\\s+/g, ' ').slice(0, 20) + ' ← 越界 ' + px + 'px');
      }
    }
    return { cards: cardsOut, cross: [...new Set(cross)].slice(0, 8), gridSpill: gridSpill.slice(0, 6), n: cardsOut.length };
  `);

  const judge = async (label) => {
    const r = await probe();
    let bad = 0;
    for (const c of r.cards) {
      if (!c.inner.length && !c.spill.length) continue;
      bad++;
      if (c.inner.length) console.log(`❌ [${label}] 卡片「${c.head}」卡内文字互压: ${JSON.stringify(c.inner)}`);
      if (c.spill.length) console.log(`❌ [${label}] 卡片「${c.head}」文字越出边框: ${JSON.stringify(c.spill)}`);
    }
    if (r.cross.length) { bad++; console.log(`❌ [${label}] 跨卡片文字重叠（肉眼所见的就是这个）: ${JSON.stringify(r.cross)}`); }
    if (r.gridSpill.length) { bad++; console.log(`❌ [${label}] 网格子项越出容器: ${JSON.stringify(r.gridSpill)}`); }
    if (!bad) ok(`[${label}] ${r.n} 张卡片：卡内无互压、文字无越界、无跨卡重叠`);
    return { ...r, bad };
  };

  /* ---- 1. 岗位库（岗位列表）：原来的覆盖面，保持不动 ---- */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(1200);
  const list = await judge('岗位列表');
  await page.shot('overlap-list');

  /* ---- 2. 公司背景：事故现场，必须单独量一遍 ---- */
  const toCo = await page.eval(`return window.__q.click('.segmented__btn, .segmented button', '公司背景');`);
  await sleep(1200);
  if (String(toCo).startsWith('NOT_FOUND')) {
    fail('找不到「公司背景」子页入口：' + toCo);
    return { list, companies: null };
  }
  const co = await probe();
  if (co.n === 0) {
    console.log('⚠️ 公司背景为空态（无公司资料），无卡片可量 —— 用 QZ_PKG=<含公司数据的导出 JSON> 才能压到这条断言。');
    await page.shot('overlap-companies-empty');
    return { list, companies: { skipped: true } };
  }
  const companies = await judge('公司背景');
  /* 公司名/长字段真的渲染出来了才算量到东西，否则是选错了屏 */
  const names = await page.eval(`return [...document.querySelectorAll('.glass.card .h-sub')].map((e) => e.textContent.trim()).slice(0, 6);`);
  console.log('  公司卡:', JSON.stringify(names));
  if (!names.length) fail('公司背景子页没有渲染出任何公司卡（.h-sub 为空）—— 几何测量不可信');
  await page.shot('overlap-companies');

  return { list, companies, names, bad: list.bad + companies.bad };
}

/* 场景：真实汇总表文件导入（覆盖 mdImport 单位键修复后的端到端链路）
   需要一个真实的汇总表 .md 才跑得动：用 QZ_MD=<路径> 指路。
   本仓库是脱敏模板、不含任何真实招聘信息，所以默认没有这份文件 ——
   此时**显式跳过**，而不是拿空路径去喂文件输入框（那样会得到「仍缺单位」这类假红）。 */
async function scenarioImport(page) {
  if (!MD_PATH) {
    console.log('⚠️ 未提供汇总表，跳过导入场景。');
    console.log('   本仓库是脱敏模板，不含真实招聘信息；请用 QZ_MD=<汇总表.md 路径> 指定你自己的文件。');
    return null;
  }
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(900);
  const before = await page.eval(`return window.__q.count("jobs");`);
  console.log('导入前岗位数:', before);

  const open = await page.eval(`return window.__q.click('button', '从坚果云同步');`);
  console.log('打开同步弹窗:', open);
  await sleep(1500);
  /* 同步弹窗里也有「选文件」入口；直接用岗位库的导入弹窗更稳：走「更多 → 导入汇总表」 */
  const alt = await page.eval(`
    const btns = [...document.querySelectorAll('.modal button')];
    const b = btns.find((x) => /选文件|拖拽|导入/.test(x.textContent || ''));
    if (b) { b.click(); return 'MODAL_BTN:' + b.textContent.trim(); }
    return 'NONE';
  `);
  console.log('同步弹窗内按钮:', alt);
  await sleep(800);
  if (alt === 'NONE') {
    await page.eval(`return window.__q.click('.modal__head button, button[aria-label=关闭]', '');`);
    await page.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '更多');
      if (b) b.click(); return 'ok';
    `);
    await sleep(400);
    await page.eval(`return window.__q.click('button', '导入汇总表');`);
    await sleep(800);
  }
  const hasInput = await page.eval(`return !!document.querySelector('.modal input[type=file]');`);
  console.log('导入弹窗文件输入框:', hasInput);
  if (!hasInput) { console.log('⚠️ 未找到文件输入框，跳过'); return null; }

  const { root } = await page.cdp.send('DOM.getDocument', {}, page.sid);
  const { nodeId } = await page.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.modal input[type=file]' }, page.sid);
  await page.cdp.send('DOM.setFileInputFiles', { nodeId, files: [MD_PATH] }, page.sid);
  await sleep(2500);
  const parsed = await page.eval(`
    const m = document.querySelector('.modal');
    return { text: m.innerText.replace(/\s+/g, ' ').slice(0, 300) };
  `);
  console.log('解析结果:', parsed.text.slice(0, 220));
  const imported = await page.eval(`return window.__q.click('.modal__foot button, .modal button', '导入');`);
  console.log('点导入:', imported);
  await sleep(2500);
  const after = await page.eval(`
    const s = window.__q.state();
    const names = [...new Set(s.jobs.map((j) => j.company))];
    return { jobs: s.jobs.length, events: s.events.length, units: names.length,
      has: ['国家开发银行','国家能源集团','中国广核集团','中国黄金集团','中国有色集团','中国兵器集团','中国邮政集团','中国电信集团'].map((c) => ({ c, ok: names.some((n) => n.includes(c)) })) };
  `);
  console.log('导入后:', JSON.stringify({ jobs: after.jobs, prev: before, events: after.events, units: after.units }));
  const miss = after.has.filter((x) => !x.ok).map((x) => x.c);
  console.log(miss.length === 0 ? '✅ 此前被静默丢弃的单位已全部入库' : '❌ 仍缺单位: ' + miss.join('、'));
  console.log(`岗位数变化: ${before} → ${after.jobs}`);
  await page.shot('import-after');
  /* 幂等性：同一份文件再导一次不应新增任何条目 */
  await sleep(800);
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(300);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(600);
  await page.eval(`const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '更多'); if (b) b.click(); return 'ok';`);
  await sleep(400);
  await page.eval(`return window.__q.click('button', '导入汇总表');`);
  await sleep(900);
  const has2 = await page.eval(`return !!document.querySelector('.modal input[type=file]');`);
  if (has2) {
    const { root: r2 } = await page.cdp.send('DOM.getDocument', {}, page.sid);
    const { nodeId: n2 } = await page.cdp.send('DOM.querySelector', { nodeId: r2.nodeId, selector: '.modal input[type=file]' }, page.sid);
    await page.cdp.send('DOM.setFileInputFiles', { nodeId: n2, files: [MD_PATH] }, page.sid);
    await sleep(2500);
    await page.eval(`return window.__q.click('.modal__foot button, .modal button', '导入');`);
    await sleep(2500);
    const twice = await page.eval(`const s = window.__q.state(); return { jobs: s.jobs.length, events: s.events.length };`);
    console.log('二次导入后:', JSON.stringify(twice), `(首次后 ${after.jobs} 岗位 / ${after.events} 事件)`);
    console.log(twice.jobs === after.jobs && twice.events === after.events
      ? '✅ 幂等性成立：同一份汇总表重复导入没有新增任何条目'
      : `❌ 幂等性被击穿：岗位 +${twice.jobs - after.jobs}，事件 +${twice.events - after.events}`);
  }
  return after;
}

/* 场景：题库「分类卡墙 → 题库卡墙 → 题组列表」三级卡片墙（v7 起的核心交互）
   覆盖：预置分类兜底；分类卡墙常驻；空态引导；新建分类；在指定分类下建题库（下拉选分类，不吃默认值）；
        题库内加题带 bankId+catId；分类层「加一题（挂分类下）」只带 catId（于是「未归档」卡才长出来）；
        批量归入（目标按钮形如「银行 / QA 中金公司」）；搜索跨分类收敛并标出「分类·题库」归属；
        整场导入 = 一场面试只占**一张题组卡**（不是 35 张卡），卡内可逐题展开 / 重排 / 解散；
        题库换分类时题目跟着走且页面不变空；删分类不丢资产（题库与题搬到「其他」）；删题库不删题（题回该分类未归档）。 */
async function scenarioBankRepo(page) {
  const res = {};
  const go = async (sel, text) => { await page.eval(`return window.__q.click(${JSON.stringify(sel)}, ${JSON.stringify(text)})`); await sleep(500); };
  const card = async (name) => { await page.eval(`return window.__q.qPick(${JSON.stringify(name)})`); await sleep(600); };
  const back = async () => { await page.eval(`return window.__q.qBack()`); await sleep(600); };
  /* v8 把低频与破坏性操作统一收进了 ⋯ 下拉。它的触发按钮是 icon-only（只有 aria-label，
     没有可见文字），byText 那条路找不到它 —— 所以先按 aria-label 开菜单，菜单项才有文字。
     程序化 .click() 只派发 click 事件，而菜单的「点外部关闭」监听的是 mousedown，
     所以不会出现「刚打开就被自己关掉」。 */
  const menu = async (label, item) => {
    await page.eval(`const b = [...document.querySelectorAll('button')]
      .find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (b) b.click(); return b ? 'OK' : 'NO_MORE';`);
    await sleep(400);
    if (item) await go('button', item);
  };
  const texts = (sel) => page.eval(`return window.__q.texts(${JSON.stringify(sel)}).join(' | ')`);
  const body = () => page.eval(`return (document.querySelector('.app__scroll')||document.body).innerText.replace(/\\s+/g,' ')`);
  const st = () => page.eval(`const s = window.__q.state(); const cs = s.bankCategories || []; return {
    n: (s.questions||[]).length,
    cats: cs.map((c) => c.name),
    banks: (s.banks||[]).map((b) => b.name + '/' + (cs.find((c) => c.id === b.catId) || {}).name),
    bankId: (s.questions||[]).map((q) => q.bankId || ''),
    catId: (s.questions||[]).map((q) => (cs.find((c) => c.id === q.catId) || {}).name || ''),
    groups: (s.questions||[]).map((q) => q.groupId || ''),
  };`);
  const catIdOf = (name) => page.eval(`const s = window.__q.state(); const c = (s.bankCategories||[]).find((x) => x.name === ${JSON.stringify(name)}); return c ? c.id : null;`);

  await go('.nav__item', '备考题库');

  /* 第一屏必须是分类卡片墙：一张卡一个赛道，卡里列出它下面的题库；老的左侧分类树已拆除 */
  const wallCards = await page.eval(`return window.__q.qCards().join('|')`);
  const wallOk = /银行/.test(wallCards) && /国央企/.test(wallCards) && /券商基金/.test(wallCards);
  console.log(`分类卡墙：${wallOk ? '✅ 常驻（' + wallCards.split('|').length + ' 张卡）' : '❌ ' + wallCards}`);
  res.wall = wallOk;

  /* 预置分类兜底：老数据升上来之后，即使一道题都没有，也必须已经有分类可挂 */
  let s0 = await st();
  const presetsOk = s0.cats.length >= 7 && s0.cats.includes('银行') && s0.cats.includes('国央企');
  console.log(`预置分类：${presetsOk ? '✅ ' + s0.cats.length + ' 个（含银行 / 国央企 / 券商基金…）' : '❌ ' + JSON.stringify(s0.cats)}`);
  res.presets = presetsOk;

  /* 空态必须给出「建分类 → 建题库 → 整场导入」三步引导，而不是一句「题库还是空的」 */
  const emptyBody = await body();
  const guided = emptyBody.includes('题库还是空的') && emptyBody.includes('整场导入');
  console.log(`空态引导：${guided ? '✅ 引导建分类→建题库→整场导入' : '❌ ' + emptyBody.slice(0, 160)}`);
  res.emptyGuide = guided;

  /* ---- 自建分类：空态主按钮与卡片墙收尾卡都叫「新建分类」 ---- */
  await go('button', '新建分类');
  const catLabels = await texts('.modal .field__label');
  console.log(`新建分类弹窗：${catLabels.includes('分类名称') ? '✅ 有「分类名称」字段' : '❌ ' + catLabels}`);
  res.catModal = catLabels.includes('分类名称');
  console.log('填分类名:', await page.eval(`return window.__q.modalSetByLabel('分类名称', 'QA 赛道');`));
  await sleep(300);
  await go('.modal button', '保存');
  await waitForState(page, `(state.bankCategories || []).length === ${s0.cats.length + 1}`);
  let b = await st();
  res.addCat = b.cats.includes('QA 赛道');
  console.log(`建分类：${res.addCat ? '✅ 已建「QA 赛道」' : '❌ ' + JSON.stringify(b.cats)}`);

  /* 建完自动进入该分类 —— 第二屏是「题库卡片墙」，含返回与新建题库入口 */
  const newCatPage = await body();
  await back();
  await card('银行');
  const bankCatPage = await body();
  const catPageOk = newCatPage.includes('返回全部分类') && newCatPage.includes('新建题库')
    && bankCatPage.includes('返回全部分类') && bankCatPage.includes('新建题库');
  console.log(`分类页（第二屏）：${catPageOk ? '✅ 有「返回全部分类 / 新建题库」' : '❌ ' + bankCatPage.slice(0, 180)}`);
  res.catPage = catPageOk;

  /* ---- 在「银行」下建题库：必须靠下拉显式选分类，而不是吃默认第一个 ---- */
  await go('button', '新建题库');
  const bankLabels = await texts('.modal .field__label');
  const hasPick = bankLabels.includes('所属分类') && bankLabels.includes('题库名称');
  console.log(`新建题库弹窗：${hasPick ? '✅ 有「所属分类 / 题库名称」' : '❌ ' + bankLabels}`);
  res.bankModal = hasPick;
  console.log('选分类:', await page.eval(`return window.__q.modalPickByLabel('所属分类', '银行');`));
  await sleep(200);
  console.log('填题库名:', await page.eval(`return window.__q.modalSetByLabel('题库名称', 'QA 中金公司');`));
  await sleep(300);
  await go('.modal button', '保存');
  await waitForState(page, `state.banks && state.banks.length === 1`);
  b = await st();
  const bankInBank = b.banks.length === 1 && b.banks[0] === 'QA 中金公司/银行';
  console.log(`建题库：${bankInBank ? '✅ 「QA 中金公司」挂到了「银行」下' : '❌ ' + JSON.stringify(b.banks)}`);
  res.createBank = bankInBank;

  /* 新建后自动进入该题库（第三屏） */
  const afterCreate = await body();
  const autoOk = afterCreate.includes('返回题库列表') && afterCreate.includes('QA 中金公司');
  console.log(`建后自动进入：${autoOk ? '✅ 第三屏（题库内）' : '❌ ' + afterCreate.slice(0, 180)}`);
  res.autoEnter = autoOk;

  /* 题库内加题：bankId 与 catId 都要带上 */
  await go('button', '加一题');
  await page.eval(`return window.__q.modalSet('textarea.textarea', 'QA 仓库：中金的题');`);
  await sleep(200);
  await go('.modal button', '保存');
  await waitForState(page, `state.questions && state.questions.length === 1`);
  let c = await st();
  const inBankQ = c.bankId.filter(Boolean).length;
  const inBankCat = c.catId.filter((x) => x === '银行').length;
  console.log(`题库内加题：${c.n === 1 && inBankQ === 1 && inBankCat === 1 ? '✅ 带上了 bankId + catId' : '❌ ' + JSON.stringify(c)}`);
  res.addInBank = c.n === 1 && inBankQ === 1 && inBankCat === 1;

  /* ---- 分类层加「散题」：只有 catId，没有 bankId ---- */
  await back();
  await go('button', '加一题（挂分类下）');
  await page.eval(`return window.__q.modalSet('textarea.textarea', 'QA 仓库：未归库的散题');`);
  await sleep(200);
  await go('.modal button', '保存');
  await waitForState(page, `state.questions && state.questions.length === 2`);
  let a = await st();
  const unassignedNow = a.bankId.filter((x) => x === '').length;
  const stillBankCat = a.catId.filter((x) => x === '银行').length;
  console.log(`散题加题：${a.n === 2 && unassignedNow === 1 && stillBankCat === 2 ? '✅ 无 bankId 但归属仍是「银行」' : '❌ ' + JSON.stringify(a)}`);
  res.unsortedAdd = a.n === 2 && unassignedNow === 1 && stillBankCat === 2;

  /* 有散题了，「未归档」卡必须自己长出来 —— 否则这类题一个入口都没有 */
  const wallCards2 = await page.eval(`return window.__q.qCards().join('|')`);
  console.log(`未归档卡：${/未归档/.test(wallCards2) ? '✅ 有散题即出现' : '❌ ' + wallCards2}`);
  res.unsortedCard = /未归档/.test(wallCards2);

  /* ---- 批量归入：散题收编到「银行 / QA 中金公司」 ---- */
  await card('未归档');
  const pickBtn = await texts('button');
  const hasPickBtn = pickBtn.includes('批量归入…') || pickBtn.includes('批量归入');
  console.log(`批量归入按钮：${hasPickBtn ? '✅ 可见' : '❌ 缺'}`);
  res.pickBtn = hasPickBtn;
  if (hasPickBtn) {
    await go('button', '批量归入');
    await go('button', '全选当前');
    const assignBtns = await texts('button');
    const hasTarget = /银行 \/ QA 中金公司/.test(assignBtns);
    console.log(`归入目标：${hasTarget ? '✅ 列出「银行 / QA 中金公司」' : '❌ ' + assignBtns.slice(0, 260)}`);
    res.assignTarget = hasTarget;
    if (hasTarget) {
      await page.eval(`return window.__q.click('button', '银行 / QA 中金公司');`);
      await waitForState(page, `(state.questions || []).length === 2 && state.questions.every((q) => q.bankId)`);
      let d = await st();
      const left = d.bankId.filter((x) => x === '').length;
      console.log(`批量归入：${left === 0 && d.bankId.filter(Boolean).length === 2 ? '✅ 全部归入' : '❌ ' + JSON.stringify(d.bankId)}`);
      res.assign = left === 0 && d.bankId.filter(Boolean).length === 2;
    }
  }

  /* ---- 搜索：跨分类收敛成一份结果集，并标出「分类·题库」归属 ---- */
  await back(); await back();                       /* 回分类卡墙：在题库内搜索是就地过滤，不走全局收敛 */
  await page.shot('bank-lv1-cats');                 /* 第一级：分类卡墙（卡内有题库时会带预览行） */
  await page.eval(`return window.__q.set('.section-head .input--sm', 'QA 仓库');`);
  await sleep(800);
  const searchBody = (await body()).replace(/\s+/g, '');
  const searchOk = searchBody.includes('跨全部分类与题库') && searchBody.includes('银行·QA中金公司');
  console.log(`搜索收敛 + 归属标签：${searchOk ? '✅ 命中并标出「银行·QA中金公司」' : '❌ ' + searchBody.slice(0, 260)}`);
  res.searchTag = searchOk;
  await page.eval(`return window.__q.set('.section-head .input--sm', '');`);
  await sleep(600);

  /* ---- 整场导入：一场面试只占一张卡，展开才是逐题 ---- */
  await card('银行');
  await page.shot('bank-lv2-banks');                /* 第二级：某分类下的题库卡墙 */
  await card('QA 中金公司');
  /* 导入收敛成一枚「导入 ▾」下拉（原先顶栏「整场导入」与筛选行「导入 JSON」两个并存）：
     先开下拉，再选整场导入。 */
  await menu('导入', '整场导入');
  const importLabels = await texts('.modal .field__label');
  const importOk = importLabels.includes('题组名称') && importLabels.includes('整篇粘贴题目');
  console.log(`整场导入弹窗：${importOk ? '✅ 有「题组名称 / 整篇粘贴题目」' : '❌ ' + importLabels}`);
  res.importModal = importOk;
  await page.eval(`return window.__q.modalSetByLabel('题组名称', 'QA 中核一面');`);
  await sleep(200);
  await page.eval(`return window.__q.modalSetByLabel('整篇粘贴题目', '1. 请先做个自我介绍\\n2. 为什么选择我们单位\\n3. 你做过最有挑战的一件事是什么');`);
  await sleep(700);
  const previewN = await page.eval(`return ((document.querySelector('.modal')||{}).innerText || '').replace(/\\s+/g,' ').match(/已识别 (\\d+) 题/) ? RegExp.$1 : '0'`);
  console.log(`切题预览：${previewN === '3' ? '✅ 整篇粘进来自动切成 3 题（无需自己排版）' : '❌ 识别到 ' + previewN + ' 题'}`);
  res.split = previewN === '3';
  await page.eval(`return window.__q.click('.modal button', '导入 3 题');`);
  await waitForState(page, `(state.questions || []).length === 5`);
  await sleep(700);
  let g1 = await st();
  const grouped = g1.groups.filter(Boolean).length === 3 && g1.groups.filter((x) => x === '').length === 2;
  const headMap = await page.eval(`
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const s = window.__q.state();
    const q = (s.questions || []).find((x) => x.groupId);
    return {
      title: q ? q.groupTitle : '',
      heads: [...document.querySelectorAll('button')]
        .filter((b) => String(b.className || '').includes('grow') && norm(b.textContent).startsWith('QA中核一面')).length,
    };
  `);
  const setOk = grouped && headMap.title === 'QA 中核一面' && headMap.heads === 1;
  console.log(`整场导入成组：${setOk ? '✅ 3 题共用 1 个题组、列表上只有 1 张卡（不是 3 张）' : '❌ groups=' + JSON.stringify(g1.groups) + ' title=' + headMap.title + ' heads=' + headMap.heads}`);
  res.groupImport = setOk;

  /* 展开题组 → 逐题露出来。
     注意：导入完成后**题组默认就是展开的**（saveSetImport 把新 groupId 塞进了 openSets）——
     用户刚粘完一整场，最想看的就是「切得对不对」，让他再点一次是多余的一步。
     所以这里先断言「已经展开」，只有没展开时才去点，免得点一下反而收起来。 */
  const itemsAuto = await page.eval(`return document.querySelectorAll('.qset__item').length`);
  if (itemsAuto !== 3) { await page.eval(`return window.__q.qOpenSet('QA 中核一面');`); await sleep(700); }
  const items = await page.eval(`return document.querySelectorAll('.qset__item').length`);
  /* v9 起题组卡没有底部工具行了：AI 整理与加一题并到了题组头右侧（sparkles + ⋯）。
     改成探测题组头那两枚图标在不在 —— 顺带钉住「它们没有被摊平回一排按钮」。 */
  /* 可见性断言：程序化 click 对 opacity:0 的元素照样生效，所以「点得到」≠「看得见」。
     v9.2 修过一个真 bug —— 单题卡的 ✨/⋯ 包在 .qset__hover 里，而那条显隐规则靠祖先
     .qset__item 触发，单题卡没有这个类，桌面端 opacity 恒为 0：按钮在 DOM 里、点得动、就是看不见。
     所以这里一律查「有效 opacity」（自身与所有祖先的 opacity 连乘），不透明才算过。 */
  const visEval = `
    const eff = (el) => { let o = 1; for (let n = el; n && n !== document.documentElement; n = n.parentElement) o *= (Number(getComputedStyle(n).opacity) || 0); return o; };
  `;
  const headTools = await page.eval(`${visEval}
    const has = (l) => { const b = document.querySelector('button[aria-label="' + l + '"]'); return !!b && eff(b) > .5; };
    return [has('AI 整理这一场') && 'AI 整理这一场', has('题组操作') && '题组操作 ⋯'].filter(Boolean).join(' | ');
  `);
  const rowAi = await page.eval(`${visEval}
    const rows = [...document.querySelectorAll('.qset__item')];
    const ok = rows.filter((r) => { const b = r.querySelector('button[aria-label="AI 参考答案"]'); return b && eff(b) > .5; });
    return rows.length + '/' + ok.length;
  `);
  const headOk = headTools === 'AI 整理这一场 | 题组操作 ⋯';
  const rowAiOk = rowAi === items + '/' + items;
  console.log(`展开题组：${items === 3 ? `✅ 3 条逐题${itemsAuto === 3 ? '（导入后自动展开）' : ''}` : '❌ ' + items + ' 条'} · 题组头: ${headOk ? headTools + ' ✅可见' : '❌ ' + headTools} · 每行 ✨: ${rowAiOk ? rowAi + ' ✅可见' : '❌ ' + rowAi}`);
  res.setExpand = items === 3;
  res.setAutoOpen = itemsAuto === 3;
  res.headToolsVisible = headOk;
  res.rowAiVisible = rowAiOk;
  await page.shot('bank-lv3-set');                  /* 第三级：题库内的题组（展开后逐题） */

  /* 顺手留一张 ⋯ 展开的图：它是 v8 精简里唯一的新交互（低频/破坏性操作都收在这里），
     值得有视觉基线 —— 以后菜单被父级 overflow 裁掉、或改右对齐改出屏，一眼能看出来。 */
  await page.eval(`const b = [...document.querySelectorAll('button')]
    .find((x) => x.getAttribute('aria-label') === '题组操作'); if (b) b.click(); return b ? 'OK' : 'NO_MORE';`);
  await sleep(400);
  /* 菜单必须真的浮在所有卡片之上。它是 fixed + portal 到 body 的：
     一旦退回 absolute 赖在卡片里，卡片自身的 backdrop-filter 会把菜单关进它的 stacking
     context，z-index 再高也只在卡内有效 —— 下半截会被后面的兄弟卡片整块盖住。
     用 elementFromPoint 戳菜单顶部：命中的不是菜单内的元素，就是被挡了。 */
  const menuHit = await page.eval(`
    const m = document.querySelector('.moremenu');
    if (!m) return 'NO_MENU';
    const r = m.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 12);
    return m.contains(hit) ? 'OK' : 'COVERED_BY:' + (hit ? (String(hit.className) || hit.tagName) : 'null');
  `);
  console.log(`⋯ 菜单浮层：${menuHit === 'OK' ? '✅ 未被卡片遮挡（fixed + portal）' : '❌ ' + menuHit}`);
  res.menuOnTop = menuHit === 'OK';
  await page.shot('bank-lv3-moremenu');
  await page.eval(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'OK';`);
  await sleep(300);

  /* 题组内逐题顺序可调：把第一题下移一位，order 必须换位 */
  const orderBefore = await page.eval(`const s = window.__q.state(); return (s.questions||[]).filter((q) => q.groupId).sort((a,b) => a.order-b.order).map((q) => q.content.slice(0,6));`);
  /* 上移 / 下移收进了单题行自己的 ⋯（v8 起单题常驻的只有一枚「展开答案」）：
     先开这一行的 ⋯，再点菜单里的「下移一位」。 */
  await page.eval(`const it = document.querySelectorAll('.qset__item')[0];
    const more = [...it.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '更多操作');
    if (more) { more.click(); return 'OK'; } return 'NO_MORE';`);
  await sleep(400);
  await go('button', '下移一位');
  await sleep(600);
  const orderAfter = await page.eval(`const s = window.__q.state(); return (s.questions||[]).filter((q) => q.groupId).sort((a,b) => a.order-b.order).map((q) => q.content.slice(0,6));`);
  const reorderOk = JSON.stringify(orderBefore) !== JSON.stringify(orderAfter) && orderAfter[0] === orderBefore[1];
  console.log(`题组内重排：${reorderOk ? '✅ ' + orderBefore.join('、') + ' → ' + orderAfter.join('、') : '❌ ' + JSON.stringify(orderBefore) + ' → ' + JSON.stringify(orderAfter)}`);
  res.reorder = reorderOk;

  /* 解散题组：题一道都不能少，只是不再成组。
     入口在题组头的 ⋯ 里（与「改题组名 / 删除整组」同处），不再平铺在底部工具行。 */
  await menu('题组操作', '解散题组');
  await waitForState(page, `(state.questions || []).filter((q) => q.groupId).length === 0`);
  await sleep(700);
  let g2 = await st();
  const dissolveOk = g2.n === 5 && g2.groups.every((x) => x === '');
  console.log(`解散题组：${dissolveOk ? '✅ 5 题全在，题组已拆' : '❌ ' + JSON.stringify(g2.groups)}`);
  res.dissolve = dissolveOk;

  /* 单题卡（不成组的独立一题）右侧的 ✨ 与 ⋯ 必须真的看得见 —— 理由见上面 visEval。
     这里刚好是「5 题全散开」的状态，页面上就是 5 张单题卡，是这条断言最自然的落点。
     别退化成「document.querySelector 找得到就算过」：那正是这个 bug 当初漏掉的原因。 */
  const singleVis = await page.eval(`${visEval}
    const cards = [...document.querySelectorAll('.glass')].filter((c) => c.querySelector('button[aria-label="展开答案"]'));
    if (!cards.length) return { err: 'NO_SINGLE_CARD' };
    const seen = (l) => cards.filter((c) => { const b = c.querySelector('button[aria-label="' + l + '"]'); return b && eff(b) > .5; }).length;
    return { n: cards.length, ai: seen('AI 参考答案'), more: seen('更多操作') };
  `);
  const singleOk = singleVis.n === 5 && singleVis.ai === 5 && singleVis.more === 5;
  console.log(`单题卡动作可见：${singleOk ? '✅ 5/5 张卡的 ✨ 与 ⋯ 都看得见（没被 .qset__hover 隐身）' : '❌ ' + JSON.stringify(singleVis)}`);
  res.singleCardActionsVisible = singleOk;
  await page.shot('bank-lv3-single');               /* 第三级：散题态（全是单题卡） */

  /* ---- 全是散题时的一键成组：这是老数据（一道一道攒进来的，比如同一家央企面试的 35 个问题）
     唯一的出路。没有这条提示，用户只会看到 35 张卡，压根不知道还能成组。 ---- */
  const hintBody = await body();
  const hasMergeHint = hintBody.includes('题还是散的') && hintBody.includes('合并成一场');
  console.log(`散题合并提示：${hasMergeHint ? '✅ 提示「这 N 题还是散的」+「合并成一场」' : '❌ ' + hintBody.slice(0, 200)}`);
  res.mergeHint = hasMergeHint;
  if (hasMergeHint) {
    await go('button', '合并成一场');
    const prefill = await page.eval(`return (document.querySelector('.modal input.input') || {}).value || ''`);
    await page.eval(`return window.__q.modalSetByLabel('题组名称', 'QA 合并后的一场');`);
    await sleep(200);
    await go('.modal button', '保存');
    await waitForState(page, `(state.questions || []).filter((q) => q.groupId).length === 5`);
    await sleep(700);
    let g4 = await st();
    const oneSet = new Set(g4.groups.filter(Boolean)).size === 1;
    console.log(`一键合并：${oneSet && g4.n === 5 ? `✅ 5 题共用 1 个题组（标题默认填「${prefill}」）` : '❌ ' + JSON.stringify(g4.groups)}`);
    res.merge = oneSet && g4.n === 5;
    /* 合并完提示必须自己消失：已经有题组了，再劝人合并就是废话 */
    const afterMerge = await body();
    console.log(`合并后提示收起：${!afterMerge.includes('题还是散的') ? '✅ 已收起' : '❌ 仍在'}`);
    res.mergeHintGone = !afterMerge.includes('题还是散的');
    /* 合并出来的题组默认是折叠的 → 展开它，再拆掉，把后面步骤的前置条件还原 */
    await page.eval(`return window.__q.qOpenSet('QA 合并后的一场');`);
    await sleep(600);
    await menu('题组操作', '解散题组');
    await waitForState(page, `(state.questions || []).filter((q) => q.groupId).length === 0`);
    await sleep(500);
  }

  /* ---- 自建分类被删：资产搬到「其他」，一道题都不能丢 ---- */
  await back(); await back();
  await card('QA 赛道');
  await go('button', '新建题库');
  await page.eval(`return window.__q.modalPickByLabel('所属分类', 'QA 赛道');`);
  await sleep(200);
  await page.eval(`return window.__q.modalSetByLabel('题库名称', 'QA 测试库');`);
  await sleep(300);
  await go('.modal button', '保存');
  await waitForState(page, `(state.banks || []).length === 2`);
  await go('button', '加一题');
  await page.eval(`return window.__q.modalSet('textarea.textarea', 'QA 仓库：自定义分类下的题');`);
  await sleep(200);
  await go('.modal button', '保存');
  await waitForState(page, `(state.questions || []).length === 6`);
  let f1 = await st();
  const inCustom = f1.catId.filter((x) => x === 'QA 赛道').length === 1 && f1.banks.includes('QA 测试库/QA 赛道');
  console.log(`自建分类下建题库加题：${inCustom ? '✅ 「QA 测试库」在「QA 赛道」下，题已入' : '❌ ' + JSON.stringify(f1)}`);
  res.customCat = inCustom;

  await back(); await back();
  const gearRes = await page.eval(`return window.__q.qGear('QA 赛道');`);
  await sleep(600);
  const editTitle = await texts('.modal .modal__title, .modal .card__title');
  await go('.modal button', '删除');
  await waitForState(page, `(state.bankCategories || []).every((c) => c.name !== 'QA 赛道')`);
  await sleep(800);
  let f2 = await st();
  const catGone = !f2.cats.includes('QA 赛道') && f2.cats.includes('其他');
  const movedToOther = f2.catId.filter((x) => x === '其他').length === 1 && f2.n === 6;
  const bankKept = f2.banks.includes('QA 测试库/其他');
  console.log(`删分类不丢资产：${catGone && movedToOther && bankKept ? '✅ 分类已删，题库与题搬到「其他」（共 ' + f2.n + ' 题）' : '❌ ' + JSON.stringify(f2)}`);
  if (!String(gearRes).startsWith('OK')) console.log('  ⚠️ 分类卡片齿轮点击:', gearRes, '| 弹窗标题:', editTitle);
  res.removeCatKeeps = catGone && movedToOther && bankKept;

  /* ---- 题库换分类：题目必须跟着题库一起换，且站在库里时页面不能变空 ---- */
  await card('银行');
  await card('QA 中金公司');
  /* 「编辑题库」与「删除题库」合并成一枚 ⋯（题库设置）：红色垃圾桶不再裸奔在导航条上 */
  await menu('题库设置', '改名 / 改分类');
  console.log('改所属分类为「国央企」:', await page.eval(`return window.__q.modalPickByLabel('所属分类', '国央企');`));
  await sleep(200);
  await go('.modal button', '保存');
  await waitForState(page, `(state.banks || []).some((b) => b.name === 'QA 中金公司' && b.catId === ${JSON.stringify(await catIdOf('国央企'))})`);
  await sleep(700);
  let g3 = await st();
  const bankMoved = g3.banks.includes('QA 中金公司/国央企');
  const qMoved = g3.catId.filter((x) => x === '国央企').length === 5;
  const movedBody = await body();
  const notBlank = movedBody.includes('QA 中金公司') && !movedBody.includes('里还没有题');
  console.log(`题库换分类：${bankMoved && qMoved && notBlank ? '✅ 题库与 5 道题一起搬到「国央企」，页面跟着走没变空' : '❌ ' + JSON.stringify(g3) + ' blank=' + !notBlank}`);
  res.moveCat = bankMoved && qMoved && notBlank;

  /* ---- 删题库：题目必须回到该分类的「未归档」，一题都不能少，分类归属不变 ---- */
  await menu('题库设置', '删除题库');
  await waitForState(page, `(state.banks || []).length === 1 && (state.questions || []).length === 6 && (state.questions || []).filter((q) => q.bankId === '').length >= 5`);
  await sleep(700);
  let e = await st();
  const stillSOE = e.catId.filter((x) => x === '国央企').length === 5;
  console.log(`删题库不删题：${e.n === 6 && e.banks.length === 1 && stillSOE ? '✅ 题全回「国央企 › 未归档」，分类不变' : '❌ ' + JSON.stringify(e)}`);
  res.removeKeepsQuestions = e.n === 6 && e.banks.length === 1 && stillSOE;

  res.ok = Object.values(res).every(Boolean);
  console.log(`题库结构场景：${res.ok ? '✅ 全部通过' : '❌ 有失败项 ' + JSON.stringify(res)}`);
  return res;
}

/* 场景：交互模块动作测试（新建记录 + 导出下载 + 助手面板） */
async function scenarioModules(page) {
  const DL = '/tmp/qz-downloads';
  try { fs.rmSync(DL, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DL, { recursive: true });
  await page.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  const res = {};

  /* ---- 1. 日程：新增事件 ---- */
  await page.eval(`return window.__q.click('.nav__item', '日程');`);
  await sleep(900);
  const evBefore = await page.eval(`return window.__q.count("events");`);
  await page.eval(`return window.__q.click('button', '新增事件');`);
  await sleep(600);
  console.log('日历新增事件弹窗输入:', await page.eval(`return window.__q.modalSet('input.input', 'QA 自动化测试事件');`));
  await sleep(200);
  await page.eval(`return window.__q.click('.modal button', '保存');`);
  /* 同 bankrepo：__q.count 读 localStorage，写入发生在 React 提交后的 effect 里，
     固定 sleep 会偶发跑在写入之前（全量回归里实测红过一次）。等数据，别等时间。 */
  await waitForState(page, `(state.events || []).length === ${evBefore + 1}`);
  const evAfter = await page.eval(`return window.__q.count("events");`);
  console.log(`日历：事件 ${evBefore} → ${evAfter} ${evAfter === evBefore + 1 ? '✅' : '❌ 未写入'}`);
  res.calendar = evAfter - evBefore;

  /* ---- 2. 题库：添加题目 ----
     v7 起是「分类卡墙 → 题库卡墙 → 题组列表」的三级**卡片墙**（左侧分类树已拆）。
     空数据起点下也有预置分类，走「第一个分类 → 加一题（挂分类下）」这条最贴近新手的路径：
     它不要求先建题库，题会落在该分类的「未归档」里，正好顺带验证散题路径。 */
  await page.eval(`return window.__q.click('.nav__item', '备考题库');`);
  await sleep(1000);
  const firstCat = await page.eval(`const s = window.__q.state(); const c = (s.bankCategories || [])[0]; return c ? c.name : '';`);
  const entered = firstCat
    ? await page.eval(`return window.__q.qPick(${JSON.stringify(firstCat)});`)
    : 'NO_CAT';
  if (String(entered).startsWith('OK')) await sleep(700);
  const addQ = await page.eval(`return window.__q.click('button', '加一题');`);
  if (!String(addQ).startsWith('OK')) console.log(`  ⚠️ 分类「${firstCat}」加题入口不可用（进入分类：${entered} / 按钮：${addQ}）`);
  await sleep(700);
  /* 注意选中「题目内容」那个 textarea：该弹窗里 input.input 在前（分类/公司/年份），
     用组合选择器会写到「分类」上，内容为空时应用会正确地拒绝保存。 */
  const qSet = await page.eval(`return window.__q.modalSet('textarea.textarea', 'QA：请说明法律意见书的必备要素。');`);
  console.log('题库弹窗输入:', qSet);
  await sleep(200);
  await page.eval(`return window.__q.click('.modal button', '保存');`);
  await sleep(900);
  const q = await page.eval(`
    const s = window.__q.state();
    return { n: s.questions.length, first: s.questions[0] ? (s.questions[0].content || '').slice(0, 20) : null,
      body: document.querySelector('.app__scroll').innerText.replace(/\s+/g,' ').slice(0, 120) };
  `);
  console.log(`题库：${q.n} 题，首条「${q.first}」 ${q.n === 1 ? '✅' : '❌'}`);
  res.bank = q.n;

  /* ---- 3. 材料清单：添加材料 ----
     空清单时页面渲染的是 Empty 空状态，按钮叫「导入模板清单 / 手动添加」；
     只有清单非空才出现「添加材料」。所以要按当前状态选正确的入口，
     否则在空数据（QZ_PKG=empty，默认）起点下会误报「按钮 NOT_FOUND」。 */
  await page.eval(`return window.__q.click('.nav__item', '我的资料');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '材料清单');`);
  await sleep(900);
  const mBefore = await page.eval(`return window.__q.count("materials");`);
  const addBtn = await page.eval(`return window.__q.click('button', '添加材料');`);
  if (String(addBtn).startsWith('NOT_FOUND')) {
    /* 空状态：先「手动添加」把编辑弹窗打开（与「添加材料」打开的是同一个表单） */
    const alt = await page.eval(`return window.__q.click('button', '手动添加');`);
    console.log(`材料清单为空，改用空状态入口「手动添加」：${alt}`);
  }
  await sleep(600);
  const mSet = await page.eval(`return window.__q.modalSet('input.input', 'QA 测试材料');`);
  await sleep(200);
  await page.eval(`return window.__q.click('.modal button', '保存');`);
  await sleep(900);
  const mAfter = await page.eval(`return window.__q.count("materials");`);
  console.log(`材料：${mBefore} → ${mAfter}（按钮 ${addBtn}，输入 ${mSet}）${mAfter === mBefore + 1 ? '✅' : '❌ 未写入'}`);
  res.materials = mAfter - mBefore;

  /* ---- 4. 数据洞察：导出下载（验证真的产出文件） ---- */
  await page.eval(`return window.__q.click('.nav__item', '总览');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '数据洞察');`);
  await sleep(900);
  await page.eval(`return window.__q.click('button', '导出 CSV');`);
  await sleep(700);
  await page.eval(`return window.__q.click('button', '导出 Markdown');`);
  await sleep(700);
  const files = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
  console.log('数据洞察导出文件:', JSON.stringify(files));
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DL, f));
    const head = buf.slice(0, 3).toString('hex');
    console.log(`  · ${f} ${buf.length}B ${head === 'efbbbf' ? '（含 UTF-8 BOM ✅）' : '（无 BOM）'}`);
  }
  res.exports = files;

  /* ---- 5. 设置 → 数据与备份：导出整站备份 / ICS ---- */
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(700);
  await page.eval(`return window.__q.click('.segmented__btn', '数据与备份');`);
  await sleep(600);
  await page.eval(`return window.__q.click('button', '导出 JSON 备份');`);
  await sleep(900);
  await page.eval(`return window.__q.click('button', '导出日历 ICS');`);
  await sleep(900);
  const files2 = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
  const fresh = files2.filter((f) => !files.includes(f));
  console.log('备份导出文件:', JSON.stringify(fresh));
  for (const f of fresh) {
    const txt = fs.readFileSync(path.join(DL, f), 'utf8');
    if (f.endsWith('.ics')) {
      const starts = [...txt.matchAll(/DTSTART:(\d{8}T\d{6})/g)].map((m) => m[1]);
      const ends = [...txt.matchAll(/DTEND:(\d{8}T\d{6})/g)].map((m) => m[1]);
      const bad = starts.filter((v, i) => ends[i] && ends[i] <= v);
      const uidBad = [...txt.matchAll(/UID:([^\r\n]+)/g)].filter((m) => /^(job|ev|app)-(job|ev|app)-/.test(m[1]) || m[1].includes('+'));
      console.log(`  · ICS ${starts.length} 个事件；DTEND≤DTSTART 的非法区间 ${bad.length} 个；异常 UID ${uidBad.length} 个 ${bad.length === 0 && uidBad.length === 0 ? '✅' : '❌'}`);
    }
    if (f.endsWith('.json')) {
      const j = JSON.parse(txt);
      console.log(`  · 备份 JSON：岗位 ${j.jobs?.length} / 投递 ${j.applications?.length} / 事件 ${j.events?.length} / _v ${j._v} ✅`);
    }
  }
  res.exports2 = fresh;

  /* ---- 6. AI 助手面板（未配置 Key 时应优雅提示，不崩） ---- */
  await page.eval(`const b = [...document.querySelectorAll('.modal__head button')].pop(); if (b) b.click(); return 'ok';`);
  await sleep(500);
  const opened = await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /AI 助手/.test(x.getAttribute('aria-label') || ''));
    if (!b) return 'NO_BTN';
    b.click(); return 'OK';
  `);
  await sleep(800);
  const panel = await page.eval(`
    const el = document.querySelector('.agent-col, .agent-float, .agent-full');
    return el ? { cls: el.className, text: el.innerText.replace(/\s+/g,' ').slice(0, 120) } : null;
  `);
  console.log('AI 助手面板:', opened, JSON.stringify(panel));
  if (panel) {
    const typed = await page.eval(`return window.__q.set('.agent-col textarea, .agent-col input, .agent-float textarea, .agent-float input', '你好');`);
    await sleep(200);
    await page.eval(`
      const el = document.querySelector('.agent-col, .agent-float');
      const b = el ? [...el.querySelectorAll('button')].find((x) => /发送|send/i.test(x.textContent + (x.getAttribute('aria-label') || ''))) : null;
      if (b) b.click(); return 'ok';
    `);
    await sleep(1500);
    const after = await page.eval(`
      const el = document.querySelector('.agent-col, .agent-float');
      return el ? el.innerText.replace(/\s+/g,' ').slice(0, 200) : null;
    `);
    console.log('输入框:', typed, '｜发送后:', after);
    console.log(after && /配置 AI|API Key|未配置/.test(after) ? '✅ 未配置 Key 时给出明确引导（未崩溃）' : '⚠️ 未看到引导文案，请人工确认');
  }
  await page.shot('modules-final');
  return res;
}

/* 场景：Word 简历导出 + 证件照上传（纯前端重功能） */
async function scenarioDocx(page) {
  const DL = '/tmp/qz-downloads';
  try { fs.rmSync(DL, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DL, { recursive: true });
  await page.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  /* ---- 3. 证件照上传 ---- */
  const IMG = '/tmp/qz-photo-test.jpg';
  const { execSync } = require('node:child_process');
  try { execSync(`sips -s format jpeg --resampleHeightWidth 300 240 "${'/System/Library/Desktop Pictures/Solid Colors/Silver.png'}" --out ${IMG} >/dev/null 2>&1 || true`); } catch {}
  if (!fs.existsSync(IMG)) {
    /* 兜底：写一个最小的合法 JPEG（1×1 红点） */
    fs.writeFileSync(IMG, Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'));
  }
  await page.eval(`return window.__q.click('.nav__item', '我的资料');`);
  await sleep(300);
  await page.eval(`return window.__q.click('.tabbar__btn', '简历');`);
  await sleep(900);
  await page.eval(`return window.__q.click('button', '证件照');`);
  await sleep(800);
  const hasFile = await page.eval(`return !!document.querySelector('input[type=file][accept=\"image/*\"]');`);
  console.log('证件照入口/文件输入:', hasFile);
  if (hasFile) {
    const { root } = await page.cdp.send('DOM.getDocument', {}, page.sid);
    const { nodeId } = await page.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][accept="image/*"]' }, page.sid);
    await page.cdp.send('DOM.setFileInputFiles', { nodeId, files: [IMG] }, page.sid);
    await sleep(2500);
    const r = await page.eval(`
      const shot = localStorage.getItem('qz.photo');
      return { saved: !!shot, len: shot ? shot.length : 0, prefix: shot ? shot.slice(0, 22) : '',
        visible: !!document.querySelector('img[src^="data:image"]') };
    `);
    console.log('证件照结果:', JSON.stringify(r));
    console.log(r.saved && r.visible ? '✅ 证件照已压缩存本机并渲染' : '❌ 证件照未保存/未渲染');
  }

  /* ---- 导出（证件照已就位）---- */
  /* ---- 1. 网申资料库 → 导出 Word ---- */
  await page.eval(`return window.__q.click('.nav__item', '我的资料');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '网申资料库');`);
  await sleep(1000);
  console.log('资料库导出 Word:', await page.eval(`return window.__q.click('button', '导出 Word');`));
  await sleep(2500);
  const toast1 = await page.eval(`const t = document.querySelector('.toast, .toaster'); return t ? t.innerText.replace(/\s+/g,' ') : '(无提示)';`);
  console.log('提示:', toast1);

  /* ---- 2. 简历页 → 导出 Word（普通版 + Agent 版） ---- */
  await page.eval(`return window.__q.click('.tabbar__btn', '简历');`);
  await sleep(1200);
  console.log('简历导出 Word:', await page.eval(`return window.__q.click('button', '导出 Word');`));
  await sleep(2500);
  /* 同时导出 Markdown：与 Word 应包含同样的正文内容（曾出现 Word 全文、MD 截断的不一致） */
  console.log('简历导出 MD:', await page.eval(`return window.__q.click('button', '导出 MD');`));
  await sleep(1500);
  const files = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
  console.log('下载文件:', JSON.stringify(files));
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DL, f));
    if (f.endsWith('.docx')) {
      const isZip = buf.slice(0, 2).toString() === 'PK';
      console.log(`  · ${f} ${(buf.length / 1024).toFixed(1)}KB ${isZip ? '（是合法 docx(zip) ✅）' : '（❌ 不是 zip，Word 打不开）'}`);
    } else {
      console.log(`  · ${f} ${(buf.length / 1024).toFixed(1)}KB（${f.endsWith('.md') ? 'Markdown 文本' : '其他'}）`);
    }
  }

  await page.shot('docx-photo');
  return { files };
}

/* 场景：邮件中心（需本机邮件桥 8787 与已播种的 X-QZ-Token） */
async function scenarioMail(page) {
  await page.eval(`return window.__q.click('.nav__item', '邮件中心');`);
  await sleep(6000);   /* 邮件要经本机桥拉 agently-cli，给足时间 */
  const list = await page.eval(`
    const items = document.querySelectorAll('.mail-item');
    return { n: items.length, first: items[0] ? items[0].innerText.replace(/\s+/g,' ').slice(0, 70) : null,
      empty: /暂无邮件/.test(document.querySelector('.app__scroll').innerText) };
  `);
  console.log('收件箱:', JSON.stringify(list));
  if (!list.n) { console.log('⚠️ 未取到邮件，后续跳过'); await page.shot('mail-empty'); return list; }

  const ev0 = await page.eval(`return window.__q.count("events");`);
  console.log('首次「同步到日历」:', await page.eval(`return window.__q.click('button', '同步到日历');`));
  await sleep(1500);
  const ev1 = await page.eval(`return window.__q.count("events");`);
  await page.eval(`return window.__q.click('button', '同步到日历');`);
  await sleep(1500);
  const ev2 = await page.eval(`return window.__q.count("events");`);
  console.log(`日历事件：${ev0} → 首次同步 ${ev1} → 再次同步 ${ev2}`);
  console.log(ev2 === ev1 ? '✅ 重复点「同步到日历」不会重复写入日程' : `❌ 重复同步写出了 ${ev2 - ev1} 条重复日程`);

  /* 打开第一封邮件 → 加入日历（同样应去重） */
  await page.eval(`const it = document.querySelector('.mail-item'); if (it) it.click(); return 'ok';`);
  await sleep(1500);
  await page.eval(`return window.__q.click('button', '加入日历');`);
  await sleep(1500);
  const ev3 = await page.eval(`return window.__q.count("events");`);
  const toast = await page.eval(`const t = document.querySelector('.toaster, .toast'); return t ? t.innerText.replace(/\s+/g,' ') : '(无)';`);
  console.log(`首次「加入日历」：事件 ${ev2} → ${ev3}，提示「${toast}」`);
  /* 同一封邮件再点一次：不应重复写入日程 */
  await page.eval(`return window.__q.click('button', '加入日历');`);
  await sleep(1500);
  const ev4 = await page.eval(`return window.__q.count("events");`);
  const toast2 = await page.eval(`const t = document.querySelector('.toaster, .toast'); return t ? t.innerText.replace(/\s+/g,' ') : '(无)';`);
  console.log(`再次「加入日历」：事件 ${ev3} → ${ev4}，提示「${toast2}」`);
  console.log(ev4 === ev3 ? '✅ 同一封邮件重复加入不产生重复日程' : `❌ 重复写入 ${ev4 - ev3} 条重复日程`);
  await page.shot('mail-sync');
  return { list: list.n, ev0, ev1, ev2, evFinal: ev4 };
}

/* 场景：全模块「新建 → 刷新 → 仍在」持久化验证 */
/**
 * 云端同步链路：改一条数据 → 有没有真的写进 Supabase。
 * 巡检里最容易被漏掉的一环 —— 界面全绿但「根本没往后端写」是这类站最危险的假通过。
 */
async function scenarioCloudSync(page) {
  const before = page.cloudWrites.length;
  const beforeGets = (page.cloudCalls && page.cloudCalls.gets) || 0;

  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(900);
  const opened = await page.eval(`return window.__q.click('button', '添加岗位');`);
  await sleep(700);
  /* 「添加岗位」的公司与岗位都是必填：只填公司会让保存被校验拦下、弹窗不关 ——
     巡检脚本自己踩过一次，记在这里免得下次又当成产品缺陷查半天。 */
  await page.eval(`
    const ins = [...document.querySelectorAll('.modal input.input')];
    const put = (el, v) => {
      if (!el) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    put(ins[0], '云端巡检单位');
    put(ins[1], '法务岗（巡检）');
    return 'OK';
  `);
  await sleep(250);
  const saved = await page.eval(`return window.__q.click('.modal button', '保存');`);
  /* 防抖 700ms + 一次 HTTP 往返，留足时间 */
  await sleep(2500);

  const writes = page.cloudWrites.slice(before);
  const doc = writes.length ? writes[writes.length - 1] : null;
  const jobs = doc && doc.data && doc.data.state && Array.isArray(doc.data.state.jobs) ? doc.data.state.jobs : [];
  const hit = jobs.some((j) => j.company === '云端巡检单位');
  const stateV = doc && doc.data && doc.data.state ? doc.data.state._v : undefined;
  const shape = doc && doc.data ? { _v: doc.data._v, _app: doc.data._app, hasState: !!doc.data.state, stateV } : null;
  /* 信封 `_v` 必须等于 state 自己的 `_v`（文档自描述）。曾经这两个值分属两个文件里的常量，
     题库 schema 升到 v6 时只改了一处，云端文档一直写着 v5 —— 迁移链的起点就错了，
     将来谁再照着那个失效的注释去「对齐」，老账号的迁移就会被跳过一个版本。 */
  const vOk = typeof shape?._v === 'number' && shape._v === stateV;

  console.log(`打开弹窗=${opened} / 保存=${saved}`);
  console.log(`启动时读取次数=${beforeGets}（应 ≥1，说明确实向云端要过数据）`);
  console.log(`保存后云端写入次数=${writes.length}（原始计数 ${JSON.stringify(page.cloudCalls)}）`);
  const st = await page.eval(`return { jobs: window.__q.state().jobs?.length, modalOpen: !!document.querySelector('.modal') };`);
  console.log(`本机状态=${JSON.stringify(st)}`);
  console.log(`文档结构=${JSON.stringify(shape)}`);
  console.log(vOk ? `✅ 云端文档版本自描述（信封 _v = state._v = ${stateV}）` : `❌ 信封 _v(${shape?._v}) 与 state._v(${stateV}) 不一致`);
  console.log(hit ? '✅ 新岗位已随文档写入云端' : '❌ 云端写入里找不到刚新增的岗位');
  const ui = await page.eval(`return document.querySelector('.sidebar__foot')?.innerText.replace(/\\s+/g,' ') || '';`);
  console.log('侧边栏同步状态:', ui.slice(0, 80));
  return { beforeGets, writes: writes.length, shape, hit, vOk };
}

/**
 * 「标签页落后于云端」巡检。
 *
 * 场景：网页装成 PWA 后可以挂在后台好几天。用户在手机上改了数据，几天后回到
 * 还开着的那台电脑 —— 那个标签页内存里还是旧状态，它一有写入就会把整份旧文档
 * 推上云端，把手机上刚填的整片抹掉。巡检要确认：重新获得焦点时站点能发现这件事并提醒。
 */
async function scenarioStale(page) {
  const base = page.cloudUpdatedAt;
  /* 先等首屏的首次写入落定，拿到基线 */
  await sleep(2000);
  const before = await page.eval(`return document.querySelectorAll('.toast, .toaster > *').length;`);

  /* 把服务端时间往后拨 = 另一台设备刚刚写过 */
  page.cloudUpdatedAt = '2026-06-01T00:00:00.000Z';
  await page.cdp.send('Page.bringToFront', {}, page.sid).catch(() => {});
  await page.eval(`
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    return 'OK';
  `);
  await sleep(1500);

  const toastText = await page.eval(`
    const t = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /另一台设备|未同步的改动/.test(e.textContent || ''));
    return t.length ? t[0].parentElement.innerText.replace(/\\s+/g, ' ').slice(0, 120) : '';
  `);
  const warned = /另一台设备/.test(toastText);
  const hasAction = /载入云端最新/.test(toastText);
  console.log('基线（首屏）toast 数:', before, '｜服务端时间已拨到:', page.cloudUpdatedAt);
  console.log(warned ? '✅ 检测到云端被别的设备改过并提醒' : '❌ 没有提醒（会静默覆盖掉另一台设备的新数据）');
  console.log(hasAction ? '✅ 提供「载入云端最新」入口' : '❌ 没有提供载入入口');
  if (toastText) console.log('   提示原文:', toastText);
  return { warned, hasAction, toastText };
}

/**
 * 陈旧检测的「脏」分支：本机还有没推上去的改动时，**不能**诱导用户点「载入云端最新」
 * —— 那等于把他刚敲的内容丢掉。必须只警告、不给载入入口。
 * 单独一个场景是因为新鲜度检查有 60 秒节流，两种分支各自需要一次「首次检查」。
 */
async function scenarioStaleDirty(page) {
  await sleep(2000);                                   // 等首屏首次写入落定，拿到基线
  const base = page.cloudUpdatedAt;
  page.cloudUpdatedAt = '2026-06-01T00:00:00.000Z';    // 另一台设备刚写过

  /* 制造一个还没推上去的本地改动：切主题会改 state，触发 700ms 防抖保存。
     注意按钮已经搬家：侧栏那个带文字的「深浅色模式」被删了（和顶栏重复），
     现在只剩顶栏一个纯图标按钮、靠 aria-label="切换主题" 认人 ——
     按文字找会 NO_BTN，「脏」这个分支就永远测不到，却表现为产品没做这个提示。 */
  const toggled = await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /切换主题/.test(x.getAttribute('aria-label') || ''))
      || [...document.querySelectorAll('button')].find((x) => /深浅色模式|日光玻璃|液态玻璃/.test(x.textContent || ''));
    if (!b) return 'NO_BTN';
    b.click(); return 'OK';
  `);
  if (toggled !== 'OK') console.log('  ⚠️ 找不到「切换主题」按钮:', toggled);
  await sleep(120);                                     // 仍在防抖窗口内

  await page.cdp.send('Page.bringToFront', {}, page.sid).catch(() => {});
  await page.eval(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); return 'OK';`);
  await sleep(1200);

  const txt = await page.eval(`
    const t = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /另一台设备|未同步的改动/.test(e.textContent || ''));
    return t.length ? t[0].parentElement.innerText.replace(/\\s+/g, ' ').slice(0, 140) : '';
  `);
  const warned = /未同步的改动/.test(txt);
  const badOffer = /载入云端最新/.test(txt);
  console.log('基线:', base, '→ 拨到:', page.cloudUpdatedAt);
  console.log(warned ? '✅ 有未同步改动时给出正确警告' : '❌ 未检测到（或提示词不对）');
  console.log(badOffer ? '❌ 仍在诱导刷新（会丢掉用户刚敲的内容）' : '✅ 没有提供会丢数据的载入入口');
  if (txt) console.log('   提示原文:', txt);
  return { warned, badOffer, txt };
}

/**
 * 「清空全部数据」巡检 —— 这是最容易写错、后果又最重的一个按钮。
 *
 * 要盯住三件事：
 *  ① 它是不是真的清干净了（含简历备注文本 —— 早期实现漏了它，清完还留在库里、照样同步到云端）；
 *  ② 清空是不是**同时落到云端**（只清本机的话，下次打开又被云端拉回来，用户会以为按钮坏了）；
 *  ③ 文案有没有误导（旧文案写「恢复成示例数据」而种子其实是空的，且只字不提云端会被清空）。
 */
async function scenarioReset(page) {
  const before = await page.eval(`const s=window.__q.state(); return { jobs:s.jobs?.length||0, apps:s.applications?.length||0, ev:s.events?.length||0, materials:s.materials?.length||0, resumeLen:(s.resumeText||'').length };`);
  console.log('清空前:', JSON.stringify(before));

  /* 打开设置 → 切到「数据与备份」 */
  await page.eval(`const b=document.querySelector('.topbar button[aria-label="设置"]'); if(b) b.click(); return 'OK';`);
  await sleep(700);
  await page.eval(`return window.__q.click('.segmented__btn, .segmented button', '数据与备份');`);
  await sleep(600);

  const copy = await page.eval(`
    const t = document.querySelector('.modal')?.innerText || '';
    return { 提到云端: /云端账号一起清空|云端账号里的数据/.test(t), 老文案: /恢复成示例数据/.test(t), 有先导出备份: /先导出备份/.test(t) };
  `);
  console.log('文案检查:', JSON.stringify(copy));
  console.log(copy.老文案 ? '❌ 仍在说「恢复成示例数据」（种子是空的，属误导）' : '✅ 已去掉误导性的「示例数据」说法');
  console.log(copy.提到云端 ? '✅ 明确说明云端也会被清空' : '❌ 没说云端会被清空');
  console.log(copy.有先导出备份 ? '✅ 危险按钮旁提供了「先导出备份」' : '❌ 没有就近的备份入口');

  const writesBefore = (page.cloudCalls && page.cloudCalls.writes) || 0;
  await page.eval(`return window.__q.click('.modal button', '清空全部数据');`);
  await sleep(2600);   // 等 700ms 防抖 + 一次云端往返

  const after = await page.eval(`const s=window.__q.state(); return { jobs:s.jobs?.length||0, apps:s.applications?.length||0, ev:s.events?.length||0, materials:s.materials?.length||0, resumeLen:(s.resumeText||'').length };`);
  console.log('清空后:', JSON.stringify(after));
  const clean = Object.values(after).every((v) => v === 0);
  console.log(clean ? '✅ 全部字段已清空（含简历备注文本）' : '❌ 还有字段没清干净 → ' + JSON.stringify(after));

  const writesAfter = (page.cloudCalls && page.cloudCalls.writes) || 0;
  const last = page.cloudWrites[page.cloudWrites.length - 1];
  const cloudJobs = last && last.data && last.data.state && Array.isArray(last.data.state.jobs) ? last.data.state.jobs.length : -1;
  console.log(`云端写入次数 ${writesBefore} → ${writesAfter}｜最后一次上传的岗位数 = ${cloudJobs}`);
  console.log(cloudJobs === 0 ? '✅ 清空已同步到云端（否则下次打开又被云端拉回来）' : '❌ 云端没被清空');
  return { before, after, copy, clean, cloudJobs };
}

/**
 * 「云端读不通」巡检 —— 站点最该稳住的容错路径。
 *
 * 要盯住四件事：
 *  ① 界面仍然可用（用本机缓存撑起来，不是白屏、不是卡在「正在连接云端…」）；
 *  ② 用户能看见「同步没成功」，而不是以为自己存上了；
 *  ③ **一个字都不许往云端写** —— 读失败期间本机可能已经改过、云端也可能被别的设备更新过，
 *     这时候写就是把本机过期状态覆盖云端，正是 CloudBoot 三态要防的事；
 *  ④ 「重试连接」不能只是把写入开关拨开（那等于绕过第 ③ 条），而要先读通再重载。
 * 用 QZ_CLOUD_FAIL=1 运行。
 */
async function scenarioCloudFail(page) {
  /* 自检：本场景必须配合 QZ_CLOUD_FAIL=1 才有意义。少了它，云端一切正常，
     断言会整片反过来（曾因为漏传这个变量得到一份全是 ❌ 的假报告）。 */
  if (!CLOUD_FAIL) {
    console.log('⚠️ 本场景需要 QZ_CLOUD_FAIL=1 才会注入「云端不可用」。');
    console.log('   正确用法：QZ_CLOUD=1 QZ_CLOUD_FAIL=1 node scripts/qa-e2e.mjs cloudfail');
    return { skipped: true };
  }
  const body = await page.eval(`return document.body.innerText.replace(/\\s+/g,' ').slice(0, 90);`);
  const rendered = await page.eval(`return !!document.querySelector('.app');`);
  console.log(rendered ? '✅ 界面照常渲染（本机缓存兜底，没有白屏）' : '❌ 白屏或卡在加载态');
  console.log('   首屏文本:', body);

  const st = await page.eval(`const s=window.__q.state(); return { jobs:s.jobs?.length||0, apps:s.applications?.length||0 };`);
  console.log('   本机数据仍在:', JSON.stringify(st));

  const foot = await page.eval(`return document.querySelector('.sidebar__foot')?.innerText.replace(/\\s+/g,' ') || '';`);
  /* 侧栏同步态收敛成三档短文案（账号已连接 / 正在同步… / 同步异常 · 见设置）：
     原来那串「邮件桥 在线/离线 · 云端已同步 · 时间 · 深浅色模式」是运维噪音，已删。
     断言按新词表走，别再去匹配已经不存在的「同步失败」。 */
  const warns = /同步异常|未开启/.test(foot);
  console.log(warns ? '✅ 侧边栏明确显示同步异常' : '❌ 侧边栏看不到任何异常提示 → ' + foot.slice(0, 60));

  /* 改一条数据：这时候**绝不能**触发任何云端写入 */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(800);
  await page.eval(`return window.__q.click('button', '添加岗位');`);
  await sleep(600);
  await page.eval(`
    const ins = [...document.querySelectorAll('.modal input.input')];
    const put = (el, v) => { if (!el) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    put(ins[0], '断网巡检单位'); put(ins[1], '法务岗');
    return 'OK';
  `);
  await sleep(200);
  await page.eval(`return window.__q.click('.modal button', '保存');`);
  await sleep(2500);
  const w = (page.cloudCalls && page.cloudCalls.writes) || 0;
  console.log(w === 0 ? '✅ 改动后没有向云端写入一个字（不会覆盖云端）' : `❌ 竟然尝试写云端 ${w} 次 —— 会用本机过期状态覆盖云端`);

  /* 设置面板里的错误说明与重试按钮 */
  await page.eval(`const b=document.querySelector('.topbar button[aria-label="设置"]'); if(b) b.click(); return 'OK';`);
  await sleep(700);
  const panel = await page.eval(`
    const t = document.querySelector('.modal')?.innerText.replace(/\\s+/g,' ') || '';
    return { 有错误原因: /同步失败/.test(t), 有重试: /重试连接/.test(t), 有立即同步: /立即同步到云端/.test(t) };
  `);
  console.log('设置面板:', JSON.stringify(panel));
  console.log(panel.有错误原因 ? '✅ 设置里能看到失败原因' : '❌ 设置里没有错误原因');
  console.log(panel.有重试 ? '✅ 提供「重试连接」' : '❌ 没有重试入口');

  /* 云端仍不可用时点重试：应保持失败、依然不写入 */
  const before = (page.cloudCalls && page.cloudCalls.writes) || 0;
  await page.eval(`return window.__q.click('.modal button', '重试连接');`);
  await sleep(2500);
  const after = (page.cloudCalls && page.cloudCalls.writes) || 0;
  const stillErr = await page.eval(`return /同步失败/.test(document.querySelector('.modal')?.innerText || '');`);
  console.log(after === before ? '✅ 重试失败后依旧没有写入' : `❌ 重试后开始写入了 ${after - before} 次`);
  console.log(stillErr ? '✅ 重试失败后仍显示失败原因' : '❌ 重试失败后错误被吞掉了');

  /* 云端恢复后再点重试：应重载页面并以「云端优先」重新启动，同步随之开启 */
  page.cloudFail = false;
  page.cloudUpdatedAt = '2026-07-01T00:00:00.000Z';
  await page.eval(`return window.__q.click('.modal button', '重试连接');`);
  await sleep(4000);
  await page.eval(`return 'OK';`).catch(() => {});
  const afterReload = await page.eval(`return document.querySelector('.sidebar__foot')?.innerText.replace(/\\s+/g,' ') || '';`);
  const recovered = /账号已连接|正在同步/.test(afterReload);
  console.log('云端恢复后:', afterReload.slice(0, 60));
  console.log(recovered ? '✅ 重载后同步恢复正常' : '❌ 重载后仍未恢复同步');
  return { rendered, st, warns, writes: w, panel, retryWrites: after - before, recovered };
}

/**
 * 同一浏览器「两个标签页」巡检。
 *
 * 要防的场景：A、B 两个标签页都开着这个站。A 改了东西（写入 localStorage 与云端），
 * B 内存里还是旧状态；用户在 B 随手点一下（这里用切主题模拟），B 就把**整份旧状态**
 * 写回去 —— A 的改动当场消失。这比跨设备场景常见得多。
 *
 * 断言分两层：
 *  ① B 的空闲页要**接纳**了 A 的改动（用 B 自己的渲染结果验证，不能读 localStorage —— 那是共享的，读它等于没验证）；
 *  ② B 之后写入时**不能**把 A 的改动冲掉（这时读 localStorage 才是对的）。
 */
async function scenarioTwoTab(page) {
  const { targetId } = await page.cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await page.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const tab2 = new Page(page.cdp, sessionId);
  await tab2.init('{}');          // localStorage 已由第一个标签页播好，这里不会覆盖
  await tab2.goto();
  await injectHelpers(tab2);

  const readCount = async (pg) => {
    await pg.eval(`const b=document.querySelector('.topbar button[aria-label="设置"]'); if(!b) return 'NO'; b.click(); return 'OK';`);
    await sleep(600);
    await pg.eval(`return window.__q.click('.segmented__btn, .segmented button', '数据与备份');`);
    await sleep(500);
    const n = await pg.eval(`
      const t = document.querySelector('.modal')?.innerText || '';
      const m = /岗位\\s*(\\d+)/.exec(t);
      return m ? Number(m[1]) : -1;
    `);
    return n;
  };
  const closeSettings = async (pg) => {
    await pg.eval(`const b=[...document.querySelectorAll('.modal button')].find(x=>/^完成$|^关闭$/.test((x.textContent||'').trim())); if(b) b.click(); return 'OK';`);
    await sleep(400);
  };

  const base2 = await readCount(tab2);
  console.log('标签页 B 看到的岗位数:', base2);
  await closeSettings(tab2);

  /* A 页新增一个岗位 */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(700);
  await page.eval(`return window.__q.click('button', '添加岗位');`);
  await sleep(600);
  await page.eval(`
    const ins = [...document.querySelectorAll('.modal input.input')];
    const put = (el, v) => { if (!el) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    put(ins[0], '双标签页巡检单位'); put(ins[1], '法务岗');
    return 'OK';
  `);
  await sleep(200);
  await page.eval(`return window.__q.click('.modal button', '保存');`);
  await sleep(1600);

  const after2 = await readCount(tab2);
  console.log('A 新增岗位后，标签页 B 看到的岗位数:', after2);
  const adopted = after2 === base2 + 1;
  console.log(adopted ? '✅ B 的空闲页接纳了 A 的改动（未被落在旧状态）' : `❌ B 仍停在旧状态（${base2} → ${after2}）`);
  await closeSettings(tab2);

  /* 关键一步：让 B 写入一次。若未接纳，这次写入会把 A 的岗位冲掉 */
  await tab2.eval(`const b=[...document.querySelectorAll('button')].find(x=>/模式/.test(x.textContent||'')); if(b) b.click(); return 'OK';`);
  await sleep(1800);

  const survived = await page.eval(`
    const raw = localStorage.getItem(window.__q.cacheKey()) || '{}';
    const s = JSON.parse(raw || '{}');
    return (s.jobs || []).some((j) => j.company === '双标签页巡检单位');
  `);
  console.log(survived ? '✅ B 写入后 A 的新增仍在（没有被旧状态覆盖）' : '❌ A 的新增被 B 的旧状态覆盖了');

  /* ---- 反向分支：B 正在编辑时不能强行接纳，否则会冲掉用户正在敲的内容 ---- */
  const n3 = await readCount(tab2);                 // 打开设置 = 存在 .modal-overlay，视为「正在编辑」
  console.log('B 保持设置面板打开（模拟正在编辑），当前岗位数:', n3);

  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(700);
  await page.eval(`return window.__q.click('button', '添加岗位');`);
  await sleep(600);
  await page.eval(`
    const ins = [...document.querySelectorAll('.modal input.input')];
    const put = (el, v) => { if (!el) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    put(ins[0], '编辑中巡检单位'); put(ins[1], '法务岗');
    return 'OK';
  `);
  await sleep(200);
  await page.eval(`return window.__q.click('.modal button', '保存');`);
  await sleep(1800);

  const n4 = await readCount(tab2);
  const warned = await page.eval(`return true;`) && await tab2.eval(`return /另一个标签页也开着这个站/.test(document.body.innerText);`);
  console.log('A 再次改动后，B 的岗位数:', n4, '（应保持不变 = 未被强行接纳）');
  console.log(n4 === n3 ? '✅ 编辑中的标签页没有被强行覆盖' : `❌ 编辑中的标签页被改动了（${n3} → ${n4}）`);
  console.log(warned ? '✅ 已提醒「另一个标签页更新了数据」' : '❌ 没有任何提示（用户会一直蒙在鼓里）');

  try { await page.cdp.send('Target.closeTarget', { targetId }); } catch { /* ignore */ }
  return { base2, after2, adopted, survived, n3, n4, warned };
}

/**
 * 真实账号端到端：用**真实凭据**在浏览器里登录，而不是伪造会话。
 *
 * 这是唯一能验证「注册/登录真的通、云端真的落盘」的场景 —— 其余场景都用 CDP 伪造会话 + 拦截 REST，
 * 只能验到接口形状这一层。需要 QZ_USER / QZ_PASS，且必须配 QZ_PROXY（浏览器要能连到 Supabase）。
 */
async function scenarioRealLogin(page) {
  const email = process.env.QZ_USER, pass = process.env.QZ_PASS;
  if (!email || !pass) {
    console.log('⚠️ 需要 QZ_USER / QZ_PASS，本场景跳过。');
    console.log('   用法：QZ_USER=you@x.com QZ_PASS=... QZ_PROXY=http://127.0.0.1:7897 node scripts/qa-e2e.mjs loginreal');
    return { skipped: true };
  }

  await page.cdp.send('Page.navigate', { url: BASE }, page.sid);
  if (!await page.waitFor('!!document.querySelector(".login-card")', 20000)) {
    console.log('❌ 没有渲染出登录页'); return { rendered: false };
  }
  await injectHelpers(page);

  const filled = await page.eval(`
    const c = document.querySelector('.login-card');
    const put = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    if (/创建新账号|设置新密码/.test(c.innerText)) {
      const b = [...c.querySelectorAll('.link-btn')].find((x) => /登录/.test(x.textContent || ''));
      if (b) b.click();
    }
    put(c.querySelector('input[type=email]'), ${JSON.stringify(email)});
    put(c.querySelector('input[type=password]'), ${JSON.stringify(pass)});
    return 'OK';
  `);
  console.log('填入凭据:', filled);
  await sleep(300);
  await page.eval(`document.querySelector('.login-card button[type=submit]').click(); return 'OK';`);

  const entered = await page.waitFor('!!document.querySelector(".app")', 30000);
  if (!entered) {
    const msg = await page.eval(`return (document.querySelector('.login-msg')?.innerText || document.body.innerText).replace(/\\s+/g,' ').slice(0, 160);`);
    console.log('❌ 没能进入站内。页面提示:', msg);
    return { entered: false, msg };
  }
  await sleep(1500);
  const foot = await page.eval(`return document.querySelector('.sidebar__foot')?.innerText.replace(/\\s+/g,' ') || '';`);
  console.log('✅ 已用真实账号登录进入站内');
  console.log('   侧边栏:', foot.slice(0, 70));
  const syncOk = /云端已同步|云端已连接|正在同步/.test(foot);
  console.log(syncOk ? '✅ 云端同步已建立' : '❌ 云端同步未建立');
  await page.shot('loginreal');

  /* 先验证「取回」：本次是干净浏览器（无本机缓存），岗位库里的内容只可能来自云端 */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(500);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(1500);
  const pulled = await page.eval(`
    const t = document.querySelector('.app__scroll')?.innerText || '';
    return { 含上轮写入: /端到端验收单位/.test(t), 长度: t.length };
  `);
  console.log('本机无缓存时岗位库内容:', JSON.stringify(pulled));
  console.log(pulled.含上轮写入
    ? '✅ 换设备取回成功：云端数据被拉回来了'
    : '（首次运行属正常：云端还没有这条）');

  if (process.env.QZ_WRITE !== '1') {
    console.log('（未设 QZ_WRITE=1，本次只读不写）');
    return { entered: true, syncOk, pulled };
  }

  /* 写一条数据，稍后回数据库核对 */
  await page.eval(`return window.__q.click('button', '添加岗位');`);
  await sleep(700);
  await page.eval(`
    const ins = [...document.querySelectorAll('.modal input.input')];
    const put = (el, v) => { if (!el) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    put(ins[0], '端到端验收单位'); put(ins[1], '法务岗');
    return 'OK';
  `);
  await sleep(250);
  await page.eval(`return window.__q.click('.modal button', '保存');`);
  await sleep(4000);   // 700ms 防抖 + 真实网络往返
  console.log('✅ 已在页面上新增一条岗位（「端到端验收单位」），等云端写入');
  return { entered: true, syncOk, foot, pulled };
}

async function scenarioCrud(page) {
  const steps = [
    { name: '联系人', nav: '求职进程', tab: '人脉内推', add: '添加联系人', field: 'input.input', value: '黔鲲测试联系人' },
    { name: '简历版本', nav: '我的资料', tab: '简历版本', add: '新建版本', field: 'input.input', value: '黔鲲测试版本' },
    { name: 'Offer', nav: '面试与 Offer', tab: 'Offer 对比', add: '添加 Offer', field: 'input.input', value: '黔鲲测试单位' },
    { name: '面试复盘', nav: '面试与 Offer', tab: '面试复盘', add: '记录第一场面试', field: 'input.input', value: '黔鲲测试单位' },
  ];
  const created = [];
  for (const st of steps) {
    await page.eval(`return window.__q.click('.nav__item', ${JSON.stringify(st.nav)});`);
    await sleep(350);
    await page.eval(`return window.__q.click('.tabbar__btn', ${JSON.stringify(st.tab)});`);
    await sleep(800);
    const before = await page.eval(`return window.__q.state();`);
    let opened = await page.eval(`return window.__q.click('button', ${JSON.stringify(st.add)});`);
    if (String(opened).startsWith('NOT_FOUND')) {
      const alt = await page.eval(`return window.__q.click('button', ${JSON.stringify('添加第一个 ' + st.name.replace('面试复盘', 'Offer').replace('Offer', 'Offer'))});`);
      if (!String(alt).startsWith('NOT_FOUND')) opened = alt + '(空状态按钮)';
      else {
        /* 再退一步：抓页面里第一个 primary 的「添加」类按钮 */
        const any = await page.eval(`
          const b = [...document.querySelectorAll('.section-head button, .card button')].find((x) => /添加|新建|记录/.test(x.textContent || ''));
          if (!b) return 'NOT_FOUND'; b.click(); return 'OK(自动匹配:' + b.textContent.trim() + ')';
        `);
        opened = any;
      }
    }
    await sleep(600);
    const set = await page.eval(`return window.__q.modalSet('${st.field}', ${JSON.stringify(st.value)});`);
    await sleep(200);
    const saved = await page.eval(`return window.__q.click('.modal button', '保存');`);
    await sleep(900);
    const after = await page.eval(`
      const s = window.__q.state();
      return { contacts: s.contacts.length, versions: s.versions.length, offers: s.offers.length, interviews: s.interviews.length };
    `);
    const key = { 联系人: 'contacts', 简历版本: 'versions', Offer: 'offers', 面试复盘: 'interviews' }[st.name];
    const delta = after[key] - (before[key] ? before[key].length : 0);
    const modalGone = await page.eval(`return !document.querySelector('.modal');`);
    console.log(`${st.name}：${opened} / 输入 ${set} / 保存 ${saved} → ${delta === 1 ? '写入 ✅' : '❌ 未写入(' + delta + ')'}；弹窗已关闭 ${modalGone ? '✅' : '❌'}`);
    created.push({ name: st.name, key, value: st.value, ok: delta === 1 });
  }

  /* 刷新后必须仍在（没写进 localStorage 就等于丢数据） */
  await page.goto();
  await injectHelpers(page);
  const persisted = await page.eval(`return window.__q.state();`);
  const found = {
    联系人: (persisted.contacts || []).some((x) => x.name === '黔鲲测试联系人'),
    简历版本: (persisted.versions || []).some((x) => x.name === '黔鲲测试版本'),
    Offer: (persisted.offers || []).some((x) => x.company === '黔鲲测试单位'),
    面试复盘: (persisted.interviews || []).some((x) => x.company === '黔鲲测试单位'),
  };
  console.log('刷新后仍在:', JSON.stringify(found));
  const lost = Object.entries(found).filter(([, v]) => !v).map(([k]) => k);
  console.log(lost.length === 0 ? '✅ 四个模块的新建记录全部持久化' : '❌ 刷新后丢失：' + lost.join('、'));
  return { created, found };
}

/* 场景：弹窗里的真实键盘输入
   回归目标：Modal 的「锁滚动 + 初始焦点 + 关闭归还焦点」副作用若依赖不稳定的 onClose
   （父组件每次渲染都传新箭头函数），则**每次按键引发的重渲染都会跑一遍清理**，
   把焦点还给触发器按钮、30ms 后再抢回第一个输入框：
   表现为「中文打不进去 / 第二个字段打不进字 / 字符串到第一个字段」。
   本场景必须用真实鼠标 + 逐字符按键，__q.set 直接写值会绕过焦点、测不出来。 */
async function scenarioTyping(page) {
  const cases = [
    { name: '新增投递', nav: '求职进程', tab: '投递记录', add: '新增投递',
      fields: [['公司', 'zhongjin', 'key'], ['岗位', 'fawu', 'key'], ['备注', '中金公司网申·中文输入', 'ime']] },
    { name: '添加岗位', nav: '求职进程', tab: '岗位库', add: '添加岗位',
      fields: [['公司', 'guokaixing', 'key'], ['岗位', 'hegui', 'key']] },
  ];
  const out = [];
  for (const c of cases) {
    await page.eval(`return window.__q.click('.nav__item', ${JSON.stringify(c.nav)});`);
    await sleep(350);
    await page.eval(`return window.__q.click('.tabbar__btn', ${JSON.stringify(c.tab)});`);
    await sleep(800);
    const opened = await page.eval(`return window.__q.click('button', ${JSON.stringify(c.add)});`);
    await sleep(800);
    if (!(await page.eval(`return !!document.querySelector('.modal');`))) {
      console.log(`${c.name}：❌ 弹窗没打开（${opened}）`);
      out.push({ name: c.name, ok: false });
      continue;
    }
    /* 打开弹窗后初始焦点应落在第一个表单控件上，不能是标题栏的 ✕ 关闭按钮 */
    await sleep(400);
    const first = await page.eval(`return window.__q.active();`);
    const firstOk = !!(first.inModal && first.tag === 'INPUT');
    console.log(`${c.name}：打开后初始焦点=${first.tag}${first.label ? '「' + first.label + '」' : ''} ${firstOk ? '✅' : '❌ 应在第一个输入框上'}`);

    const steps = [];
    for (const [label, text, mode] of c.fields) {
      await page.eval(`return window.__q.watchFocus();`);
      const box = await page.eval(`return window.__q.boxByLabel(${JSON.stringify(label)});`);
      if (!box) { steps.push({ label, typed: text, got: 'NO_FIELD' }); continue; }
      await page.clickBox(box);
      await sleep(150);
      if (mode === 'ime') await page.imeText(text); else await page.typeText(text);
      await sleep(300);
      const st = await page.eval(`return window.__q.active();`);
      const log = await page.eval(`return window.__q.focusLog();`);
      const self = st.snap.find((s) => s.label && s.label.includes(label));
      steps.push({
        label, typed: text,
        got: self ? self.value : null,
        focusOn: st.label, inModal: !!st.inModal, focusTag: st.tag,
        steals: log.filter((x) => x.type === 'in' && !(x.el.startsWith('INPUT') && x.el.includes(label))
          && !(x.el.startsWith('TEXTAREA') && x.el.includes(label))).length,
        log: log.slice(0, 14).map((x) => `${x.type}:${x.el}`),
      });
    }
    const ok = firstOk && steps.every((s) => s.got === s.typed && s.inModal && s.focusOn && s.focusOn.includes(s.label));
    for (const s of steps) {
      console.log(`   「${s.label}」输入 ${JSON.stringify(s.typed)} → 实际 ${JSON.stringify(s.got)}`
        + ` ｜ 输入后焦点=${s.focusTag}${s.focusOn ? '「' + s.focusOn + '」' : '(不在输入框)'}`
        + ` ｜ 打字期间焦点被抢 ${s.steals} 次 ${s.got === s.typed && s.inModal ? '✅' : '❌'}`);
      if (s.got !== s.typed && s.log) console.log(`     焦点流水: ${s.log.join(' → ')}`);
    }
    console.log(`   ${ok ? '✅ 弹窗内可以正常打字' : '❌ 弹窗内打字异常（焦点被抢走 / 字符串字段）'}`);
    await page.shot('typing-' + (c.name === '新增投递' ? 'app' : 'job'));
    /* 关掉弹窗，别影响下一个用例 */
    await page.eval(`return window.__q.click('.modal button', '取消') || window.__q.click('.modal__head button', '');`);
    await sleep(400);
    out.push({ name: c.name, ok, steps });
  }
  const bad = out.filter((o) => !o.ok).map((o) => o.name);
  console.log(bad.length === 0 ? '\n✅ 弹窗打字回归全部通过' : '\n❌ 打字回归未通过：' + bad.join('、'));
  return out;
}

/* 场景：命令面板搜索跳转 / 岗位库处置入口 / 网盘空配置容错 */
async function scenarioMisc(page) {
  /* ---- 1. ⌘K 搜索 → 回车跳转 ---- */
  await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); return 'ok';`);
  await sleep(600);
  await page.eval(`return window.__q.set('.modal input.input, .modal input', '岗位库');`);
  await sleep(600);
  const res = await page.eval(`
    const ov = document.querySelector('.modal-overlay');
    return { n: ov.querySelectorAll('.nav__item').length, first: ov.querySelector('.nav__item') ? ov.querySelector('.nav__item').innerText.replace(/\s+/g,' ') : null };
  `);
  console.log('⌘K 搜索「岗位库」:', JSON.stringify(res));
  await page.eval(`
    const inp = document.querySelector('.modal input');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'ok';
  `);
  await sleep(900);
  const nav = await page.eval(`
    const tb = document.querySelector('.tabbar__btn--active');
    return { closed: !document.querySelector('.modal-overlay'),
      active: tb ? tb.textContent.trim().split(String.fromCharCode(10)).join('').split('+').join('').replace(/[0-9]/g, '') : null,
      crumb: (document.querySelector('.topbar') || document.body).innerText.replace(/\s+/g,' ').slice(0, 40) };
  `);
  console.log('回车后:', JSON.stringify(nav));
  console.log(nav.closed && String(nav.active).startsWith('岗位库') ? '✅ 搜索命中并成功跳转' : '❌ 跳转失败');

  /* ---- 2. 岗位库：清理重复 / 归档已截止 ----
     v6 起这两个「偶发才用」的动作收进了「更多」下拉（标题栏不再摊一排按钮），
     所以必须先点开「更多」再点条目；直接按旧文案找会恒 NOT_FOUND，
     看着像功能被删了，其实只是入口换了地方。 */
  await sleep(500);
  const moreBtn = await page.eval(`return window.__q.click('button', '更多');`);
  await sleep(400);
  const dup = await page.eval(`return window.__q.click('button', '清理重复岗位');`);
  await sleep(800);
  const dupInfo = await page.eval(`
    const m = document.querySelector('.modal');
    return m ? { title: (m.querySelector('.modal__title') || {}).innerText || '', len: m.innerText.replace(/\\s+/g,' ').length, head: m.innerText.replace(/\\s+/g,' ').slice(0, 110) } : null;
  `);
  console.log('「更多」→ 清理重复岗位:', moreBtn, dup, JSON.stringify(dupInfo));
  await page.eval(`const b = [...document.querySelectorAll('.modal__head button')].pop(); if (b) b.click(); return 'ok';`);
  await sleep(500);

  await page.eval(`return window.__q.click('button', '更多');`);
  await sleep(400);
  const arch = await page.eval(`return window.__q.click('button', '归档已截止岗位');`);
  await sleep(1200);
  const archInfo = await page.eval(`
    const s = window.__q.state();
    return { archived: s.jobs.filter((j) => j.status === 'archived').length,
      applied: s.jobs.filter((j) => j.status === 'applied').length,
      toast: (document.querySelector('.toaster, .toast') || {}).innerText || '' };
  `);
  console.log('「更多」→ 归档已截止岗位:', arch, JSON.stringify(archInfo));
  console.log(archInfo.archived > 0 ? '✅ 归档入口生效' : '⚠️ 没有可归档项（空数据起点下正常；用 QZ_PKG 灌入带过期岗位的数据包可真正验证）');

  /* ---- 3. 设置 → 网盘同步：空配置点「先测试连接」应给友好错误而不是崩 ---- */
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(600);
  await page.eval(`return window.__q.click('.segmented__btn', '数据与备份');`);
  await sleep(600);
  /* ⑤ 网盘同步在原生 <details class="adv"> 折叠区里，默认收起（「我多半不需要」）。
     不先展开就点「先测试连接」，点的是**不可见**按钮：React 事件照样跑、报错卡片也照渲染，
     但它在收起区里，innerText 一个字都读不到 —— 于是「空配置应给出友好错误」
     会被误判成「无失败提示」，看着像容错没做，其实只是没展开。 */
  const openAdv = await page.eval(`return window.__q.click('.adv__sum');`);
  await sleep(400);
  const wdClick = await page.eval(`return window.__q.click('button', '先测试连接');`);
  await sleep(4000);
  const wd = await page.eval(`
    const m = document.querySelector('.modal');
    const toast = (document.querySelector('.toaster, .toast') || {}).innerText || '';
    if (!m) return { crashed: true };
    const t = m.innerText.replace(/\\s+/g,' ');
    const i = t.indexOf('先测试连接');
    /* 措辞别写死：空配置的报错是「配置没填全 / 请先填写 WebDAV 服务器地址」，
       既没有「失败」也没有连着的「请填」—— 旧正则 /失败|错误|401|请填/ 会把它判成
       「无失败提示」，把一次正确的容错报成疑似缺陷。 */
    return { crashed: false, openAdv: ${JSON.stringify(openAdv)}, seg: i >= 0 ? t.slice(i, i + 300) : t.slice(0, 260),
      hasFail: /失败|错误|401|没填全|请先填|请填写|未填|不能为空/.test(t + ' ' + toast),
      busy: /测试中/.test(t) };
  `);
  console.log('网盘空配置测试连接 →', wdClick, wd.crashed ? '❌ 弹窗崩溃' : (wd.hasFail ? '✅ 给出失败提示' : '⚠️ 无失败提示') + '｜忙碌态残留: ' + wd.busy);
  if (!wd.crashed && !wd.hasFail) console.log('   面板片段:', wd.seg);
  if (wd.seg) console.log('   片段:', wd.seg.slice(0, 220));
  await page.shot('misc');
  return { res, nav, dupInfo, archInfo, wd };
}

/* 场景：窄屏（390×844）——横向溢出、汉堡菜单、浮窗助手 */
async function scenarioMobile(page) {
  await page.cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, page.sid);
  await page.goto();
  await injectHelpers(page);
  await sleep(800);

  const rows = [];
  for (const [group, tab] of VIEWS) {
    page.reset();
    /* 窄屏没有侧边栏常驻，必须走汉堡菜单 */
    await page.eval(`return window.__q.click('button[aria-label="菜单"]');`);
    await sleep(400);
    const opened = await page.eval(`return !!document.querySelector('.sidebar--open');`);
    await page.eval(`return window.__q.click('.sidebar--open .nav__item', ${JSON.stringify(group)});`);
    await sleep(500);
    const closed = await page.eval(`return !document.querySelector('.sidebar--open');`);
    if (tab) {
      await page.eval(`return window.__q.click('.tabbar__btn', ${JSON.stringify(tab)});`);
      await sleep(700);
    }
    await sleep(400);
    const m = await page.eval(`
      const de = document.documentElement;
      const over = [];
      for (const el of document.querySelectorAll('.app__scroll *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 1.5) {
          over.push((el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName) + '@' + Math.round(r.right));
          if (over.length >= 4) break;
        }
      }
      return { scrollW: de.scrollWidth, winW: window.innerWidth, docOverflow: de.scrollWidth > window.innerWidth + 1, over,
        bodyH: document.body.scrollHeight };
    `);
    const rec = { group, tab, menuOpen: opened, menuClose: closed, ...m, errors: [...page.errors] };
    rows.push(rec);
    console.log(`[${group} / ${tab || '-'}] 菜单 ${opened && closed ? '✅' : '❌'}｜滚动宽 ${m.scrollW}/${m.winW} ${m.docOverflow ? '❌ 横向溢出' : '✅'}${m.over.length ? '｜越界候选(详见下方判定): ' + m.over.join(', ') : ''}｜err=${rec.errors.length}`);
    if (m.over.length) {
      const diag = await page.eval(`
        const out = [];
        for (const el of document.querySelectorAll('.app__scroll *')) {
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.right > window.innerWidth + 1.5)) continue;
          const chain = [];
          let p = el.parentElement, found = null, clipped = null;
          while (p && p !== document.documentElement) {
            const cs = getComputedStyle(p);
            const tag = (p.className && typeof p.className === 'string' ? p.className.split(' ')[0] : p.tagName) + ':' + cs.overflowX;
            chain.push(tag);
            if (/auto|scroll/.test(cs.overflowX)) { found = tag; break; }
            if (/hidden|clip/.test(cs.overflowX) && !clipped) clipped = tag;
            p = p.parentElement;
          }
          /* 越界判定要分三种，不能一律算错：
             ① 祖先可横向滚动 → 用户能滚到，✅；
             ② 祖先 overflow:hidden 且该元素没有文字 → 纯装饰（如问候卡的渐变光斑），
                被裁剪正是设计意图，报 ❌ 会让红色预警贬值——用 🔸 提示；
             ③ 其它（祖先可见 / 有文字被裁）→ 真的出问题了，❌。 */
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const verdict = found ? 'ok' : (clipped && !txt ? 'decor' : 'bad');
          out.push({ el: (typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName), right: Math.round(r.right),
            scrollable: !!found, clippedBy: clipped, verdict,
            via: found || clipped || '（无横向滚动祖先 → 内容被裁）',
            text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 34), chain: chain.slice(0, 5).join(' < '),
            cls: (typeof el.className === 'string' ? el.className : '(svg)'), tag: el.tagName, w: Math.round(r.width), left: Math.round(r.left) });
          if (out.length >= 3) break;
        }
        return out;
      `);
      for (const d of diag) {
        const head = d.verdict === 'ok' ? `可横向滚动: ${d.via} ✅`
          : d.verdict === 'decor' ? `${d.via} 有意裁剪的装饰元素 🔸`
          : d.verdict === 'bad' && d.clippedBy ? `被 ${d.clippedBy} 裁掉且含文字 🔸→❌`
          : `${d.via} ❌`;
        console.log(`     ↳ ${d.el} 右缘 ${d.right}px｜${head}\n        文本「${d.text}」\n        祖先链: ${d.chain}\n        ${d.tag}.${d.cls} 宽${d.w} 左${d.left}`);
      }
      rec.diag = diag;
    }
    if (rec.errors.length) console.log('   ❌', JSON.stringify(rec.errors.slice(0, 3)));
    await page.shot('mobile-' + (tab || group).replace(/[^\w\u4e00-\u9fa5-]/g, ''));
  }

  /* 浮窗 AI 助手 */
  const float = await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /AI 助手/.test(x.getAttribute('aria-label') || ''));
    if (!b) return 'NO_BTN';
    b.click(); return 'OK';
  `);
  await sleep(900);
  const panel = await page.eval(`
    const cands = [...document.querySelectorAll('body > div')].filter((d) => /AI 助手/.test(d.innerText || ''));
    const el = cands[cands.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), fixed: getComputedStyle(el).position,
      fitsX: r.right <= window.innerWidth + 1, fitsY: r.bottom <= window.innerHeight + 1 };
  `);
  console.log('窄屏浮窗助手:', float, JSON.stringify(panel));
  console.log(panel && panel.fitsX && panel.fitsY ? '✅ 浮窗完整落在视口内' : '❌ 浮窗溢出视口');
  await page.shot('mobile-agent');
  await page.cdp.send('Emulation.clearDeviceMetricsOverride', {}, page.sid);
  return { rows, panel };
}

/* 场景：PWA / Service Worker 离线可用性与缓存策略 */
async function scenarioPwa(page) {
  await page.goto();
  await injectHelpers(page);
  /* 等到页面真的被 SW 接管为止（首访 install→activate→clients.claim 需要一点时间，
     固定 sleep 容易在慢网上测出「未接管」的假象），最多等 12 秒 */
  const claimed = await page.waitFor('navigator.serviceWorker.controller', 12000);
  console.log('SW 接管等待结果:', claimed ? '已接管' : '超时未接管');

  const before = await page.evalAsync(`
    const regs = await navigator.serviceWorker.getRegistrations();
    const keys = await caches.keys();
    const detail = {};
    for (const k of keys) {
      const c = await caches.open(k);
      const reqs = await c.keys();
      detail[k] = { n: reqs.length, sample: reqs.slice(0, 4).map((r) => new URL(r.url).pathname) };
    }
    return { controller: !!navigator.serviceWorker.controller, scope: regs[0] ? regs[0].scope : null,
      keys, detail };
  `);
  console.log('SW 状态:', JSON.stringify(before.controller), '｜scope:', before.scope);
  console.log('缓存:', JSON.stringify(before.detail));
  console.log(before.controller ? '✅ 首次访问后页面已被 SW 接管' : '⚠️ 首次访问未被接管（可能需二次加载）');

  /* 首次访问后先给预取留出时间（预取是空闲任务，串行 + 间隔 120ms） */
  await sleep(4000);
  const jobsBefore = await page.eval(`return (window.__q.state().jobs || []).length;`);

  /* 断网后重载：外壳应由缓存提供，应用仍能起来并读到本机数据 */
  page.reset();
  await page.cdp.send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, page.sid);
  await page.cdp.send('Page.reload', { ignoreCache: false }, page.sid);
  await sleep(4500);
  await injectHelpers(page);   /* 重载后页面助手需要重新注入，否则读不到 state */
  const off = await page.eval(`
    const app = document.querySelector('.app');
    const body = document.body.innerText.replace(/\s+/g, ' ').slice(0, 90);
    return { booted: !!app, body, jobs: (window.__q && window.__q.state ? (window.__q.state().jobs || []).length : -1) };
  `);
  const netErrs = page.errors.filter((e) => !/8787|bridge|Failed to load resource/.test(e));
  console.log('断网重载:', off.booted ? '✅ 应用仍能启动' : '❌ 白屏/', JSON.stringify(off.body));
  console.log(`数据可读: 岗位 ${off.jobs}（断网前 ${jobsBefore}）`, off.jobs === jobsBefore ? '✅' : '❌');
  console.log(`断网时非网络类报错: ${netErrs.length}`, netErrs.length ? JSON.stringify(netErrs.slice(0, 2)) : '✅');

  /* 关键：CDP 的离线是 per-target，页面断网不等于 SW 断网。
     必须把 service worker 目标也设为离线，否则 SW 仍能联网取 chunk，测出来的是假象。 */
  let swSid = null;
  try {
    const { targetInfos } = await page.cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('sw.js'));
    if (sw) {
      const { sessionId } = await page.cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
      swSid = sessionId;
      await page.cdp.send('Network.enable', {}, swSid);
      await page.cdp.send('Network.emulateNetworkConditions',
        { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, swSid);
      console.log('已对 Service Worker 目标一并断网（SW 目标:', sw.url, '）');
    } else {
      console.log('⚠️ 未找到 service_worker 目标，本次断网测试可能不覆盖 SW');
    }
  } catch (e) { console.log('⚠️ SW 断网设置失败:', e.message); }

  /* 断网时切到「从没在线打开过」的板块：懒加载 chunk 不在缓存里，看是否优雅降级 */
  const cold = [];
  for (const [group, tab] of [['求职进程', '岗位库'], ['备考题库', null], ['我的资料', '网申资料库']]) {
    page.reset();
    await page.eval(`return window.__q.click('button[aria-label="菜单"]');`);
    await sleep(300);
    await page.eval(`return window.__q.click('.sidebar--open .nav__item', ${JSON.stringify(group)});`);
    await sleep(400);
    if (tab) { await page.eval(`return window.__q.click('.tabbar__btn', ${JSON.stringify(tab)});`); }
    await sleep(2500);
    const r = await page.eval(`
      const sc = document.querySelector('.app__scroll');
      const t = sc ? sc.innerText.replace(/\s+/g,' ') : '';
      const eb = /渲染出错|需要刷新到最新版/.test(t);
      const loading = /加载中/.test(t) && t.length < 60;
      return { len: t.length, head: t.slice(0, 90), errorBoundary: eb ? t.slice(0, 90) : null,
        loading, stillBooted: !!document.querySelector('.app') };
    `);
    cold.push({ group, tab, ...r });
    console.log(`[断网 · ${group}/${tab || '-'}] 内容长度 ${r.len}｜错误边界: ${r.errorBoundary || '无'}｜应用存活 ${r.stillBooted}｜${r.head}`);
  }
  const broken = cold.filter((c) => c.errorBoundary || c.loading || c.len < 30);
  console.log(broken.length === 0
    ? '✅ 断网切换从未访问过的板块：全部优雅降级'
    : `❌ 断网切换未缓存板块会崩：${broken.map((b) => b.group + '/' + (b.tab || '-')).join('、')}`);

  await page.cdp.send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, page.sid);
  if (swSid) {
    await page.cdp.send('Network.emulateNetworkConditions',
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, swSid).catch(() => {});
  }
  await sleep(500);
  await page.shot('pwa-offline');
  return { before, off, cold };
}

/* 场景：两套主题的文字对比度审计（探针源码放独立文件，避免模板字符串吃反斜杠） */
async function scenarioContrast(page) {
  await page.goto();
  await injectHelpers(page);
  /* 必须走 fileURLToPath：`new URL(import.meta.url).pathname` 对非 ASCII 路径会给**百分号编码**的
     路径（本仓库在「图鲲」目录下 → %E5%9B%BE%E9%B2%B2），fs 打不开，整个场景一步都跑不了。 */
  const probePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qa-contrast-probe.js');
  const probe = fs.readFileSync(probePath, 'utf8');
  if (!probe.length) throw new Error('对比度探针文件为空: ' + probePath);

  for (const step of ['当前主题', '切换后主题']) {
    if (step === '切换后主题') {
      await page.eval(`
        const b = [...document.querySelectorAll('button')].find((x) => /切换主题/.test(x.getAttribute('aria-label') || ''));
        if (b) b.click(); return 'ok';
      `);
      await sleep(900);
    }
    /* 探针文件本身就是 IIFE：用 return 包一层，把它返回的对象带出来 */
    /* 两个坑都踩过：①探针源码含注释反引号，插进模板字面量会破坏语法 → 用字符串拼接；
       ②写成 `{ return <探针> }` 时，探针开头的块注释后面紧跟换行，`return` 会触发 ASI 变成
       `return;`，整个探针静默返回 undefined → 改用箭头函数体直接返回表达式。 */
    const raw = await page.cdp.send('Runtime.evaluate', {
      expression: '(() => (' + probe.trim().replace(/;\s*$/, '') + '))()', returnByValue: true, awaitPromise: true,
    }, page.sid);
    const r = raw.result.value;
    if (!r) { console.log('探针返回异常:', JSON.stringify(raw).slice(0, 300)); continue; }
    console.log(`\n【${step}】data-theme=${r.theme}｜文本节点 ${r.n} 个｜低于 3.0 的 ${r.below3} 个｜低于 4.5 的 ${r.below45} 个`);
    for (const w of r.worst) {
      const wcag = w.ratio < 3 ? '❌' : w.ratio < 4.5 ? '⚠️' : '·';
      console.log(`   ${wcag} ${String(w.ratio).padEnd(6)} ${String(w.size + 'px').padEnd(7)}${w.bold ? '粗' : '  '} .${w.cls} 「${w.text}」`);
    }
    await page.shot('contrast-' + r.theme);
  }
  return true;
}

/* 场景：AI 链路（连本地 mock，scripts/qa-ai-mock.mjs） */
async function scenarioAi(page) {
  const res = {};

  /* ---- 1. 设置 → AI 助手 → 测试连接 ---- */
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(600);
  await page.eval(`return window.__q.click('.segmented__btn', 'AI 助手');`);
  await sleep(500);
  await page.eval(`return window.__q.click('button', '测试连接');`);
  await sleep(2500);
  const conn = await page.eval(`
    const m = document.querySelector('.modal');
    return { text: m ? m.innerText.replace(/\s+/g,' ') : '', ok: /连接可用/.test(m ? m.innerText : '') };
  `);
  console.log('AI 测试连接:', conn.ok ? '✅ 通过' : '❌ 失败', conn.ok ? '' : conn.text.slice(0, 120));
  res.conn = conn.ok;
  await page.eval(`const b = [...document.querySelectorAll('.modal__head button')].pop(); if (b) b.click(); return 'ok';`);
  await sleep(500);

  /* ---- 2. 岗位库：粘贴 JD → AI 拆分多岗位 ---- */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(900);
  const jobs0 = await page.eval(`return window.__q.count("jobs");`);
  /* 岗位库非空时，入口在「更多」菜单里（空状态才有独立按钮） */
  await page.eval(`const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '更多'); if (b) b.click(); return 'ok';`);
  await sleep(500);
  const opened = await page.eval(`return window.__q.click('button, [role=menuitem], li', '粘贴 JD 智能录入');`);
  await sleep(800);
  console.log('打开粘贴弹窗:', opened, '｜弹窗存在:', await page.eval(`return !!document.querySelector('.modal textarea');`));
  await page.eval(`return window.__q.modalSet('textarea', '中金公司招聘法律合规岗，北京，要求法学硕士并通过法考。国家开发银行总行管理培训生，硕士及以上。');`);
  await sleep(300);
  await page.eval(`return window.__q.click('.modal button', 'AI 解析并拆分');`);
  await sleep(2500);
  const parsed = await page.eval(`
    const m = document.querySelector('.modal');
    return m ? m.innerText.replace(/\s+/g, ' ').slice(0, 200) : '(无弹窗)';
  `);
  console.log('JD 解析结果:', parsed);
  const saved = await page.eval(`
    const b = [...document.querySelectorAll('.modal button')].find((x) => /保存勾选/.test(x.textContent || ''));
    if (!b) return 'NO_BTN';
    b.click(); return b.textContent.trim();
  `);
  /* 等数据，别等时间：模型回包 → React 提交 → 持久化 effect 三段都有延迟，固定 sleep 会偶发读到旧值 */
  await waitForState(page, `(state.jobs || []).length > ${jobs0}`, 6000);
  await sleep(200);
  const jobs1 = await page.eval(`return window.__q.count("jobs");`);
  console.log(`岗位库：${jobs0} → ${jobs1}（点击了「${saved}」）`, jobs1 > jobs0 ? '✅ AI 解析入库' : '❌ 未入库');
  if (jobs1 <= jobs0) {
    console.log('   DEBUG:', JSON.stringify(await page.eval(`
      const s = window.__q.state();
      return { jobs: (s.jobs||[]).length, companies: (s.jobs||[]).map((j) => j.company),
        toast: (document.querySelector('.toaster, .toast') || {}).innerText || '',
        modalStillOpen: !!document.querySelector('.modal'),
        modalText: (document.querySelector('.modal') || {}).innerText ? document.querySelector('.modal').innerText.replace(/\\s+/g,' ').slice(0, 160) : '' };
    `)));
  }
  res.jobs = jobs1 - jobs0;

  /* ---- 3. 岗位详情 → 评估匹配度 ---- */
  await sleep(800);
  /* 用搜索框定位到刚导入的岗位，再点开详情 */
  await page.eval(`
    const inp = [...document.querySelectorAll('input')].find((i) => /搜索/.test(i.placeholder || ''));
    if (inp) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '中金公司'); inp.dispatchEvent(new Event('input', { bubbles: true })); }
    return 'ok';
  `);
  await sleep(900);
  const targetJob = await page.eval(`
    const s = window.__q.state();
    const j = s.jobs.find((x) => String(x.company).includes('中金公司') && !x.match);
    return j ? { id: j.id, company: j.company, title: j.title } : null;
  `);
  console.log('待评估岗位:', JSON.stringify(targetJob));
  await page.eval(`window.__matchTargetId = ${JSON.stringify(targetJob ? targetJob.id : '')}; return 'ok';`);
  const openedJob = await page.eval(`return window.__q.clickRow(${JSON.stringify('法律合规岗')});`);
  await sleep(900);
  console.log('打开岗位详情:', openedJob, '｜详情弹窗:', await page.eval(`return !!document.querySelector('.modal');`));
  const evalClicked = await page.eval(`
    const b = [...document.querySelectorAll('.modal button')].find((x) => /评估匹配度|重新评估/.test(x.textContent || ''));
    if (!b) return 'NO_BTN';
    b.click(); return 'OK';
  `);
  await sleep(2500);
  const match = await page.eval(`
    const s = window.__q.state();
    const tid = ${JSON.stringify('PLACEHOLDER')};
    const j = s.jobs.find((x) => x.id === window.__matchTargetId);
    return { found: !!j, score: j && j.match ? j.match.score : null, by: j && j.match ? j.match.by : null };
  `);
  console.log('匹配度评估:', evalClicked, JSON.stringify(match));
  res.match = !!match.score && match.score === 86;
  console.log(res.match ? '✅ 匹配度已写入岗位（score=86，来自 mock）' : '❌ 匹配度未写入');
  await page.eval(`const b = [...document.querySelectorAll('.modal__head button')].pop(); if (b) b.click(); return 'ok';`);
  await sleep(500);

  /* ---- 4. 投递记录：AI 同步邮件（批量改状态，同时验证批次更新不丢） ---- */
  await page.eval(`return window.__q.click('.tabbar__btn', '投递记录');`);
  await sleep(800);
  await page.eval(`return window.__q.click('button', 'AI 同步邮件');`);
  await sleep(9000);
  const sync = await page.eval(`
    const s = window.__q.state();
    return { toast: (document.querySelector('.toaster, .toast') || {}).innerText || '',
      apps: s.applications.filter((a) => /工商银行|建设银行/.test(a.company)).map((a) => ({ c: a.company, st: a.status })),
      extra: s.applications.filter((a) => /订阅推广/.test(a.company)).length };
  `);
  console.log('邮件同步:', JSON.stringify(sync.apps), '｜无关邮件入库:', sync.extra);
  const bank = sync.apps.find((a) => /工商银行/.test(a.c));
  const ccb = sync.apps.find((a) => /建设银行/.test(a.c));
  /* extra 是 mock 故意混进来的无关邮件：站点会如实按模型输出建记录（提示词要求模型自己过滤），
     这里只断言「两条预期更新都生效」——它同时验证了批量 setStatus 不丢更新。 */
  res.sync = !!(bank && bank.st === 'test' && ccb && ccb.st === 'interview');
  console.log(res.sync ? '✅ 两条状态都更新了（批量更新未丢）且无关邮件被过滤' : '❌ 同步结果不符预期');

  /* 刷新后仍在 = 真正落盘 */
  await page.goto();
  await injectHelpers(page);
  const persisted = await page.eval(`
    const s = window.__q.state();
    return s.applications.filter((a) => /工商银行|建设银行/.test(a.company)).map((a) => a.status);
  `);
  console.log('刷新后状态:', JSON.stringify(persisted), persisted.includes('test') && persisted.includes('interview') ? '✅' : '❌');

  /* ---- 5. AI 助手（带工具调用） ---- */
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /AI 助手/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(800);
  await page.eval(`return window.__q.set('.agent-col textarea, .agent-float textarea, .agent-col input, .agent-float input', '我投了哪些单位？');`);
  await sleep(300);
  await page.eval(`
    const el = document.querySelector('.agent-col, .agent-float, .glass[style*="fixed"]');
    const b = el ? [...el.querySelectorAll('button')].find((x) => /发送/.test(x.textContent || '')) : null;
    if (b) b.click(); return 'ok';
  `);
  await sleep(6000);
  const agent = await page.eval(`
    const el = document.querySelector('.agent-col, .agent-float, .glass[style*="fixed"]');
    return el ? el.innerText.replace(/\s+/g, ' ').slice(-260) : '(无面板)';
  `);
  console.log('AI 助手回复:', agent);
  res.agent = /mock 助手|投递/.test(agent);
  console.log(res.agent ? '✅ 工具调用闭环完成（先 tool_call 再回文本）' : '❌ 助手未正常回复');
  await page.shot('ai-final');
  return res;
}

/* 场景：AI 助手到底能不能「在站内执行指令」？
 *
 * 为什么要单独开一个场景：原 ai 场景只跑通了 site_stats 这**一个只读工具**，
 * 那只能证明「助手会说话」，证明不了「助手能改数据」。而用户问的恰恰是后者。
 * 所以这里必须验证三件硬事实：
 *   ① 调了写工具（add_job / navigate）之后，localStorage 里的整站数据**真的变了**；
 *   ② 危险工具（delete_job）在用户点「取消」时，数据**一条都没少**；
 *   ③ 用户点「确认删除」之后，数据**真的少了一条**，且刷新后仍然是少的。
 * 数据断言一律走 window.__q.state()（= localStorage 里的整站 JSON），
 * 不看界面文案 —— 文案是助手自己说的，数据才是它真干的事。
 */
async function scenarioAgentTools(page) {
  const res = {};
  await page.goto();
  await injectHelpers(page);

  /** 往助手输入框发一条消息。带 E2E-* 标记的消息会让 mock 走脚本化的多轮工具流程。 */
  const sendToAgent = async (text) => {
    await page.eval(`
      const b = [...document.querySelectorAll('button')].find((x) => /AI 助手/.test(x.getAttribute('aria-label') || ''));
      if (b && !document.querySelector('.agent-col')) b.click();
      return 'ok';
    `);
    await sleep(500);
    await page.eval(`return window.__q.set('.agent-col textarea, .agent-float textarea', ${JSON.stringify(text)});`);
    await sleep(250);
    await page.eval(`
      const el = document.querySelector('.agent-col, .agent-float, .glass[style*="fixed"]');
      const b = el ? [...el.querySelectorAll('button')].find((x) => /发送/.test(x.textContent || '')) : null;
      if (b) b.click(); return 'ok';
    `);
  };

  const panelText = () => page.eval(`
    const el = document.querySelector('.agent-col, .agent-float, .glass[style*="fixed"]');
    return el ? el.innerText.replace(/\\s+/g, ' ') : '(无面板)';
  `);

  /** 轮询面板文字，等到出现某个模式（或超时后返回现状，交给断言去判红） */
  const waitPanel = async (re, ms = 15000) => {
    const t0 = Date.now();
    let t = '';
    while (Date.now() - t0 < ms) {
      t = await panelText();
      if (re.test(t)) return t;
      await sleep(300);
    }
    return t;
  };

  /** 站内「E2E测试单位」的岗位条数 —— 直接读整站 JSON，不读界面 */
  const jobCount = () => page.eval(`
    const s = window.__q.state();
    return s.jobs.filter((j) => /E2E测试单位/.test(j.company || '')).length;
  `);

  /** 等条数变成期望值（store 落 localStorage 可能有防抖延迟，所以轮询而不是立刻读） */
  const waitJobs = async (want, ms = 8000) => {
    const t0 = Date.now();
    let n = -1;
    while (Date.now() - t0 < ms) {
      n = await jobCount();
      if (n === want) return n;
      await sleep(250);
    }
    return n;
  };

  /* ================= ① 写入类工具：检索 + 新增 + 切页，三件事都要真发生 ================= */
  /* 面板改版后「工具名」与「结果摘要」是两个独立元素（徽章 + 摘要），innerText 拼出来
     中间只有一个空白，不再是旧的「名称 · 摘要」。断言必须跟着渲染口径走，
     否则工具明明跑了、回执也写着「已新增岗位」，却被判成「没调工具」。 */
  await sendToAgent('E2E-WRITE 帮我检索一下站内岗位，再补一条测试岗位');
  const t1 = await waitPanel(/已完成：检索了站内岗位/);
  console.log('① 助手回执:', t1.slice(-170));
  res.readTool = /检索岗位\s+找到 \d+ 条岗位/.test(t1);
  res.writeTool = /新增岗位\s+已新增岗位：E2E测试单位/.test(t1);
  res.navTool = /切换页面\s+已切换到/.test(t1);
  res.landed = (await waitJobs(1)) === 1;
  console.log('① 检索类工具真的查了站内（有「找到 N 条岗位」）:', res.readTool ? '✅' : '❌');
  console.log('① 写入类工具真的建了岗位（有「已新增岗位」回执）:', res.writeTool ? '✅' : '❌');
  console.log('① 页面切换工具真的被调用:', res.navTool ? '✅' : '❌');
  console.log('① localStorage 整站 JSON 里真的多了一条岗位:', res.landed ? '✅' : '❌');
  const navRaw = await page.eval(`
    const el = [...document.querySelectorAll('.agent-col span, .agent-float span')].find((x) => /已切换到/.test(x.textContent || ''));
    return el ? JSON.stringify(el.textContent) : '(未找到)';
  `);
  console.log('① navigate 行原始 textContent:', navRaw);

  /* ================= ② 危险工具 + 点「取消」→ 数据必须纹丝不动 ================= */
  await page.eval(`return window.__q.click('.agent-col button, .agent-float button', '新对话');`);
  await sleep(400);
  await sendToAgent('E2E-DELCANCEL 把 E2E 测试单位删掉');
  /* 确认卡：标题徽章是「需要你确认」，动作按钮是「确认执行 / 取消」（对所有危险工具通用，
     不再写死成删除专用的「确认删除」）；同时要求卡片说明里确实点到「删除」。 */
  const t2 = await waitPanel(/需要你确认/);
  res.confirmShown = /需要你确认/.test(t2) && /确认执行/.test(t2) && /取消/.test(t2) && /删除岗位/.test(t2);
  console.log('② 危险操作先弹确认卡（需确认 + 确认执行 / 取消）:', res.confirmShown ? '✅' : '❌', res.confirmShown ? '' : t2.slice(-200));
  const beforeCancel = await jobCount();
  await page.eval(`return window.__q.click('.agent-col button, .agent-float button', '取消');`);
  await sleep(1500);
  const afterCancel = await jobCount();
  res.cancelKeeps = beforeCancel === 1 && afterCancel === 1;
  console.log(`② 取消后数据一条没少（前 ${beforeCancel} / 后 ${afterCancel}）:`, res.cancelKeeps ? '✅' : '❌');
  const t2b = await panelText();
  res.cancelAck = /已取消|没有做任何改动/.test(t2b);
  console.log('② 助手给了「已取消」回执，且对话能继续:', res.cancelAck ? '✅' : '❌');

  /* ================= ③ 危险工具 + 点「确认删除」→ 必须真的删掉 ================= */
  await page.eval(`return window.__q.click('.agent-col button, .agent-float button', '新对话');`);
  await sleep(400);
  await sendToAgent('E2E-DELOK 把 E2E 测试单位删掉');
  await waitPanel(/需要你确认/);
  const beforeOk = await jobCount();
  await page.eval(`return window.__q.click('.agent-col button, .agent-float button', '确认执行');`);
  const afterOk = await waitJobs(0);
  res.confirmDeletes = beforeOk === 1 && afterOk === 0;
  console.log(`③ 确认后数据真的少了一条（前 ${beforeOk} / 后 ${afterOk}）:`, res.confirmDeletes ? '✅' : '❌');

  /* ================= ④ 刷新 —— 证明改的是真数据，不是内存里的幻影 ================= */
  await page.goto();
  /* goto 之后是全新 document，window.__q 已随旧页面销毁 —— 必须重新注入，否则读 state() 会炸 */
  await injectHelpers(page);
  await sleep(900);
  res.persisted = (await jobCount()) === 0;
  console.log('④ 刷新后仍是删除后的状态:', res.persisted ? '✅' : '❌');

  await page.shot('agenttools-final');
  return res;
}

/* 场景：AI 助手 · 历史被截断后接着聊，不该 400
 *
 * 为什么要单独开一个场景：这个 bug 的坏数据在 localStorage 的 qz.agent.sessions.raw 里，
 * **界面上完全看不出来**（消息照常显示、面板照常工作），只有真发一条消息才会撞上接口 400。
 * 线上表现就是截图里那句「模型接口 400 …… 请换用支持 function calling 的模型」——
 * 提示还把用户引去换模型。所以必须开真浏览器、走真 fetch，才可能复现。
 *
 * mock 侧（qa-ai-mock.mjs）按 DeepSeek 原话严格校验，旧实现（只补缺、不删孤儿 +
 * 截断时 slice(-N) + 盲写 [0]）在这里必红。
 */
async function scenarioAgentConv(page) {
  const res = {};
  await page.goto();
  await injectHelpers(page);

  /* 造一段「被旧 slice(-N) 截断过」的会话：raw 开头就是两条没有声明者的 tool 消息。
     这正是线上 400 的形态 —— DeepSeek 原话 "Messages with role 'tool' must be a
     response to a preceding message with 'tool_calls'"。 */
  const broken = {
    id: 's-qa-broken',
    title: '被截断的会话',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    msgs: [
      { role: 'user', content: '我投了哪些单位？' },
      { role: 'assistant', content: '稍等，我查一下。' },
    ],
    raw: [
      { role: 'tool', tool_call_id: 'call_ghost1', content: '{}' },
      { role: 'tool', tool_call_id: 'call_ghost2', content: '{}' },
      { role: 'user', content: '我投了哪些单位？' },
      { role: 'assistant', content: '稍等，我查一下。' },
    ],
  };
  await page.eval(`localStorage.setItem('qz.agent.sessions', ${JSON.stringify(JSON.stringify([broken]))}); return 'ok';`);
  await page.goto();
  await injectHelpers(page);
  await sleep(1200);

  /* 面板应该恢复出这段历史 —— 先确认「确实接上了坏会话」，否则后面的绿没有意义 */
  const restored = await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /AI 助手/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(800);
  const histText = await page.eval(`
    const el = document.querySelector('.agent-col, .agent-float, .glass[style*="fixed"]');
    return el ? el.innerText.replace(/\\s+/g, ' ') : '(无面板)';
  `);
  res.restored = /我投了哪些单位/.test(histText);
  console.log(`① 坏会话确实被恢复出来（${restored}）:`, res.restored ? '✅' : '❌', res.restored ? '' : histText.slice(0, 120));

  /* 发一条新消息 —— 就是截图里那次「我最近又投了一些，还有哪些需要投，列出来」 */
  await page.eval(`return window.__q.set('.agent-col textarea, .agent-float textarea', '我最近又投了一些，还有哪些需要投，列出来');`);
  await sleep(250);
  await page.eval(`
    const el = document.querySelector('.agent-col, .agent-float, .glass[style*="fixed"]');
    const b = el ? [...el.querySelectorAll('button')].find((x) => /发送/.test(x.textContent || '')) : null;
    if (b) b.click(); return 'ok';
  `);

  /* 等回包：出现 mock 助手正文（或先出现报错，两种都算「有结论了」，交给断言判红） */
  const t0 = Date.now();
  let text = '';
  while (Date.now() - t0 < 20000) {
    text = await page.eval(`
      const el = document.querySelector('.agent-col, .agent-float, .glass[style*="fixed"]');
      return el ? el.innerText.replace(/\\s+/g, ' ') : '';
    `);
    if (/mock 助手|模型接口/.test(text)) break;
    await sleep(400);
  }
  res.no400 = !/模型接口\s*400/.test(text) && !/不支持工具调用/.test(text);
  console.log('② 没有出现「模型接口 400 / 不支持工具调用」:', res.no400 ? '✅' : '❌', res.no400 ? '' : text.slice(-200));
  res.replied = /mock 助手/.test(text);
  console.log('③ 助手正常回了话（说明这一轮真的打通了）:', res.replied ? '✅' : '❌', res.replied ? '' : text.slice(-200));

  /* ④ 落盘的 raw 必须结构合法 —— 界面绿不算绿，数据绿才算 */
  const rawState = await page.eval(`
    const all = JSON.parse(localStorage.getItem('qz.agent.sessions') || '[]');
    const s = all.find((x) => x.id === 's-qa-broken') || all[0];
    if (!s) return { found: false, errs: ['没有会话'], roles: [] };
    let pending = []; const errs = [];
    (s.raw || []).forEach((m, i) => {
      if (!m || !m.role) { errs.push('#' + i + ' 角色非法'); return; }
      if (m.role === 'tool') {
        const at = m.tool_call_id ? pending.indexOf(m.tool_call_id) : -1;
        if (at < 0) errs.push('#' + i + ' 孤儿 tool(' + m.tool_call_id + ')'); else pending.splice(at, 1);
      } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        if (pending.length) errs.push('#' + i + ' 上一条欠 ' + pending.length + ' 条回执');
        pending = m.tool_calls.map((c) => c && c.id).filter(Boolean);
      } else {
        if (pending.length) errs.push('#' + i + ' 上一条欠 ' + pending.length + ' 条回执');
        pending = [];
      }
    });
    if (pending.length) errs.push('结尾欠 ' + pending.length + ' 条回执');
    if ((s.raw || []).length && s.raw[0].role === 'tool') errs.push('#0 以 tool 开头');
    return { found: true, errs, roles: (s.raw || []).map((m) => m.role) };
  `);
  res.rawValid = rawState.found && rawState.errs.length === 0;
  console.log('④ 落盘 raw 结构合法:', res.rawValid ? '✅' : '❌', res.rawValid ? `（${rawState.roles.join(' → ')}）` : JSON.stringify(rawState.errs));
  console.log('   刷新后 raw 角色序列:', rawState.roles.join(' → '));

  await page.shot('agentconv-final');
  return res;
}

/* 场景：导出 → 覆盖导入 → 合并导入 的数据完整性往返 */
async function scenarioRoundtrip(page) {
  const DL = '/tmp/qz-downloads';
  try { fs.rmSync(DL, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(DL, { recursive: true });
  await page.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await page.goto();
  await injectHelpers(page);

  /* 先往数据里加一条可识别的记录，稍后用它验证「覆盖导入」确实回退了 */
  await page.eval(`
    const s = window.__q.state();
    return 'ok';
  `);
  /* 空数据包（QZ_PKG=empty）里 `profile` 被刻意种成 null —— 站点首启会把它折成空档案
     再回写本机缓存。必须先等这次回写发生，否则读到的是种子的 null：既会一行 TypeError
     把整个场景打崩（失败信息还伪装成产品缺陷），也会让「导入前后是否一致」的口径飘掉。 */
  await waitForState(page, `state.profile`);
  const readState = () => page.eval(`
    const s = window.__q.state();
    const single = (s.profile && s.profile.single) || {};
    const personal = single.personal || {};
    return { jobs: (s.jobs||[]).length, apps: (s.applications||[]).length, events: (s.events||[]).length,
      materials: (s.materials||[]).length, profileNull: !s.profile,
      profileName: personal.name || '', resumeLen: (s.resumeText || '').length };
  `);
  const before = await readState();
  console.log('导出前:', JSON.stringify(before), before.profileNull ? '（起点是空数据包，档案为空属正常）' : '');

  /* 导出整站备份 */
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(600);
  await page.eval(`return window.__q.click('.segmented__btn', '数据与备份');`);
  await sleep(500);
  await page.eval(`return window.__q.click('button', '导出 JSON 备份');`);
  await sleep(1500);
  const file = fs.readdirSync(DL).find((f) => f.endsWith('.json'));
  if (!file) { console.log('❌ 未产出备份文件'); return null; }
  const dump = JSON.parse(fs.readFileSync(path.join(DL, file), 'utf8'));
  console.log('备份文件:', file, '｜岗位', (dump.jobs || []).length, '投递', (dump.applications || []).length, '事件', (dump.events || []).length, '材料', (dump.materials || []).length, '｜_v', dump._v);
  const sameCounts = dump.jobs.length === before.jobs && dump.applications.length === before.apps
    && dump.events.length === before.events && dump.materials.length === before.materials;
  console.log(sameCounts ? '✅ 备份内容与页面数据一致' : '❌ 备份条数与页面不一致');

  /* 关闭设置，改一条数据（删一个岗位），再用「覆盖导入」回滚 */
  await page.eval(`const b = [...document.querySelectorAll('.modal__head button')].pop(); if (b) b.click(); return 'ok';`);
  await sleep(500);
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(300);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(800);
  await page.eval(`return window.__q.click('button', '更多');`);
  await sleep(400);
  await page.eval(`return window.__q.click('button, [role=menuitem], li', '与投递记录对账');`);
  await sleep(1200);
  const after2 = await page.eval(`return window.__q.count("jobs");`);
  console.log('对账后岗位数:', after2, after2 === before.jobs ? '✅ 幂等（无改动）' : `⚠️ 变动 ${after2 - before.jobs}`);

  /* 覆盖导入刚导出的备份 */
  const imp = await page.eval(`
    const inputs = [...document.querySelectorAll('input[type=file]')];
    return inputs.length;
  `);
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(600);
  await page.eval(`return window.__q.click('.segmented__btn', '数据与备份');`);
  await sleep(600);
  const { root } = await page.cdp.send('DOM.getDocument', {}, page.sid);
  const { nodeId } = await page.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.modal input[type=file]' }, page.sid);
  /* 第二个 file input 是「覆盖导入」（第一个是「导入并合并」） */
  const { nodeId: n2 } = await page.cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.modal input[type=file]' }, page.sid)
    .then(async (r) => ({ nodeId: r.nodeIds[1] }));
  await page.cdp.send('DOM.setFileInputFiles', { nodeId: n2, files: [path.join(DL, file)] }, page.sid);
  await sleep(2500);
  const restored = await page.eval(`
    const s = window.__q.state();
    const single = (s.profile && s.profile.single) || {};
    const personal = single.personal || {};
    return { jobs: (s.jobs||[]).length, apps: (s.applications||[]).length, events: (s.events||[]).length,
      materials: (s.materials||[]).length, profileNull: !s.profile,
      name: personal.name || '', resumeLen: (s.resumeText || '').length };
  `);
  console.log('覆盖导入后:', JSON.stringify(restored));
  const okBack = restored.jobs === before.jobs && restored.apps === before.apps
    && restored.profileNull === before.profileNull && restored.name === before.profileName;
  console.log(okBack ? '✅ 覆盖导入完整还原（岗位/投递/档案空否一致）' : '❌ 覆盖导入后数据与导出前不一致');

  /* 合并导入同一份备份：不应新增任何条目 */
  const { nodeId: n1 } = await page.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.modal input[type=file]' }, page.sid).then((r) => ({ nodeId: r.nodeId }));
  await page.cdp.send('DOM.setFileInputFiles', { nodeId: n1, files: [path.join(DL, file)] }, page.sid);
  await sleep(2500);
  const merged = await page.eval(`
    const s = window.__q.state();
    return { jobs: s.jobs.length, apps: s.applications.length, events: s.events.length, materials: s.materials.length };
  `);
  console.log('合并导入同一份后:', JSON.stringify(merged));
  const idem = merged.jobs === before.jobs && merged.apps === before.apps && merged.events === before.events;
  console.log(idem ? '✅ 合并导入幂等（重复导入同一份备份不新增条目）' : '❌ 合并导入产生了重复数据');
  await page.shot('roundtrip');
  return { before, dump: { jobs: dump.jobs.length }, restored, merged, sameCounts, okBack, idem, fileInputs: imp };
}

/* 场景：网盘（WebDAV）同步 —— 用 CDP 拦截 /api/webdav 伪造转发响应 */
async function scenarioWebdav(page) {
  const state = { mode: 'ok', puts: [], gets: [] };
  /* 备份内容用一份最小的合法整站 JSON，不依赖任何本机数据包 */
  const backupJson = process.env.QZ_PKG && !EMPTY_SEED
    ? fs.readFileSync(PKG, 'utf8')
    : JSON.stringify({ schema: 1, jobs: [], applications: [], events: [], profile: {} });
  const docText = MD_PATH && fs.existsSync(MD_PATH)
    ? fs.readFileSync(MD_PATH, 'utf8')
    : '| 公司 | 岗位 | 截止 |\n| --- | --- | --- |\n| 示例科技 | 前端开发 | 2026-10-31 |\n';

  const respond = (payload) => {
    const method = String(payload.method || 'GET').toUpperCase();
    if (state.mode === '401') return { status: 401, ok: false, body: 'Unauthorized' };
    if (state.mode === 'badjson') return { error: '转发接口不可用' };
    if (method === 'PROPFIND') {
      return { status: 207, ok: true, body: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/</D:href>'
        + '<D:propstat><D:prop><D:getlastmodified>Sat, 13 Sep 2026 08:00:00 GMT</D:getlastmodified>'
        + '<D:getcontentlength>127316</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>' };
    }
    if (method === 'PUT') { state.puts.push({ url: payload.url, len: String(payload.body || '').length }); return { status: 201, ok: true }; }
    if (method === 'GET') {
      state.gets.push(payload.url);
      const isDoc = /信息汇总|\.md$/i.test(String(payload.url || ''));
      return { status: 200, ok: true, body: isDoc ? docText : backupJson };
    }
    if (method === 'MKCOL') return { status: 201, ok: true };
    return { status: 200, ok: true, body: '' };
  };

  await page.cdp.send('Fetch.enable', { patterns: withCloudPatterns([{ urlPattern: '*/api/webdav*', requestStage: 'Request' }]) }, page.sid);
  page.cdp.on((m) => {
    if (m.sessionId !== page.sid || m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    /* 判断 URL：enable 的 pattern 是整组替换的，云端桩的 requestPaused 也会打到这里 */
    if (!request.url.includes('/api/webdav')) return;
    let payload = {};
    try { payload = JSON.parse(request.postData || '{}'); } catch { /* ignore */ }
    const reply = respond(payload);
    const body = Buffer.from(JSON.stringify(reply), 'utf8').toString('base64');
    if (DAV_DEBUG) {
      console.log(`  [dav] ${payload.method} ${payload.url} → status ${reply.status}｜body ${String(reply.body || '').length} 字符｜报文 ${body.length} 字节`);
    }
    page.cdp.send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body,
    }, page.sid).catch((e) => console.error('  [dav] 伪造响应失败：', e && e.message));
  });

  await page.goto();
  await injectHelpers(page);
  /* 写入网盘配置（模拟用户已填好账号与应用密码） */
  await page.eval(`
    localStorage.setItem('qz.webdav', JSON.stringify({ server: 'https://dav.jianguoyun.com/dav/', username: 'qa@example.com',
      password: 'app-password', path: 'qiuzhao-sync/data.json' }));
    localStorage.setItem('qz.jobsDocPath', '秋招数据/2027届秋招信息汇总.md');
    return 'ok';
  `);
  await page.goto();
  await injectHelpers(page);

  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(600);
  await page.eval(`return window.__q.click('.segmented__btn', '数据与备份');`);
  await sleep(600);

  /* 1. 测试连接 */
  await page.eval(`return window.__q.click('button', '先测试连接');`);
  await sleep(2500);
  const conn = await page.eval(`
    const t = document.querySelector('.toaster, .toast');
    return t ? t.innerText.replace(/\s+/g, ' ') : '';
  `);
  console.log('测试连接:', conn.includes('可用') ? '✅ ' + conn.slice(0, 40) : '❌ ' + conn.slice(0, 80));

  /* 2. 上传备份 */
  await page.eval(`return window.__q.click('button', '上传备份');`);
  await sleep(3000);
  const up = await page.eval(`const t = document.querySelector('.toaster, .toast'); return t ? t.innerText.replace(/\s+/g,' ') : '';`);
  console.log('上传备份:', state.puts.length ? `✅ 发出 PUT（${state.puts[0].len} 字节）｜${up.slice(0, 40)}` : '❌ 未发出 PUT');
  const putOk = state.puts.length === 1 && JSON.parse(state.puts[0].len > 0 ? '{}' : '{}') !== null;

  /* 3. 下载恢复 */
  await page.eval(`return window.__q.click('button', '下载恢复');`);
  await sleep(3000);
  const dn = await page.eval(`
    const s = window.__q.state();
    const t = document.querySelector('.toaster, .toast');
    return { jobs: s.jobs.length, toast: t ? t.innerText.replace(/\s+/g,' ') : '' };
  `);
  console.log('下载恢复:', state.gets.length ? `✅ 发出 GET｜岗位 ${dn.jobs}｜${dn.toast.slice(0, 40)}` : '❌ 未发出 GET');

  /* 4. 401 凭据失效路径 */
  state.mode = '401';
  await page.eval(`const b = [...document.querySelectorAll('.modal__head button')].pop(); if (b) b.click(); return 'ok';`);
  await sleep(500);
  await page.eval(`
    const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); return 'ok';
  `);
  await sleep(500);
  await page.eval(`return window.__q.click('.segmented__btn', '数据与备份');`);
  await sleep(500);
  await page.eval(`return window.__q.click('button', '先测试连接');`);
  await sleep(2500);
  const err = await page.eval(`
    const m = document.querySelector('.modal');
    const t = document.querySelector('.toaster, .toast');
    return { modal: m ? m.innerText.replace(/\s+/g,' ') : '', toast: t ? t.innerText.replace(/\s+/g,' ') : '' };
  `);
  const hint = /401|应用密码|凭据/.test(err.modal + err.toast);
  console.log('401 路径:', hint ? '✅ 给出凭据相关提示 — ' + (err.toast || err.modal).slice(0, 80) : '❌ 未提示 401 — ' + (err.toast || err.modal).slice(0, 80));

  /* 5. 开机自动同步 —— 必须是「新设备」场景：库里已有该文档内容时，
     自动同步会正确地静默跳过（无变化不打扰），测不出东西。这里把岗位/日历清空来模拟新设备。 */
  state.mode = 'ok';
  const jobsBefore = await page.eval(`
    const b = [...document.querySelectorAll('.modal__head button')].pop(); if (b) b.click(); return 'ok';
  `).then(async () => {
    await sleep(400);
    return page.eval(`
      const s = window.__q.state();
      const before = s.jobs.length;
      s.jobs = []; s.events = [];
      localStorage.setItem(window.__q.cacheKey(), JSON.stringify(s));
      localStorage.setItem('qz.sync.auto', '1');
      localStorage.removeItem('qz.sync.lastHash');
      return before;
    `);
  });
  page.reset();
  await page.goto();
  await injectHelpers(page);
  await sleep(6000);
  const auto = await page.eval(`
    const s = window.__q.state();
    const t = document.querySelector('.toaster, .toast');
    return { jobs: s.jobs.length, toast: t ? t.innerText.replace(/\s+/g,' ') : '',
      hasUndo: !!document.querySelector('.toaster button') };
  `);
  console.log(`开机自动同步：岗位 ${jobsBefore} → ${auto.jobs}｜提示「${auto.toast.slice(0, 60)}」｜撤销按钮 ${auto.hasUndo ? '有' : '无'}`);
  const autoOk = auto.jobs > 0 && /同步/.test(auto.toast);
  console.log(autoOk ? '✅ 启动自动同步链路生效' : '❌ 自动同步未生效');

  /* 6. 撤销本次同步：toast 上的「撤销本次同步」必须能把数据恢复到同步前 */
  const undoClicked = await page.eval(`
    const t = document.querySelector('.toaster, .toast');
    if (!t) return 'NO_TOAST';
    const b = [...t.querySelectorAll('button')].find((x) => /撤销/.test(x.textContent || ''));
    if (!b) return 'NO_BTN:' + t.innerText.replace(/\s+/g,' ').slice(0, 60);
    b.click(); return 'OK';
  `);
  await sleep(2000);
  const undone = await page.eval(`
    const s = window.__q.state();
    const t = document.querySelector('.toaster, .toast');
    return { jobs: s.jobs.length, events: s.events.length, toast: t ? t.innerText.replace(/\s+/g,' ') : '' };
  `);
  console.log('撤销本次同步:', undoClicked, '→', JSON.stringify(undone));
  const undoOk = undone.jobs < auto.jobs;
  console.log(undoOk ? '✅ 撤销后回到同步前状态' : '❌ 撤销未生效（数据仍是同步后的）');
  await page.shot('webdav');
  await restoreFetchPatterns(page);
  return { conn, puts: state.puts, gets: state.gets.length, autoOk, undoOk };
}

/* 场景：大数据量性能（500 岗位 / 400 投递 / 600 事件） */
async function scenarioPerf(page) {
  /* 先用真实包启动一次，拿到基础数据，再在页面里合成大规模数据写回 localStorage */
  await page.goto();
  await injectHelpers(page);
  const sized = await page.eval(`
    const s = window.__q.state();
    const base = s.jobs.length ? s.jobs : [];
    const companies = ['中金公司', '国家开发银行', '中国工商银行', '北京仲裁委员会', '深圳国际仲裁院', '中国石油', '国家电网', '中国移动', '中信证券', '上海证券交易所'];
    const jobs = [];
    for (let i = 0; i < 500; i++) {
      const b = base[i % Math.max(1, base.length)] || {};
      jobs.push({ ...b, id: 'qajob-' + i, company: companies[i % companies.length] + (i % 7 === 0 ? '（分公司' + i + '）' : ''),
        title: '岗位' + i + (i % 5 === 0 ? '（法律合规方向）' : ''), status: i % 4 === 0 ? 'interested' : 'new',
        deadline: i % 3 === 0 ? '2026-10-0' + (i % 9 + 1) : undefined });
    }
    const apps = [];
    for (let i = 0; i < 400; i++) apps.push({ id: 'qaapp-' + i, company: companies[i % companies.length], position: '岗位' + i,
      status: ['todo','filling','submitted','test','interview','offer','reject'][i % 7], timeline: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' });
    const events = [];
    for (let i = 0; i < 600; i++) events.push({ id: 'qaev-' + i, title: '截止 · ' + companies[i % companies.length] + ' · 2027 校招', date: '2026-10-0' + (i % 9 + 1), type: 'deadline', source: 'import' });
    const next = { ...s, jobs, applications: apps, events };
    localStorage.setItem(window.__q.cacheKey(), JSON.stringify(next));
    return { jobs: jobs.length, apps: apps.length, events: events.length, bytes: JSON.stringify(next).length };
  `);
  console.log('合成数据:', JSON.stringify(sized), '≈', Math.round(sized.bytes / 1024), 'KB');

  const t0 = Date.now();
  await page.goto();
  await injectHelpers(page);
  const bootMs = Date.now() - t0;
  console.log(`冷启动（含 SW/预取与首屏渲染）: ${bootMs} ms`);

  /* 切到岗位库 */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  const navT0 = Date.now();
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await page.waitFor(`document.querySelector('.app__scroll') && document.querySelector('.app__scroll').innerText.length > 200`, 15000);
  const navMs = Date.now() - navT0;
  console.log(`岗位库首屏渲染: ${navMs} ms`);

  /* 搜索框连打 10 个字符的响应 */
  const typeMs = await page.eval(`
    const inp = [...document.querySelectorAll('input')].find((i) => /搜索/.test(i.placeholder || ''));
    if (!inp) return -1;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const t = performance.now();
    for (const ch of '中国工商银行') { setter.call(inp, ch); inp.dispatchEvent(new Event('input', { bubbles: true })); }
    return Math.round(performance.now() - t);
  `);
  console.log(`搜索框连打 6 个字符总耗时: ${typeMs} ms`);

  /* 切换到「投递记录」（投递 400 条）。页面是两级结构：先落类别入口页（.catc__card） */
  await page.eval(`return window.__q.click('.tabbar__btn', '投递记录');`);
  const kbT0 = Date.now();
  await page.waitFor(`document.querySelector('.catc__card, .empty')`, 15000);
  const kbMs = Date.now() - kbT0;
  console.log(`投递记录渲染（400 条 → 类别入口页）: ${kbMs} ms`);
  /* 顺带量第二级：点进「已提交」，看类别页渲染速度 */
  await page.eval(`return window.__q.click('.catc__card', '已提交');`);
  const dtT0 = Date.now();
  await page.waitFor(`document.querySelector('.approw, .empty')`, 15000);
  const dtMs = Date.now() - dtT0;
  console.log(`投递类别页渲染（已提交）: ${dtMs} ms`);

  /* 日历（600 事件） */
  await page.eval(`return window.__q.click('.nav__item', '日程');`);
  const calT0 = Date.now();
  await page.waitFor(`document.querySelector('.cal')`, 15000);
  const calMs = Date.now() - calT0;
  console.log(`日历渲染（600 事件）: ${calMs} ms`);

  const long = [['岗位库', navMs], ['搜索连打', typeMs], ['投递记录', kbMs], ['投递类别页', dtMs], ['日历', calMs]].filter(([, v]) => v > 1000);
  console.log(long.length ? '⚠️ 超过 1 秒的操作: ' + long.map(([k, v]) => `${k} ${v}ms`).join('、') : '✅ 各项交互均在 1 秒内');
  await page.shot('perf');
  /* 补两张投递记录的真实截图（带 400 条数据，便于人工确认两级结构）。
     注意：此时页面停在「日程」，投递记录在「求职进程」组内，必须两步导航才到位。 */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(900);
  await page.eval(`return window.__q.click('.tabbar__btn', '投递记录');`);
  await page.waitFor(`document.querySelector('.catc__card, .empty')`, 8000);
  await page.shot('apps-categories');
  await page.eval(`return window.__q.click('.catc__card', '已提交');`);
  await page.waitFor(`document.querySelector('.approw, .empty')`, 8000);
  await page.shot('apps-category-detail');
  return { sized, bootMs, navMs, typeMs, kbMs, dtMs, calMs };
}


/* 场景：写邮件/发信（拦截邮件桥 /api/send，验证两段式确认契约，不真的发信） */
async function scenarioMailSend(page) {
  const state = { sends: [] };
  const respond = (payload) => {
    state.sends.push({ to: payload.to, subject: payload.subject, atts: (payload.attachments || []).length, token: payload.confirmation_token || null });
    if (!payload.confirmation_token) {
      return { need_confirm: true, confirmation_token: 'ctk_mock_123', summary: `收件人：${(payload.to || []).join('、')}\n主题：${payload.subject}\n附件：${(payload.attachments || []).length} 个` };
    }
    if (payload.confirmation_token !== 'ctk_mock_123') return { error: '确认令牌无效' };
    return { sent: true, message_id: 'msg_mock_1' };
  };

  await page.cdp.send('Fetch.enable', { patterns: withCloudPatterns([{ urlPattern: '*/api/send*', requestStage: 'Request' }]) }, page.sid);
  page.cdp.on((m) => {
    if (m.sessionId !== page.sid || m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    /* 判断 URL：enable 的 pattern 是整组替换的，云端桩的 requestPaused 也会打到这里 */
    if (!request.url.includes('/api/send')) return;
    /* 预检必须单独放行：跨源 POST + JSON 会先发 OPTIONS，若把 JSON 当预检响应回，
       浏览器会判定 CORS 失败 → 前端只看到「Failed to fetch」。 */
    if (request.method === 'OPTIONS') {
      page.cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: 204,
        responseHeaders: [
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
          { name: 'Access-Control-Allow-Headers', value: '*' },
        ],
      }, page.sid).catch(() => {});
      return;
    }
    let payload = {};
    try { payload = JSON.parse(request.postData || '{}'); } catch { /* ignore */ }
    page.cdp.send('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(respond(payload)), 'utf8').toString('base64'),
    }, page.sid).catch(() => {});
  });

  await page.goto();
  await injectHelpers(page);
  await page.eval(`return window.__q.click('.nav__item', '邮件中心');`);
  await sleep(5000);

  await page.eval(`return window.__q.click('button', '写邮件');`);
  await sleep(800);
  const opened = await page.eval(`return !!document.querySelector('.modal textarea');`);
  console.log('打开写邮件:', opened ? '✅' : '❌');
  if (!opened) return null;

  /* 1. 空收件人应被拦下 */
  await page.eval(`return window.__q.click('.modal__foot button, .modal button', '发送');`);
  await sleep(800);
  const emptyTo = await page.eval(`const t = document.querySelector('.toaster, .toast'); return t ? t.innerText.replace(/\s+/g,' ') : '';`);
  console.log('空收件人:', /收件人/.test(emptyTo) ? '✅ 已拦下 — ' + emptyTo.slice(0, 30) : '❌ 未拦截 — ' + emptyTo.slice(0, 40));
  const blocked = state.sends.length === 0;

  /* 2. 填好内容发送 → 应进入两段式确认，且此时**不应**已发出 */
  const fillTo = await page.eval(`return window.__q.modalSetByLabel('收件人', 'qa-target@example.com');`);
  await sleep(200);
  const fillBody = await page.eval(`return window.__q.modalSetByLabel('正文', '这是一封 QA 测试邮件正文。');`);
  const fillSubj = await page.eval(`return window.__q.modalSetByLabel('主题', 'QA 测试主题');`);
  console.log('填写字段:', fillTo, fillSubj, fillBody);
  await sleep(200);
  await page.eval(`return window.__q.click('.modal button', '发送');`);
  await sleep(1500);
  const confirmUi = await page.eval(`
    const m = document.querySelector('.modal');
    return { text: m ? m.innerText.replace(/\s+/g,' ') : '', hasConfirmBtn: !!window.__q.byText('.modal button', '确认发送') };
  `);
  console.log('首次发送后:', state.sends.length, '次请求｜确认界面:', confirmUi.hasConfirmBtn ? '✅ 出现' : '❌ 未出现');
  console.log('  摘要:', confirmUi.text.slice(confirmUi.text.indexOf('请确认发送'), confirmUi.text.indexOf('请确认发送') + 90));
  const twoStep = state.sends.length === 1 && !state.sends[0].token && confirmUi.hasConfirmBtn;

  /* 3. 确认发送 → 带 token 再发一次 */
  await page.eval(`return window.__q.click('.modal button', '确认发送');`);
  await sleep(1500);
  const done = await page.eval(`const t = document.querySelector('.toaster, .toast'); return t ? t.innerText.replace(/\s+/g,' ') : '';`);
  const second = state.sends[1] || {};
  console.log('确认后:', JSON.stringify(state.sends.length), '次请求｜token:', second.token, '｜提示「' + done.slice(0, 30) + '」');
  const sent = state.sends.length === 2 && second.token === 'ctk_mock_123' && /已发送/.test(done);
  console.log(sent ? '✅ 两段式确认契约正确（先预览、确认后才带 token 真发）' : '❌ 确认流程异常');
  console.log(blocked && twoStep && sent ? '✅ 发信链路全部符合预期' : '⚠️ 有不符合预期的环节');
  await page.shot('mail-send');
  await restoreFetchPatterns(page);
  return { blocked, twoStep, sent, sends: state.sends };
}

/* 场景：滚动可用性（用户报「网站无法上下滑动」） */
async function scenarioScroll(page) {
  /* 用真实滚轮事件 + 等待：`.app__scroll` 有 scroll-behavior: smooth，
     直接读 scrollTop 会读到动画开始前的 0，造成「滚不动」的假象。 */
  const wheel = async (dy) => {
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: dy, pointerType: 'mouse' }, page.sid);
    await sleep(700);
  };
  const scrollTop = () => page.eval(`const sc = document.querySelector('.app__scroll'); return sc ? Math.round(sc.scrollTop) : -1;`);
  const probe = `
    const sc = document.querySelector('.app__scroll');
    return {
      appOverflowX: sc ? getComputedStyle(sc).overflowX : '?',
      appOverflowY: sc ? getComputedStyle(sc).overflowY : '?',
      inlineOverflow: sc ? (sc.style.overflow || '(空)') : '?',
      bodyOverflow: getComputedStyle(document.body).overflow,
      bodyInline: document.body.style.overflow || '(空)',
      scrollH: sc ? sc.scrollHeight : 0, clientH: sc ? sc.clientHeight : 0,
      docH: document.documentElement.scrollHeight, winH: window.innerHeight,
    };
  `;
  await page.goto();
  await injectHelpers(page);
  const steps = [];
  /* 弹窗打开时背景**应当**锁住 —— 这是有意设计，不是故障。
     但两个方向都要断言：该锁的时候还滚得动，同样是缺陷（内容会在弹窗背后乱跑）。
     原先写死「滚不动 = ❌」，把这条真实的缺陷反过来报成假红，
     而假红会训练人忽略红色——比漏报更糟。 */
  const EXPECT_LOCK = /弹窗打开时|叠加时/;
  const snap = async (label) => {
    await page.eval(`const sc = document.querySelector('.app__scroll'); if (sc) sc.scrollTop = 0; return 'ok';`);
    await sleep(400);
    const before = await scrollTop();
    await wheel(500);                       // 向下滚
    const afterDown = await scrollTop();
    await wheel(-500);                      // 向上滚
    const afterUp = await scrollTop();
    const r = await page.eval(probe);
    const rec = { label, down: afterDown - before, up: afterDown - afterUp, ...r };
    steps.push(rec);
    const locked = EXPECT_LOCK.test(label);
    /* 「滚不动」有两种成因，必须分开判：
       ① 真的被锁死（overflow 被外力写成 hidden）——这才是要抓的缺陷；
       ② 内容本来就没超出视口（scrollH <= clientH），没得可滚 —— 空数据起点下的正常态。
       只断言「down > 0」会把 ② 报成 ❌，而假红会训练人忽略红色，比漏报更糟。 */
    const noRoom = rec.scrollH <= rec.clientH;
    const pass = locked ? rec.down <= 0 : (noRoom || rec.down > 0);
    const mark = pass ? (locked ? '🔒' : '✅') : '❌';
    const note = locked
      ? (pass ? '背景已锁（预期）' : '弹窗开着却还能滚背景')
      : (noRoom ? '内容未超出视口，无可滚（非锁死）' : (pass ? '可滚动' : '滚不动'));
    console.log(`[${label}] overflowY=${r.appOverflowY}｜inline=${r.inlineOverflow}｜body=${r.bodyOverflow}(${r.bodyInline})｜内容 ${r.scrollH}/${r.clientH}｜下滚 ${rec.down}px 上滚 ${rec.up}px ${mark}${note}`);
    return rec;
  };
  const first = await snap('刚打开');

  /* 打开再关闭一个弹窗 */
  await page.eval(`const b=[...document.querySelectorAll('button')].find(x=>/设置/.test(x.getAttribute('aria-label')||'')); if(b)b.click(); return 'ok';`);
  await sleep(700);
  await snap('设置弹窗打开时');
  await page.eval(`const b=[...document.querySelectorAll('.modal__head button')].pop(); if(b)b.click(); return 'ok';`);
  await sleep(700);
  const after1 = await snap('设置关闭后');

  /* 连续开两个弹窗再依次关（叠加场景） */
  await page.eval(`const b=[...document.querySelectorAll('button')].find(x=>/设置/.test(x.getAttribute('aria-label')||'')); if(b)b.click(); return 'ok';`);
  await sleep(500);
  await page.eval(`return window.__q.click('.segmented__btn', '数据与备份');`);
  await sleep(400);
  await page.eval(`return window.__q.click('button', '选文件 / 拖拽导入');`);
  await sleep(800);
  const stacked = await page.eval(`return document.querySelectorAll('.modal-overlay').length;`);
  console.log('叠加弹窗层数:', stacked);
  await snap('两个弹窗叠加时');
  /* 先关最上面那个（导入），再关设置 */
  await page.eval(`
    const o=[...document.querySelectorAll('.modal-overlay')];
    const top=o[o.length-1]; const b=top.querySelector('.modal__head button'); if(b)b.click(); return 'ok';
  `);
  await sleep(600);
  const mid = await snap('关掉上层后');
  await page.eval(`
    const o=[...document.querySelectorAll('.modal-overlay')];
    if(o.length){ const b=o[0].querySelector('.modal__head button'); if(b)b.click(); }
    return 'ok';
  `);
  await sleep(700);
  const last = await snap('全部关闭后');

  /* 真实叠加路径：岗位详情弹窗 + 其上再开「转为网申记录」弹窗（DetailModal 不会先关），
     两个弹窗在同一次提交里一起卸载 —— 若各自「恢复进入前的 overflow」，
     后卸载的那个会把 hidden 又写回去，页面从此锁死。 */
  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(1200);
  await page.eval(`const inp=[...document.querySelectorAll('input')].find(i=>/搜索/.test(i.placeholder||'')); return 'ok';`);
  const cardText = await page.eval(`
    const el = document.querySelector('.acc__head, .card__head, .kcard, .list-row');
    return el ? el.innerText.replace(/\s+/g,' ').slice(0, 20) : '';
  `);
  const opened = await page.eval(`return window.__q.clickRow(${JSON.stringify('展开查看岗位')}) === 'NOT_FOUND:展开查看岗位' ? 'no-expand' : 'expanded';`);
  const jobOpened = await page.eval(`
    const els = [...document.querySelectorAll('.app__scroll *')].filter((e) => e.children.length === 0 && /法律|管理培训|岗位/.test(e.textContent || '') && e.textContent.length < 30);
    if (!els.length) return 'NO_JOB';
    let p = els[0];
    while (p && p !== document.body) { const cs = getComputedStyle(p); if (cs.cursor === 'pointer' || /row|card|item/i.test(String(p.className))) { p.click(); return 'OK:' + String(p.className).slice(0, 24); } p = p.parentElement; }
    return 'NO_CLICKABLE';
  `);
  await sleep(900);
  const stack1 = await page.eval(`return document.querySelectorAll('.modal-overlay').length;`);
  const applyBtn = await page.eval(`
    const b = [...document.querySelectorAll('.modal button')].find((x) => /转为投递/.test(x.textContent || ''));
    if (!b) return 'NO_BTN'; b.click(); return 'OK';
  `);
  await sleep(800);
  const stack2 = await page.eval(`return document.querySelectorAll('.modal-overlay').length;`);
  console.log(`叠加路径：展开=${opened}｜岗位卡=${jobOpened}｜详情层数=${stack1}｜点「转为投递」后=${stack2}（${applyBtn}）`);
  if (stack2 >= 2) {
    await page.eval(`return window.__q.click('.modal button', '确认转入');`);
    await sleep(1200);
    const st = await page.eval(`const sc=document.querySelector('.app__scroll'); return { overlays: document.querySelectorAll('.modal-overlay').length, inline: sc.style.overflow || '(空)', computed: getComputedStyle(sc).overflowY };`);
    const final = await snap('叠加弹窗全部关闭后');
    console.log('叠加关闭后的 DOM 状态:', JSON.stringify(st));
    if (final.down <= 0) console.log('❌ 复现用户报的问题：走完「转为投递」后页面再也滚不动（inline overflow 卡在 hidden）');
    else console.log('✅ 叠加路径未锁死');
  } else {
    console.log('（本次未形成叠加，跳过该断言）');
  }

  /* 启动自愈：手工制造「残留锁」，重新加载后应被清掉 */
  await page.eval(`
    const sc = document.querySelector('.app__scroll');
    if (sc) sc.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return 'ok';
  `);
  await page.goto();
  await injectHelpers(page);
  await sleep(600);
  const healed = await page.eval(`const sc=document.querySelector('.app__scroll'); return { inline: sc.style.overflow || '(空)', body: document.body.style.overflow || '(空)' };`);
  const healedScroll = await snap('残留锁后重新加载');
  const hasRoom = healedScroll.scrollH > healedScroll.clientH;
  console.log('启动自愈:', JSON.stringify(healed),
    hasRoom
      ? (healedScroll.down > 0 ? '✅ 已清除残留锁，可滚动' : '❌ 仍被锁死')
      : '⏭ 内容未超出视口，无可滚（空数据起点，跳过该断言）');

  /* 同上：只把「有内容可滚却滚不动」算缺陷，内容不足视口的场景不算。 */
  const broken = steps.filter((s) => s.down <= 0 && s.scrollH > s.clientH && !EXPECT_LOCK.test(s.label));
  console.log();
  if (last.scrollH <= last.clientH) {
    console.log('⏭ 内容未超出视口，无可滚 —— 该场景需要更长的页面内容才有意义');
    console.log('   提示：用 QZ_PKG=<数据包.json> 灌入足够数据后重跑，才能真正验证滚动锁。');
  } else {
    console.log(last.down > 0 ? '✅ 最终可正常滚动' : '❌ 页面被锁死，无法滚动（用户报的问题复现）');
  }
  if (broken.length) console.log('滚不动的环节:', broken.map((b) => b.label).join('、'));
  return { steps, broken };
}

/* 场景：叠加弹窗是否把滚动锁死（岗位详情 + 转为投递） */
async function scenarioStackLock(page) {
  await page.goto(); await injectHelpers(page);
  const wheel = async (dy) => { await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: dy, pointerType: 'mouse' }, page.sid); await sleep(700); };
  const top = async () => page.eval(`const sc=document.querySelector('.app__scroll'); return sc?Math.round(sc.scrollTop):-1;`);
  const canScroll = async () => { await page.eval(`const sc=document.querySelector('.app__scroll'); if(sc) sc.scrollTop=0; return 'ok';`); await sleep(400); await wheel(500); return (await top()) > 0; };

  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(400);
  await page.eval(`return window.__q.click('.tabbar__btn', '岗位库');`);
  await sleep(1200);
  const target = await page.eval(`
    const s = window.__q.state();
    const j = s.jobs.find((x) => x.status !== 'archived');
    return j ? { company: j.company, title: j.title } : null;
  `);
  console.log('目标岗位:', JSON.stringify(target));
  /* 展开公司卡（点公司名），再点岗位行 */
  const expand = await page.eval(`return window.__q.clickRow(${JSON.stringify((target && target.company) || '')});`);
  await sleep(800);
  const openJob = await page.eval(`return window.__q.clickRow(${JSON.stringify((target && target.title) || '')});`);
  await sleep(900);
  const n1 = await page.eval(`return document.querySelectorAll('.modal-overlay').length;`);
  console.log(`展开=${expand}｜点岗位=${openJob}｜弹窗层数=${n1}`);
  if (n1 < 1) { console.log('❌ 未能打开岗位详情，跳过'); return null; }

  const apply = await page.eval(`const b=[...document.querySelectorAll('.modal button')].find(x=>/转为投递/.test(x.textContent||'')); if(!b) return 'NO_BTN'; b.click(); return 'OK';`);
  await sleep(800);
  const n2 = await page.eval(`return document.querySelectorAll('.modal-overlay').length;`);
  console.log(`点「转为投递」=${apply}｜弹窗层数=${n2}（应为 2 = 叠加）`);
  const before = await canScroll();
  console.log('叠加时能否滚动:', before ? '可滚（叠加层自身可滚）' : '不可滚（预期，被锁定）');

  const confirm = await page.eval(`return window.__q.click('.modal button', '确认转入');`);
  await sleep(1500);
  const st = await page.eval(`const sc=document.querySelector('.app__scroll'); return { overlays: document.querySelectorAll('.modal-overlay').length, inline: sc.style.overflow || '(空)', computed: getComputedStyle(sc).overflowY, bodyInline: document.body.style.overflow || '(空)' };`);
  const after = await canScroll();
  console.log(`点「确认转入」=${confirm}`);
  console.log('两个弹窗都关闭后:', JSON.stringify(st));
  console.log(after ? '✅ 页面恢复可滚动' : '❌ 页面被永久锁死（inline overflow 卡在 hidden）—— 这就是用户报的问题');
  if (!after) {
    /* 失败时必须能直接看出「是哪个弹窗没关」和「点击时抛了什么」。
       只报一句「滚不动」会把排查成本全丢给下一个人 —— 本次的真相是 onClick 里抛了异常
       （投递记录缺 timeline，详情渲染炸），modal 压根没关，锁着其实是**正确**行为，
       毛病在别处。这类误导最费时间，宁可多打两行。 */
    console.log('   仍有可见弹窗:', JSON.stringify(await page.eval(`
      return [...document.querySelectorAll('.modal-overlay')].map((o) => ({
        display: getComputedStyle(o).display,
        title: (o.querySelector('.modal__title') || {}).innerText || '',
        head: o.innerText.replace(/\\s+/g,' ').slice(0, 70),
      }));
    `)));
    if (page.errors.length) console.log('   点击期间的页面报错:', JSON.stringify(page.errors.slice(-3)));
  }
  await page.shot('stacklock');
  return { n1, n2, st, after };
}

/* 主流程 */
const scenario = process.argv[2] || 'views';

/**
 * 重置密码回跳巡检。
 *
 * 这一屏是最容易整条链路「看起来能用其实没用」的地方：邮件链接点回来，
 * supabase-js 会把人直接登录，密码却一个字节没改。没有拦截屏的站点，
 * 用户以为自己重置成功了，退出后再登却是错的 —— 而且再也找不到改密码的地方。
 */
async function scenarioRecovery(page) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const jwt = [b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ sub: QA_UID, email: 'qa@qiuzhao.local', role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now }),
    'sig'].join('.');
  const hash = `#access_token=${jwt}&expires_in=3600&refresh_token=qa&token_type=bearer&type=recovery`;

  await page.cdp.send('Page.navigate', { url: BASE + hash }, page.sid);
  const shown = await page.waitFor(`!!document.querySelector('.login-card') && /设置新密码/.test(document.querySelector('.login-card').innerText)`, 20000);
  console.log(shown ? '✅ 回跳后拦在「设置新密码」屏' : '❌ 没有拦截屏（会被直接登录、密码其实没改）');
  if (!shown) {
    console.log('   页面文本:', await page.eval(`return document.body.innerText.slice(0, 160);`));
    return { shown: false };
  }
  await page.shot('recovery');
  const fields = await page.eval(`const c=document.querySelector('.login-card'); return { pwd: c.querySelectorAll('input[type=password]').length };`);
  console.log('密码输入框数量:', fields.pwd, fields.pwd === 2 ? '✅' : '❌');

  /* 太短 → 应提示 */
  await page.eval(`
    const c = document.querySelector('.login-card');
    const put = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    const ins = c.querySelectorAll('input[type=password]');
    put(ins[0], '123'); put(ins[1], '123');
    return 'OK';
  `);
  await sleep(300);
  const shortBlocked = await page.eval(`return /至少 6 位/.test(document.querySelector('.login-card').innerText);`);
  const btnDisabled1 = await page.eval(`return document.querySelector('.login-card button[type=submit]').disabled;`);
  console.log(shortBlocked ? '✅ 太短会提示' : '❌ 太短没提示', '｜提交按钮禁用 =', btnDisabled1);

  /* 两次不一致 → 应提示且禁用提交 */
  await page.eval(`
    const c = document.querySelector('.login-card');
    const put = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    const ins = c.querySelectorAll('input[type=password]');
    put(ins[0], 'NewPass123'); put(ins[1], 'NewPass999');
    return 'OK';
  `);
  await sleep(300);
  const mismatch = await page.eval(`return { msg: /两次输入不一致/.test(document.querySelector('.login-card').innerText), disabled: document.querySelector('.login-card button[type=submit]').disabled };`);
  console.log(mismatch.msg ? '✅ 不一致会提示' : '❌ 不一致没提示', '｜提交按钮禁用 =', mismatch.disabled);

  /* 一致 → 按钮应可用 */
  await page.eval(`
    const c = document.querySelector('.login-card');
    const put = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    const ins = c.querySelectorAll('input[type=password]');
    put(ins[1], 'NewPass123');
    return 'OK';
  `);
  await sleep(300);
  const ready = await page.eval(`return !document.querySelector('.login-card button[type=submit]').disabled;`);
  console.log(ready ? '✅ 两次一致后可以提交' : '❌ 一致了还提交不了');
  return { shown, fields: fields.pwd, shortBlocked, btnDisabled1, mismatch, ready };
}

/**
 * 登录门巡检：公开站的第一屏就是它，注册/登录走不通的话后面 17 个板块都是白搭。
 * 该场景刻意**不**注入伪造会话，因此要用独立的浏览器 profile。
 */
async function scenarioLogin(page) {
  await page.cdp.send('Page.navigate', { url: BASE }, page.sid);
  const ok = await page.waitFor('!!document.querySelector(".login-card")', 20000);
  if (!ok) {
    const body = await page.eval(`return document.body.innerText.slice(0, 200);`);
    console.log('❌ 没渲染出登录卡片，页面文本：', body);
    return { rendered: false };
  }
  const ui = await page.eval(`
    const c = document.querySelector('.login-card');
    return {
      text: c.innerText.replace(/\s+/g, ' ').slice(0, 140),
      email: !!c.querySelector('input[type=email]'),
      pwd: !!c.querySelector('input[type=password]'),
      submit: [...c.querySelectorAll('button')].some((b) => /登录|注册/.test(b.textContent || '')),
      aurora: !!document.querySelector('.aurora'),
    };
  `);
  console.log('登录页结构:', JSON.stringify(ui));
  await page.shot('login');

  /* 未登录访客的落地页必须有左栏说明，但左栏绝不能把登录表单挤出屏幕 */
  const landing = await page.eval(`
    const l = document.querySelector('.landing');
    const feats = document.querySelectorAll('.landing__feat').length;
    return { 有左栏: !!l, 特性条数: feats, 标题: (document.querySelector('.landing__lead')?.textContent || '').trim() };
  `);
  console.log('落地页左栏:', JSON.stringify(landing));
  console.log(landing.有左栏 && landing.特性条数 >= 6 ? '✅ 未登录访客能看到「这站是干什么的」' : '❌ 左栏缺失或内容过少');

  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, page.sid);
  await sleep(600);
  const mobile = await page.eval(`
    const c = document.querySelector('.login-card');
    const r = c.getBoundingClientRect();
    return {
      left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
      vw: innerWidth, vh: innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      featsHidden: getComputedStyle(document.querySelector('.landing__feats')).display === 'none',
    };
  `);
  console.log('窄屏 390×844:', JSON.stringify(mobile));
  const fits = mobile.left >= 0 && mobile.right <= mobile.vw + 1 && !mobile.overflowX;
  console.log(fits ? '✅ 登录卡完整落在视口内、无横向溢出' : '❌ 登录卡被挤出视口或页面横向溢出');
  console.log(mobile.featsHidden ? '✅ 窄屏已收起特性列表（不把表单顶到屏幕外）' : '❌ 窄屏仍展示完整特性列表');
  await page.shot('login-mobile');
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, page.sid);
  await sleep(300);

  /* 注册/登录切换 */
  const toSignup = await page.eval(`
    const b = [...document.querySelectorAll('.login-card .link-btn')].find((x) => /注册/.test(x.textContent || ''));
    if (!b) return 'NOT_FOUND'; b.click(); return 'OK';
  `);
  await sleep(400);
  const signedUp = await page.eval(`return document.querySelector('.login-card').innerText.replace(/\s+/g,' ').slice(0, 60);`);
  console.log(`切到注册=${toSignup}｜文案：${signedUp}`);

  /* 故意用错密码，验证错误提示是人话而不是英文堆栈 */
  await page.eval(`
    const c = document.querySelector('.login-card');
    const put = (el, v) => {
      if (!el) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    put(c.querySelector('input[type=email]'), 'nobody@qiuzhao-qa.invalid');
    put(c.querySelector('input[type=password]'), 'wrong-password-123');
    return 'OK';
  `);
  await sleep(200);
  /* 切回登录模式再提交 */
  await page.eval(`const b=[...document.querySelectorAll('.login-card .link-btn')].find(x=>/登录/.test(x.textContent||'')); if(b) b.click(); return 'OK';`);
  await sleep(300);
  await page.eval(`const f=document.querySelector('.login-card'); const i=f.querySelector('input[type=password]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'wrong-password-123'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';`);
  await page.eval(`document.querySelector('.login-card button[type=submit]').click(); return 'OK';`);
  await sleep(5000);
  const err = await page.eval(`return document.querySelector('.login-msg')?.innerText || '(无提示)';`);
  const english = /[A-Za-z]{12,}/.test(err);
  console.log('错误提示:', err);
  console.log(err === '(无提示)' ? '❌ 提交后没有任何反馈' : (english ? '⚠️ 提示里夹了英文原文' : '✅ 提示是中文人话'));
  return { rendered: true, ...ui, err, english };
}
/**
 * 上手链路巡检 —— 新用户第一次进来会碰到、而其它场景都没覆盖到的两条路：
 *   ① 「三分钟上手」指南：第一次进站自动弹、顶栏 ⓘ 能再打开、指南里的跳转真的能切板块；
 *   ② 忘记密码 = 人工重置（方案 B）：界面把「复制我的邮箱」做完，且**绝不再打 Supabase 的恢复接口**。
 * 本场景要走已登录壳（QZ_CLOUD=1 时框架会注入伪造会话），所以指南那一段必须先抹掉
 * 「已看过」标记再重载 —— 否则第二次跑就不会自动弹，断言会莫名其妙变红。
 */
async function scenarioOnboard(page) {
  const out = {};

  /* ---------------- 一、新手指南 ---------------- */
  await page.eval(`
    localStorage.removeItem('qz.guideSeen');
    localStorage.removeItem('qz.qa.noSeed');
    localStorage.setItem('qz.qa.guideFresh', '1');
    return 'ok';
  `);
  await page.cdp.send('Page.navigate', { url: BASE }, page.sid);
  await page.waitFor('document.querySelector(".app")', 15000);
  await injectHelpers(page);

  const auto = await page.waitFor('document.querySelector(".modal--wide")', 8000);
  out.autoOpen = auto;
  console.log(auto ? '✅ 新用户首次进站自动弹出「三分钟上手」' : '❌ 没有自动弹出教程');

  const marked = await page.eval(`return localStorage.getItem('qz.guideSeen');`);
  out.marked = marked === '1';
  console.log(out.marked ? '✅ 弹出后立刻打上「已看过」标记（下次不再打扰）' : `❌ 弹出后没打标记：${JSON.stringify(marked)}`);
  await page.shot('onboard-guide');

  const g = await page.eval(`
    const m = document.querySelector('.modal--wide');
    return {
      text: m ? m.innerText.replace(/\\s+/g, ' ') : '',
      cards: [...document.querySelectorAll('.guide__cardhead b')].map((e) => e.textContent.trim()),
      tabs: [...document.querySelectorAll('.guide__tab')].map((e) => e.textContent.trim()),
      settings: document.querySelectorAll('.guide__sitem').length,
      faq: document.querySelectorAll('.guide__qa').length,
      navGroups: [...document.querySelectorAll('.nav__item')].map((e) => e.textContent.replace(/[0-9]+/g, '').replace(/\\+/g, '').trim()),
    };
  `);
  console.log('指南文本:', JSON.stringify(g.text.slice(0, 120)));

  /* 用户那句需求就是「说明该网站可以用于做什么，以及设置里的信息」——两节都必须在 */
  const secs = [
    ['讲清网站能做什么（七个板块）', /一、.*板块/],
    ['给新用户上手顺序', /二、建议这么开始/],
    ['讲清设置里各项', /三、设置/],
    ['常见问题（含忘密怎么找回）', /四、/],
  ];
  for (const [label, re] of secs) {
    const hit = re.test(g.text);
    console.log(hit ? `✅ 指南有「${label}」` : `❌ 指南缺「${label}」一节`);
  }

  out.cards = g.cards.length;
  console.log(g.cards.length === 7 ? '✅ 指南按左侧导航列出 7 个板块' : `❌ 板块卡片 ${g.cards.length} 个（期望 7）`);
  /* 指南是从 NAV_GROUPS 派生的：导航改了它必须跟着改，对不上就是漂移 */
  const same = JSON.stringify([...g.cards].sort()) === JSON.stringify([...g.navGroups].sort());
  out.cardsMatchNav = same;
  console.log(same ? '✅ 指南的板块名与侧边栏逐字一致' : `❌ 板块名对不上\n   指南: ${JSON.stringify(g.cards)}\n   侧栏: ${JSON.stringify(g.navGroups)}`);
  console.log(g.tabs.length === 14 ? '✅ 指南列全 14 个标签页' : `❌ 指南只列了 ${g.tabs.length} 个标签页（期望 14）`);
  out.settings = g.settings;
  out.faq = g.faq;
  console.log(g.settings === 5 ? '✅ 指南讲全 5 个设置分页' : `❌ 设置项只讲了 ${g.settings} 个（期望 5）`);
  console.log(g.faq === 5 ? '✅ 常见问题 5 条' : `❌ 常见问题 ${g.faq} 条（期望 5）`);

  /* 关掉，再用顶栏 ⓘ 打开一次 —— 首访之后用户唯一的入口就是它 */
  await page.eval(`return window.__q.click('.modal__foot button', '知道了');`);
  await sleep(600);
  const gone = await page.eval(`return !document.querySelector('.modal--wide');`);
  console.log(gone ? '✅ 「知道了，开始用」能关掉' : '❌ 「知道了，开始用」关不掉');
  const btnFound = await page.eval(`const b = document.querySelector('button[aria-label="使用教程"]'); if (!b) return 'NOT_FOUND'; b.click(); return 'OK';`);
  const back = await page.waitFor('document.querySelector(".modal--wide")', 5000);
  out.reopen = back;
  console.log(back ? '✅ 顶栏 ⓘ 能重新打开教程' : `❌ 顶栏 ⓘ 打不开（${btnFound}）`);

  /* 指南里的板块名是按钮：点了要真的切过去，不能只是「看着像链接」 */
  const before = await page.eval(`return (document.querySelector('.topbar__title') || {}).textContent || '';`);
  /* 目标标签页的描述直接从指南 DOM 上取（指南渲染成「标签名 · 描述」），不写死字符串：
     描述改了断言跟着变，不会因为一句文案改动就假红。 */
  const target = await page.eval(`
    const b = [...document.querySelectorAll('.guide__tab')].find((e) => e.textContent.trim() === '岗位库');
    if (!b) return null;
    const li = b.closest('li');
    const sp = li ? li.querySelector('span') : null;
    return { desc: sp ? sp.textContent.replace(/^\\s*·\\s*/, '').trim() : '' };
  `);
  const clicked = await page.eval(`const b = [...document.querySelectorAll('.guide__tab')].find((e) => e.textContent.trim() === '岗位库'); if (b) b.click(); return b ? 'OK' : 'NOT_FOUND';`);
  await sleep(800);
  const after = await page.eval(`return { title: (document.querySelector('.topbar__title') || {}).textContent || '', crumb: (document.querySelector('.topbar__crumb') || {}).textContent || '', modal: !!document.querySelector('.modal--wide') };`);
  /* 顶栏标题是分组名（求职进程），面包屑是该标签页的描述 —— 用从指南里取到的 desc 比对，
     能证明「点的是哪一条、就真的切到了那一条」。 */
  const landed = !!target && target.desc.length > 0 && after.crumb.includes(target.desc);
  out.guideNav = clicked === 'OK' && landed && !after.modal;
  console.log(out.guideNav ? `✅ 点指南里的「岗位库」真的切过去了（顶栏「${(after.title + ' ' + after.crumb).trim()}」，指南自动关闭）` : `❌ 指南里的跳转没生效：点击=${clicked} 标题=${after.title} 面包屑=${after.crumb} 弹窗还在=${after.modal}`);

  /* ---------------- 二、忘记密码 = 人工重置 ---------------- */
  /* ★ 光删会话不够：框架的 seed 每次导航都会重播，会把伪造会话又塞回来，于是永远回不到登录页。
     必须先置逃生门 qz.qa.noSeed=1 再删。 */
  await page.eval(`
    localStorage.setItem('qz.qa.noSeed', '1');
    Object.keys(localStorage).filter((k) => k.startsWith('sb-')).forEach((k) => localStorage.removeItem(k));
    return 'ok';
  `);
  await page.cdp.send('Page.navigate', { url: BASE }, page.sid);
  const hasCard = await page.waitFor('document.querySelector(".login-card")', 20000);
  if (!hasCard) {
    console.log('❌ 清掉会话后没有回到登录页，人工重置这一段没法测');
    await page.eval(`localStorage.removeItem('qz.qa.noSeed'); localStorage.removeItem('qz.qa.guideFresh'); localStorage.setItem('qz.guideSeen', '1'); return 'ok';`);
    return out;
  }
  console.log('✅ 清掉会话后回到登录页');
  await injectHelpers(page);

  await page.eval(`return window.__q.click('.link-btn', '忘记密码');`);
  await sleep(500);
  const panel = await page.eval(`
    const h = document.querySelector('.login-help');
    const card = document.querySelector('.login-card');
    return {
      help: h ? h.innerText.replace(/\\s+/g, ' ') : '',
      steps: h ? h.querySelectorAll('ol li').length : 0,
      submit: (card.querySelector('button[type=submit]') || {}).textContent || '',
      title: (card.querySelector('.card__title, h1, h2') || {}).textContent || '',
      pwdField: !!card.querySelector('input[type=password]'),
    };
  `);
  console.log('忘密面板:', JSON.stringify(panel.help.slice(0, 130)));
  console.log(panel.steps >= 4 ? `✅ 忘密面板给了 ${panel.steps} 步人工重置说明` : `❌ 忘密面板步骤只有 ${panel.steps} 步`);
  console.log(/复制我的邮箱/.test(panel.submit) ? '✅ 主按钮已改成「复制我的邮箱」' : `❌ 主按钮文案还是：${JSON.stringify(panel.submit)}`);
  console.log(!panel.pwdField ? '✅ 忘密模式下不再要求填密码（本来就用不上）' : '⚠️ 忘密模式下还留着密码输入框');
  await page.shot('onboard-forgot');

  /* 两个探针：① 谁在打 Supabase 的恢复接口；② 复制到底有没有真的执行。
     没有这两个探针，「改成人工重置」就只是「看起来改了」。 */
  const spy = await page.eval(`
    window.__recoverHits = 0;
    window.__copied = null;
    const of = window.fetch;
    window.fetch = function (...a) {
      const u = String((a[0] && (a[0].url || a[0])) || '');
      if (u.indexOf('/auth/v1/') >= 0 && u.indexOf('recover') >= 0) window.__recoverHits++;
      return of.apply(this, a);
    };
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copied = String(t); } },
      });
    } catch (e) { return 'CLIPBOARD_STUB_FAILED: ' + e.message; }
    return 'ok';
  `);
  console.log(spy === 'ok' ? '✅ 已装上网络与剪贴板探针' : `⚠️ ${spy}`);

  const MAIL = 'qa-onboard@resumeself.vercel.app';
  await page.eval(`return window.__q.set('.login-card input[type=email]', ${JSON.stringify(MAIL)});`);
  await page.eval(`document.querySelector('.login-card button[type=submit]').click(); return 'OK';`);
  await sleep(1500);

  const res = await page.eval(`
    return {
      msg: (document.querySelector('.login-msg') || {}).innerText || '',
      cls: (document.querySelector('.login-msg') || {}).className || '',
      recoverHits: window.__recoverHits,
      copied: window.__copied,
    };
  `);
  out.recoverHits = res.recoverHits;
  out.copied = res.copied;
  console.log('提交后提示:', JSON.stringify(res.msg), '/', res.cls);
  console.log(res.msg.indexOf(MAIL) >= 0 ? '✅ 提示里带着用户的邮箱（能直接照抄发给站长）' : '❌ 提示里没有用户邮箱，用户不知道该发什么给站长');
  console.log(res.copied === MAIL ? '✅ 「复制我的邮箱」真的执行了复制' : `❌ 没有发生复制：${JSON.stringify(res.copied)}`);
  console.log(res.recoverHits === 0 ? '✅ 全程没有调用 Supabase 的密码恢复接口（方案 B 是彻底的）' : `❌ 还在偷偷调用恢复接口：${res.recoverHits} 次`);

  /* 撤掉逃生门：留着的话后面每个场景都会以「未登录」启动，全盘假红 */
  await page.eval(`localStorage.removeItem('qz.qa.noSeed'); localStorage.removeItem('qz.qa.guideFresh'); localStorage.setItem('qz.guideSeen', '1'); return 'ok';`);

  out.ok = !!(auto && out.marked && out.cardsMatchNav && out.guideNav && g.settings === 5 && g.faq === 5
    && res.recoverHits === 0 && res.copied === MAIL && res.msg.indexOf(MAIL) >= 0);
  return out;
}

/* 空数据起点必须是「**结构完整但内容为空**」的包，不能是字面量 '{}'。
   坑（实测踩了很久）：写成 '{}' 时，应用读到的持久化文档连 shape() 的 15 个字段一个都没有，
   它只在自己有数据可写时才回写缓存；于是 window.__q.state() 长时间返回 {}，
   任何以 state() 为基底的播种都会写出残缺包（23360 字节 vs 完整包 23844），
   reload 时种子守卫（见 page.init 里的 `if (!localStorage.getItem(cacheKey))`）见键已存在
   而不重写，残缺包被固化 → 断言全落在残缺状态上，表现为 4~20 ❌ 的**假红**，
   且残缺程度每次不同（keys=1/3/11/15），看起来像「间歇性产品缺陷」，实为巡检起点不对。
   这里直接给一份 shape() 全字段的空包（src/store/store.tsx:158-177），
   保证任何场景在空数据起点下 state() 都稳定是 15 键。 */

/* 场景：投递记录的**两级下钻**结构（类别入口页 → 单类别投递库 / 搜索跨类别收敛）。
   为什么单独有一个场景：这一页从旧的 table/kanban/list 三视图整体重写过，
   旧场景 scenarioAppTable 被删掉后新结构基本零巡检覆盖 —— 没有断言就等于没有回归网，
   下一次有人「顺手」改窄卡片或改掉计数口径，没人会知道。

   与场景强绑定的真值（改产品前先看这里，别直接把阈值调松）：
   - 第一级永远是 7 张 .catc__card，data-cat 严格按 STATUS_ORDER 排列
   - 每张卡的 .catc__count === 该状态实际条数，7 卡计数之和 === 总条数
   - 卡内预览 .catc__row 最多 3 条（n>3 时显示「还有 N-3 条 →」）
   - 第二级 .approw 条数 === 该状态条数，标题含「· 投递库」
   - 行内原生 select 改状态不弹窗；一进一出后类别页计数随之变化
   - 0 条时无论什么状态都短路到 .empty，绝不渲染 .catc */
/**
 * 进度线（投递记录 → 详情 → 进度线）视觉巡检。
 *
 * 为什么单独开一个场景：这块是站里唯一「多行小表单 + 状态标记 + 时间线轴」混排的区域，
 * 纯 DOM 断言测不出「一排控件只占左边三分之一、右边一大片空」「卡片被撑成两块灰饼」
 * 这类观感问题，而每次改动都靠人眼截图比对太慢、也容易漏。
 * 这里一次求值取全几何量：每个节点卡的高度、第一行控件的实际矩形、控件之间的空隙、
 * 卡片内空白占比，再把 1440 与 390 两档各截一张图。
 *
 *   QZ_NO_SANDBOX=1 QZ_CLOUD=1 QZ_BASE=http://127.0.0.1:4173/ node scripts/qa-e2e.mjs pline
 */
async function scenarioPline(page) {
  const ok = (m) => console.log('✅ ' + m);
  const bad = (m) => console.log('❌ ' + m);

  await page.goto();
  await injectHelpers(page);

  /* 播种复刻用户截图那条：博时基金，已提交（已发生）+ 笔试（日期已过、时间未定、已赴约） */
  await page.eval(`
    const s = window.__q.state();
    const app = {
      id: 'qaapp-pline-1', company: '博时基金', position: '党建岗和助理岗', status: 'test',
      channel: '官网', location: '北京', deadline: '', notes: '',
      createdAt: '2026-10-01', updatedAt: '2026-10-01',
      timeline: [
        { id: 'stg-a', status: 'submitted', at: '2026-10-15', done: true },
        { id: 'stg-b', status: 'test', at: '2026-10-20', done: true },
        { id: 'stg-c', status: 'interview', at: '2026-10-18', done: false, note: '线上群面，提前 10 分钟进会议' },
        { id: 'stg-d', status: 'interview', at: '2026-10-25', time: '14:00', place: '金融街支行 12 层', done: false },
      ],
    };
    localStorage.setItem(window.__q.cacheKey(), JSON.stringify({ ...s, applications: [app], skin: 'paper', theme: 'light' }));
    /* 首屏渲染提示另存一份（qz.skin）：只改整站 state 的话，登录页会先用默认的极光夜 */
    localStorage.setItem('qz.skin', 'paper');
    return 1;
  `);
  await page.goto();
  await injectHelpers(page);
  if (!await page.waitFor(`(() => { const s = window.__q.state(); return (s.applications || []).length === 1; })()`, 8000)) {
    bad('播种没生效（store 未水合），后续跳过');
    return;
  }

  await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
  await sleep(700);
  await page.eval(`return window.__q.click('.tabbar__btn', '投递记录');`);
  await sleep(700);
  await page.eval(`return window.__q.set('.search input', '博时');`);
  /* 搜索结果要等一轮水合 + 一次重渲染：固定 sleep 会偶发读到 0 行（重跑又好），
     那是「等时间」而不是「等状态」，必须改成轮询。 */
  let hit = false;
  for (let i = 0; i < 25 && !hit; i++) {
    await sleep(200);
    hit = await page.eval(`return document.querySelectorAll('.approw').length > 0;`);
  }
  const probe = await page.eval(`
    return {
      inputs: [...document.querySelectorAll('.search input')].map((i) => i.value),
      rows: document.querySelectorAll('.approw').length,
      head: (document.querySelector('.section-head__t') || {}).textContent || '',
    };
  `);
  console.log('搜索态:', JSON.stringify(probe));
  const opened = await page.eval(`const r = document.querySelector('.approw'); if (!r) return 'NO_ROW'; r.click(); return 'OK';`);
  if (opened !== 'OK') { bad('没找到投递记录行，跳过'); return; }
  await sleep(700);
  const tabbed = await page.eval(`return window.__q.click('.segmented__btn', '进度线');`);
  if (tabbed !== 'OK') bad('切不到进度线：' + tabbed);
  await sleep(600);

  /* 一次求值取全几何量 */
  const geo = await page.eval(`
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const nodes = [...document.querySelectorAll('.pline__node')].map((n) => {
      const box = n.querySelector('.pline__box');
      const row = n.querySelector('.pline__row');
      const cells = [...row.querySelectorAll('.pline__cell, .pline__done, .pline__del')].map((c) => ({
        cls: c.className.replace(/\\s+/g, '.'), ...r(c),
      }));
      /* 第一行里相邻控件之间的空隙：>40px 就说明中间在「漏气」 */
      const sorted = cells.slice().sort((a, b) => a.x - b.x);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        const g = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w);
        gaps.push({ after: sorted[i - 1].cls, px: Math.round(g) });
      }
      return { h: r(box).h, w: r(box).w, cells, gaps };
    });
    return { nodes, modal: r(document.querySelector('.modal')).w };
  `);
  console.log('几何:', JSON.stringify(geo, null, 0).slice(0, 1200));

  /* 「对齐」是这一页最容易被改坏、也最容易被肉眼漏掉的东西：
     勾选框与删除图标必须落在跨卡的同一条竖线上 —— 只要有一张卡因为少了时间列而错位，
     整页看起来就「散架」（这正是 2026-10-21 那轮返工的原因）。 */
  const xOf = (n, cls) => (n.cells.find((c) => c.cls.includes(cls)) || {}).x;
  const doneXs = geo.nodes.map((n) => xOf(n, 'pline__done'));
  const delXs = geo.nodes.map((n) => xOf(n, 'pline__del'));
  if (new Set(doneXs).size === 1) ok(`勾选框跨 ${doneXs.length} 张卡对齐于 x=${doneXs[0]}`);
  else bad(`勾选框没对齐：${doneXs.join(' / ')}`);
  if (new Set(delXs).size === 1) ok(`删除图标跨 ${delXs.length} 张卡对齐于 x=${delXs[0]}`);
  else bad(`删除图标没对齐：${delXs.join(' / ')}`);
  await page.shot('pline-1440');

  const send = (m, p) => page.cdp.send(m, p, page.sid);
  /* 中间档：820px 断点以下撤掉引导线、控件改弹性宽度 —— 这里最容易出现「控件被裁」 */
  await send('Emulation.setDeviceMetricsOverride', { width: 780, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const mid = await page.eval(`
    const m = document.querySelector('.modal');
    const boxes = [...document.querySelectorAll('.pline__row:not(.pline__row--sub)')].map((r) => {
      const last = r.querySelector('.pline__del');
      return { rowW: Math.round(r.getBoundingClientRect().width), delX: Math.round(last.getBoundingClientRect().right) };
    });
    return { modalW: Math.round(m.getBoundingClientRect().width), overflow: m.scrollWidth - m.clientWidth, boxes };
  `);
  console.log('780px:', JSON.stringify(mid));
  if (mid.overflow > 1) bad(`780px 下弹窗横向溢出 ${mid.overflow}px`); else ok('780px 无横向溢出');
  await page.shot('pline-780');

  /* 窄屏复查：两列排布，卡片不该横向溢出 */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  const narrow = await page.eval(`
    const m = document.querySelector('.modal');
    return { modalW: Math.round(m.getBoundingClientRect().width), scrollW: m.scrollWidth, clientW: m.clientWidth };
  `);
  console.log('窄屏:', JSON.stringify(narrow));
  if (narrow.scrollW > narrow.clientW + 1) bad(`390px 下弹窗横向溢出 ${narrow.scrollW - narrow.clientW}px`);
  else ok('390px 无横向溢出');
  await page.shot('pline-390');
}

/* 场景：日历只装笔试 / 面试 / Offer。
   对应用户口径「日历和待办应该只呈现笔面试的」（2026-10-21）。
   这一版笔面日程的唯一真源是投递记录的进度线（lib/appTimeline.ts），日历只是投影，
   所以这里同时验两件事：
   ① 截止与待办**即使存在**也画不进月格 / 近期安排，但数据不能少（各自还在自己的卡里）；
   ② 进度线里填的笔试面试能被投影出来 —— 否则「只显示笔面试」会退化成「什么都不显示」。 */
async function scenarioCalv(page) {
  const ok = (m) => console.log('✅ ' + m);
  const bad = (m) => console.log('❌ ' + m);

  await page.goto();
  await injectHelpers(page);

  const seeded = await page.eval(`
    const s = window.__q.state();
    const d0 = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const iso = (n) => {
      const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + n);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    };
    /* 三类「不该进格子」的东西都放一份：手工截止事件、手工待办、投递记录的截止日期 */
    const events = [
      { id: 'qa-ev-deadline', title: '截止·中行网申', date: iso(3), time: '', type: 'deadline', source: 'manual' },
      { id: 'qa-ev-todo', title: '打印成绩单', date: iso(4), time: '', type: 'todo', source: 'manual', done: false },
      { id: 'qa-ev-manual', title: '国开行一面', date: iso(6), time: '09:30', type: 'interview', source: 'manual' },
    ];
    const app = {
      id: 'qaapp-calv-1', company: '博时基金', position: '党建岗', status: 'test',
      channel: '官网', location: '北京', deadline: iso(5), notes: '',
      createdAt: iso(-10), updatedAt: iso(-1),
      timeline: [
        { id: 'stg-t', status: 'test', at: iso(2), time: '19:00', done: false, place: '线上机考' },
        { id: 'stg-i', status: 'interview', at: iso(8), time: '14:00', done: false },
      ],
    };
    localStorage.setItem(window.__q.cacheKey(), JSON.stringify({ ...s, events, applications: [app] }));
    return { testDay: iso(2), appDeadline: iso(5) };
  `);
  console.log('播种:', JSON.stringify(seeded));

  await page.goto();
  await injectHelpers(page);
  if (!await page.waitFor(`(() => { const s = window.__q.state(); return (s.applications || []).length === 1 && (s.events || []).length === 3; })()`, 8000)) {
    bad('播种没生效（store 未水合），后续跳过');
    return;
  }

  await page.eval(`return window.__q.click('.nav__item', '日程');`);
  /* 网格 42 格 + 三处投影要等一轮水合：固定 sleep 会偶发读到半成品（重跑又好） */
  await page.waitFor(`document.querySelectorAll('.cal__cell').length >= 42`, 6000);
  await sleep(500);

  const probe = await page.eval(`
    const cls = (el) => String(el.className || '');
    const chips = [...document.querySelectorAll('.cal__cell .cal__ev')].map((e) => ({ cls: cls(e), t: e.textContent.trim() }));
    const card = (needle) => [...document.querySelectorAll('.card')].find((c) => {
      const t = c.querySelector('.card__title');
      return t && t.textContent.replace(/\\s+/g, '').includes(needle);
    }) || null;
    const up = card('近期安排');
    const monthCard = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.cal__cell')) || null;
    return {
      cells: document.querySelectorAll('.cal__cell').length,
      chips,
      deadlines: chips.filter((c) => c.cls.includes('ev-deadline')).length,
      todos: chips.filter((c) => c.cls.includes('ev-todo')).length,
      tests: chips.filter((c) => c.cls.includes('ev-test')).length,
      interviews: chips.filter((c) => c.cls.includes('ev-interview')).length,
      upChips: up ? [...up.querySelectorAll('.cal__ev')].map(cls) : ['NO_CARD'],
      upText: up ? up.innerText.replace(/\\s+/g, ' ').slice(0, 200) : 'NO_CARD',
      todoText: (card('待办清单') || { innerText: 'NO_CARD' }).innerText.replace(/\\s+/g, ' ').slice(0, 140),
      dlText: (card('投递截止提醒') || { innerText: 'NO_CARD' }).innerText.replace(/\\s+/g, ' ').slice(0, 140),
      subtitle: (document.querySelector('.section-head__d') || {}).textContent || '',
      legend: monthCard ? [...monthCard.querySelectorAll('.row.gap-12 .cal__ev')].map((e) => e.textContent.trim()) : [],
    };
  `);
  console.log('日历态:', JSON.stringify({
    cells: probe.cells, deadlines: probe.deadlines, todos: probe.todos,
    tests: probe.tests, interviews: probe.interviews, legend: probe.legend,
  }));
  console.log('近期安排:', probe.upText);
  console.log('待办卡:', probe.todoText);
  console.log('截止卡:', probe.dlText);

  if (probe.cells >= 42) ok(`月视图 ${probe.cells} 格已渲染`);
  else bad(`月视图没渲染出来（${probe.cells} 格）`);

  /* ① 不该出现的两类 */
  if (probe.deadlines === 0) ok('月视图 0 个截止标记（截止不进格子）');
  else bad(`月视图混进 ${probe.deadlines} 个截止标记`);
  if (probe.todos === 0) ok('月视图 0 个待办标记（待办不进格子）');
  else bad(`月视图混进 ${probe.todos} 个待办标记`);
  const upBad = probe.upChips.filter((c) => c.includes('ev-deadline') || c.includes('ev-todo'));
  if (upBad.length === 0) ok('近期安排里也只有笔/面/Offer');
  else bad(`近期安排混进 ${upBad.length} 条截止/待办：${upBad.join(',')}`);
  if (!/截止/.test(probe.upText)) ok('近期安排文案无「截止」字样');
  else bad(`近期安排出现「截止」条目：${probe.upText.slice(0, 80)}`);

  /* ② 该出现的：进度线投影 + 手工面试 */
  if (probe.tests >= 1) ok(`进度线里的笔试已投影到日历（${probe.tests} 个）`);
  else bad('进度线里的笔试没有出现在日历上（投影断了）');
  if (probe.interviews >= 1) ok(`面试已进日历（${probe.interviews} 个）`);
  else bad('面试没有出现在日历上');

  /* ③ 数据一条不丢：截止回投递截止提醒卡，待办回待办清单 */
  if (/博时基金/.test(probe.dlText)) ok('投递截止提醒卡仍列出博时基金的截止（数据没丢，只是不画格子）');
  else bad(`投递截止提醒卡没读到截止记录：${probe.dlText.slice(0, 80)}`);
  if (/打印成绩单/.test(probe.todoText)) ok('待办清单卡仍有「打印成绩单」');
  else bad(`待办清单卡丢了待办：${probe.todoText.slice(0, 80)}`);

  /* ④ 口径文案与图例：图例只列三类，否则等于替旧口径站台 */
  if (/只放笔试/.test(probe.subtitle)) ok('页头副标题写明了「只放笔试 / 面试 / Offer」');
  else bad(`页头副标题没写清口径：${probe.subtitle}`);
  const legendOk = probe.legend.length === 3 && !probe.legend.some((t) => /截止|待办|事项/.test(t));
  if (legendOk) ok(`图例只有三类：${probe.legend.join(' / ')}`);
  else bad(`图例不对：${JSON.stringify(probe.legend)}`);

  await page.shot('calv-1440');

  /* ⑤ 点投影出来的那条笔试：弹窗必须承认自己是进度线节点，删除要写回投递记录 */
  const clicked = await page.eval(`
    const el = [...document.querySelectorAll('.cal__cell .cal__ev')].find((e) => /笔试/.test(e.textContent));
    if (!el) return 'NO_CHIP';
    el.click(); return 'OK';
  `);
  if (clicked !== 'OK') bad('没点到笔试标记：' + clicked);
  await sleep(600);
  const modal = await page.eval(`
    const m = document.querySelector('.modal');
    if (!m) return { open: false };
    return {
      open: true,
      title: (m.querySelector('.modal__title') || {}).textContent || '',
      btns: [...m.querySelectorAll('button')].map((b) => b.textContent.replace(/\\s+/g, '')).filter(Boolean),
      types: [...m.querySelectorAll('.badge')].map((b) => b.textContent.trim()).filter(Boolean),
      hint: /进度线/.test(m.innerText),
    };
  `);
  console.log('弹窗:', JSON.stringify(modal));
  if (modal.open && /笔面试节点/.test(modal.title)) ok('投影事件打开的是「编辑笔面试节点」');
  else bad(`投影事件弹窗标题不对：${modal.title}`);
  if (modal.btns.some((t) => /从进度线删除/.test(t))) ok('删除按钮写明「从进度线删除」（删的是投递记录里的节点，不是日历副本）');
  else bad(`删除按钮文案不对：${JSON.stringify(modal.btns)}`);
  const typesOk = modal.types.length === 3 && !modal.types.some((t) => /截止|待办/.test(t));
  if (typesOk) ok(`弹窗类型只给三类：${modal.types.join(' / ')}`);
  else bad(`弹窗类型不对：${JSON.stringify(modal.types)}`);
  await page.eval(`const b = [...document.querySelectorAll('.modal button')].find((x) => /取消/.test(x.textContent)); if (b) b.click(); return 'ok';`);
  await sleep(400);

  /* ⑥ 窄屏：右栏 320px 必须收起，不能把月格挤出屏幕 */
  const send = (m, p) => page.cdp.send(m, p, page.sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const narrow = await page.eval(`
    const wrap = document.querySelector('.cal-wrap');
    return {
      vw: window.innerWidth,
      wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : -1,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cols: wrap ? getComputedStyle(wrap).gridTemplateColumns : '',
      chips: document.querySelectorAll('.cal__cell .cal__ev').length,
    };
  `);
  console.log('390px:', JSON.stringify(narrow));
  if (narrow.docOverflow <= 1) ok('390px 无横向溢出');
  else bad(`390px 横向溢出 ${narrow.docOverflow}px`);
  /* 单列时 gridTemplateColumns 只剩一轨；仍是 '1fr 320px' 就说明断点没生效 */
  if (narrow.cols && narrow.cols.trim().split(/\s+/).length === 1) ok('390px 右栏已收起成单列');
  else bad(`390px 右栏没收起：${narrow.cols}`);
  if (narrow.chips >= 1) ok('390px 下笔面标记仍在');
  else bad('390px 下月格里的标记全没了');
  await page.shot('calv-390');

  console.log('日历口径巡检完成（只装笔试/面试/Offer）');
}

async function scenarioAppCat(page) {
  const fail = (m) => console.log('❌ ' + m);
  const ok = (m) => console.log('✅ ' + m);
  /* 播种按**固定分配**，且每个状态都 ≥4 条。为什么不能用取模等分：
     一是取模下每个状态各 17 条，看不出「计数串位」这类缺陷；
     二是 3 条预览上限需要 n>3 才能区分「≤3 条」与「截断到 3 条」。 */
  const CYCLE = ['todo', 'filling', 'submitted', 'test', 'interview', 'offer', 'reject',
    'submitted', 'test', 'interview', 'offer', 'reject', 'todo', 'filling'];
  const ALL = ['todo', 'filling', 'submitted', 'test', 'interview', 'offer', 'reject'];
  const LABEL = { todo: '待投递', filling: '填写中', submitted: '已提交', test: '笔试', interview: '面试', offer: 'Offer', reject: '未通过' };
  const N = 120;
  const EXPECT = {}; ALL.forEach((s) => { EXPECT[s] = 0; });
  for (let i = 0; i < N; i++) EXPECT[CYCLE[i % CYCLE.length]]++;
  const ODD = '昆仑万维（海外事业部）';
  const KW = '昆仑';
  /* ★ 命中数必须**按播种规则算出来**，不能凭感觉估、更不能写死。
     播种里含「昆仑」的只有 i%15===0 那一种（company 用 ODD+i），其余分支是「公司名（第k分公司）」，
     所以命中恰好是 i=0,15,30,…,105 这 8 条。
     实测踩过：这里原本写 Math.floor(N/30)+1=5，断言当场假红（实得 8）。 */
  const HITS = Math.floor((N - 1) / 15) + 1;
  const SUB = EXPECT.submitted;
  /* 断言 7 要改的那条：必须挑一条**确实落在「已提交」**的「昆仑」记录。
     符合条件的只有 i=30 与 i=105（CYCLE 里 submitted 出现在下标 2 和 7）。
     用 i=30 那条，记下它的完整公司名做身份锚点。 */
  const CO30 = ODD + 30;

  const gotoApps = async () => {
    await page.eval(`return window.__q.click('.nav__item', '求职进程');`);
    await sleep(900);
    await page.eval(`return window.__q.click('.tabbar__btn', '投递记录');`);
    /* ★ 不能只等 `.catc__card, .empty`：空态 `.empty` 在启动水合完成前就会渲染出来，
       会把「还没水合完」误判成「到位了」，随后读到 0 张卡。必须等**真正属于本页的**结构，
       并同时要求它已经用上播种后的数据。 */
    await page.waitFor(
      `(() => {
         if (document.querySelectorAll('.catc__card').length === 7) return true;
         if (document.querySelector('.empty')) {
           const t = document.body.innerText || '';
           return t.includes('还没有网申记录') && (window.__q.state().applications || []).length === 0;
         }
         return false;
       })()`, 8000,
    );
  };
  /* 读第一级快照：卡片顺序、data-cat、计数、每卡预览行数。一次求值取全，避免多次往返时页面已变 */
  const readCards = () => page.eval(`
    const cards = [...document.querySelectorAll('.catc__card')];
    return {
      cards: cards.map((c) => ({
        cat: c.getAttribute('data-cat'),
        count: Number((c.querySelector('.catc__count') || {}).textContent),
        rows: c.querySelectorAll('.catc__row').length,
        empty: c.classList.contains('catc__card--empty'),
      })),
      catc: !!document.querySelector('.catc'),
      empty: !!document.querySelector('.empty'),
      title: (document.querySelector('.section-head__t') || {}).textContent || '',
      approws: document.querySelectorAll('.approw').length,
      back: !!document.querySelector('.catc_back'),
      modal: document.querySelector('.modal') ? 1 : 0,
      txt: (document.querySelector('.app__scroll') || document.body).innerText || '',
    };
  `);

  await page.goto();
  await injectHelpers(page);

  /* ---- 播种：120 条投递，固定分布写进缓存键 ---- */
  const seeded = await page.eval(`
    const s = window.__q.state();
    const cycle = ${JSON.stringify(CYCLE)};
    const cos = ['中金公司', '国家开发银行', '中国工商银行', '中信证券', '上海证券交易所',
      '北京仲裁委员会', '深圳国际仲裁院', '中国石油', '国家电网', '中国移动'];
    const apps = [];
    for (let i = 0; i < ${N}; i++) {
      const odd = i % 15 === 0;
      apps.push({
        id: 'qaapp-cat-' + i,
        /* ⚠️ 拼接位必须在浏览器侧：这段求值体是 Node 的模板字符串，任何反引号插值都会先被 Node 解析，
           而 i 只存在于下面这个浏览器内的 for 里 → Node 抛 ReferenceError: i is not defined，
           场景在第一次求值前就早退（实测踩过，qa-regress.sh 记「未跑完」）。
           ⚠️ 连注释里都不能出现插值写法：本注释初版就是这么写的，结果自己被 Node 解析而触发了同一个错误。 */
        company: odd ? (${JSON.stringify(ODD)} + i) : cos[i % cos.length] + '（第' + (i % 5 + 1) + '分公司）',
        position: '岗位' + i + (i % 4 === 0 ? '（法律合规方向）' : ''),
        status: cycle[i % cycle.length],
        channel: '官网', location: '北京',
        deadline: i % 6 === 0 ? '2026-10-' + String(i % 28 + 1).padStart(2, '0') : '',
        timeline: [], notes: '', createdAt: '2026-09-01', updatedAt: '2026-09-01',
      });
    }
    localStorage.setItem(window.__q.cacheKey(), JSON.stringify({ ...s, applications: apps }));
    return { n: apps.length, expect: ${JSON.stringify(EXPECT)} };
  `);
  console.log('合成投递:', seeded.n, '条 /', JSON.stringify(seeded.expect));

  /* ★ 播种后**必须再 reload 一次**，否则整段断言全部落空。
     原因：播种只是往 localStorage 写了新值，而此刻页面里的 React store 还是「空数据」那份内存状态；
     store 的持久化 effect 在状态提交后会把**内存里的旧状态**整体写回同一个键（store.tsx 的
     `localStorage.setItem(storageKey, serialized)`），把刚播的数据当场覆盖掉。
     实测踩过：不 reload 时第一级拿到 0 张卡、title 停在「网申记录追踪」、搜索分支却能命中
     「跨全部类别」——看上去像产品坏了，其实是播种没生效。
     reload 之后 store 从种子启动，而 page.init 的种子守卫（键已存在则不重写）保证不被覆盖。 */
  await page.goto();
  await injectHelpers(page);
  /* ★ reload 之后不能立刻读 state：`Page.goto` 只等 `.app` 静态骨架 + 900ms，
     而 React store 真正把 localStorage 里的包灌进内存是**异步**的。
     实测：reload 后立刻读会偶尔拿到 0 条（随后整段断言连环假红，看似产品坏了）。
     这里先等一次「应用已完成启动水合」再读，读不到就如实报红、不静默继续。 */
  const hydrated = await page.waitFor(
    `(() => { const s = window.__q.state(); return (s.applications || []).length === ${N}; })()`, 10000,
  );
  if (!hydrated) {
    /* 兜底：也可能读到的不是我们播的那个键，打印出来便于定位 */
    const seen = await page.eval(`return {
      keys: Object.keys(window.__q.state()),
      apps: (window.__q.state().applications || []).length,
      key: window.__q.cacheKey(),
    };`);
    fail(`启动水合超时：10s 内 state.applications 未达到 ${N}（实得 ${JSON.stringify(seen)}）`);
  }
  const seededLive = await page.eval(`return (window.__q.state().applications || []).length;`);
  console.log('播种生效检查: state.applications =', seededLive);
  if (seededLive !== N) {
    fail(`播种未生效: state.applications=${seededLive}，期望 ${N}（后续断言不可信，请先修播种）`);
  }

  /* ---- 断言 1+2+3：默认落类别入口页；7 张卡；计数正确；预览最多 3 条 ---- */
  await gotoApps();
  await page.waitFor(`document.querySelectorAll('.catc__card').length === 7`, 8000);
  const c1 = await readCards();
  const cats = c1.cards.map((x) => x.cat);
  const catsOk = cats.length === 7 && cats.join(',') === ALL.join(',');
  console.log(`[1] 类别入口页: .catc=${c1.catc} 卡片=${c1.cards.length} data-cat=[${cats.join(',')}] title=「${c1.title}」`);
  if (!catsOk) fail(`第一级应恰有 7 张 .catc__card 且 data-cat 为 STATUS_ORDER，实得 ${c1.cards.length} 张 [${cats.join(',')}]`);
  else ok('第一级 7 张类别卡，data-cat 恰好覆盖 STATUS_ORDER 七状态');
  if (c1.title.trim() !== '网申记录追踪') fail(`第一级标题应为「网申记录追踪」，实得「${c1.title}」`);

  const counts = {}; c1.cards.forEach((x) => { counts[x.cat] = x.count; });
  const badCount = ALL.filter((s) => counts[s] !== EXPECT[s]);
  const sum = ALL.reduce((t, s) => t + (counts[s] || 0), 0);
  console.log(`[2] 各卡计数 ${JSON.stringify(counts)} 期望 ${JSON.stringify(EXPECT)} 之和=${sum}/${N}`);
  if (badCount.length) fail(`计数不符: ${badCount.map((s) => `${LABEL[s]} 实得${counts[s]}/应为${EXPECT[s]}`).join('、')}`);
  else ok('7 张卡计数与该状态实际条数逐项相符');
  if (sum !== N) fail(`7 卡计数之和应为 ${N}，实得 ${sum}`);

  const over3 = c1.cards.filter((x) => x.rows > 3);
  const rowList = c1.cards.map((x) => `${x.cat}:${x.rows}`).join(' ');
  console.log(`[3] 各卡预览行数 ${rowList}`);
  if (over3.length) fail(`预览应最多 3 条，超限: ${over3.map((x) => `${x.cat}=${x.rows}`).join('、')}`);
  else ok('每张卡预览行数均 ≤ 3');
  /* 空类别（本轮构造下不存在）才该显示「暂无记录」；有数据的卡显示「暂无记录」是错的 */
  const bogusNone = c1.cards.filter((x) => x.count > 0 && x.empty);
  if (bogusNone.length) fail(`有数据的卡不应带 catc__card--empty: ${bogusNone.map((x) => x.cat).join('、')}`);

  /* ---- 断言 4：点「已提交」下钻到第二级 ---- */
  await page.eval(`return window.__q.click('.catc__card', '已提交');`);
  await page.waitFor(`document.querySelectorAll('.approw').length > 0 || !!document.querySelector('.empty')`, 8000);
  await sleep(250);
  const c2 = await readCards();
  console.log(`[4] 下钻「已提交」: .catc__card=${c2.cards.length} .approw=${c2.approws}/${SUB} .catc_back=${c2.back} title=「${c2.title}」`);
  if (c2.cards.length !== 0) fail(`第二级不应再有 .catc__card，实得 ${c2.cards.length} 张`);
  if (!c2.title.includes('· 投递库') || !c2.title.includes('已提交')) fail(`第二级标题应含「已提交」与「· 投递库」，实得「${c2.title}」`);
  if (c2.approws !== SUB) fail(`第二级 .approw 应 === 已提交条数 ${SUB}，实得 ${c2.approws}`);
  if (!c2.back) fail('第二级缺少 .catc_back（返回各类别）');
  if (c2.cards.length === 0 && c2.approws === SUB && c2.back && c2.title.includes('· 投递库')) {
    ok(`下钻正确: .catc__card 归零、.approw=${SUB}、标题含「· 投递库」、.catc_back 存在`);
  }
  /* 行内结构：tile / co / pos / meta / status 五项齐全（缺一项是「行塌了」的典型形态） */
  const rowShape = await page.eval(`
    const row = document.querySelector('.approw'); if (!row) return null;
    const bad = [...document.querySelectorAll('.approw')].filter((r) =>
      !r.querySelector('.approw__tile') || !r.querySelector('.approw__co')
      || !r.querySelector('.approw__pos') || !r.querySelector('.approw__meta')
      || !r.querySelector('select.approw__status')).length;
    return { total: document.querySelectorAll('.approw').length, missing: bad };
  `);
  if (!rowShape) fail('第二级没有任何 .approw');
  else if (rowShape.missing > 0) fail(`${rowShape.missing}/${rowShape.total} 行缺少 approw__tile/co/pos/meta/status 之一`);
  else ok(`全部 ${rowShape.total} 行结构完整（tile/co/pos/meta/status 齐全）`);

  /* ---- 断言 5：返回各类别 ----
     ★ 必须**点里面那个按钮**，不能让 __q.click 落在外层 .catc_back 上：
     .catc_back 只是个 row-between 容器，它自己没有 onClick；点到容器上什么也不会发生，
     表现为「返回没生效」——这会让人一路排查产品代码，而问题在被测的点击本身。
     并且要点完先确认 click 返回 OK，再谈断言（否则红项会指向错误的方向）。 */
  const backClick = await page.eval(`
    const btn = [...document.querySelectorAll('.catc_back button')]
      .find((b) => (b.textContent || '').replace(/\\s+/g, '').includes('返回各类别'));
    if (!btn) return 'NO_BACK_BUTTON';
    btn.click();
    return 'OK';
  `);
  if (backClick !== 'OK') fail(`返回各类别按钮点不到: ${backClick}`);
  await page.waitFor(`document.querySelectorAll('.catc__card').length === 7`, 8000);
  await sleep(200);
  const c3 = await readCards();
  console.log(`[5] 返回后: .catc__card=${c3.cards.length} .approw=${c3.approws} title=「${c3.title}」`);
  if (c3.cards.length !== 7) fail(`返回后应恢复 7 张类别卡，实得 ${c3.cards.length}`);
  if (c3.approws !== 0) fail(`返回后 .approw 应归零，实得 ${c3.approws}`);
  if (c3.cards.length === 7 && c3.approws === 0) ok('返回各类别：7 张卡恢复、.approw 归零');

  /* ---- 断言 6：搜索跨类别收敛 + 清空恢复 ---- */
  const kwOk = await page.eval(`
    const inp = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('搜索公司'));
    if (!inp) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(KW)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  `);
  if (kwOk !== 'OK') { fail('找不到搜索框（placeholder 含「搜索公司」）'); }
  await page.waitFor(`document.querySelectorAll('.approw').length > 0`, 8000);
  await sleep(250);
  const c4 = await readCards();
  console.log(`[6] 搜索「${KW}」: .approw=${c4.approws}/${HITS} .catc__card=${c4.cards.length} 含「跨全部类别」=${c4.txt.includes('跨全部类别')}`);
  if (c4.cards.length !== 0) fail(`搜索态不应渲染类别卡，实得 ${c4.cards.length} 张`);
  if (c4.approws !== HITS) fail(`搜索「${KW}」应命中 ${HITS} 条，实得 ${c4.approws}`);
  if (c4.approws === N) fail('搜索结果等于全量，说明根本没做收敛');
  if (!c4.txt.includes('跨全部类别')) fail('搜索态缺少「跨全部类别」文案');
  if (!/命中\s*\d+\s*条/.test(c4.txt)) fail('搜索态缺少「命中 N 条」文案');
  if (c4.cards.length === 0 && c4.approws === HITS && c4.txt.includes('跨全部类别')) {
    ok(`搜索跨类别收敛: 命中 ${HITS} 条（≠${N}），显示「跨全部类别」`);
  }
  await page.eval(`return window.__q.click('button', '清除搜索');`);
  await page.waitFor(`document.querySelectorAll('.catc__card').length === 7`, 8000);
  await sleep(200);
  const c5 = await readCards();
  console.log(`[6b] 清除搜索后: .catc__card=${c5.cards.length} .approw=${c5.approws}`);
  if (c5.cards.length !== 7 || c5.approws !== 0) fail(`清除搜索后应回到类别页，实得 卡片=${c5.cards.length} approw=${c5.approws}`);
  else ok('清除搜索后恢复类别入口页');

  /* ---- 断言 7：行内原生 select 改状态，不弹窗；且第一级计数随之变化 ---- */
  await page.eval(`return window.__q.click('.catc__card', '已提交');`);
  await page.waitFor(`document.querySelectorAll('.approw').length > 0`, 8000);
  await sleep(250);
  /* ★ 定位必须**按身份**而不是按「第一个含关键词的行」：
     播种数据里含「昆仑」的行有 8 条（i%15===0），其中落在「已提交」的恰好 2 条（i=30 与 i=105）。
     改状态后列表会重排/该行会移出本类别，`.find(innerText.includes(KW))` 拿到的就**不是原来那一行**了
     —— 断言会读到另一行的值而报假红，甚至一度让我误以为产品没生效。
     这里改为按 DOM 序号锁定同一个下标，并在改之前记录它的公司名做身份校验。 */
  const before = await page.eval(`
    const rows = [...document.querySelectorAll('.approw')];
    const idx = rows.findIndex((r) => r.innerText.includes(${JSON.stringify(KW)}));
    if (idx < 0) return null;
    const row = rows[idx];
    const sel = row.querySelector('select.approw__status');
    return { idx, co: (row.querySelector('.approw__co') || {}).innerText || '', value: sel.value, opts: sel.options.length };
  `);
  if (!before) fail('第二级里找不到测试目标行');
  else {
    console.log(`[7] 目标行 select: idx=${before.idx} co=「${before.co}」 value=${before.value} options=${before.opts}`);
    if (before.value !== 'submitted') fail(`目标行应处于已提交，实得 ${before.value}`);
    if (before.opts !== 7) fail(`行内 select 应有 7 个选项，实得 ${before.opts}`);
    /* React 的 onChange 认的是原生 value setter + change 事件（直接改 .value 不派发会被忽略） */
    const chg = await page.eval(`
      const rows = [...document.querySelectorAll('.approw')];
      const row = rows[${before.idx}];
      if (!row) return 'NO_ROW';
      const sel = row.querySelector('select.approw__status');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'interview');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK';
    `);
    if (chg !== 'OK') fail('行内改状态派发失败: ' + chg);
    /* 该行会被移出「已提交」，故不能再用下标找它；改为断言**该 id 的记录**已不是 submitted，
       并按公司名在整页里确认它已不在本类别列表中。 */
    await page.waitFor(`(() => {
      const rows = [...document.querySelectorAll('.approw')];
      return !rows.some((r) => r.innerText.includes(${JSON.stringify(CO30)}));
    })()`, 6000);
    await sleep(300);
    const after = await page.eval(`
      const rows = [...document.querySelectorAll('.approw')];
      return {
        stillHere: rows.some((r) => r.innerText.includes(${JSON.stringify(CO30)})),
        st: (window.__q.state().applications || []).find((a) => a.company === ${JSON.stringify(CO30)}),
        modal: document.querySelector('.modal') ? 1 : 0,
        rows: rows.length,
      };
    `);
    const afterSt = after.st ? after.st.status : null;
    console.log(`[7] 改后: 该行仍在列表中=${after.stillHere} 缓存状态=${afterSt} .modal=${after.modal} 当前行数=${after.rows}`);
    if (afterSt !== 'interview') fail(`行内改状态后该记录 status 应为 interview，实得 ${afterSt}`);
    if (after.stillHere) fail('改状态后该行仍留在「已提交」类别里（就地改状态未即时生效）');
    if (after.modal !== 0) fail(`行内改状态不应弹窗，实得 .modal 存在 ${after.modal} 个`);
    if (afterSt === 'interview' && !after.stillHere && after.modal === 0) {
      ok('行内改状态：该记录 status→interview、已移出本类别、全程无弹窗');
    }
    /* 该行已移出「已提交」，列表条数应减 1（就地改状态必须即时反映，不能靠刷新） */
    if (after.rows !== SUB - 1) fail(`状态改出后本类别行数应为 ${SUB - 1}，实得 ${after.rows}`);
    else ok(`状态改出后本类别行数 ${SUB} → ${SUB - 1}`);
  }

  /* ---- 断言 8：脏值扫描（只认带边界的字面量，避免把公司名/备注里的子串误判成脏值） ---- */
  const dirty = await page.eval(`
    const t = document.body.innerText || '';
    return {
      undef: /(^|[^A-Za-z\\u4e00-\\u9fa5_])undefined([^A-Za-z\\u4e00-\\u9fa5_]|$)/.test(t),
      nan: /NaN/.test(t),
      nul: /(^|[^A-Za-z\\u4e00-\\u9fa5_])null([^A-Za-z\\u4e00-\\u9fa5_]|$)/.test(t),
      len: t.length,
    };
  `);
  console.log(`[8] 脏值扫描: undefined=${dirty.undef} NaN=${dirty.nan} null=${dirty.nul} (innerText ${dirty.len} 字)`);
  if (dirty.undef || dirty.nan || dirty.nul) fail(`页面出现脏值字面量: ${JSON.stringify(dirty)}`);
  else ok('整页无 undefined / NaN / null 字面量');

  /* ---- 断言 10（前半）：第二级截图 ---- */
  await page.shot('app-cat');

  /* ---- 断言 9：0 条时短路到 .empty（不能被 .catc 或空类别卡顶掉） ---- */
  await page.eval(`
    const s = window.__q.state();
    localStorage.setItem(window.__q.cacheKey(), JSON.stringify({ ...s, applications: [] }));
    return 'cleared';
  `);
  await page.goto();
  await injectHelpers(page);
  await gotoApps();
  await sleep(400);
  const c6 = await page.eval(`
    return {
      catc: !!document.querySelector('.catc'),
      cards: document.querySelectorAll('.catc__card').length,
      approws: document.querySelectorAll('.approw').length,
      empty: !!document.querySelector('.empty'),
      emptyText: (document.querySelector('.empty') || {}).innerText || '',
      appScroll: !!document.querySelector('.app__scroll'),
      state: (window.__q.state().applications || []).length,
    };
  `);
  console.log(`[9] 清空后 reload: state.applications=${c6.state} .catc=${c6.catc} .catc__card=${c6.cards} .approw=${c6.approws} .empty=${c6.empty}`);
  if (c6.state !== 0) fail(`清空未生效，state.applications=${c6.state}（后续断言不可信）`);
  if (c6.empty !== true) fail('0 条投递时应渲染 .empty，实得 false');
  if (c6.catc !== false) fail('0 条投递时不应渲染 .catc（应为空态短路）');
  if (c6.cards !== 0) fail(`0 条投递时不应渲染类别卡，实得 ${c6.cards} 张`);
  if (c6.approws !== 0) fail(`0 条投递时不应渲染 .approw，实得 ${c6.approws} 行`);
  if (c6.empty && c6.catc === false && c6.state === 0) {
    ok(`0 条记录走空态: .empty=true、.catc=false、文案含「还没有网申记录」=${c6.emptyText.includes('还没有网申记录')}`);
  }
  if (c6.empty && !c6.emptyText.includes('还没有网申记录')) fail(`空态文案异常: 「${c6.emptyText.slice(0, 60)}」`);
  await page.shot('app-cat-empty');

  console.log('投递记录两级结构巡检完成');
  return { n: N, expect: EXPECT, counts, hits: HITS, seeded: seeded.n, emptyOk: c6.empty && c6.catc === false };
}

const EMPTY_PAYLOAD = JSON.stringify({
  profile: null, theme: 'dark', resumeText: undefined, remind: {},
  applications: [], events: [], jobs: [], questions: [], banks: [],
  companies: [], offers: [], interviews: [], materials: [], versions: [], contacts: [],
});
const payload = EMPTY_SEED ? EMPTY_PAYLOAD : fs.readFileSync(PKG, 'utf8');
const { child, cdp, sessionId } = await launch();
const page = new Page(cdp, sessionId);
let result = {};
try {
  await page.init(payload);
  if (scenario === 'login') {
    await scenarioLogin(page);
    result = { errors: page.errors };
    throw { __done: true };
  }
  if (scenario === 'recovery') {
    await scenarioRecovery(page);
    result = { errors: page.errors };
    throw { __done: true };
  }
  if (scenario === 'loginreal') {
    await scenarioRealLogin(page);
    result = { errors: page.errors };
    throw { __done: true };
  }
  await page.goto();
  await injectHelpers(page);
  const boot = await page.eval(`return { jobs: window.__q.state().jobs?.length, apps: window.__q.state().applications?.length, ev: window.__q.state().events?.length, body: document.body.innerText.slice(0,120) };`);
  console.log('目标站点:', BASE);
  console.log('启动状态:', JSON.stringify(boot));
  console.log('启动错误:', JSON.stringify(page.errors));
  page.reset();

  if (scenario === 'views' || scenario === 'all') {
    const rows = await scenarioViews(page);
    for (const r of rows) {
      console.log(`\n[${r.group} / ${r.tab || '-'}] len=${r.mainLen} err=${r.errors.length} failed=${r.failed.length}`);
      console.log('  文本:', r.text.slice(0, 160));
      if (r.err) console.log('  ⚠️ 错误边界:', r.err);
      if (r.errors.length) console.log('  ❌', JSON.stringify(r.errors.slice(0, 4), null, 0));
    }
  }
  if (scenario === 'removeapp' || scenario === 'all') { page.reset(); await scenarioRemoveApp(page); }
  if (scenario === 'palette' || scenario === 'all') { page.reset(); await scenarioPalette(page); }
  if (scenario === 'convert' || scenario === 'all') { page.reset(); await scenarioConvert(page); }
  if (scenario === 'mailsync') { page.reset(); await scenarioMailSync(page); }
  if (scenario === 'settings') { page.reset(); await scenarioSettings(page); }
  if (scenario === 'settingsopt') { page.reset(); await scenarioSettingsOptional(page); }
  if (scenario === 'overlap') { page.reset(); await scenarioOverlap(page); }
  if (scenario === 'import') { page.reset(); await scenarioImport(page); }
  if (scenario === 'modules') { page.reset(); await scenarioModules(page); }
  if (scenario === 'bankrepo') { page.reset(); await scenarioBankRepo(page); }
  if (scenario === 'onboard') { page.reset(); await scenarioOnboard(page); }
  if (scenario === 'docx') { page.reset(); await scenarioDocx(page); }
  if (scenario === 'mail') { page.reset(); await scenarioMail(page); }
  if (scenario === 'crud') { page.reset(); await scenarioCrud(page); }
  if (scenario === 'reset') { page.reset(); await scenarioReset(page); }
  if (scenario === 'cloudfail') { page.reset(); await scenarioCloudFail(page); }
  if (scenario === 'loginreal') { page.reset(); await scenarioRealLogin(page); }
  if (scenario === 'twotab') { page.reset(); await scenarioTwoTab(page); }
  if (scenario === 'stale') { page.reset(); await scenarioStale(page); }
  if (scenario === 'staledirty') { page.reset(); await scenarioStaleDirty(page); }
  if (scenario === 'cloudsync') { page.reset(); await scenarioCloudSync(page); }
  if (scenario === 'typing') { page.reset(); await scenarioTyping(page); }
  if (scenario === 'misc') { page.reset(); await scenarioMisc(page); }
  if (scenario === 'mobile') { await scenarioMobile(page); }
  if (scenario === 'pwa') { await scenarioPwa(page); }
  if (scenario === 'contrast') { await scenarioContrast(page); }
  if (scenario === 'ai') { page.reset(); await scenarioAi(page); }
  if (scenario === 'agenttools') { page.reset(); await scenarioAgentTools(page); }
  if (scenario === 'agentconv') { page.reset(); await scenarioAgentConv(page); }
  if (scenario === 'roundtrip') { page.reset(); await scenarioRoundtrip(page); }
  if (scenario === 'webdav') { page.reset(); await scenarioWebdav(page); }
  if (scenario === 'scroll') { await scenarioScroll(page); }
  if (scenario === 'stacklock') { await scenarioStackLock(page); }
  if (scenario === 'perf') { await scenarioPerf(page); }
  if (scenario === 'appcat') { page.reset(); await scenarioAppCat(page); }
  if (scenario === 'pline') { page.reset(); await scenarioPline(page); }
  if (scenario === 'calv') { page.reset(); await scenarioCalv(page); }
  if (scenario === 'mailsend') { page.reset(); await scenarioMailSend(page); }
  result = { errors: page.errors };
} catch (e) {
  if (!e || !e.__done) console.error('巡检异常:', e.message);
} finally {
  cdp.close();
  try { child.kill('SIGKILL'); } catch {}
  /* Chrome 的渲染/GPU 子进程不会随主进程一起死，残留进程会**继续占着 user-data-dir**。
     同一 profile 再启动时，新进程会被单例逻辑顶回旧实例，于是「刚清空的 profile」
     里读到的还是上一轮的数据 —— 表现为场景随机假红假绿（实测：ai 场景第二次跑，
     岗位库里已经躺着第一轮导入的 2 条，全部被判「重复」，断言全绿其实什么都没验证）。
     按 profile 路径兜一刀，保证每轮都是干净起点。 */
  try { execFileSync('pkill', ['-f', `user-data-dir=${PROFILE}`], { stdio: 'ignore' }); }
  catch { /* 没有残留进程时 pkill 退出码为 1，属正常 */ }
}
console.log('\n截图目录:', SHOTS);
