import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../ui/Icon';
import { Button, Badge, Empty, Modal } from '../ui/Kit';
import { copyText, fmtDate, todayISO, daysUntil } from '../../lib/util';
import type { Contact } from '../../types';

/** 内推人 / HR / 学长人脉：谁答应帮你推、推到哪一步、什么时候该跟进 */
export default function Contacts() {
  const { contacts, addContact, updateContact, removeContact, toast } = useStore();
  const [editing, setEditing] = useState<Partial<Contact> | null>(null);
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return contacts
      .filter((c) => !kw || [c.name, c.company, c.role, c.relation, c.notes, c.promised].some((x) => (x || '').toLowerCase().includes(kw)))
      .slice()
      .sort((a, b) => {
        const da = a.nextFollowUp ? (daysUntil(a.nextFollowUp) ?? 999) : 999;
        const db = b.nextFollowUp ? (daysUntil(b.nextFollowUp) ?? 999) : 999;
        return da - db;
      });
  }, [contacts, q]);

  const due = contacts.filter((c) => c.nextFollowUp && (daysUntil(c.nextFollowUp) ?? 99) <= 0);

  const save = () => {
    if (!editing?.name?.trim()) { toast('请填写姓名', 'err'); return; }
    if (editing.id) { updateContact(editing.id, editing); toast('已更新联系人'); }
    else { addContact(editing); toast('已添加联系人'); }
    setEditing(null);
  };
  const set = (k: keyof Contact, v: unknown) => setEditing((e) => ({ ...(e || {}), [k]: v } as Partial<Contact>));

  if (!contacts.length) {
    return (
      <>
        <Empty icon="user" title="还没有联系人记录"
          desc="内推、宣讲会加到的 HR、答应帮你递简历的学长 —— 记下「谁答应做什么、什么时候该跟进」，别让一次口头承诺烂在聊天记录里。"
          action={<Button variant="primary" icon="plus" onClick={() => setEditing({ name: '', lastContact: todayISO() })}>添加联系人</Button>} />
        {editing && <ContactForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} />}
      </>
    );
  }

  return (
    <div className="rise col gap-16">
      <div className="glass card">
        <div className="card__head">
          <div className="card__title"><Icon name="user" size={18} /> 人脉与内推（{contacts.length}）
            {due.length > 0 && <span className="badge badge--warn" style={{ marginLeft: 8 }}>{due.length} 位待跟进</span>}
          </div>
          <div className="row gap-8">
            <div className="search">
              <Icon name="search" size={15} />
              <input className="input input--sm" style={{ width: 170 }} placeholder="搜索姓名/单位/承诺…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ name: '', lastContact: todayISO() })}>添加</Button>
          </div>
        </div>
        <div className="col gap-6">
          {list.map((c) => {
            const fd = c.nextFollowUp ? daysUntil(c.nextFollowUp) : null;
            const overdue = fd !== null && fd <= 0;
            return (
              <div className="list-row" key={c.id} style={{ padding: '11px 12px', alignItems: 'flex-start' }}>
                <span className="tile">{c.name.slice(0, 2)}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row gap-8 wrap">
                    <b style={{ fontSize: 13.5 }}>{c.name}</b>
                    {c.role && <span className="badge badge--muted">{c.role}</span>}
                    {c.company && <span className="tx-3" style={{ fontSize: 12 }}>{c.company}</span>}
                    {c.relation && <span className="tx-4" style={{ fontSize: 11.5 }}>{c.relation}</span>}
                  </span>
                  {c.promised && <span className="tx-2" style={{ display: 'block', fontSize: 12.5, marginTop: 4 }}>承诺：{c.promised}</span>}
                  {c.notes && <span className="tx-3" style={{ display: 'block', fontSize: 12, marginTop: 3 }}>{c.notes}</span>}
                  <span className="tx-4" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
                    {c.lastContact ? `上次联系 ${fmtDate(c.lastContact)}` : '未记录联系时间'}
                    {c.nextFollowUp ? ` · 计划跟进 ${fmtDate(c.nextFollowUp)}` : ''}
                  </span>
                </span>
                <span className="col gap-6" style={{ alignItems: 'flex-end' }}>
                  {overdue && <Badge tone="badge--warn">该跟进了</Badge>}
                  <span className="row gap-4">
                    {c.wechat && <Button size="sm" variant="ghost" icon="copy" aria-label="复制微信"
                      onClick={async () => { if (await copyText(c.wechat || '')) toast('已复制微信号'); }} />}
                    {c.email && <Button size="sm" variant="ghost" icon="mail" aria-label="复制邮箱"
                      onClick={async () => { if (await copyText(c.email || '')) toast('已复制邮箱'); }} />}
                    <Button size="sm" variant="ghost" icon="check" aria-label="标记已联系"
                      onClick={() => { updateContact(c.id, { lastContact: todayISO() }); toast('已记录今天联系过'); }} />
                    <Button size="sm" variant="ghost" icon="edit" aria-label="编辑" onClick={() => setEditing(c)} />
                    <Button size="sm" variant="ghost" icon="trash" aria-label="删除"
                      onClick={() => { if (confirm(`删除联系人「${c.name}」？`)) { removeContact(c.id); toast('已删除', 'info'); } }} />
                  </span>
                </span>
              </div>
            );
          })}
          {!list.length && <div className="tx-3" style={{ fontSize: 13 }}>没有匹配的联系人</div>}
        </div>
      </div>
      {editing && <ContactForm editing={editing} set={set} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ContactForm({ editing, set, onSave, onClose }:
  { editing: Partial<Contact>; set: (k: keyof Contact, v: unknown) => void; onSave: () => void; onClose: () => void }) {
  const f = (label: string, k: keyof Contact, placeholder?: string, type = 'text') => (
    <div className="field" key={String(k)}>
      <label className="field__label">{label}</label>
      <input className="input" type={type} value={String((editing as Record<string, unknown>)[k] ?? '')} placeholder={placeholder}
        onChange={(e) => set(k, e.target.value)} />
    </div>
  );
  return (
    <Modal open onClose={onClose} icon="user" title={editing.id ? '编辑联系人' : '添加联系人'} wide
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="check" onClick={onSave}>保存</Button></>}>
      <div className="col gap-12">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
          {f('姓名 *', 'name', '如 张学长')}
          {f('单位', 'company', '如 中金公司')}
          {f('身份', 'role', 'HR / 内推人 / 学长 / 猎头')}
          {f('关系', 'relation', '如 校友、实习同事')}
          {f('微信', 'wechat')}
          {f('邮箱', 'email')}
          {f('电话', 'phone')}
          {f('上次联系', 'lastContact', '', 'date')}
          {f('计划跟进', 'nextFollowUp', '', 'date')}
        </div>
        <div className="field">
          <label className="field__label">对方承诺 / 待办</label>
          <input className="input" value={editing.promised || ''} onChange={(e) => set('promised', e.target.value)} placeholder="如 帮我把简历递给法务部 HR，说本周内给消息" />
        </div>
        <div className="field">
          <label className="field__label">备注</label>
          <textarea className="textarea" style={{ minHeight: 80 }} value={editing.notes || ''} onChange={(e) => set('notes', e.target.value)}
            placeholder="沟通要点、对方偏好、可用的说话方式…" />
        </div>
      </div>
    </Modal>
  );
}
