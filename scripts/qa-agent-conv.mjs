#!/usr/bin/env node
/**
 * AI 助手 · 对话结构单测（纯函数，不需要浏览器 / 预览服务 / AI 接口）
 *
 * 用法：node scripts/qa-agent-conv.mjs      退出码 0 = 全绿
 *
 * ── 为什么要有这个文件
 * 侧边栏会「聊着聊着突然 400」，报的却是「该模型不支持工具调用」——被引去换模型，
 * 换完还是 400。真因是 OpenAI 协议对 tool 消息的两条硬约束被破坏了：
 *   ① assistant(tool_calls) 后面必须逐条跟上对应 id 的 tool 消息；
 *   ② 任何 tool 消息前面必须有声明它 id 的 assistant。
 * 这两种破法都不长在界面上（数据坏在 localStorage 的 raw 里），只有把 sanitizeConversation /
 * trimRawConversation 当纯函数直接喂坏数据才能钉住。所以这份测试跑在 Node 里，
 * 用 esbuild 把 src/lib/agent.ts 现编现跑，连浏览器都不用起。
 *
 * ── 为什么断言里要保留「旧写法」的用例
 * 见 case 5/6：先证明 slice(-N) 与「只补不删」确实会造出非法结构，
 * 这样将来谁把实现改回去，测试会立刻红，而不是等用户撞上 400。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.join(fileURLToPath(new URL('..', import.meta.url)));
let pass = 0; let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};

/* ---- 把 TS 现编成 ESM 再 import（仓库里没有 ts-node，esbuild 是现成 devDependency） ---- */
const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/lib/agent.ts')],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2020',
  write: false, logLevel: 'silent',
});
const tmp = path.join(os.tmpdir(), `qz-agent-conv-${process.pid}.mjs`);
fs.writeFileSync(tmp, built.outputFiles[0].text);
const { sanitizeConversation, trimRawConversation } = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });

/* ---- 协议合法性校验器：故意写得比实现更严，用来当裁判 ---- */
function violations(msgs) {
  const errs = [];
  let pending = [];
  msgs.forEach((m, i) => {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') { errs.push(`#${i} 角色非法`); return; }
    if (m.role === 'tool') {
      const at = m.tool_call_id ? pending.indexOf(m.tool_call_id) : -1;
      if (at < 0) errs.push(`#${i} 孤立 tool（前面没有声明 ${m.tool_call_id || '?'} 的 assistant）`);
      else pending.splice(at, 1);
      return;
    }
    if (pending.length) errs.push(`#${i} 上一条 assistant 还欠 ${pending.length} 条回执`);
    const tc = m.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    pending = tc.map((c) => c && c.id).filter(Boolean);
  });
  if (pending.length) errs.push(`结尾仍欠 ${pending.length} 条回执`);
  if (msgs.length && msgs[0].role === 'tool') errs.push('#0 以 tool 开头');
  return errs;
}
const call = (id, name = 'site_stats', args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/* ================= 1. 孤儿 tool（截图里那条报错的形态） ================= */
console.log('\n1) 孤儿 tool 消息 —— 正是截图里 DeepSeek 报的那句');
{
  const bad = [
    { role: 'system', content: 'S' },
    { role: 'tool', tool_call_id: 'call_a', content: '{}' },   // 声明者被截断掉了
    { role: 'user', content: '还有哪些需要投' },
  ];
  ok(violations(bad).length === 1, '坏数据本身确实非法（前置自检）');
  const fixed = sanitizeConversation(bad);
  ok(violations(fixed).length === 0, '体检后合法', violations(fixed).join(' / '));
  ok(!fixed.some((m) => m.role === 'tool'), '孤儿 tool 被丢掉，而不是硬塞一条 assistant 上去');
  ok(fixed.length === 2, '只少了那一条孤儿', `实际 ${fixed.length} 条`);
}

/* ================= 2. 缺回执（等用户确认删除时被打断 / 关页面） ================= */
console.log('\n2) assistant 声明了 3 个工具但只回执了 1 个');
{
  const bad = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '清理重复' },
    { role: 'assistant', content: null, tool_calls: [call('c1'), call('c2'), call('c3')] },
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
  ];
  const fixed = sanitizeConversation(bad);
  ok(violations(fixed).length === 0, '体检后合法', violations(fixed).join(' / '));
  const tools = fixed.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  ok(JSON.stringify(tools) === JSON.stringify(['c1', 'c2', 'c3']), '缺的按声明顺序补齐', JSON.stringify(tools));
  const i = fixed.findIndex((m) => m.role === 'assistant');
  ok(fixed.slice(i + 1, i + 4).every((m) => m.role === 'tool'), '合成回执紧跟在那条 assistant 后面');
}

/* ================= 3. 孤儿 + 缺回执混在一起 ================= */
console.log('\n3) 同时有孤儿和缺回执');
{
  const bad = [
    { role: 'system', content: 'S' },
    { role: 'tool', tool_call_id: 'ghost1', content: '{}' },
    { role: 'assistant', content: null, tool_calls: [call('x1'), call('x2')] },
    { role: 'tool', tool_call_id: 'ghost2', content: '{}' },   // 孤儿，且夹在中间
    { role: 'tool', tool_call_id: 'x1', content: '{}' },
    { role: 'user', content: '继续' },
  ];
  const fixed = sanitizeConversation(bad);
  ok(violations(fixed).length === 0, '体检后合法', violations(fixed).join(' / '));
  ok(!fixed.some((m) => m.tool_call_id === 'ghost1' || m.tool_call_id === 'ghost2'), '两条孤儿都被清掉');
  ok(fixed.some((m) => m.tool_call_id === 'x2'), '缺失的 x2 被补上');
  ok(fixed[fixed.length - 1].role === 'user', '补出来的回执插在 user 之前，不越过用户消息');
}

/* ================= 4. 幂等 —— 体检可以反复跑（每次请求前都会跑） ================= */
console.log('\n4) 幂等：体检两次结果一致');
{
  const bad = [
    { role: 'system', content: 'S' },
    { role: 'tool', tool_call_id: 'g', content: '{}' },
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: '{}' },
    { role: 'user', content: 'hi' },
  ];
  const once = sanitizeConversation(bad);
  const twice = sanitizeConversation(once);
  ok(JSON.stringify(once) === JSON.stringify(twice), '两次体检结果完全一致');
  ok(violations(once).length === 0, '且合法');
}

/* ================= 5. 旧写法 slice(-N) 会造出非法结构（防回归） ================= */
console.log('\n5) 持久化截断：旧 slice(-N) 必炸，新 trimRawConversation 不炸');
{
  /* 攒一段真实形态的历史：8 轮，每轮 1 条 user + 1 条 assistant(2 个 tool) + 2 条 tool */
  const raw = [{ role: 'system', content: 'S' }];
  for (let r = 0; r < 8; r++) {
    raw.push({ role: 'user', content: `第 ${r + 1} 问` });
    raw.push({ role: 'assistant', content: null, tool_calls: [call(`r${r}a`), call(`r${r}b`)] });
    raw.push({ role: 'tool', tool_call_id: `r${r}a`, content: '{}' });
    raw.push({ role: 'tool', tool_call_id: `r${r}b`, content: '{}' });
  }
  ok(violations(raw).length === 0, '原始历史合法（前置自检）');

  const oldWay = raw.slice(-10);
  ok(violations(oldWay).length > 0, '旧 slice(-10) 确实破协议（这条就是线上 400 的源头）', violations(oldWay)[0]);

  const newWay = trimRawConversation(raw, 10);
  ok(violations(newWay).length === 0, '新 trimRawConversation 结果合法', violations(newWay).join(' / '));
  ok(newWay[0].role === 'system', '保留 system 在首位');
  ok(newWay[1].role === 'user', '紧跟 system 的第一条是完整轮次的起点（user）');
  /* 一轮 4 条（user / assistant(tool_calls) / tool / tool），预算 9 条只能装下 2 整轮 —— 
     断言「不超预算 + 装的是整数轮」；若断言「条数 ≥ 预算」是错的，会逼实现从中间切。 */
  ok(newWay.length <= 10, `不超过预算（实际 ${newWay.length} 条含 system）`);
  ok((newWay.length - 1) % 4 === 0, '保留的是整数个完整轮次，没有半轮', `实际正文 ${newWay.length - 1} 条`);
  ok(violations(sanitizeConversation(newWay)).length === 0, '再叠一层 sanitize 依然合法');

  /* 单轮就超预算：宁可超长也不能从中间切 */
  const oneHuge = [{ role: 'system', content: 'S' }, { role: 'user', content: '一次拉 20 个工具' },
    { role: 'assistant', content: null, tool_calls: Array.from({ length: 20 }, (_, i) => call(`h${i}`)) },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'tool', tool_call_id: `h${i}`, content: '{}' }))];
  const kept = trimRawConversation(oneHuge, 5);
  ok(violations(kept).length === 0, '单轮超预算时整轮保留，仍合法', violations(kept).join(' / '));
  ok(kept.length === oneHuge.length, '这一轮一条都没少');
}

/* ================= 6. 随机压力：任意坏输入，体检后必须合法 ================= */
console.log('\n6) 随机坏数据 300 组：体检后必须全部合法');
{
  const rnd = (n) => Math.floor(Math.random() * n);
  let bad = 0;
  for (let t = 0; t < 300; t++) {
    const n = 3 + rnd(40);
    const msgs = [];
    const ids = [];
    for (let i = 0; i < n; i++) {
      const k = rnd(4);
      if (k === 0) msgs.push({ role: 'user', content: `u${i}` });
      else if (k === 1) {
        const tc = Array.from({ length: 1 + rnd(3) }, (_, j) => call(`c${t}_${i}_${j}`));
        tc.forEach((c) => ids.push(c.id));
        msgs.push({ role: 'assistant', content: null, tool_calls: tc });
      } else if (k === 2) {
        /* 一半概率回执一个真 id，一半概率塞随机 id（孤儿） */
        const id = rnd(2) ? `c${t}_${rnd(n)}_${rnd(3)}` : ids.splice(rnd(Math.max(1, ids.length)), 1)[0];
        msgs.push({ role: 'tool', tool_call_id: id || `z${i}`, content: '{}' });
      } else msgs.push({ role: 'assistant', content: `a${i}` });
    }
    if (rnd(2)) msgs.unshift({ role: 'system', content: 'S' });
    const fixed = sanitizeConversation(msgs);
    const v = violations(fixed);
    if (v.length) { bad++; if (bad <= 2) console.log('     例:', JSON.stringify(msgs).slice(0, 200), '→', v[0]); }
  }
  ok(bad === 0, '300 组随机输入，体检后零违规', `${bad} 组违规`);
}

console.log(`\n=== 对话结构单测：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
