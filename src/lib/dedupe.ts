/**
 * 岗位库去重（纯逻辑，不依赖 React，便于单测与多处复用）。
 *
 * 背景：岗位常从汇总表、邮件、坚果云同步等多条路径进来，同一条信息写法略有差异
 * （「中金公司」/「中国国际金融股份有限公司」、「2027 校招法务岗」/「法务岗」），
 * 精确比对挡不住，于是列表和截止提醒里就出现一堆看起来重复的条目。
 *
 * 判定分两档：
 *   1. 同一档 = 单位是同一家（`sameCompany` 宽松比对）且岗位名归一化后相同 → 默认合并；
 *   2. 相似档 = 同一单位、岗位名互为包含（如「法务岗」与「法务合规岗」）→ 可能是不同岗位，
 *      默认只提示不合并，由用户勾选后才合并。
 * 合并时把被删项里独有的链接 / 要求 / 笔试 / 截止日 / 薪资补进保留项，尽量不丢信息。
 */
import type { JobPosting } from '../types';
import { sameCompany, stripDecor } from './util';

/** 去掉括号注解：括号里多是简称/批次/要求说明，不影响「是不是同一条岗位」的判断。
 *  反例（曾漏判）：「全行总口径（部分分行传 9/30，）」vs「全行总口径（部分分行渠道传 9/30，）」——
 *  括号内一字之差就会让标题既不完全相同、也不互为包含，从而完全逃逸判重。 */
function dropParens(s: string): string {
  return String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')      // 成对括号
    .replace(/[（(][^）)]*$/, '');          // 源表被截断的未闭合括号（如「①法律类（硕士+」）
}

/** 岗位名归一化：去装饰标记与括号注解、去空格标点、剥掉「2027 届校招」「招聘」「岗位」这类通用前后缀。
 *  注意：结果可能为**空串**（如「2027 校招」「秋招」）——这类是「整批招聘」条目而非具体岗位，
 *  判重侧必须单独处理，不能当成「没写岗位名」而跳过（见 planJobDedupe 的泛化标题规则）。 */
export function normTitle(t?: string): string {
  return stripDecor(dropParens(String(t || '')))
    .replace(/[\s\-—_/（）()【】\[\]·、,，.。]/g, '')
    .replace(/^(20\d{2})?(届|年)?(校招|秋招|春招|校园招聘|社会招聘|招聘)?/, '')
    .replace(/(校招|秋招|春招|校园招聘|社会招聘|招聘|岗位|职位|岗)$/g, '');
}

export interface DedupeGroup {
  keep: JobPosting;
  dups: JobPosting[];
  patch: Partial<JobPosting>;          // 从被删项补进保留项的字段
  reason: 'same' | 'similar';
}

export interface SimilarPair { company: string; a: string; b: string; ids: [string, string]; }

export interface DedupePlan {
  groups: DedupeGroup[];
  similarPairs: SimilarPair[];
  removeIds: string[];
}

/** 信息完整度打分：留下信息最全的那条 */
function completeness(j: JobPosting): number {
  return (j.url ? 2 : 0) + (j.requirements ? 2 : 0) + (j.exam ? 2 : 0) + (j.jd ? 2 : 0)
    + (j.deadline ? 2 : 0) + (j.match ? 1 : 0) + (j.city ? 1 : 0) + (j.salary ? 1 : 0);
}

/** 生成去重方案（不改数据，供预览与执行共用） */
export function planJobDedupe(
  jobs: JobPosting[],
  opts: { mergeSimilar?: boolean; company?: string } = {},
): DedupePlan {
  const list = opts.company ? jobs.filter((j) => sameCompany(j.company, opts.company)) : jobs;

  /* 两个并查集：CO = 同一家单位（sameCompany 不保证传递，故两两连）；PO = 同一条岗位 */
  const mkDsu = (n: number) => {
    const p = Array.from({ length: n }, (_, i) => i);
    const f = (i: number): number => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
    const u = (a: number, b: number) => { const ra = f(a), rb = f(b); if (ra !== rb) p[rb] = ra; };
    return { f, u };
  };
  const CO = mkDsu(list.length);
  const PO = mkDsu(list.length);
  for (let i = 0; i < list.length; i++) {
    for (let k = i + 1; k < list.length; k++) {
      if (sameCompany(list[i].company, list[k].company)) CO.u(i, k);
    }
  }

  /* 同单位内再判岗位：先把成员按公司族归拢，避免跨单位误并 */
  const coFamilies = new Map<number, number[]>();
  list.forEach((_, i) => { const r = CO.f(i); coFamilies.set(r, [...(coFamilies.get(r) || []), i]); });

  const similarPairs: SimilarPair[] = [];
  const titles = list.map((j) => normTitle(j.title));
  for (const members of coFamilies.values()) {
    const spec = members.filter((i) => titles[i]);        // 具体岗位
    const gen = members.filter((i) => !titles[i]);        // 泛化标题（「2027 校招」「秋招」）

    /* 泛化标题规则（修复漏判的关键）：
     *   - 1 个泛化 + 1 个具体 → 同一条招聘（如「深圳国际仲裁院 SCIA」的「2027 校招」与「仲裁业务法律顾问…」）；
     *   - 只有多个泛化、没有具体 → 同一条招聘的不同写法（如「建设银行 2027 校招」与「中国建设银行 秋招」）；
     *   - 1 个泛化 + ≥2 个具体 → 泛化那条是「整批」条目（如工商银行下的 4 个不同岗位），**不合并**，
     *     否则会把「客户经理/科技菁英/专业英才/星辰管培生」误并成一条。 */
    if (gen.length && spec.length === 1) gen.forEach((i) => PO.u(i, spec[0]));
    else if (gen.length > 1 && spec.length === 0) for (let n = 1; n < gen.length; n++) PO.u(gen[0], gen[n]);

    for (let a = 0; a < spec.length; a++) {
      for (let b = a + 1; b < spec.length; b++) {
        const i = spec[a], k = spec[b], na = titles[i], nb = titles[k];
        if (na === nb) { PO.u(i, k); continue; }
        if (na.includes(nb) || nb.includes(na)) {
          similarPairs.push({ company: list[i].company, a: list[i].title, b: list[k].title, ids: [list[i].id, list[k].id] });
          if (opts.mergeSimilar) PO.u(i, k);
        }
      }
    }
  }
  const find = PO.f;

  const families = new Map<number, JobPosting[]>();
  list.forEach((j, i) => { const r = find(i); families.set(r, [...(families.get(r) || []), j]); });

  const groups: DedupeGroup[] = [];
  families.forEach((fam) => {
    if (fam.length < 2) return;
    /* 保留项的选取：**先看岗位名是否具体**，再看信息完整度。
     * 顺序不能反——「2027 校招」这类泛化条目常因带链接/要求而信息分更高，
     * 若按信息分优先，就会把「仲裁业务法律顾问（法学硕士+法考+英语）」合并掉、只留一个「2027 校招」。
     * 泛化条目独有的链接/截止日等字段会由下面的 patch 补进保留项，信息不会丢。 */
    const sorted = [...fam].sort((a, b) =>
      (normTitle(b.title) ? 1 : 0) - (normTitle(a.title) ? 1 : 0)
      || completeness(b) - completeness(a));
    const keep = sorted[0];
    const dups = sorted.slice(1);
    const patch: Partial<JobPosting> = {};
    for (const d of dups) {
      if (!keep.url && d.url) patch.url = d.url;
      if (!keep.requirements && d.requirements) patch.requirements = d.requirements;
      if (!keep.exam && d.exam) patch.exam = d.exam;
      if (!keep.deadline && d.deadline) patch.deadline = d.deadline;
      if (!keep.jd && d.jd) patch.jd = d.jd;
      if (!keep.salary && d.salary) patch.salary = d.salary;
      if (!keep.city && d.city) patch.city = d.city;
      if (!keep.match && d.match) patch.match = d.match;
      if (!keep.appliedBy && d.appliedBy) patch.appliedBy = d.appliedBy;
      // 进展状态取更靠后的那个，避免把「已投递」合并回「新岗位」
      if (d.status && d.status !== 'new' && (keep.status === 'new' || !keep.status)) patch.status = d.status;
    }
    groups.push({
      keep, dups, patch,
      reason: dups.every((d) => normTitle(d.title) === normTitle(keep.title)) ? 'same' : 'similar',
    });
  });

  groups.sort((a, b) => b.dups.length - a.dups.length);
  return { groups, similarPairs, removeIds: groups.flatMap((g) => g.dups.map((d) => d.id)) };
}
