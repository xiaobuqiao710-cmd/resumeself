/**
 * 站内 AI Agent —— 让用户用对话直接操作网站。
 *
 * 为什么能纯前端实现：网站已经让用户配置了自己的 OpenAI 兼容 API Key，
 * 而 agent 需要的「工具」全是本机 localStorage 里的数据操作。
 * 所以这里是一个标准的 **客户端 agent 循环**：
 *   用户说话 → 模型返回 tool_calls → 本地执行 → 把结果回灌 → 再问模型 → 直到给出结论
 * 不需要任何后端，也不需要把数据发到除用户自己模型服务商以外的任何地方。
 */
import type {
  JobPosting, Application, CalEvent, ProfileData, Rec, AppStatus, JobStatus, ViewId, JobTrack,
  Question, QuestionBank, BankCategory, Offer, InterviewLog, MaterialItem, Contact,
} from '../types';
import type { AiConfig } from './ai';
import { getAiConfig, hasSearchKey, webSearch } from './ai';
import { daysUntil, todayISO, fmtDate, sameCompany, STATUS_META } from './util';
import { JOB_STATUS_META } from './jobMeta';
import { inferTrack, TRACK_META } from './mdImport';
import { planJobDedupe } from './dedupe';
import { SECTIONS } from '../data/formSchema';
import { ALL_SCOPE, FALLBACK_CAT_ID, questionCatId, sortCategories } from './bankMeta';

/* ================= 工具定义 ================= */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  destructive?: boolean;      // 会删数据 → UI 先让用户确认
}

const str = (desc: string) => ({ type: 'string', description: desc });
const num = (desc: string) => ({ type: 'number', description: desc });

const APP_STATUSES = ['todo', 'filling', 'submitted', 'test', 'interview', 'offer', 'reject'];
/** 枚举值直接来自模型返回值，取不到就原样回显，绝不让 STATUS_META[x].label 抛错中断整轮工具调用 */
const statusLabel = (s: string) => STATUS_META[s]?.label || s;
/** 单位比对：与全站统一口径（别名 / 主干），模型写「中国国际金融股份有限公司」也能命中「中金公司」 */
const sameCo = (a: unknown, b: unknown) => sameCompany(String(a ?? ''), String(b ?? '')) || norm(a) === norm(b);
const JOB_STATUSES = ['new', 'interested', 'applied', 'archived'];

export const AGENT_TOOLS: ToolSpec[] = [
  /* ---------------- 联网（唯一会走出本站的工具） ---------------- */
  {
    name: 'web_search',
    description: '联网搜索真实互联网（不是站内数据）。凡是本站查不到的站外信息都走它：'
      + '某单位的招聘公告与截止时间、岗位待遇/薪资、笔试面试经验、公司背景与行业地位、行业薪资水平、政策与考试安排等。'
      + '返回每条结果的标题、网址、站点、发布时间与摘要。',
    parameters: { type: 'object', required: ['query'], properties: {
      query: str('搜索关键词。中文效果最好；把「单位名 + 年份 + 想查的点」写全，例如「国家开发银行 2027 校招 笔试经验」'),
      count: num('返回条数 1-10，默认 6'),
      freshness: { type: 'string', enum: ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'], description: '时效过滤，默认 noLimit 不限；查最新公告时建议 oneMonth' },
      summary: { type: 'boolean', description: '是否要长摘要，默认 true（长摘要比片段更好用来读正文）' },
    } },
  },

  /* ---------------- 岗位库 ---------------- */
  {
    name: 'search_jobs', description: '在岗位库里检索岗位（按单位/岗位名关键词、状态过滤）',
    parameters: { type: 'object', properties: { query: str('检索关键词，可空'), status: { type: 'string', enum: JOB_STATUSES, description: '岗位状态，可空' }, limit: num('最多返回条数，默认 20') } },
  },
  {
    name: 'search_applications', description: '检索网申记录（投递记录）',
    parameters: { type: 'object', properties: { query: str('检索关键词，可空'), status: { type: 'string', enum: APP_STATUSES, description: '投递状态，可空' }, limit: num('最多返回条数，默认 20') } },
  },
  {
    name: 'upcoming_deadlines', description: '列出最近即将截止的岗位与投递（默认未来 7 天）',
    parameters: { type: 'object', properties: { days: num('未来天数，默认 7') } },
  },
  {
    name: 'site_stats', description: '获取网站整体统计（岗位数、投递数、各状态分布、题库、面试、Offer 等）',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'add_job', description: '新增一个岗位到岗位库',
    parameters: { type: 'object', required: ['company'], properties: {
      company: str('单位名称'), title: str('岗位名称，缺省为 2027 校招'), deadline: str('投递截止日 YYYY-MM-DD'),
      url: str('岗位/网申入口链接'), requirements: str('招聘要求'), exam: str('笔试/考试内容'),
      city: str('城市'), salary: str('薪资'), track: { type: 'string', enum: ['soe', 'civil', 'private'], description: '招聘线：国央企/公职选调/民营及其他（不填自动判断）' },
    } },
  },
  {
    name: 'update_job_status', description: '修改岗位状态；把状态改成 applied 表示「已投递」，其截止提醒会自动停止',
    parameters: { type: 'object', required: ['company', 'status'], properties: {
      company: str('单位名称（精确）'), title: str('岗位名称，可空表示该单位全部岗位'), status: { type: 'string', enum: JOB_STATUSES },
    } },
  },
  {
    name: 'add_application', description: '新增一条网申（投递）记录；若状态为已提交及之后，会自动把岗位库对应岗位置为已投递',
    parameters: { type: 'object', required: ['company'], properties: {
      company: str('单位名称'), position: str('岗位名称'), status: { type: 'string', enum: APP_STATUSES, description: '默认 submitted' },
      channel: str('渠道，如官网/内推/BOSS'), location: str('城市'), deadline: str('截止日 YYYY-MM-DD'), link: str('投递链接'),
    } },
  },
  {
    name: 'set_application_status', description: '修改某条投递记录的状态（改为已提交及之后会自动同步岗位库并停止截止提醒）',
    parameters: { type: 'object', required: ['company', 'status'], properties: {
      company: str('单位名称'), position: str('岗位名称，可空'), status: { type: 'string', enum: APP_STATUSES },
      note: str('备注，可空'),
    } },
  },
  {
    name: 'add_event', description: '往日历里加一条事件（截止/笔试/面试/待办等）',
    parameters: { type: 'object', required: ['title', 'date'], properties: {
      title: str('事件标题'), date: str('日期 YYYY-MM-DD'), time: str('时间 HH:mm，可空'),
      type: { type: 'string', enum: ['deadline', 'interview', 'test', 'offer', 'todo', 'other'] },
      note: str('备注，可空'),
    } },
  },
  {
    name: 'navigate', description: '切换网站页面（让用户直接看到结果）',
    parameters: { type: 'object', required: ['view'], properties: {
      view: { type: 'string', enum: ['dashboard', 'insights', 'jobs', 'applications', 'calendar', 'interviews', 'offers', 'bank', 'resume', 'versions', 'checklist', 'contacts', 'mail', 'database'] },
    } },
  },
  {
    name: 'dedupe_jobs', description: '清理岗位库里的重复岗位：同一单位下名称相同或高度相似的只保留一条（保留信息最全的那条），其余合并后删除。危险操作，需用户确认。',
    destructive: true,
    parameters: { type: 'object', properties: {
      company: str('只清理该单位，可空表示全库'),
      dry_run: { type: 'boolean', description: 'true 只报告不删除' },
      merge_similar: { type: 'boolean', description: 'true 时连「标题高度相似但不完全相同」的也合并（例如「2027 校招」与「2027 校招（含某类岗位）」）；默认只合并完全同名的' },
    } },
  },
  {
    name: 'delete_job', description: '删除岗位库里的岗位（危险操作，需用户确认）', destructive: true,
    parameters: { type: 'object', required: ['company'], properties: { company: str('单位名称'), title: str('岗位名称，可空表示该单位全部岗位') } },
  },
  {
    name: 'delete_application', description: '删除一条投递记录（危险操作，需用户确认）', destructive: true,
    parameters: { type: 'object', required: ['company'], properties: { company: str('单位名称'), position: str('岗位名称，可空') } },
  },
  {
    name: 'update_job', description: '修改岗位的字段（截止日、链接、要求、笔试内容、城市、薪资、招聘线等）；只改传入的字段',
    parameters: { type: 'object', required: ['company'], properties: {
      company: str('单位名称（精确或简称）'), title: str('岗位名称，可空表示该单位全部岗位'),
      deadline: str('投递截止日 YYYY-MM-DD'), url: str('岗位链接'), requirements: str('招聘要求'),
      exam: str('笔试/考试内容'), city: str('城市'), salary: str('薪资'),
      track: { type: 'string', enum: ['soe', 'civil', 'private'], description: '招聘线' },
    } },
  },

  /* ---------------- 题库 ---------------- */
  {
    name: 'question_banks', description: '查看题库结构：每个分类下有哪些库、各有多少题、多少未掌握。要动题库前先调用它确认库名。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'search_questions', description: '检索题库里的题目（可按关键词、分类/库名、笔试或面试、是否已掌握过滤）',
    parameters: { type: 'object', properties: {
      query: str('检索关键词，可空'),
      bank: str('库名或分类名，可空'),
      kind: { type: 'string', enum: ['written', 'interview'], description: 'written=笔试 / interview=面试，可空' },
      unmastered_only: { type: 'boolean', description: 'true 只看未掌握的' },
      limit: num('最多返回条数，默认 20'),
    } },
  },
  {
    name: 'add_question', description: '往题库里添加题目（可指定归入哪个分类/库；库不存在时用 add_bank 先建）',
    parameters: { type: 'object', required: ['content'], properties: {
      content: str('题干'), kind: { type: 'string', enum: ['written', 'interview'], description: '默认 written' },
      category: str('题目分类，如 行测·资料分析 / 行为面试(BQ)'), answer: str('参考答案'), analysis: str('解析'),
      company: str('公司，可空'), year: str('年份/场次，可空'),
      difficulty: { type: 'string', enum: ['易', '中', '难'] },
      bank: str('库名，可空'), cat: str('分类（赛道）名，可空'),
    } },
  },
  {
    name: 'add_bank', description: '在题库里新建一个库（需要先有分类；分类不存在时用 add_bank_category 建）',
    parameters: { type: 'object', required: ['name'], properties: {
      name: str('库名，如 招商银行'), cat: str('所属分类名，如 银行'), note: str('备注，可空'),
    } },
  },
  {
    name: 'add_bank_category', description: '新建题库分类（赛道），如「法律岗」「央企总部」',
    parameters: { type: 'object', required: ['name'], properties: { name: str('分类名称') } },
  },
  {
    name: 'update_question', description: '修改题目：标记已掌握/未掌握、改分类、改答案、或移动到别的库',
    parameters: { type: 'object', properties: {
      query: str('用题干关键词定位题目（必填）'),
      mastered: { type: 'boolean', description: '是否标记为已掌握' },
      category: str('新的题目分类'), answer: str('新的答案'),
      bank: str('移动到该库（库名）；留空字符串表示移出到未归档'),
    } },
  },
  {
    name: 'delete_question', description: '删除题目（危险操作，需用户确认）', destructive: true,
    parameters: { type: 'object', required: ['query'], properties: { query: str('用题干关键词定位要删除的题目') } },
  },

  /* ---------------- 面试复盘 / Offer ---------------- */
  {
    name: 'search_interviews', description: '检索面试复盘记录（公司、轮次、问了什么、结果）',
    parameters: { type: 'object', properties: { query: str('关键词，可空'), limit: num('默认 20') } },
  },
  {
    name: 'add_interview', description: '新增一场面试复盘',
    parameters: { type: 'object', required: ['company', 'date'], properties: {
      company: str('单位名称'), position: str('岗位'), date: str('日期 YYYY-MM-DD'),
      round: { type: 'string', enum: ['笔试', '一面', '二面', '三面', '终面', 'HR面', '群面', '其他'] },
      questions: str('面试问题，多题用换行分隔'), selfReview: str('整体复盘'), improvements: str('下次改进'),
      result: { type: 'string', enum: ['pending', 'passed', 'failed'], description: '默认 pending' },
    } },
  },
  {
    name: 'search_offers', description: '列出 Offer 及其条件（薪资结构、户口、签约截止等），用于横向对比',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'add_offer', description: '新增一个 Offer',
    parameters: { type: 'object', required: ['company'], properties: {
      company: str('单位名称'), position: str('岗位'), city: str('城市'),
      baseMonthly: str('月 base'), months: str('薪数，如 16'), totalPackage: str('首年总包'),
      hukou: str('户口情况'), signDeadline: str('签约截止 YYYY-MM-DD'), notes: str('备注'),
    } },
  },

  /* ---------------- 网申资料库 / 材料 / 人脉 ---------------- */
  {
    name: 'profile_read', description: '读取网申资料库（个人信息/教育/实习/项目/证书/获奖/家庭等）的内容，用于填写表单或核对资料',
    parameters: { type: 'object', properties: {
      section: str('板块 id 或名称（如 personal / education / 个人信息）；不传则返回全部板块概览'),
    } },
  },
  {
    name: 'profile_write', description: '写入网申资料库：填某个板块的字段（会覆盖同名字段，先读再写）',
    parameters: { type: 'object', required: ['section', 'fields'], properties: {
      section: str('板块 id 或名称，如 personal / education'),
      fields: { type: 'object', description: '字段名到值的映射，如 {"name":"张三","phone":"138…"}' },
      record_name: str('多记录板块（教育/实习/项目…）用：定位到哪一条记录（如学校名）；不传则用第一条，没有就新建'),
    } },
  },
  {
    name: 'materials', description: '查看材料清单（证件/证明/成绩单等），标出未备好的项',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'update_material', description: '修改材料清单某一项：标记已备好/未备好，或补上文件路径',
    parameters: { type: 'object', required: ['name'], properties: {
      name: str('材料名称（关键词）'), done: { type: 'boolean' }, path: str('本机文件路径'), note: str('备注'),
    } },
  },
  {
    name: 'search_contacts', description: '检索人脉 / 内推人（HR、学长、猎头）及其跟进节奏',
    parameters: { type: 'object', properties: { query: str('关键词，可空'), due_only: { type: 'boolean', description: 'true 只看今天及之前该跟进的' } } },
  },
  {
    name: 'add_contact', description: '新增一个人脉 / 内推人',
    parameters: { type: 'object', required: ['name'], properties: {
      name: str('姓名'), company: str('单位'), role: str('身份，如 HR/内推人/学长'),
      wechat: str('微信'), email: str('邮箱'), phone: str('电话'),
      nextFollowUp: str('下次跟进日 YYYY-MM-DD'), promised: str('对方承诺的事'), notes: str('备注'),
    } },
  },
];

/* ================= 执行宿主（由 UI 注入 store 能力） ================= */
export interface AgentHost {
  jobs: JobPosting[];
  applications: Application[];
  events: CalEvent[];
  profile: ProfileData;
  questions: Question[];
  banks: QuestionBank[];
  bankCategories: BankCategory[];
  interviews: InterviewLog[];
  offers: Offer[];
  materials: MaterialItem[];
  contacts: Contact[];
  addJob: (j: Partial<JobPosting>) => JobPosting;
  updateJob: (id: string, patch: Partial<JobPosting>) => void;
  removeJob: (id: string) => void;
  addApp: (a: Partial<Application>) => Application;
  setStatus: (id: string, s: AppStatus, note?: string) => void;
  removeApp: (id: string) => void;
  addEvent: (e: Partial<CalEvent>) => CalEvent;
  setView: (v: ViewId) => void;
  /* 题库 */
  addQuestion: (q: Partial<Question>) => Question;
  updateQuestion: (id: string, patch: Partial<Question>) => void;
  removeQuestion: (id: string) => void;
  addBank: (b: Partial<QuestionBank>) => QuestionBank;
  addCategory: (c: Partial<BankCategory>) => BankCategory;
  /* 面试复盘 */
  addInterview: (i: Partial<InterviewLog>) => InterviewLog;
  /* Offer */
  addOffer: (o: Partial<Offer>) => Offer;
  /* 资料库 / 材料 / 人脉 */
  setSingle: (section: string, key: string, value: string) => void;
  updateMulti: (section: string, idx: number, patch: Partial<Rec>) => void;
  addMulti: (section: string, record?: Rec) => void;
  updateMaterial: (id: string, patch: Partial<MaterialItem>) => void;
  addContact: (c: Partial<Contact>) => Contact;
}

export interface ToolRun { name: string; args: Record<string, unknown>; ok: boolean; summary: string; result?: unknown; }

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** 执行一个工具调用；返回给模型看的简短结果 */
export function runTool(host: AgentHost, name: string, args: Record<string, unknown>): ToolRun {
  const brief = (j: JobPosting) => ({
    company: j.company, title: j.title, status: j.status, track: j.track || 'private',
    deadline: j.deadline || null, url: j.url || null,
    requirements: j.requirements ? String(j.requirements).slice(0, 80) : null,
    exam: j.exam ? String(j.exam).slice(0, 60) : null,
  });
  const briefApp = (a: Application) => ({
    company: a.company, position: a.position, status: a.status,
    deadline: a.deadline || null, channel: a.channel || null, submittedAt: a.submittedAt || null,
  });
  const fuzzy = (text: string, q: string) => !q || text.toLowerCase().includes(q.toLowerCase());

  switch (name) {
    case 'search_jobs': {
      const q = String(args.query || '');
      const st = args.status ? String(args.status) : '';
      const limit = Math.min(50, Number(args.limit) || 20);
      const list = host.jobs
        .filter((j) => (!st || j.status === st) && fuzzy(`${j.company} ${j.title} ${j.city || ''}`, q))
        .slice(0, limit).map(brief);
      return { name, args, ok: true, summary: `找到 ${list.length} 条岗位`, result: list };
    }
    case 'search_applications': {
      const q = String(args.query || '');
      const st = args.status ? String(args.status) : '';
      const limit = Math.min(50, Number(args.limit) || 20);
      const list = host.applications
        .filter((a) => (!st || a.status === st) && fuzzy(`${a.company} ${a.position} ${a.channel || ''}`, q))
        .slice(0, limit).map(briefApp);
      return { name, args, ok: true, summary: `找到 ${list.length} 条投递记录`, result: list };
    }
    case 'upcoming_deadlines': {
      const days = Number(args.days) || 7;
      const jobs = host.jobs.filter((j) => {
        const d = daysUntil(j.deadline);
        return d !== null && d >= 0 && d <= days && j.status !== 'applied' && j.status !== 'archived';
      }).map((j) => ({ kind: '岗位', company: j.company, title: j.title, date: j.deadline, days: daysUntil(j.deadline) }));
      const apps = host.applications.filter((a) => {
        const d = daysUntil(a.deadline);
        return d !== null && d >= 0 && d <= days && ['todo', 'filling'].includes(a.status);
      }).map((a) => ({ kind: '投递', company: a.company, title: a.position, date: a.deadline, days: daysUntil(a.deadline) }));
      const all = [...jobs, ...apps].sort((x, y) => (x.days ?? 0) - (y.days ?? 0));
      return { name, args, ok: true, summary: `${days} 天内共 ${all.length} 项截止`, result: all };
    }
    case 'site_stats': {
      const byStatus = (xs: { status: string }[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x.status]: (m[x.status] || 0) + 1 }), {});
      const p = host.profile;
      const filled = Object.values(p.single?.personal || {}).filter((v) => String(v || '').trim()).length;
      return {
        name, args, ok: true, summary: '已统计',
        result: {
          岗位总数: host.jobs.length, 岗位状态分布: byStatus(host.jobs),
          投递总数: host.applications.length, 投递状态分布: byStatus(host.applications),
          日历事件: host.events.length, 面试复盘: host.interviews.length, Offer: host.offers.length,
          题库: host.questions.length, 个人信息已填字段: filled,
        },
      };
    }
    case 'add_job': {
      const company = String(args.company || '').trim();
      if (!company) return { name, args, ok: false, summary: '缺少单位名称' };
      const title = String(args.title || '2027 校招');
      const track = (args.track as JobTrack) || inferTrack(company, title);
      const j = host.addJob({
        company, title, track,
        deadline: args.deadline ? String(args.deadline) : undefined,
        url: args.url ? String(args.url) : undefined,
        requirements: args.requirements ? String(args.requirements) : undefined,
        exam: args.exam ? String(args.exam) : undefined,
        city: args.city ? String(args.city) : undefined,
        salary: args.salary ? String(args.salary) : undefined,
        source: 'AI 助手',
      });
      return { name, args, ok: true, summary: `已新增岗位：${company} · ${title}（${TRACK_META[track].label}）`, result: { id: j.id } };
    }
    case 'update_job_status': {
      const company = String(args.company || '').trim();
      const title = String(args.title || '').trim();
      const status = String(args.status || '') as JobStatus;
      if (!JOB_STATUSES.includes(status)) {
        return { name, args, ok: false, summary: `岗位状态不合法：${status}（可用：${JOB_STATUSES.join(' / ')}）` };
      }
      const hits = host.jobs.filter((j) => sameCo(j.company, company) && (!title || fuzzy(j.title, title)));
      if (!hits.length) return { name, args, ok: false, summary: `岗位库里没找到「${company}」` };
      hits.forEach((j) => host.updateJob(j.id, { status, ...(status === 'applied' ? {} : { appliedBy: undefined }) }));
      const extra = status === 'applied' ? '，其截止提醒已停止' : '';
      return { name, args, ok: true, summary: `已把 ${hits.length} 条岗位设为「${JOB_STATUS_META[status]?.label || status}」${extra}`, result: hits.map((h) => ({ company: h.company, title: h.title })) };
    }
    case 'add_application': {
      const company = String(args.company || '').trim();
      if (!company) return { name, args, ok: false, summary: '缺少单位名称' };
      const raw = String(args.status || 'submitted') as AppStatus;
      const status: AppStatus = APP_STATUSES.includes(raw) ? raw : 'submitted';
      const app = host.addApp({
        company, position: String(args.position || '岗位'), status,
        channel: args.channel ? String(args.channel) : undefined,
        location: args.location ? String(args.location) : undefined,
        deadline: args.deadline ? String(args.deadline) : undefined,
        link: args.link ? String(args.link) : undefined,
      });
      return { name, args, ok: true, summary: `已新增投递记录：${company} · ${app.position}（${statusLabel(status)}）`, result: { id: app.id } };
    }
    case 'set_application_status': {
      const company = String(args.company || '').trim();
      const position = String(args.position || '').trim();
      const status = String(args.status || '') as AppStatus;
      if (!APP_STATUSES.includes(status)) return { name, args, ok: false, summary: `状态不合法：${status}` };
      const hits = host.applications.filter((a) => sameCo(a.company, company) && (!position || fuzzy(a.position, position)));
      if (!hits.length) return { name, args, ok: false, summary: `没找到「${company}」的投递记录` };
      hits.forEach((a) => host.setStatus(a.id, status, args.note ? String(args.note) : 'AI 助手'));
      return { name, args, ok: true, summary: `已把 ${hits.length} 条投递改为「${statusLabel(status)}」`, result: hits.map((h) => ({ company: h.company, position: h.position })) };
    }
    case 'add_event': {
      const title = String(args.title || '').trim();
      const date = String(args.date || '').trim();
      if (!title || !date) return { name, args, ok: false, summary: '缺少标题或日期' };
      const ev = host.addEvent({ title, date, time: args.time ? String(args.time) : undefined, type: (args.type as CalEvent['type']) || 'other', note: args.note ? String(args.note) : undefined, source: 'manual' });
      return { name, args, ok: true, summary: `已加入日历：${title}（${fmtDate(date)}）`, result: { id: ev.id } };
    }
    case 'navigate': {
      const v = String(args.view || '') as ViewId;
      host.setView(v);
      return { name, args, ok: true, summary: `已切换到「${v}」页面` };
    }
    case 'dedupe_jobs': {
      const only = String(args.company || '').trim();
      const dry = args.dry_run === true;
      // 去重规则统一在 lib/dedupe.ts（岗位追踪里的「清理重复」按钮走同一套，结果一致）
      const plan = planJobDedupe(host.jobs, { mergeSimilar: args.merge_similar === true, company: only || undefined });
      const removed: { company: string; title: string }[] = [];
      const kept: { company: string; title: string; mergedFrom: number }[] = [];
      for (const g of plan.groups) {
        if (!dry && Object.keys(g.patch).length) host.updateJob(g.keep.id, g.patch);
        g.dups.forEach((d) => {
          if (!dry) host.removeJob(d.id);
          removed.push({ company: d.company, title: d.title });
        });
        kept.push({ company: g.keep.company, title: g.keep.title, mergedFrom: g.dups.length });
      }
      return {
        name, args, ok: true,
        summary: removed.length
          ? `${dry ? '发现' : '已清理'} ${removed.length} 条重复岗位，保留 ${kept.length} 条（已把重复项里的链接/要求/笔试信息补进保留项）`
          : '没有发现重复岗位',
        result: {
          保留: kept,
          删除: removed,
          疑似重复未合并: args.merge_similar === true
            ? []
            : plan.similarPairs.slice(0, 10).map((p) => ({ company: p.company, a: p.a, b: p.b })),
        },
      };
    }
    case 'delete_job': {
      const company = String(args.company || '').trim();
      const title = String(args.title || '').trim();
      const hits = host.jobs.filter((j) => sameCo(j.company, company) && (!title || fuzzy(j.title, title)));
      hits.forEach((j) => host.removeJob(j.id));
      return { name, args, ok: true, summary: `已删除 ${hits.length} 条岗位`, result: hits.map((h) => ({ company: h.company, title: h.title })) };
    }
    case 'delete_application': {
      const company = String(args.company || '').trim();
      const position = String(args.position || '').trim();
      const hits = host.applications.filter((a) => sameCo(a.company, company) && (!position || fuzzy(a.position, position)));
      hits.forEach((a) => host.removeApp(a.id));
      return { name, args, ok: true, summary: `已删除 ${hits.length} 条投递记录` };
    }
    case 'update_job': {
      const company = String(args.company || '').trim();
      const title = String(args.title || '').trim();
      const hits = host.jobs.filter((j) => sameCo(j.company, company) && (!title || fuzzy(j.title, title)));
      if (!hits.length) return { name, args, ok: false, summary: `岗位库里没找到「${company}」` };
      const patch: Partial<JobPosting> = {};
      if (args.deadline) patch.deadline = String(args.deadline);
      if (args.url) patch.url = String(args.url);
      if (args.requirements) patch.requirements = String(args.requirements);
      if (args.exam) patch.exam = String(args.exam);
      if (args.city) patch.city = String(args.city);
      if (args.salary) patch.salary = String(args.salary);
      if (args.track && ['soe', 'civil', 'private'].includes(String(args.track))) patch.track = args.track as JobTrack;
      if (!Object.keys(patch).length) return { name, args, ok: false, summary: '没有给出要修改的字段' };
      hits.forEach((j) => host.updateJob(j.id, patch));
      return { name, args, ok: true, summary: `已更新 ${hits.length} 条岗位（${Object.keys(patch).join('、')}）`, result: hits.map((h) => ({ company: h.company, title: h.title })) };
    }

    /* ---------------- 题库 ---------------- */
    case 'question_banks': {
      const cats = sortCategories(host.bankCategories);
      const qs = host.questions;
      const catOf = (id: string) => cats.find((c) => c.id === id)?.name || '未分类';
      const result = cats.map((c) => {
        const group = host.banks.filter((b) => (b.catId || FALLBACK_CAT_ID) === c.id);
        const inCat = qs.filter((q) => questionCatId(q, host.banks) === c.id);
        return {
          分类: c.name,
          题数: inCat.length,
          未掌握: inCat.filter((q) => !q.mastered).length,
          库: group.map((b) => {
            const bs = qs.filter((q) => q.bankId === b.id);
            return { 库名: b.name, 题数: bs.length, 未掌握: bs.filter((q) => !q.mastered).length };
          }),
          未归档题数: inCat.filter((q) => !q.bankId).length,
        };
      });
      return {
        name, args, ok: true,
        summary: `题库共 ${qs.length} 题、${cats.length} 个分类、${host.banks.length} 个库`,
        result: result,
      };
    }
    case 'search_questions': {
      const kw = String(args.query || '').trim().toLowerCase();
      const bankArg = String(args.bank || '').trim();
      const kd = args.kind ? String(args.kind) : '';
      const limit = Math.min(50, Number(args.limit) || 20);
      const bankHit = bankArg
        ? host.banks.find((b) => b.name === bankArg || b.name.includes(bankArg))
        : undefined;
      const catHit = bankArg
        ? host.bankCategories.find((c) => c.name === bankArg || c.name.includes(bankArg))
        : undefined;
      const list = host.questions.filter((q) => {
        if (kd && q.kind !== kd) return false;
        if (bankHit && q.bankId !== bankHit.id) return false;
        if (!bankHit && catHit && questionCatId(q, host.banks) !== catHit.id) return false;
        if (bankArg && !bankHit && !catHit) return false;
        if (args.unmastered_only === true && q.mastered) return false;
        if (kw && !`${q.content} ${q.category} ${q.company || ''}`.toLowerCase().includes(kw)) return false;
        return true;
      }).slice(0, limit).map((q) => ({
        题干: q.content.slice(0, 160), 类型: q.kind === 'interview' ? '面试' : '笔试', 分类: q.category,
        所属: q.bankId ? (host.banks.find((b) => b.id === q.bankId)?.name || '') : `${host.bankCategories.find((c) => c.id === questionCatId(q, host.banks))?.name || '未分类'}（未归档）`,
        已掌握: !!q.mastered, 公司: q.company || null,
      }));
      return { name, args, ok: true, summary: `找到 ${list.length} 道题`, result: list };
    }
    case 'add_question': {
      const content = String(args.content || '').trim();
      if (!content) return { name, args, ok: false, summary: '缺少题干' };
      const bankArg = String(args.bank || '').trim();
      const catArg = String(args.cat || '').trim();
      const bankHit = bankArg ? host.banks.find((b) => b.name === bankArg || b.name.includes(bankArg)) : undefined;
      const catHit = catArg ? host.bankCategories.find((c) => c.name === catArg || c.name.includes(catArg)) : undefined;
      const q = host.addQuestion({
        content,
        kind: args.kind === 'interview' ? 'interview' : 'written',
        category: args.category ? String(args.category) : '其他',
        answer: args.answer ? String(args.answer) : undefined,
        analysis: args.analysis ? String(args.analysis) : undefined,
        company: args.company ? String(args.company) : undefined,
        year: args.year ? String(args.year) : undefined,
        difficulty: (['易', '中', '难'] as string[]).includes(String(args.difficulty || '')) ? args.difficulty as Question['difficulty'] : undefined,
        bankId: bankHit?.id,
        catId: bankHit?.catId || catHit?.id,
      });
      const where = bankHit ? `库「${bankHit.name}」` : catHit ? `分类「${catHit.name}」` : '题库（未归档）';
      return { name, args, ok: true, summary: `已添加 1 道题到${where}：${content.slice(0, 30)}`, result: { id: q.id } };
    }
    case 'add_bank': {
      const nm = String(args.name || '').trim();
      if (!nm) return { name, args, ok: false, summary: '缺少库名称' };
      const catArg = String(args.cat || '').trim();
      const catHit = catArg ? host.bankCategories.find((c) => c.name === catArg || c.name.includes(catArg)) : undefined;
      const exist = host.banks.find((b) => b.name === nm);
      if (exist) return { name, args, ok: true, summary: `库「${nm}」已存在，直接用它`, result: { id: exist.id } };
      const b = host.addBank({ name: nm, catId: catHit?.id || FALLBACK_CAT_ID, note: args.note ? String(args.note) : undefined });
      if (catArg && !catHit) return { name, args, ok: true, summary: `已建库「${nm}」，但没找到分类「${catArg}」，先放在「其他」下`, result: { id: b.id } };
      return { name, args, ok: true, summary: `已在「${catHit?.name || '其他'}」下建库「${nm}」`, result: { id: b.id } };
    }
    case 'add_bank_category': {
      const nm = String(args.name || '').trim();
      if (!nm) return { name, args, ok: false, summary: '缺少分类名称' };
      const exist = host.bankCategories.find((c) => c.name === nm);
      if (exist) return { name, args, ok: true, summary: `分类「${nm}」已存在`, result: { id: exist.id } };
      const c = host.addCategory({ name: nm });
      return { name, args, ok: true, summary: `已新建分类「${c.name}」`, result: { id: c.id } };
    }
    case 'update_question': {
      const kw = String(args.query || '').trim().toLowerCase();
      if (!kw) return { name, args, ok: false, summary: '需要用 query 指明要改哪道题' };
      const hits = host.questions.filter((q) => q.content.toLowerCase().includes(kw)
        || `${q.category} ${q.company || ''}`.toLowerCase().includes(kw));
      if (!hits.length) return { name, args, ok: false, summary: `题库里没找到含「${args.query}」的题目` };
      const patch: Partial<Question> = {};
      if (typeof args.mastered === 'boolean') patch.mastered = args.mastered;
      if (args.category) patch.category = String(args.category);
      if (args.answer) patch.answer = String(args.answer);
      if (typeof args.bank === 'string') {
        if (!args.bank.trim()) { patch.bankId = undefined; }
        else {
          const b = host.banks.find((x) => x.name === args.bank || x.name.includes(String(args.bank)));
          if (!b) return { name, args, ok: false, summary: `没有名为「${args.bank}」的库` };
          patch.bankId = b.id; patch.catId = b.catId;
        }
      }
      if (!Object.keys(patch).length) return { name, args, ok: false, summary: '没有给出要修改的内容' };
      hits.forEach((q) => host.updateQuestion(q.id, patch));
      return { name, args, ok: true, summary: `已更新 ${hits.length} 道题`, result: hits.map((q) => ({ 题干: q.content.slice(0, 40) })) };
    }
    case 'delete_question': {
      const kw = String(args.query || '').trim().toLowerCase();
      const hits = host.questions.filter((q) => q.content.toLowerCase().includes(kw));
      hits.forEach((q) => host.removeQuestion(q.id));
      return { name, args, ok: true, summary: `已删除 ${hits.length} 道题`, result: hits.map((q) => ({ 题干: q.content.slice(0, 40) })) };
    }

    /* ---------------- 面试复盘 / Offer ---------------- */
    case 'search_interviews': {
      const kw = String(args.query || '').trim().toLowerCase();
      const limit = Math.min(50, Number(args.limit) || 20);
      const list = host.interviews.filter((i) => !kw
        || `${i.company} ${i.position || ''} ${i.selfReview || ''} ${(i.questions || []).map((x) => x.q).join(' ')}`.toLowerCase().includes(kw))
        .slice(0, limit).map((i) => ({
          公司: i.company, 岗位: i.position || null, 轮次: i.round, 日期: i.date, 结果: i.result,
          问题数: (i.questions || []).length,
          问题: (i.questions || []).slice(0, 5).map((x) => x.q),
          复盘: i.selfReview ? String(i.selfReview).slice(0, 120) : null,
        }));
      return { name, args, ok: true, summary: `找到 ${list.length} 场面试复盘`, result: list };
    }
    case 'add_interview': {
      const company = String(args.company || '').trim();
      const date = String(args.date || '').trim();
      if (!company || !date) return { name, args, ok: false, summary: '缺少单位或日期' };
      const rounds = ['笔试', '一面', '二面', '三面', '终面', 'HR面', '群面', '其他'];
      const rnd = rounds.includes(String(args.round)) ? args.round as InterviewLog['round'] : '一面';
      const qs = String(args.questions || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
        .map((t) => ({ q: t.replace(/^\s*(\d+[.、)）]|[•·\-–—])\s*/, '') }));
      const results = ['pending', 'passed', 'failed'];
      const it = host.addInterview({
        company, position: args.position ? String(args.position) : undefined, round: rnd, date,
        questions: qs,
        selfReview: args.selfReview ? String(args.selfReview) : undefined,
        improvements: args.improvements ? String(args.improvements) : undefined,
        result: results.includes(String(args.result)) ? args.result as InterviewLog['result'] : 'pending',
      });
      return { name, args, ok: true, summary: `已记录「${company}」${rnd} 复盘（${qs.length} 个问题）`, result: { id: it.id } };
    }
    case 'search_offers': {
      const list = host.offers.map((o) => ({
        公司: o.company, 岗位: o.position, 城市: o.city || null, 状态: o.status,
        月base: o.baseMonthly || null, 薪数: o.months || null, 首年总包: o.totalPackage || null,
        户口: o.hukou || null, 签约截止: o.signDeadline || null, 评分: o.rating ?? null, 备注: o.notes || null,
      }));
      return { name, args, ok: true, summary: host.offers.length ? `共 ${list.length} 个 Offer` : '还没有记录 Offer', result: list };
    }
    case 'add_offer': {
      const company = String(args.company || '').trim();
      if (!company) return { name, args, ok: false, summary: '缺少单位名称' };
      const o = host.addOffer({
        company, position: String(args.position || '岗位'), status: 'considering',
        city: args.city ? String(args.city) : undefined,
        baseMonthly: args.baseMonthly ? String(args.baseMonthly) : undefined,
        months: args.months ? String(args.months) : undefined,
        totalPackage: args.totalPackage ? String(args.totalPackage) : undefined,
        hukou: args.hukou ? String(args.hukou) : undefined,
        signDeadline: args.signDeadline ? String(args.signDeadline) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
      });
      return { name, args, ok: true, summary: `已新增 Offer：${company} · ${o.position}`, result: { id: o.id } };
    }

    /* ---------------- 网申资料库 / 材料 / 人脉 ---------------- */
    case 'profile_read': {
      const normSec = (s: string) => s.replace(/\s/g, '').toLowerCase();
      const findSec = (t: string) => SECTIONS.find((s) => s.id === t || s.title === t
        || s.id.toLowerCase() === t.toLowerCase() || normSec(s.title) === normSec(t));
      const valueOf = (s: typeof SECTIONS[number], r: Rec) => Object.fromEntries(
        s.fields.filter((f) => String(r[f.key] || '').trim()).map((f) => [f.name, String(r[f.key]).slice(0, 300)]),
      );
      const dump = (s: typeof SECTIONS[number]) => {
        const recs: Rec[] = s.multiple ? (host.profile.multi[s.id] || []) : [host.profile.single[s.id] || {}];
        return { 板块: s.title, id: s.id, 多记录: !!s.multiple, 记录: recs.map(valueOf.bind(null, s)).filter((x) => Object.keys(x).length) };
      };
      const arg = String(args.section || '').trim();
      if (arg) {
        const s = findSec(arg);
        if (!s) return { name, args, ok: false, summary: `没有找到板块「${arg}」；可用：${SECTIONS.map((x) => x.title).join('、')}` };
        return { name, args, ok: true, summary: `已读取「${s.title}」`, result: dump(s) };
      }
      const overview = SECTIONS.map((s) => {
        if (s.multiple) {
          const recs = host.profile.multi[s.id] || [];
          const filled = recs.reduce((n, r) => n + s.fields.filter((f) => String(r[f.key] || '').trim()).length, 0);
          return { 板块: s.title, id: s.id, 记录数: recs.length, 已填字段: filled };
        }
        const r = host.profile.single[s.id] || {};
        return { 板块: s.title, id: s.id, 已填字段: s.fields.filter((f) => String(r[f.key] || '').trim()).length, 字段总数: s.fields.length };
      });
      return { name, args, ok: true, summary: '已读取资料库概览（要看细节就指定 section）', result: overview };
    }
    case 'profile_write': {
      const normSec = (s: string) => s.replace(/\s/g, '').toLowerCase();
      const s = SECTIONS.find((x) => x.id === String(args.section) || x.title === String(args.section)
        || normSec(x.title) === normSec(String(args.section || '')));
      if (!s) return { name, args, ok: false, summary: `没有找到板块「${args.section}」；可用：${SECTIONS.map((x) => x.title).join('、')}` };
      const raw = (args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields))
        ? args.fields as Record<string, unknown> : {};
      const pairs: [string, string][] = [];
      const unknown: string[] = [];
      for (const [k, v] of Object.entries(raw)) {
        const key = k.replace(/\s/g, '').toLowerCase();
        const f = s.fields.find((x) => x.key === k || x.name === k
          || x.key.toLowerCase() === key || x.name.replace(/\s/g, '').toLowerCase() === key);
        if (f) pairs.push([f.key, String(v ?? '')]);
        else unknown.push(k);
      }
      if (!pairs.length) {
        return { name, args, ok: false, summary: `没有识别出可写字段（${unknown.join('、') || '空'}）。该板块可用字段：${s.fields.map((f) => f.name).join('、')}` };
      }
      if (!s.multiple) {
        pairs.forEach(([k, v]) => host.setSingle(s.id, k, v));
        return { name, args, ok: true, summary: `已写入「${s.title}」${pairs.length} 个字段${unknown.length ? `（未识别：${unknown.join('、')}）` : ''}` };
      }
      const recs = host.profile.multi[s.id] || [];
      const want = String(args.record_name || '').trim();
      let idx = -1;
      if (want) {
        idx = recs.findIndex((r) => Object.values(r).some((v) => String(v || '').includes(want)));
      } else if (recs.length) idx = 0;
      if (idx >= 0) {
        host.updateMulti(s.id, idx, Object.fromEntries(pairs) as Rec);
        return { name, args, ok: true, summary: `已写入「${s.title}」第 ${idx + 1} 条记录${pairs.length} 个字段${unknown.length ? `（未识别：${unknown.join('、')}）` : ''}` };
      }
      const rec = Object.fromEntries(pairs) as Rec;
      host.addMulti(s.id, rec);
      return { name, args, ok: true, summary: `「${s.title}」里没有匹配的记录，已新建 1 条（${pairs.length} 个字段）${unknown.length ? `，未识别：${unknown.join('、')}` : ''}` };
    }
    case 'materials': {
      const list = host.materials.map((m) => ({ 分组: m.group, 名称: m.name, 已备好: !!m.done, 路径: m.path || null, 备注: m.note || null }));
      const todo = host.materials.filter((m) => !m.done).length;
      return { name, args, ok: true, summary: `材料清单共 ${list.length} 项，未备好 ${todo} 项`, result: list };
    }
    case 'update_material': {
      const kw = String(args.name || '').trim().toLowerCase();
      const hits = host.materials.filter((m) => m.name.toLowerCase().includes(kw) || `${m.group} ${m.name}`.toLowerCase().includes(kw));
      if (!hits.length) return { name, args, ok: false, summary: `材料清单里没找到「${args.name}」` };
      const patch: Partial<MaterialItem> = {};
      if (typeof args.done === 'boolean') patch.done = args.done;
      if (args.path) patch.path = String(args.path);
      if (args.note) patch.note = String(args.note);
      if (!Object.keys(patch).length) return { name, args, ok: false, summary: '没有给出要修改的内容' };
      hits.forEach((m) => host.updateMaterial(m.id, patch));
      return { name, args, ok: true, summary: `已更新 ${hits.length} 项材料`, result: hits.map((m) => ({ 名称: m.name })) };
    }
    case 'search_contacts': {
      const kw = String(args.query || '').trim().toLowerCase();
      const today = todayISO();
      const list = host.contacts.filter((c) => {
        if (args.due_only === true && !(c.nextFollowUp && c.nextFollowUp <= today)) return false;
        if (kw && !`${c.name} ${c.company || ''} ${c.role || ''} ${c.notes || ''}`.toLowerCase().includes(kw)) return false;
        return true;
      }).map((c) => ({
        姓名: c.name, 单位: c.company || null, 身份: c.role || null, 微信: c.wechat || null,
        邮箱: c.email || null, 电话: c.phone || null,
        上次联系: c.lastContact || null, 下次跟进: c.nextFollowUp || null,
        承诺: c.promised || null, 备注: c.notes || null,
      }));
      return { name, args, ok: true, summary: `找到 ${list.length} 位联系人`, result: list };
    }
    case 'add_contact': {
      const nm = String(args.name || '').trim();
      if (!nm) return { name, args, ok: false, summary: '缺少姓名' };
      const c = host.addContact({
        name: nm,
        company: args.company ? String(args.company) : undefined,
        role: args.role ? String(args.role) : undefined,
        wechat: args.wechat ? String(args.wechat) : undefined,
        email: args.email ? String(args.email) : undefined,
        phone: args.phone ? String(args.phone) : undefined,
        nextFollowUp: args.nextFollowUp ? String(args.nextFollowUp) : undefined,
        promised: args.promised ? String(args.promised) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
      });
      return { name, args, ok: true, summary: `已新增联系人：${c.name}${c.company ? ' · ' + c.company : ''}`, result: { id: c.id } };
    }
    default:
      return { name, args, ok: false, summary: `未知工具：${name}` };
  }
}

/* ================= 工具执行（同步 + 异步两层） =================
 * 站内工具是纯同步的（读写内存里的 store），联网工具必须异步。
 * 为了不动上面那一大串已经稳定运行的同步分支，这里分两层：
 *   runTool      —— 同步，只管站内数据（原样保留，改动风险为零）
 *   runToolAsync —— 异步入口：联网工具走网络，其余原样转交 runTool
 * UI 层统一 await runToolAsync，两边行为一致。
 *
 * 为什么要 try/catch 兜住网络错误而不是往外抛：抛出去会被 UI 当成「整轮失败」，
 * 用户看到一条红字报错、模型也拿不到任何反馈；而包成 ok:false 的 ToolRun 后，
 * 模型能读到「搜索失败：Key 无效」并据此告诉用户去改哪儿 —— 失败也是有用的信息。
 */
export async function runToolAsync(host: AgentHost, name: string, args: Record<string, unknown>): Promise<ToolRun> {
  if (name !== 'web_search') return runTool(host, name, args);

  const query = String(args.query || '').trim();
  if (!query) return { name, args, ok: false, summary: '缺少搜索关键词 query' };

  const cfg = getAiConfig();
  if (!hasSearchKey()) {
    return { name, args, ok: false, summary: '未配置联网搜索 Key，本站查不到的信息这次搜不了（设置 → AI 助手 → 联网搜索）。' };
  }

  const count = Math.max(1, Math.min(10, Number(args.count) || 6));
  try {
    const out = await webSearch(query, {
      count,
      freshness: args.freshness ? String(args.freshness) : undefined,
      summary: args.summary !== false,
    }, cfg);
    if (!out.items.length) {
      return { name, args, ok: true, summary: `联网搜索「${query}」没有结果`, result: { 查询: query, 结果: [], 提示: out.note } };
    }
    return {
      name, args, ok: true,
      summary: `联网搜索「${query}」，返回 ${out.items.length} 条网页结果`,
      result: {
        查询: query,
        结果: out.items.map((x) => ({
          标题: x.title,
          网址: x.url,
          站点: x.site || null,
          发布时间: x.date || null,
          /* 单条截 500 字：6 条就是 3k 字量级，足够模型归纳，又不至于把上下文撑爆 */
          摘要: (x.summary || x.snippet || '').slice(0, 500) || null,
        })),
      },
    };
  } catch (e) {
    return { name, args, ok: false, summary: `联网搜索失败：${(e as Error).message}` };
  }
}

/* ================= 站点快照（给模型的上下文） =================
 * 只放「一眼能看出该不该动手」的骨架信息（数量 + 结构 + 最近的几条），
 * 具体内容一律走工具查 —— 全量塞进上下文既贵又容易让模型凭摘要瞎猜。
 */
export function buildAgentContext(host: AgentHost): string {
  const j = host.jobs;
  const count = (xs: { status: string }[], s: string) => xs.filter((x) => x.status === s).length;
  const today = todayISO();
  const soonList = j
    .filter((x) => { const d = daysUntil(x.deadline); return d !== null && d >= 0 && d <= 7 && x.status !== 'applied' && x.status !== 'archived'; })
    .sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''))
    .slice(0, 5)
    .map((x) => `${x.company}${x.title ? '·' + x.title : ''}(${x.deadline}，${daysUntil(x.deadline)}天)`);
  const personal = Object.entries(host.profile.single?.personal || {}).filter(([, v]) => String(v || '').trim());
  const cats = sortCategories(host.bankCategories);
  const bankLine = cats.map((c) => {
    const bs = host.banks.filter((b) => (b.catId || FALLBACK_CAT_ID) === c.id).map((b) => b.name);
    const n = host.questions.filter((q) => questionCatId(q, host.banks) === c.id).length;
    return `${c.name}(${n}题${bs.length ? '：' + bs.join('/') : ''})`;
  }).join('；');
  const pendingInterviews = host.interviews.filter((i) => i.result === 'pending').length;
  const todoMaterials = host.materials.filter((m) => !m.done).length;
  const dueContacts = host.contacts.filter((c) => c.nextFollowUp && c.nextFollowUp <= today);

  return [
    `今天是 ${today}。`,
    `岗位库 ${j.length} 条（未投递 ${count(j, 'new') + count(j, 'interested')}、已投递 ${count(j, 'applied')}、已归档 ${count(j, 'archived')}）；7 天内截止 ${soonList.length} 条${soonList.length ? '：' + soonList.join('，') : ''}`,
    `投递记录 ${host.applications.length} 条（${['todo', 'filling', 'submitted', 'test', 'interview', 'offer', 'reject'].map((s) => `${STATUS_META[s]?.label || s} ${count(host.applications, s)}`).join('、')}）`,
    `日历事件 ${host.events.length} 条、面试复盘 ${host.interviews.length} 场（待出结果 ${pendingInterviews}）、Offer ${host.offers.length} 个`,
    `题库 ${host.questions.length} 题（未掌握 ${host.questions.filter((q) => !q.mastered).length}）、分类 ${cats.length} 个、库 ${host.banks.length} 个 —— 结构：${bankLine || '（空）'}`,
    `材料清单 ${host.materials.length} 项（未备好 ${todoMaterials}）、人脉 ${host.contacts.length} 位${dueContacts.length ? `（${dueContacts.map((c) => c.name).slice(0, 5).join('、')} 该跟进了）` : ''}`,
    `用户档案：${personal.slice(0, 12).map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join('；') || '（未填写）'}`,
    /* 这一行决定模型「会不会承认自己搜不了」。
       配了 Key 却说「我没有联网工具」是这个站上真实发生过的投诉（用户截图反馈），
       根因就是提示词里从没告诉过它有没有这个能力 —— 所以这里必须显式说清。 */
    `联网搜索：${hasSearchKey()
      ? '已配置（web_search 可用）。站外信息（招聘公告、岗位待遇、笔试面试经验、公司背景、行业薪资）一律用它去搜，不要凭记忆作答，也不要说「我没有联网工具」。'
      : '未配置（web_search 不可用）。用户问站外信息时，如实说明「本机没有配联网搜索 Key」，并指引到「设置 → AI 助手 → 联网搜索」；绝不编造具体数字或事实。'}`,
    `提示：以上只是骨架。要看具体内容（岗位要求、题目、资料库字段、材料路径、面试问题等）请调用对应查询工具，不要凭这些数字推测。`,
  ].join('\n');
}

export const AGENT_SYSTEM = `你是「秋招网申辅助中心」网站内置的助手，直接帮用户操作这个网站。

能力（都有对应工具，**必须调用工具拿真实数据，绝不凭记忆或推测作答**）：
· 岗位库：检索 / 新增 / 改字段 / 改状态 / 删（删除类需确认）
· 投递记录：检索 / 新增 / 改状态 / 删（删除类需确认）
· 日历与截止：加事件 / 查未来截止
· 题库：查分类与库结构 / 检索题目 / 新增题目 / 新建分类与库 / 标记已掌握 / 移动题目 / 删题
· 面试复盘：检索 / 新增；Offer：查看对比 / 新增
· 网申资料库：按板块读取字段 / 写入字段（写之前先读一遍，避免覆盖）
· 材料清单：查看 / 标记已备好 / 补路径；人脉：检索 / 新增
· 切页：navigate 让用户直接看到结果
· 联网搜索：web_search 查真实互联网 —— 招聘公告与截止时间、岗位待遇/薪资、笔试面试经验、公司背景、政策与行业行情。
  **本站没有的信息都在这里查**（用户说「查一下/搜一下/联网查/结合网络」时就是指它）。

原则：
1. 用户让你做操作时，**直接调用工具完成**，做完用一两句话说明改了什么。不要只给建议。
2. 拿不准目标时就先查（例如「把中金标记为已投递」先 search_jobs 确认有几条），目标不唯一时向用户复述确认。
3. 删除类工具务必先得到用户明确同意（界面上会弹确认，但你也应当说明将删除什么）。
4. 涉及题库结构时：库必须先有分类；不确定库名就先 question_banks 看结构，别猜。
5. 涉及资料库写入时：先 profile_read 看现有内容与字段名，再 profile_write；字段名对不上就把该板块可用字段回给用户。
6. 回答简洁，中文，不要复述工具返回的原始 JSON。需要展示清单时用短列表（每行一条，最多 8 条，其余折叠说明）。
7. 涉及日期以系统提示里的「今天是」为基准。
8. 用户说「清理重复」时：先用 dedupe_jobs 预演（dry_run: true）看有多少；同名重复可直接执行，
   若结果里有「疑似重复未合并」（标题互为包含），先把它们列给用户确认，用户同意后再用 merge_similar: true 执行。
9. 如果用户没配 AI Key 或工具调用失败，直接说明原因，不要编造数据。
10. **联网搜索的规矩**（站外信息一律按这条来）：
    · 用户问待遇、薪资、公告、截止日期、面经、公司背景这类站外信息时，先 web_search，再据结果回答。**不要先说「我没有联网工具」**。
    · 关键词用中文、把「单位名 + 年份 + 要查的点」写全；问最新公告时带 freshness: 'oneMonth'。
    · 答案里凡是用到搜索结果的地方，都附上来源（站点名 + 链接），方便用户自己复核。
    · 搜索摘要只是网页片段，可能过时或有误：说法不一致时要指出分歧，不要挑一个当定论。
    · 涉及薪资/待遇时明确说是「网上信息、仅供参考」，绝不把搜索到的数字说成官方口径。
    · **搜索词里不要带用户的姓名、手机号、邮箱、身份证号等个人信息**，只搜单位与岗位层面的公开信息。
    · web_search 返回 ok:false 时，把失败原因原样告诉用户（例如 Key 无效），并指出要去「设置 → AI 助手 → 联网搜索」处理。`;

/* ================= 模型调用（带工具） ================= */
interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string; }

export async function callModelWithTools(cfg: AiConfig, messages: ChatMessage[], timeout = 60000): Promise<ChatMessage> {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model, temperature: 0.2, messages,
        tools: AGENT_TOOLS.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.parameters } })),
        tool_choice: 'auto',
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      /* 结构类 400 有两句官方原话，必须都认出来 —— 只认第一句会把它误判成
         「模型不支持工具调用」，把用户引去换模型（截图里就是这么误导的）：
           ① An assistant message with 'tool_calls' must be followed by tool messages…
           ② Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
         两句都提到 tool_call / tool messages，用这段正则一网打尽，再退回泛化判断。 */
      const structErr = /must be a response to a preceding message|must be followed by tool messages|tool_call_id/i.test(txt);
      const hint = res.status === 404 ? '（接口路径或模型名不对：请确认 Base URL 形如 https://api.deepseek.com/v1）'
        : res.status === 401 ? '（API Key 无效）'
        : res.status === 400 && structErr ? '（对话结构异常：历史里有一条工具结果找不到对应的工具调用——多半是上次操作被中断，或历史被截断。已自动修复，直接重发即可）'
        : res.status === 400 && /tool|function/i.test(txt) ? '（该模型/接口可能不支持工具调用，请换用支持 function calling 的模型，如 deepseek-chat）'
        : '';
      throw new Error(`模型接口 ${res.status}${hint}：${txt.slice(0, 160)}`);
    }
    const d = await res.json();
    const msg = d?.choices?.[0]?.message;
    if (!msg) throw new Error('模型返回为空');
    return msg as ChatMessage;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`请求超时（${Math.round(timeout / 1000)}s）`);
    throw e;
  } finally { clearTimeout(t); }
}

export { AGENT_TOOLS as TOOLS };


/* ================= 对话结构修复 =================
 * OpenAI 协议对 tool 消息的位置有两条硬约束，破任意一条整轮就 400：
 *   ① 带 tool_calls 的 assistant 后面，必须**逐条**跟上对应 tool_call_id 的 tool 消息；
 *   ② 反过来，任何 tool 消息的前面必须有一条声明了它 id 的 assistant。
 * 实战里这三处会把它破坏掉：
 *   · 危险操作等用户确认时被中断、关页面、切会话 → 只回执了一部分 tool（缺，破 ①）；
 *   · 会话落 localStorage 时按**条数**截断，把某一批 tool 从中间切开，孤立的 tool
 *     跑到数组开头（破 ②，DeepSeek 原话就是 "Messages with role 'tool' must be a
 *     response to a preceding message with 'tool_calls'"）；
 *   · 刷新后接着聊时把 system 盲写到 [0]，覆盖掉恰好位于数组头部的 assistant(tool_calls)
 *     （同样破 ②，且一次能废掉整批 tool）。
 * 所以这里做**双向体检**：缺的回执补上、孤立的 tool 丢掉。只补不删是不够的 ——
 * 那正是「聊着聊着突然 400、而且重发也没用」的原因。
 */
export function sanitizeConversation(msgs: unknown[]): unknown[] {
  const list = (Array.isArray(msgs) ? msgs : []) as {
    role?: string; tool_calls?: { id?: string }[]; tool_call_id?: string;
  }[];
  const out: unknown[] = [];
  /** 当前这条 assistant 还欠哪些 tool_call_id 的回执（按声明顺序） */
  let pending: string[] = [];

  const flushPending = () => {
    for (const id of pending) {
      out.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: false, summary: '（该步骤未执行完成，已跳过）' }) });
    }
    pending = [];
  };
  const declared = (m: { tool_calls?: { id?: string }[] }) =>
    Array.isArray(m?.tool_calls) ? m.tool_calls.map((c) => c?.id).filter((x): x is string => !!x) : [];

  for (const m of list) {
    if (!m || typeof m !== 'object' || !m.role) continue;

    if (m.role === 'tool') {
      /* ② 找不到声明它的 assistant → 是上次被截断/被覆盖留下的孤儿，丢掉；
            找得到就收下并销账（用 indexOf 兼容乱序回执） */
      const at = m.tool_call_id ? pending.indexOf(m.tool_call_id) : -1;
      if (at < 0) continue;
      pending.splice(at, 1);
      out.push(m);
      continue;
    }

    /* ① 出现新的非 tool 消息前，先把还欠的回执补齐 —— 顺序不能反 */
    flushPending();
    out.push(m);
    pending = declared(m);
  }
  flushPending();
  return out;
}

/* ================= 持久化截断 =================
 * 会话存 localStorage 有条数上限，切的时候必须**按整轮切**：从某条 user 消息起头往后留。
 * 直接 slice(-N) 会把某一批 tool 从中间切开，留下孤立的 tool 消息 —— 这种会话下次
 * 一打开就是 400，sanitizeConversation 虽然能兜住，但兜法是把用户真问过的上下文一起
 * 当成「未完成的步骤」清掉，等于静默失忆。
 * 规则：保留 system（如果有）+ 预算内尽可能多的**完整**轮次；单轮本身就超预算时宁可
 * 超一点，也不能从中间切。
 */
export function trimRawConversation(raw: unknown[], max: number): unknown[] {
  const list = (Array.isArray(raw) ? raw : []).filter((m) => m && typeof m === 'object');
  if (list.length <= max || max <= 0) return list;
  const hasSys = (list[0] as { role?: string })?.role === 'system';
  const sys = hasSys ? list[0] : null;
  const body = hasSys ? list.slice(1) : list;

  const starts: number[] = [];
  body.forEach((m, i) => { if ((m as { role?: string })?.role === 'user') starts.push(i); });
  const budget = sys ? max - 1 : max;
  /* 没有 user 分界（异常数据）时退化成按条切，交给 sanitizeConversation 收尾 */
  if (!starts.length) return sys ? [sys, ...body.slice(-Math.max(1, budget))] : body.slice(-Math.max(1, budget));

  /* 取预算内最早的那一轮起点，留下尽量多且完整的轮次 */
  let from = starts[starts.length - 1];
  for (const s of starts) { if (body.length - s <= budget) { from = s; break; } }
  return sys ? [sys, ...body.slice(from)] : body.slice(from);
}
