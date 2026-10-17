/**
 * 公司维度的聚合与推断。
 *
 * 岗位追踪按「公司」而不是「岗位」呈现更符合真实决策方式：
 * 你关心的是「这家单位要不要投、我投了几个岗、什么时候截止」，
 * 而不是散落的 40 张岗位卡。这里负责把岗位按公司聚合并推断行业、重要度。
 */
import type { JobPosting, JobTrack, CompanyProfile } from '../types';
import { daysUntil } from './util';
import { inferTrack } from './mdImport';

/* ---------------- 行业推断 ---------------- */
const INDUSTRY_KW: [string, string[]][] = [
  ['不良资产 / AMC', ['金融资产', '东方资产', '信达', '长城资产', '华融', '资产管理']],
  ['交易所 / 金融基础设施', ['交易所', '股转', '清算', '登记结算', '中证', '期货']],
  ['银行', ['银行']],
  ['证券', ['证券', '券商', '投行', '建投']],
  ['基金', ['基金']],
  ['保险', ['保险', '人寿', '人保', '再保险', '养老']],
  ['律师事务所', ['律师事务所', '律所']],
  ['仲裁机构', ['仲裁']],
  ['公职 / 事业单位', ['组织部', '选调', '公务员', '党校', '人民政府', '管理局', '事业单位']],
  ['能源 / 电力', ['能源', '电网', '核电', '电力', '石油', '石化', '天然气', '煤', '油']],
  ['通信 / 科技', ['移动', '联通', '电信', '科技', '信息', '软件', '电子']],
  ['建筑 / 制造', ['建筑', '中铁', '中建', '中车', '船舶', '航空', '航天', '兵器', '钢铁', '机械']],
  ['综合央企 / 投资', ['集团', '控股', '投资', '国新', '国投', '招商局', '保利']],
];

export function inferIndustry(company: string, title = ''): string {
  const t = `${company} ${title}`;
  for (const [label, kws] of INDUSTRY_KW) if (kws.some((k) => t.includes(k))) return label;
  return '其他';
}

/* ---------------- 重要度 ---------------- */
export type PriorityKey = 'high' | 'mid' | 'low';
export const PRIORITY_META: Record<PriorityKey, { label: string; cls: string; icon: string }> = {
  high: { label: '非常重要', cls: 'badge--danger', icon: 'star' },
  mid: { label: '重要', cls: 'badge--warn', icon: 'star' },
  low: { label: '一般', cls: 'badge--info', icon: 'star' },
};
export const PRIORITY_ORDER: PriorityKey[] = ['high', 'mid', 'low'];

/** 重要度：优先用你手动设的，否则按「最近截止 + 当前进展」自动判定 */
export function autoPriority(jobs: JobPosting[], manual?: PriorityKey): PriorityKey {
  if (manual) return manual;
  const near = (n: number) => jobs.some((j) => { const d = daysUntil(j.deadline); return d !== null && d >= 0 && d <= n; });
  /* 原先还有一条 `near(7) || (applied && (offer|interview))` 的分支，它与下面这行覆盖同一集合，
     永远轮不到（且 offer/interview 是投递状态、不是岗位状态，取不到），已删除。 */
  if (near(7)) return 'high';
  if (near(30) || jobs.some((j) => ['test', 'applied'].includes(j.status))) return 'mid';
  return 'low';
}

/* ---------------- 按公司聚合 ---------------- */
export interface CompanyGroup {
  company: string;
  jobs: JobPosting[];
  industry: string;
  track: JobTrack;
  tracks: JobTrack[];
  sources: string[];
  website?: string;
  nextDeadline?: string;
  priority: PriorityKey;
  manualPriority?: PriorityKey;
}

export function groupByCompany(
  jobs: JobPosting[],
  profiles: CompanyProfile[],
  trackOf: (j: JobPosting) => JobTrack,
): CompanyGroup[] {
  const map = new Map<string, JobPosting[]>();
  for (const j of jobs) {
    const key = (j.company || '未命名单位').trim();
    map.set(key, [...(map.get(key) || []), j]);
  }
  const out: CompanyGroup[] = [];
  map.forEach((list, company) => {
    const profile = profiles.find((p) => p.company === company);
    const sources = Array.from(new Set(list.map((j) => j.source).filter(Boolean) as string[]));
    const deadlines = list.map((j) => j.deadline).filter(Boolean).sort() as string[];
    const tracks = Array.from(new Set(list.map(trackOf)));
    // 公司里第一个有链接的岗位，作为「官网」入口
    const website = profile?.website || list.map((j) => j.url).find((u) => !!u && /^https?:/i.test(u));
    const manual = (profile?.priority as PriorityKey | undefined);
    out.push({
      company,
      jobs: list.slice().sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999')),
      industry: profile?.industry || inferIndustry(company, list[0]?.title || ''),
      track: tracks[0] || 'private',
      tracks,
      sources,
      website,
      nextDeadline: deadlines[0],
      priority: autoPriority(list, manual),
      manualPriority: manual,
    });
  });
  const rank: Record<PriorityKey, number> = { high: 0, mid: 1, low: 2 };
  return out.sort((a, b) =>
    rank[a.priority] - rank[b.priority]
    || (a.nextDeadline || '9999').localeCompare(b.nextDeadline || '9999')
    || b.jobs.length - a.jobs.length);
}
