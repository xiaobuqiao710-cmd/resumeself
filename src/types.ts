// ---------- Form schema types (from 网申填写信息资料库.docx) ----------
export type FieldType =
  | 'text' | 'textarea' | 'number' | 'select' | 'radio'
  | 'date' | 'file' | 'fixed' | 'signature';

export interface FieldDef {
  key: string;
  name: string;
  type: FieldType;
  options?: string[];
  hint?: string;
  limit?: number;
  full?: boolean;      // render full-width
  placeholder?: string;
}

export interface SectionDef {
  id: string;
  title: string;
  icon: string;        // icon key
  multiple: boolean;   // can add multiple records
  desc?: string;
  fields: FieldDef[];
}

// A single record = { fieldKey: value }
export type Rec = Record<string, string>;
// Profile: single sections -> Rec ; multiple sections -> Rec[]
export interface ProfileData {
  single: Record<string, Rec>;
  multi: Record<string, Rec[]>;
}

// ---------- Applications ----------
export type AppStatus =
  | 'todo' | 'filling' | 'submitted' | 'test' | 'interview' | 'offer' | 'reject';

export interface TimelineEntry {
  status: AppStatus;
  at: string;        // ISO date
  note?: string;
}

export interface Application {
  id: string;
  company: string;
  position: string;
  status: AppStatus;
  channel?: string;       // 官网/内推/BOSS/猎聘...
  location?: string;
  deadline?: string;      // YYYY-MM-DD
  link?: string;
  salary?: string;
  notes?: string;
  contact?: string;       // HR / 内推人
  submittedAt?: string;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEntry[];
}

// ---------- Calendar events ----------
export type EventType = 'deadline' | 'interview' | 'test' | 'offer' | 'todo' | 'other';
export interface CalEvent {
  id: string;
  title: string;
  date: string;           // YYYY-MM-DD
  time?: string;          // HH:mm
  type: EventType;
  appId?: string;
  note?: string;
  source: 'manual' | 'application' | 'mail' | 'import';
  done?: boolean;
}

// ---------- Mail ----------
export type MailCategory =
  | 'offer' | 'interview' | 'test' | 'reject'
  | 'apply-confirm' | 'newsletter' | 'other';

export interface MailAddress { name?: string; email: string; }
export interface MailAttachment { id: string; filename: string; size?: number; download_url?: string; }
export interface MailMessage {
  id: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  created_at: string;
  snippet?: string;
  is_read: boolean;
  has_attachments: boolean;
  dir: string;
  body?: string;          // html or text
  body_is_html?: boolean;
  attachments?: MailAttachment[];
  category?: MailCategory;
}

export interface MailAccount {
  email: string;
  name?: string;
  daily_send_quota?: number;
  scopes?: string[];
}

export type ToastKind = 'ok' | 'err' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  msg: string;
  /** 可选的行内动作（如自动同步后的「撤销本次同步」） */
  action?: { label: string; run: () => void };
}

export type ViewId =
  | 'dashboard' | 'database' | 'applications' | 'jobs' | 'bank' | 'calendar' | 'mail' | 'resume'
  | 'insights' | 'offers' | 'interviews' | 'checklist' | 'versions' | 'contacts';

// ---------- Jobs (招聘信息追踪) ----------
/** 价值分档。阈值与权重见 `lib/scoreRules.ts` 的 TIER_META / WEIGHTS */
export type ScoreTier = 'S' | 'A' | 'B' | 'C';

export interface JobMatch {
  score: number;          // 0-100
  highlights: string;
  gaps: string;
  advice: string;
  at: string;
  /**
   * 评分来源：
   *   · `rule`    —— 导入时按机构 / 岗位 / 地域 / 门槛自动打分（确定性，不依赖 JD 文本）
   *   · `ai`      —— 用户在岗位详情里手动触发的 AI 深度分析
   *   · `keyword` —— 无 AI Key 时的关键词粗评兜底
   * 自动评分与手动评估会互相覆盖，这是刻意的：手动评估代表更晚的判断。
   */
  by: 'ai' | 'keyword' | 'rule';
  /** 分档。只有规则评分会填；手动 AI 评分留空（它的分数口径与规则分不同源） */
  tier?: ScoreTier;
  /** 时间 / 门槛 / 形态标记，如 `⏰ 3 天内截止`、`📜 需法考证` */
  flags?: string[];
}
/** 招聘线：三条线分开管理，避免国央企、公考选调、民营企业混在一起看 */
export type JobTrack = 'soe' | 'civil' | 'private';
export type JobStatus = 'new' | 'interested' | 'applied' | 'archived';
export interface JobPosting {
  id: string;
  company: string;
  title: string;
  city?: string;
  salary?: string;
  source?: string;        // 官网/BOSS直聘/猎聘/智联/前程无忧/实习僧/国聘/邮件…
  url?: string;
  jd?: string;            // 职位描述原文（含岗位方向/对象/流程）
  requirements?: string;  // 招聘要求（硬性门槛）
  exam?: string;          // 笔试 / 考试内容
  deadline?: string;
  match?: JobMatch;
  status: JobStatus;
  track?: JobTrack;      // 招聘线：soe=国央企校招 / civil=公务员选调 / private=民营企业及其他
  appliedBy?: string;    // 这份「已投递」是由哪条投递记录同步来的（投递状态退回时可精准回退）
  createdAt: string;
  updatedAt: string;
}

// ---------- Question bank (笔试/面试题库) ----------
export type QKind = 'written' | 'interview';

/**
 * 题库一级分类（赛道）。
 *
 * 结构：**分类卡墙 → 题库卡墙 → 题组（一场面试 / 一套卷）/ 单题**。
 * 分类是一层固定的粗粒度容器（考公选调 / 银行 / 国央企…），可增删改名；
 * 用户在自己关心的分类下建题库（如「银行 → 招商银行 2026 笔试」），题目放在题库里。
 * v7 起界面上是三级卡片墙（沿用「网申记录追踪」那套 .catc 语言），不再是左侧分类树。
 */
export interface BankCategory {
  id: string;
  name: string;
  /** 排序权重，小的在前 */
  order: number;
  /** 预置分类（预置的不可删除，只能改名） */
  presets?: boolean;
  createdAt: string;
}

/** 题库仓库：挂在某个分类下的自建容器，把笔试题 / 面试题 / 面经收进去 */
export interface QuestionBank {
  id: string;
  name: string;
  /** 所属分类 id；缺失表示「未分类」（老数据迁移兜底，不猜归属） */
  catId?: string;
  note?: string;                 // 备注：如「笔试常考行测 + 金融专业课」
  createdAt: string;
  updatedAt?: string;
  /** 旧版字段：company | industry。仅用于读取老数据与合并去重，不再出现在界面上 */
  kind?: 'company' | 'industry';
}

export interface Question {
  id: string;
  kind: QKind;
  category: string;
  content: string;
  answer?: string;
  analysis?: string;
  company?: string;
  year?: string;
  difficulty?: '易' | '中' | '难';
  mastered?: boolean;
  /** 归属仓库 id；空 = 直接挂在分类下（未建库的题） */
  bankId?: string;
  /** 所属分类 id；与所属仓库保持同步，便于「按分类看全部题」 */
  catId?: string;
  /**
   * 所属「题组」id：同一场面试 / 同一套卷的题共享一个 id。
   *
   * 为什么要有它：用户拿到手的往往是一整场面试的问法清单（一次 30+ 题），
   * 逐题建条会让列表炸成一片、归档 30 次。题组把「整场」当成列表上的一个单位
   * —— 往里塞时整篇粘贴即可，看的时候是一张卡，展开才是逐题。
   * 空 = 独立单题（老数据全部走这条路，不需要迁移）。
   */
  groupId?: string;
  /** 题组标题（如「中核集团 2026 秋招 一面」）。冗余存在每道题上，免去单独一张表与一个云同步键 */
  groupTitle?: string;
  /** 题组内顺序，小在前；单题忽略 */
  order?: number;
  createdAt: string;
}

// ---------- Company profiles (公司背景) ----------
export type CompanyPriority = 'high' | 'mid' | 'low';
export interface CompanyProfile {
  id: string;
  company: string;
  industry?: string;
  website?: string;              // 官网 / 招聘入口
  priority?: CompanyPriority;    // 手动设定的重要度；不设则按截止与进展自动判定
  scale?: string;
  hq?: string;
  business?: string;
  process?: string;
  notes?: string;
  aiGenerated?: boolean;
  updatedAt: string;
}

// ---------- Mail send attachment ----------
export interface SendAttachment { filename: string; dataBase64: string; }

/* ================= 第二批板块新增类型 ================= */

/* ---------- Offer 决策对比 ---------- */
export type OfferStatus = 'considering' | 'accepted' | 'declined' | 'expired';
export interface Offer {
  id: string;
  company: string;
  position: string;
  status: OfferStatus;
  city?: string;
  team?: string;              // 部门 / 团队 / 业务线
  baseMonthly?: string;       // 月base
  months?: string;            // 薪数（如 16）
  bonus?: string;             // 年终 / 绩效
  allowance?: string;         // 补贴（餐补/房补/交通）
  signingBonus?: string;      // 签字费
  totalPackage?: string;      // 首年总包（可手填或自动估算）
  socialInsurance?: string;   // 社保公积金基数/比例
  hukou?: string;             // 户口 / 落户
  penalty?: string;           // 违约金
  signDeadline?: string;      // 签约截止 YYYY-MM-DD
  onboardDate?: string;       // 入职时间
  pros?: string;
  cons?: string;
  rating?: number;            // 1-5 主观评分
  weight?: number;            // 决策权重（默认 1）
  appId?: string;             // 关联投递记录
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------- 面试复盘 ---------- */
export type InterviewRound = '笔试' | '一面' | '二面' | '三面' | '终面' | 'HR面' | '群面' | '其他';
export type InterviewResult = 'pending' | 'passed' | 'failed';
export interface InterviewQuestion {
  /** 稳定标识：列表渲染的 key 用（原先用下标，删除中间一题会让 React 复用错位的 DOM 节点）。
   *  旧数据没有该字段，渲染时回退到下标。 */
  id?: string;
  q: string; a?: string; self?: 'good' | 'mid' | 'bad'; note?: string;
}
export interface InterviewLog {
  id: string;
  company: string;
  position?: string;
  round: InterviewRound;
  date: string;               // YYYY-MM-DD
  time?: string;              // HH:mm
  format?: string;            // 线上 / 线下 / 电话
  interviewers?: string;      // 面试官（人数/职务）
  durationMin?: number;
  questions: InterviewQuestion[];
  selfReview?: string;        // 整体复盘
  improvements?: string;      // 下次改进
  result: InterviewResult;
  mood?: number;              // 1-5 自我感觉
  appId?: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------- 材料清单 ---------- */
export interface MaterialItem {
  id: string;
  group: string;              // 分组（证件/证明/学历…）
  name: string;
  note?: string;
  path?: string;              // 本机文件路径（可一键复制）
  done?: boolean;             // 是否已备好
  needScan?: boolean;
  updatedAt: string;
}

/* ---------- 简历版本 ---------- */
export interface ResumeVersion {
  id: string;
  name: string;               // 律所版 / 券商法务版 / 银行合规版
  target?: string;            // 面向岗位/行业
  focus?: string;             // 这个版本强调什么
  highlights?: string;        // 必须保留的关键经历（换版本时别丢）
  usedFor?: string[];         // 已投递单位（自由文本数组）
  fileName?: string;          // 本机文件名
  updatedAt: string;
}

/* ---------- 内推人 / 人脉 CRM ---------- */
export interface Contact {
  id: string;
  name: string;
  company?: string;
  role?: string;              // HR / 学长 / 内推人 / 猎头
  relation?: string;          // 关系（校友/实习同事…）
  wechat?: string;
  email?: string;
  phone?: string;
  lastContact?: string;       // YYYY-MM-DD
  nextFollowUp?: string;      // YYYY-MM-DD
  promised?: string;          // 对方承诺的事
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------- 截止提醒配置 ---------- */
export interface RemindConfig {
  enabled: boolean;           // 是否启用浏览器通知
  days: number[];             // 提前几天提醒（默认 7/3/1）
  notifyAt: string;           // HH:mm（站内检查时间点，用于通知节流）
  includeJobs: boolean;
  includeApps: boolean;
  includeEvents: boolean;
}
