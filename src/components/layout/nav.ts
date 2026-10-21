/**
 * 全站导航的唯一事实来源。
 *
 * 整合原则（2026-09-11）：把原来 14 个并列入口按「用户脑中的任务」合并成 7 个主入口，
 * 组内用页内标签切换 —— 侧边栏只回答「我在哪件大事上」，标签回答「具体看哪一屏」。
 * 侧边栏、页内标签栏、顶部标题、⌘K 跳转全部从这里派生，改一处即全局一致。
 */
import type { ViewId } from '../../types';

export interface NavTab { id: ViewId; label: string; icon: string; desc: string; }
export interface NavGroupDef { id: string; label: string; icon: string; section: string; tabs: NavTab[]; }

export const NAV_GROUPS: NavGroupDef[] = [
  {
    id: 'overview', label: '总览', icon: 'dashboard', section: '求职推进',
    tabs: [
      { id: 'dashboard', label: '今日总览', icon: 'dashboard', desc: '秋招总览 · 截止提醒 · 进度与待办' },
      { id: 'insights', label: '数据洞察', icon: 'filter', desc: '投递漏斗 · 渠道与城市效力 · 导出快照' },
    ],
  },
  {
    id: 'pipeline', label: '求职进程', icon: 'target', section: '求职推进',
    tabs: [
      { id: 'jobs', label: '岗位库', icon: 'target', desc: '招聘信息汇集 · 汇总表批量导入 · AI 匹配度' },
      { id: 'applications', label: '投递记录', icon: 'building', desc: '投递进度追踪 · 状态流转' },
      { id: 'contacts', label: '人脉内推', icon: 'user', desc: 'HR / 内推人 / 跟进节奏' },
    ],
  },
  {
    id: 'schedule', label: '日程', icon: 'calendar', section: '求职推进',
    tabs: [
      { id: 'calendar', label: '笔试面试日程', icon: 'calendar', desc: '只放笔试 / 面试 / Offer 的约定时间 · 撞车检测' },
    ],
  },
  {
    id: 'outcome', label: '面试与 Offer', icon: 'trophy', section: '求职推进',
    tabs: [
      { id: 'interviews', label: '面试复盘', icon: 'video', desc: '问了什么 · 我的回答 · 下次改进' },
      { id: 'offers', label: 'Offer 对比', icon: 'trophy', desc: '薪资结构 · 户口 · 签约截止 · 决策评分' },
    ],
  },
  {
    id: 'exam', label: '备考题库', icon: 'paper', section: '求职推进',
    tabs: [
      { id: 'bank', label: '笔试面试题库', icon: 'paper', desc: '分类 → 题库 → 整场导入自动成组 · 真题经验 · AI 参考答案' },
    ],
  },
  {
    id: 'profile', label: '我的资料', icon: 'layers', section: '资料与协同',
    tabs: [
      { id: 'database', label: '网申资料库', icon: 'layers', desc: '12 大板块 · 一键复制填写' },
      { id: 'resume', label: '简历', icon: 'resume', desc: '编辑 · 导出 Word · 证件照' },
      { id: 'versions', label: '简历版本', icon: 'doc', desc: '各方向一版 · 投递对应' },
      { id: 'checklist', label: '材料清单', icon: 'award', desc: '证件 / 证明 / 成绩 · 一键复制路径' },
    ],
  },
  {
    id: 'mail', label: '邮件中心', icon: 'mail', section: '资料与协同',
    tabs: [
      { id: 'mail', label: '邮件中心', icon: 'mail', desc: '直连你的邮箱自动收发 · 整理 · 同步' },
    ],
  },
];

/** 每个视图属于哪个主入口 */
export function groupOf(view: ViewId): NavGroupDef {
  return NAV_GROUPS.find((g) => g.tabs.some((t) => t.id === view)) || NAV_GROUPS[0];
}

/** 视图 → 标题信息（顶部栏用）：t = 主入口名，c = 当前标签的说明 */
export const VIEW_INFO: Record<string, { groupId: string; groupLabel: string; tabLabel: string; desc: string }> = (() => {
  const out: Record<string, { groupId: string; groupLabel: string; tabLabel: string; desc: string }> = {};
  for (const g of NAV_GROUPS) {
    for (const t of g.tabs) out[t.id] = { groupId: g.id, groupLabel: g.label, tabLabel: t.label, desc: t.desc };
  }
  return out;
})();
