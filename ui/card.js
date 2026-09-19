// card.js — 聊天流内的下载进度卡片（v2 App，官方 @hana/app-sdk/ui）
//
// 与旧版的区别：
//   1. 不再劫持 window.fetch、不再模拟插件时代的 /download/xxx 路径。
//      后端访问统一走 hana.api.fetch（SDK 自动带上 iframe 的 surface session 票据）。
//   2. 主题与尺寸走 SDK（hana.theme / hana.ui.resize），不再自己解析 iframe URL 参数。
//   3. 任务身份不再靠「无参回退到最近任务」：加载后向引擎 /bind 认领本卡对应的任务，
//      键是宿主铸造的 cardInstanceId（重新投影后不变，所以会话重载不会串）。
//
// 视觉层（配色板、类结构、图标、文案、折叠联动）沿用旧版，未改。

import { hana } from "./assets/sdk.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = document.getElementById("dl-root");
if (!root) throw new Error("dl-root missing");

// card.html 里没有内联脚本了，__API 基址完全由 SDK 负责解析。
try { hana.ready(); } catch (e) { /* ready 失败不阻塞渲染 */ }

// ── 主题 ──
function syncTheme() {
  let snap = null;
  try { snap = hana.theme?.getSnapshot?.() || null; } catch { snap = null; }
  const label = String(snap?.theme || "");
  let dark = snap?.appearance === "dark" || /dark|midnight|contrast|深|夜/i.test(label);
  if (!snap?.appearance && (!label || label === "inherit")) {
    dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  document.body.classList.toggle("t-dark", dark);
}
syncTheme();
try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 订阅不可用就只保留首帧 */ }

// ── 尺寸上报 ──
// 高度走 SDK 的 ui.resize；同时保留 hana.card-resize 这条顶层消息作兜底——
// 0.970.9 聊天流挂载位的卡壳只认这一条高度消息（实测），SDK 那条在这条路径上没人接。
var CARD_WIDTH = 400; // 2026-09-17：450 → 400（收窄 50px）

function measureH() {
  const dlEl = document.querySelector(".dl");
  const bodyEl = document.body;
  let pad = 0;
  if (bodyEl && window.getComputedStyle) {
    const cs = window.getComputedStyle(bodyEl);
    pad = (parseInt(cs.paddingTop, 10) || 0) + (parseInt(cs.paddingBottom, 10) || 0);
  }
  let h = Math.ceil((dlEl ? dlEl.offsetHeight : (bodyEl ? bodyEl.scrollHeight : 0)) + pad);
  // 下限 24px：内容真没了也得留出可点的两行。
  // 2026-09-14 压薄：原为 40，等于给卡片钉了块地板，内容压到 32 也报 40，
  // 底部就永远有 8px 空白（用户看到的“进度条到下边框的距离”）。
  if (!isFinite(h) || h < 24) h = 24;
  return h;
}

var lastReportedH = 0;
function reportSize() {
  try {
    const h = measureH();
    // 高度未变不重复上报（高频轮询下减负；宽度是常量，不参与变化判断）
    if (h === lastReportedH) return;
    lastReportedH = h;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { /* 老宿主没有这路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}

if (typeof ResizeObserver !== "undefined") {
  try { new ResizeObserver(() => reportSize()).observe(root); } catch { /* 观察失败不影响主流程 */ }
}

// ── 任务绑定 ──
let taskId = "";

function surfaceContext() {
  try { return hana.surface?.getContext?.() || null; } catch { return null; }
}

async function bindTask() {
  let ctx = null;
  for (let i = 0; i < 12 && !ctx; i++) {
    ctx = surfaceContext();
    if (!ctx) await sleep(150);
  }
  const cardInstanceId = ctx?.cardInstanceId || "";
  const sessionId = ctx?.embeddedSessionId || ctx?.originSessionId || null;

  try {
    const res = await hana.api.fetch("/engine/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardInstanceId, sessionId }),
    });
    const j = await res.json();
    if (j?.ok && j.taskId) {
      taskId = j.taskId;
      return true;
    }
  } catch (e) {
    // 认领失败：退回无参轮询（引擎回退到最近任务），至少让卡片有内容
  }
  return false;
}

// ── 引擎访问 ──
async function engineFetch(path, body, method) {
  const init = { method: method || (body ? "POST" : "GET") };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await hana.api.fetch(`/engine/${path}`, init);
  return res.json();
}

// ── 状态机 ──
var timer = null;
var FINAL_STATES = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

async function poll() {
  try {
    const data = await engineFetch("wait", { taskId: taskId || null });
    if (!data || !data.ok) {
      renderFail((data && data.error) || "任务不存在");
      stop();
      return;
    }
    const t = data.task || data.snap;
    if (t && t.taskId) taskId = t.taskId;
    render(t);
    if (FINAL_STATES[t.state]) stop();
  } catch (e) {
    // 瞬时错误（引擎重启/网络抖动）：静默重试
  }
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

async function cancel() {
  try {
    const d = await engineFetch("cancel", { taskId: taskId || null, source: "user" });
    if (d && d.ok) poll();
  } catch (e) { /* 卡片即将随任务终态刷新 */ }
}

async function reveal(mode) {
  const p = currentTask && currentTask.filePath;
  if (!p) return;
  try {
    const d = await engineFetch("reveal", { path: p, mode: mode || "select" });
    if (d && d.ok === false) renderHint(d.error || "打开失败");
  } catch (e) { renderHint("打开失败"); }
}

async function copyPath(p) {
  if (!p) return;
  try {
    await hana.clipboard.writeText(p);
    flashBtn("已复制");
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = p;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flashBtn("已复制");
    } catch (e2) { renderHint("复制失败"); }
  }
}

function flashBtn(msg) {
  const b = root.querySelector(".dl-copy");
  if (!b) return;
  const old = b.textContent;
  b.textContent = msg;
  setTimeout(() => { if (b) b.textContent = old; }, 1200);
}

// ── 折叠状态（render 每次重写 DOM，这里记住状态防丢失）──
var expanded = false;
var allExpanded = false;
var BC = null;
try { BC = new BroadcastChannel("hana-dl-cards"); } catch (e) { BC = null; }
if (BC) {
  BC.onmessage = (ev) => {
    const d = ev.data;
    if (!d || d.type !== "setAll") return;
    allExpanded = !!d.value;
    expanded = allExpanded;
    applyExpandState();
  };
}

function applyExpandState() {
  const dl = root.querySelector(".dl");
  if (dl) dl.classList.toggle("expanded", expanded);
  const foldBtn = document.getElementById("dl-fold");
  if (foldBtn) foldBtn.classList.toggle("open", expanded);
  const allBtn = document.getElementById("dl-all");
  if (allBtn) allBtn.classList.toggle("open", allExpanded);
  reportSize();
}

function toggleFold() { expanded = !expanded; applyExpandState(); }

function toggleAll() {
  allExpanded = !allExpanded;
  expanded = allExpanded;
  applyExpandState();
  if (BC) { try { BC.postMessage({ type: "setAll", value: allExpanded }); } catch (e) { /* 忽略 */ } }
}

// ── 渲染 ──
var currentTask = null;

var STAGE_TEXT = {
  receiving: "接收中", checkout: "检出中", fetching: "拉取中", linking: "链接中",
  building: "编译中", "resolving-deps": "解析依赖", cloning: "准备克隆",
  enumerating: "枚举对象", resolving: "解析增量", finalizing: "收尾",
  // winget / pip 链路（2026-09-18）
  found: "查找包", downloading: "下载中", verifying: "校验哈希", installing: "安装中",
  collecting: "解析依赖",
};
var UNIT_NAME = { objects: "对象", files: "文件", packages: "包" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + "B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n; let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + units[i];
}

function fmtDuration(sec) {
  if (sec < 60) return Math.max(1, Math.round(sec)) + "s";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return (sec / 3600).toFixed(1) + "h";
}

function stateBadge(s) {
  return { running: "下载中", pending: "准备中", done: "完成", failed: "失败", canceled: "已取消", interrupted: "已中断", stalled: "停滞" }[s] || s;
}

function render(t) {
  if (!t) return;
  currentTask = t;

  const state = t.state;
  const running = state === "running";
  const pending = state === "pending";
  const done = state === "done";
  const terminal = done || state === "failed" || state === "canceled" || state === "interrupted";
  // winget / pip 是阶段式任务：输出里没有百分比与字节数据，数字区按需收起（2026-09-18）
  const pkgTask = t.cmdType === "winget-install" || t.cmdType === "pip-install"
    || !!(t.cmd && (t.cmd.type === "winget-install" || t.cmd.type === "pip-install"));
  const pct = t.percent;
  const known = t.total != null && t.total > 0;
  // 计数型单位（objects / packages / files）在 total 未知时不报 100%：分母本来就不存在（2026-09-19）
  const pctText = done
    ? (known || !(t.unit && t.unit !== "bytes") ? "100%" : "—")
    : (known ? (pct == null ? "0" : pct.toFixed(pct >= 100 ? 0 : 1)) + "%" : "—");
  const unit = t.unit;
  const sizeText = pending ? "—" : (unit && unit !== "bytes")
    ? (t.received != null ? t.received : 0) + (known ? "/" + t.total : "") + (UNIT_NAME[unit] ? " " + UNIT_NAME[unit] : "")
    : (done && known ? fmtBytes(t.total) : fmtBytes(t.received) + (known ? "/" + fmtBytes(t.total) : ""));
  const speedText = running && t.speed > 0 ? fmtBytes(t.speed) + "/s" : "";

  let etaText = "";
  if (running && known && t.speed > 0) {
    etaText = "剩" + fmtDuration(Math.max(0, (t.total - t.received) / t.speed));
  }

  const badge = stateBadge(state);
  const badgeState = state === "running" && t.stalled ? "stalled" : state;
  const barClass = "dl-bar"
    + (pending || (!known && !terminal) ? " indet" : "")
    + (done ? " done" : "")
    + (state === "failed" || state === "canceled" || state === "interrupted" ? " failed" : "");
  const barWidth = done ? 100 : (known && pct != null ? Math.min(100, pct) : 0);
  const filePath = t.filePath || "";

  // 2026-09-17：速度从 meta 里移出，与百分比/大小合成「数据组」，统一放到进度条上面那行。
  const metaParts = [];
  if (t.stalled && !terminal) metaParts.push("连接停滞，等待 Agent 决策");
  if (etaText) metaParts.push(etaText);
  if (pending) metaParts.push("准备中…");
  // 计数型任务（pnpm 等）：优先显示真实计数明细，没有明细才退回阶段名（2026-09-19）
  if (running && t.stageDetail) metaParts.push(t.stageDetail);
  else if (running && t.stage && STAGE_TEXT[t.stage]) metaParts.push(STAGE_TEXT[t.stage]);
  if (done && t.note) metaParts.push(t.note);
  const metaText = metaParts.join(" · ");

  let html = "";
  html += '<div class="dl' + (expanded ? " expanded" : "") + '">';
  html += '<div class="dl-row"><span class="dl-left">';
  html += '<button class="dl-fold' + (expanded ? " open" : "") + '" id="dl-fold" title="展开/收起详情">❯</button>';
  html += '<button class="dl-all' + (allExpanded ? " open" : "") + '" id="dl-all" title="展开/收起所有下载">□</button>';
  html += "</span>";
  html += '<span class="dl-badge b-' + badgeState + '">' + badge + "</span>";

  // 失败/中断原因：放在进度条上面那行（信息行）里，红色短文本，超长省略；
  // 全文在展开区的「状态」行。2026-09-14：原本独占卡片底部一行。
  const errText = (state === "failed" || state === "canceled" || state === "interrupted")
    ? (t.error || "下载失败") : "";
  // 信息行：错误优先、其次阶段/备注；与徽标文案重复时省略（如 winget 下载阶段两处都是「下载中」）；
  // 错误里的换行压成空格，避免撑破单行布局（全文仍在 title 里）
  let lineText = errText ? errText.replace(/\s*\n\s*/g, " ") : metaText;
  if (lineText === badge) lineText = "";
  if (lineText) {
    html += '<span class="dl-meta' + (errText ? " err" : "") + '"'
      + (errText ? ' title="' + esc(errText) + '"' : "") + ">" + esc(lineText) + "</span>";
  }

  // 进度数据组（百分比 · 已下载/总量 · 速度）：2026-09-17 从进度条右侧上移到这一行（进度条上面那行），
  // 紧邻操作按钮之前；进度条自己独占下面一行。
  html += '<span class="dl-progress-top">';
  // 阶段式任务（winget/pip）默认收起数字区；一旦有真实字节数据（下载探测到的进度）就照常显示
  if (!pkgTask || done || known) html += '<span class="dl-pct">' + esc(pctText) + "</span>";
  if (!pkgTask || known) html += '<span class="dl-size">' + esc(sizeText) + "</span>";
  if (speedText) html += '<span class="dl-speed">' + esc(speedText) + "</span>";
  html += "</span>";

  if (pending || running) {
    html += '<button class="dl-btn danger" id="dl-cancel">取消</button>';
  } else if (done) {
    if (pkgTask) {
      // winget / pip 没有可打开的产物：完成态不给打开按钮
    } else if (t.kind === "command") {
      html += '<button class="dl-btn primary" id="dl-folder" title="打开目标目录">打开文件夹</button>';
    } else {
      html += '<button class="dl-btn primary" id="dl-open">打开</button>'
        + '<button class="dl-btn" id="dl-folder" title="打开所在文件夹">文件夹</button>';
    }
  }
  html += "</div>";

  // 进度条独占一行（2026-09-17）：数据组已上移，这里只留条本身。
  html += '<div class="dl-row2">';
  html += '<div class="dl-track"><div class="' + barClass + '" style="width:' + barWidth + '%"></div></div>';
  html += "</div>";

  // 第三行已撤销（2026-09-14）：metaText 已并入上方信息行。

  html += '<div class="dl-detail">';
  html += '<div class="dl-d-row"><span class="dl-d-label">文件</span><span class="dl-d-value">' + esc(t.fileName || "—") + "</span></div>";
  if (filePath) html += '<div class="dl-d-row"><span class="dl-d-label">路径</span><span class="dl-d-value">' + esc(filePath) + "</span></div>";
  html += '<div class="dl-d-row"><span class="dl-d-label">操作</span><span class="dl-d-value">'
    + '<button class="dl-btn dl-copy" id="dl-copy">复制路径</button></span></div>';
  if (known) {
    let sizeDetail = (unit && unit !== "bytes")
      ? t.total + (UNIT_NAME[unit] ? " " + UNIT_NAME[unit] : "")
      : fmtBytes(t.total);
    if (running && t.received != null) {
      sizeDetail += (unit && unit !== "bytes" ? "（已完成 " + t.received + "）" : "（已下载 " + fmtBytes(t.received) + "）");
    }
    // 计数型（packages/objects/files）的“大小”其实是计数，标签跟着改（2026-09-19）
    html += '<div class="dl-d-row"><span class="dl-d-label">' + (unit && unit !== "bytes" ? "数量" : "大小") + '</span><span class="dl-d-value">' + esc(sizeDetail) + "</span></div>";
  }
  html += '<div class="dl-d-row"><span class="dl-d-label">任务</span><span class="dl-d-value">' + esc(t.taskId || taskId) + "</span></div>";
  html += '<div class="dl-d-row"><span class="dl-d-label">状态</span><span class="dl-d-value">' + esc(badge) + (metaText ? "（" + esc(metaText) + "）" : "") + "</span></div>";
  if (running && known && t.speed > 0 && t.received < t.total) {
    const remainSec = Math.max(0, (t.total - t.received) / t.speed);
    const etaAbs = new Date(Date.now() + remainSec * 1000);
    html += '<div class="dl-d-row"><span class="dl-d-label">预计</span><span class="dl-d-value">'
      + String(etaAbs.getHours()).padStart(2, "0") + ":" + String(etaAbs.getMinutes()).padStart(2, "0")
      + " 完成（剩" + fmtDuration(remainSec) + "）</span></div>";
  }
  html += "</div>";

  // 错误行已上移到信息行（2026-09-14），此处不再重复渲染。
  html += "</div>";

  if (root.innerHTML !== html) root.innerHTML = html;

  reportSize();

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("dl-fold", toggleFold);
  on("dl-all", toggleAll);
  on("dl-cancel", cancel);
  on("dl-open", () => reveal("open"));
  on("dl-folder", () => reveal("select"));
  on("dl-copy", () => copyPath(filePath));
}

function renderFail(msg) {
  root.innerHTML = '<div class="dl"><div class="dl-error">' + esc(msg) + "</div></div>";
  reportSize();
}

function renderHint(msg) {
  const div = document.createElement("div");
  div.className = "dl-hint";
  div.textContent = msg;
  root.appendChild(div);
  reportSize();
}

// ── 启动 ──
window.addEventListener("load", () => setTimeout(reportSize, 60));

// 尺寸诊断：把当前 iframe 宽度与宿主信封上报到卡片活动仓（hana.track，不进会话、不唤醒）。
// 用途：在宿主侧确认聊天流卡实际拿到多宽（页面无法直接决定宽度，只能上报）。
setTimeout(() => {
  try {
    let env = null;
    try { env = hana.envelope?.getSnapshot?.() || null; } catch (e) { env = null; }
    const q = (sel) => { try { const el = document.querySelector(sel); return el ? el.offsetHeight : null; } catch (e) { return null; } };
    const cs = (sel) => { try { const s = getComputedStyle(sel ? document.querySelector(sel) : document.body); return { lh: s.lineHeight, fs: s.fontSize, pad: s.padding, mt: s.marginTop, mb: s.marginBottom }; } catch (e) { return null; } };
    hana.track?.("diag", {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      envW: env?.width || null,
      envH: env?.height || null,
      want: CARD_WIDTH,
      // 高度拆解（2026-09-14 压薄排查用）
      bodyH: document.body?.offsetHeight ?? null,
      rootH: q("#dl-root"),
      dlH: q(".dl"),
      rowH: q(".dl-row"),
      row2H: q(".dl-row2"),
      trackH: q(".dl-track"),
      pctH: q(".dl-pct"),
      bodyCs: cs(null),
      rowCs: cs(".dl-row"),
    });
  } catch (e) { /* 诊断失败不影响主流程 */ }
}, 1200);

(async () => {
  await bindTask();
  await poll();
  // 300ms 一轮（2026-09-18 调快，原 600ms）：数据源 500ms 更新一次，
  // 再快的收益有限但开销极小（内存快照读取），以跟手为准。
  timer = setInterval(poll, 300);
})();
