import React from 'react';
import { Icon } from '../ui/Icon';
import { useStore } from '../../store/store';
import { cn, todayISO } from '../../lib/util';
import { NAV_GROUPS, groupOf, type NavGroupDef } from './nav';
import type { ViewId } from '../../types';

/**
 * 侧边栏：只展示 7 个主入口（原为 14 个并列项）。
 * 每个入口的角标 = 组内各标签待办数之和，点进去再用页内标签细分，
 * 这样「有多少事没做」一眼可见，但视线不被 14 行菜单切碎。
 */
export function Sidebar({ bridgeOnline, unread, open, onNavigate, onOpenGroup, userEmail, onLogout }:
  { bridgeOnline: boolean; unread: number; open?: boolean;
    onNavigate?: () => void; onOpenGroup: (g: NavGroupDef) => void;
    /** 云端版：当前账号与退出入口；不传则按本机模式渲染 */
    userEmail?: string; onLogout?: () => void }) {
  /* allEvents：笔试/面试日程 v7 起由投递进度线派生，只数 events 会漏 */
  const { view, applications, allEvents: events, jobs, questions, profile,
    interviews, offers, materials, contacts, cloud } = useStore();

  const today = todayISO();
  const badgeOf = (id: ViewId): number => {
    switch (id) {
      case 'applications': return applications.filter((a) => !['offer', 'reject'].includes(a.status)).length;
      case 'calendar': return events.filter((e) => e.date === today).length;
      case 'mail': return bridgeOnline ? unread : 0;
      case 'jobs': return jobs.filter((j) => j.status === 'new' || j.status === 'interested').length;
      case 'bank': return questions.filter((q) => !q.mastered).length;
      case 'interviews': return interviews.filter((i) => i.result === 'pending').length;
      case 'offers': return offers.filter((o) => o.status === 'considering').length;
      case 'checklist': return materials.filter((m) => !m.done).length;
      case 'contacts': return contacts.filter((c) => c.nextFollowUp && c.nextFollowUp <= today).length;
      default: return 0;
    }
  };

  const activeGroupId = groupOf(view).id;
  let lastSection = '';

  return (
    <aside className={cn('sidebar glass', open && 'sidebar--open')}>
      <div className="brand">
        <div className="brand__logo"><Icon name="logo" size={24} strokeWidth={2} /></div>
        <div>
          <div className="brand__name">秋招网申中心</div>
          <div className="brand__sub">{profile?.single?.personal?.name || '我的'} · 秋招中心</div>
        </div>
      </div>

      <nav className="nav">
        {NAV_GROUPS.map((g) => {
          const showSection = g.section !== lastSection;
          lastSection = g.section;
          const n = g.tabs.reduce((sum, t) => sum + badgeOf(t.id), 0);
          return (
            <React.Fragment key={g.id}>
              {showSection && <div className="nav__label">{g.section}</div>}
              <button
                className={cn('nav__item', activeGroupId === g.id && 'nav__item--active')}
                title={g.tabs.map((t) => t.label).join(' · ')}
                onClick={() => { onOpenGroup(g); onNavigate?.(); }}>
                <Icon name={g.icon} size={19} />
                <span>{g.label}</span>
                {n > 0 ? <span className="nav__badge">{n > 99 ? '99+' : n}</span> : null}
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {/* 底栏只留「我是谁 + 退出」。
          原先这里还挂着「邮件桥 在线/离线」「云端已同步 · 时间」以及第二个深浅色开关 —— 这些都是
          运维信息，日常用不到，却常驻在最显眼的位置。云端同步异常改由顶栏提示与设置页负责，
          邮件桥状态在「邮件中心」页内有自己的徽章。 */}
      <div className="sidebar__foot">
        {userEmail && (
          <div className="acct" title={userEmail}>
            <span className="acct__avatar">{(userEmail[0] || 'U').toUpperCase()}</span>
            <span className="acct__mail truncate">
              <span className="truncate" style={{ display: 'block' }}>{userEmail}</span>
              <span className="tx-4" style={{ fontSize: 10.5 }}>
                {cloud.state === 'error' ? '同步异常 · 见设置'
                  : cloud.state === 'saving' ? '正在同步…'
                    : '账号已连接'}
              </span>
            </span>
            {onLogout && (
              <button className="link-btn" style={{ marginLeft: 0, fontSize: 11 }} onClick={onLogout} title="退出登录">退出</button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
