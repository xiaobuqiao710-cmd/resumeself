#!/usr/bin/env node
/**
 * 秋招网申辅助中心 · 本地邮件桥（自包含版）
 * ==========================================================================
 * 它做什么：在你自己的电脑上跑一个小服务，用 IMAP / SMTP 连你自己的邮箱，
 * 把邮件收发能力以 HTTP 接口暴露给 localhost，让网页版「邮件中心」能用。
 *
 * 为什么要跑在本地：浏览器不可能直接练 IMAP/SMTP，也不该把你的邮箱密码发给任何服务器。
 * 邮件凭据只存在这台电脑的这个文件里，网页只跟 localhost 说话，数据不经过第三方。
 *
 * 快速开始：
 *   1) cd mail-bridge && npm install
 *   2) cp bridge.config.example.json bridge.config.json   （然后填邮箱与授权码）
 *   3) npm start
 *   4) 终端会打印一个 48 位令牌，把它粘到网站「设置 → 邮件桥 → 访问令牌」
 *
 * 只想先试试能不能通、不想填邮箱？用演示模式：
 *   QZ_DEMO=1 npm start      # 返回一封假的收件箱，用来验证「网站 ↔ 桥」这一段是通的
 *
 * 环境要求：Node.js 18 或更高（node -v 查看）。
 * ==========================================================================
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'bridge.config.json');
const TOKEN_PATH = path.join(HERE, 'bridge.token');
const PORT = Number(process.env.QZ_BRIDGE_PORT || 8787);
const DEMO = process.env.QZ_DEMO === '1';

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error(`✗ ${CONFIG_PATH} 不是合法 JSON：${e.message}`);
      process.exit(1);
    }
  } else if (!DEMO) {
    console.error(`✗ 找不到配置文件 ${CONFIG_PATH}`);
    console.error('  请先执行：cp bridge.config.example.json bridge.config.json 然后填写。');
    console.error('  只想先试试连通性：QZ_DEMO=1 npm start');
    process.exit(1);
  }
  return {
    email: cfg.email || '',
    name: cfg.name || '',
    imap: {
      host: cfg.imap?.host || '',
      port: Number(cfg.imap?.port || 993),
      secure: cfg.imap?.secure !== false,
    },
    smtp: {
      host: cfg.smtp?.host || '',
      port: Number(cfg.smtp?.port || 465),
      secure: cfg.smtp?.secure !== false,
    },
    /* 授权码 / 应用专用密码 —— 不是你的登录密码 */
    authCode: cfg.authCode || '',
    sentFolder: cfg.sentFolder || '',
    /* 允许哪些网页来源访问。默认放行全部，因为令牌本身才是真正的门禁；
       想收紧就填 ["https://你的域名"]。 */
    allowOrigins: Array.isArray(cfg.allowOrigins) && cfg.allowOrigins.length ? cfg.allowOrigins : ['*'],
  };
}

const CFG = loadConfig();

/* 令牌：首次运行自动生成并落盘，之后每次启动都读同一份，避免用户反复粘贴 */
function ensureToken() {
  if (process.env.QZ_BRIDGE_TOKEN) return process.env.QZ_BRIDGE_TOKEN.trim();
  if (fs.existsSync(TOKEN_PATH)) {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t) return t;
  }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_PATH, t, { mode: 0o600 });
  return t;
}
const TOKEN = ensureToken();

/* ------------------------------------------------------------------ *
 * HTTP 基础设施
 * ------------------------------------------------------------------ */
function corsHeaders(origin) {
  const allow = CFG.allowOrigins.includes('*') ? '*' : (CFG.allowOrigins.includes(origin) ? origin : '');
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-QZ-Token',
    'Access-Control-Max-Age': '600',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  if (allow && allow !== '*') h['Vary'] = 'Origin';
  return h;
}

function send(res, code, obj, origin) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(code, {
    ...corsHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 除 /api/health 外一律要求令牌。
 *
 * 为什么 health 不要求：网站在「有没有填令牌」之前就要能显示「桥在线 / 离线」，
 * 否则用户填错地址时看到的是「离线」，而真正的原因可能是没填令牌 —— 分不清。
 * health 只回一个 {ok, needToken}，不泄露任何邮箱信息。
 */
function tokenOk(req) {
  const got = String(req.headers['x-qz-token'] || '');
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * 邮件访问层：真实 IMAP/SMTP
 * ------------------------------------------------------------------ */
let imapMod = null, mailparserMod = null, nodemailerMod = null;
async function loadDeps() {
  if (!imapMod) imapMod = await import('imapflow');
  if (!mailparserMod) mailparserMod = await import('mailparser');
  if (!nodemailerMod) nodemailerMod = await import('nodemailer');
}

async function withImap(fn) {
  await loadDeps();
  const { ImapFlow } = imapMod;
  const client = new ImapFlow({
    host: CFG.imap.host,
    port: CFG.imap.port,
    secure: CFG.imap.secure,
    auth: { user: CFG.email, pass: CFG.authCode },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* 断开失败不影响结果 */ }
  }
}

/** 收件箱 / 已发送的文件夹名候选：各家叫法不一样，逐个试 */
async function resolveMailbox(client, dir) {
  if (dir === 'inbox') return 'INBOX';
  if (CFG.sentFolder) return CFG.sentFolder;
  const candidates = ['Sent', 'Sent Items', 'Sent Messages', '已发送', '已发送邮件', '&XfJT0ZAB-'];
  const boxes = await client.list();
  const names = boxes.map((b) => b.path);
  for (const c of candidates) {
    const hit = names.find((n) => n === c || n.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  /* 退一步：挑一个名字里带 sent 的 */
  return names.find((n) => /sent/i.test(n)) || 'Sent';
}

function addr(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((a) => ({ name: a.name || '', email: a.address || '' }));
}

function toMessage(uid, dir, env, flags, bodyStructure) {
  const seen = flags && typeof flags.has === 'function' ? flags.has('\\Seen') : false;
  return {
    id: `${dir}:${uid}`,
    subject: env?.subject || '(无主题)',
    from: addr(env?.from)[0] || { name: '', email: '' },
    to: addr(env?.to),
    created_at: (env?.date instanceof Date ? env.date : new Date(env?.date || Date.now())).toISOString(),
    snippet: '',
    is_read: seen,
    has_attachments: !!(bodyStructure && JSON.stringify(bodyStructure).includes('attachment')),
    dir,
  };
}

async function listMessages(dir, limit) {
  /* 演示数据也要按目录过滤，否则「已发送」会把收件箱的内容一起列出来 ——
     一个一眼就能看出是假的 bug，但它会让人怀疑整个桥是不是坏的。 */
  if (DEMO) return DEMO_MESSAGES.filter((m) => m.dir === dir).slice(0, limit);
  return withImap(async (client) => {
    const mailbox = await resolveMailbox(client, dir);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const total = client.mailbox.exists || 0;
      if (!total) return [];
      const start = Math.max(1, total - Math.max(limit * 4, 40) + 1);
      const rows = [];
      for await (const m of client.fetch(`${start}:*`, { envelope: true, flags: true, bodyStructure: true, uid: true })) {
        rows.push(toMessage(m.uid, dir, m.envelope, m.flags, m.bodyStructure));
      }
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return rows.slice(0, limit);
    } finally {
      lock.release();
    }
  });
}

async function readMessage(id) {
  const [dir, uidStr] = String(id).split(':');
  const uid = Number(uidStr);
  if (DEMO) {
    const hit = DEMO_MESSAGES.find((m) => m.id === id);
    if (!hit) throw new Error('找不到这封邮件');
    return { ...hit, dir };
  }
  if (!Number.isFinite(uid)) throw new Error('邮件 id 不合法');
  return withImap(async (client) => {
    const mailbox = await resolveMailbox(client, dir);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const one = await client.fetchOne(String(uid), { source: true, envelope: true, flags: true }, { uid: true });
      if (!one) throw new Error('邮件不存在或已被删除');
      const { simpleParser } = mailparserMod;
      const parsed = await simpleParser(one.source);
      return {
        ...toMessage(uid, dir, one.envelope, one.flags, null),
        subject: parsed.subject || one.envelope?.subject || '(无主题)',
        from: parsed.from?.value?.[0] ? { name: parsed.from.value[0].name || '', email: parsed.from.value[0].address || '' } : addr(one.envelope?.from)[0],
        to: parsed.to?.value?.map((a) => ({ name: a.name || '', email: a.address || '' })) || addr(one.envelope?.to),
        body: parsed.html || parsed.text || '',
        body_is_html: !!parsed.html,
        has_attachments: (parsed.attachments || []).length > 0,
        attachments: (parsed.attachments || []).slice(0, 20).map((a, i) => ({
          id: `att-${i}`, filename: a.filename || `附件${i + 1}`, size: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

/**
 * 搜索在本地做，不用 IMAP SEARCH。
 * 原因：IMAP 的 SEARCH 对中文支持视服务商而定（很多服务器只认 ASCII，中文关键词直接搜不到），
 * 而用户搜的几乎一定是中文（"面试"、"笔试"）。拉最近几百封在本地过滤，结果反而准。
 */
async function searchMessages(q, dir, limit) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const pool = await listMessages(dir, 300);
  const out = [];
  for (const m of pool) {
    const hay = `${m.subject} ${m.from?.email || ''} ${m.from?.name || ''} ${m.snippet || ''}`.toLowerCase();
    if (!hay.includes(needle)) continue;
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

async function sendMail(payload) {
  if (DEMO) {
    return payload.confirmation_token
      ? { sent: true, message_id: `<demo-${Date.now()}@local>` }
      : { need_confirm: true, confirmation_token: 'demo-token', summary: `将发送给 ${(payload.to || []).join('、')}，主题「${payload.subject}」` };
  }
  /* 两阶段确认：第一次不带 token 只回摘要，第二次带 token 才真发。
     邮件发出去无法撤回，这一步防的是误点与误改。 */
  if (!payload.confirmation_token) {
    return {
      need_confirm: true,
      confirmation_token: crypto.randomBytes(12).toString('hex'),
      summary: `收件人：${(payload.to || []).join('、') || '(空)'}；主题：${payload.subject || '(无)'}`,
    };
  }
  await loadDeps();
  const nodemailer = nodemailerMod.default || nodemailerMod;
  const transporter = nodemailer.createTransport({
    host: CFG.smtp.host,
    port: CFG.smtp.port,
    secure: CFG.smtp.secure,
    auth: { user: CFG.email, pass: CFG.authCode },
  });
  const info = await transporter.sendMail({
    from: CFG.name ? `"${CFG.name}" <${CFG.email}>` : CFG.email,
    to: (payload.to || []).join(', '),
    cc: (payload.cc || []).join(', ') || undefined,
    bcc: (payload.bcc || []).join(', ') || undefined,
    subject: payload.subject || '',
    text: payload.body || '',
    attachments: (payload.attachments || []).map((a) => ({
      filename: a.filename, content: Buffer.from(String(a.dataBase64 || ''), 'base64'),
    })),
  });
  return { sent: true, message_id: info.messageId };
}

/* ------------------------------------------------------------------ *
 * 演示数据（QZ_DEMO=1）：让用户在填邮箱之前就能验证「网站 ↔ 桥」这一段
 * ------------------------------------------------------------------ */
const DEMO_MESSAGES = [
  {
    id: 'inbox:101', subject: '【面试通知】某某集团 2027 校园招聘 · 初面安排', from: { name: '某某集团招聘', email: 'hr@example-corp.com' },
    to: [{ name: '', email: 'you@example.com' }], created_at: new Date(Date.now() - 3600e3).toISOString(),
    snippet: '您好，恭喜通过简历筛选，请于 10 月 12 日 14:00 参加线上面试……', is_read: false, has_attachments: false, dir: 'inbox',
  },
  {
    id: 'inbox:100', subject: '在线测评邀请（请于 48 小时内完成）', from: { name: '某某银行校招', email: 'campus@example-bank.com' },
    to: [{ name: '', email: 'you@example.com' }], created_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
    snippet: '请点击链接完成在线笔试，账号为您的手机号……', is_read: false, has_attachments: false, dir: 'inbox',
  },
  {
    id: 'inbox:99', subject: '您的申请已收到 · 感谢投递', from: { name: '某某证券', email: 'noreply@example-sec.com' },
    to: [{ name: '', email: 'you@example.com' }], created_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
    snippet: '我们已收到您的简历，后续进展将通过邮件通知……', is_read: true, has_attachments: false, dir: 'inbox',
  },
  {
    id: 'sent:1', subject: 'Re: 关于实习证明的补充材料', from: { name: '我', email: 'you@example.com' },
    to: [{ name: 'HR', email: 'hr@example-corp.com' }], created_at: new Date(Date.now() - 2 * 86400e3).toISOString(),
    snippet: '您好，附件为补充材料，请查收……', is_read: true, has_attachments: true, dir: 'sent',
  },
];

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  if (p === '/api/health') return send(res, 200, { ok: true, needToken: true, demo: DEMO }, origin);

  if (!tokenOk(req)) {
    /* 令牌不对时把原因说清楚：用户最常犯的错是「只填了地址、忘了填令牌」，
       回一句 HTTP 401 的英文对排查毫无帮助。 */
    return send(res, 401, {
      error: '访问令牌不正确或未填写。请在网站「设置 → 邮件桥 → 访问令牌」里粘贴启动时打印的那串 48 位令牌。',
    }, origin);
  }

  try {
    if (p === '/api/me') {
      return send(res, 200, { email: CFG.email || 'demo@local', name: CFG.name || '' }, origin);
    }
    if (p === '/api/list') {
      const dir = url.searchParams.get('dir') || 'inbox';
      const limit = Math.min(Number(url.searchParams.get('limit') || 25), 200);
      return send(res, 200, { messages: await listMessages(dir, limit) }, origin);
    }
    if (p === '/api/read') {
      return send(res, 200, { message: await readMessage(url.searchParams.get('id')) }, origin);
    }
    if (p === '/api/search') {
      const dir = url.searchParams.get('dir') || 'inbox';
      const limit = Math.min(Number(url.searchParams.get('limit') || 25), 200);
      return send(res, 200, { messages: await searchMessages(url.searchParams.get('q'), dir, limit) }, origin);
    }
    if (p === '/api/send' && req.method === 'POST') {
      const raw = await readBody(req);
      return send(res, 200, await sendMail(raw), origin);
    }
    return send(res, 404, { error: '没有这个接口：' + p }, origin);
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('[邮件桥] 出错：', msg);
    /* 把常见错误翻成人话 —— 用户看到 "Invalid credentials" 不知道该改什么 */
    let hint = msg;
    if (/auth|credential|login|AUTHENTICATIONFAILED/i.test(msg)) {
      hint = '登录邮箱失败：多半是「授权码」不对。注意要用邮箱服务商生成的 IMAP/SMTP 授权码（应用专用密码），不是你的登录密码。';
    } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/i.test(msg)) {
      hint = '连不上邮箱服务器：检查 imap.host / smtp.host 是否填对（各家服务商不同），以及本机网络是否正常。';
    } else if (/certificate|self signed/i.test(msg)) {
      hint = '证书校验失败：若你用的是自建邮件服务器，可在配置里把 imap.secure / smtp.secure 设为 false（仅限可信内网）。';
    }
    return send(res, 500, { error: hint, raw: msg }, origin);
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 30 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  const line = '─'.repeat(64);
  console.log(line);
  console.log('  秋招网申辅助中心 · 本地邮件桥已启动');
  console.log(line);
  console.log(`  地址      http://localhost:${PORT}`);
  console.log(`  邮箱      ${CFG.email || '(演示模式，未连真实邮箱)'}`);
  console.log(`  模式      ${DEMO ? '演示（返回假数据，用来验证网站能否连上）' : '真实（IMAP + SMTP）'}`);
  console.log('');
  console.log('  访问令牌（复制这串，粘到网站的「设置 → 邮件桥 → 访问令牌」）：');
  console.log('');
  console.log('    ' + TOKEN);
  console.log('');
  console.log('  令牌也保存在：' + TOKEN_PATH);
  console.log('  停止服务：在本窗口按 Ctrl + C');
  console.log(line);
});
