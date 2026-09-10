// lib/delivery.js — hana-downloader 投递层唯一权威（v0.15.0 桥接同步 + deferred 兵底）
//
// 设计：
//   - 未收束会话（agent 正处于流式回复中，当前 turn 未结束）：
//     终态 / stall 进入 pending 队列 → 宿主下一次 agent/pre-step 决策时（即下一条 LLM API
//     请求组装前）把 hana-background-result 拼进该请求的 messages → agent 在不收束会话的
//     前提下，下一次思考即感知下载完成。这就是「同步投递」。
//   - 已收束会话：直接 deferred:register + deferred:resolve，宿主 dispatcher 毫秒级接管
//     （agent busy → followUp 排队；agent idle → triggerTurn 唤醒新 turn）。
//   - 超时兜底：pending 在 SYNC_WAIT_MS 内未被消费 → 降级 deferred，保证不丢回执。
//   - agent 取消（canceledBy=agent）：静默（download-cancel 同步返回值就是结果）。
//   - user 取消（canceledBy=user）：异步通知（带 hint）。
//   - 每任务只允许一条回执：内存 _delivered + 持久化 delivered 双重去重。
//
// 注入通道：
//   - v2 ctx.hooks（插件被当 app 跑时才有，本插件通常为 undefined）→ 插件自注册 adjudicator
//   - 桥接：配套 v2 app hd-sync-bridge 持有官方 agent/pre-step 正门，读队列注入（当前主通道）
//   两条通道互斥，一条回执只走一条，不会双投。

import fs from "node:fs";
import path from "node:path";

const TERMINAL = new Set(["done", "failed", "canceled", "interrupted"]);
const SYNC_WAIT_MS = 30000; // 等下一条 provider request 的时间，超时降级异步

function statusOf(task) {
  return task ? (task.state || task.status || "") : "";
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 会话是否已收束：jsonl 尾部最近一条 assistant message 的 stopReason==="stop" 才算收束。
// 注意必须看「最近的 assistant」——倒序第一个 assistant 若是 toolUse 状态，说明 agent 还在回合中。
function tailSettled(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return false;
    const size = fs.statSync(sessionPath).size;
    if (size === 0) return false;
    const fd = fs.openSync(sessionPath, "r");
    const buf = Buffer.alloc(Math.min(size, 32768));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type !== "message" || !o.message) continue;
      const m = o.message;
      if (m.role === "assistant") return m.stopReason === "stop";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 构造投递实例（同步注入 + deferred 兜底）。
 * @param {object} opts
 * @param {object} opts.ctx   v2 plugin ctx（含 bus, log, dataDir, pluginId, hooks）
 * @param {object} opts.bus   v2 plugin ctx.bus（自动注入 caller）
 * @param {object} opts.manager TaskManager 单例
 * @param {string} opts.dataDir 插件数据目录
 * @param {object} opts.log  日志对象
 */
export function createDelivery({ ctx, bus, manager, dataDir, log, bridgeQueueDir = null }) {
  const logger = log || ctx?.log || { info() {}, warn() {}, error() {} };
  function logInfo(s) { try { logger.info?.(s); } catch {} }
  function logWarn(s) { try { logger.warn?.(s); } catch {} }

  const PLUGIN_ID = ctx?.pluginId || "hana-downloader";
  const pending = new Map(); // key -> { task, result, entry, timer, sessionPath, kind }

  // ── 桥接通道（v2 app hd-sync-bridge 的 agent/pre-step 正门）──
  // v2 plugin 的 ctx 没有 hooks（实测 ctx.hooks=undefined），拿不到同步注入正门；
  // 于是把回执原子写入桥接 app 的 dataDir 队列，由那个 app 在 agent/pre-step 里读走并注入。
  // 文件被读走（消失）即视为已投递；超时前文件仍在则降级 deferred。
  const BRIDGE_DIR = bridgeQueueDir || null;
  function bridgeFile(key) {
    return BRIDGE_DIR ? path.join(BRIDGE_DIR, `${key}.json`) : null;
  }
  function bridgeWrite(key, item) {
    if (!BRIDGE_DIR) return false;
    try {
      fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      const tmp = path.join(BRIDGE_DIR, `${key}.tmp`);
      const dst = path.join(BRIDGE_DIR, `${key}.json`);
      fs.writeFileSync(tmp, JSON.stringify({
        key,
        sessionPath: item.sessionPath || null,
        content: item.entry?.content ?? null,
        details: item.entry?.details ?? null,
        createdAt: Date.now(),
      }), "utf8");
      fs.renameSync(tmp, dst);
      return true;
    } catch (e) {
      logWarn(`[delivery] BRIDGE-WRITE ERR ${key}: ${e?.message || e}`);
      return false;
    }
  }
  function bridgeDrop(key) {
    const f = bridgeFile(key);
    if (!f) return;
    try { fs.unlinkSync(f); } catch {}
  }
  function bridgeConsumed(key) {
    const f = bridgeFile(key);
    if (!f) return false;
    try { return !fs.existsSync(f); } catch { return false; }
  }
  // 桥接 app 的心跳：app 在 apply 时写 ready.json 并在每次 pre-step 刷新；
  // 插件入队时读它判断桥接是否真的在线，不在线就回退其他通道。
  const BRIDGE_READY = BRIDGE_DIR ? path.join(path.dirname(BRIDGE_DIR), "ready.json") : null;
  function bridgeReady() {
    if (!BRIDGE_READY) return false;
    try {
      const o = JSON.parse(fs.readFileSync(BRIDGE_READY, "utf8"));
      return typeof o?.at === "number" && Date.now() - o.at < 120000;
    } catch { return false; }
  }
  // ── 注入通道选择：ctx.hooks（app 形态）> 桥接（v2 app 正门）──
  // 一条回执只走一条通道，避免双投。
  function pickChannel() {
    try {
      if (ctx?.hooks && typeof ctx.hooks.onDecision === "function") return "hooks";
      if (bridgeReady()) return "bridge";
    } catch {}
    return "none";
  }

  // ── 终态结果构造 ──
  function buildResult(task) {
    const state = statusOf(task);
    const status = state === "done" ? "done" : state === "canceled" ? "cancelled" : "error";
    if (state === "done") {
      return {
        taskId: task.taskId,
        fileName: task.fileName || "",
        status,
        filePath: task.filePath,
        total: task.total ?? null,
        received: task.received ?? 0,
      };
    }
    const userCanceled = state === "canceled" && task.canceledBy === "user";
    return {
      taskId: task.taskId,
      fileName: task.fileName || "",
      status,
      error: task.error || state,
      ...(task.filePath ? { filePath: task.filePath } : {}),
      ...(userCanceled ? { hint: "用户手动取消" } : {}),
    };
  }

  // hana-background-result 消息体。双 status 字段：
  //   status（legacyStatus）= success/failed/aborted，宿主 interlude / 前端 detail 兼容
  //   event-status（新语义）= done/cancelled/error，agent 应读这个
  function buildEntry(taskId, result) {
    const eventStatus = result.status || (result.state === "done" ? "done" : result.state === "canceled" ? "cancelled" : "error");
    const legacyStatus = eventStatus === "done" ? "success" : eventStatus === "cancelled" ? "aborted" : "failed";
    const action = eventStatus === "done" || eventStatus === "cancelled" ? "none" : "decide";
    const body = JSON.stringify(result, null, 2);
    return {
      customType: "hana-background-result",
      content: `<hana-background-result task-id="${esc(taskId)}" status="${esc(legacyStatus)}" event-status="${esc(eventStatus)}" source="system" plugin="hana-downloader" type="download" action="${esc(action)}">\n${esc(body)}\n</hana-background-result>`,
      display: false,
      details: { schemaVersion: 2, taskId, deliveryId: `sync:${taskId}:${Date.now()}`, eventStatus, action },
    };
  }

  function alreadyHandled(t) {
    return t && (t._delivered === true || t.delivered === true);
  }

  function markDelivered(t) {
    if (!t) return;
    if (manager.markDelivered) {
      try { manager.markDelivered(t.taskId); } catch {}
    }
    t._delivered = true;
    t.delivered = true;
  }

  function finalizeRegistry(t) {
    if (!t || t._registryFinalized) return;
    t._registryFinalized = true;
    if (!bus) return;
    const state = statusOf(t);
    import("./registry.js").then(({ completeTask, failTask, cancelTask }) => {
      if (state === "done") {
        completeTask(bus, t.taskId, {
          url: t.url || "",
          fileName: t.fileName || "",
          filePath: t.filePath || null,
          total: t.total ?? null,
          received: t.received ?? 0,
        }).catch(() => {});
      } else if (state === "canceled") {
        cancelTask(bus, t.taskId, {
          state,
          error: t.error || state,
          canceledBy: t.canceledBy || null,
        }).catch(() => {});
      } else {
        failTask(bus, t.taskId, {
          state,
          error: t.error || state,
          canceledBy: t.canceledBy || null,
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  // ── 异步投递（已收束会话 / 同步超时兜底）──
  async function deliverAsync(t, result) {
    if (!bus) {
      logWarn(`[delivery] NO BUS for ${t.taskId} async`);
      markDelivered(t);
      finalizeRegistry(t);
      return;
    }
    try {
      if (t.deferredRegistered !== true) {
        await import("./deferred.js").then(({ registerDeferred }) =>
          registerDeferred(bus, t, {}, null, null)
        ).catch(() => {});
      }
      await bus.request("deferred:resolve", { taskId: t.taskId, result });
      markDelivered(t);
      finalizeRegistry(t);
      logInfo(`[delivery] ASYNC ${t.taskId} (${statusOf(t)}) → deferred:resolve`);
    } catch (e) {
      logWarn(`[delivery] ASYNC ERR ${t.taskId}: ${e?.message || e}`);
    }
  }

  // ── stall 异步投递兜底 ──
  async function deliverStallAsync(t, result, stallKey) {
    if (!bus || !t || !stallKey) {
      if (t) t._stallDelivered = true;
      return;
    }
    try {
      await bus.request("deferred:register", {
        taskId: stallKey,
        ...(t.sessionId ? { sessionId: t.sessionId } : {}),
        ...(t.sessionPath ? { sessionPath: t.sessionPath } : {}),
        meta: { type: "download-stall", fileName: t.fileName || "", url: t.url || "" },
      }).catch(() => {});
      await bus.request("deferred:resolve", { taskId: stallKey, result });
      t._stallDelivered = true;
      logInfo(`[delivery] STALL-ASYNC ${t.taskId} (${stallKey}) → deferred:resolve`);
    } catch (e) {
      logWarn(`[delivery] STALL-ASYNC ERR ${t.taskId}: ${e?.message || e}`);
    }
  }

  // ── 同步注入入队：等下一个 agent/pre-step 消费 ──
  function enqueueSync(t, entry, keyOverride = null, kind = "final") {
    const key = keyOverride || t.taskId;
    const item = {
      task: t,
      result: entry._result,
      entry,
      sessionPath: t.sessionPath || t.sessionRef?.path || null,
      timer: null,
      kind,
    };
    // 入队即置位：同一 manager 单例若残留多个订阅（dev 槽重载未退订），
    // 并发回调会对同一任务各入队一份 → 双投。
    if (kind === "stall") {
      if (t) t._stallDelivered = true;
    } else if (t) {
      t._delivered = true;
    }
    const channel = pickChannel();
    item.channel = channel;
    pending.set(key, item);
    const bridgeOk = channel === "bridge" && item.sessionPath ? bridgeWrite(key, item) : false;
    logInfo(`[delivery] SYNC-ENQUEUE ${key} (${kind}) channel=${channel} session=${item.sessionPath || "?"} → wait agent/pre-step`);

    const schedule = (ms) => {
      item.timer = setTimeout(() => {
        if (pending.get(key) !== item) return;
        // 桥接模式：队列文件被 app 读走 = 已注入，直接收工（不重复投递）
        if (bridgeOk && bridgeConsumed(key)) {
          pending.delete(key);
          const realTask = item.task;
          if (item.kind === "stall") {
            if (realTask) realTask._stallDelivered = true;
          } else if (realTask) {
            markDelivered(realTask);
            finalizeRegistry(realTask);
          }
          logInfo(`[delivery] BRIDGE-CONSUMED ${key} (${kind}) → injected by hd-sync-bridge`);
          return;
        }
        pending.delete(key);
        bridgeDrop(key);
        logInfo(`[delivery] SYNC-TIMEOUT ${key} (${kind}) → fallback async`);
        if (kind === "stall") {
          deliverStallAsync(item.task, item.result, key).catch(() => {});
        } else {
          deliverAsync(item.task, item.result).catch(() => {});
        }
      }, ms);
      if (item.timer.unref) item.timer.unref();
    };
    schedule(SYNC_WAIT_MS);
  }

  // ── 供 index.js 的 agent/pre-step adjudicator 调用：把本会话 pending 拼进下一条请求 ──
  function injectForSession(sessionPath, payload) {
    if (!payload || !Array.isArray(payload.messages) || pending.size === 0) return payload;
    const injected = [];
    for (const [key, item] of Array.from(pending)) {
      if (item.channel && item.channel !== "hooks") continue;
      const itemSession = item.sessionPath || item.task?.sessionPath || item.task?.sessionRef?.path;
      if (sessionPath && itemSession && !sameSession(sessionPath, itemSession)) continue;
      if (item.timer) clearTimeout(item.timer);
      pending.delete(key);
      payload.messages.push({
        role: "user",
        content: item.entry.content,
        ...(item.entry.details ? { details: item.entry.details } : {}),
      });
      const realTask = item.task;
      if (item.kind === "stall") {
        if (realTask) realTask._stallDelivered = true;
      } else {
        if (realTask && realTask.taskId) markDelivered(realTask);
        finalizeRegistry(realTask);
      }
      injected.push(key);
    }
    if (injected.length) logInfo(`[delivery] SYNC-INJECT ${injected.join(",")} into next provider request`);
    return payload;
  }

  function sameSession(a, b) {
    const na = String(a).split(/[\\/]/).pop();
    const nb = String(b).split(/[\\/]/).pop();
    return !na || !nb || na === nb;
  }

  // ── 终态回调（订阅 mgr.onFinal）──
  async function handleFinal(task) {
    if (!task) return;
    const taskId = task.taskId;
    const state = statusOf(task);
    if (!TERMINAL.has(state)) return;
    const t = manager.getTask ? (manager.getTask(taskId) || task) : task;
    if (!t) return;
    if (alreadyHandled(t)) {
      logInfo(`[delivery] skip ${taskId}: already delivered`);
      return;
    }
    if (t.consumedByWait === true || (t.waitActive || 0) > 0) {
      markDelivered(t);
      finalizeRegistry(t);
      logInfo(`[delivery] skip ${taskId}: consumedByWait`);
      return;
    }
    if (state === "canceled" && t.canceledBy === "agent") {
      markDelivered(t);
      finalizeRegistry(t);
      logInfo(`[delivery] skip ${taskId}: canceled-by-agent → silent`);
      return;
    }

    const result = buildResult(t);
    const entry = buildEntry(taskId, result);
    entry._result = result;
    const sp = t.sessionPath || t.sessionRef?.path || null;

    // 已收束 → 直接异步唤醒
    if (tailSettled(sp)) {
      logInfo(`[delivery] settled ${taskId} → async deferred`);
      await deliverAsync(t, result);
      return;
    }
    // 未收束 → 入队等下一条 API 请求（真同步）
    enqueueSync(t, entry);
  }

  // ── 停滞回调（订阅 mgr.onStall）──
  async function handleStall(task) {
    if (!task || !task.taskId) return;
    const taskId = task.taskId;
    const t = manager.getTask ? (manager.getTask(taskId) || task) : task;
    if (!t) return;
    // 终态任务不发停滞通知（done/canceled 后排队补发的 stall 全是噪音）
    if (TERMINAL.has(statusOf(t))) return;
    if (t._stallDelivered) return;
    if (t.consumedByWait === true || (t.waitActive || 0) > 0) return;

    const stallKey = taskId + ":stall:" + Date.now();
    const result = {
      taskId,
      fileName: t.fileName || "",
      url: t.url || "",
      status: "stall",
      hint: "下载连接已停滞，以最新 download-wait / done 通知为准",
    };
    const entry = buildEntry(stallKey, result);
    entry._result = result;
    const sp = t.sessionPath || t.sessionRef?.path || null;

    if (tailSettled(sp)) {
      await deliverStallAsync(t, result, stallKey);
      return;
    }
    enqueueSync(t, entry, stallKey, "stall");
  }

  // ── 订阅 dlcore 终态/停滞（唯一权威，index.js 创建一次）──
  const unsubStall = typeof manager.onStall === "function"
    ? manager.onStall((task) => { handleStall(task || null).catch(() => {}); })
    : null;
  if (typeof manager.onFinal === "function") {
    manager.onFinal((task) => { handleFinal(task || null).catch(() => {}); });
  }

  function dispose() {
    for (const [key, item] of Array.from(pending)) {
      if (item.timer) { try { clearTimeout(item.timer); } catch {} }
      pending.delete(key);
    }
    if (typeof unsubStall === "function") {
      try { unsubStall(); } catch {}
    }
  }

  return { injectForSession, handleFinal, handleStall, dispose };
}
