// lib/tasks.js — 下载任务管理器（插件进程内单例）
// 职责：创建/准备下载任务、流式下载 + 进度统计、限速、取消、状态快照、持久化恢复。
// 不依赖任何第三方库，使用 Node 18+ 全局 fetch。

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

const TASKS_FILE = "tasks.json";
const SPEED_CACHE_FILE = "speed-cache.json";
const SPEED_CACHE_MAX = 50;    // 历史速度缓存条目上限
const SPEED_CACHE_KEEP = 5;    // 每域名保留最近样本数
const MAX_TASKS = 64;
const SPEED_SAMPLE_MS = 700;   // 测速采样间隔
const SPEED_SAMPLES_MAX = 5;   // 滑动窗口样本数（≈3.5s）
const CHUNK_SLEEP_MIN_MS = 1;  // 限速时 chunk 间最小等待

let _instance = null;
const MGR_VER = 21; // 每次修改管理器逻辑 +1：globalThis 单例按版本换新实例，绕开插件加载器的 lib 模块缓存（v21=加 forget 单条删除）
// v0.1.7: 下载核心支持断点续传（Range/If-Range/.part 半成品、206/200/416 分支、SHA-256 校验、失败保留 .part、重启恢复 received=statSync(.part).size）
// v0.1.6: 下载核心支持 HTTP CONNECT 代理（环境变量/config.json proxy/Windows 系统代理），
// 代理优先 + 失败自动降级直连；支持 3xx 与文本重定向（"Redirecting to <url>"，如 npmmirror）。

// 真单例：插件加载器按 import 字符串（./lib vs ../lib）缓存模块，可能产生多个模块实例，
// 用 globalThis 兜底保证所有引用方拿到同一个 TaskManager；版本变化时强制重建。
export function getTaskManager(dataDir) {
  const cur = globalThis.__dlTaskMgr;
  if (cur && cur.__ver === MGR_VER) return cur;
  if (_instance && _instance.__ver === MGR_VER) {
    globalThis.__dlTaskMgr = _instance;
    return _instance;
  }
  _instance = new TaskManager(dataDir);
  _instance.__ver = MGR_VER;
  globalThis.__dlTaskMgr = _instance;
  return _instance;
}

/** 主要供测试/重置 */
export function _resetTaskManager() {
  _instance = null;
}

class TaskManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.downloadDir = path.join(dataDir, "downloads");
    this.tasks = new Map();
    this._finalCb = null;
    this._stallCb = null;
    this._speedCache = null; // 惰性加载
  }

  // ── 历史下载速度缓存（按域名；供 wait auto 模式估算阈值，本地计算不费模型算力）──
  _loadSpeedCache() {
    if (this._speedCache) return this._speedCache;
    try {
      this._speedCache = JSON.parse(fs.readFileSync(path.join(this.dataDir, SPEED_CACHE_FILE), "utf-8"));
    } catch { this._speedCache = {}; }
    return this._speedCache;
  }

  _saveSpeedCache() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, SPEED_CACHE_FILE), JSON.stringify(this._speedCache), "utf-8");
    } catch { /* 缓存写入失败不影响下载 */ }
  }

  recordSpeed(host, speed) {
    if (!host || !Number.isFinite(speed) || speed <= 0) return;
    const cache = this._loadSpeedCache();
    const list = cache[host] || (cache[host] = []);
    list.push({ speed: Math.round(speed), at: Date.now() });
    if (list.length > SPEED_CACHE_KEEP) list.splice(0, list.length - SPEED_CACHE_KEEP);
    // 整体条目数上限：清最老的域名
    const hosts = Object.keys(cache);
    if (hosts.length > SPEED_CACHE_MAX) {
      hosts.sort((a, b) => (cache[a][cache[a].length - 1]?.at || 0) - (cache[b][cache[b].length - 1]?.at || 0));
      for (const h of hosts.slice(0, hosts.length - SPEED_CACHE_MAX)) delete cache[h];
    }
    this._saveSpeedCache();
  }

  getHostSpeed(host) {
    const list = this._loadSpeedCache()[host];
    if (!list || !list.length) return null;
    const avg = list.reduce((a, s) => a + s.speed, 0) / list.length;
    return avg > 0 ? avg : null;
  }

  // v0.6.6 起主逻辑不再订阅 onFinal，终态投递由扩展 dl-nextturn 负责；保留此 API 仅供扩展或第三方接入使用。
  // 注册终态回调（done/failed/canceled），供插件层做 deferred 通知
  onFinal(cb) { this._finalCb = typeof cb === "function" ? cb : null; }

  // 终态一次性等待：终态到达（或已是终态）时立即 resolve。
  // 供 download-wait 实现「取消/完成即时唤醒」，不再等轮询间隔。
  // 返回 { promise, cancel }：cancel 用于 wait 每轮循环退出时清理 waiter，防止无界累积。
  onceFinal(taskId) {
    let wrapped = null;
    let set = null;
    const promise = new Promise((resolve) => {
      const t = this.tasks.get(taskId);
      if (t && (t.state === "done" || t.state === "failed" || t.state === "canceled" || t.state === "interrupted")) { resolve(t); return; }
      if (!this._finalWaiters) this._finalWaiters = new Map();
      set = this._finalWaiters.get(taskId);
      if (!set) { set = new Set(); this._finalWaiters.set(taskId, set); }
      wrapped = (task) => { set.delete(wrapped); resolve(task); };
      set.add(wrapped);
    });
    return {
      promise,
      cancel() {
        if (wrapped && set) { set.delete(wrapped); wrapped = null; }
      },
    };
  }

  _fireFinal(task) {
    // 唤醒挂起的 onceFinal waiter（立即返回，不等轮询）
    try {
      const set = this._finalWaiters && task ? this._finalWaiters.get(task.taskId) : null;
      if (set && set.size) { this._finalWaiters.delete(task.taskId); for (const fn of [...set]) { try { fn(task); } catch { /* 忽略单个 waiter 异常 */ } } }
    } catch { /* 唤醒异常不影响通知 */ }
    if (!this._finalCb || !task) return;
    const s = task.state;
    if (s === "done" || s === "failed" || s === "canceled" || s === "interrupted") {
      try { this._finalCb(task); } catch { /* 通知失败不影响下载 */ }
    }
  }

  // 注册停滞回调：无新数据超过 stallTimeoutMs 时触发一次（进度恢复后可再次触发）。
  // v0.8 支持多监听器：index.js 的 onStall 负责 deferred 占位托管（防丢兜底），
  // dl-nextturn 的 onStall 负责双通道投递（unsettled→steer 同步 / settled→deferred 异步）。
  // 返回退订函数：dev 槽重载/插件卸载时必须退订，否则同一 manager 单例上的
  // 旧回调残留 → 一个 stall 事件被多个 delivery 实例各投一次（双投 bug，见 2026-09-01 实测）。
  onStall(cb) {
    if (typeof cb !== "function") return () => {};
    if (!this._stallCbs) this._stallCbs = [];
    this._stallCbs.push(cb);
    return () => {
      const i = this._stallCbs ? this._stallCbs.indexOf(cb) : -1;
      if (i >= 0) this._stallCbs.splice(i, 1);
    };
  }

  _fireStall(task) {
    if (!task) return;
    const cbs = this._stallCbs || [];
    for (const cb of cbs) {
      try {
        const r = cb(task);
        if (r && typeof r.catch === "function") r.catch(() => {}); // 异步回调异常也不影响下载
      } catch { /* 通知失败不影响下载 */ }
    }
  }

  // ── 创建并立即启动任务 ──
  create({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind = "url", cmd = null, unit = "bytes", filePath, resumable = true, expectedSha256 = null }) {
    const task = this._createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind, cmd, unit, filePath, resumable, expectedSha256 });
    this._run(task); // 后台执行，不等待
    return task;
  }

  // ── 准备任务（pending）：先占位，延迟后自动启动，保证卡片从 0% 开始渲染 ──
  prepare({ url, fileName, saveDir, speedLimit, startDelayMs, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind = "url", cmd = null, unit = "bytes", filePath, resumable = true, expectedSha256 = null }) {
    const task = this._createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, state: "pending", stallTimeoutMs, sessionPath, kind, cmd, unit, filePath, resumable, expectedSha256 });
    // 严格解析延迟：只有有限正数才走延迟路径，其余（0/undefined/非法）立即启动
    const raw = Number(startDelayMs);
    const delay = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (delay > 0) {
      task.pendingTimer = setTimeout(() => {
        this.startPending(task.taskId);
      }, delay);
      if (task.pendingTimer?.unref) task.pendingTimer.unref();
    } else {
      // 立即启动；若同步启动失败，标记失败，避免任务永久卡在 pending（无 timer、无 controller）
      try {
        this.startPending(task.taskId);
      } catch (e) {
        task.state = "failed";
        task.error = friendlyError(e);
        task.finishedAt = Date.now();
        this._persist();
        // 不在 catch 调 _fireFinal：交给外层 _run() 的 finally 块统一触发（避免错误路径 fireFinal
        // 覆盖 _run 后续成功路径——之前 fireFinal 误触发了两次，injectForSession 第一次消费的
        // entry.content 是错误路径的 status="failed"，第二次成功路径因 alreadyHandled skip，
        // 导致 agent 看到 status="failed" 但实际 task 成功 + 文件落盘）。
      }
    }
    return task;
  }

  // 查询任务（供 deferred 延迟复查等）：返回任务对象引用（只读使用）
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  // 标记任务已投递成功（持久化到 tasks.json，host 重启后 onload 兜底可读到、不再二次 resolve）。
  // dl-nextturn followUp/同步投递成功后调用：置 t.delivered=true + 落盘。
  markDelivered(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    t.delivered = true;
    this._persist();
    return true;
  }

  // 启动 pending 任务
  startPending(taskId) {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== "pending") return { ok: false, error: "任务不存在或不在准备中" };
    t.state = "running";
    t.startedAt = Date.now();
    t.controller = new AbortController();
    this._persist();
    this._run(t);
    return { ok: true };
  }

  _createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, state, stallTimeoutMs = 30000, sessionPath = null, kind = "url", cmd = null, unit = "bytes", filePath: explicitPath = null, resumable = true, expectedSha256 = null }) {
    if (this.tasks.size >= MAX_TASKS) {
      // 清理最老的已结束任务
      for (const [id, t] of this.tasks) {
        if (t.state !== "running" && t.state !== "pending") { this.tasks.delete(id); if (this.tasks.size < MAX_TASKS) break; }
      }
      if (this.tasks.size >= MAX_TASKS) throw new Error("下载任务过多，请稍后再试");
    }

    const dir = saveDir || this.downloadDir;
    fs.mkdirSync(dir, { recursive: true });

    const rawName = (fileName && String(fileName).trim()) || fileNameFromUrl(url);
    const name = sanitizeFileName(rawName);
    const filePath = explicitPath || uniquePath(path.join(dir, name));
    const partPath = filePath + ".part";

    const taskId = randomUUID().slice(0, 8) + "-" + Date.now().toString(36);
    const task = {
      taskId,
      url,
      fileName: path.basename(filePath),
      filePath,
      saveDir: dir,
      state: state || "running",
      total: null,
      received: 0,
      speed: 0,
      startedAt: state === "pending" ? null : Date.now(),
      finishedAt: null,
      elapsed: 0,
      error: null,
      cancelRequested: false,
      sessionId: sessionId || null,
      sessionRef: sessionRef || null,
      consumedByWait: false, // wait 返回终态时置真：标识 Agent 已拿到结果（投递时供识别冗余）
      waitActive: 0, // wait 正在守望的计数：onFinal 时 >0 说明 Agent 即将通过 wait 拿到结果
      waitBudgetExhausted: false, // 守望预算已用尽：后续 wait 对该任务直接快照，禁止二次守望（杜绝回查循环）
      speedLimit: Number.isFinite(speedLimit) && speedLimit > 0 ? speedLimit : 0,
      controller: state === "pending" ? null : new AbortController(),
      pendingTimer: null,
      _samples: [],
      stalledAt: null,
      stallNotified: false,
      _lastProgressAt: Date.now(),
      stallTimeoutMs: Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0 ? stallTimeoutMs : 30000,
      sessionPath: sessionPath || null,
      kind,
      cmd,
      unit,
      stage: null,
      child: null,
      partPath,
      etag: null,
      lastModified: null,
      acceptRanges: false,
      expectedSha256: expectedSha256 || null,
      resumable: kind === "command" ? false : (resumable !== false),
      _lastPersistAt: 0,
    };
    this.tasks.set(taskId, task);
    this._persist();
    return task;
  }

  // ── 后台下载循环 ──
  _startStallMonitor(task) {
    // 人为限速（speedLimit>0）的任务不报停滞：throttle 主动 pause 流的间歇不是网络异常，
    // 误判会在低速率下必性触发假 stall 通知（v0.13.1，9-08 实测 250B/s 任务 1s 即报）。
    if (task.speedLimit > 0) return;
    task._stallTimer = setInterval(() => {
      try {
        if (task.state !== "running") return;
        if (Date.now() - task._lastProgressAt >= task.stallTimeoutMs) {
          if (task.stalledAt == null) {
            task.stalledAt = Date.now();
            this._persist(); // 停滞触发即刷盘，避免排查时只能靠内存态
          }
          if (!task.stallNotified) {
            task.stallNotified = true;
            this._fireStall(task);
          }
        } else if (task.stalledAt != null) {
          // 进度恢复：解除停滞，允许再次停滞再通知
          task.stalledAt = null;
          task.stallNotified = false;
        }
      } catch { /* 停滞判定异常不影响下载 */ }
    }, Math.max(100, task.stallTimeoutMs || 30000));
    if (task._stallTimer?.unref) task._stallTimer.unref();
  }

  _stopStallMonitor(task) {
    if (task._stallTimer) { clearInterval(task._stallTimer); task._stallTimer = null; }
  }

  async _run(task) {
    if (task.kind === "command") { await this._runCommand(task); return; }

    let ws = null;
    let wroteAnyChunk = false;
    const hash = task.expectedSha256 ? createHash("sha256") : null;
    this._startStallMonitor(task);
    const controller = task.controller;
    let req = null;
    // 取消：destroy 底层请求（触发 error → catch 按 canceled 处理）
    const abortListener = () => { try { if (req) req.destroy(new AbortError("canceled by user")); } catch { /* 忽略 */ } };
    controller.signal.addEventListener("abort", abortListener);
    try {
      const targetUrl = new URL(task.url);
      // 本地回环目标永不走代理：回环流量经代理隧道既慢又不稳定（实测被中途掐断）
      const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(targetUrl.hostname)
        || /^127\./.test(targetUrl.hostname);
      const proxy = isLoopback ? "" : resolveProxy(this.dataDir);
      const mod = targetUrl.protocol === "https:" ? https : http;

      // 请求 + 重定向（3xx 与文本重定向，如 npmmirror 的 "Redirecting to ..."）
      // 代理策略：优先走代理，若代理失败（网络错/HTTP 4xx/5xx）自动降级直连重试一次
      let target = task.url;
      let res = null;
      let preBuffer = null; // 文本重定向检测时缓冲的小 body（非重定向时写回流）
      let lastReqErr = null;
      let startOffset = 0; // 断点续传起始偏移（每轮请求按 received 重新计算）
      const proxyAttempts = proxy ? [proxy, null] : [null];
      for (let pi = 0; pi < proxyAttempts.length && !res; pi++) {
        const useProxy = proxyAttempts[pi];
        const useAgent = useProxy ? createTunnelAgent(useProxy) : undefined;
        let current = target;
        let redirects = 0;
        try {
          while (redirects < 5) {
            startOffset = (task.resumable !== false ? (task.received || 0) : 0);
            const headers = {
              "User-Agent": "HanaAgent/1.0 (hana-downloader)",
              "Accept": "*/*",
              "Accept-Encoding": "identity", // 防 CDN 压缩导致字节偏移错位
              "Range": startOffset > 0 ? `bytes=${startOffset}-` : undefined,
              "If-Range": (task.etag || task.lastModified) || undefined,
            };
            if (headers["Range"] === undefined) delete headers["Range"];
            if (headers["If-Range"] === undefined) delete headers["If-Range"];
            res = await new Promise((resolve, reject) => {
              const r = mod.request(current, {
                agent: useAgent,
                headers,
              }, (resp) => resolve(resp));
              req = r;
              r.on("error", reject);
              r.end();
            });
            const sc = res.statusCode || 0;
            // 标准 3xx 重定向
            if ((sc === 301 || sc === 302 || sc === 303 || sc === 307 || sc === 308) && res.headers.location) {
              res.resume();
              current = new URL(res.headers.location, current).toString();
              redirects++;
              continue;
            }
            // 416：服务器不支持 Range（或 If-Range 校验失败），删 .part 后从头下载
            if (sc === 416 && startOffset > 0) {
              res.resume();
              try { if (fs.existsSync(task.partPath)) fs.unlinkSync(task.partPath); } catch { /* 忽略清理失败 */ }
              task.received = 0;
              continue;
            }
            // 4xx/5xx：代理路径下视为可能被风控，降级直连重试；直连路径直接失败
            if (sc >= 400) {
              res.resume();
              if (useProxy) { res = null; break; }
              throw new Error(`HTTP ${sc} ${res.statusMessage || ""}`);
            }
            // 文本重定向（如 npmmirror 返回 200 + "Redirecting to <url>"）
            const small = await readSmallBody(res);
            if (small) {
              const text = small.toString("utf8");
              const m = /^Redirecting to\s+(\S+)/.exec(text.trim());
              if (m) {
                current = new URL(m[1], current).toString();
                redirects++;
                continue;
              }
              preBuffer = small; // 真小文件：缓冲数据留待写回流
            }
            break; // 正常响应
          }
          if (!res) continue; // 降级直连
        } catch (e) {
          lastReqErr = e;
          res = null;
          // 代理失败降级直连；直连也失败则保留最后错误
        }
      }
      if (!res) throw (lastReqErr || new Error("HTTP 请求失败"));

      if (!res.statusCode || res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode} ${res.statusMessage || ""}`);

      // 记录响应元数据（供断点续传 If-Range 与重启恢复）
      task.etag = res.headers["etag"] || null;
      task.lastModified = res.headers["last-modified"] || null;
      task.acceptRanges = (res.headers["accept-ranges"] || "none") !== "none";

      // 响应分支：206 续传 / 200 从头（416 已在请求循环内处理）
      if (res.statusCode === 206) {
        const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(res.headers["content-range"] || "");
        if (!m) throw new Error("HTTP 206 响应缺少有效的 Content-Range 头");
        const crStart = Number(m[1]);
        if (crStart !== startOffset) throw new Error(`断点续传偏移不符：服务器返回 ${crStart}，期望 ${startOffset}`);
        const crTotal = m[3] === "*" ? null : Number(m[3]);
        if (crTotal != null && Number.isFinite(crTotal) && crTotal > 0) {
          task.total = crTotal;
        } else {
          // Content-Range 无总长度：用剩余长度 + 起始偏移还原全量大小
          const cl = parseInt(res.headers["content-length"] || "", 10);
          task.total = Number.isFinite(cl) && cl > 0 ? cl + startOffset : null;
        }
        ws = fs.createWriteStream(task.partPath, { start: startOffset });
      } else {
        // 200：Range 被忽略（或新任务无 Range），从头下载
        if (!fs.existsSync(task.partPath)) fs.writeFileSync(task.partPath, Buffer.alloc(0));
        fs.truncateSync(task.partPath, 0);
        startOffset = 0;
        task.received = 0;
        const cl = parseInt(res.headers["content-length"] || "", 10);
        task.total = Number.isFinite(cl) && cl > 0 ? cl : null;
        ws = fs.createWriteStream(task.partPath, { flags: "w" });
      }

      // 流式接收 + 进度采样 + 限速（与旧 fetch 版逻辑一致）
      await new Promise((resolve, reject) => {
        let lastTick = Date.now();
        let lastBytes = 0;
        let chunkStart = Date.now();
        const speedSample = () => {
          const now = Date.now();
          if (now - lastTick >= SPEED_SAMPLE_MS) {
            const inst = (task.received - lastBytes) / ((now - lastTick) / 1000);
            task._samples.push(inst);
            if (task._samples.length > SPEED_SAMPLES_MAX) task._samples.shift();
            task.speed = task._samples.reduce((a, b) => a + b, 0) / task._samples.length;
            lastTick = now;
            lastBytes = task.received;
          }
        };
        const processChunk = (chunk) => {
          if (task.cancelRequested) { try { if (req) req.destroy(); } catch { /* 忽略 */ } return; }
          wroteAnyChunk = true;
          ws.write(chunk);
          task.received += chunk.length;
          if (hash) hash.update(chunk); // SHA-256 流式累计
          task._lastProgressAt = Date.now();
          if (task.stalledAt != null) {
            task.stalledAt = null;
            task.stallNotified = false;
          }
          // 已知总大小且已收满：提前收尾（与服务端关闭边界一致）
          if (task.total != null && task.received >= task.total) {
            try { if (req) req.destroy(); } catch { /* 忽略 */ }
            return;
          }
          // 进度节流落盘：每 1.5s 持久化一次 received（作为断点续传恢复点）
          if (Date.now() - (task._lastPersistAt || 0) >= 1500) {
            task._lastPersistAt = Date.now();
            this._persist();
          }
          // 限速：暂停流 + 定时恢复
          if (task.speedLimit > 0) {
            const want = (chunk.length / task.speedLimit) * 1000;
            const used = Date.now() - chunkStart;
            if (want > used) {
              res.pause();
              setTimeout(() => { chunkStart = Date.now(); res.resume(); }, want - used + CHUNK_SLEEP_MIN_MS);
            } else { chunkStart = Date.now(); }
          }
          speedSample();
        };
        if (preBuffer && preBuffer.length) processChunk(preBuffer);
        if (preBuffer) {
          // 小文件已由 readSmallBody 完整缓冲（读到 end），直接收尾
          ws.end((err) => (err ? reject(err) : resolve()));
        } else {
          res.on("data", processChunk);
          res.on("end", () => {
            ws.end((err) => (err ? reject(err) : resolve()));
          });
          res.on("error", reject);
          req.on("error", reject);
        }
      });

      // 流正常结束即下载完整：总大小未知（chunked 无 Content-Length）或声明值与实际不符
      // （如 Content-Encoding 自动解压时 received 为解压后字节）时，以实际接收为准兜底。
      // received < total 不拉低（若服务器提前断开会走 error/abort 分支）。
      if (task.received > 0 && (task.total == null || task.received > task.total)) task.total = task.received;

      // 终态收尾：SHA-256 校验（若配置 expectedSha256）→ 通过后将 .part 改名为正式文件
      if (task.expectedSha256 && hash) {
        const digest = hash.digest("hex");
        if (digest !== task.expectedSha256) {
          task.state = "failed";
          task.error = `SHA-256 校验失败：期望 ${task.expectedSha256}，实际 ${digest}`;
        } else {
          fs.renameSync(task.partPath, task.filePath);
          task.state = "done";
        }
      } else {
        fs.renameSync(task.partPath, task.filePath);
        task.state = "done";
      }
      task.finishedAt = Date.now();
    } catch (e) {
      const aborted = task.cancelRequested || e?.name === "AbortError" || controller.signal.aborted;
      // 注意：chunked（total=null）半途断连时 complete 恒为 false，会走下方删除分支——
      // body 无长度声明无法验证完整性，failed + 删半成品是保守正确。勿放宽此判定为
      // (total==null || received>=total)：会把残缺文件误判为完成保下来，比删文件更糟。
      // 续传场景 received 从旧偏移起步，额外要求本次写过 chunk，否则请求阶段失败会误判 complete。
      const complete = !aborted && wroteAnyChunk && task.total != null && task.received >= task.total && task.received > 0;
      if (complete) {
        try {
          if (ws) await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
        } catch { /* 落盘失败则按失败处理 */ }
        // 收满路径同样做 SHA-256 校验：不匹配则不得交付
        if (task.expectedSha256 && hash) {
          const digest = hash.digest("hex");
          if (digest !== task.expectedSha256) {
            task.state = "failed";
            task.error = `SHA-256 校验失败：期望 ${task.expectedSha256}，实际 ${digest}`;
            task.finishedAt = Date.now();
            return; // 已标终态，交给 finally 收尾
          }
        }
        if (fs.existsSync(task.partPath)) {
          try {
            fs.renameSync(task.partPath, task.filePath);
            task.state = "done";
            task.error = null;
          } catch (re) {
            task.state = "failed";
            task.error = friendlyError(e) + "；落盘改名失败：" + friendlyError(re);
          }
        } else {
          task.state = "failed";
          task.error = friendlyError(e);
        }
      } else {
        if (ws) { try { ws.destroy(); } catch { /* 忽略 */ } }
        if (aborted) {
          // canceled：保留 .part 半成品（可续传）
          task.state = "canceled";
          task.error = "已取消";
        } else if (!wroteAnyChunk) {
          // failed 且未写过任何 chunk：仅删空 .part（避免空文件）；非空 .part 保留供续传
          try {
            const st = fs.statSync(task.partPath);
            if (st && st.size === 0) fs.unlinkSync(task.partPath);
          } catch { /* .part 不存在或不可读：跳过清理 */ }
          task.state = "failed";
          task.error = friendlyError(e);
        } else {
          // failed 且写过 chunk：保留 .part，状态置 interrupted（可续传）
          task.state = "interrupted";
          task.error = friendlyError(e);
        }
      }
      task.finishedAt = Date.now();
    } finally {
      try { controller.signal.removeEventListener("abort", abortListener); } catch { /* 忽略 */ }
      this._stopStallMonitor(task);
      task.elapsed = (task.finishedAt || Date.now()) - (task.startedAt || Date.now());
      // 记录历史速度（按域名），供 wait auto 模式估算阈值
      if (task.total && task.total > 0 && task.elapsed > 0) {
        const host = hostOf(task.url);
        const avg = (task.received / task.elapsed) * 1000;
        if (host) this.recordSpeed(host, avg);
      }
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
    }
  }

  // ── 命令型任务：git clone / pnpm install ──
  async _runCommand(task) {
    const { parseGitLine, createPnpmParser } = await import("./progress-parsers.js");
    const parser = task.cmd.type === "git-clone" ? parseGitLine : createPnpmParser();
    // Windows 下 npm 全局装的 pnpm 是 .cmd shim，裸 spawn(pnpm) shell:false 无法执行（EINVAL）；
    // 解析真实 JS 入口用 node 运行（数组传参，无 shell，无注入面）；git 是真实 exe 原样 spawn
    const resolved = resolveCommandBin(task.cmd);
    const cmdBin = resolved.bin;
    const fullArgs = resolved.args;

    this._startStallMonitor(task);
    task._cmdBuf = ""; // 输出缓冲（截断 4KB 供错误摘要）

    let child;
    try {
      child = spawn(cmdBin, fullArgs, {
        cwd: task.cmd.workdir || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this._stopStallMonitor(task);
      task.state = "failed";
      task.error = "命令无法启动：" + (err?.message || String(err));
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
      return;
    }
    task.child = child;

    const feed = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      task._lastProgressAt = Date.now(); // 喂停滞监视器
      task._cmdBuf = appendBuf(task._cmdBuf, text); // 缓冲截断
      const lines = text.split(/[\r\n]+/); // \r 重绘（git/pnpm 进度刷新）也拆成独立行，parser 每行拿最新值
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const r = parser(line);
        if (!r) continue;
        if (r.pct != null) {
          task.stage = r.stage;
          if (r.unit) task.unit = r.unit;
          if (r.received != null && r.total != null) {
            task.received = r.received;
            task.total = r.total;
          } else if (r.pct != null && task.total) {
            task.received = Math.round(task.total * r.pct / 100);
          }
        } else if (r.stage) {
          task.stage = r.stage;
        }
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);

    child.on("error", (e) => { task._spawnError = e; });

    child.on("close", (code) => {
      this._stopStallMonitor(task);
      const aborted = task.cancelRequested;
      if (aborted) {
        task.state = "canceled";
        task.error = "已取消";
        // git clone 半成品目录删；node_modules 半成品保留
        if (task.cmd.type === "git-clone" && task.filePath && fs.existsSync(task.filePath)) {
          try { fs.rmSync(task.filePath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
        }
      } else if (code === 0) {
        task.state = "done";
        if (task.received > 0 && (task.total == null || task.received > task.total)) task.total = task.received;
      } else {
        task.state = "failed";
        const tail = task._cmdBuf ? task._cmdBuf.slice(-4000) : "";
        task.error = (task._spawnError ? task._spawnError.message + "；" : "") + `命令退出码 ${code}` + (tail ? `：${tail.split(/\n/).slice(-3).join("\n")}` : "");
      }
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
    });
  }

  // ── 取消 ──
  // source: "user"=用户在卡片上手动取消 | "agent"=Agent 调工具取消（默认）| "system"=系统自动
  cancel(taskId, source = "agent") {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "任务不存在" };
    if (t.state === "pending") {
      if (t.pendingTimer) clearTimeout(t.pendingTimer);
      t.state = "canceled";
      t.canceledBy = source;
      t.error = "已取消";
      t.finishedAt = Date.now();
      this._persist();
      this._fireFinal(t);
      return { ok: true };
    }
    if (t.state !== "running") return { ok: false, error: "任务已结束" };
    t.canceledBy = source;
    t.cancelRequested = true;
    if (t.kind === "command" && t.child && t.child.pid) {
      // Windows 杀进程树；非 Windows 信号
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/pid", String(t.child.pid), "/T", "/F"], { windowsHide: true });
        } catch { try { t.child.kill(); } catch { /* 忽略 */ } }
      } else {
        try { process.kill(-t.child.pid, "SIGTERM"); } catch { try { t.child.kill(); } catch { /* 忽略 */ } }
      }
      return { ok: true };
    }
    t.controller?.abort();
    return { ok: true };
  }

  // ── 状态快照（供 route 返回给卡片）──
  snapshot(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    const percent = t.total ? Math.min(100, (t.received / t.total) * 100) : null;
    return {
      taskId: t.taskId,
      url: t.url,
      fileName: t.fileName,
      filePath: t.filePath,
      state: t.state,
      canceledBy: t.canceledBy || null,
      stalled: t.stalledAt != null,
      stalledAt: t.stalledAt,
      total: t.total,
      received: t.received,
      speed: Math.round(t.speed),
      percent: percent == null ? null : Math.round(percent * 10) / 10,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      elapsed: t.elapsed,
      error: t.error,
      kind: t.kind || "url",
      cmd: t.cmd || null,
      unit: t.unit || "bytes",
      stage: t.stage || null,
      sessionId: t.sessionId || null,
      sessionPath: t.sessionPath || null,
      consumedByWait: t.consumedByWait === true,
      deferredRegistered: t.deferredRegistered === true,
      waitActive: t.waitActive || 0,
      waitBudgetExhausted: t.waitBudgetExhausted === true,
      saveDir: t.saveDir || null,
      speedLimit: t.speedLimit || 0,
    };
  }

  // wait 拿到终态后调用：标记 Agent 已消费结果（deferred 投递时 result.consumedByWait=true）。
  // 同时取消终态投递的延迟复查定时器（v0.5.7）：Agent 已拿到终态，投递不再需要，立即止血。
  markConsumedByWait(taskId) {
    const t = this.tasks.get(taskId);
    if (t && !t.consumedByWait) {
      t.consumedByWait = true;
      if (t._resolveTimer) { try { clearTimeout(t._resolveTimer); } catch { /* 忽略 */ } t._resolveTimer = null; }
      this._persist();
    }
  }

  // wait 进入/退出守望的计数：onFinal 判断 Agent 是否即将通过 wait 拿到结果（时序无关）
  markWaitActive(taskId) {
    const t = this.tasks.get(taskId);
    if (t) t.waitActive = (t.waitActive || 0) + 1;
  }

  markWaitInactive(taskId) {
    const t = this.tasks.get(taskId);
    if (t && t.waitActive > 0) t.waitActive -= 1;
  }

  // 守望预算到点（未终态）后调用：标记该任务禁止二次守望，后续 wait 直接快照
  markWaitBudgetExhausted(taskId) {
    const t = this.tasks.get(taskId);
    if (t && !t.waitBudgetExhausted) {
      t.waitBudgetExhausted = true;
      this._persist();
    }
  }

  // ── 全部任务快照（跨会话下载管理器用）：在途优先，终态按结束时间倒序 ──
  list() {
    const all = [...this.tasks.values()];
    const active = all.filter((t) => t.state === "running" || t.state === "pending");
    const final = all.filter((t) => t.state !== "running" && t.state !== "pending")
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    const ordered = [...active, ...final];
    return ordered.map((t) => this.snapshot(t.taskId)).filter(Boolean);
  }

  // ── 清空分类记录（v0.8.9：仅移除任务记录，不删磁盘文件）──
  // states: 要清空的任务状态集合。只动终态记录；在途（running/pending）不被清空，防幽灵下载。
  // 返回移除的任务 id 列表（供前端刷新计数/日志）。
  clearByStates(states) {
    const set = states && Array.isArray(states) ? new Set(states) : null;
    if (!set || set.size === 0) return { ok: true, removed: [] };
    const removed = [];
    for (const [id, t] of this.tasks) {
      if (t.state === "running" || t.state === "pending") continue; // 在途不动
      if (set.has(t.state)) {
        this.tasks.delete(id);
        removed.push(id);
      }
    }
    this._persist();
    return { ok: true, removed };
  }

  // ── 删除单条记录（v0.90.3：管理器行内菜单「删除记录 / 删除记录及文件」）──
  // opts.deleteFile = true 时连同磁盘产物一起删：
  //   - url 任务删 filePath 与残留的 .part
  //   - git-clone 任务删 targetDir（本次克隆出来的目录树）
  //   - pnpm-install 任务不删任何东西（filePath 就是用户的工作目录，误删不可逆）
  // 在途任务（running/pending）拒绝删除，必须先取消。
  forget(taskId, opts = {}) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "任务不存在" };
    if (t.state === "running" || t.state === "pending") {
      return { ok: false, error: "任务仍在进行中，请先取消再删除" };
    }
    const wantFile = !!opts.deleteFile;
    let fileDeleted = false;
    let fileSkipped = null;
    let fileError = null;
    if (wantFile) {
      if (t.kind === "command") {
        const dir = t.cmd && t.cmd.targetDir ? t.cmd.targetDir : null;
        if (t.cmd && t.cmd.type === "git-clone" && dir) {
          try {
            if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); fileDeleted = true; }
          } catch (e) { fileError = String(e?.message || e); }
        } else {
          fileSkipped = "该任务为依赖安装，只删除记录，不删除工作目录";
        }
      } else {
        const targets = [t.filePath, t.partPath || (t.filePath ? t.filePath + ".part" : null)].filter(Boolean);
        for (const p of targets) {
          try {
            if (fs.existsSync(p)) { fs.unlinkSync(p); if (p === t.filePath) fileDeleted = true; }
          } catch (e) { fileError = String(e?.message || e); }
        }
        if (!fileDeleted && !fileError) fileSkipped = "磁盘上没有找到对应的文件";
      }
    }
    this.tasks.delete(taskId);
    this._persist();
    return { ok: true, taskId, fileDeleted, fileSkipped, fileError };
  }

  // ── 全部取消在途（v0.8.9：管理器“全部取消”按钮）──
  // 取消所有 running/pending，归入 canceled。返回取消的任务 id 列表。
  cancelAll(source = "user") {
    const ids = [];
    for (const [id, t] of this.tasks) {
      if (t.state === "running" || t.state === "pending") {
        try { this.cancel(id, source); } catch (e) { /* 单个失败不阻塞 */ }
        ids.push(id);
      }
    }
    return { ok: true, canceled: ids };
  }

  // ── 重启恢复：running → interrupted、pending → interrupted（定时器丢失），删除半成品 ──
  restore() {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(this.dataDir, TASKS_FILE), "utf-8"));
    } catch { return; }
    if (!meta || !Array.isArray(meta.tasks)) return;
    const now = Date.now();
    for (const m of meta.tasks) {
      const t = this.tasks.get(m.taskId);
      if (t) continue; // 内存中已有（create/prepare 后立即持久化过）
      if (m.state === "running" || m.state === "pending") {
        const isCmd = m.kind === "command" && m.cmd?.type;
        if (isCmd) {
          // 命令型：git-clone 中断删半成品目录；pnpm-install 保留 node_modules 半成品
          if (m.cmd.type === "git-clone" && m.filePath && fs.existsSync(m.filePath)) {
            try { fs.rmSync(m.filePath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
          }
        } else {
          try { if (m.filePath && fs.existsSync(m.filePath)) fs.unlinkSync(m.filePath); } catch { }
        }
        // URL 任务：保留 .part 半成品（不再删除），received 取 .part 实际大小作为续传恢复点
        const partPath = m.partPath || (m.filePath ? m.filePath + ".part" : null);
        let received = m.received || 0;
        if (!isCmd && partPath && fs.existsSync(partPath)) {
          try { received = fs.statSync(partPath).size; } catch { /* statSync 失败则保留 m.received */ }
        }
        this.tasks.set(m.taskId, {
          taskId: m.taskId, url: m.url || "", fileName: m.fileName || "",
          filePath: m.filePath || "", saveDir: m.saveDir || this.downloadDir,
          state: "interrupted", total: m.total || null, received,
          speed: 0, startedAt: m.startedAt || now, finishedAt: now, elapsed: 0,
          error: isCmd ? "命令被中断（应用重启），请重新执行" : "下载被中断（应用重启），请重新发起下载",
          cancelRequested: false, speedLimit: m.speedLimit || 0,
          sessionId: m.sessionId || null, sessionPath: m.sessionPath || null, sessionRef: null, controller: null, pendingTimer: null, _samples: [],
          consumedByWait: m.consumedByWait === true, deferredRegistered: m.deferredRegistered === true,
          delivered: m.delivered === true,
          stalledAt: m.stalledAt || null, stallNotified: false, _lastProgressAt: now,
          kind: m.kind || "url", cmd: m.cmd || null, unit: m.unit || "bytes", child: null, stage: null,
          partPath: partPath || "",
          etag: m.etag || null,
          lastModified: m.lastModified || null,
          acceptRanges: m.acceptRanges === true,
          expectedSha256: m.expectedSha256 || null,
          resumable: isCmd ? false : (m.resumable !== false),
        });
      } else {
        // 已完成/失败/取消的旧任务：仅保留 1 天内，用于卡片回放
        const age = now - (m.finishedAt || m.startedAt || 0);
        if (age < 24 * 3600 * 1000) {
          // 历史 done 任务若 total 缺失（chunked 下载时代遗留数据）：用 received 兜底，回放卡片进度/大小正确
          const hisTotal = (m.state === "done" && m.total == null && m.received > 0) ? m.received : (m.total || null);
          this.tasks.set(m.taskId, {
            taskId: m.taskId, url: m.url || "", fileName: m.fileName || "",
            filePath: m.filePath || "", saveDir: m.saveDir || this.downloadDir,
            state: m.state || "interrupted", total: hisTotal, received: m.received || 0,
            speed: 0, startedAt: m.startedAt || now, finishedAt: m.finishedAt || now,
            elapsed: m.elapsed || 0, error: m.error || null, cancelRequested: false, speedLimit: m.speedLimit || 0,
            sessionId: m.sessionId || null, sessionPath: m.sessionPath || null, sessionRef: null, controller: null, pendingTimer: null, _samples: [],
            consumedByWait: m.consumedByWait === true, deferredRegistered: m.deferredRegistered === true,
            delivered: m.delivered === true,
            stalledAt: m.stalledAt || null, stallNotified: false, _lastProgressAt: now,
            kind: m.kind || "url", cmd: m.cmd || null, unit: m.unit || "bytes", child: null, stage: null,
            partPath: m.partPath || (m.filePath ? m.filePath + ".part" : null),
            etag: m.etag || null,
            lastModified: m.lastModified || null,
            acceptRanges: m.acceptRanges === true,
            expectedSha256: m.expectedSha256 || null,
            resumable: m.kind === "command" ? false : (m.resumable !== false),
          });
        }
      }
    }
  }

  // ── 持久化（仅状态转换时调用，进度不落盘；终态任务只保留最近 100 条，防文件无限膨胀）──
  _persist() {
    try {
      const KEEP_FINAL = 100;
      const finalList = [];
      for (const t of this.tasks.values()) {
        if (t.state === "running" || t.state === "pending") continue;
        finalList.push(t);
      }
      // 终态按结束时间倒序，保留最近 KEEP_FINAL 条；超出部分从内存删除（防无限增长）
      finalList.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      const overflow = finalList.slice(KEEP_FINAL);
      for (const t of overflow) this.tasks.delete(t.taskId);

      const meta = {
        version: 3,
        updatedAt: Date.now(),
        tasks: [...this.tasks.values()].map((t) => ({
          taskId: t.taskId, url: t.url, fileName: t.fileName, filePath: t.filePath,
          saveDir: t.saveDir, state: t.state, total: t.total, received: t.received,
          speedLimit: t.speedLimit || 0,
          startedAt: t.startedAt, finishedAt: t.finishedAt, elapsed: t.elapsed,
          error: t.error,
          canceledBy: t.canceledBy || null,
          kind: t.kind || "url",
          cmd: t.cmd || null,
          unit: t.unit || "bytes",
          stalledAt: t.stalledAt || null,
          sessionId: t.sessionId || null,
          sessionPath: t.sessionPath || null,
          consumedByWait: t.consumedByWait === true,
          deferredRegistered: t.deferredRegistered === true,
          delivered: t.delivered === true,
          etag: t.etag || null,
          lastModified: t.lastModified || null,
          partPath: t.partPath || null,
          acceptRanges: t.acceptRanges === true,
          expectedSha256: t.expectedSha256 || null,
          resumable: t.resumable !== false,
        })),
      };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, TASKS_FILE), JSON.stringify(meta), "utf-8");
    } catch { /* 持久化失败不阻塞下载 */ }
  }
}

// ── 辅助函数 ──

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

// 命令输出缓冲：追加文本并截断到 4KB，供失败时错误摘要（最后几行）
function appendBuf(buf, text) {
  const next = buf + text;
  if (next.length <= 4096) return next;
  return next.slice(-4096);
}

// 命令可执行入口解析（Windows 兼容）：
// - git-clone：git 是真实 exe，直接 spawn，数组传参
// - pnpm-install：npm 全局装的 pnpm 是 .cmd shim，shell:false 的 spawn 执行不了（EINVAL）；
//   解析到真实 JS 入口（pnpm/bin/pnpm.mjs|cjs）用当前 node 运行，保持无 shell、无注入面
function resolveCommandBin(cmd) {
  const args = cmd.args || [];
  if (cmd.type === "git-clone") return { bin: "git", args: ["clone", "--progress", ...args] };
  // pnpm-install（及未知类型退化到 pnpm）
  const entry = findPnpmEntry();
  if (entry) return { bin: process.execPath, args: [entry, "install", ...args] };
  return { bin: "pnpm", args: ["install", ...args] }; // 退化：PATH 上有 pnpm.exe 时可用
}

function findPnpmEntry() {
  // 1) where pnpm → .cmd shim → 读内容找 node_modules/pnpm/bin/pnpm.mjs|cjs
  try {
    const r = spawnSync("where.exe", ["pnpm"], { encoding: "utf-8", windowsHide: true });
    if (r.status === 0) {
      for (const line of String(r.stdout || "").split(/\r?\n/)) {
        const p = line.trim();
        if (!p || !/\.cmd$/i.test(p)) continue;
        const content = fs.readFileSync(p, "utf-8");
        const m = content.match(/node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.(?:mjs|cjs)/);
        if (m) {
          const entry = path.resolve(path.dirname(p), m[0].replace(/\//g, path.sep));
          if (fs.existsSync(entry)) return entry;
        }
      }
    }
  } catch { /* 继续探测 */ }
  // 2) npm root -g 直拼标准结构
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", windowsHide: true });
    if (r.status === 0) {
      const root = String(r.stdout || "").trim();
      for (const f of ["pnpm/bin/pnpm.mjs", "pnpm/bin/pnpm.cjs"]) {
        const entry = path.join(root, f);
        if (fs.existsSync(entry)) return entry;
      }
    }
  } catch { /* 返回 null 走退化 */ }
  return null;
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (name) return name;
  } catch { /* fallthrough */ }
  return "download_" + Date.now();
}

function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "download_" + Date.now();
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const dir = path.dirname(p);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

function friendlyError(e) {
  const msg = e?.message || String(e || "");
  const low = msg.toLowerCase();
  const cause = e?.cause;
  const causeCode = cause && cause.code ? `（${cause.code}）` : "";
  if (low.includes("terminated")) return "连接被中断（terminated）";
  if (low.includes("fetch failed") || low.includes("socket hang up") || low.includes("econnreset")) {
    return "网络请求失败" + causeCode;
  }
  if (low.includes("aborted")) return "请求被中止";
  if (low.includes("content-length") || low.includes("length")) return "响应异常（长度不符）";
  return msg + causeCode;
}

// ── 代理支持（无第三方依赖）──
// 优先级：环境变量 HTTPS_PROXY/HTTP_PROXY > 插件 config.json 的 proxy 字段 > Windows 系统代理（注册表）
function resolveProxy(dataDir) {
  const envP = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (envP) return envP;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8") || "{}");
    if (cfg && cfg.proxy) return String(cfg.proxy);
  } catch { /* 无配置则跳过 */ }
  try {
    const out = spawnSync(
      "reg",
      ["query", 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', "/v", "ProxyServer"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    );
    const m = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(out.stdout || "");
    if (m && m[1].trim()) {
      const p = m[1].trim();
      if (p.startsWith("http://") || p.startsWith("https://")) return p;
      return "http://" + p;
    }
  } catch { /* 读注册表失败则直连 */ }
  return "";
}

// 小响应缓冲：Content-Length < 4KB 时读完整 body，用于检测文本重定向
// （npmmirror 等返回 200 + "Redirecting to <url>" 的非标准重定向）。
// 非重定向时返回 Buffer（由调用方写回流），重定向/异常返回 null 由上层处理。
function readSmallBody(res) {
  const cl = parseInt(res.headers["content-length"] || "", 10);
  if (!(Number.isFinite(cl) && cl >= 0 && cl < 4096)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("error", onErr);
      resolve(v);
    };
    const onData = (c) => {
      chunks.push(c);
      const total = chunks.reduce((a, b) => a + b.length, 0);
      if (total > 8192) finish(null);
    };
    const onEnd = () => finish(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
    const onErr = () => finish(null);
    res.on("data", onData);
    res.on("end", onEnd);
    res.on("error", onErr);
    setTimeout(() => finish(null), 3000);
  });
}

// 手写 HTTP CONNECT 隧道 Agent（https.Agent 负责后续 TLS）
function createTunnelAgent(proxyUrl) {
  let pu;
  try { pu = new URL(proxyUrl); } catch { return null; }
  if (pu.protocol !== "http:" && pu.protocol !== "https:") return null;
  const port = Number(pu.port) || (pu.protocol === "http:" ? 80 : 443);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = function (options, cb) {
    const host = options.host;
    const targetPort = options.port || 443;
    const socket = net.connect(port, pu.hostname, function () {
      const cReq = http.request({
        host: pu.hostname,
        port: port,
        method: "CONNECT",
        path: host + ":" + targetPort,
        headers: { Host: host + ":" + targetPort },
      });
      cReq.once("connect", function (cRes, tunnel) {
        if (!cRes.statusCode || cRes.statusCode !== 200) {
          tunnel.destroy();
          cb(new Error("代理 CONNECT 失败: " + (cRes.statusCode || "?")));
          return;
        }
        cb(null, tunnel);
      });
      cReq.once("error", function (err) { cb(err); });
      cReq.end();
    });
    socket.once("error", function (err) { cb(err); });
  };
  return agent;
}

class AbortError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "AbortError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
