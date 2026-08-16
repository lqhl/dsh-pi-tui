# dsh-pi-tui

[pi 的 TUI](https://github.com/earendil-works/pi/tree/main/packages/tui)（`@earendil-works/pi-tui`）驱动的 DeepSeek Harness 终端前端：界面是 pi 的观感（品牌蓝 prompt、流式 Markdown、thinking 折叠、工具调用卡片、微分渲染防闪烁），内核（模型路由、工具、会话持久化、slash 命令、审批）全部由 dsh 官方机制提供。

## 安装

前置：官方 [`dsh`](https://github.com/deepseek-ai/deepseek-harness) CLI（`npm i -g @deepseek-ai/dsh`）与 `pnpm`。

```sh
dsh plugin --profile pi-tui add dsh-pi-tui   # 自动初始化 profile 并挂为 bundle
dsh --profile pi-tui                          # 新会话
dsh --profile pi-tui --resume <session-id>    # 恢复指定会话
dsh --profile pi-tui --resume                 # 从持久化会话列表中选择
dsh --profile pi-tui --preset <id>            # 选择 agent preset（standard/minimal/code）
dsh --profile pi-tui --preset                 # 从 preset 列表中选择
```

会话与 web profile 共享 `~/.dsh/sessions` 持久化存储，两端互通。

## 键位

| 按键 | 功能 |
|---|---|
| `Enter` | 提交（`Shift+Enter` 换行） |
| `Esc` | 中断当前 turn / 取消自动补全 |
| `Ctrl+C` | 运行中→中断；有文字→清空；已空→再次按下退出 |
| `Ctrl+D` | 编辑器为空时退出（非空时删除字符） |
| `Ctrl+T` | 展开/折叠 thinking 块 |
| `Ctrl+O` | 展开/折叠工具完整输出 / diff |
| `Ctrl+L` | 打开模型选择器 |
| `Ctrl+R` | 搜索消息历史：本会话 + 最近持久化会话的首条消息（选中载入输入框） |
| `↑` / `↓` | 浏览当前会话的消息历史（恢复/切换后自动载入） |
| `Ctrl+Z` | 挂起到后台（`fg` 恢复） |
| `Ctrl+G` | 用 `$EDITOR` 编辑输入 |
| `Shift+Tab` | 循环会话 mode（normal ↔ plan） |
| `Ctrl+X` | 循环思考强度（off→high→max） |
| `Tab` | 补全（slash 命令 / 路径型 token；普通单词不触发） |
| `@` | 文件提及菜单（搜索框 fuzzy 过滤，选中即插入） |
| `!` / `!!` | 直接执行 shell 命令（用户全权；`!!` 输出不进模型上下文） |

## 命令

| 命令 | 功能 |
|---|---|
| `/model [query]` | 切换模型（无参数弹选择器；下一步生效） |
| `/thinking off\|high\|max` | 设置思考强度（下一步生效） |
| `/skills` | 列出人类可调用技能 |
| `/new` | 新会话 |
| `/fork` | 当前会话末尾 fork（保留历史，记录 lineage） |
| `/resume [query]` | 列出/恢复持久化会话 |
| `/tree` | 子代理会话树 |
| `/agents` | 列出 live 子代理 |
| `/jobs` | 列出后台任务 |
| `/export` | 导出 transcript 为 markdown |
| `/rename <title>` | 重命名会话（官方 sessionTitle 服务） |
| `/permission [preset]` | 官方权限 preset 切换（workspace-write / danger-full-access…） |
| `/hotkeys` | 显示键位表 |
| `/compact` `/goal` `/plan` `/feedback` | 官方 dsh 命令（自动发现） |

模型/思考强度切换通过官方 `installModelSelection` 链路（与 web/grok 客户端同款），无需 fork 会话；会话与 web profile 共享 `~/.dsh/sessions` 持久化存储。

## 功能

- 流式渲染：`assistant/chunk` 增量 → Markdown、thinking 折叠标签
- 工具调用卡片：运行/成功/失败三态 + 参数与结果预览；Ctrl+O 展开完整输出；write/edit 结果带**彩色 diff 高亮**（官方 meta.diffs）
- `read_image` 结果在 kitty/iTerm2 终端内联渲染图片（Ctrl+O 展开）
- slash 命令：`/compact` `/goal` `/plan` `/feedback` 等全部来自官方 `ctx.commands` 注册表（自动补全 + 动态发现）
- 权限审批弹窗（`approval/request`）与 `ask_user_question` 交互表单（选项/多选/自由文本；plan-review 特化弹窗）
- 会话管理：创建、恢复、fork、子代理树、选择器（官方持久化后端）
- 状态栏：provider/model、preset、plan 指示、goal 状态、上下文压力 `ctx N%`、会话 id、token 统计、todo 进度、后台任务计数（全部来自官方 projection/jobs 服务）
- 转场提示：compaction 检查点、turn 失败/中止/超长提示
- 启动 banner：品牌蓝 ASCII 鲸鱼 + 会话信息 + 键位提示（boot 与会话切换时）
- 权限：官方 `/permission <preset>`（沙箱模式 + 审批策略捆绑切换），状态栏显示当前 preset

## 支持矩阵

| dsh | node | 状态 |
|---|---|---|
| 0.1.0-rc.6 | >= 22.19（CI 跑 22/24） | ✅ 测试通过 |
| 其他 rc | — | 未验证，欢迎反馈 |

发布：npm 上的每次发版由 GitHub Actions 经 [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers)（OIDC）发布，带 provenance 签名——打 `v*` tag 即发布，无任何 token。

## 开发

```sh
npm install && npm run build && npm test
# 本地联调：profile 里是 link: 软链，重新 build 后直接重启即可
```

## License

MIT。改编自 pi coding-agent interactive mode 的组件逻辑保留原作者版权，见 [NOTICE](NOTICE)。
