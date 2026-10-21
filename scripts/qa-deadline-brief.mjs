#!/usr/bin/env node
/**
 * 「AI 梳理截止」清单的规则回归测试（2026-10-20）
 * ==========================================================================
 * 用户的原话：「这里呈现的待办和我的投递记录也不匹配……建议直接设置成一个 AI 按钮，
 * 我一按就显示你哪些要截止，以及何时截止。」
 *
 * 这一屏的清单完全由规则算出（`lib/deadlineBrief.ts`），AI 只在上面补一句话。
 * 所以这里断言的是**规则本身**，日期算错一天、把已截止的当成还有时间，都必须拦住：
 *   ① 投递截止：只收「待投递 / 填写中」；已提交之后不再催；
 *   ② 岗位截止：已投递、已归档、或该单位已有提交过的投递 → 不收；
 *   ③ 笔面日程：只收未完成的笔试/面试/Offer；deadline 与 todo 类型不进；
 *   ④ 无主日程（对不上任何投递记录）单独标出来，因为它们是噪音的主要来源；
 *   ⑤ 分档：已过期 / 今天 / 3 天内 / 7 天内 / 更远，边界值不能错；
 *   ⑥ 排序：过期的排最前且「越久越靠后」，未来的按时间升序。
 *
 * 跑法：node scripts/qa-deadline-brief.mjs
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

async function loadModule(entry) {
  const out = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  });
  const tmp = path.join(ROOT, 'node_modules/.tmp', `qa-brief-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const mod = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);
  return mod;
}

const { buildDeadlineBrief } = await loadModule('src/lib/deadlineBrief.ts');

/** 以「今天」为基准生成偏移日期，避免测试写死日期后过期。
 *  原先这里写死成 new Date(2026, 9, 20)：注释说「避免写死」，代码却把基准钉在 10-20。
 *  过了那天，所有相对断言（5 天后 / 昨天 / 3 天内）一起漂移——2026-10-21 实测 10 failed。
 *  基准必须取真实的今天，测试才不会到点自己烂掉。 */
const d = (n) => {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 真实今天（本地时区）
  base.setDate(base.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())}`;
};
const TODAY = d(0);

const mkApp = (over = {}) => ({
  id: 'a1', company: '中金公司', position: '法务合规岗', status: 'filling',
  deadline: d(5), createdAt: TODAY, updatedAt: TODAY, timeline: [], ...over,
});
const mkJob = (over = {}) => ({
  id: 'j1', company: '国家开发银行', title: '法务岗', status: 'interested',
  deadline: d(2), createdAt: TODAY, updatedAt: TODAY, ...over,
});
const mkEv = (over = {}) => ({
  id: 'e1', title: 'x', date: d(1), type: 'interview', source: 'manual', ...over,
});

console.log('\n【1】投递截止：只催「还没提交」的');
let b = buildDeadlineBrief({ applications: [mkApp()], jobs: [], events: [] }, TODAY);
check('填写中的投递截止 → 进清单', b.items.length === 1 && b.items[0].kind === 'app');
check('剩余天数算对（5 天后）', b.items[0].days === 5, String(b.items[0].days));
check('标签写「网申截止」', b.items[0].label === '网申截止');
for (const s of ['submitted', 'test', 'interview', 'offer', 'reject']) {
  b = buildDeadlineBrief({ applications: [mkApp({ status: s })], jobs: [], events: [] }, TODAY);
  check(`状态=${s} 的投递不再催截止`, b.items.length === 0);
}
b = buildDeadlineBrief({ applications: [mkApp({ deadline: '' })], jobs: [], events: [] }, TODAY);
check('没填截止日 → 不进清单', b.items.length === 0);

console.log('\n【2】岗位截止：已投递/已归档/该单位已提交过 → 都不催');
b = buildDeadlineBrief({ applications: [], jobs: [mkJob()], events: [] }, TODAY);
check('未投递的岗位截止 → 进清单', b.items.length === 1 && b.items[0].kind === 'job');
b = buildDeadlineBrief({ applications: [], jobs: [mkJob({ status: 'applied' })], events: [] }, TODAY);
check('已投递的岗位 → 不催', b.items.length === 0);
b = buildDeadlineBrief({ applications: [], jobs: [mkJob({ status: 'archived' })], events: [] }, TODAY);
check('已归档的岗位 → 不催', b.items.length === 0);
b = buildDeadlineBrief({
  applications: [mkApp({ company: '国家开发银行', status: 'submitted', deadline: '' })],
  jobs: [mkJob()], events: [],
}, TODAY);
check('该单位已有提交过的投递 → 岗位截止不重复催', b.items.length === 0);

console.log('\n【3】笔面日程：只收未完成的笔试/面试/Offer');
b = buildDeadlineBrief({ applications: [], jobs: [], events: [mkEv()] }, TODAY);
check('未完成的面试 → 进清单', b.items.length === 1 && b.items[0].kind === 'stage');
b = buildDeadlineBrief({ applications: [], jobs: [], events: [mkEv({ done: true })] }, TODAY);
check('已完成的面试 → 不进', b.items.length === 0);
b = buildDeadlineBrief({ applications: [], jobs: [], events: [mkEv({ type: 'todo' })] }, TODAY);
check('待办不进「截止清单」（它自己有一块）', b.items.length === 0);
b = buildDeadlineBrief({ applications: [], jobs: [], events: [mkEv({ type: 'deadline' })] }, TODAY);
check('deadline 类型的事件不进（免得与岗位截止重复）', b.items.length === 0);

console.log('\n【4】无主日程：对不上投递记录的要单独标出来');
const app = mkApp({ id: 'a1', company: '中金公司' });
b = buildDeadlineBrief({
  applications: [app],
  jobs: [],
  events: [mkEv({ id: 'e-ok', appId: 'a1', date: d(2) }), mkEv({ id: 'e-lost', appId: 'app-gone', date: d(3) })],
}, TODAY);
check('挂得上投递的日程不算无主', b.orphans.every((o) => o.key !== 'ev-e-ok'));
check('appId 指向不存在的投递 → 算无主', b.orphans.some((o) => o.key === 'ev-e-lost'));
b = buildDeadlineBrief({ applications: [], jobs: [], events: [mkEv({ id: 'e-noapp' })] }, TODAY);
check('没有 appId 的日程 → 算无主', b.orphans.length === 1);
check('有 appId 时标题用投递记录的公司名', (() => {
  const x = buildDeadlineBrief({ applications: [app], jobs: [], events: [mkEv({ appId: 'a1', title: '尊敬的宋同学' })] }, TODAY);
  return x.items[0].company === '中金公司';
})());

console.log('\n【5】分档边界：今天 / 3 天 / 7 天 / 更远，一天都不能错');
b = buildDeadlineBrief({
  applications: [],
  jobs: [],
  events: [
    mkEv({ id: 'o', type: 'test', date: d(-1) }),
    mkEv({ id: 't', type: 'test', date: d(0) }),
    mkEv({ id: 'x3', type: 'test', date: d(3) }),
    mkEv({ id: 'x4', type: 'test', date: d(4) }),
    mkEv({ id: 'x7', type: 'test', date: d(7) }),
    mkEv({ id: 'x8', type: 'test', date: d(8) }),
  ],
}, TODAY);
check('昨天 → overdue', b.buckets.overdue.length === 1);
check('今天 → today', b.buckets.today.length === 1);
check('+3 天 → d3', b.buckets.d3.some((i) => i.key === 'ev-x3'));
check('+4 天 → d7（不是 d3）', b.buckets.d7.some((i) => i.key === 'ev-x4') && !b.buckets.d3.some((i) => i.key === 'ev-x4'));
check('+7 天仍算 d7', b.buckets.d7.some((i) => i.key === 'ev-x7'));
check('+8 天 → later', b.buckets.later.some((i) => i.key === 'ev-x8'));

console.log('\n【6】排序：过期的排最前，且「越久越靠后」；未来按时间升序');
b = buildDeadlineBrief({
  applications: [],
  jobs: [],
  events: [
    mkEv({ id: 'old30', type: 'test', date: d(-30) }),
    mkEv({ id: 'old3', type: 'test', date: d(-3) }),
    mkEv({ id: 'today', type: 'test', date: d(0) }),
    mkEv({ id: 'soon', type: 'test', date: d(2) }),
    mkEv({ id: 'far', type: 'test', date: d(20) }),
  ],
}, TODAY);
const order = b.items.map((i) => i.key.replace('ev-', ''));
check('刚过期的排最前（不是 30 天前那条）', order[0] === 'old3', order.join(','));
check('30 天前的排在过期组最后', order[1] === 'old30', order.join(','));
check('未来的按时间升序', order.slice(2).join(',') === 'today,soon,far', order.join(','));

console.log('\n【7】摘要与 AI 上下文');
b = buildDeadlineBrief({
  applications: [mkApp({ deadline: d(0) })],
  jobs: [],
  events: [mkEv({ type: 'test', date: d(-5) })],
}, TODAY);
check('摘要点出过期与今天', /已过期没处理/.test(b.summary) && /今天 1 项/.test(b.summary), b.summary);
check('AI 上下文带日期与剩余天数', /已过 5 天/.test(b.aiContext) && /今天/.test(b.aiContext));
check('空清单给出「没有要赶的截止」', buildDeadlineBrief({ applications: [], jobs: [], events: [] }, TODAY).summary === '目前没有要赶的截止');

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
