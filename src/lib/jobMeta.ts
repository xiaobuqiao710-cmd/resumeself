import type { JobStatus, ScoreTier } from '../types';

/** 岗位状态展示元数据（岗位列表与公司卡片共用） */
export const JOB_STATUS_META: Record<JobStatus, { label: string; cls: string }> = {
  new: { label: '新发现', cls: 'badge--info' },
  interested: { label: '感兴趣', cls: 'badge--accent' },
  applied: { label: '已投递', cls: 'badge--ok' },
  archived: { label: '已归档', cls: 'badge--muted' },
};

/** 匹配度颜色 */
export const scoreTone = (s: number) => (s >= 80 ? 'badge--ok' : s >= 60 ? 'badge--accent' : s >= 40 ? 'badge--warn' : 'badge--danger');

/**
 * 价值分档徽章配色。
 * S 用 `badge--danger`（红）—— 中国语境里红色是「重点 / 值得争」，不是警告；
 * 这一档需要在一屏里第一眼被看到，用最重的颜色是对的。
 */
export const tierTone = (t?: ScoreTier) =>
  t === 'S' ? 'badge--danger' : t === 'A' ? 'badge--warn' : t === 'B' ? 'badge--info' : 'badge--muted';

/** 分档短标签，用于列表里的紧凑徽章 */
export const TIER_SHORT: Record<ScoreTier, string> = { S: 'S 核心', A: 'A 重点', B: 'B 常规', C: 'C 低优先' };

/** 排序权重：S→0 … C→3。无分档（手动 AI 评分）排在有分档的后面 */
export const tierRank = (t?: ScoreTier) => (t ? ['S', 'A', 'B', 'C'].indexOf(t) : 9);

