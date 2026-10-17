import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal } from '../ui/Kit';
import { copyText, download, downloadBlob } from '../../lib/util';
import { buildResumeDocx } from '../../lib/docx';
import { getMaterialBase, materialPath } from '../../data/materials';
import { PhotoSlot } from '../ui/Photo';
import { getPhoto } from '../../lib/photo';

// 材料根目录与材料清单都来自本机数据（localStorage），不写入代码、不随站点部署。
const matBase = getMaterialBase();
import { SECTION_MAP } from '../../data/formSchema';
import { FieldBlock, RecordCard } from './Database';
import { recKey } from '../../lib/merge';

/** 简历预览可编辑的板块（复用信息资料库的字段定义与编辑器） */
const EDIT_SECTIONS = ['personal', 'education', 'internship', 'project', 'practice', 'certificate', 'award', 'extra'] as const;

/**
 * 简历文件所在目录 —— 存本机 localStorage，绝不写进代码。
 *
 * 它是「这台电脑上的路径」：换设备毫无意义，也不属于账号数据，所以不进 Supabase。
 * 早期版本把它硬编码成作者本人的桌面路径，一旦站点面向所有人部署，
 * 每个访客的「复制路径」都会复制出一个陌生人电脑上的目录 —— 那既是隐私泄漏，也是功能失效。
 */
const LS_RESUME_DIR = 'qz.resumeDir';
function loadResumeDir(): string {
  try { return localStorage.getItem(LS_RESUME_DIR) || ''; } catch { return ''; }
}
function saveResumeDir(v: string) {
  try { localStorage.setItem(LS_RESUME_DIR, v.trim()); } catch { /* ignore */ }
}

function Block({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="row gap-8" style={{ marginBottom: 12 }}>
        <span className="acc__ico" style={{ width: 30, height: 30, borderRadius: 10 }}><Icon name={icon} size={16} /></span>
        <span className="h-sub">{title}</span>
        <span className="grow" style={{ height: 1, background: 'rgba(255,255,255,.1)' }} />
      </div>
      {children}
    </div>
  );
}

export default function Resume() {
  const { profile, toast, resumeText, setResumeText, setSingle, updateMulti, addMulti, removeMulti, materials } = useStore();

  /* 材料清单直接取本机数据（与「我的资料 → 材料清单」是同一份，不再有两处清单） */
  const matGroups = useMemo(() => {
    const m = new Map<string, typeof materials>();
    for (const it of materials) {
      const g = it.group || '其他';
      m.set(g, [...(m.get(g) || []), it]);
    }
    return Array.from(m.entries()).map(([title, items]) => ({ id: title, title, icon: 'award', items }));
  }, [materials]);
  const RESUME_FILES = useMemo(
    () => materials.filter((m) => (m.group || '').includes('简历')).map((m) => ({ name: m.name, note: m.note || '', size: '', path: m.path })),
    [materials],
  );
  const [tab, setTab] = useState<'preview' | 'files' | 'materials' | 'text'>('preview');
  const [resumeDir, setResumeDirState] = useState(loadResumeDir);
  const [editing, setEditing] = useState(false);
  const [editSec, setEditSec] = useState<string>('personal');
  const p = profile.single.personal || {};
  const edu = profile.multi.education || [];
  const intern = profile.multi.internship || [];
  const proj = profile.multi.project || [];
  const prac = profile.multi.practice || [];
  const certs = profile.multi.certificate || [];
  const awards = profile.multi.award || [];
  const extra = profile.single.extra || {};

  const markdown = useMemo(() => {
    const L: string[] = [];
    L.push(`# ${p.name || '我的简历'}`);
    L.push([p.phone, p.email, p.currentCity].filter(Boolean).join(' · '));
    L.push('');
    if (edu.length) { L.push('## 教育经历'); edu.forEach((e) => { L.push(`**${e.school}** · ${e.major}（${e.edu || ''}${e.degree ? '/' + e.degree : ''}） ${e.start || ''}~${e.end || ''}`); if (e.courses) L.push(`- 课程：${e.courses}`); if (e.gpa) L.push(`- 成绩：${e.gpa}`); if (e.majorDesc) L.push(`- ${e.majorDesc}`); L.push(''); }); }
    if (intern.length) { L.push('## 实习经历'); intern.forEach((e) => { L.push(`**${e.company}** · ${e.position} ${e.start || ''}~${e.end || ''}`); if (e.content) L.push(e.content.split('\n').map((x) => `- ${x}`).join('\n')); L.push(''); }); }
    if (proj.length) { L.push('## 项目经历'); proj.forEach((e) => { L.push(`**${e.name || '项目'}** ${e.start || ''}~${e.end || ''}`); /* 不要截断：导出内容必须与 Word/预览一致（原先 slice(0,200) 会把长描述从句子中间切断，
       用户在网申表单里粘贴的就是残缺版本） */
      if (e.desc) L.push(`- ${e.desc}`); if (e.duty) L.push(`- 职责：${e.duty}`); if (e.result) L.push(`- 成果：${e.result}`); L.push(''); }); }
    if (prac.length) { L.push('## 在校实践与职务'); prac.forEach((e) => { L.push(`**${e.title || e.name}** ${e.start || ''}~${e.end || ''}`); if (e.desc) L.push(`- ${e.desc}`); L.push(''); }); }
    /* 证书/获奖的字段要与 Word 导出一致（名称·颁发机构·日期·说明），
       否则「复制 MD」粘进网申表单会平白少一截信息 */
    if (certs.length) { L.push('## 技能证书'); certs.forEach((e) => L.push(`- ${e.name}${e.issuer ? '（' + e.issuer + '）' : ''}${e.date ? ' ' + e.date : ''}${e.desc ? '：' + e.desc : ''}`)); L.push(''); }
    if (awards.length) { L.push('## 获奖情况'); awards.forEach((e) => L.push(`- ${e.name}${e.level ? '（' + e.level + '）' : ''}${e.date ? ' ' + e.date : ''}${e.desc ? '：' + e.desc : ''}`)); L.push(''); }
    if (extra.selfEval) { L.push('## 自我评价'); L.push(extra.selfEval); }
    return L.join('\n');
  }, [p, edu, intern, proj, prac, certs, awards, extra]);

  const exportWord = async () => {
    try {
      const blob = await buildResumeDocx(profile, { photo: getPhoto() });
      downloadBlob(p.name ? `${p.name}-简历.docx` : '简历.docx', blob);
      toast('已根据个人档案导出 Word 简历');
    } catch (e) {
      toast('Word 生成失败：' + (e as Error).message, 'err');
    }
  };

  /* 编辑弹窗当前板块：复用资料库字段定义，改动实时写入 store（自动保存），预览/导出同步更新 */
  const sec = SECTION_MAP[editSec];
  const secRecs = sec?.multiple ? (profile.multi[sec.id] || []) : null;
  const secSingle = sec && !sec.multiple ? (profile.single[sec.id] || {}) : null;

  return (
    <div className="rise">
      <div className="section-head">
        <div>
          <div className="section-head__t">我的简历</div>
          <div className="section-head__d">与信息资料库实时同步 · 可直接编辑 · 可导出 Markdown / Word 用于快速投递</div>
        </div>
        <div className="row gap-8 wrap">
          <div className="segmented">
            {([['preview', '预览'], ['files', '简历文件'], ['materials', '证明材料'], ['text', '备注文本']] as const).map(([k, l]) => (
              <button key={k} className={`segmented__btn ${tab === k ? 'segmented__btn--active' : ''}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          <Button size="sm" icon="edit" onClick={() => setEditing(true)}>编辑简历</Button>
          <Button size="sm" icon="copy" onClick={async () => { if (await copyText(markdown)) toast('已复制 Markdown 简历'); }}>复制 MD</Button>
          <Button size="sm" icon="download" onClick={() => { const fn = p.name ? `${p.name}-简历.md` : '简历.md'; download(fn, markdown, 'text/markdown'); toast('已导出 Markdown'); }}>导出 MD</Button>
          <Button size="sm" variant="primary" icon="doc" onClick={exportWord}>导出 Word</Button>
        </div>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} wide icon="edit" title="编辑简历内容"
        footer={
          <>
            <span className="tx-3" style={{ fontSize: 12, marginRight: 'auto', alignSelf: 'center' }}>改动实时保存到本机浏览器，预览 / 导出 Word 同步更新</span>
            <Button variant="primary" size="sm" onClick={() => setEditing(false)}>完成</Button>
          </>
        }>
        <div className="col gap-14">
          <div className="segmented" style={{ flexWrap: 'wrap' }}>
            {EDIT_SECTIONS.map((id) => (
              <button key={id} className={`segmented__btn ${editSec === id ? 'segmented__btn--active' : ''}`}
                onClick={() => setEditSec(id)}>{SECTION_MAP[id].title}</button>
            ))}
          </div>
          {sec && secRecs && (
            <div>
              {secRecs.map((r, i) => (
                /* 稳定 key：用下标会在删除中间记录时复用组件实例，复制/AI 状态串到邻条 */
                <RecordCard key={`${recKey(sec.id, r)}#${i}`} section={sec} rec={r} idx={i}
                  onPatch={(patch) => updateMulti(sec.id, i, patch)}
                  onRemove={() => { removeMulti(sec.id, i); toast('已删除一条记录', 'info'); }}
                  onCopyRec={async () => {
                    const lines: string[] = [];
                    sec.fields.forEach((f) => { const v = r[f.key] || ''; if (String(v).trim()) lines.push(`${f.name}：${v}`); });
                    if (await copyText(lines.join('\n'))) toast('已复制本条记录');
                  }}
                  onToast={(m) => toast(m)} />
              ))}
              <Button icon="plus" onClick={() => { addMulti(sec.id); toast(`已新增一条「${sec.title}」`, 'info'); }}>添加{sec.title}</Button>
            </div>
          )}
          {sec && secSingle && (
            <div className="db-fields">
              {sec.fields.map((f) => (
                <FieldBlock key={f.key} def={f} value={secSingle[f.key] || ''}
                  onChange={(v) => setSingle(sec.id, f.key, v)}
                  onCopy={() => toast(`已复制「${f.name}」`)} />
              ))}
            </div>
          )}
        </div>
      </Modal>

      {tab === 'preview' && (
        <div className="glass card" style={{ maxWidth: 860, margin: '0 auto' }}>
          <div className="row gap-16" style={{ marginBottom: 22 }}>
            <PhotoSlot />
            <div>
              <div className="h-display" style={{ fontSize: 26 }}>{p.name || '请完善个人资料'}</div>
              <div className="row gap-12 wrap tx-2" style={{ fontSize: 13, marginTop: 6 }}>
                {p.phone && <span className="row gap-5"><Icon name="phone" size={13} /> {p.phone}</span>}
                {p.email && <span className="row gap-5"><Icon name="mail" size={13} /> {p.email}</span>}
                {p.currentCity && <span className="row gap-5"><Icon name="target" size={13} /> {p.currentCity}</span>}
              </div>
              <div className="row gap-6 wrap" style={{ marginTop: 8 }}>
                {p.highestEdu && <Badge tone="badge--accent">{p.highestEdu}</Badge>}
                {edu[0]?.school && <Badge tone="badge--info">{edu[0].school}</Badge>}
                {p.certificates && <Badge tone="badge--muted">{p.certificates}</Badge>}
                {p.englishLevel && <Badge tone="badge--muted">{p.englishLevel}</Badge>}
              </div>
            </div>
          </div>

          {edu.length > 0 && (
            <Block icon="edu" title="教育经历">
              {edu.map((e, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div className="row-between gap-10">
                    <span style={{ fontSize: 14.5, fontWeight: 680 }}>{e.school} · {e.major}</span>
                    <span className="tx-3 mono" style={{ fontSize: 12, flexShrink: 0 }}>{e.start} ~ {e.end}</span>
                  </div>
                  <div className="tx-3" style={{ fontSize: 12.5, marginTop: 2 }}>{[e.edu, e.degree, e.gpa ? 'GPA ' + e.gpa : null].filter(Boolean).join(' · ')}</div>
                  {e.courses && <div className="tx-2" style={{ fontSize: 13, marginTop: 5 }}>课程：{e.courses}</div>}
                  {e.majorDesc && <div className="tx-2" style={{ fontSize: 13, marginTop: 3 }}>{e.majorDesc}</div>}
                </div>
              ))}
            </Block>
          )}

          {intern.length > 0 && (
            <Block icon="intern" title="实习经历">
              {intern.map((e, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div className="row-between gap-10">
                    <span style={{ fontSize: 14.5, fontWeight: 680 }}>{e.company} · {e.position}</span>
                    <span className="tx-3 mono" style={{ fontSize: 12, flexShrink: 0 }}>{e.start} ~ {e.end}</span>
                  </div>
                  {e.content && <div className="tx-2" style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{e.content}</div>}
                </div>
              ))}
            </Block>
          )}

          {proj.length > 0 && (
            <Block icon="project" title="项目经历">
              {proj.map((e, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div className="row-between gap-10">
                    <span style={{ fontSize: 14.5, fontWeight: 680 }}>{e.name || '项目'}</span>
                    <span className="tx-3 mono" style={{ fontSize: 12, flexShrink: 0 }}>{e.start} ~ {e.end}</span>
                  </div>
                  {e.desc && <div className="tx-2" style={{ fontSize: 13, marginTop: 3, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{e.desc}</div>}
                  {e.duty && <div className="tx-2" style={{ fontSize: 13, marginTop: 2 }}>职责：{e.duty}</div>}
                  {e.result && <div className="tx-2" style={{ fontSize: 13, marginTop: 2 }}>成果：{e.result}</div>}
                </div>
              ))}
            </Block>
          )}

          {prac.length > 0 && (
            <Block icon="practice" title="在校实践与职务">
              {prac.map((e, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div className="row-between gap-10">
                    <span style={{ fontSize: 14, fontWeight: 640 }}>{e.title || e.name}</span>
                    <span className="tx-3 mono" style={{ fontSize: 12 }}>{e.start} ~ {e.end}</span>
                  </div>
                  {e.desc && <div className="tx-2" style={{ fontSize: 13, marginTop: 3 }}>{e.desc}</div>}
                </div>
              ))}
            </Block>
          )}

          {certs.length > 0 && (
            <Block icon="badge" title="技能证书">
              <div className="row gap-8 wrap">
                {certs.map((e, i) => <Badge key={i} tone="badge--muted">{e.name}{e.issuer ? ` · ${e.issuer}` : ''}</Badge>)}
              </div>
            </Block>
          )}

          {awards.length > 0 && (
            <Block icon="award" title="获奖情况">
              <div className="row gap-8 wrap">
                {awards.map((e, i) => <Badge key={i} tone="badge--accent">{e.name}{e.level ? ` · ${e.level}` : ''}</Badge>)}
              </div>
            </Block>
          )}

          {(extra.specialty || extra.hobbies || extra.selfEval || extra.careerGoal || extra.achievements) && (
            <Block icon="sparkles" title="附加信息">
              {extra.specialty && <div className="tx-2" style={{ fontSize: 13.5, lineHeight: 1.8, marginBottom: 8 }}><b>特长：</b>{extra.specialty}</div>}
              {extra.hobbies && <div className="tx-2" style={{ fontSize: 13.5, lineHeight: 1.8, marginBottom: 8 }}><b>兴趣爱好：</b>{extra.hobbies}</div>}
              {extra.selfEval && <div className="tx-2" style={{ fontSize: 13.5, lineHeight: 1.8, marginBottom: 8 }}><b>自我评价：</b>{extra.selfEval}</div>}
              {extra.careerGoal && <div className="tx-2" style={{ fontSize: 13.5, lineHeight: 1.8, marginBottom: 8 }}><b>职业目标与专长：</b>{extra.careerGoal}</div>}
              {extra.achievements && <div className="tx-2" style={{ fontSize: 13.5, lineHeight: 1.8, marginBottom: 8 }}><b>主要成绩：</b>{extra.achievements}</div>}
            </Block>
          )}
        </div>
      )}

      {tab === 'files' && (
        <div className="glass card" style={{ maxWidth: 720 }}>
          <div className="card__title" style={{ marginBottom: 6 }}><Icon name="resume" size={18} /> 本地简历文件</div>
          <div className="field" style={{ marginBottom: 14 }}>
            <label className="field__label">简历文件所在目录（本机路径）</label>
            <input className="input mono" value={resumeDir} placeholder="例如 /Users/你的用户名/Documents/简历"
              onChange={(e) => setResumeDirState(e.target.value)}
              onBlur={() => { saveResumeDir(resumeDir); toast('已保存简历目录'); }} />
            <div className="field__hint">
              浏览器读不到你电脑上的磁盘，这里只是把目录登记下来，网申时点「复制路径」直接粘贴即可。
              它只保存在这台设备的浏览器里，不会同步到云端账号 —— 换台电脑要重新填。
            </div>
          </div>
          <div className="col gap-6">
            {RESUME_FILES.map((f) => (
              <div className="list-row" key={f.name} style={{ padding: '11px 12px' }}>
                <span className="tile" style={{ width: 34, height: 34, borderRadius: 10 }}><Icon name="paper" size={16} /></span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={{ fontSize: 13.5, fontWeight: 620, display: 'block' }}>{f.name}</span>
                  <span className="tx-3" style={{ fontSize: 11.5 }}>{f.note} · {f.size}</span>
                </span>
                <Button size="sm" variant="ghost" icon="copy" onClick={async () => {
                  const p2 = f.path || (resumeDir ? `${resumeDir.replace(/\/+$/, '')}/${f.name}` : '');
                  if (!p2) { toast('请先在上面填写简历文件所在目录', 'err'); return; }
                  if (await copyText(p2)) toast('已复制文件路径');
                }}>复制路径</Button>
              </div>
            ))}
          </div>
          <div className="glass" style={{ padding: 12, borderRadius: 14, marginTop: 14 }}>
            <div className="tx-3" style={{ fontSize: 12, lineHeight: 1.7 }}>
              <Icon name="alert" size={13} /> 网申上传简历时，直接用上方 PDF 主版本；文件名建议规范为「姓名-简历-岗位.pdf」，单文件不超过 50MB。
            </div>
          </div>
        </div>
      )}

      {tab === 'materials' && (
        <div className="col gap-14" style={{ maxWidth: 860 }}>
          <div className="glass card" style={{ padding: 14 }}>
            <div className="row gap-8">
              <Icon name="paper" size={16} />
              <span className="tx-2" style={{ fontSize: 13, lineHeight: 1.7 }}>
                各类证明材料保存在你的电脑本地：<span className="mono">{matBase}</span>。网站仅登记清单与路径，网申上传时可直接复制路径取用。
              </span>
            </div>
          </div>
          {matGroups.map((g) => (
            <div className="glass card" key={g.id}>
              <div className="row gap-8" style={{ marginBottom: 12 }}>
                <span className="acc__ico" style={{ width: 28, height: 28, borderRadius: 9 }}><Icon name={g.icon} size={15} /></span>
                <span className="card__title">{g.title}</span>
                <Badge tone="badge--muted">{g.items.length} 份</Badge>
                <span className="grow" />
                <span className="tx-4" style={{ fontSize: 11 }}>
                  已备好 {g.items.filter((m) => m.done).length}/{g.items.length}
                </span>
              </div>
              <div className="col gap-6">
                {g.items.map((m) => (
                  <div className="list-row" key={m.id} style={{ padding: '10px 12px' }}>
                    <span className="tile" style={{ width: 32, height: 32, borderRadius: 9 }}><Icon name={m.done ? 'check' : g.icon} size={15} /></span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="truncate" style={{ fontSize: 13.5, fontWeight: 620, display: 'block' }}>{m.name}</span>
                      <span className="tx-3 truncate" style={{ display: 'block', fontSize: 11 }}>{m.path || materialPath({ id: m.group, title: m.group, icon: 'award', dir: '', hint: '', files: [] }, m.name)}</span>
                      {m.note && <span className="tx-4" style={{ fontSize: 11 }}>{m.note}</span>}
                    </span>
                    <Button size="sm" variant="ghost" icon="copy" onClick={async () => {
                      const path = m.path || materialPath({ id: m.group, title: m.group, icon: 'award', dir: '', hint: '', files: [] }, m.name);
                      if (await copyText(path)) toast('已复制文件路径');
                    }}>复制路径</Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {matGroups.length === 0 && (
            <div className="glass card">
              <div className="tx-3" style={{ fontSize: 13, lineHeight: 1.8 }}>
                这里显示的是「我的资料 → 材料清单」里登记的证件与证明。去那里（或导入本机资料恢复包）即可登记你的真实文件名与路径；
                网站不再内置任何个人材料名称。
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'text' && (
        <div className="glass card" style={{ maxWidth: 760 }}>
          <div className="card__title" style={{ marginBottom: 6 }}><Icon name="edit" size={18} /> 简历备注 / 自由文本</div>
          <div className="field__hint" style={{ marginBottom: 12 }}>可粘贴针对不同岗位定制的自我介绍、求职信片段或简历纯文本，随资料一起保存在本机浏览器。</div>
          <textarea className="textarea" style={{ minHeight: 260 }} value={resumeText || ''} placeholder="例如：投券商/金融岗时突出金融法方向与证券处罚案经验…"
            onChange={(e) => setResumeText(e.target.value)} />
          <div className="row gap-8" style={{ marginTop: 12 }}>
            <Button size="sm" icon="copy" onClick={async () => { if (await copyText(resumeText || '')) toast('已复制'); }}>复制</Button>
            <span className="tx-4" style={{ fontSize: 12 }}>{(resumeText || '').length} 字</span>
          </div>
        </div>
      )}
    </div>
  );
}
