# @deepseek-ai/dsh-client-ui-scroll-flow

DSH Web 对话「流式输出自动滚动过渡动画」客户端插件：模型流式输出时，聊天视图
的贴底自动跟随从「瞬间跳变」变成平滑过渡；同时在 General 设置中提供一个
开关（默认开启），可随时关闭。

纯客户端插件，按 DSH 标准 client-plugin 模式接入（`dsh.client` manifest +
slot 注册 + tsdown client bundle），构建产物 `lib/` 随仓库提供，安装后无需
自己构建即可使用。

## 效果

- **流式平滑跟随**：模型输出过程中，内容持续增长时滚动容器自动跟随最新
  内容，滚动从瞬时跳变变为平滑过渡（`scroll-behavior: smooth`，由浏览器
  原生动画驱动）。
- **Think 摘要横向保持原始速度**：未展开的思考块在流式时逐行滚动摘要
  （`data-follow-end` 行尾跟随）。`scroll-behavior` 是继承属性，若不处理，
  摘要元素会继承滚动容器的 `smooth`——而浏览器平滑动画有固定最小时长、
  跟不上 token 节奏，摘要行会明显落后于文字。规则把 `[data-follow-end]`
  显式钉回 `auto`：每次行尾写入瞬时落地，横向滚动以与 token 完全相同的
  速度跟随（恢复插件接入前的行为），纵向贴底跟随的平滑动画不受影响。
- **精确触发条件**：仅在「模型正在输出（`running`）」且「用户贴底跟随中」
  时生效；流式结束、用户手动滚动离开底部或关闭开关后立即恢复原有行为
  （打开会话、加载更早消息等瞬时滚动保持不变）。
- **不干扰手动滚动**：滚轮 / 触摸等读者滚动始终是浏览器原生手感，不经过
  `scroll-behavior`。
- **尊重系统减动效**：`prefers-reduced-motion: reduce` 下自动禁用平滑，
  保持瞬时行为。
- **跟随状态稳定（滑行守护）**：ChatView 的贴底归属账本假设程序化写入是
  瞬时落地的——平滑滑行中间产生的「gap > 25px 且向底部前进」的 scroll
  事件会被误判为读者滚动，导致大段文本流式或展开 Think 时跟随被错误丢弃、
  「回到底部」按钮闪现。行为组件在 `window` 上挂捕获阶段监听器，仅在
  「流式中 && 开关开 && 前向移动 && gap > 25px」时用
  `stopImmediatePropagation` 拦截这些滑行事件（先于滚动容器上的气泡阶段
  处理器执行），账本因此永远看不到翻转条件：跟随不丢、按钮不出现，平滑
  动画原样保留；读者反向滚动、落地事件与空闲状态全部照常放行，流式结束
  时若滑行仍在进行也会守护到落地为止。
- **状态标签不被待插话顶起**：发送待插话时，待处理消息气泡按 DOM 顺序
  追加在运行状态标签（"Deep diving..."）之后，会把标签顶高、消息被采纳
  后又回落。流式期间用 flex `order` 把标签固定为流程列的最后一项，气泡
  落在标签上方、标签的滚动位移随之抵消，屏幕上位置全程不变。
- **状态标签不随行跳动（视觉钉住）**：平滑滑行永远不会瞬时落地，因此每
  次追加一行后、滑行到位的间隙里，视图会滞后于内容底部几个像素——而运行
  状态标签恰好是流程列的最后一项，这残余滞后就表现为标签随每一行上下
  震动几个像素（未加平滑时是瞬时写入、无滞后，所以标签是固定的）。与其
  把滚动位置拍平（那会让逐行小提交——尤其是展开 Think 的垂直跟随——失去
  过渡动画），行为组件改为只补偿标签本身：流式期间以 rAF 循环给标签施加
  `translateY(-min(滞后, 80px))`，标签视觉位置恒定、逐行震动消失，而
  滚动位置完全不被触碰，展开 Think 等内容的垂直平滑动画原样保留。高刷
  屏（600Hz）上 CSS smooth 的动画时长固定（~500ms，与刷新率无关），内容
  增长快于动画时会产生 30–60px 的稳态滞后——补偿上限 80px 覆盖该范围；
  滞后超过上限时（标签文字抖动、大段落等）触发**一次**「回底纠正」：把
  `scrollTop` 写回 `scrollHeight - clientHeight` 让滑行落地（守护器照常
  拦截中间事件）。标签文字自身的亚像素级变化（Deep diving 计时器每秒
  重渲染）落在死区（≤0.5px）内不做任何补偿，杜绝 1px 抖动。读者向上滚动
  会清除「跟随意图」——钉住与回底纠正同时失效，读者不会被拉回底部。
- **新消息逐行淡入**：每次新挂载的行——消息气泡、工具调用行、折叠思考的
  摘要行、消息内每一条 Markdown 块行（段落、列表项、代码块、引用、标题、
  脚注）——都执行 220ms 淡入（Web Animations API，无需 keyframes），元素
  从第一帧起占据布局位，历史消息被自然推上去。MutationObserver 监听流程
  列子树的插入，行级判定 = `data-chat-flow-key`（流程项）或
  `data-follow-end`（折叠思考行尾）或行级块标签（p/li/pre/blockquote/
  heading/ul/ol/table/figure/section/hr）；同一批次插入的整块消息会
  递归淡入其内部各行，行内 inline 元素（span、图标）不触发，
  `prefers-reduced-motion` 用户看到普通插入。**展开的思考内容**没有 DOM
  行（ReasoningRow 渲染单个文本块），插件把文本按换行拆成行元素、每行
  与普通消息行一样 220ms 淡入、行与行之间错开 30ms 依次显现（仅思考已
  定稿时拆行，流式中的展开保持原样以避免与 React 重渲染冲突；同一行
  500ms 内不重复淡入，防止批量插入被多次报告时重放动画）。
- **独立设置菜单项**：Settings 导航新增「滚动动画」页面（`settings.section`
  菜单项），页内提供「流式滚动动画」与「调试日志」两个开关，偏好持久化到
  浏览器 localStorage（`ui-scroll-flow` 键；Host 设置传输的写回不可靠，
  刷新即丢，故弃用）。
- **调试记录器（Debug）**：开启「调试日志」后，插件把关键事件与运行指标
  写入环形日志缓冲（**约 2 万条上限**，写满后丢弃最旧）：状态切换（tag
  开/关、scrollport 变更）、滑行守护（抑制进入/释放）、标签钉住
  （translateY 补偿值）、横向摘要跟随（拦截安装/释放 + 动画采样）、以及
  **帧率记录器**（每秒一条 fps + 帧间隔 >200ms 的 jank 卡顿标记）。可通过
  `window.__DSH_SCROLL_FLOW_DEBUG__` 实时查看：`logs()` 取日志、
  `stats()` 按类型统计、`clear()` 清空、`active()` 查询开关状态。

## 标准模式接入说明

| 层 | 位置 | 说明 |
|---|---|---|
| 包 manifest | `package.json` 的 `dsh.client` | `platform: 'web'` + `inject` 依赖列表（informational） |
| 浏览器入口 | `src/client/index.ts` | `exports["./client"]` → `lib/client.js`，`__ModuleLoader__` 包裹 |
| 设置页 | `settings.section` slot | id `scroll-flow`（order 100），导航标签「滚动动画」，页内两个开关（动画 + 调试日志，role="switch"） |
| 行为组件 | `conversation.composer.dock` slot | 隐藏锚点 + `data-scroll-flow` 标记切换 |
| 平滑规则 | `ScrollFlowBehavior.module.css` | `:global` 规则：滚动容器 `[data-conversation-scroll][data-scroll-flow]` → `smooth`；折叠摘要 `… [data-follow-end]` → `auto`（覆盖继承，配合 JS 快速跟随） |
| 调试记录 | `src/client/debug-logger.ts` | 2 万条环形缓冲 + 帧率/卡顿记录器 + `window.__DSH_SCROLL_FLOW_DEBUG__` 探针 |
| 持久化 | `src/client/policy.ts` | 浏览器 localStorage（`ui-scroll-flow` 键，JSON 双字段） |

工作流：模型流式（`useSession(s => s.running)`）且偏好开启时，行为组件给
对话滚动容器（`[data-conversation-scroll]`，ConversationRoot 的
scrollBody）打上 `data-scroll-flow` 标记；ChatView 自身的贴底跟随写入
（`el.scrollTop = el.scrollHeight`）随即被 CSS 平滑化；同一标记下的折叠
Think 摘要（ReasoningRow 的 `data-follow-end` 行尾跟随写入）被 JS 拦截
（`scroll-behavior: auto` 钉回 + 实例级 `scrollLeft` 遮蔽），写入只记录为
目标、由 rAF 循环以**时间基准** easing 插值（时间常数 30ms 小增量 / 10ms
大增量，与刷新率无关：600Hz 屏与 60Hz 屏看到同样的 ~90ms 过渡，逐帧 easing
在高刷屏上会退化成瞬跳）。标记在流式结束、开关关闭或会话卸载时立即移除。

## 构建

需要 Node.js 22+ 与 pnpm。

```sh
pnpm install          # 安装构建 / 测试依赖（registry 上的 @deepseek-ai 0.1.0-rc.8 系列）
pnpm build            # tsc -b && tsdown → lib/（index.js + invariant.js + client.js）
```

产物说明：

- `lib/index.js` — node half（空 apply，供 Host Loader 发现）
- `lib/invariant.js` — invariant companion
- `lib/client.js` — 浏览器 bundle（`window.__ModuleLoader__.load` 包裹，
  externals 走平台模块表：react / cordis / ui-slots / runtime/client 等）

## 安装到 DSH Web

```sh
# 在本仓库目录下：
pnpm dsh plugin --profile web add "$PWD"
```

这会向 `$DSH_HOME/profiles/web/` 写入指向本仓库的依赖并组合进 web
profile。首次安装后重启 `pnpm dsh web`（之后的构建产物实时生效，刷新页面
即可）：

```sh
# 停掉当前 dsh web，然后：
pnpm dsh web
```

打开 `http://127.0.0.1:3080`：`window.__DSH_BOOT__` 中出现
`@deepseek-ai/dsh-client-ui-scroll-flow` 条目、`/plugins/@deepseek-ai/dsh-client-ui-scroll-flow/client.js`
可访问，即加载成功。随后在设置 → 滚动动画页面确认「流式滚动动画」与
「调试日志」开关。

### 调试日志查看

设置 → 滚动动画页打开「调试日志」后，在 DevTools Console 里：

```js
window.__DSH_SCROLL_FLOW_DEBUG__.stats()   // 各类型事件计数 + 总量
window.__DSH_SCROLL_FLOW_DEBUG__.logs()    // 最近约 2 万条（旧→新）
window.__DSH_SCROLL_FLOW_DEBUG__.clear()   // 清空缓冲
window.__DSH_SCROLL_FLOW_DEBUG__.active()  // 记录器是否开启
```

事件类型：`state`（标记开/关、scrollport 变更）、`guard`（滑行守护抑制
进入/释放）、`pin`（状态标签补偿值）、`follow`（摘要跟随拦截/动画采样）、
`fps`（每秒帧率）、`jank`（帧间隔 >200ms 卡顿，含后台标签页冻结）。

### 热重载（开发时）

每次 `pnpm run build` 后刷新 `http://127.0.0.1:3080` 即可（服务器实时读取
`lib/client.js`），无需重启服务器。

## 测试

```sh
pnpm test             # vitest（jsdom）：policy / 设置行 / 行为组件
```

## 目录结构

```
src/
  index.ts                  # node half（空 apply）
  invariant.ts              # invariant companion
  settings.ts               # 偏好类型 + 字段常量 + 默认值（localStorage 契约）
  css-modules.d.ts          # CSS Modules 类型声明
  client/
    index.ts                # 浏览器入口：locale 注册 + 两处 slot 注册
    locales.ts              # zh / en 字典
    policy.ts               # 偏好持久化（localStorage ↔ 快照 store）
    ScrollFlowSection.tsx    # 独立设置页「滚动动画」（两个开关）
    ScrollFlowSection.module.css
    ScrollFlowBehavior.tsx  # dock 行为组件（流式感知标记切换）
    ScrollFlowBehavior.module.css  # 平滑滚动规则（含 reduced-motion）
    debug-logger.ts         # 调试记录器（环形缓冲 + 帧率/卡顿 + 探针）
build/
  tsdown.client.ts          # DSH 标准 client bundle 预设（拷贝自仓库）
  platform.ts               # 平台模块表
tests/                      # vitest 规格
tsdown.config.ts
tsconfig.json
package.json
```
