/**
 * 追踪准入规则 —— 准入口径（要不要收）
 * ==================================================================
 * ⚠️ 本机存在**两份**同名副本，改一边必须同步另一边（2026-09-28 定）：
 *    权威：`~/Desktop/图鲲/resumeself-opensource/src/lib/`
 *          ← 线上站（resumeself.vercel.app）源码；qz-tracker 的 `lib/qz-rules.mjs` 从这里打包
 *    副本：`~/Documents/QoderCN/2026-09-05/chat-1/qiuzhao-assistant/src/lib/`
 *          ← 另一个 App 分叉自带一份（它不能跨仓库 import TypeScript）
 *    两份不一致时，权威侧 `npm run check:rules` 会告警（daily.sh 阶段 0 每天跑一次）。
 *
 * 本文件回答一个问题：**这条岗位要不要进我的追踪库？**
 *
 * 规则来自用户 2026-09-28 的三条口径：
 *   1. 律师事务所不要（含涉外所 / 外资所）
 *   2. 地方国企与平台：只追踪 **北京 / 上海 / 深圳 / 浙江 / 江苏 / 广东**，
 *      其他地区的地方国企一律不要
 *   3. 民营企业：只收**大厂与优质科创公司**，且必须有**法律类岗位**
 *
 * ── 设计原则：**只有拿到阳性证据才拒** ────────────────────────
 * 第一版是「无法证明它不是民营 → 按民营处理」，实测**灾难性过杀**：
 *   · `工行总行本部`、`银河资产`、`中投公司`、`中证信用`、`中证中小投资者服务中心`
 *     因为名字里没有「银行 / 资产管理」等词，被判成「非大厂民营」而被拒；
 *   · 24 条**北大宣讲专场**（来校单位）因为宣讲标题里没有「法务」二字被整批拒掉。
 * 现行版本反转为**证据驱动**：
 *   · 律所 —— 名字里出现律所特征词，**阳性**，拒；
 *   · 地方国企 —— 必须**点名了非目标省份/城市**（如「陕西省国资委」），才拒；
 *     判不出地域的一律放行（宁可多留，不可静默丢）；
 *   · 民营 —— 必须**能确证是民营**（命中大厂/科创名单，或名称是「XX有限公司」
 *     且不带任何国资/金融/基础设施/仲裁/公职特征）才施加门槛。
 *
 * ── 边界（刻意留白的部分，别擅自扩大）──────────────────────────
 * · **涉外只排到「涉外律所 / 外资所」为止。** 涉外仲裁机构（贸仲 / 北仲 /
 *   上仲 / SCIA / 港仲）是**保留**的；外企法务、央企涉外岗也不在排除范围。
 * · **央企、中央金融企业、金融基础设施、仲裁机构不受地域限制。** 它们总部多在
 *   北京上海，本身就在目标地域内；国网各省分公司、中国移动各省这类岗位照收。
 *   地域规则**只**作用于地方国企与平台。
 *
 * ⚠️ **数据源没有「工作地点」字段。** 北大就业网接口只给 venue / 截止日 / 专业 /
 * 学历，不给城市。所以地域判定只能靠**单位名与岗位文本**里的地区线索。
 * ==================================================================
 */
import type { JobTrack } from '../types';

/* ================= 一、目标地域 ================= */

/** 目标地域及其别名。**只用多字别名** —— 单字如「京 / 深 / 苏」会误伤（东京、深化） */
export const TARGET_REGIONS: { key: string; label: string; aliases: string[] }[] = [
  { key: 'beijing', label: '北京', aliases: ['北京', '中关村', '海淀', '朝阳区', '西城区', '东城区', '丰台', '昌平', '顺义', '大兴', '通州', '亦庄'] },
  { key: 'shanghai', label: '上海', aliases: ['上海', '浦东', '陆家嘴', '张江', '静安', '黄浦', '徐汇', '虹桥', '临港新片区'] },
  { key: 'shenzhen', label: '深圳', aliases: ['深圳', '前海', '南山', '福田', '罗湖', '宝安', '龙岗', '龙华'] },
  { key: 'zhejiang', label: '浙江', aliases: ['浙江', '杭州', '宁波', '温州', '嘉兴', '绍兴', '金华', '台州', '湖州', '义乌', '舟山', '衢州', '丽水'] },
  { key: 'jiangsu', label: '江苏', aliases: ['江苏', '南京', '苏州', '无锡', '常州', '南通', '徐州', '扬州', '镇江', '泰州', '盐城', '昆山', '江阴'] },
  { key: 'guangdong', label: '广东', aliases: ['广东', '广州', '珠海', '东莞', '佛山', '中山', '惠州', '江门', '肇庆', '横琴'] },
];

export const TARGET_REGION_LABEL = '北京 / 上海 / 深圳 / 浙江 / 江苏 / 广东';

export function detectTargetRegions(text: string): string[] {
  const s = String(text || '');
  return TARGET_REGIONS.filter((r) => r.aliases.some((a) => s.includes(a))).map((r) => r.label);
}

export function inTargetRegion(text: string): boolean {
  return detectTargetRegions(text).length > 0;
}

/* ================= 二、律师事务所（全排） ================= */

const LAW_FIRM_KW = ['律师事务所', '律所', '法律事务所', '律师行', 'law firm', 'llp'];

/**
 * 外资所**品牌名** —— 命中即足以证明是律所。
 * 与 `FOREIGN_LAW_HINT` 拆开是必须的：`外资`/`涉外` 这类词只是描述性定语
 * （「某外资企业法务岗」），单独命中不能判成律所，否则会把外企法务整批误杀。
 * 但品牌名本身就是律所的名字 —— `Baker McKenzie`「年利达」没有中文「律师事务所」后缀，
 * 只靠 `LAW_FIRM_KW` 会整个漏过去（回归测试实测）。
 */
const FOREIGN_LAW_BRAND = [
  'baker', 'linklaters', 'freshfields', 'clifford chance', 'allen & overy', 'herbert smith', 'slaughter',
  '年利达', '高伟绅', '富而德', '司力达', '安理国际', '史密夫斐尔', '贝克·麦坚时', '伟凯', '欧华', '瑞生',
  '达维', '霍金路伟', '凯易', '普衡', '世达', '美富', '盛德', '众达',
];
/** 仅作排除**原因**的定语，不参与「是不是律所」的判定 */
const FOREIGN_LAW_HINT = ['外资', '涉外', '国际律师', '外国律师'];

export function isLawFirm(company: string, title = ''): boolean {
  const s = `${company} ${title}`.toLowerCase();
  if (LAW_FIRM_KW.some((k) => s.includes(k))) return true;
  return FOREIGN_LAW_BRAND.some((k) => s.includes(k));
}

export function isForeignLawFirm(company: string, title = ''): boolean {
  if (!isLawFirm(company, title)) return false;
  const s = `${company} ${title}`.toLowerCase();
  return FOREIGN_LAW_HINT.some((k) => s.includes(k)) || FOREIGN_LAW_BRAND.some((k) => s.includes(k));
}

/* ================= 三、地方国企与平台 ================= */

/** 央企特征：以「中国 / 中央 / 国家 / 全国 / 中华」开头 —— 这类不受地域限制 */
const CENTRAL_PREFIX = /^(中国|中央|国家|全国|中华|国务院|中央金融)/;

/** 很多央企不以「中国」开头，必须单独列，否则会被当成民营 */
const CENTRAL_HINT_KW = [
  '中核', '中石油', '中石化', '中海油', '中粮', '中建', '中铁', '中车', '中船', '中远', '中化',
  '中广核', '中电科', '中电', '中航', '中兵', '中储', '中信', '招商局', '保利', '国投', '国新',
  '华能', '大唐', '华电', '三峡', '南方电网', '国家能源', '国家电投', '国网', '国铁',
  '中国移动', '中国联通', '中国电信', '中国邮政', '中国融通', '中国五矿', '中国铝业', '中国黄金',
  '中国华电', '中国大唐', '中国国新', '中国有色', '中国信保', '中国人寿', '中国人民保险',
  '中国太平', '中国出口信用', '中国电子', '中国商飞', '中国建材', '中国中车', '烟草',
  /* 2026-09-28 回放补漏：这些央企不以「中国」开头，漏了会被评分当成「其他机构」而降档。
     只收**无歧义**的写法 —— 「银河」不能裸加，否则「银河航天」（民营商业航天）会被误判成央企。 */
  '中投', '中国银河', '银河资产', '航空工业', '南网', '国机', '哈电', '东方电气',
  '鞍钢', '首钢', '国家管网', '中国铁塔', '中储粮',
  /* 2026-09-28 第二次回放补漏：央企**子公司常用简称**，名字里既没有「中国」也没有母集团全称。
     漏掉的后果不是「少收一条」，而是被 `isConfirmedPrivate` 的
     「名称带『有限公司』即视为民营」兜底判成民营，再被「非大厂」拒掉 —— 恰好把用户
     最想要的**央企岗位**丢掉。以下均为无歧义写法，只收有把握的。 */
  '东风汽车', '中移', '中材', '中能建', '卓望', '国睿', '四川航天',
];

/**
 * 北京市属国企 —— 名字里没有「国资 / 城投 / 交投」这类通用特征词，靠 `LOCAL_SOE_KW` 与
 * `LOCAL_SOE_COMBO` 都识别不出来，必须点名。
 *
 * 不点名的后果（实测）：`北京汽车集团有限公司` 会走到 `isConfirmedPrivate` 的兜底
 * 「带『有限公司』即民营」→ 被判「非大厂民营」→ 拒掉。而北京**正是目标地域**，
 * 国企也不该受「大厂」门槛约束 —— 这是纯粹的误杀。
 * 归入地方国企而不是央企，是因为两者在评分上不是一回事，不能为了「先放进来」而标错身份。
 */
const MUNICIPAL_SOE_KW = [
  '北京汽车集团', '北汽集团', '北京建工', '北京能源集团', '京能集团',
  '首都创业', '首创集团', '京仪集团',
];

/** 地方国企/平台的强特征词 */
const LOCAL_SOE_KW = [
  '国有资产', '国有资本', '国资运营', '地方国资', '国资', '城投', '交投', '水投', '产投', '城发',
  '城建投资', '公用事业', '水务集团', '文旅集团', '交通投资', '产业投资', '投资控股', '控股集团',
  '发展集团', '金融控股', '国有投资', '市政集团', '地铁集团', '轨道集团', '港口集团', '人才发展', '安居集团',
];

/** 「省市行政区划 + 国企类词」的组合特征 */
const LOCAL_SOE_COMBO = /(省|市|自治区|区|县)[^，。]{0,6}(国有|国资|投资|发展|控股|建设|交通|能源|文旅|水务|资本|资产|产业|科技|人才|传媒|环保|农业|公用|地铁|轨道|港口|机场)/;

/** 「目标地域城市名 + 强国企词」—— 覆盖名字里没有「市」字的（如南京扬子国资投资集团） */
const LOCAL_SOE_STRONG = /(国资|国有|城投|交投|水投|产投|公用事业|市政|国有资本|投资控股|城市建设投资|发展投资)/;

/** 非目标地域的行政区划名 —— **阳性外地证据**，只有命中它才判「在外地」 */
const OTHER_REGION_KW = [
  '天津', '重庆', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广西', '海南', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海',
  '宁夏', '新疆', '郑州', '武汉', '长沙', '成都', '西安', '合肥', '济南', '青岛', '大连', '沈阳',
  '哈尔滨', '长春', '石家庄', '太原', '南昌', '福州', '厦门', '南宁', '昆明', '贵阳', '兰州', '银川',
  '西宁', '乌鲁木齐', '呼和浩特', '拉萨', '烟台', '南通',
];

export function isLocalSoe(company: string): boolean {
  const c = String(company || '').trim();
  if (!c) return false;
  if (CENTRAL_PREFIX.test(c)) return false;                       // 央企前缀：明确不是地方国企
  if (MUNICIPAL_SOE_KW.some((k) => c.includes(k))) return true;   // 市属国企：无通用特征词，只能点名
  if (LOCAL_SOE_KW.some((k) => c.includes(k))) return true;
  if (LOCAL_SOE_COMBO.test(c)) return true;
  if (inTargetRegion(c) && LOCAL_SOE_STRONG.test(c)) return true;   // 名字里没有「市」字的地方平台
  if (OTHER_REGION_KW.some((k) => c.includes(k))
      && /(集团|投资|控股|发展|国资|资产|资本|建设|开发|产业)/.test(c)) return true;
  return false;
}

/** 单位名里有没有「明确的非目标地域」证据。**这是拒绝地方国企的唯一依据** */
export function hasForeignRegionEvidence(company: string): boolean {
  return OTHER_REGION_KW.some((k) => String(company || '').includes(k));
}

/* ================= 四、机构性质 ================= */

/** 金融机构（含常用简称） */
const FINANCE_ORG = /(银行|工行|建行|农行|中行|交行|邮储|工银|建银|农银|中银|证券|保险|人寿|人保|太保|太平|信托|基金|资产管理|金融资产|信达|长城资产|华融|东方资产|金控|理财|消费金融|财务公司|投行|高盛|摩根|汇丰|花旗|瑞银|野村|巴克莱|渣打)/;
/** 金融基础设施 / 交易场所 */
const INFRA_ORG = /(交易所|登记结算|中央结算|中债登|中证登|中国结算|中证|清算|银联|网联|票交所|CIPS|银行间市场|期货|中金所|上期所|郑商所|大商所|广期所|港交所|外汇交易中心)/;
/** 仲裁与争议解决机构 */
const ARBITRATION_ORG = /(仲裁委|仲裁委员会|仲裁院|仲裁|公证处|争议解决)/;
/** 公职 / 事业单位 / 军队 */
const CIVIL_ORG = /(组织部|选调|国考|省考|遴选|公务员|党校|人民政府|管理局|事业单位|检察院|法院|纪检监察|部队|军官|直招士官|人才服务中心)/;

/** 「XX有限公司 / 股份有限公司」—— 民营主体的典型形态 */
const LTD_SUFFIX = /(有限公司|股份有限公司|有限责任公司)/;

/* ---------- 机构性质谓词（导出）----------
 * 这几条正则原本只服务于 `isLikelyNonPrivate`（是不是民营）这一问。
 * `lib/scoreRules.ts`（价值评分）需要**同一套**机构性质判定来定「机构梯队」，
 * 所以在这里导出谓词，而不是在评分文件里重抄一遍正则 —— 口径只能有一处，
 * 否则改了一边忘了另一边，两套判断会悄悄分叉。
 */
/** 金融机构（含简称）：银行 / 证券 / 保险 / AMC / 金控 / 外资行 */
export const isFinanceOrg = (s: string): boolean => FINANCE_ORG.test(String(s || ''));
/** 金融基础设施 / 交易场所：登记结算 / 交易所 / 清算 / 支付清算 */
export const isInfraOrg = (s: string): boolean => INFRA_ORG.test(String(s || ''));
/** 仲裁与争议解决机构（含涉外仲裁 —— 贸仲/北仲/上仲/SCIA 是**保留**项，不是排除项） */
export const isArbitrationOrg = (s: string): boolean => ARBITRATION_ORG.test(String(s || ''));
/** 公职 / 事业单位 / 军队 */
export const isCivilOrg = (s: string): boolean => CIVIL_ORG.test(String(s || ''));

/** 是不是**中央**企业 —— 「中国/中央/国家」开头，或命中央企简称名单 */
export function isCentralSoe(company: string): boolean {
  const c = String(company || '').trim();
  if (!c) return false;
  return CENTRAL_PREFIX.test(c) || CENTRAL_HINT_KW.some((k) => c.includes(k));
}

/** 「总行 / 总部 / 本部」类后缀 —— 用来区分集团总部与分支机构 */
export const HQ_SUFFIX = /(总行|总部|本部|集团总部|总公司)/;
/** 「分行 / 分公司 / 省分行 / 市分行」类后缀 */
export const BRANCH_SUFFIX = /(分行|分公司|省分行|市分行|支行|营业部|办事处)/;

/** 能确证**不是**民营的机构（国资 / 金融 / 基础设施 / 仲裁 / 公职） */
export function isLikelyNonPrivate(company: string): boolean {
  const c = String(company || '').trim();
  if (!c) return true;                                   // 无名单位不进入民营门槛
  if (CENTRAL_PREFIX.test(c)) return true;
  if (CENTRAL_HINT_KW.some((k) => c.includes(k))) return true;
  if (MUNICIPAL_SOE_KW.some((k) => c.includes(k))) return true;
  if (isLocalSoe(c)) return true;
  if (FINANCE_ORG.test(c)) return true;
  if (INFRA_ORG.test(c)) return true;
  if (ARBITRATION_ORG.test(c)) return true;
  if (CIVIL_ORG.test(c)) return true;
  return false;
}

/* ================= 五、民营：大厂与优质科创 ================= */

/**
 * 平台型大厂（判定标准的锚点）。**不要求逐家穷举**，命中任一即算大厂。
 * 标准集中在这里，增删只改这一处。
 */
const BIGTECH_KW = [
  /* 「抖音」是 2026-09-28 回放补的：北大就业网上字节跳动的发布主体写的是
     「北京抖音信息服务有限公司」，名字里既没有「字节」也没有「跳动」，
     于是同一家公司在「字节跳动」写法下放行、在注册名写法下被判「非大厂民营」拒掉。
     判定结果随**注册名 vs 通称**漂移，和行文漂移一样不可接受。 */
  '字节', '跳动', '抖音', '腾讯', '阿里', '蚂蚁', '百度', '京东', '美团', '网易', '小米', '华为',
  '快手', '滴滴', '拼多多', '哔哩哔哩', 'bilibili', '小红书', '携程', '去哪儿', '唯品会',
  '得物', '知乎', '微博', '新浪', '搜狐', '360', '奇虎', '58同城', 'boss直聘', '饿了么',
  '菜鸟', '盒马', 'oppo', 'vivo', '荣耀', '联想', '大疆', '旷视', '商汤', '科大讯飞',
  '海康威视', '大华', '金山', '用友', '金蝶', '涂鸦', '蔚来', '理想汽车', '小鹏', '比亚迪',
  '宁德时代', '隆基', '迈瑞', '药明', '中芯国际', '寒武纪', '地平线', '摩尔线程', '壁仞',
];

/** 优质科创的**行业**特征词 —— 与实体主体词组合判定，避免「XX科技咨询」被误判 */
const DEEPTECH_KW = [
  '半导体', '芯片', '集成电路', '人工智能', '大模型', '机器人', '自动驾驶', '智能驾驶',
  '新能源', '储能', '锂电', '光伏', '生物医药', '生物科技', '创新药', '医疗器械',
  '智能制造', '商业航天', '卫星', '无人机', '量子', '区块链', '云计算', '操作系统', '数据库',
  /* 2026-09-28 回放补漏：实测有行业词但第一版没覆盖的硬科技方向 */
  '雷达', '光电', '传感器', '服务器', '数据中心', '工业软件', '仪器仪表', '氢能', '合成生物', '低空经济', '光刻',
];

/** 可信主体词：说明是实体企业而非中介/服务商 */
const REAL_ENTITY_KW = ['集团', '科技', '技术', '智能', '电子', '信息', '网络', '软件', '硬件', '股份', '有限公司'];

/**
 * 硬科技龙头**白名单** —— 命中即认定「优质科创」，不再看行文里有没有行业词。
 *
 * 为什么必须有它：`isTopTierPrivate` 的行业判定依赖「单位名或岗位文本里出现行业词」，
 * 而同一家公司在不同批次的行文差别很大 ——
 * 北大宣讲表里写「北大宣讲 · 2027 校招；方向：半导体装备研发」能过，
 * 但若某期只写「北大宣讲 · 2027 校招」，**同一家公司就会被判成「非大厂民营」而拒掉**。
 * 判定结果随行文漂移是绝对不可接受的，白名单把它钉死。
 *
 * 收录范围：用户点名的标的 + 公认的硬科技龙头。**宁缺毋滥**——只收没有争议的。
 */
const TECH_WHITELIST = [
  '北方华创', '睿创微纳', '寒武纪', '中芯国际', '长江存储', '长鑫存储', '华虹', '士兰微',
  '兆易创新', '韦尔股份', '中微公司', '拓荆科技', '盛美上海', '澜起科技', '海光信息',
  '地平线', '黑芝麻智能', '禾赛', '速腾聚创', '大疆', '迈瑞', '联影', '药明康德',
  '百济神州', '恒瑞医药', '隆基绿能', '阳光电源', '宁德时代', '比亚迪', '蔚来', '小鹏',
  '理想汽车', '商汤', '旷视', '云从', '依图', '科大讯飞', '海康威视', '大华股份',
  '中控技术', '汇川技术', '先导智能', '杭可科技', '天合光能', '晶澳科技', '亿纬锂能',
];

/** 是不是公认的硬科技龙头（评分与准入共用，避免两处名单分叉） */
export function isNotableTech(company: string): boolean {
  return TECH_WHITELIST.some((k) => String(company || '').includes(k));
}

/** 民营噪音：人力/外包/招聘/中介/教育 —— 不是「大厂或科创」 */
const PRIVATE_NOISE_KW = [
  '人力资源', '劳务派遣', '劳务', '外包', '招聘', '人才服务', '人力服务', '猎头', '职业介绍',
  '教育培训', '教育科技', '培训中心', '餐饮', '酒店', '房地产经纪', '物业管理', '中介',
  '咨询有限公司', '管理咨询', '图文', '广告传媒', '文化传播',
];

/** 明确指向「非法务」的岗位词 —— 大厂/科创的这类岗才拒绝 */
const NON_LEGAL_ROLE_KW = [
  '工程师', '开发', '研发', '算法', '设计', '运营', '销售', '市场', '产品经理', '产品岗',
  '财务', '会计', '人力', '行政', '分析师', 'analyst', 'quant', '教师', '编辑', '客服', '医护',
];

/**
 * 宣讲 / 双选 / 组团等**活动类**条目。
 * 这类标题描述的是「有单位来校」而非某个具体岗位（如「北大宣讲 · 2027 届校园招聘（研发/产品/职能）」），
 * 用岗位词去判它「不是法律岗」等于拿不存在的信息做决定，会把整批来校单位误拒。
 */
const EVENT_LIKE = /(宣讲会|宣讲|双选会|招聘会|组团|引才专场|专场活动|开放日|空中宣讲|进校招聘)/;

export function isNoiseCompany(company: string): boolean {
  return PRIVATE_NOISE_KW.some((k) => String(company || '').includes(k));
}

/**
 * 大厂 or 优质科创 —— 判机构，但**行业词同时看单位名与岗位描述**。
 * 只认单位名会漏掉名字里不写行业词的优质标的，实测两例：
 *   ·「北京北方华创微电子装备有限公司」—— 半导体设备龙头（002371），名字里没有「半导体」
 *   ·「烟台睿创微纳技术股份有限公司」—— 红外芯片（688002），行业词只在岗位方向里
 */
export function isTopTierPrivate(company: string, title = ''): boolean {
  const c = String(company || '');
  if (!c) return false;
  if (isNoiseCompany(c)) return false;
  if (isNotableTech(c)) return true;                                            // 标准①：硬科技龙头白名单
  if (BIGTECH_KW.some((k) => c.includes(k))) return true;                       // 标准②：平台型大厂
  const ctx = `${c} ${title}`;
  if (DEEPTECH_KW.some((k) => ctx.includes(k))
      && REAL_ENTITY_KW.some((k) => c.includes(k))) return true;                // 标准③：硬科技行业 + 实体
  return false;
}

/**
 * **能不能确证它是民营。**
 * 只有确证为民营，才施加「大厂/优质科创 + 法律岗」门槛。
 * 判不出来（如「工行总行本部」「银河资产」「中投公司」）→ 返回 false → 直接放行。
 */
export function isConfirmedPrivate(company: string): boolean {
  const c = String(company || '').trim();
  if (!c) return false;
  if (BIGTECH_KW.some((k) => c.includes(k))) return true;        // 大厂名单本身就是民营的强证据
  if (isLikelyNonPrivate(c)) return false;                       // 有国资/金融/基础设施等特征 → 不是民营
  return LTD_SUFFIX.test(c);                                     // 「XX有限公司」且无上述特征 → 视为民营
}

/* ================= 六、法律类岗位 ================= */

const LEGAL_ROLE_KW = [
  '法务', '合规', '法律', '法学', '知识产权', '知产', '风控', '内控',
  '公司律师', '法律顾问', '企业法律', '纪检', '监察', '审计', '法律事务',
];

export function hasLegalRole(title: string, detail = ''): boolean {
  return LEGAL_ROLE_KW.some((k) => `${title} ${detail}`.includes(k));
}

/* ================= 七、准入判定 ================= */

export type RejectReason =
  | 'law-firm'
  | 'local-soe-outside-region'
  | 'private-not-top-tier'
  | 'private-no-legal-role'
  | 'private-noise';

export const REJECT_LABEL: Record<RejectReason, string> = {
  'law-firm': '律师事务所（含涉外 / 外资所）',
  'local-soe-outside-region': `地方国企但明确在目标地域外（只收 ${TARGET_REGION_LABEL}）`,
  'private-not-top-tier': '民营企业但非大厂 / 优质科创',
  'private-no-legal-role': '民营企业但明确不是法律类岗位',
  'private-noise': '人力 / 外包 / 招聘 / 教育等中介机构',
};

export interface AdmissionInput {
  company: string;
  title?: string;
  detail?: string;
  /** 已推断出的求职板块。仅用于日志，不再作为判定依据（见文件头「设计原则」） */
  track?: JobTrack;
}

export interface AdmissionResult {
  allowed: boolean;
  reason?: RejectReason;
  /** 人话原因，直接给 UI 显示 */
  label?: string;
}

/**
 * 判定一条岗位能否进追踪库。
 * 顺序：律所 → 地方国企（阳性外地证据）→ 民营（确证为民营才设门槛）。
 * **每一道拒绝都必须有阳性证据**，判不出来一律放行。
 */
export function checkAdmission(input: AdmissionInput): AdmissionResult {
  const company = String(input.company || '').trim();
  const title = String(input.title || '');
  const detail = String(input.detail || '');
  if (!company) return { allowed: true };

  /* ① 律所一律排除（涉外 / 外资所只影响文案） */
  if (isLawFirm(company, title)) {
    return {
      allowed: false,
      reason: 'law-firm',
      label: isForeignLawFirm(company, title) ? '涉外 / 外资律师事务所' : REJECT_LABEL['law-firm'],
    };
  }

  /* ② 地方国企 / 平台：**必须点名了非目标地域**才拒。
        「郑州国资运营集团」「陕西省国资委」会命中；判不出地域的放行。 */
  if (isLocalSoe(company) && hasForeignRegionEvidence(company) && !inTargetRegion(company)) {
    return {
      allowed: false,
      reason: 'local-soe-outside-region',
      label: `${company} —— 地方国企且在目标地域外`,
    };
  }

  /* ③ 民营：确证为民营才设门槛。判不出的（工行总行本部 / 银河资产 / 中投公司…）直接放行。 */
  if (isConfirmedPrivate(company)) {
    if (isNoiseCompany(company)) {
      return { allowed: false, reason: 'private-noise', label: REJECT_LABEL['private-noise'] };
    }
    if (!isTopTierPrivate(company, title)) {
      return { allowed: false, reason: 'private-not-top-tier', label: `${company} 未命中「大厂 / 优质科创」标准` };
    }
    /* 大厂/科创：只收法律岗。但「泛招公告」与「宣讲/活动」不判 —— 标题里没有岗位信息，
       判成「非法律岗」等于用不存在的信息做决定。 */
    const ctx = `${title} ${detail}`;
    if (EVENT_LIKE.test(ctx)) return { allowed: true };
    const looksLikeSpecificRole = NON_LEGAL_ROLE_KW.some((k) => ctx.toLowerCase().includes(k));
    if (looksLikeSpecificRole && !hasLegalRole(title, detail)) {
      return {
        allowed: false,
        reason: 'private-no-legal-role',
        label: `${company} —— 大厂/科创但该岗位明显不是法律类（${(title || '未注明').slice(0, 30)}）`,
      };
    }
  }

  return { allowed: true };
}

/* ================= 八、排除报告 ================= */

export interface RejectedRow { company: string; title: string; reason: RejectReason; label: string }

/** 汇总成人话，供导入结果提示。**不静默丢弃**是这套规则的前提 */
export function summarizeRejections(rows: RejectedRow[]): string {
  if (!rows.length) return '';
  const byReason = new Map<RejectReason, number>();
  for (const r of rows) byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1);
  return [...byReason.entries()].map(([k, n]) => `${REJECT_LABEL[k]} ${n} 条`).join('；');
}
