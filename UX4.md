# dsh-pi-tui UX4 方案：Shift+Tab 模式切换 + 状态栏补全（待 review）

## 问题 1：Shift+Tab 应该切换 mode

### 三方惯例（已核实）

| 产品 | Shift+Tab | Tab |
|---|---|---|
| **Claude Code** | **循环 mode**（default ↔ auto-accept ↔ plan）——[官方速查表](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet) + [issue #17344](https://github.com/anthropics/claude-code/issues/17344) 佐证 | 循环 models |
| **pi** | 循环 thinking level（off→xhigh） | 路径补全 |
| **我们现在** | 循环 thinking effort（抄的 pi） | 路径补全（已收窄） |

结论：你期望的是 **CC 语义**。dsh 里最接近 CC "mode" 的概念是 **plan 模式**（plan-mode 插件，可运行时切换，投影 `plan: {active, wanted}`）。

### 建议

1. **Shift+Tab = 循环会话 mode：normal ↔ plan**（CC 语义）。实现 = 调官方 `/plan` 的等价路径（plan-mode 的 command/run 或直接 setActive），状态栏即时反映；
2. **thinking effort 循环换键**：`Ctrl+X`（pi-tui 编辑器未占用该键），`/thinking` 命令保留；
3. **不**把权限模式放进 Shift+Tab 循环（误触升级危险）；preset 切换仅限新会话（dsh `recompose` 要求会话未产出任何内容），不进循环。

## 问题 2：状态栏补全

### 现状 vs 期望

| 状态 | 现状 | 期望 |
|---|---|---|
| plan/normal | 只有 `⌘plan`（active 时） | 显式 `plan` / `normal` |
| 权限状态 | ❌ 无 | `perm: ws-write / read-only / danger` |
| context 占比 | `ctx 45%` | 占比 + 总量 + 可视化 |
| context 总量 | ❌ 无 | `12k/27k`（pressureTokens/contextWindow） |

### dsh 能力（已核实）

- **权限**：`ctx.sandboxPolicy.resolve({session})` → 同步返回 `{mode, workspaceRoot}`（会话 override > 部署默认）；写入用 `setSandboxMode(session, mode)`（`@deepseek-ai/dsh-sandbox-policy` 导出，`SANDBOX_MODES` = read-only/workspace-write/danger-full-access）；
- **上下文**：`contextPressure` 投影 `{surfaceTokens, pressureTokens?, projectedTokens?, contextWindow}` + `contextBreakdown` 投影 `{systemTokens, toolsTokens, messageTokens}`（分色段条的数据源）；token-meter 已有；
- **plan**：`plan` 投影 `{active, wanted}`（已有）；goal/jobs/todos/preset（已有）。

### 建议（新状态栏段，顺序即显示顺序）

```
dsh-pi-tui · deepseek-v4-flash·max · standard · ⌘plan · ws-write · ◈active ·
ctx ▓▓▓▓▓▓░░░░ 45% 12k/27k · in 4.2k out 343 · ☐ 2/5 · ⚙ 1 · abc12345 · repo
```

1. **mode 段**：`⌘plan`（active）/ `normal`（非 active）——显式，满足 plan/normal 诉求；
2. **权限段**：`ws-write` / `read-only` / `danger`（`resolve({session}).mode` 的短名映射）；
3. **context 段升级**：10 格迷你条（`contextBreakdown` 三段累计 + contextWindow 分母，<70% 绿 / 70-90% 黄 / ≥90% 红）+ `45%` + `12k/27k`（pressureTokens/contextWindow，人类可读缩写）；
4. 顺带：**`/permission <ws|ro|danger>`** 命令（`setSandboxMode`），与显示配对——权限状态不只"看"还能"切"。

## 实现规模与测试

| 项 | 规模 |
|---|---|
| Shift+Tab 模式循环 + Ctrl+X effort 循环 | ~40 行 |
| 状态栏权限段 + context 条/总量 | ~60 行（含纯函数：模式短名、context 缩写、条渲染——全部单测） |
| /permission 命令 | ~30 行 |
| 新增依赖 `@deepseek-ai/dsh-sandbox-policy`（harness 同版本，pnpm 去重） | 1 行 |

测试：状态栏组合单测（新增段）、键位状态机单测、PTY 冒烟（Shift+Tab 切换 → 状态栏 ⌘plan↔normal；/permission ws → 状态栏变化；/permission danger 需审批路径）。

## 请 review 的决策点

1. Shift+Tab 循环内容 = **normal ↔ plan** 是否同意（不含权限/preset）？
2. thinking effort 循环改到 **Ctrl+X** 是否接受？
3. 状态栏新增段的顺序/缩略格式（`ws-write`、`ctx ▓▓… 45% 12k/27k`）？
4. `/permission` 命令是否要（danger 切换走审批弹窗确认）？
