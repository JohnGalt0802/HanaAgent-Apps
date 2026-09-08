// routes/download.js — 下载进度卡片相关路由
//   GET  /card/download?taskId=xxx   进度卡片页面（iframe）
//   GET  /download/status?taskId=xxx 进度 JSON（卡片轮询）
//   POST /download/cancel?taskId=xxx 取消下载

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTaskManager, _resetTaskManager } from "../lib/dlcore.js";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

// 取“新版本可用的”任务管理器：若 globalThis 缓存的是旧实例（缺新方法，说明 lib 模块被缓存、
// MGR_VER 常量未更新），则强制 _resetTaskManager 重建，确保 clearByStates/cancelAll 等方法可用。
function _freshManager(dataDir) {
  let m = getTaskManager(dataDir);
  if (m && typeof m.clearByStates === "function") return m;
  try { _resetTaskManager(); } catch (e) { /* 忽略 */ }
  m = getTaskManager(dataDir);
  return m;
}

// 每次请求时读取卡片资源，改样式/脚本即时生效（不缓存）
function readCardAssets() {
  return {
    css: fs.readFileSync(path.join(APP, "card.css"), "utf-8"),
    js: fs.readFileSync(path.join(APP, "card.js"), "utf-8"),
  };
}

// 下载管理器资源（跨会话任务列表页）
function readManagerAssets() {
  return {
    css: fs.readFileSync(path.join(APP, "manager.css"), "utf-8"),
    js: fs.readFileSync(path.join(APP, "manager.js"), "utf-8"),
  };
}

export default function registerDownloadRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;
  // 任务管理器实例（globalThis 单例，dataDir 为实际任务存储位置：community 槽）
  const taskMgr = getTaskManager(ctx.dataDir);
  // 关键：host 可能在 plugin onload 之前调 routes（_loadRoutes 与 _activatePluginEntry 顺序），此时 tasks.json 未加载、
  // fallback 取不到任务 → 卡片显示“缺少任务 ID”。这里幂等调 restore() 保证内存 Map 加载。
  // restore() 内 `if (this.tasks.get(m.taskId)) continue` 避免覆盖内存里已有的任务，与 onload 后调不冲突。
  try { taskMgr.restore(); } catch (e) { console.warn("[download] restore failed:", e?.message || e); }

  // ── 插件设置（默认下载目录等）与 tasks.json 同级存放（实际生效的 dataDir）──
  const CONFIG_FILE = path.join(taskMgr.dataDir, "config.json");
  function readSettings() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) || {}; } catch { return {}; }
  }
  function writeSettings(s) {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2), "utf-8");
  }

  // 诊断：卡片页面把实际生效的 CSS 变量与尺寸上报（排查用，无副作用）
  app.post("/diag", async (c) => {
    try {
      const body = await c.req.json();
      fs.appendFileSync(
        path.join(taskMgr.dataDir, "manager-diag.log"),
        JSON.stringify({ t: new Date().toISOString(), ...body }) + "\n",
        "utf-8"
      );
    } catch (e) { /* 忽略 */ }
    return c.json({ ok: true });
  });

  // 读设置
  app.get("/settings", (c) => {
    try { return c.json({ ok: true, settings: readSettings() }); }
    catch (e) { return c.json({ ok: false, error: e?.message || String(e) }, 500); }
  });

  // 写设置：defaultSaveDir 设置/清除默认下载目录；agentChooses 是否由 Agent 自选目录
  app.post("/settings", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const cur = readSettings();
      if (body.defaultSaveDir !== undefined) {
        const v = String(body.defaultSaveDir || "").trim();
        if (v) { try { fs.mkdirSync(v, { recursive: true }); } catch { /* 目录不可创建也不阻塞 */ } }
        cur.defaultSaveDir = v || null;
      }
      if (body.agentChooses !== undefined) {
        cur.agentChooses = !!body.agentChooses;
      }
      writeSettings(cur);
      return c.json({ ok: true, settings: cur });
    } catch (e) { return c.json({ ok: false, error: e?.message || String(e) }, 500); }
  });

  // 启动下载（HTTP 入口，UI/外部直接调用，返回任务快照）
  // 注意：sessionId 硬编码 null，不注册 deferred 占位——UI 入口无唤醒语义，完成不投递
  app.post("/download/start", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const url = String(body?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return c.json({ ok: false, error: "url 必须是 http/https 地址" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      const task = manager.create({
        url,
        fileName: body?.fileName ? String(body.fileName) : undefined,
        saveDir: body?.saveDir ? String(body.saveDir) : undefined,
        speedLimit: Number(body?.speedLimit) || 0,
        sessionId: null,
        sessionRef: null,
      });
      return c.json({ ok: true, task: manager.snapshot(task.taskId) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // 准备下载（pending）：生成任务占位并延迟自动启动，供卡片先渲染、进度从 0% 开始
  // 注意：UI 入口，sessionId 为 null 不注册占位，无唤醒语义（Agent 工具入口 download-file 才注册）
  app.post("/download/prepare", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const url = String(body?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return c.json({ ok: false, error: "url 必须是 http/https 地址" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      const task = manager.prepare({
        url,
        fileName: body?.fileName ? String(body.fileName) : undefined,
        saveDir: body?.saveDir ? String(body.saveDir) : undefined,
        speedLimit: Number(body?.speedLimit) || 0,
        startDelayMs: Number(body?.startDelayMs) || 0,
        sessionId: null,
        sessionRef: null,
      });
      return c.json({ ok: true, task: manager.snapshot(task.taskId) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.get("/download/status", (c) => {
    try {
      const taskId = String(c.req.query("taskId") || "");
      if (!taskId) return c.json({ ok: false, error: "缺少 taskId" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      const snap = manager.snapshot(taskId);
      if (!snap) return c.json({ ok: false, error: "任务不存在" }, 404);
      return c.json({ ok: true, task: snap });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // 全部任务列表（跨会话下载管理器）：在途优先，终态按结束时间倒序
  app.get("/download/list", (c) => {
    try {
      const manager = getTaskManager(ctx.dataDir);
      const tasks = manager.list();
      return c.json({ ok: true, tasks });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.post("/download/cancel", (c) => {
    try {
      const taskId = String(c.req.query("taskId") || "");
      if (!taskId) return c.json({ ok: false, error: "缺少 taskId" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      // 卡片按钮 = 用户手动操作，固定标记 canceledBy=user，供 Agent 区分取消来源
      const r = manager.cancel(taskId, "user");
      return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 409);
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // 清空分类记录（管理器按钮：仅移除任务记录，不删磁盘文件）
  // body: { states: ["done"] / ["failed","canceled","interrupted"] / [终态全集] }
  app.post("/download/clear", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const states = Array.isArray(body.states) ? body.states.filter((s) => typeof s === "string") : [];
      if (!states.length) return c.json({ ok: false, error: "缺少要清空的状态" }, 400);
      const manager = _freshManager(ctx.dataDir);
      const r = manager.clearByStates(states);
      return c.json({ ok: r.ok, removed: r.removed || [] }, 200);
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // 全部取消在途（管理器“全部取消”按钮）
  app.post("/download/cancel-all", (c) => {
    try {
      const manager = _freshManager(ctx.dataDir);
      const r = manager.cancelAll("user");
      return c.json({ ok: r.ok, canceled: r.canceled || [] }, 200);
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // 打开文件/所在文件夹（服务端 explorer.exe，绕过宿主 capability 的 platform 限制）
  // mode=reveal（默认）：定位文件并打开所在文件夹；mode=open：用默认程序打开文件；目录路径直接打开
  app.post("/download/reveal", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const target = String(body.path || "").trim();
      const mode = String(body.mode || "reveal") === "open" ? "open" : "reveal";
      if (!target) return c.json({ ok: false, error: "缺少路径" }, 400);
      // 安全校验：目标必须是任务记录中的文件路径或其所在目录
      const manager = getTaskManager(ctx.dataDir);
      const tasks = manager.list();
      const knownFile = tasks.some((t) => t.filePath === target);
      const knownDir = tasks.some((t) => t.filePath && path.dirname(t.filePath) === target);
      if (!knownFile && !knownDir) return c.json({ ok: false, error: "路径不在下载记录中" }, 403);
      const { execFile } = await import("node:child_process");
      const { statSync } = await import("node:fs");
      // 目标类型：目录任务（git-clone）的 filePath 本身是目录；下载任务的 filePath 是文件（不存在时按文件处理，开父目录）
      let isDir = false;
      try { isDir = statSync(target).isDirectory(); } catch { /* 文件不存在 → 按文件处理 */ }
      // 语义：open=用默认程序打开目标本身；reveal=打开目标所在文件夹（目录则直接进入）
      const openPath = mode === "open" ? target : (isDir ? target : path.dirname(target));
      if (process.platform === "win32") {
        // cmd /c + 双引号 + ^ 转义：
        //  - 双引号整体包裹 → explorer 正确解析含空格路径（spawn 直传会被 explorer 自解析截断，exit 1）
        //  - ^ 转义 & | ^ % < > " ! → 消除 cmd 命令分隔符注入面（引号内 & 虽不分隔，但防御异常路径）
        //  - windowsVerbatimArguments: true → Node 不自动转义内嵌引号（默认会转成 \"，cmd 收到错乱引号导致 explorer 参数截断）
        const esc = openPath.replace(/([&|^%<>"!])/g, "^$1");
        execFile("cmd.exe", ["/c", 'explorer.exe "' + esc + '"'], { windowsHide: true, windowsVerbatimArguments: true }, (err) => {
          if (err) console.error("[dl-reveal] explorer failed:", err);
        });
      } else {
        // 非 Windows：平台默认打开器
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        execFile(opener, [openPath], { windowsHide: true }, (err) => {
          if (err) console.error("[dl-reveal] opener failed:", err);
        });
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.get("/manager", (c) => {
    c.header("Cache-Control", "no-store");
    const assets = readManagerAssets();
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    return c.html(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>下载管理器</title>
${hcLink}
<style>${assets.css}<\/style>
</head>
<body data-hana-theme="${esc(th)}">
<div id="dl-root"></div>
<script>window.__API="${base}";<\/script>
<script>${assets.js}<\/script>
</body>
</html>`);
  });

  app.get("/card/download", (c) => {
    c.header("Cache-Control", "no-store");
    const assets = readCardAssets();
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    let taskId = String(c.req.query("taskId") || "");
    // Chalkboard 卡片用静态 route（无 taskId）打开：自动取最近任务（running/pending 优先，
    // 无在途任务时取最新任务展示完成态）。这样卡片中心/Chalkboard 打开也能显示进度。
    if (!taskId) {
      try {
        const manager = getTaskManager(ctx.dataDir);
        // 兑底：万一 routes 被调用时 Map 是空（比如 plugin 重载途中），再 restore 一次
        if (manager.tasks.size === 0) {
          try { manager.restore(); } catch { /* 失败交给下面过滤处理 */ }
        }
        const all = manager.tasks ? [...manager.tasks.values()] : [];
        const active = all.filter((t) => t && (t.state === "running" || t.state === "pending"));
        const pick = active.length > 0 ? active[0] : all[all.length - 1];
        if (pick?.taskId) taskId = pick.taskId;
      } catch (e) {
        console.warn("[download] fallback task lookup failed:", e?.message || e);
      }
    }
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    return c.html(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>下载进度</title>
${hcLink}
<style>${assets.css}<\/style>
</head>
<body data-hana-theme="${esc(th)}">
<div id="dl-root" data-task="${esc(taskId)}"></div>
<script>window.__API="${base}";<\/script>
<script>${assets.js}<\/script>
</body>
</html>`);
  });
}

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
