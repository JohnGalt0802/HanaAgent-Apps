# stall 后继续完成下载——双异步投递测试（v5 全自动化）

>时间：2026-09-05
>测试：aee399c2-mtnx7vw2（q15-50mb-stall-async-final.bin, 50MB, stall-recover-server-v5）
>commit：待 git commit

## 1. 目标

验证 stall 后下载继续完成，stall 通知和 done 通知**都走 deferred:resolve 异步 channel**投递（不是 injectForSession 同步注入）。agent 必须**两次主动收束**（纯文本 stop=stop，不发任何工具调用查状态）。

## 2. 关键设计

### 2.1 server v5（脚本控制 stall 触发时机）

```
GET /test.bin → 自然下载数据（@30ms/chunk ≈500KB/s）→ 发到 50% (25MB) →
暂停 35s（stallTimeoutMs=500 自然触发 stall）→ 等 POST /trigger-resume →
恢复发剩余 25MB → 完成
```

**为什么不用 initialDelay？** 用户要求 stall 在"下载到一半时触发"，让 stall 触发时机由下载进度自然决定，而不是固定时间。

### 2.2 stallController.py（脚本自动控制 stall 恢复）

```python
find_50mb_task()              # 等 tasks.json 出现 50MB running 任务 → taskId
wait_stallkey_resolved(tid, 90s)  # 等 host store 出现 stallKey 且 status=resolved
trigger_resume()              # POST /trigger-resume 让 server 恢复
wait_mainkey_resolved(tid, 180s) # 等 main key status=resolved（done 异步投递完成）
```

**关键**：stallController 完全后台运行，agent 不需要主动调 /trigger-resume。这是测试"agent 主动收束"的前提——agent 不准去调 /trigger-resume。

### 2.3 agent 行为约束

|时机 | agent 必须做 | agent 不准做 |
|---|---|---|
| 发起 download_file tool call | 纯文本 stop=stop（**第一次主动收束**）| exec_command 查 status、调 /trigger-resume |
| 收到 stall HBR 异步投递唤醒 | 纯文本 stop=stop（**第二次主动收束**）| exec_command 查 status、调 /trigger-resume、cancel |
| 收到 done HBR 异步投递唤醒 | 验证 | (无约束) |

## 3. 测试流程

1. 启动 server v5（端口 18951，50MB，stallAt 0.5）
2. 启动 stallController 后台（timeout 90s）
3. agent 发起 download_file（50MB URL）
4. **第一次主动收束**：agent 立即纯文本 stop=stop
6. 自然下载到 25MB 时 server 暂停 35s → stallTimeoutMs=500 → stall 事件触发
7. **handleStall 看 tailSettled(sessionPath)** ——jsonl 末尾是 stop=stop（agent 已第一次主动收束）→ 走 settled 分支 → `deferred:register` + `deferred:resolve` 异步投递 stallKey HBR
8. stallKey HBR 异步投递 → agent 被唤醒
9. **第二次主动收束**：agent 立即纯文本 stop=stop（选择继续下载，不查状态不取消）
10. stallController 后台轮询 host store 看到 stallKey status=resolved → 调 POST /trigger-resume
11. server 收到 /trigger-resume → 恢复发剩余 25MB（@30ms/chunk ≈17s）
12. done 触发 → handleFinal 看 tailSettled(sessionPath) ——jsonl 末尾是 stop=stop（agent 已第二次主动收束）→ 走 deliverAsync 分支 → `deferred:resolve` 异步投递 done HBR
13. done HBR 异步投递 → agent 被唤醒
14. 验证：host store 两个 key 都 resolved，stall-debug 没 injected 行，jsonl 有两条 custom_message

## 4. 实测结果

### 4.1 任务状态

|字段 | 值 |
|---|---|
| taskId | `aee399c2-mtnx7vw2` |
| state | `done` |
| delivered | `True` |
| stallKey | `aee399c2-mtnx7vw2:stall:1788584867325` |
| total | 52428800 (50MB) |

### 4.2 host store（异步投递痕迹）

```
key=aee399c2-mtnx7vw2 status=resolved delivered=False result=done
key=aee399c2-mtnx7vw2:stall:1788584867325 status=resolved delivered=True result=stall
```

两个 key 都 `status=resolved`——**双异步投递**。

### 4.3 stall-debug（同步注入痕迹）

无 `aee399c2` 的 `injected` 行——**没走 injectForSession**。

### 4.4 jsonl（异步投递痕迹）

```
L649 ts=2026-09-05T05:07:47.341Z customType=hana-background-result  ← stall
L652 ts=2026-09-05T05:08:39.505Z customType=hana-background-result  ← done
```

两条 `custom_message` 行——**异步投递落到 jsonl**。

stall → done 间隔 52s ≈ stall 暂停 35s + 恢复发剩余 17s（与设计吻合）。

## 5. stallController.py timeout bug 修复

```diff
-def wait_stallkey_resolved(taskId, timeout_s=30):
+def wait_stallkey_resolved(taskId, timeout_s=90):
```

**为什么需要 90s？** server 自然下载到 50% 需要约 51s（@30ms/chunk = ~500KB/s），加上 stall 触发后异步投递延迟（500ms stallTimeoutMs + 几ms 异步投递），需要 ≥ 60s 才稳妥。30s 太短——stallController 会在 stall 触发前超时退出，导致无法自动调 /trigger-resume。

## 6. 与之前测试对比

| 测试 | taskId | stall 路径 | done 路径 | 是否真异步 |
|---|---|---|---|---|
| 74ca2bde (stall-recover-server stallMs=8s) | 74ca2bde-mtnsvhqk | 同步注入 enqueueSync | 同步注入 enqueueSync | ❌ |
| b7a357f3 (stall-recover-server stallMs=12s) | b7a357f3-mtmsz988 | 同步注入 | 同步注入 | ❌ |
| a737f889 (stall-recover-server-v3 initialDelay=18s) | a737f889-mtmt8p7f | 同步注入 | 同步注入 | ❌ |
| ec3a331c (stall-recover-server-v4 initialDelay=10s + stallController 30s timeout) | ec3a331c-mtntjpwt | **异步投递（settled 分支）** | 异步投递（manual /trigger-resume） | ⚠️ 半自动 |
| **aee399c2 (stall-recover-server-v5 + stallController 90s timeout)** | **aee399c2-mtnx7vw2** | **异步投递（settled 分支）** | **异步投递（stallController 自动 /trigger-resume）** | **✅ 全自动** |

**ec3a331c 是半自动**——stall 异步投递成功（第一次主动收束没破坏），但 done 异步投递需要我手动调 /trigger-resume（破坏 tailSettled）。但实际 done 仍然异步投递了，因为收到 stall HBR 后我那条纯文本 stop=stop 收尾把 tailSettled=true 状态修复（jsonl 末尾是 stop=stop）。

**aee399c2 是全自动**——agent 两次主动收束都是纯 stop=stop，stallController 自动调 /trigger-resume，无任何 agent 手动干预。

## 7. 关键教训：agent 主动收束的纪律

loop 模式下 agent 本能是查状态（exec_command tasks.json / host store）——会破坏 tailSettled=true 条件。要做真正的"主动收束"，agent 必须：
- 发起 download_file 后立即纯文本 stop=stop
- 收到 stall HBR 后立即纯文本 stop=stop
- **绝对不能**查状态、调 /trigger-resume、cancel

**测试环境配套**：
- server 必须支持 stallController 触发的 /trigger-resume 路由
- stallController 必须自动等 stallKey resolved（不是手动触发）
- stallController timeout 必须 ≥ 90s（覆盖自然下载到 50% 的时间）

## 8. 结论

**stall 后继续完成下载，stall + done 都走 deferred:resolve 异步 channel 真异步投递测试通过。** 这是修复 handleFinal stall 抑制分支（commit `6a2ea670`）后端到端真异步投递路径的完整验证。