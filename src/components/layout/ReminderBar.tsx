import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Kit';
import { collectReminders, fireNotifications, LEVEL_META } from '../../lib/remind';
import { cn, fmtDate } from '../../lib/util';
import type { ViewId } from '../../types';

/**
 * 截止提醒条：打开站点即见「今天 / 3 天内 / 7 天内」的截止与面试。
 *
 * 设计上刻意做减法：它出现在**每个页面**的顶部，所以默认只占一行、不放任何按钮。
 * 原先是一个带图标块 + 三个按钮的大卡片，既不点也占着半屏，属于典型的「常驻无用信息」。
 * 需要「到点响」的两种正规做法（浏览器系统通知 / 导出 ICS）都在「设置 → 外观与提醒」里，
 * 那里才是它们该待的地方。
 */
export function ReminderBar({ onNav }: { onNav: (v: ViewId) => void }) {
  const { jobs, applications, events, remind, toast } = useStore();
  const [open, setOpen] = useState(false);

  const items = useMemo(
    () => collectReminders({ jobs, applications, events }, remind).filter((i) => i.days >= 0),
    [jobs, applications, events, remind],
  );

  /* 打开站点时（每档每天一次）推送系统通知 */
  useEffect(() => {
    if (!remind.enabled || !items.length) return;
    const t = setTimeout(() => { const n = fireNotifications(items); if (n) toast(`已推送 ${n} 条截止提醒`, 'info'); }, 2500);
    return () => clearTimeout(t);
  }, [remind.enabled, items]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items.length) return null;

  const today = items.filter((i) => i.days === 0).length;
  const urgent = items.filter((i) => i.days <= 3).length;
  const near = items.filter((i) => i.days <= 7).length;

  return (
    <div className={cn('remind-bar', urgent > 0 && 'remind-bar--urgent')}>
      <button className="remind-bar__sum" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="bell" size={14} />
        <span style={{ fontWeight: 620 }}>截止提醒</span>
        {today > 0 && <Badge tone="badge--danger">今天 {today}</Badge>}
        {urgent > 0 && <Badge tone="badge--warn">3 天内 {urgent}</Badge>}
        <span className="tx-3" style={{ fontSize: 12 }}>共 {items.length} 项待处理</span>
        <span className="grow" />
        <span className="tx-4" style={{ fontSize: 11 }}>
          {open ? '收起' : `展开${near < items.length ? `（7 天内 ${near} 项）` : ''}`}
        </span>
        <Icon name={open ? 'chevron' : 'chevronR'} size={12} />
      </button>

      {open && (
        <div className="remind-bar__list fade">
          {items.slice(0, 8).map((i) => (
            <div className="list-row" key={i.id} style={{ padding: '6px 8px' }}>
              <Badge tone={LEVEL_META[i.level].cls}>{LEVEL_META[i.level].label}</Badge>
              <span className="grow truncate" style={{ fontSize: 12.5 }}>
                {i.company}{i.title && i.title !== '招聘' ? ` · ${i.title}` : ''}
              </span>
              <span className="tx-4 mono" style={{ fontSize: 11 }}>{fmtDate(i.date)}</span>
              {i.url && <a href={i.url} target="_blank" rel="noreferrer" className="tx-3"><Icon name="external" size={13} /></a>}
            </div>
          ))}
          {items.length > 8 && (
            <button className="copy-btn" style={{ alignSelf: 'flex-start' }} onClick={() => onNav('jobs')}>
              查看全部 {items.length} 项 ›
            </button>
          )}
          {!remind.enabled && (
            <span className="tx-4" style={{ fontSize: 11, padding: '2px 8px' }}>
              想要关掉网页也到点提醒？到「设置 → 外观与提醒」开启系统通知或导出日历。
            </span>
          )}
        </div>
      )}
    </div>
  );
}
