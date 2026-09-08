# stall → 恢复 → done 通知丢失 bug 修复

> 时间：2026-09-04
> 宿主：openhanako 0.817.86 / hana-downloader v0.11.0
> commit：6a2ea670
> 严重度：**高** —— 用户视角下"下载卡顿之后又好了"完全失声，agent 永远不知道成功

---

## 1. 现象

下载触发 stall 通知后，连接恢复并最终完成 → **`done` 通知被吞**。

- tasks.json: `state=done, delivered=False`
- jsonl 无对应 HBR
- 之前 stall 通知投递成功（独立 stallKey），但**主 taskId 的终态永远不到**

## 2. 复现条件

`stallTimeoutMs=500` 的前提下：

1. 下载开始，前 64KB 数据到达
2. 连接停滞 ≥ 500ms → stall 事件触发（独立 stallKey HBR）
3. 连接恢复，剩余数据到达，下载完成 → done 终态
4. **期望**：agent 收到 stall + done 两条 HBR
5. **实际**：agent 只收到 stall，done 被吞

## 3. 根因（b63d85bc 引入）

`lib/delivery.js` `handleFinal` 抑制分支：

```js
if (t._stallDelivered === true && t.canceledBy !== "user") {
  logInfo(`[delivery] skip ${taskId}: stall already delivered`);
  return;
}
```

**意图**：stall 通知后如果任务没恢复 → interrupted 终态，不重复通知。

**实际缺陷**：

1. `enqueueSync`（L178-180）入队 stall 时**立即置 `_stallDelivered=true`**（防 dev 槽重载残留订阅导致双 stallKey 双投）—— 这是"已发起 stall 投递"的标记，不是"已成功投递"的标记。
3. `handleFinal` 用这个标记抑制**所有**非 user 取消的终态（含 done/canceled/failed/interrupted）—— 把"stall 后短期 interrupted 不重复"扩大成"stall 后任何终态一律吞"。
4. dlcore stall 恢复（L304-307）只清 `stallNotified`（dlcore 自己的标记），**不清 `_stallDelivered`**（delivery 层的标记）—— 一旦 stall 进过 enqueueSync，终态永远被吞。

## 4. 修复方案：彻底删除该抑制

**核心观点**：stall 通知和终态通知是**两个独立事件**，不需要"抑制"——

- stall 通知用独立 `stallKey = ${taskId}:stall:${ts}` 投递
- 终态通知用主 `taskId` 投递
- agent 通过 taskId 区分两个事件

不存在"重复"问题——重复的本质是"两个通知说的是同一件事"，但 stall 通知说"出问题了"，done 通知说"成功了"，本来就是两件事。

### 4.1 代码改动

`lib/delivery.js` `handleFinal`：去掉 `_stallDelivered===true` 抑制分支，注释改写说明新逻辑。

保留的（防双投）：

- `enqueueSync` L180 入队 stall 时立即置 `_stallDelivered=true`（防 dev 槽重载双 stallKey 双投）
- `handleStall` L300 抑制重复 stall fire（同一任务不会被 fire 两次）
- `injectForSession` L347 注入 stall 后置位（保证下游 `_stallDelivered` 一致）
- `deliverStallAsync` L276/L287 投递成功置位

### 4.2 涉及的特殊场景

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| stall 后 done | ❌ done 被吞 | ✓ done 投递 |
| stall 后 interrupted | ✓ interrupted 被抑制（意图） | ⚠️ interrupted 投递 |
| stall 后 failed | ❌ failed 被吞 | ✓ failed 投递 |
| stall 后 agent cancel | ✓ canceled 静默（另一分支） | ✓ canceled 静默 |
| stall 后 user cancel | ✓ canceled 投递（用户操作需告知） | ✓ canceled 投递 |

**"stall 后 interrupted 不重复"**这条原始意图在删除抑制后会**失效**。这是**有意识的取舍**：

- stall 通知有独立 stallKey，agent 看到 stallKey HBR 知道"出问题了"
- interrupted HBR 是 agent 视角的终态事实（"下载中断了"），agent 也需要知道
- 两个事件不冗余，都是事实

## 6. 实测验证

### 6.1 修复前复现

- 任务：`b14d476a-mtmnddc4`（q7-stall-recover.bin, 1MB, stall-recover-server 18944）
- 链路：stall 触发 → enqueueSync stall 入队 → 恢复 → done → handleFinal → `_stallDelivered=true` → 抑制
- 结果：tasks.json `state=done, delivered=False`，jsonl 无 done HBR

### 6.2 修复后验证（重启后 + 新下载）

- 任务 1（重启恢复）：`b14d476a-mtmnddc4` ONLOAD-RECOVER 重投 → **修复后 handleFinal 不再抑制** → done HBR 到达 ✓
- 任务 2（新下载）：`2f60bf5c-mtmnldtt`（q8-stall-recover-fix.bin, 1MB）
  - stall HBR（stallKey `2f60bf5c-mtmnldtt:stall:1788508183600`，event-status=stall，action=decide）✓
  - done HBR（主 taskId `2f60bf5c-mtmnldtt`，event-status=done，action=none）✓
  - tasks.json `delivered=True` ✓
  - 两条 HBR 通过同一会话的 injectForSession 先后到达

### 6.3 对照

| 任务 | 修复前 | 修复后 |
|---|---|---|
| b14d476a (修复前下载) | delivered=False / done HBR 无 | delivered=True / done HBR 到达（ONLOAD-RECOVER） |
| 2f60bf5c (修复后下载) | n/a | delivered=True / stall + done 双 HBR 到达 |

## 7. 不在本次修复范围

- **stall 通知的投递成功率**：`640f4bd1` 已修 stall 异步超时兜底
- **ONLOAD-RECOVER**：v0.11.1 已上，正常生效
- **task:register-handler 失败**（`task.control` 权限缺失）：0.814/8.17 都有，独立缺陷