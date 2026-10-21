import React, { useMemo } from 'react';
import { useStore } from '../../store/store';
import { SECTIONS, FIXED_VALUES } from '../../data/formSchema';
import type { EventType, MailAccount } from '../../types';
import { Icon } from '../ui/Icon';
import { Badge, Progress } from '../ui/Kit';
import { cn, todayISO, fmtDate, deadlineLabel, daysUntil, STATUS_META, STATUS_ORDER, initials } from '../../lib/util';

/* =========================================================================
   今日总览 · 方向 B「今天一屏」
   -------------------------------------------------------------------------
   为什么是现在这样：这个页面每天被打开十几次，用户第一眼要的是**今天要干什么**，
   而不是「一共有多少条数据」。所以首屏骨架按「时间」排：

     ① 一句问候 + 一行小字（今天/本周/资料完成度）
     ② 本周七格：一眼看到这周哪天有安排
     ③ 今天 → 明天 → 之后，按天分段的日程表
     ④ 只在把今天排完之后，才给统计（进行中/笔面/Offer/追踪/待掌握）

   统计没有删，只是从「五块大卡占满首屏」降到「一行小字 + 页脚一行」，
   因为它们是**状态**不是**行动**：知道「进行中 6」不会让你今天做什么，
   知道「今天 20:00 补网申」才会。
   ========================================================================= */

type DashProps = { mail: { online: boolean; unread: number; account: MailAccount | null }; onNav: (v: any) => void };

const EVENT_LABEL: Record<EventType, string> = {
  deadline: '截止', interview: '面试', test: '笔试', offer: 'Offer', todo: '待办', other: '日程',
};
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

type AgendaRow = {
  key: string;
  date: string;
  time?: string;
  title: string;
  kind: string;
  badge?: { text: string; cls: string };
  days: number;
};

/** 首页的数据视图：只在这里算一次，所有区块共用同一口径 */
function useDashData() {
  const { profile, applications, allEvents: events, jobs, questions } = useStore();
  const personal = profile.single.personal || {};
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

  const kpi = useMemo(() => ({
    inProgress: applications.filter((a) => !['offer', 'reject'].includes(a.status)).length,
    interviews: applications.filter((a) => a.status === 'interview' || a.status === 'test').length,
    offers: applications.filter((a) => a.status === 'offer').length,
    trackingJobs: jobs.filter((j) => j.status === 'new' || j.status === 'interested').length,
    unmastered: questions.filter((q) => !q.mastered).length,
  }), [applications, jobs, questions]);

  /* 日程池：投递截止 + 岗位截止 + 日历事件。
     用 allEvents（含投递进度线派生的笔试/面试）而非原始 events：v7 起笔面日程不再存 events。 */
  const agenda = useMemo(() => {
    const rows: AgendaRow[] = [];
    applications
      .filter((a) => a.deadline && a.deadline >= today && !['offer', 'reject'].includes(a.status))
      .forEach((a) => {
        const dl = deadlineLabel(a.deadline);
        rows.push({ key: 'a' + a.id, date: a.deadline!, title: `${a.company} · ${a.position}`, kind: '投递截止', badge: { text: dl.text, cls: dl.cls }, days: daysUntil(a.deadline) ?? 0 });
      });
    jobs
      .filter((j) => j.deadline && j.deadline >= today && j.status !== 'applied' && j.status !== 'archived')
      .forEach((j) => {
        const dl = deadlineLabel(j.deadline);
        rows.push({ key: 'j' + j.id, date: j.deadline!, title: `${j.company} · ${j.title}`, kind: '岗位截止', badge: { text: dl.text, cls: dl.cls }, days: daysUntil(j.deadline) ?? 0 });
      });
    events
      .filter((e) => e.date >= today && e.type !== 'deadline')
      .forEach((e) => rows.push({ key: 'e' + e.id, date: e.date, time: e.time, title: e.title, kind: EVENT_LABEL[e.type], days: daysUntil(e.date) ?? 0 }));
    return rows.sort((x, y) => x.date.localeCompare(y.date) || (x.time || '').localeCompare(y.time || ''));
  }, [applications, jobs, events, today]);

  const todayDow = (new Date().getDay() + 6) % 7;
  const week = useMemo(() => {
    const base = new Date();
    base.setDate(base.getDate() - todayDow);
    return Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const items = agenda.filter((r) => r.date === iso);
      return { iso, day: dt.getDate(), n: items.length, items };
    });
  }, [agenda, todayDow]);

  return {
    personal, today, greet, completion, kpi, agenda, week, todayDow,
    bgLine: [personal.school, personal.major, personal.highestEdu].filter(Boolean).join(' · '),
    todayItems: agenda.filter((r) => r.days === 0),
    tomorrowItems: agenda.filter((r) => r.days === 1),
    laterItems: agenda.filter((r) => r.days > 1),
    weekTotal: week.reduce((s, c) => s + c.n, 0),
  };
}

/** 一行日程：时间 / 标题+类型 / 右侧紧迫度 */
function AgendaRowView({ r, dim, lead }: { r: AgendaRow; dim?: boolean; lead?: React.ReactNode }) {
  const tone = r.days <= 0 ? 'today' : r.days === 1 ? 'soon' : '';
  return (
    <div className={cn('dash-row', dim && 'dash-row--dim', tone && `dash-row--${tone}`)}>
      <span className="dash-row__time">{lead ?? (r.time || '全天')}</span>
      <span className="dash-row__main">
        <span className="dash-row__t">{r.title}</span>
        <span className="dash-row__m">{r.kind}{r.time && lead ? ` · ${r.time}` : ''}</span>
      </span>
      <span className="dash-row__rest">
        {r.badge ? <Badge tone={r.badge.cls}>{r.badge.text}</Badge>
          : r.days === 0 ? '今天' : r.days === 1 ? '明天' : `${r.days} 天后`}
      </span>
    </div>
  );
}

/**
 * 今日总览。
 *
 * 取舍记要（方向 B 定稿）：
 * - 「今天/明天/之后」三段而不是一张混排列表：混排时最重要的今天几项会和两周后的截止混在一起，
 *   要人自己按日期筛；分段后第一屏顶部永远是最该看的。
 * - 七格周条：日历页要翻月，而「这周哪天有空、哪天有笔面」是每天要看一眼的，给它一个窄条就够。
 * - 统计从五张卡降为两处小字：首屏让给日程，页脚保留全量五个数，点得到、不抢眼。
 */
export default function Dashboard({ mail, onNav }: DashProps) {
  const d = useDashData();
  const hasAny = d.agenda.length > 0;
  const emailLine = d.todayItems.length === 0 && d.tomorrowItems.length === 0 && d.laterItems.length === 0;

  return (
    <div className="rise dash">
      {/* ① 问候 + 一行小字 */}
      <header className="dash-head">
        <div className="dash-head__l">
          <h1 className="dash-head__hello">{d.greet}，{d.personal.name || '同学'}</h1>
          <div className="dash-head__count">
            今天 <b>{d.todayItems.length}</b> 项
            <i>·</i> 本周 <b>{d.weekTotal}</b> 项
            <i>·</i> 资料完成 <b>{d.completion}%</b>
            {mail.online && mail.unread > 0 && (
              <>
                <i>·</i>
                <button className="dash-head__mail" onClick={() => onNav('mail')}>
                  <Icon name="mail" size={11} /> {mail.unread} 封未读
                </button>
              </>
            )}
          </div>
          {!d.bgLine && (
            <div className="dash-head__hint">
              先在「网申资料库」补全教育与背景信息，之后各企业网申可一键复用
            </div>
          )}
        </div>
        <div className="dash-head__acts">
          <button className="btn btn--primary btn--sm" onClick={() => onNav('applications')}>
            <Icon name="plus" size={14} /> 记录新投递
          </button>
          <button className="btn btn--sm" onClick={() => onNav('interviews')}>
            <Icon name="video" size={14} /> 面试复盘
          </button>
        </div>
      </header>

      {/* ② 本周七格 */}
      <div className="dash-week" role="list" aria-label="本周安排">
        {d.week.map((c, i) => (
          <div
            key={c.iso}
            role="listitem"
            className={cn('dash-week__c', i === d.todayDow && 'is-now', c.n > 0 && 'is-has')}
            title={c.items.length ? c.items.map((x) => `${x.time ? x.time + ' ' : ''}${x.title}`).join('\n') : '这天没有安排'}
            onClick={() => onNav('calendar')}
          >
            <span className="dash-week__d">{WEEK[i]}</span>
            <span className="dash-week__n">{c.day}</span>
            <span className="dash-week__dot">{c.n ? c.n : ''}</span>
          </div>
        ))}
      </div>

      {/* ③ 今天 / 明天 / 之后 */}
      {!hasAny ? (
        <div className="dash-empty">
          <Icon name="calendar" size={20} />
          <div>
            <b>近期没有排期</b>
            <span>岗位库里的截止日、投递记录里的笔试面试，都会自动出现在这里</span>
          </div>
        </div>
      ) : (
        <div className="dash-cols">
          <section className="dash-main">
            <div className="dash-sect">
              <div className="dash-sect__h">今天{d.todayItems.length > 0 && <em>{d.todayItems.length} 项</em>}</div>
              {d.todayItems.length === 0 ? (
                <div className="dash-sect__none">{emailLine ? '今天没有安排' : '今天没有要赴的约，可以把明天的提前做掉'}</div>
              ) : d.todayItems.map((r) => <AgendaRowView key={r.key} r={r} />)}
            </div>

            <div className="dash-sect">
              <div className="dash-sect__h">明天{d.tomorrowItems.length > 0 && <em>{d.tomorrowItems.length} 项</em>}</div>
              {d.tomorrowItems.length === 0 ? (
                <div className="dash-sect__none">明天没有排期</div>
              ) : d.tomorrowItems.map((r) => <AgendaRowView key={r.key} r={r} dim />)}
            </div>
          </section>

          <aside className="dash-side">
            <div className="dash-sect">
              <div className="dash-sect__h">
                之后
                <button className="dash-sect__more" onClick={() => onNav('calendar')}>全部日程 ›</button>
              </div>
              {d.laterItems.length === 0 ? (
                <div className="dash-sect__none">两周内没有更远的事</div>
              ) : d.laterItems.slice(0, 7).map((r) => (
                <AgendaRowView key={r.key} r={r} dim lead={`${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}`} />
              ))}
            </div>

            <div className="dash-goal">
              <div className="dash-goal__h">
                <span>资料库完成度</span>
                <b>{d.completion}<em>%</em></b>
              </div>
              <Progress value={d.completion} />
              <div className="dash-goal__note">
                补充身份证号、家庭情况、证件照等材料后，即可一键复用到各企业网申。
              </div>
              <button className="btn btn--sm btn--ghost" onClick={() => onNav('database')}>
                <Icon name="edit" size={13} /> 继续完善
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* ④ 页脚：五个状态数（保留但不抢首屏） */}
      <footer className="dash-foot">
        <span>进行中投递 <b>{d.kpi.inProgress}</b></span>
        <span>笔试 / 面试 <b>{d.kpi.interviews}</b></span>
        <span>Offer <b>{d.kpi.offers}</b></span>
        <span>追踪中岗位 <b>{d.kpi.trackingJobs}</b></span>
        <span>题库待掌握 <b>{d.kpi.unmastered}</b></span>
        <span className="dash-foot__avatar" title={d.personal.name || '未填姓名'}>
          {initials(String(d.personal.name || '秋'))}
        </span>
      </footer>
    </div>
  );
}
