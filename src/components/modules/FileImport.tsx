/**
 * 从本机文件导入：选文件 / 拖拽 → 自动判断每份文件属于全站哪个板块 → 预览样例行 → 勾选目标 → 落库。
 *
 * 与 JobsImportModal 的区别：那个只吃《秋招信息汇总》Markdown；
 * 这个吃桌面上任意 .md / .json / .csv / .ics，并且能同时写入多个板块
 * （岗位库 / 截止日历 / 笔面题库 / 资料库 / 简历版本 / 人脉 / 整站备份）。
 *
 * 判重放在 lib/fileImport.ts，落库全部走 store 的既有 add* 方法 ——
 * 这里只负责「把计划的统计念给用户听，用户点确认后才写」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { Badge, Button, Modal } from '../ui/Kit';
import { Icon } from '../ui/Icon';
import {
  buildImportPlan, planFile, planCount, summarize, TARGET_META,
  type FilePlan, type FileTarget, type ImportContext,
} from '../../lib/fileImport';
import type { CalEvent, Contact, JobPosting, MaterialItem, Question, ResumeVersion } from '../../types';

/** 目标板块的强调色，用于勾选芯片 */
const TONE: Partial<Record<FileTarget, string>> = {
  jobs: '#a78bfa', calendar: '#6ee7ff', questions: '#fcd34d',
  materials: '#6ee7b7', versions: '#f0abfc', contacts: '#93c5fd',
  profile: '#fda4af', backup: '#d8b4fe',
};

export function FileImportModal({ onClose }: { onClose: () => void }) {
  const {
    jobs, events, questions, materials, versions, contacts, profile, banks, bankCategories,
    addJobs, addEvents, addQuestions, importMaterials, addVersion, addContact,
    setSingle, addMulti, importMerge, toast,
  } = useStore();

  const [plans, setPlans] = useState<FilePlan[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 用户手动取消勾选的目标（默认全选） */
  const [off, setOff] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* 判重上下文：当前站内已有数据，解析时就地排除重复 */
  const ctx = useMemo<ImportContext>(() => ({
    jobs: jobs as Partial<JobPosting>[],
    events: events as Partial<CalEvent>[],
    questions: questions as Partial<Question>[],
    materials: materials as Partial<MaterialItem>[],
    versions: versions as Partial<ResumeVersion>[],
    contacts: contacts as Partial<Contact>[],
    profile,
    banks,
    bankCategories,
  }), [jobs, events, questions, materials, versions, contacts, profile, banks, bankCategories]);

  const plan = useMemo(() => buildImportPlan(plans, ctx), [plans, ctx]);
  const summary = useMemo(() => summarize(plan), [plan]);

  const accept = async (list: FileList | File[] | null) => {
    if (!list) return;
    const files = Array.from(list);
    if (!files.length) return;
    setBusy(true);
    try {
      const next: FilePlan[] = [];
      for (const f of files) next.push(await planFile(f, ctx));
      setPlans((prev) => [...prev, ...next]);
      const bad = next.filter((p) => p.error);
      if (bad.length) toast(`${bad.length} 份文件无法解析：${bad[0].error}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  /* 拖拽：整窗接收，和 JobsImportModal 一致（拖到任意位置都算） */
  useEffect(() => {
    const onOver = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
    const onLeave = (e: DragEvent) => { e.preventDefault(); setDragging(false); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); setDragging(false);
      void accept(e.dataTransfer?.files || null);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
    // 只在挂载时绑定一次；accept 内部只依赖 setState，无闭包陷阱
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (target: FileTarget) => {
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target); else next.add(target);
      return next;
    });
  };

  const active = summary.filter((s) => !off.has(s.target));
  const totalSelected = active.reduce((n, s) => n + s.count, 0);
  const picked = (t: FileTarget) => active.some((s) => s.target === t);

  const doImport = () => {
    if (!totalSelected) return;
    const report: string[] = [];

    /* ① 整站备份：交给 store 既有的合并逻辑（自带各板块判重） */
    if (picked('backup') && plan.payload.backup?.length) {
      const r = importMerge(JSON.stringify(plan.payload.backup[0]));
      if (r.ok) report.push(`整站备份合并 ${r.detail.length} 项`);
      else toast('整站备份导入失败，请检查文件格式', 'err');
    }

    /* ② 岗位库（addJobs 自带 sameCompanyStem + normTitle 判重） */
    const jlist = picked('jobs') ? (plan.payload.jobs || []) as Partial<JobPosting>[] : [];
    if (jlist.length) {
      const { added, updated } = addJobs(jlist);
      report.push(`岗位 +${added}${updated ? ` / 补充 ${updated}` : ''}`);
    }

    /* ③ 截止日历（addEvents 按 date|标题 去重） */
    const elist = picked('calendar') ? (plan.payload.calendar || []) as Partial<CalEvent>[] : [];
    if (elist.length) {
      const n = addEvents(elist.map((e) => ({ ...e, source: 'import' as const })));
      report.push(`日历 +${n}`);
    }

    /* ④ 笔面题库 */
    const qlist = picked('questions') ? (plan.payload.questions || []) as Partial<Question>[] : [];
    if (qlist.length) {
      const n = addQuestions(qlist.map((q) => ({
        kind: q.kind === 'interview' ? 'interview' as const : 'written' as const,
        category: String(q.category || '导入'),
        content: String(q.content || ''),
        answer: q.answer,
        company: q.company,
        year: q.year,
        difficulty: q.difficulty,
      })));
      report.push(`题库 +${n}`);
    }

    /* ⑤ 资料库材料 */
    const mlist = picked('materials') ? (plan.payload.materials || []) as Partial<MaterialItem>[] : [];
    if (mlist.length) {
      const n = importMaterials(mlist.map((m) => ({
        group: String(m.group || '其他'),
        name: String(m.name || ''),
        note: m.note,
        path: m.path,
        needScan: m.needScan,
      })));
      report.push(`材料 +${n}`);
    }

    /* ⑥ 简历版本（store 不判重，这里按 name 去重） */
    const vlist = picked('versions') ? (plan.payload.versions || []) as Partial<ResumeVersion>[] : [];
    if (vlist.length) {
      const seen = new Set(versions.map((v) => (v.name || '').trim()).filter(Boolean));
      let n = 0;
      for (const v of vlist) {
        const nm = String(v.name || '').trim();
        if (!nm || seen.has(nm)) continue;
        seen.add(nm);
        addVersion({
          name: nm, target: v.target, focus: v.focus,
          highlights: v.highlights, usedFor: v.usedFor, fileName: v.fileName,
        });
        n++;
      }
      if (n) report.push(`简历版本 +${n}`);
    }

    /* ⑦ 人脉（store 不判重，这里按 姓名|公司 去重） */
    const clist = picked('contacts') ? (plan.payload.contacts || []) as Partial<Contact>[] : [];
    if (clist.length) {
      const keyOf = (c: Partial<Contact>) =>
        `${(c.name || '').trim()}|${(c.company || '').trim()}`.toLowerCase();
      const seen = new Set(contacts.map(keyOf));
      let n = 0;
      for (const c of clist) {
        if (!String(c.name || '').trim()) continue;
        const k = keyOf(c);
        if (seen.has(k)) continue;
        seen.add(k);
        addContact({
          name: String(c.name), company: c.company, role: c.role, relation: c.relation,
          wechat: c.wechat, email: c.email, phone: c.phone,
          lastContact: c.lastContact, nextFollowUp: c.nextFollowUp,
          promised: c.promised, notes: c.notes,
        });
        n++;
      }
      if (n) report.push(`人脉 +${n}`);
    }

    /* ⑧ 资料库-个人信息（只填空缺，绝不覆盖已填内容 —— 与 importMerge 口径一致） */
    const plist = picked('profile') ? (plan.payload.profile || []) as Record<string, unknown>[] : [];
    if (plist.length) {
      let filled = 0;
      for (const item of plist) {
        for (const [section, rec] of Object.entries(item || {})) {
          if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
          for (const [k, v] of Object.entries(rec as Record<string, string>)) {
            if (!v) continue;
            if (profile.single[section]?.[k]) continue;   // 已填的保持不动
            setSingle(section, k, v);
            filled++;
          }
        }
        const edu = (item as { education?: unknown }).education;
        if (Array.isArray(edu)) {
          for (const row of edu as Record<string, string>[]) {
            if (!row || typeof row !== 'object') continue;
            const dup = profile.multi.education?.some(
              (x) => x.school === row.school && x.start === row.start,
            );
            if (dup) continue;
            addMulti('education', row);
            filled++;
          }
        }
      }
      if (filled) report.push(`资料库 +${filled} 项`);
    }

    if (report.length) toast(`导入完成：${report.join('，')}`, 'ok');
    else toast('没有可导入的内容', 'info');
    onClose();
  };

  const emptyBox = (on: boolean): React.CSSProperties => ({
    border: `1.5px dashed ${on ? 'var(--accent-3, #a78bfa)' : 'var(--glass-brd)'}`,
    borderRadius: 14, padding: '18px 16px', textAlign: 'center',
    background: on ? 'rgba(167,139,250,.10)' : 'rgba(0,0,0,.12)',
    transition: 'background .15s, border-color .15s',
  });

  return (
    <Modal
      open
      wide
      onClose={onClose}
      icon="upload"
      title="从本机文件导入"
      footer={
        <>
          <Button size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" icon="check" disabled={!totalSelected} onClick={doImport}>
            {totalSelected ? `确认导入 ${totalSelected} 条` : '确认导入'}
          </Button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          直接把桌面上的文件拖进来（或点下面的按钮选文件），会自动识别<b>这是什么内容、该进哪个板块</b>，
          解析后先给你看样例行，确认无误再写入。<b>文件不会上传</b>，全部在本机浏览器里解析。
        </div>

        <div
          className="col gap-6"
          style={{ ...emptyBox(dragging), alignItems: 'center', cursor: 'pointer' }}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragging(false);
            void accept(e.dataTransfer.files);
          }}
        >
          <Icon name="upload" size={22} />
          <div style={{ fontSize: 13, fontWeight: 640 }}>
            {busy ? '正在解析…' : dragging ? '松手即可解析' : '把文件拖到这里，或点击选择'}
          </div>
          <div className="tx-4" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            支持 .md 秋招汇总表 · .json 整站备份 / 题库 / 岗位数组 · .csv 表格 · .ics 日历
          </div>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            onChange={(e) => { void accept(e.target.files); e.target.value = ''; }}
          />
        </div>

        {!!plans.length && (
          <div className="col gap-8">
            <div className="h-sub">识别结果</div>
            {plans.map((f, i) => {
              const rejected = !!f.error || !f.targets.length;
              const open = expanded === `${i}`;
              return (
                <div className="glass card" key={`${f.name}-${i}`} style={{ padding: 12 }}>
                  <div className="row gap-8">
                    <Icon name={rejected ? 'alert' : 'doc'} size={15} />
                    <div className="grow">
                      <div className="truncate" title={f.name}>{f.name}</div>
                      <div className="tx-4" style={{ fontSize: 11, marginTop: 2 }}>
                        {f.error || f.kind}
                      </div>
                    </div>
                    {!rejected && <Badge tone="badge--ok">{planCount(f)} 条</Badge>}
                    {!rejected && (
                      <Button
                        size="sm" variant="ghost" icon="chevron"
                        onClick={() => setExpanded(open ? null : `${i}`)}
                        style={{ transform: open ? 'rotate(180deg)' : undefined }}
                      >
                        {open ? '收起' : '看明细'}
                      </Button>
                    )}
                  </div>

                  {open && (
                    <div className="col gap-10" style={{ marginTop: 10 }}>
                      {f.targets.map((t) => (
                        <div key={t.target}>
                          <div className="row gap-6">
                            <span
                              className="badge"
                              style={{ color: TONE[t.target], borderColor: 'var(--glass-brd)' }}
                            >
                              {TARGET_META[t.target].label}
                            </span>
                            <span className="tx-4" style={{ fontSize: 11 }}>
                              {t.count} 条 · {TARGET_META[t.target].hint}
                            </span>
                          </div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
                            <thead>
                              <tr className="tx-3">
                                {t.columns.map((c) => (
                                  <th key={c} style={{ textAlign: 'left', padding: '4px 8px' }}>{c}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {t.sample.map((row, ri) => (
                                <tr key={ri} style={{ borderTop: '1px solid var(--glass-brd)' }}>
                                  {row.map((cell, ci) => (
                                    <td key={ci} className="truncate" style={{ padding: '4px 8px', maxWidth: 220 }}>
                                      {cell || '—'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {t.count > t.sample.length && (
                            <div className="tx-4" style={{ fontSize: 11, marginTop: 3 }}>
                              …… 还有 {t.count - t.sample.length} 条
                            </div>
                          )}
                        </div>
                      ))}
                      {!!f.skipped.length && (
                        <details>
                          <summary className="tx-3" style={{ fontSize: 11.5, cursor: 'pointer' }}>
                            跳过了什么（{f.skipped.length} 条说明）
                          </summary>
                          <div className="col gap-4" style={{ marginTop: 6 }}>
                            {f.skipped.map((s, si) => (
                              <div className="tx-4" style={{ fontSize: 11.5 }} key={si}>· {s}</div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!!summary.length && (
          <div className="col gap-8">
            <div className="h-sub">导入到这些位置</div>
            <div className="tx-4" style={{ fontSize: 11.5 }}>点一下可取消勾选；已和站内数据去重，重复的不会重复写入。</div>
            <div className="row gap-8 wrap">
              {summary.map((s) => {
                const meta = TARGET_META[s.target];
                const on = !off.has(s.target);
                const tone = TONE[s.target] || 'var(--tx-2)';
                return (
                  <button
                    key={s.target}
                    type="button"
                    className="btn btn--sm"
                    onClick={() => toggle(s.target)}
                    title={meta.hint}
                    style={{
                      opacity: on ? 1 : .42,
                      borderColor: on ? tone : 'var(--glass-brd)',
                      color: on ? tone : 'var(--tx-3)',
                      cursor: 'pointer',
                    }}
                  >
                    <Icon name={on ? 'check' : 'x'} size={13} />
                    {meta.label} · {s.count}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!plans.length && (
          <details>
            <summary className="tx-3" style={{ fontSize: 12, cursor: 'pointer' }}>各类文件会被怎么处理？</summary>
            <div className="tx-3" style={{ fontSize: 12, lineHeight: 1.85, marginTop: 6 }}>
              · <b>《秋招信息汇总.md》</b> → 岗位库 + 截止日历（走的是和「批量导入秋招信息」同一套解析器，含单位明细表合并）<br />
              · <b>整站备份 .json</b>（本站「导出 JSON 备份」的产物）→ 按板块合并补齐，只填空缺不覆盖<br />
              · <b>题库 .json</b>（数组，元素含 content + kind）→ 笔面题库
              <span className="tx-3">（再写 <code>bank</code> 或 <code>bankId</code> 可指定归入哪个仓库，仓库名对不上就先落在「未归档」）</span><br />
              · <b>人脉 .csv</b>（表头含姓名 + 公司/微信/电话）→ 人脉<br />
              · <b>日历 .ics</b>（手机日历导出）→ 截止日历<br />
              · <b>其它 .csv</b>（表头含单位/公司/事项）→ 岗位库<br />
              识别不准时文件卡片里会写明原因，不会静默丢数据。
            </div>
          </details>
        )}
      </div>
    </Modal>
  );
}
