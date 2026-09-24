// tests/unit-proxy.mjs — 代理解析：模式三档 / 内置规则 / 自定义名单 / 白名单 / 优先级
// 覆盖 2026-09-23 修订：新增「不走代理」出口（此前系统代理一开就无法绕过）
// 覆盖 2026-09-24 修订：新增 proxy.mode（auto/always/never）与按目标地址自动路由
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProxy, hostMatchesNoProxy, noProxyList, readProxyConfig, resolveProxyUrl, CN_DIRECT, FOREIGN_PROXY } from "../engine/dlcore.js";

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

// ── 2026-09-24 新增：模式与自动路由 ──
// 不测 ⑥ 未知域名探测：那条会真发网络请求（curl HEAD），留给集成测试。
// 下面每条都能被 ①~⑤ 之一确定命中。
console.log("── readProxyConfig 三种写法兼容 ──");
clearEnv();
setCfg({ proxy: false });
check("false → never", readProxyConfig(dir).mode, "never");
setCfg({ proxy: "http://x:1" });
check("字符串 → always + url", [readProxyConfig(dir).mode, readProxyConfig(dir).url], ["always", "http://x:1"]);
setCfg({ proxy: { mode: "auto", url: "http://y:2", directHosts: ["a.com"], proxyHosts: ["b.com"] } });
check("对象 → 逐字段读出", [readProxyConfig(dir).mode, readProxyConfig(dir).url, readProxyConfig(dir).directHosts, readProxyConfig(dir).proxyHosts], ["auto", "http://y:2", ["a.com"], ["b.com"]]);
setCfg({});
check("无 proxy 字段 → 默认 auto", readProxyConfig(dir).mode, "auto");
setCfg({ proxy: { mode: "乱写", url: "http://z:3" } });
check("非法 mode 回落到 auto", readProxyConfig(dir).mode, "auto");

console.log("── mode 三档 ──");
clearEnv();
setCfg({ proxy: { mode: "never", url: "http://p:8080" } });
check("never → 直连（即使目标是国外）", resolveProxy(dir, "https://github.com/a"), "");
setCfg({ proxy: { mode: "always", url: "http://p:8080" } });
check("always → 全走代理（即使目标是国内）", resolveProxy(dir, "https://hf-mirror.com/a"), "http://p:8080");

console.log("── auto：内置规则 ──");
setCfg({ proxy: { mode: "auto", url: "http://p:8080" } });
check("hf-mirror 直连", resolveProxy(dir, "https://hf-mirror.com/a.safetensors"), "");
check("npmmirror 直连", resolveProxy(dir, "https://registry.npmmirror.com/x"), "");
check("清华镜像直连", resolveProxy(dir, "https://mirrors.tuna.tsinghua.edu.cn/x"), "");
check("*.cn 直连", resolveProxy(dir, "https://some-site.cn/x"), "");
check("gitee 直连", resolveProxy(dir, "https://gitee.com/x/y"), "");
check("github 走代理", resolveProxy(dir, "https://github.com/x/y"), "http://p:8080");
check("githubusercontent 走代理", resolveProxy(dir, "https://raw.githubusercontent.com/x/y"), "http://p:8080");
check("huggingface 走代理", resolveProxy(dir, "https://huggingface.co/x"), "http://p:8080");
check("pypi 走代理", resolveProxy(dir, "https://pypi.org/simple/"), "http://p:8080");
check("npmjs 走代理", resolveProxy(dir, "https://registry.npmjs.org/x"), "http://p:8080");

console.log("── auto：自定义名单覆盖内置 ──");
setCfg({ proxy: { mode: "auto", url: "http://p:8080", directHosts: ["github.com"], proxyHosts: ["hf-mirror.com"] } });
check("directHosts 覆盖内置（github 改直连）", resolveProxy(dir, "https://github.com/x"), "");
check("proxyHosts 覆盖内置（hf-mirror 改走代理）", resolveProxy(dir, "https://hf-mirror.com/x"), "http://p:8080");
check("未覆盖的照旧（pypi 仍走代理）", resolveProxy(dir, "https://pypi.org/x"), "http://p:8080");

console.log("── 无代理地址时的行为（本机注册表可能有系统代理，故只验 never）──");
clearEnv();
// 注意：本机若开着系统代理，resolveProxyUrl 的 ⑤ 会从注册表读到它（这是预期行为，不是 bug）。
// 所以这里用 never 把环境隔离掉，只验「模式层不会被缺代理地址搞崩」。
setCfg({ proxy: { mode: "never" } });
check("never + 无 url → 直连", resolveProxy(dir, "https://github.com/x"), "");
setCfg({ proxy: false });
check("proxy:false + 无 url → 直连", resolveProxy(dir, "https://github.com/x"), "");

console.log("── resolveProxyUrl 来源优先级 ──");
clearEnv();
setCfg({ proxy: { mode: "auto", url: "http://from-cfg:1" } });
check("显式参数最高", resolveProxyUrl(dir, "http://explicit:2"), "http://explicit:2");
check("config.proxy.url 次之", resolveProxyUrl(dir), "http://from-cfg:1");
process.env.HTTPS_PROXY = "http://from-env:3";
check("env 低于 config.url", resolveProxyUrl(dir), "http://from-cfg:1");
setCfg({ proxy: { mode: "auto" } });
check("config 无 url 时用 env", resolveProxyUrl(dir), "http://from-env:3");

console.log("── 内置规则表自身可匹配 ──");
check("CN_DIRECT 非空且含 hf-mirror", CN_DIRECT.includes("hf-mirror.com"), true);
check("FOREIGN_PROXY 非空且含 github", FOREIGN_PROXY.some((e) => hostMatchesNoProxy("github.com", e)), true);

restoreEnv();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n代理解析：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
