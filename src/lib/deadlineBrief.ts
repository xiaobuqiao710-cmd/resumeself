/**
 * 「什么要截止、什么时候」—— 截止清单的规则引擎 + AI 上下文。
 *
 * 为什么单独抽一层（2026-10-20）：
 *   日历右侧原先直接平铺 `isEventActionable` 过滤后的事件，结果一堆「已过 30 天」的
 *   笔试通知堆在最上面，把真正临近的事压下去；而邮件同步生成的日程又常常对不上任何
 *   一条投递记录（标题是邮件原文、没有归属），看起来就像「跟我的投递记录不匹配」。
 *
 *   用户要的其实只有一句：「我按一下，你告诉我哪些要截止、什么时候截止」。
 *   所以这里把三处数据（投递截止 / 岗位截止 / 笔面日程）统一算成一份带剩余天数的清单，
 *   UI 只负责分组展示，AI 只负责在这份清单上补一句人话总结。
 *
 * 关键取舍：**分类与排序全由规则决定，AI 不改数据**。
 * 日期算错一天、把已截止的当成还有时间，代价远大于「AI 不聪明」。
 */
import type { Application, CalEvent, JobPosting } from '../types';
import { daysUntil, sameCompanyLoose, STATUS_META } from './util';
import { isScheduledStage } from './appTimeline';

export type BriefBucket = 'overdue' | 'today' | 'd3' | 'd7' | 'later';

export interface BriefItem {
  key: string;
  /** app=投递截止，job=岗位截止，stage=笔试/面试/Offer 日程 */
  kind: 'app' | 'job' | 'stage';
  company: string;
  position?: string;
  label: string;
  date: string;
  time?: string;
  /** 距今天数：负数=已过 */
  days: number;
  bucket: BriefBucket;
  /**
   * 「对不上投递记录的日程」：邮件同步（或手工）建出来的、没有挂到任何投递记录上，
   * 或者挂的那个 appId 已经指向一条不存在的记录。
   * 这类条目往往是噪音源头，界面上单独成组，给用户一个批量清理的口子。
   */
  orphan: boolean;
  url?: string;
}

export interface DeadlineBrief {
  /** 全部条目，按日期升序（已过期的排在前面，因为最需要处理） */
  items: BriefItem[];
  buckets: Record<BriefBucket, BriefItem[]>;
  orphans: BriefItem[];
  /** 一句话概括，无 AI Key 时直接用它顶上 */
  summary: string;
  /** 喂给 AI 的清单文本（结构化、无冗余字段） */
  aiContext: string;
}

const bucketOf = (d: number): BriefBucket =>
  (d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 3 ? 'd3' : d <= 7 ? 'd7' : 'later');

/** 已收尾的投递状态：它们的截止与日程都不该再进清单 */
const CLOSED_STATUS: Application['status'][] = ['offer', 'reject'];

export function buildDeadlineBrief(
  data: { applications: Application[]; jobs: JobPosting[]; events: CalEvent[] },
  today: string,
): DeadlineBrief {
  const items: BriefItem[] = [];
  const apps = data.applications || [];
  const appById = new Map(apps.map((a) => [a.id, a]));

  /* ① 投递截止：只提醒还没提交的。已提交/笔试/面试/Offer/未通过都不再需要催 */
  for (const a of apps) {
    if (!a.deadline || !['todo', 'filling'].includes(a.status)) continue;
    const d = daysUntil(a.deadline);
    if (d === null) continue;
    items.push({
      key: `app-${a.id}`, kind: 'app', company: a.company, position: a.position,
      label: '网申截止', date: a.deadline, days: d, bucket: bucketOf(d), orphan: false, url: a.link,
    });
  }

  /* ② 岗位截止：没投递、没归档的才催；同单位已有提交过的投递记录也跳过 */
  const submittedCompanies = apps.filter((a) => ['submitted', 'test', 'interview', 'offer'].includes(a.status));
  for (const j of data.jobs || []) {
    if (!j.deadline || j.status === 'applied' || j.status === 'archived') continue;
    if (submittedCompanies.some((a) => sameCompanyLoose(a.company, j.company))) continue;
    const d = daysUntil(j.deadline);
    if (d === null) continue;
    items.push({
      key: `job-${j.id}`, kind: 'job', company: j.company, position: j.title,
      label: '岗位截止', date: j.deadline, days: d, bucket: bucketOf(d), orphan: false, url: j.url,
    });
  }

  /* ③ 笔试 / 面试 / Offer 日程：已完成的不算 */
  for (const e of data.events || []) {
    if (!e.date || e.done) continue;
    if (e.type === 'deadline' || e.type === 'todo') continue;
    if (!isScheduledStage(e.type as Application['status'])) continue;
    const d = daysUntil(e.date);
    if (d === null) continue;
    const app = e.appId ? appById.get(e.appId) : undefined;
    const orphan = !app;
    items.push({
      key: `ev-${e.id}`, kind: 'stage', company: app?.company || e.title, position: app?.position,
      label: STATUS_META[e.type]?.label || '日程', date: e.date, time: e.time,
      days: d, bucket: bucketOf(d), orphan,
    });
  }

  /* 排序：先按「越紧急越前」。已过期的最需要处理，所以排在今天之前；
     同为过期时，刚过期的在前（30 天前的陈年旧账放最后）。 */
  const rank = (b: BriefBucket) => ({ overdue: 0, today: 1, d3: 2, d7: 3, later: 4 })[b];
  items.sort((x, y) => {
    const r = rank(x.bucket) - rank(y.bucket);
    if (r !== 0) return r;
    if (x.bucket === 'overdue') return y.days - x.days;   // 过期越久越靠后
    return (x.date + (x.time || '')).localeCompare(y.date + (y.time || ''));
  });

  const buckets: Record<BriefBucket, BriefItem[]> = { overdue: [], today: [], d3: [], d7: [], later: [] };
  for (const it of items) buckets[it.bucket].push(it);
  const orphans = items.filter((i) => i.orphan);

  const parts: string[] = [];
  if (buckets.overdue.length) parts.push(`${buckets.overdue.length} 项已过期没处理`);
  if (buckets.today.length) parts.push(`今天 ${buckets.today.length} 项`);
  if (buckets.d3.length) parts.push(`3 天内 ${buckets.d3.length} 项`);
  if (buckets.d7.length) parts.push(`7 天内 ${buckets.d7.length} 项`);
  if (buckets.later.length) parts.push(`更远 ${buckets.later.length} 项`);
  const summary = parts.length ? parts.join(' · ') : '目前没有要赶的截止';

  const aiContext = [
    `今天：${today}`,
    ...items.slice(0, 40).map((i) => {
      const when = i.days < 0 ? `已过 ${-i.days} 天` : i.days === 0 ? '今天' : `${i.days} 天后`;
      return `- ${i.date}${i.time ? ' ' + i.time : ''}｜${i.label}｜${i.company}${i.position ? ' · ' + i.position : ''}｜${when}${i.orphan ? '｜无对应投递记录' : ''}`;
    }),
  ].join('\n');

  return { items, buckets, orphans, summary, aiContext };
}
