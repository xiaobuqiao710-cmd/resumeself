import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import type { MailMessage, MailCategory, MailAccount, SendAttachment } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal, Empty, Segmented } from '../ui/Kit';
import { cn, relTime, fmtDateTime, copyText, initials, toISO } from '../../lib/util';
import {
  fetchList, fetchRead, searchMail, sendMail,
  CATEGORY_META, classify, extractDates, getBridgeUrl, setBridgeUrl, DEFAULT_BRIDGE, getBridgeToken, setBridgeToken } from '../../lib/mail';
import { getAiConfig, hasAiKey, aiDraftMail, buildProfileSummary } from '../../lib/ai';

interface Props {
  online: boolean;
  account: MailAccount | null;
  onUnread: (n: number) => void;
  onRefreshBridge: () => void;
}

export default function MailCenter({ online, account, onUnread, onRefreshBridge }: Props) {
  const { addEvents, toast, applications } = useStore();
  /* 邮件里没解析出日期时，用邮件**本地**日期兜底：
     `new Date(created_at).toISOString().slice(0,10)` 取的是 UTC 日期，东八区凌晨收到的邮件会落到前一天。 */
  const mailDate = (m: MailMessage) => {
    const d = new Date(m.created_at);
    return isNaN(d.getTime()) ? toISO(new Date()) : toISO(d);
  };
  const [dir, setDir] = useState<'inbox' | 'sent'>('inbox');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<MailMessage | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<MailCategory | 'all'>('all');
  const [composing, setComposing] = useState<null | { to: string; subject: string; body: string }>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [bridgeInput, setBridgeInput] = useState(getBridgeUrl());
  const [tokenInput, setTokenInput] = useState(getBridgeToken());

  /* 不在这里预判 online：`online` 是渲染时的快照，而「刷新」按钮是先重连桥、再加载，
     用快照判断会让「桥刚起来时点刷新」变成什么都不做（用户看到的是一直空列表，
     切走再回来才有邮件）。离线时请求本身就会失败并给出提示。 */
  const load = useCallback(async (d = dir, query = '') => {
    setLoading(true);
    try {
      const msgs = query ? await searchMail(query, d, 30) : await fetchList(d, 30);
      setMessages(msgs);
      onUnread(msgs.filter((m) => !m.is_read).length);
      if (msgs.length === 0) setActive(null);
    } catch (e: any) {
      toast(`加载失败：${e.message || e}`, 'err');
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  useEffect(() => { if (online) load(dir, q); else { setMessages([]); onUnread(0); } /* eslint-disable-next-line */ }, [online, dir]);

  const openMsg = async (m: MailMessage) => {
    setActive(m);
    if (!m.body) { try { setActive(await fetchRead(m.id)); } catch { /* keep list item */ } }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: messages.length };
    messages.forEach((m) => { const k = m.category || classify(m); c[k] = (c[k] || 0) + 1; });
    return c;
  }, [messages]);
  const shown = useMemo(() => cat === 'all' ? messages : messages.filter((m) => (m.category || classify(m)) === cat), [messages, cat]);

  const syncToCalendar = () => {
    const targets = messages.filter((m) => ['interview', 'test', 'offer'].includes(m.category || classify(m)));
    if (targets.length === 0) { toast('未发现面试/笔试/Offer 类邮件', 'info'); return; }
    /* 走 addEvents 批量写入：它按「日期 + 归一化标题」去重，连点两次不会写出重复日程
       （原先循环调 addEvent，每点一次就多一份同样的日程）。返回值是真实新增条数。 */
    const drafts = targets.map((m) => {
      const c = m.category || classify(m);
      const dates = extractDates(`${m.subject} ${m.snippet || ''} ${m.body || ''}`);
      const type = c === 'offer' ? 'offer' : c === 'test' ? 'test' : 'interview';
      const app = applications.find((a) => (m.subject || '').includes(a.company));
      return {
        title: (m.subject || '招聘邮件').slice(0, 40),
        date: dates[0] || mailDate(m),
        type: type as 'offer' | 'test' | 'interview',
        appId: app?.id,
        source: 'mail' as const,
        note: `来自邮件：${m.from?.email}`,
      };
    });
    const n = addEvents(drafts);
    toast(n ? `已同步 ${n} 封招聘邮件到日历` : `识别到 ${drafts.length} 封招聘邮件，但都已在日历中（未重复添加）`, n ? 'ok' : 'info');
  };

  return (
    <div className="rise">
      <div className="section-head">
        <div>
          <div className="section-head__t">邮件中心</div>
          <div className="section-head__d">
            {online && account ? <>已连接 <b className="grad-text">{account.email}</b> · 通过本地邮件桥直连你的邮箱收发 / 整理 / 同步</>
              : <>连接本地邮件桥后，即可自动收发、整理分类并同步到日历</>}
          </div>
        </div>
        <div className="row gap-8 wrap">
          <Badge tone={online ? 'badge--ok' : 'badge--muted'} dot>{online ? '邮件桥在线' : '未连接'}</Badge>
          <Button size="sm" icon="refresh" onClick={async () => { await onRefreshBridge(); void load(dir, q); }}>刷新</Button>
          <Button size="sm" icon="sparkles" onClick={syncToCalendar} disabled={!online}>同步到日历</Button>
          <Button size="sm" icon="settings" onClick={() => { setBridgeInput(getBridgeUrl()); setShowSetup(true); }}>{online ? '设置' : '连接邮件桥'}</Button>
          <Button variant="primary" icon="send" onClick={() => setComposing({ to: '', subject: '', body: '' })} disabled={!online}>写邮件</Button>
        </div>
      </div>

      {!online ? (
        <div className="glass card">
          <Empty icon="mail" title="本地邮件桥未连接"
            desc="邮件功能通过你电脑上的「本地邮件桥」实现：桥以 IMAP/SMTP 直连你自己的邮箱（凭据只留本机）。公网部署的网站无法直接执行本机命令，需在本机运行该小服务，网站即可自动收发 / 整理 / 同步。点下方按钮下载安装器，双击运行跟着弹窗走完，再把令牌粘进来即可。"
            action={<Button variant="primary" icon="settings" onClick={() => { setBridgeInput(getBridgeUrl()); setShowSetup(true); }}>查看连接步骤</Button>} />
        </div>
      ) : (
        <>
          <div className="row gap-8 wrap" style={{ marginBottom: 14 }}>
            <Segmented value={dir} onChange={(v) => setDir(v)} options={[{ value: 'inbox', label: '收件箱', icon: 'inbox' }, { value: 'sent', label: '已发送', icon: 'send' }]} />
            <div className="search"><Icon name="search" size={16} />
              <input className="input input--sm" style={{ width: 220 }} placeholder="搜索邮件，回车确认…"
                value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(dir, q); }} /></div>
            <Button size="sm" icon="search" onClick={() => load(dir, q)}>搜索</Button>
            <div className="grow" />
            <div className="row gap-6 wrap">
              <CatChip active={cat === 'all'} onClick={() => setCat('all')} label={`全部 ${counts.all || 0}`} />
              {(Object.keys(CATEGORY_META) as MailCategory[]).map((k) => counts[k] ? (
                <CatChip key={k} active={cat === k} onClick={() => setCat(k)} label={`${CATEGORY_META[k].label} ${counts[k]}`} tone={CATEGORY_META[k].cls} />
              ) : null)}
            </div>
          </div>

          <div className="mail-layout">
            <div className="mail-list">
              {loading && messages.length === 0 && [1, 2, 3].map((i) => <div key={i} className="mail-item shimmer" style={{ height: 74 }} />)}
              {!loading && shown.length === 0 && <Empty icon="inbox" title={q ? '没有匹配的邮件' : '此文件夹暂无邮件'} />}
              {shown.map((m) => {
                const c = m.category || classify(m);
                return (
                  <div key={m.id} className={cn('mail-item', active?.id === m.id && 'mail-item--active', !m.is_read && 'mail-item--unread')} onClick={() => openMsg(m)}>
                    <div className="row-between gap-8">
                      <span className="mail-item__from truncate">{m.from?.name || m.from?.email}</span>
                      <span className="tx-4" style={{ fontSize: 10.5, flexShrink: 0 }}>{relTime(m.created_at)}</span>
                    </div>
                    <div className="mail-item__subj truncate">{m.subject || '(无主题)'}</div>
                    <div className="row-between gap-8" style={{ marginTop: 3 }}>
                      <span className="mail-item__snip clamp-2 grow">{m.snippet}</span>
                      <Badge tone={CATEGORY_META[c].cls}>{CATEGORY_META[c].label}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mail-read glass">
              {!active ? <Empty icon="mail" title="选择一封邮件查看" desc="点击左侧邮件读取完整内容，可回复、加入日历或识别为招聘通知。" /> : (
                <div className="fade" key={active.id}>
                  <div className="row gap-8 wrap" style={{ marginBottom: 10 }}>
                    <Badge tone={CATEGORY_META[active.category || 'other'].cls}>{CATEGORY_META[active.category || 'other'].label}</Badge>
                    {active.has_attachments && <Badge tone="badge--muted"><Icon name="doc" size={11} /> 含附件</Badge>}
                    <span className="tx-4" style={{ fontSize: 11.5 }}>{fmtDateTime(active.created_at)}</span>
                  </div>
                  <h2 className="h-title" style={{ marginBottom: 10 }}>{active.subject || '(无主题)'}</h2>
                  <div className="row gap-10" style={{ paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,.08)' }}>
                    <span className="tile">{initials(active.from?.name || active.from?.email || '?')}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{active.from?.name || active.from?.email}</div>
                      <div className="tx-3 truncate" style={{ fontSize: 12 }}>&lt;{active.from?.email}&gt; → {(active.to || []).map((t) => t.email).join(', ')}</div>
                    </div>
                  </div>
                  <div className="mail-read__body">
                    {active.body_is_html
                      ? <iframe title="mail" sandbox="" srcDoc={active.body || ''} style={{ minHeight: 280 }} />
                      : (active.body || active.snippet || '(无正文)')}
                  </div>
                  <div className="row gap-8 wrap" style={{ marginTop: 18 }}>
                    <Button size="sm" icon="send" onClick={() => setComposing({ to: active.from?.email || '', subject: `Re: ${active.subject || ''}`, body: '\n\n—— 原邮件 ——\n' + (active.snippet || '') })}>回复</Button>
                    <Button size="sm" icon="calendar" onClick={() => {
                      const dates = extractDates(`${active.subject} ${active.body || active.snippet || ''}`);
                      const c = active.category || classify(active);
                      const n = addEvents([{ title: (active.subject || '招聘邮件').slice(0, 40), date: dates[0] || mailDate(active), type: (c === 'offer' ? 'offer' : c === 'test' ? 'test' : c === 'interview' ? 'interview' : 'other') as 'offer' | 'test' | 'interview' | 'other', source: 'mail', note: `来自邮件：${active.from?.email}` }]);
                      toast(n ? '已加入日历' : '这条已在日历里了（未重复添加）', n ? 'ok' : 'info');
                    }}>加入日历</Button>
                    <Button size="sm" icon="copy" onClick={async () => { if (await copyText(active.from?.email || '')) toast('已复制发件人邮箱'); }}>复制发件人</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {composing && <ComposeModal account={account} init={composing} onClose={() => setComposing(null)} onSent={() => { setComposing(null); load(dir, q); }} />}

      {showSetup && <SetupModal onClose={() => setShowSetup(false)} bridgeInput={bridgeInput} setBridgeInput={setBridgeInput}
        tokenInput={tokenInput} setTokenInput={setTokenInput}
        onSave={() => { setBridgeUrl(bridgeInput.trim() || DEFAULT_BRIDGE); setBridgeToken(tokenInput); setShowSetup(false); toast('已保存邮件桥地址与令牌'); onRefreshBridge(); }} />}
    </div>
  );
}

function CatChip({ active, onClick, label, tone }: { active: boolean; onClick: () => void; label: string; tone?: string }) {
  return <button className={cn('badge', active ? (tone || 'badge--accent') : 'badge--muted')} style={{ cursor: 'pointer', padding: '4px 10px' }} onClick={onClick}>{label}</button>;
}

function ComposeModal({ account, init, onClose, onSent }:
  { account: MailAccount | null; init: { to: string; subject: string; body: string }; onClose: () => void; onSent: () => void }) {
  const { toast, profile } = useStore();
  const [to, setTo] = useState(init.to);
  const [subject, setSubject] = useState(init.subject);
  const [body, setBody] = useState(init.body);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ token: string; summary: string } | null>(null);
  const [atts, setAtts] = useState<{ file: SendAttachment; size: number }[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiAsk, setAiAsk] = useState('');

  const pickFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).slice(0, 5 - atts.length).forEach((f) => {
      if (f.size > 20 * 1024 * 1024) { toast(`附件 ${f.name} 超过 20MB，已跳过`, 'err'); return; }
      const r = new FileReader();
      r.onload = () => {
        const b64 = String(r.result || '').split(',')[1] || '';
        setAtts((xs) => [...xs, { file: { filename: f.name, dataBase64: b64 }, size: f.size }]);
      };
      r.readAsDataURL(f);
    });
  };

  const doAiDraft = async () => {
    if (!aiAsk.trim()) { toast('请先描述写信要求', 'err'); return; }
    if (!hasAiKey()) { toast('未配置 API Key，请在设置中填入后使用 AI 代写', 'err'); return; }
    setAiBusy(true);
    try {
      const draft = await aiDraftMail(aiAsk.trim(), buildProfileSummary(profile), getAiConfig());
      if (!draft) { toast('AI 返回格式异常，请重试', 'err'); return; }
      setSubject(draft.subject || subject);
      setBody(draft.body || body);
      setAiOpen(false);
      toast('AI 已生成草稿，可继续编辑');
    } catch (e: any) { toast(`AI 代写失败：${e.message || e}`, 'err'); }
    finally { setAiBusy(false); }
  };

  const doSend = async (token?: string) => {
    if (!to.trim()) { toast('请填写收件人', 'err'); return; }
    setBusy(true);
    try {
      const res = await sendMail({
        to: to.split(/[,;\s]+/).filter(Boolean), subject, body,
        attachments: atts.map((a) => a.file),
        confirmation_token: token,
      });
      if (res.need_confirm && res.confirmation_token) setConfirm({ token: res.confirmation_token, summary: res.summary || '' });
      else if (res.sent) { toast('邮件已发送'); onSent(); }
      else if (res.error) toast(res.error, 'err');
    } catch (e: any) { toast(`发送失败：${e.message || e}`, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} icon="send" title="写邮件"
      footer={confirm ? (<>
        <Button onClick={() => setConfirm(null)}>返回修改</Button>
        <Button variant="primary" icon="send" disabled={busy} onClick={() => doSend(confirm.token)}>确认发送</Button>
      </>) : (<>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="send" disabled={busy} onClick={() => doSend()}>{busy ? '处理中…' : '发送'}</Button>
      </>)}>
      {confirm ? (
        <div className="glass" style={{ padding: 16, borderRadius: 16 }}>
          <div className="card__title" style={{ marginBottom: 10 }}><Icon name="alert" size={17} /> 请确认发送</div>
          <pre className="tx-2" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, margin: 0, fontFamily: 'var(--font)' }}>{confirm.summary}</pre>
          <div className="field__hint" style={{ marginTop: 12 }}>写操作不可撤销，确认后才会真正发出。</div>
        </div>
      ) : (
        <div className="col gap-12">
          <div className="field"><label className="field__label">发件人</label><input className="input" value={account?.email || '（连接后显示）'} disabled /></div>
          <div className="field"><label className="field__label">收件人 <span className="field__req">*</span></label>
            <input className="input" value={to} placeholder="多个收件人用逗号分隔" onChange={(e) => setTo(e.target.value)} /></div>
          <div className="field"><label className="field__label">主题</label>
            <div className="row gap-8">
              <input className="input grow" value={subject} onChange={(e) => setSubject(e.target.value)} />
              <Button size="sm" icon="sparkles" disabled={aiBusy} onClick={() => setAiOpen(true)}>{aiBusy ? '生成中…' : 'AI 代写'}</Button>
            </div></div>
          <div className="field"><label className="field__label">正文</label>
            <textarea className="textarea" style={{ minHeight: 180 }} value={body} onChange={(e) => setBody(e.target.value)} /></div>
          <div className="field">
            <label className="field__label">附件 <span className="tx-4" style={{ fontWeight: 500 }}>最多 5 个，单个 ≤ 20MB（如简历 PDF）</span></label>
            <div className="row gap-8 wrap">
              <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
                <Icon name="upload" size={14} /> 添加附件
                <input type="file" multiple hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }} />
              </label>
              {atts.map((a, i) => (
                <span key={i} className="badge badge--muted" style={{ padding: '4px 10px' }}>
                  <Icon name="doc" size={11} /> {a.file.filename} · {(a.size / 1024).toFixed(0)} KB
                  <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 0 0 4px' }}
                    onClick={() => setAtts((xs) => xs.filter((_, j) => j !== i))} aria-label="移除">✕</button>
                </span>
              ))}
            </div>
          </div>
          {aiOpen && (
            <div className="glass" style={{ padding: 14, borderRadius: 16 }}>
              <div className="card__title" style={{ marginBottom: 8, fontSize: 13.5 }}><Icon name="sparkles" size={15} /> AI 代写邮件</div>
              <textarea className="textarea" style={{ minHeight: 64 }} value={aiAsk}
                placeholder="描述写信要求，如：给中金公司 HR 写一封法务岗投递邮件，附上简历，说明教育背景与实习经历亮点，语气诚恳专业"
                onChange={(e) => setAiAsk(e.target.value)} />
              <div className="row gap-8" style={{ marginTop: 8 }}>
                <Button size="sm" variant="primary" icon="sparkles" disabled={aiBusy} onClick={doAiDraft}>{aiBusy ? '生成中…' : '生成主题与正文'}</Button>
                <Button size="sm" onClick={() => setAiOpen(false)}>收起</Button>
                {!hasAiKey() && <span className="badge badge--warn">未配置 API Key，请先在设置中填入</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function SetupModal({ onClose, bridgeInput, setBridgeInput, tokenInput, setTokenInput, onSave }:
  { onClose: () => void; bridgeInput: string; setBridgeInput: (s: string) => void;
    tokenInput: string; setTokenInput: (s: string) => void; onSave: () => void }) {
  const step = (n: number, t: string, code?: string, d?: string) => (
    <div className="row gap-12" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
      <span className="tile" style={{ width: 28, height: 28, borderRadius: 9, fontSize: 13 }}>{n}</span>
      <div className="grow">
        <div style={{ fontSize: 13.5, fontWeight: 640 }}>{t}</div>
        {d && <div className="field__hint" style={{ marginTop: 3 }}>{d}</div>}
        {code && <pre className="kbd" style={{ display: 'block', marginTop: 7, padding: '9px 12px', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6 }}>{code}</pre>}
      </div>
    </div>
  );
  return (
    <Modal open onClose={onClose} icon="settings" title="连接本地邮件桥"
      footer={<><Button onClick={onClose}>关闭</Button><Button variant="primary" icon="check" onClick={onSave}>保存地址</Button></>}>
      <div className="field" style={{ marginBottom: 18 }}>
        <label className="field__label">邮件桥地址</label>
        <input className="input mono" value={bridgeInput} onChange={(e) => setBridgeInput(e.target.value)} placeholder={DEFAULT_BRIDGE} />
        <div className="field__hint">默认 http://localhost:8787。邮件桥跑在你自己电脑上，装好并启动后即可用这个地址访问。</div>
      </div>
      <div className="field" style={{ marginBottom: 18 }}>
        <label className="field__label">访问令牌（X-QZ-Token）</label>
        <input className="input mono" type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)}
          placeholder="48 位令牌（安装时会自动复制到剪贴板，⌘V 粘贴即可）" onBlur={() => setBridgeToken(tokenInput)} />
        <div className="field__hint">
          必填。没有令牌，任何你打开的网页都能悄悄调用本机邮件桥读取邮箱。令牌自动生成在
          <b> mail-bridge/bridge.token</b>；只存本机浏览器。
        </div>
      </div>
      <div className="divider" />
      <div className="h-sub" style={{ marginBottom: 4 }}>还没装？下载后双击一次就好</div>
      <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.8, marginBottom: 12 }}>
        点下面按钮下载安装文件，双击运行，跟着弹窗走完即可 ——
        不用打开终端、不用敲命令。它会自动检查环境、装依赖、问你邮箱和授权码、配好开机自启，
        并把令牌复制到剪贴板。<b>装完回到这里，地址保持默认，令牌按 ⌘V 粘贴</b>，点「保存并重连」。
      </div>
      <div className="row gap-8" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <a className="btn btn--primary" href="/download/邮件桥安装器.zip" download>
          <Icon name="download" size={15} /> 下载安装器（macOS）
        </a>
      </div>
      <div className="glass" style={{ padding: 12, borderRadius: 14, marginBottom: 12 }}>
        <div className="tx-3" style={{ fontSize: 12, lineHeight: 1.7 }}>
          <Icon name="sparkles" size={13} /> <b>下载的是 zip，解压后双击「安装邮件桥.command」。</b>为什么打包：浏览器下载会丢掉
          文件的可执行权限，直接下 <code className="mono">.command</code> 双击会<b>毫无反应</b>，而 zip 解压能保留权限。
          <br />
          <b>仍提示「无法验证开发者」？</b>这是 macOS 的隔离标记：<b>右键点文件 → 选「打开」</b>，再点一次「打开」即可；
          或执行 <code className="mono">xattr -d com.apple.quarantine ~/Downloads/图鲲邮件桥/安装邮件桥.command</code>。
          这是纯文本脚本，可用文本编辑器打开核对它做的每一步。
        </div>
      </div>
      {step(1, '解压后双击安装', '安装邮件桥.command', '会自动装依赖、配服务器、设开机自启。需要先装 Node.js 18+（没有会提示并打开下载页）。')}
      {step(2, '填邮箱与授权码', '（弹窗里填，无需命令行）', '授权码 = 邮箱设置里生成的「IMAP/SMTP 授权码」，不是登录密码；凭据只存本机。')}
      {step(3, '自动验证并启动', '（安装器自动完成）', '安装器会真连一次邮箱确认授权码有效，然后把令牌复制到剪贴板。')}
      {step(4, '回到这里粘贴令牌', '⌘V', '地址保持 http://localhost:8787，令牌粘进上面的输入框，点「保存并重连」。')}
      <div className="glass" style={{ padding: 12, borderRadius: 14, marginTop: 6 }}>
        <div className="tx-3" style={{ fontSize: 12, lineHeight: 1.7 }}>
          <Icon name="sparkles" size={13} /> 出于安全，浏览器无法从公网网站直接调用本机邮件；邮件桥在你电脑上以 IMAP/SMTP 直连你的邮箱，凭据不出本机。发送遵循两阶段确认，绝不会自动发出未经你确认的邮件。
        </div>
      </div>
    </Modal>
  );
}
