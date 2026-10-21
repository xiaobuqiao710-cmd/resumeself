/**
 * 只读演示模式 —— 供截图与设计评审用的假数据外壳（**不参与生产路径**）。
 *
 * 为什么要它：站点是「登录 + 云端」结构，未登录只能看到落地页，首页与日历根本渲染不出来；
 * 而设计评审必须对着真实渲染的截图看，不能对着源码想象。
 *
 * 三条硬约束：
 *   ① 只有 URL 带 `?demo=1` 才会走到这里（App.tsx 里那一处判断）；
 *   ② 它**不读也不写** localStorage / Supabase —— 演示数据只存在内存里，刷新即还原；
 *   ③ 它不改任何业务逻辑：StoreProvider 收到的就是一份普通的 boot.state。
 */
import React, { useState } from 'react';

const noop = () => {};

/** 演示数据存在这个内存副本里；刷新页面就回到 src/lib/demoSeed.ts 的初始内容 */
let memoryState: Record<string, unknown> | null = null;

/** 演示数据的来源：src/lib/demoSeed.ts，静态 import —— 只有 ?demo=1 时才会被真正求值到 */
async function seed(): Promise<Record<string, unknown>> {
  const m = await import('./demoSeed');
  return m.DEMO_SEED as unknown as Record<string, unknown>;
}

import type { ViewId } from '../types';

/**
 * 方向探索用的「演示方向」开关（?demo=1&dir=a|b|c）。
 *
 * 只服务 style-explorer 对比页：同一个仓库同时挂着三个首屏方向，靠这个参数切换。
 * 同样**不进生产路径** —— 没有 ?demo=1 时恒为 null，任何 dir= 参数都不生效。
 */
export function demoDirection(): string | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  if (q.get('demo') !== '1') return null;
  return q.get('dir');
}

export interface DemoBoot {
  st: 'ready';
  userId: string;
  email: string;
  boot: { ok: true; state: Record<string, unknown> | null; migrated: boolean; savedAt?: string };
  /** 演示模式下从 #/xxx 解析出的落地板块（只影响演示） */
  initialView?: ViewId;
}

/** App 启动时用：拿到一份「已登录 + 云端已读到」的状态，直接进站 */
export async function demoBootState(): Promise<DemoBoot> {
  memoryState = memoryState ?? JSON.parse(JSON.stringify(await seed()));
  /* 地址里的导航目标：#/dashboard → 'dashboard'。
     这是**演示模式独有**的入口 —— 生产环境导航状态只存在 store 里，不走 URL。 */
  const hashView = (location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
  return {
    st: 'ready',
    userId: 'demo',
    email: 'demo@example.com',
    boot: { ok: true, state: memoryState, migrated: false },
    initialView: hashView ? (hashView as DemoBoot['initialView']) : undefined,
  };
}

/** openFor 里用的简版：只要 boot 那一层 */
export async function demoBoot() {
  return (await demoBootState()).boot;
}

/** 演示模式下的「云端读」：永远返回内存副本，不联网 */
export const demoLoad = async () => ({ state: memoryState, savedAt: undefined, migrated: false });

/** 演示模式下的「云端写」：只写内存副本，落不到任何持久层 */
export const demoSave = async (state: Record<string, unknown>) => {
  memoryState = JSON.parse(JSON.stringify(state));
  return new Date().toISOString();
};

/** 演示模式下的假 Supabase：只实现 App 实际会碰的 auth 方法 */
export function makeDemoClient() {
  const user = { id: 'demo', email: 'demo@example.com', aud: 'authenticated', app_metadata: {}, user_metadata: {} };
  const session = { access_token: 'demo', token_type: 'bearer', user, expires_at: 0, refresh_token: 'demo' };
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: noop } } }),
      signOut: async () => ({ error: null }),
      signInWithPassword: async () => ({ data: { session, user }, error: null }),
      signUp: async () => ({ data: { session, user }, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: { user }, error: null }),
      resend: async () => ({ data: {}, error: null }),
      getUser: async () => ({ data: { user }, error: null }),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  };
}

/**
 * 演示模式的常驻提示条。存在的意义是**不让看截图的自己或别人误以为这是真数据**，
 * 所以它只占一行、不抢视觉重心，可以关掉。
 */
export function DemoBanner() {
  /* 探索页（style-explorer 对比页）要干净的截图：带 ?dir= 时不渲染这条提示。
     它只是提示，不影响任何数据路径 —— 真实数据本来就不会被读写。 */
  const [off, setOff] = useState(() => !!demoDirection());
  if (off) return null;
  return (
    <div className="demo-bar">
      <span className="demo-bar__dot" aria-hidden />
      <span className="demo-bar__t">演示数据</span>
      <span className="demo-bar__d">不读取也不写入你的真实数据 · 刷新即还原</span>
      <button className="demo-bar__x" onClick={() => setOff(true)} aria-label="关闭演示提示">×</button>
    </div>
  );
}
