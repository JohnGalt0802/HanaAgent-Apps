// lib/progress-parsers.js — 命令型任务的输出行解析器（纯函数）
// git clone / pnpm install 的 stdout/stderr 行 → 进度数据。
// 每行输入（已剥 \r）→ { stage, received, total, unit, pct, message } 或 null。
//
// - git clone：进度在 stderr，对象计数天然是 received/total，无状态
// - pnpm install：进度在 stdout，\r 重绘每秒多次，必须状态化（同 stage 取最新，received 直接赋值不累加）

const GIT_CLONING = /Cloning into\s+'([^']+)'/;
const GIT_ENUM = /remote:\s+Enumerating objects:\s+(\d+)/;
const GIT_RECEIVING = /Receiving objects:\s+(\d+)%\s*\((\d+)\/(\d+)\)/;
const GIT_DELTAS = /Resolving deltas:\s+(\d+)%\s*\((\d+)\/(\d+)\)/;
const GIT_UPDATING = /Updating files:\s+(\d+)%\s*\((\d+)\/(\d+)\)/;

export function parseGitLine(line) {
  if (!line) return null;
  let m;
  if ((m = line.match(GIT_CLONING))) return { stage: "cloning", pct: 0, message: "准备克隆" };
  if ((m = line.match(GIT_ENUM))) return { stage: "enumerating", message: `枚举对象 ${m[1]}` };
  if ((m = line.match(GIT_RECEIVING)))
    return { stage: "receiving", received: +m[2], total: +m[3], unit: "objects", pct: +m[1], message: `接收对象 ${m[2]}/${m[3]}` };
  if ((m = line.match(GIT_DELTAS)))
    return { stage: "resolving", received: +m[2], total: +m[3], unit: "objects", pct: +m[1], message: `解析增量 ${m[1]}%` };
  if ((m = line.match(GIT_UPDATING)))
    return { stage: "checkout", received: +m[2], total: +m[3], unit: "files", pct: +m[1], message: `检出文件 ${m[2]}/${m[3]}` };
  return null;
}

const PNPM_PROGRESS = /Progress:\s+resolved\s+(\d+),\s+reused\s+(\d+),\s+downloaded\s+(\d+),\s+added\s+(\d+)/;
const PNPM_PACKAGES = /Packages:\s+\+(\d+)/;
const PNPM_BUILD = /postinstall\$/;
const PNPM_BAS_DONE = /Done in\s+(?:(\d+(?:\.\d+)?)m\s+)?(\d+(?:\.\d+)?)s/;

const PACKAGES_TOTAL = 1000;

export function createPnpmParser() {
  let packages = null; // 包总数（Packages: +N），用于比例换算
  return function (line) {
    if (!line) return null;
    let m;
    if ((m = line.match(PNPM_PACKAGES))) { packages = +m[1]; return null; }
    if ((m = line.match(PNPM_PROGRESS))) {
      const resolved = +m[1], downloaded = +m[3], added = +m[4];
      let stage, pct;
      // 同 stage 只取最新：received 直接赋值（不累加），pnpm \r 重绘天然状态化
      if (added > 0 && packages) { stage = "linking"; pct = 60 + Math.min(20, (added / packages) * 20); }
      else if (downloaded > 0 && packages) { stage = "fetching"; pct = 10 + Math.min(50, (downloaded / packages) * 50); }
      else if (resolved > 0) { stage = "resolving-deps"; pct = 5; }
      else return null;
      const received = Math.round((pct / 100) * PACKAGES_TOTAL);
      return {
        stage, received, total: PACKAGES_TOTAL, unit: "packages", pct: Math.round(pct * 10) / 10,
        message: stage === "fetching" ? `拉取 ${downloaded}/${packages}` : stage === "linking" ? `链接 ${added}/${packages}` : "解析依赖",
      };
    }
    if (PNPM_BUILD.test(line)) return { stage: "building", received: 900, total: PACKAGES_TOTAL, unit: "packages", pct: 90, message: "编译原生模块" };
    if ((m = line.match(PNPM_BAS_DONE))) return { stage: "finalizing", received: PACKAGES_TOTAL, total: PACKAGES_TOTAL, unit: "packages", pct: 100, message: "收尾" };
    return null;
  };
}
