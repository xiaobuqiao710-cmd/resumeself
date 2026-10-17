import React from 'react';

/**
 * 轻量 Markdown 渲染 —— 零依赖。
 *
 * 为什么需要它：站内所有 AI 产出（题库参考答案、面试复盘、助手对话）都是模型直接吐的文本，
 * 模型习惯性会带 `**加粗**`、`# 标题`、`- 列表` 这些 Markdown 记号。如果当纯文本塞进
 * `whiteSpace: 'pre-wrap'` 的 div，用户看到的就是满屏 `**`，既难看也读不出层级。
 * 所以统一走这里渲染，而不是在每处调用点各写一遍替换。
 *
 * 覆盖范围刻意做小：**加粗** / `行内代码` / ### 小标题 / - 与 1. 列表 / 行首「答案：」标签。
 * 不做表格、链接、图片 —— 这些形态 AI 在站内没用过，加了只会增加误伤面积。
 */
const LABELS = [
  '答案', '解析', '理由', '依据', '结论', '考点', '考察点', '考法',
  '答题思路', '思路', '失分点', '易错点', '追问', '注意', '提示', '示例',
  '参考', '要点', '得分点', '法条',
].join('|');
/** 行首标签：`答案：xxx` —— 只认白名单，避免把正文里的任意冒号都加粗 */
const LABEL_RE = new RegExp(`^((?:${LABELS})\\s*[：:])\\s*(.*)$`);
/** 序号前缀：`1、` `1.` `(1)` `第 1 问：` —— 与后面的标签分开着色，序号本身不抢视线 */
const NO_RE = /^(\d{1,2}\s*[、.)）]\s*|第\s*\d{1,2}\s*[问题]\s*[：:]?\s*)/;

/** 行内记号：**加粗** 与 `行内代码` */
export function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<b key={`${keyBase}-b${i++}`}>{t.slice(2, -2)}</b>);
    else out.push(<code key={`${keyBase}-c${i++}`} className="mono" style={{ fontSize: '0.92em', padding: '1px 4px', borderRadius: 5, background: 'var(--glass-bg-strong)' }}>{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, className, style }:
  { text: string; className?: string; style?: React.CSSProperties }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let buf: { ordered: boolean; items: string[] } | null = null;
  let k = 0;
  const flush = () => {
    if (!buf) return;
    const items = buf.items;
    const ordered = buf.ordered;
    blocks.push(
      ordered
        ? <ol key={`l${k++}`} style={{ margin: '4px 0', paddingLeft: 20, lineHeight: 1.8 }}>{items.map((t, i) => <li key={i}>{renderInline(t, `o${k}-${i}`)}</li>)}</ol>
        : <ul key={`l${k++}`} style={{ margin: '4px 0', paddingLeft: 18, lineHeight: 1.8 }}>{items.map((t, i) => <li key={i} style={{ listStyle: 'disc' }}>{renderInline(t, `u${k}-${i}`)}</li>)}</ul>,
    );
    buf = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push(<div key={`h${k++}`} style={{ fontWeight: 700, fontSize: 13, margin: '6px 0 2px' }}>{renderInline(h[1], `h${k}`)}</div>);
      continue;
    }
    const ul = /^\s*[-*•·]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d+)[.、)）]\s+(.*)$/.exec(line);
    if (ul) { if (!buf || buf.ordered) { flush(); buf = { ordered: false, items: [] }; } buf.items.push(ul[1]); continue; }
    if (ol) { if (!buf || !buf.ordered) { flush(); buf = { ordered: true, items: [] }; } buf.items.push(ol[2]); continue; }
    flush();
    // 段落内再拆一层：`1、` 前缀 + 「答案：」标签单独加粗。
    // 目的是让「结论」和「理由」在视觉上分开，而不是整段糊成一片同色小字。
    const no = NO_RE.exec(line);
    const rest = no ? line.slice(no[1].length) : line;
    const lab = LABEL_RE.exec(rest);
    blocks.push(
      <div key={`p${k++}`} style={{ lineHeight: 1.85, margin: '3px 0' }}>
        {no && <span className="rt-no">{no[1]}</span>}
        {lab
          ? <><b className="rt-lab">{lab[1]}</b>{renderInline(lab[2], `p${k}`)}</>
          : renderInline(rest, `p${k}`)}
      </div>,
    );
  }
  flush();
  return <div className={className} style={style}>{blocks}</div>;
}
