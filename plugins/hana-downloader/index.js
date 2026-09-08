// index.js — hana-downloader v0.14.0 v2 plugin lifecycle（零依赖版）
//
// 投递架构（v0.14.0，宿主 0.928.0）：
//   - lib/delivery.js 是唯一投递权威：订阅 mgr.onFinal/onStall。
//   - 真同步注入：onload 注册 agent/pre-step adjudicator，宿主在下一条 LLM API 请求组装前
//     dispatch，我们把 pending 里的 hana-background-result 拼进 messages → 未收束会话
//     的 agent 下一次思考即感知（不打断当前流式回复）。
//     通道优先级：v2 ctx.hooks（宿主原生正门，抗宿主更新）→ globalThis.__sessionHooks（bundle 魔改通道）。
//   - 已收束会话：deferred:register + deferred:resolve，宿主 dispatcher 接管（followUp/triggerTurn）。
//   - session:send 通道已废弃（0.928.0 下 agent 活跃期恒 session_busy；v2 app steer 被归属校验封死）。
//
// v2 plugin 协议（manifestVersion=2）：
//   - entry 字段入口（不是顶层 tools/cards/routes）。
//   - host 调 `new a()` + `c.ctx = e.ctx` + `c.register = (l) => {...}` + `c.onload()`。
//   - 不依赖任何外部包（host 不在 community 槽自动安装 node_modules）。
//   - ctx.bus 自动注入 caller: {kind: "plugin", pluginId}（bc() 在 host 视为 null）。
//   - 工具 (tools/) + 路由 (routes/) + 命令 (commands/) + 扩展 (extensions/) 由 host 自动加载。
import { getTaskManager } from "./lib/dlcore.js";
import { createDelivery } from "./lib/delivery.js";
import { registerHandler } from "./lib/registry.js";

export default class HanaDownloaderPlugin {
  constructor() {
    this.ctx = null;
    this.register = null; // host 在 new 之后注入 dispose 注册器
  }

  async onload() {
    if (!this.ctx) {
      console.warn("[hana-downloader] onload called without ctx");
      return;
    }
    const ctx = this.ctx;
    const helpers = { register: this.register };
    const { bus, log: logF, dataDir } = ctx;
    const logger = logF || ctx.log || { info() {}, warn() {}, error() {} };

    // 诊断日志（写在插件数据目录下，确认 onload 执行 + v2 plugin ctx 字段）
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dbgLog = (s) => {
      try {
        fs.appendFileSync(path.join(dataDir, "v2-load-debug.log"), `[${new Date().toISOString()}] ${s}\n`);
      } catch {}
    };
    dbgLog(`DBG v2 onload entered | bus=${typeof bus} dataDir=${dataDir} pluginId=${ctx.pluginId}`);

    try {
      // 1) 初始化 TaskManager 单例（globalThis 兜底，避免 plugin 加载器 lib 模块缓存造成多实例）
      const manager = getTaskManager(dataDir);
      manager.restore();
      ctx._dl = manager;
      dbgLog(`DBG manager restored | tasks=${manager.tasks?.size ?? 0}`);

      // 2) 注册 task:register-handler（task.write 权限），让 stop_task 可取消下载。
      //    v2 plugin bus request 自动注入 caller={kind:"plugin",pluginId}，
      //    task.* 协议不需要 verified v2 app caller（仅 task.write 权限校验）。
      try {
        await registerHandler(bus, () => manager);
        dbgLog(`DBG task:register-handler registered`);
      } catch (e) {
        dbgLog(`DBG task:register-handler WARN: ${e?.message || e}`);
        logger.warn?.(`task:register-handler failed: ${e?.message || e}`);
      }

      // 3) 投递层（v0.13.0 deferred 直投）
      //    退旧 delivery 避免 dev 槽重载残留（onStall 多订阅 → 双投 bug）。
      if (ctx._dlDelivery && typeof ctx._dlDelivery.dispose === "function") {
        try { ctx._dlDelivery.dispose(); } catch {}
      }
      ctx._dlDelivery = createDelivery({
        ctx,
        bus,
        manager,
        dataDir,
        log: logger,
      });
      dbgLog(`DBG delivery created (v0.14.0: sync inject + deferred fallback)`);

      // 3-b) 注册 agent/pre-step 真同步注入 adjudicator。
      //      宿主在「下一条 LLM API 请求组装前」dispatch agent/pre-step；我们在这一步把 pending
      //      队列里的 hana-background-result 拼进 messages，agent 无需收束当前会话即可感知。
      dbgLog(`DBG hooks probe | ctx.hooks=${typeof ctx?.hooks} onDecision=${typeof ctx?.hooks?.onDecision} | globalThis.__sessionHooks=${typeof globalThis.__sessionHooks}`);
      let hooksApi = null;
      let hooksSource = "none";
      try {
        if (ctx.hooks && typeof ctx.hooks.onDecision === "function") {
          hooksApi = ctx.hooks;
          hooksSource = "ctx.hooks";
        } else if (globalThis.__sessionHooks && typeof globalThis.__sessionHooks.onDecision === "function") {
          hooksApi = globalThis.__sessionHooks;
          hooksSource = "globalThis.__sessionHooks";
        }
      } catch (e) {
        dbgLog(`DBG hooks probe ERR: ${e?.message || e}`);
      }
      if (hooksApi) {
        try {
          if (ctx._dlHooksDispose) { try { ctx._dlHooksDispose(); } catch {} }
          ctx._dlHooksDispose = hooksApi.onDecision(
            "agent/pre-step",
            async ({ session, messages }) => {
              const sp = session?.sessionPath || session?.sessionFile || null;
              dbgLog(`DBG agent/pre-step called | session=${sp || "?"} msgs=${Array.isArray(messages) ? messages.length : "N/A"}`);
              if (!Array.isArray(messages)) return;
              const d = ctx._dlDelivery;
              if (!d || typeof d.injectForSession !== "function") return;
              const before = messages.length;
              const ret = d.injectForSession(sp, { messages });
              if (!ret || !Array.isArray(ret.messages) || ret.messages.length === before) return;
              dbgLog(`DBG agent/pre-step INJECTED | session=${sp || "?"} msgs ${before}->${ret.messages.length}`);
              return { messages: ret.messages };
            },
            { owner: ctx.pluginId || "hana-downloader", order: 999 }
          );
          dbgLog(`DBG registered agent/pre-step adjudicator via ${hooksSource} (order=999)`);
        } catch (e) {
          dbgLog(`DBG onDecision register ERR: ${e?.message || e}`);
          logger.warn?.(`agent/pre-step register failed: ${e?.message || e}`);
        }
      } else {
        dbgLog(`DBG NO hooks channel → sync injection unavailable, async-only`);
      }

      // 4) onload 恢复兜底：补调已终态 + 未投递任务的 handleFinal。
      //    host 重启导致 deferred 占位丢失场景。
      try {
        const TERMINAL = new Set(["done", "failed", "canceled", "interrupted"]);
        let recoverCount = 0;
        for (const t of manager.tasks.values()) {
          if (!t || !t.taskId || !TERMINAL.has(t.state)) continue;
          if (t.delivered === true) continue;
          t.deferredRegistered = false;
          recoverCount++;
          dbgLog(`ONLOAD-RECOVER ${t.taskId} state=${t.state} received=${t.received}/${t.total} → re-deliver`);
          try {
            ctx._dlDelivery.handleFinal(t);
          } catch (e) {
            dbgLog(`ONLOAD-RECOVER ERR ${t.taskId}: ${e?.message || e}`);
          }
        }
        if (recoverCount > 0) dbgLog(`ONLOAD-RECOVER total=${recoverCount}`);
      } catch (e) {
        dbgLog(`ONLOAD-RECOVER loop ERR: ${e?.message || e}`);
      }

      logger.info?.(`hana-downloader v0.14.0 v2 loaded (delivery: sync inject + deferred)`);
      dbgLog(`DBG hana-downloader v0.14.0 v2 loaded`);
    } catch (e) {
      logger.warn?.(`hana-downloader restore failed: ${e?.message || e}`);
      dbgLog(`DBG ERR: ${e?.message || e}`);
    }
  }

  async onunload() {
    // 释放 agent/pre-step adjudicator（避免重载后旧回调残留 → 双注入）
    if (this.ctx && typeof this.ctx._dlHooksDispose === "function") {
      try { this.ctx._dlHooksDispose(); } catch {}
      this.ctx._dlHooksDispose = null;
    }
    // 释放本实例对 manager 的订阅（避免 dev 槽重载残留 → 双投）
    if (this.ctx && this.ctx._dlDelivery && typeof this.ctx._dlDelivery.dispose === "function") {
      try { this.ctx._dlDelivery.dispose(); } catch {}
    }
  }
}