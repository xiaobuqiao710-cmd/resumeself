#!/usr/bin/env node
/**
 * 投递进度线 → 日历 的回归测试（2026-10-20）
 * ==========================================================================
 * 修的是什么：日历看不到投递记录里的信息。根因是投递记录里没有笔试/面试的时间字段，
 * 「快捷加入日历」拿"今天"建一条不含岗位的空事件，之后两边各存一份、互不相干。
 *
 * 现在的口径：笔面日程的唯一真源是投递记录的进度线（`Application.timeline`），
 * 日历侧只做投影（`deriveStageEvents`），迁移时把旧的、挂得上投递的事件折进进度线
 * （`foldStageEventsIntoApps`）。这个测试断言的就是这两件事，以及它们必须幂等。
 *
 * 跑法：node scripts/qa-app-timeline.mjs
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
  const tmp = path.join(ROOT, 'node_modules/.tmp', `qa-line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const mod = await import(`file://${tmp}?t=${Date.now()}`);
  fs.unlinkSync(tmp);
  return mod;
}

const L = await loadModule('src/lib/appTimeline.ts');
const TODAY = '2026-10-20';

const mkApp = (over = {}) => ({
  id: 'app-1', company: '中金公司', position: '法务合规岗', status: 'interview',
  createdAt: '2026-09-01', updatedAt: '2026-09-01',
  timeline: [
    { id: 's1', status: 'submitted', at: '2026-09-10', done: true },
    { id: 's2', status: 'test', at: '2026-10-15', time: '09:30', place: '线上笔试系统', done: true },
    { id: 's3', status: 'interview', at: '2026-11-02', time: '14:00', place: '中金大厦 12 层', note: '带简历 2 份', done: false },
  ],
  ...over,
});

console.log('\n【1】派生口径：只有笔试/面试/Offer 且有日期才进日历');
const evs = L.deriveStageEvents([mkApp()]);
check('3 个节点里只派生出 2 条（已提交不进日历）', evs.length === 2, `实际 ${evs.length}`);
check('笔试与面试各一条', evs.map((e) => e.type).sort().join(',') === 'interview,test');
const noDate = mkApp({ timeline: [{ id: 's9', status: 'interview', at: '', done: false }] });
check('没有日期的面试节点不派生（不编日期）', L.deriveStageEvents([noDate]).length === 0);
const todoOnly = mkApp({ timeline: [{ id: 's8', status: 'todo', at: '2026-11-05', done: false }] });
check('待办/填写中节点不派生', L.deriveStageEvents([todoOnly]).length === 0);

console.log('\n【2】日历上要认得出来是哪个岗位、几点、在哪');
const interview = evs.find((e) => e.type === 'interview');
check('标题带公司与岗位', interview.title.includes('中金公司') && interview.title.includes('法务合规岗'), interview.title);
check('带具体时间', interview.time === '14:00');
check('带地点', interview.place === '中金大厦 12 层');
check('带备注', interview.note === '带简历 2 份');
check('挂上投递记录 id（日历可跳回记录）', interview.appId === 'app-1');
check('未赴约的节点派生为未完成', interview.done === false);

console.log('\n【3】派生事件 id 能反解回「哪个投递的哪个节点」（日历改时间要写回这里）');
const parsed = L.parseStageEventId(interview.id);
check('反解出 appId', parsed?.appId === 'app-1', JSON.stringify(parsed));
check('反解出 entryId', parsed?.entryId === 's3', JSON.stringify(parsed));
check('普通手工事件不会被误认（反解为 null）', L.parseStageEventId('ev-abc123') === null);

console.log('\n【4】迁移：旧事件折进进度线，且不重复、不丢、不误删');
const legacyApp = {
  id: 'app-2', company: '工商银行', position: '管培生', status: 'interview',
  createdAt: '2026-09-02', updatedAt: '2026-09-02',
  timeline: [{ status: 'submitted', at: '2026-09-12' }],   // 老数据：没有 id、没有 done
};
const legacyEvents = [
  /* 挂得上投递记录的面试：应被折进进度线并移出 events */
  { id: 'ev-1', title: '工商银行 · 面试', date: '2026-10-28', time: '10:00', type: 'interview', appId: 'app-2', note: '邮件：面试通知', source: 'mail' },
  /* 投递记录已删掉的事件：不能跟着消失 */
  { id: 'ev-2', title: '某公司 · 笔试', date: '2026-10-25', type: 'test', appId: 'app-gone', source: 'manual' },
  /* 手工独立日程：与投递无关，原样保留 */
  { id: 'ev-3', title: '整理网申材料', date: '2026-10-22', type: 'todo', source: 'manual' },
  /* 截止类事件：不参与折叠 */
  { id: 'ev-4', title: '工商银行 网申截止', date: '2026-09-20', type: 'deadline', appId: 'app-2', source: 'application' },
];
const r1 = L.foldStageEventsIntoApps([legacyApp], legacyEvents);
const a2 = r1.applications[0];
check('旧面试事件被折进进度线', a2.timeline.some((t) => t.status === 'interview' && t.at === '2026-10-28'));
check('折叠后带上了时间与备注', a2.timeline.find((t) => t.status === 'interview')?.time === '10:00'
  && a2.timeline.find((t) => t.status === 'interview')?.note === '邮件：面试通知');
check('折叠掉的旧事件从 events 里摘除', !r1.events.some((e) => e.id === 'ev-1'));
check('投递已删的事件原样保留（不能凭空消失）', r1.events.some((e) => e.id === 'ev-2'));
check('手工待办原样保留', r1.events.some((e) => e.id === 'ev-3'));
check('截止类事件不参与折叠', r1.events.some((e) => e.id === 'ev-4'));
check('老节点补上了 id', a2.timeline.every((t) => !!t.id));
check('老节点补上了 done=true（历史事实）', a2.timeline.filter((t) => t.at === '2026-09-12').every((t) => t.done === true));
check('进度线按日期有序', a2.timeline.map((t) => t.at).join(',') === '2026-09-12,2026-10-28');
check('折完日历只剩一条面试（不会出现两条一样的）',
  L.deriveStageEvents(r1.applications).filter((e) => e.type === 'interview').length === 1);

const r2 = L.foldStageEventsIntoApps(r1.applications, r1.events);
check('幂等：再跑一次节点数不变', r2.applications[0].timeline.length === a2.timeline.length,
  `${a2.timeline.length} → ${r2.applications[0].timeline.length}`);
check('幂等：再跑一次不再折叠任何事件', r2.folded === 0);

console.log('\n【5】同一天同一阶段的重复事件只折成一个节点');
const dupApp = { id: 'app-3', company: '建设银行', position: '综合岗', status: 'test', createdAt: '2026-09-03', updatedAt: '2026-09-03', timeline: [] };
const dupEvents = [
  { id: 'd1', title: '建设银行 · 笔试', date: '2026-10-30', time: '09:00', type: 'test', appId: 'app-3', source: 'import' },
  { id: 'd2', title: '建设银行 · 笔试', date: '2026-10-30', type: 'test', appId: 'app-3', source: 'import' },
];
const r3 = L.foldStageEventsIntoApps([dupApp], dupEvents);
check('两条重复事件 → 一个节点', r3.applications[0].timeline.length === 1, `实际 ${r3.applications[0].timeline.length}`);
check('节点保留了有时间的那个字段', r3.applications[0].timeline[0].time === '09:00');

console.log('\n【6】「下一次要赴的约」：列表行靠它显示 11/02 14:00 面试');
const nx = L.nextStageOf(mkApp(), TODAY);
check('取到 11/02 那场面试', nx?.entry.at === '2026-11-02' && nx?.entry.status === 'interview');
const allDone = mkApp({ timeline: [{ id: 'x', status: 'interview', at: '2026-11-02', done: true }] });
check('已赴约的节点不算「下一次」', L.nextStageOf(allDone, TODAY) === null);
const noneSched = mkApp({ timeline: [{ id: 'y', status: 'submitted', at: '2026-09-10', done: true }] });
check('没有笔面节点时返回 null', L.nextStageOf(noneSched, TODAY) === null);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
