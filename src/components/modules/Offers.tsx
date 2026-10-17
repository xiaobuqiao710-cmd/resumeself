import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Badge, Empty, Modal, Progress } from '../ui/Kit';
import { cn, download, fmtDate, daysUntil, todayISO } from '../../lib/util';
import { offersToMarkdown } from '../../lib/exporters';
import type { Offer, OfferStatus } from '../../types';

const STATUS: Record<OfferStatus, { label: string; cls: string }> = {
  considering: { label: '考虑中', cls: 'badge--info' },
  accepted: { label: '已接受', cls: 'badge--ok' },
  declined: { label: '已放弃', cls: 'badge--muted' },
  expired: { label: '已过期', cls: 'badge--danger' },
};

/** 首年总包估算：月base × 薪数 + 年终 + 补贴×12 + 签字费 */
export function estimatePackage(o: Offer): number | null {
  const num = (s?: string) => {
    if (!s) return 0;
    const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    let v = parseFloat(m[1]);
    if (/[wW万]/.test(s)) v *= 10000;
    if (/[kK]/.test(s)) v *= 1000;
    return v;
  };
  const base = num(o.baseMonthly);
  if (!base) return null;
  const months = num(o.months) || 12;
  const total = base * months + num(o.bonus) + num(o.allowance) * 12 + num(o.signingBonus);
  return total > 0 ? Math.round(total) : null;
}

const fmtMoney = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : `${n} 元`);

export default function Offers() {
  const { offers, addOffer, updateOffer, removeOffer, toast, applications } = useStore();
  const [editing, setEditing] = useState<Partial<Offer> | null>(null);
  const [detail, setDetail] = useState<Offer | null>(null);

  const active = useMemo(() => offers.filter((o) => o.status === 'considering' || o.status === 'accepted'), [offers]);
  const best = useMemo(() => {
    const scored = active.map((o) => ({ o, score: (o.rating || 3) * (o.weight ?? 1) }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.o;
  }, [active]);

  const save = () => {
    if (!editing?.company?.trim()) { toast('请填写单位名称', 'err'); return; }
    if (editing.id) { updateOffer(editing.id, editing); toast('已更新 Offer'); }
    else { addOffer(editing); toast('已添加 Offer'); }
    setEditing(null);
  };

  const set = (k: keyof Offer, v: unknown) => setEditing((e) => ({ ...(e || {}), [k]: v } as Partial<Offer>));

  const rows: { label: string; get: (o: Offer) => React.ReactNode; key: string }[] = [
    { key: 'city', label: '城市 / 部门', get: (o) => [o.city, o.team].filter(Boolean).join(' · ') || '—' },
    { key: 'pkg', label: '首年总包（估算）', get: (o) => { const e = estimatePackage(o); return o.totalPackage ? <b>{o.totalPackage}</b> : e ? <b>{fmtMoney(e)}</b> : '—'; } },
    { key: 'base', label: '月 base × 薪数', get: (o) => [o.baseMonthly, o.months && `${o.months} 薪`].filter(Boolean).join(' × ') || '—' },
    { key: 'bonus', label: '年终 / 绩效', get: (o) => o.bonus || '—' },
    { key: 'allow', label: '补贴（月）', get: (o) => o.allowance || '—' },
    { key: 'sign', label: '签字费', get: (o) => o.signingBonus || '—' },
    { key: 'hukou', label: '户口 / 落户', get: (o) => o.hukou || '—' },
    { key: 'si', label: '社保公积金', get: (o) => o.socialInsurance || '—' },
    { key: 'penalty', label: '违约金', get: (o) => o.penalty || '—' },
    { key: 'sign_deadline', label: '签约截止', get: (o) => { const d = daysUntil(o.signDeadline); return <>{fmtDate(o.signDeadline) || '—'}{d !== null && d >= 0 && <span className="tx-3" style={{ marginLeft: 6, fontSize: 11.5 }}>剩 {d} 天</span>}</>; } },
    { key: 'onboard', label: '入职时间', get: (o) => o.onboardDate || '—' },
    { key: 'rating', label: '主观评分', get: (o) => '★'.repeat(o.rating || 0) + '☆'.repeat(Math.max(0, 5 - (o.rating || 0))) },
    { key: 'pros', label: '优势', get: (o) => o.pros || '—' },
    { key: 'cons', label: '顾虑', get: (o) => o.cons || '—' },
  ];

  if (!offers.length) {
    return (
      <>
        <Empty icon="trophy" title="还没有 Offer 记录"
          desc="秋招后半程的核心工具：把薪资结构、户口、违约金、签约截止放一张表里横向比，避免在多份 offer 之间反复翻聊天记录。"
          action={<Button variant="primary" icon="plus" onClick={() => setEditing({ status: 'considering', rating: 3, weight: 1, signDeadline: '' })}>添加第一个 Offer</Button>} />
        {editing && <OfferForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} applications={applications} />}
      </>
    );
  }

  return (
    <div className="rise col gap-16">
      {best && active.length > 1 && (
        <div className="glass card" style={{ borderColor: 'var(--glass-brd-strong)' }}>
          <div className="row gap-12 wrap">
            <span className="tile tile--lg" style={{ background: 'var(--accent-grad)', color: '#fff' }}><Icon name="trophy" size={20} /></span>
            <div className="grow" style={{ minWidth: 200 }}>
              <div className="h-sub">按你的评分与权重，当前最优：{best.company} · {best.position}</div>
              <div className="tx-3" style={{ fontSize: 12.5, marginTop: 4 }}>
                评分 {best.rating || 3}/5 · 权重 {best.weight ?? 1}
                {(() => { const e = estimatePackage(best); return e ? ` · 首年约 ${fmtMoney(e)}` : ''; })()}
                {best.signDeadline ? ` · 签约截止 ${fmtDate(best.signDeadline)}` : ''}
              </div>
            </div>
            <Button size="sm" icon="doc" onClick={() => { download(`Offer对比-${todayISO()}.md`, '# Offer 对比\n\n' + offersToMarkdown(offers), 'text/markdown'); toast('已导出对比表'); }}>导出对比</Button>
          </div>
        </div>
      )}

      <div className="row-between wrap gap-10">
        <div className="row gap-8 wrap">
          {(['considering', 'accepted', 'declined', 'expired'] as OfferStatus[]).map((s) => (
            <Badge key={s} tone={STATUS[s].cls}>{STATUS[s].label} {offers.filter((o) => o.status === s).length}</Badge>
          ))}
        </div>
        <div className="row gap-8">
          <Button size="sm" icon="download" onClick={() => { download(`Offer对比-${todayISO()}.csv`, '\uFEFF' + offers.map((o) => [o.company, o.position, o.city, o.baseMonthly, o.months, o.totalPackage || (estimatePackage(o) ? fmtMoney(estimatePackage(o)!) : ''), o.hukou, o.signDeadline, o.rating, o.status].join(',')).join('\r\n'), 'text/csv'); toast('已导出 CSV'); }}>CSV</Button>
          <Button variant="primary" icon="plus" onClick={() => setEditing({ status: 'considering', rating: 3, weight: 1 })}>添加 Offer</Button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))' }}>
        {offers.map((o) => {
          const est = estimatePackage(o);
          const d = daysUntil(o.signDeadline);
          return (
            <div className="glass card" key={o.id} style={{ cursor: 'pointer' }} onClick={() => setDetail(o)}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <span className="row gap-8" style={{ minWidth: 0 }}>
                  <span className="tile">{o.company.slice(-2)}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="truncate" style={{ display: 'block', fontSize: 13.5, fontWeight: 650 }}>{o.company}</span>
                    <span className="tx-3 truncate" style={{ display: 'block', fontSize: 11.5 }}>{o.position}</span>
                  </span>
                </span>
                <Badge tone={STATUS[o.status].cls}>{STATUS[o.status].label}</Badge>
              </div>
              <div className="row gap-10 wrap tx-2" style={{ fontSize: 12 }}>
                {o.city && <span>{o.city}</span>}
                {o.hukou && <span>户口：{o.hukou}</span>}
              </div>
              <div className="h-sub grad-text" style={{ fontSize: 20, marginTop: 10 }}>
                {o.totalPackage || (est ? fmtMoney(est) : '待补薪资')}
              </div>
              <div className="tx-4" style={{ fontSize: 11, marginTop: 2 }}>
                {o.baseMonthly ? `${o.baseMonthly} × ${o.months || 12} 薪` : '未填月 base'}
                {o.signingBonus ? ` · 签字费 ${o.signingBonus}` : ''}
              </div>
              <div style={{ marginTop: 10 }}>
                <Progress value={((o.rating || 0) / 5) * 100} />
              </div>
              <div className="row-between" style={{ marginTop: 8 }}>
                <span className="tx-3" style={{ fontSize: 11.5 }}>{'★'.repeat(o.rating || 0)}{'☆'.repeat(Math.max(0, 5 - (o.rating || 0)))}</span>
                {o.signDeadline && (
                  <Badge tone={d === null ? 'badge--muted' : d < 0 ? 'badge--muted' : d <= 3 ? 'badge--danger' : d <= 7 ? 'badge--warn' : 'badge--info'}>
                    签约 {fmtDate(o.signDeadline)}
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="glass card">
        <div className="card__head"><div className="card__title"><Icon name="layers" size={18} /> 横向对比</div></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 520 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--tx-3)', fontWeight: 600, position: 'sticky', left: 0, background: 'var(--glass-bg)' }}>对比项</th>
                {active.concat(offers.filter((o) => !active.includes(o))).map((o) => (
                  <th key={o.id} style={{ textAlign: 'left', padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--tx-1)' }}>
                    {o.company}{o.id === best?.id && <span className="badge badge--ok" style={{ marginLeft: 6 }}>最优</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} style={{ background: i % 2 ? 'transparent' : 'rgba(255,255,255,.015)' }}>
                  <td style={{ padding: '8px 10px', color: 'var(--tx-3)', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--glass-bg)' }}>{r.label}</td>
                  {active.concat(offers.filter((o) => !active.includes(o))).map((o) => (
                    <td key={o.id} style={{ padding: '8px 10px', verticalAlign: 'top', maxWidth: 220 }}>{r.get(o)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && <OfferForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} applications={applications} />}

      <Modal open={!!detail} onClose={() => setDetail(null)} icon="trophy" title={detail ? `${detail.company} · ${detail.position}` : ''} wide
        footer={detail ? (
          <>
            <Button variant="danger" icon="trash" onClick={() => { if (confirm('确定删除这条 Offer 记录？')) { removeOffer(detail.id); setDetail(null); toast('已删除', 'info'); } }}>删除</Button>
            <Button icon="edit" onClick={() => { setEditing(detail); setDetail(null); }}>编辑</Button>
            <Button variant="primary" onClick={() => setDetail(null)}>关闭</Button>
          </>
        ) : null}>
        {detail && (
          <div className="col gap-12">
            {detail.notes && <div className="tx-2" style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>{detail.notes}</div>}
            <div className="divider" />
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
              {rows.map((r) => (
                <div key={r.key} className="col gap-4">
                  <span className="tx-4" style={{ fontSize: 11 }}>{r.label}</span>
                  <span style={{ fontSize: 13 }}>{r.get(detail)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function OfferForm({ editing, set, onSave, onClose, applications }:
  { editing: Partial<Offer>; set: (k: keyof Offer, v: unknown) => void; onSave: () => void; onClose: () => void; applications: { id: string; company: string; position: string }[] }) {
  const f = (label: string, k: keyof Offer, placeholder?: string, type = 'text') => (
    <div className="field" key={String(k)}>
      <label className="field__label">{label}</label>
      <input className="input" type={type} value={String((editing as Record<string, unknown>)[k] ?? '')} placeholder={placeholder}
        onChange={(e) => set(k, type === 'number' ? Number(e.target.value) : e.target.value)} />
    </div>
  );
  return (
    <Modal open onClose={onClose} icon="trophy" title={editing.id ? '编辑 Offer' : '添加 Offer'} wide
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="check" onClick={onSave}>保存</Button></>}>
      <div className="col gap-12">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          {f('单位 *', 'company', '如 中金公司')}
          {f('岗位', 'position', '如 法务合规岗')}
          {f('城市', 'city', '如 北京')}
          {f('部门 / 业务线', 'team')}
          {/* 状态是固定枚举：原先做成自由文本输入，填成「已接」这类值后
              STATUS[o.status] 取不到，徽标没样式、统计与「最优 Offer」也会漏算这条。 */}
          <div className="field">
            <label className="field__label">状态</label>
            <select className="select" value={String(editing.status || 'considering')}
              onChange={(e) => set('status', e.target.value)}>
              {(Object.keys(STATUS) as OfferStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
            </select>
          </div>
          {f('签约截止', 'signDeadline', 'YYYY-MM-DD', 'date')}
          {f('入职时间', 'onboardDate', '如 2027-07')}
        </div>
        <div className="divider" />
        <div className="h-sub" style={{ marginBottom: 4 }}>薪酬结构（填原始数字即可，总包自动估算）</div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
          {f('月 base', 'baseMonthly', '如 20000')}
          {f('薪数', 'months', '如 16')}
          {f('年终 / 绩效', 'bonus', '如 60000')}
          {f('月补贴合计', 'allowance', '如 1500')}
          {f('签字费', 'signingBonus', '如 30000')}
          {f('首年总包（手填可覆盖估算）', 'totalPackage', '如 40 万')}
          {f('社保公积金', 'socialInsurance', '如 全额 12%')}
          {f('户口 / 落户', 'hukou', '如 解决北京户口')}
          {f('违约金', 'penalty', '如 无 / 1 个月工资')}
        </div>
        <div className="divider" />
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <div className="field">
            <label className="field__label">关联投递记录</label>
            <select className="select" value={editing.appId || ''} onChange={(e) => set('appId', e.target.value)}>
              <option value="">（不关联）</option>
              {applications.map((a) => <option key={a.id} value={a.id}>{a.company} · {a.position}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label">主观评分（1-5）</label>
            <select className="select" value={String(editing.rating ?? 3)} onChange={(e) => set('rating', Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label">决策权重</label>
            <select className="select" value={String(editing.weight ?? 1)} onChange={(e) => set('weight', Number(e.target.value))}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n}（越大越看重）</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field__label">优势 / 吸引点</label>
          <textarea className="textarea" style={{ minHeight: 70 }} value={editing.pros || ''} onChange={(e) => set('pros', e.target.value)} placeholder="平台、赛道、成长、团队氛围…" />
        </div>
        <div className="field">
          <label className="field__label">顾虑 / 风险</label>
          <textarea className="textarea" style={{ minHeight: 70 }} value={editing.cons || ''} onChange={(e) => set('cons', e.target.value)} placeholder="加班强度、base 地、违约金、户口不确定…" />
        </div>
        <div className="field">
          <label className="field__label">备注</label>
          <textarea className="textarea" style={{ minHeight: 70 }} value={editing.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="HR 沟通要点、谈薪记录、需要确认的事项…" />
        </div>
      </div>
    </Modal>
  );
}
