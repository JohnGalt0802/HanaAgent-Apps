// hana-downloader-app/engine/engine-port.js
// 引擎端口的唯一来源。
//
// 背景：端口原本有两个来源——index.js 写死 4317，server.js 读 HD_ENGINE_PORT 环境变量。
// 两边一旦错开就是「静默连不上」，排查成本远高于维护这个常量。
// App 主进程与受管引擎进程都从这里取默认值；HD_ENGINE_PORT 仅作本机调试覆盖。
export const ENGINE_PORT = 4317;
