export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

export const uid = (p = 'id') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const pad = (n: number) => String(n).padStart(2, '0');

/** Date <-> YYYY-MM-DD (local) */
export function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function fromISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export const todayISO = () => toISO(new Date());

export function fmtDate(s?: string): string {
  if (!s) return '';
  const d = new Date(s.length <= 10 ? fromISO(s) : s);
  if (isNaN(d.getTime())) return s;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}
export function fmtDateTime(s?: string): string {
  if (!s) return '';
  /* 纯日期串必须走 fromISO 按**本地**午夜解析：`new Date('2026-10-09')` 按 UTC 解析，
     在东八区会显示成 08:00（fmtDate 早已这么处理，这里原先漏了同一处）。 */
  const d = new Date(s.length <= 10 ? fromISO(s) : s);
  if (isNaN(d.getTime())) return s;
  return `${fmtDate(s)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function relTime(s?: string): string {
  if (!s) return '';
  const d = new Date(s).getTime();
  if (isNaN(d)) return '';
  const diff = Date.now() - d;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  return fmtDate(s);
}
/** 距离截止日期的天数（正=未来，负=已过） */
export function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  const t = fromISO(iso.slice(0, 10)).getTime();
  const now = fromISO(todayISO()).getTime();
  return Math.round((t - now) / 86400000);
}
export function deadlineLabel(iso?: string): { text: string; cls: string } {
  const d = daysUntil(iso);
  if (d === null) return { text: '无截止', cls: 'badge--muted' };
  if (d < 0) return { text: `已截止 ${-d} 天`, cls: 'badge--danger' };
  if (d === 0) return { text: '今天截止', cls: 'badge--danger' };
  if (d <= 3) return { text: `${d} 天后截止`, cls: 'badge--warn' };
  if (d <= 7) return { text: `${d} 天后截止`, cls: 'badge--info' };
  return { text: `${fmtDate(iso)} 截止`, cls: 'badge--muted' };
}

/* ---------- 单位名匹配 ----------
 * 同一条单位在不同地方写法常常不同：「中金公司」/「中国国际金融股份有限公司」、
 * 「招商银行」/「招商银行深圳分行」。投递记录与岗位库要能对上，否则状态同步、截止提醒都会漏。
 * 规则保守：先归一化（去空白标点、去组织形式后缀）→ 查常见简称别名 → 再允许「前缀 + 分支后缀」。 */
/**
 * 源表（秋招汇总表 / 日报）里的装饰与状态标记。
 * 这些字符会跟着「事项」「单位」单元格一起被导入，曾导致「吉林银行」与「吉林银行 🆕」
 * 被当成两家不同单位 → 每轮导入都新增一条重复岗位、多出一张重复公司卡。
 * 匹配与入库前必须先剥掉；岗位名里的 ①②③（多岗位并列编号）同理。
 */
const DECOR = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** 剥掉装饰标记（🆕⭐❗🔎✅①②③…）并压缩空白；只用于比对与入库清洗，不影响展示用原文 */
export function stripDecor(s?: string): string {
  return String(s || '').replace(DECOR, '').replace(/[\s\u3000]+/g, ' ').trim();
}

/** 去掉成对/未闭合的括号注解：单位名括号里多是简称与批次说明（「北京仲裁委员会（北仲 BAC/BIAC）」、
 *  「广发银行（国寿系）」「中国石油（多家子公司）」），不剥掉就会被当成另一家单位 → 裂成重复公司卡。 */
function dropParens(s: string): string {
  return String(s || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[（(][^）)]*$/, '');
}

/**
 * 简称 → 全称（**全局替换**，不是等值映射）。
 *
 * 为什么需要独立于 COMPANY_ALIAS：那张表是「归一化后的整串 → 代号」的等值映射，
 * 只能处理整名就是简称的情况。而汇总表里常见的是**简称嵌在复合名里**
 * （「北交所 + 全国股转公司」「中证股转科技（北交所技术子公司）」），
 * 整串不等于任何别名键，于是「北交所 + 全国股转公司」与投递记录里的
 * 「北京证券交易所 + 全国股转公司」被判成两家单位——岗位卡不同步、截止提醒也停不下来。
 * 键按长度降序替换，避免短键先吃掉长键的前缀。
 */
const ALIAS_EXPAND: Record<string, string> = {
  北交所: '北京证券交易所',
  上交所: '上海证券交易所',
  深交所: '深圳证券交易所',
  中金所: '中国金融期货交易所',
  上期所: '上海期货交易所',
  郑商所: '郑州商品交易所',
  大商所: '大连商品交易所',
  广期所: '广州期货交易所',
  中证登: '中国结算',
  中债登: '中央结算公司',
  上清所: '银行间市场清算所',
  贸仲: '中国国际经济贸易仲裁委员会',
  北仲: '北京仲裁委员会',
  深国仲: '深圳国际仲裁院',
  国网: '国家电网',
  中投公司: '中国投资有限责任公司',
  外汇交易中心: '中国外汇交易中心',
  证金公司: '中国证券金融',
  中证金融: '中国证券金融',
  中证投服: '中证中小投资者服务中心',
};
const ALIAS_KEYS = Object.keys(ALIAS_EXPAND).sort((a, b) => b.length - a.length);

function expandAlias(s: string): string {
  let out = s;
  for (const k of ALIAS_KEYS) if (out.includes(k)) out = out.split(k).join(ALIAS_EXPAND[k]);
  return out;
}

const coCache = new Map<string, string>();
export function normCompany(s?: string): string {
  const raw = String(s || '');
  const hit = coCache.get(raw);
  if (hit !== undefined) return hit;
  const v = expandAlias(stripDecor(dropParens(raw))
    .replace(/[\s\u3000()（）【】\[\]{}·、,，.。/\\\-+＋&＆]/g, ''))
    .replace(/(股份有限公司|有限责任公司|有限公司|集团有限公司|控股集团|集团|公司)$/g, '');
  if (coCache.size < 4000) coCache.set(raw, v);   // 去重是 O(n²) 比对，缓存归一化结果
  return v;
}

/** 秋招高频单位的简称 ↔ 全称 */
const COMPANY_ALIAS: Record<string, string> = {
  中国国际金融: '中金', 中金: '中金',
  国家开发银行: '国开行', 国开行: '国开行', 开发银行: '国开行',
  中国工商银行: '工行', 工商银行: '工行', 工行: '工行',
  中国农业银行: '农行', 农业银行: '农行', 农行: '农行',
  中国建设银行: '建行', 建设银行: '建行', 建行: '建行',
  中国银行: '中行', 中行: '中行',
  交通银行: '交行', 交行: '交行',
  中国邮政储蓄银行: '邮储', 邮政储蓄银行: '邮储', 邮储银行: '邮储', 邮储: '邮储',
  中国烟草: '中烟', 烟草专卖局: '中烟', 中烟: '中烟',
  国家电网: '国网', 国网: '国网',
  东方资产: '中国东方资产', 中国东方资产管理: '中国东方资产', 东方资管: '中国东方资产',
  信达资产: '中国信达', 中国信达资产管理: '中国信达', 信达: '中国信达',
  长城资产: '中国长城资产', 中国长城资产管理: '中国长城资产',
  华融资产: '中国华融', 中国华融资产管理: '中国华融', 华融: '中国华融',
};

/** 「XX银行深圳分行」这类分支：前缀相同 + 余下部分是分支后缀，视为同一家单位 */
const BRANCH_TAIL = /(分行|支行|分公司|子公司|分行营业部|营业部|办事处|研究所|研究院|事业部|中心|局|院|厂|矿|省公司|市公司)$/;

/** 两条记录是否指同一家单位 */
export function sameCompany(a?: string, b?: string): boolean {
  const x = normCompany(a), y = normCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const ax = COMPANY_ALIAS[x] || x, ay = COMPANY_ALIAS[y] || y;
  if (ax === ay) return true;
  const [short, long] = ax.length <= ay.length ? [ax, ay] : [ay, ax];
  return short.length >= 2 && long.startsWith(short) && BRANCH_TAIL.test(long.slice(short.length));
}

/** 归一后的单位键（含简称别名）：用于「同一单位同一天」的分组与去重，比 sameCompany 略弱（不含分行前缀判断） */
export function companyKey(s?: string): string {
  const n = normCompany(s);
  return COMPANY_ALIAS[n] || n;
}

/** 机构类型后缀：用于剥出「单位主干」，认「深圳国际仲裁院 SCIA」=「深圳国际仲裁委员会」这类同义写法 */
const ORG_TAIL = /(委员会|仲裁委员会|仲裁院|仲裁委|研究院|研究所|管理局|总局|分行|支行|分公司|子公司|营业部|办事处|大学|学院|医院|证券|基金|保险|资管|集团|公司|中心|协会|学会|基金会|院|局|部|厅|署|社|台|站|厂|矿)$/g;

/**
 * 剥类型词前需要「原样保留」的归一化键。
 *
 * 为什么需要：ORG_TAIL 会把「证券/集团/局」这类**同集团下属不同法人**的类型词一并剥掉，
 * 导致本该互相独立的单位撞成同一个键（键相同 → `buildJobDraftsFromDoc` 先到先得，后一条被整条丢弃）：
 *   · 「招商证券」 → 剥「证券」 → `招商`
 *   · 「招商局集团」 → 先剥「集团」 → `招商局`，再剥「局」 → `招商`   ← 两者撞键
 * 所以把它们放进本表，命中即直接返回，不参与 ORG_TAIL 剥离。
 * 新增逻辑时请只放「确实必须与集团/同名主体区分」的法人名，不要图省事往里堆。
 */
const STEM_KEEP = new Set<string>(['招商证券', '招商局', '招商局集团']);

/** 去掉机构类型词后的单位主干（剥完太短则退回原值）。
 *  先剥结尾的拉丁缩写（SCIA / SHIAC / CIETAC / CIPS …），否则「深圳国际仲裁院 SCIA」
 *  的主干会带上 SCIA 而与「深圳国际仲裁委员会」对不上。 */
export function companyStem(s?: string): string {
  const key = companyKey(s).replace(/[A-Za-z]{2,}$/, '');
  if (STEM_KEEP.has(key)) return key;
  const stem = key.replace(ORG_TAIL, '');
  return stem.length >= 2 ? stem : key;
}

/**
 * 状态联动用的单位匹配：sameCompany 之外，再认**主干完全相等**。
 * 比 sameCompanyLoose 严——loose 用的是「主干互相包含」，会把「中国银行」与「中国银行保险」
 * 判成同一家；这里要求主干严格相等，所以「深圳国际仲裁委员会」=「深圳国际仲裁院 SCIA」
 * （主干都是「深圳国际仲裁」）能对上，而「中国银行」≠「中国银行保险」。
 */
export function sameCompanyStem(a?: string, b?: string): boolean {
  if (sameCompany(a, b)) return true;
  const x = companyStem(a), y = companyStem(b);
  return !!x && x === y && x.length >= 4;
}

/** 更宽松的同单位判断：sameCompany 之外再认「主干相等/互相包含」——只用于提醒聚合与去重，不用于删除数据 */
export function sameCompanyLoose(a?: string, b?: string): boolean {
  if (sameCompany(a, b)) return true;
  const x = companyStem(a), y = companyStem(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
}

/** 标题（如「截止 · 中国东方资产 · 2027 校招 · 日程」）里是否提到某家单位：按前缀逐级放宽比对。
 *
 *  **前缀放宽的下限必须 ≥3 字**：原先下限是 `c.length - 4`，6 字单位会一路放宽到 2 字，
 *  于是「中国东方资产」的前缀「中国」命中了「中国联通」的标题——已投递单位的事件被错误吞掉。
 *  下限设 3 后，「深圳国际仲裁委员会」（主干「深圳国际」）这类仍需前缀匹配的场景不受影响。 */
export function mentionsCompany(title: string, company?: string): boolean {
  const t = companyKey(title);
  if (!t) return false;
  const punctOnly = expandAlias(stripDecor(String(company || ''))).replace(/[\s\u3000()（）【】\[\]{}·、,，.。/\\\-+＋&＆]/g, '');   // 不去后缀的兜底写法
  for (const c of [companyKey(company), companyStem(company), punctOnly]) {
    if (!c || c.length < 2) continue;
    const floor = Math.max(c.length - 3, 3);
    for (let len = c.length; len >= floor; len--) {
      if (t.includes(c.slice(0, len))) return true;
    }
  }
  return false;
}

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  todo:      { label: '待投递', cls: 'st-todo' },
  filling:   { label: '填写中', cls: 'st-filling' },
  submitted: { label: '已提交', cls: 'st-submitted' },
  test:      { label: '笔试', cls: 'st-test' },
  interview: { label: '面试', cls: 'st-interview' },
  offer:     { label: 'Offer', cls: 'st-offer' },
  reject:    { label: '未通过', cls: 'st-reject' },
};
export const STATUS_ORDER = ['todo', 'filling', 'submitted', 'test', 'interview', 'offer', 'reject'] as const;

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallthrough */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function initials(name: string): string {
  const t = (name || '').trim();
  if (!t) return '?';
  // Chinese: last 1-2 chars; Latin: first letters
  if (/[\u4e00-\u9fa5]/.test(t)) return t.slice(-2);
  return t.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

export function download(filename: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 下载二进制 Blob（用于 docx 等由库生成的文件） */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 把「AI 生成的自然语言」压成能塞进胶囊标签的一句话。
 *
 * 存在的理由：industry / scale / hq 这些字段是**标签**，但 AI 返回的是自由文本，
 * 长度完全不可控。实测 hq 会吐出
 *   待核实（「东方资管」可能指中国东方资产管理股份有限公司，总部位于北京）
 * 这种 40+ 字的值；.badge 是 white-space:nowrap 的胶囊，它会一路撑到卡片外，
 * 直接把右边那张卡的文字盖住 —— 线上「文字重叠」事故的根因。
 *
 * 规则：短值原样返回；超长值只取「括号 / 逗号 / 冒号之前的主干」，主干仍超长才截断加省略号。
 * 主干（如「待核实」）本身就是这个字段想表达的全部意思，多出来的都是解释性补充；
 * 完整原文请调用方挂到 title 上，信息不丢。
 */
export const TAG_MAX = 16;
export function tagText(v: string, max = TAG_MAX): string {
  const s = (v || '').trim();
  if (s.length <= max) return s;
  const head = (s.split(/[（(，,。；;、:：]/)[0] || s).trim();
  /* 主干本身够短就直接用主干（「待核实（…）」→「待核实」），不加省略号 ——
     省略号会让人以为后面还有没显示完的话，而这里多出来的其实全是补充说明。 */
  return head.length <= max ? head : head.slice(0, max) + '…';
}
