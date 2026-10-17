/**
 * 合并导入的纯逻辑（不依赖 React，便于直接测试）。
 *
 * 设计目标：把一份「本机真实资料恢复包」补进网站时，**永远不丢原有数据**：
 *   - 资料库单选项：只填空缺字段，已填内容一律保留（kept 计数用于告知用户）
 *   - 资料库多选项：按记录标识去重追加（同名项目/同一段经历不会重复堆积）
 *   - 各列表：按各自标识去重追加，已存在的原样不动
 *   - 简历备注：仅当本地为空时补入
 * 想要整表替换请用「覆盖导入」（importAll），那是另一条明确的路径。
 */
import type {
  ProfileData, Rec, Application, CalEvent, JobPosting, Question, QuestionBank, BankCategory, CompanyProfile,
  Offer, InterviewLog, MaterialItem, ResumeVersion, Contact,
} from '../types';

export interface MergeCurrent {
  profile: ProfileData;
  applications: Application[];
  jobs: JobPosting[];
  questions: Question[];
  banks: QuestionBank[];
  bankCategories: BankCategory[];
  companies: CompanyProfile[];
  events: CalEvent[];
  offers: Offer[];
  interviews: InterviewLog[];
  materials: MaterialItem[];
  versions: ResumeVersion[];
  contacts: Contact[];
  resumeText?: string;
}

export interface MergePatch {
  profile?: ProfileData;
  applications?: Application[];
  jobs?: JobPosting[];
  questions?: Question[];
  banks?: QuestionBank[];
  bankCategories?: BankCategory[];
  companies?: CompanyProfile[];
  events?: CalEvent[];
  offers?: Offer[];
  interviews?: InterviewLog[];
  materials?: MaterialItem[];
  versions?: ResumeVersion[];
  contacts?: Contact[];
  resumeText?: string;
}

export interface MergeOutcome { patch: MergePatch; detail: string[]; }

/** 同一条记录的判定标识：用于合并去重，避免重复堆积 */
export function recKey(section: string, r: Rec): string {
  const pick = (keys: string[]) => keys.map((k) => String(r[k] || '').trim()).filter(Boolean).join('|');
  switch (section) {
    case 'education': return pick(['school', 'start']) || pick(['school', 'major']);
    case 'internship':
    case 'work': return pick(['company', 'start']) || pick(['company', 'position']);
    case 'project': return pick(['name']);
    case 'practice': return pick(['title', 'start']) || pick(['title']);
    case 'certificate': return pick(['name']);
    case 'award': return pick(['name', 'date']) || pick(['name']);
    case 'paper': return pick(['name']);
    case 'family': return pick(['relation', 'name']);
    default: return JSON.stringify(r).slice(0, 120);
  }
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function mergeSnapshot(cur: MergeCurrent, incoming: unknown): MergeOutcome {
  const inc = (incoming || {}) as Record<string, unknown>;
  const patch: MergePatch = {};
  const detail: string[] = [];

  /* ---------- 资料库 ---------- */
  const incProfile = inc.profile as ProfileData | undefined;
  if (incProfile && typeof incProfile === 'object') {
    const nextSingle = { ...cur.profile.single };
    const nextMulti = { ...cur.profile.multi };
    let filled = 0, kept = 0, addedRec = 0, dupRec = 0;

    for (const [sec, rec] of Object.entries(incProfile.single || {})) {
      const current = { ...(nextSingle[sec] || {}) };
      for (const [k, v] of Object.entries((rec || {}) as Rec)) {
        if (!String(v || '').trim()) continue;
        if (String(current[k] || '').trim()) { kept++; continue; }
        current[k] = v; filled++;
      }
      nextSingle[sec] = current;
    }
    for (const [sec, list] of Object.entries(incProfile.multi || {})) {
      const current = [...(nextMulti[sec] || [])];
      const keys = new Set(current.map((r) => recKey(sec, r)));
      for (const r of arr<Rec>(list)) {
        const k = recKey(sec, r);
        if (!k || keys.has(k)) { dupRec++; continue; }
        current.push(r); keys.add(k); addedRec++;
      }
      nextMulti[sec] = current;
    }

    if (filled || addedRec) patch.profile = { single: nextSingle, multi: nextMulti };
    if (filled) detail.push(`资料库补全 ${filled} 个字段`);
    if (kept) detail.push(`已有内容保留 ${kept} 项未改动`);
    if (addedRec) detail.push(`新增经历记录 ${addedRec} 条`);
    if (dupRec) detail.push(`重复记录跳过 ${dupRec} 条`);
  }

  /* ---------- 各列表：按标识去重追加 ---------- */
  const mergeList = <T,>(curList: T[], incList: unknown, key: (x: T) => string, label: string, assign: (v: T[]) => void) => {
    const list = arr<T>(incList);
    if (!list.length) return;
    const keys = new Set(curList.map(key));
    const add = list.filter((x) => {
      const k = key(x);
      if (!k || keys.has(k)) return false;
      keys.add(k); return true;
    });
    if (add.length) { assign([...curList, ...add]); detail.push(`${label}新增 ${add.length} 条`); }
  };

  mergeList(cur.materials, inc.materials, (m) => `${m.group || ''}|${(m.name || '').trim()}`, '材料清单', (v) => { patch.materials = v; });
  mergeList(cur.versions, inc.versions, (v) => (v.name || '').trim(), '简历版本', (v) => { patch.versions = v; });
  mergeList(cur.contacts, inc.contacts, (c) => `${(c.name || '').trim()}|${(c.company || '').trim()}`, '联系人', (v) => { patch.contacts = v; });
  mergeList(cur.applications, inc.applications, (a) => a.id, '投递记录', (v) => { patch.applications = v; });
  mergeList(cur.jobs, inc.jobs, (j) => j.id, '岗位', (v) => { patch.jobs = v; });
  /* 仓库按 name 去重（同名视为同一个仓库）；题目按 id 去重。
     注意：若导入包里的题目 bankId 指向一个本地不存在的仓库，题目仍会被并入，
     只是显示为「未归档」——宁可让题留下来，也不因为容器缺失而丢题。 */
  mergeList(cur.banks, inc.banks, (b) => `${(b.name || '').trim()}|${b.catId || ''}`, '题库仓库', (v) => { patch.banks = v; });
  /* 分类按「名称」去重：预置分类 id 固定不会重复，用户自建分类改名后也不会被重复创建 */
  mergeList(cur.bankCategories || [], inc.bankCategories, (c) => (c.name || '').trim(), '题库分类', (v) => { patch.bankCategories = v; });
  mergeList(cur.questions, inc.questions, (q) => q.id, '题库', (v) => { patch.questions = v; });
  mergeList(cur.companies, inc.companies, (c) => c.id, '公司资料', (v) => { patch.companies = v; });
  mergeList(cur.events, inc.events, (e) => e.id, '日历事件', (v) => { patch.events = v; });
  mergeList(cur.offers, inc.offers, (o) => o.id, 'Offer', (v) => { patch.offers = v; });
  mergeList(cur.interviews, inc.interviews, (i) => i.id, '面试复盘', (v) => { patch.interviews = v; });

  /* ---------- 简历备注：仅在本地为空时补入 ---------- */
  const incText = typeof inc.resumeText === 'string' ? inc.resumeText.trim() : '';
  if (incText && !(cur.resumeText || '').trim()) {
    patch.resumeText = inc.resumeText as string;
    detail.push('补入简历备注文本');
  }

  return { patch, detail };
}
