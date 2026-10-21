/**
 * 截止提醒：站内提醒中心 + 浏览器系统通知。
 *
 * 取舍说明：网页无法在关闭后主动唤醒用户（没有服务端推送），
 * 因此无法做「服务端定时推送」。这里用两条腿替代：
 *   1) 打开网站时的分级提醒横幅（今天 / 3 天内 / 7 天内）
 *   2) 浏览器系统通知（PWA 装到手机/桌面后同样生效），每天每档只提醒一次
 *   3) 需要真正的系统日历闹钟，用「导出 ICS」导入手机日历（带 -7d/-3d/-1d 闹钟）
 */
import type { JobPosting, Application, CalEvent, RemindConfig } from '../types';
import { daysUntil, fmtDate, sameCompanyLoose, mentionsCompany, companyKey, todayISO } from './util';

export type RemindLevel = 'overdue' | 'today' | 'urgent' | 'soon';

/** 真正需要去赴约的日程类型 —— 提醒条与日历页共用这一份定义，不许各写一套 */
export const APPOINTMENT_TYPES: CalEvent['type'][] = ['test', 'interview', 'offer'];
export const isAppointment = (type: CalEvent['type']) => APPOINTMENT_TYPES.includes(type);
export interface RemindItem {
  id: string;
  kind: 'job' | 'app' | 'event';
  /** 这条在提醒条上算什么：appointment=去赴约的日程 / deadline=岗位或投递的截止 / todo=待办。
   *  加这个字段的原因（2026-10-18）：用户反馈「日历还是很多很多」—— 根源之一是顶部提醒条
   *  把成千上万条导入的岗位截止当成「待处理事项」计数（实测「共 106 项」），
   *  而日历里那些截止根本不再显示，两处口径不一致。有了 kindOf，提醒条就能只对
   *  「真要去做的」计数，把海量岗位截止降级成一行汇总。 */
  kindOf: 'appointment' | 'deadline' | 'todo';
  company: string;
  title: string;
  date: string;
  days: number;
  level: RemindLevel;
  url?: string;
}

export const LEVEL_META: Record<RemindLevel, { label: string; cls: string }> = {
  overdue: { label: '已截止', cls: 'badge--muted' },
  today: { label: '今天截止', cls: 'badge--danger' },
  urgent: { label: '3 天内', cls: 'badge--warn' },
  soon: { label: '7 天内', cls: 'badge--info' },
};

/**
 * 提醒条目的稳定 id。
 *
 * 实体自身的 id 往往已带前缀（store 的 `uid('job')` 生成的就是 `job-xxx`），无条件再拼一次会得到
 * `job-job-xxx` / `ev-ev-xxx`；而这个 id 会被 `exporters.ts` 当作 ICS 的 UID 写进手机日历——
 * 语义脏，且部分日历客户端在重复导入时会把同一件事识别成两条。
 * 规则统一为「已有同名前缀就不再补」，导出侧必须用同一函数构造反查键。
 */
export const remindItemId = (kind: 'job' | 'app' | 'ev', id: string) => (id.startsWith(`${kind}-`) ? id : `${kind}-${id}`);

/**
 * 「已经收工的单位」—— 这家单位已经投了（或有记录进入笔试/面试/offer），
 * 那么它的**截止类**日程就不该再催：截止日的意义在提交那一刻就结束了。
 *
 * 为什么单独抽成函数：站内提醒条、日历页都用同一口径，
 * 各写一套一定会漂移（历史上「提醒条不催了、日历还在催」就是这么来的）。
 */
export function closedCompaniesOf(data: { jobs: JobPosting[]; applications: Application[] }): string[] {
  const appliedApps = (data.applications || [])
    .filter((a) => ['submitted', 'test', 'interview', 'offer'].includes(a.status));
  return [
    ...appliedApps.map((a) => a.company),
    ...data.jobs.filter((j) => j.status === 'applied' || j.status === 'archived').map((j) => j.company),
  ];
}

/**
 * 一条日历事件「现在还值不值得提醒」。日历页的「待办提醒」与顶部提醒条**共用**这一条判据。
 *
 * 规则只有四段，多一条都会让日历重新变乱：
 *   ① 已完成（done）→ 不提醒；
 *   ② 截止类（deadline）且该单位已经投了/归档了 → 不提醒（截止日的意义在提交那一刻结束）；
 *   ③ 笔试 / 面试 / Offer 这类**约定时间的日程**，即使已投递也**必须**提醒 ——
 *      它们正是投递之后真正要做的事，也是这个日历唯一有提醒价值的对象；
 *      连日期已过也要留着，那是「已经错过的」，必须让人看见；
 *   ④ 待办（todo）与其它事项只受 ① 约束，日期过了就不再占位。
 */
export function isEventActionable(e: CalEvent, closedCompanies: string[], now = todayISO()): boolean {
  if (e.done || !e.date) return false;
  if (e.type === 'deadline' && closedCompanies.some((c) => mentionsCompany(e.title, c))) return false;
  const passed = e.date < now;
  if (passed && (e.type === 'todo' || e.type === 'other' || e.type === 'deadline')) return false;
  return true;
}

export function collectReminders(
  data: { jobs: JobPosting[]; applications: Application[]; events: CalEvent[] },
  cfg?: Partial<RemindConfig>,
): RemindItem[] {
  const days = Math.max(1, ...(cfg?.days?.length ? cfg.days : [7]));
  const out: RemindItem[] = [];
  const level = (n: number): RemindLevel => (n < 0 ? 'overdue' : n === 0 ? 'today' : n <= 3 ? 'urgent' : 'soon');
  const itemId = remindItemId;

  /* 已投递的岗位不再提醒截止：截止日的意义在投递那一刻就结束了 */
  const appliedApps = (data.applications || [])
    .filter((a) => ['submitted', 'test', 'interview', 'offer'].includes(a.status));
  /* 「已经收工」的单位：已投递的投递记录 + 岗位库里已投递/已归档的岗位。
     它们的截止日事件（导入汇总表时自动写进日历的那种）也不该再催。
     口径统一由 closedCompaniesOf 提供，日历页用的是同一个函数。 */
  const closedCompanies = closedCompaniesOf(data);

  if (cfg?.includeJobs !== false) {
    for (const j of data.jobs) {
      const d = daysUntil(j.deadline);
      if (d === null || d > days) continue;
      if (j.status === 'applied' || j.status === 'archived') continue;   // 已投递 / 已归档
      if (appliedApps.some((a) => sameCompanyLoose(a.company, j.company))) continue;   // 兜底：该单位已有提交过的投递记录
      out.push({ id: itemId('job', j.id), kind: 'job', kindOf: 'deadline', company: j.company, title: j.title, date: j.deadline!, days: d, level: level(d), url: j.url });
    }
  }
  if (cfg?.includeApps !== false) {
    for (const a of data.applications) {
      const d = daysUntil(a.deadline);
      if (d === null || d > days) continue;
      // 只提醒「还没提交」的投递；已提交/笔试/面试/Offer/未通过都不再需要截止提醒
      if (!['todo', 'filling'].includes(a.status)) continue;
      out.push({ id: itemId('app', a.id), kind: 'app', kindOf: 'deadline', company: a.company, title: a.position, date: a.deadline!, days: d, level: level(d), url: a.link });
    }
  }
  if (cfg?.includeEvents !== false) {
    for (const e of data.events) {
      const d = daysUntil(e.date);
      if (d === null || d > days || e.done) continue;
      // 投递截止类事件：该单位已经投了/已归档，就不再提醒（面试、笔试等日程照常提醒）
      if (e.type === 'deadline' && closedCompanies.some((c) => mentionsCompany(e.title, c))) continue;
      const kindOf = isAppointment(e.type) ? 'appointment' as const : e.type === 'todo' ? 'todo' as const : 'deadline' as const;
      out.push({ id: itemId('ev', e.id), kind: 'event', kindOf, company: e.title, title: e.type === 'interview' ? '面试' : e.type === 'test' ? '笔试' : e.type === 'offer' ? 'Offer' : '日程', date: e.date, days: d, level: level(d) });
    }
  }

  /* 去重一（先做，趁岗位还是各自的原始条目，单位名的各种写法都还在）：
     导入汇总表 / 转入投递时会同时生成岗位（或投递）与同名截止事件，
     同一天、标题里点到同一家单位时只留岗位/投递那条，避免「一行岗位 + 一行日程」看着重复。 */
  const plain = out.filter((i) => i.kind !== 'event');
  /* 事件之间也要去重：重复导入同一份汇总表会写出多条**标题完全相同**的截止事件
     （`addEvents` 曾不去重，实测某次数据里 25 条事件各存了两份），
     不去重就会在提醒条里出现两行一模一样的「截止 · XX · …」。 */
  const seenEvent = new Set<string>();
  const events = out.filter((i) => i.kind === 'event')
    .filter((e) => !plain.some((b) => b.date === e.date && mentionsCompany(e.company, b.company)))
    .filter((e) => {
      const k = `${e.date}|${companyKey(e.company)}`;
      if (seenEvent.has(k)) return false;
      seenEvent.add(k);
      return true;
    });

  /* 同一单位同一天有多个岗位截止时并成一条（「中金公司 · 3 个岗位」），
     否则汇总表一导入，提醒条就被同一家单位刷屏；岗位明细仍在岗位追踪里看。
     单位按宽松比对（「深圳国际仲裁院 SCIA」与「深圳国际仲裁委员会」算一家）。 */
  const buckets: { date: string; company: string; list: RemindItem[] }[] = [];
  for (const it of out.filter((i) => i.kind === 'job')) {
    const hit = buckets.find((b) => b.date === it.date && sameCompanyLoose(b.company, it.company));
    if (hit) hit.list.push(it); else buckets.push({ date: it.date, company: it.company, list: [it] });
  }
  const jobs = buckets.map((b) => (b.list.length === 1
    ? b.list[0]
    : { ...b.list[0], id: `${b.list[0].id}+${b.list.length}`, title: `${b.list[0].title} 等 ${b.list.length} 个岗位` }));

  /* 去重二：同一单位同一天的「岗位截止」与「投递截止」是同一件事，只留岗位那条 */
  const apps = out.filter((i) => i.kind === 'app')
    .filter((a) => !jobs.some((j) => j.date === a.date && sameCompanyLoose(j.company, a.company)));

  return [...jobs, ...apps, ...events].sort((a, b) => a.days - b.days);
}

export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;

export async function ensureNotifyPermission(): Promise<boolean> {
  if (!notifySupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

const NOTIFIED_KEY = 'qz.notified';

/** 每天每档只推一次，避免每次打开网站都轰炸 */
export function fireNotifications(items: RemindItem[]): number {
  if (!notifySupported() || Notification.permission !== 'granted') return 0;
  /* 「今天」必须用本地日期：站内其余日期全是本地 YYYY-MM-DD，
     而 `toISOString()` 给的是 UTC 日期 —— 东八区 00:00–08:00 之间 UTC 还是前一天，
     于是同一批提醒会在早上 8 点后再弹一次（或跨日界整天不弹）。 */
  const today = todayISO();
  let sent: Record<string, string> = {};
  try { sent = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}'); } catch { /* ignore */ }
  let n = 0;
  for (const it of items) {
    if (it.days < 0) continue;
    const key = `${it.id}|${it.date}|${it.days}`;
    if (sent[key] === today) continue;
    try {
      new Notification(it.days === 0 ? `今天截止：${it.company}` : `${it.days} 天后截止：${it.company}`, {
        body: `${it.title} · ${fmtDate(it.date)}`,
        tag: key,
      });
      sent[key] = today;
      n++;
    } catch { /* 部分环境不支持构造 Notification */ }
  }
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(sent)); } catch { /* ignore */ }
  return n;
}
