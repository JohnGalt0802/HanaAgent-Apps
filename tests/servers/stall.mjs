// stall-server.mjs — 发 headers+1KB 后静默 150s 再断，用于制造 stall 现场
import http from 'node:http';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-length': '100000' });
  res.write(Buffer.alloc(1000));
  // 然后沉默 150 秒（不发任何字节）
  setTimeout(() => { try { res.end(); } catch {} }, 150000);
});
srv.listen(47653, '127.0.0.1', () => console.log('stall-server on 47653'));
setTimeout(() => process.exit(0), 240000); // 4分钟自毁，防孤儿
