// tests/unit-proxy.mjs — 代理解析：proxy:false / noProxy 白名单 / 优先级
// 覆盖 2026-09-23 修订：新增「不走代理」出口（此前系统代理一开就无法绕过）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProxy, hostMatchesNoProxy, noProxyList } from "../engine/dlcore.js";

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-proxy-test-"));
const cfgPath = path.join(dir, "config.json");
const setCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj), "utf-8");
const clearCfg = () => { try { fs.unlinkSync(cfgPath); } catch { /* 无文件 */ } };

const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
const clearEnv = () => { for (const k of ENV_KEYS) delete process.env[k]; };
const restoreEnv = () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
};

console.log("── hostMatchesNoProxy ──");
check("精确域名", hostMatchesNoProxy("hf-mirror.com", "hf-mirror.com"), true);
check("子域命中", hostMatchesNoProxy("cdn.hf-mirror.com", "hf-mirror.com"), true);
check("*. 写法", hostMatchesNoProxy("hf-mirror.com", "*.hf-mirror.com"), true);
check("不相关域名不命中", hostMatchesNoProxy("notmyhf-mirror.com", "hf-mirror.com"), false);
check("IP", hostMatchesNoProxy("127.0.0.1", "127.0.0.1"), true);
check("通配 *", hostMatchesNoProxy("anything.example", "*"), true);
check("带端口条目按 host 比较", hostMatchesNoProxy("hf-mirror.com", "hf-mirror.com:443"), true);
check("大小写不敏感", hostMatchesNoProxy("HF-Mirror.COM", "hf-mirror.com"), true);
check("空值安全", hostMatchesNoProxy("", "hf-mirror.com"), false);

console.log("── resolveProxy 优先级 ──");
clearEnv(); clearCfg();
process.env.HTTPS_PROXY = "http://env-proxy:8080";
check("无 config 时走 env 代理", resolveProxy(dir, "https://huggingface.co/x"), "http://env-proxy:8080");

setCfg({ proxy: false });
check("proxy:false → 直连（忽略 env）", resolveProxy(dir, "https://huggingface.co/x"), "");

setCfg({ noProxy: ["hf-mirror.com"] });
check("白名单命中 → 直连", resolveProxy(dir, "https://hf-mirror.com/a/b.safetensors"), "");
check("白名单未命中 → env 代理", resolveProxy(dir, "https://huggingface.co/x"), "http://env-proxy:8080");
check("白名单子域命中 → 直连", resolveProxy(dir, "https://cdn.hf-mirror.com/a"), "");

clearEnv();
setCfg({ noProxy: ["hf-mirror.com"], proxy: "http://cfg-proxy:3128" });
check("config.proxy 生效", resolveProxy(dir, "https://huggingface.co/x"), "http://cfg-proxy:3128");
check("config 白名单优先于 config.proxy", resolveProxy(dir, "https://hf-mirror.com/x"), "");

setCfg({ proxy: false, noProxy: ["example.com"] });
check("proxy:false 优先于一切", resolveProxy(dir, "https://example.com/x"), "");

console.log("── noProxyList 合并来源 ──");
clearEnv();
setCfg({ noProxy: ["a.com"] });
process.env.NO_PROXY = "b.com, c.com";
const list = noProxyList(dir);
check("config + env 合并", ["a.com", "b.com", "c.com"].every((x) => list.includes(x)), true);

setCfg({ noProxy: "d.com,e.com" });
check("config 字符串写法", ["d.com", "e.com"].every((x) => noProxyList(dir).includes(x)), true);

clearCfg();
check("无 config 不报错", Array.isArray(noProxyList(dir)), true);

restoreEnv();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n代理解析：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
