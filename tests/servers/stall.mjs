// stall-server.mjs — 发 headers+1KB 后静默 150s 再断，用于制造 stall 现场
import http from 'node:http';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-length': '100000' });
  res.write(Buffer.alloc(1000));
  // 然后沉默 150 秒（不发任何字节）
  setTimeout(() => { try { res.end(); } catch {} }, 150000);
});
srv.listen(47653, '127.0.0.1', () => console.log('stall-server on 47653'));
// 自毁兜底（防孤儿进程）：默认 15 分钟，可用 STALL_KEEP_MS 覆盖。
// 2026-09-20：原先写死 4 分钟，但七象限要跑“未收束 + 已收束”两次卡滞（每次 150 秒以上），4 分钟不够用。
setTimeout(() => process.exit(0), Number(process.env.STALL_KEEP_MS || 900000));
