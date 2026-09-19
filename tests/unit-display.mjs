// tests/unit-display.mjs — ui/shared/display.js 的离线单测（2026-09-20 新增）
//
// 为什么要测它：阶段文案、计数单位与「这是什么形态的任务」原本在 index.js / card.js /
// manager.js 各写一份，2026-09-19 改 pnpm 文案时两处都要动。收成一份之后，
// 这份断言就是三处共同的地基——它错了，三个面一起错，所以必须有网。
import {
  STAGE_TEXT, UNIT_NAME, stageLabel, unitSuffix, cmdTypeOf,
  isPkgTask, isCloneTask, isCountTask, isCmdTask, progressText,
} from "../ui/shared/display.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

// ── 表本身 ──
check("stage table: winget 四阶段在内", STAGE_TEXT, (x) => ["found", "downloading", "verifying", "installing"].every((k) => typeof x[k] === "string"));
check("stage table: git/pnpm 阶段在内", STAGE_TEXT, (x) => ["fetching", "enumerating", "resolving", "finalizing"].every((k) => typeof x[k] === "string"));
check("unit table", UNIT_NAME, (x) => x.objects === "对象" && x.files === "文件" && x.packages === "包");

// ── 取值函数 ──
check("stageLabel: 已知", stageLabel("verifying"), (x) => x === "校验哈希");
check("stageLabel: 未知回落原值", stageLabel("weird"), (x) => x === "weird");
check("stageLabel: 空值", stageLabel(null), (x) => x === "");
check("unitSuffix: 包", unitSuffix("packages"), (x) => x === " 包");
check("unitSuffix: 字节型为空", unitSuffix("bytes"), (x) => x === "");
check("unitSuffix: 空值", unitSuffix(undefined), (x) => x === "");

// ── 形态判定：兼容快照（cmdType）与任务对象（cmd.type）两种形态 ──
check("cmdTypeOf: 快照形态", cmdTypeOf({ cmdType: "pip-install" }), (x) => x === "pip-install");
check("cmdTypeOf: 任务形态", cmdTypeOf({ cmd: { type: "winget-install" } }), (x) => x === "winget-install");
check("cmdTypeOf: 空对象", cmdTypeOf({}), (x) => x === null);
check("cmdTypeOf: null", cmdTypeOf(null), (x) => x === null);

check("isPkgTask: winget", isPkgTask({ cmdType: "winget-install" }), (x) => x === true);
check("isPkgTask: pip", isPkgTask({ cmd: { type: "pip-install" } }), (x) => x === true);
check("isPkgTask: 普通下载为假", isPkgTask({ unit: "bytes" }), (x) => x === false);
check("isCloneTask", isCloneTask({ cmdType: "git-clone" }), (x) => x === true);
check("isCmdTask: pnpm 为真", isCmdTask({ cmdType: "pnpm-install" }), (x) => x === true);
check("isCmdTask: winget 为假", isCmdTask({ cmdType: "winget-install" }), (x) => x === false);
check("isCountTask: packages", isCountTask({ unit: "packages" }), (x) => x === true);
check("isCountTask: bytes 为假", isCountTask({ unit: "bytes" }), (x) => x === false);
check("isCountTask: 缺 unit 为假", isCountTask({}), (x) => x === false);

// ── 文案：包安装走阶段 ──
check("pkg: 有阶段", progressText({ cmdType: "winget-install", stage: "downloading" }), (x) => x === "阶段：下载中");
check("pkg: 无阶段 → null", progressText({ cmdType: "pip-install" }), (x) => x === null);

// ── 文案：计数型 ──
check("count: 完成态（工具面）", progressText({ unit: "packages", state: "done", received: 68, total: 68 }, { doneText: true }), (x) => x === "完成：68/68 包");
check("count: 有明细走明细", progressText({ unit: "objects", state: "running", received: 3, total: 9, stageDetail: "接收中 3/9" }), (x) => x === "进度：接收中 3/9");
check("count: 无明细拼计数", progressText({ unit: "packages", state: "running", received: 12, total: 68 }), (x) => x === "进度：12/68 包");
check("count: total 未知", progressText({ unit: "objects", state: "running", received: 7 }), (x) => x === "进度：7 对象");
check("count: doneText 但未终态仍写进度", progressText({ unit: "packages", state: "running", received: 1, total: 2 }, { doneText: true }), (x) => x === "进度：1/2 包");

// ── 文案：字节型 ──
check("bytes: 有总量", progressText({ unit: "bytes", state: "running", received: 512, total: 1024 }), (x) => x === "进度：50%（512/1024 字节）");
check("bytes: 无总量", progressText({ received: 512 }), (x) => x === "已下载：512 字节");
check("null 任务", progressText(null), (x) => x === null);

console.log(`\n=== display: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
