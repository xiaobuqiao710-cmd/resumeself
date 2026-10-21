#!/usr/bin/env node
/**
 * profile 结构容错回归测试（2026-10-18）
 * ==========================================================================
 * 修的是什么：`migrateProfile` 原先只补「项目经历」，却假定 profile / profile.single /
 * profile.multi 一定存在。云端文档、手工整理的备份、别人给的还原包都可能只有 `{basic:{...}}`，
 * `(?m.profile) ?? emptyProfile()` 只挡整块缺失，**残缺的块照样穿过去**，于是
 * `profile.single` 为 undefined，Dashboard / Database / Resume / docx / ai 里上百处
 * `profile.single.personal` 一起抛 `Cannot read properties of undefined (reading 'personal')`
 * —— 表现是**所有板块同时白屏**（2026-10-18 线上实测复现）。
 *
 * 断言：无论 profile 被削成什么样，出来的结构都必须满足各消费点的直接下标访问。
 *
 * 跑法：node scripts/qa-profile-shape.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

/* 只加载 store 模块会拖进 React 与整个 UI 依赖图，太大；
   这里用 esbuild 把 store.tsx 编成 ESM 后**只取 migrateProfile 的行为**：
   组件文件导出 StoreProvider，migrateProfile 是模块内部的 —— 于是走「真实源码 + 桩掉 React」这条路。 */
const reactShim = `
export const useState = (i) => [typeof i === 'function' ? i() : i, () => {}];
export const useMemo = (f) => f();
export const useCallback = (f) => f;
export const useRef = (v) => ({ current: v });
export const useEffect = () => {};
export const useContext = (c) => c;
export const createContext = (v) => ({ Provider: (p) => p.children, _v: v });
export const createElement = () => null;
export const Fragment = 'f';
export default { useState, useMemo, useCallback, useRef, useEffect, useContext, createContext };
`;
const jsxShim = `export const jsx=()=>null, jsxs=()=>null, Fragment='f';`;

async function loadStore() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shims = [
    ['react', reactShim], ['shimreact/jsx-runtime', jsxShim],
    ['../lib/cloudState', `export const saveCloudState=async()=>(new Date().toISOString()); export const fetchCloudUpdatedAt=async()=>null; export const loadCloudState=async()=>({});`],
    ['../lib/seed', `export const SEED_PROFILE={single:{basic:{name:''},personal:{name:'',phone:'',email:''}},multi:{project:[]}}; export const MATERIAL_BASE_DEFAULT='';`],
  ];
  const plugins = shims.map(([from, code], i) => ({
    name: `shim${i}`,
    setup(b) {
      const ns = `shim${i}`;
      b.onResolve({ filter: new RegExp(`^${esc(from)}$`) }, () => ({ path: 'entry', namespace: ns }));
      b.onLoad({ filter: /^entry$/, namespace: ns }, () => ({ contents: code, loader: 'js' }));
    },
  }));
  const out = await build({
    entryPoints: [path.join(ROOT, 'src/store/store.tsx')],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
    jsx: 'automatic', jsxImportSource: "shimreact", plugins,
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const tmp = path.join(ROOT, 'node_modules/.tmp', `qa-store-${Date.now()}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const mod = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);
  return mod;
}

const store = await loadStore();

/* migrateProfile 没导出，用 render 路径拿不到；改为在源文件里检查它导出的行为 ——
   这里直接调用导出的 `StoreProvider` 太依赖 React，因此改用源码级断言 + 一个可执行的结构检查。
   更可靠的做法：把 seed 结构当模板的结论用「模拟消费点」验证。 */
console.log('\n【1】结构契约：各消费点都会直接下标访问这些字段');
const REQUIRED_SINGLE = ['personal'];
const REQUIRED_MULTI = ['project'];

async function structuralCheck(label, makeProfile) {
  const p = store.__testMigrateProfile ? store.__testMigrateProfile(makeProfile()) : null;
  if (!p) { check(`${label}：测试钩子可用`, false, 'store 未导出 __testMigrateProfile'); return null; }
  const okSingle = p.single && typeof p.single === 'object';
  const okMulti = p.multi && typeof p.multi === 'object' && Array.isArray(p.multi.project);
  check(`${label}：p.single 是对象（Dashboard 直接读 profile.single.personal）`, okSingle);
  check(`${label}：p.multi.project 是数组`, okMulti);
  if (okSingle) {
    for (const k of REQUIRED_SINGLE) {
      check(`${label}：p.single.${k} 存在且可下标访问`, p.single[k] && typeof p.single[k] === 'object');
    }
    let threw = null;
    try { void (p.single.personal || {}).name; } catch (e) { threw = e.message; }
    check(`${label}：读 p.single.personal.name 不抛异常`, !threw, threw || '');
  }
  return p;
}

const cases = [
  ['profile.single 整体缺失', () => ({ multi: { project: [] } })],
  ['profile.multi 整体缺失', () => ({ single: { basic: { name: 'x' } } })],
  ['只有 basic、没有 single/multi', () => ({ basic: { name: 'x' } })],
  ['single 是 null', () => ({ single: null, multi: { project: [] } })],
  ['single 是数组（脏数据）', () => ({ single: [], multi: {} })],
  ['整块缺失（undefined）', () => undefined],
  ['完整正常数据', () => ({ single: { personal: { name: '张三' } }, multi: { project: [{ name: '甲' }] } })],
];
for (const [label, mk] of cases) await structuralCheck(label, mk);

console.log('\n【2】用户已有字段不被覆盖');
const kept = store.__testMigrateProfile ? store.__testMigrateProfile({ single: { personal: { name: '张三', phone: '13800000000' } }, multi: { project: [{ name: '我的项目' }] } }) : null;
check('用户自己的姓名保留', kept?.single?.personal?.name === '张三', kept?.single?.personal?.name);
check('用户自己的手机号保留', kept?.single?.personal?.phone === '13800000000');
check('用户自己的项目经历保留', (kept?.multi?.project || []).some((x) => x.name === '我的项目'));

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
