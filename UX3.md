# dsh-pi-tui @ 文件选择的固定忽略规则方案（UX3，待 review）

> 问题：`~/workspace/awesome-system-papers` 下 @ 列表出现 `.DS_Store`、`.agents/settings.local.json`、`__pycache__/*.pyc` 等垃圾项，且硬上限 300 截断。
> 根因：当前实现是「ctx.fs 递归 walk + 8 个硬编码目录名 + depth 4 + 300 上限」，没有 .gitignore 语义，也没有"业界固定规则"。

## 一、相关产品的固定规则（调研结论）

### pi（fd 语义）
`walkDirectoryWithFd` 的参数（`packages/tui/src/autocomplete.ts:131-146`）：
```
fd --base-directory <cwd> --max-results 100 --type f --type d --follow --hidden
   --exclude .git --exclude .git/* --exclude .git/**  [query]
```
- **核心规则 = fd 默认语义**：尊重 **.gitignore（嵌套逐目录）+ .ignore + .fdignore + global gitignore**；
- `--hidden` 包含隐藏文件（.env 等可被 @ 选到）；
- 只手动排除 .git；max-results 100，fuzzy 后取 top 20，**按文件名优先打分**。

### dsh 自己的 glob 工具（rg 语义，模型侧）
`dsh-tool-fs-search` README：模型侧 `glob` = `rg --files --glob <pattern> --sort=modified --no-ignore --hidden` + VCS 元数据排除（`.git .svn .hg .bzr .jj .sl`）。**关键**：rg 二进制随包发布（`@vscode/ripgrep`），不依赖宿主安装。

### Claude Code
- @ 文件搜索尊重 .gitignore（[gitignored 文件搜不到是已知限制 #1248](https://github.com/anthropics/claude-code/issues/1248)）；还尊重 `.claudeignore`（[#22010](https://github.com/anthropics/claude-code/issues/22010)）；
- 隐藏文件默认不显示，输入 `.` 开头才出现。

### 结论：固定规则 = **ripgrep/fd 的 .gitignore 语义 + 一小撮无条件排除 + 隐藏文件按 CC 语义**
用户仓库里 `.DS_Store`/`__pycache__` 之所以出现，是因为该仓库的 .gitignore 没覆盖它们——仅靠 gitignore 挡不住，必须叠加无条件排除。

## 二、当前实现的问题清单

1. 无 .gitignore 支持（硬编码 8 个目录名，覆盖不到 `.DS_Store`/`__pycache__`/`.agents/`）；
2. depth 4 + 300 条硬上限，深层/大量文件被静默截断；
3. 隐藏文件无策略（点开头全进）；
4. 打分已按 basename 优先（上轮已修），但数据源本身脏。

## 三、方案

### 1. 数据源换成随包 ripgrep（一次性列全量）

- 新增依赖 `@vscode/ripgrep`（随包 mac/linux/win 二进制，dsh 同款依赖，pnpm 自动去重）；
- 启动时/打开 @ 菜单时执行一次：
  ```
  rg --files --hidden --sort=modified \
     -g '!.git/**' -g '!.DS_Store' -g '!**/__pycache__/**' -g '!*.pyc' -g '!*.pyo' \
     -g '!node_modules/**' -g '!dist/**' -g '!build/**' -g '!coverage/**' \
     -g '!.dsh/**' -g '!.svn/**' -g '!.hg/**' -g '!.bzr/**' -g '!.jj/**' -g '!.sl/**'
  ```
  - **.gitignore / .ignore / global gitignore 由 rg 原生处理**（这就是"固定规则"）；
  - `--hidden` 拿全量，隐藏文件由 UI 层按 CC 语义过滤（见 3）；
  - 无条件排除 = 构建产物 + 缓存 + 编辑器/VCS 元数据（fd/rg 生态共识 + dsh glob 的 VCS 清单）。
- 回退：rg 执行失败（极罕见）→ 现有 ctx.fs walker（忽略集同步扩充）。

### 2. 去掉截断上限，改"全量内存 + 显示上限"

- 路径全量进内存（1 万文件 ≈ 0.5MB，rg 毫秒级）；
- **未过滤**：只渲染前 100 条，footer 显示 `1/2345 · type to filter`（不再出现"只有 300 个"的假象）；
- **过滤后**：basename 优先的两层 fuzzy（沿用上轮），渲染 top 100 + 计数 footer；
- 打开菜单的耗时：rg 一次 ~几十 ms，缓存当次会话的列表。

### 3. 隐藏文件按 CC 语义

- 默认不显示点开头条目；**query 以 `.` 开头时显示隐藏文件**（`.env` 场景）。

### 4. 打分与展示（沿用 + 微调）

- basename 优先两层 fuzzy（已有）；rg 结果自带 `--sort=modified` 顺序，未过滤时按修改时间新→旧。

## 四、工作量与影响

| 项 | 规模 |
|---|---|
| listWorkspaceFiles 重写（spawn rg + 解析 + 回退） | ~100 行 |
| 隐藏文件过滤 + 显示上限 + footer 计数 | ~40 行 |
| package.json 加 `@vscode/ripgrep` | 1 行 |
| 单测（rg 输出解析、隐藏过滤、显示截断） | ~60 行 |

不改变 overlay 交互（搜索框/Enter/Esc 不变）；`!` 命令、/model 等不受影响。

## 五、请 review 的决策点

1. **无条件排除清单**是否同意（node_modules/dist/build/coverage/__pycache__/*.pyc/.DS_Store/VCS 元数据）——即使用户仓库没 gitignore 这些也会被排除；
2. **隐藏文件语义**选 CC（默认隐藏、`.` 开头 query 显示）还是 pi（全显）？
3. **显示上限** 100 + footer 计数是否合适？
4. rg 二进制随包（新增 ~1.5MB 依赖）是否接受？
