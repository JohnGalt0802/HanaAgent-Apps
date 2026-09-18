// hana-downloader-app/engine/tunnel-agent.js — 手写 HTTP CONNECT 隧道 Agent
// 从 dlcore.js 抽出（2026-09-18），供两处共用：
//   1. dlcore 的 URL 下载（https 经代理隧道）；
//   2. download-probe 的 HEAD 请求（winget 下载进度探测也要走代理）。
// 仅支持 http(s) 形式的代理 URL；socks 等其它形式返回 null（调用方回退为直连）。
//
// 实现方式（2026-09-18 实测定稿）：raw socket 手写 CONNECT + 手解析响应行，
// 成功后在同一 socket 上 tls.connect（https.Agent 不会代做 TLS，必须在此完成）。
// 不用 http.request 发 CONNECT 的原因：那条路线上 socket 经 http 解析器后
// 状态异常，tls.connect 会卡在等 ServerHello（实测挂死 20s+）；raw 方式实测稳定
//（CONNECT 200 → TLSv1.3 → 正常响应）。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const CONNECT_TIMEOUT_MS = 15000;

export function createTunnelAgent(proxyUrl) {
  let pu;
  try { pu = new URL(proxyUrl); } catch { return null; }
  if (pu.protocol !== "http:" && pu.protocol !== "https:") return null;
  const port = Number(pu.port) || (pu.protocol === "http:" ? 80 : 443);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = function (options, cb) {
    const host = options.host;
    const targetPort = options.port || 443;
    let settled = false;
    let timer = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cb(err);
    };
    const ok = (sock) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cb(null, sock);
    };

    const socket = net.connect(port, pu.hostname, function () {
      socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
    });
    timer = setTimeout(() => {
      try { socket.destroy(); } catch { /* 已断 */ }
      fail(new Error("代理 CONNECT 超时"));
    }, CONNECT_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    let buf = "";
    const onData = (d) => {
      buf += d.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      socket.removeListener("data", onData);
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
      if (!m || m[1] !== "200") {
        try { socket.destroy(); } catch { /* 已断 */ }
        fail(new Error("代理 CONNECT 失败: " + statusLine));
        return;
      }
      // 响应头之后的剩余字节（正常为空）退回给 TLS 层
      const rest = buf.slice(idx + 4);
      if (rest.length) socket.unshift(Buffer.from(rest, "latin1"));
      const tlsSocket = tls.connect({ socket: socket, servername: host }, function () {
        ok(tlsSocket);
      });
      tlsSocket.once("error", function (err) { fail(err); });
    };
    socket.on("data", onData);
    socket.once("error", function (err) { fail(err); });
  };
  return agent;
}
