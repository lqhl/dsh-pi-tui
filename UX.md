# dsh-pi-tui 交互体验改进建议（v2，调研完成）

> 针对你试用反馈的 5 个问题，对照 **pi / grok / Claude Code** 的交互惯例与 **dsh 现有实现**逐项给出建议。所有 dsh API 建议均已核实到签名。

---

## 问题 1：Ctrl+C 一键退出（应两段式）；无 Ctrl+D；无中断键

### 对标惯例（已核实）

| 工具 | Ctrl+C | Ctrl+D | 中断 |
|---|---|---|---|
| **Claude Code** | 中断当前操作；空闲时退出 | 退出（同 `/exit`） | Esc / Ctrl+C |
| **pi** | `app.clear`：第一次**清空编辑器**、**500ms 内第二次退出**（`interactive-mode.ts:3190-3198`） | `app.exit`：**仅编辑器为空时退出**（`custom-editor.ts:59-67`） | `app.interrupt`=**Esc**：万能取消（中断流式/abort bash/取消补全） |
| **dsh launcher** | 第一次 SIGINT 优雅排空、第二次强制退出（官方 CLI 语义） | — | — |

### 建议（对齐 pi 精确语义 + Claude Code 直觉）

1. **Esc** = 万能取消（pi 专属中断键）：取消自动补全（编辑器内置）→ turn 运行时 `agent.cancel({kind:'user'})`（`AgentCancelCause` 已核实；`agent.status` `'idle'|'running'` 判断）→ 空闲时双击 Esc 可留待 /tree（M4）。
2. **Ctrl+C** 两段式（pi 精确语义 + Claude Code 直觉的混合）：
   - turn 运行中 → 中断（=Esc，Claude Code 习惯）；
   - 空闲且编辑器非空 → **清空编辑器**（pi 语义，第一次）；
   - 编辑器已空 → **500ms 内第二次按** → 退出（走现有 `disposeRootAndExit`）；提示 `(Ctrl+C again to exit)`。
3. **Ctrl+D** = 仅编辑器为空时退出；**非空时回落为删除字符**（pi-tui 编辑器内置 ctrl+d=deleteForward，无需我们实现）。
4. 退出前保留现有 5s 兜底排空。
5. 可选（低优先级）：Ctrl+Z 挂起（SIGTSTP）、`/hotkeys` 打印完整键位表（pi 内建）。

实现量：~40 行（`chat.ts` input listener 状态机 + 单测）。

---

## 问题 2：无法 /model 选模型

### 对标惯例（已核实）

- **Claude Code**：`/model` 切换 + 模型滑条（low|medium|high|xhigh）。
- **pi**：`Ctrl+L` 打开带搜索的模型选择器；`Ctrl+P`/`Shift+Ctrl+P` 循环切换；`/model [词]` 直接切。选中后**双写**：`settingsManager.setDefaultModelAndProvider`（全局默认）+ `session.setModel`（当前会话应用）。
- **dsh 现状**：官方命令表没有 /model（base 只有 /compact /goal /plan /feedback）；**cc-tui 的做法是 fork 会话 + 新建 agent**（较重，会换会话）。

### dsh 侧正确实现（已核实，比 cc-tui 方案轻）

官方 web 主机（`dsh-host-apiproxy/lib/index.js:1764-1772`）与 grok 桥（`acp-server.ts:997-1011`）共同使用：

```ts
import { installModelSelection } from '@deepseek-ai/dsh-agent'
const selection = { current: undefined, assembled: undefined }
installModelSelection(agent.ctx, selection)
// 切换：selection.current = { provider, model, reasoningEffort }  → 下一步生效
```

- 模型目录：`ctx.get('llm')` → `listProviders()` + `listModels(provider)`（LlmModelInfo 含 contextWindow）。llm-deepseek 目录：`deepseek-v4-flash` / `deepseek-v4-pro`。
- ⚠️ **`installModelSelection` 每个 agent 只装一次**（重复安装会让外层陈旧 selection 覆盖）——agent 创建后立即安装并持有 ref。
- ⚠️ **`AgentOptions` 没有 reasoningEffort 字段**：创建时设不了，effort 只能走 `selection.current.reasoningEffort`（resolveCallConfig 校验 → agent/request waterfall → durable `request/header` 记录）。
- `agentDefaultModel.saveSelection()` 写的是**进程默认**（settings.yaml），不是会话切换——`/model` 的会话生效靠 selection；是否持久化默认由用户决定。

### 建议

1. **UI 级 `/model [query]`**（不注册进官方命令表）：fuzzy SelectList overlay，数据来自 `llm.listProviders()` × `listModels()` 展平（同 id 多 provider 用 `provider@model` 区分）；带 query 直接切换，无 query 弹选择器。
2. **选中校验**：`await llm.resolveCallConfig({provider, model})`（grok `session/set_model` 同款，非法值在 I/O 前失败）。
3. **应用**（grok 模式，权威参考 `acp-server.ts:969-1042`）：agent 绑定后 `installModelSelection(agent.ctx, ref)` **只装一次**；选中后 `ref.current = {provider, model}`。
4. **可选持久化**：`agentDefaultModel.saveSelection()` —— grok 注释给出的理由：写共享默认可**避免 web 侧外层 waterfall 的陈旧 selection 覆盖**（web 进程的 selection 回退链会读它）。
5. **`Ctrl+L`** 打开选择器（pi 惯例；grok 官方是 Ctrl+M）；可选 Ctrl+P/N 循环（低优先级）。
6. 状态栏即时显示新模型；运行中切换 → 提示"下一步生效"。

---

## 问题 3：@ 无法选文件

### 已核实的现状（比预想好）

pi-tui 0.84 编辑器**内置**：
- 默认触发字符 `DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"]`（`editor.js`）——输入 `@`+非空白字符自动弹模糊文件补全；
- `CombinedAutocompleteProvider` 自带 `@` 前缀解析 + fuzzy 文件匹配（`extractAtPrefix`），**无 fd 时回退到 fs 递归遍历**（我们传了 `fdPath=null`，回退路径可用）；
- `Tab` 强制文件补全、`/` 命令补全也已接好。

**所以「`@`+继续打字」的补全很可能已经能用**（我们传的就是 `CombinedAutocompleteProvider(slashCommands, cwd)`）。与 Claude Code 的差距是：**裸输入 `@` 不弹菜单**（pi 需要 @ 后跟非空格字符才触发），且是内联补全不是菜单。

### 建议

1. **验证优先**：确认「@+字符」「Tab」补全在当前构建可用（PTY 脚本测试）。
2. **补裸 `@` 菜单**（Claude Code 体验）：editor 输入 `@`（词首、后随空格/行尾）→ 弹 fuzzy 文件列表 overlay（SelectList），选中插入相对路径。数据源：`ctx.get('fs')` 的 `listDir` 递归 + 深度上限 + .gitignore 过滤（cc-tui 有 `listFilesDeep` 可参考）。
3. 保留内联补全与菜单并存；`#` 触发字符暂不映射（无对应概念）。

---

## 问题 4：无法选择思考强度

### 对标惯例（已核实）

- **Claude Code**：/model 滑条（low|medium|high|xhigh）。
- **pi**：`Shift+Tab` 循环 thinking level（`app.thinking.cycle`），变更发 `thinking_level_changed` 并保存默认；`Ctrl+T` 折叠显示（`app.thinking.toggle`）。
- **dsh**：reasoningEffort 取值 **`off` / `high` / `max`**（llm-deepseek：off=thinking disabled；high/max=顶层 reasoning_effort）；`installModelSelection` 的 selection 携带 `reasoningEffort`；settings 的 `agent-default-model.reasoningEffort` 也存它。

### 建议

1. **UI 级 `/thinking off|high|max`**：改 `selection.current.reasoningEffort`（下一步生效）。**档位动态枚举**：`(await llm.resolveModelInfo(provider, model)).reasoning?.efforts`（deepseek 固定 off/high/max 有序表 + defaultEffort），不硬编码。
2. **校验**：`await llm.resolveCallConfig({provider, model, reasoningEffort})`——非法值抛 `UNSUPPORTED_REASONING_EFFORT`（I/O 前）。
3. **`Shift+Tab`** 循环切换（pi 惯例）。
4. **`Ctrl+T`** = thinking 显示折叠（pi 惯例；把我们现在误用的 `Ctrl+O` 换掉，见下）。
5. **状态栏回读实际值**：订阅 `request/header` 事件（`event.data.header.config?.reasoningEffort`），显示模型请求真正用的档位（cc-tui 同款）。
6. 与 /model 合并展示（每行模型附 effort 档位）可选。

---

## 问题 5：skills 支持

### 已核实的现状

- **模型侧已端到端工作**：dsh-base 挂载 `skill`/`skill-filesystem`/`tool-skill`，标准 preset 的模型可自动加载技能——TUI 无需任何改动，模型就能用（你试用时模型其实已经在用）。
- **人类侧 API 存在**：`ctx.skills.list({cwd})` 列出工作区技能摘要；`isUserInvocable(skill)` / `isModelInvocable(skill)` 区分两类；有"用户显式调用技能"的注入通道（SkillInvocationSource）。web 的侧栏就是消费这些 API。
- pi 惯例：技能无人类侧选择器（SKILL.md 自动加载 + `/skill:name` 显式调用）。

### 建议

1. 短期：README 说明"技能由模型自动加载，无需配置"；不加 UI。
2. 中期：**`/skills`** 命令列出 `isUserInvocable` 的技能（SelectList）：注册表**从 preset 作用域取**（agent 属于某 preset 时用 `agentPresets.serviceFor(agent, 'skills')`，否则 host `ctx.get('skills')`——web `skill.list` RPC 同款）；`modelInvocable:false` 的标 user-only。
3. ⚠️ **重要联动**：dsh 里"用户显式调用技能"= 输入 `/skillname` 文本，由 `dsh-tool-skill` 的 pre-step gesture 边界注入。我们现在的 slash 路由会把**未知命令直接拒绝**——这会吞掉技能调用！修正：输入 `/xxx` 时先查命令表 → 再查用户可调用技能（命中则作为 followup 文本发送）→ 都不中才报"未知命令"。
4. 可选直接注入：`ctx.skills.get(name, {cwd, scope})` + `renderSkillContent(skill)` 作为指令上下文（绕开 gesture 边界）。

---

## 顺手修正：键位冲突

我们现在 `Ctrl+O` = thinking 展开/折叠，与 pi 惯例冲突。对齐 pi：

| 键 | pi 语义 | 我们现状 | 建议 |
|---|---|---|---|
| `Ctrl+O` | 展开工具输出/diff | thinking 折叠（误用） | **改为展开工具卡片完整输出** |
| `Ctrl+T` | thinking 显示折叠 | 无 | **接管 thinking 折叠** |
| `Esc` | 万能取消 | 无 | 中断/取消补全 |
| `Shift+Tab` | 循环 thinking level | 无 | 循环 effort |

---

## 实现顺序建议（review 后开工）

| 顺序 | 内容 | 规模 |
|---|---|---|
| 1 | 键盘语义修复（Esc/Ctrl+C 两段/Ctrl+D） | ~30 行 |
| 2 | /model + /thinking + Shift+Tab + Ctrl+T（共用 selection 机制） | ~200 行 |
| 3 | @ 菜单 + 验证内联补全 | ~150 行 |
| 4 | /skills + 键位迁移（Ctrl+O） | ~100 行 |

全部完成后：README 键位表更新 + 单测（按键状态机、selection 应用）+ PTY 冒烟 + 你复测。
