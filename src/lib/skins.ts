/**
 * 皮肤市场 · 皮肤定义表
 *
 * 设计口径（改这里之前先读完）：
 *
 * ① **皮肤 ≠ 明暗**。原先只有 `theme: 'dark' | 'light'`，那是「同一套玻璃换个亮度」；
 *    皮肤是更上一层的「设计语言」—— 纸、墨、石墨、青绿，各有一套自己的底色、语义色、
 *    圆角与字体。所以另起一个 `data-skin` 维度，与 `data-theme` 正交：
 *      · `data-skin`  决定「长什么样」（颜色、质感、圆角、字体）
 *      · `data-theme` 决定「亮还是暗」，它会继续驱动 components.css 里那一整套
 *        `:root[data-theme="light"] .badge--ok {…}` 浅色映射（那套规则不要动）
 *    每款皮肤自带一个基调（`theme`），应用皮肤时同步写进 `data-theme`，
 *    这样「既有的一整套浅色覆盖」能被纸质 / 水墨 / 石墨 / 青绿直接复用。
 *
 * ② **明暗不做单独开关**。每款皮肤的明暗由它自己定：极光玻璃的「夜 / 晨」在市场里
 *    就是两张卡（各自一份 data-skin="aurora" + 不同 theme）。
 *    原先顶栏与设置里各有一个「☀️ / 🌙」切换按钮，且只在极光下才有效 —— 那是个
 *    「只对一款皮肤有意义」的按钮，其余皮肤下要么隐藏要么点了没反应，纯属噪音。
 *    现在统一去掉：想换明暗，回市场换另一张卡。`theme` 仍在数据里（导出 / 云同步
 *    都带着它），但它是**皮肤的派生物**，不再有独立的入口。
 *
 * ③ `swatch` 是卡片上那三个色点，**必须与 skins.css 里该皮肤的真实取色一致** ——
 *    色板一旦和实际观感对不上，这块地方就从「预览」变成了「误导」。
 */

export type SkinId =
  | 'aurora-dark'
  | 'aurora-light'
  | 'paper'
  | 'ink'
  | 'graphite'
  | 'eye';

export interface SkinDef {
  id: SkinId;
  /** 市场卡片上的名字 */
  name: string;
  /** 一句话说清它是什么味道（会被完整展示，控制在 30 字内） */
  sub: string;
  /** 落到 <html data-skin> 上的值：多张卡片可以共用同一套样式（极光的夜与晨） */
  skin: string;
  /** 该皮肤自带的明暗基调 → 同步写进 data-theme */
  theme: 'dark' | 'light';
  /** 卡片色板：[底、强调、线]，与 skins.css 的真实取色保持一致 */
  swatch: [string, string, string];
  /** 浏览器 / PWA 状态栏取色（= 该皮肤的页面底色），与 skins.css 里的 --bg-1 一致 */
  themeColor: string;
}

export const SKINS: SkinDef[] = [
  {
    id: 'aurora-dark',
    name: '极光玻璃 · 夜',
    sub: '深空底 + 液态玻璃，站子原来的样子',
    skin: 'aurora',
    theme: 'dark',
    swatch: ['#0b1020', '#a78bfa', '#6ee7ff'],
    themeColor: '#070b18',
  },
  {
    id: 'aurora-light',
    name: '极光玻璃 · 晨',
    sub: '同一套玻璃，搬到日光下',
    skin: 'aurora',
    theme: 'light',
    swatch: ['#f5f7ff', '#a78bfa', '#f472b6'],
    themeColor: '#eef2fb',
  },
  {
    id: 'paper',
    name: '纸 · 手记',
    sub: '暖米纸、陶土橙、衬线标题 —— 像在读一本装订好的册子',
    skin: 'paper',
    theme: 'light',
    swatch: ['#faf9f5', '#d97757', '#e7e3d8'],
    themeColor: '#faf9f5',
  },
  {
    id: 'ink',
    name: '宣纸 · 水墨',
    sub: '宣纸底、墨字、朱砂印 —— 中式线装书的手感',
    skin: 'ink',
    theme: 'light',
    swatch: ['#fbf7ec', '#a63a2e', '#1f1b15'],
    themeColor: '#f6f0e0',
  },
  {
    id: 'graphite',
    name: '石墨 · 极简',
    sub: '纯白底、细黑线、零装饰 —— 瑞士国际主义的克制',
    skin: 'graphite',
    theme: 'light',
    swatch: ['#ffffff', '#18181b', '#e4e4e7'],
    themeColor: '#f4f4f5',
  },
  {
    id: 'eye',
    name: '豆绿 · 护眼',
    sub: 'WPS 护眼绿（#CCE8CF）打底、近黑正文、低饱和 —— 盯一下午也不刺眼',
    skin: 'eye',
    theme: 'light',
    swatch: ['#cce8cf', '#2f7d3e', '#b2d4b6'],
    themeColor: '#cce8cf',
  },
];

export const DEFAULT_SKIN: SkinId = 'aurora-dark';

/**
 * 容错取皮肤定义。
 * 用它的地方有两类，都不能抛错：
 *  · 云端 / 导入包里的 skin 值可能来自更高版本（未知 id）→ 退回默认皮肤，界面照常能用；
 *  · localStorage 里可能存着某个已删掉的皮肤 id → 同上。
 */
export function skinDef(id: unknown): SkinDef {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

/* ------------------------------------------------------------------ *
 * 「上一次用的皮肤」的本地落地
 *
 * 为什么要单独存一份 localStorage（而不只放在整站 state 里）：
 * 皮肤是**首屏就要用**的东西，而整站 state 要等登录 + 云端读回来才知道。
 * 只走 state 的话，登录页永远先用一遍默认皮肤、登录后再闪成用户选的那套；
 * 慢网下这一闪能持续一两秒。这份缓存让「登录页」也能一上来就是对的皮肤。
 * 它只是**渲染提示**，权威值仍在整站 state 里（会跟着账号同步）。
 * ------------------------------------------------------------------ */
export const SKIN_LS_KEY = 'qz.skin';

export function readSavedSkin(): SkinId {
  try { return skinDef(localStorage.getItem(SKIN_LS_KEY)).id; } catch { return DEFAULT_SKIN; }
}

export function writeSavedSkin(id: SkinId): void {
  try { localStorage.setItem(SKIN_LS_KEY, id); } catch { /* 隐私模式下写不进去，不影响使用 */ }
}

/**
 * 把皮肤落到 <html> 上。`data-skin` 与 `data-theme` 必须**成对**写：
 * 皮肤决定设计语言，theme 决定明暗 —— 只写一半会出现「纸的底色 + 深色主题的
 * 语义色映射」这种两套皮肤各出一半的错配。
 */
export function applySkinToDocument(id: SkinId): void {
  const def = skinDef(id);
  const root = document.documentElement;
  root.setAttribute('data-skin', def.skin);
  root.setAttribute('data-theme', def.theme);
  /* 手机装成 PWA 后，状态栏取的是这个 meta —— 不同步会在顶部留一条对不上的色带。
     它跟着皮肤走，所以每次应用皮肤都要重写一遍。 */
  try {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', def.themeColor);
  } catch { /* 某些内嵌 webview 里可能查不到，忽略 */ }
}
