# 投递判定标准（同步 / 异步）

> 落盘：2026-09-01
> **当前实现（v0.14.0 / 宿主 0.928.0）**：同步 = 注册 `agent/pre-step` adjudicator，把回执拼进**下一条 LLM API 请求的 messages**（依赖 bundle 魔改）；异步 = `deferred:resolve`。
> 判定标准本身未变，变的只是同步通道的实现方式；实测证据见 `docs/host-changelog/v0.14.0-sync-restore.md`。
> 目的：这是下载完成/终态消息投递的**唯一判定标准**。任何"同步"/"异步"的判断，必须按本标准实测，**禁止凭 jsonl 配对 / 日志关键字臆断**。
> 本文件是重做 0.9.1 投递层的判定基石。

---

## 1. 定义（用户确认）

- **同步**：下载完成消息，在会话**「未收束」**时，作为**当前回合的 input** 到达 agent，agent 在**同一个未收束回合**里感知并回应。
- **异步**：下载完成消息，在会话**「已收束」**（agent 停止）后到达，需要**唤起一个新回合**才交回 agent。

**一句话**：同步 = 未收束回合内到达；异步 = 收束后唤醒新回合才到达。

---

## 2. 实测判定（看 jsonl，2 步）

> 注（v0.14.0 实测）：**同步注入的消息不落盘到 jsonl**，它只存在于那一次 LLM API 请求的 messages 里（详见 §5）。
> 异步投递才会落盘（`customType=hana-background-result` 的 custom_message + `turn_input_consumption` 记账）。

### 第 1 步：判会话是否收束
找 jsonl **最后一条真实 message**（跳过 custom/custom_message/turn_input_consumption 等记账条目）：
- `assistant + stopReason===“stop"` → **收束**（settled）
- `assistant + stopReason!=="stop"`（toolUse 等） / `toolResult` / `user` → **未收束**（unsettled）

### 第 2 步：看下载完成消息 entry 的位置 + agent 后续生成
- 下载完成 entry（`custom_message customType=hana-background-result` 或 `role=toolResult`）在**未收束**时到达，且 agent 紧接着**同回合继续生成**（下一条 assistant，无收束间隔）感知并回应它 → **同步**
- 下载完成 entry 在**收束**（assistant+stop）之后到达，唤起**新的 assistant 生成回合**（新 turn）才交回 → **异步**

---

## 3. 判据红线（易错，必须记住）

- ❌ **`custom_message + turn_input_consumption 配对` ≠ 异步**。它只是宿主记录"这条 input 被消费"，**同步投递同样产生**。
- ❌ **日志 `STEER(queue) sent` / `BUS-STEER(...)` ≠ 真同步**。它只表示插件调用了某通道，**不代表消息成为回合内 input**。
- ✅ **唯一真判据 = 消息在未收束回合内到达 + agent 同回合回应**（jsonl 顶层结构判断）。
- ✅ **channel 是否"原生"用宿主已有 API；不能靠魔改 bundle 造通道**（0.9.1 原则）。

---

## 4. 记录规范

- 每次测试，先写**① 会话收束与否 ② 消息 entry 位置 ③ agent 回应是否同回合**，再下"同步/异步"结论。
- 结论标成色：**实测** / **代码推断**，不得混写。

---

## 5. 请求内取证法（2026-09-08 新增，用户要求）

**只看插件日志（`INJECTED msgs N->N+1`）不算验证**——那是插件自证，证明不了宿主真的把改后的 messages 发出去了。
必须证明回执出现在**那一次 API 请求的提示词里**。

### 5.1 两条路径的落盘差异（实测）

| 路径 | jsonl 落盘 | 消息生命周期 |
|---|---|---|
| 同步注入（`agent/pre-step`） | **不落盘** | 仅存在于那一次请求的 messages，之后不再可见 |
| 异步投递（deferred followUp/triggerTurn） | 落 `custom_message`（`customType=hana-background-result`）+ `turn_input_consumption` 记账 | 持久，后续请求可读到 |

### 5.2 取证两步

**第一步：让 agent 在请求内自证。**
下载一个**大小/内容不可预知**的目标（例如随机大小本地服务，返回 1000-8999 字节随机长度），
下载完成后 agent 在**下一次生成**里报出回执里的字段（如 `total`）。
agent 事前不知道这个值，jsonl 里也不应有任何查询它的记录 → 该值只可能来自请求内的回执。

**第二步：交叉验证路径。**
- 插件日志出现 `agent/pre-step INJECTED ... msgs N->N+1` → 同步注入
- jsonl 出现 `customType=hana-background-result` 的 custom_message → 异步投递

### 5.3 实测样本（2026-09-08 21:07，宿主 0.930.1 + v0.14.0）

- 随机大小服务（1000-8999B）→ 下载 `proof-random-size.bin`
- 插件日志：`13:07:36.773 INJECTED | msgs 375->376`
- agent 在 `13:07:42` 的 thinking 里报出 `total: 6691`（服务端随机生成，agent 事前未知，jsonl 无查询记录）
- jsonl 中该 taskId（`1cb1c2c5-mtsopgft`）**无** custom_message 落盘

**结论：同步注入成立。**

### 5.4 易错点

- ❌ 拿插件日志当唯一证据（自证）
- ❌ 拿"我看到了"当证据但值可从别处推断（必须用不可预知的值）
- ✅ 不可预知值 + jsonl 无落盘 + 插件日志 INJECTED 三者互相扣合
