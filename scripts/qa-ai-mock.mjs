/**
 * 秋招助手 · AI 接口 mock（OpenAI 兼容），仅供 scripts/qa-e2e.mjs 的 ai 场景做端到端验证。
 *
 * 用法：node scripts/qa-ai-mock.mjs [port]     默认 8799
 * 站点侧把「设置 → AI 助手」的 Base URL 指向 http://127.0.0.1:8799/v1 即可。
 *
 * 按系统提示词路由到不同的假响应，覆盖：连接测试 / 邮件状态识别 / JD 多岗位解析 /
 * 简历匹配度 / 公司背景 / 通用写作 / 带工具的 Agent 对话（先回 tool_call，再回文本）。
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8799);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
};

/** 包装成 OpenAI chat.completions 的响应 */
const reply = (content, toolCalls) => ({
  id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'mock-model',
  choices: [{
    index: 0, finish_reason: toolCalls ? 'tool_calls' : 'stop',
    message: toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});

/** 邮件 → 投递状态更新（模拟 AI 识别结果） */
const SYNC_UPDATES = [
  { company: '中国工商银行总行本部', position: '总行管理培训生', status: 'test', date: '2026-10-12', note: '笔试通知：10/12 线上测评', mailSubject: '【笔试通知】中国工商银行 2027 校园招聘' },
  { company: '中国建设银行', position: '法律合规', status: 'interview', date: '2026-10-20', note: '一面邀约', mailSubject: '面试邀请 - 中国建设银行' },
  { company: '某某订阅推广公司', position: '', status: 'reject', note: '无关邮件（应被过滤）', mailSubject: '限时优惠' },
];

const JOB_PARSE = [
  { company: '中金公司', title: '法律合规岗', city: '北京', salary: '25w', requirements: '法学硕士，通过法考', deadline: '2026-10-30', source: '官网', url: 'https://example.com/cicc', jd: '负责合规审查与监管沟通' },
  { company: '国家开发银行', title: '总行管理培训生', city: '北京', salary: '', requirements: '硕士及以上，六级', deadline: '2026-10-07', source: '官网', url: '', jd: '总行管培生项目' },
];

const COMPANY_INFO = {
  industry: '证券', scale: '约 1 万人', hq: '北京', business: '投资银行、股票业务、固定收益等（mock）',
  process: '网申 → 笔试 → 两轮面试（mock）', notes: '建议尽早投递（mock）',
};

const log = [];

/* ---- 协议严格校验（故意比真服务商更严）--------------------------------
 * OpenAI 兼容协议对 tool 消息有两条硬约束，破任意一条真服务商就回 400：
 *   ① assistant(tool_calls) 后面必须逐条跟上对应 id 的 tool 消息；
 *   ② 任何 tool 消息前面必须有声明它 id 的 assistant。
 * DeepSeek 对第 ② 条的原话是
 *   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
 * —— agentconv 场景就是拿它当裁判的，这里照抄这句话。
 *
 * ⚠️ 不加这段校验会怎样：mock 什么都收，agentconv 场景在**旧代码上也是绿的**，
 *    回归价值归零。「侧边栏聊着聊着突然 400」当初能漏到线上，正是因为所有 mock
 *    都无条件接受任何对话结构。
 */
function protocolError(msgs) {
  const need = (i) => `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id' (request_id: qa-mock-${i})`;
  let pending = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] || {};
    if (m.role === 'tool') {
      const at = m.tool_call_id ? pending.indexOf(m.tool_call_id) : -1;
      if (at < 0) return `Messages with role 'tool' must be a response to a preceding message with 'tool_calls' (request_id: qa-mock-${i})`;
      pending.splice(at, 1);
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (pending.length) return need(i);
      pending = m.tool_calls.map((c) => c && c.id).filter(Boolean);
    } else {
      if (pending.length) return need(i);
      pending = [];
    }
  }
  return pending.length ? need('end') : null;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (!req.url.startsWith('/v1/chat/completions')) { json(res, 404, { error: { message: 'not found' } }); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* ignore */ }
    const msgs = payload.messages || [];
    const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
    const user = String((msgs.filter((m) => m.role === 'user').pop() || {}).content || '');
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const toolMsgs = msgs.filter((m) => m.role === 'tool');

    let kind = 'agent-text';
    if (sys.includes('连接测试助手')) kind = 'conn';
    else if (sys.includes('状态识别助手')) kind = 'sync';
    else if (sys.includes('独立岗位')) kind = 'jobs';
    else if (sys.includes('校招顾问')) kind = 'match';
    else if (sys.includes('求职信息研究员')) kind = 'company';
    else if (sys.includes('秋招求职写作助手')) kind = 'write';
    else if (hasTools) kind = toolMsgs.length ? 'agent-text' : 'agent-tool';

    /* 结构不合法一律 400，并且在 stdout 留痕 —— 场景里看到这行就说明被测代码没修好 */
    const proto = protocolError(msgs);
    if (proto) {
      log.push({ kind: 'PROTOCOL-400', detail: proto.slice(0, 60) });
      process.stdout.write(`[ai-mock] 拒绝非法对话结构: ${proto}\n`);
      return json(res, 400, { error: { message: proto } });
    }

    log.push({ kind, tools: hasTools, auth: (req.headers.authorization || '').slice(0, 12) });

    /* ---- 脚本化 Agent 流程 ------------------------------------------------
       供 qa-e2e.mjs 的 agenttools 场景验证两件「原 ai 场景没覆盖」的事：
         A. 写入类工具真的改了站内数据（不是只回一段好听的话）；
         B. 危险工具真的会拦一道 —— 用户取消时数据纹丝不动，确认后才真删。
       触发方式：用户在助手输入框里发一条带 E2E-XXX 标记的消息。同一段内按
       「已经回灌了几条 tool 消息」判断这是第几轮，从而先回 tool_calls、再回收尾文本。 */
    const mark = (user.match(/E2E-[A-Z]+/) || [])[0];
    if (mark && hasTools) {
      const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const round = toolMsgs.length;
      const SCRIPTED = {
        /* 读 + 写 + 切页放在同一批：一次循环里同时验证「检索」与「执行」都真的落地 */
        'E2E-WRITE': [
          [
            tc('call_w1', 'search_jobs', { query: '中金' }),
            tc('call_w2', 'add_job', { company: 'E2E测试单位', title: '端到端测试岗', city: '北京', deadline: '2027-03-01' }),
            tc('call_w3', 'navigate', { view: 'jobs' }),
          ],
          '已完成：检索了站内岗位，新增「E2E测试单位 · 端到端测试岗」，并切到了岗位库。',
        ],
        /* 危险工具 + 用户点「取消」→ 数据必须原样不动 */
        'E2E-DELCANCEL': [
          [tc('call_d1', 'delete_job', { company: 'E2E测试单位' })],
          '好，已取消，没有做任何改动。',
        ],
        /* 危险工具 + 用户点「确认删除」→ 数据必须真的少一条 */
        'E2E-DELOK': [
          [tc('call_d1', 'delete_job', { company: 'E2E测试单位' })],
          '已删除「E2E测试单位」。',
        ],
      }[mark];
      if (SCRIPTED) {
        log.push({ kind: 'script:' + mark, tools: hasTools, round, toolMsgs: round });
        const step = SCRIPTED[Math.min(round, SCRIPTED.length - 1)];
        process.stdout.write(`[ai-mock] ${mark} round=${round} -> ${typeof step === 'string' ? 'text' : 'tool_calls'}\n`);
        return json(res, 200, typeof step === 'string' ? reply(step) : reply(null, step));
      }
    }

    switch (kind) {
      case 'conn': return json(res, 200, reply('连接正常'));
      case 'sync': return json(res, 200, reply('```json\n' + JSON.stringify(SYNC_UPDATES) + '\n```'));
      case 'jobs': return json(res, 200, reply(JSON.stringify(JOB_PARSE)));
      case 'match': return json(res, 200, reply(JSON.stringify({ score: 86, highlights: '法学硕士对口；有非诉实习经历；已过法考', gaps: '缺少券商合规实习', advice: '建议突出尽调与监管沟通经验，尽快投递' })));
      case 'company': return json(res, 200, reply(JSON.stringify(COMPANY_INFO)));
      case 'write': return json(res, 200, reply('这是 mock 生成的正文内容。'));
      case 'agent-tool':
        return json(res, 200, reply(null, [{
          id: 'call_mock_1', type: 'function',
          function: { name: 'site_stats', arguments: '{}' },
        }]));
      default:
        if (user.includes('模拟 500')) return json(res, 500, { error: { message: 'mock server error' } });
        return json(res, 200, reply('（mock 助手）我已查阅站内数据：当前共有若干条投递与岗位记录，详情见各板块。'));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ai-mock] listening on http://127.0.0.1:${PORT}/v1`);
});

process.on('SIGTERM', () => { console.log('[ai-mock] 收到请求统计:', JSON.stringify(log)); server.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('[ai-mock] 收到请求统计:', JSON.stringify(log)); server.close(); process.exit(0); });
