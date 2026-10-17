---
name: qiuzhao-resume-hub
description: 从零复刻一套「求职进程管理中心」个人网站（岗位追踪 / 投递看板 / 日历提醒 / 网申资料库 / 简历导出 / 面试复盘 / Offer 对比 / AI 助手）。当用户说「复刻这个网站」「搭一个秋招网申网站」「做一个求职管理/投递追踪工具」「照 resumeself 做一个我自己的」时使用。包含从 Supabase 建库、Vercel 部署、买域名到换成国内云/自建后端的完整升级路线。
---

# 复刻「求职进程管理中心」网站

## 这套东西是什么

一个**只用前端 + 一个托管数据库**就能跑起来的个人求职管理站。它不是模板站，
核心价值在「三库对账」：**网申资料库 ↔ 岗位库 ↔ 投递记录 ↔ 日历提醒** 全量联动，
投递状态一变，岗位卡、截止提醒、日历事件同步更新。

技术底子是 Vite 5 + React 18 + TypeScript，后端只依赖 Supabase（Auth + Postgres）。
没有自建服务器，没有需要运维的进程。

代码来源：<https://github.com/你的账号/resumeself>（或用户自己已有的仓库）。

---

## 第 0 步：先明确复刻深度

**动手前必须问用户**，不同答案后面步骤差很多：

| 用户想要 | 该走的路线 |
|---|---|
| 只想有个能用的站，数据在自己账号 | 走 A 线（Supabase + Vercel，30 分钟） |
| 要给朋友/同学一起用 | 走 A 线 + 第 5 步（多用户已内建，开注册即可） |
| 不想依赖 Supabase / 要数据完全自持 | 走 B 线（换自建 Postgres 或纯本地模式） |
| 面向国内用户、要快 | 走 C 线（国内云 + 备案 + 换数据库） |
| 只是想要个界面壳子改字段 | 也走 A 线，第 4 步改词表即可 |

---

## A 线：Supabase + Vercel（默认路线）

### 1. 拿到代码

```bash
git clone https://github.com/你的账号/resumeself.git
cd resumeself
npm install
```

### 2. 建数据库（Supabase）

1. 到 <https://supabase.com> 新建项目（免费版够用），记下项目 ref。
2. 打开 **SQL Editor**，依次执行仓库里的迁移：
   - `supabase/migrations/001_init.sql` —— 建表 + 行级安全策略（RLS）
   - `supabase/migrations/003_touch_updated_at.sql` —— **必跑，不是可选**

   > `002_storage.sql` 是早期原型的简历上传桶，现在**不需要跑**。

   **为什么 003 必跑**：`profiles.updated_at` 若只有 `DEFAULT NOW()`，
   那个默认值**只在 INSERT 时生效**；走 upsert 的 UPDATE 分支时
   **客户端传什么就存什么**。于是「服务端时间」实际是写入设备的本机时钟 ——
   设备 B 时钟慢两小时，它后改的数据时间戳反而更早，设备 A 会判定「云端不比我的新」，
   既不提醒也不拦截，下次写入就把 B 的改动整片覆盖。触发器把 `NEW.updated_at`
   强制改成 `NOW()`，这类静默覆盖才会消失。

3. **关掉邮箱验证**：Authentication → Sign In / Providers → Email → 关掉 `Confirm email`。
   不关的话新用户注册完是「未验证」状态登不进来，而免费版内置 SMTP 送达率很低，会把注册流程卡死。

### 3. 配置环境变量

```bash
cp .env.example .env.local
```

填入 Supabase 后台 → Project Settings → API 里的 `URL` 与 `anon key`。

> 这两个值是**公开信息**（随前端 bundle 发出去），安全性由 RLS 保证。
> **`service_role` key 绝不能进前端，也绝不能填进 `.env.local`。**

（可选）`VITE_ADMIN_CONTACT` 填站长邮箱，用于「忘记密码」时让用户把邮箱发给你人工重置。

### 4. 本地跑起来 + 换掉行业词表

```bash
npm run dev      # http://localhost:5173
```

到这一步网站已经能用了。**要改成你自己的行业**，改这几处：

| 想改什么 | 改哪里 |
|---|---|
| 资料库的字段（12 大板块） | `src/data/formSchema.ts` |
| 初始板块与导航 | `src/lib/modules.ts`、`src/components/layout/nav.ts` |
| 公司/行业词表与归并规则 | `src/lib/company.ts`、`src/lib/jobMeta.ts` |
| 自动归类的匹配逻辑 | `src/lib/dedupe.ts` |
| 首页文案与特性列表 | `src/components/modules/Login.tsx` 的 `FEATURES` |

> 注意 `Login.tsx` 的特性列表**只写已经跑通的能力**。删掉没实现的功能，
> 比留着一条做不到的承诺要好。

### 5. 部署到 Vercel

```bash
npm i -g vercel
vercel --prod
```

在 Vercel 项目的 **Settings → Environment Variables** 里加上 `.env.local` 里那两个变量，
然后重新部署一次（环境变量不会作用于已构建的产物）。

`vercel.json` 已配好三件容易被忽略的事，别删：

- `/assets/*` 返回**真 404** —— 否则 SPA 回退会把 HTML 当 JS 返回，报错信息极难定位；
- `/sw.js` 显式 `no-cache` —— 否则 Service Worker 更新不生效，用户永远停在旧版本；
- 其余路径 `no-store` —— 保证用户拿到的总是最新壳子。

`api/webdav.js` 是全站唯一的服务端代码（无状态转发，不存任何数据）。

### 6. 冒烟验证（别跳过）

```bash
npm run build && npm run preview     # 另开一个终端
node scripts/qa-webdav-guard.mjs     # /api/webdav 安全回归：SSRF / CORS / 体积
```

再手工点一遍：**新建一条投递 → 刷新页面 → 数据还在** → 换个浏览器登录同账号 → 数据同步过来了。
这三下能覆盖 90% 的「配错了」。

---

## B 线：不想要 Supabase

### B1. 换自建 Postgres（Supabase 是托管 Postgres，代码改动很小）

Supabase 的客户端库只用到两件事：**Auth** 和**一张 `profiles` 表**。
自建的话：

1. 后端暴露两个端点：`POST /auth/token`（发 JWT）、`GET|POST /profile`（读写整份 JSON 文档）。
2. 把 `src/lib/supabase.ts` 换成你自己的客户端封装，保持导出签名不变
   （`supabase`、`describeAuthError`、`INITIAL_RECOVERY`），上层组件就不用动。
3. 数据模型照抄这个设计：**整站状态序列化成一份 JSON 文档**存一行，
   `UNIQUE(user_id)`，一次 upsert 原子落盘。

   > 为什么不是拆成 7 张表：拆表后每次保存要「先全删再全插」7 轮请求，
   > 任一轮失败就停在半同步态（投递删了但岗位卡还在）；加载失败导致内存为空时，
   > 下一轮保存还会把云端整表抹掉。单文档一次解决这三类问题。

### B2. 完全不要后端（纯本机模式）

仓库本身支持不连云：`CloudBoot` 为 `undefined` 时就是纯本机模式，
数据只落在 `localStorage`，靠「设置 → 导出/导入 JSON」在设备间搬运。
想做成纯本地版：删掉 `Login.tsx` 的登录门、`src/lib/supabase.ts`，
让 `store.tsx` 始终以 `undefined` 启动即可。

**代价**：换设备要手动导出导入，且 PWA 挂后台久了有覆盖风险（需要保留 `storage` 事件那套逻辑）。

---

## C 线：面向国内用户（要快、要备案）

国内用户直连 Vercel 常常慢或不稳。要真做国内版：

| 项 | 做法 | 注意 |
|---|---|---|
| 托管 | 阿里云 OSS + CDN / 腾讯云 COS + CDN，或轻量服务器 + Nginx | 纯静态站，CDN 最省事 |
| 域名 | 阿里云/腾讯云买 `.cn` 或 `.com` | 约 ¥30–80/年 |
| 备案 | **必须**，未备案的域名国内 CDN 会拒绝接入 | 周期约 1–3 周，要提前规划 |
| 数据库 | 换国内 Postgres（阿里云 RDS / 腾讯云 CDB），或干脆走 B2 纯本机 | 免备案数据库跨地域访问延迟高 |
| 邮件 | Supabase 免费 SMTP 送达率低；国内换成阿里云邮件推送 / 腾讯云 SES | 不换就别做自助找回密码 |

**备案是这条路线的真正门槛**，要提前跟用户讲清楚，别让他以为改个配置就行。

---

## 上线前必查的 6 个坑

这些坑的共同点是：**页面看起来正常，只有某个功能静默失效**。

1. **域名改了但 CORS 名单没改** → 站点照常打开，**只有「网盘同步」403**。
   改项目名 / 加自定义域名时，必须同步改 `api/webdav.js` 的 `DEFAULT_ORIGINS`
   或环境变量 `QZ_ALLOWED_ORIGINS`。这是最难联想到域名的一类故障。

2. **Supabase 的 Redirect URLs 没配** → 注册验证邮件与重置密码邮件里的链接把用户
   重定向到 `Site URL`（默认 `http://localhost:3000`），用户点进去是打不开的页面，
   而 Supabase 面板上**不会有任何报错**。把正式域名与 `localhost:5173` 一起加进去。

3. **CORS 回 `*`** → 公开站上等于任何网站都能借访客浏览器把你当免费代理
   （借你的出口 IP 绕过各种限制）。只对白名单来源回 CORS 头，其他一律 403。
   不带 Origin 的请求（curl）仍放行。

4. **SSRF 判定要做规范化之后再做**。只比对字面量会被这些写法绕过：
   `http://2130706433/`（十进制整数）、`http://0x7f000001/`、`http://127.1/`、
   `http://[::1]/`（注意 `new URL().hostname` **保留方括号**，`h === '::1'` 会漏）。
   改完跑 `node scripts/qa-webdav-guard.mjs`。

5. **PWA 缓存导致改了没生效** → Service Worker 会把旧壳子钉住。`sw.js` 必须 no-cache，
   且改完让用户**硬刷新**一次。

6. **「以为存上了其实没存」** —— 这类站最致命的体验问题。写失败必须冒泡到界面，
   绝不静默。改动先写 `localStorage`（断网不丢），再 700ms 防抖 + 单飞推云端。

---

## 优化方案（用户问「能不能更好」时给这些）

- **买自己的域名**：现在用的免费子域是 `resumeself.vercel.app`。要换成自定义域名（约
  ¥55–80/年），在注册商处加两条 A 记录指向 `76.76.21.21`（Vercel），或把 nameserver
  换成 `ns1.vercel-dns.com` / `ns2.vercel-dns.com`。
  **还须同步 `api/webdav.js` 的 `DEFAULT_ORIGINS`**，否则站点照常打开、只有「网盘同步」会 403。
  注意 `resumeself.com` 这个域名**从未注册过**，绑在项目上也不会解析 —— 别把它当可用地址。
- **邮件中心**：仓库带一个 `mail-bridge/`，跑在用户自己电脑上，让网站能收发邮件并自动
  识别面试/笔试通知回写投递状态。**浏览器不允许网页直连 IMAP/SMTP，也不该把邮箱密码
  交给任何网站**，所以这必须是个本机小服务。它是**可选的**，不装网站照常使用。
  装法见 `mail-bridge/README.md`；注意它只监听 `127.0.0.1`，且除 `/api/health`
  外所有端点都要校验 `X-QZ-Token`。
- **数据自持**：接用户自己的 WebDAV（坚果云等）做备份。凭据只存本机，经
  `/api/webdav` 无状态转发绕开 CORS，**不进数据库**。
- **AI 助手**：用用户自己的 API Key，请求从浏览器直连服务商，**站点不代转**。
  代价是 Key 不跨设备同步 —— 这是有意的取舍，避免密钥进数据库。
- **多端一致**：已内建跨设备与跨标签页防覆盖。改这块前先读代码里的 5 条纪律注释，
  每一条都对应一个真实踩过的坑。

---

## 交付判定

复刻成功的标准（逐条确认，别跳）：

- [ ] `npm run dev` 能起来，注册 → 登录 → 填资料 → 刷新数据还在
- [ ] `001_init.sql` 与 `003_touch_updated_at.sql` 都跑过
- [ ] Supabase 关了 `Confirm email`，Redirect URLs 里有正式域名
- [ ] 部署后配了环境变量，并**重新部署**过一次
- [ ] 换个浏览器登录同账号，数据能同步过来
- [ ] `node scripts/qa-webdav-guard.mjs` 全绿
