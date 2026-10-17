import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useStore } from '../../store/store';
import { cn, fmtDate, STATUS_META } from '../../lib/util';
import type { ViewId } from '../../types';
import { NAV_GROUPS } from '../layout/nav';

interface Hit { id: string; group: string; title: string; sub?: string; view: ViewId; badge?: string; }

/** 侧边栏只留 7 个主入口，但 ⌘K 依然可以直达全部细分视图 */
const NAV_HITS: Hit[] = NAV_GROUPS.flatMap((g) => g.tabs.map((t) => ({
  id: 'nav-' + t.id, group: g.label, title: t.label, sub: t.desc, view: t.id,
})));

/** ⌘K / Ctrl+K 全局搜索：跨模块一次搜到投递、岗位、题库、Offer、面试、联系人、材料 */
export function CommandPalette({ open, onClose, onNavigate }:
  { open: boolean; onClose: () => void; onNavigate: (v: ViewId) => void }) {
  const { applications, jobs, questions, offers, interviews, contacts, materials, events } = useStore();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);

  const all = useMemo<Hit[]>(() => {
    const hits: Hit[] = [...NAV_HITS];
    for (const a of applications) hits.push({ id: 'app-' + a.id, group: '网申记录', title: `${a.company} · ${a.position}`, sub: [a.location, a.channel, a.deadline && '截止 ' + fmtDate(a.deadline)].filter(Boolean).join(' · '), view: 'applications', badge: STATUS_META[a.status]?.label });
    for (const j of jobs) hits.push({ id: 'job-' + j.id, group: '岗位', title: `${j.company} · ${j.title}`, sub: [j.city, j.deadline && '截止 ' + fmtDate(j.deadline), j.source].filter(Boolean).join(' · '), view: 'jobs' });
    for (const o of offers) hits.push({ id: 'off-' + o.id, group: 'Offer', title: `${o.company} · ${o.position}`, sub: [o.city, o.totalPackage || o.baseMonthly, o.hukou].filter(Boolean).join(' · '), view: 'offers' });
    for (const i of interviews) hits.push({ id: 'iv-' + i.id, group: '面试复盘', title: `${i.company} · ${i.round}`, sub: [fmtDate(i.date), `${i.questions.length} 题`].join(' · '), view: 'interviews' });
    for (const c of contacts) hits.push({ id: 'ct-' + c.id, group: '联系人', title: c.name, sub: [c.company, c.role, c.promised].filter(Boolean).join(' · '), view: 'contacts' });
    for (const m of materials) hits.push({ id: 'mat-' + m.id, group: '材料', title: m.name, sub: [m.group, m.done ? '已备好' : '未备好'].join(' · '), view: 'checklist' });
    for (const e of events) hits.push({ id: 'ev-' + e.id, group: '日程', title: e.title, sub: [fmtDate(e.date), e.time].filter(Boolean).join(' '), view: 'calendar' });
    for (const qq of questions) hits.push({ id: 'q-' + qq.id, group: '题库', title: qq.content.slice(0, 60), sub: [qq.kind === 'interview' ? '面试' : '笔试', qq.category, qq.company].filter(Boolean).join(' · '), view: 'bank' });
    return hits;
  }, [applications, jobs, offers, interviews, contacts, materials, events, questions]);

  const results = useMemo(() => {
    const kw = q.trim().toLowerCase();
    /* 空查询 → 直接列出全部板块跳转。
       原先写的是 `all.filter((h) => h.group === '跳转')`，而 NAV_HITS 的 group 取自
       NAV_GROUPS 的 label（总览 / 求职进程 / …），全站根本没有「跳转」这个组 →
       一按 ⌘K 就是「没有匹配结果」，上下键与回车全部失效，看不出能去哪儿。 */
    const base = kw ? all.filter((h) => `${h.title} ${h.sub || ''} ${h.group}`.toLowerCase().includes(kw)) : NAV_HITS;
    return base.slice(0, 40);
  }, [q, all]);

  useEffect(() => { setIdx(0); }, [q]);

  if (!open) return null;

  const go = (h: Hit) => { onNavigate(h.view); onClose(); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const h = results[idx]; if (h) go(h); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  const groups = Array.from(new Set(results.map((r) => r.group)));

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal glass glass--strong" style={{ maxWidth: 620, marginTop: '8vh', alignSelf: 'flex-start' }} role="dialog" aria-modal="true">
        <div className="row gap-10" style={{ padding: '14px 16px', borderBottom: '1px solid var(--glass-brd)' }}>
          <Icon name="search" size={17} />
          <input ref={inputRef} className="input" style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 15 }}
            placeholder="搜索投递 / 岗位 / Offer / 面试 / 题库 / 联系人，或直接跳转板块…"
            value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
          <span className="kbd">ESC</span>
        </div>
        <div className="modal__body" style={{ maxHeight: '58vh', padding: '8px 8px 12px' }}>
          {results.length === 0 && <div className="tx-3" style={{ fontSize: 13, padding: 16 }}>没有匹配结果</div>}
          {groups.map((g) => (
            <div key={g}>
              <div className="nav__label" style={{ padding: '8px 10px 4px' }}>{g}</div>
              {results.filter((r) => r.group === g).map((h) => {
                const i = results.indexOf(h);
                return (
                  <button key={h.id} className={cn('nav__item', i === idx && 'nav__item--active')}
                    style={{ width: '100%', textAlign: 'left' }}
                    onMouseEnter={() => setIdx(i)} onClick={() => go(h)}>
                    <Icon name={h.group === '跳转' ? 'chevronR' : 'doc'} size={15} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="truncate" style={{ display: 'block', fontSize: 13 }}>{h.title}</span>
                      {h.sub && <span className="tx-4 truncate" style={{ display: 'block', fontSize: 11 }}>{h.sub}</span>}
                    </span>
                    {h.badge && <span className="badge badge--muted">{h.badge}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
