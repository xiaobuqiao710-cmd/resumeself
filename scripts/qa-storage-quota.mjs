#!/usr/bin/env node
/**
 * 本机存储配额回归测试（2026-10-16）
 * ==========================================================================
 * 修的是什么 bug：`lib/backup.ts` 的快照保留策略只按**条数**（最多 5 份），
 * 而一份快照就是一份**完整全量状态**。用户实测单份状态 79 万字符，
 * 5 份快照 + 主键 ≈ 8MB，直接把 localStorage 的 5MB 配额撑爆 ——
 * 此后任何修改都写不进去，站点只能弹「本机浏览器存储已满」，且旧实现不自愈。
 * 另外旧 `scan()` 只认 `.bak.`，`.preimport.` 快照永远不被回收。
 *
 * 这个测试在 Node 里放一个**带真实配额语义**的 localStorage 假实现，
 * 然后调用**真实的** src/lib/backup.ts（用 esbuild 现编译），断言四件事：
 *   ① 复现：不清理的话，主状态确实写不进去（配额错误是真的）
 *   ② 写 8 次快照后，总量仍在配额内，且主状态始终完好
 *   ③ 快照条数 ≤ 5、总占用 ≤ SNAPSHOT_BUDGET，且 .preimport. 也参与回收
 *   ④ 自救：配额已被旧快照占满时，clearSnapshots() 能腾出位置让主状态写成功
 *
 * 跑法：node scripts/qa-storage-quota.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ---------- 1. 把真实源码编译成可导入的 ESM ---------- */
async function loadModule(entry) {
  const out = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'error',
  });
  const code = out.outputFiles[0].text;
  const tmp = path.join(ROOT, 'node_modules/.tmp', `qa-${path.basename(entry, '.ts')}-${Date.now()}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, code);
  const mod = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);
  return mod;
}

/* ---------- 2. 带配额语义的 localStorage 假实现 ---------- */
class FakeStorage {
  constructor(quotaChars) {
    this.quota = quotaChars;
    this.map = new Map();
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    const next = new Map(this.map);
    next.set(String(k), String(v));
    if (this.used(next) > this.quota) {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.map = next;
  }
  removeItem(k) { this.map.delete(k); }
  /** 只给「摆现场」用：把浏览器里**已经存在**的键值直接放进 map，不触发配额检查。
      这些快照是历史上陆续写下的，我们只关心「它们已经在那里」这个事实。 */
  seed(k, v) { const next = new Map(this.map); next.set(String(k), String(v)); this.map = next; }
  used(m = this.map) {
    let n = 0;
    for (const [k, v] of m) n += k.length + v.length;
    return n;
  }
}

/* ---------- 3. 断言小工具 ---------- */
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const QUOTA = 2_500_000;              // ≈ 5MB（UTF-16 两字节一字符）
const MAIN_LEN = 790_000;             // 实测用户主状态规模（79 万字符）
/* 真实动态：状态是**逐步长大**的，而快照是「当时那份状态」的副本 ——
   所以「5 份快照」不是 5 倍当前体积，而是历史各版本之和，一路把配额吃掉。 */
const RAMP = [300_000, 400_000, 500_000, 600_000, 700_000, 790_000, 790_000, 790_000];
const storage = new FakeStorage(QUOTA);
globalThis.localStorage = storage;

const backup = await loadModule('src/lib/backup.ts');
const KEY = 'qz.cloud.test-user';
/** 造一份「体积可信、内容可校验」的假状态：JSON 合法，长度≈len，头部带 tag 便于断言 */
const makeState = (tag, len = MAIN_LEN) => {
  const head = `{"_v":6,"tag":"${tag}",`;
  const mid = '"pad":"';
  const tail = '"}';
  const pad = Math.max(0, len - head.length - mid.length - tail.length);
  return head + mid + 'x'.repeat(pad) + tail;
};

console.log('\n【1】复现：不清理时主状态写不进去（证明配额语义是真的）');
storage.seed(KEY, makeState('v0'));
for (let i = 0; i < 5; i++) storage.seed(`${KEY}.bak.${1700000000000 + i}`, makeState(`snap${i}`));
const beforeUsed = storage.used();
let threw = false;
try { storage.setItem(KEY, makeState('v1')); } catch { threw = true; }
check('5 份快照 + 主键 已超出配额', beforeUsed > QUOTA, `已用 ${beforeUsed} / ${QUOTA}`);
check('此时主状态写入抛 QuotaExceededError（复现成功）', threw);
check('主状态仍是旧值（没被写坏）', JSON.parse(storage.getItem(KEY)).tag === 'v0');

console.log('\n【2】自救：clearSnapshots() 腾出位置后主状态能写成功');
const freed = backup.clearSnapshots();
check('clearSnapshots 释放了空间', freed > 0, `释放 ${freed} 字符`);
check('快照已全部清空', backup.listSnapshots().length === 0);
let ok2 = false;
try { storage.setItem(KEY, makeState('v1')); ok2 = true; } catch { /* */ }
check('主状态写入成功', ok2 && JSON.parse(storage.getItem(KEY)).tag === 'v1');
check('总量已回到配额内', storage.used() <= QUOTA, `已用 ${storage.used()}`);

console.log('\n【3】状态逐步长大 + 每步留快照：主状态一次都不能被配额挡住');
storage.map = new Map([[KEY, makeState('v0', RAMP[0])]]);
let blocked = 0;
for (let i = 1; i < RAMP.length; i++) {
  backup.saveSnapshot(KEY, storage.getItem(KEY), 'bak');      // 快照 = 上一步那份状态
  try { storage.setItem(KEY, makeState(`v${i}`, RAMP[i])); } catch { blocked++; }
}
const snaps = backup.listSnapshots();
const snapChars = snaps.reduce((a, s) => a + s.size, 0);
check('快照条数 ≤ 5', snaps.length <= 5, `实际 ${snaps.length} 份`);
check('快照总量 ≤ SNAPSHOT_BUDGET', snapChars <= backup.SNAPSHOT_BUDGET,
  `${snapChars} / ${backup.SNAPSHOT_BUDGET}`);
check('每一步的主状态写入都没被挡（0 次失败）', blocked === 0, `被挡 ${blocked} 次`);
check('主状态停在第 7 版（v7）', JSON.parse(storage.getItem(KEY)).tag === 'v7',
  JSON.parse(storage.getItem(KEY)).tag);
check('总量未超配额', storage.used() <= QUOTA, `已用 ${storage.used()} / ${QUOTA}`);
check('至少保留了 1 份最新快照（回滚能力没丢）', snaps.length >= 1);

console.log('\n【4】.preimport. 也参与回收（旧实现只认 .bak.，这里必然漏）');
storage.map = new Map([[KEY, makeState('v1')]]);
for (let i = 0; i < 6; i++) backup.saveSnapshot(KEY, makeState(`pre${i}`), 'preimport');
const all = backup.listSnapshots();
check('preimport 快照被计入并发受回收', all.length <= 5, `实际 ${all.length} 份`);
check('tags 覆盖到了 preimport', all.some((s) => s.tag === 'preimport'));
check('总量未超配额', storage.used() <= QUOTA, `已用 ${storage.used()} / ${QUOTA}`);

console.log('\n【5】体检数据自洽');
storage.map = new Map([[KEY, makeState('v1')], [KEY + '.bak.1', makeState('s')]]);
const u = backup.localUsage(KEY);
check('localUsage.chars ≥ main + snapshots', u.chars >= u.mainChars + u.snapshotChars,
  JSON.stringify(u));
check('snapshotCount 与实际一致', u.snapshotCount === 1, JSON.stringify(u));
check('fmtBytes 输出人话', /KB|MB|B/.test(backup.fmtBytes(790_000)));

console.log('\n【6】变异检验：把「按体积回收」改回「只按条数」（= 修复前的策略），测试必须失败');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/backup.ts'), 'utf8');
  const mutated = src.replace(/export const SNAPSHOT_BUDGET = [\d_]+;/, 'export const SNAPSHOT_BUDGET = 1e12;');
  check('变异已注入（预算被放到无穷大）', mutated !== src);
  const out = await build({
    stdin: { contents: mutated, resolveDir: ROOT, loader: 'ts', sourcefile: 'backup-mutated.ts' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  });
  const tmp = path.join(ROOT, 'node_modules/.tmp', `qa-mutated-${Date.now()}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const old = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);

  storage.map = new Map([[KEY, makeState('v0', RAMP[0])]]);
  let blocked = 0;
  for (let i = 1; i < RAMP.length; i++) {
    old.saveSnapshot(KEY, storage.getItem(KEY), 'bak');
    try { storage.setItem(KEY, makeState(`v${i}`, RAMP[i])); } catch { blocked++; }
  }
  const oldSnaps = old.listSnapshots();
  const oldChars = oldSnaps.reduce((a, s) => a + s.size, 0);
  check('旧策略下主状态会被配额挡住（证明本测试有牙齿）', blocked > 0, `被挡 ${blocked} 次`);
  check('旧策略下快照占用远超预算（正是配额被吃光的原因）',
    oldChars > backup.SNAPSHOT_BUDGET, `${oldChars} 字符 / 预算 ${backup.SNAPSHOT_BUDGET}`);
  check('旧策略下快照堆积到多份', oldSnaps.length > 1, `实际 ${oldSnaps.length} 份`);
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
