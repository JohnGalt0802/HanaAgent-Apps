# Hana Downloader · 小花下载器（v2 App）

App ID：`hana-downloader` · 当前版本：**1.0.0**（2026-09-13 重构版）
宿主基线：HanaAgent **0.978.0**（实测；0.970.9 需临时补丁才能出卡，见第七节）
卡片尺寸：**400 × 25 px**——宽度由卡片上报自定，高度完全跟内容走（见第九节）

为 HanaAgent 提供**可观测下载**：任意 URL 下载、命令型安装（git clone / pnpm install /
winget / pip）、聊天流内实时进度卡片、跨会话下载管理器。

---

## 一、能力

| 工具 | 用途 |
| --- | --- |
| `download-file` | 下载任意 http/https 文件到指定或默认目录，返回 taskId。可选 `speedLimit`（限速）与 `expectedSha256`（下载后校验，不匹配不交付） |
| `download-wait` | 查一个任务的进度快照（state / 进度 / 速度），立即返回不阻塞 |
| `download-cancel` | 取消进行中的任务，半成品保留供续传 |
| `download-command` | 四种命令：`git-clone` 克隆仓库 / `pnpm-install` 安装依赖 / `winget-install` 装 Windows 软件 / `pip-install` 装 Python 包（支持 venv 解释器与 uv runner） |

配套：

- **聊天流进度卡**：每次发起下载，会话里挂一张实时进度卡。**两行布局**：
  信息行（折叠按钮 · 状态徽标 · 剩余/阶段 · **百分比 · 已完成/总量 · 速度** · 失败原因 · 操作按钮）
  + 进度条行（进度条独占一行拉满）。2026-09-17 调整：百分比/大小/速度从进度条右侧上移到信息行，
  速度从 `.dl-meta` 拆出并入数据组；卡片高度由 32px 降至 25px。
  完成态给「打开 / 文件夹」，可折叠、可一键全展（多张卡联动）。
- **下载管理器**：跨会话统一看所有任务、清理已完成、取消在途。

---

## 二、安装

宿主 → 设置 → 应用 → 安装（来源选本地目录）：

```
D:\HanakoWorks\HanaAgentAPPs\hana-downloader-app
```

首次安装需要在确认页批准。清单里声明的能力：

```
app/runtime.execute           受管运行时
app/runtime.local-machine     引擎需要本机文件能力
app/runtime.network           引擎与下载经受控出网
app/tasks.manage              宿主任务（完成回执）
app/session.start-turn        往会话投递进度卡
app/sessions.manage
app/tools.expose-to-model     把四个工具暴露给模型
app/resources.read            管理器「选目录」
app/ui.clipboard-write        卡片「复制路径」
app/hooks.agent-pre-step      下载铁律注入
```

**装完或改完代码都要重启宿主**（见「五、开发」）。

---

## 三、使用

对助手说一句就行：下载某个 URL、克隆某个仓库、装某个项目的依赖、
装个 Windows 软件（winget）、给某个环境装 Python 包（pip）。
助手调用对应工具后，会话里会出现进度卡，不需要额外指令。

winget / pip 是**阶段式进度**（两者的输出里没有字节数据，卡片显示阶段而非百分比）：
winget 走「先搜后装」——模糊词命中多个包时先把候选列表交给模型，选定后以完整 ID 安装；
完成后带一句结果备注（如「已安装 jq 1.8.2；PATH 已更新，重启 shell 后生效」）。

- 卡片上的「取消」会终止下载并保留半成品；
- 完成后卡片给「打开 / 文件夹 / 复制路径」；
- 助手可以用 `download-wait` 中途回查进度，也可以什么都不做等完成通知。

**重试与排队**（2026-09-20）：

- 管理器行尾的 ▾ 菜单对失败 / 中断 / 已取消的任务多一项「**重试**」：URL 任务按 `.part` 断点续传，
  命令型任务重跑原命令。重试跑完会**往原会话投一条隐藏记录**（不上屏，会唤起 agent 去处理），
  所以重试的结果不会掉在地上。
- 同时下载数受设置里的「**同时下载上限**」约束（默认 3）：超出上限的任务显示「排队中」，
  前面的任务一结束就自动补位。不需要人工干预，也不用重发。

---

## 四、配置

引擎设置存在 `{appDataDir}/engine-config.json`：

| 键 | 含义 |
| --- | --- |
| `defaultSaveDir` | 未显式指定保存目录时用的默认目录 |
| `agentChooses` | `true` 表示由助手每次自行决定，不套用 `defaultSaveDir` |
| `stallTimeoutMs` | 连接停滞多久算卡滞（默认由内核决定） |
| `maxConcurrent` | 同时处于下载中的任务数上限，超出的排队等待；`0` 表示不限（默认 3） |
| `speedLimit` | 任务没有单独指定限速时的默认值（字节/秒）；`0` 表示不限 |

以上四项都能在管理器右上角的齿轮里改（目录、默认限速、同时下载上限、停滞阈值）。

运行数据目录：`C:\Users\John Galt\.hanako\app-data\hana-downloader\`

```
tasks.json        任务记录（引擎 restore 用）
finished/         终态快照，App 侧靠读它结算宿主任务（不走 RPC 轮询）
stalled/          卡滞标记
bindings.json     卡片绑定表：pending（待认领）/ bind（cardInstanceId → taskId）
```

---

## 五、开发

**改完代码必须重启宿主**（改工具逻辑时），v2 App 没有热重载通道。
**宿主实际从副本目录运行**：`C:\Users\John Galt\.hanako\apps\hana-downloader`
（2026-09-17 实测：app-host 进程授权路径与引擎入口都在副本目录，是普通目录、非链接）。
开发目录（本仓库）的改动**不会自动同步过去**，改完必须把改动文件拷到副本；
好消息是同步后**新挂载的卡片无需重启**即可生效（静态资源按请求读）。
详见 `docs/踩坑记录.md` 第 21 条。

本工作区的同步脚本在 `HanaAgentAPPs/.tools/sync-hana-downloader.ps1`（同步 + reload 一条龙；
改了 `manifest.json` 加 `-Full`，改了工具逻辑或引擎加 `-Restart`）。

本地目录安装的 app 可以走 `POST /api/extensions/:ref/reload` 原地重载，
但**重载后工具调用的 RPC 通道会指向已消失的旧 peer**（调用报 `RPC peer closed`），
路由虽然还活着，工具却不可用。所以 reload 只适合"确认能不能装载"的轻验证，
验收一律重启宿主。详见 `docs/踩坑记录.md` 第 14 条。

---

## 六、结构

```
hana-downloader-app/
├── manifest.json       v2 清单：capabilities / network / cards（messageRenderers 为退路）
├── index.js            defineApp(async sdk => …)  官方 @hana/app-sdk 入口
├── sdk/                官方 SDK dist（77 个 .js，随 app 分发，不装 npm 包）
├── engine/
│   ├── server.js       受管下载引擎：HTTP 面 + 卡片绑定表
│   ├── engine-port.js  引擎端口唯一来源（index.js 与 server.js 共用）
│   ├── dlcore.js       下载内核（HTTP 下载 / 断点续传 / git / pnpm / winget / pip 四条命令链路）
│   ├── download-probe.js    winget 下载进度探测（看下载目录里的文件增长）
│   ├── tunnel-agent.js      HTTP CONNECT 隧道代理
│   └── progress-parsers.js  输出解析（git / pnpm / winget / pip / uv + winget 退出码表）
├── ui/
│   ├── card.html / card.js        聊天流进度卡
│   ├── manager.html / manager.js  跨会话管理器
│   ├── shared/display.js          阶段/单位文案与任务形态判定的唯一来源（Node 侧也用）
│   ├── card.css / manager.css     视觉素材
│   ├── assets/sdk.js              官方 UI SDK（dist/ui.js）
│   └── face.png                   卡片内联图标位图
├── tests/                         离线测试与本地下载源（见 tests/README.md）
├── assets/icon.png | icon.svg
└── docs/
    ├── 改动生效范围.md            改哪些文件要不要重启（交付前先过这张表）
    ├── 重构说明.md                 重构动因、实测结论、新架构
    ├── 踩坑记录.md                 33 条，含宿主侧通用结论
    ├── 规划-winget与pip-20260918.md
    ├── 七象限测试报告-20260914.md  宿主 0.978.0 / 宽度 450，7/7 完成
    ├── 七象限测试报告-20260910.md  历史：宿主 0.946.2 / 宽度 550
    ├── 宿主缺陷-v2应用卡片投影丢工具名.md
    └── hana-app卡片尺寸与身份反馈.md
```

---

## 七、卡片投递机制（作者备忘）

聊天流卡走**工具返回值 `details.card`**：宿主把它投影成内联 iframe，挂在**工具调用块下方**，
随工具返回**实时出现**；卡片自己每 600ms 轮询引擎拿进度。不往会话投消息，既实时又无污染。

### 宿主侧前置条件

**0.978.0 及以上：原生可用，无需任何补丁。**
宿主在 `LV()` 里用新增的 `F$t(t, e)` 把原始工具名 `tool_call` 换成
`details.bridgedTool.name`（宿主自动填，例如 `download-file`），
再把修正后的名字交给 `resolveToolOwner`，归属解析因此能命中 v2 App。

**0.970.9：需要一条临时补丁**（仅该版本）。
那一版修出来的名字只喂内置渲染器表，归属解析仍用原始名，卡片会被静默丢弃。
补丁文件见 `_tools/hana-host-patches/`（`patch-2026-09-13-003`），**0.978.0 起已退役**。

### 卡片身份

创建任务时由 App 给出稳定实例 id：`sha256(appId:taskId)` 前 20 位，形如 `a_` + 20 位十六进制，
写进 `details.card.cardInstanceId`。宿主原样采用（实测：重启前后、实时与历史投影四处一致），
卡片加载后报出它就能直接查到任务，不依赖加载顺序推断。

### 备选通道（补丁也不可用时）

可退回 `session:send-custom` + `contributes.messageRenderers`。代价：流式中的投递只能排成
`followUp`，卡片要等本回合结束才出现，而且那条消息会进模型上下文。
清单里的 `messageRenderers` 声明保留着，随时可切回。
## 八、已知限制

1. **历史遗留卡可能抢新任务**：若池子里只剩一条新任务，而某张没有 pending 记录的旧卡先加载，
   它会把这条任务认领走。实际影响很小（新卡在视口里，通常先加载先认领），
   彻底解决需要宿主把消息身份暴露给卡片 iframe。
2. **reload 后工具 RPC 通道失效**：`POST /api/extensions/:ref/reload` 换的是 App 子进程，
   路由逐请求解析所以还活着，工具 RPC 是常驻连接就断了（调用报 `RPC peer closed`）。
   开发期验收仍需重启宿主。**0.978.0 实测仍如此**（见 `docs/踩坑记录.md` 第 14 条）。

> 以下两条为历史限制，**已在宿主 0.978.0 解决**，保留作对照：
>
> - ~~并发投递会被合并~~：那是 `session:send-custom` 隧道的 followUp 队列行为。
>   现在卡片走工具结果通道，不走队列，同一回合并发多张卡各自成块（实测）。
> - ~~聊天流卡宽度不可控~~：0.978.0 起信封宽度上限提到 774px，页面上报生效
>   （实测上报 450 → 渲染 449px）。详见 `docs/踩坑记录.md` 第 6、10 条的新增标注。

---

## 九、卡片尺寸怎么定的

两个数字都不写死在宿主里，各自有明确来源：

| 维度 | 值 | 来源 |
| --- | --- | --- |
| 宽度 | 400px（实测渲染 399px） | 页面用 `hana.ui.resize({ width })` 上报，宿主按“上报值 − 1px”采纳（0.978.0 起生效）；2026-09-17 由 450 收窄 |
| 高度 | 25px（由内容决定，无固定值） | `measureH()` 量身：信息行 18px + 进度条行 4px + 间距 3px；下限 24px 兜底 |

**改宽度**：改 `ui/card.js` 的 `CARD_WIDTH` 与 `index.js` 里两处 `preferredWidthPx`，三处保持一致。
实测（2026-09-17）：同步到副本后**无需重启**，新卡片即按新宽度渲染——
真正生效的是页面上报通道；`index.js` 那两处 `preferredWidthPx` 要等 App 子进程重启（宿主重启）才对齐。

**改高度**：不要动高数值，改 CSS 即可（行高、按钮尺寸、间距都是变量）。注意两点：

1. `body` 主规则里的 `font-size` 会盖掉文件顶部 `html, body` 那条——同名规则后写者胜，且不报错；
2. `measureH()` 里那个下限（`if (h < 24) h = 24`）改大就是把卡片钉在地上，别把它当成测量结果。

实测沿革：45 → 40 → 32 → **25px**（2026-09-17：数据组上移、进度条独占一行后）。

---

## 十、测试

离线测试住在仓库里，一条命令跑完（不依赖网络、宿主与引擎）：

```powershell
cd D:\HanakoWorks\HanaAgentAPPs\hana-downloader-app
node tests/run-tests.mjs
```

覆盖 130 项：输出解析器 46、winget 下载探测 10、展示层单一来源 32、
下载内核端到端 17（含 SHA-256 校验与限速两条路）、并发队列与重试 25。
明细与新增约定见 `tests/README.md`。

七象限投递能力测试（完成 / 取消 / 卡滞 × 未收束 / 已收束 + 卡滞恢复）需要宿主在场，
最新一轮：宿主 0.978.0、**7/7 完成**，见 `docs/七象限测试报告-20260914.md`
（那一轮的卡片宽度还是 450；2026-09-17 起收窄为 400，见第九节）。

造现场用的本地下载源也在仓库里：`tests/servers/`（2MB 快源 / 6MB 一次性 / 6MB 慢速 /
卡滞 / 卡滞恢复），端口表见 `tests/README.md`。

---

## 十一、排障入口

症状 → 先看哪里：

| 症状 | 先查 |
| --- | --- |
| 卡片不出来 / 出来了但认错任务 | 第七节（出卡通道与卡片身份）、`docs/踩坑记录.md` 第 6、10、13 条 |
| 工具调用报 `RPC peer closed` | 只 reload 没重启宿主，见第五节与第 14 条 |
| 工具调用报 `engine fetch failed` | 引擎进程没了：看宿主日志里的 `[hd]` 行；watchdog 每 30s 探活并自动重启 |
| 下载不动 / 卡在某个百分比 | `download-wait <taskId>` 看阶段；卡滞会落盘到 `{appDataDir}/stalled/` |
| 任务显示「排队中」一直不动 | 到了「同时下载上限」：在管理器齿轮里调大或设 0（不限），或等前面的任务结束 |
| 点了重试但 agent 没反应 | 看 App 日志里的 `retry notify`：任务没带会话路径时不会通知（手动造的任务就是这种） |
| 命令失败但错误文案没信息量 | 第 32 条（失败摘要要抓带错误码的那行） |
| winget / pip 下不动或装不上 | 第 33 条（各 CLI 的代理行为实测表）、第 25 条 |
| 改了代码没生效 | `docs/改动生效范围.md`：哪类文件要重启，先过那张表 |
| 同步后校验报大批差异 | 行尾漂移：看仓库根 `.gitattributes` 与第 21 条 |
