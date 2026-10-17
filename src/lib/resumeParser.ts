/**
 * 简历解析器：从 PDF / DOCX 文件中提取文本，并结构化解析为个人资料。
 * 支持正则提取基础字段 + AI 提取复杂结构（教育/实习/项目经历）。
 */

import type { ProfileData, Rec } from '../types';
import { getAiConfig, callAi, extractJsonObject } from './ai';

/* ================= PDF 文本提取 ================= */
let pdfjsWorker: any = null;

async function getPDFWorker() {
  if (!pdfjsWorker) {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';  // 使用主线程模式
    pdfjsWorker = pdfjsLib;
  }
  return pdfjsWorker;
}

export async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await getPDFWorker();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // 按 y 坐标分组文本项，模拟阅读顺序
    const items = content.items as any[];
    const rows: Map<number, string[]> = new Map();
    for (const item of items) {
      if (!('str' in item)) continue;
      const y = Math.round(item.transform[5]);
      const row = rows.get(y) || [];
      row.push(item.str);
      rows.set(y, row);
    }
    // 按 y 坐标降序排列（PDF 坐标原点在左下角）
    const sortedY = Array.from(rows.keys()).sort((a, b) => b - a);
    for (const y of sortedY) {
      lines.push(rows.get(y)!.join(' '));
    }
    lines.push('');  // 分页空行
  }
  return lines.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ================= DOCX 文本提取 ================= */
export async function extractTextFromDOCX(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.replace(/\s+/g, ' ').replace(/ \n /g, '\n').trim();
}

/* ================= 统一文本提取入口 ================= */
export async function extractResumeText(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return extractTextFromPDF(file);
  /* mammoth 只认 OOXML(.docx)：把 .doc 也丢给它只会得到一句难懂的解析错误 */
  if (ext === 'doc') throw new Error('浏览器无法解析旧版 .doc：请在 Word / WPS 里「另存为 .docx」后重新上传');
  if (ext === 'docx') return extractTextFromDOCX(file);
  throw new Error(`不支持的文件格式：.${ext}，请上传 PDF 或 DOCX 文件`);
}

/* ================= 正则解析基础字段 ================= */
export interface ParsedBasic {
  name?: string;
  phone?: string;
  email?: string;
  gender?: string;
  birthday?: string;
  currentCity?: string;
  nativePlace?: string;
  highestEdu?: string;
  englishLevel?: string;
  political?: string;
}

export function parseBasicFields(text: string): ParsedBasic {
  const result: ParsedBasic = {};

  // 手机号：11 位数字，1 开头
  const phoneMatch = text.match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  if (phoneMatch) result.phone = phoneMatch[0];

  // 邮箱
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) result.email = emailMatch[0];

  // 性别
  if (/性\s*别[：:\s]*男/.test(text)) result.gender = '男';
  else if (/性\s*别[：:\s]*女/.test(text)) result.gender = '女';

  // 出生日期
  const bdayMatch = text.match(/(?:出生|生日|出生日期)[：:\s]*(\d{4})[./\-年](\d{1,2})[./\-月](\d{1,2})/);
  if (bdayMatch) {
    result.birthday = `${bdayMatch[1]}-${bdayMatch[2].padStart(2, '0')}-${bdayMatch[3].padStart(2, '0')}`;
  } else {
    /* 兜底不能拿全文第一个日期当生日：简历里最先出现的往往是教育 / 实习时间，
       会把「2023-05-01 入职」写成出生日期并直接进入个人档案。
       这里只接受「算出来 16–45 岁」的候选。 */
    const year = new Date().getFullYear();
    for (const m of text.matchAll(/(\d{4})[./\-](\d{1,2})[./\-](\d{1,2})/g)) {
      const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const age = year - y;
      if (age < 16 || age > 45) continue;
      result.birthday = `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      break;
    }
  }

  // 政治面貌
  const polMatch = text.match(/政治(?:面貌|身份)[：:\s]*(中共党员|中共预备党员|共青团员|群众|民主党派)/);
  if (polMatch) result.political = polMatch[1];

  // 最高学历
  const eduKeywords = ['博士研究生', '硕士研究生', '本科', '大专', '高中'];
  for (const edu of eduKeywords) {
    if (text.includes(edu)) { result.highestEdu = edu; break; }
  }

  // 英语等级
  const engMatch = text.match(/(?:英语|外语|语言)[：:\s]*(CET-?[46]|TEM-?[48]|雅思|托福|IELTS|TOEFL)[\s（(]*(\d+\.?\d*)?/);
  if (engMatch) {
    const level = engMatch[1].toUpperCase().replace('CET-', 'CET-').replace('TEM-', 'TEM-');
    result.englishLevel = level.startsWith('CET') || level.startsWith('TEM') ? level : (level.includes('雅思') || level.includes('IELTS') ? '雅思' : '托福');
  }

  // 现居住地
  const cityMatch = text.match(/(?:现居|居住地|所在城市|所在地)[：:\s]*([\u4e00-\u9fa5]{2,6}(?:市|省|区))/);
  if (cityMatch) result.currentCity = cityMatch[1];

  // 籍贯
  const nativeMatch = text.match(/(?:籍贯|生源地)[：:\s]*([\u4e00-\u9fa5]{2,6}(?:省|市|县|区))/);
  if (nativeMatch) result.nativePlace = nativeMatch[1];

  // 姓名：尝试从简历头部提取（通常在第一行或前几行）
  const firstLines = text.split('\n').slice(0, 5).join('\n');
  // 模式：姓名后面跟着手机号或邮箱
  const namePhoneMatch = firstLines.match(/^([\u4e00-\u9fa5]{2,4})\s*(?:1[3-9]\d{9}|[\w.+-]+@)/m);
  if (namePhoneMatch) result.name = namePhoneMatch[1];
  else {
    // 模式：姓名单独一行，2-4 个中文字
    const nameLine = firstLines.match(/^([\u4e00-\u9fa5]{2,4})\s*$/m);
    if (nameLine) result.name = nameLine[1];
  }

  return result;
}

/* ================= AI 解析复杂结构 ================= */
export interface ParsedEducation {
  school: string;
  college?: string;
  major: string;
  edu: string;
  degree?: string;
  start: string;
  end: string;
  gpa?: string;
  courses?: string;
  rank?: string;
}

export interface ParsedExperience {
  company: string;
  position: string;
  start: string;
  end: string;
  content: string;
  referee?: string;
}

export interface ParsedProject {
  name?: string;
  start: string;
  end: string;
  desc: string;
  duty?: string;
  result?: string;
}

export interface ParsedAward {
  name: string;
  date?: string;
  level?: string;
}

export interface ParsedResume {
  basic: ParsedBasic;
  education: ParsedEducation[];
  internship: ParsedExperience[];
  work: ParsedExperience[];
  project: ParsedProject[];
  award: ParsedAward[];
  selfEval?: string;
}

const RESUME_PARSE_SYSTEM =
  '你是简历结构化解析专家。用户会提供一份简历的文本内容，你需要将其解析为结构化的 JSON 对象。' +
  '只输出一个 JSON 对象，不要任何解释。字段如下：\n' +
  'basic: {name(姓名),phone(手机号),email(邮箱),gender(性别:男/女),birthday(出生日期YYYY-MM-DD),political(政治面貌),highestEdu(最高学历:本科/硕士研究生/博士研究生/大专),englishLevel(英语等级:CET-4/CET-6/TEM-4/TEM-8/雅思/托福),currentCity(现居城市),nativePlace(籍贯)}\n' +
  'education: [{school(学校),college(学院),major(专业),edu(学历),degree(学位:学士/硕士/博士),start(入学YYYY-MM),end(毕业YYYY-MM),gpa(成绩),courses(主修课程)}]\n' +
  'internship: [{company(公司),position(岗位),start(开始YYYY-MM),end(结束YYYY-MM或"至今"),content(工作内容描述)}]\n' +
  'work: [{company(公司),position(职位),start(开始YYYY-MM),end(结束YYYY-MM或"至今"),content(工作职责)}]\n' +
  'project: [{name(项目名称),start(开始),end(结束),desc(项目描述),duty(个人职责),result(项目成果)}]\n' +
  'award: [{name(奖项名称),date(获奖时间YYYY-MM),level(级别:国家级/省部级/校级/院级)}]\n' +
  'selfEval(自我评价，200字以内)\n\n' +
  '规则：\n' +
  '1. 抽不到的字段给空字符串\n' +
  '2. 日期统一为 YYYY-MM 或 YYYY-MM-DD 格式\n' +
  '3. 教育经历按时间倒序排列\n' +
  '4. 实习/工作经历按时间倒序排列\n' +
  '5. 不要编造简历中没有的信息\n' +
  '6. 如果简历中某板块完全没有，对应数组给空数组';

export async function aiParseResume(text: string): Promise<ParsedResume> {
  const cfg = getAiConfig();
  const raw = await callAi(cfg, RESUME_PARSE_SYSTEM, text.slice(0, 15000), 90000);
  const o = extractJsonObject(raw);
  if (!o) throw new Error('AI 解析返回格式异常');

  const s = (k: string, obj?: Record<string, unknown>) => {
    const v = obj ? obj[k] : o[k];
    return v ? String(v).trim() : '';
  };
  const arr = (k: string) => {
    const v = o[k];
    return Array.isArray(v) ? v as Record<string, unknown>[] : [];
  };

  const basic: ParsedBasic = {
    name: s('name'), phone: s('phone'), email: s('email'),
    gender: s('gender'), birthday: s('birthday'), political: s('political'),
    highestEdu: s('highestEdu'), englishLevel: s('englishLevel'),
    currentCity: s('currentCity'), nativePlace: s('nativePlace'),
  };

  const education: ParsedEducation[] = arr('education').map((e) => ({
    school: s('school', e), college: s('college', e) || undefined,
    major: s('major', e), edu: s('edu', e), degree: s('degree', e) || undefined,
    start: s('start', e), end: s('end', e),
    gpa: s('gpa', e) || undefined, courses: s('courses', e) || undefined,
  }));

  const internship: ParsedExperience[] = arr('internship').map((e) => ({
    company: s('company', e), position: s('position', e),
    start: s('start', e), end: s('end', e), content: s('content', e),
    referee: s('referee', e) || undefined,
  }));

  const work: ParsedExperience[] = arr('work').map((e) => ({
    company: s('company', e), position: s('position', e),
    start: s('start', e), end: s('end', e), content: s('content', e),
  }));

  const project: ParsedProject[] = arr('project').map((e) => ({
    name: s('name', e) || undefined,
    start: s('start', e), end: s('end', e),
    desc: s('desc', e), duty: s('duty', e) || undefined,
    result: s('result', e) || undefined,
  }));

  const award: ParsedAward[] = arr('award').map((e) => ({
    name: s('name', e), date: s('date', e) || undefined,
    level: s('level', e) || undefined,
  }));

  return { basic, education, internship, work, project, award, selfEval: s('selfEval') || undefined };
}

/* ================= 合并解析结果 ================= */
/** 将 AI 解析结果与正则解析结果合并（正则优先，AI 补充） */
export function mergeParsedResults(aiResult: ParsedResume, regexResult: ParsedBasic): ParsedResume {
  const basic = { ...aiResult.basic };
  // 正则结果作为兜底
  if (!basic.name && regexResult.name) basic.name = regexResult.name;
  if (!basic.phone && regexResult.phone) basic.phone = regexResult.phone;
  if (!basic.email && regexResult.email) basic.email = regexResult.email;
  if (!basic.gender && regexResult.gender) basic.gender = regexResult.gender;
  if (!basic.birthday && regexResult.birthday) basic.birthday = regexResult.birthday;
  if (!basic.highestEdu && regexResult.highestEdu) basic.highestEdu = regexResult.highestEdu;
  if (!basic.englishLevel && regexResult.englishLevel) basic.englishLevel = regexResult.englishLevel;
  if (!basic.currentCity && regexResult.currentCity) basic.currentCity = regexResult.currentCity;
  if (!basic.nativePlace && regexResult.nativePlace) basic.nativePlace = regexResult.nativePlace;
  if (!basic.political && regexResult.political) basic.political = regexResult.political;
  return { ...aiResult, basic };
}

/* ================= 转换为 ProfileData ================= */
/** 将解析结果转换为 store 可用的 ProfileData 格式 */
export function parsedToProfile(parsed: ParsedResume): ProfileData {
  const b = parsed.basic;
  const personal: Rec = {};
  if (b.name) personal.name = b.name;
  if (b.phone) personal.phone = b.phone;
  if (b.email) personal.email = b.email;
  if (b.gender) personal.gender = b.gender;
  if (b.birthday) personal.birthday = b.birthday;
  if (b.political) personal.political = b.political;
  if (b.highestEdu) personal.highestEdu = b.highestEdu;
  if (b.englishLevel) personal.englishLevel = b.englishLevel;
  if (b.currentCity) personal.currentCity = b.currentCity;
  if (b.nativePlace) personal.nativePlace = b.nativePlace;

  const extra: Rec = {};
  if (parsed.selfEval) extra.selfEval = parsed.selfEval;

  const education: Rec[] = parsed.education.map((e) => {
    const r: Rec = { school: e.school, major: e.major, start: e.start, end: e.end };
    if (e.edu) r.edu = e.edu;
    if (e.degree) r.degree = e.degree;
    if (e.college) r.college = e.college;
    if (e.gpa) r.gpa = e.gpa;
    if (e.courses) r.courses = e.courses;
    return r;
  });

  const internship: Rec[] = parsed.internship.map((e) => ({
    company: e.company, position: e.position, start: e.start, end: e.end, content: e.content,
    ...(e.referee ? { referee: e.referee } : {}),
  }));

  const work: Rec[] = parsed.work.map((e) => ({
    company: e.company, position: e.position, start: e.start, end: e.end, duty: e.content,
  }));

  const project: Rec[] = parsed.project.map((e) => ({
    ...(e.name ? { name: e.name } : {}),
    start: e.start, end: e.end, desc: e.desc,
    ...(e.duty ? { duty: e.duty } : {}),
    ...(e.result ? { result: e.result } : {}),
  }));

  const award: Rec[] = parsed.award.map((e) => ({
    name: e.name, ...(e.date ? { date: e.date } : {}), ...(e.level ? { level: e.level } : {}),
  }));

  return {
    single: { personal, education: {}, resumeFile: {}, extra },
    multi: {
      education, internship, work, project,
      practice: [], certificate: [], award, paper: [], family: [],
    },
  };
}
