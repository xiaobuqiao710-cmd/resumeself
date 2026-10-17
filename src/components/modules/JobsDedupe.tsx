import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { planJobDedupe } from '../../lib/dedupe';
import { Button, Badge, Modal } from '../ui/Kit';
import { Icon } from '../ui/Icon';
import { saveSnapshot } from '../../lib/backup';
import { JOB_STATUS_META } from '../../lib/jobMeta';
import { cn } from '../../lib/util';

/**
 * 「清理重复」预览弹窗。
 *
 * 为什么需要它：岗位从汇总表导入、邮件识别、网盘同步多条路径进来，同一条信息写法常不同
 * （「中金公司」/「中国国际金融股份有限公司」、「2027 校招法务岗」/「法务岗」），
 * 精确比对挡不住，列表和截止提醒里就会出现一堆看着重复的条目。
 * 这里先把方案摆出来给人看：留下信息最全的一条，其余合并删除；删除前自动存快照可回滚。
 */
export function JobsDedupeModal({ onClose }: { onClose: () => void }) {
  const { jobs, updateJob, removeJob, toast } = useStore();
  const [mergeSimilar, setMergeSimilar] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());          // 取消勾选的分组（用保留项 id 标识）

  const plan = useMemo(() => planJobDedupe(jobs, { mergeSimilar }), [jobs, mergeSimilar]);
  const chosen = plan.groups.filter((g) => !skip.has(g.keep.id));
  const removeCount = chosen.reduce((n, g) => n + g.dups.length, 0);

  const toggle = (id: string) => setSkip((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const apply = () => {
    try {
      const key = 'qz.cloud.default';
      const raw = localStorage.getItem(key);
      if (raw) saveSnapshot(key, raw);        // 默认 bak 标签 → 「设置 → 数据与备份 → 查看快照」可一键回滚
    } catch { /* 配额不足时忽略，不阻塞清理 */ }
    let removed = 0;
    chosen.forEach((g) => {
      if (Object.keys(g.patch).length) updateJob(g.keep.id, g.patch);
      g.dups.forEach((d) => { removeJob(d.id); removed++; });
    });
    toast(`已清理 ${removed} 条重复岗位（清理前已存快照，可在「设置 → 数据与备份」回滚）`);
    onClose();
  };

  return (
    <Modal open onClose={onClose} wide icon="filter" title="清理重复岗位"
      footer={<>
        <span className="tx-4" style={{ fontSize: 12, marginRight: 'auto' }}>
          {removeCount > 0 ? `将删除 ${removeCount} 条、保留 ${chosen.length} 条` : '没有勾选任何分组'}
        </span>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" disabled={removeCount === 0} onClick={apply}>
          清理选中的 {removeCount} 条
        </Button>
      </>}>
      <div className="col gap-12">
        <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.75 }}>
          判定规则：<b>同一单位</b>（简称/全称/分行视为一家）且<b>岗位名归一化后相同</b>的视为重复 ——
          保留信息最全的一条（有链接、要求、笔试、JD 的优先），并把其余条目里独有的字段补进来，不会丢链接和截止日。
          清理前会自动存一份本机快照，随时可在「设置 → 数据与备份 → 查看快照」回滚。
        </div>

        <label className="row gap-8" style={{ fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={mergeSimilar} onChange={(e) => { setMergeSimilar(e.target.checked); setSkip(new Set()); }} />
          连「标题高度相似」的也一起合并（例如「法务岗」与「法务合规岗」）
        </label>

        {plan.groups.length === 0 && (
          <div className="glass card" style={{ padding: 16 }}>
            <div className="row gap-8" style={{ fontSize: 13 }}>
              <Icon name="check" size={16} /> 没有发现重复岗位
            </div>
            {plan.similarPairs.length > 0 && (
              <div className="tx-3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.8 }}>
                不过有 {plan.similarPairs.length} 组「标题互相包含」的岗位，可能是同一家的不同岗位，也可能是同一条的两种写法；
                需要一并合并的话，勾选上面的开关。
              </div>
            )}
          </div>
        )}

        {plan.groups.map((g) => {
          const st = JOB_STATUS_META[g.keep.status];
          const fields = Object.keys(g.patch);
          return (
            <div key={g.keep.id} className="glass card" style={{ padding: 12 }}>
              <div className="row gap-10" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={!skip.has(g.keep.id)} onChange={() => toggle(g.keep.id)} style={{ marginTop: 3 }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row gap-6 wrap" style={{ fontSize: 13, fontWeight: 640 }}>
                    <span className="truncate">保留：{g.keep.company} · {g.keep.title}</span>
                    {st && <Badge tone={st.cls}>{st.label}</Badge>}
                    {g.reason === 'similar' && <Badge tone="badge--warn">标题相似</Badge>}
                  </div>
                  <div className="tx-3" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
                    合并删除 {g.dups.length} 条：{g.dups.map((d) => `${d.company} · ${d.title}`).join('、')}
                  </div>
                  {fields.length > 0 && (
                    <div className="tx-4" style={{ fontSize: 11, marginTop: 4 }}>
                      会从被删项补全：{fields.join('、')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {!mergeSimilar && plan.similarPairs.length > 0 && plan.groups.length > 0 && (
          <div className="glass" style={{ padding: 12, borderRadius: 16 }}>
            <div className="row gap-8" style={{ fontSize: 12.5, fontWeight: 640 }}>
              <Icon name="alert" size={14} /> 另有 {plan.similarPairs.length} 组疑似重复（默认不动）
            </div>
            <div className="col gap-4" style={{ marginTop: 8, maxHeight: 150, overflowY: 'auto' }}>
              {plan.similarPairs.slice(0, 20).map((p, i) => (
                <div key={i} className={cn('tx-3', 'truncate')} style={{ fontSize: 12 }}>
                  {p.company}：「{p.a}」 ↔ 「{p.b}」
                </div>
              ))}
            </div>
            <div className="tx-4" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
              这些是同一单位下名字互相包含的岗位，可能确实是两个岗位（如「法律类」与「技术类」），所以默认不合并。
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
