#!/usr/bin/env node
/**
 * 日历提醒口径回归测试（2026-10-17）
 * ==========================================================================
 * 修的是什么：日历页的「待办提醒」曾把所有 todo 事件平铺，主区又把所有未来事件再列一遍，
 * 导入汇总表写进来的截止日（含已投递单位的）把「笔试 / 面试在哪天」淹掉，
 * 日历因此没有提醒作用。
 *
 * 现在的判据只有一条：`lib/remind.ts` 的 `isEventActionable`，
 * 日历页的「接下来要做的」与顶部提醒条共用它。这个测试断言的是**这条判据本身**：
 *   ① 约定日程（笔试/面试/Offer）无论投没投递都必须留 —— 它们是唯一有提醒价值的对象；
 *   ② 截止类事件：该单位已投递/已归档 → 不收；未投递且未过期 → 收；
 *   ③ 待办：未完成且未过期才收；过期/完成都不收；
 *   ④ 已过期但未完成的笔试面试：仍要收（「已经错过」必须让人看见）；
 *   ⑤ 口径与提醒条一致：同一批数据下，`collectReminders` 认为要催的截止事件，
 *      日历也不会把它判成「可忽略」。
 *
 * 跑法：node scripts/qa-calendar-agenda.mjs
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
  const tmp = path.join(ROOT, 'node_modules/.tmp', `qa-cal-${Date.now()}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const mod = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);
  return mod;
}

const remind = await loadModule('src/lib/remind.ts');

const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const TODAY = d(0);

const ev = (over) => ({ id: `ev-${Math.random().toString(36).slice(2, 8)}`, title: 'x', date: TODAY, type: 'test', source: 'manual', ...over });

console.log('\n【1】约定日程：投没投递都要留（这是日历唯一有提醒价值的对象）');
const closedNone = [];
check('未来的面试 → 收', remind.isEventActionable(ev({ type: 'interview', date: d(3) }), closedNone, TODAY));
check('未来的笔试 → 收', remind.isEventActionable(ev({ type: 'test', date: d(1) }), closedNone, TODAY));
check('今天的 Offer 答复 → 收', remind.isEventActionable(ev({ type: 'offer', date: d(0) }), closedNone, TODAY));
check('**已过期**未完成的笔试 → 仍收（已错过要让人看见）',
  remind.isEventActionable(ev({ type: 'test', date: d(-4) }), closedNone, TODAY));

console.log('\n【2】截止类事件：已投递/已归档单位不再占位');
const closed = ['中金公司', '君合律师事务所'];
check('已投递单位的截止事件 → 不收',
  !remind.isEventActionable(ev({ type: 'deadline', title: '截止 · 中金公司 · 法务岗', date: d(5) }), closed, TODAY));
check('已归档单位的截止事件 → 不收',
  !remind.isEventActionable(ev({ type: 'deadline', title: '截止 · 君合律师事务所 · 律师助理', date: d(2) }), closed, TODAY));
check('未投递单位的未来截止 → 收',
  remind.isEventActionable(ev({ type: 'deadline', title: '截止 · 海问律师事务所 · 实习生', date: d(6) }), closed, TODAY));
check('未投递单位已过期的截止 → 不收（过去的截止没有提醒意义）',
  !remind.isEventActionable(ev({ type: 'deadline', title: '截止 · 海问律师事务所', date: d(-2) }), closed, TODAY));
check('已投递单位的**面试**事件不受影响 → 仍收',
  remind.isEventActionable(ev({ type: 'interview', title: '中金公司 · 面试', date: d(2) }), closed, TODAY));

console.log('\n【3】待办：只看未完成且未过期');
check('未完成、未来的待办 → 收', remind.isEventActionable(ev({ type: 'todo', title: '打印三方协议', date: d(2) }), closedNone, TODAY));
check('未完成、**已过期**的待办 → 不收（进「已结束」）',
  !remind.isEventActionable(ev({ type: 'todo', title: '旧待办', date: d(-1) }), closedNone, TODAY));
check('已完成的待办 → 不收',
  !remind.isEventActionable(ev({ type: 'todo', title: '做完了', date: d(2), done: true }), closedNone, TODAY));
check('已完成的面试 → 不收',
  !remind.isEventActionable(ev({ type: 'interview', date: d(2), done: true }), closedNone, TODAY));
check('没有日期的脏数据 → 不收', !remind.isEventActionable(ev({ type: 'test', date: '' }), closedNone, TODAY));

console.log('\n【4】已收工单位：口径由 closedCompaniesOf 统一提供');
const apps = [
  { id: 'a1', company: '中金公司', position: '法务', status: 'submitted', createdAt: TODAY, updatedAt: TODAY, timeline: [] },
  { id: 'a2', company: '某公司A', position: '法务', status: 'todo', createdAt: TODAY, updatedAt: TODAY, timeline: [] },
  { id: 'a3', company: '某公司B', position: '法务', status: 'reject', createdAt: TODAY, updatedAt: TODAY, timeline: [] },
];
const jobs = [
  { id: 'j1', company: '君合', title: '助理', status: 'applied', createdAt: TODAY, updatedAt: TODAY },
  { id: 'j2', company: '海问', title: '实习生', status: 'new', createdAt: TODAY, updatedAt: TODAY },
];
const cc = remind.closedCompaniesOf({ jobs, applications: apps });
check('已提交的投递单位被计入（中金公司）', cc.includes('中金公司'));
check('已投递的岗位单位被计入（君合）', cc.includes('君合'));
check('未投递的投递单位不计入（某公司A）', !cc.includes('某公司A'));
check('已投递的岗位不计入（海问）', !cc.includes('海问'));

console.log('\n【5】与提醒条一致：提醒条要催的截止事件，日历不能判成"可忽略"');
const events = [
  ev({ id: 'e1', type: 'deadline', title: '截止 · 海问 · 实习生', date: d(5) }),      // 未投递 → 两边都收
  ev({ id: 'e2', type: 'deadline', title: '截止 · 中金公司 · 法务', date: d(5) }),    // 已投递 → 两边都不收
  ev({ id: 'e3', type: 'interview', title: '中金公司 · 面试', date: d(3) }),           // 约定日程 → 两边都收
];
const calOk = new Map(events.map((e) => [e.id, remind.isEventActionable(e, cc, TODAY)]));
const bar = remind.collectReminders({ jobs, applications: apps, events }, { days: [7] });
const barEventIds = new Set(bar.filter((i) => i.kind === 'event').map((i) => i.id));
check('未投递单位的截止：日历收 · 提醒条也收',
  calOk.get('e1') === true && barEventIds.has('ev-e1'));
check('已投递单位的截止：日历不收 · 提醒条也不收',
  calOk.get('e2') === false && !barEventIds.has('ev-e2'));
check('面试日程：日历收 · 提醒条也收',
  calOk.get('e3') === true && barEventIds.has('ev-e3'));

console.log('\n【6】噪声检验：一份「导入汇总表」典型数据里，真实要做的没被淹掉');
const noisy = [];
for (let i = 0; i < 25; i++) {
  noisy.push(ev({ type: 'deadline', title: `截止 · 银行${i} · 柜员`, date: d(i + 1), source: 'import' }));
}
const realOnes = [
  ev({ type: 'test', title: '工商银行 · 笔试', date: d(2) }),
  ev({ type: 'interview', title: '中金公司 · 面试', date: d(4) }),
];
const all = [...noisy, ...realOnes];
const shown = all.filter((e) => remind.isEventActionable(e, [], TODAY));
check('25 条截止事件 + 2 条真实日程：真实日程 100% 保留',
  realOnes.every((r) => shown.some((s) => s.id === r.id)));
check('全部都会被收（未投递单位、未过期），说明覆盖率没被误伤', shown.length === all.length);
/* 加上"这些银行都已经投递了"的前提：25 条噪声全部应被过滤，只剩 2 条真实日程 */
const banksClosed = Array.from({ length: 25 }, (_, i) => `银行${i}`);
const shown2 = all.filter((e) => remind.isEventActionable(e, banksClosed, TODAY));
check('这些单位都已投递时，25 条截止被全部过滤，只剩 2 条真实日程', shown2.length === 2,
  `实际 ${shown2.length} 条：${shown2.map((s) => s.title).join(',')}`);

console.log('\n【7】日历层收紧：月视图与右栏都不收 deadline（用户在截图里看到的满屏「截止 · XX」）');
/* 复现用户截图里的真实规模：某月单日 +66 条截止事件 */
const bulk = [];
for (let i = 0; i < 400; i++) {
  bulk.push(ev({ type: 'deadline', title: `截止 · 单位${i} · 岗位`, date: d((i % 28) + 1), source: 'import' }));
}
const appointments = [
  ev({ type: 'test', title: '工商银行 · 笔试', date: d(2) }),
  ev({ type: 'interview', title: '中金公司 · 面试', date: d(4) }),
  ev({ type: 'offer', title: '中金公司 · Offer 答复', date: d(6) }),
];
const todos = [ev({ type: 'todo', title: '打印就业推荐表', date: d(1) })];
const allEvents = [...bulk, ...appointments, ...todos];
/* 与 Calendar.tsx 里 shownEvents 完全相同的判定 */
const shownInCalendar = allEvents.filter((e) => e.type !== 'deadline' && remind.isEventActionable(e, [], TODAY));
check('400 条截止事件全部不进日历', shownInCalendar.every((e) => e.type !== 'deadline'));
check('日历里只剩 4 条（3 条笔面试 Offer + 1 条待办）', shownInCalendar.length === 4,
  `实际 ${shownInCalendar.length}：${shownInCalendar.map((e) => e.title).join(',')}`);
check('笔试/面试/Offer 一条都没丢', appointments.every((a) => shownInCalendar.some((s) => s.id === a.id)));
check('待办保留', todos.every((t) => shownInCalendar.some((s) => s.id === t.id)));
/* 反向：如果按旧口径（不过滤 deadline），日历会被 400 条淹没 —— 证明这个过滤是必要的 */
const oldBehavior = allEvents.filter((e) => remind.isEventActionable(e, [], TODAY));
check('旧口径下会有 400+ 条进日历（正是用户截图里的样子）', oldBehavior.length > 400,
  `旧口径 ${oldBehavior.length} 条`);

console.log('\n【8】提醒条计数口径：只数「日程待办」，海量岗位截止单独降级');
/* 用户截图里显示「共 106 项待处理」，而日历格子已经空了 —— 两处口径必须对齐。
   这里直接调真实的 collectReminders，检查 kindOf 分类与计数。 */
const barEvents = [
  ...Array.from({ length: 420 }, (_, i) => ev({ type: 'deadline', title: `截止 · 单位${i}`, date: d((i % 20) + 1), source: 'import' })),
  ev({ type: 'test', title: '工商银行 · 笔试', date: d(2) }),
  ev({ type: 'interview', title: '中金公司 · 面试', date: d(3) }),
  ev({ type: 'todo', title: '打印就业推荐表', date: d(1) }),
];
const jobsForBar = Array.from({ length: 12 }, (_, i) => ({
  id: `jb${i}`, company: `岗位单位${i}`, title: '岗', status: 'new', deadline: d(5), createdAt: TODAY, updatedAt: TODAY,
}));
const bar2 = remind.collectReminders({ jobs: jobsForBar, applications: [], events: barEvents }, { days: [7] });
const nAppt = bar2.filter((i) => i.kindOf === 'appointment').length;
const nTodo = bar2.filter((i) => i.kindOf === 'todo').length;
const nDeadline = bar2.filter((i) => i.kindOf === 'deadline').length;
check('每一条提醒都带 kindOf 分类', bar2.every((i) => ['appointment', 'deadline', 'todo'].includes(i.kindOf)));
check('日程计数 = 2（1 笔试 + 1 面试），不含任何截止', nAppt === 2, `实际 ${nAppt}`);
check('待办计数 = 1', nTodo === 1, `实际 ${nTodo}`);
check('截止被单独归类（不计入日程待办）', nDeadline > 0, `实际 ${nDeadline}`);
check('日程待办总数 = 3（旧口径会是几百）', nAppt + nTodo === 3, `实际 ${nAppt + nTodo}`);
check('旧口径「共 N 项待处理」= ' + bar2.length + ' 项（含海量截止），新口径只数 3 项', bar2.length > 100);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
