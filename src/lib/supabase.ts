/**
 * Supabase 客户端（云端版的唯一后端依赖）。
 *
 * 这里的 URL 与 anon key 是**公开信息**：它们会随 JS bundle 发到每个访客的浏览器里，
 * 安全性完全由数据库的行级安全策略（RLS）保证 —— 每张表都只允许 `auth.uid() = user_id`
 * 的读写，所以拿 anon key 也无法看到别人的数据。真正的服务端密钥（service_role）绝不能出现在前端。
 *
 * 与旧版（prototype）的差异：旧版把资料、投递、岗位等拆成 7 张表分别同步，
 * 每次保存要「先全删再全插」7 轮请求，任一轮失败就会出现半同步状态；
 * 现在整站状态作为**一份 JSON 文档**存进 profiles.data（见 lib/cloudState.ts），
 * 一次 upsert 原子落盘，也就再没有「投递删了但岗位卡还在」这类跨表不一致。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/* ------------------------------------------------------------------ *
 * 回跳 URL 必须在 createClient 之前抓下来。
 *
 * 邮件链接（重置密码 / 邮箱验证）回跳时，凭据挂在 `#access_token=…&type=recovery`，
 * 而 supabase-js 初始化时会把这段 hash **消费掉并清空**。等 React 渲染时再读
 * location.hash 就什么都读不到了，也就无法判断「这次是重置密码回来的」。
 * 所以在这里、在客户端创建之前，先把原始 hash 存进常量。
 * ------------------------------------------------------------------ */
const RAW_HASH = typeof location !== 'undefined' ? location.hash : '';

/** 本次打开是不是「点重置密码邮件」回来的 */
export const INITIAL_RECOVERY = /(^|[#&])type=recovery(&|$)/.test(RAW_HASH);

/** 回跳链接自带的错误（链接过期 / 已被使用），给登录页显示人话 */
export const INITIAL_AUTH_ERROR = (() => {
  const m = /(^|[#&])error_description=([^&]*)/.exec(RAW_HASH);
  if (!m) return '';
  const raw = decodeURIComponent(m[2].replace(/\+/g, ' '));
  if (/expired|invalid/i.test(raw)) return '链接已失效或已被使用。本站不走自助重置：请在登录页点「忘记密码」，把注册邮箱发给站长人工重置。';
  return raw;
})();

/*
 * 配置来自环境变量，而不是写死在源码里 —— 这样同一个仓库可以被任何人 clone 后
 * 接上自己的 Supabase 项目，不必改动任何一行代码。
 *
 *   1) 复制 .env.example 为 .env.local（已在 .gitignore 里，不会入库）
 *   2) 填入自己 Supabase 项目的 URL 与 anon key（Supabase 后台 → Project Settings → API）
 *
 * 这两个值本身是**公开信息**：它们会随 JS bundle 发到每个访客的浏览器里，
 * 安全性完全由数据库的行级安全策略（RLS）保证。真正的服务端密钥（service_role）
 * 绝不能出现在前端，也绝不能填进 .env.local。
 */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** 配置缺失时不崩、不白屏，让界面自己解释「你还没配数据库」 */
export const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/*
 * 配置缺失时**不能**调 createClient：它会直接抛出 `supabaseUrl is required.`，
 * 而这发生在模块求值阶段（import 那一刻），React 根本来不及渲染，
 * 结果就是整个页面白屏、控制台一条错误 —— 这正是 2026-09-24 线上黑屏的成因。
 *
 * 这里改为：缺配置时给一个「惰性报错」的替身对象。这样
 *   · 模块可以正常加载，App 能渲染出「请先配置数据库」的说明页；
 *   · 万一有代码绕过检查真的去用它，也是在**调用时**报一句人话，
 *     而不是让整个应用在启动瞬间消失。
 */
function createMissingConfigClient(): SupabaseClient {
  const boom = (): never => {
    throw new Error(
      '尚未配置 Supabase：请在项目根目录创建 .env.local，填入 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY（详见 .env.example）',
    );
  };
  return new Proxy({}, { get: () => boom }) as unknown as SupabaseClient;
}

export const supabase: SupabaseClient = SUPABASE_CONFIGURED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        /* 找回密码 / 邮箱验证回跳时，URL 里会带 access_token（hash 形式），
           这里显式开启解析，否则用户点完邮件链接回来仍是未登录状态。 */
        detectSessionInUrl: true,
      },
    })
  : createMissingConfigClient();

/*
 * 这里原先有一个 uploadResumeFile()（把简历原件传进 Supabase Storage 的 resumes 桶）。
 * 已移除，原因有二：
 *   ① 全站没有任何地方调用它 —— 简历板块登记的是「本机文件路径」，走的是 materials 那套；
 *   ② 该桶从未创建（storage.buckets 里没有 resumes），真调用只会静默失败，
 *      留着就是给下一个维护者埋坑。
 * 若将来想做「简历原件也上云、换设备直接下载」，步骤是：先在 SQL Editor 跑
 * supabase/migrations/002_storage.sql 建桶并配好 storage 策略，再把上传入口接进简历板块。
 */

/** 把 Supabase 的错误对象翻译成人能看懂的中文（登录/网络/RLS 三类） */
export function describeAuthError(err: unknown): string {
  const raw = (err as { message?: string } | null)?.message || String(err || '未知错误');
  if (/Invalid login credentials/i.test(raw)) return '邮箱或密码不正确';
  if (/Email not confirmed/i.test(raw)) return '邮箱尚未验证：请到邮箱点确认链接，或联系站长在后台关闭「Confirm email」';
  if (/User already registered/i.test(raw)) return '该邮箱已注册，直接登录即可';
  if (/Password should be at least/i.test(raw)) return '密码太短，至少 6 位';
  if (/rate limit|too many requests/i.test(raw)) return '请求过于频繁，请稍后再试（免费版对邮件发送有频率限制）';
  /*
   * 网络类错误：只说是「没连上」，并把**怎么自查**讲清楚。
   *
   * 这里原先写的是「检查网络，或该项目在 Supabase 免费版上因长期未用被暂停（后台 Restore 即可）」——
   * 把两个完全不同的原因并列，且没有任何依据去判别，等于让用户自己去猜。
   * 2026 年秋招期间真实发生过误导：用户的注册/登录失败被这句文案指向「项目被暂停」，
   * 反复去后台找 Restore 按钮（而项目根本没暂停，health/signup/token 接口全部正常），
   * 真正的故障（忘了密码）反而被掩盖了。
   *
   * 正确的做法是：只陈述**能确定的事**（请求没到服务器 / 没拿到响应），
   * 把可能的两种原因分开写、并给出**可自查**的路径，而不是替用户下结论。
   * 后端地址也随 BACKEND 走 —— 换成境内节点后，这里不该再提 supabase.com。
   */
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return '连不上云端：检查网络，或该项目在 Supabase 免费版上因长期未用被暂停（后台 Restore 即可）';
  if (/Auth session missing|not authenticated|JWT expired/i.test(raw)) return '登录状态已失效，请重新登录；若确实忘了密码，在登录页点「忘记密码」，把注册邮箱发给站长人工重置';
  if (/should be different from the old password/i.test(raw)) return '新密码不能和旧密码相同';
  if (/New password should be different/i.test(raw)) return '新密码不能和旧密码相同';
  return raw;
}
