import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { cn } from '../../lib/util';
import { useStore } from '../../store/store';

/* ---------- Button ---------- */
export function Button({ variant = 'default', size, icon, children, className, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'icon';
    size?: 'sm' | 'lg'; icon?: string;
  }) {
  return (
    <button
      className={cn('btn',
        variant === 'primary' && 'btn--primary',
        variant === 'ghost' && 'btn--ghost',
        variant === 'danger' && 'btn--danger',
        variant === 'icon' && 'btn--icon',
        size === 'sm' && 'btn--sm', size === 'lg' && 'btn--lg',
        className)}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

/* ---------- Badge ----------
 * title 透传是为了「胶囊里放不下就完整挂悬停」这条降级路径（见 Jobs 的公司背景卡：
 * AI 生成字段长度不可控，短值进胶囊、长值取主干 + title 兜底完整原文）。 */
export function Badge({ children, tone, dot, className, title }:
  { children: React.ReactNode; tone?: string; dot?: boolean; className?: string; title?: string }) {
  return <span className={cn('badge', tone, className)} title={title}>{dot && <i className="badge__dot" />}{children}</span>;
}

/* ---------- 内联 AI 按钮 ----------
 * 一个通用小按钮：靠右对齐、生成中显示进度并禁用。
 * 存在的理由：AI 能力必须长在**需要它的那个输入框旁边**。
 * 反面教材是「答案字段写一句『可用列表中 ✨ 按钮生成』」—— 用户得关弹窗、回列表、
 * 找到那一条、再点 ✨；既然全站都接了 AI，就不该让人绕出去。
 * 用法：塞进 `.field__label` 里即可 —— 它本身就是 flex 行（align-items:center; gap:6px），
 * 按钮自带 marginLeft:'auto' 会被推到右端，不需要改任何 CSS。
 */
export function AiBtn({ label, busyLabel, busy, onClick, title }:
  { label: string; busyLabel: string; busy: boolean; onClick: () => void; title?: string }) {
  return (
    <button type="button" className={cn('badge', 'badge--accent')}
      style={{ cursor: busy ? 'progress' : 'pointer', padding: '3px 9px', marginLeft: 'auto',
        opacity: busy ? .6 : 1, flexShrink: 0 }}
      disabled={busy} onClick={onClick} title={title || label}>
      <Icon name="sparkles" size={11} /> {busy ? busyLabel : label}
    </button>
  );
}

/* ---------- 滚动锁定（计数式，模块级）----------
 * 为什么不能「各自记住、各自恢复」：站内存在**两层弹窗叠加**的真实路径
 * （岗位详情弹窗上再开「转为网申记录」），确认后两个弹窗在同一次提交里卸载。
 * 若每个弹窗都保存进入前的 overflow 再恢复，后卸载的那个会把「已被前者恢复成空」的值
 * 又写回 hidden —— 实测结果是页面**永久无法上下滑动**，只能刷新。
 * 计数式：只有第一层保存原值、只有最后一层恢复，与卸载顺序无关。
 */
let scrollLockDepth = 0;
let savedScrollerOverflow: string | null = null;
let savedBodyOverflow: string | null = null;

function lockScroll() {
  const scroller = document.querySelector<HTMLElement>('.app__scroll');
  if (scrollLockDepth === 0) {
    savedScrollerOverflow = scroller ? scroller.style.overflow : null;
    savedBodyOverflow = document.body.style.overflow;
  }
  scrollLockDepth++;
  if (scroller) scroller.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
}

function unlockScroll() {
  scrollLockDepth = Math.max(0, scrollLockDepth - 1);
  if (scrollLockDepth > 0) return;                 // 还有弹窗开着 → 保持锁定
  const scroller = document.querySelector<HTMLElement>('.app__scroll');
  if (scroller && savedScrollerOverflow !== null) scroller.style.overflow = savedScrollerOverflow;
  if (savedBodyOverflow !== null) document.body.style.overflow = savedBodyOverflow;
  savedScrollerOverflow = null;
  savedBodyOverflow = null;
}

/**
 * 兜底自愈：站内只有弹窗会写 `.app__scroll` 的行内 overflow。
 * 启动时若发现残留（旧版本锁死过、或异常卸载路径），直接清掉，避免用户「页面滚不动」。
 */
export function healScrollLock() {
  if (scrollLockDepth > 0) return;
  const scroller = document.querySelector<HTMLElement>('.app__scroll');
  if (scroller && scroller.style.overflow === 'hidden') scroller.style.overflow = '';
  if (document.body.style.overflow === 'hidden') document.body.style.overflow = '';
}

/* ---------- Modal ---------- */
export function Modal({ open, onClose, title, children, footer, wide, icon }:
  { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode;
    footer?: React.ReactNode; wide?: boolean; icon?: string }) {
  /* onClose 走 ref：调用点全都传内联箭头函数（`onClose={() => setX(null)}`），
     每次父组件渲染都是新引用。把它放进 deps，会让下面这个「锁滚动 + 初始焦点 + 关闭归还焦点」
     的副作用**每次父组件重渲染都重跑一遍**：清理函数先把焦点还给触发器按钮，新一轮再把焦点
     抢回弹窗——于是「新增投递」这种「表单状态存在父组件里」的弹窗，每敲一个字焦点就被抢走一次，
     实测第二个字段只能进去第一个字符、中文根本打不进去。副作用只认 open。 */
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', h);
    /* 打开弹窗时锁住底层滚动：站内的滚动容器是 .app__scroll 而不是 body，
       只锁 body 的话在弹窗上滚滚轮，背后的列表会跟着动。
       同时把焦点移进弹窗、关闭后归还给原元素（键盘用户 Tab 原先会跑到遮罩后面）。 */
    lockScroll();
    const prevFocus = document.activeElement as HTMLElement | null;
    /* 初始焦点必须落在**表单控件**上，不能把 button 混进同一个选择器：
       逗号选择器是一个「选择器列表」，返回的是**文档顺序里第一个**命中的元素，
       而 .modal__head 里的关闭按钮永远排在正文输入框前面——结果焦点跑到 ✕ 上，
       弹窗一打开就是个高亮的焦点环，用户还得自己再点一次输入框。
       没有任何表单控件时才退回到对话框容器本身（tabIndex=-1），别去聚焦关闭按钮。 */
    const t = setTimeout(() => {
      const root = document.querySelector<HTMLElement>('.modal');
      if (!root) return;
      const field = root.querySelector<HTMLElement>(
        'input:not([type=hidden]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled])',
      );
      if (field) { field.focus?.(); return; }
      root.tabIndex = -1;
      root.focus?.();
    }, 30);
    return () => {
      window.removeEventListener('keydown', h);
      unlockScroll();
      clearTimeout(t);
      /* 只有原元素还在文档里才归还焦点：跳转板块/列表刷新后它可能已经卸载，
         这时聚焦会静默失败或把焦点甩到 body 上。 */
      try { if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.(); } catch { /* 元素已卸载 */ }
    };
  }, [open]);
  if (!open) return null;
  /* 通过 Portal 挂到 body：避免被带 transform/动画的祖先容器捕获 fixed 定位 */
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cn('modal glass glass--strong', wide && 'modal--wide')} role="dialog" aria-modal="true">
        <div className="modal__head">
          <div className="row gap-10">
            {icon && <span className="acc__ico"><Icon name={icon} size={18} /></span>}
            <div className="modal__title">{title}</div>
          </div>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="关闭" />
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Segmented ---------- */
export function Segmented<T extends string>({ value, onChange, options, size }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: string }[]; size?: 'sm' }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value}
          className={cn('segmented__btn', value === o.value && 'segmented__btn--active')}
          style={size === 'sm' ? { padding: '4px 10px', fontSize: 11.5 } : undefined}
          onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={13} className="inline" />} {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Empty state ---------- */
export function Empty({ icon = 'inbox', title, desc, action }:
  { icon?: string; title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="empty fade">
      <Icon name={icon} size={46} />
      <div className="empty__t">{title}</div>
      {desc && <div className="empty__d">{desc}</div>}
      {action && <div className="row gap-10" style={{ justifyContent: 'center', marginTop: 18 }}>{action}</div>}
    </div>
  );
}

/* ---------- Toaster ---------- */
export function Toaster() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={cn('toast', `toast--${t.kind}`)} onClick={() => dismissToast(t.id)}>
          <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'err' ? 'alert' : 'sparkles'} size={18} />
          <span>{t.msg}</span>
          {t.action && (
            <button
              className="copy-btn"
              style={{ marginLeft: 10, whiteSpace: 'nowrap', flex: '0 0 auto', cursor: 'pointer' }}
              onClick={(ev) => { ev.stopPropagation(); t.action!.run(); dismissToast(t.id); }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- Progress ---------- */
export function Progress({ value, className }: { value: number; className?: string }) {
  return <div className={cn('progress-bar', className)}><div className="progress-bar__fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}
