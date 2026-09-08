# 下载投递六象限测试标准

> 版本：hana-downloader v0.14.0（宿主 0.928.0 基线）
> 目的：系统验证下载完成/取消/卡滞三类终态，在「快/慢」与「同步/异步」两种投递时机下的行为，确保投递层符合 dual-channel 语义。
>
> **⭐ v0.14.0 同步通道变更（2026-09-08）**：
> - 同步投递 = 注册 `agent/pre-step` adjudicator，把回执拼进**下一条 LLM API 请求的 messages**（依赖 bundle 魔改，见 `host-bundle-mods.md`）。
> - 下方「同步注入机制定案（session:send 绕开 stale）」那节**已作废**：session:send 对 plugin caller 走底部分支，agent 活跃期恒 `session_busy`；v2 app 的 steer 通道被 session 归属校验封死。
> - 同步判据：`plugin-data\hana-downloader\v2-load-debug.log` 出现 `agent/pre-step INJECTED | msgs N->N+1`。
> - **v0.14.0 同步回归四场景（必测）**：
>   1. 未收束 + 1KB 即时完成 → 应见 INJECTED
>   2. 未收束 + 1KB 限速（512B/s ≈ 2s）→ 应见 INJECTED
>   3. 收束后延迟完成（1KB @100B/s，收束后落地）→ 应走 deferred 唤醒，**不应**有 INJECTED
>   4. 长任务：1KB @100B/s + 工具挂起 55s → 30s 超时点不清空队列，工具返回后应见 INJECTED

> **⭐ 测法约束（v0.11.0 标准化，2026-09-01 起）**：
> - **快下载统一用 1KB 小文件**（不限速，几十毫秒完成）——象限 1/3/5
> - **慢下载统一用 10MB 大文件 + `speedLimit=500000`（500KB/s）≈ 20s 完成**——象限 2/4/6
> - **测试慢下载相关项必须在 20 秒内完成回合收束**——agent 真的 idle（不发任何未完成 toolCall，不调工具），让 `tailSettled=true` 走 deliverAsync 路径
> - 超过 20s agent 还在调工具 → tailSettled=false → enqueueSync 续等（30s + N×续等）→ fallback deliverAsync（这是混合路径，**不是真异步**）
>
> **为何 20s 这么紧**：10MB @ 500KB/s ≈ 20s 完成。handleFinal 在下载完成瞬间调，时机：
> - agent idle（`tailSettled=true`）→ 走 `deliverAsync` → `b.request("deferred:resolve", ...)` → host `pendingDeferredContentEvents` → 下次 `stream_start` → `flushDeferred` → `custom_message` 写入 session
> - agent 还在 streaming（`tailSettled=false`）→ 走 `enqueueSync` → 30s 定时器 → `sessionActive` 检查 → agent 还在续等 → 10min SYNC_MAX_WAIT_MS 后才 fallback deliverAsync（这个路径 **不是用户要的「异步投递」**）
>
> **host flushDeferred 触发点**（bundle 0.817.86 L50401）：**仅在 turn_start 触发**（`flushDeferred=true`），**没有自动 timer**。所以"真异步投递"必须依赖下一次 stream_start 事件（user message / QQ bridge 转发 / subagent fork / reconnect 等）。在 hanako 主会话里跑测试时，下一次 stream_start 通常是 user 消息（或者 QQ bridge 自动心跳），需要确保在 20s 收束后 session 不被持续工具调用占住。

> **⭐ 同步注入机制定案（2026-08-31 晚，宿主源码决定性确认）**：
> - **根因**：`pi.sendMessage({deliverAs:"steer"})` 依赖扩展加载时捕获的 `pi` 手柄，会话被替换/重载后必 stale（`This extension ctx is stale`）。宿主 deferred 路由清单**无** `deferred:steer`（插件 bus 调它必 `No handler`）。
> - **解法（session:send 绕开 stale）**：宿主 `session:send` 路由（bundle @7550442）的 steer 分支走 `steerSession`（**按 sessionPath 解析活会话，不依赖 captured pi**）。
>   - 插件 `bus.request("session:send", {sessionPath, text, deliverAs:"steer"})` **被允许**：`session:send` 在插件 bus 白名单 `IDe` 里（`Aae` 返回 true）。
>   - caller 判定：插件调用时 caller=`{pluginId:t}`，`Zi({pluginId:t})` 因 `kind` 非 `"plugin"` 走 `Lr(pluginId)`→**非 null**→进 agent 分支→`isStreaming && deliverAs==="steer"`→`xD()`→`steerSession`。
> - **代码改动**：`dl-nextturn.js` 的 `steerViaBus` 已加 `① session:send-custom(+triggerTurn) 优先 → ② deferred:steer → ③ pi.sendMessage → ④ deferred` 降级链。
> - **第一版 session:send 实测（c6dd3c2f, 2026-08-31 19:16，宿主 03:15 重启后）**：`session:send` 已**接通宿主**（不再 No handler），但报 `session_busy`——`deliverAs:"steer"` 的 `steerSession` 仅在会话 `isStreaming===true` 时接受，而测试时（sleep 40s）会话 `isStreaming=false` → 拒绝。**证明：session:send/steer 通道只在会话正在生成（streaming）时可用，不能覆盖「未收束但空闲」的常见场景。**
> - **第二版（正确通道）= `session:send-custom` + `triggerTurn:true`（bundle @7556119）**：宿主 `deliverCustomMessage` 在会话**非 streaming** 时走 `triggerTurn` 分支（@955020）——`sendCustomMessage({triggerTurn:true})` **主动触发一个新 turn 来消费消息**，emit `isStreaming:true`。它不依赖 `isStreaming`（不像 steer），也不依赖 captured pi（走 caller 校验 + sessionPath）。**这才覆盖「未收束但空闲」的同步注入。** 插件 `bus.request("session:send-custom", {sessionPath, customType, content, display:false, triggerTurn:true, details})` 即触发。
> 基线语义：**unsettled（会话未收束）→ 同步投递（steer）+ suppress 占位，防宿主收束后异步重投；settled（会话已收束）→ 异步投递（deferred:resolve），宿主投递唤醒收束会话，不 suppress。**

---

## 1. 二维坐标系

每个象限由两个独立维度组合而成：

### 维度 A：投递时机（同步 / 异步）
- **同步**：下载在**对话未收束**（unsettled，agent 还在运行）时达到终态。走 `steer` 通道，消息注入同一个 unsettled 对话，agent 在接下来同轮/下一轮就能读到。**投递成功后立即 suppress 占位**，阻断宿主之后再投。
- **异步**：下载在**对话已收束**（settled，agent 停止）之后达到终态。走宿主原生 `deferred:resolve`，宿主 DeferredResultStore 异步投递 `<hana-background-result>` 并惊醒收束会话。**故意不 suppress**（这是该状态唯一投递渠道）。

### 维度 B：终态类型（完成 / 取消 / 卡滞）
- **完成（done）**：下载成功收尾，`state=done`。
- **取消（canceled）**：任务被取消，`state=canceled`。区分取消来源：
  - `canceledBy=agent`：agent 用 `download-cancel` 工具取消 → **静默**（同步返回值就是结果，不再唤醒，避免回音壁）。
  - `canceledBy=user`：用户通过卡片按钮/`stop_task` 取消 → **正常通知**（agent 不知道的外界动作）。
- **卡滞（stall）**：下载连接停滞（无新数据超过 `stallTimeoutMs`），`type=download-stall`。

### 象限组合（3 终态 × 2 时机 = 6 象限）

| # | 象限 | 终端态 | 时机 | 预期投递通道 | 是否 suppress |
|---|------|--------|------|--------------|--------------|
| 1 | 快速同步完成 | done | unsettled | steer（同步） | ✅ suppress |
| 2 | 慢速异步完成 | done | settled | 宿主 deferred:resolve（异步） | ❌ 不 suppress |
| 3 | 快速同步取消 | canceled | unsettled | steer（同步，agent 取消则静默） | ✅ suppress |
| 4 | 慢速异步取消 | canceled | settled | 宿主 deferred:resolve（异步，user 取消才通知） | ❌ 不 suppress |
| 5 | 快速同步卡滞 | stall | unsettled | steer（同步） | ✅ suppress（stallKey） |
| 6 | 慢速异步卡滞 | stall | settled | index.js deferred register+resolve（异步） | ❌ 不 suppress |

> 注：象限 4/6 的“慢速”不改变通道，只改变终态到达时机相对对话收束的位置。慢速用大文件+限速让完成推迟到收束后，从而落入 settled 分支。

### 象限 7（v0.11.0+ 加入）：stall → 恢复 → done 双异步投递

**为什么要加这个象限**：象限 6 只验证 stall 独立异步投递。但**真实场景**是 stall 触发后连接恢复，下载继续完成——此时 stall 和 done 两条通知都需要异步投递。修复 `b63d85bc` 引入的「stall 抑制 done」 设计 bug 后，需专门测试「stall 异步 + done 异步」双通道都被正确投递（不被互相抑制）。

| # | 象限 | stall 路径 | done 路径 | 是否真异步 |
|---|------|-----------|-----------|-----------|
| 7 | stall 后恢复 done | settled→ deferred:resolve（异步，stallKey）| settled→ deferred:resolve（异步，main key）| ✅ 全程双异步 |

**关键纪律（与象限 2/6 同样严苛）**：
- stall 触发时 tailSettled=true 走 settled 分支（异步 stallKey）→ 要求 agent 在 stall 触发前已主动收束（**第一次主动收束**）
- done 触发时 tailSettled=true 走 deliverAsync（异步 main key）→ 要求 agent 在 done 触发前已再次主动收束（**第二次主动收束**）
- agent **绝不能**在两次 stall/done 触发之间查状态或调工具（任何 toolUse 都会让 tailSettled=false）→ 走 enqueueSync 同步注入（不是用户期望的「双异步」）
- stall 的恢复必须由**脚本**自动控制（不依赖 agent 调 /trigger-resume）——agent 调工具破坏 tailSettled=false

**测试设计**（v0.11.0+ 标配）：
- server-v5：自然下载到 50% 时 stall 35s（stallTimeoutMs=500 自然触发），等 POST /trigger-resume 恢复发剩余 → 完成
- stallController.py：后台轮询 host store stallKey resolved → 调 /trigger-resume → 等 main key resolved → 完成
- agent 行为：发起 download_file → 立即纯文本 stop=stop（第一次主动收束）；收到 stall HBR 异步唤醒后立即纯文本 stop=stop（第二次主动收束）；收到 done HBR 异步唤醒后验证
- 测试源：`<workspace>\_temp\stall-recover-server-v5.mjs` + `<workspace>\_temp\stall-controller.py`（作为六象限测试标配工具）

**验证**：
- host store 两个 key 都 resolved（stallKey + main key），各 status=resolved
- stall-debug 无 `injected` 行（双通道均不走 injectForSession）
- jsonl 两条 `customType=hana-background-result` 行（stall + done，交付到两个不同 deliveryId）

**避免失败的设计陷阱**：
- stallController.py `wait_stallkey_resolved` timeout 必须 ≥ 90s（自然下载到 50% 需 51s + 异步投递延迟）——之前 30s 太短，stallController 会早于 stall 触发时机超时退出
- stall-recover-server 不能用 initialDelay + sleep + 自动恢复的简单模式（会让 stall 在下载开始 0.5s 后触发，agent 还没收束）——必须让 stall 在下载到一半时自然触发

---

## 2. 触发方法（构造六象限）

### 通用工具
- 发起下载：`hana-downloader_download-file`（URL + fileName + 可选 speedLimit）
- 取消下载：`hana-downloader_download-cancel`（taskId）
- 查询状态：`hana-downloader_download-wait`（taskId，主动回查）
- 检查宿主投递：查 `~/.hanako\.ephemeral\deferred-tasks.json` 中该 taskId 的 `status` / `delivered` / `deliverySuppressed` / `result.state`
- 测试源（v0.11.0+ 测法标准化）：
  - **快下载：1KB 小文件**（不限速，几十毫秒完成）——用于象限 1/3/5（同步路径）
  - **慢下载：10MB 大文件 + `speedLimit=500000`（500KB/s）≈ 20s 完成**——用于象限 2/4/6（异步路径）
  - **关键纪律**：测试慢下载（象限 2/4/6）**必须在 20 秒内完成回合收束**（agent 真的 idle），否则会走 enqueueSync 续等路径而非 deliverAsync + host flushDeferred，**无法测试异步投递**

> **为何固定 20s**：10MB @ 500KB/s ≈ 20s。agent 必须在下载完成前完成回合收束（不发新工具调用、不发未完成 toolCall），才能让 `tailSettled=true` 走 deliverAsync → b.request("deferred:resolve") → host pendingDeferredContentEvents → 下次 stream_start → flushDeferred → custom_message 写入 session。**超过 20s agent 还在调工具 → tailSettled=false → enqueueSync → 30s 续等 → fallback deliverAsync（测的是合并路径，非真异步）**。
>
> **host flushDeferred 触发条件**（bundle L50401）：**仅在 turn_start 触发**——没有任何自动 timer。所以"真异步投递"必须依赖下一次 stream_start（user message / QQ bridge 转发 / subagent fork 等）。在测试中需要确保 session 有后续事件触发 flush，否则 background-result 会一直挂在 pendingDeferredContentEvents 里。

### 各象限构造

**象限 1（快速同步完成）**
1. 发起下载 1Mb.dat（不限速）
2. **禁止主动 download-wait 消费终态**：用 sleep 保持工具调用，模拟 agent 下载期间仍在做别的任务（真实情况），让下载自动完成
3. 下载在对话进行中（unsettled）完成 → 回合内收到一次 `<hana-background-result>`（同步 steer 投递）
- 验证：**只收到一条回执**；宿主 store `delivered=true` + `deliverySuppressed` 被标记（且后续收束不重投）→ **不出现第二条收束后异步回执**

> **重要纪律**：所有 unsettled 象限（1/3/5）禁止用 `download-wait` 主动消费终态——那会把「自动同步投递」误测成「主动消费静默」。统一用 **sleep 保持工具调用**（agent 下载期间仍在运行 = unsettled），让下载自动完成，观察宿主同步投递回执。

**象限 2（慢速异步完成）**
1. 发起下载 10MB.dat + `speedLimit=500000`（500KB/s，≈ 20s 完成）
2. **20 秒内**完成回合收束——agent 必须**不再调任何工具**（不发未完成 toolCall），让 `tailSettled=true` 走 deliverAsync 路径
3. 下载在收束后完成 → host `b.request("deferred:resolve", ...)` → pendingDeferredContentEvents
4. 下次 stream_start（user message / bridge / reconnect 等）触发 host flushDeferred → `custom_message` 写入 session
- 验证：收束后收到**一次** `<hana-background-result state=done>`；宿主 store `resolved`+`delivered=true`；**无 suppress**（宿主需要投，不能熄）
- **检查点**：`~/.hanako/.ephemeral/deferred-tasks.json` 中该 taskId 的 `deliverySuppressed=false`（未 suppress）
- **该象限只有在 agent 真正 idle 时才能正确测出**——如果 agent 超过 20s 还在调工具，走 enqueueSync 续等路径（30s + N×续等），不是真异步

> **调试检查**：可查 `plugin-data\hana-downloader\stall-debug.log` 末尾是否含 `DBG agent/pre-step adjudicator called`（plugin injectForSession 注入）vs `delivery.js logInfo("[delivery] settled ... → async deferred")`（deliverAsync 路径）。真异步走 settled + host flushDeferred；plugin inject 走 adjudicator called + injected。

**象限 3（快速同步取消）**
1. 发起下载 1Mb.dat
2. 立即 `download-cancel` 取消（agent 取消）
3. 对话未收束，agent 回查
- 验证：
  - 若 `canceledBy=agent`：**静默**，download-wait 同步返回 canceled+`.part` 保留，**无回执唤醒**；宿主 store 保持 pending/无 result（不投递不标记）
  - 若 `canceledBy=user`：**通知**，收到一次取消回执

**象限 4（慢速异步取消）**
1. 发起下载 10MB.dat + `speedLimit=500000`（500KB/s，≈ 20s 完成）
2. **20 秒内**完成回合收束（agent 真正 idle）
3. 在收束后 + 下载完成前，用户侧取消（卡片/stop_task，`canceledBy=user`）
4. 取消事件被 host 走 `b.request("deferred:resolve")` → pendingDeferredContentEvents
5. 下次 stream_start 触发 flushDeferred → custom_message 写入 session
- 验证：收束后收到**一次** `<hana-background-result state=canceled canceledBy=user>`；宿主 store `resolved`+`delivered=true`；**无 suppress**（user 取消是外界干预必须通知）
- **关键**：取消必须发生在收束后且 agent 真正 idle（tailSettled=true），否则 enqueueSync 路径会吃掉 cancel 事件

**象限 5（快速同步卡滞）**
1. 发起下载（限速极低或会停顿的源，如 `speedLimit=1000`）
2. 对话未收束，触发 `stallTimeoutMs` 无新数据
3. 收到 `<hana-background-result type=download-stall>` 通知
- 验证：回合内收到**一次** stall 通知；stallKey 占位被 suppress（防宿主二次投）；后续收束不再重投

**象限 6（慢速异步卡滞）**
1. 发起下载 10MB.dat + `speedLimit=500000`（500KB/s，≈ 20s 完成）
2. **20 秒内**完成回合收束（agent 真正 idle）
3. 在收束后 + 下载完成前，下载停滞超过 `stallTimeoutMs`（默认 30s）
4. 停滞事件被 plugin onStall 订阅捕获 → handleStall → enqueueSync 路径（tailSettled=true 走 deliverAsync）
5. 下次 stream_start 触发 flushDeferred → custom_message 写入 session
- 验证：收束后收到**一次** `type=download-stall` 异步回执；宿主 store 有 stall 占位（不 suppress）
- **注意**：stallTimeoutMs 默认 30s > 下载总时长 20s，stall 必然发生在收束后。可以在 stall-server 控速让 stall 提前触发
- **stall-server 替代**（更可控）：用 `<workspace>\_temp\stall-server.mjs`（发 headers+1KB 后静默 150s），stallTimeoutMs=30s 内必触发 stall

---

### 象限 7 构造（stall → 恢复 → done 双异步投递）

**背景**：象限 6 只验证 stall 独立异步投递。本象限验证 stall 触发后连接恢复、下载继续完成时，stall 和 done 两条通知**都走 deferred:resolve 异步 channel**（不是 injectForSession 同步注入、不是 stall 抑制 done）。

**标配工具**（v0.11.0+ 验证后作为测试基础设施）：
- `<workspace>\_temp\stall-recover-server-v5.mjs`：自然下载数据 → 发到 50% (stallFraction 默认 0.5) → 暂停 35s → 等 POST /trigger-resume → 恢复发剩余 → 完成
- `<workspace>\_temp\stall-controller.py`：后台轮询 host store，等 stallKey resolved → 调 POST /trigger-resume → 等 main key resolved

**测试源启动**：
```bash
# 1. 启动 server v5（50MB, stallAt 50%, stall 永久等 trigger-resume）
node <workspace>\_temp\stall-recover-server-v5.mjs 18951 50 0.5

# 2. 启动 stallController 后台（timeout 90s 足够覆盖自然下载到 50%）
python <workspace>\_temp\stall-controller.py
# stallController 内部：等 taskId 出现 → 等 stallKey resolved (90s) → 调 /trigger-resume → 等 main key resolved
```

**agent 步骤（不查状态不调工具，关键纪律）**：
1. `hana-downloader_download-file` 发起下载（URL=http://127.0.0.1:18951/test.bin, 50MB）
2. **第一次主动收束**：toolResult 回来后立即纯文本 stop=stop（不查状态）
3. 自然下载到 25MB 时 server 暂停 35s → stallTimeoutMs=500 触发 stall → handleStall 看 tailSettled=true → settled 分支 → deferred:register + deferred:resolve 异步投递 stallKey HBR
4. stall HBR 异步投递唤醒 agent
5. **第二次主动收束**：立即纯文本 stop=stop（选择继续下载，不查状态不调 /trigger-resume）—— stallController 会自动调 /trigger-resume
6. server 恢复发剩余 → done 触发 → handleFinal 看 tailSettled=true → deliverAsync → deferred:resolve 异步投递 done HBR
7. done HBR 异步投递唤醒 agent → 验证

**stallController timeout bug（v5 之前）**：
- stallController.py `wait_stallkey_resolved` 默认 30s 太短（自然下载到 50% 需 51s + 异步投递延迟）
- stallController 会早于 stall 触发超时退出 → 不能自动调 /trigger-resume
- **修复**：timeout 调到 90s（在 v5 测试中已修复，详见实测记录）
- **测试纪律**：检查 stallController log 确认“stallKey resolved: ...”后才进入验证阶段

---

## 3. 判定标准（通过条件）

> **⭐ 判定标准以 `docs/delivery-判定标准.md` 为准（2026-09-01 落盘）**。核心：
> - **同步** = 下载完成消息在会话**「未收束」**时，作为**当前回合的 input** 到达 agent，agent 在**同一个未收束回合**里感知并回应。
> - **异步** = 下载完成消息在会话**「已收束」**（agent 停止）后到达，需**唤起一个新回合**才交回 agent。
> - **第 1 步判收束**：jsonl 最后一条真实 message。`assistant+stopReason=="stop"` → 收束；`assistant+stopReason!=="stop"`（toolUse 等）/`toolResult`/`user` → 未收束。
> - **第 2 步看消息位置**：下载完成 entry 在**未收束**时到达 + agent **同回合继续生成**感知并回应 → **同步**；在**收束后**到达 + 唤起新回合 → **异步**。
> - ❌ **`custom_message + turn_input_consumption 配对` ≠ 异步**。它只是宿主记录"input 被消费"，**同步投递同样产生**（b7a75f0e 实测：有配对但未收束时到达=同步）。
> - ❌ **日志 `STEER(queue) sent` ≠ 真同步**。它只表示插件调了某通道，不代表消息成为回合内 input。

对每个象限，**通过**需同时满足：

1. **投递次数 = 1**：整个生命周期（含收束后）该任务只收到**一条** `custom_message(下载完成)`。**严禁双投**（回合内同步 + 收束后异步同时出现）。
2. **投递时机正确（按新标准）**：
   - unsettled 象限 → 消息在**未收束回合内**到达 + agent **同回合回应**（同步），并 `deferred:suppress` 防收束后重投（单投靠它）。
   - settled 象限 → 消息在**收束后**到达 + **唤起新回合**（异步），不 suppress（宿主需投）。
3. **宿主 store 状态**：`delivered=true`；同步象限另 `deliverySuppressed=true`（占位被熄），异步象限 `deliverySuppressed` 为 `false`（占位存活宿主已投）。
4. **终态语义正确**：done→`state=done`；canceled→区分 `canceledBy=agent`（静默）/`canceledBy=user`（通知）；stall→`type=download-stall`+stalledAt。
5. **回执格式**：宿主原生 `<hana-background-result ...>`。

### 双投判定（最多见的失败）
若同一 taskId 在**回合内收到一次**（同步通知）且**收束后又收到一次**（异步回执），即判双投失败。根因：unsettled 同步投递成功后**未 suppress 占位**。

---

## 4. 实测记录法

每个象限测试后填写：

```text
象限 #：
taskId：
终态/state：
canceledBy（如适用）：
received 回执数（回合内/收束后）：
宿主 store：status= / delivered= / deliverySuppressed=
是否双投：
是否通过：
```

### 宿主 store 检查命令

```python
import json
d = json.load(open(r'~/.hanako/.ephemeral/deferred-tasks.json', encoding='utf-8'))
v = d.get('<TASK_ID>')
print('status:', v.get('status'), '| delivered:', v.get('delivered'),
      '| suppressed:', v.get('deliverySuppressed'))
```

---

## 5. 已实测通过的基线

> **⚠️ 决定性重测（2026-08-31 19:03，recurring-loop 会话）`d51a13d6`**：正式安装 community 源 0.9.0 下，发起 1Mb 快速下载 → sleep 40s 保持 unsettled → 下载完成。**实测日志暴露真相**：
> ```
> skip d51a13d6: final already claimed (sync)
> STORE-PROBE ... status=pending delivered=false yield=false
> unsettled for d51a13d6 (done) → steer
> BUS-STEER ERR: No handler registered for "deferred:steer"
> STEER ERR for d51a13d6 (done): **This extension ctx is stale after session replacement or reload**
> STEER-FALLBACK deferred(confirmed) for d51a13d6 (done) + markDelivered
> ```
> **结论**：**即使在正式安装下，`pi.sendMessage({deliverAs:"steer"})` 也报 `This extension ctx is stale`**——因为该扩展捕获的 `pi` 手柄在会话被替换/重载（recurring-loop 模式 + compaction）后**必然 stale**，并非只有 dev 槽才 stale。**同步 steer 实际未能注入，静默降级为异步 resolve**（store `resolved/delivered=True`，jsonl 行 2958/2960 配对确认异步送达并消费）。
> **⇒ 用户铁律「未收束会话完成的下载走流式同步，其余走异步」的现实**：当前宿主下**同步 steer 通道在真实运行的多数场景走不通**（pi stale），下完通知实际总是退化为**异步 deferred**。这与「同步到位后不得异步」的目标存在真实差距，是插件侧捕获 pi 的机制局限，不是测试环境问题。

| 象限 | taskId | 状态 | 判定 |
|---|---|---|---|
| 1 快速同步完成 | `c518e03c` | 日志 `STEER(queue) sent`+suppress（`BUS-STEER ERR: deferred:steer 宿主无，预期`→ 走 `pi.sendMessage({deliverAs:"steer"})` 降级；此例**无 stale err**，是捕获到有效 `pi` 的案例） | ⚠️ **调用成功但注入存疑**（`pi.sendMessage` 未抛错，但 jsonl 无配对、agent 生成未复述注入消息；且 d51a13d6 证明同通道多数场景会 stale→降级异步。故「同步到位」证据不足，倾向实际也走异步或伪成功） |
| 2 慢速异步完成 | `17ecb1e5` | `settled→deferred resolve`；store `resolved`；文件 104857600B | ✅ 真正送达（jsonl 行 2650/2653 配对 → 异步 followUp 消费） |
| 3 快速同步取消 | `01dc30c0` | `canceled-by-agent → silent`；wait 返回 canceled，`.part` 保留 | ✅ 静默正确（无回执） |
| 4 慢速异步取消 | `bcc77389` | `settled(canceled)→deferred resolve`；`canceledBy=user` | ✅ 真正送达（jsonl 行 2687/2690 配对 → 异步 followUp 消费） |
| 5 快速同步卡滞 | `5ab241d8` | 日志 `STALL STEER sent`+suppress | ⚠️ **此任务最终实际以** `interrupted`（网络请求失败）告终，宿主在 17:45 通过**异步 deferred**投递并消费（jsonl 行 2748/2751 配对，deliveryId=`deferred-delivery:5ab241d8...`）。**证明：同步 steer 是它测试期走的第一条路；真正落地的回执经异步通道** |
| 6 慢速异步卡滞 | `7d71c741` | `stall settled→index.js deferred`；stall 占位 `resolved` | ✅ 真正送达（jsonl 行 2704/2707 配对 → 异步 followUp 消费） |

> **核心结论（2026-08-31 v3 修正，经 d51a13d6 决定性重测）**：
> - **同步 steer 通道（`pi.sendMessage({deliverAs:"steer"})` → `steerSession → s.session.steer()`）在宿主源码里真实存在、设计上同步**；它**不走 `hana-background-result` 配对**（那对配对是异步 followUp/deferred 通道的痕迹）。上一版用「jsonl 配对」判同步是**判据错了**，这点没错。
> - **但「同步 steer 实际生效」存疑，且多数场景不生效**：d51a13d6 重测实锤——正式安装下 `pi.sendMessage({deliverAs:"steer"})` 同样报 `This extension ctx is stale`（扩展捕获的 pi 在会话替换/重载后必 stale），静默降级为**异步 resolve**。所以**同步 steer 真正注入生效的场景很窄**，下完通知实际常走异步 deferred（store `resolved/delivered=True` + jsonl 配对消费）。
> - **真实边界（两层）**：① `isStreaming===true` 才被 `steerSession` 接受；② 即便 streaming，扩展捕获的 `pi` 须在当前会话仍有效（未被替换/重载）。任一不满足 → 降级异步。**所以「同步优先、异步兑底」的设计在宿主当前实现下，同步这条腿经常踩空。**


> **⚠️ 测试环境纪律（dev 重载 vs 正式安装，已由 d51a13d6 重测修正）**：同步通道（象限 1/3/5）需在正式安装（community 源 `plugins/`）下测。**但「正式安装下 pi 必有效」是错的**——d51a13d6 实测证明：只要会话经历替换/重载（如 recurring-loop 模式、compaction），扩展捕获的 `pi` 手柄**同样 stale**，`pi.sendMessage({deliverAs:"steer"})` 同样报 `This extension ctx is stale`。故：
  - **stale 不是 dev 专属**，凡会话被替换/重载后（不只是 dev 槽）必 stale。
  - 0.9.0 真正同步路径 = `pi.sendMessage({deliverAs:"steer"})`，其成功与否取决于**插件捕获 pi 时所在会话与当前会话是否一致**。跨会话替换后必 stale → 降级异步。
  - 所以「unsettled 同步 steer」实际**依赖捕获时机**，非稳定可靠通道；下完通知经常走异步 deferred。

> **⚠️ 补充（同步通道在 dev 重载下必然丢失，与上一条纪律一致，不重复展开）**：dev 重载下 `unsettled→steer` 必然走 `BUS-STEER ERR（deferred:steer 无）→ STEER ERR（pi stale）→ STEER-FALLBACK deferred`，**同步全程未落地**。故测试同步象限必须正式安装（见上）。

- **象限 1 快速同步完成（0.9.0 基线重测·旧记录，结论已订正）** `6f2ff25f-mthgslno`：发起 1Mb 下载 → **sleep 40s 保持 unsettled**（不主动 wait）→ 下载自动完成。store：`status=resolved`、`delivered=True`、`deliverySuppressed=None`、`result.state=done`、`consumedByWait=False`，文件完整落盘无 `.part`，**单投不双投** 通过。
  - **关键（印证 2s 延迟复查）**：因为**未主动 wait**（sleep 保持不消费），终态后 2s 复查时 `consumedByWait=false`、`waitActive=0` → **正常 `deferred:resolve` 自动投递**（delivered=True）。这是 2s 复查机制的正确行为——只有 Agent 主动消费（wait 拿到结果）才静默，未消费则投递。
  - **与 c518e03c 的差异（说明投递时机敏感）**：`6f2ff25f` 该实例 store 呈 `deliverySuppressed=None`（未走同步 steer，走异步 resolve），而 `c518e03c` 日志 `STEER(queue) sent`+suppress（同步 steer 触发）。**差异根因在会话收束点**：若 sleep 期间会话仍 `isStreaming`（agent 还在生成）→ `steerSession` 接受 → 同步；若下载完成前会话已收束（`isStreaming=false`）→ `steerSession` 返回 false → `xD()` 抛 `session_busy` → 插件降级异步 resolve。故「unsettled 时 steer 是否触发」取决于真实 `isStreaming`，非通道设计问题。
- **象限 1（初次实测·简版）** `b77c0092-mthgi4k3`：两次 sleep 保持 unsettled，store 同构（resolved/delivered=True/consumedByWait=False），单投。

- **象限 1 快速同步完成（本次实测·旧记录，结论已订正）** `b77c0092-mthgi4k3`：发起 1Mb 下载 → **两次 sleep（12s+25s）保持 unsettled**（不主动 wait）→ 下载自动完成。store：`status=resolved`、`delivered=True`、`result.state=done`、`consumedByWait=False`，文件完整落盘无 `.part`，**单投不双投** 通过。
  - **机制发现（订正）**：该实例 download 在 unsettled 期间完成但**未触发同步 steer**（`isStreaming=false` 锁死 → 只注册异步 deferred → 收束后宿主 flush 投递异步回执）。这说明**当时会话实际已收束（isStreaming=false）**，`steerSession` 拒绝 → 降级异步。**不能因此断言「所有 unsettled 都退化为异步」**——`c518e03c` 在真 unsettled（sleep 期间 isStreaming=true）就触发了 `STEER(queue) sent`。区分点仍是「下载完成时会话是否真 in streaming」。
- **象限 1（旧基线）** `a2008147`/`4166f636`：`resolved + delivered=true`，一次同步投递。注意 a2008147 曾出现「收束后异步二次投递」双投，根因 0.9.1 丢失 suppress —— 0.9.0 基线已修复，复测应单投。
- **象限 3 快速同步取消** `1739e94f`（agent 取消）：download-wait 同步返回 canceled，`.part` 保留，静默无回执。
- **象限 4 慢速异步取消** `35e55464`/`2e0b85c4`：`canceledBy=user` 收到一次取消回执。
- **象限 5 快速同步卡滞** `e2b31f54`：触发 `<hana-background-result status=running type=download-stall>` 通知。

---

## 5-b. 实测基线（community 源 v0.9.3 sync-first，2026-09-01）

测试环境：宿主 0.814.0，community 源 `~/.hanako\plugins\hana-downloader` 加载 v0.9.3 sync-first delivery（manifest 仍是 0.9.2，代码已 0.9.3），dev 槽已卸载（单版本避免多 plugin 回调累积）。本次实测为完整六象限重测基线。

### 关键发现

1. **sync 通道唯一可行的腿**：`pi.sendMessage({deliverAs:"steer"})` 在 community 源稳定运行下 PI-STEER 成功（deliveryId=`steer:...`），jsonl 真注入回合内 input。`session:send-custom + triggerTurn` 在 v1 插件下永远 ERR（v2 caller 校验），syncViaSessionCustom 实质走空。
2. **settled async 投递链路**：`deferred:resolve` → `markDelivered` → host `triggerTurn` → jsonl HBR 注入（deliveryId=`deferred-delivery:...`）。`triggerTurn` flush 需要 agent 收束窗口。
3. **agent 取消静默**：`canceledBy=agent` 路径 store 保持 pending 零投递，回音壁防护。
4. **canceledBy=user 投递**：用户在 UI 取消触发 task:cancel → `handler.abort(taskId, "user")` → settled async 投递 HBR（hint 含"用户手动取消（非故障，无需自动重试或换源）"）。
5. **stall 单投递**：单 stallKey 单 HBR；dev 槽下 `8a23fb43` 双 stallKey 双投 bug 在 community 单版本下消失。根因：dev 槽 + community 共存导致 `mgr.onStall` 回调累积（v0.9.2 + v0.9.3 同时注册同一 `globalThis.__dlTaskMgr`），community 单跑干净。
6. **stallTimeoutMs 字段 vs 实际 stall 检测周期不一致**（新发现 bug）：task.stallTimeoutMs 字段=500（hint 显示 500ms）但 stall 6 秒后才触发。dlcore.js `_stallTimer = setInterval(...)` 周期不等于 `task.stallTimeoutMs` 字段值。
7. **sync-first 名不副实**：v1 插件契约下 `session:send-custom` 永远走空，sync-first 实质 = "pi.sendMessage 单腿 + deferred async 兜底"。要真"双通道 sync"需要 v2 插件契约（manifestVersion:2 + apply(ctx)）。

### 象限实测

| 象限 | taskId | jsonl 投递 | deliveryId | 判定 |
|---|---|---|---|---|
| 1 sync done | cf46cb89-mti70xfx | L169+L174 | `steer:cf46cb89-...` | ✅ 真同步 |
| 1' sync done（复测）| 9ab8d0ef-mti726l4 | L184+L187 | `steer:9ab8d0ef-...` | ✅ 真同步 |
| 2 settled async done（stall）| bbf69d17:stall:1788238753868 | L224+L228 | `deferred-delivery:bbf69d17:stall:...` | ✅ stall 单投递 |
| 2 settled async done（done）| bbf69d17-mti769ow | L242 | `deferred-delivery:bbf69d17:446a...` | ✅ done 单投递 |
| 3 agent 取消静默 | 58321d2d-mti73bb5 | 0 HBR | — | ✅ 静默 |
| 4 user 取消通知（实测覆盖）| 9bc89723-mti73glb | L248 | `deferred-delivery:9bc89723:b9eba0a3-...` | ✅ canceledBy=user |
| 5 sync stall | 9bc89723:stall:1788238612823 | L211+L215 | `deferred-delivery:9bc89723:stall:...` | ✅ 单 stallKey 单投递 |
| 6 settled async stall | e927379d:stall:1788238754916 | L236+L240 | `deferred-delivery:e927379d:stall:...` | ✅ stall 单投递 |
| 6 settled async stall + cancel | e927379d-mti76i8l | L264 | `deferred-delivery:e927379d:d21440cc-...` | ✅ main canceledBy=user |

判定要点：
- 象限 1 HBR 注入在 agent `assistant toolUse` → `assistant toolUse` 之间（HBR type=custom_message，deliveryId=`steer:`），agent 在未收束回合内收到 + 同回合继续处理 → 真同步。
- 象限 2/6 同 taskId 收到 1 条 stall HBR + 1 条 done/canceled HBR（2 条不同类型不同 deliveryId，**不是双投**——stall 是通知不是终态回执）。
- 象限 4 原本需用户在 UI 取消 100Mb 慢速任务触发，但本次实测中用户在 UI 取消 stall 任务 9bc89723 时意外触发了 canceledBy=user 投递，验证了 canceledBy=user 投递链路（hint 含"用户手动取消"）。

### 实测基线对比

| 通道 | 0.9.2 community（之前实测）| 0.9.3 community（本次）| 变化 |
|---|---|---|---|
| sync 通道①（session:send-custom）| 永远 ERR（v2 caller）| 永远 ERR（v2 caller）| 无变化 |
| sync 通道②（pi.sendMessage steer）| 间歇 ERR（dev 时序）| **稳定成功**（community 稳定运行）| ✅ 改善 |
| deferred:resolve → triggerTurn | store delivered 标记但 jsonl 延迟投递 | ✅ 真投递到 jsonl | ✅ 改善 |
| agent 取消静默 | ✅ | ✅ | 无变化 |
| canceledBy=user 投递 | ✅ | ✅ | 无变化 |
| stall 双投（dev 槽多版本共存）| ❌ 双 stallKey | ✅ 单 stallKey | ✅ 修复 |
| stallTimeoutMs 字段 vs 实际周期 | 字段 vs 周期一致 | **不一致**（hint 500ms 但 6 秒触发）| ⚠️ 新 bug |

### 待修 bug（已转 dsh）

1. **dlcore.js stallTimeoutMs 字段 vs 检测周期不一致**：`_stallTimer = setInterval(...)` 周期不等于 `task.stallTimeoutMs` 字段值。hint 显示 500ms 但 stall 6 秒后才触发。需让 setInterval 周期用 `task.stallTimeoutMs`（当前可能是硬编码或别的常量）。
2. **manifest bump 0.9.3**：manifest.json 仍是 0.9.2 但代码已是 v0.9.3 sync-first 设计。代码顶部注释 `v0.9.3 sync-first delivery` 与 manifest 不一致，应同步 bump。
3. **v2 插件契约升级（远期）**：syncViaSessionCustom 真同步需要 v2 manifest（manifestVersion:2）+ apply(ctx) 契约。当前 v1 插件（class onload 模式）下 sync-first 名不副实——只剩 pi.sendMessage 单腿。

### 测试纪律更新

1. **sync 通道单腿（v1 插件）**：实测确认 `pi.sendMessage({deliverAs:"steer"})` 是 v1 插件下唯一可行的 sync 通道，`session:send-custom + triggerTurn` 永远走空。
2. **cancel 测试窗口**：sync-first 真同步让小文件完成太快，cancel 测试必须用大文件 + speedLimit 让下载足够长（>100s），agent 才有 cancel 窗口。1Mb + 默认不限速时下载 5 秒内完成，agent 失去 cancel 窗口（本次象限 3 首次 cancel 测试即遇此问题，第二次改用 speedLimit=10000 + 1Mb ≈ 100s 下载窗口才成功 cancel）。
3. **stallTimeoutMs hint ≠ 实际触发**：dlcore.js 实际 stall 检测周期不等于 `task.stallTimeoutMs` 字段值。hint 是从字段读，但 setInterval 周期是别的。修复前不要以 hint 作为 stall 触发时间参考。
4. **triggerTurn 投递延迟**：settled async 投递依赖 host `triggerTurn` flush，需要 agent 收束窗口。如果 agent 一直 round-trip（不停调工具），triggerTurn 队列里的 HBR 不会投递到 jsonl——store 标记 delivered=True 但 agent 看不到。下次 agent 收束 + 新回合启动时 triggerTurn flush 投递。

---

---

## 5-c. 象限 7 实测基线（v0.11.0+, 2026-09-05）

测试环境：宿主 0.817.86, community 源 hana-downloader v0.11.0（commit 6a2ea670 修复 stall 抑制 done 后）。测试源 stall-recover-server-v5 + stall-controller.py。50MB 文件 stallAt 0.5 stall 35s。

| 任务 | taskId | stall 路径 | done 路径 | 双异步 | 验证 |
|------|--------|------------|-----------|--------|------|
| q15-50mb-stall-async-final.bin | aee399c2-mtnx7vw2 | handleStall settled 分支 → deferred:resolve stallKey HBR | handleFinal deliverAsync → deferred:resolve main key HBR | ✅ | host store 双 key resolved, stall-debug 无 injected 行, jsonl 两条 custom_message |

**实测证据**：

- host store:
  - `aee399c2-mtnx7vw2:stall:1788584867325` status=resolved delivered=True result=stall
  - `aee399c2-mtnx7vw2` status=resolved delivered=False result=done
- stall-debug：无 `aee399c2` 的 `injected` 行
- jsonl:
  - L649 ts=2026-09-05T05:07:47.341Z customType=hana-background-result ← stall HBR 异步投递
  - L652 ts=2026-09-05T05:08:39.505Z customType=hana-background-result ← done HBR 异步投递
- stall → done 间隔 52s ≈ stall 暂停 35s + 恢复发剩余 17s（与设计吻合）

**这次关键纪律**：agent 两次主动收束都是**纯文本 stop=stop**，无任何 exec_command 查状态、无调 /trigger-resume、无 cancel。stallController 后台轮询 stallKey resolved → 自动调 /trigger-resume 让 server 恢复发剩余。

**stallController timeout bug（发现于 aee399c2 之前）**：
- stallController.py `wait_stallkey_resolved(taskId, timeout_s=30)` 太短
- stall 触发时机 = 自然下载到 50% 需 51s + stallTimeoutMs 500ms ≈ 52s
- stallController 30s 超时早于 stall 触发时机 → 退出 → 不能自动调 /trigger-resume
- **修复**：`timeout_s=90`（足够覆盖自然下载到 50% + 异步投递延迟）
- **测试纪律**：验证 stallController log 是否出现 "stallKey resolved: ..."——未出现说明 stallController 超时退出，需要重跑前检查 timeout

**与之前象限 6（stall 独立异步）对比**：
- 象限 6 3fbaea28 (q4-usercancel.bin)：stall 独立异步投递成功 + interrupted/canceled 终态被 stallNotified 抑制——被 stall 抑制后的 done 丢失（原始 bug）
- 象限 7 aee399c2：stall 异步投递成功 + done 也异步投递成功——不被 stall 抑制，双异步都送达
- **这是 commit 6a2ea670 “删除 handleFinal stall 抑制分支” 修复的完整验证证据**

---

## 6. 修改投递层时需回归的检查点

修改 `extensions/dl-nextturn.js` 的 handleFinal/handleStall 或 `lib/deferred.js` 后，必须全量回归六象限。重点：

1. **settle 状态判断**用 `tailSettled(sessionPath)`（尾部扫真实 message，别只看尾行，防 `turn_input_consumption` 尾巴误判）。
2. **unsettled** 同步投递成功后**必须 `deferred:suppress`**，否则收束后宿主重投（双投）。
3. **settled** 异步投递**必须不 suppress**，且走 `deliverDeferredConfirmed`（confirm + 重试），否则收束态通知丢失。
4. **agent 取消静默**：`canceledBy=agent` 不唤醒，仅同步返回值。
5. 改动 `extensions/`、`lib/` 走插件加载路径可直接重载；改 `tools/*.js` 需重启宿主进程。

### 象限 7 专项回归（修改 handleFinal/handleStall 时）

修改 `lib/delivery.js` 的 handleFinal / handleStall / enqueueSync / deliverAsync / deliverStallAsync 后，必须回归象限 7（stall→recover→done 双异步投递）。重点：

1. **stall 走 settled 分支**：stall 触发时 tailSettled=true → handleStall 调 deferred:register + deferred:resolve（stallKey）→ host store 有 stallKey=resolved
2. **done 不被 stall 抑制**：done 触发时 `_stallDelivered===true`（stall 已投递）也不跳过 done handleFinal 主路径 → host store main key=resolved
3. **stall + done 两 key 不互相干扰**：stallKey 和 main key 是独立 deferred 占位（stallKey=`<taskId>:stall:<ts>`，main key=`<taskId>`）
4. **stallController timeout ≥ 90s**（stallController.py）：保证自然下载到 50% 后 stallController 仍能轮询到 stallKey resolved
5. **agent 纪律**：测试时 agent 两次主动收束都是纯 stop=stop（不查状态、不调 /trigger-resume），如发现 stall-debug 出现 `injected` 行或 host store stallKey 未 resolved 则测试失败，需检查 agent 行为

**典型回归场景**：
- 重设 stall 抑制分支会丢 done（原始 b63d85bc bug）→ stall-debug 有 injected 行 + main key 未 resolved
- stallController timeout 太短 → stallController log 报 "stallKey not resolved within Xs" + server 暂停后不被恢复 + done 永远不触发
- handleFinal 收束判定 bug → enqueueSync 路径走 / settle 路径走 → stall/debug 不对
