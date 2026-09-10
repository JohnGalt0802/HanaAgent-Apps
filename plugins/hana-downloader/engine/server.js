// hana-downloader-app/engine/server.js — 受管下载引擎（完整版）
// 复用插件时代的下载内核 lib/dlcore.js（纯 Node，无宿主依赖），对外提供 HTTP 服务：
//   GET  /ping                        健康检查
//   POST /download                    发起 URL 下载 { url, fileName?, saveDir?, speedLimit?, stallTimeoutMs?, sessionPath? }
//   POST /command                     发起命令型下载 { kind: "git-clone"|"pnpm-install", repo?, targetDir?, workdir?, label? }
//   GET  /wait?taskId=xxx             进度快照
//   POST /cancel  { taskId, source? } 取消
//   GET  /list                        全部任务
//   GET  /events                      终态/停滞事件流（SSE）
// 由 app 经 ctx.runtime.fetch(runtimeId, path) 访问，服务注册见 manifest 的 service 参数。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getTaskManager } from "./dlcore.js";

const PORT = Number(process.env.HD_ENGINE_PORT || 4317);
const READY_MARKER = "HD_ENGINE_READY";
// dataDir 由 app 经 args 传入（受管程序的 cwd 不保证指向 app 数据目录）
const DATA_DIR = process.argv[2] || process.env.HD_ENGINE_DATA_DIR || process.cwd();

const log = (s) => { try { console.log(`[hd-engine] ${s}`); } catch {} };

const mgr = getTaskManager(DATA_DIR);
try { mgr.restore(); } catch (e) { log(`restore ERR ${e?.message || e}`); }

// ── 事件流（SSE）──
const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}
const summarize = (t) => t ? ({
  taskId: t.taskId, state: t.state || t.status, fileName: t.fileName, url: t.url,
  total: t.total ?? null, received: t.received ?? 0, filePath: t.filePath || null,
  error: t.error || null, canceledBy: t.canceledBy || null,
}) : null;

try { mgr.onFinal((t) => {
    log(`final ${t?.taskId} ${t?.state}`);
    broadcast({ type: "final", task: summarize(t) });
    // 同时落一个结果文件：app 侧用 fs 轮询它（不走 RPC，避免堵住工具回程的 rpc2.drain()）
    try {
      const dir = path.join(DATA_DIR, "finished");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${t.taskId}.json`), JSON.stringify(summarize(t)), "utf8");
    } catch (e) { log(`write finished ERR ${e?.message || e}`); }
  }); } catch (e) { log(`onFinal ERR ${e?.message || e}`); }
try { mgr.onStall((t) => {
  log(`stall ${t?.taskId}`);
  broadcast({ type: "stall", task: summarize(t) });
  // 与 finished 同一机制：落盘让 app 侧用 fs 轮询到（不占 RPC，不堵工具回包）
  try {
    const dir = path.join(DATA_DIR, "stalled");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${t.taskId}.json`), JSON.stringify(summarize(t)), "utf8");
  } catch (e) { log(`write stalled ERR ${e?.message || e}`); }
}); } catch (e) { log(`onStall ERR ${e?.message || e}`); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = async () => { let raw = ""; for await (const c of req) raw += c; try { return JSON.parse(raw || "{}"); } catch { return {}; } };

  if (req.method === "GET" && u.pathname === "/ping") return send(200, { ok: true, pid: process.pid, ts: Date.now() });

  if (req.method === "GET" && u.pathname === "/list") {
    let tasks = [];
    try { tasks = mgr.list() || []; } catch (e) { return send(500, { error: String(e?.message || e) }); }
    return send(200, { ok: true, tasks: tasks.map(summarize) });
  }

  if (req.method === "POST" && u.pathname === "/wait") {
    const b = await readBody();
    let taskId = b.taskId || u.searchParams.get("taskId");
    // 卡片中心 / 黑板用静态 route 打开时没有 taskId：回退到最近任务
    // （running/pending 优先，无在途任务时取最新一条），与旧插件服务端行为一致。
    if (!taskId) {
      try {
        const all = mgr.tasks && typeof mgr.tasks.values === "function" ? [...mgr.tasks.values()] : [];
        const active = all.filter((t) => t && (t.state === "running" || t.state === "pending"));
        const pick = active.length > 0 ? active[0] : all[all.length - 1];
        if (pick?.taskId) taskId = pick.taskId;
      } catch (e) { log(`wait fallback ERR ${e?.message || e}`); }
    }
    if (!taskId) return send(404, { error: "no task", taskId: null });
    const snap = mgr.snapshot(taskId);
    if (!snap) return send(404, { error: "not found", taskId });
    // 同时给 snap 和 task 两个键：前者是本引擎的命名，后者是卡片前端（自插件时代沿用）读的字段
    return send(200, { ok: true, snap, task: snap });
  }

  // 兼容旧式 query 调用（宿主导由对带 query 的路径支持不稳定，故主用 POST）
  if (req.method === "GET" && u.pathname === "/wait") {
    const taskId = u.searchParams.get("taskId");
    if (!taskId) return send(400, { error: "taskId required" });
    const snap = mgr.snapshot(taskId);
    if (!snap) return send(404, { error: "not found", taskId });
    return send(200, { ok: true, snap });
  }

  if (req.method === "POST" && u.pathname === "/download") {
    const b = await readBody();
    if (!b.url) return send(400, { error: "url required" });
    try {
      const t = await mgr.create({
        url: b.url,
        fileName: b.fileName || undefined,
        saveDir: b.saveDir || undefined,
        speedLimit: b.speedLimit || undefined,
        stallTimeoutMs: b.stallTimeoutMs || undefined,
        sessionPath: b.sessionPath || null,
        kind: "url",
      });
      log(`created ${t?.taskId} | ${b.url}`);
      return send(200, { ok: true, taskId: t?.taskId, state: t?.state || t?.status });
    } catch (e) {
      log(`create ERR ${e?.message || e}`);
      return send(500, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && u.pathname === "/command") {
    const b = await readBody();
    const kind = String(b.kind || "").trim();
    const workdir = b.workdir ? path.resolve(String(b.workdir).trim()) : process.cwd();
    let cmd = null, fileName = "", filePath = "", unit = "bytes";
    try {
      if (kind === "git-clone") {
        const repo = String(b.repo || "").trim();
        if (!repo) return send(400, { error: "git-clone 需要仓库地址（repo）" });
        if (!fs.existsSync(workdir)) return send(400, { error: `工作目录不存在：${workdir}` });
        const repoName = repoNameOf(repo);
        const targetDir = b.targetDir ? path.resolve(String(b.targetDir).trim()) : path.join(workdir, repoName);
        if (fs.existsSync(targetDir)) return send(409, { error: `目标目录已存在，为避免覆盖：${targetDir}` });
        filePath = targetDir;
        fileName = b.label ? String(b.label).trim() : repoName;
        unit = "objects";
        cmd = { type: "git-clone", args: [repo, targetDir], workdir, targetDir };
      } else if (kind === "pnpm-install") {
        if (!fs.existsSync(workdir)) return send(400, { error: `工作目录不存在：${workdir}` });
        filePath = workdir;
        fileName = b.label ? String(b.label).trim() : path.basename(workdir) + "（依赖安装）";
        unit = "packages";
        cmd = { type: "pnpm-install", args: [], workdir };
      } else {
        return send(400, { error: `不支持的命令类型：${kind}（仅支持 git-clone / pnpm-install）` });
      }
      const t = await mgr.create({
        kind: "command",
        cmd,
        unit,
        fileName,
        filePath,
        saveDir: path.dirname(filePath),
        stallTimeoutMs: b.stallTimeoutMs || undefined,
        sessionPath: b.sessionPath || null,
      });
      log(`created command ${t?.taskId} | ${kind} ${fileName}`);
      return send(200, { ok: true, taskId: t?.taskId, state: t?.state || t?.status, kind: "command", fileName, filePath });
    } catch (e) {
      log(`command ERR ${e?.message || e}`);
      return send(500, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && u.pathname === "/cancel") {
    const b = await readBody();
    if (!b.taskId) return send(400, { error: "taskId required" });
    try {
      const r = mgr.cancel(b.taskId, b.source || "agent");
      log(`cancel ${b.taskId} -> ${JSON.stringify(r)}`);
      return send(200, { ok: true, result: r ?? null });
    } catch (e) {
      return send(500, { error: String(e?.message || e) });
    }
  }

  // 在系统文件管理器中定位（local-machine 下可 spawn 本机程序）
  if (req.method === "POST" && u.pathname === "/reveal") {
    const b = await readBody();
    const p = b.filePath || b.path;
    if (!p) return send(400, { error: "filePath required" });
    try {
      const { spawn } = await import("node:child_process");
      spawn("explorer.exe", ["/select,", p], { detached: true, stdio: "ignore" }).unref();
      log(`reveal ${p}`);
      return send(200, { ok: true });
    } catch (e) {
      return send(500, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && u.pathname === "/clear") {
    const b = await readBody();
    try {
      const r = mgr.clearByStates(b.states || ["done", "failed", "canceled", "interrupted"]);
      return send(200, { ok: true, ...r });
    } catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (req.method === "POST" && u.pathname === "/cancel-all") {
    try {
      const r = mgr.cancelAll("user");
      return send(200, { ok: true, ...r });
    } catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (u.pathname === "/settings") {
    const cfgFile = path.join(DATA_DIR, "engine-config.json");
    if (req.method === "GET") {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch {}
      return send(200, { ok: true, settings: cfg });
    }
    if (req.method === "POST") {
      const b = await readBody();
      try {
        const cur = (() => { try { return JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { return {}; } })();
        const next = { ...cur, ...(b && typeof b === "object" ? b : {}) };
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2), "utf8");
        return send(200, { ok: true, settings: next });
      } catch (e) { return send(500, { error: String(e?.message || e) }); }
    }
  }

  // 注意：不能使用 /download/* 前缀（“download” 会被宿主的运行时路由当成保留段，路径被截断）。
  if (req.method === "GET" && u.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`: connected\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  return send(404, { error: "not found", path: u.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening 127.0.0.1:${PORT} | dataDir=${DATA_DIR}`);
  // 就绪标记必须独占一行且与 service.readyMarker 精确匹配
  console.log(READY_MARKER);
});

// ── 命令型辅助：仓库名提取与安全化 ──
function repoNameOf(repo) {
  const cleaned = repo.replace(/\.git(?:\/)?$/, "");
  const seg = cleaned.split(/[/\\]+/).filter(Boolean).pop() || "repo";
  return sanitizeName(seg);
}

function sanitizeName(name) {
  const s = String(name || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return s || "repo";
}
