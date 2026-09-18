// hana-downloader-app/engine/download-probe.js — winget 下载进度旁路探测（2026-09-18）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么需要：winget CLI 在非交互（管道）环境下不输出下载进度（进度条是终端专属），
// 阶段式卡片只能干显示“下载中”。但实测 + 源码（Downloader.cpp 逐块写流）证实：
// winget 会把安装包逐块写进一个固定规律的落盘文件：
//     <TEMP>\WinGet\<PackageId>.<Version>\<InstallerSha256>
// 本模块轮询该目录、对文件求和得到 received；再用下载 URL 的 Content-Length 补 total，
// 从而还原真实百分比与速度（复用任务模型既有的字节进度字段，前端零改动）。
//
// 设计约束（宁可不显示，不可弄坏任务）：
//   - 一切失败静默降级：找不到目录/HEAD 失败 = 该项不更新，任务照常；
//   - 只在任务 running 期间工作，任务终态自动停；
//   - 字节在增长时刷新 task._lastProgressAt（喂停滞监视器），避免长下载被误报“连接停滞”；
//   - bundle（一次安装含多个安装包）场景 total 只按首个 URL 计，百分比可能不准，已知接受。
//
// 已知行为（2026-09-18 实测）：DO 阶段不写此文件（DO 用自己的缓存），
// 因此如果 winget 走 DO 通道下载，文件增长从 WinINet 降级后才开始——本机 DO 通道
// 常态超时降级，影响可忽略；DO 正常的机器上，进度会晚 60 秒左右出现。
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createTunnelAgent } from "./tunnel-agent.js";

const POLL_MS = 1500;
const HEAD_TIMEOUT_MS = 12000;

// TEMP 候选路径：受管进程的 TEMP 被重定向到 <dataDir>\.runtime-tmp（实测），
// 普通进程用自己的 TEMP/TMP；两个都试，找到哪个用哪个。
function tempCandidates(dataDir) {
  const list = [process.env.TEMP, process.env.TMP];
  if (dataDir) list.push(path.join(dataDir, ".runtime-tmp"));
  return list.filter(Boolean);
}

// 在候选 TEMP 下找「本包」的下载目录（<pkgId>.<ver>，取最近修改的一个）。
// 找不到返回 null（下一轮再试）。
function findDownloadDir(pkgId, dataDir) {
  if (!pkgId) return null;
  const prefix = `${String(pkgId).toLowerCase()}.`;
  for (const base of tempCandidates(dataDir)) {
    const root = path.join(base, "WinGet");
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    let best = null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!e.name.toLowerCase().startsWith(prefix)) continue;
      const p = path.join(root, e.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {
        /* 忽略单个条目错误 */
      }
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
    if (best) return best.path;
  }
  return null;
}

// 目录内所有文件大小求和（通常一个安装包；bundle 时多个，求和即累计下载量）。
function dirTotalBytes(dir) {
  let sum = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      sum += fs.statSync(path.join(dir, e.name)).size;
    } catch {
      /* 文件可能正在被移动/删除，跳过 */
    }
  }
  return sum;
}

// 对下载 URL 取 Content-Length（手动跟随重定向；https 可走代理隧道；失败返回 null）。
// 不用全局 fetch 的原因：fetch 不支持自建 CONNECT 隧道代理（Node 无全局 ProxyAgent），
// 而 winget 的下载 URL（GitHub 等）在需要代理的环境下必须经代理才能 HEAD 通。
function fetchContentLength(url, proxyUrl) {
  return new Promise((resolve) => {
    const go = (u, depth) => {
      if (depth > 4) return resolve(null);
      let target;
      try { target = new URL(u); } catch { return resolve(null); }
      const isHttps = target.protocol === "https:";
      const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(target.hostname) || /^127\./.test(target.hostname);
      const mod = isHttps ? https : http;
      const opts = {
        method: "HEAD",
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        headers: { "user-agent": "hana-downloader-probe/1.0" },
        timeout: HEAD_TIMEOUT_MS,
      };
      if (isHttps && proxyUrl && !isLoopback) {
        const agent = createTunnelAgent(proxyUrl);
        if (agent) opts.agent = agent;
      }
      const req = mod.request(opts, (res) => {
        const code = res.statusCode || 0;
        const loc = res.headers.location;
        if (code >= 300 && code < 400 && loc) {
          res.resume();
          let next;
          try { next = new URL(loc, u).toString(); } catch { return resolve(null); }
          return go(next, depth + 1);
        }
        res.resume();
        if (code !== 200) return resolve(null);
        const len = Number(res.headers["content-length"]);
        resolve(Number.isFinite(len) && len > 0 ? len : null);
      });
      req.on("timeout", () => { try { req.destroy(); } catch { /* 已断开 */ } resolve(null); });
      req.on("error", () => resolve(null));
      req.end();
    };
    go(url, 0);
  });
}

/**
 * 启动 winget 下载进度探测。
 * @param {object} task    任务对象（需 cmd.type === "winget-install"；读取 cmd.pkgId / installUrl / state）
 * @param {string} dataDir 引擎数据目录（用于 .runtime-tmp 兜底候选）
 * @param {string} proxyUrl 代理地址（http(s)://…；空串=直连。HEAD 取总大小时用）
 * @returns {() => void}   stop：停止探测（幂等）
 */
export function startWingetProbe(task, dataDir, proxyUrl = "") {
  const noop = () => {};
  if (!task || task.cmd?.type !== "winget-install") return noop;

  let stopped = false;
  let headTried = false;
  let dirPath = null;
  let lastBytes = 0;
  let lastAt = 0;

  const tick = () => {
    if (stopped) return;
    if (task.state !== "running") {
      stop();
      return;
    }

    // 1) URL 到手后取一次 Content-Length（失败静默；只试一次，不反复发请求）
    if (!headTried && typeof task.installUrl === "string" && task.installUrl) {
      headTried = true;
      fetchContentLength(task.installUrl, proxyUrl)
        .then((len) => {
          if (!stopped && len && task.total == null) {
            task.total = len;
            if (task.unit !== "bytes") task.unit = "bytes";
          }
        })
        .catch(noop);
    }

    // 2) 定位本包的下载目录（找到后缓存；目录尚未出现时下轮再试）
    if (!dirPath) dirPath = findDownloadDir(task.cmd?.pkgId, dataDir);
    if (!dirPath) return;

    // 3) 求和 → received / speed；有数据流动时喂停滞监视器
    const bytes = dirTotalBytes(dirPath);
    const now = Date.now();
    if (bytes > 0) {
      if (bytes > lastBytes && lastAt > 0) {
        const inst = Math.round((bytes - lastBytes) / Math.max(0.5, (now - lastAt) / 1000));
        task.speed = task.speed > 0 ? Math.round(task.speed * 0.5 + inst * 0.5) : inst;
        task._lastProgressAt = now;
      }
      task.received = bytes;
      if (task.unit !== "bytes") task.unit = "bytes";
    }
    lastBytes = bytes;
    lastAt = now;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  const timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();
  // 首轮稍后立即触发（不等第一个间隔，也不跟任务创建同拍）
  const kick = setTimeout(tick, 200);
  if (kick.unref) kick.unref();

  return stop;
}
