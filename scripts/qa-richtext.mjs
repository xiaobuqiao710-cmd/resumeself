/**
 * 秋招助手 · 参考答案 / 助手回答的 Markdown 渲染回归。
 *
 * 为什么单独有这么一个检查：AI 吐出来的文本一定带 Markdown 记号（`**加粗**`、`# 标题`、
 * `1. 列表`）。渲染层一旦退回「纯文本 + pre-wrap」，页面上就会冒出一排排裸露的 `**`
 * —— 功能没坏、测试不会红，但用户第一眼就觉得难看。所以这里直接断言「输出里不许有裸记号」。
 *
 * 用法：node scripts/qa-richtext.mjs
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = resolve(root, 'node_modules/.tmp');
mkdirSync(tmpDir, { recursive: true });

/* 用 esbuild 打一个临时入口：把 RichText 渲染成静态 HTML 字符串 */
const entry = resolve(tmpDir, 'qa-richtext.entry.tsx');
writeFileSync(entry, `
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText } from '${resolve(root, 'src/components/ui/RichText').replace(/\\\\/g, '/')}';
export function render(text: string): string {
  return renderToStaticMarkup(<RichText text={text} />);
}
`);

const outfile = resolve(tmpDir, 'qa-richtext.bundle.cjs');
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  jsx: 'automatic',
  logLevel: 'error',
});
const { render } = await import(pathToFileURL(outfile).href);

/* 用例 1：就是用户截图里那种形态 —— 模型用 ** 把小问标题包起来 */
const ANSWER = `**1. 证监会"责令改正"的法律性质并阐述理由**

答案：责令改正属于行政命令（行政处理），不是行政处罚。

解析：责令改正是要求违法行为人履行法定义务、停止和纠正违法行为的行政命令。

**2. 证券交易所作出终止上市决定的法律性质界定并阐述理由**

答案：属于自律管理行为（自律监管措施），不是行政处罚。`;

/* 用例 2：提示词收紧后的形态 —— 没有 Markdown 记号，靠行首标签分层 */
const LABELED = `1、法律性质
答案：属于行政命令，不是行政处罚。
解析：目的在于恢复合法状态，不具有惩罚性。

2、终止上市决定
答案：属于自律管理行为。
解析：来源于会员让渡权利和法律授权。`;

/* 用例 3：助手对话里的标题 + 列表 */
const LISTS = `## 本周安排
- 10/12 工商银行线上笔试
- 10/20 建设银行一面

1. 先确认考场
2. 再打印准考证`;

const CASES = [
  { name: '参考答案（**加粗小问标题）', text: ANSWER, must: ['<b>', '责令改正'], mustNot: ['**'] },
  { name: '参考答案（行首标签分层）', text: LABELED, must: ['答案：</b>', '解析：</b>', 'rt-no'], mustNot: ['**'] },
  { name: '助手对话（标题 + 列表）', text: LISTS, must: ['<ul', '<ol', '<li'], mustNot: ['##', '- 10/12'] },
];

let failed = 0;
for (const c of CASES) {
  const html = render(c.text);
  const hits = c.must.filter((m) => html.includes(m));
  const bad = c.mustNot.filter((m) => html.includes(m));
  const ok = hits.length === c.must.length && bad.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${c.name}`);
  if (!ok) {
    if (hits.length !== c.must.length) console.log(`   缺少：${c.must.filter((m) => !hits.includes(m)).join(' , ')}`);
    if (bad.length) console.log(`   不该出现：${bad.join(' , ')}`);
    console.log(`   实际输出：${html.slice(0, 400)}`);
  }
}

/* 用例 4：源码里不该再有「把答案当纯文本 pre-wrap 直接打印」的写法 */
const bank = readFileSync(resolve(root, 'src/components/modules/Bank.tsx'), 'utf8');
const block = /function AnswerBlock[\s\S]*?\n}/.exec(bank)?.[0] || '';
if (block.includes('{item.answer}') && !block.includes('RichText')) {
  failed++;
  console.log('❌ AnswerBlock 又退回了直接打印 item.answer');
} else {
  console.log('✅ AnswerBlock 走 RichText 渲染');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
