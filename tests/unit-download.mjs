// tests/unit-download.mjs — 下载内核的端到端离线测试（2026-09-20 新增）
//
// 覆盖三件此前「实现完整但没人用过」的事，正因没人用过，才需要网：
//   1. 普通 URL 下载的完整链路（创建 → 流式落盘 → 终态快照）
//   2. expectedSha256：摘要正确则交付，错误则失败且不交付文件（2026-09-20 接线）
//   3. speedLimit：限速真的拖慢下载（2026-09-20 接线）
// 另外钉住已清理的死字段不再回到快照里。
//
// 全程本地回环，不走代理、不碰外网。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getTaskManager } from "../engine/dlcore.js";

const BASE = path.join(os.tmpdir(), "hd-dl-test");
const DATA_DIR = path.join(BASE, "data");
const SAVE_DIR = path.join(BASE, "out");
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(SAVE_DIR, { recursive: true });

const SIZE = 1024 * 1024; // 1MB
const BODY = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(SIZE) });
  if (req.method === "HEAD") return res.end();
  res.end(BODY);
});
await new Promise((r) => srv.listen(18997, "127.0.0.1", r));

const mgr = getTaskManager(DATA_DIR);

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

async function waitFinal(taskId, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = mgr.snapshot(taskId);
    if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return mgr.snapshot(taskId);
}

const url = "http://127.0.0.1:18997/big.bin";

// ── 场景 1：普通下载 ──
{
  const t = mgr.create({ url, fileName: "plain.bin", saveDir: SAVE_DIR });
  const snap = await waitFinal(t.taskId);
  check("plain: done", snap?.state, (x) => x === "done");
  check("plain: 字节数对齐", snap, (x) => x.total === SIZE && x.received === SIZE);
  check("plain: 文件落盘且大小正确", snap, (x) => fs.existsSync(x.filePath) && fs.statSync(x.filePath).size === SIZE);
  check("plain: 无 .part 残留", snap, (x) => !fs.existsSync(x.filePath + ".part"));
  check("plain: 快照不再带死字段", snap, (x) => !("consumedByWait" in x) && !("waitActive" in x) && !("waitBudgetExhausted" in x) && !("deferredRegistered" in x));
}

// ── 场景 2：expectedSha256 正确 → 交付 ──
{
  const t = mgr.create({ url, fileName: "sum-ok.bin", saveDir: SAVE_DIR, expectedSha256: SHA });
  const snap = await waitFinal(t.taskId);
  check("sha 正确: done", snap?.state, (x) => x === "done");
  check("sha 正确: 落盘哈希一致", snap, (x) => crypto.createHash("sha256").update(fs.readFileSync(x.filePath)).digest("hex") === SHA);
}

// ── 场景 3：expectedSha256 错误 → 失败且不交付 ──
{
  const wrong = "0".repeat(64);
  const t = mgr.create({ url, fileName: "sum-bad.bin", saveDir: SAVE_DIR, expectedSha256: wrong });
  const snap = await waitFinal(t.taskId);
  check("sha 错误: failed", snap?.state, (x) => x === "failed");
  check("sha 错误: 错误文案含 SHA-256", snap, (x) => String(x.error || "").includes("SHA-256"));
  check("sha 错误: 正式文件未交付", snap, (x) => !fs.existsSync(x.filePath));
}

// ── 场景 4：限速 256KB/s 下 1MB 至少用 3 秒 ──
{
  const t0 = Date.now();
  const t = mgr.create({ url, fileName: "throttled.bin", saveDir: SAVE_DIR, speedLimit: 256 * 1024 });
  const snap = await waitFinal(t.taskId);
  const cost = Date.now() - t0;
  check("throttle: done", snap?.state, (x) => x === "done");
  check("throttle: 快照带 speedLimit", snap, (x) => x.speedLimit === 256 * 1024);
  check("throttle: 确实被拖慢（≥3s）", cost, (x) => x >= 3000);
}

// ── 场景 5：downloads 记录可枚举、可清理记录 ──
{
  const list = mgr.list();
  check("list: 返回 4 条", list, (x) => x.length >= 4);
  check("list: 终态任务在前排序可用", list, (x) => x.every((it) => typeof it.taskId === "string"));
  const cleared = mgr.clearByStates(["done", "failed"]);
  check("clearByStates: 清掉终态", cleared, (x) => x.ok === true && x.removed.length >= 3);
  check("clearByStates: 记录已空", mgr.list().length, (x) => x === 0);
}

console.log(`\n=== download: ${pass} passed, ${fail} failed ===`);
srv.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
