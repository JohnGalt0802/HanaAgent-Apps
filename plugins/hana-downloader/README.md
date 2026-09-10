# Hana Downloader · 小花下载器

> 插件 ID：`hana-downloader` · 中文名：小花下载器 · 为 HanaAgent 提供**可观测下载**（observable download）能力：
> 下载任务实时可视化、进度状态可查询、中途可干预、终态可靠通知。
> 同时提供命令型下载（git clone / pnpm install）与跨会话下载管理器。

- 当前版本：v0.15.0
- 权限要求：full-access
- 运行环境：HanaAgent 0.946.2（实测基线）；同步投递走配套 v2 app 正门（`companion-app/hd-sync-bridge`）

---

## 一、核心架构

插件分为三层，各层职责单一、通过明确契约衔接：

```
┌─────────────────────────────────────────────────────┐
│  展示层                                              │
│  ├─ 进度卡片（聊天流内嵌 webview，600ms 轮询刷新）    │
│  └─ 跨会话管理器（/manager，集中管控全部会话的任务）   │
├─────────────────────────────────────────────────────┤
│  工具层（LLM 消费的四个工具）                         │
│  ├─ download-file     URL 下载（返回卡片 + taskId）   │
│  ├─ download-command  命令型下载（git clone/pnpm）    │
│  ├─ download-wait     回查（立即快照，不阻塞）        │
│  └─ download-cancel   取消（来源签名 user/agent）     │
├─────────────────────────────────────────────────────┤
│  数据层（lib/dlcore.js 任务管理器）                    │
│  流式下载 · 测速 · 限速 · 停滞监测 · 终态事件 · 持久化  │
└─────────────────────────────────────────────────────┘
```

**层间契约**：

- 工具层 → 展示层：工具返回值携带 `details.card`（webview 卡片描述），宿主将其渲染在工具块正下方；卡片前端以 600ms 周期轮询 `/download/status` 刷新。
- 数据层 → 工具层：`onceFinal(taskId)` 提供终态一次性等待原语；`onFinal/onStall` 回调驱动投递分流。
- 工具层 → 宿主：`deferred:register/resolve` 总线通道承载跨回合投递。

## 二、核心机制：v0.15.0 三通道通知

下载完成通知按 agent 当前状态分两条：

| agent 状态 | 投递路径 | agent 感知时机 |
|---|---|---|
| 未收束 | **真同步**：配套 v2 app `hd-sync-bridge` 在 `agent/pre-step` 把 HBR 拼进**下一条 LLM API 请求的 messages** | **当前轮** 下一次思考即看到 HBR |
| 已收束 | **异步唤醒**：`deferred:register + resolve` → host dispatcher（busy→followUp，idle→triggerTurn） | 新 turn input 看到 HBR |

同步超时（30s 内未被桥接消费）→ 自动降级异步，不丢回执。

完整机制见 `docs/host-changelog/v0.14.0-sync-restore.md`（四场景实测 + 证据）；历史链路见 `docs/v0.11.0-真同步投递完整机制.md`。

### 同步投递通道（v0.15.0：桥接单通道）

plugin 形态的 `ctx` 没有 `hooks` 成员（实测 `ctx.hooks=undefined`），`agent/pre-step` 正门只对 **v2 app** 开放。v0.15.0 因此采用桥接，让两边各干擅长的：

```text
hana-downloader (plugin，宿主进程内、无沙箱)
   └─ 下载回执 → 原子写入 {HANA_HOME}/app-data/hd-sync-bridge/queue/<key>.json
hd-sync-bridge (v2 app，独立子进程 + 权限沙箱，持有 app/hooks.agent-pre-step)
   └─ agent/pre-step → 读队列 → 拼进 messages → 删除文件
```

一条回执只走一条通道：`ctx.hooks`（插件被当 app 跑时才有）> 桥接。桥接靠 `ready.json` 心跳判活（120s 内有效），心跳过期时回执不写队列，直接走异步唤醒；两条通道互斥，不会双投。

**配套 app 安装（必需，否则没有同步语义）**：

1. 把 `companion-app/hd-sync-bridge/` 复制到 `{HANA_HOME}/apps/hd-sync-bridge/`
2. 设置 → Apps → 批准该 app
3. 设置 → Security → App capabilities → 打开 `app/hooks.agent-pre-step`

桥接不可用时的行为：静默降级为「收束后 deferred 唤醒」，不丢回执但失去同步语义。

> bundle 魔改通道已于 2026-09-10 下线（打补丁脚本已删、宿主 bundle 已还原）。

### HBR 根标签 7 属性

```xml
<hana-background-result
  task-id="..."
  status="success|failed|aborted"
  event-status="done|cancelled|error"
  source="system"
  plugin="hana-downloader"
  type="download"
  action="none|decide">
...
</hana-background-result>
```

**agent 优先看 `event-status`**（新语义），`status` 仅用于兼容宿主 interlude / 前端 detail。

**取消来源溯源**：每次取消记录 `canceledBy` 来源（卡片按钮 = `user`，Agent 工具 = `agent`），贯穿快照、wait 返回值与投递消息；用户手动取消的通知附「非故障，无需自动重试或换源」提示，防止 Agent 将人为干预误判为故障。

## 三、功能清单

### 3.1 下载工具 download-file

| 参数 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 下载地址（http/https） |
| `saveDir` | 否 | 保存目录绝对路径；留空用插件默认目录 |
| `fileName` | 否 | 自定义文件名；留空从 URL 推断 |
| `speedLimit` | 否 | 限速（字节/秒） |
| `startDelayMs` | 否 | 准备态延迟（毫秒），默认 0 |

返回文本自足、含任务 ID 与免回查引导。网络策略：代理优先（CONNECT 隧道），失败自动降级直连。完整性红线：chunked（无 Content-Length）传输半途断连一律判 failed 并删除半成品。

### 3.2 命令型下载 download-command

`git-clone` 与 `pnpm-install` 白名单命令（不做 shell 拼接），解析输出流映射为阶段文案与百分比；Windows 下以 taskkill 杀进程树取消。

### 3.3 回查工具 download-wait

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskId` | 是 | 任务 ID |

立即返回当前事实快照（state / percent / speed / eta / error / filePath / stalled / consumedByWait / deferredAutoRegistered），不阻塞。**可选回查，不强制**：任务未完成时可直接收束，下载完成会自动唤醒；若想主动确认进度或提前拿终态，可调用本工具。

### 3.4 取消工具 download-cancel

终止指定任务（来源签名为 agent），删除半成品文件。

### 3.5 跨会话管理器

`/manager` 页面集中展示所有会话的下载任务：列表、筛选（全部/在途/已完成/失败）、搜索、行内详情、打开文件/所在文件夹、默认下载目录设置。

布局与配色（v0.14.0）：卡片底色与滚动条优先取宿主注入的 CSS 变量（`--bg-card` / `--text-muted`），未注入时退回自包含双色板；列表用 flex 高度链（`#dl-root` 列布局 + `.mgr-list` `flex:1 / min-height:0 / overflow-y:auto`）在视口内滚动，不再依赖宿主卡片高度上限的硬编码值。

## 四、设置项

| 设置 | 默认 | 说明 |
|------|------|------|
| `defaultSaveDir` | 空 | 默认保存目录，留空用插件数据目录 downloads/ |
| `stallTimeoutMs` | 30000 | 停滞判定阈值（毫秒） |
| `waitWatchMode` | false | wait 守望模式开关；当前默认快照模式（wait 立即返回，Agent 收束后由 deferred 自动唤醒） |

## 五、项目结构

```
manifest.json                插件声明（full-access）
index.js                     生命周期：onload 注册 agent/pre-step adjudicator（order 999）+ 遗留任务恢复
lib/delivery.js              投递权威：tailSettled / buildEntry 7 属性 / enqueueSync(主动投递实时态) / injectForSession / deliverAsync
lib/dlcore.js                任务管理器：流式下载/测速/限速/停滞监测/onceFinal/canceledBy/consumedByWait/持久化
lib/deferred.js              deferred 占位 helper（register/resolve + 全局 bus 兜底）
lib/progress-parsers.js      git/pnpm 输出解析（纯函数）
tools/download-file.js       URL 下载工具（创建即注册占位）
tools/download-command.js    命令型下载工具（创建即注册占位）
tools/download-wait.js       回查工具（立即快照）
tools/download-cancel.js     取消工具
routes/download.js           卡片页/管理器页/status/list/cancel/prepare/reveal/settings 路由
app/card.css|card.js         进度卡片前端（自包含色板、折叠交互、报高）
app/manager.css|manager.js   跨会话管理器前端
docs/host-changelog/0.938.12-bridge-sync-verified.md  桥接方案落地与实测（权威）
docs/host-changelog/0.938.12-hooks-gate-v2app.md      v2 app hooks 正门实测
companion-app/hd-sync-bridge/                          配套 v2 app（同步投递正门）
docs/host-changelog/v0.14.0-sync-restore.md  魔改通道机制与实测
docs/card-width-and-container.md   聊天流卡片宽度与容器约束（实测）
docs/host-bundle-mods.md      宿主魔改重建手册（内部，含本机路径，不入公开库）
docs/v0.11.0-真同步投递完整机制.md   历史机制文档（v1 契约时代）
```

---

## 六、安装

### 方式一：宿主安装入口（推荐分发）

1. 拿到分发包 `hana-downloader-<version>.zip`，先解压出 `hana-downloader/` 文件夹；
2. HanaAgent → 扩展中心 → 「本地安装」，选择该**文件夹**（安装入口认目录，不直接吃 zip）；
3. 确认审查卡，批准；
4. 重启宿主（legacy 插件没有热重载）。

> 包内 `manifest.json` **不写 `manifestVersion`**，走宿主的 legacy 插件通道（staged 结果 `runtime: "v1"`）。
> 若写成 `manifestVersion: 2`，安装入口会按 v2 App 规范严格校验（`contributes.configuration`、卡片 `type` 等字段都会被拒），这条包就装不上。

### 方式二：手动放置

把 `hana-downloader/` 整个目录放进 `~/.hanako/plugins/`，重启宿主。

### 配套 app（同步投递正门）

`companion-app/hd-sync-bridge/` 是独立的 v2 app，需单独装到 `~/.hanako/apps/`，并在「设置 → Apps → App 能力」授权 `app/hooks.agent-pre-step`。缺了它，同步投递会退回 deferred 异步唤醒。

---

## 七、重启与调试

```powershell
# 重启宿主（重启后插件重新加载；bundle 魔改已于 2026-09-10 下线）
pwsh -File <workspace>\_tools\restart-hana\restart-hana-reliable.ps1
```

同步投递只走桥接 app 一条通道（`companion-app/hd-sync-bridge`）；它不在线时自动回退 deferred 异步唤醒。bundle 魔改通道已废弃并移除，旧手册 `docs/host-bundle-mods.md` 仅作历史参考。

**调试日志**（运行时写，不影响功能）：
- 插件数据目录 `v2-load-debug.log`：onload / hooks probe / **INJECTED**（同步投递判据）
- 宿主日志搜索 `[hd-sync-bridge]`：`adjudicator registered` / `INJECT n item(s)`

---

*作者：John Galt*
