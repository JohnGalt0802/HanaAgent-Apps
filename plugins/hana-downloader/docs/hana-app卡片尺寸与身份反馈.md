# 宿主反馈：v2 App 卡片的「尺寸」与「身份」两处缺口

宿主版本：HanaAgent 0.946.2（win32-x64）
反馈者：hana-downloader（v1 plugin → v2 App 全量迁移中）
日期：2026-09-10

这两条都不是下载器独有，任何把「操作按钮」放在卡片里的 v2 App 都会撞上，所以单独成篇。

---

## 一、聊天流卡的宽度：上限由卡壳决定，页面侧上报无效

> 本文早期版本把这条写成“宿主锁定宽度”。实测后修正：**没锁死，是上限由卡壳决定**。

### 现象

卡片里三个操作按钮挤成两行。按常规做法做了两件事：

1. 页面调用 `hana.ui.resize({ width })` 上报期望宽度；
2. 卡片 CSS 把 `max-width` 从 470 调到 540、再调到 620。

**实测毫无变化。**

### 排查

在 `bundle/index.js` 里找到宿主的卡片尺寸桥（`resize-bridge` 注入脚本），它向父窗口发的消息只有一个维度：

```js
var h = <计算出的内容高度>;
if (h !== last) {
  last = h;
  window.parent.postMessage({ type: 'hana.card-resize', height: h }, '*');
}
```

**只有 `height`，没有 `width`。** 但《APPS.md》「尺寸信封」章的挂载位表给出了完整规则：

| 挂载位 | height | width |
| --- | --- | --- |
| 聊天流插件卡 | `flexible`，max 为聊天可视区高度上限 | `flexible`，max 为卡壳 `clientWidth` |
| 黑板 / 拆窗帧 | `fixed`，value 为容器 `clientHeight` | `fixed`，value 为容器 `clientWidth` |
| page / widget | `flexible` | `fixed`，value 为容器 `clientWidth` |

即宽度**不是 locked，而是 flexible**，max 就是卡壳的 `clientWidth`。

实测验证：在卡片里直接量四个宽度（真渲染后取 `getBoundingClientRect`）：

```
iw347 dpr1.75 body347 root347 dl347 CW620      // 小窗口
iw937 dpr1.75 body937 root937 dl937 CW620      // 大窗口
```

三层 DOM（`body` / 根容器 / 内容）**全部等于 iframe 宽度**，说明容器已撑满，
我们设的 620 上限够不到、从未参与。

### 影响

- **页面对“宽于上限”无任何发言权**：宽度没有页面→宿主的上报通道（resize 桥只认 height）。
- 上限 = **卡壳 `clientWidth`**，而卡壳宽度跟随宿主窗口/消息区，不是固定值。
  窗口拉大时 iframe 变宽（实测 347 → 937），卡片跟着变。
- 同一张卡在聊天流与黑板宽窄不同，因为两处上限不同源（黑板走自己的尺寸）。

### 建议

若希望 App 能影响聊天流卡宽（哪怕只是“报告我需要多宽”）：

1. **给 `ui.resize` 的 `width` 一维配上接收方**（现在上报了也没人接）；
2. 或在 `contributes.cards[]` 里给一个声明式宽度提示（类似已有的 `aspectRatio`）；
3. 若都不打算开，希望在 `APPS.md` 尺寸章节**写明「width 上报不生效，上限为卡壳 clientWidth」**，
   省掉每个 App 作者各撞一次墙（本项目为此白改了三个宽度值）。

---

## 二、卡外贡献的按钮拿不到卡身份，无法做「针对某一张卡」的操作

### 背景

窄卡片放不下操作按钮时，自然的解法是把按钮挪到卡外。宿主正好提供了这个位置：

`contributes.ui.cardChrome`（`APPS.md` 第 793 行起），一个应用至多 4 条，落点为**聊天流卡的操作行**与黑板 `plugin-webview` / `plugin-stream-card` 卡的**标题栏**。

### 缺口

`cardChrome` 的 `args` 是清单里的**静态值**，写不了运行时的实例 ID。而点击时宿主经 `ui-actions` 通道传给工具的是：

```
{ ...body.args, context: { sessionPath, messageId, messageText, selectionText? } }
```

其中 `cardChrome` 的 `messageId` **恒为 `null`**（`APPS.md` 第 1394 节明确写出），`context` 里**没有任何卡片实例标识**。

结果：**卡外按钮无法知道自己是从哪一张卡上被点的**。

### 影响

一个 App 在聊天流里同时挂多张卡时（本项目场景：每个下载任务一张进度卡），卡外的「打开 / 打开文件夹 / 复制路径」只能退化为**"对最近一个任务操作"**。任务并发或用户点击历史卡片时必然点错对象，且这种错误是静默的——按钮成功执行了，只是执行在了另一个对象上。

这与已有的另一个问题同源：`/wait` 这类查询接口无参数时同样只能回退到"最近任务"，因为上游没给身份。

### 建议

在 `cardChrome`（以及同通道的 `slotContributions`）的 `context` 里补一个卡片实例标识，例如：

```
context: { sessionPath, messageId, cardInstanceId, surface }
```

对聊天流卡，`cardInstanceId` 用宿主为该 iframe 铸票时的同一次标识（现有 `appSurfaceSession` 已有类似的实例概念，可以复用或对齐）；对黑板卡用 binding 里的卡实例 id。有了它，卡外按钮就能精确定位到某一张卡对应的实体，`args` 保持静态也不会受限。

---

## 小结

两条都指向同一个设计取向：**宿主目前把聊天流卡当成一块只读的展示面**——不给尺寸话语权，也不给身份。这在纯展示场景没问题，但一旦卡片要承载"可操作的对象"（下载任务、后台作业、会话草稿），尺寸和身份就都成了硬需求。

附：本项目对应的踩坑记录见 `hana-downloader-app/docs/踩坑记录.md` 第 6、7、8 条。
