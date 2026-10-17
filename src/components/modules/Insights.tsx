import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Badge, Empty, Progress, Segmented } from '../ui/Kit';
import { cn, download, STATUS_META, STATUS_ORDER, daysUntil, fmtDate } from '../../lib/util';
import { applicationsToMarkdown, applicationsToCSV, jobsToMarkdown, jobsToCSV, toMarkdownTable } from '../../lib/exporters';

interface Stage { key: string; label: string; n: number; }
interface Row { key: string; total: number; test: number; interview: number; offer: number; reject: number; }

/** 投递漏斗 + 渠道 ROI：回答「哪条路真的有效」 */
export default function Insights() {
  const { applications, jobs, offers, interviews, toast } = useStore();
  const [dim, setDim] = useState<'channel' | 'location' | 'month'>('channel');

  const funnel = useMemo<Stage[]>(() => {
    const reached = (min: number) => applications.filter((a) => STATUS_ORDER.indexOf(a.status) >= min || a.status === 'offer').length;
    return [
      { key: 'all', label: '投递总数', n: applications.length },
      { key: 'submitted', label: '已提交', n: reached(2) },
      { key: 'test', label: '进入笔试', n: reached(3) },
      { key: 'interview', label: '进入面试', n: reached(4) },
      { key: 'offer', label: '拿到 Offer', n: applications.filter((a) => a.status === 'offer').length },
    ];
  }, [applications]);

  const rows = useMemo<Row[]>(() => {
    const map = new Map<string, Row>();
    const keyOf = (a: typeof applications[number]) => {
      if (dim === 'channel') return a.channel?.trim() || '未填渠道';
      if (dim === 'location') return a.location?.trim() || '未填城市';
      return (a.submittedAt || a.createdAt || '').slice(0, 7) || '未填日期';
    };
    for (const a of applications) {
      const k = keyOf(a);
      const r = map.get(k) || { key: k, total: 0, test: 0, interview: 0, offer: 0, reject: 0 };
      r.total++;
      const idx = STATUS_ORDER.indexOf(a.status);
      if (idx >= 3) r.test++;
      if (idx >= 4) r.interview++;
      if (a.status === 'offer') r.offer++;
      if (a.status === 'reject') r.reject++;
      map.set(k, r);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [applications, dim]);

  const maxN = Math.max(1, ...funnel.map((f) => f.n));
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const pending = applications.filter((a) => ['todo', 'filling'].includes(a.status)).length;
  const upcoming = jobs.filter((j) => j.deadline && (daysUntil(j.deadline) ?? 99) >= 0 && (daysUntil(j.deadline) ?? 99) <= 7).length;

  const exportMd = () => {
    const md = [
      `# 秋招进度快照 ${fmtDate(new Date().toISOString())}`,
      '',
      '## 投递漏斗',
      toMarkdownTable(['阶段', '数量', '相对上一阶段转化'],
        funnel.map((f, i) => [f.label, f.n, i === 0 ? '—' : `${rate(f.n, funnel[i - 1].n)}%`])),
      '',
      `## 按${dim === 'channel' ? '渠道' : dim === 'location' ? '城市' : '月份'}统计`,
      toMarkdownTable(['维度', '投递', '笔试', '面试', 'Offer', '面试转化率'],
        rows.map((r) => [r.key, r.total, r.test, r.interview, r.offer, `${rate(r.interview, r.total)}%`])),
      '',
      '## 截止日历', jobsToMarkdown(jobs), '',
      '## 投递明细', applicationsToMarkdown(applications),
    ].join('\n');
    download(`秋招快照-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown');
    toast('已导出 Markdown 快照');
  };

  if (!applications.length && !jobs.length) {
    return <Empty icon="dashboard" title="还没有数据可以分析" desc="先在「网申记录」里记几条投递，或用「岗位追踪 → 导入汇总表」把日报里的截止日历一次导入。"
      action={<Button variant="primary" icon="upload" onClick={exportMd}>导出模板</Button>} />;
  }

  return (
    <div className="rise col gap-16">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
        <div className="stat glass"><div className="stat__ico"><Icon name="building" size={18} /></div><div className="stat__v">{applications.length}</div><div className="stat__l">累计投递</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="clock" size={18} /></div><div className="stat__v" style={{ color: 'var(--warn)' }}>{pending}</div><div className="stat__l">待完成（未提交）</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="interview" size={18} /></div><div className="stat__v" style={{ color: 'var(--accent-2)' }}>{rate(funnel[3].n, applications.length)}%</div><div className="stat__l">面试转化率</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="trophy" size={18} /></div><div className="stat__v" style={{ color: 'var(--ok)' }}>{offers.length}</div><div className="stat__l">Offer</div></div>
        <div className="stat glass"><div className="stat__ico"><Icon name="alert" size={18} /></div><div className="stat__v" style={{ color: 'var(--danger)' }}>{upcoming}</div><div className="stat__l">7 天内截止岗位</div></div>
      </div>

      <div className="glass card">
        <div className="card__head">
          <div className="card__title"><Icon name="filter" size={18} /> 投递漏斗</div>
          <div className="row gap-8">
            <Button size="sm" icon="doc" onClick={exportMd}>导出 Markdown</Button>
            <Button size="sm" icon="download" onClick={() => { download(`投递记录-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + applicationsToCSV(applications), 'text/csv'); toast('已导出 CSV'); }}>导出 CSV</Button>
          </div>
        </div>
        <div className="col gap-12">
          {funnel.map((f, i) => (
            <div key={f.key}>
              <div className="row-between" style={{ marginBottom: 5 }}>
                <span style={{ fontSize: 13, fontWeight: 620 }}>{f.label}</span>
                <span className="tx-3 mono" style={{ fontSize: 12 }}>
                  {f.n}{i > 0 && <span className="tx-4"> · 转化 {rate(f.n, funnel[i - 1].n)}%</span>}
                </span>
              </div>
              <div className="progress-bar"><div className="progress-bar__fill" style={{ width: `${(f.n / maxN) * 100}%`, opacity: 1 - i * 0.14 }} /></div>
            </div>
          ))}
        </div>
        <div className="divider" />
        <div className="tx-3" style={{ fontSize: 12, lineHeight: 1.7 }}>
          提示：漏斗按「当前状态」统计——投递记录只有一条当前状态，所以已进入面试的岗位也会计入「已提交」。
          被标为「未通过」的记录不计入笔试/面试阶段，便于看真实通过率。
        </div>
      </div>

      <div className="glass card">
        <div className="card__head">
          <div className="card__title"><Icon name="target" size={18} /> 渠道 / 城市效力</div>
          <Segmented value={dim} onChange={setDim} options={[
            { value: 'channel', label: '按渠道' },
            { value: 'location', label: '按城市' },
            { value: 'month', label: '按月份' },
          ]} />
        </div>
        {rows.length === 0 ? <div className="tx-3" style={{ fontSize: 13 }}>暂无数据</div> : (
          <div className="col gap-8">
            <div className="row tx-4" style={{ fontSize: 11.5, padding: '0 6px' }}>
              <span className="grow">维度</span>
              <span style={{ width: 54, textAlign: 'right' }}>投递</span>
              <span style={{ width: 54, textAlign: 'right' }}>笔试</span>
              <span style={{ width: 54, textAlign: 'right' }}>面试</span>
              <span style={{ width: 54, textAlign: 'right' }}>Offer</span>
              <span style={{ width: 74, textAlign: 'right' }}>面试率</span>
            </div>
            {rows.map((r) => (
              <div className="list-row" key={r.key} style={{ padding: '9px 10px' }}>
                <span className="grow truncate" style={{ fontSize: 13, fontWeight: 600 }}>{r.key}</span>
                <span className="mono tx-2" style={{ width: 54, textAlign: 'right', fontSize: 12.5 }}>{r.total}</span>
                <span className="mono tx-2" style={{ width: 54, textAlign: 'right', fontSize: 12.5 }}>{r.test}</span>
                <span className="mono tx-2" style={{ width: 54, textAlign: 'right', fontSize: 12.5 }}>{r.interview}</span>
                <span className="mono" style={{ width: 54, textAlign: 'right', fontSize: 12.5, color: 'var(--ok)' }}>{r.offer}</span>
                <span style={{ width: 74, textAlign: 'right' }}>
                  <Badge tone={rate(r.interview, r.total) >= 30 ? 'badge--ok' : rate(r.interview, r.total) >= 15 ? 'badge--warn' : 'badge--muted'}>
                    {rate(r.interview, r.total)}%
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="glass card">
        <div className="card__head"><div className="card__title"><Icon name="layers" size={18} /> 状态分布与备考联动</div></div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))' }}>
          {STATUS_ORDER.map((s) => {
            const n = applications.filter((a) => a.status === s).length;
            return (
              <div key={s} className="col gap-6" style={{ padding: 10 }}>
                <span className={cn('badge', STATUS_META[s].cls)} style={{ alignSelf: 'flex-start' }}>{STATUS_META[s].label}</span>
                <span className="h-sub" style={{ fontSize: 20 }}>{n}</span>
                <Progress value={(n / Math.max(1, applications.length)) * 100} />
              </div>
            );
          })}
        </div>
        <div className="divider" />
        <div className="row gap-16 wrap tx-3" style={{ fontSize: 12.5 }}>
          <span>面试记录 {interviews.length} 场</span>
          <span>Offer {offers.length} 个</span>
          <span>岗位库 {jobs.length} 条</span>
        </div>
      </div>
    </div>
  );
}
