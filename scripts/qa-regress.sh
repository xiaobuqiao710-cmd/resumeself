#!/bin/bash
# 全量回归：逐个跑 scripts/qa-e2e.mjs 的场景，只报每个场景的 ❌ 条数。
#
# ★ 为什么要有这份脚本：它以前只待在 /tmp 里，一次命令被中断后整份丢了，
#   只好凭记忆重建。回归入口属于项目资产，必须进仓库。
#
# 前置（缺了就会得到一堆假失败，而假失败会训练人忽略红色）：
#   1) 本地预览     npm run build && npm run preview        → http://127.0.0.1:4173
#   2) 演示邮件桥   cd mail-bridge && QZ_DEMO=1 QZ_BRIDGE_PORT=8790 node server.mjs
#   3) AI mock      node scripts/qa-ai-mock.mjs             → http://127.0.0.1:8799
#   4) 桥令牌       mail-bridge/bridge.token 存在（演示模式下由服务端生成）
#
# 用法：
#   bash scripts/qa-regress.sh             # 跑全部
#   bash scripts/qa-regress.sh webdav mail # 只跑指定场景
set -u
cd "$(dirname "$0")/.."
export QZ_CLOUD=1
export QZ_BRIDGE_URL=${QZ_BRIDGE_URL:-http://127.0.0.1:8790}
# 打自建桥必须显式指路：不指路就去默认位置找令牌，找不到会报「令牌无效」，看起来像产品 bug
export QZ_BRIDGE_TOKEN_FILE=${QZ_BRIDGE_TOKEN_FILE:-$PWD/mail-bridge/bridge.token}

# 需要真实账号的 loginreal 不在列：它要 QZ_USER / QZ_PASS，跑失败不代表产品有问题
ALL="views removeapp palette convert mailsync settings settingsopt overlap import modules bankrepo docx mail crud reset twotab stale staledirty cloudsync typing misc mobile pwa roundtrip webdav scroll stacklock perf mailsend ai agenttools agentconv onboard pline calv brief"
SCENARIOS=${*:-$ALL}

# overlap 想真的压到「长字段把卡片撑破、文字压到邻卡上」这条断言，
# 必须喂它仓库里的长字段夹具 —— 空数据下公司背景是空态，那条断言会静默跳过，
# 于是「跑绿了」什么也没证明（线上事故就是这么漏过去的）。
# 其余场景用空数据起点（QZ_PKG=empty，验证「别人第一次打开模板」的体验）。
OVERLAP_FIXTURE="$PWD/scripts/fixtures/company-long-fields.json"

# 判定一个 run 是否真的跑完：qa-e2e.mjs 正常收尾一定会打印「截图目录:」，
# 而中途抛异常早退时只会打印「巡检异常:」且不会有收尾行。
# 只数 ❌ 是不够的——早退的 run 一行 ❌ 都不会打印，只数 ❌ 会把它记成 0 = 通过
#（D 线实测：12 次里 5 次崩溃早退，全部被记成 0 ❌ 全绿）。
run_one() {
  local name="$1"; shift
  local out n done_ok crashed
  out=$("$@" 2>&1)
  n=$(printf '%s' "$out" | grep -cE '❌')
  done_ok=$(printf '%s' "$out" | grep -cE '^截图目录:')
  crashed=$(printf '%s' "$out" | grep -cE '巡检异常:')
  if [ "$done_ok" = "0" ] || [ "$crashed" != "0" ]; then
    red=$((red + 1))
    printf "%-14s %s ❌  ⚠️ 未跑完（early-exit/crash）\n" "$name" "$n"
    printf '%s\n' "$out" | grep -E '巡检异常|❌' | head -4 | sed 's/^/                 /'
    return
  fi
  [ "$n" != "0" ] && red=$((red + 1))
  printf "%-14s %s ❌\n" "$name" "$n"
  if [ "$n" != "0" ]; then
    printf '%s\n' "$out" | grep -E '❌' | head -4 | sed 's/^/                 /'
  fi
}

red=0

# 纯函数单测放最前：它不依赖预览服务 / 邮件桥 / AI mock，任何环境下都该先绿。
# 「侧边栏聊着聊着突然 400」那类坏在 localStorage raw 里的对话结构问题，
# 走浏览器看不出来（数据是坏的、界面是好的），只有这一份能钉住。
if node scripts/qa-agent-conv.mjs >/tmp/qz-agent-conv.log 2>&1; then
  printf "%-14s ✅\n" "agentconv"
else
  red=$((red + 1))
  printf "%-14s ❌ （详见 /tmp/qz-agent-conv.log）\n" "agentconv"
  grep -E '❌' /tmp/qz-agent-conv.log | head -4 | sed 's/^/                 /'
fi

for S in $SCENARIOS; do
  # overlap 单独走：它要带长字段夹具，混在统一循环里会让这条断言退化成空跑
  [ "$S" = "overlap" ] && continue
  run_one "$S" node scripts/qa-e2e.mjs "$S"
done

if printf '%s' "$SCENARIOS" | grep -qw overlap; then
  run_one overlap env QZ_PKG="$OVERLAP_FIXTURE" node scripts/qa-e2e.mjs overlap
fi

# cloudfail 必须单独跑：QZ_CLOUD_FAIL=1 让伪造的 Supabase 一律 500，
# 用来验证「云端读不通」时的表现；这个开关会污染其它场景，不能混在同一个进程里
if [ -z "${*:-}" ] || printf '%s' "$SCENARIOS" | grep -qw cloudfail; then
  run_one cloudfail env QZ_CLOUD_FAIL=1 node scripts/qa-e2e.mjs cloudfail
fi

echo "=== 回归结束：$red 个场景有红项 ==="
exit $((red > 0))
