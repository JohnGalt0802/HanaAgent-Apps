# Hana Downloader · 小花下载器（v2 App）

> App ID：`hana-downloader` · 为 HanaAgent 提供**可观测下载**能力：
> 下载任务实时可视化、进度可查询、中途可干预、终态可靠通知。
> 支持 URL 下载与命令型下载（git clone / pnpm install），另有跨会话管理器。

- 当前版本：v0.90.1
- 宿主基线：HanaAgent 0.946.2（实测）
- 形态：v2 App（单 bundle 入口 + local-machine 受管下载引擎）

---

## 一、这是什么

从 v1 插件形态完整迁移到 v2 App 的版本。迁移的动因是 v2 提供了
`ctx.tasks`（宿主统一任务与投递），可以让"下载完成后通知会话"这件事
走宿主正门，而不再依赖插件自己维护占位与注入通道。

原有的四项能力一项不少：实时进度卡片、进度查询、取消、跨会话管理器。

---

## 二、架构

```
┌───────────────────────────────────────────────────────────┐
│  展示层（ui/，跑在 App iframe 里）                          │
│  ├─ card.html / card.js     进度卡片（聊天流内嵌）           │
│  └─ manager.html / manager.js 跨会话管理器                   │
│      └─ hdboot.js：适配层，把旧请求重写到引擎 API             │
├───────────────────────────────────────────────────────────┤
│  App 层（index.js，宿主 AppHost 子进程）                     │
│  ├─ 注册四个工具（download-file/command/wait/cancel）        │
│  ├─ 拉起并管理受管下载引擎（ctx.runtime）                     │
│  ├─ 投递：拿到 callToken → ctx.tasks.create → 完成后 complete │
│  └─ 路由：/engine/* 转发前端请求到引擎                        │
├───────────────────────────────────────────────────────────┤
│  引擎层（engine/，local-machine 受管程序）                    │
│  ├─ server.js   HTTP 服务（127.0.0.1:4317）                  │
│  ├─ dlcore.js   任务管理器（流式下载/测速/限速/停滞/持久化）    │
│  └─ progress-parsers.js  git / pnpm 输出解析                 │
└───────────────────────────────────────────────────────────┘
```

**为什么要一个独立的受管引擎**：v2 App 的子进程受 Node Permission Model 约束，
不能裸 `fetch`、也不能任意落盘。只有 `profile: "local-machine"` 的受管程序
才能保住"任意 URL + 任意落盘目录"这两个原有能力。

**App 与引擎怎么通信**：App 侧经 `ctx.network.fetch` 访问 `127.0.0.1:4317`。
不用 `ctx.runtime.start({ service })` 的回环服务代理——那条路会留一条常驻 RPC，
卡死工具回包（详见 `docs/踩坑记录.md` 第 4 条）。

---

## 三、安装

```bash
# 开发期：把整个目录放进宿主 apps/
cp -r hana-downloader-app  ~/.hanako/apps/hana-downloader

# 重载
curl -X POST http://127.0.0.1:14500/api/extensions/app:hana-downloader/reload \
  -H "Authorization: Bearer <token>"      # token 见 ~/.hanako/server-info.json
```

需要在宿主「设置 → 应用」里逐项授权以下能力：

| capability | 用途 |
| --- | --- |
| `app/runtime.execute` | 拉起受管引擎 |
| `app/runtime.local-machine` | 让引擎以本机权限运行（任意 URL / 任意落盘） |
| `app/runtime.network` | 受管引擎出网 |
| `app/tasks.manage` | 建/结算宿主任务，完成结果投递给会话 |
| `app/session.start-turn` | 会话投递 |
| `app/tools.expose-to-model` | 把工具暴露给模型 |

另需清单顶层 `network`（`allowedHosts: ["127.0.0.1"]` + `allowLocalhost: true`），
供 App 侧 `ctx.network.fetch` 访问本机引擎。

---

## 四、工具

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `download-file` | URL 下载，发起即返回 taskId | `url`（必填）、`saveDir`、`fileName` |
| `download-command` | 命令型下载 | `kind`（`git-clone` / `pnpm-install`）、`repo`、`targetDir`、`workdir`、`label` |
| `download-wait` | 查进度快照（立即返回、不阻塞） | `taskId` |
| `download-cancel` | 取消下载 | `taskId` |

工具返回值统一为 `{ content: [{ type: "text", text }], details }`；
`details.card` 触发聊天流内嵌卡片，`details.download` 带结构化快照。

下载完成后由宿主经 `ctx.tasks` 把结果投递回发起会话，模型无需轮询。

### 命令型的两条边界

- 只认 `git-clone` 与 `pnpm-install` 两种，不接受任意命令。
- 不做 shell 拼接，全部数组传参；Windows 下 pnpm 的 `.cmd` shim 会被解析到真实
  JS 入口，用当前 node 执行，避开 `shell:false` 的 EINVAL。

---

## 五、引擎 HTTP API

引擎监听 `127.0.0.1:4317`，路径避开了 `/download/*` 前缀（宿主保留段）。

```
GET  /ping                                健康检查
POST /download    { url, fileName?, saveDir?, speedLimit?, stallTimeoutMs?, sessionPath? }
POST /command     { kind, repo?, targetDir?, workdir?, label?, sessionPath? }
GET  /wait?taskId=xxx                     进度快照
POST /wait        { taskId }              同上（POST 版，宿主路由对带 query 的路径不友好）
POST /cancel      { taskId, source? }     取消
POST /cancel-all                          取消全部
GET  /list                                全部任务
POST /clear                               清理终态任务
POST /reveal      { filePath }            在系统文件管理器中定位
GET|POST /settings                        读写引擎设置
GET  /events                              SSE：终态 / 停滞事件流
```

App 侧的转发入口（给前端用）：

```
GET /api/apps/hana-downloader/routes/engine/<path>   → 引擎 /<path>
GET /api/apps/hana-downloader/routes/engine-base     → {"ok":true,"base":"engine"}
GET /api/apps/hana-downloader/routes/engine-status   → 受管运行时状态
```

---

## 六、目录结构

```
hana-downloader-app/
├── manifest.json            v2 清单（capabilities / network / contributes.cards）
├── index.js                 入口：工具注册、引擎管理、投递、路由
├── assets/icon.svg
├── engine/
│   ├── server.js            受管引擎 HTTP 服务
│   ├── dlcore.js            下载内核（从插件时代复用，纯 Node 无宿主依赖）
│   └── progress-parsers.js  git / pnpm 输出解析
├── ui/
│   ├── card.html / card.js / card.css        进度卡片
│   ├── manager.html / manager.js / manager.css  跨会话管理器
│   └── hdboot.js            适配层（旧请求 → 引擎 API）
└── docs/
    ├── 踩坑记录.md                   迁移过程中踩到的坑与解法（含 3 条宿主通用结论）
    ├── 七象限测试报告-20260910.md    投递能力验收
    └── hana-app卡片尺寸与身份反馈.md  给宿主开发者：卡片尺寸锁死与卡外按钮无身份
```

引擎数据目录：`{HANA_HOME}/app-data/hana-downloader/`
（`tasks.json` 任务快照、`finished/*.json` 终态结果、`speed-cache.json` 测速缓存）。

---

## 七、界面

两处 UI 决定值得记下。

**聊天流卡片**。卡宽由宿主限定（任务族统一宽度 `--chat-task-block-width: 348px`，
详见「已知限制」），因此首行只放两个高频操作：

- URL 任务完成态：`打开` + `文件夹`
- 命令型任务完成态：`打开文件夹`（目录无「打开文件」语义）

`复制路径` 下沉到展开详情里的「操作」行，与「路径」行相邻，想复制时目光本来就在路径上。

**滚动条**。管理器列表的滚动条对齐宿主原生卡片（工作台卡等）：
宽度 4px、滑块 `rgba(128, 128, 128, 0.2)`、悬停 `.4`、圆角 2px、两端按钮隐藏；
同时写 `scrollbar-width: thin` 与 `scrollbar-color`，兼顾 Firefox。

**设置菜单**。管理器工具条上的文件夹按钮里有三项，写入引擎数据目录的
`engine-config.json`，下载时作为缺省值生效：

| 项 | 作用 |
| --- | --- |
| 设置默认下载目录 | 所有未显式指定 `saveDir` 的下载落到这里 |
| 助手选择下载地址 | 反过来，由 Agent 每次决定；固定目录不套用 |
| 停滞判定阈值 | 无新数据超过该毫秒数判定为停滞（默认 30000） |

## 八、状态机

任务状态：`pending` → `running` → `done` / `failed` / `canceled` / `interrupted`

- URL 任务取消后保留 `.part` 半成品供断点续传；
- `git-clone` 任务失败/取消时清理半成品目录（避免留下不完整仓库）；
- `pnpm-install` 保留 `node_modules` 半成品。

---

## 九、已知限制

- 命令型仅支持 `git-clone` / `pnpm-install`，不做通用命令执行。
- 引擎监听固定端口 4317；多个实例同时运行会冲突（重载时会先停掉本 App 的遗留实例）。
- 进度卡片依赖前端轮询引擎，慢网络下刷新有延迟。
- **聊天流内嵌卡片的宽度上限由宿主卡壳决定**（宽度 = 卡壳 `clientWidth`，随窗口浮动，
  小窗口实测 347px、大窗口 937px）；`hana.ui.resize({ width })` 没有接收方，
  页面只能"窄于上限"不能"宽于上限"。卡片布局按窄宽设计：首行只放徽章与操作按钮，
  进度与元信息分行；`html` / `body` / 根容器显式 `width:100%` 以免自行收缩。
  参见 `docs/hana-app卡片尺寸与身份反馈.md` 与 `docs/踩坑记录.md` 第 6 条。
- 中途停滞（`stalled`）状态无法主动投递给模型：v2 任务模型是「一次 execute → 一条终态
  通知」，`ctx.tasks.create` 需要当前有效的 `callToken`，而 `callToken` 只在 execute 期间
  有效。目前改为引擎落盘 `stalled/*.json` 供前端展示，不惊动模型。

---

## 十、v1 遗留清理（2026-09-11）

从 v1 插件整机迁到 v2 App 之后，宿主里还挂着一批过渡期的东西，已一并清掉。

**卸载的 app**

| app | 作用 | 处置 |
| --- | --- | --- |
| `hd-sync-bridge` | 过渡期的“回执桥”：v1 插件把下载回执写成队列文件，这个 app 在 `agent/pre-step` 把队列拼进消息 | 移除 |
| `rt-probe` | 验证 local-machine 运行时与 `ctx.tasks` 能力的探针 | 移除 |
| `_disabled-sync-probe-*` | 更早的探针残骸 | 移除 |

桥为什么曾经需要：v1 插件有“任意 URL / 任意落盘 / spawn”这些宽能力，但没有 hooks 正门；
app 有 hooks 正门，却受权限沙箱约束。两边各取所长，才有了“插件写队列 + app 注入”的绕行。
整机迁成 v2 App 后 `ctx.tasks` 直接可用，桥就失去了意义。

**卡片侧的旧凭据**

`card.js` / `manager.js` 里还留着 v1 时代的 `LOOPBACK_TOKEN`（URL 上的 `token=`）与
`X-Hana-Plugin-Surface-Session` 头，与 `hdboot.js` 的 v2 票据（`appSurfaceSession` →
`X-Hana-App-Surface-Session`）重复。v2 下 URL 不带 `token`，那段逻辑恒为空，是死代码。
现在凭据统一由 hdboot 注入，业务代码不再自管。

**验证**：宿主重启后管理器卡连续 `fwd GET /list -> 200`，链路正常。
