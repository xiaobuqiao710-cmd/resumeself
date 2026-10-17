/**
 * 同步状态 —— 「为什么我看不到新招聘信息」这个问题在界面上的正面回答。
 *
 * 起因（真实 bug）：自动同步失败只记在**内存里的一个 ref** 上（每会话最多弹一次提示），
 * 刷新页面即失忆；而「拉取成功、汇总表没更新」与「链路早就断了」在界面上完全同形 ——
 * 两者都表现为岗位列表里没有新东西。用户的合理结论只能是「这个网站没有新信息」。
 *
 * 因此这里固定展示两个时间，缺一不可：
 *   · 最近一次检查  —— 证明**链路活着**（这是「同步到底在不在跑」的证据）
 *   · 最近一次有更新 —— 证明**数据在动**（这才是「有没有新岗位」的答案）
 * 只显示前者，看不出数据源没动；只显示后者，会把「一切正常、只是上游没更新」
 * 误判成「同步坏了」。两种误判的处置动作完全相反，所以必须并列。
 */
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button } from './Kit';
import { cn } from '../../lib/util';
import { syncHealth, relTime, type SyncHealthState } from '../../lib/autosync';

const META: Record<SyncHealthState, { tone: string; color: string; icon: string; label: string }> = {
  ok:           { tone: 'badge--ok',     color: 'var(--ok)',     icon: 'check', label: '同步正常' },
  off:          { tone: 'badge--muted',  color: 'var(--tx-4)',   icon: 'info',  label: '同步已关' },
  never:        { tone: 'badge--warn',   color: 'var(--warn)',   icon: 'info',  label: '从未同步' },
  unconfigured: { tone: 'badge--muted',  color: 'var(--tx-4)',   icon: 'info',  label: '未配网盘' },
  stale:        { tone: 'badge--warn',   color: 'var(--warn)',   icon: 'clock', label: '同步停滞' },
  error:        { tone: 'badge--danger', color: 'var(--danger)', icon: 'alert', label: '同步失败' },
};

/** 状态在每次渲染时重算；另挂一个 60 秒的时钟，
 *  否则「5 分钟前」会一直停在打开页面那一刻，看久了反而不可信。 */
function useTick(ms = 60_000) {
  const [, bump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const fmt = (ts: number) => (ts ? `${new Date(ts).toLocaleString('zh-CN', { hour12: false })}（${relTime(ts)}）` : '—');

export function SyncStatus({ variant = 'pill', onAction }: {
  variant?: 'pill' | 'block';
  /** 点它干什么 —— 一般传「打开同步弹窗」；设置面板里传「打开同步弹窗」即可。 */
  onAction?: () => void;
}) {
  useTick();
  const h = syncHealth();
  const m = META[h.state];

  if (variant === 'block') {
    return (
      <div className="glass" style={{ padding: 12, borderRadius: 14, marginTop: 10 }}>
        <div className="row gap-8 wrap" style={{ alignItems: 'center' }}>
          <span className={cn('badge', m.tone)} style={{ flexShrink: 0 }}>
            <Icon name={m.icon} size={11} /> {m.label}
          </span>
          <span className="grow" style={{ fontSize: 12.5, lineHeight: 1.6 }}>{h.text}</span>
          {onAction && <Button size="sm" icon="refresh" onClick={onAction}>手动同步一次</Button>}
        </div>
        <div className="field__hint" style={{ marginTop: 8, lineHeight: 1.9 }}>
          最近一次检查：{fmt(h.lastTryAt)}
          <br />
          最近一次有更新：{fmt(h.lastAt)}{h.summary ? ` · ${h.summary}` : ''}
          {h.error ? (<><br />失败原因：{h.error}</>) : null}
        </div>
        {h.state === 'off' && (
          <div className="field__hint" style={{ marginTop: 6 }}>
            自动同步关着，汇总表更新后网站不会自己拉 —— 上面的复选框打开即可。
          </div>
        )}
        {h.state === 'unconfigured' && (
          <div className="field__hint" style={{ marginTop: 6 }}>
            想让它自动拉，就到下面「⑤ 网盘同步」填坚果云账号 + <b>应用密码</b>（不是登录密码）；
            不想配也没关系，用「从网盘同步汇总表」或「选文件导入」手动导一次效果完全一样。
          </div>
        )}
        {h.state === 'never' && (
          <div className="field__hint" style={{ marginTop: 6 }}>
            还没有成功同步过。点「手动同步一次」走一遍，就能看出是没配账号、路径不对还是密码错了。
          </div>
        )}
        {h.state === 'stale' && (
          <div className="field__hint" style={{ marginTop: 6 }}>
            两种情况长得一样：这几天没打开过网站，或网盘凭据/路径失效。点「手动同步一次」即可区分 ——
            能拉到文件就是前者，报错就是后者。
          </div>
        )}
      </div>
    );
  }

  return (
    <button type="button" onClick={onAction} disabled={!onAction}
      className="row gap-6"
      style={{
        background: 'none', border: 'none', padding: 0, margin: 0, textAlign: 'left',
        cursor: onAction ? 'pointer' : 'default', color: m.color,
        fontSize: 12, lineHeight: 1.5, alignItems: 'center', maxWidth: '100%',
      }}
      title={onAction ? '查看同步详情 / 手动同步一次' : h.text}>
      <Icon name={m.icon} size={13} />
      <span className="truncate">{h.text}</span>
    </button>
  );
}
