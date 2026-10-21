/**
 * 只读演示数据 —— 只在 URL 带 `?demo=1` 时才被载入（见 src/lib/demoMode.tsx）。
 *
 * 为什么要单独一份：站点是「登录 + 云端」结构，未登录看不到首页与日历；
 * 而设计评审必须对着真实渲染的截图看。这份数据让两屏能以真实结构渲染出来。
 *
 * 铁律：**这里的公司名、日期、数字全是构造的**，不代表用户任何真实投递记录。
 * 唯一真实的是 `profile`（来自站点自带的 SEED_PROFILE 种子结构），这样首页读起来是连贯的。
 */
import type { Application, CalEvent, JobPosting } from '../types';

/* 固定基准日，避免「今天」漂移导致截图每次都不一样（演示模式只用于设计评审） */
const TODAY = new Date(2026, 9, 20); // 2026-10-20
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (offset: number) => { const d = new Date(TODAY); d.setDate(d.getDate() + offset); return iso(d); };

const st = (s: Application['status'], at: string, note?: string) => ({ status: s, at, note, done: true });

export const DEMO_SEED = {
  _v: 7,
  profile: undefined as never, // 留空：shape() 会用 SEED_PROFILE 的结构补齐，不伪造个人资料
  theme: 'dark' as const,
  skin: undefined as never,
  resumeText: '',
  applications: [
    {
      id: 'a1', company: '中电科某研究所', position: '后端开发工程师', status: 'interview',
      channel: '内推', location: '南京', deadline: day(6), salary: '18-25k',
      contact: '张老师', submittedAt: day(-9), createdAt: day(-12), updatedAt: day(-2),
      notes: '已过一面，二面安排在下周三上午。', timeline: [
        st('todo', day(-12)), st('submitted', day(-9)), st('test', day(-5)), st('interview', day(-2)),
      ],
    },
    {
      id: 'a2', company: '某国有银行', position: '金融科技岗', status: 'test',
      channel: '官网', location: '北京', deadline: day(2), salary: '15-20k',
      submittedAt: day(-7), createdAt: day(-10), updatedAt: day(-1),
      notes: '在线笔试 120 分钟，行测 + 专业题。', timeline: [
        st('submitted', day(-7)), st('test', day(-1)),
      ],
    },
    {
      id: 'a3', company: '某互联网大厂', position: '前端工程师', status: 'offer',
      channel: '官网', location: '杭州', salary: '25-35k',
      submittedAt: day(-21), createdAt: day(-24), updatedAt: day(-3),
      notes: '已发意向书，10 月底前答复。', timeline: [
        st('submitted', day(-21)), st('test', day(-15)), st('interview', day(-8)), st('offer', day(-3)),
      ],
    },
    {
      id: 'a4', company: '某能源集团', position: '数据分析岗', status: 'filling',
      channel: 'BOSS直聘', location: '深圳', deadline: day(9),
      createdAt: day(-2), updatedAt: day(-1),
      notes: '个人信息已填 70%，还差项目经历。', timeline: [st('todo', day(-2)), st('filling', day(-1))],
    },
    {
      id: 'a5', company: '某省属国企', position: '综合管理岗', status: 'submitted',
      channel: '官网', location: '成都', deadline: day(14),
      submittedAt: day(-4), createdAt: day(-4), updatedAt: day(-4),
      timeline: [st('submitted', day(-4))],
    },
    {
      id: 'a6', company: '某券商', position: '量化研究助理', status: 'reject',
      channel: '内推', location: '上海', submittedAt: day(-30), createdAt: day(-33), updatedAt: day(-11),
      notes: '简历未通过筛选。', timeline: [st('submitted', day(-30)), st('reject', day(-11))],
    },
    {
      id: 'a7', company: '某通信设备商', position: '嵌入式软件工程师', status: 'todo',
      channel: '官网', location: '西安', deadline: day(4),
      createdAt: day(-1), updatedAt: day(-1),
      notes: '还没开始填，截止前必须动。', timeline: [st('todo', day(-1))],
    },
    {
      id: 'a8', company: '某商业银行', position: '数据运营岗', status: 'interview',
      channel: '官网', location: '武汉', submittedAt: day(-14), createdAt: day(-16), updatedAt: day(-6),
      timeline: [st('submitted', day(-14)), st('test', day(-9)), st('interview', day(-6))],
    },
  ] as unknown as Application[],

  events: [
    { id: 'e1', title: '中电科某研究所 · 二面', date: day(1), time: '10:00', type: 'interview', appId: 'a1', place: '线上 · 腾讯会议', source: 'manual', done: false },
    { id: 'e2', title: '某国有银行 · 在线笔试', date: day(2), time: '14:00', type: 'test', appId: 'a2', place: '线上笔试系统', source: 'manual', done: false },
    { id: 'e3', title: '某商业银行 · 终面', date: day(3), time: '09:30', type: 'interview', appId: 'a8', place: '武汉 · 光谷', source: 'manual', done: false },
    { id: 'e4', title: '中电科某研究所 · 投递截止', date: day(6), type: 'deadline', appId: 'a1', source: 'application', done: false },
    { id: 'e5', title: '补齐某能源集团网申信息', date: day(0), time: '20:00', type: 'todo', appId: 'a4', source: 'manual', done: false },
    { id: 'e6', title: '答复某互联网大厂意向书', date: day(5), type: 'offer', appId: 'a3', source: 'manual', done: false },
    { id: 'e7', title: '某通信设备商 · 投递截止', date: day(4), type: 'deadline', appId: 'a7', source: 'application', done: false },
    { id: 'e8', title: '某省属国企 · 投递截止', date: day(14), type: 'deadline', appId: 'a5', source: 'application', done: false },
    { id: 'e9', title: '整理本周面试复盘', date: day(-1), type: 'todo', source: 'manual', done: true },
    { id: 'e10', title: '某券商 · 简历筛选', date: day(-11), type: 'other', appId: 'a6', source: 'application', done: true },
    { id: 'e11', title: '某国有银行 · 笔试成绩公布', date: day(8), type: 'other', appId: 'a2', source: 'manual', done: false },
    { id: 'e12', title: '更新一版中文简历', date: day(7), time: '21:00', type: 'todo', source: 'manual', done: false },
  ] as unknown as CalEvent[],

  jobs: [] as unknown as JobPosting[],
  questions: [],
  banks: [],
  bankCategories: undefined as never,
  companies: [],
  offers: [],
  interviews: [],
  materials: [],
  versions: [],
  contacts: [],
  remind: undefined as never,
};
