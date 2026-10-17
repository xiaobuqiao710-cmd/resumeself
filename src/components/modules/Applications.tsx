import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import type { Application, AppStatus } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal, Empty, Segmented } from '../ui/Kit';
import { cn, uid, todayISO, deadlineLabel, fmtDate, STATUS_META, STATUS_ORDER, initials, daysUntil } from '../../lib/util';
import { pingBridge, fetchList } from '../../lib/mail';
import { getAiConfig, hasAiKey, aiSyncStatus, keywordFallback } from '../../lib/ai';
import type { AiAppUpdate } from '../../lib/ai';

const emptyForm = (): Partial<Application> => ({
  company: '', position: '', status: 'todo', channel: '官网', location: '', deadline: '', link: '', notes: '', contact: '',
});

/* 排序模型：第二级类别页内按截止日期 / 公司名排序 */
type SortKey = 'company' | 'position' | 'status' | 'deadline' | 'location' | 'channel';
type SortDir = 'asc' | 'desc';


function AppForm({ data, onChange }: { data: Partial<Application>; onChange: (p: Partial<Application>) => void }) {
  const set = (k: keyof Application, v: string) => onChange({ ...data, [k]: v });
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div className="field"><label className="field__label">公司 / 单位 <span className="field__req">*</span></label>
        <input className="input" value={data.company || ''} placeholder="如 中金公司" onChange={(e) => set('company', e.target.value)} /></div>
      <div className="field"><label className="field__label">岗位 <span className="field__req">*</span></label>
        <input className="input" value={data.position || ''} placeholder="如 法务合规岗" onChange={(e) => set('position', e.target.value)} /></div>
      <div className="field"><label className="field__label">当前状态</label>
        <select className="select" value={data.status || 'todo'} onChange={(e) => set('status', e.target.value)}>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select></div>
      <div className="field"><label className="field__label">投递渠道</label>
        <input className="input" value={data.channel || ''} placeholder="官网/内推/BOSS/猎聘…" onChange={(e) => set('channel', e.target.value)} /></div>
      <div className="field"><label className="field__label">工作地点</label>
        <input className="input" value={data.location || ''} placeholder="如 北京" onChange={(e) => set('location', e.target.value)} /></div>
      <div className="field"><label className="field__label">截止日期</label>
        <input className="input" type="date" value={data.deadline || ''} onChange={(e) => set('deadline', e.target.value)} /></div>
      <div className="field"><label className="field__label">投递链接</label>
        <input className="input" value={data.link || ''} placeholder="https://…" onChange={(e) => set('link', e.target.value)} /></div>
      <div className="field"><label className="field__label">联系人 / 内推人</label>
        <input className="input" value={data.contact || ''} placeholder="HR 或内推人" onChange={(e) => set('contact', e.target.value)} /></div>
      <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">备注</label>
        <textarea className="textarea" value={data.notes || ''} placeholder="岗位匹配点、需准备材料、注意事项…" onChange={(e) => set('notes', e.target.value)} /></div>
    </div>
  );
}

function StatusPills({ value, onPick }: { value: AppStatus; onPick: (s: AppStatus) => void }) {
  return (
    <div className="row gap-6 wrap">
      {STATUS_ORDER.map((s) => (
        <button key={s} className={cn('badge', value === s ? STATUS_META[s].cls : 'badge--muted')}
          style={{ cursor: 'pointer', padding: '5px 11px', borderColor: value === s ? 'currentColor' : undefined }}
          onClick={() => onPick(s)}>
          {STATUS_META[s].label}
        </button>
      ))}
    </div>
  );
}

function Card({ app, onOpen, onStatus }: { app: Application; onOpen: () => void; onStatus: (s: AppStatus) => void }) {
  const dl = deadlineLabel(app.deadline);
  const [menu, setMenu] = useState(false);
  return (
    <div className="kcard" onClick={onOpen}>
      <div className="row gap-10" style={{ marginBottom: 8 }}>
        <span className="tile" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>{initials(app.company)}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="kcard__co truncate" style={{ display: 'block' }}>{app.company}</span>
          <span className="kcard__pos truncate" style={{ display: 'block' }}>{app.position}</span>
        </span>
      </div>
      <div className="row gap-6 wrap">
        {app.deadline && <Badge tone={dl.cls}>{dl.text}</Badge>}
        {app.location && <Badge tone="badge--muted">{app.location}</Badge>}
        {app.channel && <Badge tone="badge--muted">{app.channel}</Badge>}
      </div>
      <div className="row gap-6" style={{ marginTop: 10, position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button className={cn('badge', STATUS_META[app.status].cls)} title="点击选择切换状态（手动）"
          style={{ cursor: 'pointer', padding: '5px 11px' }}
          onClick={() => setMenu((m) => !m)}>
          {STATUS_META[app.status].label} <Icon name="chevron" size={12} />
        </button>
        <span className="tx-4" style={{ fontSize: 11 }}>手动切换状态</span>
        {menu && (
          <span className="glass glass--strong fade" style={{ position: 'absolute', left: 0, top: 30, zIndex: 40, padding: 6, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 128 }}>
            {STATUS_ORDER.map((s) => (
              <button key={s} className={cn('btn btn--sm btn--ghost', STATUS_META[s].cls)}
                style={{ justifyContent: 'flex-start' }}
                onClick={() => { setMenu(false); onStatus(s); }}>
                {app.status === s && <Icon name="check" size={12} />} {STATUS_META[s].label}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

export default function Applications() {
  const { applications, addApp, updateApp, setStatus, removeApp, addEvent, toast } = useStore();
  /* 两级结构：viewing === null 时是「类别入口页」，否则是该类别自己的投递库页 */
  const [viewing, setViewing] = useState<AppStatus | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('deadline');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Application | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Partial<Application>>(emptyForm());
  const [syncing, setSyncing] = useState(false);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    const arr = k ? applications.filter((a) =>
      `${a.company}${a.position}${a.location || ''}${a.notes || ''}${a.channel || ''}`.toLowerCase().includes(k))
      : applications;
    return [...arr].sort((a, b) => (daysUntil(a.deadline) ?? 9999) - (daysUntil(b.deadline) ?? 9999));
  }, [applications, q]);

  const openCreate = () => { setForm(emptyForm()); setCreating(true); };
  const changeStatus = (a: Application, s: AppStatus) => {
    if (a.status === s) return;
    setStatus(a.id, s);
    toast(`「${a.company}」状态更新为「${STATUS_META[s].label}」`);
  };
  const saveCreate = () => {
    if (!form.company?.trim() || !form.position?.trim()) { toast('请填写公司与岗位', 'err'); return; }
    const app = addApp(form);
    if (form.deadline) addEvent({ title: `${form.company} 网申截止`, date: form.deadline, type: 'deadline', appId: app.id, source: 'application' });
    setCreating(false); toast(`已添加「${form.company}」`);
  };

  const matchApp = (company: string) => {
    const c = (company || '').trim().toLowerCase();
    if (!c) return undefined;
    return applications.find((a) => {
      const n = (a.company || '').toLowerCase();
      return n === c || n.includes(c) || c.includes(n);
    });
  };

  const syncFromMail = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const online = await pingBridge();
      if (!online) { toast('本地邮件桥未连接，无法读取收件箱', 'err'); return; }
      const mails = await fetchList('inbox', 40);
      if (!mails.length) { toast('收件箱暂无邮件', 'info'); return; }
      const useAi = hasAiKey();
      const updates: AiAppUpdate[] = useAi
        ? await aiSyncStatus(mails, applications, getAiConfig())
        : keywordFallback(mails);
      if (!updates.length) {
        toast(useAi ? 'AI 未识别到投递状态变化' : '未识别到招聘类邮件（可在设置填入 API Key 提升识别）', 'info');
        return;
      }
      let changed = 0, created = 0;
      for (const u of updates) {
        const note = [u.note, u.mailSubject ? `邮件：${u.mailSubject}` : null].filter(Boolean).join('｜');
        const evType = u.status === 'interview' ? 'interview' : u.status === 'test' ? 'test' : 'other';
        const evTitle = `${u.company} · ${u.status === 'interview' ? '面试' : u.status === 'test' ? '笔试' : '事项'}`;
        const hit = matchApp(u.company);
        if (hit) {
          if (hit.status !== u.status) { setStatus(hit.id, u.status, note); changed++; }
          if (u.date) addEvent({ title: evTitle, date: u.date, type: evType, appId: hit.id, source: 'mail', note });
        } else {
          const app = addApp({ company: u.company, position: u.position || '待确认岗位', status: u.status, channel: '邮件识别', notes: note, deadline: u.date });
          created++;
          if (u.date) addEvent({ title: evTitle, date: u.date, type: evType, appId: app.id, source: 'mail', note });
        }
      }
      toast(`同步完成：更新 ${changed} 条${created ? `，新增 ${created} 条` : ''}${useAi ? '' : '（关键词兜底）'}`);
    } catch (e) {
      toast('同步失败：' + (e as Error).message, 'err');
    } finally {
      setSyncing(false);
    }
  };

  const grouped = useMemo(() => {
    const g: Record<string, Application[]> = {};
    STATUS_ORDER.forEach((s) => (g[s] = []));
    list.forEach((a) => { (g[a.status] ||= []).push(a); });
    return g;
  }, [list]);

  /* 排序只作用于渲染副本，list 本身（useMemo）不被改动 */
  const sorted = useMemo(() => {
    const arr = [...list];
    arr.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      const r = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'zh');
      return sortDir === 'asc' ? r : -r;
    });
    return arr;
  }, [list, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };

  /* 搜索非空时自动跨类别收敛到结果集（否则"搜了却还停在空分类里"会让人困惑） */
  const searching = q.trim().length > 0;
  /* 当前正在查看的类别（第二级页面）的记录，已带排序 */
  const catList = useMemo(() => {
    if (!viewing) return [];
    const arr = sorted.filter((a) => a.status === viewing);
    /* 「未通过」这类已收尾的类别按截止倒序看更顺：先看最近的；进行中的仍按原顺序 */
    if (viewing === 'reject' || viewing === 'offer') arr.reverse();
    return arr;
  }, [sorted, viewing]);

  return (
    <div className="rise">
      <div className="section-head">
        <div>
          <div className="section-head__t">{viewing ? `${STATUS_META[viewing].label} · 投递库` : '网申记录追踪'}</div>
          <div className="section-head__d">
            {viewing
              ? `${catList.length} 条 · 按截止日期排序${catList.length ? ` · 最近 ${deadlineLabel(catList[0].deadline).text}` : ''}`
              : `共 ${applications.length} 条投递 · 进行中 ${applications.filter(a => !['offer','reject'].includes(a.status)).length}`}
          </div>
        </div>
        <div className="row gap-8 wrap">
          <div className="search"><Icon name="search" size={16} />
            <input className="input input--sm" style={{ width: 180 }} placeholder="搜索公司/岗位…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {!viewing && <Button icon="sparkles" onClick={syncFromMail} disabled={syncing}>{syncing ? '同步中…' : 'AI 同步邮件'}</Button>}
          <Button variant="primary" icon="plus" onClick={openCreate}>新增投递</Button>
        </div>
      </div>

      {/* 搜索时自动跨库收敛到结果集，避免“搜索了却还停在空分类里” */}
      {searching ? (
        <div className="glass card stagger" style={{ padding: 8 }}>
          <div className="catc_back row-between" style={{ padding: '4px 8px 10px' }}>
            <span className="tx-3" style={{ fontSize: 12.5 }}>搜索「{q.trim()}」命中 {list.length} 条（跨全部类别）</span>
            <Button size="sm" icon="x" onClick={() => setQ('')}>清除搜索</Button>
          </div>
          {list.length === 0 && <div className="tx-4" style={{ padding: '26px 0', textAlign: 'center', fontSize: 13 }}>没有匹配的投递记录</div>}
          {list.map((a) => <AppRow key={a.id} app={a} onOpen={() => setEditing(a)} onStatus={(s) => changeStatus(a, s)} />)}
        </div>
      ) : viewing ? (
        /* ---------- 第二级：某个类别自己的页面（像库一样，只放这一类） ---------- */
        <>
          <div className="catc_back">
            <Button size="sm" icon="chevron" onClick={() => setViewing(null)}>返回各类别</Button>
            <span className={cn('badge', STATUS_META[viewing].cls)} style={{ marginLeft: 4 }}>{STATUS_META[viewing].label}</span>
            <span className="tx-4" style={{ fontSize: 12, marginLeft: 'auto' }}>
              {viewing === 'reject' || viewing === 'offer' ? '已结束的投递' : '进行中的投递'}
            </span>
          </div>
          <div className="catc_detail-tools">
            <span className="tx-3" style={{ fontSize: 12.5 }}>排序</span>
            <Segmented size="sm" value={sortKey === 'deadline' ? 'deadline' : 'company'} onChange={(k) => { setSortKey(k as SortKey); setSortDir('asc'); }}
              options={[{ value: 'deadline', label: '截止日期' }, { value: 'company', label: '公司名' }]} />
            <Button size="sm" icon={sortDir === 'asc' ? 'chevron' : 'chevronR'}
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>{sortDir === 'asc' ? '正序' : '倒序'}</Button>
            <span className="grow" />
            <span className="tx-4" style={{ fontSize: 12 }}>{catList.length} 条</span>
          </div>
          <div className="glass card stagger" style={{ padding: 8 }}>
            {catList.map((a) => <AppRow key={a.id} app={a} onOpen={() => setEditing(a)} onStatus={(s) => changeStatus(a, s)} />)}
            {catList.length === 0 && (
              <Empty icon="inbox" title={`「${STATUS_META[viewing].label}」下还没有记录`}
                desc="投递状态变化会自动归入这里；也可以直接在「新增投递」里指定状态。" />
            )}
          </div>
        </>
      ) : applications.length === 0 ? (
        <div className="glass card"><Empty icon="building" title="还没有网申记录" desc="点「新增投递」手动登记，或用「AI 同步邮件」从收件箱自动识别生成。"
          action={<><Button variant="primary" icon="plus" onClick={openCreate}>新增投递</Button><Button icon="sparkles" onClick={syncFromMail} disabled={syncing}>{syncing ? '同步中…' : 'AI 同步邮件'}</Button></>} /></div>
      ) : (
        /* ---------- 第一级：只列类别入口，不展开长列表 ---------- */
        <div className="catc">
          {STATUS_ORDER.map((s) => {
            const items = grouped[s];
            const pending = s === 'todo' || s === 'filling';
            const n = items.length;
            return (
              <button key={s} className={cn('catc__card', n === 0 && 'catc__card--empty')} data-cat={s}
                onClick={() => setViewing(s)} title={`查看「${STATUS_META[s].label}」全部记录`}>
                <div className="catc__top">
                  <span className={cn('badge__dot', STATUS_META[s].cls)} />
                  <span className={cn('catc__name', STATUS_META[s].cls)}>{STATUS_META[s].label}</span>
                  <span className="catc__count">{n}</span>
                </div>
                <div className="catc__hint tx-4">{pending ? '待处理，按截止日期排队' : s === 'reject' ? '已结束' : s === 'offer' ? '已收获' : '进行中'}</div>
                <div className="catc__list">
                  {items.slice(0, 3).map((a) => {
                    const dl = deadlineLabel(a.deadline);
                    const soon = daysUntil(a.deadline) !== null && (daysUntil(a.deadline) as number) <= 3 && (daysUntil(a.deadline) as number) >= 0;
                    return (
                      <div className="catc__row" key={a.id}>
                        <span className="grow truncate" style={{ minWidth: 0 }}>
                          <span className="catc__co truncate">{a.company}</span>
                          <span className="catc__pos tx-3 truncate">{a.position}</span>
                        </span>
                        {a.deadline && <span className={cn('catc__dl tx-4', soon && 'catc__dl--soon')}>{dl.text}</span>}
                      </div>
                    );
                  })}
                  {n === 0 && <div className="catc__none tx-4">暂无记录</div>}
                </div>
                {n > 3 && <div className="catc__more tx-4">还有 {n - 3} 条 →</div>}
                {n > 0 && n <= 3 && <div className="catc__more tx-4">共 {n} 条 →</div>}
              </button>
            );
          })}
        </div>
      )}

      {/* create modal */}
      <Modal open={creating} onClose={() => setCreating(false)} title="新增网申投递" icon="plus"
        footer={<><Button onClick={() => setCreating(false)}>取消</Button><Button variant="primary" icon="check" onClick={saveCreate}>保存</Button></>}>
        <AppForm data={form} onChange={setForm} />
      </Modal>

      {/* detail / edit modal */}
      {editing && (
        <DetailModal app={editing} onClose={() => setEditing(null)}
          onSave={(p) => { updateApp(editing.id, p); setEditing(null); toast('已保存修改'); }}
          onStatus={(s, note) => { setStatus(editing.id, s, note); setEditing({ ...editing, status: s }); toast(`状态更新为「${STATUS_META[s].label}」`); }}
          onDelete={() => { removeApp(editing.id); setEditing(null); toast('已删除投递记录', 'info'); }}
          onAddEvent={(type) => {
            addEvent({ title: `${editing.company} · ${type === 'interview' ? '面试' : type === 'test' ? '笔试' : '事项'}`, date: todayISO(), type, appId: editing.id, source: 'application' });
            toast('已添加到日历');
          }} />
      )}
    </div>
  );
}

/** 类别详情页里的一行：信息舒展、可点开、可就地改状态 */
function AppRow({ app, onOpen, onStatus }: { app: Application; onOpen: () => void; onStatus: (s: AppStatus) => void }) {
  const dl = deadlineLabel(app.deadline);
  const d = daysUntil(app.deadline);
  const soon = d !== null && d <= 3 && d >= 0;
  return (
    <div className="approw" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <span className="tile approw__tile">{initials(app.company)}</span>
      <span className="grow approw__main" style={{ minWidth: 0 }}>
        <span className="approw__co truncate">{app.company}</span>
        <span className="approw__pos tx-3 truncate">{app.position}</span>
        <span className="approw__meta tx-4">
          {[app.channel, app.location, app.deadline ? `截止 ${fmtDate(app.deadline)}` : ''].filter(Boolean).join(' · ') || '未填写渠道 / 地点'}
        </span>
      </span>
      {app.deadline && <Badge tone={soon ? 'badge--warn' : dl.cls}>{dl.text}</Badge>}
      <select className={cn('select approw__status', STATUS_META[app.status].cls)} value={app.status} title="更改投递状态"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => { e.stopPropagation(); onStatus(e.target.value as AppStatus); }}>
        {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
      </select>
      <Icon name="chevronR" size={16} className="tx-4" />
    </div>
  );
}

/* 排序取值：状态按 STATUS_ORDER 下标，截止按天数（无截止排最后），其余按中文字典序 */
const sortValue = (a: Application, k: SortKey): string | number => {
  if (k === 'status') {
    const i = STATUS_ORDER.indexOf(a.status as typeof STATUS_ORDER[number]);
    return i < 0 ? STATUS_ORDER.length : i;
  }
  if (k === 'deadline') return daysUntil(a.deadline) ?? 9999;
  return String((a[k] as string | undefined) ?? '');
};

function DetailModal({ app, onClose, onSave, onStatus, onDelete, onAddEvent }:
  { app: Application; onClose: () => void; onSave: (p: Partial<Application>) => void;
    onStatus: (s: AppStatus, note?: string) => void; onDelete: () => void;
    onAddEvent: (t: 'interview' | 'test' | 'deadline' | 'other') => void }) {
  const [form, setForm] = useState<Partial<Application>>(app);
  const [tab, setTab] = useState<'detail' | 'timeline'>('detail');
  /* 「详情」表单里的「当前状态」下拉也必须走 onStatus（=store.setStatus），
     否则只改投递记录、岗位库与截止提醒不会跟着变（曾出现：提醒停了、岗位卡还写着新岗位） */
  const patchForm = (p: Partial<Application>) => {
    if (p.status && p.status !== app.status) onStatus(p.status as AppStatus);
    setForm(p);
  };
  return (
    <Modal open onClose={onClose} wide icon="building"
      title={<span>{app.company} · <span className="tx-3" style={{ fontWeight: 500 }}>{app.position}</span></span>}
      footer={<>
        <Button variant="danger" icon="trash" onClick={onDelete}>删除</Button>
        <span className="grow" />
        <Button onClick={onClose}>关闭</Button>
        <Button variant="primary" icon="check" onClick={() => onSave(form)}>保存</Button>
      </>}>
      <div className="row-between" style={{ marginBottom: 16 }}>
        <StatusPills value={(form.status as AppStatus) || app.status} onPick={(s) => { setForm({ ...form, status: s }); onStatus(s); }} />
        <Segmented size="sm" value={tab} onChange={setTab} options={[{ value: 'detail', label: '详情' }, { value: 'timeline', label: '进度时间线' }]} />
      </div>

      {tab === 'detail' ? (
        <>
          <AppForm data={form} onChange={patchForm} />
          <div className="row gap-8 wrap" style={{ marginTop: 16 }}>
            <span className="tx-3" style={{ fontSize: 12 }}>快捷加入日历：</span>
            <Button size="sm" icon="calendar" onClick={() => onAddEvent('interview')}>面试</Button>
            <Button size="sm" icon="edit" onClick={() => onAddEvent('test')}>笔试</Button>
            <Button size="sm" icon="clock" onClick={() => onAddEvent('other')}>其他事项</Button>
            {app.link && <a href={app.link} target="_blank" rel="noreferrer"><Button size="sm" icon="external">打开投递链接</Button></a>}
          </div>
        </>
      ) : (
        <div className="timeline" style={{ marginTop: 6 }}>
          {/* store 的 migrate() 会给 timeline 兜底，但这里再判一次：这条渲染路径最昂贵
              ——它抛错会让整张投递列表一起白掉，而失败信息只是个 TypeError，
             从界面上看只像「点了没反应」。宁可多一个 || []。 */}
          {[...(app.timeline || [])].reverse().map((t, i) => (
            <div className="timeline__item" key={i}>
              <div className="row gap-8">
                <Badge tone="badge--accent">{STATUS_META[t.status]?.label || t.status}</Badge>
                <span className="tx-3" style={{ fontSize: 12 }}>{fmtDate(t.at)}</span>
              </div>
              {t.note && <div className="tx-2" style={{ fontSize: 13, marginTop: 5 }}>{t.note}</div>}
            </div>
          ))}
          {(app.timeline || []).length === 0 && <Empty icon="clock" title="暂无进度记录" />}
        </div>
      )}
    </Modal>
  );
}
