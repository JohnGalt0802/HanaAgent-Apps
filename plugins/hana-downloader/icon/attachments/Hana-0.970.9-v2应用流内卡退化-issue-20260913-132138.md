# Issue：Hana 0.970.9 —— v2 App 的聊天流内嵌卡片链路退化

- 宿主版本：HanaAgent **0.970.9**（win32-x64）
- 对照基线：**0.946.2**（同一份应用代码在那时工作正常）
- 复现应用：`hana-downloader`（v2 App，`manifestVersion: 2`）
- 定位方式：读 `bundle/index.js` + 在 `voe()` 内临时插诊断日志（已还原，零残留）
- 日期：2026-09-13

---

## 一、摘要

v2 App 工具返回的 `details.card` 在 0.970.9 上**完全不再进入聊天流投影**，卡片被静默丢弃。
宿主自己并不知道，仍在工具结果里追加：

```
Card "下载 xxx" rendered. cardInstanceId: a_xxxxxxxxxxxxxxxxxxxx (for ui_inspect), cardEntityId: app-card:a_xxx …
```

所以从工具结果表面看一切正常，只有聊天流里没有卡。

**影响面**：所有把操作卡放在工具结果里的 v2 App，不止本案例的下载器。

---

## 二、复现

1. 装任一 v2 App，其工具返回：

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "details": {
    "card": { "pluginId": "<appId>", "route": "/card.html", "title": "...", "cardForm": "flush" }
  }
}
```

2. 调用该工具。
3. 查 `GET /api/sessions/messages?path=<session>`：
   - 期望：`blocks` 里出现 `type: "plugin_card"`（带 `channel: "app"`）
   - 实际：**0 条**

---

## 三、根因（0.970.9 bundle，行号为该文件内位置）

`hV()`（~53565）是工具结果与自定义消息共用的投影入口：

```js
function hV(t, e, s, i, r) {
  const a = Poe[J_t(t, e)];                     // ← J_t 修正出来的真名，只喂这张内置渲染器表
  if (a) { … }
  const c = r?.resolveAppMessageRenderer(t);    // ← 用的是原始 t
  if (c) { 产卡，带 channel:"app" } else {
    const d = r?.resolveToolOwner(t);           // ← 也是原始 t
    const p = Z_t(e, typeof d == "string" && d ? d : null, l);
    p && o.push(p);
  }
}
```

链路逐环：

1. 对 **v2 App 的工具结果**，宿主传进来的 `toolName` 是 SDK 桥接的统一别名 **`tool_call`**；
2. `J_t(t, e)`（~53560）的职责正是在这种情况下从 `details.bridgedTool.name` 取真实工具名，
   但它的返回值**只用于查 `Poe` 表**，**归属解析两步用的仍是原始名 `tool_call`**；
3. `voe()`（~53498）拿 `tool_call` 逐个问已加载 App 是否拥有该工具名，必然 `matched = []` → 返回 `null`；
4. `Z_t()`（~53565 起）在 owner 为 `null` 时**照样产卡，但不带 `channel: "app"`**；
5. `Qoe()`（~53611）过滤时，对没有 channel 的卡要求 v1 `pluginManager` 认识它，
   而 v2 App 不在那张表里 → **静默丢弃**，连一条日志都不留。

---

## 四、实测证据

### A. 工具名册是好的，坏的是查询键

在 `voe()` 内插临时日志（已还原），重启后触发共 66 条查询记录：

```
exec_command: 29    loop_control: 9    tool_call: 6    write: 6
read: 5             write_stdin: 4     edit: 3         web_search: 2
grep: 1             ls: 1
download-*: 0        ← 一次都没有
```

单条样例（名册本身齐全，问题在查询键）：

```
[DIAG-voe] tool="exec_command" apps=[
  jimeng-cli(loaded, owns=false, names=[]),
  hana-downloader(loaded, owns=false, names=[download-file|download-wait|download-cancel|download-command]),
  powershell-tool(loaded, owns=false, names=[powershell|powershell_task|powershell_cancel]),
  …
] matched=[]
```

宿主内置工具（`exec_command` / `read` / `write` …）用的是**真实名**，`owns=false` 属正常；
v2 App 工具那 6 次 `tool_call` 就是它们的「残影」。

### B. 在工具返回值里补 `details.bridgedTool` 无效

试过由 App 自己补上：

```json
"details": {
  "card": { … },
  "bridgedTool": { "name": "download-file", "server": "hana-downloader" }
}
```

宿主持久化时**确实**把它写进了会话记录（历史投影也读得到），但卡片依旧不出。
原因就是上面第 2 条：`J_t` 的结果根本没被归属解析使用。
**所以「给 SDK 桥接工具填 bridgedTool」这条修法不成立。**

### C. 投影层没有任何报错

宿主日志里没有 `dropping plugin card: claimed pluginId … !== tool owner …` 之类的警告，
说明归属是「没查出来」，而不是「查出来但不匹配」。

---

## 五、对照：0.946.2 的行为

- 同一份 `details.card` 能正常投影成聊天流**内联卡**，渲染在**工具调用块下方**；
- 卡片随工具返回**立即出现**（实时），不需要等回合结束；
- 目标形态（本案例）：宽度 550px 的实时下载进度卡。

---

## 六、建议修法（任一即可）

**修法 1（最小改动，两处）**：`hV()` 里归属解析改用修正后的名字

```js
const c = r?.resolveAppMessageRenderer(J_t(t, e));
const d = r?.resolveToolOwner(J_t(t, e));
```

已确认 `resolveToolOwner(t)` 与 `resolveAppMessageRenderer(t)` 在 bundle 里**各只有 1 处**，
替换是安全的。（我们按这个思路准备了本地补丁，尚未对宿主施加。）

**修法 2**：给 SDK 桥接工具的实时事件填 `details.bridgedTool`（或直接在事件里传真实工具名），
让 `J_t()` 有输入。注意单独填 `bridgedTool` 不够，必须配合修法 1。

**修法 3**：若产品上不再支持 v2 App 的工具结果卡，请在 APPS.md 明确写出，
并提供「实时内联」的替代通道——目前的替代方案不具备实时性（见下）。

---

## 七、附带问题（同一批观测到的）

### 1. `session:send-custom` 在流式中必然 followUp，卡片无法实时出现

流式期间调用 `session:send-custom`，回执恒为：

```json
{ "ok": true, "mode": "followUp", "customType": "app:hana-downloader/download", "entryId": null, "sessionId": "…" }
```

消息排到**本回合结束后**才落地；请求体 `AppSessionSendCustomRequestV2`
（`scope / content / customType / display / details / triggerTurn`）里没有控制投递时机的字段。

**后果**：卡片总在整轮对话结束后才出现。对小文件下载来说，用户看到的就是一张完成态的卡，
实时性完全丧失——而这正是 `details.card` 那条正路本来能提供的。

**另一个副作用**：`display: true` 的自定义消息会被排进本会话的后续输入，
也就是说**一定会进模型上下文**。2026-09-13 那次 138 圈自循环就是这么来的
（内容是祈使句「下载 x」，下一轮被模型当成新指令执行）。

**建议**：给 `display: true` 且不触发回合的自定义消息开一条「即时落地」档位，
或提供真正的 display-only 通道。

### 2. `cardInstanceId` 在实时投影与历史投影下不一致

同一条自定义消息：

| 投影时机 | cardInstanceId |
| --- | --- |
| 实时（流式中） | `a_eb97f56cf57258bc2d2b` |
| 历史（重读会话） | `a_53e97e5025f56d8cbe7d` |

推测原因：`F$e({ stored, pluginId, route, toolCallId, messageId, customType })` 里的 `messageId`
在两处取值不同（实时用流式临时 id，历史用持久化 id）。

**后果**：卡片在会话重载后**丢失身份**，App 无法稳定绑定「这张卡 ↔ 它对应的对象」，
只能靠加载顺序推断（不可靠，实测错过）。

**App 侧可用的缓解**：往 `details.cardInstanceId` 里给一个符合 `^a_[0-9a-f]{20}$` 的值，
宿主会**原样采用**——实测 `sha256(appId:taskId)` 取前 20 位，宿主回报的 id 与 App 算出的一字不差。
但这条走的是**工具结果**的 details；`session:send-custom` 的 `details.cardInstanceId`
是否同样被采用，需你确认。

**建议**：让同一张卡的实例 id 在两种投影下保持一致，或在文档里写明 App 可以自带稳定 id。

### 3. 聊天流卡片的宽度不可控（长期缺口，非本次回归）

- `hana.ui.resize({ width })` 在聊天流插件卡挂载位**没有接收方**（宿主的 resize 桥只发 height）；
- 宽度上限 = 卡壳 `clientWidth`：纯工具调用时是折叠块（`--chat-task-block-width: 348px`），
  消息里带文字时是聊天列宽；
- 0.970.9 新增的 `details.card.preferredWidthPx`（服务端校验 240~1200）是唯一的声明式宽度通道，
  但它**挂在工具结果卡那条路上**，而那条路现在是坏的。

**后果**：0.970.9 下想把进度卡设成 550px 做不到（0.946.2 下同样做不到，属长期缺口）。

**建议**：给 `ui.resize` 的 width 补接收方，或允许 `contributes.cards[]` 声明宽度提示，
或至少在 APPS.md 尺寸章节写明「width 上报不生效，上限为卡壳 clientWidth」，
省掉每个 App 作者各撞一次墙。

### 4. `POST /api/extensions/:ref/reload` 之后工具 RPC 通道失效

本地目录安装的 App，原地重载后：

- App 装载成功（apply / 工具注册 / 引擎就绪的日志都正常）；
- App 自己的后端路由**仍可访问**（`/api/apps/<id>/routes/...` 正常返回）；
- 但**工具调用**报：

```
App tool "download-file" failed: RPC peer closed; cannot call callback.tools.execute
```

说明重载换了 App 子进程，宿主侧工具调用的 RPC 通道仍指向已消失的旧 peer；
路由是逐请求解析的所以还活着，工具 RPC 是常驻连接就断了。

**影响**：开发期的 reload 无法用于验收，每次都要重启宿主（约 20~40 秒）。

**建议**：reload 时重建工具 RPC 通道。

### 5. 并发投递被合并

同一时刻的多条 `session:send-custom`，宿主的 followUp 队列会合并（3 条只落最后 1 条）。
与 `callToken` 约 25 秒的寿命叠加，App 侧只能就地投递、无法排队。

---

## 八、本案例应用的当前状态

- 应用：`hana-downloader` v1.0.0（v2 App），宿主基线 0.970.9
- 目标形态：每次发起下载，在**工具调用块下方**内联一张**宽度 550** 的实时进度卡
- 现可用形态：卡片改走 `session:send-custom` + `contributes.messageRenderers`，
  宽度 550 由卡片页面自行上报（`hana.ui.resize` + `hana-card-resize` 兜底），
  **但卡片出现在回合结束后**，且会在会话里留下一条「【下载记录】…」的自定义消息
- `details.card` 正路按本文档所述已封死

---

## 九、附件

- 应用目录：`D:\HanakoWorks\hana-downloader-app`
- 本地诊断材料：`hana-downloader-app/docs/` 下的
  `宿主缺陷-v2应用卡片投影丢工具名.md`、`重构说明.md`、`踩坑记录.md`（第 10~12 条）
- 本地已备好按「修法 1」写的宿主补丁（`_tools/hana-host-patches/apply-patches.mjs`，
  `--check` 验证锚点唯一、通过），尚未对宿主施加
