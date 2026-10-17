import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Badge, Empty, Modal, Segmented, AiBtn } from '../ui/Kit';
import { cn, download, fmtDate, todayISO, uid } from '../../lib/util';
import { interviewsToMarkdown } from '../../lib/exporters';
import { getAiConfig, hasAiKey, aiAssist, callAi } from '../../lib/ai';
import type { InterviewLog, InterviewRound, InterviewResult, InterviewQuestion } from '../../types';

const ROUNDS: InterviewRound[] = ['笔试', '一面', '二面', '三面', '终面', 'HR面', '群面', '其他'];
const RESULT: Record<InterviewResult, { label: string; cls: string }> = {
  pending: { label: '等待结果', cls: 'badge--info' },
  passed: { label: '已通过', cls: 'badge--ok' },
  failed: { label: '未通过', cls: 'badge--danger' },
};
const SELF: Record<string, { label: string; cls: string }> = {
  good: { label: '答得好', cls: 'badge--ok' },
  mid: { label: '一般', cls: 'badge--warn' },
  bad: { label: '没答好', cls: 'badge--danger' },
};

/** 面试复盘：一场一面地记「问了什么、我怎么答、下次怎么改」，才是秋招真正的迭代来源 */
export default function Interviews() {
  const { interviews, addInterview, updateInterview, removeInterview, applications, toast } = useStore();
  const [filter, setFilter] = useState<'all' | InterviewResult>('all');
  const [editing, setEditing] = useState<Partial<InterviewLog> | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const list = useMemo(
    () => interviews.filter((i) => filter === 'all' || i.result === filter)
      .slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [interviews, filter],
  );

  const stats = useMemo(() => {
    const done = interviews.filter((i) => i.result !== 'pending');
    return {
      total: interviews.length,
      passed: interviews.filter((i) => i.result === 'passed').length,
      failed: interviews.filter((i) => i.result === 'failed').length,
      pending: interviews.filter((i) => i.result === 'pending').length,
      passRate: done.length ? Math.round((done.filter((i) => i.result === 'passed').length / done.length) * 100) : 0,
      qCount: interviews.reduce((s, i) => s + i.questions.length, 0),
    };
  }, [interviews]);

  /** 跨场次聚合高频问题（文本完全一致才算同一题） */
  const freq = useMemo(() => {
    const map = new Map<string, { q: string; n: number; companies: Set<string> }>();
    for (const i of interviews) {
      for (const q of i.questions) {
        const key = (q.q || '').trim();
        if (key.length < 3) continue;
        const cur = map.get(key) || { q: key, n: 0, companies: new Set<string>() };
        cur.n++; cur.companies.add(i.company);
        map.set(key, cur);
      }
    }
    return Array.from(map.values()).filter((x) => x.n >= 1).sort((a, b) => b.n - a.n).slice(0, 12);
  }, [interviews]);

  const save = () => {
    if (!editing?.company?.trim()) { toast('请填写单位名称', 'err'); return; }
    if (editing.id) { updateInterview(editing.id, editing); toast('已更新面试记录'); }
    else { addInterview(editing); toast('已新增面试记录'); }
    setEditing(null);
  };
  const set = (k: keyof InterviewLog, v: unknown) => setEditing((e) => ({ ...(e || {}), [k]: v } as Partial<InterviewLog>));

  const setQ = (idx: number, patch: Partial<InterviewQuestion>) => {
    setEditing((e) => {
      const qs = [...(e?.questions || [])];
      qs[idx] = { ...qs[idx], ...patch };
      return { ...(e || {}), questions: qs } as Partial<InterviewLog>;
    });
  };

  if (!interviews.length) {
    return (
      <>
        <Empty icon="video" title="还没有面试复盘"
          desc="面完当场记 5 分钟，胜过事后回忆 1 小时：面试官问了什么、你答成什么样、卡在哪、下次怎么改。记录会按单位与轮次沉淀成你的个人题库。"
          action={<Button variant="primary" icon="plus" onClick={() => setEditing({ date: todayISO(), round: '一面', result: 'pending', questions: [{ id: uid('iq'), q: '' }] })}>记录第一场面试</Button>} />
        {editing && <InterviewForm editing={editing} set={set} setQ={setQ} onSave={save} onClose={() => setEditing(null)} applications={applications} />}
      </>
    );
  }

  return (
    <div className="rise col gap-16">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}>
        <div className="stat glass"><div className="stat__ico"><Icon name="video" size={18} /></div><div className="stat__v">{stats.total}</div><div className="stat__l">面试 / 笔试场次</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="trophy" size={18} /></div><div className="stat__v" style={{ color: 'var(--ok)' }}>{stats.passed}</div><div className="stat__l">已通过</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="clock" size={18} /></div><div className="stat__v" style={{ color: 'var(--accent-2)' }}>{stats.pending}</div><div className="stat__l">等待结果</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="target" size={18} /></div><div className="stat__v">{stats.passRate}%</div><div className="stat__l">已知场次通过率</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="paper" size={18} /></div><div className="stat__v">{stats.qCount}</div><div className="stat__l">累计记录问题</div></div>
      </div>

      <div className="glass card">
        <div className="card__head">
          <div className="card__title"><Icon name="video" size={18} /> 面试记录</div>
          <div className="row gap-8">
            <Segmented value={filter} onChange={setFilter} options={[
              { value: 'all', label: '全部' },
              { value: 'pending', label: '等待' },
              { value: 'passed', label: '通过' },
              { value: 'failed', label: '未过' },
            ]} />
            <Button size="sm" icon="doc" onClick={() => { download(`面试复盘-${todayISO()}.md`, '# 面试复盘汇总\n\n' + interviewsToMarkdown(interviews), 'text/markdown'); toast('已导出复盘汇总'); }}>导出</Button>
            <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ date: todayISO(), round: '一面', result: 'pending', questions: [{ id: uid('iq'), q: '' }] })}>记录面试</Button>
          </div>
        </div>
        {list.length === 0 ? <div className="tx-3" style={{ fontSize: 13 }}>该筛选下暂无记录</div> : (
          <div className="col gap-10">
            {list.map((i) => (
              <div className="glass" key={i.id} style={{ padding: '12px 14px', borderRadius: 16 }}>
                <div className="row-between wrap gap-10" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === i.id ? null : i.id)}>
                  <div className="row gap-10" style={{ minWidth: 0 }}>
                    <span className="tile">{i.company.slice(-2)}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: 13.5, fontWeight: 650 }}>
                        {i.company}{i.position ? ` · ${i.position}` : ''}
                        <span className="badge badge--muted" style={{ marginLeft: 8 }}>{i.round}</span>
                      </div>
                      <div className="tx-3" style={{ fontSize: 11.5, marginTop: 3 }}>
                        {fmtDate(i.date)}{i.time ? ` ${i.time}` : ''}{i.format ? ` · ${i.format}` : ''}
                        {i.questions.length ? ` · ${i.questions.length} 个问题` : ''}
                        {i.mood ? ` · 自评 ${'★'.repeat(i.mood)}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="row gap-8">
                    <Badge tone={RESULT[i.result].cls}>{RESULT[i.result].label}</Badge>
                    <Icon name={open === i.id ? 'chevron' : 'chevronR'} size={16} />
                  </div>
                </div>

                {open === i.id && (
                  <div className="col gap-10" style={{ marginTop: 12 }}>
                    {i.interviewers && <div className="tx-2" style={{ fontSize: 12.5 }}>面试官：{i.interviewers}{i.durationMin ? ` · 约 ${i.durationMin} 分钟` : ''}</div>}
                    {i.questions.length > 0 && (
                      <div className="col gap-8">
                        {i.questions.map((q, idx) => (
                          <div key={idx} className="col gap-4" style={{ paddingLeft: 10, borderLeft: '2px solid var(--glass-brd-strong)' }}>
                            <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
                              <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{q.q || '（空）'}</span>
                              {q.self && <Badge tone={SELF[q.self].cls}>{SELF[q.self].label}</Badge>}
                            </div>
                            {q.a && <div className="tx-2" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>我的回答：{q.a}</div>}
                            {q.note && <div className="tx-3" style={{ fontSize: 12 }}>备注：{q.note}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                    {i.selfReview && <div className="tx-2" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}><b>整体复盘：</b>{i.selfReview}</div>}
                    {i.improvements && <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', color: 'var(--warn)' }}><b>下次改进：</b>{i.improvements}</div>}
                    <div className="row gap-8">
                      <Button size="sm" icon="edit" onClick={() => setEditing(i)}>编辑</Button>
                      {i.result === 'pending' && (
                        <>
                          <Button size="sm" icon="check" onClick={() => { updateInterview(i.id, { result: 'passed' }); toast('已标记通过'); }}>标记通过</Button>
                          <Button size="sm" icon="x" onClick={() => { updateInterview(i.id, { result: 'failed' }); toast('已标记未通过', 'info'); }}>标记未通过</Button>
                        </>
                      )}
                      <Button size="sm" variant="danger" icon="trash" onClick={() => { if (confirm('确定删除这条复盘？')) { removeInterview(i.id); toast('已删除', 'info'); } }}>删除</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {freq.length > 0 && (
        <div className="glass card">
          <div className="card__head">
            <div className="card__title"><Icon name="sparkles" size={18} /> 高频问题（跨场次聚合，考前 10 分钟速览）</div>
          </div>
          <div className="col gap-6">
            {freq.map((f) => (
              <div className="list-row" key={f.q} style={{ padding: '9px 12px' }}>
                <span className="badge badge--accent">{f.n} 次</span>
                <span className="grow" style={{ fontSize: 13 }}>{f.q}</span>
                <span className="tx-4 truncate" style={{ fontSize: 11.5, maxWidth: 180 }}>{Array.from(f.companies).join('、')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && <InterviewForm editing={editing} set={set} setQ={setQ} onSave={save} onClose={() => setEditing(null)} applications={applications} />}
    </div>
  );
}

function InterviewForm({ editing, set, setQ, onSave, onClose, applications }:
  { editing: Partial<InterviewLog>; set: (k: keyof InterviewLog, v: unknown) => void;
    setQ: (i: number, patch: Partial<InterviewQuestion>) => void; onSave: () => void; onClose: () => void;
    applications: { id: string; company: string; position: string }[] }) {
  const { toast } = useStore();
  /* 整场级的 AI 操作（复盘/改进）共用一个 busy；逐题点评单独一个下标，两者可并行不互相吞状态 */
  const [busy, setBusy] = useState<null | 'review' | 'improve'>(null);
  const [qBusy, setQBusy] = useState<number | null>(null);
  const qs = editing.questions || [];
  const addQ = () => set('questions', [...qs, { id: uid('iq'), q: '' }]);
  const delQ = (i: number) => set('questions', qs.filter((_, x) => x !== i));

  /* 三类 AI 操作共用的前置检查：没 Key 说清去哪配，没素材说清缺什么。
     统一拦一次，比让每个按钮各报一种错好，也避免白跑一次网络请求。 */
  const aiReady = () => {
    if (!hasAiKey()) { toast('未配置 API Key，请到「设置 → AI」填入后再用', 'err'); return false; }
    if (!qs.some((x) => (x.q || '').trim())) { toast('请先记下面试官问了什么，AI 才有素材', 'err'); return false; }
    return true;
  };

  /** 把整场问答拍平成一份给 AI 看的材料（截断从后端接口的 5000 字上限倒推） */
  const qaText = () => qs.map((x, i) => {
    const parts = [`第 ${i + 1} 题：${(x.q || '').trim() || '（未记录题目）'}`];
    if (x.a?.trim()) parts.push(`我的回答：${x.a.trim()}`);
    if (x.self) parts.push(`自评：${SELF[x.self].label}`);
    if (x.note?.trim()) parts.push(`备注：${x.note.trim()}`);
    return parts.join('\n');
  }).join('\n\n').slice(0, 4000);

  const ctx = () => `【单位】${editing.company || '未填'}${editing.position ? `\n【岗位】${editing.position}` : ''}`
    + `\n【轮次】${editing.round || '一面'}${editing.interviewers ? `\n【面试官】${editing.interviewers}` : ''}`
    + `\n【问题与我的回答】\n${qaText()}`;

  /** 逐题点评 → 写进该题的「备注」（考察点 / 失分点 / 更好的答法骨架） */
  const reviewQ = async (i: number) => {
    const item = qs[i];
    if (!hasAiKey()) { toast('未配置 API Key，请到「设置 → AI」填入后再用', 'err'); return; }
    if (!(item.q || '').trim()) { toast('先记下这一题问了什么，AI 才有素材', 'err'); return; }
    setQBusy(i);
    try {
      const out = await callAi(getAiConfig(),
        '你是资深面试教练。针对这一道面试题与候选人的作答给出复盘：'
        + '① 考察点（面试官到底想确认什么）② 本次作答的亮点与失分点（直接指出缺了什么、哪句是空话，不要客套）'
        + '③ 更好的答法骨架（分点、可复述）。直接输出正文，不要 Markdown 标题符号。',
        `【单位】${editing.company || '未填'}${editing.position ? `\n【岗位】${editing.position}` : ''}`
        + `\n【轮次】${editing.round || '一面'}\n【问题】${item.q}\n【我的回答】${(item.a || '').trim() || '（未记录回答）'}`,
        60000);
      setQ(i, { note: out.trim() });
      toast(`第 ${i + 1} 题已生成点评，写进备注`);
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setQBusy(null); }
  };

  const genReview = async () => {
    if (!aiReady()) return;
    setBusy('review');
    try {
      const out = await aiAssist(
        '根据下面这场面试的问答记录，写一段「整体复盘」：这场面试的流程与基调、我的整体表现'
        + '（强项与短板各说清，短板要点名是哪几题）、面试官明显在关注什么。'
        + '第二人称「你」，120-200 字，直接输出正文，不要 Markdown 标题符号。', ctx(), getAiConfig());
      set('selfReview', out.trim());
      toast('已生成整体复盘');
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  const genImprove = async () => {
    if (!aiReady()) return;
    setBusy('improve');
    try {
      const out = await aiAssist(
        '根据下面这场面试的记录，给出「下次改进」的具体动作：3-5 条，每条必须可直接执行、'
        + '带数量 / 时长 / 产出物（例如「自我介绍压到 90 秒」「补 3 个尽调项目细节」），'
        + '不要写「加强练习」这类空话。用「1. 2. 3.」编号，只输出这几条，不要 Markdown 标题符号。',
        ctx() + (editing.selfReview ? `\n【我已写的整体复盘】${editing.selfReview.slice(0, 800)}` : ''),
        getAiConfig());
      set('improvements', out.trim());
      toast('已生成下次改进');
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  return (
    <Modal open onClose={onClose} icon="video" title={editing.id ? '编辑面试复盘' : '记录面试复盘'} wide
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="check" onClick={onSave}>保存</Button></>}>
      <div className="col gap-12">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
          <div className="field">
            <label className="field__label">单位 *</label>
            <input className="input" value={editing.company || ''} onChange={(e) => set('company', e.target.value)} placeholder="如 中金公司" />
          </div>
          <div className="field">
            <label className="field__label">岗位</label>
            <input className="input" value={editing.position || ''} onChange={(e) => set('position', e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">轮次</label>
            <select className="select" value={editing.round || '一面'} onChange={(e) => set('round', e.target.value)}>
              {ROUNDS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label">日期</label>
            <input className="input" type="date" value={editing.date || ''} onChange={(e) => set('date', e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">时间</label>
            <input className="input" type="time" value={editing.time || ''} onChange={(e) => set('time', e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">形式</label>
            <input className="input" value={editing.format || ''} onChange={(e) => set('format', e.target.value)} placeholder="线上 / 线下 / 电话" />
          </div>
          <div className="field">
            <label className="field__label">面试官</label>
            <input className="input" value={editing.interviewers || ''} onChange={(e) => set('interviewers', e.target.value)} placeholder="人数 / 职务" />
          </div>
          <div className="field">
            <label className="field__label">时长（分钟）</label>
            <input className="input" type="number" value={editing.durationMin ?? ''} onChange={(e) => set('durationMin', Number(e.target.value) || undefined)} />
          </div>
          <div className="field">
            <label className="field__label">结果</label>
            <select className="select" value={editing.result || 'pending'} onChange={(e) => set('result', e.target.value)}>
              <option value="pending">等待结果</option>
              <option value="passed">已通过</option>
              <option value="failed">未通过</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label">自我感觉（1-5）</label>
            <select className="select" value={String(editing.mood ?? '')} onChange={(e) => set('mood', Number(e.target.value) || undefined)}>
              <option value="">（未评）</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label">关联投递</label>
            <select className="select" value={editing.appId || ''} onChange={(e) => set('appId', e.target.value)}>
              <option value="">（不关联）</option>
              {applications.map((a) => <option key={a.id} value={a.id}>{a.company} · {a.position}</option>)}
            </select>
          </div>
        </div>

        <div className="divider" />
        <div className="row-between">
          <div className="h-sub">面试问题清单</div>
          <Button size="sm" icon="plus" onClick={addQ}>加一题</Button>
        </div>
        <div className="col gap-10">
          {qs.map((q, i) => (
            <div className="glass" key={q.id || 'idx-' + i} style={{ padding: 12, borderRadius: 14 }}>
              <div className="row gap-8" style={{ marginBottom: 8 }}>
                <span className="badge badge--muted">第 {i + 1} 题</span>
                <span className="grow" />
                <AiBtn label="AI 点评这题" busyLabel="点评中…" busy={qBusy === i} onClick={() => reviewQ(i)}
                  title="按考察点 / 失分点 / 更好的答法骨架点评，结果写进备注" />
                <Button size="sm" variant="ghost" icon="trash" aria-label="删除该题" onClick={() => delQ(i)} />
              </div>
              <input className="input" value={q.q} placeholder="面试官问了什么（尽量记原话）" onChange={(e) => setQ(i, { q: e.target.value })} />
              <textarea className="textarea" style={{ minHeight: 60, marginTop: 8 }} value={q.a || ''} placeholder="我当时怎么答的（关键论点/例子）" onChange={(e) => setQ(i, { a: e.target.value })} />
              <div className="row gap-8" style={{ marginTop: 8 }}>
                <select className="select" style={{ maxWidth: 160 }} value={q.self || ''} onChange={(e) => setQ(i, { self: (e.target.value || undefined) as InterviewQuestion['self'] })}>
                  <option value="">答得怎么样</option>
                  <option value="good">答得好</option>
                  <option value="mid">一般</option>
                  <option value="bad">没答好</option>
                </select>
                <input className="input grow" value={q.note || ''} placeholder="备注：考察点 / 面试官反应" onChange={(e) => setQ(i, { note: e.target.value })} />
              </div>
            </div>
          ))}
          {!qs.length && <div className="tx-3" style={{ fontSize: 12.5 }}>还没有题目，点「加一题」开始记录。</div>}
        </div>

        <div className="divider" />
        <div className="field">
          <label className="field__label">整体复盘
            <AiBtn label="AI 写复盘" busyLabel="生成中…" busy={busy === 'review'} onClick={genReview}
              title="AI 读整场问答，自动写一段整体复盘" />
          </label>
          <textarea className="textarea" style={{ minHeight: 90 }} value={editing.selfReview || ''} onChange={(e) => set('selfReview', e.target.value)}
            placeholder="流程、氛围、自己的表现、面试官关注点…（也可点右上让 AI 先写一版，再自己改）" />
        </div>
        <div className="field">
          <label className="field__label">下次改进（具体到动作）
            <AiBtn label="AI 出改进动作" busyLabel="生成中…" busy={busy === 'improve'} onClick={genImprove}
              title="AI 从本场短板生成 3-5 条可直接执行的动作" />
          </label>
          <textarea className="textarea" style={{ minHeight: 80 }} value={editing.improvements || ''} onChange={(e) => set('improvements', e.target.value)}
            placeholder="如：自我介绍压到 90 秒；准备 3 个尽调项目细节；补一下公司法 2023 修订要点…" />
        </div>
      </div>
    </Modal>
  );
}
