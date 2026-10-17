/**
 * 本机自动备份（localStorage 快照）。
 *
 * 背景：早期版本在数据结构版本号不匹配时直接 removeItem 清空用户数据，
 * 一次发版就可能让全部投递记录消失。现在改为「先备份、再迁移」，并保留
 * 最近若干份快照，随时可回滚。
 *
 * ⚠️ 2026-10-16 修一个会「越用越死」的配额 bug：
 *   localStorage 的配额是按**字节**算的（Chromium 单源 5MB，UTF-16 约 260 万字符），
 *   而旧实现只按**条数**保留 5 份。可一份快照就是**一份完整的全量状态** ——
 *   实测该用户单份状态 79 万字符（≈1.6MB），于是 5 份快照 + 主键 ≈ 8MB，
 *   直接把配额撑爆；此后任何修改都写不进去，站点只能弹「本机浏览器存储已满」，
 *   而且弹了也不会自愈（旧实现只是在 catch 里 ignore）。
 *   旧实现还有第二个漏洞：`scan()` 只认 `.bak.`，所以 `.preimport.`（导入前快照）
 *   这类键永远不参与回收，只增不减。
 *
 * 现在的规则：
 *   ① 快照总占用不得超过 `SNAPSHOT_BUDGET`，同时条数上限 `MAX_SNAPSHOTS`；
 *   ② **所有**标签（bak / preimport / broken）都参与统计与回收；
 *   ③ 写入失败时先按预算回收旧快照再重试一次；
 *   ④ 主键（当前状态）写入失败时，由调用方触发 `clearSnapshots()` 自救 ——
 *      **当前这份状态永远优先于旧副本**，绝不因为几份过期快照丢掉用户刚做的修改。
 */
const PREFIX = 'qz.cloud.';
/** 快照标签：bak=通用自动备份，preimport=导入前，broken=存档损坏时抢救出来的原文 */
const TAG_RE = /\.(bak|preimport|broken)\.(\d+)$/;

/** 条数上限（状态很小时才有机会用满） */
const MAX_SNAPSHOTS = 5;

/**
 * 快照总预算（字符数）。
 * 实测该站点这份数据的存储开销 ≈ 1.87 字节/字符（中英混排，UTF-16 与 UTF-8 混合计账），
 * 所以 90 万字符 ≈ 1.7MB。加上主状态（79 万字符 ≈ 1.5MB）≈ 3.2MB，
 * 对 Chromium 每个 origin 的 10MB 配额留了足够余量。
 */
export const SNAPSHOT_BUDGET = 900_000;

/**
 * localStorage 配额估算（字符数）。Chromium 的 kPerStorageAreaQuota 是 **10MB**
 * （早期版本是 5MB，很多老文档还写着 5MB，别再按 5MB 算）。
 * 这里按 1 字符 ≈ 2 字节保守折算成字符数，只用于「存储体检」显示进度。
 */
export const LOCAL_QUOTA_CHARS = 5_000_000;

export interface Snapshot { key: string; at: number; label: string; tag: string; size: number; }

export interface Usage {
  /** 该源下全部 localStorage 键值合计（字符数） */
  chars: number;
  /** 主状态本身（qz.cloud.<uid>，不含快照） */
  mainChars: number;
  /** 快照合计 */
  snapshotChars: number;
  snapshotCount: number;
}

/** 全部快照，新的在前。所有标签都算进来（旧实现只认 .bak.，导致 preimport 永不回收）。 */
function scan(): Snapshot[] {
  const out: Snapshot[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const m = k.match(TAG_RE);
      if (!m) continue;
      const raw = localStorage.getItem(k) || '';
      out.push({
        key: k,
        at: Number(m[2]) || 0,
        tag: m[1],
        label: k.replace(PREFIX, ''),
        size: raw.length + k.length,
      });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b.at - a.at);
}

export function listSnapshots(): Snapshot[] { return scan(); }

/** 删除若干键，返回释放掉的字符数 */
function dropKeys(keys: string[]): number {
  let chars = 0;
  for (const k of keys) {
    try {
      const v = localStorage.getItem(k);
      localStorage.removeItem(k);
      chars += (v ? v.length : 0) + k.length;
    } catch { /* ignore */ }
  }
  return chars;
}

/**
 * 按预算回收：从头（最新）往后留，装不下或超过条数上限的就删。
 * `reserve` 是**即将写入**的那份的字符数，先扣掉它再算剩余预算。
 */
function prune(reserve = 0): number {
  const list = scan();
  const keep = new Set<string>();
  let used = reserve;
  for (const s of list) {
    if (keep.size >= MAX_SNAPSHOTS - (reserve ? 1 : 0)) break;
    if (used + s.size > SNAPSHOT_BUDGET) continue;   // 这份装不下 → 不保留（不是 break：更老的更装不下）
    keep.add(s.key);
    used += s.size;
  }
  return dropKeys(list.filter((s) => !keep.has(s.key)).map((s) => s.key));
}

export function saveSnapshot(storageKey: string, raw: string, tag = 'bak') {
  /* 键名只带毫秒时间戳，同一个毫秒内连存两份会互相覆盖（脚本/批量迁移里真的会发生）。
     用「占位即跳过」的方式顺延 1ms，既不撞键、也不破坏 `.bak.<数字>` 这个可解析格式。 */
  let at = Date.now();
  let key = `${storageKey}.${tag}.${at}`;
  try { while (localStorage.getItem(key) !== null) key = `${storageKey}.${tag}.${++at}`; }
  catch { /* ignore */ }
  try {
    /* 先写后收：正常情况下不动存量快照 */
    localStorage.setItem(key, raw);
    prune();
  } catch {
    /* 写不进：先按预算腾出位置再试一次。仍失败就算了 —— 快照是「锦上添花」，
       清空全部存量去换一份新快照是赔本买卖，真正的兜底在 store 写主状态那一侧。 */
    prune(raw.length);
    try { localStorage.setItem(key, raw); } catch { /* ignore */ }
  }
}

export function readSnapshot(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function removeSnapshot(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/**
 * 清空全部快照，返回释放的字符数。
 * 用途：① 用户在「设置 → 数据与备份」点「清理全部快照」；
 *      ② 主状态写不进配额时自救（快照是可再生的旧副本，当前状态不是）。
 */
export function clearSnapshots(): number {
  return dropKeys(scan().map((s) => s.key));
}

/** 本机存储体检：整体占用 + 快照占用，给「设置 → 数据与备份」显示 */
export function localUsage(storageKey?: string): Usage {
  let chars = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      chars += k.length + (localStorage.getItem(k) || '').length;
    }
  } catch { /* ignore */ }
  const snaps = scan();
  const snapshotChars = snaps.reduce((a, s) => a + s.size, 0);
  let mainChars = 0;
  if (storageKey) {
    try { mainChars = storageKey.length + (localStorage.getItem(storageKey) || '').length; }
    catch { /* ignore */ }
  }
  return { chars, mainChars, snapshotChars, snapshotCount: snaps.length };
}

/** 字符数 → 人话体积。localStorage 按 UTF-16 存，1 字符 ≈ 2 字节。 */
export function fmtBytes(chars: number): string {
  const bytes = chars * 2;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface KeyUsage { key: string; chars: number; }

/**
 * 占用最大的前 n 个键。
 * 为什么需要：配额被吃光时，只报一个「已用 10MB」用户无从下手 ——
 * 实测这份数据里 60% 是快照、18% 是同步用的上一版原文、7% 是 AI 会话历史，
 * 主状态本身只占 14%。把大项列出来，用户才知道该删什么。
 */
export function topKeys(n = 5): KeyUsage[] {
  const out: KeyUsage[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      out.push({ key: k, chars: k.length + (localStorage.getItem(k) || '').length });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b.chars - a.chars).slice(0, n);
}
