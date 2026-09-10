// card.js — 下载进度卡片前端（iframe 内执行）
// 轮询插件 route 获取进度，渲染进度条/大小/速度/已完成量。
// 内含 mini host SDK（@hana/plugin-sdk 协议兼容，免构建）。

(function () {
  "use strict";

  // 主题明暗判定：data-hana-theme（宿主传的静态值）优先，缺失时 prefers-color-scheme 兜底
  var __th = (document.body && document.body.getAttribute("data-hana-theme")) || "";
  var __dark = /dark|midnight|contrast|深/i.test(__th);
  if (!__dark && (!__th || __th === "inherit")) {
    __dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  if (__dark) document.body.classList.add("t-dark");
  // 主题变化监听：宿主未传静态主题时，跟随系统配色变化动态切换
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (ev) {
        var th2 = (document.body && document.body.getAttribute("data-hana-theme")) || "";
        if (/dark|midnight|contrast|深/i.test(th2)) { document.body.classList.add("t-dark"); return; }
        if (th2 && th2 !== "inherit") return;
        document.body.classList.toggle("t-dark", ev.matches);
      });
    } catch (e) { /* 忽略 */ }
  }

  // 宿主主题切换监听：宿主广播 hana.theme.changed / theme-changed 到插件 iframe
  // 兼容不同 payload 形状：md.theme 或嵌套。收到后更新 data-hana-theme + t-dark（颜色由 CSS 变量切换自动跟随）
  var _lastThemeSig = ""; // 诊断：记录最近一次主题信号，随详情区显示
  window.addEventListener("message", function (ev) {
    try {
      var md = ev.data;
      if (!md || typeof md !== "object") return;
      var th = "";
      if (md.type === "hana.theme.changed") {
        th = md.theme || (md.payload && md.payload.theme) || "";
      } else if (md.type === "theme-changed") {
        th = md.theme || (md.payload && md.payload.theme) || "";
      } else if (md.theme && (md.type === "hana.surface.envelope.changed" || md.type === "hana.surface.runtime.changed")) {
        th = md.theme || "";
      }
      // 通用兜底：任何消息若带 theme 字段都处理
      if (!th && md.theme) th = md.theme;
      if (!th) return;
      _lastThemeSig = th;
      document.body.setAttribute("data-hana-theme", th);
      var dark = /dark|midnight|contrast|深|夜/i.test(th);
      document.body.classList.toggle("t-dark", dark);
      if (typeof render === "function") { try { render(); } catch (e) { /* 忽略 */ } }
    } catch (e3) { /* 忽略 */ }
  });

  var root = document.getElementById("dl-root");
  var API = window.__API || "";
  var pageParams = new URLSearchParams(location.search);
  var taskId = (root && root.dataset.task) || pageParams.get("taskId") || "";
  // iframe 由宿主以带凭据的 URL 加载：本地连接带 token query，远程连接带 pluginSurfaceSession
  var LOOPBACK_TOKEN = pageParams.get("token") || "";
  var SURFACE_SESSION = pageParams.get("pluginSurfaceSession") || "";
  // v2 App：contributes.cards[].route 不允许带 query，聊天流卡的 route 固定是 /card.html，
  // 所以这里通常拿不到 taskId。不再因此报错，而是让 /download/status 不带 taskId 请求，
  // 由引擎回退到“最近任务”（running/pending 优先），拿到快照后再回填 taskId。

  function apiUrl(path) {
    var url = API + path;
    if (LOOPBACK_TOKEN) {
      url += (url.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(LOOPBACK_TOKEN);
    }
    return url;
  }

  function apiFetch(path, init) {
    var headers = new Headers(init && init.headers);
    if (SURFACE_SESSION) headers.set("X-Hana-Plugin-Surface-Session", SURFACE_SESSION);
    return fetch(apiUrl(path), Object.assign({}, init || {}, { headers: headers }));
  }

  // ── mini host SDK ──
  var PARENT = window.parent;
  // 消息目标 origin：宿主 iframe URL 若带 hana-host-origin 用之，否则用通配符投递
  // （不能用 referrer origin：Electron 下 referrer 为 file://，origin 是 "null"，消息会投递失败）
  var HOST_ORIGIN = new URLSearchParams(location.search).get("hana-host-origin") || "*";
  var seq = 0;
  function hostRequest(type, payload) {
    var id = "dl-" + (++seq);
    return new Promise(function (resolve, reject) {
      function onMsg(e) {
        if (e.source !== PARENT) return;
        var m = e.data;
        if (!m || m.id !== id || m.type !== type) return;
        cleanup();
        if (m.kind === "response") resolve(m.payload);
        else if (m.kind === "error") reject(new Error((m.error && m.error.message) || "host error"));
      }
      function cleanup() {
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
      }
      var timer = setTimeout(function () { cleanup(); reject(new Error("host 请求超时: " + type)); }, 8000);
      window.addEventListener("message", onMsg);
      PARENT.postMessage(
        { protocol: "hana.plugin.ui", version: 1, id: id, kind: "request", type: type, payload: payload },
        HOST_ORIGIN
      );
    });
  }

  // ── 内容高度自适应：报告给宿主，iframe 贴合内容高度（避免“浏览器窗口”感）──
  // 卡片目标宽度：null = 自动取「聊天区当前宽度 × 2/3」并一次定格（用户要“现在三分之二”）。
  // 0 = 不上报 width，卡片铺满；正数 = 锁到该宽度。宿主把 width 当 maxWidthPx，
  // 报窄值会让卡片变窄、右侧留白；铺满则跟随聊天区。这里默认用自动 2/3。
  var CARD_WIDTH = 620; // 2026-09-10 用户要求：再调宽到 620，让首行“打开 / 文件夹 / 复制路径”舒展（不再紧凑）
                        // （历史：2026-08-31 曾收窄到 470；2026-09-10 先到 540）
  var _cwLocked = false; // 已定格：避免读 innerWidth 上报后宿主改 iframe 宽再读变小，形成递归
  var _cw = 0;           // 定格后的卡片宽度（px）

  // ── 图标按钮（完成态三个操作）：stroke 跟随 currentColor，与主题色板一致 ──
  var ICO_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';
  var ICO_FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  var ICO_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
  var ICO_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  // ── 内容高度自适应：卡片实际内容多高报多高，收起/展开同一机制，不定档不钳位。
  // （2026-08-31 二轮：用户要求废除 COLLAPSED_H 定高与 EXPANDED_MAX_H 钳位，全走实测自适应）──
  function measureH() {
    var dlEl = document.querySelector(".dl");
    var bodyEl = document.body;
    var pad = 0;
    if (bodyEl) {
      var cs = window.getComputedStyle ? window.getComputedStyle(bodyEl) : null;
      if (cs) pad = (parseInt(cs.paddingTop, 10) || 0) + (parseInt(cs.paddingBottom, 10) || 0);
    }
    var base = dlEl ? dlEl.offsetHeight : (bodyEl ? bodyEl.scrollHeight : 0);
    if (!isFinite(base) || base < 0) base = 0;
    var h = Math.ceil(base + pad);
    if (!isFinite(h) || h < 40) h = 40; // 防零高/负高的兼底下限
    return h;
  }

  function reportSize() {
    try {
      var h = measureH();
      var payload = { height: h };
      // 卡片宽度策略：
      //   CARD_WIDTH === null（自动 2/3）：首次读 iframe 宽度取 2/3 定格，上报后不再变。
      //   CARD_WIDTH > 0：报该固定值当 maxWidthPx 上限——宿主窗口窄时 iframe 跟随容器变窄，
      //     窗口超过该值才被夹住。这是“封顶上限”，不是锁定宽，不反馈。
      if (CARD_WIDTH === null) {
        if (!_cwLocked) {
          var cw = 0;
          try { cw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0; } catch (e2) { cw = 0; }
          if (cw > 0) {
            var want = Math.max(350, Math.round(cw * 2 / 3));
            var stored = 0;
            try { stored = parseInt(window.localStorage.getItem("dl-card-fixed-w"), 10) || 0; } catch (e3) { stored = 0; }
            if (stored >= 350 && want < stored) want = stored;
            _cw = want;
            try { window.localStorage.setItem("dl-card-fixed-w", String(want)); } catch (e4) {}
            _cwLocked = true;
          }
        }
        if (_cwLocked) payload.width = _cw;
      } else if (CARD_WIDTH > 0) {
        payload.width = CARD_WIDTH;
      }
      PARENT.postMessage(
        { protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: payload },
        HOST_ORIGIN
      );
    } catch (e) { /* 忽略 */ }
  }

  // 用 ResizeObserver 监听内容容器 #dl-root（展开/收起/进度变化立即报高）。
  // 不监听 body：宿主 iframe 高度变化会让 body 尺寸变化（height:100%），导致循环报错。
  var _ro = null;
  if (typeof ResizeObserver !== "undefined") {
    try {
      _ro = new ResizeObserver(function () { reportSize(); });
      _ro.observe(root || document.getElementById("dl-root"));
    } catch (e) { _ro = null; }
  }

  // ── 状态机 ──
  var timer = null;
  var lastState = "";
  var FINAL_STATES = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

  function poll() {
    // 无 taskId 时不带参数请求，引擎会回退到最近任务（v2 卡片 route 不能带 query）
    var q = taskId ? "/download/status?taskId=" + encodeURIComponent(taskId) : "/download/status";
    apiFetch(q, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          renderFail((data && data.error) || "任务不存在");
          stop();
          return;
        }
        render(data.task);
        if (FINAL_STATES[data.task.state]) stop();
      })
      .catch(function () {
        // 瞬时网络错误：静默重试，连续失败由 render 提示
      });
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function cancel() {
    apiFetch("/download/cancel?taskId=" + encodeURIComponent(taskId), { method: "POST", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) poll();
        else renderHint((d && d.error) || "取消失败");
      })
      .catch(function () { renderHint("取消失败"); });
  }

  function openFile(p) {
    if (!p) { renderHint("没有可打开的文件路径"); return; }
    // 服务端 explorer 用默认程序打开（聊天流宿主上下文 resource.open 能力不可靠）
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, mode: "open" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) renderHint(d.error || "打开失败"); })
      .catch(function () { renderHint("打开失败：网络错误"); });
  }

  function openFolder(p) {
    if (!p) { renderHint("没有可打开的文件路径"); return; }
    // 服务端 explorer /select 定位并打开所在文件夹（绕过宿主 platform 限制）
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) renderHint(d.error || "打开文件夹失败"); })
      .catch(function () { renderHint("打开文件夹失败：网络错误"); });
  }

  function copyPath(p) {
    hostRequest("clipboard.writeText", { text: p })
      .then(function () { flashBtn("已复制"); })
      .catch(function () {
        try {
          var ta = document.createElement("textarea");
          ta.value = p; document.body.appendChild(ta); ta.select();
          document.execCommand("copy"); document.body.removeChild(ta);
          flashBtn("已复制");
        } catch (e) { renderHint("复制失败"); }
      });
  }

  function flashBtn(msg) {
    var b = root.querySelector(".dl-copy");
    if (!b) return;
    var old = b.textContent;
    b.textContent = msg;
    setTimeout(function () { if (b) b.textContent = old; }, 1200);
  }

  // ── 折叠状态（render 每次重写 DOM，这里记住状态防丢失）──
  var expanded = false;    // 本条展开
  var allExpanded = false; // 全部展开（□ 旋转为菱形）
  var BC = null;
  try { BC = new BroadcastChannel("hana-dl-cards"); } catch (e) { BC = null; }
  if (BC) {
    BC.onmessage = function (ev) {
      var d = ev.data;
      if (!d || d.type !== "setAll") return;
      allExpanded = !!d.value;
      expanded = allExpanded;
      applyExpandState();
    };
  }

  function applyExpandState() {
    var dl = root.querySelector(".dl");
    var foldBtn = document.getElementById("dl-fold");
    var allBtn = document.getElementById("dl-all");
    if (dl) dl.classList.toggle("expanded", expanded);
    if (foldBtn) foldBtn.classList.toggle("open", expanded);
    if (allBtn) allBtn.classList.toggle("open", allExpanded);
    reportSize();
  }

  function toggleFold() {
    expanded = !expanded;
    applyExpandState();
  }

  function toggleAll() {
    allExpanded = !allExpanded;
    expanded = allExpanded;
    applyExpandState();
    if (BC) {
      try { BC.postMessage({ type: "setAll", value: allExpanded }); } catch (e) { /* 忽略 */ }
    }
  }

  // ── 渲染 ──
  function render(t) {
    var state = t.state;
    var running = state === "running";
    var pending = state === "pending";
    var done = state === "done";
    var terminal = done || state === "failed" || state === "canceled" || state === "interrupted";
    var pct = t.percent;
    var known = t.total != null && t.total > 0;
    // 完成态百分比兑底显示 100%（total 未知/历史数据时 percent 可能为 null）
    var pctText = done ? "100%" : (known ? (pct == null ? "0" : pct.toFixed(pct >= 100 ? 0 : 1)) + "%" : "—");
    var UNIT_NAME = { objects: "对象", files: "文件", packages: "包" };
    // 命令型任务（command）单位是 对象/文件/包，不是 bytes；bytes 走原 fmtBytes
    var sizeText = pending ? "—" : (t.unit && t.unit !== "bytes")
      ? (t.received != null ? t.received : 0) + (known ? "/" + t.total : "") + (UNIT_NAME[t.unit] ? " " + UNIT_NAME[t.unit] : "")
      : fmtBytes(t.received) + (known ? "/" + fmtBytes(t.total) : "");
    var speedText = running && t.speed > 0 ? fmtBytes(t.speed) + "/s" : "";
    var etaText = "";
    if (running && known && t.speed > 0) {
      var remain = Math.max(0, (t.total - t.received) / t.speed);
      etaText = "剩" + fmtDuration(remain);
    }

    var badge = stateBadge(state);
    var badgeState = state === "running" && t.stalled ? "stalled" : state;
    // 终态（done/failed/canceled/interrupted）脱离不确定态：done 强制满条，其余终态停在实际进度
    var barClass = "dl-bar" + (pending || (!known && !terminal) ? " indet" : "") + (done ? " done" : "") + (state === "failed" || state === "canceled" || state === "interrupted" ? " failed" : "");
    var barWidth = done ? 100 : (known && pct != null ? Math.min(100, pct) : 0);
    var filePath = t.filePath || "";

    // 第一行元信息：速度 · 剩余时间（紧凑）；第二行放百分比和大小
    var metaParts = [];
    if (t.stalled) metaParts.push("连接停滞，等待 Agent 决策");
    if (speedText) metaParts.push(speedText);
    if (etaText) metaParts.push(etaText);
    if (pending) metaParts.push("准备中…");
    // 命令型任务：阶段文案（接收中/检出中/拉取中/编译中等）追加到元信息尾部
    if (running && t.stage && STAGE_TEXT[t.stage]) metaParts.push(STAGE_TEXT[t.stage]);
    var metaText = metaParts.join(" · ");
    var sizeText2 = pending ? "—" : sizeText;

    var html = "";
    html += '<div class="dl' + (expanded ? " expanded" : "") + '">';
    html += '<div class="dl-row"><span class="dl-left">';;
    html += '<button class="dl-fold' + (expanded ? " open" : "") + '" id="dl-fold" title="展开/收起详情">❯</button>';
    html += '<button class="dl-all' + (allExpanded ? " open" : "") + '" id="dl-all" title="展开/收起所有下载">□</button>';
    html += "</span>";
    html += '<span class="dl-badge b-' + badgeState + '">' + badge + "</span>";
    // 首行只留「徐章 + 操作按钮」：折叠/全展在左，按钮组用 margin-left:auto 推到右侧，
    // 把固定宽度的空间用满（聊天流卡宽度由宿主锁定，不采纳页面宽度上报）。
    // 元信息（速度/剩余/阶段）与百分比/大小一起放到进度行。

    if (pending || running) {
      html += '<button class="dl-btn danger" id="dl-cancel">取消</button>';
    } else if (state === "done") {
      if (t.kind === "command") {
        // 命令型任务完成：目录无默认打开程序语义，只给 打开文件夹
        html += '<button class="dl-btn primary" id="dl-folder" title="打开目标目录">打开文件夹</button>';
      } else {
        // 卡宽由宿主任务族统一宽度限定（348px），首行只放两个高频操作，
        // “复制路径”下沉到展开详情里（路径行右侧）。（2026-09-10 用户要求）
        html += '<button class="dl-btn primary" id="dl-open">打开</button>' +
          '<button class="dl-btn" id="dl-folder" title="打开所在文件夹">文件夹</button>';
      }
    }
    html += "</div>";

    // 第二行：进度条（单独一行，拉满）+ 右侧百分比/大小
    html += '<div class="dl-row2">';
    html += '<div class="dl-track"><div class="' + barClass + '" style="width:' + barWidth + '%"></div></div>';
    html += '<span class="dl-progress-top"><span class="dl-pct">' + esc(pctText) + '</span><span class="dl-size">' + esc(sizeText2) + '</span></span>';
    html += "</div>";
    // 元信息行（速度 · 剩余 · 阶段），仅在非空时输出，避免空白行
    if (metaText) {
      html += '<div class="dl-metarow">' + esc(metaText) + "</div>";
    }

    // 详情区（折叠展开时显示）
    html += '<div class="dl-detail">';
    html += '<div class="dl-d-row"><span class="dl-d-label">文件</span><span class="dl-d-value">' + esc(t.fileName || "—") + "</span></div>";
    if (filePath) html += '<div class="dl-d-row"><span class="dl-d-label">路径</span><span class="dl-d-value">' + esc(filePath) + "</span></div>";
    // 复制路径从首行下沉到详情区：卡宽受宿主任务族统一宽度（348px）限制，
    // 首行只留最常用的两个操作。（2026-09-10 用户要求）
    html += '<div class="dl-d-row"><span class="dl-d-label">操作</span><span class="dl-d-value">' +
      '<button class="dl-btn dl-copy" id="dl-copy">复制路径</button></span></div>';
    if (known) {
      // 命令型任务（unit≠bytes）：详情大小按单位显示（对象/文件/包），不走字节格式化
      var sizeDetail = (t.unit && t.unit !== "bytes")
        ? t.total + (UNIT_NAME[t.unit] ? " " + UNIT_NAME[t.unit] : "")
        : fmtBytes(t.total);
      if (running && t.received != null) sizeDetail += (t.unit && t.unit !== "bytes" ? "（已完成 " + t.received + "）" : "（已下载 " + fmtBytes(t.received) + "）");
      html += '<div class="dl-d-row"><span class="dl-d-label">大小</span><span class="dl-d-value">' + esc(sizeDetail) + "</span></div>";
    }
    html += '<div class="dl-d-row"><span class="dl-d-label">任务</span><span class="dl-d-value">' + esc(t.taskId || taskId) + "</span></div>";
    html += '<div class="dl-d-row"><span class="dl-d-label">状态</span><span class="dl-d-value">' + esc(badge) + (metaText ? "（" + esc(metaText) + "）" : "") + "</span></div>";
    if (running && known && t.speed > 0 && t.received < t.total) {
      var remainSec = Math.max(0, (t.total - t.received) / t.speed);
      var etaAbs = new Date(Date.now() + remainSec * 1000);
      var hh = String(etaAbs.getHours()).padStart(2, "0");
      var mm = String(etaAbs.getMinutes()).padStart(2, "0");
      html += '<div class="dl-d-row"><span class="dl-d-label">预计</span><span class="dl-d-value">' + hh + ":" + mm + " 完成（剩" + fmtDuration(remainSec) + "）</span></div>";
    }
    html += "</div>";

    if (state === "failed" || state === "interrupted") {
      html += '<div class="dl-error">' + esc(t.error || "下载失败") + "</div>";
    }
    html += "</div>";

    if (root.innerHTML !== html) root.innerHTML = html;

    reportSize();

    var foldBtn = document.getElementById("dl-fold");
    if (foldBtn) foldBtn.addEventListener("click", toggleFold);
    var allBtn = document.getElementById("dl-all");
    if (allBtn) allBtn.addEventListener("click", toggleAll);

    var cancelBtn = document.getElementById("dl-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", cancel);
    var openBtn = document.getElementById("dl-open");
    if (openBtn) openBtn.addEventListener("click", function () { openFile(filePath); });
    var folderBtn = document.getElementById("dl-folder");
    if (folderBtn) folderBtn.addEventListener("click", function () { openFolder(filePath); });
    var copyBtn = document.getElementById("dl-copy");
    if (copyBtn) copyBtn.addEventListener("click", function () { copyPath(filePath); });

    lastState = state;
  }

  function renderFail(msg) {
    root.innerHTML = '<div class="dl"><div class="dl-error">' + esc(msg) + "</div></div>";
  }

  function renderHint(msg) {
    var div = document.createElement("div");
    div.className = "dl-hint";
    div.textContent = msg;
    var actions = root.querySelector(".dl-actions");
    if (actions) actions.appendChild(div);
  }

  function stateBadge(s) {
    return { running: "下载中", pending: "准备中", done: "完成", failed: "失败", canceled: "已取消", interrupted: "已中断", stalled: "停滞" }[s] || s;
  }

  // ── 工具函数 ──
  var STAGE_TEXT = {
    receiving: "接收中", checkout: "检出中", fetching: "拉取中", linking: "链接中",
    building: "编译中", "resolving-deps": "解析依赖", cloning: "准备克隆",
    enumerating: "枚举对象", resolving: "解析增量", finalizing: "收尾",
  };
  function fmtBytes(n) {
    if (n == null) return "—";
    if (n < 1024) return n + "B";
    var units = ["KB", "MB", "GB", "TB"];
    var v = n, i = -1;
    do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + units[i];
  }

  function fmtDuration(sec) {
    if (sec < 60) return Math.max(1, Math.round(sec)) + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    return (sec / 3600).toFixed(1) + "h";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>';

  // ── 启动 ──
  window.addEventListener("load", function () { setTimeout(reportSize, 60); });
  poll();
  timer = setInterval(poll, 600);
})();
