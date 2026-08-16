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

## 注意

- `lib/` 是编译产物，勿手改、勿提交。
- 测试用 Node 原生 test runner + `tsx`，不要引入额外测试框架。
- 历史文档 `PLAN.md`、`UX*.md` 是归档调研/提案，不在 Prettier 范围（见 `.prettierignore`）。
