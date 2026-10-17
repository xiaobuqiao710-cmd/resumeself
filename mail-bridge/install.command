#!/bin/bash
#
# 秋招网申辅助中心 · 邮件桥一键安装器（macOS）
# ==========================================================================
# 用法：在「访达」里双击本文件即可。不需要打开终端、不需要敲任何命令。
#
# 它做四件事：
#   ① 检查 Node.js（不够就教你装，并直接打开下载页）
#   ② 安装依赖（npm install，只做一次）
#   ③ 用原生对话框问你的邮箱与授权码，自动识别服务商填好收/发件服务器
#   ④ 装成开机自启的后台服务，并把令牌自动写好 —— 用户不需要复制粘贴任何东西
#
# 设计原则（每条都对应一个真实踩过的坑，改之前请先读）：
#   · 幂等：重复双击不会装出两座桥。已有桥在跑时直接跳到「接管令牌」。
#     两座桥同时抢 8787 的表现是「网站显示离线」，极难归因 —— 必须由安装器堵死。
#   · 双击时 PATH 不含 ~/.local/lib/nodejs/bin（Terminal.app 才会带上 ~/.zprofile），
#     所以 Node 必须**显式按路径探测**，不能只靠 `which node`。
#   · 授权码填错也能装上：server.mjs 的 IMAP 连接是懒加载（首次拉信才连），
#     启动时不会报错。所以安装结束必须**主动验证一次真实登录**，否则用户会带着
#     「装好了但一直离线」的状态离开。
#   · 令牌写进 launchd 环境变量 QZ_BRIDGE_TOKEN（server.mjs:79 优先读它），
#     而不是让用户去 `cat bridge.token` 再手抄 —— 手抄环节是最大的人为错误源。
# ==========================================================================

set -uo pipefail

# ---------------------------------------------------------------------------
# 自我修复执行位（必须放在最前面，且在任何 cd 之前）。
#
# 为什么需要：从网站下载 .command 时，浏览器**不会保留文件权限**，落盘就是 644。
# 实测（macOS 26.6.2）：644 的 .command 在访达里双击**毫无反应**，也不报错 ——
# 用户只会以为「装了但没反应」。所以脚本必须自己把 x 位补上。
#
# 关键限制：一个没有 x 位的脚本被 bash 执行时，它是能跑起来的（访达/终端调 bash 时
# 不检查 x 位），但**无法用 `exec "$0"` 重新启动自己**（没有 x 位 exec 会失败）。
# 所以这里只 chmod，不重新 exec：已经跑起来的这份进程继续往下走即可，效果一样。
# ---------------------------------------------------------------------------
SELF_PATH="${BASH_SOURCE[0]}"
if [ -f "$SELF_PATH" ] && [ ! -x "$SELF_PATH" ]; then
  chmod u+x "$SELF_PATH" 2>/dev/null \
    || /bin/chmod u+x "$SELF_PATH" 2>/dev/null \
    || true
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

CONFIG_PATH="$HERE/bridge.config.json"
TOKEN_PATH="$HERE/bridge.token"
# 注意：这个 label 必须与其它桥的 label **区分开**。
#   · com.xianlinglong.qz-mail-bridge-dsh  → 本机另一套「DSH 托管桥」在用（standalone.mjs）
#   · com.qiuzhao.mailbridge               → 更早的历史残留
# 如果本安装器沿用它们的 label，`bootout` + 覆盖 plist 会把正在工作的那座桥
# **连配置一起顶掉** —— 用户只是想装个桥，结果把原来能用的那套弄坏了。
# 所以这里用独立 label，两座桥互不干涉（它们靠端口区分，见下面的冲突处理）。
LABEL="com.xianlinglong.qz-mail-bridge-standalone"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.dsh/mail-bridge"
PORT="${QZ_BRIDGE_PORT:-8787}"

# ── 输出风格：双击运行时窗口是唯一的信息通道，用色块和图标保证一眼能扫 ──
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; CYN=$'\033[36m'
else
  B=''; DIM=''; R=''; GRN=''; RED=''; YEL=''; CYN=''
fi
line() { printf '%s\n' "────────────────────────────────────────────────────────────"; }
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s %s%s\n' "${GRN}✓${R}" "$*" ""; }
warn() { printf '%s %s%s\n' "${YEL}!${R}" "$*" ""; }
die()  { printf '\n%s %s\n\n' "${RED}✗ 安装中止：${R}" "$*" >&2; printf '%s\n\n' "遇到解决不了的问题，把本窗口的内容截图发给站长即可。" >&2; exit 1; }

# 原生对话框（osascript）。取消/关闭返回非 0，由调用方决定怎么处理。
ask() { osascript -e "display dialog \"$1\" default answer \"$2\" with title \"$3\" buttons {\"取消\", \"$4\"} default button \"$4\"" -e 'text returned of result' 2>/dev/null; }
alert() { osascript -e "display dialog \"$1\" with title \"$2\" buttons {\"好\"} default button \"好\" $3" >/dev/null 2>&1; }

clear
say ""
printf '%s\n' "${B}  秋招网申辅助中心 · 邮件桥一键安装${R}"
line
say "  邮件桥是跑在${B}你自己电脑${R}上的一个小服务，让网站的「邮件中心」"
say "  能读你的邮箱。${DIM}浏览器没法直接连 IMAP，也不该把邮箱密码交给任何网站。${R}"
say ""
say "  下面全程用弹窗操作，你${B}不需要输入任何命令${R}。"
say "  邮箱授权码只写进本机文件，不会上传到任何服务器。"
line
say ""

# ══════════════════════════════════════════════════════════════════
# 第 0 步：先看看这个端口是不是已经有桥了
#
#   这不是「省事」，而是防止双写的唯一关口。已有桥在跑时再启一座，第二座会因端口
#   占用起不来，而用户看到的现象只是「网站还是离线」，完全联想不到是端口冲突 ——
#   属于最难归因的一类故障。所以这里探测到在线就**绝不**再装一座。
#
#   但「已在运行」不等于「不用做事」：用户可能正用着别人的桥（如 DSH 托管桥），
#   自己却不知道令牌是什么。所以这种情况要问清楚他想怎么办，而不是默默跳过。
# ══════════════════════════════════════════════════════════════════
say "${B}① 检查端口 $PORT${R}"

BRIDGE_INFO="$(curl -fsS -m 4 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"
if [ -n "$BRIDGE_INFO" ]; then
  ok "端口 $PORT 上已有一座邮件桥在运行"
  say "  ${DIM}$BRIDGE_INFO${R}"
  say ""
  # 认出是谁在跑：本安装器自己装的？还是 DSH 托管桥 / 别的东西？
  RUNNER="其它程序"
  case "$BRIDGE_INFO" in
    *dsh-mail-bridge*) RUNNER="DSH 托管邮件桥" ;;
  esac
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    RUNNER="本安装器此前装的邮件桥"
  fi
  say "  运行中的是：${B}$RUNNER${R}"
  say ""
  say "  ${B}两座桥不能同时占用同一个端口${R}，所以这里不能直接再装一座。"
  say "  如果你的「邮件中心」现在就能正常收发邮件，${B}什么都不用做${R}，关掉本窗口即可。"
  say ""
  if ! osascript -e "display dialog \"端口 $PORT 上已经有邮件桥在运行。\\n\\n运行中的是：$RUNNER\\n\\n如果网站的「邮件中心」现在能正常收发邮件，就什么都不用做 —— 点「取消」关掉本窗口即可。\\n\\n如果想用本安装器重新装一座（会先停掉当前这座、并用你的邮箱重新配置），点「继续安装」。\" with title \"已经有一座桥在运行\" buttons {\"取消\", \"继续安装\"} default button \"取消\" with icon caution" >/dev/null 2>&1; then
    say "  用户选择保留现有邮件桥，未做任何改动。"
    say ""
    exit 0
  fi
  say ""
  # 用户明确要求重装：先停掉占端口的那个（若是本安装器自己的，按 label 停）
  say "  正在停掉现有邮件桥…"
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  fi
  # 不是本安装器装的（如 DSH 托管桥）：按端口找出进程停掉，避免用户以为装了新的、
  # 实际跑的还是旧的 —— 那会导致「配置改了但行为没变」的诡异现象。
  OLD_PIDS="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)"
  for p in $OLD_PIDS; do
    [ -n "$p" ] && kill "$p" 2>/dev/null && say "  ${DIM}已停止 PID $p${R}"
  done
  sleep 2
  if curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say ""
    die "端口 $PORT 仍被占用，无法安装。请先停掉占用它的程序：\n    lsof -nP -iTCP:$PORT -sTCP:LISTEN\n  或重启电脑后再试。"
  fi
  ok "端口 $PORT 已释放"
  ALREADY_RUNNING=0
else
  ok "端口 $PORT 空闲，可以安装"
  ALREADY_RUNNING=0
fi
say ""

# ══════════════════════════════════════════════════════════════════
# 第 1 步：找 Node.js
#   双击运行的 .command 由 launchd 拉起，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
#   不含 ~/.local/lib/nodejs/bin —— 而那正是本机 node 的安装位置。
#   所以必须逐个候选路径探测，`which node` 在双击场景下会误报「没装 Node」。
# ══════════════════════════════════════════════════════════════════
say "${B}② 检查 Node.js${R}"

NODE_BIN=""
for cand in \
  "$(command -v node 2>/dev/null)" \
  "$HOME/.local/lib/nodejs/bin/node" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node" \
  "$HOME/.nvm/versions/node/"*/bin/node
do
  [ -n "$cand" ] && [ -x "$cand" ] && { NODE_BIN="$cand"; break; }
done

if [ -z "$NODE_BIN" ]; then
  warn "本机没找到 Node.js —— 邮件桥需要它才能运行。"
  say ""
  say "  接下来会${B}自动打开 Node.js 官网${R}，你下载 LTS 版、一路点「继续」装好后，"
  say "  ${B}再双击一次本文件${R}即可。"
  say ""
  osascript -e 'display dialog "还没装 Node.js。\n\n点「打开下载页」后，在网页上点绿色的 LTS 按钮下载，双击 .pkg 一路继续装完，再回来双击一次「安装邮件桥.command」即可。" with title "还差一步：装 Node.js" buttons {"取消", "打开下载页"} default button "打开下载页"' >/dev/null 2>&1 \
    && open "https://nodejs.org/zh-cn/download"
  say "  ${DIM}（也可以在终端执行：brew install node）${R}"
  exit 0
fi

NODE_VER="$("$NODE_BIN" -v 2>/dev/null || echo unknown)"
NODE_MAJOR="$(printf '%s' "$NODE_VER" | sed 's/^v//; s/\..*//')"
if [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null; then
  die "Node.js 版本过低（当前 $NODE_VER，需要 18 或更高）。请到 https://nodejs.org 装新版后重试。"
fi
ok "Node.js $NODE_VER  ${DIM}($NODE_BIN)${R}"
# 让后续 npm/node 调用用同一个解释器，避免「检测到的」和「实际跑的」不是同一个
export PATH="$(dirname "$NODE_BIN"):$PATH"
say ""

# ── 已经装过桥：跳过安装，直奔令牌 ────────────────────────────────
if [ "$ALREADY_RUNNING" = "1" ]; then
  manage_token_only=1
else
  manage_token_only=0
fi

if [ "$manage_token_only" = "0" ]; then
# ══════════════════════════════════════════════════════════════════
# 第 2 步：装依赖
# ══════════════════════════════════════════════════════════════════
say "${B}③ 安装依赖${R} ${DIM}(首次约 10–30 秒)${R}"

if [ -d "$HERE/node_modules/imapflow" ] && [ -d "$HERE/node_modules/mailparser" ] && [ -d "$HERE/node_modules/nodemailer" ]; then
  ok "依赖已存在，跳过"
else
  say "  ${DIM}正在下载 imapflow / mailparser / nodemailer …${R}"
  if ! NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false /usr/bin/env npm install --omit=dev --no-audit --no-fund >/tmp/qz-bridge-install.log 2>&1; then
    say ""
    die "依赖安装失败。日志末尾：\n$(tail -n 12 /tmp/qz-bridge-install.log | sed 's/^/    /')"
  fi
  ok "依赖安装完成"
fi
say ""

# ══════════════════════════════════════════════════════════════════
# 第 3 步：问邮箱（原生弹窗），自动识别服务商
# ══════════════════════════════════════════════════════════════════
say "${B}④ 填写邮箱信息${R}"

# 已经填过就沿用，避免每次重装都重新输入授权码
PRESET_EMAIL=""
PRESET_NAME=""
if [ -f "$CONFIG_PATH" ]; then
  PRESET_EMAIL="$(/usr/bin/python3 -c "import json,sys;print(json.load(open('$CONFIG_PATH')).get('email',''))" 2>/dev/null || echo '')"
  PRESET_NAME="$(/usr/bin/python3 -c "import json,sys;print(json.load(open('$CONFIG_PATH')).get('name',''))" 2>/dev/null || echo '')"
fi

EMAIL=""
while [ -z "$EMAIL" ]; do
  EMAIL="$(ask "请输入你的邮箱地址：\\n\\n（例如 you@qq.com、you@163.com、you@gmail.com）" "${PRESET_EMAIL}" "邮件桥安装 · 第 1/2 步" "下一步")"
  if [ -z "$EMAIL" ]; then
    osascript -e 'display dialog "安装已取消，没有做任何改动。" with title "已取消" buttons {"好"} default button "好"' >/dev/null 2>&1
    say "  用户取消，未做任何改动。"
    exit 0
  fi
  case "$EMAIL" in
    *@*.*) : ;;
    *) alert "这不是一个合法的邮箱地址，请重新输入。" "格式不对" ""; EMAIL="" ;;
  esac
done

# 按域名自动认出服务商 —— 绝大多数人不用知道 imap/smtp 是什么
DOMAIN="${EMAIL##*@}"
IMAP_HOST=""; SMTP_HOST=""; SMTP_PORT=465; SMTP_SECURE="true"
case "$DOMAIN" in
  qq.com)                  IMAP_HOST="imap.qq.com";           SMTP_HOST="smtp.qq.com";;
  foxmail.com)             IMAP_HOST="imap.qq.com";           SMTP_HOST="smtp.qq.com";;
  163.com)                 IMAP_HOST="imap.163.com";          SMTP_HOST="smtp.163.com";;
  126.com)                 IMAP_HOST="imap.126.com";          SMTP_HOST="smtp.126.com";;
  yeah.net)                IMAP_HOST="imap.yeah.net";         SMTP_HOST="smtp.yeah.net";;
  gmail.com)               IMAP_HOST="imap.gmail.com";        SMTP_HOST="smtp.gmail.com";;
  outlook.com|hotmail.com|live.com|outlook.jp|outlook.com.cn)
                           IMAP_HOST="outlook.office365.com"; SMTP_HOST="smtp.office365.com"; SMTP_PORT=587; SMTP_SECURE="false";;
  aliyun.com)              IMAP_HOST="imap.aliyun.com";       SMTP_HOST="smtp.aliyun.com";;
  exmail.qq.com)           IMAP_HOST="imap.exmail.qq.com";    SMTP_HOST="smtp.exmail.qq.com";;
  *)                       IMAP_HOST="imap.$DOMAIN";          SMTP_HOST="smtp.$DOMAIN";;
esac

HINT="请到邮箱网页版的「设置」里开启 IMAP/SMTP 服务，会给你一串授权码。"
case "$DOMAIN" in
  qq.com|foxmail.com) HINT="QQ邮箱：网页版 → 设置 → 账户 → 找到「IMAP/SMTP服务」开启，按提示发短信，会给你一串授权码。";;
  163.com|126.com|yeah.net) HINT="网易邮箱：网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP，生成授权码。";;
  gmail.com) HINT="Gmail：先在账号里开启「两步验证」，再生成「应用专用密码」（16 位）。注意国内网络访问可能需要代理。";;
  outlook.com|hotmail.com|live.com) HINT="Outlook：在账号安全设置里开启两步验证后，生成「应用密码」。";;
  aliyun.com) HINT="阿里云邮箱：网页版设置里开启 IMAP/SMTP，生成客户端密码。";;
esac

AUTH=""
while [ -z "$AUTH" ]; do
  AUTH="$(ask "请输入邮箱的「授权码」。\\n\\n${HINT}\\n\\n⚠️ 不是你平时登录邮箱的那个密码 —— 填成登录密码几乎一定会失败。" "" "邮件桥安装 · 第 2/2 步" "完成安装")"
  if [ -z "$AUTH" ]; then
    osascript -e 'display dialog "安装已取消，没有做任何改动。" with title "已取消" buttons {"好"} default button "好"' >/dev/null 2>&1
    say "  用户在授权码这一步取消，未写入任何配置。"
    exit 0
  fi
done

ok "邮箱：$EMAIL"
ok "收件服务器：$IMAP_HOST　发件服务器：$SMTP_HOST"

# 写配置。权限 600：这个文件里有授权码。
cat > "$CONFIG_PATH" <<JSON
{
  "_说明": "由「安装邮件桥.command」生成。这个文件里是你的邮箱授权码，不要提交到 git、不要发给别人。",
  "email": "$EMAIL",
  "name": "${PRESET_NAME}",
  "authCode": "$AUTH",
  "imap": { "host": "$IMAP_HOST", "port": 993, "secure": true },
  "smtp": { "host": "$SMTP_HOST", "port": $SMTP_PORT, "secure": $SMTP_SECURE },
  "sentFolder": "",
  "allowOrigins": ["*"]
}
JSON
chmod 600 "$CONFIG_PATH" 2>/dev/null || true
ok "配置已写入 bridge.config.json ${DIM}(权限 600，仅本机可读)${R}"
say ""
fi  # manage_token_only

# ══════════════════════════════════════════════════════════════════
# 第 4 步：装成开机自启的后台服务
#
# 为什么用 launchd 而不是「留一个终端窗口开着」：
#   关掉窗口服务就停，用户下次打开网站发现「邮件中心又离线了」，
#   但他以为自己已经装好了 —— 这类「装了但没运行」的困惑占了支持问题的多数。
# 为什么令牌走环境变量：
#   用户不需要去 cat bridge.token 再手抄 48 位十六进制串。少一个人工环节，
#   就少一类「令牌填错 → 网站显示离线 → 以为安装失败」的假故障。
# ══════════════════════════════════════════════════════════════════
say "${B}⑤ 注册后台服务${R}"

mkdir -p "$LOG_DIR"

# 令牌：优先沿用已有的，没有就生成一个
if [ -f "$TOKEN_PATH" ] && [ -s "$TOKEN_PATH" ]; then
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_PATH")"
  ok "沿用已有令牌"
else
  TOKEN="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  printf '%s' "$TOKEN" > "$TOKEN_PATH"
  chmod 600 "$TOKEN_PATH" 2>/dev/null || true
  ok "已生成新令牌"
fi

ENTRY="$HERE/server.mjs"

# 先卸掉同名旧项，保证幂等（重复双击不会叠加）
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$ENTRY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$HERE</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>QZ_BRIDGE_TOKEN</key>
        <string>$TOKEN</string>
        <key>QZ_BRIDGE_PORT</key>
        <string>$PORT</string>
        <!-- launchd 不继承登录 shell 的 PATH，这里补上 node 所在目录 -->
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/bridge.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/bridge.error.log</string>
</dict>
</plist>
PLIST_EOF

if [ "$ALREADY_RUNNING" = "1" ]; then
  # 已经有一座桥在跑：不抢端口，只把令牌位置告诉用户
  warn "检测到已有邮件桥在运行，${B}不重复启动${R}，以免两座桥抢同一个端口。"
  say "  ${DIM}（已有的桥用的是它自己的配置；本安装器已把令牌准备在 $TOKEN_PATH）${R}"
else
  launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null \
    || { launchctl load -w "$PLIST" 2>/dev/null; }
  ok "已注册开机自启：$LABEL"
fi
say ""

# ══════════════════════════════════════════════════════════════════
# 第 5 步：等它就绪，并**真实验证一次登录**
#   server.mjs 的 IMAP 连接是懒加载，启动成功 ≠ 授权码正确。
#   不在这里验证的话，用户会带着「显示安装成功、网站却一直离线」离开。
# ══════════════════════════════════════════════════════════════════
say "${B}⑥ 验证${R}"

if [ "$ALREADY_RUNNING" = "0" ]; then
  READY=0
  for _ in $(seq 1 20); do
    if curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then READY=1; break; fi
    sleep 0.5
  done
  if [ "$READY" = "1" ]; then
    ok "桥已在本机运行：http://127.0.0.1:$PORT"
  else
    warn "桥没能启动。看日志：$LOG_DIR/bridge.error.log"
    say "  ${DIM}$(tail -n 6 "$LOG_DIR/bridge.error.log" 2>/dev/null | sed 's/^/    /')${R}"
  fi
fi

# 真连一次邮箱，确认授权码对。
#
# ⚠️ 这里**不能**用 /api/me 判断。2026-09-27 实测：
#     /api/me 只回读配置里的 email 字段，**不建立 IMAP 连接** —— 授权码完全是错的，
#     它照样返回 200 + {"email":…}。拿它当判据就会给出「邮箱已经连上了」的**假成功**，
#     用户带着这个结论离开，回头发现网站一直离线，却不知道是授权码错了。
#     （server.mjs 的 IMAP 连接是懒加载：首次拉信才连，所以「启动成功」同样不能作数。）
#
#   正确做法：调一次真正会碰 IMAP 的 /api/list，看 **HTTP 状态码**：
#     200 → 真的连上并拉到了邮件
#     500 → 桥活着，但连邮箱失败（授权码错 / 服务器地址错 / 网络不通）
#     401 → 令牌不对（安装器自己写的令牌，正常不会发生）
#   注意失败时响应体也是 {"error":…}，所以必须看状态码，不能看 body 里有没有 email。
LIST_CODE="$(curl -s -o /tmp/qz-bridge-verify.json -w '%{http_code}' -m 30 \
  -H "X-QZ-Token: $TOKEN" "http://127.0.0.1:$PORT/api/list?dir=inbox&limit=1" 2>/dev/null)"
VERIFY_BODY="$(head -c 500 /tmp/qz-bridge-verify.json 2>/dev/null)"
ME_JSON="$(curl -fsS -m 10 -H "X-QZ-Token: $TOKEN" "http://127.0.0.1:$PORT/api/me" 2>/dev/null)"

LOGIN_OK=0
LOGIN_REASON=""
case "$LIST_CODE" in
  200) LOGIN_OK=1 ;;
  "")  LOGIN_REASON="桥没有响应（多半没启动成功）" ;;
  401) LOGIN_REASON="令牌校验失败" ;;
  500) LOGIN_REASON="邮箱服务器拒绝了登录" ;;
  *)   LOGIN_REASON="未知响应（HTTP $LIST_CODE）" ;;
esac

say ""
line
if [ "$LOGIN_OK" = "1" ]; then
  printf '%s\n' "${GRN}${B}  安装完成，邮箱已经连上了${R}"
  line
  say ""
  say "  连上的邮箱：${B}$(printf '%s' "$ME_JSON" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin).get('email',''))" 2>/dev/null || echo "$EMAIL")${R}"
  say ""
  say "  最后一步（只需做一次）：打开网站 → 设置 → 邮件桥"
  say "    · 地址填：${B}http://localhost:$PORT${R}"
  say "    · 访问令牌填：${B}$TOKEN${R}"
  say ""
  say "  ${DIM}令牌已同时复制到剪贴板，直接按 ⌘V 粘贴即可。${R}"
  printf '%s' "$TOKEN" | pbcopy 2>/dev/null || true
  say ""
  say "  以后开机自动运行，不用再管它。要停止请看「卸载邮件桥.command」。"
else
  printf '%s\n' "${YEL}${B}  桥装好了，但邮箱没连上${R}"
  line
  say ""
  say "  原因：$LOGIN_REASON"
  say ""
  say "  邮箱服务器返回："
  say "    ${DIM}${VERIFY_BODY:-（无响应）}${R}"
  say ""
  say "  ${B}最可能的原因是授权码填错了${R}（比如填成了登录密码 —— 几乎每家邮箱都会因此"
  say "  报 AUTHENTICATIONFAILED）。另外两个常见原因：该邮箱还没在网页版里开启 IMAP 服务；"
  say "  或者本机网络连不上邮箱服务器。"
  say ""
  say "  改法：重新双击一次「安装邮件桥.command」，填正确的授权码即可覆盖旧配置 ——"
  say "  ${DIM}不需要先卸载，也不会重复装出第二座桥。${R}"
fi
say ""
line

osascript -e "display dialog \"$( [ "$LOGIN_OK" = "1" ] && echo "邮件桥已装好并连上邮箱 ✓\\n\\n最后一步：打开网站 → 设置 → 邮件桥，地址填 http://localhost:$PORT，访问令牌已复制到剪贴板，按 ⌘V 粘贴即可。\\n\\n以后开机自动运行。" || echo "桥已安装，但邮箱没连上。多半是授权码填成了登录密码 —— 请重新双击一次安装文件，填正确的授权码。\\n\\n详情见安装窗口。" )\" with title \"$( [ "$LOGIN_OK" = "1" ] && echo "安装完成" || echo "需要处理一下" )\" buttons {\"好\"} default button \"好\"" >/dev/null 2>&1

say ""
say "  本窗口可以直接关闭。"
say ""
