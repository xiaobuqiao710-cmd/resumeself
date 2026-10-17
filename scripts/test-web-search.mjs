/**
 * 联网搜索（web_search）回归测试
 * ------------------------------------------------------------------
 * 覆盖三件容易在改动中悄悄坏掉的事：
 *   ① 未配 Key 时**不能抛错、不能发请求** —— 要返回 ok:false 并指引到设置页；
 *   ② 配了 Key 时真的能搜到东西，且结果被压成模型好读的「结果[]」结构；
 *   ③ 本地工具经异步入口没被带坏（runTool 的同步行为必须原样保留）。
 *
 * 用法：
 *   BOCHA_KEY=sk-xxx npm run test:search
 * 不给 BOCHA_KEY 也能跑 —— 只跑不需要网络的断言（①③ 与提示词检查）。
 */
import { AGENT_TOOLS, AGENT_SYSTEM, buildAgentContext, runToolAsync, runTool } from '../src/lib/agent.ts';

const KEY = (process.env.BOCHA_KEY || '').trim();

/* Node 里没有 localStorage，按 ai.ts 的读取方式造一个最小实现 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' —— ' + extra : ''}`);
  if (!cond) fail++;
};

/* 最小可用的 host：buildAgentContext 只读这些字段 */
const noop = () => { throw new Error('不该被调用'); };
const host = {
  jobs: [{ id: 'j1', company: '某集团', title: '法律岗', status: 'new', deadline: '2026-10-20', track: 'soe' }],
  applications: [], events: [], questions: [], banks: [], bankCategories: [],
  interviews: [], offers: [], materials: [], contacts: [],
  profile: { single: { personal: {} }, multi: {} },
  addJob: noop, updateJob: noop, removeJob: noop, addApp: noop, setStatus: noop, removeApp: noop,
  addEvent: noop, setView: noop, addQuestion: noop, updateQuestion: noop, removeQuestion: noop,
  addBank: noop, addCategory: noop, addInterview: noop, addOffer: noop,
  setSingle: noop, updateMulti: noop, addMulti: noop, updateMaterial: noop, addContact: noop,
};

const cfg = (searchKey) => JSON.stringify({
  baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x', model: 'deepseek-chat', searchKey,
});

/* 用来数网络请求：断言「未配 Key 时零请求」
   在 Node ≥18 里 globalThis.fetch 可直接覆写 */
const realFetch = globalThis.fetch;
let fetched = 0;
globalThis.fetch = (...a) => { fetched++; return realFetch(...a); };

const spec = AGENT_TOOLS.find((t) => t.name === 'web_search');
ok('web_search 已注册进工具表', !!spec);
ok('web_search 的 query 是必填', !!spec && JSON.stringify(spec.parameters).includes('"required":["query"]'));
ok('web_search 不是危险操作（不该弹确认卡）', !!spec && !spec.destructive);
ok('web_search 声明了时效参数', !!spec && JSON.stringify(spec.parameters).includes('oneMonth'));

const sys = AGENT_SYSTEM;
ok('系统提示词点了 web_search 这个工具', /web_search/.test(sys));
ok('系统提示词明确「不要说我没有联网工具」', /没有联网工具/.test(sys));
ok('系统提示词要求附来源链接', /来源/.test(sys) && /链接/.test(sys));
ok('系统提示词禁止把个人信息带进搜索词', /个人信息/.test(sys));
ok('系统提示词提醒待遇信息仅供参考', /仅供参考/.test(sys));

/* ① 未配 Key */
store.set('qz.ai', JSON.stringify({ baseUrl: '', apiKey: '', model: '' }));
fetched = 0;
const r1 = await runToolAsync(host, 'web_search', { query: '某某交易所 待遇' });
ok('未配 Key 时返回 ok:false（而不是抛错）', r1.ok === false, r1.summary);
ok('未配 Key 的说明指向设置页', /设置/.test(r1.summary) && /联网搜索/.test(r1.summary));
ok('未配 Key 时零网络请求（不发空 Key 请求）', fetched === 0);
ok('未配 Key 时上下文如实告知不可用', /联网搜索：未配置/.test(buildAgentContext(host)));

/* ③ 本地工具不受影响 */
const r2 = await runToolAsync(host, 'site_stats', {});
ok('本地工具经异步入口仍正常', r2.ok === true, r2.summary);
const r3 = runTool(host, 'site_stats', {});
ok('同步 runTool 未被改动（向后兼容）', r3.ok === true && r3.summary === '已统计');
ok('未知工具仍走原来的兜底', runTool(host, 'nope', {}).ok === false);

/* ② 真联网（给了 Key 才跑） */
if (!KEY) {
  console.log('\n⚠️  未提供 BOCHA_KEY，已跳过真实联网断言。用法：BOCHA_KEY=sk-xxx npm run test:search');
} else {
  store.set('qz.ai', cfg(KEY));
  ok('配了 Key 时上下文告知可联网', /联网搜索：已配置/.test(buildAgentContext(host)));

  const r4 = await runToolAsync(host, 'web_search', { query: '国家开发银行 2027 校园招聘 公告', count: 3, freshness: 'oneMonth' });
  ok('联网搜索成功', r4.ok === true, r4.summary);
  const list = r4.result?.结果;
  ok('结果结构化成「结果[]」且带标题/网址',
    !!list?.length && !!list[0].标题 && /^https?:\/\//.test(list[0].网址),
    list?.[0]?.标题?.slice(0, 30));
  ok('单条摘要不超过 500 字（防上下文被撑爆）',
    !!list?.every((x) => !x.摘要 || x.摘要.length <= 500));

  const r5 = await runToolAsync(host, 'web_search', { query: '中债登 2027 校园招聘', count: 2 });
  ok('连续第二次检索仍可用（无状态残留）', r5.ok === true, r5.summary);

  store.set('qz.ai', cfg('sk-this-key-is-invalid'));
  const r6 = await runToolAsync(host, 'web_search', { query: 'test' });
  ok('错误 Key 走 ok:false 且带原因', r6.ok === false && /联网搜索失败/.test(r6.summary), r6.summary.split('\n')[0]);
}

console.log(fail ? `\n=== ${fail} 项未通过 ===` : '\n=== 全部通过 ===');
process.exit(fail ? 1 : 0);
