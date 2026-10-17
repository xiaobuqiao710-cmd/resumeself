import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Button, Badge } from './Kit';
import { RichText } from './RichText';
import { useStore } from '../../store/store';
import { getAiConfig, hasAiKey, hasSearchKey } from '../../lib/ai';
import {
  AGENT_TOOLS, AGENT_SYSTEM, buildAgentContext, callModelWithTools, runToolAsync, sanitizeConversation, type AgentHost, type ToolRun,
} from '../../lib/agent';
import { cn } from '../../lib/util';
import { newSession, listSessions, loadSession, latestSession, saveSession, deleteSession, type AgentSession, type AgentUiMsg } from '../../lib/agentStore';
import type { ViewId } from '../../types';

type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; runs?: ToolRun[] }
  | { role: 'error'; content: string };

const EXAMPLES = [
  '我投了哪些单位？还有哪些没投？',
  '列出未来 3 天要截止的岗位',
  '题库里有哪些分类和库？各有多少题',
  '把「某某集团」标记为已投递',
  '本周有几场笔试或面试？',
  '我的资料库里个人信息填了哪些',
  /* 联网搜索的示范：没有这一条，用户不会想到这个助手还能查站外信息 */
  '联网搜一下国家开发银行 2027 校招的笔试考什么',
];

/* 轻量 Markdown 渲染已抽到 ui/RichText.tsx —— 助手对话与题库参考答案共用同一份实现，
 * 免得「对话里能加粗、答案里冒 **」这种同一站内两套观感的问题再出现。 */

/**
 * 站内 AI 助手：对话即可直接操作网站。
 * 纯前端 agent —— 用用户自己配置的 API Key，工具直接读写站内数据。
 * 只有「模型请求」会发到用户自己填的那家服务商；站点不代转、不留存对话。
 */
export function AgentPanel({ fullPage = false, docked = false, floating = false, width, onResize, onOpen = () => {}, onClose = () => {} }:
  { fullPage?: boolean; docked?: boolean; floating?: boolean;
    /** 右侧常驻列宽度（受控）；不传则用 CSS 默认值 */
    width?: number;
    /** 拖拽调整宽度后回调（只在 docked 下生效） */
    onResize?: (w: number) => void;
    onOpen?: () => void; onClose?: () => void } = {}) {
  const store = useStore();
  const bootRef = useRef<AgentSession | null>(null);
  if (!bootRef.current) bootRef.current = latestSession() || newSession();
  const sessRef = useRef<AgentSession>(bootRef.current);
  const [msgs, setMsgs] = useState<ChatMessage[]>((bootRef.current.msgs || []) as ChatMessage[]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState(() => listSessions());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ name: string; args: Record<string, unknown>; summary: string } | null>(null);
  const convRef = useRef<unknown[]>(bootRef.current.raw || []);
  const batchRef = useRef<{ calls: { id: string; name: string; args: Record<string, unknown> }[]; idx: number; depth: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const host: AgentHost = {
    jobs: store.jobs, applications: store.applications, events: store.events,
    profile: store.profile, questions: store.questions, banks: store.banks,
    bankCategories: store.bankCategories, interviews: store.interviews, offers: store.offers,
    materials: store.materials, contacts: store.contacts,
    addJob: store.addJob, updateJob: store.updateJob, removeJob: store.removeJob,
    addApp: store.addApp, setStatus: store.setStatus, removeApp: store.removeApp,
    addEvent: store.addEvent, setView: store.setView as (v: ViewId) => void,
    addQuestion: store.addQuestion, updateQuestion: store.updateQuestion, removeQuestion: store.removeQuestion,
    addBank: store.addBank, addCategory: store.addCategory,
    addInterview: store.addInterview, addOffer: store.addOffer,
    setSingle: store.setSingle, updateMulti: store.updateMulti, addMulti: store.addMulti,
    updateMaterial: store.updateMaterial, addContact: store.addContact,
  };
  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy, pending]);

  useEffect(() => {
    if (!msgs.length && !(convRef.current || []).length) return;
    sessRef.current = { ...sessRef.current, msgs: msgs as AgentUiMsg[], raw: convRef.current as unknown[] };
    saveSession(sessRef.current);
    setSessions(listSessions());
  }, [msgs]);

  /* 输入框随内容长高（最多 5 行），省得长问题只能看到一行 */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(120, Math.max(38, el.scrollHeight)) + 'px';
  }, [input]);

  const push = (m: ChatMessage) => setMsgs((xs) => [...xs, m]);

  const loopRef = useRef<((d: number) => Promise<void>) | null>(null);

  const execBatch = useCallback(async (batch: { calls: { id: string; name: string; args: Record<string, unknown> }[]; idx: number }, depth: number) => {
    const runs: ToolRun[] = [];
    for (let i = batch.idx; i < batch.calls.length; i++) {
      const c = batch.calls[i];
      const spec = AGENT_TOOLS.find((t) => t.name === c.name);
      if (spec?.destructive) {
        batchRef.current = { calls: batch.calls, idx: i, depth };
        setPending({ name: c.name, args: c.args, summary: spec.description });
        if (runs.length) push({ role: 'assistant', content: '', runs });
        setBusy(false);
        return;
      }
      const r = await runToolAsync(hostRef.current, c.name, c.args);
      runs.push(r);
      (convRef.current as unknown[]).push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(r.result ?? { ok: r.ok, summary: r.summary }) });
    }
    if (runs.length) push({ role: 'assistant', content: '', runs });
    await loopRef.current?.(depth + 1);
  }, []);

  const loop = useCallback(async (depth = 0) => {
    if (depth > 6) { push({ role: 'assistant', content: '（步骤过多，已停止。请把需求说得更具体一些）' }); setBusy(false); return; }
    const cfg = getAiConfig();
    try {
      convRef.current = sanitizeConversation(convRef.current);
      const reply = await callModelWithTools(cfg, convRef.current as never[]);
      (convRef.current as unknown[]).push(reply);
      const calls = ((reply as { tool_calls?: unknown[] }).tool_calls || []) as {
        id: string; function: { name: string; arguments?: string };
      }[];
      if (!calls.length) {
        push({ role: 'assistant', content: (reply.content || '（没有回复内容）').toString() });
        setBusy(false);
        return;
      }
      const batch = {
        calls: calls.map((c) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* 参数不合法 */ }
          return { id: c.id, name: c.function.name, args };
        }),
        idx: 0,
      };
      await execBatch(batch, depth);
    } catch (e) {
      push({ role: 'error', content: (e as Error).message });
      setBusy(false);
    }
  }, []);

  loopRef.current = loop;

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    if (!hasAiKey()) { push({ role: 'error', content: '还没配置 AI：请到「设置 → AI 助手」填入 API Key（如 DeepSeek）。' }); return; }
    /* 上一批危险操作的确认卡还挂着时又发了新消息 → 那条 assistant(tool_calls) 的回执
       永远补不齐了。当作「用户放弃了确认」：补齐跳过回执、收起确认卡。
       不这么做的话，之后点「确认执行」会补出一条迟到的 tool —— 结构合法但会被体检
       当孤儿丢掉，结果是数据真删了、模型却不知道，下一轮它还会说「这条还在」。 */
    if (batchRef.current) {
      const b = batchRef.current;
      const conv = convRef.current as unknown[];
      for (let i = b.idx; i < b.calls.length; i++) {
        conv.push({ role: 'tool', tool_call_id: b.calls[i].id, content: JSON.stringify({ ok: false, summary: '用户取消了该操作' }) });
      }
      batchRef.current = null;
      setPending(null);
    }
    setInput('');
    push({ role: 'user', content: q });
    setBusy(true);
    const sys = `${AGENT_SYSTEM}\n\n【当前站点状态】\n${buildAgentContext(hostRef.current)}`;
    /* 先体检再落 system。以前是盲写 convRef.current[0]：历史被截断过时 [0] 可能是一条
       tool 或 assistant(tool_calls)，这一写就把它顶掉，它后面的 tool 全部变成孤儿 → 400。 */
    convRef.current = sanitizeConversation(convRef.current);
    const conv = convRef.current as { role?: string; content?: string }[];
    const si = conv.findIndex((m) => m?.role === 'system');
    if (si >= 0) conv[si] = { role: 'system', content: sys };
    else convRef.current = [{ role: 'system', content: sys }, ...convRef.current];
    (convRef.current as unknown[]).push({ role: 'user', content: q });
    await loop(0);
  };

  const resolvePending = async (ok: boolean) => {
    const b = batchRef.current;
    setPending(null);
    batchRef.current = null;
    if (!b) return;
    const c = b.calls[b.idx];
    const conv = convRef.current as unknown[];
    if (ok) {
      /* 危险操作里也有联网工具的可能（未来若加入），统一走异步入口，别在这里漏掉一层 */
      const r = await runToolAsync(hostRef.current, c.name, c.args);
      conv.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(r.result ?? { ok: r.ok, summary: r.summary }) });
      push({ role: 'assistant', content: '', runs: [r] });
      setBusy(true);
      void execBatch({ calls: b.calls, idx: b.idx + 1 }, b.depth + 1);
    } else {
      conv.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, summary: '用户取消了该操作' }) });
      for (let i = b.idx + 1; i < b.calls.length; i++) {
        conv.push({ role: 'tool', tool_call_id: b.calls[i].id, content: JSON.stringify({ ok: false, summary: '已跳过（用户取消了该批次）' }) });
      }
      push({ role: 'assistant', content: '好，已取消，没有做任何改动。' });
    }
  };

  const openSession = (id: string) => {
    const se = loadSession(id);
    if (!se) return;
    sessRef.current = se;
    /* 老会话的 raw 可能带着上次被截断留下的孤儿 tool 消息（或 [0] 已不是 system）。
       载入时先体检一次：既让历史立刻可用，也顺手把它写回 localStorage（下面 msgs
       变化的 effect 会存），免得带着坏结构一直传下去。 */
    convRef.current = sanitizeConversation(se.raw || []);
    setMsgs((se.msgs || []) as ChatMessage[]);
    setPending(null); batchRef.current = null; setHistoryOpen(false);
  };

  const startNew = () => {
    const se = newSession();
    sessRef.current = se;
    convRef.current = [];
    setMsgs([]); setPending(null); batchRef.current = null; setHistoryOpen(false);
  };

  const toolLabel = (n: string) => ({
    web_search: '联网搜索',
    search_jobs: '检索岗位', search_applications: '检索投递', upcoming_deadlines: '查截止', site_stats: '统计',
    add_job: '新增岗位', update_job_status: '改岗位状态', update_job: '改岗位信息', add_application: '新增投递',
    set_application_status: '改投递状态', add_event: '加日历', navigate: '切换页面',
    dedupe_jobs: '清理重复岗位', delete_job: '删除岗位', delete_application: '删除投递',
    question_banks: '看题库结构', search_questions: '检索题目', add_question: '新增题目',
    add_bank: '新建题库库', add_bank_category: '新建题库分类', update_question: '改题目', delete_question: '删题目',
    search_interviews: '查面试复盘', add_interview: '记录面试复盘',
    search_offers: '查 Offer', add_offer: '新增 Offer',
    profile_read: '读资料库', profile_write: '写资料库',
    materials: '查材料清单', update_material: '改材料清单',
    search_contacts: '查人脉', add_contact: '新增人脉',
  }[n] || n);

  /** 危险操作确认：把参数翻译成人能读的字段行，别丢一段 JSON 给用户看 */
  const argsRows = (args: Record<string, unknown>) => {
    const label: Record<string, string> = {
      company: '单位', title: '岗位', query: '匹配', position: '岗位', status: '状态',
      bank: '库', cat: '分类', name: '名称', mastered: '已掌握', path: '路径',
      company_filter: '限定单位', merge_similar: '合并相似标题', dry_run: '仅预演',
    };
    return Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
  };

  /* ---- 拖拽调宽（右侧常驻列）---- */
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    if (!docked || !onResize) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: width || 384 };
    e.preventDefault();
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !onResize) return;
    const delta = dragRef.current.startX - e.clientX;
    const max = Math.max(360, Math.min(760, window.innerWidth - 640));
    onResize(Math.round(Math.min(max, Math.max(320, dragRef.current.startW + delta))));
  };
  const onDragEnd = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  /* 浮窗尺寸（本地态，双击标题栏复位） */
  const [float, setFloat] = useState({ w: 400, h: 0 });
  const fDrag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const onFloatDown = (e: React.PointerEvent) => {
    const el = (e.currentTarget as HTMLElement).parentElement;
    if (!el) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    fDrag.current = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
    e.preventDefault();
  };
  const onFloatMove = (e: React.PointerEvent) => {
    const d = fDrag.current;
    if (!d) return;
    const w = Math.min(Math.max(320, d.w - (e.clientX - d.x)), window.innerWidth - 24);
    const h = Math.min(Math.max(320, d.h - (e.clientY - d.y)), window.innerHeight - 24);
    setFloat({ w: Math.round(w), h: Math.round(h) });
  };
  const onFloatUp = (e: React.PointerEvent) => {
    fDrag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  if (typeof document === 'undefined') return null;

  const head = (
    <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--glass-brd)', position: 'relative', flexShrink: 0 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <span className="row gap-8" style={{ alignItems: 'center', flex: '1 1 180px', minWidth: 0 }}>
          <span className="acc__ico" style={{ width: 26, height: 26, borderRadius: 9, flex: 'none' }}><Icon name="sparkles" size={14} /></span>
          <span className="h-sub" style={{ fontSize: 13.5, whiteSpace: 'nowrap', flex: 'none' }}>AI 助手</span>
          <Badge tone={hasAiKey() ? 'badge--ok' : 'badge--warn'} className="truncate">
            <span className="truncate" style={{ display: 'block', minWidth: 0, maxWidth: 110 }}>
              {hasAiKey() ? getAiConfig().model : '未配置 Key'}
            </span>
          </Badge>
        </span>
        <span className="row gap-6 wrap" style={{ flex: '0 0 auto', marginLeft: 'auto' }}>
          <Button size="sm" variant="ghost" icon="plus" onClick={startNew} title="开始新对话（当前对话会留在历史里）">新对话</Button>
          <Button size="sm" variant="ghost" icon="clock" onClick={() => setHistoryOpen((v) => !v)} title="历史对话">
            历史{sessions.length ? ` ${sessions.length}` : ''}
          </Button>
          {!fullPage && !docked && (
            <Button size="sm" variant="ghost" icon="external" title="在独立窗口打开"
              onClick={() => window.open(`${location.pathname}?agent=1`, '_blank', 'width=560,height=800')} />
          )}
          {fullPage
            ? <a className="btn btn--sm btn--ghost" href={location.pathname} title="回到网站"><Icon name="chevronR" size={14} /></a>
            : <Button size="sm" variant="ghost" icon={docked ? 'chevronR' : 'x'} onClick={onClose} aria-label={docked ? '收起右栏' : '收起'} />}
        </span>
      </div>

      {historyOpen && (
        <>
          <div onClick={() => setHistoryOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
          <div className="glass glass--strong"
            style={{ position: 'absolute', right: 10, top: 'calc(100% - 4px)', zIndex: 71, width: 300, maxHeight: 320, overflowY: 'auto', padding: 6, borderRadius: 14 }}>
            <div className="row-between" style={{ padding: '4px 8px 8px' }}>
              <span className="tx-4" style={{ fontSize: 11 }}>历史对话（保存在本机浏览器）</span>
              <button className="copy-btn" onClick={startNew}>+ 新对话</button>
            </div>
            {sessions.length === 0 && <div className="tx-4" style={{ fontSize: 12, padding: '6px 8px' }}>还没有历史对话</div>}
            {sessions.map((se) => (
              <div key={se.id} className="row gap-8" style={{ padding: '7px 8px', borderRadius: 10, alignItems: 'center', background: se.id === sessRef.current.id ? 'var(--glass-bg-strong)' : undefined }}>
                <button className="grow" style={{ textAlign: 'left', minWidth: 0 }} onClick={() => openSession(se.id)}>
                  <span className="truncate" style={{ display: 'block', fontSize: 12.5 }}>{se.title || '新对话'}</span>
                  <span className="tx-4" style={{ display: 'block', fontSize: 10.5 }}>
                    {new Date(se.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {se.count} 条
                  </span>
                </button>
                <Button size="sm" variant="ghost" icon="trash" aria-label="删除该对话"
                  onClick={() => { deleteSession(se.id); setSessions(listSessions()); if (se.id === sessRef.current.id) startNew(); }} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );

  const body = (
    <div ref={listRef} className="grow" style={{ overflowY: 'auto', padding: 14, ...(fullPage ? { maxWidth: 820, width: '100%', margin: '0 auto' } : {}) }}>
      {msgs.length === 0 && (
        <div className="col gap-12">
          <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            直接说你要做什么，我会在网站上执行 —— 查岗位、改投递状态、整理题库、读资料库、记面试复盘都行。
            数据只在你浏览器里，用的是你自己配的 AI Key。
          </div>
          {/* 不把「能不能联网」写在界面上，用户根本不知道还有这条路 ——
              配了就当能力清单说，没配就顺手给个入口，两种状态都不含糊。 */}
          <div className="tx-4" style={{ fontSize: 11.5, lineHeight: 1.75 }}>
            {hasSearchKey()
              ? '已开通联网搜索：也能让它去网上查招聘公告、岗位待遇、笔试面试经验。'
              : '想让它联网查站外信息（公告 / 待遇 / 面经）？到「设置 → AI 助手 → 联网搜索」填一个搜索 Key 即可。'}
          </div>
          <div className="col gap-6">
            {EXAMPLES.map((e) => (
              <button key={e} className="copy-btn" style={{ textAlign: 'left' }} onClick={() => send(e)}>
                <Icon name="chevronR" size={11} /> {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {msgs.map((m, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          {m.role === 'user' && (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <div style={{
                background: 'var(--accent-grad)', color: '#0b1020', padding: '8px 13px',
                borderRadius: '14px 14px 4px 14px', fontSize: 13, maxWidth: '88%',
                whiteSpace: 'pre-wrap', lineHeight: 1.7, wordBreak: 'break-word',
              }}>{m.content}</div>
            </div>
          )}
          {m.role === 'assistant' && (
            <div className="col gap-8">
              {!!m.runs?.length && (
                <div className="glass" style={{ padding: '8px 10px', borderRadius: 12 }}>
                  <div className="tx-4" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 6 }}>
                    {m.runs.length > 1 ? `执行了 ${m.runs.length} 步` : '执行记录'}
                  </div>
                  <div className="col gap-5">
                    {m.runs.map((r, k) => (
                      <div key={k} className="row gap-8" style={{ alignItems: 'flex-start' }}>
                        <span className={cn('badge', r.ok ? 'badge--ok' : 'badge--danger')} style={{ flexShrink: 0, padding: '2px 7px', fontSize: 10.5 }}>
                          <Icon name={r.ok ? 'check' : 'alert'} size={10} /> {toolLabel(r.name)}
                        </span>
                        <span className="tx-2" style={{ fontSize: 12, lineHeight: 1.65, minWidth: 0 }}>{r.summary}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {m.content && (
                <div className="glass" style={{ padding: '10px 12px', borderRadius: '4px 14px 14px 14px', fontSize: 13 }}>
                  <RichText text={m.content} />
                </div>
              )}
            </div>
          )}
          {m.role === 'error' && (
            <div className="glass" style={{ padding: '9px 11px', borderRadius: 12, borderColor: 'rgba(220,80,80,.4)' }}>
              <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
                <Icon name="alert" size={13} />
                <span style={{ fontSize: 12.5, lineHeight: 1.7, minWidth: 0, wordBreak: 'break-word' }}>{m.content}</span>
              </div>
            </div>
          )}
        </div>
      ))}

      {pending && (
        <div className="glass card" style={{ padding: 13, borderColor: 'rgba(255,120,120,.4)', marginBottom: 14 }}>
          <div className="row gap-8" style={{ alignItems: 'center', marginBottom: 6 }}>
            <Badge tone="badge--danger">需要你确认</Badge>
            <span className="tx-4" style={{ fontSize: 11 }}>{pending.summary}</span>
          </div>
          <div className="col gap-4" style={{ marginBottom: 10 }}>
            {argsRows(pending.args).map(([k, v]) => (
              <div className="row gap-8" key={k} style={{ fontSize: 12.5, alignItems: 'flex-start' }}>
                <span className="tx-4" style={{ flexShrink: 0, minWidth: 62 }}>{k}</span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>{String(v)}</span>
              </div>
            ))}
          </div>
          <div className="field__hint" style={{ marginBottom: 10 }}>这是删除类操作，确认后才会真正执行。</div>
          <div className="row gap-8">
            <Button size="sm" variant="danger" icon="check" onClick={() => { void resolvePending(true); }}>确认执行</Button>
            <Button size="sm" onClick={() => { void resolvePending(false); }}>取消</Button>
          </div>
        </div>
      )}

      {busy && (
        <div className="row gap-8 tx-3" style={{ fontSize: 12, paddingLeft: 2 }}>
          <Icon name="refresh" size={13} className="spin" /> 正在处理…
        </div>
      )}
    </div>
  );

  const foot = (
    <div style={{ padding: 10, borderTop: '1px solid var(--glass-brd)', flexShrink: 0, ...(fullPage ? { maxWidth: 820, width: '100%', margin: '0 auto' } : {}) }}>
      <div className="row gap-8" style={{ alignItems: 'flex-end' }}>
        <textarea ref={taRef} className="textarea" rows={1} style={{ minHeight: 38, maxHeight: 120, fontSize: 13, resize: 'none' }}
          placeholder="例如：把中金标记为已投递 / 题库里法律题有多少"
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <Button variant="primary" icon="send" disabled={busy || !input.trim()} onClick={() => void send()}>发送</Button>
      </div>
      <div className="tx-4" style={{ fontSize: 10.5, marginTop: 6 }}>Enter 发送 · Shift+Enter 换行</div>
    </div>
  );

  const inner = <>{head}{body}{foot}</>;

  /* ① 右侧常驻列：左侧边缘可拖拽改宽 */
  if (docked) return (
    <aside className="agent-col">
      <div className="agent-resizer" title="拖动调整宽度（双击复位）"
        onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd}
        onDoubleClick={() => onResize?.(384)}>
        <span className="agent-resizer__grip" />
      </div>
      {inner}
    </aside>
  );

  // ② 全窗口（?agent=1）
  if (fullPage) {
    return createPortal(
      <div className="glass glass--strong rise"
        style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', flexDirection: 'column' }}>
        {inner}
      </div>, document.body);
  }

  // ③ 窄屏浮窗（受控）：右下角可拖拽调整大小，双击标题栏复位
  if (floating) {
    return createPortal(
      <div className="glass glass--strong"
        style={{
          position: 'fixed', right: 20, bottom: 20, zIndex: 60,
          width: float.w, height: float.h || 'min(72vh, 620px)',
          maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 32px)',
          display: 'flex', flexDirection: 'column', borderRadius: 18, overflow: 'hidden',
        }}>
        <div className="agent-resizer agent-resizer--corner" title="拖动调整大小（双击复位）"
          onPointerDown={onFloatDown} onPointerMove={onFloatMove} onPointerUp={onFloatUp}
          onDoubleClick={() => setFloat({ w: 400, h: 0 })} />
        {inner}
      </div>, document.body);
  }

  return null;
}
