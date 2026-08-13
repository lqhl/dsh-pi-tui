# dsh-pi-tui 实现规划

> 基于 [pi 的 TUI 库](https://github.com/earendil-works/pi/tree/main/packages/tui)（`@mariozechner/pi-tui`）为 DeepSeek Harness 实现一个 TUI 插件。
> 本文档为调研结论 + 实现规划，供 review。证据来源：本地克隆 `~/workspace/pi-mono`（2026-08-13 最新 commit）、已安装的 dsh `0.1.0-rc.6`（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`）、社区先例 `dsh-cc-tui` / `dsh-grok-tui` 源码。

---

## 0. 结论摘要

**可行，且成本可控。** 理由：

1. **pi-tui 是纯渲染库**：MIT 协议、npm 已发布（`@mariozechner/pi-tui@0.73.1`）、node>=20、与 pi 的 agent/ai/mom 生态零 import 耦合（已 grep 验证）。可以像用 chalk 一样直接 `npm i` 使用，无需 fork、无需跟随 pi 的 agent 循环。
2. **"事件 → UI" 的粘合层有现成蓝本**：pi 自己的 coding-agent TUI（`interactive-mode.ts` 5425 行 + 30 个组件）展示了一套会话渲染模式，但它是"组件消费事件流"的命令式写法，对数据源的耦合很浅，可移植到 dsh 的事件流上。
3. **dsh 侧有官方插件范式**：`dsh-cc-tui` 已验证「cordis bundle 插件 + 同进程注入 `ctx.agents`/`ctx.sessions`，零网络渲染会话」这条路径。我们的插件结构照抄这个范式，只是把渲染层换成 pi-tui。
4. **冒烟已验证**：pi-tui 独立安装 + ESM import 56 个导出全部可用（本机 node v25 实测）。

**核心工作量估计：~1000–1500 行 TypeScript 适配层**（不含依赖），分 4 个里程碑（见 §4）。

---

## 1. 调研发现

### 1.1 pi-tui：纯 UI 库（渲染层）

| 项 | 结论 |
|---|---|
| npm 包 | `@mariozechner/pi-tui`，latest **0.73.1**（313 个版本），MIT，纯 ESM（`"type":"module"`），无 `exports` 封锁 |
| 依赖 | 仅 chalk / marked / mime-types / get-east-asian-width，`koffi` 为 optional（Windows Shift+Tab 用） |
| 规模 | src 25 文件 / 11,070 行；test 28 文件 / 11,038 行（node 内置 test runner） |
| 独立性 | `packages/tui/src` 无任何对 pi 其他包的 import（已 grep `@mariozechner`/`@earendil`/`../../` 为空） |

**组件模型**（命令式，非虚拟 DOM）：

```ts
interface Component {
  render(width: number): string[];   // 每行必须 <= width
  handleInput?(data: string): void;  // 焦点组件收键盘输入
  invalidate(): void;
}
```

- 内置组件：`Text` `TruncatedText` `Input` `Editor` `Markdown` `Loader` `CancellableLoader` `SelectList` `SettingsList` `Spacer` `Box` `Container` `Image`（Kitty/iTerm2 协议）。
- `TUI` 主类：`addChild/removeChild`、`setFocus`、`showOverlay/hideOverlay`、`addInputListener`、`requestRender()`。
- **渲染管线**：事件驱动 + 16ms 节流；3 策略差分渲染（首帧全量 / 宽度变化清屏 / 差异行输出）；CSI 2026 同步输出防闪烁；bracketed paste；Kitty keyboard protocol；IME 支持（`Focusable` + `CURSOR_MARKER`，CJK 输入法候选窗定位正确）。
- `ProcessTerminal`：raw mode + stdin 管理 + 退出前 drainInput。
- `Editor` 自带 slash 命令 / 文件路径自动补全（`CombinedAutocompleteProvider`）。

**已知缺口（需要自建）**：
1. **无滚动容器** —— 长会话消息列表需要自建可滚动 Container（pi 自己的 `session-selector.ts`/`tree-selector.ts` 有滚动逻辑可参考）。
2. **无剪贴板** —— 可选，首版忽略。
3. `VirtualTerminal` 不导出（npm 构建产物里没有）—— CI headless 测试改为自实现 30 行的 `Terminal` mock（接口很小：`write/columns/rows/cursor ops`）。

### 1.2 pi coding-agent 的 TUI：蓝本（不改代码，借鉴模式）

- 主文件 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：持 `ui: TUI` + `chatContainer/pendingMessagesContainer/statusContainer` 三个 Container。
- 事件协议：`AgentSession.subscribe(listener)` 收 `agent_start/end`、`turn_*`、`message_start/message_update/message_end`、`tool_execution_start/update/end`、`compaction_*` 等；**每个流式事件带全量 `partial` 消息快照**（流式渲染 = 全量重建组件内容，靠 diff renderer 保性能）。
- 组件库（MIT，可改编）：`assistant-message.ts`（Markdown + thinking 折叠）、`tool-execution.ts`（工具调用卡片，352 行）、`bash-execution.ts`、`diff.ts`、`footer.ts`、`model-selector.ts`、`session-selector-search.ts`、`theme/theme.ts`。
- **耦合点很浅**：组件只依赖消息形状 `{content: (text|thinking|toolCall)[]}`，把 dsh 的 session 事件归一化成这个形状即可复用渲染逻辑。

### 1.3 dsh 侧接入面（同进程 cordis 服务，零网络）

`dsh-base` bundle（安装版实测 451 行 patch）已挂载 TUI 所需的全部服务行：
`agent` `session` `session-projection` `session-persistence-jsonl` `session-query-sqlite` `commands`（+/compact、/goal、/plan、/feedback）`approval` `user-questions` `permission` `settings` `token-meter` `jobs` `subagent` `goal` `plan-mode` `typert`。

| 服务 | ctx key | TUI 用途 |
|---|---|---|
| `SessionStore` | `ctx.sessions` | create/get/list/fork；`session/event` 事件词汇（`user/message`、`assistant/message`、`assistant/chunk`、`tool/call`、`tool/result`、`turn/*`、`step/*`） |
| `AgentRegistry` | `ctx.agents` | create/resume/get/list/roots、`agent.followup` 提交消息、`agent/*` 活事件 |
| 命令注册表 | `ctx.commands` | `list(agent)` 动态发现 slash 命令（自动补全菜单）、`execute(agent, line, signal)` 派发、`commands/change` 刷新 |
| 投影注册表 | `ctx.sessionProjections` | todo/goal/plan/token-meter 等 UI 读模型（状态栏数据源） |
| 提问服务 | `ctx.userQuestions` | `registerProvider()` —— TUI 注册自己为 `ask_user_question` 的 UI 呈现端。⚠️ base 已有 `user-questions` 行，**用 `ctx.get('userQuestions')` 取，不要重复 insert 该行**（cc-tui 教训，重复 insert 会产生重复行） |
| 审批 seam | `approval/request` waterfall | TUI 注册 answerer，权限请求 → overlay 弹窗 |
| 命令行 | `ctx.cmdlineArgs` | 解析 `--resume <session-id>` 等 app 参数（官方推荐方式：`inject: ['cmdlineArgs']` + `ctx.cmdlineArgs.get()` 快照数组） |

**渲染用的会话事件词汇**（cc-tui 实测）：`user/message`、`assistant/message`、`assistant/chunk`（流式文本增量）、`tool/call`、`tool/result`、`tool-call-chunks`、`turn/start`、`turn/end`、`step/start`、`step/end`、`session/created`、`session/disposed`。回放用 `agent.session.events`（内存数组）+ 实时订阅 `ctx.on('session/event', …)`。

**注意**：官方**没有 `/resume` 命令**——resume 是前端能力（读持久化会话列表 → `ctx.agents.resume`），由 TUI 自己实现。

**注意**：`ctx.terminals`（dsh-terminal / dsh-terminal-bash）是**给模型调持久 PTY 用的**，TUI 渲染不需要它；web 的 typert/WebSocket 传输面也完全不用碰。

### 1.4 两个社区先例（路径选择依据）

| | dsh-cc-tui | dsh-grok-tui |
|---|---|---|
| 挂载方式 | **官方 bundle 范式**：package.json 声明 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`，patch 叠加 dsh-base | 无 bundle 声明：installer 改写 `cordis.patch.yml` + Unix socket 桥接官方 grok 二进制 |
| 数据流 | 同进程 `ctx.agents` + `agent.session.events` 渲染 transcript，零网络 | socket + ACP JSON-RPC 映射到 `ctx.agents` |
| 渲染层 | 自移植 Ink core（react-reconciler，重） | grok TUI 二进制（外部进程） |
| `--resume` | launcher 转环境变量进 patch config | — |

**我们选 dsh-cc-tui 的范式（bundle 插件、同进程服务注入），替换其渲染层为 pi-tui（轻、无 react-reconciler 负担）。**

---

## 2. 方案选型

| 方案 | 描述 | 结论 |
|---|---|---|
| **A. pi-tui 作依赖 + 自写适配层** | `npm i @mariozechner/pi-tui`，事件→组件映射、dsh 消息归一化、自建滚动容器/工具卡片/审批 overlay | ✅ **推荐** |
| B. fork pi 的 interactive-mode 整体移植 | 拿 5425 行 TUI + 组件，改数据源 | ❌ 耦合 pi 的 agent/settings/扩展体系，维护成本高 |
| C. 协议桥接（跑 headless 管道文本） | TUI 下挂 `dsh --profile headless` | ❌ 丢流式、无审批交互、进程管理复杂 |

方案 A 的合规性：MIT × MIT，改编 pi 组件时保留其版权声明（NOTICE 文件），无需任何授权。

---

## 3. 架构设计

### 3.1 数据流

```
                    ┌────────────────────────────────────────────┐
                    │            dsh-pi-tui（cordis bundle）       │
 用户键盘输入 ──▶  Editor / overlay 表单                             │
                    │  ui/（pi-tui 组件树）                          │
 屏幕输出 ◀──────  diff 渲染（pi-tui 内置）                          │
                    ▲        │                                    │
                    │        ▼                                    │
                    │  core/（适配层）                              │
                    │   - SessionManager：create/resume/list       │
                    │   - EventMapper：session/event → 组件操作     │
                    │   - 消息归一化：dsh 事件 → {text|thinking|toolCall}[]│
                    ▼        │                                    │
              ctx.sessions / ctx.agents / ctx.commands /           │
              ctx.userQuestions / approval/request                 │
              （同进程 cordis 服务，零网络）                          │
                    └────────────────────────────────────────────┘
```

### 3.2 目录结构（~/workspace/dsh-pi-tui）

```
dsh-pi-tui/
├── package.json          # "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}
├── cordis.patch.yml      # 插件行：inject agents/sessions/commands/cmdlineArgs/…
├── tsconfig.json
├── src/
│   ├── index.ts          # cordis service 入口（app 生命周期）
│   ├── args.ts           # --resume/--session/--help 解析（ctx.cmdlineArgs）
│   ├── core/
│   │   ├── session-manager.ts   # create/resume/list（ctx.agents/ctx.sessions）
│   │   ├── event-mapper.ts      # session/event → 组件操作 switch
│   │   ├── normalize.ts         # dsh 消息 → 渲染用消息形状
│   │   └── commands.ts          # ctx.commands.list/execute 封装 + 自动补全
│   ├── ui/
│   │   ├── chat.ts              # 主视图：消息列表 + 输入框 + 状态栏
│   │   ├── scroll-container.ts  # ★ 自建可滚动 Container
│   │   ├── assistant-message.ts # Markdown + thinking 折叠（改编自 pi）
│   │   ├── user-message.ts
│   │   ├── tool-call-card.ts    # ★ 工具调用卡片（改编自 pi tool-execution）
│   │   ├── status-bar.ts        # 模型 / token / workspace / git 分支
│   │   ├── session-picker.ts    # SelectList 会话选择器
│   │   ├── approval-overlay.ts  # approval/request → 弹窗
│   │   ├── question-overlay.ts  # ask_user_question → 表单/选项
│   │   ├── slash-menu.ts        # slash 命令 fuzzy 菜单
│   │   └── theme.ts             # chalk 主题
│   └── test/
│       ├── mock-terminal.ts     # 自实现 Terminal（headless CI）
│       └── *.test.ts
├── LICENSE               # MIT
├── NOTICE                # pi-tui 改编组件版权声明
├── README.md             # 安装/键位/支持矩阵
└── .github/workflows/ci.yml
```

### 3.3 关键设计决策

1. **依赖策略**（照 dsh-cc-tui 实测范式）：
   - `dependencies`：`@mariozechner/pi-tui`（锁 `~0.73.1`，上游迭代快）+ 直接用到哪些 dsh 包就列哪些（`@deepseek-ai/dsh-agent`、`dsh-session`、`dsh-commands`、`dsh-cmdline`、`dsh-user-questions`、`dsh-user-approval`、`dsh-session-projection` 等，均 `^0.1.0-rc.6`）——pnpm 装入 profile，经 profile 的 node 父链解析与安装目录去重；
   - `peerDependencies`：`@deepseek-ai/cordis`（`^4.0.1`）、`@deepseek-ai/dsh-invariants`（`^0.1.0-rc.6`）；
   - `engines`：node `>=22`（pi-tui 下限 20，dsh 无声明，cc-tui 用 `^22.19 || >=24`；CI 矩阵跑 20/22/24 后按结果收紧）。
2. **bundle patch**（骨架，M0 精确化；语义：叠加在 dsh-base 上，按 id 覆盖 + insert 自身行）：
   ```yaml
   # ── 覆盖 base 行（按 id，整段 config 替换）─────────────
   - id: agent-loop
     config:
       agents: []          # ★ TUI 运行时自建 agent，启动时不声明式创建
   # （可选）system-prompt persona、llm-deepseek apiKey/thinking、
   #   compaction-basic 阈值、approval policy —— 首版一律继承 base 默认
   #   （共享 ~/.dsh/sessions 的 jsonl 持久化，与 web profile 会话互通）

   # ── insert 自身行 ─────────────────────────────────────
   - insert:
       - id: pi-tui
         name: 'dsh-pi-tui'
         config:
           provider: deepseek-official
           model: undefined          # 缺省用适配器默认
           sessionId: undefined      # --resume 经 cmdlineArgs 注入
   ```
   包名带 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` 声明后，`dsh plugin --profile pi-tui add dsh-pi-tui` 会自动初始化 profile（首层 dsh-base）并把本包追加为 bundle 层。**不重复 insert `user-questions` 行**（base 已有）。
3. **生命周期**：service mount → `process.stdout.isTTY` 检查 → 解析参数（`ctx.cmdlineArgs.get()`：`--resume`/`--help`）→ 建/恢复会话（`SessionId(id)` → `ctx.agents.get` → `ctx.agents.resume`，失败回退 `ctx.agents.create`）→ 订阅事件 → TUI 启动；退出（Ctrl+C / `/exit`）→ 停 TUI → `drainInput` 恢复终端 → `ctx.root.fiber.dispose()` + 兜底 `process.exit`（cc-tui `disposeRootAndExit` 语义）。
4. **交互闭环复用官方机制**：slash 命令全部来自 `ctx.commands.list(agent)` 动态发现（自动获得 /compact /goal /plan /feedback）；fork/resume/compact 全走官方服务，插件不重复实现。
5. **审批与提问**：`ctx.get('userQuestions')?.registerProvider()`（缺失时在自己 ctx 上兜底 new）+ `approval/request` waterfall answerer，分别渲染成 overlay 表单/确认弹窗（与 web GUI 的权限问答对等）。
6. **不做的事**：不 fork pi-tui、不 vendor 代码、不碰 typert/WebSocket、不实现模型侧 PTY（那是 dsh 自己的 tool 面）、不另起 sqlite 持久化（复用 base jsonl，与 web 共享会话）。

### 3.4 工作量估算

| 模块 | 预估行数 |
|---|---|
| scroll-container + chat 主视图 | 300 |
| assistant-message（Markdown + thinking 折叠） | 200 |
| tool-call-card（含 diff 可选） | 300 |
| status-bar / session-picker / slash-menu | 250 |
| approval-overlay / question-overlay | 200 |
| core（session-manager / event-mapper / normalize / commands / args） | 350 |
| 合计（含测试） | **~1600 行 TS** |

---

## 4. 里程碑

### M0 — 脚手架 + 冒烟（0.5 天）
- 仓库骨架、tsconfig、`cordis.patch.yml`（`agent-loop agents: []` 覆盖 + `pi-tui` insert 行）、`package.json`（dsh.bundle.patch 声明 + exports/files）、最小 service 入口：`process.stdout.isTTY` 检查 → 启动后渲染硬编码 "hello dsh" 文本 + 状态栏。
- 本地验证链路：`npm i -g pnpm`（本机缺失，`dsh plugin` 依赖）→ `dsh plugin --profile pi-tui add ~/workspace/dsh-pi-tui` → `dsh --profile pi-tui`。
- **验收**：终端出现 pi-tui 渲染的界面，Ctrl+C 干净退出（终端恢复 raw mode，dispose 整树）。

### M1 — 会话闭环（1–2 天）
- 会话创建/恢复/列表：`ctx.agents.create/resume`；无参数启动弹会话选择器（SelectList）。
- 输入提交：Editor → `agent.followup`；事件流渲染：用户消息、`assistant/chunk` → Markdown 流式、thinking 折叠、`tool/call`/`tool/result` → 工具卡片（Loader 状态 → 结果折叠）。
- 自建滚动容器上线；`--resume <session-id>` 参数生效。
- **验收**：能完整对话、看流式输出和工具执行，退出后可 `--resume` 恢复。

### M2 — 交互对等（2–3 天）
- slash 命令：fuzzy 菜单 + `ctx.commands` 派发（/compact /goal /plan /feedback 立即可用）。
- 审批弹窗（approval/request answerer）+ 提问 overlay（userQuestions provider，含选项/多选表单）。
- 状态栏接 `sessionProjections`（todo/goal/plan/token-meter）+ git 分支。
- 错误与中断处理（agent 取消、模型错误 toast）。
- **验收**：与 web GUI 的主要交互能力对等；审批、提问、slash 全部可用。

### M3 — 工程化 + 发布（1–2 天）
- 单测：`mock-terminal` headless 断言渲染输出；事件映射器单测。
- CI（GitHub Actions）：node 20/22/24 × lint/build/test。
- 文档：README（安装、键位表、支持矩阵）、LICENSE（MIT）、NOTICE（pi-tui 版权声明）。
- 发布：`gh repo create dsh-pi-tui --public` → push → `npm publish`（首个版本 `0.1.0`）→ 真机 profile 安装验证 → 提交 [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)。
- **验收**：`dsh plugin --profile pi-tui add dsh-pi-tui && dsh --profile pi-tui` 在任何机器一步跑通。

### M4 — 可选增强（后续）
- 图片渲染（Kitty/iTerm2，pi-tui 原生支持）、多会话切换、diff 预览面板、Windows 验证（koffi 路径）。

---

## 5. 发布与工程化细节

- **位置**：`~/workspace/dsh-pi-tui`（本仓库即插件源）。
- **GitHub**：gh CLI 已登录账号 `lqhl`（`repo` scope ✓），SSH 协议推送 ✓。仓库名 `dsh-pi-tui`，public。
- **npm**：包名 `dsh-pi-tui` **已确认未被占用**（registry 404 = 可用）。⚠️ 当前本机 npm **未登录**（`ENEEDAUTH`），发布前需 `npm login` 或注入 token（需用户提供账号或自行登录）。**bundle 插件发布的最低要求**（cc-tui/dsh-base 共同范式，已核验）：
  1. `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；
  2. `exports` 导出 `"./cordis.patch.yml"`，且 `files` 包含它（否则安装后读不到）；
  3. `peerDependencies`: `@deepseek-ai/cordis ^4.0.1`（+ `dsh-invariants`）；
  4. 用到的 `@deepseek-ai/dsh-*` 直接列 `dependencies`；
  5. `engines` node 范围声明。
- **发布备选链路**（grok-tui 范式，作为 npm 外的兜底）：installer 脚本幂等地往 `~/.dsh/profiles/<name>/cordis.patch.yml` 写 insert 块 + 软链插件进 profile 的 node_modules——若 npm 发布受阻可先走这条。
- **环境前置**：本机无 pnpm（`dsh plugin` 需要）→ 先 `npm i -g pnpm`；node v25.9 ✓（>=20 要求满足）。
- **版本策略**：`0.x` 起步；每个 dsh rc 更新后跑兼容矩阵测试，README 声明「已测试的 dsh 版本」。
- **LICENSE**：MIT（双 MIT 兼容；NOTICE 保留 Mario Zechner 对改编组件部分的版权）。

---

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| dsh 是 rc 阶段，session/event 词汇与服务 API 可能漂移 | 中 | peer 依赖锁 `0.1.0-rc.6`；每 rc 发布后跑兼容测试；README 写明支持矩阵 |
| pi-tui 上游迭代极快（数日一发） | 中 | 锁 minor（`~0.73.1`）；适配层薄（组件层 API 稳定）；月度跟进升级 |
| pi-tui 无滚动容器，长会话渲染需自研 | 中 | 自建 scroll-container（参考 pi session-selector 滚动逻辑，虚拟窗口只渲染可见区） |
| raw mode / 退出时终端状态恢复 | 低 | `ProcessTerminal.stop()` + `drainInput`；SIGINT 双信号兜底（对齐 dsh 惯例） |
| 长会话 diff 性能 | 低 | pi-tui 内建 16ms 节流 + 差异渲染；可视窗口裁剪 |
| npm 未登录 | 低（阻塞项） | 发布前 `npm login`（需用户凭据或用户自行登录） |
| Windows 兼容 | 低 | koffi 已内置；M0–M3 以 macOS/Linux 为准，Windows 标实验性 |

---

## 7. Review 决定记录（2026-08-13）

1. **命名**：✅ `dsh-pi-tui`（npm 包名与仓库名一致）。
2. **归属**：✅ GitHub 建在 `lqhl` 下；npm 账号 `lqhl`（本机 registry 指向 npmmirror，登录/发布需显式指向 `registry.npmjs.org`，见 §5 说明）。
3. **范围**：✅ 同意 M0–M3 验收标准。
4. **视觉**：✅ 优先复刻 pi coding-agent 观感（改编其 MIT 组件，NOTICE 保留版权）。
5. **开工**：✅ M0 开始。npm 登录只在 M3 发布时需要，M0–M2 不阻塞。
