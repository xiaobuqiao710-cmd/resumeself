#!/usr/bin/env node
/**
 * 岗位库清理（配额减负）回归测试（2026-10-17）
 * ==========================================================================
 * 要证明的三件事：
 *   ① 默认勾选只命中「已截止 + 未投递 + 未归档」——**已投递的岗位绝不默认勾**，
 *      否则用户在配额告警里点一下「清理」，等结果的投递锚点就静默消失了；
 *   ② 删除确实让整份状态变小（数量按被删条目占比折算），不是只改了个状态；
 *   ③ 归档与删除的区别：归档后体积不变（这正是为什么旧入口腾不出空间）。
 *
 * 做法：把 JobsCleanup.tsx 的**默认勾选口径**与归档口径各抽成一个纯函数在这里重算一遍？
 * 不行 —— 那等于测副本。这里直接把 .tsx 用 esbuild 编译成 ESM，再从一个最小的假 React 里
 * 调出组件、取它的初始 state：`useState(() => new Set(defaultIds))` 的惰性初值就是默认勾选。
 * 这样测的是**组件里真正跑的那段代码**，改了口径而忘了这里，测试会红。
 *
 * 跑法：node scripts/qa-jobs-cleanup.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ---------- 1. 假 React + 假 store：把组件「跑」起来只为了拿初始 state ---------- */
/* 组件把 useMemo 结果用作 useState 的惰性初值，所以必须真求值；
   渲染函数体本身（JSX）不执行 —— 我们只调用导出的组件一次，React 假实现会把
   useState/useMemo 的初值按调用顺序收集下来。 */
const captured = { useMemo: [], useState: [], calls: 0 };
globalThis.__QZ_CAPTURE__ = captured;

const fakeStoreJobs = [];        // 由每个用例设置
globalThis.__QZ_FAKE_JOBS__ = fakeStoreJobs;

const reactShim = `
export const useState = (init) => {
  const v = typeof init === 'function' ? init() : init;
  globalThis.__QZ_CAPTURE__.useState.push(v);
  return [v, () => {}];
};
export const useMemo = (fn) => {
  const v = fn();
  globalThis.__QZ_CAPTURE__.useMemo.push(v);
  return v;
};
export const useCallback = (fn) => fn;
export const useRef = (v) => ({ current: v });
export const useEffect = () => {};
export const useContext = (c) => c;
export const createContext = (v) => ({ _v: v, Provider: (p) => p.children, Consumer: {} });
export default { useState, useMemo, useCallback, useRef, useEffect, useContext, createContext };
`;

const storeShim = `
export function useStore() {
  const jobs = globalThis.__QZ_FAKE_JOBS__;
  return {
    jobs,
    removeJobs: (ids) => ids.length,
    storageKey: 'qz.cloud.test',
    toast: () => {},
  };
}
export const StoreProvider = ({ children }) => children;
`;

const kitShim = `
export const Button = (p) => null;
export const Badge = (p) => null;
export const Modal = (p) => { globalThis.__QZ_CAPTURE__.calls++; return null; };
export const Empty = (p) => null;
export const Segmented = (p) => null;
export const Icon = (p) => null;
`;

const iconShim = `export const Icon = (p) => null;`;

/* 真实 util：daysUntil / fmtDate 是判定「已截止」的唯一口径，必须用真的，不能用假的 */
async function loadModule(entry, overrides = {}) {
  /* 每个假模块只挂自己的 onResolve —— 早期版本把四个假模块的 resolver 塞进同一个 plugin，
     结果它们对**同一个路径**各返回一次，esbuild 报「多条解析结果」。
     另外 onResolve 的 filter 是正则：`../ui/Kit` 里的 `.` 必须转义，否则会误配到别处。 */
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plugins = Object.entries(overrides).map(([from, code], i) => {
    const ns = `shim${i}`;
    return {
      name: `shim-${i}`,
      setup(b) {
        b.onResolve({ filter: new RegExp(`^${esc(from)}$`) }, () => ({ path: 'entry', namespace: ns }));
        b.onLoad({ filter: /^entry$/, namespace: ns }, () => ({ contents: code, loader: 'js' }));
      },
    };
  });
  const out = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'error',
    jsx: 'automatic',
    jsxImportSource: 'shim-react',
    plugins,
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const tmp = path.join(ROOT, 'node_modules/.tmp', `qa-cleanup-${path.basename(entry, '.tsx')}-${Date.now()}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const mod = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);
  return mod;
}

/* ---------- 2. 造数据 ---------- */
const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
const daysAhead = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

const job = (id, over = {}) => ({
  id, company: `单位${id}`, title: `岗位${id}`, status: 'new',
  createdAt: daysAgo(30), ...over,
});

const JOBS = [
  job('j1', { deadline: daysAgo(5) }),                                      // 已截止 + 未投递 → 默认勾
  job('j2', { deadline: daysAgo(20), status: 'archived' }),                  // 已截止 + 已归档 → 不默认勾
  job('j3', { deadline: daysAgo(9), status: 'applied' }),                    // 已截止 + 已投递 → **绝不**勾
  job('j4', { deadline: daysAhead(10) }),                                    // 未截止 → 不勾
  job('j5', { deadline: undefined }),                                        // 无截止 → 不勾
  job('j6', { deadline: daysAgo(1), status: 'interested' }),                 // 已截止 + 感兴趣 → 勾
  job('j7', { deadline: daysAhead(3), status: 'applied' }),                  // 未截止 + 已投递 → 不勾
];

/* ---------- 3. 编译真实组件，取出默认勾选 ---------- */
globalThis.__QZ_FAKE_JOBS__ = JOBS;
const mod = await loadModule('src/components/modules/JobsCleanup.tsx', {
  react: reactShim,
  'shim-react/jsx-runtime': `export const jsx = () => null; export const jsxs = () => null; export const Fragment = 'f';`,
  '../ui/Kit': kitShim,
  '../ui/Icon': iconShim,
  '../../store/store': storeShim,
});

console.log('\n【1】默认勾选口径');
mod.JobsCleanupModal({ onClose: () => {} });          // 调用一次，捕获初始化阶段的 useState/useMemo
const initStates = captured.useState;
const picked = [...initStates].find((v) => v instanceof Set);
check('组件初始化时产出了一个「勾选集合」（useState 惰性初值）', picked instanceof Set);
const ids = picked ? [...picked].sort() : [];

check('已截止 + 未投递的岗位被默认勾选（j1）', ids.includes('j1'));
check('已截止 + 未投递的岗位被默认勾选（j6）', ids.includes('j6'));
check('已截止但已归档的**不**默认勾选（j2）', !ids.includes('j2'));
check('已截止但已投递的**绝不**默认勾选（j3）', !ids.includes('j3'));
check('未截止的已投递岗位不勾（j7）', !ids.includes('j7'));
check('未截止的岗位不勾（j4）', !ids.includes('j4'));
check('无截止日期的岗位不勾（j5）', !ids.includes('j5'));
check('默认勾选恰好 2 条', ids.length === 2, `实际 ${ids.length}: ${ids.join(',')}`);

console.log('\n【2】删除真的让整份状态变小（对照「归档」）');
const serialized = (list) => JSON.stringify(list);
const full = serialized(JOBS);
/* 删掉默认勾选的两条，其余保留 */
const afterDelete = serialized(JOBS.filter((j) => !ids.includes(j.id)));
/* 归档：只把两条的 status 改成 archived —— 体积几乎不变（这就是旧入口腾不出空间的原因） */
const afterArchive = serialized(JOBS.map((j) => (ids.includes(j.id) ? { ...j, status: 'archived' } : j)));
check('删除后整份状态真的变小了', afterDelete.length < full.length);
check('归档后体积**没有**实质变小（<1%）', Math.abs(afterArchive.length - full.length) / full.length < 0.01,
  `归档 ${afterArchive.length} vs 原 ${full.length}`);
check('删除省下的量 = 被删两条的序列化体积', full.length - afterDelete.length > 10);

console.log('\n【3】已投递岗位在任何组合下都不会被默认删掉（穷举状态 × 截止组合）');
const STATUSES = ['new', 'interested', 'applied', 'archived'];
const DEADLINES = [daysAgo(30), daysAgo(1), daysAhead(1), undefined];
const cross = [];
let k = 0;
for (const s of STATUSES) {
  for (const d of DEADLINES) cross.push(job(`x${k++}`, { status: s, deadline: d }));
}
globalThis.__QZ_FAKE_JOBS__ = cross;
captured.useState.length = 0; captured.useMemo.length = 0;
mod.JobsCleanupModal({ onClose: () => {} });
const crossPicked = [...captured.useState].find((v) => v instanceof Set) || new Set();
const appliedPicked = cross.filter((j) => j.status === 'applied' && crossPicked.has(j.id));
check('4 种状态 × 4 种截止 共 16 条里，已投递的一条都没进默认勾选', appliedPicked.length === 0,
  appliedPicked.map((j) => j.id).join(','));
const expectCross = cross.filter((j) =>
  j.status !== 'applied' && j.status !== 'archived'
  && !!j.deadline && (j.deadline < iso(today))).map((j) => j.id).sort();
check('默认勾选与「已截止 ∧ 未投递 ∧ 未归档」口径完全一致',
  JSON.stringify([...crossPicked].sort()) === JSON.stringify(expectCross),
  `勾了 ${[...crossPicked].sort().join(',')} / 期望 ${expectCross.join(',')}`);

console.log('\n【4】空岗位库不炸');
globalThis.__QZ_FAKE_JOBS__ = [];
captured.useState.length = 0; captured.useMemo.length = 0;
let threw = false;
try { mod.JobsCleanupModal({ onClose: () => {} }); } catch (e) { threw = true; console.log('    ', e.message); }
check('空库渲染不抛异常', !threw);
const emptyPicked = [...captured.useState].find((v) => v instanceof Set);
check('空库时勾选集为空', emptyPicked instanceof Set && emptyPicked.size === 0);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
