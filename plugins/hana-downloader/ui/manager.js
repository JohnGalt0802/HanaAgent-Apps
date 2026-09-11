// manager.js — Hana 下载管理器（跨会话）
// 轮询 /download/list 获取所有会话的下载任务，列表 + 筛选 + 详情 + 操作。
// 与 card.js 同款 mini host SDK（@hana/plugin-sdk 协议兼容，免构建）。

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

  // 宿主主题切换监听：兼容不同 payload 形状，收到后更新 data-hana-theme + t-dark + 重渲染
  window.addEventListener("message", function (ev) {
    try {
      var md = ev.data;
      if (!md || typeof md !== "object") return;
      var th = "";
      if (md.type === "hana.theme.changed") { th = md.theme || (md.payload && md.payload.theme) || ""; }
      else if (md.type === "theme-changed") { th = md.theme || (md.payload && md.payload.theme) || ""; }
      else if (!th && md.theme) th = md.theme;
      if (!th) return;
      document.body.setAttribute("data-hana-theme", th);
      var dark = /dark|midnight|contrast|深|夜/i.test(th);
      document.body.classList.toggle("t-dark", dark);
      if (typeof render === "function") { try { render(); } catch (e) { /* 忽略 */ } }
    } catch (e3) { /* 忽略 */ }
  });

  var API = window.__API || "";
  var pageParams = new URLSearchParams(location.search);
  // 凭据：统一由 hdboot.js 包在 window.fetch 上注入（X-Hana-App-Surface-Session）。
  // 旧插件时代的 token / pluginSurfaceSession 逻辑已删除（2026-09-11 清理）。

  var POLL_MS = 3000;
  var tasks = [];
  var filter = "all"; // all | active | done | failed
  var search = ""; // 搜索关键词
  var expanded = null; // taskId 展开详情
  var settings = {}; // 插件设置（defaultSaveDir / agentChooses）

  function apiUrl(path) {
    return API + path;
  }

  function apiFetch(path, init) {
    return fetch(apiUrl(path), Object.assign({}, init || {}));
  }

  // ── mini host SDK ──
  var PARENT = window.parent;
  var HOST_ORIGIN = pageParams.get("hana-host-origin") || "*";
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

  function reportSize() {
    try {
      var h = Math.ceil(document.body ? document.body.scrollHeight : 0);
      if (!h || h < 60) h = 60;
      // 高度不设插件侧上限：报告真实内容高度，由宿主（卡片上限 600）决定最终尺寸
      PARENT.postMessage(
        { protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { width: 400, height: h } },
        HOST_ORIGIN
      );
    } catch (e) { /* 忽略 */ }
  }

  // ── 格式化 ──
  function fmtBytes(n) {
    if (n == null || !isFinite(n) || n <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + " " + units[i];
  }
  function fmtSpeed(s) {
    if (!s || s <= 0) return "";
    return fmtBytes(s) + "/s";
  }
  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  function fmtDuration(ms) {
    if (!ms || ms <= 0) return "";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + "m" + (r ? r + "s" : "");
    var h = Math.floor(m / 60); m = m % 60;
    return h + "h" + m + "m";
  }
  function shortPath(p) {
    if (!p) return "";
    var parts = p.split(/[\\/]/);
    return parts.slice(0, -1).join("/").length > 30
      ? "…" + parts.slice(-3).join("/")
      : p;
  }
  function sessionLabel(t) {
    if (t.sessionPath) {
      var sp = String(t.sessionPath).split(/[\\/]/).pop() || "";
      return sp.replace(/\.jsonl$/i, "");
    }
    if (t.sessionId) return String(t.sessionId).slice(0, 12);
    return "未知会话";
  }

  // ── 渲染 ──
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function stateMeta(t) {
    switch (t.state) {
      case "running": return { label: "下载中", cls: "st-running" };
      case "pending": return { label: "准备中", cls: "st-pending" };
      case "done": return { label: "完成", cls: "st-done" };
      case "failed": return { label: "失败", cls: "st-failed" };
      case "canceled": return { label: "已取消", cls: "st-canceled" };
      case "interrupted": return { label: "已中断", cls: "st-interrupted" };
      default: return { label: t.state || "未知", cls: "st-unknown" };
    }
  }

  function render() {
    var listEl = document.getElementById("mgr-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    var visible = tasks.filter(function (t) {
      if (filter === "all") return true;
      if (filter === "active") return t.state === "running" || t.state === "pending";
      if (filter === "done") return t.state === "done";
      if (filter === "failed") return t.state === "failed" || t.state === "canceled" || t.state === "interrupted";
      return true;
    }).filter(function (t) {
      if (!search) return true;
      var q = search.toLowerCase();
      return (t.fileName || "").toLowerCase().indexOf(q) >= 0
        || (t.url || "").toLowerCase().indexOf(q) >= 0
        || (t.filePath || "").toLowerCase().indexOf(q) >= 0
        || (t.error || "").toLowerCase().indexOf(q) >= 0;
    });

    if (visible.length === 0) {
      var empty = el("div", "mgr-empty", "暂无下载任务");
      listEl.appendChild(empty);
      reportSize();
      return;
    }

    visible.forEach(function (t) {
      var row = el("div", "mgr-row" + (t.state === "done" ? " mgr-row-done" : (t.state === "failed" || t.state === "canceled" || t.state === "interrupted") ? " mgr-row-fail" : ""));
      // 整行进度背景：下载任务行即进度条（背景按百分比填充）
      if (t.state === "running" || t.state === "pending") {
        var rowPct = t.total ? Math.min(100, (t.received / t.total) * 100) : 0;
        var rowBg = el("div", "mgr-row-bg");
        rowBg.style.width = (t.total ? rowPct : 5) + "%";
        if (!t.total && t.state === "running") rowBg.classList.add("indet");
        row.appendChild(rowBg);
      }
      var isExpanded = expanded === t.taskId;
      var st = stateMeta(t);

      var head = el("div", "mgr-head");
      if (isExpanded) head.classList.add("open");

      var main = el("div", "mgr-main");
      var nameRow = el("div", "mgr-name-row");
      var badge = el("span", "mgr-badge " + st.cls, st.label);
      var name = el("span", "mgr-name", t.fileName || t.taskId);
      nameRow.appendChild(badge);
      nameRow.appendChild(name);

      var metaRow = el("div", "mgr-meta");
      var metaBits = [];
      if (t.state === "running") {
        if (t.speed) metaBits.push(fmtSpeed(t.speed));
        metaBits.push(t.total ? (t.percent != null ? t.percent + "%" : "") : fmtBytes(t.received));
      } else if (t.state === "done") {
        metaBits.push(fmtBytes(t.total || t.received));
        if (t.elapsed) metaBits.push(fmtDuration(t.elapsed));
      } else if (t.error) {
        metaBits.push(t.error);
      }
      metaBits.push(sessionLabel(t));
      metaBits.push(fmtTime(t.finishedAt || t.startedAt));
      metaRow.textContent = metaBits.filter(Boolean).join(" · ");

      main.appendChild(nameRow);
      main.appendChild(metaRow);

      var actions = el("div", "mgr-actions");
      // 主按钮：打开文件；旁边小箭头展开下拉（打开文件 / 打开所在文件夹）
      var btnOpen = el("button", "mgr-btn mgr-open-main", "打开");
      btnOpen.onclick = function (e) { e.stopPropagation(); openFile(t); };
      var btnMore = el("button", "mgr-btn mgr-more", "▾");
      btnMore.title = "更多操作";
      btnMore.onclick = function (e) {
        e.stopPropagation();
        if (rowMenuEl && rowMenuEl.style.display === "block" && rowMenuTask === t) {
          closeRowMenu();
        } else {
          closeRowMenu();
          openRowMenu(actions, t);
        }
      };
      actions.appendChild(btnOpen);
      actions.appendChild(btnMore);
      if (t.state === "running" || t.state === "pending") {
        var btnCancel = el("button", "mgr-btn mgr-btn-danger", "取消");
        btnCancel.onclick = function (e) { e.stopPropagation(); cancelTask(t); };
        actions.appendChild(btnCancel);
      }

      head.appendChild(main);
      head.appendChild(actions);
      head.onclick = function () {
        expanded = expanded === t.taskId ? null : t.taskId;
        render();
      };

      row.appendChild(head);

      if (isExpanded) {
        var detail = el("div", "mgr-detail");
        var rows = [
          ["任务 ID", t.taskId],
          ["下载地址", t.url || "—"],
          ["保存位置", shortPath(t.filePath || "")],
          ["来源会话", sessionLabel(t)],
          ["开始时间", t.startedAt ? new Date(t.startedAt).toLocaleString() : "—"],
          ["结束时间", t.finishedAt ? new Date(t.finishedAt).toLocaleString() : "—"],
          ["耗时", fmtDuration(t.elapsed) || "—"],
          ["状态", st.label + (t.error ? "：" + t.error : "")],
        ];
        rows.forEach(function (r) {
          var dRow = el("div", "mgr-detail-row");
          var k = el("span", "mgr-detail-k", r[0]);
          var v = el("span", "mgr-detail-v", r[1]);
          dRow.appendChild(k);
          dRow.appendChild(v);
          detail.appendChild(dRow);
        });
        row.appendChild(detail);
      }

      listEl.appendChild(row);
    });

    reportSize();
  }

  // ── 行内下拉菜单（body 级单例，避免 render 重建列表时被销毁）──
  var rowMenuEl = null;
  var rowMenuTask = null;
  function ensureRowMenu() {
    if (rowMenuEl) return rowMenuEl;
    rowMenuEl = el("div", "mgr-row-menu");
    var opt1 = el("button", "mgr-row-menu-opt", "打开文件");
    opt1.onclick = function (e) { e.stopPropagation(); var t = rowMenuTask; closeRowMenu(); if (t) openFile(t); };
    var opt2 = el("button", "mgr-row-menu-opt", "打开所在文件夹");
    opt2.onclick = function (e) { e.stopPropagation(); var t = rowMenuTask; closeRowMenu(); if (t) reveal(t); };
    rowMenuEl.appendChild(opt1);
    rowMenuEl.appendChild(opt2);
    document.body.appendChild(rowMenuEl);
    // 全局点击关闭
    document.addEventListener("click", function (ev) {
      if (rowMenuEl && rowMenuEl.style.display !== "none" && !rowMenuEl.contains(ev.target)) {
        closeRowMenu();
      }
    });
    return rowMenuEl;
  }
  function openRowMenu(anchorEl, t) {
    rowMenuTask = t;
    var menu = ensureRowMenu();
    // 定位（fixed 相对视口）
    var r = anchorEl.getBoundingClientRect();
    var mw = menu.offsetWidth || 150;
    var mh = menu.offsetHeight || 70;
    var left = r.right - mw;
    if (left < 8) left = 8;
    var top = r.bottom + 2;
    if (top + mh > (window.innerHeight || 600) - 8) top = r.top - mh - 2;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.display = "block";
  }
  function closeRowMenu() {
    if (rowMenuEl) rowMenuEl.style.display = "none";
    rowMenuTask = null;
  }

  // ── 筛选下拉（body 单例：双击筛选按钮弹出，清空记录 / 全部取消）──
  var filterMenuEl = null;
  var filterMenuItems = null; // 下拉项配置
  function ensureFilterMenu() {
    if (filterMenuEl) return filterMenuEl;
    filterMenuEl = el("div", "mgr-row-menu mgr-filter-menu");
    document.body.appendChild(filterMenuEl);
    document.addEventListener("click", function (ev) {
      if (filterMenuEl && filterMenuEl.style.display !== "none" && !filterMenuEl.contains(ev.target)) {
        closeFilterMenu();
      }
    });
    return filterMenuEl;
  }
  function openFilterMenu(anchorEl, opts, ev) {
    filterMenuItems = opts;
    var menu = ensureFilterMenu();
    menu.innerHTML = "";
    (opts || []).forEach(function (it) {
      var o = el("button", "mgr-row-menu-opt", it.label);
      o.onclick = function (e) { e.stopPropagation(); closeFilterMenu(); if (it.onclick) it.onclick(); };
      menu.appendChild(o);
    });
    // 先显示但用 visibility 隐藏，量取真实宽高，避免 offsetWidth=0 兜底导致偏移
    menu.style.visibility = "hidden";
    menu.style.display = "block";
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var r = anchorEl.getBoundingClientRect();
    // 健壮性：锚点若已脱离布局（矩形全 0），改用指针坐标定位，
    // 否则居中计算会得到负数，被边界一把兜到最左侧。（2026-09-10）
    if (!r.width && !r.height && ev && ev.clientX) {
      r = { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY, width: 0, height: 0 };
    }
    var vw = window.innerWidth || 400;
    // 下拉优先在按钮正上方居中：bottom 贴按钮 top，水平中心对齐按钮中心
    var left = r.left + (r.width / 2) - (mw / 2);
    // 边界收敛：左右越界时贴边，但不退回 0（否则菜单会跑到卡片最左侧）
    var maxLeft = vw - 8 - mw;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    if (left < 8) left = Math.min(8, Math.max(0, r.left));
    var top = r.top - mh - 4;
    if (top < 8) top = r.top + r.height + 4; // 上方放不下改下方
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "";
  }
  function closeFilterMenu() {
    if (filterMenuEl) filterMenuEl.style.display = "none";
    filterMenuItems = null;
  }

  // 清空记录：调用后端 /download/clear 清当前分类终态
  function clearStates(states) {
    if (!states || !states.length) return;
    apiFetch("/download/clear", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: states }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // 诊断：后端返回 diag 时一并展示（hasClear 等），便于定位模块缓存问题
        var diag = data && data.diag ? "  [diag:" + (data.diag.hasClear ? "clear=YES" : "clear=NO") + "/" + (data.diag.hasCancelAll ? "cancelAll=YES" : "cancelAll=NO") + "]" : "";
        if (data && data.ok) { hint("已清空 " + (data.removed ? data.removed.length : 0) + " 条记录"); poll(); }
        else { hint("清空失败：" + ((data && data.error) || "未知错误") + diag); }
      })
      .catch(function () { hint("清空失败：网络错误"); });
  }
  // 全部取消在途
  function cancelAllActive() {
    apiFetch("/download/cancel-all", { method: "POST", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) { hint("已取消 " + (data.canceled ? data.canceled.length : 0) + " 个在途任务"); poll(); }
        else { hint("取消失败：" + ((data && data.error) || "未知错误")); }
      })
      .catch(function () { hint("取消失败：网络错误"); });
  }

  function renderFilterBar() {
    var bar = document.getElementById("mgr-filters");
    if (!bar) return;
    bar.innerHTML = "";
    var items = [
      ["all", "全部"],
      ["active", "在途"],
      ["done", "已完成"],
      ["failed", "失败/取消"],
    ];
    // 终态全集（供“全部”清空）
    var FINAL_ALL = ["done", "failed", "canceled", "interrupted"];
    items.forEach(function (it) {
      var b = el("button", "mgr-filter" + (filter === it[0] ? " active" : ""), it[0] === "all" ? it[1] + " (" + tasks.length + ")" : it[1]);
      b.onclick = function () { filter = it[0]; expanded = null; renderFilterBar(); render(); };
      // 双击弹出下拉：不同分类给不同操作（在途→全部取消；其余→清空记录）
      b.ondblclick = function (e) {
        e.stopPropagation();
        var opts = [];
        if (it[0] === "all") {
          opts.push({ label: "清空全部记录（已结束）", onclick: function () { clearStates(FINAL_ALL); } });
        } else if (it[0] === "active") {
          opts.push({ label: "全部取消", onclick: function () { cancelAllActive(); } });
        } else if (it[0] === "done") {
          opts.push({ label: "清空完成记录", onclick: function () { clearStates(["done"]); } });
        } else if (it[0] === "failed") {
          opts.push({ label: "清空失败/取消记录", onclick: function () { clearStates(["failed", "canceled", "interrupted"]); } });
        }
        if (!opts.length) return;
        openFilterMenu(b, opts, e);
      };
      bar.appendChild(b);
    });
  }

  // 搜索框：输入即筛选；点叉号清空恢复全部
  function renderSearchBar() {
    var wrap = document.getElementById("mgr-search");
    if (!wrap) return;
    wrap.innerHTML = "";
    var box = el("div", "mgr-search-box");
    var icon = el("span", "mgr-search-icon", "⌕");
    var input = el("input", "mgr-search-input");
    input.type = "text";
    input.placeholder = "搜索文件名 / 地址 / 路径…";
    input.value = search;
    input.oninput = function () { search = input.value.trim(); render(); };
    input.onkeydown = function (e) { if (e.key === "Escape") { search = ""; input.value = ""; render(); } };
    var clearBtn = el("button", "mgr-search-clear" + (search ? " show" : ""), "×");
    clearBtn.title = "清除搜索";
    clearBtn.onclick = function () { search = ""; input.value = ""; clearBtn.classList.remove("show"); render(); };
    box.appendChild(icon);
    box.appendChild(input);
    box.appendChild(clearBtn);
    wrap.appendChild(box);
  }

  // 设置菜单：文件夹图标 + 两个选项（设置默认下载地址 / 助手选择下载地址）
  function renderSettingsMenu() {
    var wrap = document.getElementById("mgr-settings");
    if (!wrap) return;
    wrap.innerHTML = "";
    var btn = el("button", "mgr-settings-btn");
    btn.title = "下载地址设置";
    // 内联 SVG：文件夹线性图标（stroke currentColor，跟随主题）
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
    btn.onclick = function (e) {
      e.stopPropagation();
      var open = wrap.classList.toggle("open");
      if (open) {
        loadSettings(function () {
          var menu = wrap.querySelector(".mgr-settings-menu");
          if (menu) renderSettingsOptions(menu);
        });
      }
    };
    var menu = el("div", "mgr-settings-menu");
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    document.addEventListener("click", function closeMenu(ev) {
      if (!wrap.contains(ev.target)) {
        wrap.classList.remove("open");
        document.removeEventListener("click", closeMenu);
      }
    });
  }

  function closeSettingsMenu() {
    var w = document.getElementById("mgr-settings");
    if (w) w.classList.remove("open");
  }

  function renderSettingsOptions(menu) {
    menu.innerHTML = "";
    var modeDesc = settings.agentChooses ? "当前：助手选择下载地址" : (settings.defaultSaveDir ? "当前：" + settings.defaultSaveDir : "当前：插件默认目录");
    var desc = el("div", "mgr-settings-desc", modeDesc);
    menu.appendChild(desc);

    var opt1 = el("button", "mgr-settings-opt" + (!settings.agentChooses && settings.defaultSaveDir ? " active" : ""), "设置默认下载地址");
    opt1.title = "设置后所有文件统一下载到这里";
    opt1.onclick = function (e) {
      e.stopPropagation(); // 防止外部点击监听误关菜单
      // 宿主目录选择（resource.pick / mode=directory）；宿主不可用时回退 prompt
      hostRequest("resource.pick", { mode: "directory" })
        .then(function (res) {
          var dir = res && res.resources && res.resources[0] && res.resources[0].path;
          if (!dir) return;
          return apiFetch("/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ defaultSaveDir: dir, agentChooses: false }),
          }).then(function (r) { return r.json(); });
        })
        .then(function (data) {
          if (!data) return;
          if (data.ok) { settings = data.settings; renderSettingsOptions(menu); closeSettingsMenu(); hint("已设置默认下载目录"); }
          else hint("设置失败：" + (data.error || "未知错误"));
        })
        .catch(function () {
          // 宿主不可用 → prompt 手动输入
          var d = window.prompt("默认下载目录（绝对路径）", settings.defaultSaveDir || "");
          if (d == null) return;
          apiFetch("/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ defaultSaveDir: d.trim(), agentChooses: false }),
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.ok) { settings = data.settings; renderSettingsOptions(menu); closeSettingsMenu(); hint("已设置默认下载目录"); }
              else hint("设置失败：" + (data.error || "未知错误"));
            })
            .catch(function () { hint("设置失败：网络错误"); });
        });
    };

    var opt2 = el("button", "mgr-settings-opt" + (settings.agentChooses ? " active" : ""), "助手选择下载地址");
    opt2.title = "下载位置由 Agent 自行决定，更自由";
    opt2.onclick = function (e) {
      e.stopPropagation(); // 防止外部点击监听误关菜单
      apiFetch("/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentChooses: true }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) { settings = data.settings; renderSettingsOptions(menu); closeSettingsMenu(); hint("已切换为助手选择下载地址"); }
          else hint("设置失败：" + (data.error || "未知错误"));
        })
        .catch(function () { hint("设置失败：网络错误"); });
    };

    menu.appendChild(opt1);
    menu.appendChild(opt2);
  }

  function loadSettings(cb) {
    apiFetch("/settings", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data.ok) settings = data.settings || {}; cb && cb(); })
      .catch(function () { cb && cb(); });
  }

  // ── 操作 ──
  function hint(text) {
    var h = el("div", "mgr-hint", text);
    document.body.appendChild(h);
    setTimeout(function () { h.remove(); }, 3000);
  }
  function openFile(t) {
    if (!t || !t.filePath) { hint("该任务没有可打开的文件路径"); return; }
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: t.filePath, mode: "open" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) hint(d.error || "打开失败"); })
      .catch(function () { hint("打开失败：网络错误"); });
  }
  function reveal(t) {
    if (!t || !t.filePath) { hint("该任务没有可打开的文件路径"); return; }
    // 服务端 explorer /select 定位文件并打开所在文件夹（绕过宿主 platform 限制）
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: t.filePath }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) hint((d.error) || "打开文件夹失败"); })
      .catch(function () { hint("打开文件夹失败：网络错误"); });
  }
  function openFolder(dir) {
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) hint((d.error) || "打开文件夹失败"); })
      .catch(function () { hint("打开文件夹失败：网络错误"); });
  }
  function copyPath(t) {
    hostRequest("clipboard.writeText", { text: t.filePath || "" }).catch(function () {});
  }
  function cancelTask(t) {
    apiFetch("/download/cancel?taskId=" + encodeURIComponent(t.taskId), { method: "POST", cache: "no-store" })
      .then(function () { poll(); })
      .catch(function () {});
  }

  // ── 轮询 ──
  var timer = null;
  function poll() {
    apiFetch("/download/list", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) return;
        var prevStates = {};
        tasks.forEach(function (t) { prevStates[t.taskId] = t.state; });
        tasks = data.tasks || [];
        // 展开项若已不存在则收起
        if (expanded && !tasks.some(function (t) { return t.taskId === expanded; })) expanded = null;
        var changed = tasks.some(function (t) { return prevStates[t.taskId] !== t.state; })
          || Object.keys(prevStates).length !== tasks.length;
        renderFilterBar();
        render();
        if (!changed) { /* 静默刷新，不重排视觉；render 已处理 */ }
      })
      .catch(function () { /* 网络错误静默重试 */ });
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function start() {
    if (timer) clearInterval(timer);
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  // ── 顶部计数 ──
  function renderCounts() {
    var c = document.getElementById("mgr-counts");
    if (!c) return;
    var running = tasks.filter(function (t) { return t.state === "running"; }).length;
    var done = tasks.filter(function (t) { return t.state === "done"; }).length;
    var failed = tasks.filter(function (t) { return t.state === "failed" || t.state === "canceled" || t.state === "interrupted"; }).length;
    c.innerHTML = "";
    var bits = [];
    if (running) bits.push('<span class="cnt-running">' + running + ' 下载中</span>');
    bits.push('<span class="cnt-done">' + done + ' 完成</span>');
    if (failed) bits.push('<span class="cnt-failed">' + failed + ' 异常</span>');
    c.innerHTML = bits.join(" · ");
  }

  // ── 初始化 ──
  function init() {
    // 顶部工具条：设置按钮 + 搜索框 + 计数器
    var toolbar = el("div", "mgr-toolbar");
    var settingsWrap = el("div", "mgr-settings");
    settingsWrap.id = "mgr-settings";
    var searchWrap = el("div", "mgr-search");
    searchWrap.id = "mgr-search";
    var counts = el("div", "mgr-counts");
    counts.id = "mgr-counts";
    toolbar.appendChild(settingsWrap);
    toolbar.appendChild(searchWrap);
    toolbar.appendChild(counts);

    var filters = el("div", "mgr-filters");
    filters.id = "mgr-filters";
    var list = el("div", "mgr-list");
    list.id = "mgr-list";
    var root = document.getElementById("dl-root");
    if (!root) return;
    root.appendChild(toolbar);
    root.appendChild(filters);
    root.appendChild(list);

    renderSettingsMenu();
    renderSearchBar();

    // 每轮渲染后更新计数与搜索清除钮状态
    var origRender = render;
    render = function () {
      origRender();
      renderCounts();
      var cb = document.querySelector(".mgr-search-clear");
      if (cb) cb.classList.toggle("show", !!search);
    };

    start();
    reportSize();
    // resize 时重报一次高度（宿主裁剪/调整 iframe 后，body 内容不变则报告值稳定，无循环风险）
    window.addEventListener("resize", function () { reportSize(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
