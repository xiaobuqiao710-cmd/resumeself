import React, { useState } from 'react';
import { supabase, describeAuthError } from '../../lib/supabase';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Kit';

/**
 * 设置 / 修改密码。
 *
 * 主要用途：「设置 → 云端与同步 → 修改密码」。用户拿到站长核发的临时密码登录后，
 * 在这里换成自己的密码 —— 没有这一屏，他就永远卡在临时密码上。
 *
 * 同一个组件两用：
 *   `mode="recovery"`：原本是「重置密码邮件回跳」后的强制设置屏（Supabase 带着
 *     `#...&type=recovery` 回跳时会把人生成登录态，但密码一个字节都没变，
 *     没有这一屏用户就会以为重置成功了）。自 2026-09-23 起本站改走**人工重置**
 *     （原因见 Login.tsx 文件头），产品内已不再产生 recovery 回跳；这一支保留未删，
 *     日后配好自定义 SMTP 就能直接复活。
 *   `mode="change"`：已登录用户在设置里的主动改密。
 */
export default function SetPassword({ mode, onDone, onCancel }:
  { mode: 'recovery' | 'change'; onDone: () => void; onCancel?: () => void }) {
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);

  /** 简单强度检查：Supabase 默认下限是 6 位，这里给用户更明确的提示口径 */
  const tooWeak = pwd.length > 0 && pwd.length < 6;
  const mismatch = pwd2.length > 0 && pwd !== pwd2;
  const canSubmit = pwd.length >= 6 && pwd === pwd2 && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setErr(''); setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pwd });
      if (error) throw error;
      setOk(true);
      /* 立刻清掉地址栏里的 access_token —— 它是一次性凭据，
         留在 URL 里会被浏览器历史、截图、分享链接带走。 */
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      setTimeout(onDone, 1200);
    } catch (e2) {
      setErr(describeAuthError(e2));
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <form className={mode === 'recovery' ? 'glass card login-card' : ''} onSubmit={submit}>
      {mode === 'recovery' ? (
        <div className="row gap-10" style={{ marginBottom: 18 }}>
          <div className="brand__logo"><Icon name="logo" size={26} strokeWidth={2} /></div>
          <div style={{ minWidth: 0 }}>
            <div className="h-sub" style={{ fontSize: 17 }}>设置新密码</div>
            <div className="tx-4" style={{ fontSize: 11.5 }}>临时密码已验证，设置后即可用新密码登录</div>
          </div>
        </div>
      ) : (
        <div className="field__hint" style={{ marginBottom: 12 }}>修改后，其他设备需要用新密码重新登录。</div>
      )}

      <div className="field" style={{ marginBottom: 12 }}>
        <label className="field__label">新密码</label>
        <input className="input" type="password" required minLength={6} autoComplete="new-password"
          value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="至少 6 位" autoFocus />
        {tooWeak && <div className="field__hint" style={{ color: 'var(--danger)' }}>密码至少 6 位</div>}
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label className="field__label">再输一次</label>
        <input className="input" type="password" required minLength={6} autoComplete="new-password"
          value={pwd2} onChange={(e) => setPwd2(e.target.value)} placeholder="两次要一致" />
        {mismatch && <div className="field__hint" style={{ color: 'var(--danger)' }}>两次输入不一致</div>}
      </div>

      {err && <div className="badge badge--danger login-msg">{err}</div>}
      {ok && <div className="badge badge--ok login-msg">密码已更新，正在进入…</div>}

      <Button variant="primary" size="lg" type="submit" className="btn--block" disabled={!canSubmit} style={{ marginTop: 14 }}>
        {busy ? '保存中…' : '保存新密码'}
      </Button>

      {mode === 'change' && onCancel && (
        <Button size="sm" type="button" className="btn--block" style={{ marginTop: 8 }} onClick={onCancel} disabled={busy}>取消</Button>
      )}
      {mode === 'recovery' && (
        <div className="tx-4" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.7 }}>
          临时密码有时效。若已失效，请在登录页点「忘记密码」，把注册邮箱发给站长再要一个。
        </div>
      )}
    </form>
  );

  /* recovery 是独立整屏（此时还没进站）；change 是在设置弹窗里，不套 aurora 背景 */
  if (mode === 'change') return body;
  return (
    <div className="aurora">
      <div className="aurora__blob aurora__blob--1" /><div className="aurora__blob aurora__blob--2" />
      <div className="aurora__blob aurora__blob--3" /><div className="aurora__blob aurora__blob--4" />
      <div className="aurora__grain" />
      <div className="login-wrap">{body}</div>
    </div>
  );
}
