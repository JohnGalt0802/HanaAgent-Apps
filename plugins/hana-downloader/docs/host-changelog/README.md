# Host Changelog

按宿主版本号分目录存放调研记录。每个版本一个 markdown。

## 目录

- [0.928.0-sync-delivery-investigation.md](./0.928.0-sync-delivery-investigation.md) — 0.928.0 vs 0.919.4 session:send handler diff
- [0.928.0-sync-probe-broken.md](./0.928.0-sync-probe-broken.md) — sync-probe 实测：缺 `app/process.spawn` capability，设计上不能 spawn
- [v0.14.0-sync-restore.md](./v0.14.0-sync-restore.md) — 真同步投递恢复：bundle 魔改重建（工具化）+ 插件同步层回填，实测两条注入样本
- [0.930.1-sdk-diff-and-repatch.md](./0.930.1-sdk-diff-and-repatch.md) — 0.930.1 自动更新覆盖 bundle：SDK 逐项对比（无实质变化）+ 魔改重建实测

## 维护规则

- 每个 host 版本号一个 markdown
- 文件名格式：`{version}-{topic}.md`
- 必填字段：
  - 版本号 + 调研日期
  - sync-probe 实测结论（如果有）
  - session:send / session:send-custom / session:stage-file 关键口子位置（行号）
  - 对 hana-downloader 的影响（v2 plugin vs v2 app）
- 更新后必须 `git commit` + sync community 源（`<userHome>\.hanako\plugins\hana-downloader\docs\host-changelog/`）