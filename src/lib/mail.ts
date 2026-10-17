import type { MailMessage, MailCategory, MailAccount, SendAttachment } from '../types';

/** 本地邮件桥默认地址（本机 IMAP/SMTP 桥，直连你自己的邮箱）。可在设置中修改。 */
export const DEFAULT_BRIDGE = 'http://localhost:8787';
const LS_KEY = 'qz.bridgeUrl';
const LS_TOKEN = 'qz.bridgeToken';

/** 邮件桥访问令牌：防止任意网页调用本机邮件桥读取邮箱（与 ~/.dsh/mail-bridge/token 一致） */
export function getBridgeToken(): string {
  try { return localStorage.getItem(LS_TOKEN) || ''; } catch { return ''; }
}
export function setBridgeToken(t: string) {
  try { localStorage.setItem(LS_TOKEN, t.trim()); } catch { /* ignore */ }
}

export function getBridgeUrl(): string {
  try { return localStorage.getItem(LS_KEY) || DEFAULT_BRIDGE; }
  catch { return DEFAULT_BRIDGE; }
}
export function setBridgeUrl(url: string) {
  try { localStorage.setItem(LS_KEY, url.replace(/\/$/, '')); } catch { /* ignore */ }
}

async function req<T>(path: string, init?: RequestInit, timeout = 20000): Promise<T> {
  const base = getBridgeUrl();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    /*
     * 只有确实配置了令牌才带这个头。
     * 原因：带自定义头会让浏览器先发 OPTIONS 预检，而未升级的旧邮件桥不允许该头，
     * 预检失败会让**所有**邮件接口被 CORS 拦掉（哪怕桥本身是通的）。
     * 不带令牌时退化为简单请求，旧桥照常可用。
     */
    const token = getBridgeToken();
    const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) || {}) };
    if (token) headers['X-QZ-Token'] = token;
    const res = await fetch(base + path, { ...init, signal: ctrl.signal, headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json as T;
  } finally {
    clearTimeout(t);
  }
}

/** 探测本地邮件桥是否在线 */
export async function pingBridge(): Promise<boolean> {
  try {
    const r = await req<{ ok: boolean }>('/api/health', undefined, 3500);
    return !!r?.ok;
  } catch { return false; }
}

export async function fetchMe(): Promise<MailAccount> {
  return req<MailAccount>('/api/me');
}
export async function fetchList(dir = 'inbox', limit = 25): Promise<MailMessage[]> {
  const r = await req<{ messages: MailMessage[] }>(`/api/list?dir=${encodeURIComponent(dir)}&limit=${limit}`);
  return (r.messages || []).map(normalize);
}
export async function fetchRead(id: string): Promise<MailMessage> {
  const r = await req<{ message: MailMessage }>(`/api/read?id=${encodeURIComponent(id)}`);
  return normalize(r.message);
}
export async function searchMail(q: string, dir = 'inbox', limit = 25): Promise<MailMessage[]> {
  const r = await req<{ messages: MailMessage[] }>(
    `/api/search?q=${encodeURIComponent(q)}&dir=${encodeURIComponent(dir)}&limit=${limit}`);
  return (r.messages || []).map(normalize);
}

export interface SendPayload {
  to: string[]; subject: string; body: string;
  cc?: string[]; bcc?: string[]; confirmation_token?: string;
  attachments?: SendAttachment[];   // 浏览器端选择的文件（base64），由邮件桥落盘后交给 CLI
}
export interface SendResult {
  need_confirm?: boolean; confirmation_token?: string; summary?: string;
  sent?: boolean; message_id?: string; error?: string;
}
/** 两阶段发送：第一次不带 token → 返回 confirmation_token + summary；第二次带 token → 真正发送 */
export async function sendMail(p: SendPayload): Promise<SendResult> {
  return req<SendResult>('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  }, 30000);
}

function normalize(m: MailMessage): MailMessage {
  return { ...m, category: m.category || classify(m) };
}

/* ---------------- 邮件智能分类（招聘场景） ---------------- */
export const CATEGORY_META: Record<MailCategory, { label: string; cls: string; icon: string }> = {
  offer:          { label: 'Offer / 录用', cls: 'badge--ok',     icon: 'trophy' },
  interview:      { label: '面试通知',      cls: 'badge--info',   icon: 'video' },
  test:           { label: '笔试 / 测评',   cls: 'badge--warn',   icon: 'edit' },
  reject:         { label: '未通过 / 拒信', cls: 'badge--danger', icon: 'x' },
  'apply-confirm':{ label: '投递确认',      cls: 'badge--accent', icon: 'check' },
  newsletter:     { label: '资讯 / 订阅',   cls: 'badge--muted',  icon: 'mail' },
  other:          { label: '其他',          cls: 'badge--muted',  icon: 'mail' },
};

const KW: Record<MailCategory, string[]> = {
  offer: ['offer', '录用', '录用通知', '入职通知', '聘用', '拟录用', '签约邀请', ' Congratulations', 'onboard'],
  interview: ['面试', '面谈', 'interview', '复试', '终面', '一面', '二面', '面试邀请', '面试通知', '视频面'],
  test: ['笔试', '测评', '在线测试', '考试通知', 'test', 'assessment', '心理测评', '机试'],
  reject: ['未通过', '遗憾', '感谢信', '拒绝', '不合适', 'regret', 'unfortunately', '未进入', '已收悉', '人才库'],
  'apply-confirm': ['投递成功', '申请已提交', '已收到您的申请', '网申', 'application received', '报名成功', '简历已收到'],
  newsletter: ['订阅', 'newsletter', 'billing', 'unsubscribe', '周报', '促销', '资讯', 'digest', 'product update'],
  other: [],
};

export function classify(m: Partial<MailMessage>): MailCategory {
  const text = `${m.subject || ''} ${m.snippet || ''} ${m.body || ''}`.toLowerCase();
  const order: MailCategory[] = ['offer', 'interview', 'test', 'reject', 'apply-confirm', 'newsletter'];
  let best: MailCategory = 'other';
  let bestScore = 0;
  for (const cat of order) {
    let score = 0;
    for (const k of KW[cat]) if (text.includes(k.toLowerCase())) score += k.length > 4 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

/** 从邮件正文/主题中尝试抽取日期（用于同步到日历） */
export function extractDates(text: string): string[] {
  const out: string[] = [];
  const re = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, y, mo, d] = m;
    const mm = mo.padStart(2, '0'), dd = d.padStart(2, '0');
    out.push(`${y}-${mm}-${dd}`);
  }
  return Array.from(new Set(out));
}
