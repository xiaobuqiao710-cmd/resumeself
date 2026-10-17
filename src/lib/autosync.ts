/**
 * 启动自动同步：坚果云汇总表 → 岗位库 / 日历。
 *
 * 背景：数据链路里「桌面总档案 → 坚果云」由发布桥自动完成（LaunchAgent 每 30 分钟），
 * 但最后一段一直要人工点「岗位库 → 从坚果云同步 → 预览 → 确认导入」。
 * 只要上游更新，网站就不动，用户必须记得回来点一次。
 *
 * 现在把这最后一段接进启动流程：打开网站即自动拉取，
 *   - 内容哈希没变 → **零打扰跳过**（不发请求之外的任何动作、不弹任何提示）
 *   - 内容变了 → 走与手动同步完全相同的解析管线（跳过「🤖 自动抓取岗位」块、说明行只进日历）
 *     → 增量入库（`addJobs` / `addEvents` 本身幂等）→ 对账，并给一条带「撤销」的提示
 *
 * 安全网：写入前用 `saveSnapshot(..., 'bak')` 存一份快照（会出现在「设置 → 数据与备份 → 快照」里），
 * 提示条上另有「撤销本次同步」一键回滚。
 */
import type { CalEvent } from '../types';
import {
  getWebdavConfig, getSyncDocPath, setSyncDocPath, pullText, listDav,
  DEFAULT_SYNC_DOC, type WebdavConfig,
} from './webdav';
import { stripAutoCollected, parseMarkdownDeadlines, parseMarkdownDetails, buildJobDraftsFromDoc } from './mdImport';
import { normTitle } from './dedupe';

const K_HASH = 'qz.sync.lastHash';
const K_AT = 'qz.sync.lastAt';        // 最近一次「内容有变、且真的写进了新数据」
const K_SUM = 'qz.sync.lastSummary';
const K_AUTO = 'qz.sync.auto';
const K_PREV = 'qz.sync.prevRaw';
const K_TRY = 'qz.sync.lastTryAt';    // 最近一次「尝试拉取」（成功失败都记）
const K_OK = 'qz.sync.lastOkAt';      // 最近一次「拉取成功」（不代表内容有变）
const K_ERR = 'qz.sync.lastErr';      // 最近一次失败原因；空串 = 链路正常

const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 配额不足时忽略 */ } },
};

/** 自动同步开关（默认开） */
export const isAutoSyncOn = () => ls.get(K_AUTO) !== '0';
export const setAutoSyncOn = (on: boolean) => ls.set(K_AUTO, on ? '1' : '0');
/** 最近一次「内容有变并写入」的时刻。注意它**不是**「最近一次同步成功」的时刻 —— 见 markSyncOk。 */
export const lastSyncAt = () => Number(ls.get(K_AT) || 0);
export const lastSyncSummary = () => ls.get(K_SUM) || '';
export const lastSyncHash = () => ls.get(K_HASH) || '';
export const prevSyncRaw = () => ls.get(K_PREV) || '';
/** 最近一次尝试拉取的时刻（无论成败） */
export const lastSyncTryAt = () => Number(ls.get(K_TRY) || 0);
/** 最近一次拉取成功的时刻（内容不一定有变化） */
export const lastSyncOkAt = () => Number(ls.get(K_OK) || 0);
/** 最近一次失败原因；空串表示链路正常 */
export const lastSyncError = () => ls.get(K_ERR) || '';

/** 记一次「拉取成功」—— 即使内容没变也必须记。
 *
 * 为什么得和 markSynced 分开（这是本次修复的核心）：
 * `markSynced` 只在「内容有变、真的入库了」时调用，于是
 *   「一直同步成功、只是汇总表没更新」 和 「自动同步早就死了」
 * 在界面上**长得一模一样** —— 两者都表现为「上次自动同步」停在某个旧日期上。
 * 用户看到「上次同步：3 天前」根本没法判断是链路断了还是数据源没动，
 * 而这两种情况的处置完全不同（一个去查密码/路径，一个什么都不用做）。
 *
 * 拆开之后：`lastOkAt` 证明**链路通**，`lastAt` 才代表**数据有更新**。 */
export function markSyncOk() {
  const now = Date.now();
  ls.set(K_TRY, String(now));
  ls.set(K_OK, String(now));
  ls.set(K_ERR, '');                  // 成功了就把上一次的错误清掉，否则界面上会一直挂着旧 red line
}

/** 记一次「拉取失败」。只记录、只供界面展示，不在这里弹提示（打扰策略由调用方决定）。 */
export function markSyncFail(error: string) {
  ls.set(K_TRY, String(Date.now()));
  ls.set(K_ERR, String(error || '未知错误').slice(0, 200));
}

export function markSynced(hash: string, summary: string) {
  ls.set(K_HASH, hash);
  ls.set(K_AT, String(Date.now()));
  ls.set(K_SUM, summary);
  markSyncOk();                       // 能走到这里说明这次拉取本身是成功的
}

/** 文件变了、但解析出来的条目库里全都有（重复导入，或上游只改了排版）。
 *
 * 只记哈希 + 「链路通」，**不动** K_AT / K_SUM。
 * 理由：那两个字段的含义是「最近一次真的进过新数据」，被这种空转覆盖掉，
 * 「上次有更新」就会永远显示成刚刚，诊断价值归零。 */
export function markFileChanged(hash: string) {
  ls.set(K_HASH, hash);
  markSyncOk();
}
/** 记下同步前的数据，供「撤销本次同步」使用（只留最近一次） */
export const rememberPreSync = (raw: string) => ls.set(K_PREV, raw);


/**
 * 内容指纹。只用于判断「文件是否变了」，不需要抗碰撞强度，
 * 因此用一个自实现的 djb2 变体，避免为这点需求引入哈希库。
 */
export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${s.length}`;
}

/** 相对时间（分钟/小时/天），给状态行用。0 或非法值返回「—」 */
export function relTime(ts: number, now = Date.now()): string {
  if (!ts) return '—';
  const d = Math.max(0, now - ts);
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

export type SyncHealthState = 'off' | 'never' | 'unconfigured' | 'error' | 'stale' | 'ok';

export interface SyncHealth {
  state: SyncHealthState;
  /** 最近一次尝试拉取（成败都算） */
  lastTryAt: number;
  /** 最近一次拉取成功（内容不一定变） */
  lastOkAt: number;
  /** 最近一次内容有变、真的入库 */
  lastAt: number;
  summary: string;
  error: string;
  /** 一句话结论，可直接展示 */
  text: string;
}

/**
 * 把三个时间戳归一成一句人话。设置面板与岗位库角标共用，保证两处口径一致。
 *
 * 优先级：关着 > 有错 > 从没成功 > 太久没成功 > 正常。
 * 「有错」排在「太久没成功」前面，因为错误的处置动作最明确（去查账号/路径）。
 *
 * 兼容性：旧版本只写过「内容有变」的时间，没有 lastOkAt。升级上来的浏览器
 * 拿不到 lastOkAt，此时把 lastAt 当作链路活着的证据 —— 否则老用户一打开
 * 就会看到「从未成功同步」，纯属误报。
 */
export function syncHealth(now = Date.now()): SyncHealth {
  const lastTryAt = lastSyncTryAt();
  const lastOkAt = lastSyncOkAt();
  const lastAt = lastSyncAt();
  const summary = lastSyncSummary();
  const error = lastSyncError();
  const base = { lastTryAt, lastOkAt, lastAt, summary, error };

  if (!isAutoSyncOn()) return { ...base, state: 'off', text: '自动同步已关闭（数据不会自己更新）' };

  /* 「没填网盘账号」**不是故障**，是一个中性的配置状态 —— 很多用户本来就靠手动选文件导入。
     早先的实现在这里刻意不弹提示（怕打扰），代价是「开关是开的、其实什么也没做」无人知晓；
     现在把它显示出来，但用灰色而不是红色：颜色错了，用户会去排查一个并不存在的问题。 */
  if (/未配置/.test(error)) {
    return { ...base, state: 'unconfigured', text: '自动同步开着，但还没填网盘账号 —— 所以它不会自动拉取（可用「手动同步一次」或直接选文件导入）' };
  }

  if (error) return { ...base, state: 'error', text: `最近一次同步失败：${error}` };

  const aliveAt = lastOkAt || lastAt;
  if (!aliveAt) return { ...base, state: 'never', text: '尚未成功同步过' };

  const days = (now - aliveAt) / 86_400_000;
  if (days >= 1) {
    return { ...base, state: 'stale', text: `已 ${Math.floor(days)} 天没成功拉取过（可能是这几天没打开过网站，或网盘凭据失效）` };
  }

  /* 刚拉过、但从来没有过内容更新：这才是「上游没动」，可以放心说「暂无更新」 */
  if (!lastAt) {
    return { ...base, state: 'ok', text: `同步正常，${relTime(aliveAt, now)}检查过 · 汇总表暂无更新` };
  }
  /* 一小时内刚进过新数据：直接报结果。这是用户打开岗位库唯一关心的那句。 */
  if (now - lastAt < 3_600_000) {
    return { ...base, state: 'ok', text: `同步正常 · 刚刚有更新${summary ? `（${summary}）` : ''}` };
  }
  return {
    ...base,
    state: 'ok',
    /* aliveAt === lastAt 只会出现在旧版本数据（没有 lastOkAt）上，
       此时两个「x 分钟前」会一模一样，宁可只说一次。 */
    text: aliveAt === lastAt
      ? `同步正常 · 最近更新 ${relTime(lastAt, now)}`
      : `同步正常，${relTime(aliveAt, now)}检查过 · 最近更新 ${relTime(lastAt, now)}`,
  };
}

export interface ParsedSyncDoc {
  drafts: ReturnType<typeof buildJobDraftsFromDoc>['drafts'];
  events: Partial<CalEvent>[];
  notes: ReturnType<typeof buildJobDraftsFromDoc>['notes'];
  /** 按追踪口径（`lib/trackRules.ts`）被排除的条目。**不静默丢弃**：同步提示里会报数量 */
  rejected: ReturnType<typeof buildJobDraftsFromDoc>['rejected'];
  /** 「🤖 自动抓取岗位」区块被跳过的行数（机器抓取的线索默认不进库） */
  removedLines: number;
}

/** 解析汇总表文本 → 岗位草稿 + 日历事件草稿（与手动同步同一套管线） */
export function parseSyncDoc(text: string): ParsedSyncDoc {
  const stripped = stripAutoCollected(text);
  const cal = parseMarkdownDeadlines(stripped.text);
  const det = parseMarkdownDetails(stripped.text);
  const { drafts, notes, rejected } = buildJobDraftsFromDoc({ rows: cal.rows, details: det.details });
  const events: Partial<CalEvent>[] = cal.rows
    .filter((r) => (r.deadline || '').trim())
    .map((r) => ({
      title: `截止 · ${r.company}${r.title && r.title !== '招聘' ? ' · ' + r.title : ''}`,
      date: r.deadline!,
      type: 'deadline' as const,
      note: [r.remain, r.note].filter(Boolean).join(' · ') || undefined,
      source: 'import' as const,
    }));
  return { drafts, events, notes, rejected, removedLines: stripped.removedLines };
}

export type PullResult =
  | { ok: true; text: string; path?: string; pathCorrected?: boolean }
  | { ok: false; error: string };

const withTimeout = <T,>(p: Promise<T>, ms: number, err = '超时') =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(err)), ms))]);

/**
 * 历史/常见路径候选。配置值失效时按序回退，**命中后写回配置**，
 * 让「岗位库 → 从网盘同步」这个手动入口也跟着修好。
 *
 * ⚠️ 每一项必须**互不相同**，否则等于没有回退。
 * 曾经这里的第二项与 `DEFAULT_SYNC_DOC` 是同一个字符串（都是 `秋招数据/秋招信息汇总.md`），
 * 而发布桥 `qz-publish.mjs` 实际写的是带年份的 `2027届秋招信息汇总.md`：
 * 唯一的候选必然 404，全靠 `discoverSyncDoc` 扫目录才侥幸找到。
 * 扫描成功纯属运气 —— 一旦它失败（listDav 报错、文件放得比两层还深），
 * 整条自动同步就报「未找到」，而用户看到的是第一条候选的 404，和「文件明明在网盘里」对不上。
 *
 * 所以下面把「目录 × 文件名」两种可能都列全：宁可多一次 404，也不再赌扫描成功。
 *
 * 这几项**故意不重复**；「默认路径与发布桥保持一致」这件事交给回归测试去守
 * （`health-entry.ts` 第 12 步直接读 `qz-publish.mjs` 的目标路径做交叉比对）——
 * 在代码里再抄一份同样的字符串，只是把同一个错误写两遍，改错了照样一起错。
 */
const PATH_CANDIDATES = [
  DEFAULT_SYNC_DOC,                                    // 与发布桥一致（当前：秋招数据/2027届秋招信息汇总.md）
  '秋招数据/秋招信息汇总.md',                             // 无年份前缀的旧名
  '2027届秋招信息汇总.md',                               // 直接放在网盘根目录
  '我的坚果云/秋招数据/2027届秋招信息汇总.md',              // 配置里带上同步文件夹名的情况
];

/** 实际会按序尝试的路径（去重、保持顺序）。
 *
 *  抽成纯函数是为了**可断言**：候选列表里混进重复项，等于回退链断了一节，
 *  但运行时不会有任何报错 —— 它只表现为「多绕一次、多花几百毫秒」，肉眼永远发现不了。
 *  只有把「去重后的条数」变成断言，这种 bug 才会在测试里现形。 */
export function syncPathOrder(stored: string): string[] {
  const tried = new Set<string>();
  return [stored, ...PATH_CANDIDATES].filter((p) => !!p && !tried.has(p) && (tried.add(p), true));
}

async function tryPull(cfg: WebdavConfig, path: string, timeoutMs: number): Promise<PullResult> {
  try {
    const text = await withTimeout(pullText(cfg, path), timeoutMs, '拉取超时');
    return { ok: true, text: String(text || ''), path };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || '拉取失败' };
  }
}

/** 在网盘里扫一层（必要时两层）找「秋招/汇总」类的 Markdown——用户换了目录名也能自愈。
 *
 *  返回值带 `scanError`：**「扫描本身就失败了」和「扫了但真没有」必须分开**。
 *  把它们混成一句「网盘里没找到」，会让用户去翻文件名，而真实原因是网络/权限/接口报错 ——
 *  下一步动作完全相反。 */
async function discoverSyncDoc(cfg: WebdavConfig, timeoutMs: number):
  Promise<{ path: string | null; scanError?: string }> {
  const looksLikeDoc = (n: string) => /(秋招|汇总|招聘).*\.md$/i.test(n);
  try {
    const top = await withTimeout(listDav(cfg, ''), timeoutMs);
    for (const d of top.filter((e) => e.isDir).slice(0, 8)) {
      const kids = await withTimeout(listDav(cfg, d.path), timeoutMs).catch(() => []);
      const hit = kids.find((e) => !e.isDir && looksLikeDoc(e.name));
      if (hit) return { path: hit.path };
      for (const dd of kids.filter((e) => e.isDir).slice(0, 6)) {
        const inner = await withTimeout(listDav(cfg, dd.path), timeoutMs).catch(() => []);
        const h2 = inner.find((e) => !e.isDir && looksLikeDoc(e.name));
        if (h2) return { path: h2.path };
      }
    }
  } catch (e) {
    return { path: null, scanError: (e as Error)?.message || '目录扫描失败' };
  }
  return { path: null };
}

/**
 * 拉取汇总表（带路径自愈）。
 *
 * 失败时**必须给出「试过什么、下一步点哪里」**，不能把第一条候选的 404 原样抛出去：
 * 文件很可能就在网盘里、只是路径或文件名不同，而真正的结论是「所有候选 + 目录扫描都没命中」。
 * （未配置凭据仍是单独一句，调用方据此显示中性的「未配网盘」而不是红色故障。）
 */
export async function pullSyncDoc(timeoutMs = 9000): Promise<PullResult> {
  const cfg = getWebdavConfig();
  if (!cfg.server || !cfg.username || !cfg.password) return { ok: false, error: '未配置坚果云账号与应用密码' };

  const before = getSyncDocPath();
  const order = syncPathOrder(before);
  let lastErr = '';
  for (const p of order) {
    const r = await tryPull(cfg, p, timeoutMs);
    if (r.ok) {
      const corrected = p !== before;
      if (corrected) setSyncDocPath(p);                 // 记住真正可用的路径
      return { ...r, pathCorrected: corrected };
    }
    lastErr = r.error;
  }

  const found = await discoverSyncDoc(cfg, timeoutMs);
  if (found.path) {
    const r = await tryPull(cfg, found.path, timeoutMs);
    if (r.ok) { setSyncDocPath(found.path); return { ...r, pathCorrected: found.path !== before }; }
  }
  const why = found.scanError
    ? `目录扫描也失败了（${found.scanError}）`
    : '扫描网盘目录也没找到';
  return {
    ok: false,
    error: `没在网盘找到汇总表：已试 ${order.length} 条路径，${why}。`
      + '可在「岗位库 → 从网盘同步」浏览目录点选文件，或直接拖文件导入'
      + `${lastErr ? `（原始错误：${lastErr}）` : ''}`,
  };
}

/**
 * 折叠「同日期 + 归一化标题相同」的重复日历事件。
 *
 * 重复导入同一份汇总表会写出标题几乎相同的截止事件（历史上某次数据里 85 条有 35 条属于重复），
 * 实测这些差异只有三类：`🆕` 标记、空格/全角差异、源表截断（「部分分行传」vs「部分分行渠道传」），
 * 指向的都是同一天同一件事，折叠无语义风险。
 *
 * 为防万一，折叠时**保留信息最全的那条**（标题最长、其次带备注），并把被丢弃条目的备注并进去——
 * 即使两条并非完全相同，也不会丢掉文字内容，只是少一行重复提醒。
 */
export function collapseDuplicateEvents(events: CalEvent[]): { events: CalEvent[]; removed: number } {
  const groups = new Map<string, CalEvent[]>();
  for (const e of events) {
    const k = `${e.date}|${normTitle(e.title || '')}`;
    groups.set(k, [...(groups.get(k) || []), e]);
  }
  const out: CalEvent[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const best = [...list].sort((a, b) =>
      (b.title || '').length - (a.title || '').length
      || ((b.note ? 1 : 0) - (a.note ? 1 : 0)))[0];
    const extraNotes = list
      .filter((e) => e !== best && e.note && e.note !== best.note)
      .map((e) => e.note as string);
    out.push(extraNotes.length ? { ...best, note: [best.note, ...extraNotes].filter(Boolean).join(' · ') } : best);
  }
  return { events: out, removed: events.length - out.length };
}
