import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Badge, Empty, Modal, Progress } from '../ui/Kit';
import { copyText, download, cn, todayISO } from '../../lib/util';
import { getMaterialBase, setMaterialBase, DEFAULT_MATERIAL_GROUPS } from '../../data/materials';
import { toMarkdownTable } from '../../lib/exporters';
import type { MaterialItem } from '../../types';

/** 材料清单：网申/背调/体检/三方各要什么，哪些已备好、哪些还得去开，一屏看清 */
export default function Checklist() {
  const { materials, addMaterial, updateMaterial, removeMaterial, importMaterials, toast } = useStore();
  const [editing, setEditing] = useState<Partial<MaterialItem> | null>(null);
  const [base, setBase] = useState(getMaterialBase());
  const [showBase, setShowBase] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<string, MaterialItem[]>();
    for (const it of materials) {
      const g = it.group || '其他';
      m.set(g, [...(m.get(g) || []), it]);
    }
    if (!m.size) m.set('未分组', []);
    return Array.from(m.entries());
  }, [materials]);

  const doneN = materials.filter((m) => m.done).length;
  const pct = materials.length ? Math.round((doneN / materials.length) * 100) : 0;

  const save = () => {
    if (!editing?.name?.trim()) { toast('请填写材料名称', 'err'); return; }
    if (editing.id) { updateMaterial(editing.id, editing); toast('已更新'); }
    else { addMaterial(editing); toast('已添加材料'); }
    setEditing(null);
  };
  const set = (k: keyof MaterialItem, v: unknown) => setEditing((e) => ({ ...(e || {}), [k]: v } as Partial<MaterialItem>));

  const seedFromTemplate = () => {
    const items: Partial<MaterialItem>[] = [];
    for (const g of DEFAULT_MATERIAL_GROUPS) {
      for (const f of g.files) items.push({ group: g.title, name: f.name, note: f.note, path: base ? `${base}/${g.dir ? g.dir + '/' : ''}${f.name}` : undefined });
    }
    const n = importMaterials(items);
    toast(`已导入 ${n} 条模板材料，可逐条改成你本机的真实文件名`);
  };

  const fullPath = (m: MaterialItem) => m.path || (base ? `${base}/${m.name}` : m.name);

  if (!materials.length) {
    return (
      <>
        <Empty icon="award" title="材料清单还是空的"
          desc="网申阶段最费时间的不是填表，而是「找材料」。把证件照、身份证、成绩单、学历验证报告等的本机路径登记好，网申时一键复制路径即可取用。"
          action={<>
            <Button variant="primary" icon="upload" onClick={seedFromTemplate}>导入模板清单</Button>
            <Button icon="plus" onClick={() => setEditing({ group: '证件', name: '', done: false })}>手动添加</Button>
          </>} />
        {editing && <MaterialForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} groups={['证件', '证明', '学历学位', '成绩', '其他']} />}
      </>
    );
  }

  return (
    <div className="rise col gap-16">
      <div className="glass card">
        <div className="card__head">
          <div className="card__title"><Icon name="award" size={18} /> 材料就绪度 {doneN}/{materials.length}</div>
          <div className="row gap-8">
            <Button size="sm" icon="settings" onClick={() => setShowBase(true)}>材料根目录</Button>
            <Button size="sm" icon="doc" onClick={() => {
              const md = '# 网申材料清单\n\n' + toMarkdownTable(['分组', '材料', '状态', '路径', '备注'],
                materials.map((m) => [m.group, m.name, m.done ? '✅' : '⬜', fullPath(m), m.note || '']));
              download(`材料清单-${todayISO()}.md`, md, 'text/markdown');
              toast('已导出清单');
            }}>导出</Button>
            <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ group: groups[0][0], name: '', done: false })}>添加材料</Button>
          </div>
        </div>
        <Progress value={pct} />
        <div className="tx-3" style={{ fontSize: 12, marginTop: 8 }}>
          当前材料根目录：<span className="mono">{base || '（未设置，将只显示文件名）'}</span>
        </div>
      </div>

      {groups.map(([g, items]) => {
        const d = items.filter((i) => i.done).length;
        return (
          <div className="glass card" key={g}>
            <div className="card__head">
              <div className="card__title"><Icon name="layers" size={17} /> {g}
                <span className="badge badge--muted" style={{ marginLeft: 8 }}>{d}/{items.length}</span>
              </div>
            </div>
            <div className="col gap-6">
              {items.map((m) => (
                <div className="list-row" key={m.id} style={{ padding: '10px 12px' }}>
                  <button className={cn('todo-check', m.done && 'todo-check--done')}
                    onClick={() => updateMaterial(m.id, { done: !m.done })} aria-label="切换完成">
                    {m.done && <Icon name="check" size={12} strokeWidth={3} />}
                  </button>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className={cn('truncate', m.done && 'todo-done-text')} style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{m.name}</span>
                    <span className="tx-4 truncate mono" style={{ display: 'block', fontSize: 10.5, marginTop: 2 }}>{fullPath(m)}</span>
                    {m.note && <span className="tx-3" style={{ fontSize: 11.5 }}>{m.note}</span>}
                  </span>
                  <div className="row gap-4">
                    <Button size="sm" variant="ghost" icon="copy" aria-label="复制路径"
                      onClick={async () => { if (await copyText(fullPath(m))) toast('已复制路径'); }} />
                    <Button size="sm" variant="ghost" icon="edit" aria-label="编辑" onClick={() => setEditing(m)} />
                    <Button size="sm" variant="ghost" icon="trash" aria-label="删除"
                      onClick={() => { if (confirm(`删除「${m.name}」？`)) { removeMaterial(m.id); toast('已删除', 'info'); } }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="glass card">
        <div className="row gap-10 wrap">
          <Badge tone="badge--muted">提示</Badge>
          <span className="tx-3" style={{ fontSize: 12.5 }}>
            很多单位网申要求「材料打包上传」，建议按「证件 / 证明 / 学历 / 成绩」建子目录；照片与扫描件别放进网站代码，
            本站不再打包任何个人图片（证件照只存你浏览器，见「我的简历」上传位）。
          </span>
          <Button size="sm" icon="upload" onClick={seedFromTemplate}>再导入一份模板</Button>
        </div>
      </div>

      {editing && <MaterialForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} groups={Array.from(new Set([...groups.map((g) => g[0]), '证件', '证明', '学历学位', '成绩', '其他']))} />}

      <Modal open={showBase} onClose={() => setShowBase(false)} icon="settings" title="材料根目录"
        footer={<><Button onClick={() => setShowBase(false)}>取消</Button>
          <Button variant="primary" icon="check" onClick={() => { setMaterialBase(base); toast('已保存材料根目录'); setShowBase(false); }}>保存</Button></>}>
        <div className="field">
          <label className="field__label">本机材料根目录</label>
          <input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="/Users/你的用户名/Desktop/个人资料" />
          <div className="field__hint">
            填你本机存放材料的文件夹绝对路径（只存在本机浏览器，不会上传）。填了之后「复制路径」会拼成完整路径，可直接粘到访达/资源管理器打开。
          </div>
        </div>
      </Modal>
    </div>
  );
}

function MaterialForm({ editing, set, onSave, onClose, groups }:
  { editing: Partial<MaterialItem>; set: (k: keyof MaterialItem, v: unknown) => void; onSave: () => void; onClose: () => void; groups: string[] }) {
  return (
    <Modal open onClose={onClose} icon="award" title={editing.id ? '编辑材料' : '添加材料'}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="check" onClick={onSave}>保存</Button></>}>
      <div className="col gap-12">
        <div className="row gap-10 wrap">
          <div className="field grow" style={{ minWidth: 160 }}>
            <label className="field__label">名称 *</label>
            <input className="input" value={editing.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="如 本科成绩单.pdf" />
          </div>
          <div className="field grow" style={{ minWidth: 140 }}>
            <label className="field__label">分组</label>
            <input className="input" list="mat-groups" value={editing.group || ''} onChange={(e) => set('group', e.target.value)} />
            <datalist id="mat-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </div>
        </div>
        <div className="field">
          <label className="field__label">本机路径（可留空，用「材料根目录 + 名称」自动拼）</label>
          <input className="input mono" value={editing.path || ''} onChange={(e) => set('path', e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">备注</label>
          <input className="input" value={editing.note || ''} onChange={(e) => set('note', e.target.value)} placeholder="如 需教务处盖章 / 3 个月内有效" />
        </div>
        <label className="row gap-8" style={{ cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={!!editing.done} onChange={(e) => set('done', e.target.checked)} /> 已备好
        </label>
      </div>
    </Modal>
  );
}
