import React, { useMemo } from 'react';
import { useStore } from '../../store/store';
import { SECTIONS, FIXED_VALUES } from '../../data/formSchema';
import type { EventType, MailAccount } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge, Progress } from '../ui/Kit';
import { cn, todayISO, fmtDate, deadlineLabel, daysUntil, STATUS_META, STATUS_ORDER, initials } from '../../lib/util';

function Stat({ icon, value, label, tone }: { icon: string; value: React.ReactNode; label: string; tone?: string }) {
  return (
    <div className="stat glass">
      <div className="stat__ico"><Icon name={icon} size={18} /></div>
      <div className="stat__v" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="stat__l">{label}</div>
    </div>
  );
}

const EVENT_LABEL: Record<EventType, string> = {
  deadline: '截止', interview: '面试', test: '笔试', offer: 'Offer', todo: '待办', other: '日程',
};

/**
 * 今日总览。
 *
 * 做减法的原则：**先回答「今天要做什么」，其余一切都退到次级**。
 * 原先这里是 8 个统计卡 + 4 个并列板块，信息密度高到看不出重点；
 * 现在只留 5 个真正会驱动行动的指标，并把「即将截止」与「近期日程」合并成一张按时间排的「接下来」——
 * 这两件事本来就是一回事（都是「什么时候该做什么」），拆成两张卡只会让人来回对着看。
 */
export default function Dashboard({ mail, onNav }:
  { mail: { online: boolean; unread: number; account: MailAccount | null }; onNav: (v: any) => void }) {
  const { profile, applications, allEvents, jobs, questions } = useStore();
  const personal = profile.single.personal || {};
  const bgLine = [personal.school, personal.major, personal.highestEdu].filter(Boolean).join(' · ');
  const today = todayISO();
  const hour = new Date().getHours();
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';

  const completion = useMemo(() => {
    let filled = 0, total = 0;
    SECTIONS.forEach((s) => {
      const usable = s.fields.filter((f) => f.type !== 'file' && f.type !== 'signature');
      if (s.multiple) {
        const recs = profile.multi[s.id] || [];
        total += usable.length;
        if (recs.length) {
          let f = 0; recs.forEach((r) => usable.forEach((fd) => { if ((r[fd.key] || '').trim()) f++; }));
          filled += Math.min(usable.length, Math.round(f / recs.length));
        }
      } else {
        const rec = profile.single[s.id] || {};
        usable.forEach((fd) => { total++; const v = rec[fd.key] || FIXED_VALUES[fd.key] || ''; if (String(v).trim()) filled++; });
      }
    });
    return Math.round((filled / Math.max(total, 1)) * 100);
  }, [profile]);

  const inProgress = applications.filter((a) => !['offer', 'reject'].includes(a.status));
  const offers = applications.filter((a) => a.status === 'offer').length;
  const interviews = applications.filter((a) => a.status === 'interview' || a.status === 'test').length;
  const trackingJobs = jobs.filter((j) => j.status === 'new' || j.status === 'interested').length;
  const unmastered = questions.filter((q) => !q.mastered).length;

  /* 接下来：投递截止 + 日历日程 + 岗位截止，合成一条按日期排的时间线 */
  const agenda = useMemo(() => {
    type Row = { key: string; date: string; time?: string; title: string; kind: string; badge?: { text: string; cls: string }; days: number | null };
    const rows: Row[] = [];
    applications
      .filter((a) => a.deadline && a.deadline >= today && !['offer', 'reject'].includes(a.status))
      .forEach((a) => {
        const dl = deadlineLabel(a.deadline);
        rows.push({ key: 'a' + a.id, date: a.deadline!, title: `${a.company} · ${a.position}`, kind: '投递截止', badge: { text: dl.text, cls: dl.cls }, days: daysUntil(a.deadline) });
      });
    jobs
      .filter((j) => j.deadline && j.deadline >= today && j.status !== 'applied' && j.status !== 'archived')
      .forEach((j) => {
        const dl = deadlineLabel(j.deadline);
        rows.push({ key: 'j' + j.id, date: j.deadline!, title: `${j.company} · ${j.title}`, kind: '岗位截止', badge: { text: dl.text, cls: dl.cls }, days: daysUntil(j.deadline) });
      });
    allEvents
      .filter((e) => e.date >= today && e.type !== 'deadline')
      .forEach((e) => rows.push({ key: 'e' + e.id, date: e.date, time: e.time, title: e.title, kind: EVENT_LABEL[e.type], days: daysUntil(e.date) }));
    return rows
      .sort((x, y) => x.date.localeCompare(y.date) || (x.time || '').localeCompare(y.time || ''))
      .slice(0, 7);
  }, [applications, jobs, allEvents, today]);

  const statusDist = STATUS_ORDER.map((s) => ({ s, n: applications.filter((a) => a.status === s).length }))
    .filter((x) => x.n > 0);
  const maxN = Math.max(1, ...statusDist.map((x) => x.n));

  return (
    <div className="rise">
      {/* hero */}
      <div className="glass card" style={{ marginBottom: 18, overflow: 'hidden', position: 'relative' }}>
        <div style={{ position: 'absolute', right: -40, top: -40, width: 220, height: 220, borderRadius: '50%', background: 'var(--accent-grad)', opacity: .16, filter: 'blur(30px)' }} />
        <div className="row-between wrap gap-16" style={{ position: 'relative' }}>
          <div className="row gap-14">
            <span className="tile tile--lg">{initials(String(personal.name || '秋'))}</span>
            <div>
              <div className="h-display">{greet}，{personal.name || '同学'}</div>
              <div className="tx-2" style={{ fontSize: 13.5, marginTop: 6 }}>
                {bgLine || '先在「网申资料库」补全你的教育与背景信息'}
              </div>
              {mail.online && mail.unread > 0 && (
                <button className="badge badge--accent" style={{ cursor: 'pointer', padding: '3px 9px', marginTop: 8 }}
                  onClick={() => onNav('mail')}>
                  <Icon name="mail" size={11} /> {mail.unread} 封未读邮件
                </button>
              )}
            </div>
          </div>
          <div className="row gap-10 wrap">
            <Button variant="primary" icon="plus" onClick={() => onNav('applications')}>记录新投递</Button>
            <Button icon="video" onClick={() => onNav('interviews')}>面试复盘</Button>
          </div>
        </div>
      </div>

      {/* stats —— 只留会驱动行动的 5 个 */}
      <div className="grid stagger" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', marginBottom: 18 }}>
        <Stat icon="building" value={inProgress.length} label="进行中投递" tone="var(--accent-1)" />
        <Stat icon="video" value={interviews} label="笔试 / 面试" tone="var(--accent-2)" />
        <Stat icon="trophy" value={offers} label="Offer" tone="var(--ok)" />
        <Stat icon="target" value={trackingJobs} label="追踪中岗位" tone="var(--accent-2)" />
        <Stat icon="paper" value={unmastered} label="题库待掌握" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.35fr) minmax(0,1fr)', gap: 16 }} id="dash-grid">
        {/* 接下来 */}
        <div className="glass card">
          <div className="card__head">
            <div className="card__title"><Icon name="calendar" size={18} /> 接下来</div>
            <Button size="sm" variant="ghost" onClick={() => onNav('calendar')}>全部日程 ›</Button>
          </div>
          {agenda.length === 0 ? (
            <div className="tx-3" style={{ fontSize: 13 }}>近期没有待办或截止 🎉</div>
          ) : (
            <div className="col gap-6">
              {agenda.map((r) => (
                <div className="list-row" key={r.key} style={{ padding: '9px 11px' }}>
                  <span className="col" style={{ alignItems: 'center', minWidth: 40 }}>
                    <span className="tx-4" style={{ fontSize: 10 }}>{fmtDate(r.date).slice(5)}</span>
                    <span className="h-sub" style={{ fontSize: 15 }}>{Number(r.date.slice(8, 10))}</span>
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="truncate" style={{ fontSize: 13, fontWeight: 620, display: 'block' }}>{r.title}</span>
                    <span className="tx-4" style={{ fontSize: 11 }}>
                      {r.kind}{r.time ? ` · ${r.time}` : ''}{r.days !== null && r.days >= 0 ? ` · 还剩 ${r.days} 天` : ''}
                    </span>
                  </span>
                  {r.badge && <Badge tone={r.badge.cls}>{r.badge.text}</Badge>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* right column */}
        <div className="col gap-16">
          <div className="glass card">
            <div className="card__head" style={{ marginBottom: 12 }}>
              <div className="card__title"><Icon name="layers" size={18} /> 资料库完成度</div>
              <span className="grad-text" style={{ fontSize: 20, fontWeight: 760 }}>{completion}%</span>
            </div>
            <Progress value={completion} />
            <div className="tx-3" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              补充身份证号、家庭情况、证件照等材料后，即可一键复用到各企业网申。
            </div>
            <Button size="sm" icon="edit" style={{ marginTop: 12 }} onClick={() => onNav('database')}>继续完善</Button>
          </div>

          <div className="glass card">
            <div className="card__head" style={{ marginBottom: 14 }}><div className="card__title"><Icon name="filter" size={18} /> 投递进度分布</div></div>
            {statusDist.length === 0 ? <div className="tx-3" style={{ fontSize: 13 }}>暂无数据</div> : (
              <div className="col gap-10">
                {statusDist.map(({ s, n }) => (
                  <div key={s}>
                    <div className="row-between" style={{ marginBottom: 5, gap: 10 }}>
                      {/* 圆点与文字必须分成两个元素：.badge__dot 是 6px 的圆点，不能当文字容器 */}
                      <span className={cn('row', STATUS_META[s].cls)} style={{ gap: 7, alignItems: 'center' }}>
                        <i className="badge__dot" />
                        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{STATUS_META[s].label}</span>
                      </span>
                      <span className="tx-3 mono" style={{ fontSize: 12 }}>{n}</span>
                    </div>
                    <div className="progress-bar"><div className="progress-bar__fill" style={{ width: `${(n / maxN) * 100}%`, opacity: .85 }} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
