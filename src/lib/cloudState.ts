/**
 * 云端状态文档 —— 整站数据与 Supabase 之间的唯一出入口。
 *
 * ## 为什么是一份 JSON 文档而不是 7 张表
 * 旧版把 profile / applications / events / jobs / questions / companies / app_state 拆成 7 张表，
 * 每次保存都要「先把该表全删、再全插回去」。这套写法有三个必然的坑：
 *   ① 请求非原子：7 轮里第 3 轮失败，云端就停在「投递删了、岗位卡还在」的半同步状态；
 *   ② 空数组也能删：某次加载失败导致内存里是空数组，下一轮保存就把云端数据整表抹掉；
 *   ③ 无法回滚：改一条也要重写全表，没有任何版本可退回。
 * 现在整站状态序列化成一份 JSON 存进 `profiles.data`（jsonb + `UNIQUE(user_id)`），
 * 一次 upsert 原子落盘，配合本机 localStorage 缓存与快照，任意一端损坏都能恢复。
 *
 * ## 数据演进
 * 文档带 `_v` 版本号。旧版云端（profiles.data 直接存 ProfileData + 6 张分表）在首次读取时
 * 会被 `migrateLegacy()` 一次性折算成新文档 —— **只补不改，不丢任何既有数据**。
 */
import { supabase } from './supabase';

/**
 * ⚠️ 这个常量**不是** store.tsx 的 DATA_VERSION，别再想着「对齐」它们 —— 两者语义不同：
 *   · store 的 DATA_VERSION 是**整站数据 schema** 的版本（当前 6）；
 *   · 这个常量只在 `migrateLegacy()` 里用到：它是「旧版 7 张分表折算出来的那份状态」的 schema 版本，
 *     必须**小于** store 的版本，store 读进来才会继续跑自己的迁移链（5 → 6 补题库分类…）。
 *     一旦改成和 store 一样，老账号的云端数据就会跳过 5→6 的迁移，题库分类全丢。
 * 日常写入不看它：`saveCloudState` 直接沿用状态自带的 `_v`，新文档始终自描述。
 */
const LEGACY_SHAPE_V = 5;
const APP_TAG = 'qiuzhao-cloud';

export interface CloudDoc {
  _v: number;
  _savedAt: string;
  _app: string;
  state: Record<string, unknown>;
}

function isCloudDoc(x: unknown): x is CloudDoc {
  return !!x && typeof x === 'object' && !Array.isArray(x) && 'state' in (x as Record<string, unknown>);
}

export interface CloudLoadResult {
  /** 云端读到的整站状态；null = 云端确实没有数据（新账号） */
  state: Record<string, unknown> | null;
  /** 云端文档的最后保存时间 */
  savedAt?: string;
  /** 是否由旧版结构迁移而来（迁移后需要立刻回写一次） */
  migrated: boolean;
}

/**
 * 读取云端状态。
 * - 新文档：直接返回 state
 * - 旧文档：折算成新文档（并标记 migrated，让上层立刻回写）
 * - 云端报错：抛出，由上层决定是否退回本机缓存（**绝不静默当空数据**，否则会把云端覆盖成空）
 */
export async function loadCloudState(userId: string): Promise<CloudLoadResult> {
  const { data, error } = await supabase
    .from('profiles')
    .select('data,updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  /* 新鲜度基线一律用 updated_at，不用文档里的 _savedAt（后者是各设备各写各的本地时钟）。
     但要注意：updated_at 只有在数据库装了 touch_updated_at 触发器时才是**服务端时间**，
     见 supabase/migrations/003_touch_updated_at.sql —— 没有它，这一列存的就是写入设备的时钟。 */
  const serverAt = (data?.updated_at as string) || undefined;
  const raw = data?.data as unknown;
  if (!raw || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) {
    return { state: null, savedAt: serverAt, migrated: false };
  }
  if (isCloudDoc(raw)) {
    return { state: raw.state ?? null, savedAt: serverAt, migrated: false };
  }
  const migrated = await migrateLegacy(userId, raw as Record<string, unknown>);
  return { state: migrated, savedAt: undefined, migrated: migrated !== null };
}

/**
 * 写入云端状态（原子 upsert）。
 * 失败会抛错，调用方必须把错误显示出来 —— 「以为存上了其实没存」是这类站最致命的体验问题。
 */
export async function saveCloudState(userId: string, state: Record<string, unknown>): Promise<string> {
  const savedAt = new Date().toISOString();
  /* 信封的 `_v` 直接沿用状态自带的版本号：文档自描述，读到的人（以及将来可能加的信封级迁移）
     不必再去猜「这份 state 是按哪一版 schema 写的」。只有兜底（状态里没有 _v）才退回 LEGACY_SHAPE_V。 */
  const docV = Number((state as { _v?: unknown })._v) || LEGACY_SHAPE_V;
  const doc: CloudDoc = { _v: docV, _savedAt: savedAt, _app: APP_TAG, state };
  /* 这里传的 updated_at 是**兜底值**，不是权威值。
     权威值由数据库的 touch_updated_at 触发器写（见 supabase/migrations/003_touch_updated_at.sql）：
     它在 BEFORE INSERT OR UPDATE 里把 NEW.updated_at 强行改成 NOW()，
     所以装了触发器时这里传什么都不作数，.select('updated_at') 读回的才是服务端时间。
     之所以还传：万一某个部署漏跑了 003，UPDATE 分支根本不会碰这一列，
     它会一直停在首次写入的时间，陈旧检测就永远不会触发 —— 那比时间不准更糟。
     传一个本机时间，至少让它在「各设备时钟大致同步」的前提下还能工作。
     ⇒ 多设备防覆盖可不可靠，取决于 003 有没有跑，部署检查项里必须有这一条。 */
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId, data: doc, updated_at: savedAt }, { onConflict: 'user_id' })
    .select('updated_at')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.updated_at as string) || savedAt;
}

/**
 * 只问一句「云端现在是什么时候写的」，不拉整份文档 —— 用于长时间挂着的标签页
 * 在重新获得焦点时判断「另一台设备是不是改过」。只读一列，代价极小。
 */
export async function fetchCloudUpdatedAt(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.updated_at as string) || null;
}

/* ------------------------------------------------------------------ *
 * 旧版云端结构 → 新文档的一次性折算
 * ------------------------------------------------------------------ */

/** 旧表用 snake_case，站点类型用 camelCase；缺字段一律给安全默认值 */
function toApplication(r: Record<string, unknown>) {
  return {
    id: String(r.id ?? ''),
    company: String(r.company ?? '未命名公司'),
    position: String(r.position ?? '岗位'),
    status: (r.status as string) || 'todo',
    channel: r.channel ?? undefined,
    location: r.location ?? undefined,
    deadline: r.deadline ?? undefined,
    link: r.link ?? undefined,
    salary: r.salary ?? undefined,
    notes: r.notes ?? undefined,
    contact: r.contact ?? undefined,
    submittedAt: r.submitted_at ?? undefined,
    createdAt: (r.created_at as string) || new Date().toISOString().slice(0, 10),
    updatedAt: (r.updated_at as string) || new Date().toISOString().slice(0, 10),
    timeline: Array.isArray(r.timeline) ? r.timeline : [],
  };
}

function toEvent(r: Record<string, unknown>) {
  return {
    id: String(r.id ?? ''),
    title: String(r.title ?? ''),
    date: String(r.date ?? ''),
    time: r.time ?? undefined,
    type: (r.type as string) || 'other',
    appId: r.app_id ?? undefined,
    note: r.note ?? undefined,
    source: (r.source as string) || 'manual',
    done: !!r.done,
  };
}

function toJob(r: Record<string, unknown>) {
  return {
    id: String(r.id ?? ''),
    company: String(r.company ?? ''),
    title: String(r.title ?? ''),
    city: r.city ?? undefined,
    salary: r.salary ?? undefined,
    source: r.source ?? undefined,
    url: r.url ?? undefined,
    jd: r.jd ?? undefined,
    requirements: r.requirements ?? undefined,
    exam: r.exam ?? undefined,
    deadline: r.deadline ?? undefined,
    match: r.match ?? undefined,
    status: (r.status as string) || 'new',
    /* 下面三个旧表里**没有对应列**（见 supabase/migrations/001_init.sql 的 jobs），
       所以补在这里是**防御性**的，不是修复正在丢的数据：万一旧行是 JSONB 形态、
       或者将来给旧表加了列，不至于静默丢掉。两种拼写都收：站点类型用 camelCase，旧表习惯 snake_case。 */
    track: r.track ?? undefined,
    appliedBy: r.appliedBy ?? r.applied_by ?? undefined,
    createdAt: (r.created_at as string) || new Date().toISOString().slice(0, 10),
    updatedAt: (r.updated_at as string) || new Date().toISOString().slice(0, 10),
  };
}

function toQuestion(r: Record<string, unknown>) {
  return {
    id: String(r.id ?? ''),
    kind: (r.kind as string) || 'written',
    category: String(r.category ?? '其他'),
    content: String(r.content ?? ''),
    answer: r.answer ?? undefined,
    analysis: r.analysis ?? undefined,
    company: r.company ?? undefined,
    year: r.year ?? undefined,
    difficulty: r.difficulty ?? undefined,
    mastered: !!r.mastered,
    /* 同样是防御性补齐：旧 questions 表没有 bank_id 列 */
    bankId: r.bankId ?? r.bank_id ?? undefined,
    createdAt: (r.created_at as string) || new Date().toISOString().slice(0, 10),
  };
}

/** 旧版 companies 把业务字段塞在 info jsonb 里，这里摊平 */
function toCompany(r: Record<string, unknown>) {
  const info = (r.info && typeof r.info === 'object' ? r.info : {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    company: String(r.company ?? ''),
    industry: info.industry ?? undefined,
    scale: info.scale ?? undefined,
    hq: info.hq ?? undefined,
    business: info.business ?? undefined,
    process: info.process ?? undefined,
    notes: info.notes ?? undefined,
    aiGenerated: !!info.aiGenerated,
    /* 这两个是**真可能丢**的：旧 companies 表把业务字段全塞在 info(jsonb) 里，
       而 info 是自由形态 —— 只要旧版往里面写过 website / priority，上面那几行没覆盖到就会掉。
       priority 另外还可能单独做过列，所以列与 info 两处都收。 */
    website: info.website ?? undefined,
    priority: (r.priority ?? info.priority) ?? undefined,
    updatedAt: (r.updated_at as string) || new Date().toISOString().slice(0, 10),
  };
}

async function migrateLegacy(userId: string, legacyProfile: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const [apps, events, jobs, questions, companies, state] = await Promise.all([
    supabase.from('applications').select('*').eq('user_id', userId),
    supabase.from('events').select('*').eq('user_id', userId),
    supabase.from('jobs').select('*').eq('user_id', userId),
    supabase.from('questions').select('*').eq('user_id', userId),
    supabase.from('companies').select('*').eq('user_id', userId),
    supabase.from('app_state').select('theme,resume_text').eq('user_id', userId).maybeSingle(),
  ]);

  const hasProfile = !!(legacyProfile.single || legacyProfile.multi);
  const rows = [apps.data, events.data, jobs.data, questions.data, companies.data];
  const anyRows = rows.some((r) => Array.isArray(r) && r.length > 0);
  if (!hasProfile && !anyRows && !state.data) return null;

  const mappedApps = (apps.data || []).map(toApplication);
  const mappedEvents = (events.data || []).map(toEvent);
  const mappedJobs = (jobs.data || []).map(toJob);
  const mappedQs = (questions.data || []).map(toQuestion);
  const mappedCos = (companies.data || []).map(toCompany);

  /* 岗位状态与投递记录对齐一次（旧版没有对账逻辑，历史数据可能对不上） */
  const submitted = new Set(mappedApps.filter((a) => a.status !== 'todo').map((a) => a.company.trim()));
  for (const j of mappedJobs) {
    if (j.status === 'new' && submitted.has(j.company.trim())) j.status = 'applied';
  }

  return {
    _v: LEGACY_SHAPE_V,
    profile: hasProfile ? legacyProfile : { single: {}, multi: {} },
    applications: mappedApps,
    events: mappedEvents,
    theme: (state.data?.theme as string) || 'dark',
    resumeText: state.data?.resume_text ?? undefined,
    jobs: mappedJobs,
    questions: mappedQs,
    companies: mappedCos,
    offers: [],
    interviews: [],
    materials: [],
    versions: [],
    contacts: [],
  };
}
