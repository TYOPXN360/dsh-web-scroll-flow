# dsh-web-scroll-flow

DSH Web 对话滚动动效插件：自动跟随滚动动画、边缘橡皮筋回弹、流式逐字打字机。

纯客户端插件，源码 + 预构建产物都在仓库里，安装后无需自己构建即可直接看到效果。

## 效果

1. **自动跟随滚动动画**：内容流入 / 自动换行时，贴底跟随从"瞬间跳变"变成自然的平滑推送。小增量（流式逐字）近乎瞬时，大距离（回到底部、展开思维链）平滑过渡；底部状态行（Deep diving、时间、待插话消息）保持固定不漂移。
2. **边缘橡皮筋回弹**：手动滚动到顶部 / 底部后继续向外滚，内容跟手持续拉动（无硬上限），滚轮停止后才弹簧回弹归位，类似手机的橡皮筋手感。消息内部可滚动的子容器（详情、代码块）不触发页面回弹。
3. **流式逐字打字机**：思维链与正文在流式输出时以字为单位逐字显示，带闪烁光标；段落间距与完成后的 Markdown 一致，打完字不跳变、不预留整段空白；大段文本按公式自动提速。初次加载 / 刷新页面时历史消息不会全部重新打字。
4. **设置面板可调**：General 设置中新增三项，选择持久化到 Host：
   - 自动滚动动画：关闭 / 优雅（慢速上推）/ 适中（默认）
   - 边缘回弹：开关
   - 打字机效果：开关

`prefers-reduced-motion`（系统减动效）下自动跟随动画与回弹禁用，保持瞬时行为。

## 安装到 DSH Web

仓库自带预构建产物（`lib/index.js`、`lib/client.js`），克隆后**无需构建**，直接安装即可看到效果：

```sh
git clone https://github.com/<owner>/dsh-web-scroll-flow.git
cd dsh-web-scroll-flow
pnpm install            # 安装 link 解析需要的依赖（不构建插件）
pnpm dsh plugin --profile web add "$PWD"
```

这会向 `$DSH_HOME/profiles/web/package.json` 写入
`"dsh-web-scroll-flow": "link:<本目录>"` 依赖，并把包加入
`dsh.profile.bundles` 层列表。首次安装需要重启 `pnpm dsh web`：

```sh
# 停掉当前 dsh web，然后：
pnpm dsh web
```

打开 `http://127.0.0.1:3080`：`window.__DSH_BOOT__` 中出现
`dsh-web-scroll-flow` 条目，`/plugins/dsh-web-scroll-flow/client.js`
可访问，即加载成功。

### 热重载（开发时）

每次 `pnpm run build` 后刷新 `http://127.0.0.1:3080` 即可（服务器实时读取
`lib/client.js`），无需重启服务器；只有首次安装需要重启 `pnpm dsh web`
使 profile 组合生效。

## 开发

```sh
pnpm install          # 安装构建 / 测试依赖
pnpm run typecheck    # tsc --noEmit
pnpm run test         # vitest（jsdom）
pnpm run build        # tsdown → lib/（index.js + client.js）
pnpm run check        # 三者一起
```

仓库提交了预构建产物（`lib/index.js`、`lib/client.js`、`lib/index.d.ts`），
sourcemap 与依赖目录不入库。修改源码后请重新 `pnpm run build` 再提交，
确保 `lib/client.js` 与源码同步。

## 目录结构

```
src/
  index.ts                       节点半入口（空 apply，使行成为合法 loader 条目）
  client/
    index.ts                     浏览器半入口：扫描 + 挂载 + 设置接线
    scroll-flow-controller.ts    滚动控制器：跟随动画 / 橡皮筋回弹（零依赖，可独立测试）
    scroll-flow-settings.ts      设置类型 / 持久化 policy
    settings-row.tsx             General 设置行（动画档位 + 回弹 + 打字机开关）
    typewriter.ts                逐字打字机：思维链 + 正文，段落间距 / 光标 / 提速
tests/                           vitest + jsdom 测试
cordis.patch.yml                 bundle patch：插入 dsh.client 行
tsdown.config.ts                 构建配置（node 半 ESM + client 半 CJS bundle）
lib/                             预构建产物（client.js 供运行时加载，index.js 供 loader 解析）
```

## 原理

插件是纯 DOM 层增强，不修改 DSH 本体代码：

- 用 `MutationObserver` 监听文档中的对话滚动容器
  `[data-conversation-scroll]`（ConversationRoot 的 scrollBody），挂载
  `ScrollFlowController` 与 `TypewriterController`。
- **自动跟随动画**：对容器实例覆写 `scrollTop`（configurable，dispose 时
  删除还原）。程序性"贴底跟随"写入（目标 == `scrollHeight`）被拦截：
  小增量贴底跟随瞬时落底并播放整列入场推升（ChatAnimation 式，新内容
  从底部出现、旧消息整体上推）；大距离跳转（回到底部）保留平滑缓动。
  其它写入（恢复位置、prepend 锚定）原样瞬时通过。只有明确的用户输入
  （滚轮 / 触摸 / 鼠标按下 / 键盘滚动）会打断动画。
- **边缘橡皮筋**：监听滚轮事件，仅在顶 / 底边缘继续向外滚时跟手累积
  位移（软增益递减、无硬上限），滚轮停止 `releaseDelay` 后弹簧回中。
- **打字机**：MutationObserver 只对"文本实际增长"的 Markdown 启动打字
  （历史消息不打字）；打字期间目标 Markdown `display:none` 不占高，覆盖层
  正常流逐字显示，按 `\n\n` 拆段并复制段落 margin，光标跟随正在输入的
  段落；停止增长后恢复原始 Markdown，并在恢复瞬间抑制入场推升避免回弹。
- **设置**：`ctx.settingsScope` 绑定 `dsh-web-scroll-flow` 命名空间，
  General 设置行通过 `settings.general.item` 插槽注册；切换档位 / 开关时
  实时更新已挂载的所有控制器。

## 调参

默认参数在 `src/client/scroll-flow-controller.ts` 顶部的
`DEFAULT_FOLLOW` / `DEFAULT_BOUNCE`，以及 `src/client/typewriter.ts` 的
`DEFAULT_OPTIONS`：

- 跟随动画最大时长（200ms，满 200px 距离）
- 回弹软增益参考距离（24px）、弹簧刚度 / 阻尼 / 滚轮灵敏度 / 松手延迟
- 打字机基础速度（约 60 字/秒）、停止判定、光标保持、加载宽限期

修改后重新 `pnpm run build` 并刷新页面。

用户也可以在 General 设置里直接切换动画档位（优雅 = 380ms 慢速上推）、
回弹开关、打字机开关，无需改代码。

## 卸载

```sh
pnpm dsh plugin --profile web remove dsh-web-scroll-flow
```

重启 `dsh web` 后插件不再加载，浏览器行为完全还原。

## License

MIT
