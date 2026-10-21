import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import type { CalEvent, EventType } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal, Empty } from '../ui/Kit';
import { cn, uid, toISO, fromISO, todayISO, fmtDate, deadlineLabel } from '../../lib/util';
import { parseStageEventId, isStageEventId } from '../../lib/appTimeline';
import { DeadlineBriefModal } from '../ui/DeadlineBrief';

const DOW = ['一', '二', '三', '四', '五', '六', '日'];
const TYPE_META: Record<EventType, { label: string; cls: string }> = {
  deadline: { label: '截止', cls: 'ev-deadline' },
  interview: { label: '面试', cls: 'ev-interview' },
  test: { label: '笔试', cls: 'ev-test' },
  offer: { label: 'Offer', cls: 'ev-offer' },
  todo: { label: '待办', cls: 'ev-todo' },
  other: { label: '事项', cls: 'ev-other' },
};

/**
 * 日历只装「有约定时间的日程」：笔试 / 面试 / Offer。
 *
 * 为什么把截止与待办挡在外面（2026-10-21 用户反馈「日历里全是截止·XXX」）：
 * 网申截止是**漏斗状态**，一个月能有三四十条，一画进格子就把真正要赴的约
 * （哪天几点在哪一面）挤成 `+38 更多`；待办是另一套清单，它有自己的卡。
 * 数据一条都不删，只是不画在日历上：截止仍在右侧「投递截止提醒」按投递记录汇总，
 * 待办仍在「待办清单」里勾选。日历回答的问题只有一个 —— 我哪天要去笔试 / 面试。
 */
const CAL_TYPES: EventType[] = ['test', 'interview', 'offer'];
const isCalEvent = (e: CalEvent) => CAL_TYPES.includes(e.type);

function monthMatrix(year: number, month: number) {
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(year, month, 1 - startDow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  return cells;
}

const emptyEvent = (date: string): Partial<CalEvent> => ({ title: '', date, time: '', type: 'interview', note: '', source: 'manual' });

export default function Calendar() {
  /* allEvents 而不是 events：v7 起笔试/面试/Offer 日程的唯一真源是投递记录的进度线，
     日历只是它的投影（见 lib/appTimeline.ts）。只读 events 就看不到在投递记录里填的面试时间。 */
  const { allEvents, applications, addEvent, updateEvent, removeEvent, updateStage, removeStage, toast } = useStore();
  const today = new Date();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [creating, setCreating] = useState<Partial<CalEvent> | null>(null);
  /* 「AI 梳理截止」面板：一按就出「哪些要截止、何时截止」。
     清单由 lib/deadlineBrief.ts 按规则算（日期/剩余天数/去重口径全部确定），
     AI 只在上面补一句人话；没配 Key 也照样能看清单。 */
  const [showBrief, setShowBrief] = useState(false);

  const cells = useMemo(() => monthMatrix(cursor.y, cursor.m), [cursor]);
  /* 只把笔/面/Offer 装进日历（见 isCalEvent）。byDate 是格子与选中日详情的唯一供数口，
     在这里过滤一次，月视图、选中日、+N 计数都不会漏进截止与待办。 */
  const byDate = useMemo(() => {
    const map: Record<string, CalEvent[]> = {};
    allEvents.filter(isCalEvent).forEach((e) => { (map[e.date] ||= []).push(e); });
    Object.values(map).forEach((arr) => arr.sort((a, b) => (a.time || '99').localeCompare(b.time || '99')));
    return map;
  }, [allEvents]);

  const upcoming = useMemo(() => {
    const t = todayISO();
    return [...allEvents].filter((e) => e.date >= t && isCalEvent(e))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
      .slice(0, 12);
  }, [allEvents]);

  const deadlines = useMemo(() => {
    const t = todayISO();
    return applications.filter((a) => a.deadline && a.deadline >= t && !['offer', 'reject'].includes(a.status))
      .sort((a, b) => (a.deadline || '').localeCompare(b.deadline || '')).slice(0, 6);
  }, [applications]);

  const goToday = () => setCursor({ y: today.getFullYear(), m: today.getMonth() });
  const shift = (d: number) => setCursor((c) => { const nm = c.m + d; return { y: c.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }; });

  const monthLabel = `${cursor.y} 年 ${cursor.m + 1} 月`;
  const selectedEvents = selected ? byDate[selected] || [] : [];

  /* 笔试 / 面试撞车检测：同一天两场以上，或同日同一时刻（用 allEvents：进度线里的笔面也要算） */
  const conflicts = useMemo(() => {
    const byDay = new Map<string, CalEvent[]>();
    for (const e of allEvents) {
      if (e.done || (e.type !== 'test' && e.type !== 'interview')) continue;
      byDay.set(e.date, [...(byDay.get(e.date) || []), e]);
    }
    const out: { date: string; items: CalEvent[]; sameTime: boolean }[] = [];
    byDay.forEach((items, date) => {
      if (items.length < 2) return;
      const times = items.map((i) => i.time).filter(Boolean) as string[];
      out.push({ date, items, sameTime: new Set(times).size < times.length });
    });
    const today = todayISO();
    return out.filter((c) => c.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  }, [allEvents]);

  return (
    <div className="rise">
      {conflicts.length > 0 && (
        <div className="glass card" style={{ marginBottom: 16, borderColor: 'rgba(255,180,80,.35)' }}>
          <div className="card__head">
            <div className="card__title"><Icon name="alert" size={17} /> 时间冲突提醒 · {conflicts.length} 天内有撞车</div>
          </div>
          <div className="col gap-8">
            {conflicts.map((c) => (
              <div className="list-row" key={c.date} style={{ padding: '9px 12px', alignItems: 'flex-start' }}>
                <Badge tone={c.sameTime ? 'badge--danger' : 'badge--warn'}>{fmtDate(c.date)}</Badge>
                <span className="grow" style={{ fontSize: 12.5 }}>
                  {c.items.map((i) => `${i.time ? i.time + ' ' : ''}${i.title}`).join('　|　')}
                </span>
                {c.sameTime && <span className="tx-3" style={{ fontSize: 11.5 }}>同一时段</span>}
              </div>
            ))}
          </div>
          <div className="tx-3" style={{ fontSize: 12, marginTop: 8 }}>
            银行统一笔试常集中在同一周甚至同一天。收到通知就登记到这里，越早发现越有余地去协调改期或安排设备与场地。
          </div>
        </div>
      )}

      <div className="section-head">
        <div>
          <div className="section-head__t">日历追踪</div>
          <div className="section-head__d">只放笔试 / 面试 / Offer 的约定时间 · 网申截止与待办在右侧清单里看，不占日历格子</div>
        </div>
        <div className="row gap-8">
          <Button size="sm" variant="ghost" icon="chevronR" style={{ transform: 'rotate(180deg)' }} onClick={() => shift(-1)} aria-label="上月" />
          <Button size="sm" onClick={goToday}>今天</Button>
          <Button size="sm" variant="ghost" icon="chevronR" onClick={() => shift(1)} aria-label="下月" />
          <span className="h-sub" style={{ minWidth: 108, textAlign: 'center' }}>{monthLabel}</span>
          {/* 「AI 梳理截止」：这一屏真正要回答的问题不是「日历长什么样」，
              而是「我这几天有什么要截止、什么时候截止」。贴着主按钮放，
              但不抢「新增事件」的位置 —— 它是查询，不是录入。 */}
          <Button size="sm" icon="sparkles" className="btn--ai" onClick={() => setShowBrief(true)}>AI 梳理截止</Button>
          <Button variant="primary" icon="plus" onClick={() => setCreating(emptyEvent(todayISO()))}>新增事件</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 16, alignItems: 'start' }} className="cal-wrap">
        <div className="glass card">
          <div className="cal" style={{ marginBottom: 8 }}>
            {DOW.map((d) => <div className="cal__dow" key={d}>{d}</div>)}
          </div>
          <div className="cal">
            {cells.map((d) => {
              const iso = toISO(d);
              const out = d.getMonth() !== cursor.m;
              const evs = byDate[iso] || [];
              const isToday = iso === todayISO();
              return (
                <div key={iso}
                  className={cn('cal__cell', out && 'cal__cell--out', isToday && 'cal__cell--today', selected === iso && 'cal__cell--today')}
                  onClick={() => setSelected(iso)} onDoubleClick={() => setCreating(emptyEvent(iso))}>
                  <span className="cal__num">{d.getDate()}</span>
                  {evs.slice(0, 3).map((e) => (
                    <span key={e.id} className={cn('cal__ev', TYPE_META[e.type].cls)}
                      onClick={(ev) => { ev.stopPropagation(); setEditing(e); }} title={`${e.time || ''} ${e.title}`}>
                      {e.time ? e.time + ' ' : ''}{e.title}
                    </span>
                  ))}
                  {evs.length > 3 && <span className="cal__more">+{evs.length - 3} 更多</span>}
                </div>
              );
            })}
          </div>
          <div className="row gap-12 wrap" style={{ marginTop: 14 }}>
            {/* 图例只列「日历里真的会出现」的三类：以前把截止/待办/事项也列出来，
                图例本身就在暗示这些东西会画进格子，等于替旧口径站台。 */}
            {CAL_TYPES.map((k) => (
              <span key={k} className="row gap-6" style={{ fontSize: 11.5, color: 'var(--tx-3)' }}>
                <span className={cn('cal__ev', TYPE_META[k].cls)} style={{ padding: '1px 8px' }}>{TYPE_META[k].label}</span>
              </span>
            ))}
            <span className="tx-4" style={{ fontSize: 11, marginLeft: 'auto' }}>双击日期可快速新增事件</span>
          </div>
        </div>

        <div className="col gap-16">
          {/* selected day */}
          {selected && (
            <div className="glass card">
              <div className="card__head" style={{ marginBottom: 12 }}>
                <div className="card__title"><Icon name="calendar" size={17} /> {fmtDate(selected)}</div>
                <Button size="sm" variant="ghost" icon="plus" onClick={() => setCreating(emptyEvent(selected))} />
              </div>
              {selectedEvents.length === 0 ? <div className="tx-3" style={{ fontSize: 13 }}>当日暂无事件</div> :
                selectedEvents.map((e) => (
                  <div className="list-row" key={e.id} style={{ padding: '9px 10px', cursor: 'pointer' }} onClick={() => setEditing(e)}>
                    <span className={cn('cal__ev', TYPE_META[e.type].cls)} style={{ padding: '2px 8px' }}>{TYPE_META[e.type].label}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="truncate" style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{e.title}</span>
                      {e.time && <span className="tx-3" style={{ fontSize: 11.5 }}>{e.time}</span>}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {/* todo checklist */}
          <TodoCard />

          {/* upcoming agenda */}
          <div className="glass card">
            <div className="card__head" style={{ marginBottom: 12 }}><div className="card__title"><Icon name="clock" size={17} /> 近期安排</div></div>
            {upcoming.length === 0 ? <Empty icon="calendar" title="暂无近期安排" /> :
              <div className="col gap-6">
                {upcoming.map((e) => (
                  <div className="list-row" key={e.id} style={{ padding: '9px 10px', cursor: 'pointer' }} onClick={() => setEditing(e)}>
                    <span className="col" style={{ alignItems: 'center', minWidth: 40 }}>
                      <span className="tx-3" style={{ fontSize: 10.5 }}>{fromISO(e.date).getMonth() + 1}月</span>
                      <span className="h-sub">{fromISO(e.date).getDate()}</span>
                    </span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="truncate" style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{e.title}</span>
                      <span className="row gap-6" style={{ marginTop: 3 }}>
                        <span className={cn('cal__ev', TYPE_META[e.type].cls)} style={{ padding: '0 7px', fontSize: 10 }}>{TYPE_META[e.type].label}</span>
                        {e.time && <span className="tx-4" style={{ fontSize: 11 }}>{e.time}</span>}
                      </span>
                    </span>
                  </div>
                ))}
              </div>}
          </div>

          {/* deadlines */}
          <div className="glass card">
            <div className="card__head" style={{ marginBottom: 12 }}><div className="card__title"><Icon name="alert" size={17} /> 投递截止提醒</div></div>
            {deadlines.length === 0 ? <div className="tx-3" style={{ fontSize: 13 }}>暂无待截止的投递</div> :
              <div className="col gap-8">
                {deadlines.map((a) => {
                  const dl = deadlineLabel(a.deadline);
                  return (
                    <div className="row-between gap-8" key={a.id}>
                      <span className="truncate" style={{ fontSize: 12.5 }}>{a.company} · {a.position}</span>
                      <Badge tone={dl.cls}>{dl.text}</Badge>
                    </div>
                  );
                })}
              </div>}
          </div>
        </div>
      </div>

      {/* create */}
      {creating && (
        <EventModal data={creating} onClose={() => setCreating(null)}
          onSave={(e) => { addEvent(e as CalEvent); setCreating(null); toast('已添加日历事件'); }} />
      )}
      {editing && (
        <EventModal data={editing} onClose={() => setEditing(null)}
          derived={isStageEventId(editing.id)}
          /* 派生事件（id 形如 stage:app:entry）不是 events 里的一条，而是投递记录进度线节点的投影：
             在这里改时间/地点必须写回进度线，否则日历上改了、投递记录里没变，
             下次投影又把它盖回来 —— 这正是「两边各存一份」时代最烦的那种不同步。 */
          onSave={(e) => {
            const parsed = parseStageEventId(editing.id);
            if (parsed) {
              updateStage(parsed.appId, parsed.entryId, {
                at: e.date || editing.date,
                time: e.time, place: e.place, note: e.note,
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

      {/* AI 梳理截止：一按就出「哪些要截止、什么时候截止」。
          清单由规则算（lib/deadlineBrief.ts），AI 只在这份清单上补一句人话 ——
          没配 Key 也照样能看，不把「有没有 AI」变成「能不能用」的门槛。 */}
      {showBrief && <DeadlineBriefModal onClose={() => setShowBrief(false)} />}
    </div>
  );
}

function TodoCard() {
  const { events, addEvent, updateEvent, removeEvent, toast } = useStore();
  const [text, setText] = useState('');
  const todos = useMemo(() => events.filter((e) => e.type === 'todo')
    .sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.date.localeCompare(b.date)), [events]);
  const pending = todos.filter((t) => !t.done).length;

  const quickAdd = () => {
    if (!text.trim()) return;
    addEvent({ title: text.trim(), date: todayISO(), type: 'todo', source: 'manual', done: false });
    setText('');
    toast('已添加待办');
  };

  return (
    <div className="glass card">
      <div className="card__head" style={{ marginBottom: 10 }}>
        <div className="card__title"><Icon name="check" size={17} /> 待办清单 {todos.length > 0 && <span className="badge badge--muted" style={{ marginLeft: 4 }}>{pending} 项待完成</span>}</div>
      </div>
      <div className="row gap-8" style={{ marginBottom: todos.length ? 10 : 0 }}>
        <input className="input input--sm grow" placeholder="输入待办，回车添加…" value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') quickAdd(); }} />
        <Button size="sm" variant="primary" icon="plus" onClick={quickAdd} aria-label="添加待办" />
      </div>
      {todos.length === 0 ? <div className="tx-3" style={{ fontSize: 12.5 }}>暂无待办，网申材料、复习计划都可以记在这里</div> : (
        <div className="col gap-4">
          {todos.map((t) => (
            <div className="list-row" key={t.id} style={{ padding: '7px 10px' }}>
              <button className={cn('todo-check', t.done && 'todo-check--done')} aria-label={t.done ? '标记未完成' : '标记完成'}
                onClick={() => updateEvent(t.id, { done: !t.done })}>
                {t.done && <Icon name="check" size={11} strokeWidth={3} />}
              </button>
              <span className="grow" style={{ minWidth: 0, cursor: 'pointer' }} onClick={() => updateEvent(t.id, { done: !t.done })}>
                <span className={cn('truncate', t.done && 'todo-done-text')} style={{ fontSize: 12.5, fontWeight: 560, display: 'block' }}>{t.title}</span>
                <span className="tx-4" style={{ fontSize: 10.5 }}>{fmtDate(t.date)}{t.time ? ` ${t.time}` : ''}</span>
              </span>
              <Button size="sm" variant="ghost" icon="trash" aria-label="删除待办"
                onClick={() => { removeEvent(t.id); toast('已删除待办', 'info'); }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventModal({ data, onClose, onSave, onDelete, derived }:
  { data: Partial<CalEvent>; onClose: () => void; onSave: (e: Partial<CalEvent>) => void; onDelete?: () => void; derived?: boolean }) {
  const [form, setForm] = useState<Partial<CalEvent>>(data);
  const set = (k: keyof CalEvent, v: any) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal open onClose={onClose} icon="calendar" title={data.id ? (derived ? '编辑笔面试节点' : '编辑事件') : '新增事件'}
      footer={<>
        {onDelete && <Button variant="danger" icon="trash" onClick={onDelete}>{derived ? '从进度线删除' : '删除'}</Button>}
        <span className="grow" />
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" onClick={() => { if (!form.title?.trim()) return onSave({ ...form, title: '未命名事件' }); onSave(form); }}>保存</Button>
      </>}>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {derived && (
          <div className="tx-4" style={{ gridColumn: '1 / -1', fontSize: 11.5, marginBottom: -4 }}>
            这条来自投递记录的进度线，标题由记录决定，改时间 / 地点会写回那条记录。
          </div>
        )}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">事件标题</label>
          <input className="input" value={form.title || ''} placeholder="如 君合一面 / 中行笔试" onChange={(e) => set('title', e.target.value)} /></div>
        <div className="field"><label className="field__label">日期</label>
          <input className="input" type="date" value={form.date || ''} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label className="field__label">时间</label>
          <input className="input" type="time" value={form.time || ''} onChange={(e) => set('time', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">类型</label>
          <div className="row gap-6 wrap">
            {/* 只给三类：日历里画不出来的类型不该出现在这个表单里，
                否则用户新建一条「截止」，保存后在哪都找不到，会以为丢数据了。 */}
            {CAL_TYPES.map((t) => (
              <button key={t} className={cn('badge', form.type === t ? 'badge--accent' : 'badge--muted')}
                style={{ cursor: 'pointer', padding: '5px 12px' }} onClick={() => set('type', t)}>
                {TYPE_META[t].label}
              </button>
            ))}
          </div></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">备注</label>
          <textarea className="textarea" value={form.note || ''} placeholder="地点、准备材料、联系方式…" onChange={(e) => set('note', e.target.value)} /></div>
      </div>
    </Modal>
  );
}
