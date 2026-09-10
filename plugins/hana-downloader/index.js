// hana-downloader-app/index.js — v2 App 骨架（阶段 1）
// 职责：
//   1. 以 local-machine 受管程序拉起下载引擎（engine/server.js），拿回 runtimeId
//   2. 注册工具，工具内部经 ctx.runtime.fetch(runtimeId, path) 调引擎
//   3. 投递：在工具调用上下文里拿 callToken，交给 ctx.tasks 统一投递（宿主负责排程）
import path from "node:path";

const ENGINE_PORT = 4317;
const ENGINE_READY = "HD_ENGINE_READY";

export function apply(ctx) {
  const log = (s) => { try { ctx.logger?.info?.(`[hd-app] ${s}`); } catch {} };
  const err = (s) => { try { ctx.logger?.error?.(`[hd-app] ${s}`); } catch {} };
  log(`apply entered | dataDir=${ctx.dataDir}`);

  let engine = null;

  // reload 时旧 runtime 可能还占着端口：先停掉本 app 的遗留运行实例
  async function stopStaleRuntimes() {
    try {
      const list = await ctx.runtime.list();
      for (const r of Array.isArray(list) ? list : []) {
        if (!r || !r.runtimeId) continue;
        if (r.state === "ready" || r.state === "starting") {
          try { await ctx.runtime.stop(r.runtimeId); log(`stopped stale runtime | ${r.runtimeId} (${r.state})`); } catch (e) { err(`stop ERR ${r.runtimeId} | ${e?.message || e}`); }
        }
      }
    } catch (e) { err(`list runtimes ERR | ${e?.message || e}`); }
  }

  async function startEngine() {
    const rt = await ctx.runtime.start({
      runtime: "node",
      entry: "engine/server.js",
      profile: "local-machine",
      network: "external",
      args: [ctx.dataDir || ""],
      // 对照实验：暂时不注册回环服务，验证“常驻 RPC 是否来自 service”
      // (service: { port: ENGINE_PORT, readyMarker: ENGINE_READY })
    });
    engine = rt;
    log(`engine started | ${JSON.stringify(rt)}`);
    // 不再用 runtime service（它会留一条常驻 RPC，卡住工具回包），
    // 改成 app 主动经 ctx.network.fetch 探活。
    setTimeout(async () => {
      try {
        const st = await ctx.runtime.get(rt.runtimeId);
        log(`engine state after 3s | ${JSON.stringify(st)}`);
      } catch (e) { err(`runtime.get ERR | ${e?.message || e}`); }
      await waitEngineReady();
    }, 3000);
    return rt;
  }

  async function waitEngineReady(timeoutMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await callEngine("/ping", { method: "GET", timeoutMs: 3000 });
        log(`engine ready | ${JSON.stringify(r).slice(0, 240)}`);
        return true;
      } catch (e) {
        await sleep(800);
      }
    }
    err("engine ready timeout");
    return false;
  }

  // ── 引擎存活监控 ──
  // 受管进程可能静默消失（宿主日志无退出痕迹），而宿主不会自动重启它。
  // 没有这层，一次意外退出会让后续所有工具调用报 engine fetch failed，
  // 且用户看到的只是“卡住”。这里定期探活，发现不可达就重拉并等就绪。
  let watchdogTimer = null;
  let restarting = false;
  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
      if (restarting) return;
      try {
        await callEngine("/ping", { method: "GET", timeoutMs: 4000 });
      } catch (e) {
        restarting = true;
        err(`engine unreachable, restarting | ${e?.message || e}`);
        try {
          await stopStaleRuntimes();
          await startEngine();
          const ok = await waitEngineReady(20000);
          log(`engine restarted | ok=${ok}`);
        } catch (e2) {
          err(`engine restart ERR | ${e2?.message || e2}`);
        } finally {
          restarting = false;
        }
      }
    }, 30000);
  }

  // 引擎任务终态 → 结算宿主任务（ctx.tasks.complete/fail），由宿主统一投递
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function callEngine(p, init) {
    // 走 ctx.network.fetch（清单顶层 network 已声明 127.0.0.1 + allowLocalhost）：
    // 不再用 ctx.runtime.fetch——那条路会随 runtime service 留一条常驻 RPC，
    // 把工具回程前的 rpc2.drain() 卡到 30s 超时。
    const url = `http://127.0.0.1:${ENGINE_PORT}${p}`;
    const opts = { method: "POST", timeoutMs: 30000, ...(init || {}) };
    let raw;
    try {
      raw = await ctx.network.fetch(url, opts);
    } catch (e) {
      throw new Error(`engine fetch ${p} failed: ${e?.message || e}`);
    }
    const text = await raw.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  // 引擎任务终态 → 结算宿主任务（ctx.tasks.complete/fail），由宿主统一投递。
  // 注意：这不能用 RPC 轮询（rpc2.drain() 会被持续挂起的 RPC 堵住，导致工具回包超时），
  // 所以改读引擎落在 dataDir/finished 下的结果文件——纯 fs，不占 RPC。
  async function settleWhenDone(engineTaskId, hostTaskId, label, currentCallToken) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const finishedPath = path.join(ctx.dataDir, "finished", `${engineTaskId}.json`);
    const stalledPath = path.join(ctx.dataDir, "stalled", `${engineTaskId}.json`);
    let snap = null;
    let stallNotified = false;
    for (let i = 0; i < 900; i++) {
      await sleep(2000);
      // 卡滞（stall）是中途状态，不是终态。v2 的任务模型要求 create 时必须携带
      // 当前有效的 callToken，而 callToken 只在工具 execute 期间有效，下载中途早已过期，
      // 所以中途无法向会话投递（无令牌时 delivery 必为 "none"）。
      // 这里只记录事实，等待终态（done/failed/canceled/interrupted）再统一投递。
      if (!stallNotified) {
        try {
          if (fs.existsSync(stalledPath)) {
            const st = JSON.parse(fs.readFileSync(stalledPath, "utf8"));
            stallNotified = true;
            log(`stall observed (no mid-flight delivery in v2) | ${engineTaskId} received=${st.received ?? "?"}`);
          }
        } catch (e) { err(`stall read ERR | ${e?.message || e}`); }
      }
      try {
        if (fs.existsSync(finishedPath)) {
          snap = JSON.parse(fs.readFileSync(finishedPath, "utf8"));
          break;
        }
      } catch (e) { /* 继续等 */ }
    }
    if (!snap) {
      try { await ctx.tasks.fail(hostTaskId, "下载超时未结束"); } catch {}
      return;
    }
    const text = snap.state === "done"
      ? `下载完成：${snap.fileName || label}\n路径：${snap.filePath || "?"}\n大小：${snap.received ?? "?"} 字节`
      : snap.state === "canceled"
        ? `下载已取消：${snap.fileName || label}`
        : `下载失败：${snap.fileName || label}${snap.error ? `（${snap.error}）` : ""}`;
    try {
      if (snap.state === "done") {
        await ctx.tasks.complete(hostTaskId, { text, filePath: snap.filePath || null, total: snap.total ?? null, received: snap.received ?? 0 });
      } else if (snap.state === "canceled") {
        // 取消走任务的 cancel 终态，而不是 fail（语义上宿主能区分“被取消”与“出错”）
        await ctx.tasks.cancel(hostTaskId);
      } else {
        await ctx.tasks.fail(hostTaskId, text);
      }
      log(`tasks.${snap.state === "done" ? "complete" : snap.state === "canceled" ? "cancel" : "fail"} OK | ${hostTaskId} -> ${snap.state}`);
    } catch (e) {
      err(`tasks settle ERR | ${hostTaskId} | ${e?.message || e}`);
    }
  }

  // ── 工具：download-file ──
  try {
    ctx.tools.register({
      name: "download-file",
      description:
        "下载一个 URL 文件到本地（http/https，支持任意 URL 与任意落盘目录）。发起即返回 taskId，卡片实时显示进度；下载完成后自动后台通知本会话（无需轮询或调用 download-wait 确认）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "文件下载地址（http/https）" },
          saveDir: { type: "string", description: "可选：保存目录绝对路径。留空则用默认目录。" },
          fileName: { type: "string", description: "可选：自定义保存文件名（含扩展名）。留空则从 URL 推断。" },
        },
        required: ["url"],
      },
      invocationStyle: "sdk_tool",
      async execute({ url, fileName, saveDir, context }) {
        const t0 = Date.now();
        const callToken = context?.callToken;
        const sessionPath = context?.sessionPath;
        log(`download-file invoked | url=${url} callToken=${typeof callToken} sessionPath=${sessionPath || "?"}`);
        let r;
        try {
          r = await callEngine("/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url, fileName, saveDir, callToken, sessionPath }),
          });
        } catch (e) {
          err(`engine call ERR | ${e?.message || e}`);
          return { content: [{ type: "text", text: `发起下载失败：${e?.message || e}` }], isError: true };
        }
        log(`engine response | ${JSON.stringify(r).slice(0, 400)}`);
        if (r?.error || !r?.taskId) {
          return { content: [{ type: "text", text: `发起下载失败：${r?.error || "引擎未返回 taskId"}` }], isError: true };
        }

        // 投递：有 callToken 才走会话通道（宿主统一排程）
        let task = null;
        try {
          if (callToken) {
            task = await ctx.tasks.create({ callToken, label: `下载 ${fileName || url}`, delivery: "next-step" });
            log(`tasks.create OK | ${JSON.stringify(task)}`);
            if (task?.taskId && r?.taskId) {
              setTimeout(() => {
                settleWhenDone(r.taskId, task.taskId, fileName || url, callToken).catch((e) => err(`settle ERR | ${e?.message || e}`));
              }, 200);
            }
          } else {
            log("no callToken → 跳过 tasks 创建");
          }
        } catch (e) {
          err(`tasks.create ERR | ${e?.message || e}`);
        }

        log(`download-file returning | +${Date.now() - t0}ms`);
        const text = [
          `已开始下载：${fileName || r?.fileName || url}`,
          `任务 ID：${r.taskId}`,
          task?.taskId ? "完成后会自动通知本会话；也可用 download-wait 查询进度。" : "未接入会话通知（无 callToken）。",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            // 聊天流卡：宿主据此在工具块下方装一个 iframe。
            // route 必须是不带 query 的 ui/ 相对路径（宿主拒收 `?`/`#`），
            // 所以不传 taskId；卡片打开后用 /wait 无参回退到最近任务。
            card: {
              route: "/card.html",
              title: `下载 ${r?.fileName || fileName || ""}`.trim(),
              description: String(r?.fileName || fileName || url),
              aspectRatio: "8:1",
              cardForm: "flush",
              titlebar: null,
            },
            download: {
              taskId: r.taskId,
              url,
              fileName: r?.fileName || fileName || null,
              saveDir: r?.saveDir || saveDir || null,
              filePath: r?.filePath || null,
              state: r?.state || "pending",
              hostTaskId: task?.taskId || null,
            },
          },
        };
      },
    });
    log("tool registered | download-file");
  } catch (e) {
    err(`download-file register ERR | ${e?.message || e}`);
  }

  // ── 工具：download-wait（只读快照）──
  try {
    ctx.tools.register({
      name: "download-wait",
      description:
        "查询一个下载任务的当前进度快照（state/进度/速度）。立即返回、不阻塞、不等待完成。用于主动确认进度或提前拿终态；不调用也能正常收到完成通知。",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string", description: "download-file 返回的任务 ID" } },
        required: ["taskId"],
      },
      invocationStyle: "sdk_tool",
      async execute({ taskId }) {
        const id = String(taskId || "").trim();
        if (!id) return { content: [{ type: "text", text: "缺少 taskId" }], isError: true };
        let r;
        try {
          r = await callEngine("/wait", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: id }),
          });
        } catch (e) {
          return { content: [{ type: "text", text: `查询失败：${e?.message || e}` }], isError: true };
        }
        if (!r || r.error) return { content: [{ type: "text", text: `查询失败：${r?.error || "任务不存在"}` }], isError: true };
        const snap = r.snap || r;
        const pct = snap.total ? Math.round((snap.received / snap.total) * 100) : null;
        const text = [
          `状态：${snap.state}`,
          `文件：${snap.fileName || "?"}`,
          pct == null ? `已下载：${snap.received ?? "?"} 字节` : `进度：${pct}%（${snap.received}/${snap.total} 字节）`,
          snap.error ? `错误：${snap.error}` : null,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }], details: { download: snap } };
      },
    });
    log("tool registered | download-wait");
  } catch (e) { err(`download-wait register ERR | ${e?.message || e}`); }

  // ── 工具：download-cancel ──
  try {
    ctx.tools.register({
      name: "download-cancel",
      description: "取消一个正在进行的下载任务（download-file 返回的 taskId）。",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string", description: "download-file 返回的任务 ID" } },
        required: ["taskId"],
      },
      invocationStyle: "sdk_tool",
      async execute({ taskId }) {
        const id = String(taskId || "").trim();
        if (!id) return { content: [{ type: "text", text: "缺少 taskId" }], isError: true };
        let r;
        try {
          r = await callEngine("/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: id, source: "agent" }),
          });
        } catch (e) {
          return { content: [{ type: "text", text: `取消失败：${e?.message || e}` }], isError: true };
        }
        const snap = r?.snap || r || {};
        const ok = r?.ok !== false;
        const text = ok
          ? `已取消下载任务 ${id}${snap?.fileName ? `（${snap.fileName}）` : ""}${snap?.partPath ? `，半成品已保留供续传（${snap.partPath}）` : "。"}`
          : `取消失败：${r?.error || "任务不存在"}`;
        return { content: [{ type: "text", text }], details: { download: { taskId: id, canceled: ok, ...(snap || {}) } } };
      },
    });
    log("tool registered | download-cancel");
  } catch (e) { err(`download-cancel register ERR | ${e?.message || e}`); }

  // ── 工具：download-command（命令型：git clone / pnpm install）──
  try {
    ctx.tools.register({
      name: "download-command",
      description:
        "执行下载型命令（git-clone 克隆仓库 / pnpm-install 安装依赖）并在卡片上显示实时进度。仅支持这两种类型，不做任意命令执行。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["git-clone", "pnpm-install"], description: "命令类型" },
          repo: { type: "string", description: "git-clone 专用：仓库地址（http/https/git@/本地路径）" },
          targetDir: { type: "string", description: "git-clone 专用：目标目录绝对路径（可选，默认取仓库名）" },
          workdir: { type: "string", description: "执行工作目录（pnpm-install 必填；git-clone 可选）" },
          label: { type: "string", description: "卡片显示名（可选）" },
        },
        required: ["kind"],
      },
      invocationStyle: "sdk_tool",
      async execute({ kind, repo, targetDir, workdir, label, context }) {
        const callToken = context?.callToken;
        const sessionPath = context?.sessionPath;
        log(`download-command invoked | kind=${kind} callToken=${typeof callToken}`);
        let r;
        try {
          r = await callEngine("/command", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind, repo, targetDir, workdir, label, sessionPath }),
          });
        } catch (e) {
          return { content: [{ type: "text", text: `发起失败：${e?.message || e}` }], isError: true };
        }
        if (r?.error || !r?.taskId) {
          return { content: [{ type: "text", text: `发起失败：${r?.error || "引擎未返回 taskId"}` }], isError: true };
        }
        let task = null;
        try {
          if (callToken) {
            const action = kind === "git-clone" ? `克隆 ${repo || ""}` : `安装依赖 ${label || workdir || ""}`;
            task = await ctx.tasks.create({ callToken, label: action, delivery: "next-step" });
            log(`tasks.create OK | ${JSON.stringify(task)}`);
            if (task?.taskId && r?.taskId) {
              setTimeout(() => {
                settleWhenDone(r.taskId, task.taskId, r?.fileName || label || kind, callToken).catch((e) => err(`settle ERR | ${e?.message || e}`));
              }, 200);
            }
          }
        } catch (e) {
          err(`tasks.create ERR | ${e?.message || e}`);
        }
        const text = [
          `已开始${kind === "git-clone" ? "克隆" : "安装"}：${r?.fileName || label || ""}`,
          `任务 ID：${r.taskId}`,
          r?.filePath ? `目标：${r.filePath}` : null,
          task?.taskId ? "完成后会自动通知本会话；也可用 download-wait 查询进度。" : "未接入会话通知（无 callToken）。",
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            card: {
              route: "/card.html",
              title: `下载 ${r?.fileName || label || ""}`.trim(),
              description: String(r?.fileName || label || kind),
              aspectRatio: "8:1",
              cardForm: "flush",
              titlebar: null,
            },
            download: {
              taskId: r.taskId,
              kind: "command",
              cmdType: kind,
              repo: repo || null,
              fileName: r?.fileName || null,
              filePath: r?.filePath || null,
              state: r?.state || "running",
              hostTaskId: task?.taskId || null,
            },
          },
        };
      },
    });
    log("tool registered | download-command");
  } catch (e) { err(`download-command register ERR | ${e?.message || e}`); }

  // ── 给前端用的路由 ──
  // 前端跑在 iframe 里，出网受 CSP 与清单白名单管，不能直接敲 127.0.0.1:4317；
  // 所以经 app 自己的路由转一手：/routes/engine/<path> → 引擎 /<path>。
  try {
    if (ctx.routes && typeof ctx.routes.register === "function") {
      ctx.routes.register((app) => {
        app.all("/engine/*", async (c) => {
          const raw = c.req.path; // /engine/xxx
          const p = raw.replace(/^\/engine/, "") || "/";
          const method = c.req.method;
          const init = { method, timeoutMs: 30000 };
          if (method !== "GET" && method !== "HEAD") {
            init.headers = { "content-type": "application/json" };
            init.body = await c.req.text();
          }
          try {
            const res = await ctx.network.fetch(`http://127.0.0.1:${ENGINE_PORT}${p}`, init);
            const text = await res.text();
            log(`fwd ${method} ${p} -> ${res.status}${text ? " | " + text.slice(0, 160) : ""}`);
            return c.body(text, res.status, { "content-type": "application/json; charset=utf-8" });
          } catch (e) {
            err(`fwd ${method} ${p} ERR | ${e?.message || e}`);
            return c.json({ error: `engine unreachable: ${e?.message || e}` }, 502);
          }
        });
        app.get("/engine-base", (c) => c.json({ ok: true, base: "engine" }));
        app.get("/engine-status", async (c) => {
          const rt = engine ? await ctx.runtime.get(engine.runtimeId).catch((e) => ({ err: String(e?.message || e) })) : null;
          return c.json({ runtime: rt });
        });
      });
      log("routes registered | /engine/*, /engine-base, /engine-status");
    } else {
      log("ctx.routes unavailable");
    }
  } catch (e) {
    err(`routes register ERR | ${e?.message || e}`);
  }

  (async () => {
    try {
      await stopStaleRuntimes();
      await startEngine();
      startWatchdog();
    } catch (e) { err(`engine start ERR | ${e?.message || e}`); }
  })();
}

export default { name: "hana-downloader", apply };
