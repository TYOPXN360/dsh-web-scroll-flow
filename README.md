# dsh-web-scroll-flow

DSH Web 对话滚动动效插件（客户端插件，源码构建，无需上架 NPM）。

## 效果

1. **自动跟随平滑滚动**：内容流入 / 自动换行时，DSH 自己把滚动贴到底部
   （`scrollTop = scrollHeight`）——原本是瞬间跳变，本插件把它变成自然
   缓动过渡：思考链逐字输出时，内容向上顶、视口平滑向下拉。
   动画时长按距离自适应：大距离（展开思维链、回到底部）平滑慢推，
   小增量（流式逐字增长）近乎瞬时，底部状态行不漂移。
2. **手动滚动保持原生**：滚轮 / 触摸滚动不做任何插值，手感与浏览器
   原生一致；仅当手动滚动到顶 / 底边缘时叠加小幅物理回弹。
3. **状态行保持固定**：Deep diving、时间、待插话消息在自动跟随动画和
   回弹期间保持在原位置，不随内容上下震动。
4. **设置面板可调**：General 设置中新增"自动滚动动画"（关闭 / 优雅 /
   适中）与"边缘回弹"开关，选择持久化到 Host。

`prefers-reduced-motion`（系统减动效）下自动跟随动画与回弹全部禁用，
保持瞬时行为。

## 原理

插件是纯 DOM 层增强，不修改 DSH 本体代码：

- 用 `MutationObserver` 监听文档中的对话滚动容器
  `[data-conversation-scroll]`（ConversationRoot 的 scrollBody），挂载
  `ScrollFlowController`。
- **自动跟随动画**：对容器实例覆写 `scrollTop` 属性
  （configurable，dispose 时删除还原）。程序性"贴底跟随"写入
  （目标 == `scrollHeight`）被拦截：立即向读取方报告目标值（ChatView
  的 atBottom 账本保持一致，不会闪回底按钮），真实滚动位置由
  requestAnimationFrame 按 easeOutCubic 缓动逼近；新内容到达时平滑
  重定向到新底部。其它写入（会话恢复位置、prepend 锚定）原样瞬时
  通过。只有明确的用户输入（滚轮 / 触摸 / 鼠标按下 / 键盘滚动）会
  打断动画，程序写入触发的 scroll 事件不会误判。
- **边缘回弹**：监听滚轮事件，仅在顶 / 底边缘继续向外滚时把
  `[data-chat-flow]` 内容列做 `transform: translateY` 小幅拉伸，
  松手后按弹簧模型（刚度 / 阻尼）回弹归位。消息内部可滚动的子容器
  （详情、代码块）会消费滚轮，不触发页面回弹；`defaultPrevented` 的
  滚轮（输入栏链式滚动）自动忽略。
- **设置**：`ctx.settingsScope` 绑定 `dsh-web-scroll-flow` 命名空间，
  General 设置行通过 `settings.general.item` 插槽注册；切换档位 / 开关
  时实时更新已挂载的所有控制器。

## 目录结构

```
src/
  index.ts                       节点半入口（空 apply，使行成为合法 loader 条目）
  client/
    index.ts                     浏览器半入口：扫描 + 挂载 + 设置接线
    scroll-flow-controller.ts    核心控制器（零依赖，可独立测试）
    scroll-flow-settings.ts      设置类型 / 持久化 policy
    settings-row.tsx             General 设置行（动画档位 + 弹簧开关）
tests/                           vitest + jsdom 测试
cordis.patch.yml                 bundle patch：插入 dsh.client 行
tsdown.config.ts                 构建配置（node 半 ESM + client 半 CJS bundle）
```

## 开发

```sh
pnpm install          # 安装构建 / 测试依赖（store 已配置在 .npmrc）
pnpm run typecheck    # tsc --noEmit
pnpm run test         # vitest（jsdom）
pnpm run build        # tsdown → lib/（index.js + client.js）
pnpm run check        # 三者一起
```

## 安装到 DSH Web

前提：仓库检出运行过 `pnpm dsh web`（开发模式）。构建产物就绪后：

```sh
pnpm dsh plugin --profile web add /mnt/TY/dsh/dsh-web-scroll-flow
```

这会向 `$DSH_HOME/profiles/web/package.json` 写入
`"dsh-web-scroll-flow": "link:<本目录>"` 依赖，并把包加入
`dsh.profile.bundles` 层列表。热重载：每次 `pnpm run build` 后刷新
`http://127.0.0.1:3080` 即可（服务器实时读取 `lib/client.js`）；只有
首次安装需要重启 `pnpm dsh web` 使 profile 组合生效。

浏览器打开 `http://127.0.0.1:3080`：`window.__DSH_BOOT__` 中出现
`dsh-web-scroll-flow` 条目，`/plugins/dsh-web-scroll-flow/client.js`
可访问，即加载成功。

## 调参

默认参数在 `src/client/scroll-flow-controller.ts` 顶部的
`DEFAULT_FOLLOW` / `DEFAULT_BOUNCE` 常量：跟随动画最大时长（200ms，
满 200px 距离）、回弹幅度（24px）、弹簧刚度 / 阻尼 / 滚轮灵敏度 /
松手延迟。修改后重新 `pnpm run build` 并刷新页面。

用户也可以在 General 设置里直接切换动画档位（优雅 = 380ms 慢速上推）
与弹簧开关，无需改代码。

## 卸载

```sh
pnpm dsh plugin --profile web remove dsh-web-scroll-flow
```

重启 `dsh web` 后插件不再加载，浏览器行为完全还原。
