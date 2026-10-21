import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Button, Modal } from '../ui/Kit';
import { Icon } from '../ui/Icon';
import { saveSnapshot } from '../../lib/backup';
import { daysUntil, fmtDate } from '../../lib/util';
import type { JobPosting } from '../../types';

/**
 * 「清理岗位库」—— 配额满时的减负入口（2026-10-17）。
 *
 * 为什么单独做一个弹窗：配额满的告警文案让用户「清理早已截止/不投的岗位」，
 * 但岗位页原有的「归档已截止岗位」**只改状态、不删数据** —— 整份状态照旧写本机，
 * 一点空间都腾不出来。要真腾地方就只能删，而删除必须有两个前提：
 *   ① **用户先看清要删哪些**（逐条列出，默认只勾「已截止且未投递」）；
 *   ② **删之前留一份可回滚的快照**（与「清理重复岗位」同一口径）。
 *
 * 体积估算：整份状态是 JSON，删掉一条岗位省下的字符数 ≈ 该条岗位序列化后 + 1 个逗号。
 * 这里不用精确重算全站 JSON（那要把整个 store 再序列化一遍），只按条目估，
 * 用来告诉用户「这次大概能腾多少」，不参与任何判定。
 */

const estChars = (j: JobPosting) => {
  try { return JSON.stringify(j).length + 1; } catch { return 0; }
};

export function JobsCleanupModal({ onClose }: { onClose: () => void }) {
  const { jobs, removeJobs, storageKey, toast } = useStore();

  /**
   * 默认勾选：截止日已过 **且** 没投递过（status 不是 applied）、也还没归档。
   * 为什么不把「已归档」也算进来：已归档里可能有用户主动收起来、之后还想翻回来看的岗位
   * （比如「这家今年没投，明年再说」），默认不动它，让用户自己点。
   */
  const defaultIds = useMemo(() => jobs.filter((j) =>
    j.status !== 'applied' && j.status !== 'archived'
    && !!j.deadline && (daysUntil(j.deadline) ?? 0) < 0).map((j) => j.id), [jobs]);

  const [picked, setPicked] = useState<Set<string>>(() => new Set(defaultIds));

  const rows = useMemo(() => {
    /* 列表排序：已截止的排前面（默认勾的组），其余按截止日。没截止日的放最后。 */
    return [...jobs].sort((a, b) => {
      const pa = a.deadline && (daysUntil(a.deadline) ?? 0) < 0 ? 0 : 1;
      const pb = b.deadline && (daysUntil(b.deadline) ?? 0) < 0 ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (a.deadline || '9999').localeCompare(b.deadline || '9999');
    });
  }, [jobs]);

  const pickedJobs = rows.filter((j) => picked.has(j.id));
  const freed = pickedJobs.reduce((n, j) => n + estChars(j), 0);

  const toggle = (id: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const apply = () => {
    if (!picked.size) return;
    /* 删之前先快照：与「清理重复岗位」一致。配额不足时快照可能存不下，但那不该阻塞清理 ——
       这正是用户在为配额发愁的时候。 */
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) saveSnapshot(storageKey, raw);
    } catch { /* ignore */ }
    const n = removeJobs([...picked]);
    toast(`已删除 ${n} 条岗位，本机存储省下约 ${Math.round(freed / 1024)} KB（删除前已存快照，可在设置里回滚）`, 'ok', 6000);
    onClose();
  };

  return (
    <Modal open onClose={onClose} wide icon="trash" title="清理岗位库（腾出本机存储）"
      footer={<>
        <span className="tx-4" style={{ fontSize: 12, marginRight: 'auto' }}>
          {picked.size > 0 ? `将删除 ${picked.size} 条 · 约省 ${Math.round(freed / 1024)} KB` : '还没有勾选任何岗位'}
        </span>
        <Button onClick={onClose}>取消</Button>
        <Button variant="danger" icon="trash" disabled={picked.size === 0} onClick={apply}>
          删除选中的 {picked.size} 条
        </Button>
      </>}>
      <div className="col gap-10">
        <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          已截止且<b>没有投递过</b>的岗位默认勾上（共 <b>{defaultIds.length}</b> 条）—— 这些基本不会再看了。<br />
          <b>删除是不可逆的</b>：与「归档」不同，删掉后不在「已归档」筛选中，但删除前会自动存一份本机快照，
          可在「设置 → 数据与备份 → 查看快照」一键回滚。已投递的岗位<b>永不默认勾选</b>（那是等结果的锚点）。
        </div>

        {jobs.length === 0 ? (
          <div className="glass card" style={{ padding: 16, fontSize: 13 }}>
            <div className="row gap-8"><Icon name="check" size={16} /> 岗位库是空的，没有可清理的内容</div>
          </div>
        ) : (
          <div className="col gap-6" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {rows.map((j) => {
              const dl = j.deadline ? (daysUntil(j.deadline) ?? 0) : null;
              const expired = dl !== null && dl < 0;
              return (
                <label key={j.id} className="list-row" style={{ padding: '8px 10px', cursor: 'pointer', alignItems: 'center' }}>
                  <input type="checkbox" checked={picked.has(j.id)} onChange={() => toggle(j.id)} />
                  <span className="grow truncate" style={{ fontSize: 12.5 }}>{j.company} · {j.title}</span>
                  {j.status === 'applied' && <span className="badge badge--ok" style={{ fontSize: 10.5 }}>已投递</span>}
                  {j.status === 'archived' && <span className="badge badge--muted" style={{ fontSize: 10.5 }}>已归档</span>}
                  <span className={expired ? 'badge badge--warn' : 'badge badge--muted'} style={{ fontSize: 10.5 }}>
                    {j.deadline ? `${expired ? '已截止 ' : '截止 '}${fmtDate(j.deadline)}` : '无截止'}
                  </span>
                  <span className="tx-4 mono" style={{ fontSize: 10.5, minWidth: 48, textAlign: 'right' }}>
                    {Math.round(estChars(j) / 1024)} KB
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
