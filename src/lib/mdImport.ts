/**
 * 招聘信息「Markdown → 结构化数据」导入。
 *
 * 为什么需要：你每天在日报/汇总文档里维护的「截止日历」本身就是规整的 Markdown 表格，
 * 手工再录入一遍纯属浪费。此模块把表格（或带日期的列表行）解析成岗位与日历事件，
 * 并按「单位 + 事项」去重合并 —— 同一单位不同批次（如非技术类 9/20、技术类 9/30）
 * 会各自成条，同日重复推送只更新不重复。
 */
import type { JobPosting, CalEvent, JobTrack, JobMatch } from '../types';
import { stripDecor, companyStem } from './util';
import { checkAdmission, type RejectedRow } from './trackRules';
import { scoreOpportunity } from './scoreRules';

export interface ImportRow {
  deadline?: string;     // YYYY-MM-DD
  company: string;
  title: string;
  url?: string;
  remain?: string;
  note?: string;
  raw: string;
}

export interface ParseResult {
  rows: ImportRow[];
  skipped: string[];     // 无法解析日期的行（原文保留，供人工确认）
  headerFound: boolean;
  tableCount: number;
}

const COL_KEYS: Record<string, string[]> = {
  deadline: ['截止', 'deadline', '期限', '截止日'],
  company: ['单位', '公司', '机构', '企业', '部门'],
  title: ['事项', '岗位', '职位', '内容', '招聘', '项目'],
  url: ['入口', '链接', '网址', '官网', 'url', '报名'],
  remain: ['剩余', '倒计时', '还有'],
  note: ['备注', '说明', '要求', 'hard', '硬性'],
};

const clean = (s: string) => String(s || '')
  .replace(/\*\*/g, '')
  .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
  .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}
const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));

/** 把「9/15（二）」「9月15日」「2026-09-15」「9/15 24:00」等统一成 YYYY-MM-DD（推断年份） */
export function normalizeDate(input: string): string | undefined {
  const s = clean(input);
  if (!s) return undefined;
  if (/[中下上]旬|待定|未发布|另行通知|预计|TBD/i.test(s) && !/\d{1,2}\s*[/月.-]\s*\d{1,2}/.test(s)) return undefined;

  let y: number | undefined; let mo = 0; let d = 0;
  let m = s.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  if (!y) {
    m = s.match(/(\d{1,2})\s*[/月.-]\s*(\d{1,2})/);
    if (m) { mo = +m[1]; d = +m[2]; }
  }
  if (!mo || !d || mo > 12 || d > 31) return undefined;

  const today = new Date();
  const year = y ?? today.getFullYear();
  let dt = new Date(year, mo - 1, d);
  // 没写年份且已过去 90 天以上 → 认为是明年的同一天（秋招跨年）
  if (!y) {
    const diffDays = (dt.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000;
    if (diffDays < -90) dt = new Date(year + 1, mo - 1, d);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function mapColumns(header: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  header.forEach((h, i) => {
    const t = clean(h).toLowerCase();
    for (const [key, words] of Object.entries(COL_KEYS)) {
      if (out[key] !== undefined) continue;
      if (words.some((w) => t.includes(w.toLowerCase()))) { out[key] = i; break; }
    }
  });
  return out;
}

/** 机器自动抓取的区块标题（scripts/qz-auto-collect.mjs 写入） */
const AUTO_MARK = '## 🤖 自动抓取岗位';

/**
 * 摘掉「## 🤖 自动抓取岗位」整段。
 *
 * 这一段是 scripts/qz-auto-collect.mjs 按关键词搜出来的原始线索（常含知乎/聚合站/公告转载，
 * 单位名也未必干净），留在文件里当线索可以，但直接进岗位库会把列表搅乱。
 * 导入弹窗默认跳过它，需要时取消勾选即可收进来。
 */
export function stripAutoCollected(text: string): { text: string; removedLines: number; found: boolean } {
  const i = text.indexOf(AUTO_MARK);
  if (i < 0) return { text, removedLines: 0, found: false };
  const rest = text.slice(i + AUTO_MARK.length);
  const m = rest.match(/\n## /);
  const end = m && m.index !== undefined ? i + AUTO_MARK.length + m.index : text.length;
  const cut = text.slice(i, end);
  return { text: text.slice(0, i) + text.slice(end), removedLines: cut.split('\n').length, found: true };
}

/** 解析 Markdown 文本中的截止信息（表格优先，其次「日期开头的列表行」） */
export function parseMarkdownDeadlines(text: string): ParseResult {
  const lines = String(text || '').split(/\r?\n/);
  const rows: ImportRow[] = [];
  const skipped: string[] = [];
  let headerFound = false;
  let tableCount = 0;

  // ---- 1) 表格 ----
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const block: string[] = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) { block.push(lines[i]); i++; }
    i--;
    if (block.length < 2) continue;
    const header = splitRow(block[0]);
    if (isSeparator(splitRow(block[1]))) {
      tableCount++;
      const cols = mapColumns(header);
      if (cols.deadline === undefined) continue;
      headerFound = true;
      for (const line of block.slice(2)) {
        const cells = splitRow(line);
        if (isSeparator(cells)) continue;
        const rawLine = line.trim();
        const deadline = normalizeDate(cells[cols.deadline] || '');
        const company = clean(cols.company !== undefined ? cells[cols.company] : '') || clean(cells[1] || '');
        const title = clean(cols.title !== undefined ? cells[cols.title] : '') || '招聘';
        if (!deadline) { if (rawLine) skipped.push(rawLine); continue; }
        rows.push({
          deadline, company: company || '未标注单位', title,
          url: cols.url !== undefined ? clean(cells[cols.url]) : undefined,
          remain: cols.remain !== undefined ? clean(cells[cols.remain]) : undefined,
          note: cols.note !== undefined ? clean(cells[cols.note]) : undefined,
          raw: rawLine,
        });
      }
    }
  }

  // ---- 2) 「- 9/15 某某单位 …」这类列表行 ----
  for (const line of lines) {
    if (!/^\s*(?:[-*+]|\d+[.、)])\s+/.test(line)) continue;
    const body = clean(line.replace(/^\s*(?:[-*+]|\d+[.、)])\s+/, ''));
    const deadline = normalizeDate(body);
    if (!deadline) continue;
    /* 排除「待办 / 准备清单」类行：带【】重点标记，或含动作词——这些是行动项不是岗位 */
    if (/[【】]/.test(line) || /打包|发走|蹲守|准备清单|待办|提醒|优先|跟进|核实|材料|截止/.test(body)) {
      skipped.push(line.trim());
      continue;
    }
    if (rows.some((r) => r.raw.replace(/\s/g, '') === line.trim().replace(/\s/g, ''))) continue;
    const rest = body.replace(/^(20\d{2}\s*[-/年.]\s*)?\d{1,2}\s*[/月.-]\s*\d{1,2}\s*日?[（(]?[一二三四五六日天]?[）)]?/, '').replace(/^[：:，,、\s]+/, '');
    if (rest.length < 2) continue;
    const seg = rest.split(/[|｜，,；;]/).map((x) => x.trim()).filter(Boolean);
    rows.push({
      deadline,
      company: seg[0] || '未标注单位',
      title: seg[1] || '招聘',
      note: seg.slice(2).join('；') || undefined,
      raw: line.trim(),
    });
  }

  return { rows, skipped: Array.from(new Set(skipped)).slice(0, 50), headerFound, tableCount };
}

/* ================= 招聘线（三条线分开管理） ================= */
export const TRACK_META: Record<JobTrack, { label: string; short: string; cls: string; icon: string; desc: string }> = {
  soe: { label: '国央企校招', short: '国央企', cls: 'badge--info', icon: 'building', desc: '银行 / 央企 / 国企 / 交易所等校招' },
  civil: { label: '公务员选调', short: '公考选调', cls: 'badge--accent', icon: 'award', desc: '国考省考 / 定向选调 / 事业单位' },
  private: { label: '民营企业及其他', short: '民营', cls: 'badge--muted', icon: 'target', desc: '律所 / 券商 / 外企 / 仲裁机构等' },
};

const CIVIL_KW = ['选调', '公务员', '国考', '省考', '市考', '区考', '遴选', '人才引进', '事业单位', '事业编', '参公', '组织部', '党校', '储备人才', '党政'];
const SOE_KW = ['银行', '集团', '央企', '国企', '国资', '中核', '中石油', '中国石油', '中石化', '中国石化', '中海油', '中国海油', '石油', '石化', '天然气',
  '国家电网', '南方电网', '中国移动', '中国联通', '中国电信', '航空', '航天', '兵器', '船舶', '铁路', '国铁', '矿业', '煤业',
  '中国人寿', '中国人保', '国寿', '人保', '中广核', '中国核电', '国家能源', '华能', '大唐', '华电', '三峡', '中船', '中车', '中建', '中铁', '中粮',
  '中储粮', '中远海运', '招商局', '保利', '中化', '中国有色', '中国国新', '国投', '中信', '东方资产', '信达', '长城资产', '中国邮政', '南方航空',
  '中国国航', '交易所', '股转', '北交所', '上交所', '深交所', '期货交易所', '中证', '金融资产', '再保险', '烟草'];

/** 按单位与岗位名猜招聘线；猜不准一律落到「民营企业及其他」，由用户手动调整 */
export function inferTrack(company: string, title = ''): JobTrack {
  /* 「投资银行 / 投行」是券商的业务线名，不是银行机构名。先摘掉再匹配，
     否则会被 SOE_KW 里的「银行」命中，把中金/华泰/申万这类券商误判成「国央企」，
     同一个投行板块里各家被拆到不同招聘线。 */
  const t = `${company} ${title}`.replace(/投资银行|投行/g, '');
  if (CIVIL_KW.some((k) => t.includes(k))) return 'civil';
  if (SOE_KW.some((k) => t.includes(k))) return 'soe';
  return 'private';
}

/** 同一「单位 + 事项」视为同一条岗位，重复推送只更新不堆积 */
export const jobKey = (company: string, title: string) => `${(company || '').trim()}::${(title || '').trim()}`;

/* ---------------- 「事项」列到底是不是一个岗位 ----------------
 * 汇总表的「事项」列同时承担两种角色：**岗位名** 与 **时间/批次备注**。
 * 后者的例子：「至 24:00」「参照上年 10-11 月」「行测 120 分钟 + 申论 150 分钟」
 * 「全行总口径（部分分行传 9/30，）」「北京西城」。原先一律当作岗位入库，
 * 岗位库里就多出二十多条看不懂的「岗位」。
 * 现在的策略：**时间/批次信息只进日历，岗位库不收**（日历事件仍带着截止日，信息不丢）。
 */

/** 强备注：命中即判定为「不是岗位」，即使里面出现了「校招/岗」等字样。
 *  例如「2027 校招网申窗口」「下属机构岗截止」——它们描述的是时间窗口，不是岗位本身。 */
const HARD_NOTE: RegExp[] = [
  /^(至|到)\s*\d/,
  /^\d{1,2}:\d{2}/,
  /^(行测|申论|综合能力测试)/,
  /^(报名|网申)/,
  /^参照(上年|往年|去年)/,
  /^全行(总)?口径/,
  /^(总部|下属机构|分公司|总行|集团|各省市)(岗|职位|类)/,   // 「总部岗至 10/15」这类批次说明
  /^本部(几乎|基本)/,
  /(截止|开闸|窗口|参照上年|预估)$/,
];

/** 岗位语义关键词：出现即认为这条是岗位（避免把「含法律合规岗」「13 类岗含法律与运营管理类」这类真岗位误降级） */
const POSITION_KW = /(校招|秋招|春招|社招|招聘|岗位|职位|管培|实习|秘书|顾问|律师|法务|经理|专员|助理|工程师|研究员|研究岗|分析师|业务|客户|技术|人才|序列|方向|项目|培训生|储备|类岗|人员)/;

/** 弱备注：只有在**没有**岗位语义关键词时才判定为备注 */
const SOFT_NOTE: RegExp[] = [
  /^[\u4e00-\u9fa5]{2,6}(东|西|南|北|城|区|市|省)$/,     // 纯地址（「北京西城」「全集团各省市」）
  /^\d+\s*(个|类)?(岗位|岗)/,
];

/** 这是一条备注/时间信息而非岗位时，返回原因；是岗位则返回 null */
export function nonPositionReason(title: string): string | null {
  const t = stripDecor(String(title || '')).trim();
  if (!t) return '空事项';
  for (const re of HARD_NOTE) if (re.test(t)) return '时间/批次说明';
  if (POSITION_KW.test(t)) return null;
  for (const re of SOFT_NOTE) if (re.test(t)) return '地址/数量说明';
  return null;   // 拿不准一律当岗位，宁可多留也不静默丢弃
}

export function buildJobDrafts(rows: ImportRow[]): Partial<JobPosting>[] {
  const seen = new Set<string>();
  const out: Partial<JobPosting>[] = [];
  for (const r of rows) {
    if (nonPositionReason(r.title)) continue;      // 备注行不进岗位库，由 buildEventDrafts 进日历
    const key = jobKey(r.company, r.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      company: stripDecor(r.company),
      title: stripDecor(r.title),
      deadline: r.deadline,
      url: r.url && /^https?:\/\//i.test(r.url) ? r.url : undefined,
      source: '导入',
      track: inferTrack(r.company, r.title),
      requirements: r.note,
      jd: r.raw,
      status: 'new',
    });
  }
  return out;
}

/** 被降级为「只进日历、不进岗位库」的备注行（供导入页展示，避免用户以为数据丢了） */
export function noteOnlyRows(rows: ImportRow[]): { company: string; title: string; deadline: string; why: string }[] {
  const out: { company: string; title: string; deadline: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const why = nonPositionReason(r.title);
    if (!why) continue;
    const k = jobKey(r.company, r.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ company: stripDecor(r.company), title: stripDecor(r.title), deadline: r.deadline || '', why });
  }
  return out;
}

export function buildEventDrafts(rows: ImportRow[]): Partial<CalEvent>[] {
  const seen = new Set<string>();
  const out: Partial<CalEvent>[] = [];
  for (const r of rows) {
    const key = jobKey(r.company, r.title) + '::' + r.deadline;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: `截止 · ${r.company}${r.title && r.title !== '招聘' ? ' · ' + r.title : ''}`,
      date: r.deadline!,
      type: 'deadline',
      note: [r.remain, r.note].filter(Boolean).join(' · ') || undefined,
      source: 'import',
    });
  }
  return out;
}

/* ================= 明细表解析（岗位方向 / 招聘要求 / 笔试内容 / 入口链接） =================
 * 汇总文件里有两类表格：
 *   ① 截止日历表  | 截止日 | 剩余 | 单位 | 事项 | 入口 |
 *   ② 单位明细表  | 银行 | 对象 | 岗位方向与地点 | 网申期 | 入口 | 硬性要求 | 笔试 |
 * 之前只解析了 ①，于是「只有时间、没有要求与考试内容」；这里补上 ②，并让两者按单位合并。
 */
export interface DetailRow {
  company: string;
  direction?: string;      // 岗位方向与地点（岗位情况）
  requirement?: string;    // 硬性要求（招聘要求）
  exam?: string;           // 笔试 / 考试内容
  period?: string;         // 网申期原文
  url?: string;            // 入口
  target?: string;         // 对象 / 批次
  note?: string;           // 流程 / 要点
}

const DETAIL_COLS: [string, string[]][] = [
  ['company', ['单位', '银行', '机构', '公司', '企业', '集团', '名称']],
  ['direction', ['岗位方向与地点', '岗位/地点', '岗位方向', '岗位', '职位', '方向']],
  ['period', ['网申期', '网申时间', '时间线', '报名时间', '投递时间']],
  ['url', ['入口', '报名方式', '链接', '网址', '官网']],
  ['requirement', ['硬性要求', '门槛/流程', '门槛', '要求', '条件']],
  ['exam', ['笔试', '考试', '测评', '考核']],
  ['target', ['对象', '批次', '状态', '面向']],
  ['note', ['要点', '流程', '备注', '说明']],
];

/** 去掉加粗、表情、状态符号，得到干净的单位名 */
export function cleanCompany(s: string): string {
  return clean(s)
    .replace(/[⭐❗🔎✅🆕⏳☆★]/g, '')
    .replace(/^↳\s*/, '')
    .replace(/^[\s·•]+|[\s·•]+$/g, '')
    .trim();
}

/** 裸域名补全为可点击链接；邮箱返回 undefined（邮箱属于联系方式而非链接） */
export function normalizeUrl(raw?: string): string | undefined {
  let s = (raw || '').trim().replace(/[\s，,；;]+$/, '');
  if (!s || s === '—' || s === '-') return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.includes('@')) return undefined;
  if (/^[\w-]+(\.[\w-]+)+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return 'https://' + s;
  return undefined;
}

function mapDetailColumns(header: string[]): Record<string, number> {
  const flat = DETAIL_COLS.flatMap(([k, ws]) => ws.map((w) => [k, w] as [string, string]))
    .sort((a, b) => b[1].length - a[1].length);   // 长关键词优先，避免「岗位」抢占「岗位/地点」
  const out: Record<string, number> = {};
  header.forEach((h, i) => {
    const t = clean(h);
    for (const [key, word] of flat) {
      if (out[key] !== undefined) continue;
      if (t.includes(word)) { out[key] = i; break; }
    }
  });
  return out;
}

/** 解析所有「单位明细表」 */
export function parseMarkdownDetails(text: string): { details: DetailRow[]; tables: number } {
  const lines = String(text || '').split(/\r?\n/);
  const details: DetailRow[] = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const block: string[] = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) { block.push(lines[i]); i++; }
    i--;
    if (block.length < 3) continue;
    const header = splitRow(block[0]);
    if (!isSeparator(splitRow(block[1]))) continue;
    const cols = mapDetailColumns(header);
    // 只认「明细表」：必须能定位单位，且带岗位方向/要求/笔试/网申期之一
    if (cols.company === undefined) continue;
    if (cols.direction === undefined && cols.requirement === undefined
        && cols.exam === undefined && cols.period === undefined) continue;
    tables++;
    let lastCompany = '';
    for (const line of block.slice(2)) {
      const cells = splitRow(line);
      if (isSeparator(cells)) continue;
      const get = (k: string) => (cols[k] !== undefined ? clean(cells[cols[k]] || '') : '');
      let company = cleanCompany(get('company'));
      if (!company || company === '—') company = lastCompany;   // 「↳ 工行总行本部」这类承接上一行
      if (!company) continue;
      lastCompany = company;
      // 很多表的笔试信息写在「时间线 / 门槛 / 流程」列里（如「网申 9/12-10/10 → 笔试 11 月上旬」），
      // 单独成列时直接取，否则从其它列里捞出含笔试/考试/测评的片段
      let exam = get('exam') || undefined;
      if (!exam) {
        for (const cell of [get('period'), get('requirement'), get('note'), get('target')]) {
          const seg = clean(cell).split(/[；;。]/).find((x) => /笔试|考试|测评|机考|笔测/.test(x));
          if (seg) { exam = seg.trim(); break; }
        }
      }
      const row: DetailRow = {
        company,
        direction: get('direction') || undefined,
        requirement: get('requirement') || undefined,
        exam,
        period: get('period') || undefined,
        url: get('url') || undefined,
        target: get('target') || undefined,
        note: get('note') || undefined,
      };
      if (!row.direction && !row.requirement && !row.exam && !row.period) continue;
      details.push(row);
    }
  }
  return { details, tables };
}

/** 「9/3 - 10/9 24:00」这类网申期取结束日期 */
export function periodEnd(period?: string): string | undefined {
  if (!period) return undefined;
  const parts = clean(period).split(/[-–~至]/).map((x) => x.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || period;
  return normalizeDate(last) || normalizeDate(period);
}

/** 公司名归一化：用于把「截止日历」与「明细表」的同一条合并。
 *
 *  口径与全站「同一家单位」保持一致（`util.companyStem`：剥装饰标记、括号注解、简称别名、机构类型词）。
 *  旧实现是 `.replace(/[\u4e00-\u9fa5]{0,2}(银行|集团|公司|总行)$/g,'').slice(0,8)`，
 *  `{0,2}` 会连吃单位名末尾两个汉字再截前 8 字，于是：
 *    · 「国家开发银行」与「国家能源集团」都归成「国家」；
 *    · 中国人寿/中国广核/中国电信/中国黄金/中国有色/中国兵器/中国邮政 等集团都归成「中国」；
 *    · 中国工商银行 / 中国农业银行 / 中国建设银行 / 中国民生银行 … 全部归成「中国」，「中国银行」等归成空串。
 *  撞键的后果不是合并而是**整家单位消失**：`byKey.has(key) → continue` 直接跳过后续单位，
 *  且先到的单位会被后到单位用 `hit.deadline = r.deadline` 覆盖截止日。 */
function companyKey(s: string): string {
  return companyStem(s) || cleanCompany(s).replace(/[\s（）()\[\]【】]/g, '');
}

function titleFromDirection(direction?: string): string {
  if (!direction) return '2027 校招';
  const head = clean(direction).split(/[、；;，,]/)[0].replace(/^[*\s]+/, '');
  return head.length >= 3 && head.length <= 18 ? head : '2027 校招';
}

export interface NoteRow { company: string; title: string; deadline: string; why: string }

/**
 * 综合两种表格生成岗位草稿：以单位为主键合并。
 * 明细表提供「岗位方向 / 要求 / 笔试 / 入口 / 网申期」，截止日历表提供更准的「截止日」与多条批次。
 *
 * 返回 `notes`：截止日历表里那些**只是时间/批次备注**、且明细表也没有对应单位可补全的行
 * （如「至 24:00」「参照上年 10-11 月」）。它们不进岗位库，但仍会由 `buildEventDrafts`
 * 写成日历事件，所以截止信息不会丢——导入页会把这些行如实列出来。
 */
export function buildJobDraftsFromDoc(doc: { rows: ImportRow[]; details: DetailRow[] }): { drafts: Partial<JobPosting>[]; notes: NoteRow[]; rejected: RejectedRow[] } {
  const byKey = new Map<string, Partial<JobPosting>>();
  const notes: NoteRow[] = [];
  const seenNote = new Set<string>();

  /* 准入判定（口径见 lib/trackRules.ts）。被拒的不是「丢弃」而是搬到 `rejected`，
     由导入页与自动同步的提示如实列出 —— 静默丢信息比多留几条更危险。 */
  const rejected: RejectedRow[] = [];
  const rejectedKeys = new Set<string>();
  const judge = (company: string, title: string, detail: string): boolean => {
    const r = checkAdmission({ company, title, detail, track: inferTrack(company, title) });
    if (r.allowed) return true;
    const k = companyKey(company) || company;
    if (!rejectedKeys.has(k)) {
      rejectedKeys.add(k);
      rejected.push({ company: stripDecor(company), title: stripDecor(title) || '2027 校招', reason: r.reason!, label: r.label! });
    }
    return false;
  };

  for (const d of doc.details) {
    const key = companyKey(d.company);
    if (!key || byKey.has(key)) continue;
    if (!judge(d.company, d.direction || '', [d.note, d.requirement, d.exam].filter(Boolean).join(' '))) continue;
    const jd = [
      d.target && `对象：${d.target}`,
      d.direction && `岗位方向与地点：${d.direction}`,
      d.period && `网申期：${d.period}`,
      d.exam && `笔试/考试：${d.exam}`,
      d.note && `流程/要点：${d.note}`,
    ].filter(Boolean).join('\n');
    byKey.set(key, {
      company: stripDecor(d.company),
      title: stripDecor(titleFromDirection(d.direction)),
      deadline: periodEnd(d.period),
      url: normalizeUrl(d.url),
      requirements: d.requirement,
      exam: d.exam,
      jd: jd || undefined,
      source: '导入',
      status: 'new',
      track: inferTrack(d.company, d.direction || ''),
    });
  }

  for (const r of doc.rows) {
    for (const rawPart of r.company.split(/\s*\/\s*/)) {
      const part = stripDecor(rawPart).trim();
      if (part.length < 2) continue;
      const key = companyKey(part);
      if (key && rejectedKeys.has(key)) continue;   // 该单位已在准入阶段被拒，截止日历行也不再建岗
      const hit = key ? byKey.get(key) : undefined;
      if (hit) {
        if (r.deadline) hit.deadline = r.deadline;             // 日历表的截止日更精确
        hit.url = hit.url || normalizeUrl(r.url);
        if (!hit.jd) hit.jd = r.raw;
        continue;
      }
      const title = stripDecor(clean(r.title)) || '2027 校招';
      /* 「事项」列写的是时间/批次备注而非岗位时：只进日历，不进岗位库 */
      const why = nonPositionReason(title);
      if (why) {
        const nk = jobKey(part, title);
        if (!seenNote.has(nk)) { seenNote.add(nk); notes.push({ company: part, title, deadline: r.deadline || '', why }); }
        continue;
      }
      if (!judge(part, r.title, r.raw)) continue;              // 准入判定
      const k2 = key || part;
      if (byKey.has(k2)) continue;
      byKey.set(k2, {
        company: part,
        title,
        deadline: r.deadline,
        url: normalizeUrl(r.url),
        jd: r.raw,
        source: '导入',
        status: 'new',
        track: inferTrack(part, r.title),
      });
    }
  }
  /* 价值评分（口径见 lib/scoreRules.ts）。
     必须放在**两条表格合并完成之后**：明细表带来的「岗位方向 / 要求」与
     截止日历表带来的精确「截止日」是分两轮汇到同一条上的，
     提前算会拿到半条数据（评分里岗位与紧迫度两项都会偏低）。 */
  for (const d of byKey.values()) d.match = ruleMatch(d);

  return { drafts: Array.from(byKey.values()), notes, rejected };
}

/**
 * 规则评分 → `JobMatch`。
 *
 * `by: 'rule'` 让 UI 能区分「导入时自动算的」与「用户手动点评估算的」——
 * 后者代表更晚、信息更全的判断，覆盖前者是应当的。
 * 这也是本项目第一次让岗位库**不依赖 JD 文本**就有分数：
 * 北大就业网的公告绝大多数没有 JD，此前只能靠用户逐条点「评估匹配度」。
 */
function ruleMatch(d: Partial<JobPosting>): JobMatch {
  const r = scoreOpportunity({
    company: String(d.company || ''),
    title: String(d.title || ''),
    detail: [d.jd, d.requirements, d.exam].filter(Boolean).join(' '),
    deadline: d.deadline,
  });
  return {
    score: r.score,
    highlights: [
      [r.reasons.join(' · '), r.flags.join(' ')].filter(Boolean).join(' ｜ '),
      `（机构 ${r.parts.org} ・ 岗位 ${r.parts.role} ・ 地域 ${r.parts.region} ・ 门槛 ${r.parts.elig}）`,
    ].filter(Boolean).join('　'),
    gaps: '',
    advice: r.advice,
    at: new Date().toISOString(),
    by: 'rule',
    tier: r.tier,
    flags: r.flags,
  };
}
