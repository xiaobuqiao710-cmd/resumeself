import React from 'react';
import { Icon } from '../ui/Icon';
import { cn } from '../../lib/util';
import type { ViewId } from '../../types';
import type { NavTab } from './nav';

/**
 * 页内标签栏：主入口内部的细分屏。只有一个标签的入口不渲染（如「日程」「邮件中心」），
 * 避免为了统一而制造无意义的按钮。角标沿用侧边栏同一套统计。
 */
export function TabBar({ tabs, active, onChange, badge }:
  { tabs: NavTab[]; active: ViewId; onChange: (v: ViewId) => void; badge: (v: ViewId) => number }) {
  if (tabs.length < 2) return null;
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => {
        const n = badge(t.id);
        return (
          <button key={t.id} role="tab" aria-selected={active === t.id}
            title={t.desc}
            className={cn('tabbar__btn', active === t.id && 'tabbar__btn--active')}
            onClick={() => onChange(t.id)}>
            <Icon name={t.icon} size={14} />
            <span>{t.label}</span>
            {n > 0 && <span className="tabbar__badge">{n > 99 ? '99+' : n}</span>}
          </button>
        );
      })}
    </div>
  );
}
