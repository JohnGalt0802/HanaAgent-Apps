// tools/download-cancel.js — 下载取消工具
// Agent 侧主动终止下载任务（收到停滞通知后决策"取消"、或发现速度/源不可接受时）。
// 取消会中断连接并删除半成品文件。

import { getTaskManager } from "../lib/dlcore.js";

export const name = "download-cancel";
export const description =
  "取消一个进行中的下载任务（传 taskId）。取消后状态为 canceled；字节流任务保留 .part 断点续传文件，命令型任务清理半成品目录。用于中止不需要/出错的下载（如速度不达标、源不可用）。";

// v0.5.9：0.712.5 宿主要求插件工具必须声明 sessionPermission，否则 resolver 判 invalid target。
// cancel 主动终止连接并删半成品，有外部副作用 → 与 download-file/command 一致用 external_side_effect。
export const sessionPermission = { kind: "external_side_effect" };

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

export async function execute(input, toolCtx) {
  const taskId = String(input?.taskId || "").trim();
  if (!taskId) throw new Error("缺少 taskId（来自 download-file 的返回值）");

  const manager = getTaskManager(toolCtx.dataDir);
  // source="agent"：与用户在卡片上手动取消（source="user"）区分，供通知/卡片展示取消来源
  const r = manager.cancel(taskId, "agent");
  if (!r.ok) {
    return {
      content: [{ type: "text", text: `取消失败：${r.error || "任务不存在"}` }],
      details: { download: { taskId, canceled: false, error: r.error || "任务不存在" } },
    };
  }

  const snap = manager.snapshot(taskId);
  // 行为对齐：字节流任务取消后 .part 半成品保留供断点续传（dlcore 设计），命令型才真清理；
  // 旧文案「已删除」与实际不符（2026-08-31 实测发现，agent 据此残留了磁盘垃圾）
  const isCmd = snap?.kind === "command";
  const part = isCmd ? null : (manager.getTask?.(taskId)?.partPath || (snap?.filePath ? snap.filePath + ".part" : null));
  const tail = isCmd ? "，半成品目录已清理。" : (part ? `，.part 半成品已保留供续传（${part}）` : "。");
  return {
    content: [{ type: "text", text: `已取消下载任务 ${taskId}${snap?.fileName ? "（" + snap.fileName + "）" : ""}${tail}` }],
    details: {
      download: {
        taskId,
        canceled: true,
        state: "canceled",
        fileName: snap?.fileName || null,
      },
    },
  };
}
