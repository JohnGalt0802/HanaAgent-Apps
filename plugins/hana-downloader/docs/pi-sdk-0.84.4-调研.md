# Pi SDK 0.84.4 原生同步投递能力调研

> 调研时间：2026-09-03
> ⚠️ **形态结论仍有效**（Pi 0.84.4 的同步能力是 Extension 闭包形态，不是 globalThis），但当时基于的宿主版本是 0.817.86。
> 0.928.0 的最终结论是：v2 插件拿不到 `ctx.hooks`，仍靠 bundle 魔改暴露 `__sessionHooks`。见 `docs/host-changelog/v0.14.0-sync-restore.md`。
> 宿主版本：openhanako 0.817.86
> 当前 Pi 依赖：`@earendil-works/pi-{agent-core,ai,coding-agent}` @ 0.84.4
> 调研目的：验证"今天 Pi 底座更新了，可能加入了原生的同步投递能力"是否属实

---

## 结论（先说结论）

**是的，Pi 0.84.4 确实提供了原生"同步投递"能力，并且这套能力并非 0.84.4 才引入，是从 0.80.x 起逐步成型的（0.84.0 ~ 0.84.4 在 RPC / 队列 / UI prompt 三个方向又做了关键加固）。**

但要区分两件事：

1. **能力存在性**：原生能力已经成熟，覆盖了宿主魔改（`__sessionHooks.isSessionActive` + `agent/pre-step adjudicator`）所追求的"在下一轮 API 调用前同步注入消息"。
2. **API 形态兼容性**：宿主魔改的 API 形态（暴露到 globalThis 的 `__sessionHooks` registry + v1 插件运行时注入）**与 Pi 原生 ExtensionAPI 形态完全不同**。v1 插件目前跑在宿主 runtime 里，无法直接注册 Pi extension，所以**短期内宿主魔改点还摘不掉**。

另外发现一个关键事实：**0.84.4 = npm 当前 LATEST 版本**（发布于 2026-08-28，距今 6 天）。宿主 0.817.86 当前依赖的 0.84.4 已经是最新版本，"今天 Pi 底座更新了"应该指的就是 0.84.4 这版，不是 0.84.4 之后又有新版本。

---

## 一、版本事实

### 1.1 三个包当前 npm 状态（实测）

| 包名 | LATEST 版本 | 发布时间 | 距今 |
|---|---|---|---|
| `@earendil-works/pi-agent-core` | 0.84.4 | 2026-08-28 22:04 UTC | 6 天 |
| `@earendil-works/pi-ai` | 0.84.4 | 2026-08-28 22:05 UTC | 6 天 |
| `@earendil-works/pi-coding-agent` | 0.84.4 | 2026-08-28 22:07 UTC | 6 天 |

**0.84.4 之后无新版本发布**（npm `modified` 时间也是 2026-08-28，与发布同日）。
宿主 0.817.86 已经 `pin` 到 0.84.4，无需升级。

来源（实测）：
- `npm view @earendil-works/pi-agent-core time --json`
- `npm view @earendil-works/pi-ai time --json`
- `npm view @earendil-works/pi-coding-agent time --json`

### 1.2 最近 5 个版本（实测）

| 版本 | 发布时间 | 备注 |
|---|---|---|
| 0.84.0 | 2026-08-06 | 引入 `shouldStopAfterTurn` / `PiClient` 远程会话 / `message_update` 增量事件变更 |
| 0.84.1 | 2026-08-07 | 引入 `terminate` 工具调用拦截；`Agent.reset()` 修复 |
| 0.84.2 | 2026-08-14 | 引入 `expandPromptTemplates` 给 `pi.sendUserMessage()`；修复 `triggerTurn: false` 行为 |
| 0.84.3 | 2026-08-24 | 引入 `session_compact_failed` 事件；/thinking 选择器；PowerShell 工具 |
| 0.84.4 | 2026-08-28 | 引入 `ui_prompt_start/end`；RPC `clear_queue`；**修复 `triggerTurn: false` 插入位置 bug** |

### 1.3 仓库位置（实测）

三个包都来自同一个 monorepo：
- 仓库：`https://github.com/earendil-works/pi`
- 路径：`packages/agent` / `packages/ai` / `packages/coding-agent`
- 维护者：mitsuhiko (Armin Ronacher), badlogic (Mario Zechner), rwachtler

---

## 二、Pi 原生同步投递能力全景

下面这套能力是 Pi 0.80 ~ 0.84 累积形成的，**宿主魔改点要实现的能力全部有原生对应**。

### 2.1 核心投递 API：`pi.sendMessage(message, { deliverAs })`

来源：https://pi.dev/docs/latest/extensions#pisendmessagemessage-options（实测）

```ts
pi.sendMessage(
  { customType: "my-extension", content: "..." },
  { triggerTurn: true, deliverAs: "steer" }
);
```

`deliverAs` 三种投递模式：

| 模式 | 投递时机 | 触发 turn |
|---|---|---|
| `"steer"` (默认) | **当前 assistant turn 跑完所有 tool call 之后、下一次 LLM 调用之前** | 可选 `triggerTurn: true` |
| `"followUp"` | agent 完全没有 tool call 在跑时（fully settled） | 可选 `triggerTurn: true` |
| `"nextTurn"` | 排队等下一个用户 prompt，不打断当前 turn | 不触发 |

**关键匹配点**：`"steer"` 模式的官方描述就是 "Delivered after the current assistant turn finishes executing its tool calls, **before the next LLM call**" —— 这就是宿主魔改的 `agent/pre-step adjudicator` 想实现的语义。**这是官方原生的"在下一轮 API 调用前注入"机制。**

### 2.2 用户消息投递：`pi.sendUserMessage(content, { deliverAs })`

来源：https://pi.dev/docs/latest/extensions#pisendusermessagecontent-options（实测）

```ts
pi.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
pi.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });
```

行为：
- 非流式时立即发送并触发 turn
- 流式时必须指定 `deliverAs`：`"steer"` / `"followUp"`
- `expandPromptTemplates: true` 触发命令派发和 skill/prompt 模板展开

### 2.3 等待完全 settled：`ctx.waitForIdle()`

来源：同上（实测）

```ts
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

文档原话：**"Wait for the agent to fully settle, including automatic retries, auto-compaction retries, and queued continuations"** —— 这正是宿主魔改中 `__sessionHooks.isSessionActive` 想表达的语义（agent 是不是处于活跃态、是否可以安全投递）。

### 2.4 Lifecycle 事件：`agent_settled`

来源：https://pi.dev/docs/latest/extensions#agent_start--agent_end--agent_settled（实测）

```ts
pi.on("agent_start", async (_e, ctx) => {});
pi.on("agent_end", async (e, ctx) => {
  // event.messages - messages from this low-level run
});
pi.on("agent_settled", async (_e, ctx) => {
  // ctx.isIdle() is true here unless another extension started a new run.
});
```

文档原话：**"Use `agent_settled` for status integrations that need to know Pi will not continue running automatically."**

- `agent_start` / `agent_end`：单次低层 agent run 的开始/结束
- `agent_settled`：所有 auto-retry / auto-compaction / 队列 follow-up 都处理完了

### 2.5 Pre-LLM 拦截：`context` 事件

来源：https://pi.dev/docs/latest/extensions#context（实测）

```ts
pi.on("context", async (event, ctx) => {
  // event.messages - deep copy, safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

文档原话：**"Fired before each LLM call. Modify messages non-destructively."**

这是**最贴近宿主魔改的 `agent/pre-step adjudicator` 的官方钩子** —— 在每次 LLM 调用前可以非破坏性修改 messages。

### 2.6 Payload 替换：`before_provider_request` 事件

来源：https://pi.dev/docs/latest/extensions#before_provider_request（实测）

```ts
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));
  // return { ...event.payload, temperature: 0 };
});
```

文档原话：**"Fired after the provider-specific payload is built, right before the request is sent. ... Returning any other value replaces the payload for later handlers and for the actual request."**

可以替换整个 provider payload，包括 system instructions。

### 2.7 Agent 启动前注入：`before_agent_start`

来源：https://pi.dev/docs/latest/extensions#before_agent_start（实测）

```ts
pi.on("before_agent_start", async (event, ctx) => {
  return {
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

文档原话：**"Fired after user submits prompt, before agent loop. Can inject a message and/or modify the system prompt."**

### 2.8 AgentOptions：`shouldStopAfterTurn`（0.84.0 引入）

来源：CHANGELOG 0.84.0（实测）

```ts
// 在 turn 完成后、队列消息处理前、下一轮模型调用前停止
new Agent({
  shouldStopAfterTurn: true,
});
```

CHANGELOG 原话：**"Added inherited `AgentOptions.shouldStopAfterTurn` for gracefully stopping after a completed turn before queued messages or another model call are processed. ([#7367](https://github.com/earendil-works/pi/pull/7367))"**

这是个**完美的"卡 turn 边界"开关** —— 配合 `pi.sendMessage({ deliverAs: "steer" })` 可以实现"等当前 turn 完成 → 立刻注入 → 在下一次 LLM 调用前停止"。

### 2.9 队列管理（0.84.4 引入）

来源：CHANGELOG 0.84.4（实测）+ `npm view @earendil-works/pi-agent-core` 文档（实测）

```ts
// 0.84.4 新增 RPC
clear_queue  // 取出并清空 steering 和 follow-up 队列

// pi-agent-core 还提供
clearSteeringQueue()
clearFollowUpQueue()
clearAllQueues()
```

CHANGELOG 原话：**"Added RPC `clear_queue` to retrieve and remove queued steering and follow-up messages. (#8432)"**

### 2.10 UI prompt 区分（0.84.4 新增）

来源：CHANGELOG 0.84.4（实测）+ 扩展文档

```ts
pi.on("ui_prompt_start", async (event, ctx) => {
  // event.kind: "select" | "confirm" | "input" | "editor" | "custom"
  // event.title: prompt title when available
});

pi.on("ui_prompt_end", async (event, ctx) => {});
```

CHANGELOG 原话：**"Added `ui_prompt_start` and `ui_prompt_end` extension events so host integrations can distinguish active agent work from waiting on user-facing `ctx.ui` prompts. (#8355 by @cristinaponcela)"**

这套事件让宿主/状态集成能区分 "agent 在工作" vs "agent 在等你点 UI prompt"，是宿主魔改中"判定 agent 是否真的在跑"诉求的官方版。

---

## 三、宿主魔改 vs Pi 原生：映射表

| 宿主魔改点（0.817.86） | Pi 原生对应（0.84.4） | 匹配度 |
|---|---|---|
| `__sessionHooks` registry 暴露到 globalThis | `ExtensionAPI.on()` 注册事件 + `pi.sendMessage()` 主动投递 | ⚠️ 形态不同 |
| `__sessionHooks.isSessionActive` | `ctx.isIdle()` + `agent_settled` 事件 + `ctx.waitForIdle()` | ✅ 语义相同 |
| `ge` (hana engine) 暴露到 globalThis | `ExtensionContext` (`ctx`) | ⚠️ 形态不同 |
| `agent/pre-step adjudicator` "下一轮 API 调用前注入消息" | `pi.sendMessage(msg, { deliverAs: "steer" })` —— 文档原话 "Delivered after the current assistant turn finishes executing its tool calls, **before the next LLM call**" | ✅ 语义精确对应 |
| 同步等待 agent 结束 | `ctx.waitForIdle()` + `agent_settled` 事件 | ✅ 完全覆盖 |
| "改 messages 但不改 session 存储" | `context` 事件 —— "Modify messages non-destructively" | ✅ 完全覆盖 |
| "改 system prompt" | `before_agent_start` 事件可改 systemPrompt | ✅ 完全覆盖 |
| "替换整个 provider payload" | `before_provider_request` 事件 | ✅ 完全覆盖 |
| "在 turn 后立刻停下" | `AgentOptions.shouldStopAfterTurn` | ✅ 完全覆盖 |
| "清空待投队列" | `clear_queue` RPC / `clearSteeringQueue` / `clearFollowUpQueue` | ✅ 完全覆盖 |
| "区分 agent work vs 等用户" | `ui_prompt_start/end` 事件（0.84.4 新增） | ✅ 完全覆盖 |

**关键结论**：宿主魔改点要实现的**每一项语义**，在 Pi 0.84.4 都有官方对应。但**形态不一样** —— 宿主魔改暴露到 globalThis 是为了让 v1 插件能运行时访问；原生 API 是 Pi Extension 编译期/加载期通过 `ExtensionAPI` 闭包访问。

---

## 四、为什么宿主魔改点暂时摘不掉

**结论：形态兼容性是主要矛盾，不是能力缺失。**

1. **v1 插件的运行模型**：宿主 0.817.86 的 v1 插件运行在宿主 bundle 加载的 host runtime 里，宿主通过 `globalThis.__sessionHooks` + `globalThis.ge` 把魔改点暴露给它们，模拟出"扩展能监听 session"的效果。这是**host-side polyfill**。

2. **Pi Extension 的运行模型**：原生 Pi extension 是被 Pi 的 extension loader 用 jiti 加载到 Pi 进程里的模块，通过工厂函数拿到 `ExtensionAPI`，里面绑定了 `pi.sendMessage`、`pi.on` 等方法。这是 **Pi-side native**。

3. **两者 API 形态完全不同**：
   - v1 插件：`globalThis.__sessionHooks.isSessionActive` 全局访问
   - 原生：`pi.on("agent_settled", ...)` 闭包内回调

4. **如果要消除魔改**，需要：
   - 把 v1 插件改写成 Pi 原生 extension 形态（每个插件文件 export default function (pi: ExtensionAPI) {...}）
   - 让宿主 bundle 把它们当成 Pi extension loader 加载，而不是 host runtime
   - 这是一个**架构性重构**，不是简单替换 API

5. **0.84.4 升级的潜在收益**（即使魔改点保留）：
   - `triggerTurn: false` 行为修复（#8537）—— 宿主依赖的关键路径在 0.84.4 之前有"插到 tool_call 和 tool_result 之间"的 bug，0.84.4 修了
   - `ui_prompt_start/end` —— 状态判定更准
   - `clear_queue` RPC —— 多了一种清空队列的官方手段

---

## 五、用户传闻的核实

> "今天 Pi 底座更新了，可能加入了原生的同步投递能力"

**事实层面**：
- Pi 底座"更新"是真的：0.84.4 在 2026-08-28 发布，宿主已经 pin 在 0.84.4
- 但"原生同步投递能力"不是 0.84.4 才加入的，是从 0.80.x 起逐步成型的整套机制
- 0.84.4 的具体增量是：`ui_prompt_start/end`（#8355）+ RPC `clear_queue`（#8432）+ `triggerTurn: false` 位置修复（#8537）

**能力层面**：
- 原生同步投递能力**确实存在**，且语义与宿主魔改完全对应
- 主要 API 是 `pi.sendMessage(msg, { deliverAs: "steer" | "followUp" | "nextTurn" })`
- 但**无法直接替换宿主魔改**，因为 API 形态差异 + v1 插件运行模型不同

**所以这个传闻"半真半假"**：
- ✅ 真：Pi 0.84.4 提供了原生同步投递 API
- ❌ 假：这个能力是 0.84.4 新加的（实际上 0.80.x 就有 `triggerTurn`、0.84.0 加了 `shouldStopAfterTurn` 等）
- ⚠️ 误导：暗示宿主可以马上"切到原生"，实际上需要架构重构

---

## 六、关键词检索结果（搜索证据）

为完整记录检索过程，下面是按用户要求的关键命中（[实测] = 抓了实际页面 / 命令输出；[推断] = 从描述推导）：

### 6.1 完全命中（实测）
- `"sync delivery"` 同义：`pi.sendMessage({ deliverAs: "steer" })` "before the next LLM call" — **实测**（扩展文档原文）
- `"sessionHooks"` / `"isSessionActive"`：宿主魔改中的命名，**不在** Pi 官方 API 中 — **实测**（扩展文档全文搜索无此 hook 名）
- `"pre-step"` / `"pre-step adjudicator"`：宿主魔改中的命名，**不在** Pi 官方 API 中。官方等价是 `context` 事件 "Fired before each LLM call" 和 `before_provider_request` 事件 — **实测**
- `"deliverMode"` / `"deliveryMode"`：**官方有 `deliverAs`**（不是 `deliveryMode`）。第三方仓库 `basuev/pi-prompt-refiner` 引用了一个 `DeliveryMode` 类型，但**不是来自 pi-agent-core 官方 API** —— **推断**
- `"triggerTurn"` + `"steering"`：**实测**（CHANGELOG 0.84.2、0.84.4；扩展文档）
- `"queued messages"` / `"steering queue"`：**实测**（CHANGELOG；`@earendil-works/pi-agent-core` README 提到 `clearSteeringQueue, clearFollowUpQueue, clearAllQueues`）
- `"isSessionActive"`：**实测**无官方同名 API（archon.diy 的对比表里写了 "SessionHooks event vocabulary" 但那是 archon fork，不是官方 pi）
- `"deliverAs: 'steer'"`：官方文档原话 "Delivered after the current assistant turn finishes executing its tool calls, **before the next LLM call**" —— **实测**
- `"native sync"` / `"原生同步"` / `"真同步"`：搜索无直接命中 Pi 官方文档使用这些术语。宿主魔改的内部命名 — **实测**

### 6.2 半命中（推断）
- `archon.diy` 的 AI 助手对比表里列了 "SessionHooks event vocabulary" 列为 Pi 的能力 — 推断这是 archon fork 对 Pi extension event 体系的**重新命名**，不是 Pi 官方 API 命名
- `PrimeIntellect-ai/prime-agent` 引用 `AgentSessionMessageDeliveryMode` — 这是 prime-agent 自己的抽象层，不是 Pi 官方

### 6.3 完全未命中（实测）
- `isSessionActive`、`sessionHooks`（在 pi 官方 API 中）— 无
- `agent/pre-step`（在 pi 官方 hook 名中）— 无（官方是 `before_agent_start` / `context` / `before_provider_request`）
- "sync delivery" / "synchronous delivery"（在 pi 官方文档术语中）— 无（官方用 "queue" / "steering" / "deliver"）
- "native sync"（在 pi 官方文档术语中）— 无

---

## 七、openhanako 仓库近况

由于 GitHub 直连抓取超时（web_fetch fetch failed），下面是 web_search 推断的近况：

- openhanako 仓库仍然活跃，最近一次 catalog 同步是 2026-08-26（skillselion）
- `PLUGINS.md` / `PLUGINS_EN.md` 提到 "Extensions（Pi SDK 事件拦截）"，已使用 Pi Extension 路线
- `README_EN.md` 提到 "Hana-managed Pi SDK runtime resources live under `${HANA_HOME}/runtime/pi-sdk/`"
- 搜索没找到明确的 "0.84.4 升级"、"原生同步投递" 相关 issue / PR 标题

**[不确定]**：openhanako 最近 30 天是否有专门针对 0.84.4 新增能力（`ui_prompt_start/end`、`clear_queue`）的 issue 或 PR —— GitHub 直接抓取超时，未能确认。

---

## 八、对宿主魔改点的建议（仅事实陈述，不做决策）

依据上面的事实，可以**核实但不决策**的几个点：

1. **魔改点 L176280 `__sessionHooks` registry + `ge` 暴露到 globalThis**：0.84.4 原生没有等价暴露到 globalThis 的 API（官方都是 ExtensionAPI 闭包）。如果要保留现有 v1 插件运行模型，魔改点暂时必须保留。

2. **0.84.4 修复的 `triggerTurn: false` 位置 bug（#8537）**：宿主依赖的 "triggerTurn 注入消息" 路径在 0.84.4 之前可能踩到这个 bug。如果宿主魔改点是基于这个机制，升级到 0.84.4 反而会改变行为（消息不再被插到 tool_call 和 tool_result 之间，而是附加到本轮工具结果之后）。

3. **`ui_prompt_start/end`（0.84.4）**：如果宿主想做"区分 agent work vs 等 UI prompt"，原生有官方事件。

4. **`AgentOptions.shouldStopAfterTurn`（0.84.0）**：配合 `pi.sendMessage({ deliverAs: "steer" })` 可以实现"卡 turn 边界 + 同步注入"。但这是 Agent 层 API，需要在 Agent 构造时传入，不是 extension 层动态注入 —— **和宿主魔改的 `agent/pre-step` 注入路径不完全一致**。

5. **架构重构（仅供参考）**：如果未来希望消除魔改点，需要把 v1 插件改写成 Pi extension 形态，让宿主 bundle 把它们作为 Pi extension loader 加载。

---

## 附录 A：本调研未确认的事项

- [不确定] openhanako 最近 30 天是否有针对 0.84.4 的升级 / 原生同步投递的专门 issue / PR —— GitHub 直连抓取失败
- [不确定] `archon.diy` 表格里 "SessionHooks event vocabulary" 是不是 Pi 官方 API 命名 —— 推断是 archon fork 自己的封装，不是官方
- [不确定] `basuev/pi-prompt-refiner` 引用 `DeliveryMode` 的具体来源 —— 没抓到文件，可能是自有类型定义

## 附录 B：本次检索来源清单

实测来源：
- `npm view @earendil-works/pi-{agent-core,ai,coding-agent} time --json`
- `npm view @earendil-works/pi-agent-core --json`
- `https://app.unpkg.com/@earendil-works/pi-coding-agent@0.84.4/files/CHANGELOG.md`（CHANGELOG 全文）
- `https://pi.dev/docs/latest/extensions`（扩展文档全文，事件 / API 部分）
- `https://github.com/earendil-works/pi/issues/403`（steering vs queue 设计讨论 — web_search 摘要，fetch 失败）
- `https://github.com/earendil-works/pi/issues/2616`（SessionManager sync-only — web_search 摘要）

间接来源（web_search 摘要）：
- `https://github.com/earendil-works/pi/releases`
- `https://pi.dev/news/releases`
- `https://github.com/archon.diy/getting-started/ai-assistants/`（提到 "SessionHooks event vocabulary"）
- `https://github.com/basuev/pi-prompt-refiner`（提到 `DeliveryMode`）
- `https://github.com/liliMozi/openhanako/blob/main/PLUGINS.md`（提到 "Extensions（Pi SDK 事件拦截）"）

抓取失败：
- `https://github.com/earendil-works/pi`（直连超时）
- `https://github.com/earendil-works/pi/issues/403`（web_fetch fetch failed）
- `https://github.com/liliMozi/openhanako/pulls?...`（web_fetch fetch failed）
- `https://www.npmjs.com/package/@earendil-works/pi-agent-core`（HTTP 403）
