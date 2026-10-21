import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import type { Application, AppStatus, CalEvent, EventType } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal, Empty } from '../ui/Kit';
import { cn, uid, toISO, fromISO, todayISO, fmtDate, deadlineLabel, sameCompanyLoose } from '../../lib/util';
import { closedCompaniesOf, isEventActionable, APPOINTMENT_TYPES } from '../../lib/remind';
import { parseStageEventId, isStageEventId } from '../../lib/appTimeline';
import { buildAgenda } from '../../lib/agenda';
import { DeadlineBriefModal } from '../ui/DeadlineBrief';

/**
 * 日历追踪。
 *
 * ⚠️ 2026-10-17 重做「待办提醒」：此前右侧「待办清单」把**所有** todo 事件平铺，
 * 而主区「近期安排」又把**所有**未来事件再列一遍（含导入汇总表时批量写进来的截止日、
 * 已投递单位的截止事件）—— 同一批东西在三个地方各出现一次，日历和清单互相刷屏，
 * 结果最该被看见的「笔试 / 面试在哪天」被淹掉，日历失去提醒作用。
 *
 * 现在的口径（只有一套判据，见 lib/remind.ts 的 `isEventActionable`）：
 *   · 日志区只放**真正要去做的事**：笔试、面试、Offer（约定时间的日程），以及还没完成的待办；
 *     已投递单位的截止日不再进日志区（截止在提交那一刻就结束了）。
 *   · 月视图**只画约定日程与待办**（deadline 整类不进日历，见 shownEvents）。
 *   · 「已结束」折叠区：过了日期或已完成的日程/待办塞进去，默认收起，不占视线但可翻回。
 *
 * ⚠️ 2026-10-20 打通「投递记录 → 日历」：笔试/面试/Offer 的日程**不再各自存一份**。
 * 唯一真源是投递记录的进度线（`Application.timeline`，见 lib/appTimeline.ts），
 * 日历只做投影；在这里改时间/地点会回写进度线，在这里删掉也会从进度线上删掉。
 * 之前两边各存一份、互不同步，才会出现「投递记录里写着面试，日历里什么都没有」。
 */

const DOW = ['一', '二', '三', '四', '五', '六', '日'];
/* `k` = 格内单字缩写。桌面上月视图每格只有 ~130px，一行放不下「面试 14:00 某国有银行」，
   所以先给类型一个固定宽度、带底色的单字块：扫一眼就知道这天是笔试还是面试，
   标题放不下就截断，但类型判断不受影响。 */
const TYPE_META: Record<EventType, { label: string; cls: string; k: string }> = {
  deadline: { label: '截止', cls: 'ev-deadline', k: '截' },
  interview: { label: '面试', cls: 'ev-interview', k: '面' },
  test: { label: '笔试', cls: 'ev-test', k: '笔' },
  offer: { label: 'Offer', cls: 'ev-offer', k: 'O' },
  todo: { label: '待办', cls: 'ev-todo', k: '待' },
  other: { label: '事项', cls: 'ev-other', k: '事' },
};

/* 约定日程类型来自 lib/remind.ts 的唯一真源（提醒条用同一份），此处不再重复定义 */

function monthMatrix(year: number, month: number) {
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(year, month, 1 - startDow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  return cells;
}

const emptyEvent = (date: string): Partial<CalEvent> => ({ title: '', date, time: '', type: 'other', note: '', source: 'manual' });

/** 距今天数：0=今天，1=明天，负数=已过 */
const daysFrom = (iso: string) => Math.round((fromISO(iso).getTime() - fromISO(todayISO()).getTime()) / 86400000);

/** 「今天 / 明天 / 3 天后 / 9月28日 周一」这种人话日期，比裸日期更容易一眼判断该做什么 */
function relLabel(iso: string): string {
  const d = daysFrom(iso);
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  if (d === 2) return '后天';
  if (d > 0 && d <= 7) return `${d} 天后`;
  if (d < 0) return `已过 ${-d} 天`;   // 例：已过 2 天（原来的「已过期 2 天」读起来像错字）
  return fmtDate(iso);
}

export default function Calendar() {
  /* allEvents（store 提供的合并视图）= 手工事件 + 投递进度线投影；
     用 events 会漏掉笔试/面试 —— 它们已经不在 events 里了。 */
  const { allEvents, applications, jobs, addEvent, updateEvent, removeEvent,
    updateStage, removeStage, toast, storageKey, setView } = useStore();
  const today = new Date();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  /* 默认选中今天：日历打开就该先说清「今天有什么」，而不是等用户先点一个日期。
     点其它日期会换到那一天；详情区一直有内容，页面不会跳。 */
  const [selected, setSelected] = useState<string | null>(todayISO());
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [creating, setCreating] = useState<Partial<CalEvent> | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [showBrief, setShowBrief] = useState(false);

  const todayIso = todayISO();

  /* 已投递/已归档单位：截止类事件据此判「还要不要催」 */
  const closed = useMemo(() => closedCompaniesOf({ jobs, applications }), [jobs, applications]);

  const appById = useMemo(() => new Map(applications.map((a) => [a.id, a])), [applications]);

  const cells = useMemo(() => monthMatrix(cursor.y, cursor.m), [cursor]);

  /**
   * 日历上**只放约定日程**（笔试 / 面试 / Offer）与手工记的待办事项。
   *
   * ⚠️ 2026-10-18 按用户要求收紧：大范围导入汇总表会在 events 里写进**成千上万条**
   * 「截止 · 某单位 · 某岗」的 deadline 事件（实测某月单日 +66 条）。这些是**岗位信息**，
   * 属于岗位库/网申的范畴，不是日程 —— 它们把日历糊成一片色块，真正的笔试/面试反而看不见。
   * 所以从这一版起：
   *   · `deadline` 类型**一律不进日历**（月视图也不进）。要看网申截止，去岗位库或右侧
   *     「还没提交的投递截止」卡片 —— 那里才是它该待的地方；
   *   · 保留：笔试 / 面试 / Offer（约定时间，必须赴约）、待办、以及用户自己记的「事项」；
   *   · 再叠加 `isEventActionable`：已完成的不显示，过期待办不显示。
   *
   * 用户原话：「我要求只呈现我投递记录里的笔面试」。
   */
  const shownEvents = useMemo(
    () => allEvents.filter((e) => e.type !== 'deadline' && isEventActionable(e, closed, todayIso)),
    [allEvents, closed, todayIso],
  );

  /** 月视图只画 shownEvents；其余事件完全不进格子。 */
  const byDate = useMemo(() => {
    const map: Record<string, CalEvent[]> = {};
    shownEvents.forEach((e) => { (map[e.date] ||= []).push(e); });
    Object.values(map).forEach((arr) => arr.sort((a, b) => (a.time || '99').localeCompare(b.time || '99')));
    return map;
  }, [shownEvents]);

  /**
   * 「接下来要做的」—— 按时间排的日志，不是事件列表。
   * 选件与排序的唯一口径抽到了 `lib/agenda.ts`（能被回归测试覆盖），这里只负责取数据：
   *   · 投递记录的笔面试（`ev-stage-*` 派生）：未完成就一直留着，过期只加红标记
   *   · 其它约定日程：未过期的进，过期 3 天内的也给一次回顾机会
   *   · 待办 / 事项：只收今天与未来
   * 顺序：未来在前按日期升序，过期的在后且越近越靠前（原先所有过期项压成同一个键，
   * 结果最老的一条排到了今天上面）。
   */
  const agenda = useMemo(() => buildAgenda(shownEvents, todayIso), [shownEvents, todayIso]);

  /**
   * 已结束：过期或已完成的约定日程 / 待办 / 事项。
   * 刻意**不含 deadline** —— 截止本来就不进日历（见 shownEvents 的说明），
   * 塞进折叠区只会让这个按钮又变成一个装满几千条岗位信息的抽屉。
   */
  const closedItems = useMemo(() => {
    const upcoming = new Set(agenda.map((e) => e.id));
    return allEvents.filter((e) => e.type !== 'deadline' && !upcoming.has(e.id))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [allEvents, agenda]);

  /* 投递截止提醒：只留「还没提交」的（已提交/笔试/面试/Offer/未通过都不再需要催） */
  const deadlines = useMemo(() => {
    return applications
      .filter((a) => a.deadline && a.deadline >= todayIso && ['todo', 'filling'].includes(a.status))
      .sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''))
      .slice(0, 6);
  }, [applications, todayIso]);

  const goToday = () => setCursor({ y: today.getFullYear(), m: today.getMonth() });
  const shift = (d: number) => setCursor((c) => { const nm = c.m + d; return { y: c.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }; });

  const monthLabel = `${cursor.y} 年 ${cursor.m + 1} 月`;
  const selectedEvents = selected ? byDate[selected] || [] : [];

  /* 笔试 / 面试撞车检测：只统计还没过期的约定日程 ——
     已经考完/面完的日子再报「冲突」纯属噪音。 */
  const conflicts = useMemo(() => {
    const byDay = new Map<string, CalEvent[]>();
    for (const e of allEvents) {
      if (e.done || !APPOINTMENT_TYPES.includes(e.type)) continue;
      if (e.date < todayIso) continue;
      byDay.set(e.date, [...(byDay.get(e.date) || []), e]);
    }
    const out: { date: string; items: CalEvent[]; sameTime: boolean }[] = [];
    byDay.forEach((items, date) => {
      if (items.length < 2) return;
      const times = items.map((i) => i.time).filter(Boolean) as string[];
      out.push({ date, items, sameTime: new Set(times).size < times.length });
    });
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }, [allEvents, todayIso]);

  /* 今日/本周统计：日志区顶部一句话说清「这几天到底有几件事」
     过期数按 shownEvents 统计（而不是 agenda）—— agenda 只收近 3 天的过期，
     但角标要告诉用户「一共错过了多少」，点进去能看到全部。 */
  const stats = useMemo(() => {
    const todays = agenda.filter((e) => e.date === todayIso);
    const week = agenda.filter((e) => { const d = daysFrom(e.date); return d >= 0 && d <= 7; });
    const overdue = shownEvents.filter((e) => daysFrom(e.date) < 0 && APPOINTMENT_TYPES.includes(e.type));
    return { todays, week, overdue };
  }, [agenda, shownEvents, todayIso]);

  const markDone = (e: CalEvent) => {
    /* 派生事件的完成状态存在投递记录的进度线节点上，不写 events */
    const parsed = parseStageEventId(e.id);
    if (parsed) updateStage(parsed.appId, parsed.entryId, { done: true });
    else updateEvent(e.id, { done: true });
    toast(`已完成：${e.title}`, 'info');
  };

  const renderRow = (e: CalEvent, opts: { showDone?: boolean } = {}) => {
    const d = daysFrom(e.date);
    const passed = d < 0;
    return (
      <div className={cn('list-row', passed && 'cal-agenda__row--passed')} key={e.id}
        style={{ padding: '9px 10px', cursor: 'pointer', alignItems: 'flex-start' }} onClick={() => setEditing(e)}>
        <span className="col" style={{ alignItems: 'center', minWidth: 46, flexShrink: 0 }}>
          <span className="tx-3" style={{ fontSize: 10.5 }}>{fromISO(e.date).getMonth() + 1}月</span>
          <span className="h-sub">{fromISO(e.date).getDate()}</span>
        </span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="truncate" style={{ fontSize: 13, fontWeight: 600, display: 'block', textDecoration: e.done ? 'line-through' : undefined }}>
            {e.title}
          </span>
          <span className="row gap-6 wrap" style={{ marginTop: 3 }}>
            <span className={cn('cal__ev', TYPE_META[e.type].cls)} style={{ padding: '0 7px', fontSize: 10 }}>{TYPE_META[e.type].label}</span>
            {e.time && <span className="tx-4" style={{ fontSize: 11 }}>{e.time}</span>}
            <span className={cn('badge', passed ? 'badge--danger' : d === 0 ? 'badge--warn' : 'badge--muted')} style={{ fontSize: 10 }}>
              {relLabel(e.date)}
            </span>
            {e.place && <span className="tx-4 truncate" style={{ fontSize: 11, maxWidth: 180 }}>{e.place}</span>}
            {e.note && <span className="tx-4 truncate" style={{ fontSize: 11, maxWidth: 220 }}>{e.note}</span>}
            {/* 标明来源：这条不是手工建的日程，而是投递记录进度线投影出来的，随手删会连投递记录一起删 */}
            {isStageEventId(e.id) && (
              <span className="tx-4" style={{ fontSize: 10.5 }}>· 来自投递记录</span>
            )}
          </span>
        </span>
        {opts.showDone && !e.done && (
          <button className="copy-btn" style={{ flexShrink: 0 }}
            onClick={(ev) => { ev.stopPropagation(); markDone(e); }}>完成</button>
        )}
      </div>
    );
  };

  /* 格内最多显示 2 条事件，其余收成 +N；手机上退化成「按类型分色的点」。 */
  const chipClass = (t: EventType) => cn('calv-ev', TYPE_META[t].cls);

  return (
    <div className="calv">
      {/* ---- 页头：标题 + 月份切换 + 动作 ---- */}
      <header className="calv-head">
        <div className="calv-head__l">
          <h1 className="calv-head__t">日历追踪</h1>
          <div className="calv-head__d">只显示笔试 / 面试 / Offer 与待办 · 网申截止去「岗位库」看，不在日历里</div>
        </div>
        <div className="row gap-8 wrap" style={{ alignItems: 'center' }}>
          <div className="calv-month">
            <button className="calv-month__nav" onClick={() => shift(-1)} aria-label="上月">
              <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="chevronR" size={14} /></span>
            </button>
            <button className="calv-month__today" onClick={goToday}>今天</button>
            <button className="calv-month__nav" onClick={() => shift(1)} aria-label="下月">
              <Icon name="chevronR" size={14} />
            </button>
            <span className="calv-month__label">{monthLabel}</span>
          </div>
          <div className="calv-head__acts">
            <Button size="sm" icon="sparkles" onClick={() => setShowBrief(true)}>AI 梳理截止</Button>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(emptyEvent(todayISO()))}>新增事件</Button>
          </div>
        </div>
      </header>

      {/* ---- 一行统计：这几天到底有几件事 ---- */}
      <div className="calv-stat">
        <span>今天<b>{stats.todays.length}</b></span>
        <span>7 天内<b>{stats.week.length}</b></span>
        {stats.overdue.length > 0 && (
          <span className="calv-stat__bad">
            已错过的笔试面试<b>{stats.overdue.length}</b>
          </span>
        )}
        {conflicts.length > 0 && (
          <span className="calv-stat__warn">
            <span style={{ display: 'inline-flex', verticalAlign: -2, marginRight: 4 }}><Icon name="alert" size={13} /></span>
            撞车<b>{conflicts.length}</b> 天
          </span>
        )}
        <button className="calv-stat__btn" onClick={() => setShowBrief(true)}>看全部待办与截止 ›</button>
      </div>

      <div className="calv-body">
        {/* ---- 月视图 ---- */}
        <div className="calv-main">
          {/* 图例放在月视图上方而不是下方：手机上把月视图滑到眼前时，图例就在旁边，不用再滑回去对照 */}
          <div className="calv-legend">
            {Object.entries(TYPE_META)
              .filter(([k]) => k !== 'deadline')          // 截止不进日历，图例也不列它
              .map(([k, v]) => (
                <span key={k} className="calv-legend__i">
                  <b className={cn('calv-ev__k', v.cls)}>{v.k}</b>
                  {v.label}
                </span>
              ))}
            <span className="calv-legend__hint">双击日期可新增 · 网申截止不进日历</span>
          </div>
          <div className="calv-grid">
            <div className="calv-dow">
              {DOW.map((d, i) => <span key={d} className={i >= 5 ? 'is-weekend' : undefined}>{d}</span>)}
            </div>
            <div className="calv-cells">
              {cells.map((d) => {
                const iso = toISO(d);
                const out = d.getMonth() !== cursor.m;
                const evs = byDate[iso] || [];
                const isToday = iso === todayIso;
                return (
                  <div key={iso}
                    className={cn('calv-cell', out && 'calv-cell--out', isToday && 'calv-cell--today', selected === iso && 'calv-cell--sel')}
                    onClick={() => setSelected(iso)} onDoubleClick={() => setCreating(emptyEvent(iso))}>
                    <span className="calv-cell__num">{d.getDate()}</span>
                    {evs.slice(0, 2).map((e) => (
                      <span key={e.id} className={chipClass(e.type)} title={`${TYPE_META[e.type].label}${e.time ? ' ' + e.time : ''} ${e.title}`}
                        onClick={(ev) => { ev.stopPropagation(); setEditing(e); }}>
                        <b className={cn('calv-ev__k', TYPE_META[e.type].cls)}>{TYPE_META[e.type].k}</b>
                        <span className="calv-ev__t">{e.title}</span>
                        {e.time && <span className="calv-ev__time">{e.time}</span>}
                      </span>
                    ))}
                    {evs.length > 2 && <span className="calv-more">+{evs.length - 2} 项</span>}
                    {evs.length > 0 && (
                      <span className="calv-cell__dots">
                        {/* 第一个事件显示成类型缩写块（和桌面端同一套字形），其余用圆点；
                            这样手机上不点开也知道「21 号是面试、22 号是笔试」 */}
                        <b className={cn('calv-ev__k', TYPE_META[evs[0].type].cls)}>{TYPE_META[evs[0].type].k}</b>
                        {evs.slice(1, 4).map((e) => <i key={e.id} className={TYPE_META[e.type].cls} />)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ---- 右栏：接下来要做的 / 待办 / 还没提交的截止 ---- */}
        <aside className="calv-side">
          <section className="dash-sect">
            <div className="dash-sect__h">
              接下来要做的
              <em>{agenda.length} 项</em>
              <button className="dash-sect__more" onClick={() => setSelected(todayIso)}>今天 ›</button>
            </div>
            {agenda.length === 0 ? (
              <div className="dash-sect__none">近期没有要赴约的日程</div>
            ) : (
              <div className="col">
                {agenda.slice(0, 8).map((e) => {
                  const dd = daysFrom(e.date);
                  const passed = dd < 0;
                  return (
                    <div key={e.id} className={cn('calv-item', dd === 0 && 'calv-item--today', dd > 0 && dd <= 2 && 'calv-item--soon', passed && 'calv-item--passed')}
                      onClick={() => setEditing(e)}>
                      <span className="calv-item__d">
                        <span className="calv-item__m">{fromISO(e.date).getMonth() + 1}月</span>
                        <span className="calv-item__n">{fromISO(e.date).getDate()}</span>
                      </span>
                      <span className="calv-item__b">
                        <span className="calv-item__t" style={e.done ? { textDecoration: 'line-through', color: 'var(--tx-3)' } : undefined}>{e.title}</span>
                        <span className="calv-item__meta">
                          <span className={chipClass(e.type)} style={{ height: 15, lineHeight: '15px', padding: '0 5px', fontSize: 9.5 }}>{TYPE_META[e.type].label}</span>
                          {e.time && <span>{e.time}</span>}
                          <span>{relLabel(e.date)}</span>
                          {e.place && <span className="truncate" style={{ maxWidth: 110 }}>{e.place}</span>}
                        </span>
                      </span>
                      {/* 已完成/已过期的条目不挂「完成」按钮：已经完成的东西再点一次「完成」是矛盾的，
                          改成静默的对勾，只用来说明状态 */}
                      {e.done
                        ? <span className="calv-item__ok" title="已完成"><Icon name="check" size={11} strokeWidth={3} /></span>
                        : <button className="calv-item__done" onClick={(ev) => { ev.stopPropagation(); markDone(e); }}>完成</button>}
                    </div>
                  );
                })}
                {agenda.length > 8 && (
                  <button className="copy-btn" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => setSelected(agenda[8].date)}>
                    还有 {agenda.length - 8} 项，跳到 {fmtDate(agenda[8].date)} ›
                  </button>
                )}
              </div>
            )}
          </section>

          <TodoCard />

          {/* ---- 投递截止提醒：只提醒还没提交的 ---- */}
          {deadlines.length > 0 && (
            <section className="dash-sect">
              <div className="dash-sect__h">还没提交的投递截止<em>{deadlines.length} 条</em></div>
              <div className="col">
                {deadlines.map((a) => {
                  const dl = deadlineLabel(a.deadline);
                  return (
                    <div className="calv-item" key={a.id} style={{ cursor: 'default' }}>
                      <span className="calv-item__b">
                        <span className="calv-item__t">{a.company} · {a.position}</span>
                        <span className="calv-item__meta">
                          <span className={cn('badge', dl.cls)} style={{ fontSize: 10 }}>{dl.text}</span>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </aside>
      </div>

      {/* ---- 选中日详情：跨全宽放在月视图下方，不挤在 340px 窄栏里 ---- */}
      {selected && (
        <div className="calv-day">
          <div className="calv-day__h">
            <span className="calv-day__t">{fmtDate(selected)}</span>
            <span className="calv-day__rel">{relLabel(selected)}</span>
            <span className="calv-day__acts">
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setCreating(emptyEvent(selected))}>这天加一条</Button>
            </span>
          </div>
          {selectedEvents.length === 0 ? (
            <div className="calv-day__none">当日暂无事件 · 双击日期格或点右上「新增事件」即可安排</div>
          ) : (
            <div className="col">
              {selectedEvents.map((e) => (
                <div className="calv-day__row" key={e.id} onClick={() => setEditing(e)}>
                  <span className="calv-day__time">{e.time || '全天'}</span>
                  <span className="calv-day__main">
                    <span className="calv-day__title">{e.title}</span>
                    <span className="calv-day__meta">
                      <span className={cn('calv-day__kind', TYPE_META[e.type].cls)}>{TYPE_META[e.type].label}</span>
                      {e.place && <span>{e.place}</span>}
                      {e.note && <span className="truncate" style={{ maxWidth: 320 }}>{e.note}</span>}
                      {/* 标明来源：这条不是手工建的日程，而是投递记录进度线投影出来的，随手删会连投递记录一起删 */}
                      {isStageEventId(e.id) && <span>· 来自投递记录</span>}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- 时间冲突：只在真的有撞车时出现 ---- */}
      {conflicts.length > 0 && (
        <div className="calv-day" style={{ borderColor: 'rgba(255,180,80,.35)' }}>
          <div className="calv-day__h">
            <span className="calv-day__t">
              <span style={{ display: 'inline-flex', verticalAlign: -2, marginRight: 6 }}><Icon name="alert" size={14} /></span>
              时间冲突 · {conflicts.length} 天内有撞车
            </span>
            <span className="calv-day__rel" style={{ color: 'var(--warn)' }}>银行统一笔试常集中在同一周甚至同一天</span>
          </div>
          {conflicts.map((c) => (
            <div className="calv-day__row" key={c.date} onClick={() => setSelected(c.date)}>
              <span className="calv-day__time" style={{ color: 'var(--warn)' }}>{relLabel(c.date)}</span>
              <span className="calv-day__main">
                <span className="calv-day__title">{c.items.map((i) => `${i.time ? i.time + ' ' : ''}${i.title}`).join('　|　')}</span>
                <span className="calv-day__meta">
                  {c.sameTime ? <span>同一时段，需协调改期或安排设备</span> : <span>同一天，注意赶场时间</span>}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ---- 已结束：默认收起，不占视线但可翻回 ---- */}
      {closedItems.length > 0 && (
        <div className="calv-day">
          <div className="calv-day__h" style={{ cursor: 'pointer' }} onClick={() => setShowClosed((v) => !v)}>
            <span className="calv-day__t">
              <span style={{ display: 'inline-flex', verticalAlign: -1, marginRight: 5 }}><Icon name={showClosed ? 'chevron' : 'chevronR'} size={13} /></span>
              已结束 / 不提醒
            </span>
            <span className="calv-day__rel" style={{ color: 'var(--tx-3)' }}>{closedItems.length} 项</span>
            <span className="tx-4" style={{ marginLeft: 'auto', fontSize: 11 }}>
              {showClosed ? '收起' : '已完成的待办、已过期的笔试面试都在这里'}
            </span>
          </div>
          {showClosed && (
            <div className="col fade">
              {closedItems.slice(0, 40).map((e) => (
                <div className="calv-day__row" key={e.id} onClick={() => setEditing(e)}>
                  <span className="calv-day__time tx-4" style={{ color: 'var(--tx-4)' }}>{fmtDate(e.date).slice(5)}</span>
                  <span className="calv-day__main">
                    <span className="calv-day__title" style={{ color: 'var(--tx-3)', textDecoration: e.done ? 'line-through' : undefined }}>{e.title}</span>
                  </span>
                  <span className="calv-day__meta">
                    <span className={cn('calv-day__kind', TYPE_META[e.type].cls)} style={{ opacity: .6 }}>{TYPE_META[e.type].label}</span>
                  </span>
                </div>
              ))}
              {closedItems.length > 40 && <span className="tx-4" style={{ fontSize: 11, padding: '8px 0' }}>仅显示最近 40 条，更早的可在月视图里翻</span>}
            </div>
          )}
        </div>
      )}

      {/* create */}
      {creating && (
        <EventModal data={creating} onClose={() => setCreating(null)}
          onSave={(e) => { addEvent(e as CalEvent); setCreating(null); toast('已添加日历事件'); }} />
      )}
      {editing && (
        <EventModal data={editing} onClose={() => setEditing(null)}
          derived={isStageEventId(editing.id)}
          app={editing.appId ? appById.get(editing.appId) : undefined}
          onOpenApp={editing.appId ? () => {
            const a = appById.get(editing.appId!);
            setView('applications');
            setEditing(null);
            toast(a ? `已跳到投递记录：搜索「${a.company}」即可打开这条记录` : '已跳到投递记录', 'info');
          } : undefined}
          onSave={(e) => {
            const parsed = parseStageEventId(editing.id);
            if (parsed) {
              /* 派生事件：写回投递记录的进度线，日历这边不落库 */
              updateStage(parsed.appId, parsed.entryId, {
                status: (e.type as AppStatus) || 'interview',
                at: e.date || editing.date,
                time: e.time, place: e.place, note: e.note, done: e.done,
              });
              toast('已写回投递记录的进度线');
            } else {
              updateEvent(editing.id, e);
              toast('已更新事件');
            }
            setEditing(null);
          }}
          onDelete={() => {
            const parsed = parseStageEventId(editing.id);
            if (parsed) { removeStage(parsed.appId, parsed.entryId); toast('已从投递进度线删除该节点', 'info'); }
            else { removeEvent(editing.id); toast('已删除事件', 'info'); }
            setEditing(null);
          }} />
      )}

      {/* 「AI 梳理截止」：一按就出「哪些要截止、何时截止」，清单是规则算的，AI 只补一句人话 */}
      {showBrief && <DeadlineBriefModal onClose={() => setShowBrief(false)} />}
    </div>
  );
}

/**
 * 待办清单：只放**未完成**的。
 *
 * 为什么不再平铺全部：原先已完成的和过期的也排在列表里，待办一多就把「还剩几件」淹没；
 * 而「接下来要做的」和「已结束」已经分别承担了「今天做什么」与「翻旧账」两个需求。
 */
function TodoCard() {
  const { events, addEvent, updateEvent, removeEvent, toast } = useStore();
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayISO());
  const t = todayISO();

  const pending = useMemo(() => events
    .filter((e) => e.type === 'todo' && !e.done && e.date >= t)
    .sort((a, b) => a.date.localeCompare(b.date)), [events, t]);
  const doneCount = useMemo(() => events.filter((e) => e.type === 'todo' && (e.done || e.date < t)).length, [events, t]);

  const quickAdd = () => {
    if (!text.trim()) return;
    addEvent({ title: text.trim(), date, type: 'todo', source: 'manual', done: false });
    setText('');
    toast('已添加待办');
  };

  return (
    <section className="dash-sect calv-todo">
      <div className="dash-sect__h">
        待办
        <em>{pending.length} 项未完成</em>
        {doneCount > 0 && <span className="dash-sect__more" style={{ cursor: 'default' }}>已完成/过期 {doneCount} 项</span>}
      </div>
      <div className="calv-todo__add">
        <input className="input input--sm grow" placeholder="输入待办，回车添加…" value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') quickAdd(); }} />
        <Button size="sm" variant="primary" icon="plus" onClick={quickAdd} aria-label="添加待办" />
      </div>
      <div className="row gap-8" style={{ marginBottom: pending.length ? 8 : 0 }}>
        <input className="input input--sm" type="date" style={{ width: 130, fontSize: 11.5 }} value={date}
          onChange={(e) => setDate(e.target.value)} aria-label="待办日期" />
        <span className="tx-4" style={{ fontSize: 10.5 }}>这条待办加在哪天</span>
      </div>
      {pending.length === 0 ? <div className="dash-sect__none">没有未完成的待办。网申材料、复习计划都可以记在这里</div> : (
        <div className="col">
          {pending.map((todo) => (
            <div className="list-row" key={todo.id}>
              <button className={cn('todo-check', todo.done && 'todo-check--done')} aria-label={todo.done ? '标记未完成' : '标记完成'}
                onClick={() => updateEvent(todo.id, { done: !todo.done })}>
                {todo.done && <Icon name="check" size={11} strokeWidth={3} />}
              </button>
              <span className="grow" style={{ minWidth: 0, cursor: 'pointer' }} onClick={() => updateEvent(todo.id, { done: !todo.done })}>
                <span className={cn('truncate', todo.done && 'todo-done-text')} style={{ fontSize: 12.5, fontWeight: 560, display: 'block' }}>{todo.title}</span>
                <span className="tx-4" style={{ fontSize: 10.5 }}>{relLabel(todo.date)}{todo.time ? ` ${todo.time}` : ''}</span>
              </span>
              <button className="calv-item__done" aria-label="删除待办"
                onClick={() => { removeEvent(todo.id); toast('已删除待办', 'info'); }}>
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EventModal({ data, onClose, onSave, onDelete, derived, app, onOpenApp }:
  { data: Partial<CalEvent>; onClose: () => void; onSave: (e: Partial<CalEvent>) => void; onDelete?: () => void;
    /** 这条是从投递记录的进度线派生出来的：标题由记录决定，类型只能选笔试/面试/Offer */
    derived?: boolean; app?: Application; onOpenApp?: () => void }) {
  const [form, setForm] = useState<Partial<CalEvent>>(data);
  const set = (k: keyof CalEvent, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const types = (derived ? ['test', 'interview', 'offer'] : Object.keys(TYPE_META)) as EventType[];
  return (
    <Modal open onClose={onClose} icon="calendar" title={data.id ? (derived ? '投递进度 · 日程' : '编辑事件') : '新增事件'}
      footer={<>
        {onOpenApp && <Button icon="external" onClick={onOpenApp}>去投递记录</Button>}
        {onDelete && <Button variant="danger" icon="trash" onClick={onDelete}>删除</Button>}
        <span className="grow" />
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" onClick={() => { if (!derived && !form.title?.trim()) return onSave({ ...form, title: '未命名事件' }); onSave(form); }}>保存</Button>
      </>}>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {derived ? (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label className="field__label">所属投递</label>
            <div className="row gap-8 wrap" style={{ fontSize: 13 }}>
              <span className="badge badge--accent">{app ? `${app.company} · ${app.position}` : '投递记录已删除'}</span>
              <span className="tx-4" style={{ fontSize: 11.5 }}>标题与归属由投递记录决定，这里改的是那条记录上的进度节点</span>
            </div>
          </div>
        ) : (
          <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">事件标题</label>
            <input className="input" value={form.title || ''} placeholder="如 中金法务岗网申截止 / 君合一面" onChange={(e) => set('title', e.target.value)} /></div>
        )}
        <div className="field"><label className="field__label">日期</label>
          <input className="input" type="date" value={form.date || ''} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label className="field__label">时间</label>
          <input className="input" type="time" value={form.time || ''} onChange={(e) => set('time', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">
          {derived ? '进度阶段' : '类型'}</label>
          <div className="row gap-6 wrap">
            {types.map((t) => (
              <button key={t} className={cn('badge', form.type === t ? 'badge--accent' : 'badge--muted')}
                style={{ cursor: 'pointer', padding: '5px 12px' }} onClick={() => set('type', t)}>
                {TYPE_META[t].label}
              </button>
            ))}
          </div></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">地点 / 线上链接</label>
          <input className="input" value={form.place || ''} placeholder="如 中金大厦 12 层 / 腾讯会议 123-456-789"
            onChange={(e) => set('place', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">备注</label>
          <textarea className="textarea" value={form.note || ''} placeholder="准备材料、联系人、注意事项…" onChange={(e) => set('note', e.target.value)} /></div>
        <label className="row gap-8" style={{ gridColumn: '1 / -1', cursor: 'pointer', fontSize: 12.5 }}>
          <input type="checkbox" checked={!!form.done} onChange={(e) => set('done', e.target.checked)} />
          已完成（不再出现在「接下来要做的」里）
        </label>
      </div>
    </Modal>
  );
}
