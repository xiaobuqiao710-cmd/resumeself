/**
 * 题组（一场面试 / 一套卷）—— 题库列表的最小展示单位。
 *
 * ## 为什么要有「题组」而不是一路平铺单题
 * 用户真实拿到的素材形态是「一整场面试的问法清单」：一次 30~40 题，同属一家单位。
 * 老版本把每道题都做成一张卡，结果有三处必然的痛：
 *   ① 列表炸成几十张卡，找某一题要滚很久；
 *   ② 归档要逐题点「移动」，或者进「批量移入」模式再勾选，路径长到没人愿意走；
 *   ③ 场次信息（单位/轮次）只能在每张卡上重复显示。
 * 题组把「整场」提升成列表上的一个单位：**整篇粘贴进来 → 一条卡 → 展开才是逐题**。
 *
 * ## 为什么不建一张新表
 * 题组只有「一个 id + 一个标题」，把它拆成独立实体要动 store / 云同步文档 / 合并导入 /
 * AI agent 四条链路，收益却只是一个标题。所以 groupId 与 groupTitle 直接冗余在每道题上：
 * 代价是改名要写 N 条（一次 setState 搞定），换来的是整条链路零改动、老数据零迁移。
 */
import type { Question } from '../types';

/** 题组在列表里的渲染单位（单题也会被包成一个只有 1 项的组，好让列表只有一种渲染路径） */
export interface QGroup {
  /** React key：题组用 groupId，单题用 `solo:题id` */
  key: string;
  /** 题组 id；单题为 undefined */
  groupId?: string;
  /** 题组标题；单题为空串 */
  title: string;
  /** 是不是真正的题组（决定卡片走「可展开」还是「直接显示题干」） */
  isSet: boolean;
  items: Question[];
  /** 未掌握题数 */
  unmastered: number;
  written: number;
  interview: number;
  /** 组内所有题在输入数组里的最小下标：用来稳定「组间次序」 */
  minIdx: number;
}

/** 组内排序：显式 order 优先，缺失的回退到「插入顺序」（addQuestionSet 是 unshift，故按数组倒序） */
function byOrd(a: Question, b: Question, idx: Map<string, number>): number {
  const oa = a.order;
  const ob = b.order;
  if (oa != null && ob != null && oa !== ob) return oa - ob;
  if (oa != null && ob == null) return -1;
  if (oa == null && ob != null) return 1;
  return (idx.get(a.id) || 0) - (idx.get(b.id) || 0);
}

/**
 * 把任意题目数组折叠成「题组 + 单题」混合的展示列表。
 *
 * 组间次序用「组内所有题在输入数组里的**最小**下标」——输入数组本身已经带好了用户期望的
 * 顺序（未掌握优先、更新时间等），这里不重新发明排序规则，只负责把同组的题粘在一起、
 * 且不改变组与组之间的相对次序。取最小而非「排序后第一条」：改过名的题组、被编辑过的题
 * 在数组里的位置会漂，取最小才不会让整组突然跳到最后去。
 */
export function buildGroups(qs: Question[]): QGroup[] {
  const idx = new Map<string, number>();
  qs.forEach((q, i) => idx.set(q.id, i));

  const buckets = new Map<string, QGroup>();
  for (const q of qs) {
    const key = q.groupId ? `g:${q.groupId}` : `solo:${q.id}`;
    const at = idx.get(q.id) || 0;
    let g = buckets.get(key);
    if (!g) {
      g = {
        key, groupId: q.groupId, title: (q.groupTitle || '').trim(),
        isSet: !!q.groupId, items: [], unmastered: 0, written: 0, interview: 0, minIdx: at,
      };
      buckets.set(key, g);
    }
    g.items.push(q);
    if (at < g.minIdx) g.minIdx = at;
    if (!q.mastered) g.unmastered++;
    if (q.kind === 'interview') g.interview++; else g.written++;
    /* 标题以组内任意一条为准：改名时整组会被一起改写，这里只是兜底 */
    if (!g.title && q.groupTitle) g.title = q.groupTitle.trim();
  }

  const out = Array.from(buckets.values());
  out.forEach((g) => g.items.sort((a, b) => byOrd(a, b, idx)));
  out.sort((a, b) => a.minIdx - b.minIdx);
  return out;
}

/** 题组标题的默认兜底（老数据 / 用户没填标题时） */
export function groupFallbackTitle(g: QGroup): string {
  if (!g.isSet) return '';
  if (g.title) return g.title;
  const co = g.items.find((x) => x.company)?.company;
  const yr = g.items.find((x) => x.year)?.year;
  const head = [co, yr].filter(Boolean).join(' ');
  return head ? `${head} 面试题` : `未命名题组（${g.items.length} 题）`;
}

/**
 * 题干里带的编号前缀（`1.` / `1、` / `(1)` / `①` / `第 1 题` / `Q1:`）——切题时按它断行，
 * 存库前再剥掉（列表里已经有自己的序号，题干里再带一个既冗余又会对不上）。
 */
const MARK = /^\s*(?:[(（]\s*\d+\s*[)）]|\d+\s*[.、)）:：]|第\s*\d+\s*[题问]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]|[Qq]\s*\d+\s*[.、:：)）]?)\s*/;

/** 单行是否像「一道新题的开头」 */
export function looksLikeQuestionStart(line: string): boolean {
  return MARK.test(line) || /^\s*(?:问题|问)\s*\d*\s*[.、:：]/.test(line);
}

function stripMark(s: string): string {
  return s.replace(MARK, '').trim();
}

/**
 * 把「整篇粘贴」的原文切成一道一道题。
 *
 * 规则（按真实素材的形状来，不追求完备）：
 *   1. 空行是硬分段 —— 先把原文按空行切成块；
 *   2. 块内若出现「编号行」，则每个编号行起一道新题，其后的非编号行并入上一题
 *      （面试题经常题干换行、或带一小段追问）；
 *   3. 块内没有编号，就整块算一题 —— 每行一题的旧习惯（老导入弹窗的行为）因此仍然成立。
 *
 * 这样「每行一题」与「每段一题」两种粘贴习惯都能用，不必让用户先规整格式。
 */
export function splitRawText(raw: string): string[] {
  const text = (raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  const out: string[] = [];
  const push = (s: string) => {
    const t = stripMark(s.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim());
    if (t.length >= 2) out.push(t);
  };

  for (const block of text.split(/\n\s*\n+/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.length === 1) { push(lines[0]); continue; }

    const numbered = lines.filter(looksLikeQuestionStart).length;
    /* 只有一行像编号 → 大概率是题干换行，不当切点 */
    if (numbered <= 1) { push(lines.join(' ')); continue; }

    let buf: string[] = [];
    for (const line of lines) {
      if (looksLikeQuestionStart(line) && buf.length) { push(buf.join(' ')); buf = [line]; }
      else buf.push(line);
    }
    if (buf.length) push(buf.join(' '));
  }
  return out;
}

/** 题组卡折叠时的预览文本：题干只留一行，省得卡片被长题干撑爆 */
export function brief(s: string, max = 64): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
