# AGENTS.md — 给 AI coding agent 与贡献者

本文件是 AI coding agent（以及人类贡献者）在本仓库工作时的约定与命令参考。

## 项目

- `dsh-pi-tui`：基于 `@earendil-works/pi-tui` 的 DeepSeek Harness 终端前端（cordis bundle 插件）。
- TypeScript + ESM（`"type":"module"`）+ Node ≥22.19；核心在 `src/`，测试在 `test/`（Node 原生 `node:test`）。

## 命令

```sh
npm install         # 安装依赖（含 husky prepare）
npm run build       # tsc 编译 src → lib
npm test            # node:test 跑 test/*.test.ts
npm run lint        # ESLint flat config，含 type-aware recommendedTypeChecked
npm run lint:fix    # 自动修复可修问题
npm run typecheck   # tsc 对 src + test 做类型检查（tsconfig.eslint.json）
npm run format      # Prettier 写回（.prettierrc.json）
npm run format:check
```

## 完成定义（Definition of Done）

改动完成前必须全绿：

```sh
npm run lint && npm run typecheck && npm run build && npm test
```

CI 对每个 PR 跑同样四步；pre-commit hook（husky + lint-staged）在提交时对暂存文件自动跑
`eslint --fix` + `prettier --write`。

## 代码规范

- 风格由 Prettier 决定：无分号、单引号、`trailingComma: all`、`printWidth: 100`。不要手工对抗 Prettier；跑 `npm run format`。
- ESLint 用 `recommendedTypeChecked`（type-aware）。fire-and-forget 的 Promise 必须用 `void` 前缀（`void this.cmdXxx()`），禁止静默丢弃。
- 类型安全：`tsconfig` 开了 `strict`。优先复用 `@deepseek-ai/dsh-*` 的导出类型；跨文件的服务面类型集中在 `src/core/services.ts`。
- 纯逻辑放 `src/core/`（可单测、无终端依赖）；渲染放 `src/ui/`。新逻辑尽量配 `test/` 单测。

## 依赖升级

插件的运行时宿主是官方 `dsh` CLI，因此 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 的版本必须与
本机 `dsh` 对齐（`dsh --version`；rc 阶段的 `next` dist-tag 才是当前发行版，`latest` 常常是旧的）。
`dsh` 加载插件时会校验 `peerDependencies`，不匹配会直接跳过整个 bundle。

升级后**类型检查通过并不等于能跑**：`ctx.get(...)` 取到的服务面是手写 cast，服务方法改名/改形状
只会体现在运行时。已知踩过的坑：

- `userQuestions.registerProvider` → `user-questions/request` 瀑布
- `shell.start()`/`run()` → `resolve()` + `execute()` 句柄
- `sessionPersistence.list()` 由「裸 `SessionHeader[]`」变成「`{ header, revision, … }` 快照」，
  且 `load()` 被 `open(id, 'read')` 句柄取代（漏改会让每个会话渲染成 `undefined · NaN-NaN-NaN`）
- `jobs.list(caller)` 的 `caller` 是 `SessionId`（实现按 `job.owner.id === caller` 过滤），
  传 Agent 对象会静默丢掉本会话的 job

所以改完依赖必须同时做两件事：

1. **把每个 `ctx.get(...)` 的 cast 对着 `node_modules/` 里的 `.d.ts` 逐个核一遍方法名、参数与返回形状。**
2. 跑一次真实运行冒烟测试：

```sh
npm run build
# 用工作区内的临时 DSH_HOME 起一个真实 profile（不动 ~/.dsh）
mkdir -p .smoke-home/profiles/pi-tui/node_modules
ln -s ~/.dsh/profiles/node_modules .smoke-home/profiles/node_modules
ln -s "$PWD" .smoke-home/profiles/pi-tui/node_modules/dsh-pi-tui
cp ~/.dsh/profiles/pi-tui/cordis.patch.yml .smoke-home/profiles/pi-tui/
# cordis.yml = []，package.json 的 dsh.profile.bundles = ["@deepseek-ai/dsh-base","dsh-pi-tui"]
DSH_HOME=$PWD/.smoke-home dsh --profile pi-tui --help   # 非交互：验证装载
DSH_HOME=$PWD/.smoke-home script -qec "dsh --profile pi-tui" /dev/null   # 交互：PTY 下用真终端
```

最小可接受覆盖：启动 banner、一次流式回答、一次工具调用、`/resume` 重放、`/model` 与 `@` 选择器、
`!` shell 注入、plan 模式的 plan-review 决策条。

**「没报错」不等于「对」**：选择器、状态栏这类读模型要在冒烟里读它的**内容**（有没有
`undefined`/`NaN`/空列表），只确认弹层出现过会漏掉整类服务形状漂移——`/resume` 选择器就是这样
带着 0.5.0 发出去的。冒烟目录用完即删，不要提交。

## 注意

- `lib/` 是编译产物，勿手改、勿提交。
- 测试用 Node 原生 test runner + `tsx`，不要引入额外测试框架。
- 历史文档 `PLAN.md`、`UX*.md` 是归档调研/提案，不在 Prettier 范围（见 `.prettierignore`）。
