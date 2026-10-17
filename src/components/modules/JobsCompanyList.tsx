import React, { useMemo, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge, Button } from '../ui/Kit';
import { cn, fmtDate, daysUntil, tagText } from '../../lib/util';
import { JOB_STATUS_META, scoreTone, TIER_SHORT } from '../../lib/jobMeta';
import { TRACK_META } from '../../lib/mdImport';
import { groupByCompany, PRIORITY_META, PRIORITY_ORDER, type PriorityKey } from '../../lib/company';
import type { JobPosting, CompanyProfile, JobTrack } from '../../types';

/**
 * 岗位列表 · 按公司分组。
 * 为什么这样排：秋招真实的决策单位是「这家单位投不投、投了几个岗、什么时候截止」，
 * 而不是 40 张彼此无关的岗位卡。所以顶层是公司卡（含行业、岗位数、来源、官网、重要度），
 * 岗位收在「展开查看岗位」里 —— 默认收起，搜索时自动展开。
 */
export function JobsCompanyList({ jobs, profiles, query, trackOf, onOpen, onSetPriority }:
  { jobs: JobPosting[]; profiles: CompanyProfile[]; query: string;
    trackOf: (j: JobPosting) => JobTrack;
    onOpen: (j: JobPosting) => void;
    onSetPriority: (company: string, next?: PriorityKey) => void }) {

  const groups = useMemo(() => groupByCompany(jobs, profiles, trackOf), [jobs, profiles, trackOf]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const searching = query.trim().length > 0;
  /* 默认展开规则：搜索时展开全部；只有 1 个岗位的公司直接展开（省掉一次无意义的点击）；其余收起 */
  const isOpen = (c: string, n: number) => open[c] ?? (searching || n === 1);

  /* 点击重要度徽标：自动 → 非常重要 → 重要 → 一般 → 自动 */
  const cycle = (company: string, cur?: PriorityKey) => {
    if (!cur) return onSetPriority(company, 'high');
    const i = PRIORITY_ORDER.indexOf(cur);
    return onSetPriority(company, i >= PRIORITY_ORDER.length - 1 ? undefined : PRIORITY_ORDER[i + 1]);
  };

  return (
    <div className="col gap-12">
      {groups.map((g) => {
        const p = PRIORITY_META[g.priority];
        const expanded = isOpen(g.company, g.jobs.length);
        const deadlineDays = daysUntil(g.nextDeadline);
        return (
          <div className="glass card" key={g.company} style={{ padding: 16 }}>
            {/* 第一行：公司名 + 重要度 */}
            <div className="row-between gap-10 wrap">
              <div className="row gap-8" style={{ minWidth: 0, alignItems: 'center' }}>
                <span className="h-sub truncate" style={{ fontSize: 16.5 }}>{g.company}</span>
                <button className={cn('badge', p.cls)} style={{ cursor: 'pointer', border: 'none' }}
                  title="点击切换重要度（自动判定 → 非常重要 → 重要 → 一般 → 恢复自动）"
                  onClick={() => cycle(g.company, g.manualPriority)}>
                  <Icon name="star" size={11} /> {p.label}
                </button>
              </div>
              {g.website && (
                <a href={g.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" icon="external">官网</Button>
                </a>
              )}
            </div>

            {/* 第二行：行业 · 岗位数 · 来源 / 最近截止 */}
            <div className="row gap-8 wrap tx-3" style={{ fontSize: 12.5, marginTop: 7, alignItems: 'center' }}>
              <span className="row gap-5" title={g.industry}><Icon name="building" size={13} /> {tagText(g.industry)}</span>
              <span>·</span>
              <span>{g.jobs.length} 个岗位</span>
              {g.sources.length > 0 && <>
                <span>·</span>
                <span className="row gap-5"><Icon name="info" size={13} /> {g.sources.join(' / ')}</span>
              </>}
              {g.nextDeadline && <>
                <span>·</span>
                <span className={deadlineDays !== null && deadlineDays <= 7 ? '' : 'tx-3'}
                  style={deadlineDays !== null && deadlineDays <= 7 ? { color: 'var(--danger)', fontWeight: 620 } : undefined}>
                  最近截止 {fmtDate(g.nextDeadline)}
                  {deadlineDays !== null && deadlineDays >= 0 ? `（${deadlineDays === 0 ? '今天' : deadlineDays + ' 天'}）` : ''}
                </span>
              </>}
            </div>

            {/* 第三行：标签 */}
            <div className="row gap-6 wrap" style={{ marginTop: 10 }}>
              <Badge tone="badge--muted">2027 秋招</Badge>
              {/* 行业来自公司资料（可能是 AI 生成的整句），过 tagText 收窄 + badge--wrap 兜底：
                  原样塞进 nowrap 胶囊会撑破卡片、盖住隔壁那张（公司背景卡踩过同一个坑）。 */}
              <Badge tone="badge--muted" className="badge--wrap" title={g.industry}>{tagText(g.industry)}</Badge>
              {g.tracks.map((t) => <Badge key={t} tone={TRACK_META[t].cls}>{TRACK_META[t].label}</Badge>)}
            </div>

            {/* 展开岗位 */}
            <button className="copy-btn" style={{ marginTop: 12 }}
              onClick={() => setOpen((o) => ({ ...o, [g.company]: !expanded }))}>
              <Icon name={expanded ? 'chevron' : 'chevronR'} size={13} />
              {expanded ? '收起岗位' : `展开查看岗位（${g.jobs.length}）`}
            </button>

            {expanded && (
              <div className="col gap-6" style={{ marginTop: 10 }}>
                {g.jobs.map((j) => {
                  const d = daysUntil(j.deadline);
                  return (
                    <div className="list-row" key={j.id} style={{ padding: '10px 12px', cursor: 'pointer' }}
                      onClick={() => onOpen(j)}>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="truncate" style={{ display: 'block', fontSize: 13.5, fontWeight: 620 }}>{j.title}</span>
                        <span className="tx-3" style={{ display: 'block', fontSize: 11.5, marginTop: 3 }}>
                          {[j.city, j.salary, j.deadline ? `截止 ${fmtDate(j.deadline)}` : ''].filter(Boolean).join(' · ') || '未填城市 / 薪资'}
                        </span>
                        {(j.exam || j.requirements) && (
                          <span className="tx-4 clamp-2" style={{ display: 'block', fontSize: 11, marginTop: 3, lineHeight: 1.55 }}>
                            {j.exam ? `📝 笔试：${j.exam}` : `要求：${j.requirements}`}
                          </span>
                        )}
                      </span>
                      {j.match && (
                        <Badge tone={scoreTone(j.match.score)}>
                          {j.match.tier ? `${TIER_SHORT[j.match.tier]} ${j.match.score}` : `匹配 ${j.match.score}`}
                        </Badge>
                      )}
                      <Badge tone={JOB_STATUS_META[j.status].cls}>{JOB_STATUS_META[j.status].label}</Badge>
                      {j.deadline && d !== null && d >= 0 && d <= 7 && (
                        <Badge tone={d === 0 ? 'badge--danger' : 'badge--warn'}>{d === 0 ? '今天截止' : `${d} 天后截止`}</Badge>
                      )}
                      <Icon name="chevronR" size={15} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 供外部复用：把优先级顺序导出，便于在 Jobs 里提示 */
export { PRIORITY_ORDER };
