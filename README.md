# HanaAgent-Plugins

HanaAgent 插件公开集合。每个插件独立目录，即开即用。

## 插件列表

| 插件 | 版本 | 说明 |
|---|---|---|
| [ns-new-session](plugins/ns-new-session/) | 1.0.0 | `/ns` 快捷命令：新建桌面级会话，弥补移动端 `/new` 不能创建桌面会话的问题 |
| [hana-downloader](plugins/hana-downloader/) | v0.15.0 | 小花下载器：可观测下载（进度/限速/停滞/取消溯源）+ 跨会话管理器；同步投递走 v2 app 正门（配套 `companion-app/hd-sync-bridge`） |
| [easymodel-viewer](plugins/easymodel-viewer/) | v2.0.1 | 3D 模型查看器（STL/OBJ/PLY/GLB/GLTF/3MF/STEP/IGES），contributes.cards 架构，支持自动转盘/换肤/线框/网格/视角切换 |
| [qq-group-patrol-skill](qq-group-patrol-skill/) | 1.1 | QQ 群定时巡检 skill：chatlog-keeper 直读本地库，生成数据概览/群友有价值发言/群文件巡检报告，可 cron 定时推微信 |

## 安装

把目标插件目录复制到 Hana 插件目录：

```bash
# 以 download-progress 为例
cp -r plugins/download-progress <Hana插件目录>/download-progress
```

或在 Hana 设置 → 插件中直接安装。

## 说明

- 插件按需更新，版本见各插件 manifest.json
- 公开分发用仓库；日常开发请用私有仓库
- 各插件 README 内含完整使用文档与踩坑记录
