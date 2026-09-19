// hd-e2e-server.mjs — 本地下载测试源（2MB 一次性）
import http from "node:http";
const size = 2 * 1024 * 1024;
const data = Buffer.alloc(size, 0x41);
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
  res.end(data);
});
srv.listen(18999, "127.0.0.1", () => console.log("E2E_SERVER_READY"));
