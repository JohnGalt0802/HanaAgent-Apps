# winget / pip 链路规划（2026-09-18）

给 hana-downloader-app 加两种新任务类型：`winget-install`（Windows 软件安装）与
`pip-install`（Python 包安装）。后端为两者各开一条独立执行链路，前端复用现有卡片与
管理器的统一渲染。本文是动手前的方案，含本次对两个工具输出格式的实测取证。

---

## 一、基线

- `download-command` 现有两种 kind：`git-clone` / `pnpm-install`；执行在
  `engine/dlcore.js::_runCommand`，输出解析在 `engine/progress-parsers.js`。
- 任务模型（create / 进度 / 终态 / 取消 / 卡片绑定 / 结算）与前端全部复用，
  两条新链路不新开任务形态。

## 二、实测事实（成色：实测，2026-09-18 本机）

### 2.1 winget（v1.29.290，中文系统，管道模式）

非 tty（管道）下**没有进度条、没有 \r 重绘**，输出是干净的中文阶段行（stdout，UTF-8）：

| 输出行 | 含义 |
| --- | --- |
| `已找到 jq [jqlang.jq] 版本 1.8.2` | 找到包（可解析名称 / ID / 版本） |
| `正在下载 https://...` | 开始下载 |
| `已成功验证安装程序哈希` | 校验哈希 |
| `正在启动程序包安装...` | 进入安装 |
| `已修改路径环境变量；重启 shell 以使用新值。` / `添加了命令行别名："jq"` | 安装收尾提示 |
| `已成功安装` | 完成 |

- 已安装场景：`找到已安装的现有包。正在尝试升级已安装的包...` + `找不到可用的升级。`
  退出码 `0x8A15002B`（UPDATE_NOT_APPLICABLE）。语义为「已安装且无更新」。
- 找不到包：`找不到与输入条件匹配的程序包。`，退出码 `0x8A150014`（NO_APPLICATIONS_FOUND）。
- **退出码是 HRESULT 风格**（0x8A15xxxx），Node 以无符号数返回（实测 2316632084 / 2316632107），
  映射前用 `code >>> 0` 归一。

本次要用到的码：

| 码 | 符号 | 处理 |
| --- | --- | --- |
| 0 | 成功 | done |
| 0x8A15002B | UPDATE_NOT_APPLICABLE | done（已安装，无更新） |
| 0x8A15010D | INSTALL_ALREADY_INSTALLED | done（已安装另一版本） |
| 0x8A150014 | NO_APPLICATIONS_FOUND | failed（找不到包） |
| 0x8A150016 | MULTIPLE_APPLICATIONS_FOUND | 不会到达（候选流程已前置拦截） |
| 0x8A150019 | COMMAND_REQUIRES_ADMIN | failed（需要管理员） |
| 0x8A150008 | DOWNLOAD_FAILED | failed |
| 0x8A150107 | INSTALL_NO_NETWORK | failed |
| 0x8A150109 / 0x8A15010A | REBOOT_REQUIRED | done + note（需重启） |
| 0x8A15010C | INSTALL_CANCELLED_BY_USER | canceled |
| 其他非零 | | failed + 显示 `0x...` |

### 2.2 pip（系统 Python 3.14.4 / pip 26.0.1，管道模式）

非 tty 下无进度条，逐行输出（stdout）：

| 输出行 | 含义 |
| --- | --- |
| `Collecting six` | 解析依赖 |
| `  Downloading six-1.17.0-….whl.metadata (1.7 kB)` | 取元数据（缩进两格，归入 collecting） |
| `Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)` | 下载（含文件名 + 大小） |
| `Installing collected packages: six` | 安装 |
| `Successfully installed six-1.17.0` | 完成 |

- 已安装场景：`Requirement already satisfied: six in … (1.17.0)`，退出码 0。
- stderr 偶发 pip 版本升级提示（`[notice] A new release of pip…`），忽略。

### 2.3 uv（0.11.25，作为 pip 的替代 runner）

`uv pip install six --python <venv>\Scripts\python.exe` 输出在 **stderr**：

```
Using Python 3.12.13 environment at: …      → resolving
Resolved 1 package in 1.43s                 → resolving 完成
Installed 1 package in 24ms                 → installing 完成
 + six==1.17.0                              → 结果明细
```

uv 需要显式环境：`--python <解释器>` 或 `--system`；不指定时报错。

## 三、设计

### 3.1 工具面：扩展 download-command（不开新工具）

`kind` 枚举加到四种：`git-clone | pnpm-install | winget-install | pip-install`。

新参数（按 kind 适用）：

| 参数 | 适用 | 说明 |
| --- | --- | --- |
| `pkg` | winget / pip | 包 ID 或名称（winget 支持模糊，见 3.2） |
| `scope` | winget 可选 | `user` / `machine` |
| `source` | winget 可选 | 源名，透传 `--source` |
| `pythonPath` | pip 可选 | 解释器 / venv 的 python.exe 绝对路径 |
| `runner` | pip 可选 | `python`（默认）/ `uv` |
| `upgrade` | pip 可选 | 透传 `--upgrade` |

**范围边界**（第一版不做）：批量多包、requirements.txt、uninstall、
UAC 提权交互、uv venv 创建。

### 3.2 winget 链路

执行命令（数组传参，无 shell）：

```
winget install --id <pkg> -e --accept-package-agreements --accept-source-agreements
  --disable-interactivity [--scope X] [--source X]
```

**模糊查询两段式**：`/command` 收到 winget-install 后先同步跑一次

```
winget search --query <pkg> --accept-source-agreements --disable-interactivity
```

- 候选中命中精确 ID（忽略大小写）→ 直接安装（覆盖「用户输入精确 id」场景）；
- 唯一候选 → 用它的 ID 安装；
- 多候选 → **不创建任务**，`/command` 返回 `{ candidates: [...] }`，
  工具把候选列表转给模型；模型选定后以完整 ID 重调一次；
- 零候选 → 直接返回失败文本，不创建任务。

候选解析：search 表格按 2+ 空格分列（名称 / ID / 版本 / 匹配 / 源），取前 10 条。

命令行解析：`where winget` → 已知位置兜底
（`%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe`），沿用 findPnpmEntry 的思路。

### 3.3 pip 链路

- 解释器解析：`pythonPath` 参数 > `where python` 第一个（校验可执行）> `py` 兜底。
- python runner：`<python> -m pip install --no-input <pkg> [--upgrade]`。
- uv runner：`uv pip install --python <解释器> <pkg> [--upgrade]`；
  无 pythonPath 时改用 `--system`（实施时以实测为准）。

### 3.4 执行框架：表驱动分派

`_runCommand` 重构为读一张 `COMMAND_SPECS` 表，每条链路的四点独立配置：
二进制解析 / 参数构造 / 输出解析 / 终态判定（退出码映射）。
执行框架（spawn、进度喂入、停滞监视、取消、终态、卡片、结算）完全共用。

### 3.5 进度与展示

- **阶段式**，不伪造百分比：
  - winget：`found → downloading → verifying → installing`；
  - pip：`collecting → downloading → installing`。
  - stage 键与现有词表不冲突（git 的 `resolving` 是「解析增量」，pip 另用 `collecting`）。
- 卡片：信息行显示阶段文案；无数字（百分比 / 大小 / 速度）时数字组不渲染；
  进度条走既有 `indet` 流线样式。
- 完成任务：不显示「打开 / 文件夹」按钮；新增 `note` 轻字段
  （如「已安装 jq 1.8.2」「PATH 已更新，重启 shell 后生效」），
  进 snapshot / summarize，卡片详情与结算文本使用。
- 管理器：运行中行显示阶段文案；winget / pip 任务的 url 字段填
  `winget:<id>` / `pip:<pkg>`，搜索与详情行自然可用。

### 3.6 铁律与结算

- pre-step 铁律补一句：安装软件 / Python 包走 download-command 的
  winget-install / pip-install，禁止裸跑 winget / pip 命令。
- settleWhenDone：command 类任务完成文案用「安装完成：<note|fileName>」，不显示路径行。

## 四、改动清单

| 文件 | 改动 |
| --- | --- |
| engine/progress-parsers.js | +createWingetParser / createPipParser（纯函数，中英双语匹配） |
| engine/dlcore.js | +COMMAND_SPECS 表、winget/pip 参数构造、退出码映射、note 字段 |
| engine/server.js | /command 扩展 kind 校验与参数透传、winget 候选流程（同步 search） |
| index.js | download-command 描述 / 参数 schema / 文案、铁律、结算文案 |
| ui/card.js | STAGE_TEXT 扩展、数字组空处理、完成态按钮分支、note 展示 |
| ui/manager.js | 运行中阶段文案、详情行补充 |
| README.md / docs | 更新能力表与踩坑记录 |

## 五、验证计划

1. **解析器单测**：用本次实测的输出当样例喂纯函数（node 直跑）。
2. **e2e**：
   - winget：`jqlang.jq` 安装（测后卸载还原）；重复安装（已安装分支）；
     不存在包（失败路径）；多候选（模糊词）。
   - pip：临时 venv 安装 six；重复安装（already satisfied）；uv runner 同场景。
3. **回归**：URL 下载一张卡；git / pnpm 任务显示不变。
4. **同步副本 + 重启宿主**（sync 脚本 -Restart 路径）后验收。

## 六、待拍板

1. 工具面：扩展 download-command（推荐）/ 新开 download-package 工具。
2. pip runner：python + uv 双支持（推荐）/ 只做 python。
3. 进度表现：阶段式 indeterminate（推荐）/ 阶段映射假百分比。
4. winget 提权：第一版仅错误码提示（推荐）/ 尝试 UAC（受管进程下大概率不可行）。

## 七、风险与实施首步验证

- **受管进程环境**：winget 在 WindowsApps alias、python 在用户目录，受管进程能否
  spawn 它们需在实施首步验证（引擎加临时探测：spawn `where.exe winget python` 写日志）；
  失败则走绝对路径兜底。
- machine scope / UAC 非交互行为未实测，以错误码兜底，文档标注。
- 系统语言假设：解析器中英双语匹配；若输出第三种语言，仅丢失阶段文案，任务不受影响。
