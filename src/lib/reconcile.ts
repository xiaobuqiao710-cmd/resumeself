/**
 * 全局对账（reconcile）——把「岗位库 ↔ 投递记录」的一致性从「事件时刻各自为政」
 * 改为「随时可从全量数据推导出的目标状态」。
 *
 * 为什么需要它：原先的同步只发生在**改状态/新建投递的那一刻**，而且只在岗位名对得上时才生效。
 * 于是三类偏差只增不减：
 *   ① 导入进来的新岗位从不回查已有投递 → 岗位卡显示「新岗位」，而该单位其实早已投递；
 *   ② 单位名写法不同（「深圳国际仲裁委员会」vs「深圳国际仲裁院 SCIA」）→ 事件时刻匹配不上，
 *      而提醒层用的是更宽松的口径 → 出现「提醒停了、岗位卡没变」；
 *   ③ 已投递的单位在岗位库根本没有对应岗位（投递是手填的）→ 永远联不上。
 *
 * 本模块是**纯函数**：只计算「应该变成什么」，不修改数据；由 store 决定何时落地，
 * 因此可以离线用真实数据跑验证（见 planReconcile 的单测）。
 */
import type { Application, AppStatus, JobPosting, JobStatus } from '../types';
import { sameCompanyStem, todayISO, uid } from './util';
import { planJobDedupe, type DedupePlan } from './dedupe';

/** 已提交及之后的状态意味着「投递动作已完成」，岗位库应显示为已投递 */
export const SUBMITTED_ONWARDS: AppStatus[] = ['submitted', 'test', 'interview', 'offer'];

export interface JobStatusPatch {
  id: string;
  status: JobStatus;
  appliedBy?: string;
}

export interface ReconcilePlan {
  /** 岗位状态的增删改（幂等：重复执行结果一致） */
  jobStatus: JobStatusPatch[];
  /** 已投递、但岗位库里完全没有对应单位的投递记录 → 建议补建岗位条目 */
  orphanApps: Application[];
  /** 建议补建的岗位条目（由投递记录推导） */
  jobsToCreate: JobPosting[];
  /** 岗位重复检测方案（**不自动执行**，需用户确认） */
  dedupe: DedupePlan;
}

/** 某条投递记录对应的岗位。
 *
 *  **按单位整体命中**：同一家单位的岗位一起对待。
 *  用户的诉求是「一家企业已经投递了，岗位追踪和提醒就都不该再提醒」——一次网申通常就是
 *  对这家单位的一次动作，因此单位内其余岗位（如同一校招的技术类/非技术类两条线）也一并算已投递。
 *  截止提醒层本来就是按单位整体判断的（该单位有任一 submitted+ 就不再提醒），
 *  这里跟它保持同一口径，否则又会出现「提醒停了、岗位卡还是新岗位」。
 *  仅 `archived` 岗位不参与（归档是用户的明确处置）。
 */
export function matchJobsForApp(jobs: JobPosting[], a: Application): { jobs: JobPosting[]; scope: 'posting' | 'company' | 'none' } {
  const live = jobs.filter((j) => j.status !== 'archived');
  const byCompany = live.filter((j) => sameCompanyStem(j.company, a.company));
  if (!byCompany.length) return { jobs: [], scope: 'none' };
  const exact = byCompany.filter((j) => {
    const jt = (j.title || '').trim(), pt = (a.position || '').trim();
    if (!jt || !pt) return true;
    return jt === pt || jt.includes(pt) || pt.includes(jt);
  });
  return { jobs: byCompany, scope: exact.length ? 'posting' : 'company' };
}

/** 从投递记录补建一条岗位（投递是手填的、岗位库还没有这条时用） */
export function jobFromApp(a: Application): JobPosting {
  return {
    id: uid('job'),
    company: a.company,
    title: a.position || '岗位',
    city: a.location,
    salary: a.salary,
    source: a.channel || '投递记录',
    url: a.link,
    deadline: a.deadline,
    status: 'applied',
    appliedBy: a.id,
    createdAt: todayISO(),
    updatedAt: todayISO(),
  };
}

/**
 * 计算岗位库应有的状态（幂等）。
 * 只动「由投递同步而来」的岗位（appliedBy 有值）；用户手动标记的、已归档的一律不碰。
 */
export function planReconcile(
  jobs: JobPosting[],
  apps: Application[],
  opts: { createMissing?: boolean } = {},
): ReconcilePlan {
  const submitted = apps.filter((a) => SUBMITTED_ONWARDS.includes(a.status));

  /* 目标状态：每条已投递记录覆盖到的岗位 → 应为 applied，且 appliedBy 指向该记录 */
  const desired = new Map<string, string>();
  const orphanApps: Application[] = [];
  for (const a of submitted) {
    const { jobs: hit, scope } = matchJobsForApp(jobs, a);
    if (scope === 'none') { orphanApps.push(a); continue; }
    for (const j of hit) if (!desired.has(j.id)) desired.set(j.id, a.id);
  }

  const jobStatus: JobStatusPatch[] = [];
  for (const j of jobs) {
    if (j.status === 'archived') continue;                 // 归档是用户的明确意图，不参与对账
    const want = desired.get(j.id);
    if (want) {
      if (j.status !== 'applied' || j.appliedBy !== want) {
        jobStatus.push({ id: j.id, status: 'applied', appliedBy: want });
      }
      continue;
    }
    /* 曾经由投递同步成「已投递」，但那条投递已退回/删除 → 回退为感兴趣。
       只回退 appliedBy 有值的：用户手动标的「已投递」不动。 */
    if (j.status === 'applied' && j.appliedBy && !apps.some((a) => a.id === j.appliedBy && SUBMITTED_ONWARDS.includes(a.status))) {
      jobStatus.push({ id: j.id, status: 'interested', appliedBy: undefined });
    }
  }

  const jobsToCreate = opts.createMissing ? orphanApps.map(jobFromApp) : [];

  return { jobStatus, orphanApps, jobsToCreate, dedupe: planJobDedupe(jobs) };
}

/** 对账摘要（供 toast / 面板展示） */
export function summarizeReconcile(plan: ReconcilePlan): string[] {
  const out: string[] = [];
  const toApplied = plan.jobStatus.filter((p) => p.status === 'applied').length;
  const reverted = plan.jobStatus.filter((p) => p.status !== 'applied').length;
  if (toApplied) out.push(`${toApplied} 个岗位同步为「已投递」`);
  if (reverted) out.push(`${reverted} 个岗位回退为「感兴趣」`);
  if (plan.orphanApps.length) out.push(`${plan.orphanApps.length} 条已投递记录在岗位库没有对应岗位`);
  if (plan.dedupe.removeIds.length) out.push(`检出 ${plan.dedupe.groups.length} 组重复岗位（${plan.dedupe.removeIds.length} 条）`);
  return out;
}

/** 把对账结果落到岗位上（纯函数，返回新数组） */
export function applyReconcile(jobs: JobPosting[], plan: ReconcilePlan): JobPosting[] {
  if (!plan.jobStatus.length && !plan.jobsToCreate.length) return jobs;
  const byId = new Map(plan.jobStatus.map((p) => [p.id, p]));
  const next = jobs.map((j) => {
    const p = byId.get(j.id);
    if (!p) return j;
    return { ...j, status: p.status, appliedBy: p.appliedBy, updatedAt: todayISO() };
  });
  return [...plan.jobsToCreate, ...next];
}
