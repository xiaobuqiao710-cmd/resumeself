import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type {
  ProfileData, Application, CalEvent, Rec, Toast, ToastKind, AppStatus, ViewId,
  JobPosting, JobStatus, Question, QuestionBank, BankCategory, CompanyProfile,
  Offer, InterviewLog, MaterialItem, ResumeVersion, Contact, RemindConfig,
} from '../types';
import { FIXED_VALUES } from '../data/formSchema';
import { SEED_PROFILE, MIGRATION_PROJECTS } from '../data/seed';
import { uid, todayISO, sameCompanyStem, stripDecor } from '../lib/util';
import { normTitle } from '../lib/dedupe';
import { defaultCategories, inferCategoryIdOrFallback, FALLBACK_CAT_ID } from '../lib/bankMeta';
import { planReconcile, applyReconcile, summarizeReconcile, type ReconcilePlan } from '../lib/reconcile';
import {
  isAutoSyncOn, pullSyncDoc, parseSyncDoc, hashText, lastSyncHash, markSynced,
  markSyncOk, markSyncFail, markFileChanged,
  rememberPreSync, prevSyncRaw, collapseDuplicateEvents,
} from '../lib/autosync';
import { saveSnapshot, clearSnapshots, fmtBytes } from '../lib/backup';
import { mergeSnapshot } from '../lib/merge';
import { saveCloudState, fetchCloudUpdatedAt, loadCloudState } from '../lib/cloudState';
import {
  DEFAULT_SKIN, skinDef, applySkinToDocument, writeSavedSkin, type SkinId,
} from '../lib/skins';

/**
 * 数据版本号 —— 结构变更时递增。
 * 注意：版本号变化**不再清空数据**，而是走 migrate() 逐级迁移（旧数据原样保留），
 * 并在迁移前存一份本机快照（见 lib/backup.ts）。
 */
const DATA_VERSION = 6;

export const DEFAULT_REMIND: RemindConfig = {
  enabled: false,
  days: [7, 3, 1],
  notifyAt: '09:00',
  includeJobs: true,
  includeApps: true,
  includeEvents: true,
};

function emptyProfile(): ProfileData {
  return JSON.parse(JSON.stringify(SEED_PROFILE));
}

/** 增量迁移：保留已有数据，仅追加缺失的项目经历（避免老用户重复添加） */
function migrateProfile(profile: ProfileData): ProfileData {
  const existing = profile.multi?.project || [];
  const existingNames = new Set(existing.map((p) => p.name));
  const toAdd = MIGRATION_PROJECTS.filter((p) => !existingNames.has(p.name));
  if (toAdd.length === 0) return profile;
  return {
    ...profile,
    multi: { ...profile.multi, project: [...existing, ...toAdd] },
  };
}

interface Persisted {
  _v?: number;
  profile: ProfileData;
  applications: Application[];
  events: CalEvent[];
  theme: 'dark' | 'light';
  /** 皮肤 id；比 theme 高一层 —— 见 lib/skins.ts 顶部「皮肤 ≠ 明暗」 */
  skin?: SkinId;
  resumeText?: string;
  jobs?: JobPosting[];
  questions?: Question[];
  banks?: QuestionBank[];
  bankCategories?: BankCategory[];
  companies?: CompanyProfile[];
  offers?: Offer[];
  interviews?: InterviewLog[];
  materials?: MaterialItem[];
  versions?: ResumeVersion[];
  contacts?: Contact[];
  remind?: RemindConfig;
}

/** 持久化的全部数据形态（供 Store 接口与空数据共用，避免字面量类型收窄） */
interface DataState {
  profile: ProfileData;
  applications: Application[];
  events: CalEvent[];
  theme: 'dark' | 'light';
  skin: SkinId;
  resumeText?: string;
  jobs: JobPosting[];
  questions: Question[];
  banks: QuestionBank[];
  bankCategories: BankCategory[];
  companies: CompanyProfile[];
  offers: Offer[];
  interviews: InterviewLog[];
  materials: MaterialItem[];
  versions: ResumeVersion[];
  contacts: Contact[];
  remind: RemindConfig;
}

function emptyData(): DataState {
  return {
    profile: emptyProfile(),
    applications: [] as Application[],
    events: [] as CalEvent[],
    theme: 'dark' as const,
    skin: DEFAULT_SKIN,
    jobs: [] as JobPosting[],
    questions: [] as Question[],
    banks: [] as QuestionBank[],
    bankCategories: defaultCategories(),
    companies: [] as CompanyProfile[],
    offers: [] as Offer[],
    interviews: [] as InterviewLog[],
    materials: [] as MaterialItem[],
    versions: [] as ResumeVersion[],
    contacts: [] as Contact[],
    remind: { ...DEFAULT_REMIND },
  };
}

/**
 * 逐级迁移：任何旧版本都能安全升级，绝不丢数据。
 *
 * v6（题库结构重构）：引入「分类」这一层，形成 分类 → 自建库 → 笔试/面试 → 题目分类分组。
 * 老数据里只有一层库（company / industry）且题目可以没有归属，这里：
 *   ① 补齐预置分类（已有分类按 id 去重，用户改名过的不覆盖）；
 *   ② 每个老库按名称/备注**尽力推断**分类，推断不出落「其他」—— 只是给了个默认落点，
 *      用户可以在题库页随时改；不猜的是「这道题属于哪个库」这种无法从数据推断的归属；
 *   ③ 每道题的 catId 与所属库对齐（无库的题保留自身推断结果）。
 * 三步都是幂等的，重复执行结果一致。
 */
function migrate(raw: Record<string, unknown>): Persisted {
  const d = { ...raw } as Persisted & Record<string, unknown>;
  const from = Number(d._v || 1);
  if (from < 6) {
    const cats: BankCategory[] = Array.isArray(d.bankCategories) ? (d.bankCategories as BankCategory[]) : [];
    const byId = new Map(cats.map((c) => [c.id, c]));
    for (const preset of defaultCategories()) {
      if (!byId.has(preset.id)) { cats.push(preset); byId.set(preset.id, preset); }
    }
    /* 用户自建分类保持原样；预置分类标记为 presets，删不掉但可改名 */
    d.bankCategories = cats.map((c) => ({ ...c, presets: !!byId.get(c.id)?.presets }));

    const banks = (d.banks ?? []) as QuestionBank[];
    const bankCat = new Map<string, string>();
    const migratedBanks = banks.map((b) => {
      const catId = b.catId && byId.has(b.catId)
        ? b.catId
        : inferCategoryIdOrFallback(b.name, b.note);
      bankCat.set(b.id, catId);
      return { ...b, catId };
    });
    d.banks = migratedBanks;

    const qs = (d.questions ?? []) as Question[];
    d.questions = qs.map((q) => {
      if (q.bankId && bankCat.has(q.bankId)) return { ...q, catId: bankCat.get(q.bankId) };
      /* 无库的题：按公司/分类自己推断；已有 catId 且分类仍存在则保留 */
      if (q.catId && byId.has(q.catId)) return q;
      return { ...q, catId: inferCategoryIdOrFallback(q.company, q.category) };
    });
  }
  if (from < 5) {
    /* v5：题库引入「仓库」容器。老题一律 bankId 为空（未归档），不猜测归属，
       用户在题库页可以一键批量归入，不存在丢数据的路径。 */
    d.banks = d.banks ?? [];
  }
  if (from < 4) {
    d.offers = d.offers ?? [];
    d.interviews = d.interviews ?? [];
    d.materials = d.materials ?? [];
    d.versions = d.versions ?? [];
    d.contacts = d.contacts ?? [];
    d.remind = d.remind ?? { ...DEFAULT_REMIND };
  }
  /* 兜底：任何来源（云端文档 / 本机缓存 / 合并导入）都必须有分类，否则左栏会是空的 */
  if (!Array.isArray(d.bankCategories) || !(d.bankCategories as BankCategory[]).length) {
    d.bankCategories = defaultCategories();
  }
  /* 兜底：投递记录的 `timeline` 必须是数组。
     它只在 `addApp` 里被写出来，所以「站点自己建的记录」一定带着；但凡走过导入的路子
     （旧版备份、手工整理的 JSON、别人给的还原包）都可能没有这个字段 ——
     而投递详情页会直接 `[...app.timeline].reverse().map(...)`，一碰就抛
     「timeline is not iterable」，把整个详情/列表渲染打断，用户看到的是「点了没反应」。
     这里补一个只有起始状态的合法时间线，比在每个消费点写 `|| []` 更彻底。 */
  if (Array.isArray(d.applications)) {
    d.applications = (d.applications as Application[]).map((a) => ({
      ...a,
      timeline: Array.isArray(a.timeline) && a.timeline.length
        ? a.timeline
        : [{ status: a.status || 'todo', at: a.createdAt || todayISO() }],
    }));
  }
  d._v = DATA_VERSION;
  return d as Persisted;
}

function load(userId: string): DataState {
  const key = `qz.cloud.${userId}`;
  const empty = emptyData();
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { return empty; }
  if (!raw) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape');
  } catch {
    // 解析失败：先把原始串备份下来（避免静默丢数据），再以空数据启动
    saveSnapshot(key, raw, 'broken');
    return empty;
  }

  // 版本落后：迁移前留一份快照，可随时回滚
  if (Number(parsed._v || 1) !== DATA_VERSION) saveSnapshot(key, raw, 'v' + String(parsed._v ?? 'unknown'));

  return shape(parsed);
}

/**
 * 把一份「持久化形态」折算成内存状态（缺失字段一律补安全默认值）。
 * 本机缓存的旧版本与云端文档都走这一条路，保证两个来源的解析口径完全一致 ——
 * 否则会出现「同一份数据从云端读进来缺字段、从本机读进来正常」这种最难查的偏差。
 */
function shape(raw: Record<string, unknown>): DataState {
  const m = migrate(raw);
  return {
    profile: migrateProfile((m.profile as ProfileData) ?? emptyProfile()),
    applications: m.applications ?? [],
    events: m.events ?? [],
    theme: m.theme ?? ('dark' as const),
    /* 皮肤 id 容错：云端文档可能来自更高版本、本机缓存可能存着已删掉的皮肤，
       认不出来就退回默认皮肤 —— 绝不让一个陌生字符串把整站样式打崩。 */
    skin: skinDef(m.skin).id,
    resumeText: m.resumeText,
    jobs: m.jobs ?? [],
    questions: m.questions ?? [],
    banks: m.banks ?? [],
    bankCategories: m.bankCategories ?? defaultCategories(),
    companies: m.companies ?? [],
    offers: m.offers ?? [],
    interviews: m.interviews ?? [],
    materials: m.materials ?? [],
    versions: m.versions ?? [],
    contacts: m.contacts ?? [],
    remind: m.remind ?? { ...DEFAULT_REMIND },
  };
}

interface Store extends DataState {
  view: ViewId;
  setView: (v: ViewId) => void;
  /** 本机缓存 key（备份快照、占用统计都以它为准，不能再写死 qz.cloud.default） */
  storageKey: string;
  /** 当前登录账号 id（云端版）；本机模式为 default */
  userId: string;
  /** 云端同步状态；cloud.enabled === false 表示本机模式（不连云） */
  cloud: CloudStatus;
  /** 手动立即推送一次（设置里的「立即同步」与同步失败后的重试） */
  pushToCloud: () => Promise<void>;
  /** 云端启动读取失败后，用户点「重试」：重新读一次云端，读通就重载页面走「云端优先」的启动流程 */
  enableCloud: () => Promise<boolean>;
  toasts: Toast[];
  toast: (msg: string, kind?: ToastKind, ttlMs?: number, action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
  /** 当前皮肤（极光 / 纸 / 墨 / 石墨 / 青绿…），决定设计语言；见 lib/skins.ts */
  skin: SkinId;
  setSkin: (id: SkinId) => void;
  // profile
  setSingle: (section: string, key: string, value: string) => void;
  updateMulti: (section: string, idx: number, patch: Partial<Rec>) => void;
  addMulti: (section: string, rec?: Rec) => void;
  removeMulti: (section: string, idx: number) => void;
  // applications
  addApp: (a: Partial<Application>) => Application;
  updateApp: (id: string, patch: Partial<Application>) => void;
  setStatus: (id: string, status: AppStatus, note?: string) => void;
  removeApp: (id: string) => void;
  // events
  addEvent: (e: Partial<CalEvent>) => CalEvent;
  addEvents: (list: Partial<CalEvent>[]) => number;
  updateEvent: (id: string, patch: Partial<CalEvent>) => void;
  removeEvent: (id: string) => void;
  // jobs
  addJob: (j: Partial<JobPosting>) => JobPosting;
  addJobs: (list: Partial<JobPosting>[]) => { added: number; updated: number };
  updateJob: (id: string, patch: Partial<JobPosting>) => void;
  removeJob: (id: string) => void;
  // question bank
  addQuestion: (q: Partial<Question>) => Question;
  addQuestions: (qs: Partial<Question>[]) => number;
  updateQuestion: (id: string, patch: Partial<Question>) => void;
  removeQuestion: (id: string) => void;
  /** 批量删除（AI 整理后整体替换、整组清空时用） */
  removeQuestions: (ids: string[]) => number;
  // 题组（一场面试 / 一套卷）：整篇导入 → 一条卡 → 展开才逐题
  /** 整场写入：标题 + 一批题 → 一个题组 id */
  addQuestionSet: (title: string, qs: Partial<Question>[], target?: { bankId?: string; catId?: string }) => { groupId: string; added: number };
  /** 重排题组内顺序（传完整的有序 id 列表） */
  reorderGroup: (groupId: string, orderedIds: string[]) => void;
  /** 改题组标题（同步改写组内每道题） */
  renameGroup: (groupId: string, title: string) => void;
  /** 解散题组：只摘掉 groupId，题一道不删 */
  dissolveGroup: (groupId: string) => void;
  /** 把若干道独立单题合并成一个题组，返回新题组 id */
  mergeIntoGroup: (title: string, ids: string[]) => string;
  // question banks（题库：分类 → 自建库 → 笔试/面试）
  banks: QuestionBank[];
  /** 题库一级分类（赛道），可增删改名 */
  bankCategories: BankCategory[];
  addCategory: (c: Partial<BankCategory>) => BankCategory;
  updateCategory: (id: string, patch: Partial<BankCategory>) => void;
  /** 删除分类：其中的库与题**一律移到「其他」分类，绝不连带删除** */
  removeCategory: (id: string) => void;
  addBank: (b: Partial<QuestionBank>) => QuestionBank;
  updateBank: (id: string, patch: Partial<QuestionBank>) => void;
  /** 删除仓库：其中题目一律回到「未归档」，绝不连带删题 */
  removeBank: (id: string) => void;
  /** 批量把题目归入某仓库（bankId 传 undefined = 移出到未归档；catId 会随仓库同步） */
  assignQuestions: (ids: string[], bankId?: string, catId?: string) => number;
  // company profiles
  upsertCompany: (company: string, patch: Partial<CompanyProfile>) => CompanyProfile;
  removeCompany: (id: string) => void;
  // offers
  addOffer: (o: Partial<Offer>) => Offer;
  updateOffer: (id: string, patch: Partial<Offer>) => void;
  removeOffer: (id: string) => void;
  // interviews
  addInterview: (i: Partial<InterviewLog>) => InterviewLog;
  updateInterview: (id: string, patch: Partial<InterviewLog>) => void;
  removeInterview: (id: string) => void;
  // materials
  addMaterial: (m: Partial<MaterialItem>) => MaterialItem;
  updateMaterial: (id: string, patch: Partial<MaterialItem>) => void;
  removeMaterial: (id: string) => void;
  importMaterials: (items: Partial<MaterialItem>[]) => number;
  // resume versions
  addVersion: (v: Partial<ResumeVersion>) => ResumeVersion;
  updateVersion: (id: string, patch: Partial<ResumeVersion>) => void;
  removeVersion: (id: string) => void;
  // contacts
  addContact: (c: Partial<Contact>) => Contact;
  updateContact: (id: string, patch: Partial<Contact>) => void;
  removeContact: (id: string) => void;
  // remind
  setRemind: (patch: Partial<RemindConfig>) => void;
  // resume
  setResumeText: (t: string) => void;
  // data mgmt
  exportAll: () => string;
  importAll: (json: string) => boolean;
  /** 合并导入：只补空缺、按标识去重追加，绝不覆盖你已填写的内容 */
  importMerge: (json: string) => { ok: boolean; detail: string[] };
  /** 全局对账：把岗位库状态与投递记录对齐（幂等，可反复调用） */
  reconcileNow: (opts?: { createMissing?: boolean; silent?: boolean }) => { plan: ReconcilePlan; summary: string[] };
  resetAll: () => void;
}

const Ctx = createContext<Store | null>(null);

/* ------------------------------------------------------------------ *
 * 云端同步（Supabase）
 * ------------------------------------------------------------------ */

export type CloudSyncState = 'off' | 'idle' | 'saving' | 'saved' | 'error';

export interface CloudStatus {
  enabled: boolean;
  state: CloudSyncState;
  /** 最近一次成功写入云端的时间（ISO） */
  at?: string;
  /** 失败原因（原样显示给用户，不美化，免得掩盖真实问题） */
  error?: string;
}

/**
 * 启动时云端读取的结果，由 App 在登录后读一次再交给 StoreProvider。
 * 三态必须分开，否则会把「读取失败」当成「云端是空的」，进而用本机空数据覆盖云端：
 *   - `undefined`        → 本机模式（未登录 / 独立助手窗口）：完全不连云
 *   - `{ ok: false }`    → 云端读取失败：先用本机缓存把界面撑起来，但**禁止回写云端**，
 *                          直到用户点「重试」并成功为止
 *   - `{ ok: true, state: null }` → 云端确实没有数据（新账号）：用本机缓存并立即上云
 */
export type CloudBoot =
  | { ok: true; state: Record<string, unknown> | null; migrated?: boolean; savedAt?: string }
  | { ok: false; error: string }
  | undefined;

/**
 * 把「岗位库应有的状态」按对账结果一次性落地。
 *
 * 这里是**所有**联动路径的唯一收口：新建投递、改状态、导入岗位、合并导入、以及应用启动时的
 * 例行对账，都调用它。原先每个入口各自写一套 isSamePosting 匹配 + 手工回退，
 * 一旦单位名写法或岗位名对不上就悄悄漏掉（用户反馈的「投递完成了但岗位卡没更新」即是此因）。
 */
function runReconcile(
  jobs: JobPosting[],
  apps: Application[],
  setJobs: React.Dispatch<React.SetStateAction<JobPosting[]>>,
  toast: (msg: string, kind?: ToastKind) => void,
  opts: { createMissing?: boolean; silent?: boolean } = {},
  jobsRef?: React.MutableRefObject<JobPosting[]>,
): ReconcilePlan {
  const plan = planReconcile(jobs, apps, { createMissing: opts.createMissing !== false });
  if (plan.jobStatus.length || plan.jobsToCreate.length) {
    setJobs((js) => {
      const nx = applyReconcile(js, plan);
      if (jobsRef) jobsRef.current = nx;   // 同一批次内的后续调用看到最新岗位数组
      return nx;
    });
    const synced = plan.jobStatus.filter((p) => p.status === 'applied').length;
    const reverted = plan.jobStatus.filter((p) => p.status !== 'applied').length;
    if (!opts.silent) {
      if (synced) toast(`岗位库已同步：${synced} 个岗位标记为「已投递」，对应截止提醒已停止`, 'info');
      else if (reverted) toast(`岗位库已回退：${reverted} 个岗位恢复为「感兴趣」，截止提醒重新开启`, 'info');
    }
  }
  return plan;
}

export function StoreProvider({ children, userId = 'default', boot }: {
  children: React.ReactNode;
  userId?: string;
  /** 云端启动读取结果（见 CloudBoot 注释）；不传 = 本机模式 */
  boot?: CloudBoot;
}) {
  /* 云端读到数据就以云端为准（它才是权威来源）；云端为空或读取失败时用本机缓存把界面撑起来，
     保证「断网/额度暂停」时站点仍然完全可用，而不是白屏。 */
  const initial = useMemo(
    () => (boot?.ok && boot.state ? shape(boot.state) : load(userId)),
    [userId, boot],
  );
  const storageKey = useMemo(() => `qz.cloud.${userId}`, [userId]);

  /* 云端写入开关：只有「读到了云端」或「云端确认是空的」才允许回写。
     读取失败时若照样回写，本机这份可能过期的缓存就会覆盖掉云端更新的数据。 */
  const [cloudEnabled, setCloudEnabled] = useState(!!(boot?.ok));
  const cloudEnabledRef = useRef(cloudEnabled);
  cloudEnabledRef.current = cloudEnabled;
  const [cloud, setCloud] = useState<CloudStatus>(() => (
    boot === undefined
      ? { enabled: false, state: 'off' }
      : boot.ok
        ? { enabled: true, state: 'idle', at: boot.savedAt }
        : { enabled: false, state: 'error', error: boot.error }
  ));
  const cloudTimerRef = useRef<number | undefined>(undefined);
  const cloudInFlightRef = useRef(false);
  const cloudPendingRef = useRef<Persisted | null>(null);
  /* 本机有没有「还没推上去」的改动。决定重新获得焦点时能不能安全地提示「载入云端最新」——
     有未同步改动时提示用户刷新，等于把他刚敲的东西丢掉。 */
  const dirtyRef = useRef(false);
  /* 最近一次成功写入的服务端时间戳（用于判断云端是否被别的设备改过） */
  const cloudAtRef = useRef<string | undefined>(boot?.ok ? boot.savedAt : undefined);
  const staleWarnedRef = useRef<string | undefined>(undefined);   // 同一次远端更新只提示一次

  const [profile, setProfile] = useState<ProfileData>(initial.profile);
  const [applications, setApplications] = useState<Application[]>(initial.applications);
  const [events, setEvents] = useState<CalEvent[]>(initial.events);
  const [theme, setThemeState] = useState<'dark' | 'light'>(initial.theme);
  const [skin, setSkinState] = useState<SkinId>(initial.skin);
  const [resumeText, setResumeTextState] = useState<string | undefined>(initial.resumeText);
  const [jobs, setJobs] = useState<JobPosting[]>(initial.jobs);
  const [questions, setQuestions] = useState<Question[]>(initial.questions);
  const [banks, setBanks] = useState<QuestionBank[]>(initial.banks);
  const [bankCategories, setBankCategories] = useState<BankCategory[]>(initial.bankCategories);
  const [companies, setCompanies] = useState<CompanyProfile[]>(initial.companies);
  const [offers, setOffers] = useState<Offer[]>(initial.offers);
  const [interviews, setInterviews] = useState<InterviewLog[]>(initial.interviews);
  const [materials, setMaterials] = useState<MaterialItem[]>(initial.materials);
  const [versions, setVersions] = useState<ResumeVersion[]>(initial.versions);
  const [contacts, setContacts] = useState<Contact[]>(initial.contacts);
  const [remind, setRemindState] = useState<RemindConfig>(initial.remind);
  const [view, setView] = useState<ViewId>('dashboard');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const storageWarnedRef = useRef(false);   // 存储写满只提醒一次，避免刷屏
  /* 换皮肤时的过渡计时器（本机计时，不进 state —— 它只驱动一次 CSS 过渡，不该参与渲染） */
  const skinTransTimer = useRef(0);
  const adoptedRawRef = useRef<string | null>(null);   // 刚从别的标签页接纳过来的原始串
  const tabConflictWarnedRef = useRef(false);          // 标签页冲突每会话只提醒一次

  /**
   * 最新值的 ref 镜像。
   *
   * 为什么必须有：`setStatus` / `addApp` / `removeApp` / `addJobs` 都是「读当前数组 → 算新数组 →
   * 整体写回」，而回调闭包里的 `applications`/`jobs` 是**本次渲染时**的快照。同一个事件循环里连续调用
   * 两次（邮件 AI 同步一次识别出多条更新、AI 助手一次改多家单位、导入后紧接对账）时，
   * 第二次会用旧快照覆盖第一次的结果——实测「批量改 3 条只有最后 1 条生效，刷新后前两条复原」。
   * 镜像 ref 让每次调用都基于上一次调用的结果继续，写入相互不丢。
   */
  const appsRef = useRef<Application[]>(applications); appsRef.current = applications;
  const jobsRef = useRef<JobPosting[]>(jobs); jobsRef.current = jobs;
  const companiesRef = useRef<CompanyProfile[]>(companies); companiesRef.current = companies;
  const bankCategoriesRef = useRef<BankCategory[]>(bankCategories); bankCategoriesRef.current = bankCategories;

  /**
   * 把当前状态推到云端（防抖 + 单飞）。
   *
   * 三点设计，缺一个都会出问题：
   *  ① **防抖 700ms**：连续输入（简历正文、岗位备注）会触发几十次状态变更，
   *     每次都打一发 HTTP 既慢又容易撞 Supabase 的速率限制。
   *  ② **单飞 + 待办**：写入进行中又来新状态时，只把最新那份记下来，等当前请求结束再发一次。
   *     否则请求会并发交错，先发的后到就会把新数据覆盖成旧的。
   *  ③ **失败必须冒泡**：云端写失败会置 error 状态并在设置里显示原文，
   *     绝不静默 —— 「以为存上了其实没存」是这类站最致命的体验问题。
   */
  const pushNow = useCallback(async (data: Persisted) => {
    if (!cloudEnabledRef.current) return;
    if (cloudInFlightRef.current) { cloudPendingRef.current = data; return; }
    cloudInFlightRef.current = true;
    setCloud((c) => ({ ...c, state: 'saving', error: undefined }));
    try {
      const at = await saveCloudState(userId, data as unknown as Record<string, unknown>);
      cloudAtRef.current = at;
      dirtyRef.current = false;
      setCloud({ enabled: true, state: 'saved', at });
    } catch (e) {
      setCloud({ enabled: true, state: 'error', error: (e as Error).message });
    } finally {
      cloudInFlightRef.current = false;
      const pending = cloudPendingRef.current;
      cloudPendingRef.current = null;
      if (pending) void pushNow(pending);
    }
  }, [userId]);

  useEffect(() => {
    const data: Persisted = {
      _v: DATA_VERSION, profile, applications, events, theme, skin, resumeText,
      jobs, questions, banks, bankCategories, companies, offers, interviews, materials, versions, contacts, remind,
    };
    const serialized = JSON.stringify(data);
    /* 刚从另一个标签页接纳过来的内容：原样回写毫无意义，还会在两边来回触发 storage 事件。
       比字符串相等即可 —— 两边都是同一份 state 的 JSON.stringify，口径一致。 */
    if (adoptedRawRef.current && adoptedRawRef.current === serialized) {
      adoptedRawRef.current = null;
      return;
    }
    adoptedRawRef.current = null;
    try {
      localStorage.setItem(storageKey, serialized);
    } catch (e) {
      /* 写满本机存储（浏览器一般 5MB）：**绝不能静默**——否则用户以为导入成功了，
         刷新后数据却没了。这里立刻告警，并保留内存里的状态让用户有机会先导出。

         2026-10-16 起先自救一次：配额通常是被**旧快照**吃掉的（一份快照 = 一份完整全量状态，
         5 份就是 5 倍），而快照是可再生的旧副本、用户刚做的这份修改不是 —— 所以先清快照再重试。 */
      console.warn('[秋招中心] 本机存储写入失败（可能是配额已满）', e);
      const freed = clearSnapshots();
      let saved = false;
      try { localStorage.setItem(storageKey, serialized); saved = true; } catch { /* 仍写不进 */ }
      if (saved) {
        if (freed > 0) {
          setToasts((t) => [...t, {
            id: Date.now(),
            kind: 'info',
            msg: `本机存储已满，已自动清理旧快照腾出 ${fmtBytes(freed)}，本次修改已保存。`,
          }]);
        }
      } else if (!storageWarnedRef.current) {
        storageWarnedRef.current = true;
        setToasts((t) => [...t, {
          id: Date.now(),
          kind: 'err',
          msg: '本机浏览器存储已满：这次修改可能存不下来。请到「设置 → 数据与备份」导出备份，再清理不需要的数据（例如岗位库里早已截止/不投的岗位）。',
        }]);
      }
    }
    /* 云端：本机永远先写（保证断网也不丢），再防抖推云端 */
    if (!cloudEnabledRef.current) return;
    dirtyRef.current = true;
    window.clearTimeout(cloudTimerRef.current);
    cloudTimerRef.current = window.setTimeout(() => { void pushNow(data); }, 700);
    return () => window.clearTimeout(cloudTimerRef.current);
  }, [profile, applications, events, theme, skin, resumeText, jobs, questions, banks, bankCategories, companies,
      offers, interviews, materials, versions, contacts, remind, storageKey, pushNow]);

  /**
   * 把另一标签页写进 localStorage 的整份状态接纳过来。
   * 复用 `shape()`，与本机缓存、云端文档走同一条解析路径 —— 三处口径必须一致。
   */
  const adoptSnapshot = useCallback((raw: string): boolean => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const s = shape(parsed);
      adoptedRawRef.current = raw;
      setProfile(s.profile); setApplications(s.applications); setEvents(s.events);
      setThemeState(s.theme); setResumeTextState(s.resumeText);
      setSkinState(s.skin);
      setJobs(s.jobs); setQuestions(s.questions); setBanks(s.banks);
      setBankCategories(s.bankCategories); setCompanies(s.companies);
      setOffers(s.offers); setInterviews(s.interviews); setMaterials(s.materials);
      setVersions(s.versions); setContacts(s.contacts); setRemindState(s.remind);
      return true;
    } catch { return false; }
  }, []);

  /**
   * 同一浏览器多标签页同步。
   *
   * 要防的场景：用户在两个标签页里都开着这个站。A 页改了东西（已写 localStorage 与云端），
   * B 页内存里还是旧状态；此后用户在 B 页随手点一下（切主题、开个弹窗），B 的持久化 effect
   * 就会把**整份旧状态**写回 localStorage 并推上云端 —— A 刚做的改动当场消失。
   * 这比跨设备场景常见得多，因为「随手开两个标签页」太自然了。
   *
   * 处置分两种：
   *  - 本页空闲 → 直接接纳对方的快照（最好的体验，两边始终一致）；
   *  - 本页正在编辑（有弹窗或光标在输入框里）→ **不动**，只提醒一次。
   *    这种情况下去接纳会把用户正在敲的内容冲掉，属于用一个小问题换一个大问题。
   */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey || !e.newValue) return;      // storage 事件只在**其他**标签页触发
      const editing = !!document.querySelector('.modal-overlay')
        || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement && document.activeElement.tagName) || '');
      if (editing) {
        if (!tabConflictWarnedRef.current) {
          tabConflictWarnedRef.current = true;
          setToasts((t) => [...t, {
            id: Date.now(), kind: 'info',
            msg: '另一个标签页也开着这个站，而且那边更新了数据。你这边正在编辑，先别关这个页面；等填完后刷新一次即可看到两边一致。',
          }]);
        }
        return;
      }
      adoptSnapshot(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey, adoptSnapshot]);

  /** 设置面板里的「立即同步」/ 同步失败后的「重试」 */
  const currentPersisted = useCallback((): Persisted => ({
    _v: DATA_VERSION, profile, applications, events, theme, skin, resumeText,
    jobs, questions, banks, companies, offers, interviews, materials, versions, contacts, remind,
  }), [profile, applications, events, theme, skin, resumeText, jobs, questions, banks, companies,
      offers, interviews, materials, versions, contacts, remind]);

  const pushToCloud = useCallback(async () => {
    setCloudEnabled(true);
    cloudEnabledRef.current = true;
    await pushNow(currentPersisted());
  }, [currentPersisted, pushNow]);

  /**
   * 「重试连接」——**先读通云端，再重载页面**，绝不直接把写入开关拨开。
   *
   * 为什么不能只拨开关：启动读取失败的那段时间里，本机可能已经改过数据（用户并不知道
   * 自己处于「未同步」状态），而云端也可能被另一台设备更新过。此时直接开始写入，
   * 就是拿本机这份可能过期的状态去覆盖云端 —— 正是 CloudBoot 三态要防的那件事。
   * 重载页面则天然安全：启动流程本来就是「云端优先」，读得到的以云端为准。
   */
  const enableCloud = useCallback(async (): Promise<boolean> => {
    setCloud((c) => ({ ...c, state: 'saving', error: undefined }));
    try {
      await loadCloudState(userId);        // 只做连通性检查，不改内存状态
    } catch (e) {
      setCloud({ enabled: false, state: 'error', error: (e as Error).message });
      return false;
    }
    location.reload();                     // 读通了 → 交给启动流程以云端为准
    return true;
  }, [userId]);


  /* 皮肤落到 <html>。
     theme 取的是**皮肤自带的基调**而不是内存里的 theme state —— 皮肤是主、明暗是派生，
     这样即使 theme 被某条旧路径（导入包、旧版云端文档）写歪，界面也不会停在
     「纸的底色 + 深色语义色」这种两套皮肤各出一半的错配上。 */
  useEffect(() => { applySkinToDocument(skin); }, [skin]);

  /**
   * 启动时例行对账一次。
   * 修掉「历史遗留 + 导入产生」的偏差：已投递却还是「新岗位」的岗位卡、投递了但岗位库没有的单位。
   * 只做**可逆的状态对齐**；去重删除一律不在这里做（必须由用户在「清理重复」里逐组确认）。
   */
  const reconciledOnceRef = useRef(false);
  useEffect(() => {
    if (reconciledOnceRef.current) return;
    reconciledOnceRef.current = true;
    const plan = planReconcile(jobs, applications, { createMissing: true });
    if (!plan.jobStatus.length && !plan.jobsToCreate.length) return;
    setJobs((js) => applyReconcile(js, plan));
    const summary = summarizeReconcile(plan);
    if (summary.length) {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, kind: 'info' as ToastKind, msg: `已自动对账：${summary.join('；')}` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toast = useCallback((msg: string, kind: ToastKind = 'ok', ttlMs = 3200, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, msg, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttlMs);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  /**
   * 「这个标签页是不是已经落后于云端了」。
   *
   * 要防的场景：网页装成 PWA 后可以挂在后台好几天。用户在手机上改了数据，
   * 几天后回到还开着的那台电脑 —— 那个标签页内存里还是旧状态，它一有风吹草动
   * （切主题、点一下某处触发一次状态写入）就会把**整份旧文档推上云端**，
   * 把手机上刚填的东西整片抹掉。云端同步越是核心卖点，这个静默覆盖越致命。
   *
   * 因此重新获得焦点时问一句服务端「你那边什么时候写的」：
   *  - 比自己新，且本机没有未同步改动 → 提示可一键载入（刷新后云端优先，安全）
   *  - 比自己新，但本机有未同步改动 → 只警告不提供载入（否则等于丢掉用户刚敲的内容）
   * 同一次远端更新只提示一次，避免反复打扰。
   */
  const checkRemoteFreshness = useCallback(async () => {
    if (!cloudEnabledRef.current) return;
    if (cloudInFlightRef.current) return;
    try {
      const remote = await fetchCloudUpdatedAt(userId);
      if (!remote) return;
      const mine = cloudAtRef.current;
      if (!mine || remote <= mine) return;                 // 云端不比本机新（ISO 字符串可直接比大小）
      if (staleWarnedRef.current === remote) return;       // 同一次远端改动只提示一次
      staleWarnedRef.current = remote;
      if (dirtyRef.current) {
        toast('云端有更新的数据（来自另一台设备），但你本机还有未同步的改动。建议先导出备份再决定，别直接刷新。', 'err', 15000);
      } else {
        toast('另一台设备更新过数据，当前页面是旧的。', 'info', 15000, {
          label: '载入云端最新',
          run: () => { location.reload(); },
        });
      }
    } catch { /* 网络问题静默跳过：这只是锦上添花，不该打扰用户 */ }
  }, [toast, userId]);

  useEffect(() => {
    if (boot === undefined) return;                        // 本机模式不连云
    let last = 0;
    const maybeCheck = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < 60_000) return;                     // 节流：切标签页很频繁，别每次都打一发请求
      last = now;
      void checkRemoteFreshness();
    };
    window.addEventListener('focus', maybeCheck);
    document.addEventListener('visibilitychange', maybeCheck);
    return () => {
      window.removeEventListener('focus', maybeCheck);
      document.removeEventListener('visibilitychange', maybeCheck);
    };
  }, [boot, checkRemoteFreshness]);

  /**
   * 换皮肤。
   *
   * 三件事一起做，缺一件都会留下可见的错：
   *  ① `setSkinState` —— 触发 applySkinToDocument 重写 <html> 上的属性；
   *  ② `setThemeState` —— 让内存里的 theme 跟上（导出备份、云端文档里都带着它）；
   *  ③ `writeSavedSkin` —— 写一份本机缓存，供**登录页与首屏**在云端数据回来之前
   *     就把皮肤铺好（否则每次打开都会先用默认皮肤闪一下再跳成你选的那套）。
   *
   * 另外给 <html> 挂一个 420ms 的过渡标记：不加它整页会「啪」地一下换色；
   * 加成常驻 transition 又会拖慢列表滚动。所以只在切换的这一小会儿打开。
   */
  const setSkin = useCallback((id: SkinId) => {
    const root = document.documentElement;
    root.setAttribute('data-skin-transition', '');
    window.clearTimeout(skinTransTimer.current);
    skinTransTimer.current = window.setTimeout(() => root.removeAttribute('data-skin-transition'), 420);
    setSkinState(id);
    setThemeState(skinDef(id).theme);
    writeSavedSkin(id);
  }, []);

  /** 明暗不单独开关 —— 每款皮肤自带基调，「想换明暗」= 换另一款皮肤。
   *  原先这里是 setTheme / toggleTheme 一对，只在 switchable（极光玻璃）下有效，
   *  顶栏和设置页那两个按钮都是它们的入口。已整体删除：一个只对一款皮肤成立的开关
   *  放在顶栏上，对另外几款皮肤的用户就是纯粹的噪音。
   *  如果以后真要加回来，记住入口必须在**皮肤市场**（那里能同时看到两档明暗），
   *  而不是顶栏。 */

  const setSingle = useCallback((section: string, key: string, value: string) => {
    setProfile((p) => ({ ...p, single: { ...p.single, [section]: { ...p.single[section], [key]: value } } }));
  }, []);
  const updateMulti = useCallback((section: string, idx: number, patch: Partial<Rec>) => {
    setProfile((p) => {
      const arr = [...(p.multi[section] || [])];
      arr[idx] = { ...arr[idx], ...patch } as Rec;
      return { ...p, multi: { ...p.multi, [section]: arr } };
    });
  }, []);
  const addMulti = useCallback((section: string, rec?: Rec) => {
    setProfile((p) => {
      const arr = [...(p.multi[section] || []), rec ?? applyFixed({})];
      return { ...p, multi: { ...p.multi, [section]: arr } };
    });
  }, []);
  const removeMulti = useCallback((section: string, idx: number) => {
    setProfile((p) => ({ ...p, multi: { ...p.multi, [section]: (p.multi[section] || []).filter((_, i) => i !== idx) } }));
  }, []);

  const addApp = useCallback((a: Partial<Application>): Application => {
    const app: Application = {
      id: a.id || uid('app'),
      company: a.company || '未命名公司',
      position: a.position || '岗位',
      status: a.status || 'todo',
      channel: a.channel, location: a.location, deadline: a.deadline,
      link: a.link, salary: a.salary, notes: a.notes, contact: a.contact,
      submittedAt: a.submittedAt,
      createdAt: todayISO(), updatedAt: todayISO(),
      timeline: a.timeline || [{ status: a.status || 'todo', at: todayISO() }],
    };
    const nextApps = [app, ...appsRef.current];
    appsRef.current = nextApps;
    setApplications(nextApps);
    runReconcile(jobsRef.current, nextApps, setJobs, toast, {}, jobsRef);
    return app;
  }, [toast]);
  const updateApp = useCallback((id: string, patch: Partial<Application>) => {
    const nextApps = appsRef.current.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: todayISO() } : a));
    appsRef.current = nextApps;
    setApplications(nextApps);
    /* 兜底：任何经 updateApp 改到状态的路径（历史代码、第三方入口）也要触发岗位库对账，
       否则又回到「投递改了、岗位卡没变」的老问题。 */
    if (patch.status) runReconcile(jobsRef.current, nextApps, setJobs, toast, { silent: true }, jobsRef);
  }, [toast]);
  /**
   * 更新投递状态，并**双向联动岗位库**：
   * 进入「已提交/笔试/面试/Offer」→ 对应岗位标记为「已投递」（截止提醒随之停止）；
   * 退回「待投递/填写中」→ 当初由这条投递同步成的「已投递」撤回为「感兴趣」（提醒重新开启）。
   *
   * 联动不再在本函数里手写匹配，而是把**改完之后的完整投递列表**交给 planReconcile 推导目标状态：
   * 这样「同一单位多个岗位」「单位名写法不同」「岗位名对不上」等边缘情形由同一套规则处理，
   * 也不会因为某次改动漏了同步而在后面几轮里一直陈旧下去。
   */
  const setStatus = useCallback((id: string, status: AppStatus, note?: string) => {
    const target = appsRef.current.find((a) => a.id === id);
    if (!target) return;
    const nextApps = appsRef.current.map((a) => {
      if (a.id !== id) return a;
      return {
        ...a, status,
        timeline: [...a.timeline, { status, at: todayISO(), note }],
        updatedAt: todayISO(),
        submittedAt: status === 'submitted' ? todayISO() : a.submittedAt,
      };
    });
    appsRef.current = nextApps;
    setApplications(nextApps);
    runReconcile(jobsRef.current, nextApps, setJobs, toast, {}, jobsRef);
  }, [toast]);
  /**
   * 删除投递记录，并**把当初由它同步成「已投递」的岗位退回去**。
   *
   * 原先这里只删数组、不对账：岗位卡永远停在「已投递」，`appliedBy` 还指向一条不存在的记录，
   * 于是该岗位的截止提醒被永久静音（实测：删掉工行那条投递后，岗位仍是 applied，
   * 提醒条里再也看不到它）。删除同样是一次状态变更，必须走同一条收口。
   */
  const removeApp = useCallback((id: string) => {
    const nextApps = appsRef.current.filter((a) => a.id !== id);
    appsRef.current = nextApps;
    setApplications(nextApps);
    runReconcile(jobsRef.current, nextApps, setJobs, toast, { silent: true }, jobsRef);
  }, [toast]);

  const addEvent = useCallback((e: Partial<CalEvent>): CalEvent => {
    const ev: CalEvent = {
      id: e.id || uid('ev'), title: e.title || '新事件', date: e.date || todayISO(),
      time: e.time, type: e.type || 'other', appId: e.appId, note: e.note,
      source: e.source || 'manual', done: e.done,
    };
    setEvents((xs) => [...xs, ev]);
    return ev;
  }, []);
  /**
   * 批量新增日历事件，并按「日期 + 归一化标题」去重。
   *
   * 原先直接 append：同一份汇总表导入两次就会写出两份**标题完全相同**的截止事件，
   * 提醒条里于是出现两行一模一样的「截止 · XX · …」（实测某次数据里 25 条事件各存了两份）。
   * 这里同时与既有事件和本批次内部比对，重复的一律不再写入。返回值=实际新增条数。
   */
  const addEvents = useCallback((list: Partial<CalEvent>[]): number => {
    const keyOf = (title: string, date: string) => `${date}|${normTitle(title)}`;
    const seen = new Set(events.map((e) => keyOf(e.title, e.date)));
    const items: CalEvent[] = [];
    for (const e of list) {
      if (!(e.date || '').trim()) continue;
      const title = e.title || '新事件';
      const date = String(e.date);
      const k = keyOf(title, date);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({
        id: uid('ev'), title, date,
        time: e.time, type: e.type || 'other', appId: e.appId, note: e.note,
        source: e.source || 'manual', done: false,
      });
    }
    if (items.length) setEvents((xs) => [...xs, ...items]);
    return items.length;
  }, [events]);
  const updateEvent = useCallback((id: string, patch: Partial<CalEvent>) => {
    setEvents((xs) => xs.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);
  const removeEvent = useCallback((id: string) => setEvents((xs) => xs.filter((e) => e.id !== id)), []);

  const addJob = useCallback((j: Partial<JobPosting>): JobPosting => {
    const job: JobPosting = {
      id: j.id || uid('job'),
      company: j.company || '未命名公司',
      title: j.title || '岗位',
      city: j.city, salary: j.salary, source: j.source, url: j.url,
      jd: j.jd, requirements: j.requirements, deadline: j.deadline, match: j.match,
      status: j.status || 'new',
      createdAt: todayISO(), updatedAt: todayISO(),
    };
    setJobs((xs) => [job, ...xs]);
    return job;
  }, []);

  /**
   * 批量导入岗位：同一「单位 + 岗位」视为同一条，只更新截止日/链接等字段，不重复堆积。
   *
   * 判重口径与「清理重复」保持一致（`sameCompany` + `normTitle`），并先把源表带来的装饰标记
   * （🆕⭐❗…）剥掉再入库。原先按「单位与岗位名完全相等」判重，结果汇总表每轮把条目标成
   * 「吉林银行 🆕」都会新增一条重复岗位，越导越乱；导入后还会立刻对账一次，
   * 避免新导入的岗位卡停在「新岗位」而该单位其实早已投递。
   */
  const addJobs = useCallback((list: Partial<JobPosting>[]) => {
    let added = 0, updated = 0;
    const next = [...jobsRef.current];
    for (const raw of list) {
      if (!raw.company) continue;
      const j: Partial<JobPosting> = {
        ...raw,
        company: stripDecor(raw.company),
        title: stripDecor(raw.title) || '岗位',
      };
      const nj = normTitle(j.title);
      const sameCo = next.filter((x) => sameCompanyStem(x.company, j.company));
      /* 1) 归一化岗位名相同；2) 泛化标题（「2027 校招」）与该公司唯一岗位视为同一条；
         3) 双方都是泛化标题也视为同一条。岗位名具体且不同时按新岗位追加，不误并。 */
      let hit = sameCo.find((x) => !!nj && normTitle(x.title) === nj);
      if (!hit && !nj && sameCo.length === 1) hit = sameCo[0];
      if (!hit && !nj) hit = sameCo.find((x) => !normTitle(x.title));
      if (hit) {
        const i = next.indexOf(hit);
        /* 不覆盖已有的人工字段：只在导入值非空时更新 */
        const merged: JobPosting = { ...hit, id: hit.id, createdAt: hit.createdAt, updatedAt: todayISO() };
        for (const [k, v] of Object.entries(j)) {
          if (v === undefined || v === '' || k === 'status') continue;
          /* `match` 特别处理：导入草稿现在带的是**规则分**（by: 'rule'），
             而 `hit.match` 可能是用户手工点出来的 AI 分 / 关键词分。
             两者量的不是同一件事 —— 规则分=「这个机会值不值得投」，人工分=「我这个人合不合」，
             后者更晚、更贵、信息更全。每天自动同步都会重扫整份汇总表，
             若不拦住，用户的手工评估会在下一次同步时被静默冲掉。
             规则分之间可以互相刷新（口径会演进），人工分一律保留。 */
          if (k === 'match') {
            const cur = hit.match;
            if (cur && cur.by !== 'rule') continue;
          }
          (merged as unknown as Record<string, unknown>)[k] = v;
        }
        next[i] = merged;
        updated++;
      } else {
        /* 用展开，而**不是逐字段白名单**。
           原来是手写的字段列表，漏一个就永久丢一个 —— 实际就漏掉了
           `match`（规则分 + S/A/B/C 分档）、`track`（招聘线）、`exam`（笔试信息）：
           导入预览里看得到、一入库就没了，而且不报任何错。
           这是「字段级静默丢失」最难查的形态，所以改掉做法本身，而不是补字段。
           只钉死由 store 负责的 4 个字段（id / status / 两个时间戳），其余整份草稿带过来。 */
        next.unshift({
          ...j,
          id: uid('job'),
          company: j.company!,
          title: j.title || '岗位',
          status: j.status || 'new',
          createdAt: todayISO(),
          updatedAt: todayISO(),
        });
        added++;
      }
    }
    jobsRef.current = next;
    setJobs(next);
    if (added) runReconcile(next, appsRef.current, setJobs, toast, { silent: true }, jobsRef);
    return { added, updated };
  }, [toast]);
  const updateJob = useCallback((id: string, patch: Partial<JobPosting>) => {
    setJobs((xs) => xs.map((j) => (j.id === id ? { ...j, ...patch, updatedAt: todayISO() } : j)));
  }, []);
  const removeJob = useCallback((id: string) => setJobs((xs) => xs.filter((j) => j.id !== id)), []);

  const addQuestion = useCallback((q: Partial<Question>): Question => {
    const item: Question = {
      id: q.id || uid('q'), kind: q.kind || 'written', category: q.category || '其他',
      content: q.content || '', answer: q.answer, analysis: q.analysis,
      company: q.company, year: q.year, difficulty: q.difficulty, mastered: q.mastered,
      bankId: q.bankId, catId: q.catId,
      groupId: q.groupId, groupTitle: q.groupTitle, order: q.order,
      createdAt: todayISO(),
    };
    setQuestions((xs) => [item, ...xs]);
    return item;
  }, []);
  const addQuestions = useCallback((qs: Partial<Question>[]): number => {
    const items: Question[] = qs.filter((q) => (q.content || '').trim()).map((q) => ({
      id: uid('q'), kind: q.kind || 'written', category: q.category || '其他',
      content: q.content || '', answer: q.answer, analysis: q.analysis,
      company: q.company, year: q.year, difficulty: q.difficulty, mastered: false,
      bankId: q.bankId, catId: q.catId,
      groupId: q.groupId, groupTitle: q.groupTitle, order: q.order,
      createdAt: todayISO(),
    }));
    if (items.length) setQuestions((xs) => [...items, ...xs]);
    return items.length;
  }, []);
  const updateQuestion = useCallback((id: string, patch: Partial<Question>) => {
    setQuestions((xs) => xs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }, []);
  const removeQuestion = useCallback((id: string) => setQuestions((xs) => xs.filter((q) => q.id !== id)), []);
  const removeQuestions = useCallback((ids: string[]): number => {
    const set = new Set(ids);
    if (!set.size) return 0;
    setQuestions((xs) => xs.filter((q) => !set.has(q.id)));
    return set.size;
  }, []);

  /* ---- 题组（一场面试 / 一套卷） ----
     题组的元数据冗余在每道题上（见 types.ts 的 groupId 注释），所以这几个动作
     全都是「按 groupId 批量改写题」，不涉及任何新容器或新存储键。 */
  const addQuestionSet = useCallback((title: string, qs: Partial<Question>[], target?: { bankId?: string; catId?: string }) => {
    const groupId = uid('qset');
    const t = (title || '').trim();
    const items: Question[] = qs.filter((q) => (q.content || '').trim()).map((q, i) => ({
      id: uid('q'), kind: q.kind || 'written', category: q.category || '其他',
      content: (q.content || '').trim(), answer: q.answer, analysis: q.analysis,
      company: q.company, year: q.year, difficulty: q.difficulty, mastered: false,
      bankId: target?.bankId ?? q.bankId, catId: target?.catId ?? q.catId,
      groupId, groupTitle: t || undefined, order: i,
      createdAt: todayISO(),
    }));
    if (items.length) setQuestions((xs) => [...items, ...xs]);
    return { groupId, added: items.length };
  }, []);
  const reorderGroup = useCallback((groupId: string, orderedIds: string[]) => {
    const pos = new Map(orderedIds.map((id, i) => [id, i]));
    setQuestions((xs) => xs.map((q) => (q.groupId === groupId && pos.has(q.id) ? { ...q, order: pos.get(q.id) } : q)));
  }, []);
  const renameGroup = useCallback((groupId: string, title: string) => {
    const t = (title || '').trim();
    setQuestions((xs) => xs.map((q) => (q.groupId === groupId ? { ...q, groupTitle: t || undefined } : q)));
  }, []);
  /** 解散题组：只是摘掉 groupId，题一道不删（组是视图单位，题才是资产） */
  const dissolveGroup = useCallback((groupId: string) => {
    setQuestions((xs) => xs.map((q) => (q.groupId !== groupId ? q
      : { ...q, groupId: undefined, groupTitle: undefined, order: undefined })));
  }, []);
  const mergeIntoGroup = useCallback((title: string, ids: string[]): string => {
    const groupId = uid('qset');
    const t = (title || '').trim();
    const pos = new Map(ids.map((id, i) => [id, i]));
    setQuestions((xs) => xs.map((q) => (pos.has(q.id) ? { ...q, groupId, groupTitle: t || undefined, order: pos.get(q.id) } : q)));
    return groupId;
  }, []);

  /* ---- 题库分类（赛道） ---- */
  const addCategory = useCallback((c: Partial<BankCategory>): BankCategory => {
    const maxOrder = Math.max(0, ...bankCategoriesRef.current.map((x) => x.order || 0));
    const item: BankCategory = {
      id: c.id || uid('cat'), name: (c.name || '').trim() || '未命名分类',
      order: c.order ?? Math.min(maxOrder + 10, 900), presets: false, createdAt: todayISO(),
    };
    setBankCategories((xs) => [...xs, item]);
    return item;
  }, []);
  const updateCategory = useCallback((id: string, patch: Partial<BankCategory>) => {
    setBankCategories((xs) => xs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);
  const removeCategory = useCallback((id: string) => {
    /* 分类是容器不是资产：删掉分类不删库、更不删题，一律搬到「其他」 */
    const fallback = FALLBACK_CAT_ID;
    if (id === fallback) return;
    setBankCategories((xs) => xs.filter((c) => c.id !== id));
    setBanks((xs) => xs.map((b) => (b.catId === id ? { ...b, catId: fallback, updatedAt: todayISO() } : b)));
    setQuestions((xs) => xs.map((q) => (q.catId === id ? { ...q, catId: fallback } : q)));
  }, []);

  /* ---- 题库仓库 ---- */
  const addBank = useCallback((b: Partial<QuestionBank>): QuestionBank => {
    const item: QuestionBank = {
      id: b.id || uid('bank'), name: (b.name || '').trim() || '未命名仓库',
      catId: b.catId || FALLBACK_CAT_ID, note: b.note, createdAt: todayISO(), updatedAt: todayISO(),
    };
    setBanks((xs) => [item, ...xs]);
    return item;
  }, []);
  const updateBank = useCallback((id: string, patch: Partial<QuestionBank>) => {
    setBanks((xs) => xs.map((b) => (b.id === id ? { ...b, ...patch, updatedAt: todayISO() } : b)));
    /* 仓库换分类时，库里的题必须跟着换 —— 否则「按分类看全部题」会漏掉它们 */
    if (patch.catId) {
      setQuestions((xs) => xs.map((q) => (q.bankId === id ? { ...q, catId: patch.catId } : q)));
    }
  }, []);
  const removeBank = useCallback((id: string) => {
    setBanks((xs) => xs.filter((b) => b.id !== id));
    /* 只解绑、不删题：仓库是「视图容器」，题目本身是用户资产。
       题回到「未归档」但保留原分类，用户仍能在原分类下找到它们。 */
    setQuestions((xs) => xs.map((q) => (q.bankId === id ? { ...q, bankId: undefined } : q)));
  }, []);
  const assignQuestions = useCallback((ids: string[], bankId?: string, catId?: string): number => {
    const set = new Set(ids);
    if (!set.size) return 0;
    let n = 0;
    setQuestions((xs) => xs.map((q) => {
      if (!set.has(q.id) || (q.bankId === bankId && (!catId || q.catId === catId))) return q;
      n++;
      return { ...q, bankId, ...(catId ? { catId } : {}) };
    }));
    return n;
  }, []);

  const upsertCompany = useCallback((company: string, patch: Partial<CompanyProfile>): CompanyProfile => {
    const list = companiesRef.current;
    const i = list.findIndex((c) => c.company === company);
    const saved: CompanyProfile = i >= 0
      ? { ...list[i], ...patch, company, updatedAt: todayISO() }
      : { id: uid('co'), company, ...patch, updatedAt: todayISO() };
    const next = i >= 0 ? list.map((c, k) => (k === i ? saved : c)) : [saved, ...list];
    companiesRef.current = next;
    setCompanies(next);
    return saved;   // 同步返回真正落库的对象（原先在 setState 的 updater 里赋值，调用方拿到的是未合并的占位对象）
  }, []);
  const removeCompany = useCallback((id: string) => setCompanies((xs) => xs.filter((c) => c.id !== id)), []);

  /* ---------- Offers ---------- */
  const addOffer = useCallback((o: Partial<Offer>): Offer => {
    const item: Offer = {
      id: o.id || uid('off'), company: o.company || '未命名公司', position: o.position || '岗位',
      status: o.status || 'considering',
      city: o.city, team: o.team, baseMonthly: o.baseMonthly, months: o.months, bonus: o.bonus,
      allowance: o.allowance, signingBonus: o.signingBonus, totalPackage: o.totalPackage,
      socialInsurance: o.socialInsurance, hukou: o.hukou, penalty: o.penalty,
      signDeadline: o.signDeadline, onboardDate: o.onboardDate,
      pros: o.pros, cons: o.cons, rating: o.rating, weight: o.weight ?? 1,
      appId: o.appId, notes: o.notes,
      createdAt: todayISO(), updatedAt: todayISO(),
    };
    setOffers((xs) => [item, ...xs]);
    return item;
  }, []);
  const updateOffer = useCallback((id: string, patch: Partial<Offer>) => {
    setOffers((xs) => xs.map((o) => (o.id === id ? { ...o, ...patch, updatedAt: todayISO() } : o)));
  }, []);
  const removeOffer = useCallback((id: string) => setOffers((xs) => xs.filter((o) => o.id !== id)), []);

  /* ---------- Interviews ---------- */
  const addInterview = useCallback((i: Partial<InterviewLog>): InterviewLog => {
    const item: InterviewLog = {
      id: i.id || uid('iv'), company: i.company || '未命名公司', position: i.position,
      round: i.round || '一面', date: i.date || todayISO(), time: i.time, format: i.format,
      interviewers: i.interviewers, durationMin: i.durationMin,
      questions: i.questions || [], selfReview: i.selfReview, improvements: i.improvements,
      result: i.result || 'pending', mood: i.mood, appId: i.appId, jobId: i.jobId,
      createdAt: todayISO(), updatedAt: todayISO(),
    };
    setInterviews((xs) => [item, ...xs]);
    return item;
  }, []);
  const updateInterview = useCallback((id: string, patch: Partial<InterviewLog>) => {
    setInterviews((xs) => xs.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: todayISO() } : i)));
  }, []);
  const removeInterview = useCallback((id: string) => setInterviews((xs) => xs.filter((i) => i.id !== id)), []);

  /* ---------- Materials ---------- */
  const addMaterial = useCallback((m: Partial<MaterialItem>): MaterialItem => {
    const item: MaterialItem = {
      id: m.id || uid('mat'), group: m.group || '其他', name: m.name || '新材料',
      note: m.note, path: m.path, done: m.done ?? false, needScan: m.needScan,
      updatedAt: todayISO(),
    };
    setMaterials((xs) => [...xs, item]);
    return item;
  }, []);
  const importMaterials = useCallback((items: Partial<MaterialItem>[]): number => {
    const list: MaterialItem[] = items.filter((m) => (m.name || '').trim()).map((m) => ({
      id: uid('mat'), group: m.group || '其他', name: String(m.name), note: m.note,
      path: m.path, done: false, needScan: m.needScan, updatedAt: todayISO(),
    }));
    if (list.length) setMaterials((xs) => [...xs, ...list]);
    return list.length;
  }, []);
  const updateMaterial = useCallback((id: string, patch: Partial<MaterialItem>) => {
    setMaterials((xs) => xs.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: todayISO() } : m)));
  }, []);
  const removeMaterial = useCallback((id: string) => setMaterials((xs) => xs.filter((m) => m.id !== id)), []);

  /* ---------- Resume versions ---------- */
  const addVersion = useCallback((v: Partial<ResumeVersion>): ResumeVersion => {
    const item: ResumeVersion = {
      id: v.id || uid('ver'), name: v.name || '新版本', target: v.target,
      focus: v.focus, highlights: v.highlights, usedFor: v.usedFor || [], fileName: v.fileName,
      updatedAt: todayISO(),
    };
    setVersions((xs) => [item, ...xs]);
    return item;
  }, []);
  const updateVersion = useCallback((id: string, patch: Partial<ResumeVersion>) => {
    setVersions((xs) => xs.map((v) => (v.id === id ? { ...v, ...patch, updatedAt: todayISO() } : v)));
  }, []);
  const removeVersion = useCallback((id: string) => setVersions((xs) => xs.filter((v) => v.id !== id)), []);

  /* ---------- Contacts ---------- */
  const addContact = useCallback((c: Partial<Contact>): Contact => {
    const item: Contact = {
      id: c.id || uid('ct'), name: c.name || '未命名联系人', company: c.company, role: c.role,
      relation: c.relation, wechat: c.wechat, email: c.email, phone: c.phone,
      lastContact: c.lastContact, nextFollowUp: c.nextFollowUp, promised: c.promised, notes: c.notes,
      createdAt: todayISO(), updatedAt: todayISO(),
    };
    setContacts((xs) => [item, ...xs]);
    return item;
  }, []);
  const updateContact = useCallback((id: string, patch: Partial<Contact>) => {
    setContacts((xs) => xs.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: todayISO() } : c)));
  }, []);
  const removeContact = useCallback((id: string) => setContacts((xs) => xs.filter((c) => c.id !== id)), []);

  const setRemind = useCallback((patch: Partial<RemindConfig>) => {
    setRemindState((r) => ({ ...r, ...patch }));
  }, []);

  const setResumeText = useCallback((t: string) => setResumeTextState(t), []);

  const exportAll = useCallback(() => JSON.stringify({
    _v: DATA_VERSION, profile, applications, events, theme, skin, resumeText,
    jobs, questions, banks, bankCategories, companies, offers, interviews, materials, versions, contacts, remind,
    exportedAt: new Date().toISOString(),
  }, null, 2), [profile, applications, events, theme, skin, resumeText, jobs, questions, banks, bankCategories,
                companies, offers, interviews, materials, versions, contacts, remind]);

  const importAll = useCallback((json: string) => {
    try {
      const raw = JSON.parse(json) as Record<string, unknown>;
      const d = migrate(raw);
      if (d.profile) setProfile(migrateProfile(d.profile));
      if (d.applications) setApplications(d.applications);
      if (d.events) setEvents(d.events);
      if (d.theme) setThemeState(d.theme);
      /* 皮肤放最后：setSkin 会连带把 theme 校正成该皮肤自带的基调。
         顺序反过来的话，导入包里的 theme 会把皮肤的基调又覆盖回去。 */
      if (d.skin) setSkin(skinDef(d.skin).id);
      if (d.resumeText != null) setResumeTextState(d.resumeText);
      if (d.jobs) setJobs(d.jobs);
      if (d.questions) setQuestions(d.questions);
      if (d.banks) setBanks(d.banks);
      if (d.bankCategories) setBankCategories(d.bankCategories);
      if (d.companies) setCompanies(d.companies);
      if (d.offers) setOffers(d.offers);
      if (d.interviews) setInterviews(d.interviews);
      if (d.materials) setMaterials(d.materials);
      if (d.versions) setVersions(d.versions);
      if (d.contacts) setContacts(d.contacts);
      if (d.remind) setRemindState({ ...DEFAULT_REMIND, ...d.remind });
      /* 覆盖导入后立刻对账：导入进来的岗位状态可能与投递记录不一致（例如导入包是在
         某次投递之前导出的），不在这里对齐就会一直陈旧到下次刷新页面。 */
      const nj = (d.jobs as JobPosting[]) ?? [];
      const na = (d.applications as Application[]) ?? [];
      jobsRef.current = nj; appsRef.current = na;
      runReconcile(nj, na, setJobs, toast, { silent: true }, jobsRef);
      return true;
    } catch { return false; }
  }, [toast, setSkin]);

  /**
   * 合并导入（推荐）：只补空缺、按标识去重追加。
   * 用途：把「本机真实资料还原包」补进网站，而**不会**覆盖你已填写/编辑过的内容，
   * 也不会清空投递记录、岗位、面试等数据（要整表替换请用 importAll）。
   * 具体合并规则见 lib/merge.ts（纯函数，可独立测试）。
   */
  const importMerge = useCallback((json: string): { ok: boolean; detail: string[] } => {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return { ok: false, detail: ['文件不是合法的 JSON 备份'] }; }
    const d = migrate(parsed as Record<string, unknown>);
    const { patch, detail } = mergeSnapshot(
      { profile, applications, jobs, questions, banks, bankCategories, companies, events, offers, interviews, materials, versions, contacts, resumeText },
      d,
    );
    if (patch.profile) setProfile(patch.profile);
    if (patch.applications) { appsRef.current = patch.applications; setApplications(patch.applications); }
    if (patch.jobs) { jobsRef.current = patch.jobs; setJobs(patch.jobs); }
    if (patch.questions) setQuestions(patch.questions);
    if (patch.banks) setBanks(patch.banks);
    if (patch.bankCategories) setBankCategories(patch.bankCategories);
    if (patch.companies) setCompanies(patch.companies);
    if (patch.events) setEvents(patch.events);
    if (patch.offers) setOffers(patch.offers);
    if (patch.interviews) setInterviews(patch.interviews);
    if (patch.materials) setMaterials(patch.materials);
    if (patch.versions) setVersions(patch.versions);
    if (patch.contacts) setContacts(patch.contacts);
    if (patch.resumeText) setResumeTextState(patch.resumeText);
    /* 合并导入同样是对账入口：补进来的投递记录若已提交，对应岗位必须立刻标为「已投递」，
       否则岗位卡与截止提醒停在旧状态，直到下次启动对账才自愈（本轮已修：原先这里漏了对账）。 */
    if (patch.applications || patch.jobs) {
      runReconcile(jobsRef.current, appsRef.current, setJobs, toast, { silent: true }, jobsRef);
    }
    return { ok: true, detail };
  }, [profile, applications, jobs, questions, banks, bankCategories, companies, events, offers, interviews, materials, versions, contacts, resumeText, toast]);

  /** 手动触发全局对账（岗位追踪页「对账」入口） */
  const reconcileNow = useCallback((opts?: { createMissing?: boolean; silent?: boolean }) => {
    const plan = planReconcile(jobsRef.current, appsRef.current, { createMissing: opts?.createMissing !== false });
    if (plan.jobStatus.length || plan.jobsToCreate.length) runReconcile(jobsRef.current, appsRef.current, setJobs, toast, { silent: true }, jobsRef);
    const summary = summarizeReconcile(plan);
    if (!opts?.silent && summary.length) toast(`对账完成：${summary.join('；')}`, 'info');
    return { plan, summary };
  }, [toast]);

  /* ---------- 启动自动同步：坚果云汇总表 → 岗位库 / 日历 ----------
     数据链路的前半段（桌面总档案 → 坚果云）由发布桥自动完成，最后一段原先要人工
     点「从坚果云同步 → 预览 → 确认」。这里把它接进启动流程：内容没变就零打扰跳过，
     变了则走同一套解析管线增量入库，并给一条带「撤销本次同步」的提示 + 写入前快照。 */
  const autoSyncRef = useRef(false);
  const syncFailNotifiedRef = useRef(false);   // 自动同步失败每会话只提醒一次
  useEffect(() => {
    if (autoSyncRef.current) return;
    autoSyncRef.current = true;

    /* 1) 折叠「同日期 + 同标题」的重复日程（重复导入留下的纯冗余，无判别歧义） */
    const collapsed = collapseDuplicateEvents(events);
    if (collapsed.removed > 0) {
      setEvents(collapsed.events);
      toast(`已自动清理 ${collapsed.removed} 条重复日程（同日期同标题）`, 'info');
    }

    /* 2) 自动拉取汇总表并增量导入 */
    if (!isAutoSyncOn()) return;
    void (async () => {
      const pulled = await pullSyncDoc();
      if (!pulled.ok) {
        /* 落盘记一次失败 —— 这是「同步没在跑却悄无声息」的补丁。
           原先只在内存里用一个 ref 控制「每会话弹一次」，刷新页面就没了：
           用户既看不到「上次同步是什么时候」，也看不到「为什么没同步」，
           于是把「链路早就断了」理解成「网站没有新信息」。 */
        markSyncFail(pulled.error);
        /* 静默优先：没配网盘属正常情况，不打扰；已配置却失败（凭据失效/路径错）则每会话提醒一次。 */
        if (!syncFailNotifiedRef.current && !/未配置/.test(pulled.error)) {
          syncFailNotifiedRef.current = true;
          toast(`自动同步未成功：${pulled.error}（可在「设置 → 数据与备份 → 网盘同步」检查账号与应用密码）`, 'info', 12000);
        }
        return;
      }
      /* 拉到了就记一次「链路通」，与「内容有没有变」无关。
         没有这一笔的话，一份几天没更新的汇总表会让界面显示成「上次同步：3 天前」，
         和「同步坏了」完全同形 —— 见 autosync.ts 里 markSyncOk 的注释。 */
      markSyncOk();
      const h = hashText(pulled.text);
      if (h === lastSyncHash()) return;                           // 内容没变 → 零打扰
      const parsed = parseSyncDoc(pulled.text);
      if (!parsed.drafts.length && !parsed.events.length) {
        /* 文件读到了，却一条岗位/日程都解析不出来。这是一条**真问题**，不能静默返回：
           文件名对了、内容可能被改坏（或整份都被追踪口径排除），
           外观上和「链路根本没跑」一模一样，必须留下痕迹。
           注意这里不 markSynced —— 不记哈希，下次启动还会重试。 */
        markSyncFail('已拉到汇总表，但没能解析出任何岗位或日程（文件可能被改坏，或内容全被追踪口径排除）');
        toast('自动同步：拉到了汇总表但解析不出任何岗位 —— 文件可能不完整，建议到「设置 → 数据与备份」手动同步一次看预览', 'info', 12000);
        return;
      }

      const before = exportAll();
      const { added, updated } = addJobs(parsed.drafts);
      const evN = addEvents(parsed.events);
      const changed = !!(added || updated || evN);

      if (!changed) {
        /* 文件内容变了，但解析出来的条目库里**全都有**（重复导入，或上游只改了排版）。
           哈希必须记 —— 不记的话每次启动都会把这份大文件重新解析一遍；
           但「上次有更新」不能被刷新成现在，那会把「最近一次真的进过新数据」的时间抹掉。 */
        markFileChanged(h);
        if (pulled.pathCorrected) toast(`自动同步：汇总表有变化但条目库里都已存在（顺便修正网盘路径：${pulled.path}）`, 'info');
        return;
      }

      markSynced(h, `+${added} 岗位 · 更新 ${updated} · ${evN} 日程`);
      rememberPreSync(before);
      saveSnapshot(storageKey, before, 'bak');
      /* 分档摘要：只报「这一批新进来的」里 S/A 有几条，不是整库。
         这是「重要岗位放出要做明显提示」的落点之一 —— 属于提示但不弹窗。 */
      const tierN: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
      for (const d of parsed.drafts) { const t = d.match?.tier; if (t) tierN[t]++; }
      const tierText = (['S', 'A', 'B', 'C'] as const).filter((t) => tierN[t]).map((t) => `${t} ${tierN[t]}`).join(' · ');
      toast(
        `已自动从坚果云同步：新增岗位 ${added} 条、更新 ${updated} 条`
        + `${evN ? `、日程 ${evN} 条` : ''}`
        + `${parsed.notes.length ? `（另有 ${parsed.notes.length} 行说明只进日历）` : ''}`
        + `${tierText ? `｜本批分档 ${tierText}` : ''}`
        + `${parsed.rejected.length ? `｜按追踪口径排除 ${parsed.rejected.length} 条（律所／外地地方国企／非大厂民营等）` : ''}`
        + `${pulled.pathCorrected ? `｜顺便修正了网盘路径：${pulled.path}` : ''}`,
        'ok', 12000,
        {
          label: '撤销本次同步',
          run: () => { const raw = prevSyncRaw(); if (raw && importAll(raw)) toast('已撤销本次自动同步', 'info'); },
        },
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 清空全部数据。
   *
   * 注意两个容易漏的点：
   *  ① `resumeText`（简历备注文本）也是用户内容，早期实现漏了它，于是「清空全部数据」之后
   *    那段文字还留在库里、并且照样同步到云端；
   *  ② 主题（theme）是**偏好**不是数据，不清 —— 清空数据不该顺带把用户选的深/浅色改回去。
   */
  const resetAll = useCallback(() => {
    const e = emptyData();
    setProfile(e.profile); setApplications([]); setEvents([]);
    setJobs([]); setQuestions([]); setCompanies([]);
    setBanks([]); setBankCategories(defaultCategories());
    setOffers([]); setInterviews([]); setMaterials([]); setVersions([]); setContacts([]);
    setResumeTextState(undefined);
    setRemindState({ ...DEFAULT_REMIND });
  }, []);

  const value: Store = {
    profile, applications, events, theme, skin, resumeText, view, setView,
    storageKey, userId, cloud, pushToCloud, enableCloud,
    toasts, toast, dismissToast, setSkin,
    setSingle, updateMulti, addMulti, removeMulti,
    addApp, updateApp, setStatus, removeApp,
    addEvent, addEvents, updateEvent, removeEvent, setResumeText,
    jobs, addJob, addJobs, updateJob, removeJob,
    questions, addQuestion, addQuestions, updateQuestion, removeQuestion, removeQuestions,
    addQuestionSet, reorderGroup, renameGroup, dissolveGroup, mergeIntoGroup,
    banks, bankCategories, addCategory, updateCategory, removeCategory,
    addBank, updateBank, removeBank, assignQuestions,
    companies, upsertCompany, removeCompany,
    offers, addOffer, updateOffer, removeOffer,
    interviews, addInterview, updateInterview, removeInterview,
    materials, addMaterial, updateMaterial, removeMaterial, importMaterials,
    versions, addVersion, updateVersion, removeVersion,
    contacts, addContact, updateContact, removeContact,
    remind, setRemind,
    exportAll, importAll, importMerge, reconcileNow, resetAll,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}


/* 岗位匹配与「已提交及以后」的判定已统一收口到 lib/reconcile.ts：
 * 原先这里的 isSamePosting（单位用 sameCompany）与提醒层的 sameCompanyLoose 是两套口径，
 * 会出现「提醒停了、岗位卡没变」。现在两边都走 reconcile 的 matchJobsForApp。 */

function applyFixed(rec: Rec): Rec {
  const out = { ...rec };
  for (const [k, v] of Object.entries(FIXED_VALUES)) if (out[k] === undefined) out[k] = v;
  return out;
}

export function useStore(): Store {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStore must be used within StoreProvider');
  return c;
}
