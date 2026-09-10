// hd-sync-bridge — 为 hana-downloader 提供 v2 app 的 agent/pre-step 同步注入通道
//
// 机制：
//   hana-downloader（v2 plugin，跑在宿主进程内，无沙箱）把下载回执原子写入
//     {HANA_HOME}/app-data/hd-sync-bridge/queue/<key>.json
//   本 app（v2 app，独立子进程 + 权限沙箱，持有官方 hooks 正门）在每次 agent 模型请求
//   组装前（agent/pre-step）读队列，把属于当前会话的条目拼进 messages 并删除文件；
//   插件侧定时器发现文件消失即认为已投递，不再降级异步。
//
// 为什么这么绕：下载器需要的宽能力（任意 URL / 任意落盘 / spawn）只有 plugin 形态有，
//   而 hooks 正门只有 app 形态有。两边各取所长。
import fs from "node:fs";
import path from "node:path";

const MAX_ITEMS_PER_STEP = 8;

export function apply(ctx) {
  const queueDir = path.join(ctx.dataDir, "queue");
  const readyFile = path.join(ctx.dataDir, "ready.json");
  const log = (s) => { try { ctx.logger?.info?.(`[hd-sync-bridge] ${s}`); } catch {} };

  try { fs.mkdirSync(queueDir, { recursive: true }); } catch (e) { log(`mkdir ERR: ${e?.message || e}`); }

  // 心跳：插件入队时读它判断桥接是否在线（不在线时回执不写队列，直接走异步唤醒）
  let lastTouch = 0;
  const touchReady = () => {
    try {
      fs.writeFileSync(readyFile, JSON.stringify({ appId: "hd-sync-bridge", at: Date.now(), pid: process.pid }), "utf8");
      lastTouch = Date.now();
    } catch (e) { log(`ready write ERR: ${e?.message || e}`); }
  };
  touchReady();

  if (!ctx?.hooks || typeof ctx.hooks.onDecision !== "function") {
    log("NO ctx.hooks — 该入口不是 v2 app 形态，同步注入不可用");
    return;
  }

  const dispose = ctx.hooks.onDecision("agent/pre-step", (inv) => {
    if (Date.now() - lastTouch > 30000) touchReady();
    const messages = inv?.messages;
    if (!Array.isArray(messages)) return;

    let names;
    try { names = fs.readdirSync(queueDir); } catch { return; }
    if (!names.length) return;

    const cur = inv?.session?.sessionPath
      ? String(inv.session.sessionPath).split(/[\\/]/).pop()
      : null;
    if (!cur) return;

    const picked = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const p = path.join(queueDir, n);
      let item = null;
      try { item = JSON.parse(fs.readFileSync(p, "utf8")); } catch { try { fs.unlinkSync(p); } catch {} ; continue; }
      if (!item || typeof item.content !== "string" || !item.content) { try { fs.unlinkSync(p); } catch {}; continue; }
      const target = item.sessionPath ? String(item.sessionPath).split(/[\\/]/).pop() : null;
      if (!target || target !== cur) continue;
      picked.push({ p, item });
      if (picked.length >= MAX_ITEMS_PER_STEP) break;
    }
    if (!picked.length) return;

    const next = messages.slice();
    for (const { p, item } of picked) {
      try { fs.unlinkSync(p); } catch {}
      next.push({
        role: "user",
        content: item.content,
        ...(item.details ? { details: item.details } : {}),
      });
    }
    log(`INJECT ${picked.length} item(s) | session=${cur} msgs ${messages.length}->${next.length}`);
    return { messages: next };
  });

  log(`adjudicator registered | queue=${queueDir} | dispose=${typeof dispose}`);
}

export default { name: "hd-sync-bridge", apply };
