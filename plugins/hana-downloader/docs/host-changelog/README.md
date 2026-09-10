# Host Changelog

按宿主版本号分目录存放调研记录。每个版本一个 markdown。

## 目录

- [0.928.0-sync-delivery-investigation.md](./0.928.0-sync-delivery-investigation.md) — 0.928.0 vs 0.919.4 session:send handler diff
- [0.928.0-sync-probe-broken.md](./0.928.0-sync-probe-broken.md) — sync-probe 实测：缺 `app/process.spawn` capability，设计上不能 spawn
- [v0.14.0-sync-restore.md](./v0.14.0-sync-restore.md) — 真同步投递恢复：bundle 魔改重建（工具化）+ 插件同步层回填，实测两条注入样本
- [0.930.1-sdk-diff-and-repatch.md](./0.930.1-sdk-diff-and-repatch.md) — 0.930.1 自动更新覆盖 bundle：SDK 逐项对比（无实质变化）+ 魔改重建实测
- [0.938.12-hooks-gate-v2app.md](./0.938.12-hooks-gate-v2app.md) — 0.938.12 魔改再次被覆盖；实测确认 v2 app 的 `ctx.hooks.onDecision("agent/pre-step")` 正门可用（注册→咨询→跨进程注入全通），v2 plugin 仍无 hooks
- [0.938.12-bridge-sync-verified.md](./0.938.12-bridge-sync-verified.md) — 桥接方案（插件写队列 + v2 app 正门注入）落地并端到端实测通过；一条回执只走一条通道，桥接掉线自动回退魔改
- [0.946.2-bridge-verified.md](./0.946.2-bridge-verified.md) — 0.946.2 上桥接继续有效：`ctx.hooks` 对 plugin 仍为 undefined；新版会话钩子正式化为 App 域能力（10 决策点 + 6 事件，各一条 `app/hooks.*` 权限）；同步/异步投递双通道端到端复验；新增 task-registry WARN

## 维护规则

- 每个 host 版本号一个 markdown
- 文件名格式：`{version}-{topic}.md`
- 必填字段：
  - 版本号 + 调研日期
  - sync-probe 实测结论（如果有）
  - session:send / session:send-custom / session:stage-file 关键口子位置（行号）
  - 对 hana-downloader 的影响（v2 plugin vs v2 app）
- 更新后必须 `git commit` + sync community 源（`C:\Users\John Galt\.hanako\plugins\hana-downloader\docs\host-changelog/`）