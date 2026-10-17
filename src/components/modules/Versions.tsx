import React, { useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Empty, Modal } from '../ui/Kit';
import { copyText, fmtDate, todayISO } from '../../lib/util';
import type { ResumeVersion } from '../../types';

/**
 * 简历版本管理：律所 / 券商法务 / 银行合规 / 仲裁 各要一版。
 * 这里不存简历正文（正文在「我的简历」），只管理「版本 → 面向什么岗、改了哪几处、
 * 投过哪些单位、文件叫什么」，避免投错版本、也避免换版本时丢掉关键经历。
 */
export default function Versions() {
  const { versions, addVersion, updateVersion, removeVersion, toast } = useStore();
  const [editing, setEditing] = useState<Partial<ResumeVersion> | null>(null);

  const save = () => {
    if (!editing?.name?.trim()) { toast('请填写版本名称', 'err'); return; }
    if (editing.id) { updateVersion(editing.id, editing); toast('已更新版本'); }
    else { addVersion(editing); toast('已新增版本'); }
    setEditing(null);
  };
  const set = (k: keyof ResumeVersion, v: unknown) => setEditing((e) => ({ ...(e || {}), [k]: v } as Partial<ResumeVersion>));

  if (!versions.length) {
    return (
      <>
        <Empty icon="resume" title="还没有简历版本"
          desc="同一个你，投律所、券商法务、银行合规、仲裁院的简历重点完全不同。把每个版本「面向什么岗、强调什么、投过谁」记下来，投递时不会拿错版本。"
          action={<Button variant="primary" icon="plus" onClick={() => setEditing({ name: '', usedFor: [] })}>新建版本</Button>} />
        {editing && <VersionForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} />}
      </>
    );
  }

  return (
    <div className="rise col gap-16">
      <div className="row-between wrap gap-10">
        <div className="tx-3" style={{ fontSize: 12.5 }}>
          共 {versions.length} 个版本 · 简历正文仍在「我的简历」中编辑，这里只管版本策略
        </div>
        <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ name: '', usedFor: [] })}>新建版本</Button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))' }}>
        {versions.map((v) => (
          <div className="glass card" key={v.id}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <div className="row gap-8" style={{ minWidth: 0 }}>
                <span className="tile"><Icon name="resume" size={16} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 13.5, fontWeight: 650 }}>{v.name}</div>
                  <div className="tx-3 truncate" style={{ fontSize: 11.5 }}>{v.target || '未标注面向岗位'}</div>
                </div>
              </div>
              <span className="tx-4" style={{ fontSize: 10.5 }}>{fmtDate(v.updatedAt)}</span>
            </div>
            {v.focus && <div className="tx-2" style={{ fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{v.focus}</div>}
            {v.highlights && (
              <div className="tx-3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                <b>必留亮点：</b>{v.highlights}
              </div>
            )}
            {!!v.usedFor?.length && (
              <div className="row gap-6 wrap" style={{ marginTop: 10 }}>
                {v.usedFor.map((u) => <span className="badge badge--muted" key={u}>{u}</span>)}
              </div>
            )}
            {v.fileName && (
              <div className="row gap-6" style={{ marginTop: 10 }}>
                <span className="tx-4 mono truncate" style={{ fontSize: 10.5 }}>{v.fileName}</span>
                <Button size="sm" variant="ghost" icon="copy" aria-label="复制文件名"
                  onClick={async () => { if (await copyText(v.fileName || '')) toast('已复制文件名'); }} />
              </div>
            )}
            <div className="row gap-8" style={{ marginTop: 12 }}>
              <Button size="sm" icon="edit" onClick={() => setEditing(v)}>编辑</Button>
              <Button size="sm" variant="danger" icon="trash" onClick={() => { if (confirm(`删除版本「${v.name}」？`)) { removeVersion(v.id); toast('已删除', 'info'); } }}>删除</Button>
            </div>
          </div>
        ))}
      </div>

      {editing && <VersionForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}

function VersionForm({ editing, set, onSave, onClose }:
  { editing: Partial<ResumeVersion>; set: (k: keyof ResumeVersion, v: unknown) => void; onSave: () => void; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} icon="resume" title={editing.id ? '编辑简历版本' : '新建简历版本'}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="check" onClick={onSave}>保存</Button></>}>
      <div className="col gap-12">
        <div className="field">
          <label className="field__label">版本名称 *</label>
          <input className="input" value={editing.name || ''} onChange={(e) => set('name', e.target.value)} placeholder="如 律所版 / 券商法务版 / 银行合规版" />
        </div>
        <div className="field">
          <label className="field__label">面向岗位 / 行业</label>
          <input className="input" value={editing.target || ''} onChange={(e) => set('target', e.target.value)} placeholder="如 红圈所资本市场组、券商法律合规岗" />
        </div>
        <div className="field">
          <label className="field__label">这一版强调什么</label>
          <textarea className="textarea" style={{ minHeight: 70 }} value={editing.focus || ''} onChange={(e) => set('focus', e.target.value)}
            placeholder="如：突出尽调与法律意见书经验，弱化 AI 项目；把证券法相关经历提到最前" />
        </div>
        <div className="field">
          <label className="field__label">必须保留的亮点（换版本时别丢）</label>
          <textarea className="textarea" style={{ minHeight: 60 }} value={editing.highlights || ''} onChange={(e) => set('highlights', e.target.value)}
            placeholder="如：法考 A 证、两段红圈所实习、英文工作能力" />
        </div>
        <div className="field">
          <label className="field__label">已用于（逗号分隔单位名）</label>
          <input className="input" value={(editing.usedFor || []).join('、')}
            onChange={(e) => set('usedFor', e.target.value.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean))}
            placeholder="如 中金、君合、国开行" />
        </div>
        <div className="field">
          <label className="field__label">本机文件名</label>
          <input className="input mono" value={editing.fileName || ''} onChange={(e) => set('fileName', e.target.value)} placeholder="如 简历-律所版-2026.pdf" />
        </div>
      </div>
    </Modal>
  );
}
