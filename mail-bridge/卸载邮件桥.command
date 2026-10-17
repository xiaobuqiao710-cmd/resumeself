#!/bin/bash
#
# 秋招网申辅助中心 · 邮件桥卸载器（macOS）
# ==========================================================================
# 用法：在「访达」里双击本文件。
#
# 为什么必须有它：安装器往系统里写了两个东西 —— 一个开机自启的 launchd 服务、
# 一个含邮箱授权码的配置文件。没有卸载入口的话，用户想「先关掉试试」都找不到办法，
# 只能放任它一直后台运行。可逆性是一键安装的前提。
#
# 它做三件事（都会先问）：
#   ① 停掉并移除开机自启服务
#   ② 追问是否删除含授权码的配置文件（默认保留，方便以后重装）
#   ③ 打印剩余状态，确认真的停干净了
# ==========================================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$HERE/bridge.config.json"
TOKEN_PATH="$HERE/bridge.token"
# 只卸载本安装器自己创建的那个 service —— 不动别人的桥（如 DSH 托管桥）。
LABEL="com.xianlinglong.qz-mail-bridge-standalone"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${QZ_BRIDGE_PORT:-8787}"

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'
else
  B=''; DIM=''; R=''; GRN=''; RED=''; YEL=''
fi
line() { printf '%s\n' "────────────────────────────────────────────────────────────"; }
ok()   { printf '%s %s\n' "${GRN}✓${R}" "$*"; }
warn() { printf '%s %s\n' "${YEL}!${R}" "$*"; }

clear
printf '\n%s\n' "${B}  邮件桥卸载${R}"
line
printf '  这会停掉本机邮件桥，网站的「邮件中心」将变成未连接状态。\n'
printf '  %s其它板块不受任何影响。%s\n' "$DIM" "$R"
line
printf '\n'

# ── 先确认要卸载 ──────────────────────────────────────────────────
if ! osascript -e 'display dialog "确定要卸载本机邮件桥吗？\n\n卸载后网站的「邮件中心」会显示未连接，其它功能不受影响。\n\n以后想再用，双击「安装邮件桥.command」即可装回来。" with title "卸载邮件桥" buttons {"取消", "卸载"} default button "取消" with icon caution' >/dev/null 2>&1; then
  printf '  已取消，没有做任何改动。\n\n'
  exit 0
fi
printf '\n'

# ── ① 停服务 ──────────────────────────────────────────────────────
printf '%s\n' "${B}① 停止后台服务${R}"
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null \
    || { launchctl unload -w "$PLIST" 2>/dev/null; }
  ok "已停止并移除 $LABEL"
else
  printf '  %s该服务本来就没在运行%s\n' "$DIM" "$R"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST" && ok "已删除自启配置 $PLIST"
fi
printf '\n'

# ── ② 追问配置文件（含授权码） ────────────────────────────────────
printf '%s\n' "${B}② 配置文件${R}"
if [ -f "$CONFIG_PATH" ]; then
  if osascript -e 'display dialog "要一并删除邮箱授权码配置吗？\n\n· 删除：彻底清干净，以后重装需要重新填一次邮箱和授权码\n· 保留：授权码继续留在本机这个文件里，重装时不用再填\n\n（两个选择都不会把授权码发到任何地方）" with title "删除授权码配置？" buttons {"保留", "删除"} default button "保留" with icon caution' >/dev/null 2>&1; then
    rm -f "$CONFIG_PATH" && ok "已删除 bridge.config.json（含授权码）"
  else
    printf '  已保留 %s%s%s\n' "$DIM" "$CONFIG_PATH" "$R"
    printf '  %s（内含邮箱授权码，权限 600，仅本机可读）%s\n' "$DIM" "$R"
  fi
fi
[ -f "$TOKEN_PATH" ] && printf '  令牌文件保留在 %s\n' "$TOKEN_PATH"
printf '\n'

# ── ③ 复核 ────────────────────────────────────────────────────────
printf '%s\n' "${B}③ 复核${R}"
sleep 1
if curl -fsS -m 4 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  warn "端口 $PORT 上仍有服务在响应 —— 说明还有另一座桥在运行。"
  printf '  %s本项目历史上出现过多个桥抢同一端口的情况，检查：%s\n' "$DIM" "$R"
  printf '  %s  lsof -nP -iTCP:%s -sTCP:LISTEN%s\n' "$DIM" "$PORT" "$R"
else
  ok "端口 $PORT 已释放，邮件桥已完全停止"
fi
printf '\n'
line
printf '  卸载完成。想装回来：双击「安装邮件桥.command」。\n'
line
printf '\n'
