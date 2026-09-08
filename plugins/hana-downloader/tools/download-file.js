// tools/download-file.js — 下载工具
// 以"准备态"启动下载：工具立即返回进度卡片（details.card，渲染在工具块正下方），
// 任务短暂延迟后自动开始，保证卡片从"准备中"→ 0% → 100% 全程可见。

import path from "node:path";
import fs from "node:fs";
import { getTaskManager } from "../lib/dlcore.js";
import { registerDeferred } from "../lib/deferred.js";

export const name = "download-file";
export const description =
  "下载一个 URL 文件到本地。发起即返回 taskId，卡片实时显示进度；下载完成后自动后台通知本会话（agent 无需轮询或调用 download-wait 确认）。用于需要保存本地文件的 HTTP/HTTPS 下载。\n完成后无需解释本工具行为，直接引用通知结果即可。";

export const sessionPermission = { kind: "external_side_effect" };

export const parameters = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "文件下载地址（http/https）",
    },
    saveDir: {
      type: "string",
      description: "可选：保存目录的绝对路径。留空则保存到插件默认目录（插件设置里可配置）。",
    },
    fileName: {
      type: "string",
      description: "可选：自定义保存文件名（含扩展名）。留空则从 URL 自动推断。",
    },
    speedLimit: {
      type: "number",
      description: "可选：限速下载（字节/秒），如 1048576 = 1MB/s。大文件限速可避免占满带宽，也便于观察下载进度。",
    },
    startDelayMs: {
      type: "number",
      description: "可选：延迟启动毫秒数（默认 0，立即开始下载；卡片渲染晚于下载也无妨，完成后照常显示 100%）。",
    },
    resumable: {
      type: "boolean",
      description: "是否启用断点续传，默认 true",
    },
    expectedSha256: {
      type: "string",
      description: "可选的期望 SHA-256 校验和",
    },
  },
  required: ["url"],
};

export async function execute(input, toolCtx) {
  const url = String(input?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("url 必须是 http/https 地址");
  }

  const manager = getTaskManager(toolCtx.dataDir);

  // 停滞判定阈值：配置可调，默认 30s 无新数据判定停滞
  const stallTimeoutMs = toolCtx.config?.get?.("stallTimeoutMs") ?? 30000;

  let saveDir = "";
  if (input?.saveDir && String(input.saveDir).trim()) {
    // Agent 显式指定目录：优先（Agent 自选模式的核心路径）
    saveDir = path.resolve(String(input.saveDir).trim());
  } else {
    // 读取插件设置 config.json：defaultSaveDir（默认目录）/ agentChooses（Agent 自选）
    let cfg = null;
    try {
      const cfgPath = path.join(toolCtx.dataDir, "config.json");
      if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch { cfg = null; }
    const defaultDir = cfg?.defaultSaveDir && String(cfg.defaultSaveDir).trim() ? String(cfg.defaultSaveDir).trim() : "";
    const agentChooses = cfg?.agentChooses === true;
    if (defaultDir && !agentChooses) {
      // 已设默认目录且非 Agent 自选：统一落默认目录
      saveDir = path.resolve(defaultDir);
    } else if (!defaultDir || agentChooses) {
      // 无默认目录或 Agent 自选：回退插件配置系统 defaultSaveDir（兼容旧配置），再回退插件数据目录
      try { saveDir = String(toolCtx.config?.get?.("defaultSaveDir") || "").trim(); } catch { saveDir = ""; }
    }
  }

  // 准备态：卡片先渲染，延迟后自动从 0% 开始
  const task = manager.prepare({
    url,
    fileName: input?.fileName,
    saveDir: saveDir || undefined,
    speedLimit: input?.speedLimit,
    startDelayMs: Number(input?.startDelayMs) || 0,
    resumable: input?.resumable !== false,
    expectedSha256: input?.expectedSha256,
    sessionId: toolCtx.sessionId,
    sessionRef: toolCtx.sessionRef,
    stallTimeoutMs,
    // explorer 坑12修复：toolCtx.sessionPath 间歇性为空，补 sessionRef?.path 退路（与 deferred.js:32 同口径）。
    sessionPath: toolCtx.sessionPath || toolCtx.sessionRef?.path || null,
  });

  const snap = manager.snapshot(task.taskId);

  // v0.6.6：创建即注册（功能第一）——任务创建时立即注册占位，保证任务结束必通知。
  // 去重靠 consumedByWait：agent 已主动 wait 拿到结果 → resolve 时静默；没拿到 → 投递。
  // 不再纠结「创建即注册 vs 后注册」：这是实现手段，能保证「任务结束必通知 + consumed 去重」即可。
  // 快下载回合内完成 → 占位在 → 同步即时投递；慢下载收束后完成 → 占位在 → 异步唤醒。
  await registerDeferred(toolCtx.bus, task, {})
    .catch(() => { /* 注册失败不阻断下载，占位缺失时收束后不自动唤醒 */ });

  return {
    content: [{ type: "text", text: `已开始下载 ${snap.fileName}（任务ID：${snap.taskId}）。后台流式下载，卡片实时显示进度。
任务结束（完成/失败/取消）时会后台通知本会话；若已主动调 download-wait 确认过结果，则不会重复提醒。` }],
    details: {
      card: {
        type: "webview", // PLUGINS.md L349 新协议必需；缺则卡片回退到 WebView ... Chalkboard 占位壳
        route: `/card/download?taskId=${snap.taskId}`,
        title: `下载 ${snap.fileName}`,
        description: `正在准备下载 ${snap.fileName}`,
        titlebar: null, // 尝试隐藏宿主外层标题栏（unified 形态；若宿主不透明则忽略）
        cardForm: "flush", // flush = 无外框，配 titlebar:null 为 unified 无缝形态
      },
    },
  };
}
