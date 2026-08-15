# dsh-pi-tui 交互改进建议（第二轮：! 命令、@ 搜索、Tab、skills 补全）

> 针对第二轮试用反馈的 4 个问题，对照 pi / grok / Claude Code 的交互惯例给出建议。所有 dsh API 已核实。

## 问题 1：`!` 开头执行 shell 命令（未实现）

### 对标惯例（已核实）

- **pi**（`interactive-mode.ts:2555-2580, 5296-5345`）：
  - `!cmd` = bash 模式：在会话 cwd 执行，输出流式渲染进 BashExecutionComponent 卡片，Esc 可中止；
  - `!!cmd` = 同执行但 **excludeFromContext**（输出不进模型上下文）；
  - 结果经 `recordBashResult(command, result, {excludeFromContext})` 记录进会话（非 excluded 时进入模型上下文）；
  - agent 正在流式时命令**排队**（pendingMessagesContainer），不在流中间插队；
  - 已有 bash 在跑时再输入 `!` → 警告"已有命令在跑，Esc 先取消"。
- **Claude Code**：`!command` 直接跑 shell（输出显示、默认会提供给 Claude）；`!!` 同 pi 语义（[librabit.co.uk 的 bash-mode 介绍](https://librabit.co.uk/articles/claude-code-bash-mode-shell-prefix)）。
- **grok**：（调研中，见 dsh 侧报告）

### dsh 侧实现路径（已核实）

- **`ctx.shell`**（dsh-shell Service Definition，dsh-base 由 `dsh-bash-sandbox` 提供）：
  - `run(spec)` 前台执行，resolve `ShellRunResult`：`{exitCode, signal, timedOut, aborted, timeoutMs, stdout: CollectedOutput, stderr: CollectedOutput, sandbox?}`——非零退出/超时/中止都 resolve（只有基础设施失败才 reject）；
  - `start(spec)` 后台执行 + `ShellProcess.readOutput()` 增量读 + `kill()`；
  - `ShellExecRequest = {command, workdir?, timeoutMs?, stdoutMaxBytes?, signal?, sandboxPolicy?}`。
- 沙箱：base 挂的是 **sandboxing executor**（bash-sandbox）；`sandboxPolicy` 缺省时回落部署策略（workspace-write）。人类侧 `!` 建议**遵守会话沙箱**（与 agent 的 bash 工具同一世界，所见即所得）；若要 pi/CC 的"用户全权"语义，可显式传 danger-full-access 策略——二选一，倾向前者。
- 上下文注入：`!` 结果进模型上下文的 dsh 等价物 = 作为 user-role 消息 `agent.followup` 或 `agent.inject` 注入（确切签名以 dsh-agent 为准：`send(message, target, wakeup)` / `inject`）；`!!` 只渲染不注入。
- 会话 cwd：`agent.session` 的 header cwd（meta.cwd）。

### 建议（最终）

1. submit() 分流：`!!`/`!` 前缀 → `runBash(command, excluded)`：
   - `ctx.shell.run({command, workdir: 会话cwd, timeoutMs: 5min, signal: abort})`，stdout/stderr 流式/分段渲染到 bash 卡片组件（复用工具卡片样式，运行中 ⏺、完成 ✓/✗ + exit code）；
   - Esc 中止（bash 运行中时 Esc 优先 abort 它，对齐 pi）；
   - `!`（非 excluded）：完成后把 `$ cmd` + 输出作为 user 消息注入模型上下文（agent 侧 API，等价 pi recordBashResult）；
   - `!!`（excluded）：只渲染不进上下文。
2. 运行期间第二个 `!` → 提示"已有命令在跑，Esc 先取消"；agent 流式时命令排队执行（pi 语义）。
3. 键位：`!`/`!!` 输入即时切换编辑器边框颜色提示 bash 模式（pi 惯例，可选）。

## 问题 2：@ 选文件：无模糊搜索 + 选中后要再按一键

### 根因

- **无搜索**：当前 @ 菜单是纯 SelectList（只有方向键），没有搜索框。pi 的 ModelSelectorComponent 是「Input 搜索框 + `fuzzyFilter` 实时过滤 + 方向键选列表」模式；Claude Code 的 @ 菜单也是输入即过滤。
- **选中后不刷新**：`pickFromList` 的 onSelect 里 `handle.hide()` 后，调用方 `editor.setText(...)` 但**没有 `tui.requestRender()`**——编辑器内容变了但不触发重绘，下一次按键才渲染。这是 bug，一行修复。
- SelectList 自带 `setFilter` 只是前缀匹配，模糊搜索需用 pi-tui 导出的 `fuzzyFilter`。

### 建议

1. **修渲染 bug**：openAtPicker/cmdSkills 在 `setText` 后补 `tui.requestRender()`。
2. **@ 菜单加搜索框**（pi ModelSelector 模式）：顶部 Input（搜索）+ 下方 SelectList；输入字符实时 `fuzzyFilter` 过滤列表（评分排序），↑/↓ 导航、Enter 选中、Esc 取消；选中插入 `@相对路径 `。
3. 保留「@+字符」的内联补全（pi-tui 内置，含 fd/fuzzy），两条路径并存。

## 问题 3：/ 不出现 skill；/skills 选中后要再按一键

### 对标惯例（已核实）

- **pi**：技能注册为 `/skill:name` 形式的 slash 命令并**进补全列表**（`interactive-mode.ts:484-496`：`commandName = skill:${skill.name}`），`/skill:name` 提交时展开为技能块。
- **dsh**：技能的用户侧调用是**消息里的 whitespace-bounded `/name` token**，由 dsh-tool-skill 的 pre-step gesture 识别（dsh-tool-skill README）——所以补全条目应该用 `/name`（技能名本身），不是 `/skill:name`，否则 gesture 匹配不到。
- **Claude Code**：/ 菜单列出 skills（skill 是 / 命令体系的一部分）。

### 建议

1. **slash 补全加入技能**：`listSkills()`（user-invocable）的每个技能作为一个补全条目（name = 技能名），描述用 skill.description/whenToUse——输入 `/` 即可见技能并过滤（用 CombinedAutocompleteProvider 的 commands 列表追加）。
2. **修渲染 bug**：cmdSkills 选中后 `setText` + `setFocus` + `requestRender`（同一行修复）。
3. `/skills` 列表也加搜索框（与 @ 菜单共用 SearchPanel 组件）。
4. 已选中的技能条目标记（✓ 或 user-only 标识，web 同款），可选。

## 问题 4：Tab 为什么直接就补全路径（不需要 @）？

### 现状与惯例

- **pi 惯例**：Tab = 强制路径补全（任何 token 上都能补路径，README「Tab to complete paths」）；@ 是另一条触发路径。我们直接继承了这个行为。
- **Claude Code**：Tab 不做路径补全；文件用 @ 菜单。
- 你的预期接近 Claude Code。

### 建议（三选一，推荐 B）

- **A. 保持 pi 行为**：Tab 任何位置补路径（现状），说明写入 /hotkeys。
- **B.（推荐）收窄触发**：包装 AutocompleteProvider——Tab 只在「当前 token 像路径」时补全（token 含 `/`、`.`、`~` 开头、或 `@` 开头），普通单词上按 Tab 不弹。@ 菜单 + @内联补全不受影响。既保留 pi 的效率，又消除"上来就补路径"的突兀感。
- **C. 完全移除 Tab 路径补全**：文件选择只走 @ 菜单（纯 Claude Code 语义），实现最简单（不装 provider 的路径能力，只留 slash 命令补全）。

## 修复顺序建议

1. 渲染 bug 修复（问题 2/3 共用，2 行）——立即做；
2. @ 菜单搜索框 + skills 补全条目（问题 2/3，~150 行）；
3. Tab 收窄（问题 4，~40 行）；
4. `!` 命令（问题 1，~150 行，等 dsh shell API 调研完成）。
