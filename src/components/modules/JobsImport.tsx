import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal } from '../ui/Kit';
import { parseMarkdownDeadlines, parseMarkdownDetails, buildJobDraftsFromDoc, stripAutoCollected } from '../../lib/mdImport';
import { fmtDate, daysUntil, todayISO } from '../../lib/util';
import { TRACK_META } from '../../lib/mdImport';
import type { JobPosting } from '../../types';

/**
 * 「粘贴文档 → 批量入库」：把《秋招信息汇总》或每日追踪日报直接粘进来。
 *
 * 会同时解析两类表格：
 *   ① 截止日历表（截止日/单位/事项/入口）→ 截止日期与批次
 *   ② 单位明细表（单位/对象/岗位方向/网申期/入口/硬性要求/笔试）→ 招聘要求、岗位情况、考试内容、官网链接
 * 两者按单位合并成一条岗位，所以导入后每条都有链接、要求与笔试信息，而不是只有日期。
 */
export function JobsImportModal({ onClose, initialText, sourceLabel }:
  { onClose: () => void; initialText?: string; sourceLabel?: string }) {
  const { addJobs, addEvents, toast } = useStore();
  const [text, setText] = useState(initialText || '');
  const [onlyUpcoming, setOnlyUpcoming] = useState(false);
  const [withEvents, setWithEvents] = useState(true);
  const [expanded, setExpanded] = useState(false);
  /* 「🤖 自动抓取岗位」是机器按关键词搜来的原始线索（常含聚合站/公告转载），
     默认不收进岗位库；文件里仍然保留，需要时取消勾选即可一起导入。 */
  const [skipAuto, setSkipAuto] = useState(true);
  const [dragging, setDragging] = useState(false);

  const stripped = useMemo(() => stripAutoCollected(text), [text]);
  const body = skipAuto ? stripped.text : text;

  const doc = useMemo(() => {
    if (!body.trim()) return null;
    return { cal: parseMarkdownDeadlines(body), det: parseMarkdownDetails(body) };
  }, [body]);

  const parsed = useMemo(
    () => (doc ? buildJobDraftsFromDoc({ rows: doc.cal.rows, details: doc.det.details }) : { drafts: [], notes: [], rejected: [] }),
    [doc],
  );
  const allJobs = parsed.drafts as Partial<JobPosting>[];
  const notes = parsed.notes;
  const rejected = parsed.rejected;
  const jobs = useMemo(
    () => (onlyUpcoming ? allJobs.filter((j) => !j.deadline || (daysUntil(j.deadline) ?? 0) >= 0) : allJobs),
    [allJobs, onlyUpcoming],
  );

  const stats = useMemo(() => ({
    url: jobs.filter((j) => j.url).length,
    req: jobs.filter((j) => j.requirements).length,
    exam: jobs.filter((j) => j.exam).length,
    jd: jobs.filter((j) => j.jd).length,
    deadline: jobs.filter((j) => j.deadline).length,
  }), [jobs]);

  /* 价值分档分布。入库前就能看到「这批里几条是核心」，不必等切到列表页 ——
     这是「重要岗位做明显提示」在导入这一步的落点。口径见 lib/scoreRules.ts。 */
  const tiers = useMemo(() => {
    const n: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
    for (const j of jobs) { const t = j.match?.tier; if (t) n[t]++; }
    return n;
  }, [jobs]);

  const tierText = useMemo(() => {
    const parts = (['S', 'A', 'B', 'C'] as const).filter((t) => tiers[t]).map((t) => `${t} ${tiers[t]}`);
    return parts.length ? parts.join(' · ') : '';
  }, [tiers]);

  const doParse = () => {
    if (!doc) return;
    toast(`解析到 ${allJobs.length} 条岗位（截止日历 ${doc.cal.rows.length} 行 · 明细表 ${doc.det.details.length} 行）${notes.length ? `；另有 ${notes.length} 行是时间/批次说明，只写进日历` : ''}${rejected.length ? `；${rejected.length} 条按追踪口径排除` : ''}${tierText ? `；价值分档 ${tierText}` : ''}`);
  };

  const doImport = () => {
    const { added, updated } = addJobs(jobs);
    let ev = 0;
    if (withEvents && doc) ev = addEvents(
      doc.cal.rows
        .filter((r) => !onlyUpcoming || (daysUntil(r.deadline) ?? 0) >= 0)
        .map((r) => ({
          title: `截止 · ${r.company}${r.title && r.title !== '招聘' ? ' · ' + r.title : ''}`,
          date: r.deadline!,
          type: 'deadline' as const,
          note: [r.remain, r.note].filter(Boolean).join(' · ') || undefined,
          source: 'import' as const,
        })),
    );
    toast(`已导入：新增岗位 ${added} 条、更新 ${updated} 条${ev ? `、日历事件 ${ev} 条` : ''}`);
    onClose();
  };

  const readFile = (f: File) => {
    const r = new FileReader();
    r.onload = () => setText(String(r.result));
    r.readAsText(f);
  };

  const shown = jobs.slice(0, expanded ? jobs.length : 12);
  const rowsToShow = doc ? doc.cal.rows.filter((r) => !onlyUpcoming || (daysUntil(r.deadline) ?? 0) >= 0) : [];

  return (
    <Modal open onClose={onClose} icon="upload" title="批量导入（汇总表 / 日报）" wide
      footer={<>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" disabled={!jobs.length} onClick={doImport}>
          确认导入 {jobs.length} 条
        </Button>
      </>}>
      <div className="col gap-12">
        {sourceLabel && <div><Badge tone="badge--accent">{sourceLabel}</Badge></div>}

        <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          支持整份汇总文档：会自动解析「截止日历表」拿到<b>截止日期</b>，解析「单位明细表」拿到
          <b>招聘要求、岗位方向、笔试/考试内容、官网入口</b>，并按单位合并成一条。
        </div>

        <div className="row gap-8 wrap" style={{ alignItems: 'center' }}>
          <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
            <Icon name="doc" size={14} /> 选择文件
            {/* 不限制 accept：部分浏览器（尤其 Safari）会因为 .md 的类型标识不匹配而把文件变灰选不中 */}
            <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
          </label>
          <Button size="sm" icon="copy" onClick={async () => {
            try { const t = await navigator.clipboard.readText(); if (t) { setText(t); toast('已粘贴剪贴板内容'); } }
            catch { toast('浏览器未授权读取剪贴板，请手动 ⌘V 粘贴', 'err'); }
          }}>读取剪贴板</Button>
          <Button size="sm" icon="sparkles" disabled={!text.trim()} onClick={doParse}>先解析看看</Button>
        </div>

        {/* 拖拽兜底：选不中文件时直接把 .md 拖进来 */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) readFile(f); else toast('没读到文件，请把 .md 文件拖到框里', 'err');
          }}
          style={{
            border: `1.5px dashed ${dragging ? 'var(--accent-3, #a78bfa)' : 'var(--glass-brd)'}`,
            borderRadius: 14, padding: '10px 12px', fontSize: 12, textAlign: 'center',
            color: 'var(--tx-3)', background: dragging ? 'rgba(167,139,250,.08)' : undefined,
          }}>
          也可以把《秋招信息汇总.md》直接拖到这里
        </div>

        <textarea className="textarea mono" style={{ minHeight: 180, fontSize: 12.5 }} value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'直接粘贴《秋招信息汇总》全文或日报段落…\n\n| 截止日 | 剩余 | 单位 | 事项 | 入口 |\n| 9/15（二） | 4 天 | 深圳国际仲裁院 | 仲裁业务法律顾问 | hr@scia.com.cn |\n\n| 银行 | 对象 | 岗位方向与地点 | 网申期 | 入口 | 硬性要求 | 笔试 |\n| 建设银行 | 2026.1-2027.7 毕业 | 管理培训生-法律合规方向 | 9/4-10/8 | job.ccb.com | 六级 425+ | 10 月底线下机考 |'} />

        {text.trim() && doc && jobs.length === 0 && (
          <div className="glass card" style={{ padding: 14, borderColor: 'rgba(251,191,36,.4)' }}>
            <div className="row gap-8" style={{ fontSize: 13, fontWeight: 640 }}>
              <Icon name="alert" size={16} /> 没解析出岗位
            </div>
            <div className="tx-3" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.75 }}>
              可能的原因：① 选到的不是《秋招信息汇总.md》或日报（例如选成了 .ics / .json / 简历 PDF）；
              ② 文件里没有「截止日 | 单位 | 事项」这类表格；③ 内容被截断了。<br />
              当前读到 <b>{text.length}</b> 个字符{stripped.found ? `（已跳过自动抓取区块 ${stripped.removedLines} 行）` : ''}——
              可以往下翻看文本框里的内容对不对，或用「读取剪贴板」把全文粘进来。
            </div>
          </div>
        )}

        {jobs.length > 0 && (
          <>
            <div className="row gap-8 wrap">
              <Badge tone="badge--ok">解析出 {jobs.length} 条岗位</Badge>
              <Badge tone="badge--info">带官网 {stats.url}</Badge>
              <Badge tone="badge--info">带招聘要求 {stats.req}</Badge>
              <Badge tone="badge--info">带笔试信息 {stats.exam}</Badge>
              <Badge tone="badge--muted">带截止日 {stats.deadline}</Badge>
              {doc && doc.cal.skipped.length > 0 && <Badge tone="badge--warn">模糊日期跳过 {doc.cal.skipped.length} 行</Badge>}
              {notes.length > 0 && <Badge tone="badge--muted">时间/批次说明 {notes.length} 行（只进日历）</Badge>}
              {rejected.length > 0 && <Badge tone="badge--warn">按追踪口径排除 {rejected.length} 条</Badge>}
              {tiers.S > 0 && <Badge tone="badge--danger">S 核心目标 {tiers.S}</Badge>}
              {tiers.A > 0 && <Badge tone="badge--warn">A 重点 {tiers.A}</Badge>}
              {tiers.B > 0 && <Badge tone="badge--info">B 常规 {tiers.B}</Badge>}
              {tiers.C > 0 && <Badge tone="badge--muted">C 低优先 {tiers.C}</Badge>}
              {skipAuto && stripped.found && <Badge tone="badge--muted">已跳过自动抓取区块 {stripped.removedLines} 行</Badge>}
            </div>

            {rejected.length > 0 && (
              <details style={{ fontSize: 12.5 }}>
                <summary style={{ cursor: 'pointer', opacity: 0.85 }}>
                  这 {rejected.length} 条按<b>追踪口径</b>排除（律所与涉外/外资所 · 目标地域外的地方国企 · 非大厂/优质科创的民营 · 民营非法律岗）
                  —— 不进岗位库，口径定义在 <code>lib/trackRules.ts</code>
                </summary>
                <div className="col gap-4" style={{ marginTop: 8, maxHeight: 180, overflow: 'auto' }}>
                  {rejected.map((r, i) => (
                    <div key={i} className="muted" style={{ fontSize: 12 }}>
                      {r.company} · 「{r.title}」 → {r.label}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {notes.length > 0 && (
              <details style={{ fontSize: 12.5 }}>
                <summary style={{ cursor: 'pointer', opacity: 0.85 }}>
                  这 {notes.length} 行是「时间/批次说明」而非岗位（如「至 24:00」「参照上年 10-11 月」）——
                  不进岗位库，但仍会写成日历事件，截止信息不丢
                </summary>
                <div className="col gap-4" style={{ marginTop: 8, maxHeight: 180, overflow: 'auto' }}>
                  {notes.map((n, i) => (
                    <div key={i} className="muted" style={{ fontSize: 12 }}>
                      {n.company} · 「{n.title}」{n.deadline ? ` · ${n.deadline}` : ''}
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="row gap-16 wrap">
              <label className="row gap-6" style={{ fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={onlyUpcoming} onChange={(e) => setOnlyUpcoming(e.target.checked)} /> 只导入未截止的
              </label>
              <label className="row gap-6" style={{ fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={withEvents} onChange={(e) => setWithEvents(e.target.checked)} /> 同时写入日历（{rowsToShow.length} 条）
              </label>
              {stripped.found && (
                <label className="row gap-6" style={{ fontSize: 12.5, cursor: 'pointer' }}
                  title="这一段是机器按关键词抓来的原始线索（常含聚合站、公告转载），默认留在文件里但不导入">
                  <input type="checkbox" checked={skipAuto} onChange={(e) => setSkipAuto(e.target.checked)} /> 跳过「🤖 自动抓取岗位」区块
                </label>
              )}
            </div>

            <div style={{ maxHeight: 340, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--tx-3)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>单位 / 岗位</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>截止</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>招聘要求</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>笔试 / 考试</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>入口</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((j, i) => {
                    const d = daysUntil(j.deadline);
                    return (
                      <tr key={i} style={{ borderTop: '1px solid var(--glass-brd)' }}>
                        <td style={{ padding: '6px 8px' }}>
                          <b>{j.company}</b>
                          <span className="tx-4" style={{ display: 'block', fontSize: 11 }}>{j.title}</span>
                        </td>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                          {j.deadline
                            ? <><span>{fmtDate(j.deadline)}</span>
                              <span className="badge badge--muted" style={{ marginLeft: 4 }}>
                                {d === 0 ? '今天' : d !== null && d > 0 ? `${d} 天` : '已过'}
                              </span></>
                            : <span className="tx-4">—</span>}
                        </td>
                        <td style={{ padding: '6px 8px', maxWidth: 200 }} className="clamp-2">{j.requirements || <span className="tx-4">—</span>}</td>
                        <td style={{ padding: '6px 8px', maxWidth: 180 }} className="clamp-2">{j.exam || <span className="tx-4">—</span>}</td>
                        <td style={{ padding: '6px 8px', maxWidth: 150 }}>
                          {j.url
                            ? <a href={j.url} target="_blank" rel="noreferrer" className="tx-3 truncate" style={{ display: 'block' }}>{j.url.replace(/^https?:\/\//, '').slice(0, 26)}</a>
                            : <span className="tx-4">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {jobs.length > shown.length && (
                <button className="copy-btn" style={{ marginTop: 8 }} onClick={() => setExpanded(true)}>
                  还有 {jobs.length - shown.length} 条，点此展开 ▾
                </button>
              )}
            </div>
            {doc && doc.cal.skipped.length > 0 && (
              <details>
                <summary className="tx-3" style={{ fontSize: 12, cursor: 'pointer' }}>被跳过的 {doc.cal.skipped.length} 行（日期不明确，如「10 月中旬」）</summary>
                <div className="tx-4 mono" style={{ fontSize: 11, marginTop: 6, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {doc.cal.skipped.join('\n')}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
