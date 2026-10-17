import { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { SECTIONS, FIXED_VALUES } from '../../data/formSchema';
import type { FieldDef, Rec, SectionDef } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge } from '../ui/Kit';
import { cn, copyText, downloadBlob } from '../../lib/util';
import { getAiConfig, hasAiKey, aiAssist, buildProfileSummary } from '../../lib/ai';
import { buildResumeDocx } from '../../lib/docx';
import { recKey } from '../../lib/merge';
import { getPhoto } from '../../lib/photo';

/* -------- AI 一键生成长文本 -------- */
function AiWriteButton({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  const { profile, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const run = async (mode: 'gen' | 'polish' | 'short') => {
    setMenu(false);
    if (!hasAiKey()) { toast('未配置 API Key，请先在右上角设置中填入', 'err'); return; }
    setBusy(true);
    try {
      const limit = def.limit ? `字数严格控制在 ${def.limit} 字以内。` : '篇幅适中。';
      const instruction = mode === 'polish'
        ? `润色以下网申字段内容，保持真实不编造，更专业凝练。${limit}现有内容：${value}`
        : mode === 'short'
          ? `将以下网申字段内容精简到 ${def.limit || 200} 字以内，保留最关键信息，不改变事实：${value}`
          : `结合背景资料，为网申表单字段「${def.name}」生成一段可直接提交的内容。${limit}${def.hint ? `要求：${def.hint}。` : ''}${value ? `可在现有草稿基础上完善：${value}` : ''}`;
      const ctx = mode === 'gen'
        ? `${buildProfileSummary(profile)}\n【本板块已填内容】${JSON.stringify(profile.single.personal || {}).slice(0, 800)}`
        : buildProfileSummary(profile);
      const out = await aiAssist(instruction, ctx, getAiConfig());
      onChange(out);
      toast('AI 已生成，请核对后使用');
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setBusy(false); }
  };
  return (
    <span style={{ position: 'relative' }}>
      <button className="copy-btn" style={{ color: 'var(--accent-2)' }} disabled={busy}
        onClick={() => (value.trim() ? setMenu((m) => !m) : run('gen'))}
        title={value.trim() ? 'AI 生成 / 润色' : 'AI 一键生成'}>
        <Icon name="sparkles" size={13} /> {busy ? '生成中…' : 'AI'}
      </button>
      {menu && (
        <span className="glass fade" style={{ position: 'absolute', right: 0, top: 26, zIndex: 30, padding: 6, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 118 }}>
          <button className="btn btn--sm btn--ghost" onClick={() => run('gen')}>重新生成</button>
          <button className="btn btn--sm btn--ghost" onClick={() => run('polish')}>润色现有</button>
          {def.limit ? <button className="btn btn--sm btn--ghost" onClick={() => run('short')}>精简到 {def.limit} 字</button> : null}
        </span>
      )}
    </span>
  );
}

/* -------- single field control -------- */
function FieldControl({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  const fixed = def.type === 'fixed';
  const v = fixed ? (value || FIXED_VALUES[def.key] || '') : value;

  if (def.type === 'textarea') {
    const len = (v || '').length;
    const over = def.limit ? len > def.limit : false;
    return (
      <div style={{ position: 'relative' }}>
        <textarea className="textarea" value={v} maxLength={(def.limit || 99999)}
          placeholder={def.placeholder || def.hint || ''}
          onChange={(e) => onChange(e.target.value)} rows={Math.min(8, Math.max(3, Math.ceil(len / 40)))} />
        {def.limit && (
          <span className="tx-4 mono" style={{ position: 'absolute', right: 10, bottom: 8, fontSize: 10.5, color: over ? 'var(--danger)' : undefined }}>
            {len}/{def.limit}
          </span>
        )}
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <select className="select" value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">— 请选择 —</option>
        {(def.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        {v && !(def.options || []).includes(v) && <option value={v}>{v}</option>}
      </select>
    );
  }
  if (def.type === 'radio') {
    return (
      <div className="row gap-6 wrap">
        {(def.options || []).map((o) => (
          <button key={o} className={cn('badge', v === o ? 'badge--accent' : 'badge--muted')}
            style={{ cursor: 'pointer', padding: '5px 12px' }}
            onClick={() => onChange(v === o ? '' : o)}>
            {v === o && <Icon name="check" size={12} />} {o}
          </button>
        ))}
      </div>
    );
  }
  if (def.type === 'file') {
    return (
      <div className="row gap-8">
        <input className="input" value={v} placeholder="文件名 / 存放路径，如 桌面/证件/证件照.jpg"
          onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  if (fixed) {
    return <div className="db-field__val" style={{ opacity: .8 }}>{v || '（表单固定值）'}</div>;
  }
  return (
    <input className="input" type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
      value={v} placeholder={def.placeholder || ''} onChange={(e) => onChange(e.target.value)} />
  );
}

/* -------- one field block (label + hint + control + copy) -------- */
export function FieldBlock({ def, value, onChange, onCopy }:
  { def: FieldDef; value: string; onChange: (v: string) => void; onCopy: () => void }) {
  const [copied, setCopied] = useState(false);
  const val = def.type === 'fixed' ? (value || FIXED_VALUES[def.key] || '') : value;
  const doCopy = async () => {
    const ok = await copyText(val || '');
    if (ok) { setCopied(true); onCopy(); setTimeout(() => setCopied(false), 1400); }
  };
  return (
    <div className={cn('db-field', def.full && 'db-field--full')}>
      <div className="db-field__top">
        <span className="field__label">{def.name}{def.limit ? <span className="tx-4" style={{ fontWeight: 500 }}>·限{def.limit}字</span> : null}</span>
        <span className="row gap-6">
          {def.type === 'textarea' && <AiWriteButton def={def} value={val} onChange={onChange} />}
          {val && def.type !== 'file' && (
            <button className={cn('copy-btn', copied && 'copy-btn--done')} onClick={doCopy} title="复制此项">
              <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? '已复制' : '复制'}
            </button>
          )}
        </span>
      </div>
      <FieldControl def={def} value={value} onChange={onChange} />
      {def.hint && <div className="field__hint" style={{ marginTop: 6 }}>{def.hint}</div>}
    </div>
  );
}

/* -------- record card for multi sections -------- */
export function RecordCard({ section, rec, idx, onPatch, onRemove, onCopyRec, onToast }:
  { section: SectionDef; rec: Rec; idx: number;
    onPatch: (p: Partial<Rec>) => void; onRemove: () => void; onCopyRec: () => void; onToast: (m: string) => void }) {
  const title = rec.school || rec.company || rec.name || rec.title || rec.position || rec.relation || `记录 ${idx + 1}`;
  return (
    <div className="glass" style={{ padding: 16, marginBottom: 12, borderRadius: 18 }}>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div className="row gap-8">
          <span className="tile" style={{ width: 28, height: 28, borderRadius: 9, fontSize: 12 }}>{idx + 1}</span>
          <span className="h-sub truncate" style={{ maxWidth: 340 }}>{title}</span>
        </div>
        <div className="row gap-6">
          <Button size="sm" variant="ghost" icon="copy" onClick={() => { onCopyRec(); }}>复制本条</Button>
          <Button size="sm" variant="ghost" icon="trash" aria-label="删除"
            onClick={() => { if (confirm(`确定删除「${title}」这条记录？删除后不可恢复。`)) onRemove(); }} />
        </div>
      </div>
      <div className="db-fields">
        {section.fields.map((f) => (
          <FieldBlock key={f.key} def={f} value={rec[f.key] || ''}
            onChange={(v) => onPatch({ [f.key]: v })}
            onCopy={() => onToast(`已复制「${f.name}」`)} />
        ))}
      </div>
    </div>
  );
}

/* -------- section accordion -------- */
function SectionCard({ section, open, onToggle }:
  { section: SectionDef; open: boolean; onToggle: () => void }) {
  const { profile, setSingle, updateMulti, addMulti, removeMulti, toast } = useStore();
  const [copiedSec, setCopiedSec] = useState(false);

  const isMulti = section.multiple;
  const singleRec = profile.single[section.id] || {};
  const multiRecs = profile.multi[section.id] || [];

  const { filled, total } = useMemo(() => {
    let f = 0, t = 0;
    if (isMulti) {
      multiRecs.forEach((r) => section.fields.forEach((fd) => {
        if (fd.type === 'file' || fd.type === 'signature') return;
        t++; if ((r[fd.key] || '').trim()) f++;
      }));
      if (multiRecs.length === 0) { t = section.fields.filter(x => x.type !== 'file').length; }
    } else {
      section.fields.forEach((fd) => {
        if (fd.type === 'file' || fd.type === 'signature') return;
        t++; const v = singleRec[fd.key] || FIXED_VALUES[fd.key] || '';
        if (String(v).trim()) f++;
      });
    }
    return { filled: f, total: Math.max(t, 1) };
  }, [isMulti, multiRecs, singleRec, section.fields]);

  const pct = Math.round((filled / total) * 100);

  const copySection = async () => {
    const lines: string[] = [`【${section.title}】`];
    const emit = (r: Rec) => section.fields.forEach((f) => {
      const v = r[f.key] || (f.type === 'fixed' ? FIXED_VALUES[f.key] : '') || '';
      if (String(v).trim()) lines.push(`${f.name}：${v}`);
    });
    if (isMulti) { multiRecs.forEach((r, i) => { if (multiRecs.length > 1) lines.push(`— 第${i + 1}条 —`); emit(r); }); }
    else emit(singleRec);
    const ok = await copyText(lines.join('\n'));
    if (ok) { setCopiedSec(true); toast(`已复制「${section.title}」全部字段`); setTimeout(() => setCopiedSec(false), 1500); }
  };

  return (
    <div className="glass db-section" style={{ overflow: 'hidden' }}>
      <button className="acc__head" onClick={onToggle} aria-expanded={open}>
        <span className="acc__ico"><Icon name={section.icon} size={19} /></span>
        <span className="acc__main" style={{ textAlign: 'left' }}>
          <span className="h-sub" style={{ display: 'block' }}>
            {section.title}
            {isMulti && <Badge tone="badge--muted" className="gap-6" >{multiRecs.length} 条</Badge>}
          </span>
          <span className="tx-3" style={{ fontSize: 11.5 }}>
            {section.desc || `完成度 ${pct}%`}
          </span>
        </span>
        <span className="row gap-8 acc__side" style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <span className="progress-mini"><span className="progress-mini__fill" style={{ width: `${pct}%` }} /></span>
          <Button size="sm" variant="ghost" icon={copiedSec ? 'check' : 'copy'} onClick={copySection}>{copiedSec ? '已复制' : '复制整段'}</Button>
          <Icon name="chevron" className={cn('acc__chev', open && 'acc__chev--open')} size={18} />
        </span>
      </button>
      {open && (
        <div className="acc__body fade">
          {isMulti ? (
            <>
              {multiRecs.map((r, i) => (
                /* key 用记录自身的稳定标识，不能用下标：删除中间一条后 React 会复用同一实例，
                   上一条的「已复制」状态与 AI 生成中的状态会串到相邻记录上。 */
                <RecordCard key={`${recKey(section.id, r)}#${i}`} section={section} rec={r} idx={i}
                  onPatch={(p) => updateMulti(section.id, i, p)}
                  onRemove={() => { removeMulti(section.id, i); toast('已删除一条记录', 'info'); }}
                  onCopyRec={async () => {
                    const lines: string[] = [];
                    section.fields.forEach((f) => { const v = r[f.key] || ''; if (String(v).trim()) lines.push(`${f.name}：${v}`); });
                    if (await copyText(lines.join('\n'))) toast('已复制本条记录');
                  }}
                  onToast={(m) => toast(m)} />
              ))}
              <Button icon="plus" onClick={() => { addMulti(section.id); toast(`已新增一条「${section.title}」`, 'info'); }}>
                添加{section.title}
              </Button>
            </>
          ) : (
            <div className="db-fields">
              {section.fields.map((f) => (
                <FieldBlock key={f.key} def={f} value={singleRec[f.key] || ''}
                  onChange={(v) => setSingle(section.id, f.key, v)}
                  onCopy={() => toast(`已复制「${f.name}」`)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -------- module -------- */
export default function Database() {
  const { profile, toast } = useStore();
  const [open, setOpen] = useState<Record<string, boolean>>({ personal: true });
  const [q, setQ] = useState('');

  /** 与简历页同一套 docx 生成器：按当前档案数据导出 Word 简历 */
  const exportWord = async () => {
    try {
      const blob = await buildResumeDocx(profile, { photo: getPhoto() });
      const name = profile.single.personal?.name || '';
      downloadBlob(name ? `${name}-简历.docx` : '简历.docx', blob);
      toast('已根据资料库档案导出 Word 简历');
    } catch (e) {
      toast('Word 生成失败：' + (e as Error).message, 'err');
    }
  };

  const filtered = useMemo(() => {
    if (!q.trim()) return SECTIONS;
    const k = q.trim().toLowerCase();
    return SECTIONS.filter((s) =>
      s.title.toLowerCase().includes(k) ||
      s.fields.some((fd) => fd.name.toLowerCase().includes(k) || (fd.hint || '').toLowerCase().includes(k)));
  }, [q]);

  return (
    <div className="rise">
      <div className="section-head">
        <div>
          <div className="section-head__t">网申信息资料库</div>
          <div className="section-head__d">
            依据《网申填写信息资料库》12 大板块 · 已用简历数据预填 · 点击任意字段「复制」即可粘贴到各企业网申表单
          </div>
        </div>
        <div className="row gap-8">
          <div className="search">
            <Icon name="search" size={16} />
            <input className="input input--sm" style={{ width: 190 }} placeholder="搜索字段/板块…"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Button size="sm" icon="plus" onClick={() => setOpen(Object.fromEntries(SECTIONS.map((s) => [s.id, true])))}>全部展开</Button>
          <Button size="sm" icon="minus" onClick={() => setOpen({})}>全部收起</Button>
          <Button size="sm" variant="primary" icon="doc" onClick={exportWord}>导出 Word</Button>
        </div>
      </div>

      <div className="stagger">
        {filtered.map((s) => (
          <SectionCard key={s.id} section={s} open={!!open[s.id] || (!!q && filtered.length <= 4)}
            onToggle={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))} />
        ))}
      </div>

      <div className="glass card" style={{ marginTop: 16 }}>
        <div className="card__title"><Icon name="alert" size={17} /> 填写注意事项</div>
        <ul className="tx-2" style={{ fontSize: 13, lineHeight: 1.9, margin: '10px 0 0', paddingLeft: 20 }}>
          <li><b>信息真实性</b>：学历、成绩、证书等务必如实填写，部分企业表单含「本人对所提供材料的真实性负责」声明。</li>
          <li><b>服从调剂</b>：部分企业网申会询问是否服从调剂，选「是」增加录用机会但可能调剂到其他岗位/地区。</li>
          <li><b>字数控制</b>：自我评价限 200 字，经历描述类限 2000 字，先写详细版再精简。</li>
          <li><b>联系方式</b>：手机号、邮箱、紧急联系人务必准确畅通，笔试/面试/体检通知均通过其发送。</li>
          <li><b>附件规范</b>：证件照、成绩单、证书扫描件提前转为 JPG/PDF，单文件不超过 50MB。</li>
        </ul>
      </div>
    </div>
  );
}
