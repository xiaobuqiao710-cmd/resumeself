import type { AppStatus, MailMessage, Application, ProfileData } from '../types';
import { classify } from './mail';

/**
 * AI 能力配置与「收件箱 → 投递状态」智能同步。
 * 支持任意 OpenAI 兼容接口（OpenAI / DeepSeek / Moonshot / 通义 / 自建网关等）。
 */

export interface AiConfig {
  baseUrl: string;   // e.g. https://api.openai.com/v1
  apiKey: string;
  model: string;     // e.g. gpt-4o-mini / deepseek-chat
  /**
   * 联网搜索 Key（可选）。填了之后站内 AI 助手才会多出一个 web_search 工具。
   * 与 apiKey 同源同待遇：只存本机浏览器、不上云、不进代码。
   */
  searchKey?: string;
  /** 搜索接口地址，默认博查；将来换服务商只改这一个值（见 setSearchBase） */
  searchBase?: string;
}

const LS_KEY = 'qz.ai';

// 默认不预置任何第三方密钥：AI 能力需你在「设置」中填入自己的 API Key。
// 未配置时全站自动降级为关键词兜底，功能可用但不会消耗任何他人额度。
export const DEFAULT_AI: AiConfig = { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' };

/** 常见服务商预设：选择后自动填充 API Base URL 与可选模型列表 */
export interface AiProvider { id: string; label: string; baseUrl: string; models: string[]; }
export const AI_PROVIDERS: AiProvider[] = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] },
  { id: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'] },
  { id: 'qwen', label: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
  { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'] },
  { id: 'custom', label: '自定义（任意 OpenAI 兼容）', baseUrl: '', models: [] },
];
/** 按 Base URL 识别当前服务商；识别不了归为自定义 */
export function detectProvider(baseUrl: string): AiProvider {
  const u = (baseUrl || '').replace(/\/$/, '');
  return AI_PROVIDERS.find((p) => p.baseUrl && u === p.baseUrl.replace(/\/$/, '')) || AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

export function getAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AiConfig>;
      // 历史遗留：早期版本预置过第三方网关地址与密钥，一律作废
      if (saved.baseUrl && /tcloudbasegateway|cloudbase/i.test(saved.baseUrl)) {
        return { ...DEFAULT_AI, model: saved.model || DEFAULT_AI.model };
      }
      return { ...DEFAULT_AI, ...saved };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_AI };
}
export function setAiConfig(p: Partial<AiConfig>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...getAiConfig(), ...p })); } catch { /* ignore */ }
}
export const hasAiKey = () => !!getAiConfig().apiKey.trim();

/* ================= 联网搜索（博查 Web Search） =================
 * 为什么是「用户自带 Key」而不是站方代付：本站是纯前端应用，任何写进代码或环境变量的
 * 密钥都会随 JS 包发给每一个访客，谁都能拿去烧额度。所以跟 AI Key 一个规矩 ——
 * 用户自己填、只存本机 localStorage、不上云、不进仓库。
 *
 * 为什么不需要加服务端代理（api/ 目录）：博查接口对预检 OPTIONS 回
 * `access-control-allow-origin: *`（2026-10 实测），浏览器可以直接调，
 * 于是「零后端」这条架构线没有被破坏，也就不必为它新增一个 Serverless Function。
 *
 * 选博查而不是 Bing/Google/DDG 的原因：那三家的前端接口都没有 CORS 头，
 * 浏览器直连必挂；而博查是给 AI 用的中文搜索，岗位/招聘/待遇这类中文长尾内容
 * 命中率明显好于英文搜索引擎的中文索引，返回里还自带 summary 与发布时间。
 */
export const DEFAULT_SEARCH_BASE = 'https://api.bochaai.com/v1/web-search';

/** 时效过滤；映射到博查的 freshness 取值，用户说「最近一周」时用得上 */
export type SearchFreshness = 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';

const FRESHNESS_ALIAS: Record<string, SearchFreshness> = {
  day: 'oneDay', today: 'oneDay', '1d': 'oneDay', d1: 'oneDay', oneDay: 'oneDay',
  week: 'oneWeek', '1w': 'oneWeek', w1: 'oneWeek', oneWeek: 'oneWeek',
  month: 'oneMonth', '1m': 'oneMonth', m1: 'oneMonth', oneMonth: 'oneMonth',
  year: 'oneYear', '1y': 'oneYear', y1: 'oneYear', oneYear: 'oneYear',
  all: 'noLimit', nolimit: 'noLimit', noLimit: 'noLimit',
};
/** 宽松归一：模型可能写 'week'/'近一周'/''，认不出来就当不限时间，绝不因为一个枚举值把整轮打回 */
export function normalizeFreshness(v: unknown): SearchFreshness {
  const s = String(v ?? '').trim();
  if (!s) return 'noLimit';
  if (FRESHNESS_ALIAS[s]) return FRESHNESS_ALIAS[s];
  const low = s.toLowerCase();
  if (FRESHNESS_ALIAS[low]) return FRESHNESS_ALIAS[low];
  if (/天|日/.test(s)) return 'oneDay';
  if (/周|星期/.test(s)) return 'oneWeek';
  if (/月/.test(s)) return 'oneMonth';
  if (/年/.test(s)) return 'oneYear';
  return 'noLimit';
}

export interface WebSearchItem {
  title: string;
  url: string;
  site?: string;     // 站点名，如「上岸鸭公考」
  date?: string;     // 发布时间 YYYY-MM-DD
  snippet?: string;  // 摘要片段
  summary?: string;  // 长摘要（比 snippet 完整，适合直接喂模型）
}

export interface WebSearchOutput {
  query: string;
  items: WebSearchItem[];
  /** 结果条数少于请求数时给模型一句说明，免得它以为「没有相关信息」 */
  note?: string;
}

/**
 * 调博查联网搜索。key 为空或接口报错时抛出可直接展示给用户的错误。
 * cfg 默认取当前配置；单测/设置页可以显式传入。
 */
export async function webSearch(
  query: string,
  opts: { count?: number; freshness?: SearchFreshness | string; summary?: boolean } = {},
  cfg: AiConfig = getAiConfig(),
  timeout = 30000,
): Promise<WebSearchOutput> {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词为空');
  const key = String(cfg.searchKey || '').trim();
  if (!key) throw new Error('还没填联网搜索的 Key。请到「设置 → AI 助手 → 联网搜索」填入（博查开放平台的 Key）。');

  const url = String(cfg.searchBase || DEFAULT_SEARCH_BASE);
  const count = Math.max(1, Math.min(10, Number(opts.count) || 6));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: q, count,
        freshness: normalizeFreshness(opts.freshness),
        /* summary=true 时博查会额外返回一整段可读摘要 —— 对「大商所待遇怎么样」这类
           需要读正文的问题，比 snippet 的截断片段有用得多，代价只是响应稍大 */
        summary: opts.summary !== false,
      }),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`联网搜索超时（${Math.round(timeout / 1000)}s 无响应）`);
    throw new Error(`连不上搜索服务 ${url}（浏览器报 Failed to fetch）。常见原因：本机网络/代理不通，或该接口不支持浏览器跨域调用。`);
  } finally { clearTimeout(t); }

  const txt = await res.text().catch(() => '');
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(txt) as Record<string, unknown>; } catch { /* 非 JSON，下面按原文报错 */ }

  if (!res.ok) {
    const msg = String((json?.message as string) || (json?.msg as string) || txt.slice(0, 160) || '');
    const hint = res.status === 401 || /invalid api key|unauthorized/i.test(msg)
      ? '搜索 Key 无效或已被删除，请到博查开放平台后台重新生成。'
      : res.status === 403 ? '这个 Key 没有调用搜索接口的权限（或账户未开通）。'
      : res.status === 429 ? '搜索次数超限或额度用尽，稍后重试或到后台看额度。'
      : res.status === 402 || /balance|quota|insufficient|余额/i.test(msg) ? '账户余额/额度不足，去博查后台充值或领免费额度。'
      : res.status >= 500 ? '搜索服务商侧故障（5xx），不是你的配置问题，稍后重试。'
      : '';
    throw new Error(`【搜索 HTTP ${res.status}】${msg}${hint ? '\n\n怎么办：' + hint : ''}`);
  }

  /* 注意：成功时 code 是数字 200，失败时是字符串 "401" —— 一律转成字符串比对，
     只判 `!== 200` 会把成功当失败（这是这类接口最常见的坑）。 */
  const code = String(json?.code ?? '');
  if (code && code !== '200') {
    const msg = String((json?.message as string) || (json?.msg as string) || '');
    throw new Error(`【搜索 ${code}】${msg || '搜索接口返回了非 200 的 code'}`);
  }

  const data = json?.data as { webPages?: { value?: unknown } } | undefined;
  const value = data?.webPages?.value;
  const raw: Record<string, unknown>[] = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const items: WebSearchItem[] = raw.slice(0, count).map((x) => ({
    title: String(x.name || x.title || '').trim(),
    url: String(x.url || '').trim(),
    site: x.siteName ? String(x.siteName) : undefined,
    date: String(x.datePublished || x.dateLastCrawled || '').slice(0, 10) || undefined,
    snippet: x.snippet ? String(x.snippet).replace(/\s+/g, ' ').trim() : undefined,
    summary: x.summary ? String(x.summary).replace(/\s+/g, ' ').trim() : undefined,
  })).filter((x) => x.url || x.title);

  return { query: q, items, note: items.length ? undefined : '该关键词没有搜到网页结果（换更具体的关键词，或把时效放宽）' };
}

/** 连接测试：跑一次真实搜索，让用户当场看到「通没通」，而不是等到用的时候才发现 Key 是错的 */
export async function testSearchConnection(cfg: AiConfig): Promise<string> {
  const out = await webSearch('2027 校园招聘', { count: 1 }, cfg, 20000);
  const first = out.items[0];
  return first ? `${first.site || ''}${first.title}`.slice(0, 40) : '（无结果，但接口已通）';
}

/** 仅判断是否配了搜索 Key（用于界面上那枚状态徽标） */
export const hasSearchKey = () => !!String(getAiConfig().searchKey || '').trim();


export interface AiAppUpdate {
  company: string;
  position?: string;
  status: AppStatus;
  date?: string;      // YYYY-MM-DD（邮件中提到的笔试/面试/截止日期）
  note?: string;
  mailSubject?: string;
}

const VALID: AppStatus[] = ['todo', 'filling', 'submitted', 'test', 'interview', 'offer', 'reject'];

/** 调用 OpenAI 兼容 chat/completions */
export async function callAi(cfg: AiConfig, system: string, user: string, timeout = 45000): Promise<string> {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`请求超时（${Math.round(timeout / 1000)}s 无响应）`);
    /* Failed to fetch 在浏览器里是个「哑错误」：地址写错、协议不对、被 CORS 挡、DNS 不通
       全都表现为同一句话。这里按 Base URL 的形态先给出最可能的那一条，避免用户去猜。 */
    const u = (cfg.baseUrl || '').trim();
    if (!u) throw new Error('还没填 API Base URL。请在上面选一个服务商，或手动填接口地址（如 https://api.deepseek.com/v1）。');
    if (!/^https?:\/\//i.test(u)) throw new Error(`API Base URL 必须以 http:// 或 https:// 开头，当前填的是「${u}」。`);
    if (/(^|\.)(deepseek|openai|moonshot|dashscope|bigmodel)\.(com|cn)\/?$/i.test(u.replace(/\/$/, ''))) {
      throw new Error(`这看起来是官网地址而不是接口地址（${u}）。请填到 /v1 为止，例如 https://api.deepseek.com/v1 —— 填 www.deepseek.com 一定会连不上。`);
    }
    throw new Error(`连不上 ${u}（浏览器报 Failed to fetch）。三种常见原因：① 地址不是「接口地址」（应填到 /v1）；② 该服务商不允许浏览器直接跨域调用（不少国内服务商默认关闭，需换用支持 CORS 的网关）；③ 本机网络/DNS 不通或被代理拦截。`);
  } finally { clearTimeout(t); }
  try {
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      /* 各家在 body 里的报错字段名不统一（error.message / message / error），
         统一抽出来，让用户看到服务商自己的原话——那比我们的猜测准确得多。 */
      let detail = txt.slice(0, 200);
      try {
        const j = JSON.parse(txt);
        const m = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '');
        if (m) detail = String(m).slice(0, 200);
      } catch { /* 不是 JSON，就用原文 */ }
      const lower = detail.toLowerCase();
      let hint = '';
      if (res.status === 401 || res.status === 403) {
        hint = 'API Key 无效、过期，或这个 Key 没有调用该模型的权限。请回服务商后台确认 Key 是否被删除、是否欠费。';
      } else if (res.status === 404) {
        /* 模型不存在时，用服务商原话里提到的那个模型名（比 cfg.model 更准：
           用户可能刚改过输入框但还没保存）。抽不到就退回当前配置里的名字。 */
        const mentioned = detail.match(/[`"']([\w.:\-\/]{2,60})[`"']/);
        const name = mentioned ? mentioned[1] : cfg.model;
        hint = /model|模型/i.test(lower)
          ? `服务商说没有「${name}」这个模型。请在上面的「模型」里换一个当前可用的名字。`
          : '接口路径不存在。请检查 API Base URL 是否填到了 /v1（多一个或少一个路径都会 404）。';
      } else if (res.status === 429) {
        hint = '触发限流或余额不足。稍等片刻重试；若持续出现，去服务商后台看额度。';
      } else if (res.status === 402 || /insufficient|balance|quota|欠费|余额/i.test(lower)) {
        hint = '账户余额不足。请到服务商后台充值后重试。';
      } else if (res.status >= 500) {
        hint = '服务商侧故障（5xx），不是你的配置问题。稍后重试即可。';
      }
      throw new Error(`【HTTP ${res.status}】${detail}${hint ? '\n\n怎么办：' + hint : ''}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('接口返回成功，但里面没有内容（choices[0].message.content 为空）。多半是模型名填成了不支持对话的模型，或该网关的返回格式不兼容。');
    return String(content);
  } finally { clearTimeout(t); }
}

/** 连接测试：发一条极简请求，验证 Base URL / Key / 模型是否可用，返回模型回复 */
export async function testAiConnection(cfg: AiConfig): Promise<string> {
  const reply = await callAi(cfg, '你是连接测试助手。', '请只回复四个字：连接正常', 20000);
  return reply.trim();
}

/**
 * 把 AI 报错按「用户下一步该做什么」分成几类，供 UI 决定用哪种样式展示。
 * 诊断信息本质上是一段要读的文字，不该塞进单行徽标里被截断。
 */
export function aiErrorKind(msg: string): 'config' | 'money' | 'auth' | 'net' | 'other' {
  if (/还没填|必须以 http|官网地址|接口地址/.test(msg)) return 'config';
  if (/余额|余额不足|欠费/.test(msg)) return 'money';
  if (/401|403|API Key 无效|没有调用该模型/.test(msg)) return 'auth';
  if (/连不上|Failed to fetch|超时|网络|DNS|跨域/.test(msg)) return 'net';
  return 'other';
}

/** 从模型输出中宽松提取 JSON 对象 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const s = text.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : null;
  } catch { return null; }
}

/** 从模型输出中宽松提取 JSON 数组 */
export function extractJsonArray(text: string): unknown[] {
  const s = text.trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

const SYSTEM =
  '你是秋招网申状态识别助手。阅读招聘相关邮件，判断对应的公司/岗位与最新投递状态。' +
  '状态枚举仅限：todo(待投递)/filling(填写中)/submitted(已提交/投递确认)/test(笔试测评)/interview(面试)/offer(录用)/reject(未通过拒信)。' +
  '只输出一个 JSON 数组，不要任何解释。每项字段：company(公司名),position(岗位,可空),status,date(邮件中提到的笔试/面试/截止日期 YYYY-MM-DD,可空),note(一句话摘要,可空),mailSubject(原邮件主题)。' +
  '与求职无关的邮件（订阅/账单/推广）不要输出。';

export function buildSyncUserPrompt(mails: MailMessage[], apps: Application[]): string {
  const mailLines = mails.map((m, i) =>
    `[${i}] 主题：${m.subject || '(无)'}｜发件人：${m.from?.name || ''} <${m.from?.email || ''}>｜日期：${(m.created_at || '').slice(0, 10)}｜摘要：${(m.snippet || '').replace(/\s+/g, ' ').slice(0, 200)}`);
  const appLines = apps.length
    ? apps.map((a) => `- ${a.company}｜${a.position}｜当前状态:${a.status}`)
    : ['- (暂无已有投递记录)'];
  return [
    '【当前投递记录】', ...appLines, '',
    '【收件箱邮件】', ...mailLines, '',
    '请输出 JSON 数组。',
  ].join('\n');
}

/** AI 智能同步：返回建议的状态更新列表 */
export async function aiSyncStatus(mails: MailMessage[], apps: Application[], cfg: AiConfig): Promise<AiAppUpdate[]> {
  const raw = await callAi(cfg, SYSTEM, buildSyncUserPrompt(mails, apps));
  const arr = extractJsonArray(raw);
  const out: AiAppUpdate[] = [];
  for (const it of arr) {
    const o = it as Record<string, unknown>;
    const company = String(o.company || '').trim();
    const status = String(o.status || '') as AppStatus;
    if (!company || !VALID.includes(status)) continue;
    out.push({
      company,
      position: o.position ? String(o.position) : undefined,
      status,
      date: o.date ? String(o.date).slice(0, 10) : undefined,
      note: o.note ? String(o.note) : undefined,
      mailSubject: o.mailSubject ? String(o.mailSubject) : undefined,
    });
  }
  return out;
}

/** 无 API Key 时的关键词兜底：按邮件分类映射状态 */
export function keywordFallback(mails: MailMessage[]): AiAppUpdate[] {
  const map: Partial<Record<string, AppStatus>> = {
    offer: 'offer', interview: 'interview', test: 'test', reject: 'reject', 'apply-confirm': 'submitted',
  };
  const out: AiAppUpdate[] = [];
  for (const m of mails) {
    const cat = m.category || classify(m);
    const st = map[cat];
    if (!st) continue;
    const company = (m.from?.name || m.from?.email?.split('@')[0] || '').trim();
    if (!company) continue;
    out.push({ company, status: st, mailSubject: m.subject, note: `由邮件分类「${cat}」自动识别` });
  }
  return out;
}

/* ================= 岗位 JD 解析（支持多公司/多岗位混合文本拆分） ================= */
export interface ParsedJob {
  company: string; title: string; city?: string; salary?: string;
  requirements?: string; deadline?: string; source?: string; url?: string; jd?: string;
}

const JOB_PARSE_SYSTEM =
  '你是招聘信息结构化助手。用户粘贴的文本可能包含多家公司、多个岗位的招聘信息。' +
  '你必须按「独立岗位」拆分，只输出一个 JSON 数组，不要任何解释。拆分规则：不同公司、或同一公司的不同岗位，都必须各自单独成项；禁止把多个岗位合并成一项；与招聘无关的段落忽略。' +
  '每项字段：company(公司名),title(岗位名),city(城市,可空),salary(薪资,可空),requirements(任职要求原文摘录,可空),deadline(投递截止 YYYY-MM-DD,可空),source(来源平台,可空),url(岗位链接,可空),jd(该岗位对应的原文描述段落,可空)。' +
  '抽不到的字段给空字符串；company 与 title 必须从原文精准提取，不得臆造。';

export async function aiParseJobs(text: string, cfg: AiConfig): Promise<ParsedJob[]> {
  const raw = await callAi(cfg, JOB_PARSE_SYSTEM, text.slice(0, 12000), 60000);
  const arr = extractJsonArray(raw);
  const out: ParsedJob[] = [];
  for (const it of arr) {
    const o = it as Record<string, unknown>;
    const s = (k: string) => (o[k] ? String(o[k]).trim() : '');
    const company = s('company');
    const title = s('title');
    if (!company && !title) continue;
    out.push({
      company, title,
      city: s('city') || undefined, salary: s('salary') || undefined,
      requirements: s('requirements') || undefined,
      deadline: s('deadline').slice(0, 10) || undefined,
      source: s('source') || undefined, url: s('url') || undefined,
      jd: s('jd') || (arr.length === 1 ? text.slice(0, 3000) : undefined),
    });
  }
  return out;
}

/* ================= 简历匹配度评估 ================= */
export interface JobMatchResult { score: number; highlights: string; gaps: string; advice: string; }

const MATCH_SYSTEM =
  '你是资深校招顾问。对比候选人档案与岗位 JD，评估匹配度。只输出一个 JSON 对象，不要解释：' +
  'score(0-100 整数),highlights(3 条匹配亮点，用「；」分隔),gaps(最多 2 条差距/风险，用「；」分隔),advice(一句针对性投递或补强建议)。';

/** 将个人档案压缩为一段供 AI 使用的摘要 */
export function buildProfileSummary(profile: ProfileData): string {
  const p = profile.single.personal || {};
  const edu = (profile.multi.education || []).map((e) => `${e.school || ''}${e.major || ''}(${e.edu || ''})`).join('；');
  const intern = (profile.multi.internship || []).map((e) => `${e.company || ''}·${e.position || ''}：${(e.content || '').slice(0, 80)}`).join('；');
  const proj = (profile.multi.project || []).map((e) => (e.desc || '').slice(0, 60)).join('；');
  const awards = (profile.multi.award || []).map((e) => e.name).join('、');
  const certs = (profile.multi.certificate || []).map((e) => e.name).join('、');
  const extra = profile.single.extra || {};
  return [
    `姓名:${p.name || ''} 政治面貌:${p.political || ''} 学历:${p.highestEdu || ''} 英语:${p.englishLevel || ''}`,
    `教育:${edu}`, `实习:${intern}`, `项目:${proj}`, `获奖:${awards}`, `证书:${certs}`,
    `特长:${(extra.specialty || '').slice(0, 100)}`, `自评:${(extra.selfEval || p.selfEval || '').slice(0, 150)}`,
  ].join('\n');
}

export async function aiMatchJob(jobText: string, profileSummary: string, cfg: AiConfig): Promise<JobMatchResult | null> {
  const raw = await callAi(cfg, MATCH_SYSTEM, `【候选人档案】\n${profileSummary.slice(0, 2500)}\n\n【岗位 JD】\n${jobText.slice(0, 4000)}`);
  const o = extractJsonObject(raw);
  if (!o) return null;
  const score = Math.max(0, Math.min(100, Math.round(Number(o.score) || 0)));
  return {
    score,
    highlights: String(o.highlights || ''),
    gaps: String(o.gaps || ''),
    advice: String(o.advice || ''),
  };
}

/** 无 Key 兜底：档案关键词在 JD 中的命中率粗评 */
export function keywordMatchScore(jd: string, profileSummary: string): JobMatchResult {
  const kw = Array.from(new Set(
    (profileSummary.match(/[\u4e00-\u9fa5A-Za-z]{2,12}/g) || [])
      .filter((w) => !['姓名', '政治面貌', '学历', '英语', '教育', '实习', '项目', '获奖证书', '技能', '自评'].includes(w)),
  ));
  const text = jd.toLowerCase();
  const hits = kw.filter((w) => text.includes(w.toLowerCase())).slice(0, 12);
  const score = kw.length ? Math.min(92, Math.round((hits.length / Math.max(20, kw.length * 0.35)) * 100)) : 0;
  return {
    score,
    highlights: hits.length ? `关键词命中：${hits.join('、')}` : '未命中明显关键词',
    gaps: '未配置 API Key，仅为关键词粗评，建议在设置中填入 Key 获取深度分析',
    advice: '可结合岗位 JD 人工复核匹配度',
  };
}

/* ================= 公司背景 ================= */
export interface CompanyInfo { industry: string; scale: string; hq: string; business: string; process: string; notes: string; }

const COMPANY_SYSTEM =
  '你是求职信息研究员。根据公司名称（及岗位）介绍该公司背景，供应届生投递参考。只输出一个 JSON 对象，不要解释：' +
  'industry(行业),scale(人员规模量级),hq(总部城市),business(主营业务与行业地位,150字内),process(招聘流程/考察特点,100字内),notes(投递注意事项,80字内)。' +
  /* 为什么要把「短」写成硬约束：industry/scale/hq 在界面上是**胶囊标签**，不是段落。
     只写「介绍该公司背景」时，模型会顺手把推测过程也塞进 hq，吐出
     「待核实（「XX」可能指……股份有限公司，总部位于北京）」这种 40+ 字的值，
     标签行会被撑到卡片外、盖住右边那张卡（线上发生过）。字段归位比事后截断靠谱。 */
  'industry/scale/hq 必须极短，只写结论、不写解释：industry 只写行业大类（≤12字，如「银行业」「证券业」），' +
  'scale 只写规模量级（≤14字，如「超大规模（全球员工数十万）」），hq 只写总部城市（≤8字，如「北京」）。' +
  '这三个字段里不要出现括号补充、不要出现「可能指」「位于」这类说明性文字——要解释就写进 business 或 notes。' +
  '信息不确定时写「待核实」，绝不编造具体数字或事实。';

export async function aiCompanyInfo(company: string, position: string, cfg: AiConfig): Promise<CompanyInfo | null> {
  const raw = await callAi(cfg, COMPANY_SYSTEM, `公司：${company}\n岗位：${position || '校园招聘'}`);
  const o = extractJsonObject(raw);
  if (!o) return null;
  const s = (k: string) => String(o[k] || '').trim();
  return { industry: s('industry'), scale: s('scale'), hq: s('hq'), business: s('business'), process: s('process'), notes: s('notes') };
}

/* ================= 通用写作助手（一键生成整段内容） ================= */
const WRITER_SYSTEM =
  '你是秋招求职写作助手。直接输出可用文本，不要任何解释、标题或引号包裹。中文输出，语言正式得体、真实可信，不编造经历。';

export async function aiAssist(instruction: string, context: string, cfg: AiConfig): Promise<string> {
  const out = await callAi(cfg, WRITER_SYSTEM, `【任务】${instruction}\n【背景资料（个人档案/现有内容，仅供参考）】\n${context.slice(0, 5000)}`, 60000);
  return out.trim();
}

/* ================= 题库参考答案 =================
 * 提示词里刻意写死「不要用 Markdown 装饰符号」：模型默认爱用 `**1. 小问**` 包标题，
 * 渲染层虽然也能认，但禁用之后行文更干净（编号就是编号，不必再加粗再套星号）。
 */
export async function aiAnswerQuestion(q: string, kind: 'written' | 'interview', cfg: AiConfig): Promise<string> {
  const sys = kind === 'interview'
    ? '你是资深面试教练。为面试题给出高质量参考回答。要求：第一人称；结论先行，再跟 2-3 个论据或具体例子；'
      + '分点写、每点独占一行；180-300 字；不复述题干，不写「这道题考察的是…」这类元话术；'
      + '不要使用 **、#、``` 等 Markdown 装饰符号；直接输出回答正文。'
    : '你是笔试辅导专家。为笔试题给出参考答案与简要解析。要求：题干含多个小问时逐问回答，'
      + '每问先单独一行写小问序号与问点（如「1、法律性质」），再另起一行以「答案：」开头给出结论，'
      + '紧接一行以「解析：」开头说明理由；小问之间空一行；不复述题干；'
      + '不要使用 **、#、``` 等 Markdown 装饰符号；直接输出正文。';
  const out = await callAi(cfg, sys, q.slice(0, 4000), 60000);
  return out.trim();
}

/* ================= 邮件代写 ================= */
export interface MailDraft { subject: string; body: string; }

export async function aiDraftMail(instruction: string, profileSummary: string, cfg: AiConfig): Promise<MailDraft | null> {
  const sys =
    '你是求职邮件代写助手。根据要求撰写邮件。只输出一个 JSON 对象，不要解释：subject(邮件主题),body(邮件正文，纯文本，得体专业，署名用档案中的姓名)。';
  const raw = await callAi(cfg, sys, `【写信要求】${instruction}\n【发件人档案】\n${profileSummary.slice(0, 2000)}`, 60000);
  const o = extractJsonObject(raw);
  if (!o) return null;
  return { subject: String(o.subject || '').trim(), body: String(o.body || '').trim() };
}
