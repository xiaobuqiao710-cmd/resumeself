import React from 'react';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Kit';

export function TopBar({ title, crumb, onMenu, onSettings, children }:
  { title: string; crumb?: string; onMenu: () => void; onSettings: () => void; children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <Button variant="ghost" size="sm" className="mobile-only" icon="menu" onClick={onMenu} aria-label="菜单" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="topbar__title truncate">{title}</div>
        {crumb && <div className="topbar__crumb truncate">{crumb}</div>}
      </div>
      <div className="row gap-8">
        {children}
        <Button variant="ghost" size="sm" icon="settings" onClick={onSettings} aria-label="设置" />
      </div>
    </header>
  );
}
