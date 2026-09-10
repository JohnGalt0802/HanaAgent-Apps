// hana-downloader-app/ui/hdboot.js — 界面适配层
//
// 动机：卡片/管理页的前端是从插件时代原样搬过来的，它假定：
//   1. window.__API 已由宿主注入（v2 app 不注入，要自己取）
//   2. 接口是 /download/status?taskId=... 这类 GET+query（宿主的运行时路由吃不下 query）
//   3. 服务端就是宿主路由（现在是 local-machine 受管引擎，路径也不同）
//
// 这一层只做三件事：取引擎基址、把引擎基址按时序准备好、把旧请求重写成新 API。
// 业务代码一行不改。
//
// 2026-09-10：基址由 runtime 服务代理（/routes/_runtime/<rid>/）改为 app 自己的转发路由
// （/routes/engine/）。原因：ctx.runtime.start({service}) 会保持一条常驻 RPC，卡死 app 工具
// 回程前的 rpc2.drain()，使工具报 30s 超时；已改为引擎自监听 + ctx.network.fetch。
(function () {
  var APP_BASE = location.pathname.replace(/\/ui\/.*$/, "") || "";
  // __API 已由页面内联脚本同步写好（见 card.html / manager.html）。
  // 这里只做兜底：页面没写时用 App 路由前缀拼。同步可用，业务脚本不会拿到空值。
  var base = window.__API || (APP_BASE + "/routes/engine/");
  window.__API = base;
  var baseReady = Promise.resolve(base);

  // ── 主题 ──
  // 旧插件：服务端读 ?hana-theme= 写进 body 的 data-hana-theme。
  // v2 静态页拿不到服务端渲染，所以这里从 URL 参数自己读（宿主若下发就生效），
  // 同时保留对 message 事件（hana.theme.changed / theme-changed）的兼容（card.js/manager.js 已各自监听）。
  (function applyThemeFromUrl() {
    try {
      var q = new URLSearchParams(location.search);
      var theme = q.get("hana-theme") || "";
      var css = q.get("hana-css") || "";
      if (theme) document.body.setAttribute("data-hana-theme", theme);
      var dark = /dark|midnight|contrast|深|夜/i.test(theme);
      if (!theme || theme === "inherit") {
        dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      }
      document.body.classList.toggle("t-dark", dark);
      // 宿主样式表（旧版由服务端挂在 <head>）
      if (css) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = css;
        document.head.appendChild(link);
      }
    } catch (e) { /* 忽略 */ }
  })();

  // ── App surface session（iframe 票据）──
  // 宿主要求：请求走 /api/apps/<id>/routes/ 时必须带 host 登录态，或回传随 iframe URL
  // 下发的 appSurfaceSession。两条都没有就 403 missing_credential。
  // 旧插件的 LOOPBACK_TOKEN 就是这一层；v2 换成了 appSurfaceSession。
  var SURFACE_SESSION = new URLSearchParams(location.search).get("appSurfaceSession") || "";

  // 给每次请求补上票据头（不改调用方传的 headers，复制一份）
  function withCred(init) {
    var src = (init && init.headers) || {};
    var h;
    try { h = new Headers(src); } catch (e) { h = new Headers(); }
    if (SURFACE_SESSION && !h.has("X-Hana-App-Surface-Session")) {
      h.set("X-Hana-App-Surface-Session", SURFACE_SESSION);
    }
    return Object.assign({}, init || {}, { headers: h });
  }

  function qs(u) { try { return new URLSearchParams(u.split("?")[1] || ""); } catch (e) { return new URLSearchParams(""); } }

  // 旧路径 → 新 API 的映射（含 query → body 的搬运）
  var MAP = {
    "/download/status":     { path: "wait",        method: "POST", fromQuery: "taskId" },
    "/download/cancel":     { path: "cancel",      method: "POST", fromQuery: "taskId" },
    "/download/reveal":     { path: "reveal",      method: "POST" },
    "/download/list":       { path: "list",        method: "GET" },
    "/download/clear":      { path: "clear",       method: "POST" },
    "/download/cancel-all": { path: "cancel-all",  method: "POST" },
    "/download/start":      { path: "download",    method: "POST" },
    "/download/prepare":    { path: "download",    method: "POST" },
    "/settings":            { path: "settings",    method: null },
    "/diag":                { path: "ping",        method: "GET" }
  };

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var isReq = typeof Request !== "undefined" && input instanceof Request;
    var url = isReq ? input.url : String(input || "");
    var init2 = Object.assign({}, isReq ? { method: input.method, headers: input.headers, body: input.body } : {}, init || {});

    if (!origFetch || !url || /^https?:/i.test(url)) return origFetch ? origFetch(input, withCred(init2)) : Promise.reject(new Error("no fetch"));

    var path = url.split("?")[0];
    // 前端（card.js/manager.js）会把请求拼成 API + path，即
    // /api/apps/<id>/routes/engine//download/status —— 先把基址前缀剥掉，
    // 再走下面的映射表；否则会当成“已含基址”的网址丢给引擎，落到 /status 上 404。
    if (base && path.indexOf(base) === 0) {
      path = "/" + path.slice(base.length).replace(/^\/+/, "");
      url = base + path.slice(1) + (url.indexOf("?") >= 0 ? url.slice(url.indexOf("?")) : "");
    } else if (base) {
      // 兼容：路径带重复斜杠（API + "/xxx"）时归一
      path = path.replace(/^\/{2,}/, "/");
    }

    return baseReady.then(function (b) {
      var rule = MAP[path];
      if (!rule) return origFetch(b + path.replace(/^\//, "") + (url.indexOf("?") >= 0 ? url.slice(url.indexOf("?")) : ""), withCred(init2));

      var target = b + rule.path;
      var method = rule.method || init2.method || "GET";

      // query → JSON body（宿主的运行时路由不接受 query）
      if (rule.fromQuery) {
        var q = qs(url);
        var body = {};
        q.forEach(function (v, k) { body[k] = v; });
        // 已有 body 时合并
        if (init2.body && typeof init2.body === "string") {
          try { Object.assign(body, JSON.parse(init2.body)); } catch (e) {}
        }
        var h = new Headers(init2.headers || {});
        h.set("content-type", "application/json");
        return origFetch(target, withCred({ method: "POST", headers: h, body: JSON.stringify(body), cache: "no-store" }));
      }

      if (method === "POST" && init2.body && typeof init2.body === "string") {
        var h2 = new Headers(init2.headers || {});
        if (!h2.has("content-type")) h2.set("content-type", "application/json");
        return origFetch(target, withCred({ method: "POST", headers: h2, body: init2.body, cache: "no-store" }));
      }

      return origFetch(target, withCred({ method: method, headers: init2.headers, cache: "no-store" }));
    });
  };

  // 暴露给页面做诊断
  window.__hdBoot = {
    appBase: APP_BASE,
    ready: baseReady,
    currentBase: function () { return base; },
    hasSurfaceSession: !!SURFACE_SESSION,
    surfaceSessionLen: SURFACE_SESSION.length,
    search: location.search,
  };
})();
