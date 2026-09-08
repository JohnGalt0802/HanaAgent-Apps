# 同步投递机制探索记录（0.769 → 0.810）

> 落盘时间：2026-09-01
> ⚠️ **历史文档（宿主 0.769→0.810 时期）**。其中的 `deferred:steer` / `pi.sendMessage` 方案在 0.928.0 已全部失效（v1 契约废弃、宿主无该路由）。
> 当前机制见 `docs/host-changelog/v0.14.0-sync-restore.md`；本文保留作为机制演进档案，请勿据此实施。
> 目的：记录"同回合同步投递"在宿主 0.769→0.810 升级中的机制差异，作为魔改（pi + 宿主双改）的依据。
> 依据：源码走读（`artifacts/server/{0.769.0,0.810.0}-win32-x64/bundle/index.js`）+ 实测（`<workspace>/_temp/nextturn.log`）。

---

## 1. 核心认知

**"同回合同步投递" = 下载完成消息在 agent 未收束对话中，作为下一条生成 input 被读到。**

0.810 宿主**架构上删除了 0.769 的同步通道**（`deferred:steer` 路由），换成了 isStreaming 门控的瞬时 steer。下载完成时 agent 已结束生成（`isStreaming===false`），卡在门控上。

---

## 2. 0.769 vs 0.810 决定性差异

### 2.1 `deferred:steer` 路由（0.769 有，0.810 无）

**0.769** `bundle/index.js` @4665373：
```js
e.handle("deferred:steer", async ({sessionPath:sp, customType:ct, content:co, display:dp, details:dt}={}) => {
  if (!sp || co == null || !r) return { ok:!1, error:"deferred:steer requires sessionPath + content (coordinator missing?)" };
  try {
    const rr = await r.deliverCustomMessage(sp, {customType:ct||"hana-background-result", content:co, display:dp===!0, details:dt??null}, {deliverAs:"steer", triggerTurn:!1});
    return { ok: rr?. };
  }
})
```
**0.810**：`deferred:steer` **不存在**（bundle count=0）。

### 2.2 `deliverCustomMessage` isStreaming 分支（0.769 支持 steer，0.810 硬编码 followUp）

**0.769** @951340（isStreaming 分支）：
```js
if (s.session.isStreaming) {
  if (n?.requireIdle === true) throw new Error("session_busy");
  ...
  return await s.session.sendCustomMessage(r, { deliverAs: n?.deliverAs === "steer" ? "steer" : "followUp" }), ...;
}
```
**0.810** @953249（isStreaming 分支）：
```js
if (s.session.isStreaming) {
  if (n?.requireIdle === true) throw new Error("session_busy");
  ...
  const a = await this._withCapturedCustomMessageEntryId(
    s.session.sessionManager,
    () => s.session.sendCustomMessage(r, { deliverAs: "followUp" })   // ← 硬编码 followUp，丢了 deliverAs:"steer"
  );
  return ... "followUp" ...;
}
```

### 2.3 非 streaming 分支（0.769 / 0.810 一致）

**0.769** / **0.810** 非 streaming 分支都走：
```js
const i = n?.triggerTurn !== !1;   // 默认 true
...
return await s.session.sendCustomMessage(r, { triggerTurn: i }), ...
{ ok:!0, mode: i ? "triggerTurn" : "notifyOnly" };
```
即 `triggerTurn:false` → **notifyOnly**（把 custom entry 写入 jsonl，但不触发新 turn）。

---

## 3. 同步的真正机制（notifyOnly）

**关键**：`sendCustomMessage(msg, {triggerTurn:false})` = **notifyOnly** = 把消息作为 custom entry 写入 jsonl，**不触发新 turn**。

**同步场景**：agent 未收束但**非 streaming**（比如 agent 在 sleep 等待下载）时，下载完成 → notifyOnly 写 custom entry 进 jsonl → **agent sleep 结束后下一条生成读到这条消息** → **同步感知**。

**这是 0.769 能同步的真正通道**（`deferred:steer` → `deliverCustomMessage({deliverAs:"steer"})` → notifyOnly 注入）。

---

## 4. 实测确认（0.810 各通道全堵）

| 通道 | 实测 | 结果 |
|---|---|---|
| v1 `session:send` | caller 判 null | `session_busy` |
| v2 `session:send`/`send-custom` | caller 通过，但归属校验只允许发自家 plugin session | `does not belong to app` |
| `session:append-entry` | 源码注明 "never enters the model context" | 无同步 |
| `pi.sendMessage({deliverAs:"steer"})` | 底层 `steer` 层层卡 `isStreaming` | 非 streaming 不注入 |

**根因（体系性）**：0.810 删了 `deferred:steer` 路由 + isStreaming 分支丢了 `deliverAs:"steer"`。导致插件（v1/v2）都无法往 agent 主会话做 notifyOnly/steer 注入。

---

## 5. 魔改方案（pi + 宿主双改）

### 5.1 宿主（0.810 bundle）恢复同步通道

**改动点 A**（`deliverCustomMessage` isStreaming 分支 @953249）：把硬编码 `"followUp"` 改回 0.769 的：
```js
() => s.session.sendCustomMessage(r, { deliverAs: n?.deliverAs === "steer" ? "steer" : "followUp" })
```
→ isStreaming=true 且 `deliverAs:"steer"` 时，能走 steer 注入。

**改动点 B**（新增插件可调的 notifyOnly 通道）：恢复 `deferred:steer` 路由（0.769 @4665373 那段），让插件用 `bus.request("deferred:steer", {sessionPath, customType, content})` 触发 notifyOnly 注入（非 streaming 时写 entry，成为未收束 agent 下一条 input）。

### 5.2 插件（dl-nextturn extension）

`steerViaBus` 主线改为调 `deferred:steer`（宿主魔改后生效）：
```js
bus.request("deferred:steer", { sessionPath, customType:"hana-background-result", content, display:false, details });
```
未收束（unsettled）场景走 `deferred:steer`（同步 notifyOnly），已收束（settled）走 `deferred:resolve`（异步）。

---

## 6. 铁律（改完必守）

- **每个任务单投**（sync 到位后不再异步，避免双投）
- 同步判据：cmd 下一条生成 input 里能看到消息（非查日志）
- 改宿主 bundle 后**需重启宿主加载**（改前先备份 bundle + 登记 PATCHES.md）

---

## 7. 未完全确认（诚实标注）

- 0.769 的"下载完成同步"是否**完全**依赖 notifyOnly，还是另有机制——**待进一步验证**（当前以 notifyOnly + isStreaming steer 为最主要的两个可行通道）。
- `sendCustomMessage({triggerTurn:false})` 写 entry 后，**是否会被未收束 agent 下一条生成真正读到**——需实测确认（这是同步是否成立的最终判据）。
