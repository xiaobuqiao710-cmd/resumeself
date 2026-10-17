/**
 * Node 侧打包入口 —— **不参与网站构建**。
 * ------------------------------------------------------------------
 * 它只被 `scripts/build-rules.mjs` 用 esbuild 消费，产出
 * `~/.local/share/qz-tracker/lib/qz-rules.mjs`，供本机定时脚本 import。
 *
 * 为什么要绕这一圈：追踪脚本（`make-public.mjs` / `notify-important.mjs`）
 * 是 Node ESM，不能直接 import TypeScript；而把口径在脚本里**再抄一份**
 * 是这套系统已经犯过的错 —— `prompts/daily.md`、`make-public.mjs` 的
 * `KEYS` 正则、网站侧的 `trackRules.ts` 曾经各写一份关键词，
 * 改一处忘一处只是时间问题（2026-09-28 的收集管线审计就是这么发现的）。
 *
 * ## 口径的权威副本在这里（2026-09-28 定）
 * 本目录是**唯一权威**：qz-tracker 的 `lib/qz-rules.mjs` 由本仓库的
 * `scripts/build-rules.mjs` 打包，`bin/daily.sh` 阶段 0 调用。
 * 另有一份派生副本在 `~/Documents/QoderCN/2026-09-05/chat-1/qiuzhao-assistant/src/lib/`
 * （那边的应用要用），**改一边必须同步另一边**；daily.sh 阶段 0 会比对并告警。
 */
export * from './trackRules';
export * from './scoreRules';
