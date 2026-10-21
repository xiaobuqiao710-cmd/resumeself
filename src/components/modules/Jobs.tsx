import React, { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { JobsImportModal } from './JobsImport';
import { JobsDedupeModal } from './JobsDedupe';
import { planJobDedupe } from '../../lib/dedupe';
import { JobsCompanyList } from './JobsCompanyList';
import { JOB_STATUS_META, scoreTone, tierTone, tierRank, TIER_SHORT } from '../../lib/jobMeta';
import { PRIORITY_META, type PriorityKey } from '../../lib/company';
import type { JobTrack } from '../../types';
import { TRACK_META, inferTrack } from '../../lib/mdImport';
import { getWebdavConfig, pullText, getSyncDocPath, setSyncDocPath, listDav, testWebdav, type DavEntry } from '../../lib/webdav';
import type { JobPosting, JobStatus, AppStatus, JobMatch } from '../../types';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal, Empty, Segmented } from '../ui/Kit';
import { cn, fmtDate, daysUntil, STATUS_META, STATUS_ORDER, sameCompanyStem, tagText } from '../../lib/util';
import {
  getAiConfig, hasAiKey, aiParseJobs, aiMatchJob, keywordMatchScore,
  buildProfileSummary, aiCompanyInfo, type ParsedJob,
} from '../../lib/ai';

/** 主要招聘渠道快捷入口（打开官网搜集后粘贴 JD 回来解析） */
const SOURCES = [
  { name: 'BOSS直聘', url: 'https://www.zhipin.com/web/geek/jobs?query=&city=100010000' },
  { name: '猎聘', url: 'https://www.liepin.com/zhaopin/' },
  { name: '智联招聘', url: 'https://www.zhaopin.com/' },
  { name: '前程无忧', url: 'https://we.51job.com/' },
  { name: '实习僧', url: 'https://www.shixiseng.com/interns' },
  { name: '国聘网', url: 'https://www.iguopin.com/' },
  { name: '国家公务员局', url: 'https://www.scs.gov.cn/' },
  { name: '北京组工·选调', url: 'https://www.bjdj.gov.cn/' },
  { name: '国家大学生就业服务平台', url: 'https://www.ncss.cn/' },
  { name: '智联校园', url: 'https://xiaoyuan.zhaopin.com/' },
];

export default function Jobs() {
  const { jobs, addJob, updateJob, removeJob, addApp, setStatus, applications, profile, addEvent, toast,
    companies, upsertCompany, reconcileNow } = useStore();
  const [tab, setTab] = useState<'list' | 'companies'>('list');
  const [filter, setFilter] = useState<JobStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<JobPosting | null>(null);
  const [editing, setEditing] = useState<Partial<JobPosting> | null>(null);   // 手动添加/编辑
  const [pasting, setPasting] = useState(false);                              // 粘贴 JD AI 解析
  const [importing, setImporting] = useState(false);                          // 批量导入汇总表 / 日报
  const [track, setTrack] = useState<'all' | 'enterprise' | 'civil'>('all');  // 三条赛道（图示布局）
  const [subTrack, setSubTrack] = useState<'all' | 'soe' | 'private'>('all');  // 「企业校招」下的细分
  const [showSources, setShowSources] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);                            // 「更多」下拉                       // 招聘渠道入口（默认收起）
  const [syncOpen, setSyncOpen] = useState(false);                            // 从网盘拉取汇总表
  const [dedupeOpen, setDedupeOpen] = useState(false);                        // 清理重复岗位
  const [syncText, setSyncText] = useState('');                               // 拉取到的原文，交给导入弹窗
  const [matchBusy, setMatchBusy] = useState<string | null>(null);
  const [converting, setConverting] = useState<JobPosting | null>(null);   // 转网申记录确认弹窗
  const [convStatus, setConvStatus] = useState<string>('submitted');
  const [onlyKey, setOnlyKey] = useState(false);                          // 只看 S/A 档（核心 + 重点）
  const [advOpen, setAdvOpen] = useState(false);                          // 「更多筛选」面板（低频操作收进去）

  /** 岗位的招聘线：已手填的用手填值，否则按单位/岗位名推断（不写回数据，筛选时实时算） */
  const trackOf = useCallback((j: JobPosting): JobTrack => j.track || inferTrack(j.company, j.title), []);

  const shown = useMemo(() => jobs.filter((j) => {
    /* 默认视图（全部状态）不显示「已归档」：归档的意义就是把过期/不投的岗位从视线里收走。
       想回看时点「已归档」筛选即可——归档是可逆的状态，不是删除。 */
    if (filter === 'all') { if (j.status === 'archived') return false; }
    else if (j.status !== filter) return false;
    if (track === 'civil' && trackOf(j) !== 'civil') return false;
    if (track === 'enterprise' && trackOf(j) === 'civil') return false;
    if (track === 'enterprise' && subTrack !== 'all' && trackOf(j) !== subTrack) return false;
    if (onlyKey && (j.match?.tier !== 'S' && j.match?.tier !== 'A')) return false;
    if (q.trim()) {
      const k = q.trim().toLowerCase();
      return `${j.company} ${j.title} ${j.city || ''} ${j.source || ''}`.toLowerCase().includes(k);
    }
    return true;
  })
  /* 按价值分档排序：S → A → B → C，同档内分数高的在前。
     这是「重要岗位做明显提示」在列表层最直接的落点 —— 不需要用户去点筛选，
     最该投的自动浮到最上面。无分档（旧数据 / 只有手动 AI 分）排在最后。 */
  .sort((a, b) => tierRank(a.match?.tier) - tierRank(b.match?.tier)
    || (b.match?.score ?? 0) - (a.match?.score ?? 0))
  , [jobs, filter, q, track, subTrack, trackOf, onlyKey]);

  const trackCounts = useMemo(() => {
    let soe = 0, civil = 0, priv = 0;
    for (const j of jobs) {
      const t = trackOf(j);
      if (t === 'civil') civil++; else if (t === 'soe') soe++; else priv++;
    }
    return { all: jobs.length, enterprise: soe + priv, civil, soe, private: priv };
  }, [jobs, trackOf]);

  /* 价值分档统计（不含已归档）。用于列表顶部的「S/A/B/C」分布条 ——
     这是「重要岗位做明显提示」最轻的一层：不推送、不弹窗，但一眼看得到有几条核心。 */
  const tierCounts = useMemo(() => {
    const n: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
    let scored = 0;
    for (const j of jobs) {
      if (j.status === 'archived') continue;
      const t = j.match?.tier;
      if (t) { n[t]++; scored++; }
    }
    return { n, scored };
  }, [jobs]);

  /** 一键按关键词归类（只补未归类的，不覆盖你手动改过的） */
  const autoClassify = () => {
    let n = 0;
    for (const j of jobs) { if (!j.track) { updateJob(j.id, { track: inferTrack(j.company, j.title) }); n++; } }
    toast(n ? `已自动归类 ${n} 个岗位，可在岗位详情里手动调整` : '所有岗位都已归类过', n ? 'ok' : 'info');
  };

  /* ---- AI 匹配度评估 ---- */
  /**
   * 手动 AI 评估**覆盖分数，但保留规则分档**（`tier` / `flags`）。
   *
   * 两个分数量的不是同一件事：
   *   · 规则分档（`by: 'rule'`）= **这个机会值不值得投** —— 看机构、岗位方向、地域、门槛；
   *   · AI 匹配度（`by: 'ai'`）  = **我这个人跟它合不合** —— 要把个人档案与 JD 对比。
   * 一个央企核心岗可能对你「匹配度」一般（专业不完全对口），但它依然是 S 档机会。
   * 所以覆盖时不抹掉 tier，否则这条岗位会掉出分档排序、沉到列表末尾。
   */
  const evalMatch = async (job: JobPosting) => {
    const text = `${job.company} ${job.title}\n${job.requirements || ''}\n${job.jd || ''}`.trim();
    if (!text) { toast('该岗位暂无 JD / 要求，无法评估', 'info'); return; }
    setMatchBusy(job.id);
    try {
      const summary = buildProfileSummary(profile);
      const keep = { tier: job.match?.tier, flags: job.match?.flags };
      let r;
      let next: JobMatch;
      if (hasAiKey()) {
        r = await aiMatchJob(text, summary, getAiConfig());
        if (!r) throw new Error('AI 返回格式异常');
        next = { ...r, at: new Date().toISOString(), by: 'ai', ...keep };
      } else {
        r = keywordMatchScore(text, summary);
        next = { ...r, at: new Date().toISOString(), by: 'keyword', ...keep };
      }
      updateJob(job.id, { match: next });
      setDetail((d) => (d && d.id === job.id ? { ...d, match: next } : d));
      toast(`匹配度评估完成：${r.score} 分${hasAiKey() ? '' : '（关键词粗评）'}`);
    } catch (e) { toast('评估失败：' + (e as Error).message, 'err'); }
    finally { setMatchBusy(null); }
  };

  const evalAll = async () => {
    const targets = shown.filter((j) => (j.jd || j.requirements) && !j.match);
    if (!targets.length) { toast('当前列表没有待评估且含 JD 的岗位', 'info'); return; }
    toast(`开始评估 ${targets.length} 个岗位…`, 'info');
    for (const j of targets) { await evalMatch(j); }
  };

  /* ---- 转投递 / 同步截止（状态可选） ---- */
  /**
   * 岗位 ↔ 投递记录的「同一条」判定：单位走全站统一的 `sameCompanyStem`（别名/主干口径），
   * 岗位名互相包含即算同一条。原先这里用 `sameCompany` + 岗位名**完全相等**，
   * 而弹窗里的「已存在同名投递」提示又用 `a.company === job.company` 严格相等——
   * 同一件事两套口径，会出现「实际更新了已有记录，但弹窗没提示、用户以为会新建」。
   */
  const findExistingApp = useCallback((job: JobPosting) => applications.find((a) => {
    if (!sameCompanyStem(a.company, job.company)) return false;
    const at = (a.position || '').trim(), jt = (job.title || '').trim();
    if (!at || !jt) return true;
    return at === jt || at.includes(jt) || jt.includes(at);
  }), [applications]);

  const toApplication = (job: JobPosting, status: AppStatus) => {
    const exist = findExistingApp(job);
    if (exist) {
      setStatus(exist.id, status, '来自岗位追踪');
      toast(`已有该投递记录，状态更新为「${STATUS_META[status].label}」`);
    } else {
      const app = addApp({ company: job.company, position: job.title, status, channel: job.source || '岗位追踪', location: job.city, deadline: job.deadline, link: job.url, salary: job.salary, notes: job.match ? `AI 匹配度 ${job.match.score} 分：${job.match.advice}` : undefined });
      if (job.deadline) addEvent({ title: `${job.company} · ${job.title} 投递截止`, date: job.deadline, type: 'deadline', appId: app.id, source: 'manual' });
      toast(`已转入网申记录（${STATUS_META[status].label}）`);
    }
    /* 岗位状态不在这里硬写：`addApp` / `setStatus` 内部都会走全局对账，
       由「这条投递的当前状态」反推岗位该显示什么。原先无条件写 applied，
       于是选了「待投递」也会立刻显示已投递（刷新后被对账回退，用户以为提醒失灵）。 */
    setDetail(null);
  };

  const counts = useMemo(() => {
    /* 「全部状态」不含已归档，与列表默认视图口径一致（否则 chips 数字与列表条数对不上） */
    const c: Record<string, number> = { all: jobs.filter((j) => j.status !== 'archived').length };
    jobs.forEach((j) => { c[j.status] = (c[j.status] || 0) + 1; });
    return c;
  }, [jobs]);

  /* 实时检测重复：有重复才在标题栏出现「清理重复」入口，平时不打扰 */
  const dupCount = useMemo(() => planJobDedupe(jobs).removeIds.length, [jobs]);

  /**
   * 已截止待收走的岗位：截止日已过、且**不是已投递**（已投递是「等结果」的锚点，不该被收走）。
   * 归档是可逆的状态，不删数据；默认视图不显示，点「已归档」筛选可随时翻回。
   */
  const expiredJobs = useMemo(() => jobs.filter((j) =>
    j.status !== 'applied' && j.status !== 'archived'
    && !!j.deadline && (daysUntil(j.deadline) ?? 0) < 0), [jobs]);

  const archiveExpired = useCallback(() => {
    if (!expiredJobs.length) return;
    expiredJobs.forEach((j) => updateJob(j.id, { status: 'archived' }));
    toast(`已归档 ${expiredJobs.length} 条已截止岗位（点「已归档」筛选可随时翻回，未删除任何数据）`);
  }, [expiredJobs, updateJob, toast]);

  return (
    <div className="rise">
      <div className="section-head">
        <div>
          <div className="section-head__t">岗位追踪</div>
          <div className="section-head__d">三条线分开管理（国央企校招 / 公务员选调 / 民营企业及其他）· 汇总表一键同步 · AI 匹配度</div>
        </div>
        <div className="row gap-8 wrap" style={{ position: 'relative' }}>
          <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing({ status: 'new' })}>添加岗位</Button>
          <Button size="sm" icon="menu" onClick={() => setMenuOpen((v) => !v)}>更多</Button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div className="glass glass--strong"
                style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 41, padding: 6, borderRadius: 14, minWidth: 224 }}>
                {([
                  { icon: 'refresh', label: '从网盘同步汇总表', run: () => setSyncOpen(true) },
                  { icon: 'upload', label: '导入汇总表（粘贴文档）', run: () => { setSyncText(''); setImporting(true); } },
                  { icon: 'edit', label: '粘贴 JD 智能录入', run: () => setPasting(true) },
                  { icon: 'refresh', label: '与投递记录对账', run: () => reconcileNow() },
                  { icon: 'sparkles', label: matchBusy ? '批量评估（进行中）' : '批量评估匹配度', run: () => evalAll() },
                  { icon: 'filter', label: '自动归类招聘线', run: () => autoClassify() },
                  { icon: 'filter', label: dupCount > 0 ? `清理重复岗位（${dupCount} 条）` : '清理重复岗位', run: () => setDedupeOpen(true) },
                  { icon: 'archive', label: `归档已截止岗位${expiredJobs.length ? `（${expiredJobs.length} 条）` : ''}`, run: () => archiveExpired() },
                ] as { icon: string; label: string; run: () => void }[]).map((it) => (
                  <button key={it.label} className="nav__item" style={{ width: '100%' }}
                    onClick={() => { setMenuOpen(false); it.run(); }}>
                    <Icon name={it.icon} size={15} /><span>{it.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {dedupeOpen && <JobsDedupeModal onClose={() => setDedupeOpen(false)} />}
          {importing && <JobsImportModal onClose={() => { setImporting(false); setSyncText(''); }}
            initialText={syncText || undefined} sourceLabel={syncText ? '来自网盘' : undefined} />}
          {syncOpen && <JobsSyncModal onClose={() => setSyncOpen(false)}
            onLoaded={(text) => { setSyncText(text); setSyncOpen(false); setImporting(true); }} />}
        </div>
      </div>

      {/* 筛选区只留「最常用的两行」：视图切换 + 搜索 + 状态。
          企业细分 / 价值分档 / 招聘渠道 / 批量维护这些低频操作收进「更多筛选」，
          否则四排控件叠在一起，列表本身反而被挤到看不见（用户反馈的「整页很杂乱」即此）。 */}
      <div className="col gap-10" style={{ marginBottom: 14 }}>
        <div className="row gap-10 wrap" style={{ alignItems: 'center' }}>
          <Segmented value={tab} onChange={setTab} options={[{ value: 'list', label: '岗位列表', icon: 'target' }, { value: 'companies', label: '公司背景', icon: 'building' }]} />
          {tab === 'list' && (
            <Segmented value={track} onChange={(v) => { setTrack(v); setSubTrack('all'); }} options={[
              { value: 'all', label: `全部 ${trackCounts.all || 0}` },
              { value: 'enterprise', label: `企业校招 ${trackCounts.enterprise || 0}` },
              { value: 'civil', label: `公职选调 ${trackCounts.civil || 0}` },
            ]} />
          )}
          {tab === 'list' && (
            <div className="search grow" style={{ minWidth: 200 }}>
              <Icon name="search" size={16} />
              <input className="input input--sm grow" placeholder="搜索公司名称、岗位名称…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          {tab === 'list' && (
            <button className={cn('badge', advOpen ? 'badge--accent' : 'badge--muted')}
              style={{ cursor: 'pointer', padding: '5px 11px', flexShrink: 0 }}
              onClick={() => setAdvOpen((v) => !v)}>
              <Icon name={advOpen ? 'chevron' : 'chevronR'} size={11} /> 更多筛选
            </button>
          )}
        </div>

        {tab === 'list' && (
          <div className="row gap-6 wrap" style={{ alignItems: 'center' }}>
            {(['all', 'new', 'interested', 'applied', 'archived'] as const).map((k) => (
              <button key={k} className={cn('badge', filter === k ? 'badge--accent' : 'badge--muted')}
                style={{ cursor: 'pointer', padding: '4px 10px' }} onClick={() => setFilter(k)}>
                {k === 'all' ? `全部状态 ${counts.all || 0}` : `${JOB_STATUS_META[k].label} ${counts[k] || 0}`}
              </button>
            ))}
            {dupCount > 0 && (
              <button className="badge badge--warn" style={{ cursor: 'pointer', padding: '4px 10px' }}
                onClick={() => setDedupeOpen(true)}>重复 {dupCount} 条，去清理</button>
            )}
            {expiredJobs.length > 0 && (
              <button className="badge badge--muted" style={{ cursor: 'pointer', padding: '4px 10px' }}
                title="把截止日已过的岗位收进「已归档」（不含已投递；可随时用状态筛选翻回）"
                onClick={archiveExpired}>已截止 {expiredJobs.length} 条，收起来</button>
            )}
          </div>
        )}

        {tab === 'list' && advOpen && (
          <div className="glass card fade" style={{ padding: 12 }}>
            <div className="col gap-10">
              {track === 'enterprise' && (
                <div className="row gap-6 wrap" style={{ alignItems: 'center' }}>
                  <span className="tx-4" style={{ fontSize: 11.5, minWidth: 56 }}>企业细分</span>
                  {(['all', 'soe', 'private'] as const).map((t) => (
                    <button key={t} className={cn('badge', subTrack === t ? 'badge--accent' : 'badge--muted')}
                      style={{ cursor: 'pointer', padding: '4px 10px' }}
                      onClick={() => setSubTrack(t)}>
                      {t === 'all' ? `全部企业 ${trackCounts.enterprise}` : `${TRACK_META[t].short} ${trackCounts[t] || 0}`}
                    </button>
                  ))}
                </div>
              )}
              {tierCounts.scored > 0 && (
                <div className="row gap-6 wrap" style={{ alignItems: 'center' }}>
                  <span className="tx-4" style={{ fontSize: 11.5, minWidth: 56 }}>价值分档</span>
                  {tierCounts.n.S > 0 && <Badge tone="badge--danger">{TIER_SHORT.S} {tierCounts.n.S}</Badge>}
                  <Badge tone="badge--warn">{TIER_SHORT.A} {tierCounts.n.A}</Badge>
                  <Badge tone="badge--info">{TIER_SHORT.B} {tierCounts.n.B}</Badge>
                  <Badge tone="badge--muted">{TIER_SHORT.C} {tierCounts.n.C}</Badge>
                  <button className={cn('badge', onlyKey ? 'badge--accent' : 'badge--muted')}
                    style={{ cursor: 'pointer', padding: '4px 10px' }} onClick={() => setOnlyKey((v) => !v)}>
                    {onlyKey && <Icon name="check" size={11} />} 只看核心 / 重点
                  </button>
                </div>
              )}
              <div className="row gap-6 wrap" style={{ alignItems: 'center' }}>
                <span className="tx-4" style={{ fontSize: 11.5, minWidth: 56 }}>招聘渠道</span>
                <button className="copy-btn" onClick={() => setShowSources((v) => !v)}>
                  <Icon name={showSources ? 'chevron' : 'chevronR'} size={13} /> {showSources ? '收起' : `展开 ${SOURCES.length} 个入口`}
                </button>
                {showSources && SOURCES.map((src) => (
                  <a key={src.name} href={src.url} target="_blank" rel="noreferrer" className="badge badge--muted"
                    style={{ padding: '4px 10px', textDecoration: 'none', cursor: 'pointer' }}>
                    {src.name} <Icon name="external" size={10} />
                  </a>
                ))}
              </div>
              {showSources && (
                <span className="tx-4" style={{ fontSize: 11 }}>
                  在渠道中搜到岗位后，复制 JD 用「更多 → 粘贴 JD 智能录入」自动结构化。
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {tab === 'list' ? (
        <>
          {shown.length === 0 ? (
            <div className="glass card">
              <Empty icon="target"
                title={q.trim() || filter !== 'all' || track !== 'all' ? '没有匹配的岗位' : '暂无追踪的岗位'}
                desc={q.trim() || filter !== 'all' || track !== 'all'
                  ? '换个关键词，或把上方筛选调回「全部」再试。'
                  : '两条路都支持：① 用「更多 → 从网盘同步汇总表」批量入库；② 看到单个岗位时用「更多 → 粘贴 JD 智能录入」。'}
                action={<>
                  <Button variant="primary" icon="refresh" onClick={() => setSyncOpen(true)}>从网盘同步</Button>
                  <Button icon="edit" onClick={() => setPasting(true)}>粘贴 JD 智能录入</Button>
                </>} />
            </div>
          ) : (
            <JobsCompanyList jobs={shown} profiles={companies} query={q} trackOf={trackOf}
              onOpen={(j) => setDetail(j)}
              onSetPriority={(company, next) => {
                upsertCompany(company, { priority: next });
                toast(next ? `已将「${company}」标记为${PRIORITY_META[next].label}` : `「${company}」已恢复自动判定`, 'ok');
              }} />
          )}
        </>
      ) : (
        <CompaniesTab />
      )}

      {/* 岗位详情 */}
      {detail && (
        <DetailModal job={detail} busy={matchBusy === detail.id}
          onEval={() => evalMatch(detail)}
          onEdit={() => { setEditing(detail); setDetail(null); }}
          onApply={() => { setConvStatus('submitted'); setConverting(detail); }}
          onStatus={(s) => {
            /* 手动改岗位状态时必须一并处理 `appliedBy`：它标记「这个状态是某条投递同步来的」。
               若只改 status 而留着 appliedBy，下一次全局对账（启动 / 任何改投递的动作）会依据那条
               仍然「已提交」的投递把它再改回 applied —— 用户的手动修改被静默撤销。
               改回非已投递 = 解除这层联动；手动标为已投递（无投递记录）= 保持手动、对账不碰。 */
            updateJob(detail.id, s === 'applied' ? { status: s } : { status: s, appliedBy: undefined });
            setDetail({ ...detail, status: s, appliedBy: s === 'applied' ? detail.appliedBy : undefined });
          }}
          onRemove={() => { removeJob(detail.id); setDetail(null); toast('已删除岗位', 'info'); }}
          onClose={() => setDetail(null)} />
      )}

      {/* 转为网申记录：可选择初始状态 */}
      {converting && (
        <Modal open onClose={() => setConverting(null)} icon="send" title="转为网申记录"
          footer={<>
            <Button onClick={() => setConverting(null)}>取消</Button>
            <Button variant="primary" icon="check" onClick={() => { toApplication(converting, convStatus as AppStatus); setConverting(null); }}>确认转入</Button>
          </>}>
          <div className="col gap-10">
            <div className="tx-2" style={{ fontSize: 13 }}>
              将 <b>{converting.company} · {converting.title}</b> 转入「网申记录追踪」。
              {!!findExistingApp(converting)
                && <span className="badge badge--warn" style={{ marginLeft: 8 }}>已存在同名投递，将更新其状态</span>}
            </div>
            <div className="field">
              <label className="field__label">转入后的初始状态</label>
              <div className="row gap-6 wrap">
                {STATUS_ORDER.map((s) => (
                  <button key={s} className={cn('badge', convStatus === s ? STATUS_META[s].cls : 'badge--muted')}
                    style={{ cursor: 'pointer', padding: '5px 11px', borderColor: convStatus === s ? 'currentColor' : undefined }}
                    onClick={() => setConvStatus(s)}>
                    {convStatus === s && <Icon name="check" size={11} />} {STATUS_META[s].label}
                  </button>
                ))}
              </div>
              <div className="field__hint" style={{ marginTop: 8 }}>默认「已提交」；若只是收藏尚未投递可选「待投递」，已收到笔面通知可直接选对应状态。</div>
            </div>
          </div>
        </Modal>
      )}

      {/* 手动添加 / 编辑 */}
      {editing && !pasting && (
        <JobFormModal data={editing} onClose={() => setEditing(null)}
          onSave={(j) => {
            if (editing.id) { updateJob(editing.id, j); toast('已更新岗位'); }
            else { addJob(j); toast('已添加岗位，可点击卡片评估匹配度'); }
            setEditing(null);
          }} />
      )}

      {/* 粘贴 JD AI 多岗位解析 */}
      {pasting && <PasteModal onClose={() => setPasting(false)} onDone={() => setPasting(false)} />}
    </div>
  );
}

/* ---------------- 岗位详情 ---------------- */
function DetailModal({ job, busy, onEval, onEdit, onApply, onStatus, onRemove, onClose }:
  { job: JobPosting; busy: boolean; onEval: () => void; onEdit: () => void; onApply: () => void;
    onStatus: (s: JobStatus) => void; onRemove: () => void; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} wide icon="target" title={<span>{job.company} · {job.title}</span>}
      footer={<>
        <Button variant="danger" icon="trash" onClick={onRemove}>删除</Button>
        <span className="grow" />
        <Button icon="edit" onClick={onEdit}>编辑</Button>
        <Button icon="sparkles" disabled={busy} onClick={onEval}>{busy ? '评估中…' : job.match ? '重新评估匹配度' : '评估匹配度'}</Button>
        <Button variant="primary" icon="send" onClick={onApply}>转为投递</Button>
      </>}>
      <div className="col gap-12">
        <div className="row gap-6 wrap">
          <Badge tone={JOB_STATUS_META[job.status].cls}>{JOB_STATUS_META[job.status].label}</Badge>
          {job.source && <Badge tone="badge--muted">来源：{job.source}</Badge>}
          {job.city && <Badge tone="badge--muted">{job.city}</Badge>}
          {job.salary && <Badge tone="badge--warn">{job.salary}</Badge>}
          {job.deadline && <Badge tone="badge--info">截止 {fmtDate(job.deadline)}</Badge>}
          <div className="row gap-6" style={{ marginLeft: 'auto' }}>
            {(Object.keys(JOB_STATUS_META) as JobStatus[]).map((s) => (
              <button key={s} className={cn('badge', job.status === s ? 'badge--accent' : 'badge--muted')}
                style={{ cursor: 'pointer', padding: '3px 9px', fontSize: 11 }} onClick={() => onStatus(s)}>
                {JOB_STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>

        <div className="tx-4" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          右上是岗位状态，点一下即可切换：{job.status === 'applied'
            ? '当前为「已投递」，该岗位的截止提醒已停止。把「投递记录」里对应状态退回「待投递」，这里会自动恢复为「感兴趣」并重新开始提醒。'
            : '改为「已投递」后，该岗位的截止提醒会自动停止；在「投递记录」里把状态改为已提交也会自动同步过来。'}
        </div>

        {job.url && <a className="tx-3" style={{ fontSize: 12.5 }} href={job.url} target="_blank" rel="noreferrer">岗位链接 <Icon name="external" size={11} /></a>}

        {job.match ? (
          <div className="glass" style={{ padding: 14, borderRadius: 16 }}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <span className="card__title" style={{ fontSize: 13.5 }}>
                <Icon name="sparkles" size={15} /> {job.match.by === 'rule' ? '价值分档（导入自动）' : '匹配度分析'}
              </span>
              <span className="row gap-8">
                {job.match.tier && <Badge tone={tierTone(job.match.tier)}>{TIER_SHORT[job.match.tier]}</Badge>}
                <Badge tone={scoreTone(job.match.score)}>{job.match.score} / 100</Badge>
                <span className="tx-4" style={{ fontSize: 10.5 }}>
                  {job.match.by === 'ai' ? 'AI 深度分析' : job.match.by === 'rule' ? '规则自动评分' : '关键词粗评'}
                  {' · '}{fmtDate(job.match.at.slice(0, 10))}
                </span>
              </span>
            </div>
            <div className="progress-bar" style={{ marginBottom: 10 }}><div className="progress-bar__fill" style={{ width: `${job.match.score}%` }} /></div>
            {!!job.match.flags?.length && (
              <div className="row gap-6 wrap" style={{ marginBottom: 10 }}>
                {job.match.flags.map((f) => <Badge key={f} tone={f.startsWith('⏰') ? 'badge--danger' : 'badge--warn'}>{f}</Badge>)}
              </div>
            )}
            <div className="col gap-6 tx-2" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              {job.match.highlights && <div><b style={{ color: 'var(--ok)' }}>✓ 亮点：</b>{job.match.highlights}</div>}
              {job.match.gaps && <div><b style={{ color: 'var(--danger)' }}>✗ 差距：</b>{job.match.gaps}</div>}
              {job.match.advice && <div><b style={{ color: 'var(--accent-2)' }}>→ 建议：</b>{job.match.advice}</div>}
            </div>
          </div>
        ) : (
          <div className="glass" style={{ padding: 14, borderRadius: 16 }}>
            <span className="tx-3" style={{ fontSize: 12.5 }}>尚未评估匹配度。点击右下角「评估匹配度」，AI 将对比你的个人档案与该岗位 JD。</span>
          </div>
        )}

        {job.exam && (
          <div className="glass" style={{ padding: 12, borderRadius: 14 }}>
            <div className="row gap-6" style={{ marginBottom: 6 }}>
              <Icon name="edit" size={14} /><span className="h-sub" style={{ fontSize: 12.5 }}>笔试 / 考试</span>
            </div>
            <pre className="tx-2" style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.7, margin: 0, fontFamily: 'var(--font)' }}>{job.exam}</pre>
          </div>
        )}

        {job.requirements && (
          <div>
            <div className="h-sub" style={{ marginBottom: 6 }}>任职要求</div>
            <pre className="tx-2" style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.7, margin: 0, fontFamily: 'var(--font)' }}>{job.requirements}</pre>
          </div>
        )}
        {job.jd && (
          <div>
            <div className="h-sub" style={{ marginBottom: 6 }}>职位描述原文</div>
            <pre className="tx-3" style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, margin: 0, fontFamily: 'var(--font)', maxHeight: 220, overflow: 'auto' }}>{job.jd}</pre>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- 从网盘拉取汇总表 ---------------- */
export function JobsSyncModal({ onClose, onLoaded }:
  { onClose: () => void; onLoaded: (text: string) => void }) {
  const cfg = useMemo(() => getWebdavConfig(), []);
  const [path, setPath] = useState(getSyncDocPath());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tip, setTip] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<DavEntry[]>([]);
  const [listErr, setListErr] = useState('');
  const configured = !!(cfg.username && cfg.password);

  const pull = async () => {
    setBusy(true); setErr(''); setTip('');
    try {
      const text = await pullText(cfg, path);
      setSyncDocPath(path);
      /* 顺带报一下「云端那份是什么时候改的」——本地刚改完还没上传时最容易误判成「导入不进去」 */
      try {
        const dir = path.replace(/\/[^/]*$/, '');
        const name = path.split('/').pop() || '';
        const hit = (await listDav(cfg, dir)).find((e) => e.name === name);
        if (hit) {
          const when = hit.modified ? new Date(hit.modified).toLocaleString('zh-CN') : '未知';
          setTip(`云端文件：${Math.round((hit.size || text.length) / 1024)} KB · 最后修改 ${when}`);
        } else {
          setTip(`云端文件已读取（${Math.round(text.length / 1024)} KB）`);
        }
      } catch { /* 拿不到元信息不影响导入 */ }
      onLoaded(text);
    } catch (e) { setErr((e as Error).message); setBrowsing(false); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setErr(''); setTip('');
    try { const m = await testWebdav(cfg); setTip(`连接正常（${m}）· 账号 ${cfg.username}`); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  /** 列出云端目录：直接看「云端到底有什么」，不用猜路径 */
  const browse = async (dir: string) => {
    setBrowsing(true); setListErr(''); setEntries([]);
    try { const list = await listDav(cfg, dir); setCwd(dir); setEntries(list); }
    catch (e) { setListErr((e as Error).message); }
  };

  return (
    <Modal open onClose={onClose} icon="refresh" title="从网盘同步汇总表" wide
      footer={<>
        <Button onClick={onClose}>取消</Button>
        <Button icon="check" disabled={busy || !configured} onClick={test}>{busy ? '…' : '测试连接'}</Button>
        <Button variant="primary" icon="refresh" disabled={busy || !configured} onClick={pull}>{busy ? '拉取中…' : '拉取并解析'}</Button>
      </>}>
      <div className="col gap-12">
        <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          浏览器出于安全不允许网页读取你电脑上的文件，所以桌面上的汇总表**不会自动**进网站。
          把汇总表放进你自己的网盘（WebDAV），这里一键拉取并解析即可。
        </div>
        {!configured && (
          <div className="glass" style={{ padding: 12, borderRadius: 14 }}>
            <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              还没配置网盘：先到「设置 → 数据与备份 → 网盘同步」填写服务商、账号与应用密码（坚果云的应用密码在网页版「账户信息 → 安全选项 → 第三方应用管理」生成，不是登录密码）。
            </div>
          </div>
        )}
        <div className="row gap-10 wrap">
          <div className="field grow" style={{ minWidth: 200 }}>
            <label className="field__label">网盘账号（来自设置）</label>
            <input className="input mono" value={cfg.username || '（未配置）'} readOnly />
          </div>
          <div className="field grow" style={{ minWidth: 240 }}>
            <label className="field__label">汇总表在网盘中的路径</label>
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="秋招数据/秋招信息汇总.md" />
          </div>
        </div>

        <div className="row gap-8 wrap" style={{ alignItems: 'center' }}>
          <Button size="sm" icon="layers" onClick={() => (browsing ? setBrowsing(false) : browse(''))}>
            {browsing ? '收起网盘目录' : '浏览网盘目录（看云端到底有什么）'}
          </Button>
          <span className="tx-4" style={{ fontSize: 11 }}>
            提示：本机新建的文件夹需要网盘客户端运行并上传后，云端才会出现。
          </span>
        </div>

        {browsing && (
          <div className="glass card" style={{ padding: 12 }}>
            <div className="row gap-8 wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
              <button className="copy-btn" onClick={() => browse('')}>根目录</button>
              {cwd.split('/').filter(Boolean).map((seg, i, arr) => (
                <span className="row gap-8" key={seg + i}>
                  <span className="tx-4">/</span>
                  <button className="copy-btn"
                    onClick={() => browse(arr.slice(0, i + 1).join('/'))}>{seg}</button>
                </span>
              ))}
              <span className="grow" />
              <span className="tx-4" style={{ fontSize: 11 }}>点文件夹进入，点文件选中</span>
            </div>
            {listErr && <div className="badge badge--danger" style={{ whiteSpace: 'normal', textAlign: 'left', padding: '8px 10px' }}>{listErr}</div>}
            {!listErr && entries.length === 0 && <div className="tx-3" style={{ fontSize: 12.5 }}>这个目录是空的（或还没加载）。</div>}
            <div className="col gap-4">
              {entries.map((e) => (
                <div className="list-row" key={e.path} style={{ padding: '7px 10px', cursor: 'pointer' }}
                  onClick={() => { if (e.isDir) browse(e.path); else { setPath(e.path); setBrowsing(false); setErr(''); } }}>
                  <Icon name={e.isDir ? 'layers' : 'doc'} size={15} />
                  <span className="grow truncate" style={{ fontSize: 12.5 }}>{e.name}</span>
                  {!e.isDir && e.size != null && <span className="tx-4" style={{ fontSize: 11 }}>{(e.size / 1024).toFixed(1)} KB</span>}
                  <span className="tx-4" style={{ fontSize: 11 }}>{e.isDir ? '文件夹' : '文件'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tip && <div className="badge badge--ok" style={{ whiteSpace: 'normal', textAlign: 'left', padding: '8px 10px' }}>{tip}</div>}
        {err && (
          <div className="col gap-8">
            <div className="badge badge--danger" style={{ whiteSpace: 'normal', textAlign: 'left', padding: '8px 10px' }}>{err}</div>
            {!browsing && <Button size="sm" icon="layers" onClick={() => browse('')}>先看看云端有哪些目录</Button>}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- 手动表单 ---------------- */
function JobFormModal({ data, onClose, onSave }:
  { data: Partial<JobPosting>; onClose: () => void; onSave: (j: Partial<JobPosting>) => void }) {
  const [form, setForm] = useState<Partial<JobPosting>>(data);
  const set = (k: keyof JobPosting, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal open onClose={onClose} wide icon="edit" title={data.id ? '编辑岗位' : '添加岗位'}
      footer={<><Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" onClick={() => {
          if (!form.company?.trim() || !form.title?.trim()) return;
          onSave(form);
        }}>保存</Button></>}>
      <div className="col gap-14">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <div className="field"><label className="field__label">公司 <span className="field__req">*</span></label>
            <input className="input" value={form.company || ''} placeholder="如 中金公司" onChange={(e) => set('company', e.target.value)} /></div>
          <div className="field"><label className="field__label">岗位 <span className="field__req">*</span></label>
            <input className="input" value={form.title || ''} placeholder="如 法务岗（2027 届秋招）" onChange={(e) => set('title', e.target.value)} /></div>
          <div className="field"><label className="field__label">城市</label>
            <input className="input" value={form.city || ''} placeholder="如 北京" onChange={(e) => set('city', e.target.value)} /></div>
          <div className="field"><label className="field__label">薪资</label>
            <input className="input" value={form.salary || ''} placeholder="如 20-35K·16 薪" onChange={(e) => set('salary', e.target.value)} /></div>
          <div className="field"><label className="field__label">招聘线</label>
            <select className="select" value={form.track || ''} onChange={(e) => set('track', e.target.value as JobTrack)}>
              <option value="">（未归类 · 自动判断）</option>
              {(['soe', 'civil', 'private'] as const).map((t) => <option key={t} value={t}>{TRACK_META[t].label}</option>)}
            </select></div>
          <div className="field"><label className="field__label">来源渠道</label>
            <input className="input" value={form.source || ''} placeholder="官网 / BOSS 直聘 / 猎聘 / 内推…" onChange={(e) => set('source', e.target.value)} /></div>
          <div className="field"><label className="field__label">投递截止</label>
            <input className="input" type="date" value={form.deadline || ''} onChange={(e) => set('deadline', e.target.value)} /></div>
        </div>
        <div className="field"><label className="field__label">岗位链接</label>
          <input className="input mono" value={form.url || ''} placeholder="https://…" onChange={(e) => set('url', e.target.value)} /></div>
        <div className="field"><label className="field__label">任职要求</label>
          <textarea className="textarea" style={{ minHeight: 80 }} value={form.requirements || ''} placeholder="学历、专业、技能要求等…" onChange={(e) => set('requirements', e.target.value)} /></div>
        <div className="field"><label className="field__label">职位描述（JD 原文，用于 AI 匹配度评估）</label>
          <textarea className="textarea" style={{ minHeight: 100 }} value={form.jd || ''} placeholder="粘贴完整的岗位描述…" onChange={(e) => set('jd', e.target.value)} /></div>
      </div>
    </Modal>
  );
}

/* ---------------- 粘贴 JD → AI 多岗位拆分解析 ---------------- */
function PasteModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { jobs, addJob, toast } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ParsedJob[] | null>(null);
  const [picked, setPicked] = useState<boolean[]>([]);

  const keyOf = (j: { company?: string; title?: string }) =>
    `${(j.company || '').trim()}|${(j.title || '').trim()}`.toLowerCase();
  const existing = useMemo(() => new Set(jobs.map((j) => keyOf(j))), [jobs]);
  /* 与现有岗位重复、或批次内重复 */
  const dupOf = (batch: ParsedJob[], i: number) => {
    const k = keyOf(batch[i]);
    if (existing.has(k)) return true;
    return batch.slice(0, i).some((b) => keyOf(b) === k);
  };

  const parse = async () => {
    if (!text.trim()) { toast('请先粘贴招聘文本', 'err'); return; }
    if (!hasAiKey()) { toast('未配置 API Key，请在设置中填入后使用智能录入（或改用手动添加）', 'err'); return; }
    setBusy(true);
    try {
      const list = await aiParseJobs(text, getAiConfig());
      if (!list.length) { toast('未能从文本中识别出公司与岗位，请改用手动添加', 'err'); return; }
      setResults(list);
      setPicked(list.map((_, i) => !dupOf(list, i)));
      toast(`AI 已拆分为 ${list.length} 个岗位，请勾选确认`);
    } catch (e) { toast('解析失败：' + (e as Error).message, 'err'); }
    finally { setBusy(false); }
  };

  const save = () => {
    if (!results) return;
    const seen = new Set<string>();
    let added = 0, skipped = 0;
    results.forEach((j, i) => {
      if (!picked[i]) return;
      const k = keyOf(j);
      if (existing.has(k) || seen.has(k)) { skipped++; return; }
      seen.add(k);
      addJob({ ...j, status: 'new' });
      added++;
    });
    if (!added) { toast(skipped ? `勾选的 ${skipped} 项均为已有岗位，未重复导入` : '请先勾选要导入的岗位', 'info'); return; }
    toast(skipped ? `已添加 ${added} 个岗位，跳过 ${skipped} 个重复` : `已添加 ${added} 个岗位，可点击卡片评估匹配度`);
    onDone();
  };

  const pickedCount = picked.filter(Boolean).length;
  return (
    <Modal open onClose={onClose} wide icon="sparkles" title="粘贴 JD 智能录入 · 多岗位 AI 拆分"
      footer={<>
        <Button onClick={onClose}>取消</Button>
        {results && <Button icon="sparkles" disabled={busy} onClick={parse}>重新解析</Button>}
        <Button variant="primary" icon={results ? 'check' : 'sparkles'}
          disabled={busy || (!!results && pickedCount === 0)}
          onClick={results ? save : parse}>
          {busy ? 'AI 解析中…' : results ? `保存勾选 ${pickedCount} 项` : 'AI 解析并拆分'}
        </Button>
      </>}>
      <div className="col gap-10">
        {!results && (<>
          <div className="field__hint">
            支持粘贴含多家公司、多个岗位的整段招聘信息（官网公告 / 公众号推文 / 邮件汇总等）：AI 会自动拆分为独立岗位，逐项抽取公司、岗位、城市、薪资、来源、截止日期、链接与 JD 原文。
          </div>
          <textarea className="textarea" style={{ minHeight: 240 }} value={text}
            placeholder={'示例（可含多家公司的多个岗位）：\n中金公司 2027 届秋招 法务岗｜北京｜20-35K·16薪｜截止 2026-10-15｜职责：…\n招商银行总行 2027 届秋招 合规管培生｜深圳｜18-28K·14薪｜职责：…\n中信证券 2027 届秋招 法律合规岗、投行岗｜上海｜…'}
            onChange={(e) => setText(e.target.value)} />
          {!hasAiKey() && <span className="badge badge--warn" style={{ alignSelf: 'flex-start' }}>未配置 API Key：请先在右上角「设置」中填入</span>}
        </>)}
        {results && (
          <div className="col gap-8" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
            <div className="field__hint">共拆分出 {results.length} 个岗位；勾选的将被导入，标「重复」的已存在于列表或本批次中，默认不勾选。</div>
            {results.map((j, i) => {
              const dup = dupOf(results, i);
              return (
                <label key={i} className="glass" style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 14, cursor: 'pointer', alignItems: 'flex-start', opacity: picked[i] ? 1 : 0.6 }}>
                  <input type="checkbox" checked={!!picked[i]} style={{ marginTop: 3 }}
                    onChange={(e) => setPicked((p) => p.map((v, k) => (k === i ? e.target.checked : v)))} />
                  <div className="col gap-4" style={{ flex: 1, minWidth: 0 }}>
                    <div className="row gap-8 wrap" style={{ alignItems: 'center' }}>
                      <b style={{ fontSize: 13.5 }}>{j.company || '(未知公司)'}</b>
                      <span style={{ fontSize: 13 }}>{j.title || '(未知岗位)'}</span>
                      {dup && <span className="badge badge--muted">重复</span>}
                    </div>
                    <div className="row gap-6 wrap">
                      {j.city && <span className="badge badge--muted">{j.city}</span>}
                      {j.salary && <span className="badge badge--ok">{j.salary}</span>}
                      {j.source && <span className="badge badge--muted">{j.source}</span>}
                      {j.deadline && <span className="badge badge--warn">截止 {j.deadline}</span>}
                    </div>
                    {(j.requirements || j.jd) && (
                      <div className="tx-3" style={{ fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 54, overflow: 'hidden' }}>
                        {(j.requirements || j.jd || '').slice(0, 160)}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- 公司背景 Tab ----------------
 * 胶囊只装短标签，而 industry / scale / hq 是 AI 生成的自由文本（长度不可控，
 * 实测 hq 会吐出 40+ 字的「待核实（…）」）。渲染时统一过一遍 tagText() 收窄，
 * 完整原文挂 title —— 细节见 lib/util.ts 的 tagText 注释。 */
function CompaniesTab() {
  const { companies, upsertCompany, removeCompany, applications, jobs, toast } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  /* 汇总所有出现过的公司名（公司库 + 网申 + 岗位） */
  const allNames = useMemo(() => {
    const set = new Set<string>(companies.map((c) => c.company));
    applications.forEach((a) => a.company && set.add(a.company));
    jobs.forEach((j) => j.company && set.add(j.company));
    return Array.from(set);
  }, [companies, applications, jobs]);

  const genInfo = async (company: string, position = '') => {
    if (!hasAiKey()) { toast('未配置 API Key，无法生成公司背景，请在设置中填入', 'err'); return; }
    setBusy(company);
    try {
      const info = await aiCompanyInfo(company, position, getAiConfig());
      if (!info) { toast('AI 返回格式异常，请重试', 'err'); return; }
      upsertCompany(company, { ...info, aiGenerated: true });
      toast(`已生成「${company}」背景信息`);
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  return (
    <div className="col gap-14">
      <div className="glass card" style={{ padding: 14 }}>
        <div className="row gap-8 wrap">
          <input className="input input--sm grow" style={{ minWidth: 200 }} placeholder="输入公司名，AI 生成背景速览…"
            value={manual} onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && manual.trim()) { genInfo(manual.trim()); setManual(''); } }} />
          <Button size="sm" variant="primary" icon="sparkles" disabled={!!busy}
            onClick={() => { if (manual.trim()) { genInfo(manual.trim()); setManual(''); } }}>生成</Button>
          <span className="tx-4" style={{ fontSize: 11 }}>公司背景由 AI 依据公开常识生成，关键信息请以官网 / 年报核实为准</span>
        </div>
      </div>

      {companies.length === 0 ? (
        <div className="glass card">
          <Empty icon="building" title="暂无公司背景资料"
            desc="在上方输入公司名一键生成，或对网申记录 / 岗位列表中的公司点击「生成背景」。" />
          {allNames.filter((n) => !companies.some((c) => c.company === n)).length > 0 && (
            <div className="row gap-6 wrap" style={{ justifyContent: 'center', marginTop: 12 }}>
              {allNames.filter((n) => !companies.some((c) => c.company === n)).slice(0, 12).map((n) => (
                <button key={n} className="badge badge--muted" style={{ cursor: 'pointer', padding: '4px 10px' }}
                  disabled={busy === n} onClick={() => genInfo(n)}>
                  <Icon name="sparkles" size={10} /> {n}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid stagger" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 14 }}>
          {companies.map((c) => (
            <div className="glass card" key={c.id} style={{ padding: 16 }}>
              <div className="row-between gap-8" style={{ marginBottom: 10 }}>
                <span className="row gap-8">
                  <span className="tile" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>{c.company.slice(0, 2)}</span>
                  <span>
                    <span className="h-sub" style={{ display: 'block' }}>{c.company}</span>
                    <span className="tx-4" style={{ fontSize: 10.5 }}>更新于 {fmtDate(c.updatedAt)}{c.aiGenerated ? ' · AI 生成' : ''}</span>
                  </span>
                </span>
                <span className="row gap-6">
                  <Button size="sm" variant="ghost" icon="refresh" disabled={busy === c.company}
                    onClick={() => genInfo(c.company)} aria-label="重新生成" />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => { removeCompany(c.id); toast('已删除公司资料', 'info'); }} aria-label="删除" />
                </span>
              </div>
              <div className="comp-meta">
                {c.industry && <Badge tone="badge--accent" className="badge--wrap" title={c.industry}>{tagText(c.industry)}</Badge>}
                {c.scale && <Badge tone="badge--muted" className="badge--wrap" title={c.scale}>{tagText(c.scale)}</Badge>}
                {c.hq && <Badge tone="badge--muted" className="badge--wrap" title={`总部 ${c.hq}`}>总部 {tagText(c.hq)}</Badge>}
              </div>
              <div className="col gap-6 tx-2 comp-body" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                {c.business && <div><b>主营业务：</b>{c.business}</div>}
                {c.process && <div><b>招聘流程：</b>{c.process}</div>}
                {c.notes && <div><b>投递注意：</b>{c.notes}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
