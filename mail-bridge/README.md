# 本地邮件桥

站点「邮件中心」的配套小程序。跑在**你自己的电脑**上，用 IMAP / SMTP 连**你自己的邮箱**，
把收发能力以 `http://localhost:8787` 暴露给网页。

**凭据只存在这台电脑的这个目录里，不经过任何第三方服务器。**

---

## 为什么需要它

浏览器出于安全限制，不可能直接说 IMAP / SMTP 协议，也不该把你的邮箱密码交给任何网站。
所以网页和邮箱之间需要一个跑在本地的小翻译——就是它。不装它也不影响其它功能，
只是「邮件中心」会显示连接引导。

---

## 双击装好（推荐）

在「访达」里双击 **`安装邮件桥.command`**，然后一路按弹窗提示走完即可 ——
不需要打开终端、不需要敲任何命令、不需要手动复制令牌。

它依次做这些事：

1. 检查 8787 端口是否已有桥在跑。**已有就绝不重复安装**（双写会抢端口，表现为「网站还是离线」）；
   如果跑的是别的桥，会先告诉你跑的是什么，再问你要不要替换。
2. 找 Node.js：按候选路径逐个探测。找不到会打开下载页，装好再双击一次即可。
3. 装依赖（已装过则跳过）。
4. 弹窗问你的邮箱和授权码，**按域名自动填好 IMAP / SMTP 服务器**（含端口与 SSL 设置）。
5. 注册成开机自启的后台服务 —— 以后开机就在跑，**不用留着终端窗口**。
6. **真连一次邮箱验证授权码**：连上才说「安装完成」；连不上会打印邮箱服务器的原始错误，
   并告诉你是授权码填错还是地址填错。最后把令牌自动复制到剪贴板。

装完只需做一次收尾：打开网站 → **设置 → 邮件桥** → 地址填 `http://localhost:8787`
（默认值）→ 访问令牌按 **⌘V** 粘贴 → 点「保存并重连」。

想停止或彻底卸载：双击 **`卸载邮件桥.command`**（会问你要不要连授权码一起删掉）。

> 重装不需要先卸载：再双击一次安装文件即可覆盖旧配置，不会装出第二座桥。

---

## 手动安装（双击装不上时、或想自己控制时）

下面的命令都相对于本目录（`mail-bridge/`）。

### 第 1 步：确认有 Node.js

```bash
node -v
```

显示 `v18` 或更高即可。没有的话去 https://nodejs.org 下载 LTS 版装上。

> 注意：如果双击 `.command` 时提示找不到 Node，但你在终端里 `node -v` 是正常的，
> 那是因为双击运行时 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，不含你 `node` 的实际位置。
> 安装器已经处理了这一点（会按候选路径逐个探测）。

### 第 2 步：装依赖并填配置

```bash
cd mail-bridge
npm install
cp bridge.config.example.json bridge.config.json
```

然后编辑 `bridge.config.json`，填四个关键值：

| 字段 | 填什么 |
|---|---|
| `email` | 你的邮箱地址 |
| `authCode` | **授权码 / 应用专用密码**（见下表，不是登录密码！） |
| `imap.host` | 收件服务器 |
| `smtp.host` | 发件服务器 |

常见服务商（端口照抄即可）：

| 服务商 | imap.host | smtp.host | 授权码去哪拿 |
|---|---|---|---|
| QQ 邮箱 | `imap.qq.com` | `smtp.qq.com` | 设置 → 账户 → 开启 IMAP/SMTP 服务 |
| 网易 163 | `imap.163.com` | `smtp.163.com` | 设置 → POP3/SMTP/IMAP → 开启并生成授权码 |
| Gmail | `imap.gmail.com` | `smtp.gmail.com` | 先开两步验证，再生成「应用专用密码」 |
| Outlook / 365 | `outlook.office365.com` | `smtp.office365.com` | smtp 端口填 **587** 且 `secure` 填 **false** |
| 阿里云邮箱 | `imap.aliyun.com` | `smtp.aliyun.com` | 网页版设置里开启并生成客户端密码 |

> **最容易踩的坑**：`authCode` 填成登录密码。几乎每家都会因此报 `AUTHENTICATIONFAILED`，
> 而桥会把这条错误直接翻成中文提示告诉你。

### 第 3 步：启动，把令牌粘进网站

```bash
npm start
```

终端会打印一个 48 位令牌：

```
  访问令牌（复制这串，粘到网站的「设置 → 邮件桥 → 访问令牌」）：

    a1b2c3d4e5f6....（48 位）
```

打开网站 → **设置 → 邮件桥** → 地址填 `http://localhost:8787`（默认值）→ **访问令牌**粘进去
→ 点「保存并重连」。状态变成「在线」就通了。

> 手动 `npm start` 的窗口**关掉服务就停了**，重启电脑也不会自动运行 —— 这是双击安装器
> 改用 launchd 开机自启的原因。手动方式适合调试，长期使用建议用安装器。

### 第 4 步（可选）：让它在后台自动运行

如果不想每次开终端，把 `npm start` 注册成开机自启（macOS）：

```bash
cat > ~/Library/LaunchAgents/com.xianlinglong.qz-mail-bridge-manual.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.xianlinglong.qz-mail-bridge-manual</string>
<key>ProgramArguments</key><array>
<string>$(command -v node)</string><string>$PWD/server.mjs</string></array>
<key>WorkingDirectory</key><string>$PWD</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xianlinglong.qz-mail-bridge-manual.plist
```

**label 必须与已有的桥区分开**（`...-dsh` 是 DSH 托管桥，`com.qiuzhao.mailbridge` 是更早的残留）。
用别人的 label 会 `bootout` 并覆盖掉那座桥的 plist，把它连配置一起顶掉。

> 注意：`QZ_BRIDGE_TOKEN` 若想固定，写进 plist 的 `EnvironmentVariables`
> （见 `server.mjs:79`：优先读环境变量，其次读 `bridge.token` 文件，都没有才生成新的）。
> 这样就不用让用户去读文件、手抄那 48 位令牌了 —— 少一个人工环节就少一类假故障。

---

## 先试试能不能通（不想立刻填邮箱）

```bash
npm run demo
```

演示模式会返回一封假的收件箱（面试通知、测评邀请、投递确认各一封），
用来确认**网站和桥之间是通的**。网站那边显示在线、能看到三封邮件，就说明安装没问题；
之后再换成真实配置即可。

---

## 常见问题

**网站显示「离线」怎么办？**
先用安装器装的人：双击 `安装邮件桥.command` 会告诉你在不在跑；也可以直接看
`~/Library/LaunchAgents/com.xianlinglong.qz-mail-bridge-standalone.plist` 并在终端执行
`launchctl print gui/$(id -u)/com.xianlinglong.qz-mail-bridge-standalone`。
手动 `npm start` 的人：确认窗口还开着（关掉窗口服务就停了）。
然后在网站点「测试连接」。如果桥在跑但仍显示离线，多半是**令牌没填或填错**——
桥会把这种情况明确报出来（其它接口会返回「访问令牌不正确或未填写」）。

**提示「登录邮箱失败」？**
`authCode` 用的多半是登录密码。回第 2 步换成授权码。另外注意有些服务商（如 Gmail）
必须先在网页端把 IMAP 打开，否则即使密码对了也连不上。

**怎么确认邮箱真的连上了？**
光看安装器打印「完成」不够 —— 桥的 IMAP 连接是**懒加载**的，启动成功不代表授权码对
（`/api/me` 甚至只回读配置文件里的 email、根本不连邮箱，授权码错了它照样返回 200）。
判断标准只有一个：`/api/list` 拿到 200。安装器就是这么验的：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -m 30 \
  -H "X-QZ-Token: $(cat bridge.token 2>/dev/null || echo 你的令牌)" \
  "http://127.0.0.1:8787/api/list?dir=inbox&limit=1"
# 200=连上了；500=桥活着但连不上邮箱（授权码/服务器地址/网络）；401=令牌不对
```

**能收到邮件，但「已发送」是空的？**
各家「已发送」文件夹名不一样。桥会自动猜，猜不中就手动填
`bridge.config.json` 里的 `sentFolder`（例如 `Sent` 或 `已发送`）。

**邮件内容会被上传到网站服务器吗？**
不会。桥只在你电脑和邮箱服务器之间通信；网页直接请求 `localhost`，涉密内容不出本机。
网站的登录与数据同步用的是另一套（Supabase），与这里无关。

**安全吗？**
三个约束：① 只监听 `127.0.0.1`，局域网内其它机器访问不到；② 除健康检查外所有接口都要求 48 位令牌，
别的网页即使探测到这个端口也读不到你的邮件；③ 令牌保存在 `bridge.token`（权限 600），
凭据保存在 `bridge.config.json`——这两个文件都不要提交到 git、不要发给别人。

**卸载后授权码还在吗？**
`卸载邮件桥.command` 会单独问你要不要删除 `bridge.config.json`（里面含授权码）：
默认**保留**，方便以后重装不用重填；选删除则彻底清掉（令牌文件 `bridge.token` 也会保留）。

---

## 接口一览（想自己实现一个别的语言的桥时看这里）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/health` | `{ ok: true }`（**不需要令牌**，供网页探测在线状态） |
| GET | `/api/me` | `{ email, name }` |
| GET | `/api/list?dir=inbox\|sent&limit=25` | `{ messages: MailMessage[] }` |
| GET | `/api/read?id=<dir:uid>` | `{ message: MailMessage }` |
| GET | `/api/search?q=&dir=&limit=` | `{ messages: MailMessage[] }` |
| POST | `/api/send` | 见下 |

除健康检查外，所有请求都要带请求头 `X-QZ-Token: <48 位令牌>`。

`MailMessage` 形状：

```ts
{
  id: string;              // `${dir}:${uid}`
  subject: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  created_at: string;      // ISO
  snippet: string;
  is_read: boolean;
  has_attachments: boolean;
  dir: string;
  body?: string;           // 仅 /api/read 返回
  body_is_html?: boolean;
}
```

`POST /api/send` 是**两阶段**的：邮件发出去撤不回，这一步防的是误点。

- 第一次不带 `confirmation_token` → 返回 `{ need_confirm: true, confirmation_token, summary }`，
  网页把 `summary` 显示给用户确认；
- 第二次带 `confirmation_token` → 真正发送，返回 `{ sent: true, message_id }`。

请求体：`{ to: string[], subject: string, body: string, cc?: string[], bcc?: string[],
confirmation_token?: string, attachments?: { filename, dataBase64 }[] }`
