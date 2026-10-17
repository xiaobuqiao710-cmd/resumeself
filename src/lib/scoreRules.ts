/**
 * 岗位价值评分 —— 评分口径（四维加权 + S/A/B/C 分档）
 * ==================================================================
 * ⚠️ 本机存在**两份**同名副本，改一边必须同步另一边（2026-09-28 定）：
 *    权威：`~/Desktop/图鲲/resumeself-opensource/src/lib/`
 *          ← 线上站（resumeself.vercel.app）源码；qz-tracker 的 `lib/qz-rules.mjs` 从这里打包
 *    副本：`~/Documents/QoderCN/2026-09-05/chat-1/qiuzhao-assistant/src/lib/`
 *          ← 另一个 App 分叉自带一份（它不能跨仓库 import TypeScript）
 *    两份不一致时，权威侧 `npm run check:rules` 会告警（daily.sh 阶段 0 每天跑一次）。
 *
 * 本文件回答一个问题：**这条机会值不值得我优先投？**
 *
 * 与 `trackRules.ts`（准入）的分工：
 *   · trackRules = 门禁，回答「要不要收」——二元，只有阳性证据才拒；
 *   · scoreRules = 排序，回答「先投哪个」——0~100 分，四档。
 * 两者都**不删除数据**：门禁拒掉的进 `rejected` 列表照实展示，
 * 评分低的进 C 档折叠显示。静默丢机会的代价远大于多留一条噪音。
 *
 * ── 四个维度（满分 100）──────────────────────────────────
 *   ① 机构梯队 org      48 分 —— 最重要。用户的核心目标是
 *      金融基础设施 / 中央金融企业总部 / 国家级仲裁 / 中央选调。
 *   ② 岗位对口 role     28 分 —— 用户是法律 / 金融方向，
 *      法务合规岗远优于技术岗；泛招公告按「未指明」给中位分。
 *   ③ 地域 region       12 分 —— 北京 > 上海/深圳 > 浙江/江苏/广东。
 *   ④ 门槛匹配 elig     12 分 —— 2027 届可投、不被博士/社招/专业卡死。
 *
 * ⚠️ **为什么地域只占 12 分？** 因为地域与机构梯队**高度相关** ——
 * 央企总部、金融基础设施、国家级仲裁几乎都在北京。给地域高分等于把
 * 「在北京」这件事算两遍，实测会让「中央金融企业总部的泛招公告」也冲到 S 档，
 * 把「必投」标签稀释到没有区分度（真实档案 188 条里 68 条是 S）。
 * 所以地域降为 12 分，且**只加分不扣分**。
 *
 * ── 与准入规则一致的两条纪律 ────────────────────────────────
 * · **地域只加分、不扣分。** 判不出地域时给基准分而不是 0 —— 北大就业网
 *   接口**没有工作地点字段**，用「没写」当作「不在北京」是拿不存在的信息做决定。
 * · **泛招公告不判岗位性质。** 「XX 2027 校园招聘」这类标题里没有岗位信息，
 *   给它中位分 10，而不是按「没写法务」判成非法律岗。
 *
 * ── 分档（阈值改这里）────────────────────────────────────
 *   S ≥ 80  必投（置顶 + 强提醒）／ A ≥ 65 重点／ B ≥ 45 常规／ C < 45 低优先
 * 权重与阈值都集中在 `WEIGHTS` / `TIER_META`，调参只改这两处，不要在函数里写魔数。
 * ==================================================================
 */

import type { ScoreTier } from '../types';
import {
  detectTargetRegions,
  hasForeignRegionEvidence,
  hasLegalRole,
  isFinanceOrg,
  isInfraOrg,
  isArbitrationOrg,
  isCivilOrg,
  isCentralSoe,
  isLocalSoe,
  isTopTierPrivate,
  isNotableTech,
  isConfirmedPrivate,
  HQ_SUFFIX,
  BRANCH_SUFFIX,
} from './trackRules';

/** 分档类型定义在 `types.ts`（全站类型之家），这里只做转出，避免两处各写一份联合类型 */
export type { ScoreTier };

export const TIER_META: Record<ScoreTier, { label: string; min: number; cls: string; desc: string }> = {
  S: { label: 'S · 核心目标', min: 80, cls: 'tier-s', desc: '顶层机构（金融基础设施 / 中央金融企业总部 / 国家级仲裁 / 中央选调）且岗位对口 —— 优先投' },
  A: { label: 'A · 重点', min: 65, cls: 'tier-a', desc: '高价值机构（或对口岗已确证），值得尽快投' },
  B: { label: 'B · 常规', min: 45, cls: 'tier-b', desc: '可投，但机构层级或岗位对口度一般' },
  C: { label: 'C · 低优先', min: 0, cls: 'tier-c', desc: '与目标方向偏离，折叠留档' },
};

/**
 * 提醒线。「明显提示」的**稀缺性由增量保证**，不由绝对分数保证 ——
 * 每日新增约 20 条，越过这条线的通常 0~3 条，正是该被推到的量级。
 * 若按整库去数，主档案 188 条里有 68 条过线，那是归档清单不是提醒清单。
 */
export const ALERT_MIN_SCORE = 78;

export const TIER_ORDER: ScoreTier[] = ['S', 'A', 'B', 'C'];

export function tierOf(score: number): ScoreTier {
  if (score >= TIER_META.S.min) return 'S';
  if (score >= TIER_META.A.min) return 'A';
  if (score >= TIER_META.B.min) return 'B';
  return 'C';
}

/**
 * 全部权重。四个维度各自的上限之和恰好 100。
 * 调整任何一项后请重跑 `/tmp/qz-rules-test.cjs` 与 `/tmp/qz-replay.cjs`，
 * 确认分档分布没有被意外推平。
 */
export const WEIGHTS = {
  /** ① 机构梯队 */
  org: {
    infra: 48,            // 金融基础设施 / 交易场所
    arbitration: 48,      // 仲裁与争议解决机构
    civil: 46,            // 体制内序列
    centralFinHq: 48,     // 中央金融企业 · 总部
    centralFinBranch: 36, // 中央金融企业 · 分支机构
    topFinance: 38,       // 头部股份制银行 / 券商
    finance: 26,          // 地方 / 分支金融机构
    centralSoeHq: 44,     // 央企集团 · 总部
    centralSoeBranch: 34, // 央企集团 · 分支 / 省级单位
    localSoe: 28,         // 地方国企 / 平台
    bigTech: 28,          // 大厂 / 优质科创
    notableTech: 26,      // 知名科技 / 制造企业
    private: 16,
    other: 14,
    offTarget: 4,         // 中小学 / 医院等非目标主体
  },
  /** ② 岗位对口 */
  role: {
    legal: 28, mgmt: 22, fin: 15, broad: 10, nonLegal: 4,
  },
  /** ③ 地域（只加分，不扣分） */
  region: {
    beijing: 12, shanghaiShenzhen: 9, otherTarget: 6, unknown: 5,
  },
  /** ④ 门槛匹配 */
  elig: {
    base: 8, legalFriendly: 4, max: 12,
    penaltyPhd: -6, penaltySocialHire: -6, penaltyIntern: -3,
  },
} as const;

const W = WEIGHTS;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/* ================= 维度一：机构梯队（满分 48） ================= */

/**
 * 头部股份制银行 / 券商。
 * `trackRules` 的央企名单（CENTRAL_HINT_KW）收的是「中字头」，招商、兴业、
 * 浦发这些不在里面，会被 `isCentralSoe` 判成地方金融机构而降档 —— 但它们是
 * 全国性头部机构，和六大行同档。故单独列白名单。
 */
const TOP_FINANCE_KW = [
  '招商银行', '招商证券', '兴业银行', '浦发银行', '上海浦东发展银行', '光大银行', '光大证券',
  '民生银行', '平安银行', '华夏银行', '广发银行', '广发证券', '浙商银行', '渤海银行', '恒丰银行',
  '中金公司', '中金财富', '国泰君安', '华泰证券', '中信建投', '申万宏源', '银河证券', '国信证券',
  '东方证券', '海通证券', '招商局', '国投', '国新', '中信',
];

/** 期货公司是金融机构，不是交易场所 —— INFRA_ORG 里的「期货」会把它们误抬到基础设施档 */
const FUTURES_FIRM = /期货(有限)?(责任)?公司|期货经纪/;
/** 中小学校 / 高校 / 医院 —— 出现在岗位库里基本是噪音 */
const OFF_TARGET_ORG = /(中学|小学|初中|高中|幼儿园|教育集团|培训学校|补习|医院|诊所|卫生院)/;
/** 人才服务中心类「公共服务」名号会命中 CIVIL_ORG，但它们不是公职序列 */
const CIVIL_FALSE_POSITIVE = /人才服务中心|人才服务|人才市场/;

/**
 * 是不是「总部级」条目。
 * 判据是**两个否定**：没写分支机构后缀（分行 / 分公司 / 省分行…），
 * 也没点名外省城市（复用准入侧的 `hasForeignRegionEvidence`）。
 * 两者都不成立时按总部给分 —— 「中国银行 2027 校园招聘」是总行统一招聘，
 * 因为名字里没写「总行」就降档是错的（实测这一条把中国银行压到 B 档）。
 */
function isHeadQuarter(c: string): boolean {
  return HQ_SUFFIX.test(c) || (!BRANCH_SUFFIX.test(c) && !hasForeignRegionEvidence(c));
}

export interface OrgResult { score: number; reason: string }

function orgScore(company: string, title: string, detail: string): OrgResult {
  const c = String(company || '').trim();
  if (!c) return { score: 0, reason: '' };

  if (OFF_TARGET_ORG.test(c)) return { score: W.org.offTarget, reason: '非目标行业主体' };

  /* ① 金融基础设施与交易场所 —— 用户明确的第一优先级 */
  if (isInfraOrg(c) && !FUTURES_FIRM.test(c)) return { score: W.org.infra, reason: '金融基础设施 / 交易场所' };

  /* ② 仲裁与争议解决机构（含涉外仲裁，是保留项而非排除项） */
  if (isArbitrationOrg(c)) return { score: W.org.arbitration, reason: '仲裁与争议解决机构' };

  /* ③ 体制内序列 */
  if (isCivilOrg(c) && !CIVIL_FALSE_POSITIVE.test(c) && !/有限公司/.test(c)) {
    return { score: W.org.civil, reason: '体制内序列（选调 / 国考 / 公职）' };
  }

  /* ④ 中央金融企业 */
  if (isFinanceOrg(c) && (isCentralSoe(c) || TOP_FINANCE_KW.some((k) => c.includes(k)))) {
    return isHeadQuarter(c)
      ? { score: W.org.centralFinHq, reason: '中央金融企业 · 总部' }
      : { score: W.org.centralFinBranch, reason: '中央金融企业 · 分支机构' };
  }
  if (TOP_FINANCE_KW.some((k) => c.includes(k))) return { score: W.org.topFinance, reason: '头部股份制银行 / 券商' };
  if (isFinanceOrg(c)) return { score: W.org.finance, reason: '金融机构（地方 / 分支）' };

  /* ⑤ 央企集团（实业） */
  if (isCentralSoe(c)) {
    return isHeadQuarter(c)
      ? { score: W.org.centralSoeHq, reason: '央企集团 · 总部' }
      : { score: W.org.centralSoeBranch, reason: '央企集团 · 分支 / 省级单位' };
  }

  /* ⑥ 地方国企与平台（能走到这里，说明已通过地域准入） */
  if (isLocalSoe(c)) return { score: W.org.localSoe, reason: '地方国企 / 平台' };

  /* ⑦ 民营：大厂 / 优质科创 —— 行业词同时看单位名**与岗位文本**。
   *   北大宣讲类条目的行业信息（如「方向：半导体装备研发」）只写在 direction 列里，
   *   只看单位名会让北方华创、睿创微纳这类掉到 C 档。 */
  if (isTopTierPrivate(c, `${title} ${detail}`)) return { score: W.org.bigTech, reason: '大厂 / 优质科创' };
  if (isNotableTech(c)) return { score: W.org.notableTech, reason: '知名科技 / 制造企业' };
  if (isConfirmedPrivate(c)) return { score: W.org.private, reason: '民营企业' };

  return { score: W.org.other, reason: '其他机构' };
}

/* ================= 维度二：岗位对口（满分 28） ================= */

const MGMT_KW = /(管培生|管理培训生|管培|菁英|精英计划|储备干部|后备人才|综合管理|总部管培|金耀人才|星辰计划|新苗计划)/;
const FIN_ROLE_KW = /(投行|投资银行|行业研究|研究岗|研究员|量化|投资|资产管理|风险管理|稽核|审计|财务|会计|经济|金融|精算|投资经理|交易员)/;
const NON_LEGAL_KW = /(算法|开发|研发|工程师|测试|运维|设计师|产品经理|运营专员|销售|客服|教师|医师|护士|药师|土木|机械|电气|化工|材料|施工|翻译|编辑|记者)/;
/** 泛招公告：只写了年份 + 招聘动作，没有具体岗位信息 */
const BROAD_POSTING = /(校园招聘|校招|秋季招聘|春季招聘|全球招聘|招聘公告|招聘简章|招录|招募|人才引进)/;

export interface RoleResult { score: number; reason: string }

/**
 * 判岗位性质前**先把公司名从标题里剥掉**。
 *
 * 北大就业网的 `title` 是「公司名 + 招聘动作」拼成的（如
 * 「国家开发银行广西分行2027校园招聘」「中国石油集团安全环保技术研究院有限公司2027年校园招聘」），
 * 而公司名里常含技术词 —— 「国家**开发**银行」会被 `NON_LEGAL_KW` 的「开发」命中，
 * 判成「非法律类技术岗」拿 4 分（实测把国开行广西分行压到 52 分）。
 * 先把公司名剔出去，剩下的才是真正的岗位描述。
 */
export function roleText(company: string, title: string, detail: string): { text: string; hadCompany: boolean } {
  const c = String(company || '').trim();
  let t = String(title || '');
  const hadCompany = !!c && t.includes(c);
  if (hadCompany) t = t.split(c).join(' ');
  return { text: `${t} ${detail}`.trim(), hadCompany };
}

function roleScore(company: string, title: string, detail: string): RoleResult {
  const { text: ctx } = roleText(company, title, detail);
  if (!ctx.trim()) return { score: W.role.broad, reason: '岗位未指明' };

  /* 法务 / 合规 / 风控 / 知产 / 审计 —— 用户的核心方向，复用准入规则里的同一套关键词 */
  if (hasLegalRole(ctx, '')) return { score: W.role.legal, reason: '法律 / 合规岗' };
  if (MGMT_KW.test(ctx)) return { score: W.role.mgmt, reason: '管培 / 菁英序列' };
  if (FIN_ROLE_KW.test(ctx)) return { score: W.role.fin, reason: '金融 / 财务类岗' };
  /* 明确的技术 / 销售类岗：进了库也是噪音，给低分但不拒 */
  if (NON_LEGAL_KW.test(ctx)) return { score: W.role.nonLegal, reason: '非法律类技术 / 业务岗' };
  if (BROAD_POSTING.test(ctx)) return { score: W.role.broad, reason: '泛招公告（未指明岗位）' };
  return { score: W.role.broad, reason: '岗位未指明' };
}

/* ================= 维度三：地域（满分 12） ================= */

/** 地域**只加分不扣分**。接口没有工作地点字段，「没写」不等于「不在北京」。 */
export function regionScore(text: string): number {
  const hits = detectTargetRegions(text);
  if (hits.includes('北京')) return W.region.beijing;
  if (hits.includes('上海') || hits.includes('深圳')) return W.region.shanghaiShenzhen;
  if (hits.length) return W.region.otherTarget;
  return W.region.unknown;
}

/* ================= 维度四：门槛匹配（满分 12） ================= */

export function eligScore(title: string, detail: string): number {
  const ctx = `${title} ${detail}`;
  let s: number = W.elig.base; // 面向 2027 届是本项目的数据前提
  if (/法学|法律|不限专业|专业不限/.test(ctx)) s += W.elig.legalFriendly;
  if (/博士/.test(ctx)) s += W.elig.penaltyPhd;                    // 用户不是博士档
  if (/工作经验|社会招聘|社招|三年以上|五年以上|年以上经验/.test(ctx)) s += W.elig.penaltySocialHire;
  if (/实习|兼职/.test(ctx)) s += W.elig.penaltyIntern;
  return clamp(s, 0, W.elig.max);
}

/* ================= 时间紧迫度（不进分数，单独成标记） ================= */

export interface Urgency { days: number | null; label: string; hot: boolean }

/**
 * 截止日 → 天数与文案。
 * **紧迫度不进价值分** —— 明天截止的杂岗不会因为「急」而变得有价值。
 * 它只用于提醒分级（见 `isImportant`）。
 */
export function urgencyOf(deadline?: string, now: Date = new Date()): Urgency {
  const m = String(deadline || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { days: null, label: '未注明截止', hot: false };
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (days < 0) return { days, label: '已截止', hot: false };
  if (days === 0) return { days, label: '今日截止', hot: true };
  if (days <= 3) return { days, label: `${days} 天内截止`, hot: true };
  if (days <= 7) return { days, label: '7 天内截止', hot: true };
  return { days, label: `剩 ${days} 天`, hot: false };
}

/* ================= 综合评分 ================= */

export interface ScoreInput {
  company: string;
  title?: string;
  detail?: string;
  deadline?: string;
  /** 时间基准，便于测试与回放固定「今天」 */
  now?: Date;
}

export interface ScoreResult {
  score: number;              // 0-100
  tier: ScoreTier;
  band: string;               // 'S · 必投'
  reasons: string[];          // 加分理由（给「为什么高」一个可核对的交代）
  flags: string[];            // 时间 / 门槛 / 形态标记
  advice: string;             // 一句话行动建议
  urgency: Urgency;
  parts: { org: number; role: number; region: number; elig: number };
}

export function scoreOpportunity(input: ScoreInput): ScoreResult {
  const company = String(input.company || '').trim();
  const title = String(input.title || '');
  const detail = String(input.detail || '');
  const now = input.now || new Date();

  const org = orgScore(company, title, detail);
  const role = roleScore(company, title, detail);
  const region = regionScore(`${company} ${title} ${detail}`);
  const elig = eligScore(title, detail);

  const score = clamp(org.score + role.score + region + elig, 0, 100);
  const tier = tierOf(score);
  const urgency = urgencyOf(input.deadline, now);

  const reasons: string[] = [];
  if (org.reason) reasons.push(org.reason);
  if (role.reason) reasons.push(role.reason);

  const flags: string[] = [];
  if (urgency.hot) flags.push(`⏰ ${urgency.label}`);
  const ctx = `${title} ${detail}`;
  if (/限报\s*\d+\s*岗|最多报\s*\d+\s*岗|每人.{0,4}\d+\s*岗/.test(ctx)) flags.push('🔒 限报岗位数');
  if (/法律职业资格|司考|法考|A\s*证/.test(ctx)) flags.push('📜 需法考证');
  if (/硕士|研究生/.test(ctx)) flags.push('🎓 硕士起');
  if (/实习|兼职/.test(ctx)) flags.push('🧩 实习 / 兼职');

  const advice =
    tier === 'S'
      ? (urgency.hot ? `⏰ ${urgency.label}，立即投递` : '核心目标，优先投递')
      : tier === 'A'
        ? (urgency.hot ? `⏰ ${urgency.label}，本周内投递` : '列入重点，近期投递')
        : tier === 'B'
          ? '可投，排在 S / A 之后'
          : '低优先，留档备查';

  return {
    score, tier, band: TIER_META[tier].label, reasons, flags, advice, urgency,
    parts: { org: org.score, role: role.score, region, elig },
  };
}

/**
 * 算不算「重要岗位」—— 决定要不要做明显提示。
 *   · 分数 ≥ 78                → 是（准 S 档；公共源里约前 1%）
 *   · 分数 ≥ 65 且 7 天内截止   → 是（够好 + 快来不及了）
 * 其余不打扰。
 *
 * ⚠️ 调用方**必须作用在「本次新增」上**，不要拿整库去筛 ——
 * 整库里 68 条过线是正常的归档密度，逐条推送会立刻被无视。
 */
export function isImportant(res: ScoreResult): boolean {
  if (res.score >= ALERT_MIN_SCORE) return true;
  if (res.score >= TIER_META.A.min && res.urgency.days !== null
      && res.urgency.days >= 0 && res.urgency.days <= 7) return true;
  return false;
}

/* ================= 汇总（给导入结果提示用） ================= */

export interface ScoredRow extends ScoreResult {
  company: string;
  title: string;
  deadline?: string;
}

export function summarizeTiers(rows: ScoredRow[]): {
  total: number; counts: Record<ScoreTier, number>; important: ScoredRow[]; text: string;
} {
  const counts: Record<ScoreTier, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (const r of rows) counts[r.tier]++;
  const important = rows.filter(isImportant)
    .sort((a, b) => b.score - a.score || (a.urgency.days ?? 999) - (b.urgency.days ?? 999));
  const text = TIER_ORDER.filter((t) => counts[t]).map((t) => `${TIER_META[t].label} ${counts[t]}`).join(' · ');
  return { total: rows.length, counts, important, text };
}
