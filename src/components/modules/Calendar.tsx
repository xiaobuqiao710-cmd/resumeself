import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import type { CalEvent, EventType } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal, Empty } from '../ui/Kit';
import { cn, uid, toISO, fromISO, todayISO, fmtDate, deadlineLabel } from '../../lib/util';

const DOW = ['一', '二', '三', '四', '五', '六', '日'];
const TYPE_META: Record<EventType, { label: string; cls: string }> = {
  deadline: { label: '截止', cls: 'ev-deadline' },
  interview: { label: '面试', cls: 'ev-interview' },
  test: { label: '笔试', cls: 'ev-test' },
  offer: { label: 'Offer', cls: 'ev-offer' },
  todo: { label: '待办', cls: 'ev-todo' },
  other: { label: '事项', cls: 'ev-other' },
};

function monthMatrix(year: number, month: number) {
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(year, month, 1 - startDow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  return cells;
}

const emptyEvent = (date: string): Partial<CalEvent> => ({ title: '', date, time: '', type: 'other', note: '', source: 'manual' });

export default function Calendar() {
  const { events, applications, addEvent, updateEvent, removeEvent, toast } = useStore();
  const today = new Date();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [creating, setCreating] = useState<Partial<CalEvent> | null>(null);

  const cells = useMemo(() => monthMatrix(cursor.y, cursor.m), [cursor]);
  const byDate = useMemo(() => {
    const map: Record<string, CalEvent[]> = {};
    events.forEach((e) => { (map[e.date] ||= []).push(e); });
    Object.values(map).forEach((arr) => arr.sort((a, b) => (a.time || '99').localeCompare(b.time || '99')));
    return map;
  }, [events]);

  const upcoming = useMemo(() => {
    const t = todayISO();
    return [...events].filter((e) => e.date >= t)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
      .slice(0, 12);
  }, [events]);

  const deadlines = useMemo(() => {
    const t = todayISO();
    return applications.filter((a) => a.deadline && a.deadline >= t && !['offer', 'reject'].includes(a.status))
      .sort((a, b) => (a.deadline || '').localeCompare(b.deadline || '')).slice(0, 6);
  }, [applications]);

  const goToday = () => setCursor({ y: today.getFullYear(), m: today.getMonth() });
  const shift = (d: number) => setCursor((c) => { const nm = c.m + d; return { y: c.y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }; });

  const monthLabel = `${cursor.y} 年 ${cursor.m + 1} 月`;
  const selectedEvents = selected ? byDate[selected] || [] : [];

  /* 笔试 / 面试撞车检测：同一天两场以上，或同日同一时刻 */
  const conflicts = useMemo(() => {
    const byDay = new Map<string, CalEvent[]>();
    for (const e of events) {
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
  }, [events]);

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
          <div className="section-head__d">登记填报截止、笔试面试与回馈情况 · 与网申记录、邮件同步联动</div>
        </div>
        <div className="row gap-8">
          <Button size="sm" variant="ghost" icon="chevronR" style={{ transform: 'rotate(180deg)' }} onClick={() => shift(-1)} aria-label="上月" />
          <Button size="sm" onClick={goToday}>今天</Button>
          <Button size="sm" variant="ghost" icon="chevronR" onClick={() => shift(1)} aria-label="下月" />
          <span className="h-sub" style={{ minWidth: 108, textAlign: 'center' }}>{monthLabel}</span>
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
            {Object.entries(TYPE_META).map(([k, v]) => (
              <span key={k} className="row gap-6" style={{ fontSize: 11.5, color: 'var(--tx-3)' }}>
                <span className={cn('cal__ev', v.cls)} style={{ padding: '1px 8px' }}>{v.label}</span>
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
          onSave={(e) => { updateEvent(editing.id, e); setEditing(null); toast('已更新事件'); }}
          onDelete={() => { removeEvent(editing.id); setEditing(null); toast('已删除事件', 'info'); }} />
      )}
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

function EventModal({ data, onClose, onSave, onDelete }:
  { data: Partial<CalEvent>; onClose: () => void; onSave: (e: Partial<CalEvent>) => void; onDelete?: () => void }) {
  const [form, setForm] = useState<Partial<CalEvent>>(data);
  const set = (k: keyof CalEvent, v: any) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal open onClose={onClose} icon="calendar" title={data.id ? '编辑事件' : '新增事件'}
      footer={<>
        {onDelete && <Button variant="danger" icon="trash" onClick={onDelete}>删除</Button>}
        <span className="grow" />
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" onClick={() => { if (!form.title?.trim()) return onSave({ ...form, title: '未命名事件' }); onSave(form); }}>保存</Button>
      </>}>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">事件标题</label>
          <input className="input" value={form.title || ''} placeholder="如 中金法务岗网申截止 / 君合一面" onChange={(e) => set('title', e.target.value)} /></div>
        <div className="field"><label className="field__label">日期</label>
          <input className="input" type="date" value={form.date || ''} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label className="field__label">时间</label>
          <input className="input" type="time" value={form.time || ''} onChange={(e) => set('time', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">类型</label>
          <div className="row gap-6 wrap">
            {(Object.keys(TYPE_META) as EventType[]).map((t) => (
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
