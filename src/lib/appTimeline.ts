/**
 * 投递进度线 → 日历日程的派生。
 *
 * 背景（2026-10-20）：日历与投递记录原本各存一份，投递记录状态改成「面试」不会产生任何日程，
 * 用户只能去日历里手建一条日期默认"今天"、标题不含岗位的空事件，之后两边互不同步，
 * 于是「日历看不到投递记录里的信息」。
 *
 * 现在笔面日程的**唯一真源是投递记录的进度线**（`Application.timeline`）：
 * 这里把它投影成 CalEvent 交给日历渲染，日历上的编辑/删除再回写进度线。
 * 只派生不落库，所以不存在"两份数据谁对"的问题。
 */
import type { Application, AppStatus, CalEvent, TimelineEntry } from '../types';
import { STATUS_META, uid } from './util';

/** 需要占用日历格子的阶段：笔试 / 面试 / Offer（Offer 有签约截止的意味，同样要赴约） */
export const SCHEDULED_STATUS: AppStatus[] = ['test', 'interview', 'offer'];

export const isScheduledStage = (s: AppStatus) => SCHEDULED_STATUS.includes(s);

/** 派生事件 id：日历侧靠它反查出「哪个投递的哪个节点」 */
export const STAGE_EVENT_PREFIX = 'ev-stage-';
export const stageEventId = (appId: string, entryId: string) => `${STAGE_EVENT_PREFIX}${appId}--${entryId}`;
export const isStageEventId = (id: string) => id.startsWith(STAGE_EVENT_PREFIX);

/** 从派生事件 id 反解 (appId, entryId)；解不出返回 null */
export function parseStageEventId(id: string): { appId: string; entryId: string } | null {
  if (!isStageEventId(id)) return null;
  const body = id.slice(STAGE_EVENT_PREFIX.length);
  const at = body.indexOf('--');
  if (at < 0) return null;
  return { appId: body.slice(0, at), entryId: body.slice(at + 2) };
}

/** 节点在进度线上的稳定 id（老数据可能没有 id，用下标兜底，渲染与回写都走这一个函数） */
export const stageId = (t: TimelineEntry, idx: number) => t.id || `idx${idx}`;

/** 一条进度线节点 → 日历事件 */
function toEvent(app: Application, t: TimelineEntry, idx: number): CalEvent {
  const label = STATUS_META[t.status]?.label || t.status;
  return {
    id: stageEventId(app.id, stageId(t, idx)),
    title: `${app.company} · ${app.position} · ${label}`,
    date: t.at,
    time: t.time,
    type: t.status as CalEvent['type'],
    appId: app.id,
    note: t.note || undefined,
    place: t.place || undefined,
    source: 'application',
    done: !!t.done,
  };
}

/**
 * 所有投递记录里需要进日历的节点。
 *
 * 只收有日期的节点 —— 进度线上允许存在"只知道过了笔试、但没记哪天"的节点，
 * 那种节点不该在日历上编一个日期出来。
 */
export function deriveStageEvents(apps: Application[]): CalEvent[] {
  const out: CalEvent[] = [];
  for (const app of apps) {
    const line = Array.isArray(app.timeline) ? app.timeline : [];
    line.forEach((t, idx) => {
      if (!t.at || !isScheduledStage(t.status)) return;
      out.push(toEvent(app, t, idx));
    });
  }
  return out;
}

/** 某个投递记录里「下一次要赴的约」（未完成、日期不早于今天的笔试/面试/Offer） */
export function nextStageOf(app: Application, today: string): { entry: TimelineEntry; at: string } | null {
  const line = Array.isArray(app.timeline) ? app.timeline : [];
  const up = line
    .filter((t) => isScheduledStage(t.status) && t.at && !t.done)
    .sort((a, b) => (a.at + (a.time || '')).localeCompare(b.at + (b.time || '')));
  const hit = up.find((t) => t.at >= today) || up[0];
  return hit ? { entry: hit, at: hit.at } : null;
}

/**
 * v7 迁移：把「挂得上投递记录」的笔面/Offer 日历事件折进该记录的进度线，
 * 并把它们从 events 里摘出来。
 *
 * 为什么必须折：迁移后日历上的笔面日程是**从进度线派生**的，若旧事件还留在 events 里，
 * 同一个面试会在日历上出现两条（一条派生、一条旧的）。归档进进度线则信息不丢：
 * 日期、时间、备注都搬过去，只是换了真源。
 *
 * 摘不掉的一律原样保留 —— 投递记录已被删掉的事件、手工建的独立日程，都不能跟着消失。
 *
 * 幂等：重复执行时，第二次已经没有可折的事件了（第一次已把它们移出 events），
 * 补 id 也是「有则不动」，所以老数据被反复加载不会持续变形。
 */
export function foldStageEventsIntoApps(
  apps: Application[],
  events: CalEvent[],
): { applications: Application[]; events: CalEvent[]; folded: number } {
  let folded = 0;
  const migrated = (apps || []).map((a) => ({
    ...a,
    timeline: (Array.isArray(a.timeline) ? a.timeline : []).map((t) => ({
      ...t,
      id: t.id || uid('stg'),
      done: t.done ?? true,
    })),
  }));
  const byId = new Map(migrated.map((a) => [a.id, a]));
  const keep: CalEvent[] = [];

  for (const e of events || []) {
    const app = e.appId ? byId.get(e.appId) : undefined;
    if (!app || !isScheduledStage(e.type as AppStatus) || !e.date) { keep.push(e); continue; }
    const hit = app.timeline.find((t) => t.status === e.type && t.at === e.date);
    if (hit) {
      /* 同一天同一阶段已有节点：只补缺失信息，不再加一条重复节点 */
      if (!hit.time && e.time) hit.time = e.time;
      if (!hit.place && e.place) hit.place = e.place;
      if (e.note && !hit.note) hit.note = e.note;
      if (e.done) hit.done = true;
    } else {
      app.timeline.push({
        id: uid('stg'),
        status: e.type as AppStatus,
        at: e.date,
        time: e.time,
        place: e.place,
        note: e.note,
        done: !!e.done,
      });
    }
    folded++;
  }

  /* 折叠进来的节点按日期落回正确位置（稳定排序：同日保持原有先后） */
  for (const a of migrated) {
    a.timeline = a.timeline
      .map((t, i) => ({ t, i }))
      .sort((x, y) => (x.t.at || '').localeCompare(y.t.at || '') || x.i - y.i)
      .map((x) => x.t);
  }

  return { applications: migrated, events: keep, folded };
}
