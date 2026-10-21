/**
 * 日历「接下来要做的」选件与排序 —— 唯一口径在这里。
 *
 * ⚠️ 2026-10-20 两轮修正的沉淀：
 *   ① 第一批外来日程（邮件同步、导入汇总表）过期超过 3 天就收进「已结束」折叠区。
 *      此前「过期的也留」，实测 9 条「已过 30 天」的笔试通知堆在顶部，把真正临近的事压没了。
 *   ② 但这条 3 天窗口**不能套到投递记录自己的笔面试上**。用户原话：
 *      「把投递记录的笔面试时间要呈现在日历待办里」—— 他上周在进度线里填的那场笔试
 *      日期是 7 天前，一过 3 天就被扫进折叠区，看起来像「填了但没保存成功」。
 *      所以 `ev-stage-*` 派生出来的事件单独放行：那是自己记的、有明确归属的日程，
 *      没标「已赴约」就一直摆在待办里，过期只用红色「已过 N 天」提示。
 *
 * 排序同样是踩过的坑：原先所有过期项统一压成 -1 排序键，导致**最老的一条排在今天上面**。
 * 现在未来在前（升序），过期的在后（越近越靠前）。
 */
import type { CalEvent } from '../types';
import { fromISO } from './util';
import { APPOINTMENT_TYPES } from './remind';
import { isStageEventId } from './appTimeline';

/** 外来日程过期多少天后收进「已结束」：窗口要短，否则陈年旧账会把顶部占满 */
export const AGENDA_GRACE_DAYS = 3;

export const daysBetween = (iso: string, today: string): number =>
  Math.round((fromISO(iso).getTime() - fromISO(today).getTime()) / 86400000);

/** 一条事件该不该进「接下来要做的」 */
export function isAgendaEvent(e: CalEvent, today: string): boolean {
  if (!e.date) return false;
  const d = daysBetween(e.date, today);
  // 投递记录投影出来的笔面试：自己记的，未完成就一直留着
  if (isStageEventId(e.id)) return true;
  // 其它约定日程：过期 3 天内还给一次回顾机会（可能刚考完、可能改期了）
  if (APPOINTMENT_TYPES.includes(e.type)) return d >= -AGENDA_GRACE_DAYS;
  // 待办 / 事项：只收今天的和未来的
  return d >= 0;
}

/** 未来在前按日期升序；过期的在后，越近越靠前；同日按时间 */
export function sortAgenda(list: CalEvent[], today: string): CalEvent[] {
  return [...list].sort((a, b) => {
    const da = daysBetween(a.date, today);
    const db = daysBetween(b.date, today);
    const pa = da < 0;
    const pb = db < 0;
    if (pa !== pb) return pa ? 1 : -1;
    if (pa) return db - da;
    if (da !== db) return da - db;
    return (a.time || '99').localeCompare(b.time || '99');
  });
}

export function buildAgenda(events: CalEvent[], today: string): CalEvent[] {
  return sortAgenda(events.filter((e) => isAgendaEvent(e, today)), today);
}
