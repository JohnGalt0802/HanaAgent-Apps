// tools/download-wait.js — 下载进度查询工具（v0.8.0：纯事实查询，无守望）
//
// 事实查询：立即返回当前进度快照，不阻塞、不守望。
// 占位在 download-file/download-command 创建任务时已注册，本工具不再续注册。
// 本工具只陈述事实，不提供任何策略建议（换源/取消/接受等由调度层自行判断）。

import { getTaskManager } from "../lib/dlcore.js";


export const name = "download-wait";
export const description =
  "查询一个下载任务的当前进度快照（state/进度/速度/剩余时间）。立即返回、不阻塞、不等待下载完成。用于主动确认进度或提前拿终态；不调用也能正常收到完成通知。\n返回当前事实即可，无需解释。";

// 查询只读，不产生外部副作用 → kind:"read"
export const sessionPermission = { kind: "read" };

export const parameters = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "download-file 返回的任务 ID",
    },
  },
  required: ["taskId"],
};

const FINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };








    




/*
  }
}
*/

export async function execute(input, toolCtx) {
  const taskId = String(input?.taskId || "").trim();
  if (!taskId) throw new Error("缺少 taskId（来自 download-file 的返回值）");

  const manager = getTaskManager(toolCtx.dataDir);

  // 拿快照（最多等 5s 让 total 出现）
  const t0 = Date.now();
  let snap = manager.snapshot(taskId);
  while ((!snap || (snap.total == null && (snap.state === "pending" || (snap.state === "running" && snap.received === 0)))) && Date.now() - t0 < 5000) {
    await sleep(200);
    snap = manager.snapshot(taskId);
    if (!snap) break;
  }
  if (!snap) {
    return { content: [{ type: "text", text: `任务 ${taskId} 不存在或已过期（可能已被清理）。` }] };
  }

  // 已终态 → 标记已消费 + 立即返回事实
  if (FINAL[snap.state]) {
    manager.markConsumedByWait(taskId);
    // v0.9.3：不再调 deferred:suppress（宿主无此路由，魔改时代死通道）。占位若存在则任其过期：
    // 不 resolve 即不发 deferred_result 事件，会话销毁时宿主经 store.suppressDelivery 内部静默清理
    // （0.814 bundle 源码实证）。registry 层终结由扩展 dl-nextturn 的 consumed 分支统一处理。
    return buildResult(snap, { notifyRegistered: false, done: true });
  }

  // 未终态 → 立即返回事实（占位已在创建时注册，无需在此续注册）
  return buildResult(snap, { notifyRegistered: false, done: false });
  
}

// ── 组装返回（纯事实 + 占位状态，无策略建议）──
function buildResult(snap, { notifyRegistered, done }) {
  const registered = notifyRegistered === true || snap.deferredRegistered === true;
  const etaSeconds = etaSecondsOf(snap, done);
  const stalled = snap.state === "running" && snap.stalledAt != null;

  const parts = [];
  parts.push(`状态 ${snap.state}`);
  parts.push(`进度 ${snap.percent == null ? "—" : snap.percent + "%"}`);
  parts.push(`已下载 ${fmtBytes(snap.received)}` + (snap.total ? ` / ${fmtBytes(snap.total)}` : ""));
  if (snap.speed > 0) parts.push(`速度 ${fmtBytes(snap.speed)}/s`);
  if (etaSeconds != null) parts.push(`预计还需 ${fmtDuration(etaSeconds)}`);
  if (stalled) parts.push("已停滞（长时间无新数据）");
  if (snap.error) parts.push(`错误：${snap.error}`);
  if (snap.filePath) parts.push(`文件：${snap.filePath}`);
  if (snap.fileName) parts.push(`文件名：${snap.fileName}`);

  // 事实性指引：只陈述占位注册状态，不提供策略建议
  const guide = done
    ? ""
    : (registered
        ? "占位已注册，收束后下载完成会自动唤醒本会话"
        : "占位未注册，收束后需手动回查");

  const text = parts.join("，") + (guide ? `。${guide}` : "");

  return {
    content: [{ type: "text", text }],
    details: {
      download: {
        taskId: snap.taskId,
        state: snap.state,
        done,
        stalled,
        total: snap.total,
        received: snap.received,
        percent: snap.percent,
        speed: snap.speed,
        etaSeconds,
        error: snap.error,
        filePath: snap.filePath,
        fileName: snap.fileName,
        deferredAutoRegistered: registered,
      },
    },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + "B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n, i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + units[i];
}

function etaSecondsOf(snap, done) {
  if (done) return 0;
  if (snap.total && snap.speed > 0 && snap.received < snap.total) {
    return Math.max(0, Math.round((snap.total - snap.received) / snap.speed));
  }
  return null;
}

function fmtDuration(s) {
  if (s == null) return "";
  if (s < 60) return Math.max(1, s) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return (s / 3600).toFixed(1) + "h";
}
