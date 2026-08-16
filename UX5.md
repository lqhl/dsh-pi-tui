# dsh-pi-tui UX5 方案：/permission 去重、状态栏位置、启动 banner（待 review）

## 问题 1：/permission 出现两个候选

### 根因（已核实）

dsh-base 的 **官方命令注册表里已经有 `/permission`**（`dsh-permission-presets`）：
- 描述「Switch the permission preset (sandbox mode + approval policy)」；
- **权限 preset = sandbox 模式 + 审批策略的捆绑**：默认 `workspace-write`（ws-write + ask）、`danger-full-access`（danger + never）；
- 裸调用报当前 preset + 可用列表；`/permission <preset>` 经 `set()` 切换（含审批策略联动）；
- 另有 `permissions` **session 投影**（当前 preset 名 / `custom`）。

我们上一轮自造的 `/permission`（只切 sandbox 模式）与它撞名且**本地分支优先**，把官方命令遮蔽了——这正是你看到两个候选的来源。

### 建议

1. **删除本地 `/permission`**（命令分支 + 补全条目），官方命令接管：
   - `/permission` → 显示当前 preset 与可用列表（官方输出）；
   - `/permission workspace-write | danger-full-access` → 官方切换（含审批策略联动，danger 预设自带 never 审批）；
   - 我们上一轮加的 danger 确认弹窗随之移除（官方预设切换本身就是显式人类动作）。
2. **状态栏权限段改用 `permissions` 投影**（当前 preset 名，短映射 ws-write/danger/custom），投影缺失时回退 `sandboxPolicy.resolve`。

## 问题 2：状态栏在输入框上面

布局现状：messages → statusBar → editor（状态栏夹在消息和输入框之间）。pi/CC 的惯例是 **statusline 固定在输入框下方（屏幕最底部）**。

### 建议

children 顺序改为 **messages → editor → statusBar**（状态栏到底部）。loader 仍在消息流末尾不受影响。

## 问题 3：启动 banner（DeepSeek 鲸鱼）

dsh 官方没有现成品牌资产（`dsh-brand` 只是 branded-id 工具，无名称/logo 字符串），需要自绘。方案：

- **时机**：进入 TUI 时（boot）以及每次 `/new` `/fork` `/resume` 切换后，在 transcript 顶部渲染欢迎块（notice 条目，随消息自然上滚）；
- **内容**：品牌蓝（pi 蓝 `#4fc1ff`）ASCII 鲸鱼 + `dsh-pi-tui · DeepSeek Harness Terminal UI` + 会话信息（cwd / preset / model）+ 一行提示 `Esc 中断 · Ctrl+C 退出 · /hotkeys 全部键位`；
- **鲸鱼草稿**（40 列内，可再调）：

```
                 .---------------------------------.
                 |    dsh-pi-tui · DeepSeek Harness |
                 |         terminal UI              |
                 '---------------------------------'
                               .
                             .:'.
                          _.':::':_      _______
                       .-': : : : :'-.   /     _)
                      /   : : : : :   \  \    (o)
                     |    : : : : :    |  '-----'
                     |    o       o    |
                     |                 |
                      \     \___/     /
                       '-._________.-'
                   ~^~^~^~^~^~^~^~^~^~^~^~^~^~^~
```

（鲸鱼=主视觉；若你更喜欢极简几行的版本或想参考 DeepSeek logo 的侧影风格，我可再画 2-3 个变体给你挑。）

## 实现规模

| 项 | 规模 |
|---|---|
| 删除本地 /permission + 权限段改投影 | ~30 行（净删） |
| 布局调整（状态栏到底部） | 2 行 |
| 启动 banner（含鲸鱼常量 + session 信息） | ~60 行 + 1 个渲染单测 |

## 请 review

1. 删本地 `/permission`、官方命令接管（含移除 danger 确认弹窗）——同意吗？
2. 状态栏移到输入框下方——确认？
3. banner 时机（boot + 每次会话切换）与内容（鲸鱼 + 会话信息 + 键位提示）——OK？鲸鱼画风要不要我出几个变体先给你选？
