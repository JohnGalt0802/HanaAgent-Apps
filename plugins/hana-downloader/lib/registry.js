// lib/registry.js — 宿主 TaskRegistry 双注册封装（v0.12.0 v2 plugin）
//
// 宿主任务注册协议（0.919.4 实测）：
//   task:register-handler  注册中止处理器（type="download"）→ 宿主 stop_task 可取消下载
//   task:register          注册任务实例（taskId + type + 会话关联 + meta）→ 宿主可查询/等待
//   task:complete          任务完成终结（带 result）
//   task:cancel            任务取消终结（canceled 状态）
//   task:fail              任务失败终结（带 reason）
//
// 设计原则（v0.12.0 v2 plugin）：
//   - v2 plugin bus（TAr 适配器）自动注入 caller: {kind: "plugin", pluginId}。
//   - task.* 协议不需要 verified v2 app caller（与 session:send-custom 不同）。
//   - bus 直接从 ctx.bus 取（v2 plugin 显式 ctx.bus），不再回退 globalThis.__dlBus（v1 才需要）。
//   - 双注册 = deferred 占位（唤醒 Agent）+ TaskRegistry 实例（宿主可取消/等待）。
//   - 任一注册失败不阻断下载：try/catch + console 日志，静默降级。
//   - abort handler 签名 `abort: async (taskId) => {}`（v2 plugin 与 v1 同）。
//
// capabilities：manifest.json 已声明 ["task.write", "task.read"]，否则宿主权限闸拒绝注册。

const PLUGIN_ID = "hana-downloader";

const FINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

function resolveBus(bus) {
  // v2 plugin：bus 来自 ctx.bus（TAr 适配器，自动注入 plugin caller）
  return bus || null;
}

function safeLog(tag, e) {
  console.warn(`[hana-downloader] ${tag} 失败（不影响下载）:`, e?.message || String(e));
}

/** 注册 type="download" 的 abort handler：宿主 stop_task 调 abort(taskId) 取消下载。
 *  getTaskManager：函数，返回 TaskManager 实例（dlcore.js 单例）。
 */
export async function registerHandler(bus, getTaskManager) {
  bus = resolveBus(bus);
  if (!bus || typeof getTaskManager !== "function") return;
  try {
    await bus.request("task:register-handler", {
      type: "download",
      abort: async (taskId) => {
        try {
          const manager = getTaskManager();
          if (!manager || !taskId) return;
          manager.cancel(taskId, "user");
        } catch (e) {
          safeLog("abort handler 取消任务", e);
        }
      },
    });
  } catch (e) {
    safeLog("注册 task:register-handler", e);
  }
}

/** 注册任务实例（双注册第二路）。 */
export async function registerTask(bus, task) {
  bus = resolveBus(bus);
  if (!bus || !task || !task.taskId) return;
  if (FINAL[task.state]) return;
  try {
    await bus.request("task:register", {
      taskId: task.taskId,
      type: "download",
      parentSessionPath: task.sessionPath || null,
      parentSessionId: task.sessionId || null,
      pluginId: PLUGIN_ID,
      meta: {
        url: task.url || "",
        fileName: task.fileName || "",
      },
    });
  } catch (e) {
    safeLog("注册 task:register", e);
  }
}

/** 任务完成终结（done）。 */
export async function completeTask(bus, taskId, result) {
  bus = resolveBus(bus);
  if (!bus || !taskId) return;
  try {
    await bus.request("task:complete", { taskId, type: "download", result });
  } catch (e) {
    safeLog("task:complete", e);
  }
}

/** 任务取消终结（canceled，agent 主动取消路径）。 */
export async function cancelTask(bus, taskId, reason) {
  bus = resolveBus(bus);
  if (!bus || !taskId) return;
  try {
    await bus.request("task:cancel", { taskId, type: "download", reason });
  } catch (e) {
    safeLog("task:cancel", e);
  }
}

/** 任务失败/取消/中断终结（failed/canceled/interrupted）。 */
export async function failTask(bus, taskId, reason) {
  bus = resolveBus(bus);
  if (!bus || !taskId) return;
  try {
    await bus.request("task:fail", { taskId, type: "download", reason });
  } catch (e) {
    safeLog("task:fail", e);
  }
}