#!/usr/bin/env node
/**
 * 日历「接下来要做的」选件窗口回归测试（2026-10-20）
 * ==========================================================================
 * 修的是什么（用户两次反馈叠起来看才清楚）：
 *   第一次：「这里呈现的待办和我的投递记录也不匹配」—— 邮件同步进来的 9 条
 *          「已过 30 天」笔试通知堆在顶部，把真正临近的事压没了。于是给外来日程加了
 *          3 天窗口，超过就收进「已结束」折叠区。
 *   第二次：「把投递记录的笔面试时间要呈现在日历待办里」—— 这条 3 天窗口连他自己
 *          在进度线里填的那场笔试（7 天前）也一起扫走了，看起来像「填了但没保存成功」。
 *
 * 现在的口径（`lib/agenda.ts`）：
 *   · `ev-stage-*` 派生事件（= 投递记录的进度线投影）：未完成就**一直留着**，过期多久都留着；
 *   · 其它约定日程（邮件同步 / 手工建的笔试面试）：过期 3 天内给一次回顾机会，超过就折叠；
 *   · 待办 / 事项：只收今天与未来；
 *   · 排序：未来在前（按日期升序），过期的在后且**越近越靠前** —— 原先所有过期项
 *     压成同一个 -1 键，结果最老的一条反而排到了今天上面。
 *
 * 跑法：node scripts/qa-agenda-window.mjs
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

async function loadModule(entry, tag = 'qa-agenda') {
  const out = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
  });
  const tmp = path.join(ROOT, 'node_modules/.tmp', `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const mod = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);
  return mod;
}

const A = await loadModule('src/lib/agenda.ts');

const TODAY = '2026-10-20';
const d = (n) => {
  const x = new Date(2026, 9, 20);
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

/** 投递记录投影出来的笔面试事件（id 形如 ev-stage-<appId>--<entryId>） */
const stage = (n, extra = {}) => ({
  id: `ev-stage-app-1--s${Math.abs(n)}`, title: '工商银行 · 法务岗 · 笔试',
  date: d(n), type: 'test', appId: 'app-1', source: 'app', ...extra,
});
/** 外来日程：邮件同步 / 手工建的 */
const foreign = (n, extra = {}) => ({
  id: `ev-mail-${Math.abs(n)}`, title: '某行笔试通知',
  date: d(n), type: 'test', source: 'import', ...extra,
});

const ids = (list) => list.map((e) => e.id);

console.log('\n【1】投递记录的笔面试：过期多久都要留在待办（用户第二次反馈的核心）');
check('7 天前那场笔试仍在待办里', ids(A.buildAgenda([stage(-7)], TODAY)).includes(stage(-7).id));
check('30 天前的也留着 —— 没标「已赴约」就是还没处理', ids(A.buildAgenda([stage(-30)], TODAY)).includes(stage(-30).id));
check('今天 / 未来的当然在', A.buildAgenda([stage(0), stage(3)], TODAY).length === 2);
check('边界：恰好 3 天前在（不再被 3 天窗口误伤）', A.isAgendaEvent(stage(-3), TODAY) === true);
check('边界：恰好 8 天前也在', A.isAgendaEvent(stage(-8), TODAY) === true);

console.log('\n【2】外来约定日程仍走 3 天窗口（第一次反馈要压掉的那批噪音）');
check('3 天前的外来笔试：给一次回顾机会', A.isAgendaEvent(foreign(-3), TODAY) === true);
check('4 天前的外来笔试：收进折叠区', A.isAgendaEvent(foreign(-4), TODAY) === false);
check('30 天前的外来通知：收进折叠区', A.isAgendaEvent(foreign(-30), TODAY) === false);
check('未来的外来面试：收', A.isAgendaEvent(foreign(6, { type: 'interview' }), TODAY) === true);
check('Offer 也算约定日程', A.isAgendaEvent(foreign(-1, { type: 'offer' }), TODAY) === true);

console.log('\n【3】待办 / 事项：过期即收，没有宽限期');
check('昨天没做完的待办不进待办区（进「已结束」）', A.isAgendaEvent(foreign(-1, { type: 'todo' }), TODAY) === false);
check('今天的待办进', A.isAgendaEvent(foreign(0, { type: 'todo' }), TODAY) === true);
check('事项同理', A.isAgendaEvent(foreign(-2, { type: 'other' }), TODAY) === false);
check('没有日期的事件一律不进（undefined 会算出 NaN）', A.isAgendaEvent({ id: 'x', title: 't', date: '', type: 'test' }, TODAY) === false);

console.log('\n【4】排序：未来在前升序，过期在后且越近越靠前');
const mixed = [
  stage(-30), stage(-2), stage(5), stage(0), stage(-1), stage(2),
];
const order = A.buildAgenda(mixed, TODAY).map((e) => e.date);
check('今天排第一', order[0] === d(0), order.join(' , '));
check('未来按日期升序（今天 → 2 天 → 5 天）', order.slice(0, 3).join('|') === [d(0), d(2), d(5)].join('|'), order.join(' , '));
check('过期的全排在未来的后面', order.slice(3).every((x) => x < TODAY), order.join(' , '));
check('过期区里越近越靠前（-1 → -2 → -30）', order.slice(3).join('|') === [d(-1), d(-2), d(-30)].join('|'), order.slice(3).join(' , '));

console.log('\n【5】同一天按时间排，无时间的排最后');
const sameDay = [
  { id: 'ev-a', title: 'A', date: d(1), time: '14:30', type: 'interview' },
  { id: 'ev-b', title: 'B', date: d(1), type: 'test' },
  { id: 'ev-c', title: 'C', date: d(1), time: '09:00', type: 'test' },
];
check('09:00 → 14:30 → 无时间', A.buildAgenda(sameDay, TODAY).map((e) => e.id).join('|') === 'ev-c|ev-a|ev-b');

console.log('\n【6】不修改入参（Calendar 每次渲染都会重算，改坏原数组会连带弄乱月视图）');
const src = [stage(3), foreign(-9)];
const snapshot = JSON.stringify(src);
A.buildAgenda(src, TODAY);
check('原数组顺序与内容不变', JSON.stringify(src) === snapshot);
check('返回的是新数组', A.buildAgenda(src, TODAY) !== src);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
