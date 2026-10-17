/**
 * 题库分类（赛道）元数据 —— 分类 → 题库 → 题组/单题 这条主线的唯一事实来源。
 *
 * 为什么把「分类」提成一级：老版本只有 company | industry 两种库类型且只有一层，
 * 岗位方向一多（银行 / 国央企 / 考公 / 券商基金…）就全平铺在一栏里，题也就散成一片。
 * 分类是**稳定的粗粒度容器**，题库才是用户自己长出来的东西。
 * v7 起界面上是三级卡片墙，`ALL_SCOPE` 只留给 AI agent 的跨分类视角用。
 */
import type { BankCategory, QuestionBank, Question } from '../types';

/** 预置分类。id 固定，迁移与推断都以它为准 */
export const PRESET_CATEGORIES: { id: string; name: string; order: number }[] = [
  { id: 'cat-civil', name: '考公选调', order: 10 },
  { id: 'cat-bank', name: '银行', order: 20 },
  { id: 'cat-soe', name: '国央企', order: 30 },
  { id: 'cat-securities', name: '券商基金', order: 40 },
  { id: 'cat-fi', name: '交易所·金融基础设施', order: 50 },
  { id: 'cat-tech', name: '互联网科技', order: 60 },
  { id: 'cat-other', name: '其他', order: 999 },
];

/** 兜底分类 id：推断不出来一律落这里，绝不猜归属 */
export const FALLBACK_CAT_ID = 'cat-other';

/** 全部题目视图（不使用任何分类哨兵值，避免与真实分类 id 撞车） */
export const ALL_SCOPE = '__all__';

export function defaultCategories(): BankCategory[] {
  return PRESET_CATEGORIES.map((c) => ({ ...c, presets: true, createdAt: '' }));
}

/** 关键词规则。**顺序即优先级**：先命中先归属 */
const RULES: { id: string; re: RegExp }[] = [
  { id: 'cat-civil', re: /公务员|选调|省考|国考|事业编|事业单位|遴选|三支一扶|村官|军队文职|公安|警察|法院|检察院|仲裁委|仲裁|司法局|人社|组织部门/ },
  { id: 'cat-bank', re: /银行|农商|农信|信用社|银保监|中国人民银行|人行|工行|建行|农行|中行|交行|邮储|招商|兴业|浦发|中信|光大|民生|华夏|广发|浙商|渤海|恒丰|上海银行|北京银行|江苏银行|宁波银行|南京银行|杭州银行/ },
  { id: 'cat-securities', re: /证券|基金|券商|投行|资管|公募|私募|期货|中金|华泰|国泰|海通|银河|申万|东方财富|易方达|华夏基金|嘉实|南方基金|广发证券|招商证券/ },
  { id: 'cat-fi', re: /交易所|结算|清算|中证登|中债|银登|外汇交易中心|金融基础设施|期货交易所|登记结算/ },
  { id: 'cat-tech', re: /互联网|科技|字节|腾讯|阿里|百度|美团|京东|拼多多|华为|小米|网易|滴滴|快手|哔哩|滴滴出行|蚂蚁|大疆|联想|中兴/ },
  { id: 'cat-soe', re: /集团|中核|中石油|中石化|中海油|中化|国家电网|南方电网|中电|中船|中航|航天|兵器|中粮|招商局|华润|保利|中建|中铁|中交|中车|中国|国网|烟草|能源|电力|核工业|城投|国资|电科|电子科技|联通|移动|电信/ },
];

/** 按名称/备注推断分类 id；推断不出返回 undefined，由调用方决定兜底 */
export function inferCategoryId(...texts: (string | undefined | null)[]): string | undefined {
  const s = texts.filter(Boolean).join(' ');
  if (!s.trim()) return undefined;
  for (const r of RULES) if (r.re.test(s)) return r.id;
  return undefined;
}

/** 兜底 + 推断：给一个名字定分类 */
export function inferCategoryIdOrFallback(...texts: (string | undefined | null)[]): string {
  return inferCategoryId(...texts) || FALLBACK_CAT_ID;
}

/**
 * 一道题实际属于哪个分类：**以所属仓库为准**，没有仓库才看题目自己的 catId。
 * 仓库是外层容器，这个口径必须全局一致，否则「分类题数」会对不上列表。
 */
export function questionCatId(q: Question, banks: QuestionBank[]): string {
  if (q.bankId) {
    const b = banks.find((x) => x.id === q.bankId);
    if (b) return b.catId || FALLBACK_CAT_ID;
  }
  return q.catId || FALLBACK_CAT_ID;
}

/** 各分类排序后的展示序列（过滤掉不存在的分类 id） */
export function sortCategories(cats: BankCategory[]): BankCategory[] {
  return [...cats].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}
