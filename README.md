# dsh-pi-tui

[pi 的 TUI](https://github.com/earendil-works/pi/tree/main/packages/tui)（`@earendil-works/pi-tui`）驱动的 DeepSeek Harness 终端前端：界面是 pi 的观感（品牌蓝 prompt、流式 Markdown、thinking 折叠、工具调用卡片、微分渲染防闪烁），内核（模型路由、工具、会话持久化、slash 命令、审批）全部由 dsh 官方机制提供。

## 安装

前置：官方 [`dsh`](https://github.com/deepseek-ai/deepseek-harness) CLI（`npm i -g @deepseek-ai/dsh`）与 `pnpm`。

```sh
dsh plugin --profile pi-tui add dsh-pi-tui   # 自动初始化 profile 并挂为 bundle
dsh --profile pi-tui                          # 新会话
dsh --profile pi-tui --resume <session-id>    # 恢复指定会话
dsh --profile pi-tui --resume                 # 从持久化会话列表中选择
```

会话与 web profile 共享 `~/.dsh/sessions` 持久化存储，两端互通。

## 键位

| 按键 | 功能 |
|---|---|
| `Enter` | 提交（`Shift+Enter` 换行） |
| `Tab` | 自动补全（文件路径 / slash 命令） |
| `Ctrl+O` | 展开/折叠 thinking 块 |
| `Ctrl+C` | 退出 |

## 功能

- 流式渲染：`assistant/chunk` 增量 → Markdown、thinking 折叠标签
- 工具调用卡片：运行/成功/失败三态 + 参数与结果预览
- slash 命令：`/compact` `/goal` `/plan` `/feedback` 等全部来自官方 `ctx.commands` 注册表（自动补全 + 动态发现）
- 权限审批弹窗（`approval/request`）与 `ask_user_question` 交互表单（选项/多选/自由文本）
- 会话管理：创建、恢复、选择器（官方持久化后端）
- 状态栏：provider/model、会话 id、token 统计（官方 token-meter 投影）、todo 进度（官方 todo 投影）
- 转场提示：compaction 检查点、turn 失败/中止/超长提示

## 支持矩阵

| dsh | node | 状态 |
|---|---|---|
| 0.1.0-rc.6 | >= 22.19（CI 跑 22/24） | ✅ 测试通过 |
| 其他 rc | — | 未验证，欢迎反馈 |

## 开发

```sh
npm install && npm run build && npm test
# 本地联调：profile 里是 link: 软链，重新 build 后直接重启即可
```

## License

MIT。改编自 pi coding-agent interactive mode 的组件逻辑保留原作者版权，见 [NOTICE](NOTICE)。
