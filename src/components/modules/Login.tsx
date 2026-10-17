import React, { useEffect, useState } from 'react';
import { supabase, describeAuthError, INITIAL_AUTH_ERROR } from '../../lib/supabase';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Kit';
import { copyText } from '../../lib/util';
import { applySkinToDocument, readSavedSkin } from '../../lib/skins';

/**
 * 登录 / 注册 / 找回密码 —— 同时也是**未登录访客的落地页**。
 *
 * 为什么要有左侧那一栏：站点是给所有人用的，新访客打开时看到的第一个画面就是这里。
 * 原先是孤零零一张登录卡，除了「云端版 · 多设备同步」之外没有任何信息 ——
 * 陌生人凭什么注册？所以左侧补上「这是什么、能帮我做什么、我的数据在哪」三件事，
 * 右侧保持登录卡不动。窄屏（<880px）隐藏左栏，避免把表单挤到屏幕外。
 *
 * 其余设计要点见 git 历史里的注释：注册分「直接进站 / 需邮箱验证」两个分支、
 * 错误一律翻成人话。
 *
 * ★ 找回密码 = **人工重置**（2026-09-23 改，方案 B）
 *   原先走 supabase.auth.resetPasswordForEmail()，但本站没有配自定义 SMTP，
 *   靠的是 Supabase 免费版**共享**的发信通道：额度每小时个位数、发件域不是本站、
 *   大量邮箱（QQ/163 尤甚）直接判垃圾邮件甚至拒收。结果就是用户点了「发送重置邮件」、
 *   界面还回一句「已发送」，邮件却永远不来 —— 比不提供这个入口更糟。
 *   所以改成：把注册邮箱复制给用户，让他发给站长，由站长在 Supabase 后台重置。
 *   代价是管理员要动手，收益是**用户永远不会卡在「点了没反应」上**。
 *   日后若配好自定义 SMTP（见 README「邮件与找回密码」），把 submit 里那段换回
 *   resetPasswordForEmail 即可；SetPassword.tsx 的 recovery 分支一直留着，没删。
 */
type Mode = 'login' | 'signup' | 'forgot';

/**
 * 人工重置密码时，用户该把邮箱发给谁。填上后会显示在「忘记密码」面板里；
 * 留空则只提示「发给站长」，不显示具体账号。改这一行即全站生效。
 */
export const ADMIN_CONTACT = import.meta.env.VITE_ADMIN_CONTACT ?? '';

/** 把联系方式拼成「（xxx）」，没填就什么都不加 */
export const CONTACT_HINT = ADMIN_CONTACT ? `（${ADMIN_CONTACT}）` : '';

/** 只列**已经跑通**的能力，不写没做的（简历自动填表、自动投递都还没做） */
const FEATURES: { icon: string; title: string; desc: string }[] = [
  { icon: 'layers', title: '网申资料库', desc: '12 大板块，任意字段一键复制，直接粘进企业表单' },
  { icon: 'target', title: '岗位库', desc: '汇总表批量导入解析，标注截止日与匹配度' },
  { icon: 'building', title: '投递看板', desc: '状态流转，并与岗位库、提醒自动对账' },
  { icon: 'calendar', title: '截止提醒', desc: '站内提醒条 + 系统通知 + 可导入手机日历的 ICS' },
  { icon: 'video', title: '面试复盘 / Offer 对比', desc: '当场记下问了什么，多份 Offer 摆一张表里比' },
  { icon: 'paper', title: '备考题库', desc: '笔试真题与面试经验分类管理，可用 AI 生成参考答案' },
  { icon: 'resume', title: '简历与材料', desc: '在线编辑、导出 Word / Markdown，材料清单一键复制路径' },
  { icon: 'sparkles', title: '接你自己的 AI', desc: '填任意 OpenAI 兼容接口的 Key，解锁解析、匹配、代写' },
];

export default function Login() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState(() => {
    try { return localStorage.getItem('qz.lastEmail') || ''; } catch { return ''; }
  });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(INITIAL_AUTH_ERROR);
  const [ok, setOk] = useState('');
  const [needConfirm, setNeedConfirm] = useState(false);

  /* 登录页也走用户选的那套皮肤。
     这里原本写死 data-theme="dark"（当时只有一套深色玻璃）—— 有了皮肤之后，
     写死会让每次登录都出现「深色玻璃落地页 → 登进去变成暖米纸」的一次跳色。
     读的是 localStorage 里那份渲染提示副本：权威值在账号数据里，登录后由 Store 覆盖。 */
  useEffect(() => { applySkinToDocument(readSavedSkin()); }, []);

  const remember = (v: string) => { try { localStorage.setItem('qz.lastEmail', v); } catch { /* ignore */ } };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setOk(''); setBusy(true);
    remember(email.trim());
    try {
      if (mode === 'forgot') {
        /* 方案 B：不发信，只把邮箱复制给用户，由站长人工重置。
           这里刻意**不**调 resetPasswordForEmail —— 原因见文件头「★ 找回密码」注释。 */
        const mail = email.trim();
        if (!mail) { setErr('请先填上你注册时用的邮箱。'); return; }
        const done = await copyText(mail);
        if (done) {
          setOk(`已复制「${mail}」，把它发给站长${CONTACT_HINT}即可。`);
        } else {
          /* 复制失败不能伪装成成功：用 danger 样式逼用户真的手抄一遍 */
          setErr(`自动复制没成功，请手动记下你的邮箱再发给站长${CONTACT_HINT}：${mail}`);
        }
        return;
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (data.session) {
          /* 后台关掉了「Confirm email」，注册即登录 */
          setOk('注册成功，正在进入…');
        } else {
          setNeedConfirm(true);
          setMode('login');
          setOk('注册成功，但还需要邮箱验证：请到邮箱点确认链接后再登录。');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (e2) {
      setErr(describeAuthError(e2));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setErr(''); setOk(''); setBusy(true);
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
      if (error) throw error;
      setOk('验证邮件已重新发送。');
    } catch (e2) { setErr(describeAuthError(e2)); } finally { setBusy(false); }
  };

  const title = mode === 'login' ? '登录你的账号' : mode === 'signup' ? '创建新账号' : '找回密码 · 人工重置';

  return (
    <div className="aurora">
      <div className="aurora__blob aurora__blob--1" /><div className="aurora__blob aurora__blob--2" />
      <div className="aurora__blob aurora__blob--3" /><div className="aurora__blob aurora__blob--4" />
      <div className="aurora__grain" />

      <div className="login-wrap login-wrap--split">
        {/* 左栏：只对未登录访客可见，讲清「这是什么」 */}
        <section className="landing">
          <div className="landing__brand">
            <div className="brand__logo"><Icon name="logo" size={26} strokeWidth={2} /></div>
            <span className="landing__name">秋招网申辅助中心</span>
          </div>
          <h1 className="landing__lead">把秋招的十几件事，收进一个地方</h1>
          <p className="landing__sub">
            岗位与截止、投递进度、网申资料、笔面复盘、Offer 对比 —— 互相对账，
            不再散落在备忘录、聊天记录和十几个浏览器标签页里。
          </p>
          <ul className="landing__feats">
            {FEATURES.map((f) => (
              <li className="landing__feat" key={f.title}>
                <span className="landing__ico"><Icon name={f.icon} size={15} /></span>
                <span>
                  <b>{f.title}</b>
                  <span className="tx-3"> · {f.desc}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="landing__note">
            <Icon name="info" size={13} /> 注册即用，不收费、不放广告。数据存在你自己的账号里，
            「设置 → 数据与备份」里可一键清空（本机与云端一起清）。
          </p>
        </section>

        <form className="glass card login-card" onSubmit={submit}>
          <div className="row gap-10" style={{ marginBottom: 18 }}>
            <div className="brand__logo"><Icon name="logo" size={26} strokeWidth={2} /></div>
            <div style={{ minWidth: 0 }}>
              <div className="h-sub" style={{ fontSize: 17 }}>秋招网申辅助中心</div>
              <div className="tx-4" style={{ fontSize: 11.5 }}>云端版 · 多设备同步</div>
            </div>
          </div>

          <div className="tx-3" style={{ fontSize: 12.5, marginBottom: 18 }}>{title}</div>

          <div className="field" style={{ marginBottom: 12 }}>
            <label className="field__label">邮箱</label>
            <input className="input" type="email" required autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>

          {mode !== 'forgot' && (
            <div className="field" style={{ marginBottom: 16 }}>
              <label className="field__label">密码</label>
              <input className="input" type="password" required minLength={6} value={password}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" />
            </div>
          )}

          {mode === 'forgot' && (
            <div className="login-help">
              <div className="login-help__t"><Icon name="info" size={13} /> 本站不支持自助重置，走人工</div>
              <p>
                系统自带的「发送重置邮件」用的是共享发信通道，额度极小、发件人也不是本站域名，
                邮件经常发不出去或直接进垃圾箱 —— 你会以为点了没反应。所以这里干脆省掉这一步。
              </p>
              <ol>
                <li>点下面的 <b>「复制我的邮箱」</b>；</li>
                <li>把它发给站长{ADMIN_CONTACT ? <>（<b>{ADMIN_CONTACT}</b>）</> : ''}；</li>
                <li>站长核对后给你一个新的临时密码；</li>
                <li>用临时密码登录，再到 <b>「设置 → 云端与同步 → 修改密码」</b> 换成你自己的。</li>
              </ol>
              <p className="tx-4" style={{ marginBottom: 0 }}>
                密码只是登录凭据，换密码<b>不会</b>动数据 —— 岗位、投递、资料都还在你账号里。
              </p>
            </div>
          )}

          {err && <div className="badge badge--danger login-msg">{err}</div>}
          {ok && <div className="badge badge--ok login-msg">{ok}</div>}
          {needConfirm && (
            <Button size="sm" type="button" icon="mail" onClick={resend} disabled={busy} className="btn--block" style={{ marginTop: 8 }}>
              重发验证邮件
            </Button>
          )}

          <Button variant="primary" size="lg" type="submit" className="btn--block" disabled={busy}
            icon={mode === 'forgot' ? 'copy' : undefined} style={{ marginTop: 14 }}>
            {busy ? '处理中…' : mode === 'login' ? '登录' : mode === 'signup' ? '注册' : '复制我的邮箱'}
          </Button>

          <div className="row-between" style={{ marginTop: 16, fontSize: 12.5 }}>
            <span className="tx-3">
              {mode === 'login' ? '还没有账号？' : '已有账号？'}
              <button type="button" className="link-btn"
                onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setErr(''); setOk(''); }}>
                {mode === 'login' ? '注册' : '登录'}
              </button>
            </span>
            {mode !== 'forgot' && (
              <button type="button" className="link-btn" onClick={() => { setMode('forgot'); setErr(''); setOk(''); }}>
                忘记密码？
              </button>
            )}
          </div>

          <div className="divider" style={{ margin: '18px 0 12px' }} />
          <div className="tx-4" style={{ fontSize: 11, lineHeight: 1.75 }}>
            数据存在你自己的账号里（行级安全策略隔离，只有你能读），并同时在本机浏览器留一份缓存，断网也能打开。
            AI Key、邮件桥令牌等敏感配置只存本机，不会上传。
            {mode === 'forgot' && <><br />忘记密码请走人工重置：把注册邮箱发给站长{CONTACT_HINT}，由站长在后台给你临时密码。</>}
          </div>
        </form>
      </div>
    </div>
  );
}
