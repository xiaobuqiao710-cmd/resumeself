#!/usr/bin/env node
/**
 * 口径打包：网站 TS → qz-tracker 可 import 的 ESM
 * ------------------------------------------------------------------
 * 产出 `~/.local/share/qz-tracker/lib/qz-rules.mjs`（单文件、自包含）。
 *
 * 用法：
 *   npm run build:rules                      # 强制重建
 *   npm run check:rules                      # 源比产物新才重建（daily.sh 阶段 0 用）
 *   QZ_TRACKER_ROOT=/tmp/qz node scripts/build-rules.mjs
 *
 * ⚠️ 改完 `src/lib/trackRules.ts` 或 `src/lib/scoreRules.ts` 后**必须重跑**，
 *    否则本机追踪脚本仍在用旧口径（网站会变、脚本不变，两边静默分叉）。
 *
 * ── 为什么本文件在 resumeself-opensource，而不是在追踪脚本那边（2026-09-28 定）
 * 规则源码（`src/lib/{trackRules,scoreRules}.ts`）的**权威副本在这个仓库** ——
 * 它同时也是线上站（resumeself.vercel.app）的源码，改动最频繁。
 * 于是把打包器一并放在这里：口径与产出它的工具待在一起，只有一个构建入口。
 * 追踪侧 `bin/daily.sh` 阶段 0 调用的就是这个文件。
 * 另一份派生副本在 `~/Documents/QoderCN/2026-09-05/chat-1/qiuzhao-assistant/src/lib/`，
 * daily.sh 会比对两边并告警 —— 两份不是设计目标，是「两个 App 各自要 import TS」的必然结果。
 *
 * ── 为什么**不**挂在 npm 生命周期钩子上
 * 曾经在追踪侧仓库用过 `"prebuild": "node scripts/build-rules.mjs"`，想让每次网站构建
 * 顺手同步口径。这是错的钩子：本脚本的产物写在 `~/.local/share/qz-tracker`，
 * 属于**本机追踪侧**的东西，与网站产物无关。
 *   ① 在追踪侧仓库，`scripts/` 被 `.vercelignore` 排除（内含 `.env`），
 *      线上构建环境根本没有该文件 → `prebuild` 会以 ENOENT 让整条部署失败；
 *   ② 在本仓库，构建钩子会带上 `~/.local/...` 这种本机路径 ——
 *      别人 clone 了这份开源版照着构建就会失败。
 * 所以口径刷新统一由 `daily.sh` 阶段 0 触发（它能失败而不影响日报）。
 *
 * ── 为什么先写临时文件再 rename
 * 旧实现是「先覆盖产物、再自检」：自检万一不过，坏产物已经落盘，
 * 凌晨的定时任务会拿着坏口径继续跑完。现在自检不过就**不动原产物**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TRACKER_ROOT = process.env.QZ_TRACKER_ROOT || path.join(os.homedir(), '.local/share/qz-tracker');
const OUT_DIR = path.join(TRACKER_ROOT, 'lib');
const OUT = path.join(OUT_DIR, 'qz-rules.mjs');

/** 规则源码的派生副本（另一个 App 自带一份）。不参与构建，只用于漂移比对。 */
const MIRROR_ROOT = process.env.QZ_RULES_MIRROR
  || path.join(os.homedir(), 'Documents/QoderCN/2026-09-05/chat-1/qiuzhao-assistant');

const IF_STALE = process.argv.includes('--if-stale');
const ENTRY = path.join(ROOT, 'src/lib/rulesBundle.ts');
/** 产物必须比这几个源都新，否则视为过期 */
const SOURCES = ['src/lib/rulesBundle.ts', 'src/lib/trackRules.ts', 'src/lib/scoreRules.ts']
  .map((p) => path.join(ROOT, p));

const tag = '[rules]';

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return -1; }
}

/* ---------- 漂移检查：与派生副本比对（只告警，不阻断） ---------- */
function checkDrift() {
  const rels = ['src/lib/trackRules.ts', 'src/lib/scoreRules.ts'];
  const diffs = [];
  for (const rel of rels) {
    const mine = path.join(ROOT, rel);
    const theirs = path.join(MIRROR_ROOT, rel);
    if (mtime(theirs) < 0) continue;                       // 副本不存在：不算漂移
    if (mtime(mine) < 0) { diffs.push(`${rel}（本地缺失）`); continue; }
    if (fs.readFileSync(mine, 'utf8') !== fs.readFileSync(theirs, 'utf8')) diffs.push(rel);
  }
  if (diffs.length) {
    console.warn(`${tag} ⚠️ 口径与派生副本不一致：${diffs.join('、')}`);
    console.warn(`${tag}    权威：${ROOT}/src/lib/`);
    console.warn(`${tag}    副本：${MIRROR_ROOT}/src/lib/  ← 需同步，否则那个站点显示的分档会跟这里不一样`);
  }
  return diffs.length;
}

/* ---------- 过期判断（--if-stale）---------- */
if (IF_STALE) {
  const outAt = mtime(OUT);
  if (outAt < 0) {
    console.log(`${tag} 产物不存在，需要重建`);
  } else {
    const newest = SOURCES.map((p) => ({ p: path.relative(ROOT, p), t: mtime(p) }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest.t <= outAt) {
      console.log(`${tag} ⏭ 产物已是最新（${path.basename(newest.p)} 未变），跳过`);
      checkDrift();
      process.exit(0);
    }
    console.log(`${tag} 检测到 ${newest.p} 比产物新，重建`);
  }
}

/* ---------- 源缺失：明确报错，不静默 ---------- */
const missing = [ENTRY, ...SOURCES].filter((p) => mtime(p) < 0);
if (missing.length) {
  console.error(`${tag} ❌ 缺少源文件：${missing.map((p) => path.relative(ROOT, p)).join(', ')}`);
  process.exit(1);
}

/* ---------- 打包 ---------- */
let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  console.error(`${tag} ❌ 找不到 esbuild（应为 devDependencies 之一）。先跑 npm install。`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// 临时文件必须保留 `.mjs` 扩展名：Node 会拒绝 import 未知扩展名
// （曾用 `qz-rules.mjs.tmp-51635`，自检直接 "Unknown file extension" 失败）。
const TMP = OUT.replace(/\.mjs$/, `.tmp-${process.pid}.mjs`);

const banner = `/* 自动生成，请勿手改。
 * 源：resumeself-opensource/src/lib/{trackRules,scoreRules}.ts（权威副本）
 * 重新生成：cd ${ROOT} && npm run build:rules
 */`;

try {
  await build({
    entryPoints: [ENTRY],
    outfile: TMP,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    logLevel: 'warning',
    legalComments: 'none',
    banner: { js: banner },
  });
} catch (e) {
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  console.error(`${tag} ❌ 打包失败，原产物未改动：${e && e.message ? e.message : e}`);
  process.exit(1);
}

/* ---------- 自检：产物必须真的能被 import 且导出关键函数 ----------
   历史上「打包成功但导出名写错」只会在凌晨的定时任务里炸，日志还看不见 —— 这里挡住。
   自检不过就删掉临时文件、保留原产物，宁可用旧的也不要用坏的。 */
let mod;
try {
  mod = await import(`file://${TMP}?t=${Date.now()}`);
} catch (e) {
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  console.error(`${tag} ❌ 产物无法 import，原产物未改动：${e && e.message ? e.message : e}`);
  process.exit(1);
}

const need = ['checkAdmission', 'scoreOpportunity', 'isImportant', 'urgencyOf', 'summarizeTiers'];
const notFn = need.filter((k) => typeof mod[k] !== 'function');
if (notFn.length) {
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  console.error(`${tag} ❌ 产物缺少导出：${notFn.join(', ')}（原产物未改动）`);
  process.exit(1);
}

let probe;
try {
  probe = mod.scoreOpportunity({ company: '中央结算公司', title: '法律类', detail: '含法学类' });
} catch (e) {
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  console.error(`${tag} ❌ 探针执行异常，原产物未改动：${e && e.message ? e.message : e}`);
  process.exit(1);
}
if (probe.score !== 93 || probe.tier !== 'S') {
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  console.error(`${tag} ❌ 探针结果漂移：中央结算公司 法律类 → ${probe.score} 分 ${probe.tier} 档（期望 93 / S），原产物未改动`);
  process.exit(1);
}

/* ---------- 自检通过，原子替换 ---------- */
fs.renameSync(TMP, OUT);
console.log(`${tag} ✅ ${OUT}  ${fs.statSync(OUT).size}B`);
console.log(`${tag} 自检通过 · 探针 中央结算公司 法律类 → ${probe.score} 分 ${probe.tier} 档`);
checkDrift();
