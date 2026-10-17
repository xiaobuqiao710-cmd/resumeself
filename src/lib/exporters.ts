/**
 * 导出器：把网站里的数据倒回你熟悉的格式，形成闭环。
 *   - Markdown 表格：直接粘回《秋招信息汇总.md》或 Obsidian 日报
 *   - CSV：Excel / 坚果云表格继续加工
 *   - ICS：导入系统日历 / 手机日历，带提前 7/3/1 天闹钟提醒
 */
import type { Application, JobPosting, CalEvent, Offer, InterviewLog } from '../types';
import { fmtDate, STATUS_META, daysUntil, sameCompanyLoose } from './util';
import { collectReminders, remindItemId } from './remind';

const pad = (n: number) => String(n).padStart(2, '0');

/* ---------------- Markdown ---------------- */
export function toMarkdownTable(header: string[], rows: (string | number | undefined)[][]): string {
  const esc = (v: string | number | undefined) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (cells: (string | number | undefined)[]) => `| ${cells.map(esc).join(' | ')} |`;
  return [
    line(header),
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map(line),
  ].join('\n');
}

/** 截止日历表（与《秋招信息汇总》同构，可直接粘贴回文档） */
export function jobsToMarkdown(jobs: JobPosting[], onlyUpcoming = true): string {
  const list = jobs
    .filter((j) => (onlyUpcoming ? (j.deadline ? (daysUntil(j.deadline) ?? 0) >= 0 : false) : true))
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
  if (!list.length) return '（暂无带截止日期的岗位）';
  return toMarkdownTable(
    ['截止日', '剩余', '单位', '事项', '入口', '状态'],
    list.map((j) => {
      const d = daysUntil(j.deadline);
      return [
        fmtDate(j.deadline).slice(5),
        d === null ? '—' : (d === 0 ? '今天' : `${d} 天`),
        j.company,
        j.title,
        j.url || '',
        j.status,
      ];
    }),
  );
}

export function applicationsToMarkdown(apps: Application[]): string {
  if (!apps.length) return '（暂无投递记录）';
  return toMarkdownTable(
    ['单位', '岗位', '状态', '渠道', '城市', '截止', '投递日', '链接'],
    apps.map((a) => [
      a.company, a.position, STATUS_META[a.status]?.label || a.status,
      a.channel || '', a.location || '', fmtDate(a.deadline), fmtDate(a.submittedAt), a.link || '',
    ]),
  );
}

export function offersToMarkdown(offers: Offer[]): string {
  if (!offers.length) return '（暂无 Offer）';
  return toMarkdownTable(
    ['单位', '岗位', '城市', '月base', '薪数', '首年总包', '户口', '签约截止', '评分', '状态'],
    offers.map((o) => [
      o.company, o.position, o.city || '', o.baseMonthly || '', o.months || '',
      o.totalPackage || '', o.hukou || '', fmtDate(o.signDeadline), o.rating ?? '', o.status,
    ]),
  );
}

export function interviewsToMarkdown(logs: InterviewLog[]): string {
  if (!logs.length) return '（暂无面试记录）';
  return toMarkdownTable(
    ['日期', '单位', '轮次', '形式', '问题数', '结果', '改进点'],
    logs.map((l) => [
      fmtDate(l.date), l.company, l.round, l.format || '',
      l.questions.length, l.result, (l.improvements || '').replace(/\n/g, ' '),
    ]),
  );
}

/* ---------------- CSV ---------------- */
export function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCSV(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function jobsToCSV(jobs: JobPosting[]): string {
  return toCSV(
    ['单位', '岗位', '城市', '薪资', '来源', '截止日', '剩余天数', '状态', '匹配度', '链接', '备注'],
    jobs.map((j) => [
      j.company, j.title, j.city || '', j.salary || '', j.source || '', j.deadline || '',
      daysUntil(j.deadline) ?? '', j.status, j.match?.score ?? '', j.url || '', j.jd || '',
    ]),
  );
}

export function applicationsToCSV(apps: Application[]): string {
  return toCSV(
    ['单位', '岗位', '状态', '渠道', '城市', '截止日', '投递日', '薪资', '联系人', '链接', '备注'],
    apps.map((a) => [
      a.company, a.position, STATUS_META[a.status]?.label || a.status, a.channel || '',
      a.location || '', a.deadline || '', a.submittedAt || '', a.salary || '',
      a.contact || '', a.link || '', a.notes || '',
    ]),
  );
}

/* ---------------- ICS ---------------- */
const icsEsc = (s: string) => String(s || '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

/** 单个字符的 UTF-8 字节数（浏览器里没有 Buffer，折行必须按字节算而不是按字符算） */
const utf8Len = (ch: string): number => {
  const c = ch.codePointAt(0) || 0;
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};

/**
 * RFC 5545 §3.1 行折叠：内容行不得超过 75 个八位组，超出部分折到下一行并以**一个空格**开头。
 *
 * 不折行的后果实测过：一份 51 个事件的导出里有 **149 行超限，最长 455 字节**——岗位 JD 一进
 * DESCRIPTION 就会撑爆。Apple 日历容错、但 Outlook 与部分安卓客户端会截断或直接判定文件非法。
 * 折叠必须按 UTF-8 字节切（中文 3 字节），且不能把一个汉字劈成两半，所以在字符边界上累加字节数。
 */
function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;                       // 首行含 "NAME:" 前缀也算在内
  for (const ch of line) {
    const b = utf8Len(ch);
    if (bytes + b > limit && cur) { out.push(cur); cur = ch; bytes = b; limit = 74; }  // 续行首字符是空格，占 1 字节
    else { cur += ch; bytes += b; }
  }
  out.push(cur);
  return out.join('\r\n ');
}

function icsStamp(d = new Date()): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export interface IcsEventInput {
  uid: string;
  date: string;            // YYYY-MM-DD
  time?: string;           // HH:mm（缺省 09:00）
  title: string;
  description?: string;
  alarmDays?: number[];    // 提前几天提醒
}

/** 紧凑日期（YYYYMMDD）加天数，用于事件结束时间跨日进位 */
function compactAddDays(d: string, days: number): string {
  const dt = new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)) + days);
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
}

/** ICS UID 只留安全字符：`+` 等会让部分客户端认不出同一条事件，重复导入即重复建 */
const safeUid = (s: string) => String(s).replace(/[^A-Za-z0-9._@-]/g, '-');

/** 生成 ICS（浮动本地时间，导入手机日历后按当地时间触发） */
export function buildICS(events: IcsEventInput[], calName = '秋招追踪'): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'PRODID:-//qiuzhao-assistant//Qiuzhao2027//CN',
    'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEsc(calName)}`,
  ];
  const now = icsStamp();
  for (const e of events) {
    const d = (e.date || '').replace(/-/g, '');
    if (d.length !== 8) continue;
    const t = (e.time || '09:00').replace(':', '');
    const [hh, mm] = [t.slice(0, 2), t.slice(2, 4)];
    /* 结束时间 = 开始 + 1 小时，且跨日必须进位日期。
       原实现用 (小时+1)%24 却不进位：23:00 的截止事件生成 DTEND 早于 DTSTART 的非法区间，
       Google 日历直接拒收、Apple 纠正成次日 00:00，-1d 闹钟因此晚一天。 */
    const endTotal = Number(hh) * 60 + Number(mm) + 60;
    const dayShift = Math.floor(endTotal / 1440);
    const dEnd = dayShift ? compactAddDays(d, dayShift) : d;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${safeUid(e.uid)}@qiuzhao-assistant`,
      `DTSTAMP:${now}`,
      `DTSTART:${d}T${hh}${mm}00`,
      `DTEND:${dEnd}T${pad(Math.floor((endTotal % 1440) / 60))}${pad(endTotal % 60)}00`,
      `SUMMARY:${icsEsc(e.title)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${icsEsc(e.description)}`);
    for (const days of e.alarmDays || [1]) {
      lines.push(
        'BEGIN:VALARM', 'ACTION:DISPLAY',
        `TRIGGER:-P${Math.max(0, days)}D`,
        `DESCRIPTION:${icsEsc(e.title)}`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  /* 每行按 RFC 5545 折到 75 字节以内；文件以 CRLF 收尾（原先既不折行也没有结尾换行，
     DESCRIPTION 里的 JD 一长就会产出最长 455 字节的行）。 */
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function deadlinesToIcsEvents(
  jobs: JobPosting[], apps: Application[], events: CalEvent[], alarmDays: number[],
): IcsEventInput[] {
  /* 与站内「截止提醒」共用同一套筛选与去重规则（collectReminders）：
     已投递/已归档的岗位、已提交的投递、以及重复的截止事件都不会再进日历，
     避免站内已经不再提醒了、手机日历却还在催。 */
  const items = collectReminders({ jobs, applications: apps, events }, { days: [3650] })
    .filter((i) => i.days >= 0);
  /* 反查表的键必须与 collectReminders 产出的 id 用同一个构造函数，
     否则「提醒条目 → 原始实体」的映射会整体失配（JD/要求/时间会静默丢失）。 */
  const jobById = new Map(jobs.map((j) => [remindItemId('job', j.id), j]));
  const appById = new Map(apps.map((a) => [remindItemId('app', a.id), a]));
  const evById = new Map(events.map((e) => [remindItemId('ev', e.id), e]));

  /* 提醒层会把「同单位同一天」的多个岗位并成一条并把 id 改写成 `job-xxx+3`，
     反查前必须先剥掉 `+N` 后缀，否则 j 为 undefined，DESCRIPTION 里的 JD/要求整段丢失。
     UID 直接沿用剥掉后缀的键（它本身已带 job-/app-/ev- 前缀），不再二次加前缀。 */
  const baseKey = (id: string) => id.replace(/\+\d+$/, '');

  return items.map((i) => {
    const key = baseKey(i.id);
    if (i.kind === 'job') {
      const j = jobById.get(key);
      /* 提醒层把「同单位同日」的多个岗位并成了一条，这里要把这一组岗位的要求都带上，
         否则日历事件只剩第一条的 JD，其余岗位的要求在导出时丢掉。 */
      const group = j
        ? jobs.filter((x) => x.deadline === i.date && sameCompanyLoose(x.company, j.company))
        : [];
      const reqs = group.map((x) => x.requirements).filter(Boolean).join('\n');
      return {
        uid: key, date: i.date, time: '23:00',
        title: `【网申截止】${i.company} · ${i.title}`,
        description: [i.url, reqs || j?.requirements].filter(Boolean).join('\n'), alarmDays,
      };
    }
    if (i.kind === 'app') {
      const a = appById.get(key);
      return {
        uid: key, date: i.date, time: '23:00',
        title: `【投递截止】${i.company} · ${i.title}`,
        description: i.url || a?.link || '', alarmDays,
      };
    }
    const e = evById.get(key);
    return {
      uid: key, date: i.date, time: e?.time || '09:00',
      title: `${i.title === '面试' ? '【面试】' : i.title === '笔试' ? '【笔试】' : ''}${i.company}`,
      description: e?.note || '', alarmDays,
    };
  });
}
