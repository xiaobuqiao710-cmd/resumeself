import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from './Icon';
import { Badge, Button, Modal } from './Kit';
import { cn, fmtDate, fromISO, todayISO } from '../../lib/util';
import { buildDeadlineBrief, type BriefItem } from '../../lib/deadlineBrief';
import { parseStageEventId } from '../../lib/appTimeline';
import { getAiConfig, hasAiKey, callAi } from '../../lib/ai';

/**
 * 「AI 梳理截止」面板。
 *
 * 存在的理由（用户 2026-10-20 原话）：
 *   「这里呈现的待办和我的投递记录也不匹配……我建议直接就设置成一个 AI 按钮，
 *     我一按就显示你哪些要截止，以及何时截止。」
 *
 * 所以这一屏的分工很明确：
 *   · **清单本身是规则算的**（lib/deadlineBrief.ts）：日期、剩余天数、去重口径全部确定，
 *     打开即出，不等网络、不会被模型编错一天；
 *   · **AI 只补一句人话**：最要紧的三件事、有没有撞车、哪些该收尾。没配 Key 就不显示这块，
 *     清单照样完整可用 —— 不把「有没有 AI」变成「能不能用」的门槛。
 */

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

function relText(it: BriefItem): string {
  if (it.days < 0) return `已过 ${-it.days} 天`;
  if (it.days === 0) return '今天';
  if (it.days === 1) return '明天';
  return `${it.days} 天后`;
}

function toneOf(it: BriefItem): string {
  if (it.days < 0) return 'badge--muted';
  if (it.days === 0) return 'badge--danger';
  if (it.days <= 3) return 'badge--warn';
  return 'badge--info';
}

const KIND_LABEL: Record<BriefItem['kind'], string> = { app: '投递', job: '岗位', stage: '日程' };

export function DeadlineBriefModal({ onClose }: { onClose: () => void }) {
  const { applications, jobs, allEvents, removeEvent, updateEvent, updateStage, setView, toast } = useStore();
  const today = todayISO();
  const brief = useMemo(
    () => buildDeadlineBrief({ applications, jobs, events: allEvents }, today),
    [applications, jobs, allEvents, today],
  );

  const [ai, setAi] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [aiErr, setAiErr] = useState<string>('');

  const askAi = async () => {
    if (!hasAiKey() || loading) return;
    setLoading(true); setAiErr('');
    try {
      const out = await callAi(
        getAiConfig(),
        '你是秋招进度助理。根据给定的截止清单，用 2-4 句话回答：①最紧急的三件事（写清单位与日期）；'
        + '②有没有同日撞车或时间过紧的地方；③哪些已经过期、建议直接收尾。'
        + '要求：中文；直接给结论，不复述清单；不用 Markdown 符号（不要 ** # - 列表符）；'
        + '不超过 160 字；不要客套话。',
        `【截止清单】\n${brief.aiContext}`,
        45000,
      );
      setAi(out.trim());
    } catch (e) {
      setAiErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  /* 打开即问一次：用户点这个按钮就是要答案，不该再让他点第二次。
     失败不阻塞清单展示 —— 规则那份已经算好了。 */
  useEffect(() => { void askAi(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  /** 把一条过期日程标成已完成：派生事件写回进度线节点，其余写 events */
  const markDone = (it: BriefItem) => {
    const evId = it.key.slice(3);           // key 形如 ev-<id>
    const parsed = parseStageEventId(evId);
    if (parsed) updateStage(parsed.appId, parsed.entryId, { done: true });
    else updateEvent(evId, { done: true });
    toast(`已完成：${it.company}`, 'info');
  };

  const Section = ({ title, list, hint }: { title: string; list: BriefItem[]; hint?: string }) => {
    if (!list.length) return null;
    return (
      <div style={{ marginBottom: 18 }}>
        <div className="row gap-8" style={{ marginBottom: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 13.5, fontWeight: 650 }}>{title}</span>
          <Badge tone="badge--muted">{list.length}</Badge>
          {hint && <span className="tx-4" style={{ fontSize: 11.5 }}>{hint}</span>}
        </div>
        <div className="col gap-4">
          {list.map((it) => (
            <div className="list-row" key={it.key} style={{ padding: '8px 10px', alignItems: 'flex-start' }}>
              <span className="col" style={{ alignItems: 'center', minWidth: 52, flexShrink: 0 }}>
                <span className="tx-3" style={{ fontSize: 10.5 }}>{fromISO(it.date).getMonth() + 1}月{fromISO(it.date).getDate()}日</span>
                <span className="tx-4" style={{ fontSize: 10 }}>周{DOW[fromISO(it.date).getDay()]}</span>
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="truncate" style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                  {it.company}{it.position ? <span className="tx-3" style={{ fontWeight: 500 }}> · {it.position}</span> : null}
                </span>
                <span className="row gap-6 wrap" style={{ marginTop: 3 }}>
                  <Badge tone="badge--accent">{it.label}</Badge>
                  {it.time && <span className="tx-4" style={{ fontSize: 11 }}>{it.time}</span>}
                  <Badge tone={toneOf(it)}>{relText(it)}</Badge>
                  <span className="tx-4" style={{ fontSize: 10.5 }}>{KIND_LABEL[it.kind]}</span>
                  {it.orphan && <span className="tx-4" style={{ fontSize: 10.5 }}>· 无对应投递记录</span>}
                </span>
              </span>
              {it.bucket === 'overdue' && it.kind === 'stage' && (
                <Button size="sm" variant="ghost" onClick={() => markDone(it)}>完成</Button>
              )}
              {it.url && (
                <a href={it.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="ghost" icon="external" aria-label="打开链接" />
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <Modal open onClose={onClose} wide icon="clock" title="什么要截止 · 什么时候"
      footer={<>
        <Button onClick={onClose}>关闭</Button>
        <span className="grow" />
        <Button icon="sparkles" onClick={askAi} disabled={!hasAiKey() || loading}>
          {loading ? 'AI 分析中…' : hasAiKey() ? 'AI 重新梳理' : '未配置 AI Key'}
        </Button>
        <Button variant="primary" icon="calendar" onClick={() => { onClose(); setView('calendar'); }}>去日历</Button>
      </>}>
      {/* ---- 一句话结论 ---- */}
      <div className="glass card" style={{ padding: '12px 14px', marginBottom: 16 }}>
        <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
          <Icon name="sparkles" size={16} />
          <div className="grow" style={{ minWidth: 0 }}>
            {ai ? (
              <div style={{ fontSize: 13.5, lineHeight: 1.75 }}>{ai}</div>
            ) : loading ? (
              <div className="tx-3" style={{ fontSize: 13 }}>正在让 AI 看一眼…（清单已经算好了，就在下面）</div>
            ) : aiErr ? (
              <div className="tx-3" style={{ fontSize: 12.5 }}>
                AI 暂时没连上（{aiErr.slice(0, 60)}）。下面是按日期规则算好的清单，一样能用。
              </div>
            ) : (
              <div style={{ fontSize: 13.5 }}>{brief.summary}</div>
            )}
            {ai && <div className="tx-4" style={{ fontSize: 11.5, marginTop: 6 }}>{brief.summary}</div>}
          </div>
        </div>
      </div>

      <Section title="已经过期，还没处理" list={brief.buckets.overdue}
        hint="过期的约不会自己消失，要么去赴约、要么标记完成" />
      <Section title="今天" list={brief.buckets.today} />
      <Section title="3 天内" list={brief.buckets.d3} />
      <Section title="7 天内" list={brief.buckets.d7} />
      <Section title="7 天以后" list={brief.buckets.later} hint="先知道，不用现在动手" />

      {brief.items.length === 0 && (
        <div className="tx-3" style={{ fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
          没有要赶的截止。投递记录里填了截止日、进度线上填了笔面时间，就会出现在这里。
        </div>
      )}

      {/* ---- 无主日程：邮件同步最容易在这里堆垃圾 ---- */}
      {brief.orphans.length > 0 && (
        <div className="glass card" style={{ marginTop: 16, padding: 14, borderColor: 'rgba(220,120,90,.28)' }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 650 }}>
              对不上投递记录的日程 · {brief.orphans.length} 条
            </span>
            <Button size="sm" variant="danger" icon="trash" onClick={() => {
              brief.orphans.forEach((it) => removeEvent(it.key.slice(3)));
              toast(`已清理 ${brief.orphans.length} 条无主日程`, 'info');
              onClose();
            }}>全部清理</Button>
          </div>
          <div className="tx-3" style={{ fontSize: 12, lineHeight: 1.75 }}>
            这些多半是「同步邮件」时按邮件标题自动建的，没有挂到任何一条投递记录上，
            日期也常常是收到邮件那天而不是考试那天 —— 所以看起来跟你的投递记录对不上。
            想让它们变成有用的日程：去对应投递记录的「进度线」里补一个笔试/面试节点，再把这里清掉。
          </div>
          <div className="col gap-4" style={{ marginTop: 10 }}>
            {brief.orphans.slice(0, 8).map((it) => (
              <div key={it.key} className="list-row" style={{ padding: '6px 8px' }}>
                <span className="tx-4 mono" style={{ fontSize: 11, minWidth: 74 }}>{fmtDate(it.date)}</span>
                <span className="grow truncate" style={{ fontSize: 12 }}>{it.company}</span>
                <Badge tone="badge--muted">{it.label}</Badge>
                <Button size="sm" variant="ghost" icon="trash" aria-label="删除"
                  onClick={() => { removeEvent(it.key.slice(3)); toast('已删除', 'info'); }} />
              </div>
            ))}
            {brief.orphans.length > 8 && (
              <span className="tx-4" style={{ fontSize: 11 }}>还有 {brief.orphans.length - 8} 条，「全部清理」会一并删掉</span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default DeadlineBriefModal;
