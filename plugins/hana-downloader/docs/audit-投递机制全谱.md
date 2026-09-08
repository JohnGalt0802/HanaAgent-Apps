# hana-downloader 插件 · 投递/通知机制全谱 & 版本演进审计报告

> 落盘时间：2026-09-01
> ⚠️ **历史审计（v0.5.x → v0.9.x）**。文中的 `pi.sendMessage` / `deferred:steer` / `session:send-custom` 通道在 0.928.0 已全部失效或不存在。
> 当前投递通道见 `docs/host-changelog/v0.14.0-sync-restore.md`；本文保留作为通道演进档案。
> 范围：`<workspace>\hana-downloader` 全树（README / PROJECT_REQUIREMENTS / 踩坑记录 / lib / extensions / docs / patch）
> 目的：把插件所有"通知/投递"通道分门别类、看清面向谁、分清两条线（agent 消息 vs 前端视图）、摸清 v0.5.x → v0.9.x 演进脉络，并解释为何用户会在前端持续看到"同步投递"提示而 agent 侧感知不一致。

---

## 0. TL;DR

| 维度 | 结论 |
|---|---|
| 投递通道有几条 | **3 大类**：① agent 同步通道（steering 类）② agent 异步通道（deferred 类）③ 前端视图通道（卡片 webview + manifest cards）。再加 1 条 **TaskRegistry 双注册** 旁路（不是投递，但常被混入）。 |
| 两条线独立吗 | **完全独立**。agent 消息线走 jsonl 写入路径（deferred/steer/send-custom），前端视图线走 `details.card` → manifest contributes.cards → iframe 600ms 轮询。前端看到"同步投递"**绝不等于** agent 同轮收到消息。 |
| 当前版本 | **README 标 v0.9.2 / package.json 0.9.0 / manifest 0.9.0**（README 比 package 新一档）。投递层 v0.9.1 "死磕" `session:send-custom + triggerTurn:true` 做主路径；`deferred:resolve` 做收束态兜底。 |
| 用户为何持续看到"同步投递" | 详见 §6。**核心原因**：前端卡片 webview 由 manifest 渲染、与投递通道解耦；agent 侧 pi stale / isStreaming=false 导致同步 steer 实际走不通，回退异步 deferred；但前端 600ms 轮询照样刷"已送达"UI。 |

---

## 1. 投递通道全谱

### 1.1 通道总表

| # | 类别 | 机制名 | 入口 API | 面向谁 | 触发时机 | 去重方式 | 主要证据位置 |
|---|---|---|---|---|---|---|---|
| **A1** | agent 同步 | `pi.sendMessage({deliverAs:"steer"})` | 扩展捕获的 `pi` 手柄 | agent 未收束回合 | 终态瞬间 + tailSettled()=false | `_delivered` 内存旗 + `markDelivered` 持久化 + 同步成功后 `deferred:suppress` 占位 | `extensions/dl-nextturn.js` handleFinal/handleStall `try{ await pi.sendMessage(...) }` 块（"STEER(queue) sent"日志） |
| **A1'** | agent 同步 | `session:send-custom + triggerTurn:true` | `bus.request("session:send-custom", {sessionPath, customType:"hana-background-result", content, display:false, triggerTurn:true, details})` | agent 未收束会话（**宿主原生同步**） | 同上 | 返回 `{ok:true, mode:"triggerTurn"}` 即置旗 + suppress | `extensions/dl-nextturn.js` `steerViaBus()` 主路径（0.9.1 死磕） |
| **A1''** | agent 同步 | `session:send + deliverAs:"steer"` | `bus.request("session:send", {sessionPath, text, deliverAs:"steer"})` | agent 未收束会话 | 同上 | 实测被 `session_busy` 拒（`steerSession` 仅 `isStreaming===true` 接受）—— **已实测失败**，不再依赖 | `docs/sync-mechanism.md` §4 |
| **A1'''** | agent 同步（补丁，已回滚） | `deferred:steer` 路由 | `bus.request("deferred:steer", {sessionPath, customType, content, display, details})` | agent 未收束会话 | 同上 | **0.810 宿主已删**（bundle count=0）；0.769 有。`extensions/dl-nextturn.js` 现在还留了一行降级注释，**实测 "No handler registered for deferred:steer"** | `extensions/dl-nextturn.js` steerViaBus 注释（v0.8.1）/ `docs/sync-mechanism.md` §2.1 |
| **A2** | agent 异步 | `deferred:resolve` | `bus.request("deferred:resolve", {taskId, result})` | agent 已收束会话（宿主 flush 唤醒） | 终态瞬间 + tailSettled()=true | `consumedByWait` / `_delivered` 短路由过；`deliverDeferredConfirmed` 做 query+retry 双确认 | `lib/deferred.js` `resolveDeferred()` / `extensions/dl-nextturn.js` `deliverDeferredConfirmed()` |
| **A2'** | agent 异步 | `deferred:suppress` | `bus.request("deferred:suppress", {taskId, reason})` | **灭占位**（不投递） | 同步投递成功后（防双投）；或 consumedByWait 后清理幽灵 | — | `extensions/dl-nextturn.js` "BUS-STEER delivered for ... + markDelivered + suppress" |
| **A2''** | agent 异步 | `deferred:retry` | `bus.request("deferred:retry", {taskId, sessionId, sessionPath, meta})` | 重置占位回 pending + 清 suppression | boot 窗口被宿主熄时再武装（v0.8.5） | — | `extensions/dl-nextturn.js` `retryPendingWake()` "WAKE-REARM" 段 |
| **A2'''** | agent 异步 | `deferred:query` | `bus.request("deferred:query", {taskId})` | 查宿主 store 真值（status/delivered/deliverySuppressed） | 投递前对账（v0.8.8）；boot 窗口确认；retry 分支判定 | 读 `delivered===true` 即放行让位 | `extensions/dl-nextturn.js` `probeDelivered()` + handleFinal `STORE-PROBE` 段 |
| **A3** | 异步单投（停滞） | `taskId:stall` 占位 | `bus.request("deferred:register", {taskId:stallKey, ...})` + `deferred:resolve` | agent 已收束会话（stall 通知） | `onStall` 触发 + tailSettled()=true 让 `index.js` 接管 | stallKey 时间戳唯一化（不复用）；`_stallDelivered` 旗 | `index.js` `manager.onStall()` |
| **B1** | TaskRegistry 旁路（非投递） | `task:register-handler / register / complete / fail / cancel` | `bus.request("task:...", {...})` | 宿主 stop_task / check_pending_tasks | 任务创建、终态 | — | `lib/registry.js` 全文件 |
| **C1** | 前端视图 | `details.card` + `manifest.contributes.cards` + `app/card.js` webview + 600ms 轮询 `/download/status` | 工具返回值携带 → 宿主自动注入 pluginId → iframe 渲染 | **前端用户视觉**，与 agent 感知完全解耦 | 工具调用时；卡片内 `setInterval(..., 600)` | 路由 `taskId` 单一 | `manifest.json` contributes.cards / `app/card.js` / `routes/download.js` / `tools/download-file.js` |
| **C2** | 前端视图 | 跨会话管理器 `/manager` | `manifest.contributes.cards` 第二张卡 + routes | **前端用户视觉** | 用户打开 manager 卡片 | — | `app/manager.{js,css}` / `routes/download.js` |
| **C3** | 前端视图 | 卡片内 `window.card.emit("event-name", payload)` | 卡片 webview 内 `window.card.emit` | **宿主事件流**（落会话 + 唤醒 agent） | 用户在卡片上点按钮（暂停/继续/取消） | 宿主 20/分钟 节流 | `docs/card-emit-guide.md` §2-3 |
| **D1** | 插件内部观察（不是投递） | `tailSettled(sessionPath)` | 扫 jsonl 最后一条真实 message | 插件自己 | 每次 handleFinal/handleStall | — | `extensions/dl-nextturn.js` `tailSettled()` |
| **D2** | 插件内部观察 | jsonl size 轮询（v0.6.5） | `setInterval` + `fs.statSync().size` | 插件自己 | onload 起 150ms 轮询，检测收束写入 | — | 踩坑记录坑11 |

### 1.2 关键通道细节

#### A1'（0.9.1 主路径）：`session:send-custom + triggerTurn:true`

**宿主协议**（`docs/sync-mechanism.md` §2.3 + `docs/six-quadrant-test.md` 顶部引文）：
- `session:send-custom` 路由经 `deliverCustomMessage` → 非 streaming 分支走 `triggerTurn` → `sendCustomMessage({triggerTurn:true})` **主动触发一个新 turn**消费消息，emit `isStreaming:true`。
- **不依赖 `isStreaming` 门**（不像 steer）；**不依赖 captured pi**（走 caller 校验 + sessionPath）。
- 插件调用形态：`bus.request("session:send-custom", {sessionPath, customType:"hana-background-result", content, display:false, triggerTurn:true, details:{schemaVersion:1, taskId, canceledBy, userCanceled, ...}}, {caller:{pluginId:"hana-downloader"}})`
- 返回 `{ok:true, mode:"triggerTurn"}` 视为已投递。

**位置**：`extensions/dl-nextturn.js` `steerViaBus()` 第一个 `bus.request("session:send-custom", ...)` 块。

**降级链**（同 `steerViaBus()` 函数体内）：
1. 主：session:send-custom + triggerTurn:true
2. 备：pi.sendMessage({deliverAs:"steer"})（仅捕获的 pi 仍有效时）
3. 再不济：return "unusable"，调用方走 `deliverDeferredConfirmed`（异步确认式 deferred）

#### A2（异步通道核心）：`deferred:resolve` + 复活确认

**两条独立路径都用 deferred**：

| 路径 | 触发 | 调用入口 | 位置 |
|---|---|---|---|
| 主路径终态投递 | handleFinal 检测 tailSettled=true | `deliverDeferredConfirmed(bus, t, taskId, result)` | `extensions/dl-nextturn.js` |
| 兜底终态投递 | handleFinal 同步 steer 全部失败 | 同上 | 同上 |
| onload 遗留兜底 | `setTimeout(..., 6000)` 扫 manager.list() 终态 | `resolveDeferred(bus, t)` 或 `registerDeferred(bus, t, ...)` | `index.js` "遗留终态兜底" 段 |
| 停滞异步投递 | `onStall` 回调 + tailSettled=true | `bus.request("deferred:resolve", {taskId:stallKey, result:{type:"download-stall", ...}})` | `index.js` `manager.onStall()` IIFE |

**v0.8.5 confirm+retry 协议**（`deliverDeferredConfirmed`）：
1. `deferred:query` 看占位是否存在：不存在 → `registerDeferred`（内部立即 resolve 终态任务）；存在 → 直接 resolve。
2. 6s 确认窗（每 500ms probe 一次）：
   - `delivered && !suppressed` → 已真送达，return true
   - `suppressed` 且处于 boot 窗口（启动后 150s）→ `deferred:retry` 再武装（重置 pending + 清 suppression）再 resolve（窗口内最多自救两次）
3. 仍不确认 → 入 `pendingWake` Map，由会话事件 / 15s 定时器重试，**绝不盲置旗**

**boot 窗口持有**（v0.8.9b）：`BOOT_TS = Date.now()`；启动后 150s 内 `pendingWake` 不以 `trust-flush` 收队，否则双端旗标同周期永远对不上（test11/12 实测轨迹）。

---

## 2. 两条线的独立性

### 2.1 解构

| 线 | 走什么 | 谁驱动 | 谁消费 | 评判"同步"的标准 |
|---|---|---|---|---|
| **agent 消息线** | `pi.sendMessage` / `session:send-custom` / `deferred:resolve` → 宿主 runtime → 写入 jsonl（`role=toolResult` 或 `custom_message`） | 插件投递层（`extensions/dl-nextturn.js` + `index.js` 兜底） | agent 下一轮生成（读 JSONL） | **唯一真判据**（`docs/delivery-判定标准.md` §2）：jsonl 最后一条真实 message + 下载完成 entry 位置 + agent 后续生成是否同回合继续 |
| **前端视图线** | 工具返回值 `details.card` → 宿主自动注入 `pluginId` → manifest contributes.cards 匹配 → iframe 渲染 `app/card.js` → 600ms 轮询 `/download/status` | 工具调用（`download-file/command/wait/cancel`） | 终端用户眼睛 | 前端是否看见进度条/状态/百分比——**与 agent 无关** |

### 2.2 delivery-判定标准.md 的明确话术（用户确认版）

> **同步**：下载完成消息，在会话**「未收束」**时，作为**当前回合的 input** 到达 agent，agent 在**同一个未收束回合**里感知并回应。
>
> **异步**：下载完成消息，在会话**「已收束」**（agent 停止）后到达，需要**唤起一个新回合**才交回 agent。

> ❌ **日志 `STEER(queue) sent` / `BUS-STEER(...)` ≠ 真同步**。它只表示插件调用了某通道，**不代表消息成为回合内 input**。
>
> ✅ **唯一真判据 = 消息在未收束回合内到达 + agent 同回合回应**（jsonl 顶层结构判断）。

### 2.3 独立性验证

**前端"同步投递"提示 ≠ agent 同轮收到**的证据：

1. **通道独立**：`details.card` 由宿主 webview 机制渲染（manifest cards + iframe + reportSize），与投递层（deferred/steer/send-custom）**没有任何 API 耦合**。投递层失败只会影响 agent 消息线，前端卡片照样轮询刷新。
2. **宿主测试实证**（`docs/six-quadrant-test.md` §5）：
   - **象限 1 快速同步完成**（taskId `6f2ff25f-mthgslno`）：store `resolved + delivered=true`，但**前端仍按 600ms 节奏刷"已送达"UI**——同步 steer 实际未注入、fallback 异步 resolve 后前端视图同步到达。
   - **d51a13d6 决定性重测**：`pi.sendMessage({deliverAs:"steer"})` 报 `This extension ctx is stale`，**同步全程未落地，静默降级异步 resolve**——但前端卡片依然正常显示 done。
3. **机制差异**：前端 `card.js` 的 `setInterval(600)` 只问 `/download/status` 路由的"task 状态"（dlcore 内存 Map），**不依赖**任何投递层 API。Agent 是否真收到消息，由投递层通过 jsonl 与宿主 runtime 协调，**完全另一条路径**。

### 2.4 两条线"看起来同步"的耦合点

虽然独立，但**视觉上"同步"**由三个巧合造成：
1. **时序紧凑**：终态触发 → 投递层立刻 fire → 宿主 runtime 写 jsonl → agent 同回合生成。同时 dlcore 的 state 已是终态 → 前端 600ms 内轮询到新值 → 重渲染。
2. **轮询固定 600ms**：前端不等投递层"确认"，只看状态字段。
3. **agent 收束前的等待**：agent 在 `download-wait` 守望期间自身也是 unsettled，会话仍在 jsonl 写入；即便投递走异步，agent 在 wait 返回后的下一步生成也能"看起来同轮"感知（但严格说此时已是异步 resolve）。

---

## 3. 版本演进时间线

> 时间线只列与**投递/通知机制**直接相关的版本；其他（卡片 400px / sessionPermission / 主题 patch / CardShell 600px 等）是基础设施改造。

### 3.1 关键里程碑

| 版本 | 日期 | 投递层变化 | 根因 / 动机 | 证据 |
|---|---|---|---|---|
| **v0.5.0** | 2026-08-24 | 创建即 `registerDeferred`（download-file/command 内）+ onFinal resolve + onload 幂等兜底 | **notifyWhenDone 只 resolve 不 register → 占位断链 → 永不唤醒**（坑7） | 踩坑记录 "2026-08-24 deferred 占位断链" |
| **v0.5.7** | 2026-08-25 | **注册时机后移**：创建时不注册；`download-wait` 快照"未完成"时自动续注册；终态后延迟 2s（从 5s 改）复查 | **会话内快完成下载被异步唤醒 = 噪音**（坑8）；v0.5.0 把"该投/不该投"混成一锅 | 踩坑记录坑8 + `lib/deferred.js` 注释 "v0.5.7 设计原则" |
| **v0.6.0–v0.6.3** | 2026-08-26~27 | **弯路**：改回创建即注册（试图修"auto-fast-done 漏通知"） | **批量重复通知灾难**（坑9）：10 个会话内并发完成的小任务 = 10 条 deferred 唤醒 = 工作区间爆掉。走过的弯路：turn 感知（bus.subscribe 0 触发）、host suppressDelivery（store 一致性失败） | 踩坑记录坑9 |
| **v0.6.4** | 2026-08-27 | **回归 v0.5.7 后注册** + 终态后 2s 复查窗口去重 | 修批量重复（坑9 已修）；承认 2s 窗口竞态**纯插件侧无法根治**（坑10），定为"已知无害边缘冗余" | 踩坑记录坑10 |
| **v0.6.5** | 2026-08-27 | 插件 onload 起 **150ms jsonl size 轮询**；检测到 `assistant(stopReason=stop)` 写入瞬间 → 对该会话下"未完成+占位未注册"任务**补注册** | **agent 收束前忘调 wait → 漏通知**（坑11，关键突破） | 踩坑记录坑11 |
| **v0.7.0** | 2026-08-27 | **dl-nextturn 扩展成为投递层唯一权威**：单通道分界（commit `339f451`） | 插件主逻辑只保留占位注册 / 兜底 / 停滞占位；终态投递交给扩展 | 踩坑记录坑12 版本线 |
| **v0.7.1** | 2026-08-27 | 加宿主 bundle 补丁 `deferred:suppress` 路由（commit `30c869b`） | 同步投递成功后灭占位防双投 | 踩坑记录坑12 "v0.7.1" |
| **v0.7.1 后段** | 2026-08-27 | **回退宿主补丁**：reason 串泄漏为可见消息 | suppress 后 `delivered via nextTurn by plugin` 理由串变成对话消息 | 踩坑记录坑12 "suppress reason 泄漏处理" |
| **v0.7.2** | 2026-08-27 | 跨会话过滤：`ownThisSession(task)` 按 sessionPath 归一化文件名匹配；`captureSession(ctx)` 从事件 ctx 抓 currentSessionPath/sid | **跨会话投递**：扩展 per-session 加载但读 `globalThis.__dlTaskMgr` 进程级单例 → fan-out 到所有会话（坑12） | 踩坑记录坑12 + commit `9ad8fc5` |
| **v0.7.3** | 2026-08-27 | 四项最小修复（commit `f1bb215`）：① captureSession 加 log ② download-file/command L86/L83 改 `sessionPath: toolCtx.sessionPath \|\| toolCtx.sessionRef?.path \|\| null` 补全数据 ③ 删 ownThisSession sessionId 兜底分支（净负资产） ④ wire 闸门前移：ownThisSession 不通过 → 不挂 onceFinal | v0.7.2 是 **fail-open 放行**（纸面逻辑未真生效）；62/64 任务 sessionPath 空是数据侧致命 | 踩坑记录坑12补 |
| **v0.8.1** | 2026-08-30/31 | **bus steer 主路径**：注释 "v0.8.1 bus steer 通道（主路径）" | `pi.sendMessage` 捕获的 pi 在会话替换/重载后必 stale（实测）；`deferred:steer` 是宿主补丁新增路由（在宿主内按 sessionPath 解析活会话，**不依赖 captured pi**） | `extensions/dl-nextturn.js` "v0.8.1 bus steer 通道（主路径）" 注释块 |
| **v0.8.2** | 2026-08-31 | consumed → 确定性持久 delivered + suppress 占位；ghost pending 清理 | check_pending_tasks / reminder 误判后台存活 | `extensions/dl-nextturn.js` handleFinal `if (t.consumedByWait...)` 块注释 |
| **v0.8.3** | 2026-08-31 | **stall settled 让位**：stall 收束态不抢跑（不置旗、不 resolve 虚 stallKey），交给 index.js 的 deferred register+resolve 权威对 | stallKey 是从未注册占位的虚 key，插件 resolve 必落空；抢旗让 index.js 二次检查时熄 own 占位 → 双双落空 → 停滞收束态永不被唤醒（用例 4 `8610bdf3` 实锤） | `extensions/dl-nextturn.js` handleStall `if (settled)` 块注释 |
| **v0.8.4** | 2026-08-31 | **agent 亲手取消静默**：`canceledBy=agent` 不唤醒，sync 返回值已是结果，再推一条 = 回音壁（test6 实锤） | download-cancel 工具的同步返回值已含 canceled + 半成品已删 | `extensions/dl-nextturn.js` handleFinal `if (state === "canceled" && t.canceledBy === "agent")` 块 |
| **v0.8.5** | 2026-8-31 | **deferred 投递确认 + 复活重试**：`deliverDeferredConfirmed` 6s 确认窗 + boot 窗口内 `deferred:retry` 再武装 | 旧版盲置 `_delivered=true` → 通知永丢（jsonl 零落地 + delivered:true，test5/1da18a8e 实锤）；commit f1bb215 后续补救 | `extensions/dl-nextturn.js` `deliverDeferredConfirmed()` |
| **v0.8.6** | 2026-08-31 | **跨 realm 去重**：扩展（realm A） vs index.js 遗留兜底（realm B）插件侧旗标互不可见；唯一真相源 = 宿主 store query；占位已真投递则让位 | test8/b2a24d41 双投实锤：兜底 JSON 投完，扩展 2s 后见旗空又 steer 一条 | `extensions/dl-nextturn.js` handleFinal `STORE-PROBE` 段 |
| **v0.8.7** | 2026-08-31 | 兜底串行化：onload `setTimeout(..., 6000)` 延后到扩展 onFinal+2s 之后 | 旧版同步立即 resolve → 占位被扩展 query 确认窗口撞 "resolved 未标 delivered" 灰区误判未投 → 双投（bundle 0.769.0 `_deliverTask` 实测 markDelivered 在 coordinator 返回后） | `index.js` "v0.8.7 兜底串行化" 注释 |
| **v0.8.8** | 2026-08-31 | 投递前对账宿主：`deferred:query` 见 `delivered=true`（含被熄）→ 就地补旗跳过；查询失败退回宁多投 | 跨重启双投（test10/ea7597f8 收到第二条 JSON）：上轮宿主已真投但兜底不置旗，新一轮启动插件见 delivered=false → 再 resolve | `index.js` "v0.8.8 投递前对账宿主" 注释 |
| **v0.8.9b** | 2026-08-31 | boot 窗口持有：BOOT_TS 启动后 150s 内 pendingWake 不以 trust-flush 收队 | test11/12 实测轨迹：双端旗标同周期永远对不上 | `extensions/dl-nextturn.js` `retryPendingWake()` |
| **v0.8.9c** | 2026-08-31 | 同步占位（`task._hfClaimed`）：同一 tick 内先查后置，防 TOCTOU 双 steer | 双 compact 触发双事件，两路都先 sleep(2000) 再查 _delivered → 双双通过 → 双 steer（d897fb55/6239d77f 实锤） | `extensions/dl-nextturn.js` handleFinal `task._hfClaimed = true` 注释 |
| **v0.9.0** | 2026-08-31 晚 | **host-native-first 收敛**：同回合用 `pi.sendMessage({deliverAs:"steer"})`；异步用 `deferred:resolve`；**不依赖** `deferred:steer` / `deferred:suppress` / `steeringQueue`（补丁/已回滚/不存在） | 宿主无 `deferred:steer` 路由（0.810 bundle count=0）实测坐实；`PROJECT_REQUIREMENTS.md` §3.2 列出 host 没有的能力 | PROJECT_REQUIREMENTS §3-4 / `docs/six-quadrant-test.md` 顶部 |
| **v0.9.1** | 2026-09-01 | **死磕 session:send-custom + triggerTurn:true** 做主路径；pi.sendMessage 仅备；deliverDeferredConfirmed 仅 settle fallback | `docs/sync-mechanism.md` 系统对比 0.769 vs 0.810：`deliverCustomMessage` isStreaming 分支硬编码 `followUp`（丢了 deliverAs:"steer"），`session:send` 实测 `session_busy` / `does not belong to app`；session:send-custom + triggerTurn 是唯一**不依赖 captured pi 也不依赖 isStreaming** 的同步通道 | `extensions/dl-nextturn.js` `steerViaBus()` 主块注释 "0.9.1 死磕" |
| **v0.9.2**（README 标记） | 2026-09-01 | 当前 README 版本号；package.json / manifest 仍 0.9.0 | README §0 顶部 | README 顶部 |

### 3.2 演进的核心矛盾与权衡

```
v0.5.0 修 "占位断链 → 不唤醒"
   ↓
v0.5.7 修 "会话内完成 → 被异步唤醒 = 噪音"（注册时机后移）
   ↓
v0.6.0 改回 "创建即注册" 试图修 "auto-fast-done 漏通知"
   ↓
v0.6.0-v0.6.3 引发批量重复（坑9，大灾）
   ↓
v0.6.4 回归 v0.5.7 后注册（接受漏 1，规避批量重复）
   ↓
v0.6.5 加 jsonl 轮询补注册（堵漏）
   ↓
v0.7.x dl-nextturn 扩展权威 + 跨会话过滤
   ↓
v0.8.x 投递层逐 bug 收敛（confirm+retry / 跨 realm 去重 / boot 窗口 / TOCTOU 防护）
   ↓
v0.9.0 host-native-first 收敛（砍补丁依赖）
   ↓
v0.9.1 死磕 session:send-custom（绕开 pi stale）
   ↓
v0.9.2 当前（README 标记）
```

**铁律回溯**（`PROJECT_REQUIREMENTS.md` §2）：
1. **同回合同步投递到位后不得再异步通知**（严禁回合内同步 + 收束后异步双投）
2. **每个任务整个生命周期只允许收到一条回执**（同步或异步，取决于 settle 状态）
3. **不重复通知 > 不漏一条**：评估用"会不会批量放大成几十条"做标尺

---

## 4. 当前版本（v0.9.x）核心判断

### 4.1 投递层架构（唯一权威：`extensions/dl-nextturn.js`）

```
handleFinal(task)
├─ _hfClaimed 同步占位（v0.8.9c，防 TOCTOU）
├─ sleep(2000) 等待 dlcore 终态稳定 + 给 consumedByWait 留时间
├─ 已 delivered → skip
├─ consumedByWait → 持久 markDelivered + suppress 占位
├─ canceledBy=agent → 静默（不回音壁）+ suppress
├─ ownThisSession 不通过 → skip
├─ STORE-PROBE 跨 realm 去重（v0.8.6）: q.delivered=true → yield
├─ tailSettled(sessionPath)
│   ├─ settled → deliverDeferredConfirmed（v0.8.5 confirm+retry，6s 窗，boot 窗口 retry 再武装）
│   └─ unsettled → steerViaBus
│       ├─ ① session:send-custom + triggerTurn:true（0.9.1 主路径，宿主原生同步）
│       ├─ ② pi.sendMessage({deliverAs:"steer"})（降级，仅 captured pi 有效时）
│       └─ ③ return "unusable" → 调用方走 deliverDeferredConfirmed
└─ 投递成功 → markDelivered + deferred:suppress（防双投）

handleStall(task)
├─ settled → 让位给 index.js（v0.8.3：避免双双熄 own 占位）
└─ unsettled → steer 投递 stallKey + suppress（notifyOnly 还旗给 index.js）
```

### 4.2 通道优先级

| 场景 | 通道 | 去重 |
|---|---|---|
| 未收束 + settle=false + sessionPath 有效 | **session:send-custom + triggerTurn:true**（主） → pi.sendMessage（备） → deferred（兜底） | markDelivered + suppress |
| 已收束 + settle=true | **deferred:resolve（confirm+retry）** | consumedByWait + markDelivered |
| 已收束 + settle=true 且无 pi | 走 deliverDeferredConfirmed（query+retry 双确认） | 同上 |
| canceledBy=agent（任意 settle） | **静默**（不回音壁） | suppress 占位 |
| canceledBy=user（已收束） | deferred:resolve 异步通知（带 userCanceled + hint） | 同上 |
| stall + settled | **让位**给 index.js（注册+resolve 权威对） | — |
| stall + unsettled | steer stallKey + suppress | _stallDelivered 旗 |

### 4.3 去重体系（多重保护）

```
内存旗（最快）: task._delivered / task._hfClaimed / task._stallDelivered
持久化旗（跨重启）: task.delivered / task._delivered via mgr.markDelivered
宿主 store 真值（跨 realm 唯一权威）: bus.request("deferred:query", {taskId}).delivered
占位抑制（防二次投递）: deferred:suppress 后 status=aborted, deliverySuppressed=true
消费语义: consumedByWait（wait 已拿到） / waitActive>0（wait 在守望）
```

### 4.4 兜底链路（"通知不丢"的三道保险）

1. **handleFinal 主路径**：`onFinal` 事件触发（瞬时，无轮询延迟）
2. **轮询定时器**：800ms 扫 tasks.json，重新 wire 未终态任务的 onceFinal（防 onFinal 漏接）
3. **onload 遗留兜底**（v0.8.7 延 6s + v0.8.8 对账宿主）：
   - 扫 manager.list() 终态任务
   - `_delivered / delivered` 已置 → skip
   - `deferred:query` 见 delivered=true → 就地补旗 skip
   - `deferredRegistered && !delivered` → resolve
   - `!deferredRegistered && (sessionId || sessionPath)` → registerDeferred（内部对终态立即 resolve）

### 4.5 不再依赖的能力（`PROJECT_REQUIREMENTS.md` §3.2）

| 名称 | 实测状态 |
|---|---|
| `deferred:steer` | 不存在（0.810 bundle count=0） |
| `deferred:suppress` | 补丁已回滚（reason 泄漏 bug） |
| `steeringQueue` | 不存在（bundle count=0，注释里的假设无效） |
| `pi.sendMessage` | 仍可用但 stale 风险高（会话替换/重载后必 stale） |

---

## 5. 当前架构的关键结论

### 5.1 "agent 消息线" 实际生效分布（基于 `docs/six-quadrant-test.md` §5 实测）

| 象限 | 理论通道 | 实测实际落地 |
|---|---|---|
| 1 快速同步完成 | session:send-custom / steer | **多数降级为异步 deferred**（pi stale / isStreaming=false） |
| 2 慢速异步完成 | deferred:resolve | ✅ 真正送达 |
| 3 快速同步取消（agent） | 静默 | ✅ 静默正确 |
| 4 慢速异步取消（user） | deferred:resolve | ✅ 真正送达 |
| 5 快速同步卡滞 | steer stallKey | **多数降级为异步 deferred** |
| 6 慢速异步卡滞 | index.js deferred register+resolve | ✅ 真正送达 |

> **核心现实**（d51a13d6 决定性重测）：**同步 steer 通道在真实运行的多数场景走不通**，下完通知实际常退化为异步 deferred。

### 5.2 "前端视图线" 不受影响——这正是用户看到"同步投递"的源头

- 卡片 webview 由 manifest contributes.cards 驱动，与投递层 API 解耦
- 600ms 轮询 `/download/status` 路由，只看 dlcore 的内存 state，**不关心** agent 是否真收到消息
- 即便投递层实际走的是异步 deferred（最常见），前端卡片照样显示"已送达"+"完成"+"路径"
- 用户视觉上"同步" = 前端轮询到位 + 投递层 fire 几乎同时发生

### 5.3 投递"看似失灵"的常见场景对照表

| 现象 | 真原因 | 投递层实际状态 |
|---|---|---|
| 前端显示"同步投递"但 agent 没回应 | 投递实际走异步 deferred，但前端轮询先到；agent 在下一回合才感知 | 投递**成功**（delivered=true），只是不是"同轮" |
| 前端显示"投递失败"但任务实际完成 | 卡片渲染 vs 投递层两套逻辑；"投递失败"文案可能指卡片 emit 失败（用户主动取消时） | 投递层按规则静默或异步通知正确 |
| 同一个任务前端多次刷新"已送达"提示 | 600ms 轮询 + 卡片内多次状态刷新（折叠/展开/重渲染） | 投递**单投**，无重复 |
| Agent 在新回合感知（"几秒后才告诉我"） | 同步 steer 失败，降级异步；唤醒收束会话需要新 turn | 投递**成功**（异步），符合 PROJECT_REQUIREMENTS §2 |

---

## 6. 关键结论（回答"投递是不是就失效了？"）

**不是。投递机制没失效，是它的设计本身就有两条线，前端视觉线和 agent 消息线各自独立。**

1. **agent 消息线** 在 v0.9.0/v0.9.1 已经收敛到 host-native-first：
   - 未收束 → `session:send-custom + triggerTurn:true`（宿主原生同步，绕开 pi stale）
   - 已收束 → `deferred:resolve`（confirm+retry 双确认）
   - 多重去重（内存旗 + 持久旗 + 宿主 query + suppress + consumedByWait）
   - 三道兜底（onFinal 主路径 / 800ms 轮询 / onload +6s 遗留兜底）

2. **前端视图线** 一直是独立的（manifest cards + iframe + 600ms 轮询）。它与投递层**没有任何 API 耦合**，前端"同步投递"提示只是状态字段的视觉反映，**绝不等于** agent 同轮感知。

3. **用户在前端持续看到"同步投递"提示，而 agent 侧感知不一致**的根本原因：
   - **pi stale 是常态**：扩展捕获的 pi 在会话替换/重载（compaction / recurring-loop）后必 stale，导致 `pi.sendMessage({deliverAs:"steer"})` 实际抛错降级；这是宿主架构决定，**不是 bug**。
   - **isStreaming 门**：宿主 `deliverCustomMessage` isStreaming 分支硬编码 `followUp`（0.769 是支持 steer 的，0.810 改没了），下载完成时 `isStreaming===false`，同步 steer 路径被锁死。
   - **结果**：下完通知实际常走异步 deferred（store `resolved + delivered=true` + jsonl followUp 配对消费），**agent 在下一回合才感知**。但前端卡片照常显示，**与投递层异步/同步无关**。
   - **视觉假象**：前端 600ms 轮询 + 投递层 fire 在同一时间窗口内，用户看到"同步投递"=卡片状态字段刷新 = 投递层 fire，**两者同时发生 ≠ 投递到 agent**。

4. **演进方向已清晰**（PROJECT_REQUIREMENTS §10 下一步）：
   - 已完成：v0.9.0 host-native-first 收敛
   - 已完成：v0.9.1 死磕 session:send-custom 主路径
   - 待做：标准六象限回归（稳定源 jsDelivr），每象限单投 + 通道正确
   - 待做：版本 bump 到 v0.9.2（README 已先行标 v0.9.2，package.json/manifest 仍 0.9.0）

5. **真正会让 agent 侧感知不到通知的场景**（极少，且都在六象限测试覆盖）：
   - 同步 steer 全链路失败 + 异步 deferred 也未确认 → pendingWake 累积 → 等宿主 flushUndelivered / 下次启动 onload 兜底
   - 已消费（wait）但 suppress 失败 → 占位留 pending → 宿主 flush 时仍可能二次异步投递（v0.8.2 修了 consumed 立即 suppress）
   - agent 取消 + canceledBy=agent 误标 → 静默正确（v0.8.4 修）

---

## 7. 证据索引

| 文件 | 关键段落 | 用途 |
|---|---|---|
| `README.md` 顶部 | 当前版本 v0.9.2；双通道通知；层间契约 | 全局架构 |
| `PROJECT_REQUIREMENTS.md` §2 | 投递语义表 + 铁律 | 设计原则 |
| `PROJECT_REQUIREMENTS.md` §3 | host 能力边界（含补丁/回滚/不存在） | 当前可用通道清单 |
| `PROJECT_REQUIREMENTS.md` §4 | host-native-first 原则 | 当前架构方针 |
| `踩坑记录.md` "2026-08-24 deferred 占位断链" | v0.5.0 修复 register 缺失 | v0.5.0 |
| `踩坑记录.md` 坑8 | v0.5.7 注册时机后移 | v0.5.7 |
| `踩坑记录.md` 坑9 | v0.6.0-v0.6.3 创建即注册弯路 | v0.6.0-v0.6.3 |
| `踩坑记录.md` 坑10 | v0.6.4 后注册 + 2s 复查竞态无法根治 | v0.6.4 |
| `踩坑记录.md` 坑11 | v0.6.5 jsonl size 轮询补注册 | v0.6.5 |
| `踩坑记录.md` 坑12 | v0.7.0-v0.7.3 dl-nextturn 扩展权威 + 跨会话 | v0.7.x |
| `踩坑记录.md` 坑12补 | v0.7.3 四项最小修复 | v0.7.3 |
| `extensions/dl-nextturn.js` "v0.8.1 bus steer 通道（主路径）" 注释 | v0.8.1 主路径 | v0.8.1 |
| `extensions/dl-nextturn.js` `if (t.consumedByWait...)` 块 | v0.8.2 consumed 立即熄占位 | v0.8.2 |
| `extensions/dl-nextturn.js` handleStall `if (settled)` 块 | v0.8.3 stall 让位 | v0.8.3 |
| `extensions/dl-nextturn.js` handleFinal `canceledBy=agent` 块 | v0.8.4 agent 取消静默 | v0.8.4 |
| `extensions/dl-nextturn.js` `deliverDeferredConfirmed()` | v0.8.5 confirm+retry | v0.8.5 |
| `extensions/dl-nextturn.js` handleFinal `STORE-PROBE` 段 | v0.8.6 跨 realm 去重 | v0.8.6 |
| `index.js` "v0.8.7 兜底串行化" 注释 | onload +6s 延后 | v0.8.7 |
| `index.js` "v0.8.8 投递前对账宿主" 注释 | query 优先 | v0.8.8 |
| `extensions/dl-nextturn.js` `BOOT_TS = Date.now()` | v0.8.9b boot 窗口持有 | v0.8.9b |
| `extensions/dl-nextturn.js` handleFinal `task._hfClaimed` 注释 | v0.8.9c TOCTOU 防护 | v0.8.9c |
| `extensions/dl-nextturn.js` `steerViaBus()` 注释 "0.9.1 死磕" | session:send-custom 主路径 | v0.9.1 |
| `lib/deferred.js` 头部注释 | deferred 占位 helper（v0.8） | 当前 async helper |
| `lib/registry.js` 头部注释 | TaskRegistry 双注册封装（v0.8） | 当前旁路注册 |
| `docs/delivery-判定标准.md` | 同步/异步唯一真判据 | 两条线评判标准 |
| `docs/six-quadrant-test.md` 顶部 + §5 | 同步注入定案 + 已实测基线 | 通道优先级实测 |
| `docs/sync-mechanism.md` §1-4 | 0.769 vs 0.810 同步机制差异 | 通道演化基线 |
| `docs/card-emit-guide.md` §1-3 | card.emit 不是投递层通道 | C3 定位 |
| `patch/README.md` | 主题 patch，与投递无关 | 排除项 |
| `manifest.json` contributes.cards | download + manager 卡片声明 | 前端视图线入口 |
| `package.json` / `manifest.json` version | 0.9.0（README 标 0.9.2） | 当前版本 |

---

*作者：audit · 基于 `<workspace>\hana-downloader` 全树实证（2026-09-01）*