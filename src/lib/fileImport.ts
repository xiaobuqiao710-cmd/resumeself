/**
 * 本机文件导入：把桌面上的 .md / .json / .csv / .ics / 简历文件解析后，
 * 自动判断「这份文件属于全站哪个板块」，产出可预览、可勾选、可落库的导入计划。
 *
 * 设计原则
 *   1. 只做「解析 + 路由 + 判重」，不碰 React、不碰 store —— 纯函数，便于单测与复用。
 *      落库由调用方（FileImport 弹窗）拿本文件的计划逐条调 store 的既有 add* 方法完成。
 *   2. 识别靠「扩展名 + 内容指纹」，不依赖 AI、不依赖文件名关键词（文件名只用于展示）。
 *   3. 判重口径必须与 store 既有口径一致，否则「先预览显示 3 条、导入后变 5 条」：
 *      jobs 用 sameCompanyStem + normTitle，calendar 用 date|normTitle(title)，
 *      materials 用 group|name，versions 用 name，contacts 用 name|company（或手机/邮箱），
 *      questions 用 kind|category|normTitle(content)。
 */
import type { BankCategory, CalEvent, Contact, JobPosting, MaterialItem, Question, QuestionBank, ResumeVersion } from '../types';
import {
  buildEventDrafts, buildJobDraftsFromDoc, normalizeDate, parseMarkdownDeadlines, parseMarkdownDetails,
  stripAutoCollected, type ImportRow,
} from './mdImport';
import { normTitle } from './dedupe';
import { mergeSnapshot, type MergeCurrent } from './merge';
import { companyStem, sameCompanyStem, stripDecor, todayISO } from './util';

/* ------------------------------------------------------------------ *
 * 目标板块
 * ------------------------------------------------------------------ */

export type FileTarget =
  | 'jobs' | 'calendar' | 'questions' | 'materials' | 'versions'
  | 'contacts' | 'profile' | 'backup' | 'ignore';

export const TARGET_META: Record<FileTarget, { label: string; icon: string; hint: string }> = {
  jobs: { label: '岗位库', icon: 'building', hint: '单位 / 岗位 / 截止日 / 入口' },
  calendar: { label: '截止日历', icon: 'calendar', hint: '截止日、笔试日等日期事件' },
  questions: { label: '笔面题库', icon: 'doc', hint: '笔试 / 面试题目与答案' },
  materials: { label: '资料库', icon: 'award', hint: '材料清单与办理进度' },
  versions: { label: '简历版本', icon: 'resume', hint: '投递用的简历版本记录' },
  contacts: { label: '人脉', icon: 'user', hint: 'HR / 校友 / 内推人联系方式' },
  profile: { label: '资料库（个人信息）', icon: 'user', hint: '姓名、教育经历、实习等' },
  backup: { label: '整站备份', icon: 'archive', hint: '完整备份 JSON，按板块合并补齐' },
  ignore: { label: '暂不支持', icon: 'alert', hint: '无法识别内容，将被跳过' },
};

/** 预览里每个目标板块下面的样例行 */
export interface TargetPlan {
  target: FileTarget;
  count: number;
  /** 预览表格的列标题 */
  columns: string[];
  /** 样例行（最多 5 条，只用于展示） */
  sample: string[][];
  /** 真正落库用的载荷 */
  items: unknown[];
}

/** 解析单个文件的结果 */
export interface FilePlan {
  name: string;
  size: number;
  /** 内容类型的一句话说明，如「Markdown 汇总表（12 条岗位 + 9 条截止）」 */
  kind: string;
  targets: TargetPlan[];
  /** 跳过的行数 + 原因，用于「为什么少了几条」的解释 */
  skipped: string[];
  error?: string;
}

/** 多文件合并后的总计划 */
export interface ImportPlan {
  files: FilePlan[];
  /** 合并去重后、真正要写入的载荷，按目标分组 */
  payload: Partial<Record<FileTarget, unknown[]>>;
  total: number;
}

/* ------------------------------------------------------------------ *
 * 判重助手（与 store 口径保持一致）
 * ------------------------------------------------------------------ */

/** 与 store.addJobs 的命中规则同构：同公司主干 + 归一化岗位名相同 */
function sameJob(a: Partial<JobPosting>, b: Partial<JobPosting>): boolean {
  if (!sameCompanyStem(a.company || '', b.company || '')) return false;
  const na = normTitle(a.title);
  const nb = normTitle(b.title);
  if (na && nb) return na === nb;
  // 泛化标题（「2027 校招」这类 normTitle 为空）——只有同公司唯一岗位时才合并
  return false;
}

const cleanKey = (s: unknown) => String(s ?? '').trim().toLowerCase();

function sameQuestion(a: Partial<Question>, b: Partial<Question>): boolean {
  if (cleanKey(a.kind) !== cleanKey(b.kind)) return false;
  if (cleanKey(a.category) !== cleanKey(b.category)) return false;
  return normTitle(a.content) === normTitle(b.content);
}

/* ------------------------------------------------------------------ *
 * 上下文：判重用「当前站点已有的数据」+「本批次已排入的数据」
 * ------------------------------------------------------------------ */

export interface ImportContext {
  jobs?: Partial<JobPosting>[];
  events?: Partial<CalEvent>[];
  questions?: Partial<Question>[];
  banks?: Partial<QuestionBank>[];
  bankCategories?: Partial<BankCategory>[];
  materials?: Partial<MaterialItem>[];
  versions?: Partial<ResumeVersion>[];
  contacts?: Partial<Contact>[];
}

/* ------------------------------------------------------------------ *
 * CSV 解析（零依赖：支持引号包裹、引号内换行与逗号、CRLF）
 * ------------------------------------------------------------------ */

export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const d = delimiter || detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; }
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function detectDelimiter(src: string): string {
  const head = src.split('\n').slice(0, 5).join('\n');
  const counts: Record<string, number> = {
    ',': (head.match(/,/g) || []).length,
    '\t': (head.match(/\t/g) || []).length,
    ';': (head.match(/;/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/* ------------------------------------------------------------------ *
 * ICS 解析（VEVENT 的 SUMMARY / DTSTART / DESCRIPTION）
 * ------------------------------------------------------------------ */

export function parseICS(text: string): Partial<CalEvent>[] {
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const out: Partial<CalEvent>[] = [];
  const blocks = unfolded.split(/BEGIN:VEVENT/).slice(1);
  for (const raw of blocks) {
    const body = raw.split('END:VEVENT')[0];
    const get = (key: string): string | undefined => {
      const m = body.match(new RegExp(`(?:^|\\n)${key}[^:\\n]*:([^\\n]*)`));
      return m ? icsUnescape(m[1].trim()) : undefined;
    };
    const dt = get('DTSTART');
    const title = get('SUMMARY');
    if (!dt || !title) continue;
    const m = dt.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
    if (!m) continue;
    out.push({
      title,
      date: `${m[1]}-${m[2]}-${m[3]}`,
      time: m[4] ? `${m[4]}:${m[5]}` : undefined,
      type: 'other',
      note: get('DESCRIPTION'),
      source: 'import',
    });
  }
  return out;
}

const icsUnescape = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

/* ------------------------------------------------------------------ *
 * JSON 内容指纹
 * ------------------------------------------------------------------ */

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];

const has = (o: Record<string, unknown>, ...keys: string[]) => keys.every((k) => o[k] !== undefined);

/** 整站备份的判定特征：同时出现 ≥2 个本站顶层字段 */
function looksLikeBackup(o: Record<string, unknown>): boolean {
  const top = ['profile', 'applications', 'jobs', 'questions', 'companies', 'offers',
    'interviews', 'materials', 'versions', 'contacts', 'events', 'resumeText'];
  return top.filter((k) => o[k] !== undefined).length >= 2;
}

/* ------------------------------------------------------------------ *
 * 各格式的解析入口（全部返回 FilePlan）
 * ------------------------------------------------------------------ */

export function planMarkdown(text: string, name: string, size: number, ctx: ImportContext): FilePlan {
  const { text: body, removedLines, found } = stripAutoCollected(text);
  const parsed = parseMarkdownDeadlines(body);
  const details = parseMarkdownDetails(body);
  const { drafts, notes } = buildJobDraftsFromDoc({ rows: parsed.rows, details: details.details });

  const skipped: string[] = [];
  if (found) skipped.push(`跳过「🤖 自动抓取岗位」区块（${removedLines} 行）`);
  if (parsed.skipped.length) skipped.push(`未识别为岗位的列表行 ${parsed.skipped.length} 条（多为待办/提醒）`);
  if (!parsed.headerFound && !details.tables) {
    skipped.push('没有找到可识别的表格或清单行');
  }

  const targets: TargetPlan[] = [];
  const jobs = dedupeAgainst(drafts as Partial<JobPosting>[], ctx.jobs || [], sameJob);
  if (jobs.kept.length) {
    targets.push({
      target: 'jobs', count: jobs.kept.length,
      columns: ['单位', '岗位', '截止日', '入口'],
      sample: jobs.kept.slice(0, 5).map((j) => [j.company || '', j.title || '', j.deadline || '—', j.url || '—']),
      items: jobs.kept,
    });
  }
  const events = dedupeEvents(buildEventDrafts(parsed.rows) as Partial<CalEvent>[], ctx.events || []);
  if (events.kept.length) {
    targets.push({
      target: 'calendar', count: events.kept.length,
      columns: ['日期', '事件'],
      sample: events.kept.slice(0, 5).map((e) => [e.date || '', e.title || '']),
      items: events.kept,
    });
  }
  if (jobs.dup || events.dup) {
    const bits: string[] = [];
    if (jobs.dup) bits.push(`岗位 ${jobs.dup} 条`);
    if (events.dup) bits.push(`日历 ${events.dup} 条`);
    skipped.push(`与站内已有记录重复，已自动跳过（${bits.join('、')}）`);
  }
  if (notes.length) skipped.push(`识别为备注（非岗位）${notes.length} 条`);

  const kind = [
    jobs.kept.length ? `${jobs.kept.length} 条岗位` : '',
    events.kept.length ? `${events.kept.length} 条截止` : '',
  ].filter(Boolean).join(' + ') || '未识别出可导入内容';

  return { name, size, kind: `Markdown 汇总表（${kind}）`, targets, skipped };
}

export function planJson(text: string, name: string, size: number, ctx: ImportContext): FilePlan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { name, size, kind: 'JSON', targets: [], skipped: [], error: `JSON 解析失败：${(e as Error).message}` };
  }
  const skipped: string[] = [];
  const targets: TargetPlan[] = [];

  /* ① 整站备份 */
  if (data && typeof data === 'object' && !Array.isArray(data) && looksLikeBackup(data as Record<string, unknown>)) {
    const incoming = data as MergeCurrent;
    const cur: MergeCurrent = {
      profile: currentProfile(ctx),
      applications: [], jobs: ctx.jobs as JobPosting[], questions: ctx.questions as Question[],
      banks: (ctx.banks || []) as QuestionBank[],
      bankCategories: (ctx.bankCategories || []) as BankCategory[],
      companies: [], events: ctx.events as CalEvent[], offers: [], interviews: [],
      materials: ctx.materials as MaterialItem[], versions: ctx.versions as ResumeVersion[],
      contacts: ctx.contacts as Contact[],
    };
    const { detail } = mergeSnapshot(cur, incoming);
    const real = detail.filter((d) => !/^跳过/.test(d));
    targets.push({
      target: 'backup', count: real.length,
      columns: ['合并说明'],
      sample: real.slice(0, 8).map((d) => [d]),
      items: [incoming],
    });
    if (!real.length) skipped.push('备份里没有新的内容（站内已有同名记录）');
    return { name, size, kind: '整站备份 JSON（按板块合并补齐）', targets, skipped };
  }

  /* ② 顶层是数组：按元素指纹判定板块 */
  if (Array.isArray(data)) {
    const items = arr(data);
    const byKind = routeArray(items, ctx, skipped);
    for (const [target, list] of byKind) targets.push(list);
    const kind = byKind.size
      ? `JSON 数组（${[...byKind.values()].map((t) => `${TARGET_META[t.target].label} ${t.count} 条`).join('、')}）`
      : 'JSON 数组（未识别出板块）';
    return { name, size, kind, targets, skipped };
  }

  /* ③ 顶层是「板块名 → 数组」的对象 */
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const byKind = new Map<FileTarget, TargetPlan>();
    for (const [key, value] of Object.entries(obj)) {
      const list = arr(value);
      if (!list.length) continue;
      const mapped = TARGET_BY_KEY[key.toLowerCase()];
      if (!mapped || mapped === 'backup') { skipped.push(`忽略了无法归位的字段「${key}」（${list.length} 条）`); continue; }
      addToMap(byKind, mapped, list, ctx, skipped);
    }
    for (const v of byKind.values()) targets.push(v);
    return {
      name, size,
      kind: byKind.size
        ? `JSON（${[...byKind.values()].map((t) => `${TARGET_META[t.target].label} ${t.count} 条`).join('、')}）`
        : 'JSON 对象（未识别出板块）',
      targets, skipped,
    };
  }

  return { name, size, kind: 'JSON（标量，无可导入内容）', targets: [], skipped };
}

/**
 * 把文件里的「仓库」写法解析成本地已有的仓库 id。
 * 支持：写 id、写仓库名；两者都没命中返回 undefined ——
 * 此时题目仍然会导入，只是落在「未归档」，之后可在题库页批量收编。
 * （有意不做自动建仓库：猜错名字会生成一堆垃圾仓库，比不建更烦人。）
 */
function resolveBankId(
  raw: string | undefined,
  obj: Record<string, unknown>,
  ctx: ImportContext,
): string | undefined {
  const banks = ctx.banks || [];
  if (banks.length === 0) return undefined;
  const byId = String(obj.bankId ?? '').trim();
  if (byId) { const hit = banks.find((b) => b.id === byId); if (hit) return hit.id; }
  const name = (raw || '').trim();
  if (!name) return undefined;
  const hit = banks.find((b) => (b.name || '').trim() === name);
  return hit ? hit.id : undefined;
}

const TARGET_BY_KEY: Record<string, FileTarget> = {
  jobs: 'jobs', jobpostings: 'jobs', positions: 'jobs',
  events: 'calendar', calendar: 'calendar', deadlines: 'calendar',
  questions: 'questions', question: 'questions', bank: 'questions',
  materials: 'materials', material: 'materials',
  versions: 'versions', resumes: 'versions', resumeversions: 'versions',
  contacts: 'contacts', contact: 'contacts', people: 'contacts',
  profile: 'profile', personal: 'profile', educations: 'profile',
};

export function planCsv(text: string, name: string, size: number, ctx: ImportContext): FilePlan {
  const rows = parseDelimited(text);
  if (rows.length < 2) {
    return { name, size, kind: 'CSV', targets: [], skipped: [], error: '表格至少需要表头 + 一行数据' };
  }
  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  // 复用 Markdown 表的列映射思路：把表头映射成岗位草稿
  const mrows: ImportRow[] = body.map((o) => ({
    deadline: normalizeDate(pick(o, ['截止', '截止日', '期限', 'deadline'])) || '',
    company: pick(o, ['单位', '公司', '机构', '企业', '部门', 'company']) || '',
    title: pick(o, ['事项', '岗位', '职位', '内容', '招聘', 'title', 'position']) || '',
    url: pick(o, ['入口', '链接', '网址', '官网', 'url', 'link']) || '',
    remain: pick(o, ['剩余', '倒计时', '还有']) || '',
    note: pick(o, ['备注', '说明', '要求', 'hard', 'note']) || '',
    raw: header.map((h) => o[h]).join(' | '),
  }));

  const skipped: string[] = [];
  const targets: TargetPlan[] = [];

  /* 先判「这不是岗位表」的两种强特征，再退回岗位表。
     顺序很重要：人脉表的表头常带「公司」列，题库表常带「内容」列 ——
     若先按「有公司列 ⇒ 岗位」走，人脉和题库会被整表错并进岗位库（实测踩到过）。 */
  const contactHit = hasAny(header, ['姓名', '名字', 'name']) && hasAny(header, ['公司', '单位', '微信', '电话', '邮箱', '职位', 'role', 'wechat', 'phone', 'email']);
  const questionHit = hasAny(header, ['题目', '问题', '内容', 'question', 'content']) && hasAny(header, ['类型', '分类', '类别', 'kind', 'category', '答案', 'answer']);

  if (contactHit) {
    const items = body.filter((o) => pick(o, ['姓名', '名字', 'name'])).map((o) => ({
      name: pick(o, ['姓名', '名字', 'name']),
      company: pick(o, ['公司', '单位', 'company']) || undefined,
      role: pick(o, ['职位', '角色', 'role']) || undefined,
      relation: pick(o, ['关系', 'relation']) || undefined,
      wechat: pick(o, ['微信', 'wechat']) || undefined,
      email: pick(o, ['邮箱', 'email']) || undefined,
      phone: pick(o, ['电话', '手机', 'phone']) || undefined,
      notes: pick(o, ['备注', '说明', 'note', 'notes']) || undefined,
    }));
    const d = dedupeContacts(items, ctx.contacts || []);
    if (d.kept.length) {
      targets.push({
        target: 'contacts', count: d.kept.length,
        columns: ['姓名', '公司', '角色', '微信 / 电话'],
        sample: d.kept.slice(0, 5).map((c) => [c.name || '', c.company || '—', c.role || '—', c.wechat || c.phone || '—']),
        items: d.kept,
      });
    }
    if (d.dup) skipped.push(`与站内已有联系人重复，已跳过 ${d.dup} 条`);
    const kind = targets.length ? `CSV 表格（${d.kept.length} 条 人脉）` : 'CSV 表格（人脉，全部已存在）';
    return { name, size, kind, targets, skipped };
  }

  if (questionHit) {
    const items = body.filter((o) => pick(o, ['题目', '问题', '内容', 'question', 'content'])).map((o) => {
      const kindRaw = pick(o, ['类型', '分类', '类别', 'kind', 'category']);
      return {
        kind: /面试|interview/i.test(kindRaw + pick(o, ['类型', 'kind'])) ? 'interview' as const : 'written' as const,
        category: kindRaw || '导入',
        content: pick(o, ['题目', '问题', '内容', 'question', 'content']),
        answer: pick(o, ['答案', 'answer']) || undefined,
        company: pick(o, ['公司', '单位', 'company']) || undefined,
        year: pick(o, ['年份', 'year']) || undefined,
        bankId: resolveBankId(pick(o, ['仓库', '仓库名', 'bank', 'bankName', 'bankId']), o, ctx),
      };
    });
    const d = dedupeAgainst(items as Partial<Question>[], ctx.questions || [], sameQuestion as never);
    if (d.kept.length) {
      targets.push({
        target: 'questions', count: d.kept.length,
        columns: ['类型', '题目', '答案'],
        sample: d.kept.slice(0, 5).map((q) => {
          const r = q as Partial<Question>;
          return [r.kind === 'interview' ? '面试' : '笔试', (r.content || '').slice(0, 36), (r.answer || '—').slice(0, 30)];
        }),
        items: d.kept,
      });
    }
    if (d.dup) skipped.push(`与站内已有题目重复，已跳过 ${d.dup} 条`);
    const kind = targets.length ? `CSV 表格（${d.kept.length} 条 笔面题库）` : 'CSV 表格（题库，全部已存在）';
    return { name, size, kind, targets, skipped };
  }

  const hasCompany = mrows.some((r) => r.company);
  if (hasCompany) {
    const jobs = dedupeAgainst(
      mrows.filter((r) => r.company).map((r) => ({
        company: stripDecor(r.company),
        title: stripDecor(r.title) || '岗位',
        deadline: r.deadline || undefined,
        url: r.url || undefined,
        requirements: r.note || undefined,
        source: '导入', status: 'new' as const,
      })),
      ctx.jobs || [], sameJob,
    );
    if (jobs.kept.length) {
      targets.push({
        target: 'jobs', count: jobs.kept.length,
        columns: ['单位', '岗位', '截止日'],
        sample: jobs.kept.slice(0, 5).map((j) => [j.company || '', j.title || '', j.deadline || '—']),
        items: jobs.kept,
      });
    }
    if (jobs.dup) skipped.push(`与站内已有岗位重复，已跳过 ${jobs.dup} 条`);
  }
  const csvKind = targets.length ? `CSV 表格（${targets[0].count} 条 ${TARGET_META[targets[0].target].label}）` : 'CSV 表格（未识别出板块）';
  if (!hasCompany) skipped.push('表头里没有「单位 / 公司」列，也没有可识别的人脉 / 题库特征，无法归位');
  return { name, size, kind: csvKind, targets, skipped };
}

/** 表头里是否存在任一关键词（大小写不敏感、去掉空格） */
function hasAny(header: string[], keys: string[]): boolean {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/\s/g, ''));
  return keys.some((k) => norm.includes(k.toLowerCase()));
}

export function planICS(text: string, name: string, size: number, ctx: ImportContext): FilePlan {
  const all = parseICS(text);
  const { kept, dup } = dedupeEvents(all, ctx.events || []);
  const skipped: string[] = [];
  if (dup) skipped.push(`与站内已有日历重复，已跳过 ${dup} 条`);
  if (!all.length) skipped.push('没有找到 VEVENT 事件块');
  const targets: TargetPlan[] = kept.length ? [{
    target: 'calendar', count: kept.length,
    columns: ['日期', '时间', '事件'],
    sample: kept.slice(0, 5).map((e) => [e.date || '', e.time || '—', e.title || '']),
    items: kept,
  }] : [];
  return { name, size, kind: `iCalendar（${kept.length} 条事件）`, targets, skipped };
}

/** 内容（非二进制）文件的统一入口 */
export function planTextFile(name: string, text: string, ctx: ImportContext): FilePlan {
  const size = text.length;
  const ext = extOf(name);
  switch (ext) {
    case 'md': case 'markdown': case 'txt': case 'text': return planMarkdown(text, name, size, ctx);
    case 'json': return planJson(text, name, size, ctx);
    case 'csv': case 'tsv': return planCsv(text, name, size, ctx);
    case 'ics': case 'ical': return planICS(text, name, size, ctx);
    default:
      if (/^\s*[\[{]/.test(text)) return planJson(text, name, size, ctx);
      if (/BEGIN:VCALENDAR/i.test(text)) return planICS(text, name, size, ctx);
      if (/^\s*\|/m.test(text)) return planMarkdown(text, name, size, ctx);
      return {
        name, size, kind: '未识别的内容',
        targets: [], skipped: [],
        error: `无法识别的文件类型（.${ext || '无扩展名'}）：目前支持 .md / .json / .csv / .ics`,
      };
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** 常见的「AI 导出」包装：{"jobs": [...]} / [...{...}] 里混着说明文字 */
function pick(o: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    for (const [kk, vv] of Object.entries(o)) {
      if (kk.trim().toLowerCase() === k.toLowerCase() && vv) return vv;
    }
  }
  return '';
}

function addToMap(
  map: Map<FileTarget, TargetPlan>, target: FileTarget,
  list: Record<string, unknown>[], ctx: ImportContext, skipped: string[],
): void {
  let items: unknown[] = list;
  let columns: string[] = ['内容'];
  let sampleOf: (x: unknown) => string[] = (x) => [JSON.stringify(x).slice(0, 80)];

  if (target === 'jobs') {
    const d = dedupeAgainst(list as Partial<JobPosting>[], ctx.jobs || [], sameJob);
    items = d.kept;
    columns = ['单位', '岗位', '截止日'];
    sampleOf = (x) => { const j = x as Partial<JobPosting>; return [j.company || '', j.title || '', j.deadline || '—']; };
    if (d.dup) skipped.push(`岗位与站内重复 ${d.dup} 条，已跳过`);
  } else if (target === 'calendar') {
    const d = dedupeEvents(list as Partial<CalEvent>[], ctx.events || []);
    items = d.kept;
    columns = ['日期', '事件'];
    sampleOf = (x) => { const e = x as Partial<CalEvent>; return [e.date || '', e.title || '']; };
    if (d.dup) skipped.push(`日历与站内重复 ${d.dup} 条，已跳过`);
  } else if (target === 'questions') {
    const d = dedupeAgainst(list as Partial<Question>[], ctx.questions || [], sameQuestion as never);
    items = d.kept;
    columns = ['类型', '题目'];
    sampleOf = (x) => { const q = x as Partial<Question>; return [q.kind === 'interview' ? '面试' : '笔试', (q.content || '').slice(0, 40)]; };
    if (d.dup) skipped.push(`题目与站内重复 ${d.dup} 条，已跳过`);
  } else if (target === 'materials') {
    const d = dedupeMaterials(list as Partial<MaterialItem>[], ctx.materials || []);
    items = d.kept;
    columns = ['分组', '材料名'];
    sampleOf = (x) => { const m = x as Partial<MaterialItem>; return [m.group || '', m.name || '']; };
    if (d.dup) skipped.push(`材料与站内重复 ${d.dup} 条，已跳过`);
  } else if (target === 'versions') {
    const d = dedupeVersions(list as Partial<ResumeVersion>[], ctx.versions || []);
    items = d.kept;
    columns = ['版本名', '面向'];
    sampleOf = (x) => { const v = x as Partial<ResumeVersion>; return [v.name || '', v.target || '—']; };
    if (d.dup) skipped.push(`简历版本与站内重复 ${d.dup} 条，已跳过`);
  } else if (target === 'contacts') {
    const d = dedupeContacts(list as Partial<Contact>[], ctx.contacts || []);
    items = d.kept;
    columns = ['姓名', '公司', '角色'];
    sampleOf = (x) => { const c = x as Partial<Contact>; return [c.name || '', c.company || '—', c.role || '—']; };
    if (d.dup) skipped.push(`联系人与站内重复 ${d.dup} 条，已跳过`);
  }

  if (!items.length) return;
  const prev = map.get(target);
  map.set(target, {
    target,
    count: (prev?.count || 0) + items.length,
    columns: prev?.columns || columns,
    sample: [...(prev?.sample || []), ...items.slice(0, 5).map(sampleOf)].slice(0, 5),
    items: [...(prev?.items || []), ...items],
  });
}

/** 数组元素指纹 → 板块 */
function routeArray(items: Record<string, unknown>[], ctx: ImportContext, skipped: string[]): Map<FileTarget, TargetPlan> {
  const map = new Map<FileTarget, TargetPlan>();
  const groups: Record<FileTarget, Record<string, unknown>[]> = {
    jobs: [], calendar: [], questions: [], materials: [], versions: [], contacts: [], profile: [], backup: [], ignore: [],
  };
  for (const it of items) {
    if (has(it, 'content') && (it.kind === 'written' || it.kind === 'interview')) {
      /* routeArray 拿到的是原始对象，这里把「仓库」字段就地翻译成 bankId */
      const bid = resolveBankId(undefined, it, ctx);
      groups.questions.push(bid ? { ...it, bankId: bid } : it);
    }
    else if (has(it, 'company') && has(it, 'title')) groups.jobs.push(it);
    else if (has(it, 'title') && has(it, 'date')) groups.calendar.push(it);
    else if (has(it, 'name') && has(it, 'group')) groups.materials.push(it);
    else if (has(it, 'name') && has(it, 'fileName')) groups.versions.push(it);
    else if (has(it, 'name') && (has(it, 'wechat') || has(it, 'phone') || has(it, 'company'))) groups.contacts.push(it);
    else if (has(it, 'name') && has(it, 'start') && has(it, 'school')) groups.profile.push(it);
    else groups.ignore.push(it);
  }
  for (const [t, list] of Object.entries(groups) as [FileTarget, Record<string, unknown>[]][]) {
    if (!list.length || t === 'ignore') continue;
    addToMap(map, t, list, ctx, skipped);
  }
  if (groups.ignore.length) skipped.push(`有 ${groups.ignore.length} 条无法归入任何板块，已跳过`);
  return map;
}

/** 与站内已有数据判重，返回保留项与重复条数 */
function dedupeAgainst<T>(incoming: T[], existing: Partial<unknown>[], eq: (a: T, b: Partial<unknown>) => boolean) {
  const kept: T[] = [];
  let dup = 0;
  for (const item of incoming) {
    const hitIncoming = kept.some((k) => eq(item, k as Partial<unknown>));
    const hitExisting = (existing || []).some((e) => eq(item, e));
    if (hitIncoming || hitExisting) { dup++; continue; }
    kept.push(item);
  }
  return { kept, dup };
}

/** 只在载荷内部两两去重（跨文件合并用），不引入站内数据作基准 */
function dedupeWithin<T>(incoming: T[], eq: (a: T, b: T) => boolean): T[] {
  const kept: T[] = [];
  for (const item of incoming) {
    if (kept.some((k) => eq(item, k))) continue;
    kept.push(item);
  }
  return kept;
}

/** 联系人判重：姓名 + 公司；任一侧缺公司时退化为「姓名 + 手机/邮箱」 */
function sameContact(a: Partial<Contact>, b: Partial<Contact>): boolean {
  const an = (a.name || '').trim().toLowerCase();
  const bn = (b.name || '').trim().toLowerCase();
  if (!an || an !== bn) return false;
  const ac = (a.company || '').trim().toLowerCase();
  const bc = (b.company || '').trim().toLowerCase();
  if (ac && bc) return ac === bc;
  const av = (a.phone || a.email || a.wechat || '').trim().toLowerCase();
  const bv = (b.phone || b.email || b.wechat || '').trim().toLowerCase();
  if (av && bv) return av === bv;
  return false;                       // 同名不同公司又都没有联系方式：当作两个人，不合并
}

function dedupeContacts(incoming: Partial<Contact>[], existing: Partial<Contact>[]) {
  return dedupeAgainst(incoming, existing as Partial<unknown>[], sameContact as never);
}

/** 材料判重：group|name（与 store 里资料库的展示口径一致） */
function dedupeMaterials(incoming: Partial<MaterialItem>[], existing: Partial<MaterialItem>[]) {
  const eq = (a: Partial<MaterialItem>, b: Partial<unknown>) => {
    const x = b as Partial<MaterialItem>;
    return cleanKey(`${a.group || ''}|${a.name || ''}`) === cleanKey(`${x.group || ''}|${x.name || ''}`);
  };
  return dedupeAgainst(incoming, existing as Partial<unknown>[], eq as never);
}

/** 简历版本判重：只看 name（store 的 addVersion 不判重） */
function dedupeVersions(incoming: Partial<ResumeVersion>[], existing: Partial<ResumeVersion>[]) {
  const eq = (a: Partial<ResumeVersion>, b: Partial<unknown>) =>
    !!a.name && cleanKey(a.name) === cleanKey((b as Partial<ResumeVersion>).name);
  return dedupeAgainst(incoming, existing as Partial<unknown>[], eq as never);
}

/** 日历按 date|normTitle(title) 去重，与 store.addEvents 口径一致 */
function dedupeEvents(incoming: Partial<CalEvent>[], existing: Partial<CalEvent>[]) {
  const keyOf = (e: Partial<CalEvent>) => `${e.date || ''}|${normTitle(e.title)}`;
  const seen = new Set((existing || []).map(keyOf));
  const kept: Partial<CalEvent>[] = [];
  let dup = 0;
  for (const e of incoming) {
    const k = keyOf(e);
    if (!e.date || seen.has(k)) { dup++; continue; }
    seen.add(k);
    kept.push(e);
  }
  return { kept, dup };
}

function currentProfile(ctx: ImportContext): MergeCurrent['profile'] {
  return (ctx as unknown as { profile?: MergeCurrent['profile'] }).profile || { single: {}, multi: {} };
}

/* ------------------------------------------------------------------ *
 * 汇总：多文件 → 一个总计划
 * ------------------------------------------------------------------ */

export function buildImportPlan(files: FilePlan[], ctx: ImportContext): ImportPlan {
  const payload: Partial<Record<FileTarget, unknown[]>> = {};
  for (const f of files) {
    for (const t of f.targets) {
      const bucket = payload[t.target] || (payload[t.target] = []);
      for (const item of t.items) {
        if (t.target === 'backup') { payload.backup = [item]; continue; }
        bucket.push(item);
      }
    }
  }
  /* 跨文件去重：只处理「同一份内容被两个文件各带了一遍」的情况。
     ★ 这里绝不能把 ctx（站内已有数据）当 existing 再判一次 —— 各 planXxx 已经判过了，
     再拿它对比只会重复劳动；而传空集则等于放弃去重（曾把题库重导成 3→6 条）。
     正确做法是用 dedupeWithin：只在载荷内部两两比对，不引入任何外部基准。 */
  if (payload.jobs) {
    payload.jobs = dedupeWithin(payload.jobs as Partial<JobPosting>[], sameJob as never);
  }
  if (payload.calendar) {
    payload.calendar = dedupeWithin(
      payload.calendar as Partial<CalEvent>[],
      ((a: Partial<CalEvent>, b: Partial<CalEvent>) => `${a.date || ''}|${normTitle(a.title)}` === `${b.date || ''}|${normTitle(b.title)}`) as never,
    );
  }
  if (payload.questions) {
    payload.questions = dedupeWithin(payload.questions as Partial<Question>[], sameQuestion as never);
  }
  if (payload.contacts) {
    payload.contacts = dedupeWithin(payload.contacts as Partial<Contact>[], sameContact as never);
  }
  const total = Object.entries(payload)
    .filter(([k]) => k !== 'backup')
    .reduce((n, [, v]) => n + (v as unknown[]).length, 0);
  return { files, payload, total };
}

/** 统计预览用：把计划压成「板块 → 条数」 */
export function summarize(plan: ImportPlan): { target: FileTarget; count: number }[] {
  const out: { target: FileTarget; count: number }[] = [];
  for (const [k, v] of Object.entries(plan.payload) as [FileTarget, unknown[]][]) {
    if (k === 'backup') { out.push({ target: 'backup', count: 1 }); continue; }
    if (v?.length) out.push({ target: k, count: v.length });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** 从文件对象读出内容并解析（浏览器侧入口；简历类文件由弹窗另行处理） */
export async function planFile(file: File, ctx: ImportContext): Promise<FilePlan> {
  const ext = extOf(file.name);
  const plain = ['md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv', 'ics', 'ical'];
  if (!plain.includes(ext)) {
    return {
      name: file.name, size: file.size, kind: '不支持的格式', targets: [], skipped: [],
      error: `暂不支持 .${ext || '无扩展名'}（简历请用「简历解析」入口）`,
    };
  }
  try {
    const text = await file.text();
    return planTextFile(file.name, text, ctx);
  } catch (e) {
    return { name: file.name, size: file.size, kind: '读取失败', targets: [], skipped: [], error: (e as Error).message };
  }
}

/** 供 UI 展示：这条计划一共能导入多少条 */
export const planCount = (f: FilePlan): number => f.targets.reduce((n, t) => n + t.count, 0);

/** 今天（统一走 util，避免 UTC 偏移） */
export const stampToday = todayISO;

/** 公司主干（导出给 UI 做分组展示） */
export { companyStem };
