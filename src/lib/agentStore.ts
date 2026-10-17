/**
 * 站内 AI 助手的对话持久化。
 *
 * 为什么需要：面板原来只把消息放在 React state 里 —— 顺手关掉页面、切个板块、刷新一次，
 * 对话就没了，也翻不到历史。这里把「界面消息」与「给模型的原始对话」一起存进本机
 * localStorage，支持多会话切换、重命名（取首句）、删除，并做容量保护。
 *
 * ⚠️ 截断 raw 时必须走 trimRawConversation（按整轮切），不能 slice(-N)。
 *    raw 是 OpenAI 协议的报文，assistant(tool_calls) 与它的一批 tool 回执是一个原子单元；
 *    从中间切开就会留下孤立的 tool 消息，下次打开这个会话直接 400。
 */
import { trimRawConversation } from './agent';

const KEY = 'qz.agent.sessions';
const MAX_SESSIONS = 20;      // 最多保留多少个会话
const MAX_RAW = 60;           // 每个会话保留多少条模型原始消息（含工具结果）
const MAX_CHARS = 400_000;    // 总体积上限（约 400KB），超了从最旧的会话开始丢
export interface AgentRun { name: string; ok: boolean; summary: string }
export interface AgentUiMsg { role: 'user' | 'assistant' | 'error'; content: string; runs?: AgentRun[] }
export interface AgentSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  msgs: AgentUiMsg[];
  raw: unknown[];
}

const uid = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function readAll(): AgentSession[] {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(d) ? (d as AgentSession[]) : [];
  } catch { return []; }
}

function writeAll(list: AgentSession[]) {
  let out = list.slice(0, MAX_SESSIONS);
  /* 容量保护：超限先从最旧的会话开始丢；若**单个会话自身**就超限（例如把整份简历贴进对话），
     先裁它的消息与原始报文——否则循环立刻停下，setItem 抛配额异常被吞掉，
     本次对话更新全部丢失且用户毫无提示。 */
  const size = () => JSON.stringify(out).length;
  if (out.length && size() > MAX_CHARS) {
    const head = out[0];
    let msgs = head.msgs.slice(-40);
    let raw = trimRawConversation(head.raw || [], 10);
    while (msgs.length > 2 && JSON.stringify([{ ...head, msgs, raw }]).length > MAX_CHARS / 2) msgs = msgs.slice(-Math.max(2, Math.floor(msgs.length / 2)));
    out = [{ ...head, msgs, raw }, ...out.slice(1)];
  }
  while (out.length > 1 && size() > MAX_CHARS) out = out.slice(0, -1);
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* 配额不足则放弃本次写入 */ }
}

export function newSession(): AgentSession {
  const now = new Date().toISOString();
  return { id: uid(), title: '新对话', createdAt: now, updatedAt: now, msgs: [], raw: [] };
}

/** 会话列表（按更新时间倒序）；不含正文，供历史面板展示 */
export function listSessions(): { id: string; title: string; updatedAt: string; count: number }[] {
  return readAll()
    .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, count: s.msgs.length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadSession(id: string): AgentSession | null {
  return readAll().find((s) => s.id === id) || null;
}

export function latestSession(): AgentSession | null {
  const all = readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return all[0] || null;
}

export function saveSession(s: AgentSession) {
  const all = readAll();
  const i = all.findIndex((x) => x.id === s.id);
  const raw = trimRawConversation(s.raw || [], MAX_RAW);
  // 首句用户消息作为标题，便于在历史里认出来
  const firstUser = s.msgs.find((m) => m.role === 'user');
  const title = (firstUser?.content || '新对话').replace(/\s+/g, ' ').slice(0, 24);
  const next: AgentSession = { ...s, raw, title, updatedAt: new Date().toISOString() };
  if (i >= 0) all[i] = next; else all.unshift(next);
  writeAll(all);
}

export function deleteSession(id: string) {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function clearAllSessions() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
