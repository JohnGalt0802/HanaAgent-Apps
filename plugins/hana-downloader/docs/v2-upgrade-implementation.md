# v2 plugin 升级实现（0.12.0 → 真同步投递）

> ⚠️ **部分过时（2026-09-08）**：本文写于 0.919.4 时期，认为“宿主已废弃 `__sessionHooks` 通道”故改用 `session:send`。
> 实测：0.928.0 下 `session:send` 对 plugin caller 走死（活跃期恒 session_busy），而 `__sessionHooks` 可以通过 bundle 魔改重新暴露。
> v2 plugin 协议部分（manifest/entry/ctx 形状）仍有效；投递层实现已由 v0.14.0 取代，见 `docs/host-changelog/v0.14.0-sync-restore.md`。

## 背景

hana-downloader v0.11.0 基于 v1 plugin 协议，依赖 `globalThis.__sessionHooks.agent/pre-step` 真同步注入通道。0.919.4 宿主已完全废弃该通道（grep `__sessionHooks` = 0 处引用），导致 v0.11.0 sync-first 名不副实——所有"同步"投递实际都是 30s 后 fallback async。

升级到 v2 plugin 协议，启用 0.919.4 新版真同步投递机制。

## 关键调研结论（0.919.4 host bundle）

### caller 校验机制

```js
function bc(t) {
  return !t || typeof t != "object" || t.kind === "plugin" ? null : zn(t.pluginId);
}
```

- v2 plugin 的 bus（TAr 适配器）自动注入 `caller: {kind: "plugin", pluginId}`
- `bc()` 对 `kind === "plugin"` 返回 **null**
- → 所有 v2 plugin caller 走 host handler 的"底部分支"（无 verified v2 app 校验）

### 投递通道 caller 校验矩阵

| 通道 | v1 plugin caller | v2 plugin caller | v2 app caller |
|---|---|---|---|
| `session:send-custom` + triggerTurn | throw "requires verified v2 app caller identity" | throw "requires verified v2 app caller identity" | ✅ 真同步 triggerTurn |
| `session:send` + steer + isStreaming=true | throw session_busy | throw session_busy | ✅ 真同步 steer |
| `session:send` + followUp + isStreaming=true | throw session_busy | throw session_busy | ✅ followUp |
| `session:send` + prompt + !isStreaming | promptSession 异步 | **promptSession 真同步**（v2 plugin 唯一真同步通道） | promptSession 真同步 |
| `deferred:resolve` | ✅ 异步 | ✅ 异步 | ✅ 异步 |

### promptSession 真同步实现（L28369）

```js
async promptSession(e, r, n, s = {}) {
  // ...
  try {
    if (o.session.isStreaming) throw new Error("session_busy");
    this.preflightSessionInput(e), await o.session.prompt(r, f);
  } finally { ... }
}
```

**关键**：
- `isStreaming=true` → throw `session_busy`（v2 plugin 必须等重试）
- `!isStreaming` → `preflightSessionInput + await session.prompt()` —— **真同步 trigger 新 turn**

## 升级实施

### manifest.json (v2 schema)

```json
{
  "manifestVersion": 2,
  "id": "hana-downloader",
  "name": "Hana Downloader",
  "version": "0.12.0",
  "entry": "index.js",
  "minAppVersion": "0.919.4",
  "trust": "full-access",
  "capabilities": ["task.write", "task.read"],
  "contributes": { "cards": [...], "configuration": {...} }
}
```

**关键变化**：
- `manifestVersion: 1` → `2`
- 顶层 `trust: "full-access"` → 新版 v2 也支持（作为 trust field）
- 顶层 `tools/cards/routes/dataDir` 字段删除 —— v2 plugin 由 host 自动加载 `tools/`、`routes/` 等目录
- 新增 `entry: "index.js"` 字段（ESM 模块路径）
- `contributes.cards` 保留（host 自动加载）
- `contributes.configuration` 保留（host 自动加载配置面板）

### index.js (v2 lifecycle)

```js
import { definePlugin } from "@hana/plugin-runtime";
import { getTaskManager } from "./lib/dlcore.js";
import { createDelivery } from "./lib/delivery.js";
import { registerHandler } from "./lib/registry.js";

export default definePlugin({
  async onload(ctx, helpers) {
    // ctx: v2 plugin ctx（含 bus, log, dataDir, pluginId）
    // helpers: { register(disposable) }
    
    const manager = getTaskManager(ctx.dataDir);
    manager.restore();
    
    // task:register-handler（task.write 权限）—— bus 自动注入 plugin caller
    await registerHandler(ctx.bus, () => manager).catch(() => {});
    
    // v2 真同步投递（session:send → promptSession）
    ctx._dlDelivery = createDelivery({
      ctx, bus: ctx.bus, manager,
      dataDir: ctx.dataDir, log: ctx.log,
    });
  },
  onunload(ctx) {
    ctx._dlDelivery?.dispose();
  },
});
```

**关键变化**：
- `export default class DownloadProgressPlugin { onload() {} }` → `export default definePlugin({onload, onunload})`
- `this.ctx.bus` → `ctx.bus`（v2 plugin onload 第一参）
- `globalThis.__dlBus` 回退删除（v2 plugin 直接用 ctx.bus）
- 删除 `globalThis.__sessionHooks.onDecision("agent/pre-step")` 注册（v2 plugin 没有 `__sessionHooks`，也不需要——改用 session:send promptSession 真同步）

### lib/delivery.js (v2 真同步投递)

**完整重写**：移除 enqueueSync 30s timer + agent/pre-step injectForSession 通道，新增 `deliverSync`：

```js
async function deliverSync(t, result) {
  const sessionPath = t.sessionPath;
  const sessionId = t.sessionId;
  if (!sessionPath && !sessionId) {
    await deliverAsync(t, result);
    return;
  }
  
  const text = buildEntryText(t.taskId, result);
  
  // 重试 60 次 × 500ms = 30s（agent 收束后立即成功）
  for (let attempt = 1; attempt <= SYNC_RETRY_MAX; attempt++) {
    try {
      await bus.request("session:send", {
        sessionPath, sessionId, text,
        context: { metadata: { pluginId: PLUGIN_ID, taskId: t.taskId } },
      });
      // 成功 → 真同步 trigger 新 turn
      markDelivered(t);
      finalizeRegistry(t);
      return;
    } catch (e) {
      if (e.message?.includes("session_busy") && attempt < SYNC_RETRY_MAX) {
        await sleep(SYNC_RETRY_DELAY_MS);
        continue;
      }
      break;  // 其它错误或重试用完
    }
  }
  
  // Fallback async（30s 重试用完 → deferred:resolve 异步投递）
  await deliverAsync(t, result);
}
```

**关键行为**：
- agent 不在 streaming → 立即成功（promptSession 真同步 trigger 新 turn，agent 立即感知 done）
- agent 在 streaming → throw session_busy → 等 500ms 重试（最多 30s）
- 30s 后仍 busy → fallback `deferred:resolve` 异步投递（与 v0.11.0 异步通道一致）

### 兼容改动

| 文件 | 改动 |
|---|---|
| `lib/registry.js` | 删除 `globalThis.__dlBus` 回退，bus 直接从 ctx.bus 取 |
| `extensions/dl-nextturn.js` | **删除**（v2 不再用 before_provider_request 注入） |
| `extensions/enforce-download.js` | **保留**（v2 plugin 自动加载 extensions/ 目录，但 before_provider_request 在 0.919.4 仍未桥接，仍是 no-op） |
| `tools/download-file.js` | **不变**（用 toolCtx.dataDir/bus/config，v2 plugin aEe() 注入完全兼容） |
| `tools/download-cancel.js` | **不变** |
| `tools/download-command.js` | **不变** |
| `tools/download-wait.js` | **不变** |
| `routes/download.js` | **不变**（用 ctx.pluginId/dataDir，v2 plugin ctx 兼容） |
| `app/card.js` + `app/manager.js` | **不变**（静态资源，host 直接读） |

## 投递行为对比

| 场景 | v0.11.0 (v1) | v0.12.0 (v2) |
|---|---|---|
| agent 收束 → done | deferred:resolve async（host 异步唤醒） | **session:send → promptSession 真同步 trigger 新 turn** |
| agent 未收束 → done | enqueueSync 30s timer → fallback async | session:send → throw session_busy → 重试 → 收束后真同步 |
| agent 未收束 → done（30s 后仍未收束） | fallback async | fallback async（与 v0.11.0 同） |
| agent 未收束 → stall | enqueueSync 30s timer → deliverStallAsync | deliverStallAsync（直接异步，因为 stall 不阻塞 agent） |
| agent 主动 cancel | 静默（不投递） | 静默（不投递） |
| user 取消 | async 通知（hint="用户手动取消"） | async 通知（同 v0.11.0） |

## 测试验证

待 host 重启后测试：

| 测试项 | 命令 |
|---|---|
| 1KB 下载 | 验证 settled → session:send → 立即成功 |
| 50MB 下载 + agent 未收束 | 验证 busy → 重试 → 收束后真同步 |
| stall 停滞 | 验证 stallKey 注册 + async 投递 |
| cancel | 验证 canceledBy=agent 静默 |
| routes /download/status | 验证 routes 完全工作（不受 manifest 影响） |

## 风险与回滚

### 风险

- v2 plugin 必须 host ≥ 0.919.4（minAppVersion: "0.919.4"）
- v2 plugin bus caller = `{kind: "plugin"}` → `bc()` 返回 null → 不能用 session:send-custom 真同步通道（只能 session:send）
- 如果 host 升级到更高版本删除 session:send 底部分支，需要重新调研（可能性低）

### 回滚

如果真同步投递失败，回滚到 v0.11.0：
1. `git checkout main -- manifest.json index.js lib/delivery.js lib/registry.js`
2. 重启 host（恢复 v1 plugin 异步投递）
3. 当前 main 分支 v0.11.0 commits 都已保留，可直接 checkout

## 调研文档链

- `docs/sync-mechanism.md` —— v0.11.0 sync 机制设计（已废，agent/pre-step 通道失效）
- `docs/audit-投递机制全谱.md` —— 投递机制全谱（含 v0.11.0 设计）
- `docs/v0.11.0-真同步投递完整机制.md` —— v0.11.0 sync-first 名不副实的分析
- `docs/pi-sdk-0.84.4-调研.md` —— Pi SDK 调研（无关，最终用 v2 plugin 实现）
- 本文档 —— v2 plugin 真同步投递实现

## 下一步

1. 提交 v0.12.0 commits
2. 同步 community 源（<userHome>\.hanako\plugins\hana-downloader）
3. 用户手动重启 host 加载 v2 plugin
4. 重启后做完整测试套
5. 如果测试通过，更新六象限测试文档为八象限（含 sync delivery）