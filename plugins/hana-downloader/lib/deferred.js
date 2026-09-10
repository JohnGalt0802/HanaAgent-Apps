// lib/deferred.js — deferred 占位 helper（v0.8）
//
// 宿主 deferred 协议（0.712.5 实测）：
//   deferred:register  注册占位（taskId + sessionId/sessionPath + meta）→ 下载完成时按占位投递唤醒
//   deferred:resolve   解析占位（pending → resolved + 投递 hana-background-result）；占位不存在/已终态则无操作（幂等）
//   deferred:fail      同上，投递失败结果
//   deferred:retry     覆盖式重置占位回 pending + 清 result/reason/delivered + 清 suppression 标记（重新武装）
//   deferred:abort     占位 pending → aborted + 投递失败消息（本插件不用：会误报"任务中止"）
//
// 设计原则（v0.5.7 定稿，回归「会话结束前续状态」）：
//   - **占位注册时机 = agent 收束前**：由 download-wait 快照在「任务未完成」时自动续注册（agent 调 wait
//     是收束前的最后动作，工具描述明确引导）。会话内完成（wait 快照到终态）→ 不注册 → 不投递（无冗余唤醒）。
//   - **创建时不注册**（v0.5.4 的"创建即注册"已回退）：会话内完成的下载/取消不再产生收束后的多余投递。
//   - 终态投递：任务 done/failed/canceled/interrupted → resolve 投递，唤醒收束后的发起会话。
//     终态后延迟 FINAL_RESOLVE_DELAY_MS（2s）复查：复查时 wait 已消费（Agent 又回查拿到终态）→ 静默跳过；
//     未消费 → 正常 resolve。
//   - 注册结果回写 task.deferredRegistered：Agent 是否收到"占位已续"的承诺取决于真实注册状态（信息诚实性）。
//   - 宿主协议无「安静取消占位」API（abort 会投递失败消息误报"中止"）：wait 消费后不 resolve，占位保留
//     pending，宿主在创建会话销毁时经 suppressBySession 自动清理（不投递）；不 resolve 即不发
//     deferred_result 事件，因此无投递无噪音。
//   - 无 getTask 复查能力（注册竞态补 resolve / onload 兜底）时退化为立即 resolve（秒下任务 Agent 来不及回查，投递合理）。

// 宿主 TaskRegistry 双注册（v0.8）：deferred 占位之外，同步向宿主注册任务实例/终结，
// 让 stop_task 能取消下载、check_pending_tasks/wait_for_tasks 能等待下载。
// 所有调用均在注册/投递成功后追加；任一失败由 registry 内部容错（try/catch + console 日志），不阻断下载。
// 事件双发区分：done → task:complete；failed/interrupted → task:fail；canceled → task:cancel。
// stop_task 触发的取消由宿主自动调 handler.abort，本插件不自发 task:abort。
import fs from "node:fs";
import { registerTask, completeTask, failTask, cancelTask } from "./registry.js";

// bus 兜底：插件 onload 时写入 globalThis.__dlBus；工具执行的 toolCtx 若不带 bus，自动回退到全局。
export function getBus(bus) {
  return bus || (typeof globalThis !== "undefined" ? globalThis.__dlBus : null) || null;
}

// 判断会话是否已收束（jsonl 尾部最后一条是 assistant stopReason=stop）。仅供扩展 dl-nextturn 的收束分界使用（尾随读取）。
// 这里的实现保留备用；扩展内部有 tailSettled（同口径），主逻辑 onload 不再需要它。
export function sessionSettled(task) {
  try {
    const p = task && (task.sessionPath || task.sessionRef?.path);
    if (!p || !fs.existsSync(p)) return false;
    const size = fs.statSync(p).size;
    if (size === 0) return false;
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(Math.min(size, 32768));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length);
    for (let i = lines.length - 1; i >= 0; i--) {
    let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type !== "message" || !o.message) continue; // 跳过记账/注入等非对话条目
      const m = o.message;
      return m.role === "assistant" && m.stopReason === "stop";
    }
    return false;
    
  } catch {
    return false;
  }
}

/**
 * 注册占位。无会话上下文（sessionId/sessionPath 均缺）时静默跳过——没有会话就无法唤醒，不影响下载本身。
 * 返回 { ok, reason }：ok=false 且 reason 标明跳过原因（no_session / register_failed）。
 * 成功后将 task.deferredRegistered 置真；若注册完成时任务已终态（秒下竞态），立即补 resolve 防幽灵占位。
 * keyOverride：默认用 task.taskId；特殊占位（如停滞 taskId:stall）可覆盖。
 */
export async function registerDeferred(bus, task, extraMeta = {}, keyOverride = null, getTask = null) {
  bus = getBus(bus);
  if (!bus || !task) return { ok: false, reason: "no_bus" };
  const { sessionId, sessionPath } = task;
  if (!sessionId && !sessionPath) return { ok: false, reason: "no_session" };
  const key = keyOverride || task.taskId;
  try {
    await bus.request("deferred:register", {
      taskId: key,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      meta: {
        type: "download",
        fileName: task.fileName || "",
        ...(task.url ? { url: task.url } : {}),
        ...extraMeta,
      },
    });
    // 双注册第二路：宿主 TaskRegistry 注册任务实例（stop_task 可取消 / check_pending_tasks 可等待）。
    // 失败容错：registry 内部 try/catch + console 日志，不阻断下载。
    await registerTask(bus, task);
    if (!keyOverride) task.deferredRegistered = true; // 主占位记录注册状态（stall 占位不覆盖任务标记）
    // 竞态防护：注册完成时任务可能已终态（小文件秒下）→ 补 resolve，占位不留幽灵。
    // v0.6.1：传 getTask 的调用方（创建即注册 download-file/command）走延迟复查路径、尊重 consumedByWait——
    // Agent 已通过 wait 拿到终态则静默跳过，不再“立即投递、绕过 consumed”导致冗余唤醒（deec9994 实测暴露）。
    // 未传 getTask 的调用方（onload 遗留兜底/停滞占位）保持“立即 resolve”——那些是收束后/停滞场景，
    // 无本轮已消费语义，已发即投；若不区分，会把 onload 遗留批 34 个终态任务全拖进 2s 复查串行超时。
    if (task.state && (task.state === "done" || task.state === "failed" || task.state === "canceled" || task.state === "interrupted")) {
      await resolveDeferred(bus, task, getTask || undefined);
    }
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: "register_failed", error: e?.message || String(e) };
  }
}

const FINAL_RESOLVE_DELAY_MS = 0; // 终态后立即复查（原先 2000ms 是为了避开 wait 回查竞态，但复查本身是同步的、且 consumedByWait 判定已足够去重，故降为 0：对话收束后立即通知）
// v0.5.7 语义：占位由 wait 快照「未完成时续注册」（agent 收束前最后动作），会话内完成（已终态）不注册不投递。
// 此窗口只兜底「续注册后任务完成、agent 恰好又回查拿到终态」的窄间隙（wait 消费 → 复查跳过），
// 不再承担「等 agent 干完别的再回查」的大窗口（那是创建即注册时代的问题，已随注册时机后移消除）。

/** 解析占位（终态结果）。幂等：占位不存在或已终态时宿主侧无操作。
 *  getTask：可选回调，返回任务最新状态（用于延迟复查 wait 是否已消费）。
 */
export function resolveDeferred(bus, task, getTask) {
  bus = getBus(bus);
  if (!bus || !task) return Promise.resolve();
  // 已投递过（dl-nextturn followUp/同步投递已成功）→ 短路，绝不二次 resolve。
  // 双检：内存 `_delivered`（同进程）+ 持久化 `delivered`（host 重启后从 tasks.json 恢复保留）。
  // 否则 onload 兜底 / 注册竞态补 resolve 会把「已同步投递」的任务占位再 resolve 成 resolved，
  // 宿主 flushUndelivered 定时器扫到 resolved&&!delivered 会二次异步投递（双通道重复唤醒）。
  if (task._delivered === true || task.delivered === true) {
    return Promise.resolve();
  }
  const state = task.state;
  if (state !== "done" && state !== "failed" && state !== "canceled" && state !== "interrupted") {
    return Promise.resolve(); // 非终态不解析
  }
  const userCanceled = state === "canceled" && task.canceledBy === "user";
  // consumedByWait：Agent 已通过 wait 拿到结果，或 wait 正在守望（即将拿到）→ 静默不投递
  const consumed = task.consumedByWait === true || (task.waitActive || 0) > 0;
  if (consumed) {
    // Agent 在会话内已拿到终态：投递只会产生收束后的冗余唤醒噪音。
    // 宿主协议无「安静取消占位」API（abort 会投递失败消息误报"中止"），故不调 resolve 保留占位 pending，
    // 宿主在创建会话销毁时经 suppressBySession 自动清理（不投递）。不 resolve 即不发 deferred_result 事件。
    return Promise.resolve();
  }
  // 说明（改法B 定稿）：普通任务终态投递由扩展 dl-nextturn（唯一权威）负责，不再经 resolveDeferred。
  // 此处 resolveDeferred 仅剩三类用途：注册竞态补 resolve（registerDeferred 内）/ onload 遗留兜底 / 停滞占位。
  // 这些都是「收束后/补投」场景，应无条件 resolve（未消费就投），不需再判收束——收束分界已在扩展完成。
  // 故移除原先的 sessionSettled 短路，恢复无条件 resolve（保留 consumed 去重）。
  const result = {
    type: "download",
    taskId: task.taskId,
    fileName: task.fileName,
    state,
    consumedByWait: false,
    ...(state === "done"
      ? { filePath: task.filePath, total: task.total, received: task.received }
      : {
          error: task.error || state,
          canceledBy: task.canceledBy || null,
          userCanceled,
          hint: userCanceled ? "用户手动取消（非故障，无需自动重试或换源）" : null,
          ...(task.filePath ? { filePath: task.filePath } : {}),
        }),
  };
  // 延迟复查：终态后 Agent 可能正在本回合内做脚本监测/回查（wait 快照）。延迟一段后复查：
  // 复查时 wait 已消费 → Agent 已自己拿到结果，静默跳过（不投递）；未消费 → resolve 投递。
  // 无 getTask（注册竞态补 resolve / onload 兜底）→ 立即 resolve（秒下任务 Agent 来不及回查，投递合理）。
  if (typeof getTask !== "function") {
    return bus
      .request("deferred:resolve", { taskId: task.taskId, result })
      .then(() => notifyRegistryFinal(bus, task)) // 双注册终结：done → task:complete，其余终态 → task:fail
      .catch(() => { /* 无占位忽略 */ });
  }
  return new Promise((res) => {
    const timer = setTimeout(() => {
      if (task._resolveTimer) task._resolveTimer = null;
      let t2 = null;
      try { t2 = getTask(); } catch { /* 查询失败按未消费处理 */ }
      if (!t2 || t2.consumedByWait === true || (t2.waitActive || 0) > 0) { res(); return; }
      bus
        .request("deferred:resolve", { taskId: task.taskId, result })
        .then(() => notifyRegistryFinal(bus, task)) // 双注册终结：done → task:complete，其余终态 → task:fail
        .catch(() => { /* 无占位忽略 */ })
        .finally(res);
    }, FINAL_RESOLVE_DELAY_MS);
    if (timer.unref) timer.unref();
    // 存到任务对象供 wait 消费时取消（markConsumedByWait → clearTimeout）
    task._resolveTimer = timer;
  });
}

// 双注册终结通知：deferred:resolve 成功的同时，向宿主 TaskRegistry 终结任务。
// done → task:complete(result)；canceled → task:cancel(reason)；failed/interrupted → task:fail(reason)。
// registry 内部已容错（try/catch + console 日志），此处仅构造透传结果。
function notifyRegistryFinal(bus, task) {
  if (!task || !task.taskId) return Promise.resolve();
  if (task.state === "done") {
    return completeTask(bus, task.taskId, {
      url: task.url || "",
      fileName: task.fileName || "",
      filePath: task.filePath || null,
      total: task.total ?? null,
      received: task.received ?? 0,
    });
  }
  const reason = {
    state: task.state,
    error: task.error || task.state,
    canceledBy: task.canceledBy || null,
  };
  if (task.state === "canceled") return cancelTask(bus, task.taskId, reason);
  return failTask(bus, task.taskId, reason);
}
