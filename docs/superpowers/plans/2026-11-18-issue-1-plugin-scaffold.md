# Issue #1 工程基础设施与 Obsidian 插件脚手架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可独立运行的 Obsidian 插件工程骨架（TypeScript 严格模式 + esbuild 单文件构建 + Vitest 测试套件 + ESLint 零告警 + GitHub Actions CI/Release），使 Issue #2~#8 可在统一门禁下按 TDD 推进。

**Architecture:** 源码位于 `src/`，编译产物为根目录单文件 `main.js`（CommonJS、`obsidian` 声明为 external，符合 Obsidian 插件加载约定）；测试位于 `tests/`，通过 Vitest 的 `resolve.alias` 将运行时 `obsidian` 导入重定向至 `tests/__mocks__/obsidian.ts`，类型检查则始终使用官方 `obsidian` 包提供的 `obsidian.d.ts`，二者职责分离以避免 Mock 长期腐化。

**Tech Stack:** TypeScript 5.9.x（`strict: true`）、esbuild 0.28.x、Vitest 3.2.x、ESLint 10.x（flat config）+ typescript-eslint 8.73.x、`obsidian` 1.14.4（仅类型）、Node.js 22.23.1、npm 10.9.8。

**Spec:** [docs/PRD.md](file:///E:/Projects/T3-Codian/docs/PRD.md)（F-01）、[docs/ARCHITECTURE.md](file:///E:/Projects/T3-Codian/docs/ARCHITECTURE.md)（§4 技术选型、§3.1 插件表现层）、[docs/TESTING.md](file:///E:/Projects/T3-Codian/docs/TESTING.md)（§3.1/§3.3/§4）、[docs/superpowers/plans/mvp-v0.1.md](file:///E:/Projects/T3-Codian/docs/superpowers/plans/mvp-v0.1.md)（Task 1、阶段三、阶段四）、GitHub Issue #1。

**上游计划有效性检查结论:** `mvp-v0.1.md` 的 Task 1 方向有效（目标、文件清单、TDD 骨架、门禁命令均成立），但存在 **6 处需在本计划中修正的缺口**：依赖版本未锁定、`obsidian` 运行时 Mock 的解析方式未定义、`npm test` 的 watch/run 语义未定义、`test:coverage`/`test:watch` 脚本缺失、构建产物体积与外置性缺少机器可校验断言、`package-lock.json` 未列入文件清单（CI 使用 `npm ci` 依赖它）。本计划为 Issue #1 的收敛细化版，与上游计划冲突时以本计划为准。

---

## Global Constraints

- 严禁在 `main` 分支开发；本 Issue 分支固定为 `feat/issue-1-plugin-scaffold`（与 Issue #1 约束、上游计划阶段五一致）。
- 构建产物必须为**单个** `main.js`，且 `obsidian` 必须声明为 esbuild external，严禁把 Obsidian 运行时打进包体。
- 体积门禁：产物 `main.js` 必须 `< 200KB`（Issue #1 硬性约束；上游计划 Task 1 的 50KB 为更严格的内部目标，本 Issue 以 200KB 为准并在 `verify-bundle` 中断言）。
- `package.json` 与 `manifest.json` 的 `version` 必须 100% 一致（阶段四第 4 条），由自动化断言守护。
- `manifest.json` 必须包含 `id`/`name`/`version`/`minAppVersion`/`description`/`author`/`isDesktopOnly: true`。
- `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 四条门禁命令必须零错误零告警，CI 与本地口径完全一致。
- Agent 严禁推 `v*` tag、严禁创建 GitHub Release、严禁合并 PR（AGENTS.md 规则 11、12）。
- 严禁提交任何 Token、密钥或本地凭据；`.env`、`*.token`、`auth.json` 已在 `.gitignore` 中，禁止修改该策略。
- 本 Issue 不触碰用户真实 Obsidian Vault，不引入任何网络调用或对 T3 Code 的连接逻辑（属 Issue #2~#4）。

## Review Focus

以下输入/条件在 Issue #1 的验收标准中未被显式提及，但极可能在人工验收时引发问题；每条均在下文对应 Task 中以断言形式固化：

1. **交互式终端下执行 `npm test` 被卡在 watch 模式** —— 期望脚本固定为 `vitest run` 一次性执行并返回退出码，`test:watch` 单独提供 watch 模式。
2. **Windows 本地 `npm run build` 成功但产物路径或内容异常** —— 期望产物固定输出到仓库根目录 `main.js`（非 `dist/`），且构建校验脚本跨平台（仅用 `node:fs`/`node:path`）。
3. **`obsidian` 运行时模块被打进产物或测试因找不到模块而崩溃** —— 期望 esbuild 侧 external 断言成立，vitest 侧 alias 生效，测试与打包两侧均不解析真实 Obsidian 运行时。
4. **CI 上 `npm ci` 因缺少 lockfile 而失败** —— 期望 `package-lock.json` 提交入库且随 `package.json` 同步更新。
5. **`npm run lint` 在依赖升级后突然大面积报错** —— 期望 `typescript` 锁在 `5.9.x`（`typescript-eslint@8.73` 的 peer 范围为 `>=4.8.4 <6.1.0`），避免升级到 TypeScript 7 导致 lint 链断裂。
6. **构建产物超过体积门禁却仍被 CI 判为成功** —— 期望 `verify-bundle` 在构建流程内执行，体积超标直接使构建失败，而非仅打印警告。

---

## 文件结构与职责

```text
t3-codian/
├── package.json                    # 依赖与脚本唯一真源（version = 0.1.0）
├── package-lock.json               # 提交入库，CI `npm ci` 依赖
├── tsconfig.json                   # TS 严格模式 + bundler 解析（仅类型检查，无 emit）
├── esbuild.config.mjs              # 单文件 main.js 构建（CJS、external obsidian、production 压缩）
├── eslint.config.mjs               # ESLint flat config（js.recommended + typescript-eslint recommended）
├── vitest.config.mts               # 测试配置：obsidian alias、node 环境、v8 覆盖率
├── manifest.json                   # Obsidian 插件元数据（提交入库）
├── scripts/
│   └── verify-bundle.mjs           # 构建产物断言：存在性 / 体积 / external / 版本一致性
├── src/
│   └── main.ts                     # 插件入口（T3CodianPlugin），Task 1 仅最小实现
├── tests/
│   ├── __mocks__/
│   │   └── obsidian.ts             # Obsidian 运行时 Mock（按需增量扩展）
│   ├── smoke.test.ts               # 插件生命周期冒烟测试
│   └── manifest.test.ts            # manifest/package.json 版本一致性断言
├── .github/
│   ├── workflows/ci.yml            # PR + main push 门禁流水线
│   ├── workflows/release.yml       # v* tag 触发的发布流水线（Agent 永不推 tag）
│   ├── ISSUE_TEMPLATE/bug_report.yml
│   ├── ISSUE_TEMPLATE/feature_request.yml
│   └── PULL_REQUEST_TEMPLATE.md
├── .gitignore                      # 追加 coverage/、.eslintcache
├── README.md                       # 追加目录结构与开发命令
└── docs/STATUS.md                  # 阶段完成时同步（AGENTS.md 规则 15）
```

职责边界：`scripts/verify-bundle.mjs` 是**唯一**判定产物合规性的地方（CI 与本地共用同一实现）；`tests/__mocks__/obsidian.ts` 只提供运行时行为，**不**承担类型职责。

---

## 阶段一：Task 拆解

### Task 1: 工程基线、Obsidian Mock 与冒烟测试（TDD 红→绿）

**依赖:** 无

**Files:**
- Create: `package.json`
- Create: `package-lock.json`（由 `npm install` 生成并提交）
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `vitest.config.mts`
- Create: `src/main.ts`
- Create: `tests/__mocks__/obsidian.ts`
- Create: `tests/smoke.test.ts`
- Modify: `.gitignore`（追加 `coverage/`、`.eslintcache`）

**Interfaces:**
- Produces:
  ```typescript
  // src/main.ts
  export default class T3CodianPlugin extends Plugin {
    constructor(app: App, manifest: PluginManifest);
    onload(): Promise<void>;
    onunload(): Promise<void>;
  }
  // tests/__mocks__/obsidian.ts（Task 1 最小面，后续 Task 增量扩展）
  export class App { workspace: Workspace; }
  export class Plugin {
    constructor(app: App, manifest: PluginManifest);
    app: App; manifest: PluginManifest;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    registerView(type: string, factory: unknown): void;
    addRibbonIcon(icon: string, title: string, callback: () => void): unknown;
    addCommand(command: unknown): unknown;
    addSettingTab(tab: unknown): void;
    onload(): Promise<void>;
    onunload(): Promise<void>;
  }
  export interface PluginManifest { id: string; name: string; version: string; minAppVersion: string; description: string; author: string; isDesktopOnly?: boolean; }
  ```
- `tests/smoke.test.ts` 通过 `import { App } from 'obsidian'` 拿到的是上述 Mock 运行时（vitest alias）；`tsc` 解析到的是官方 `obsidian.d.ts`。Mock 的类成员签名必须与官方 d.ts 兼容（构造参数、字段名一致），否则 `tsc` 会在测试文件中报错。

- [ ] **Step 1: 建立特性分支**
  ```bash
  git checkout -b feat/issue-1-plugin-scaffold
  git status
  ```
  预期：`Switched to a new branch 'feat/issue-1-plugin-scaffold'`，工作区干净。

- [ ] **Step 2: 写入依赖清单 `package.json`**
  字段与版本固定如下（版本为 2026-11-18 实际可用且相互兼容的组合，**不得**擅自升级 `typescript` 至 6/7）：
  ```json
  {
    "name": "t3-codian",
    "version": "0.1.0",
    "description": "T3 Code Agent integration for Obsidian",
    "main": "main.js",
    "private": true,
    "scripts": {
      "build": "node esbuild.config.mjs --production && node scripts/verify-bundle.mjs",
      "dev": "node esbuild.config.mjs",
      "typecheck": "tsc --noEmit",
      "lint": "eslint . --max-warnings=0",
      "test": "vitest run",
      "test:watch": "vitest",
      "test:coverage": "vitest run --coverage"
    },
    "devDependencies": {
      "@eslint/js": "^10.0.1",
      "@types/node": "^22.0.0",
      "@vitest/coverage-v8": "^3.2.7",
      "esbuild": "^0.28.2",
      "eslint": "^10.15.0",
      "globals": "^17.14.0",
      "obsidian": "^1.14.4",
      "typescript": "^5.9.3",
      "typescript-eslint": "^8.73.0",
      "vitest": "^3.2.7"
    }
  }
  ```

- [ ] **Step 3: 安装依赖并提交 lockfile**
  ```bash
  npm install
  npm ls typescript vitest esbuild eslint typescript-eslint obsidian
  ```
  预期：无 `UNMET DEPENDENCY`；`typescript` 解析为 `5.9.x`；`obsidian` 为 `1.14.x` 且 `node_modules/obsidian/package.json` 的 `main` 为空字符串（类型包特征，确认需要 vitest alias）。

- [ ] **Step 4: 写入 `tsconfig.json`**
  固定选项：`target: "ES2022"`、`module: "ESNext"`、`moduleResolution: "bundler"`、`strict: true`、`noEmit: true`、`isolatedModules: true`、`esModuleInterop: true`、`skipLibCheck: true`、`forceConsistentCasingInFileNames: true`、`lib: ["ES2022", "DOM"]`、`types: ["node"]`、`include: ["src/**/*.ts", "tests/**/*.ts"]`。

- [ ] **Step 5: 写入 `eslint.config.mjs`**
  结构固定为：`tseslint.config({ ignores: ["node_modules/**", "main.js", "coverage/**"] }, js.configs.recommended, ...tseslint.configs.recommended, { files: ["**/*.ts", "**/*.mjs", "**/*.mts"], languageOptions: { globals: { ...globals.browser, ...globals.node } } })`。
  采用**非类型感知**规则集（不带 `projectService`），类型错误由 `npm run typecheck` 单独把关，避免 lint 阶段引入第二套类型检查开销。

- [ ] **Step 6: 写入 `vitest.config.mts`**
  固定内容：`test.environment: "node"`、`test.include: ["tests/**/*.test.ts"]`、`resolve.alias.obsidian` 指向 `./tests/__mocks__/obsidian.ts`（用 `fileURLToPath(new URL(...))` 构造绝对路径）、`test.coverage.provider: "v8"`、`test.coverage.include: ["src/**"]`、`test.coverage.reporter: ["text", "html"]`。

- [ ] **Step 7: 编写失败的冒烟测试 `tests/smoke.test.ts`**
  断言内容：
  - `it('exports a plugin class that can be instantiated', ...)`：`new T3CodianPlugin(app, manifest)` 不抛异常，且 `plugin.manifest.id === 't3-codian'`；
  - `it('completes onload without throwing', ...)`：`await plugin.onload()` 不抛异常，且 Mock 记录到至少一次 `registerView` 调用；
  - `it('releases resources on unload', ...)`：`await plugin.onunload()` 不抛异常，且 Mock 记录到 `onunload` 已执行。
  `manifest` 对象字段固定为 `{ id: 't3-codian', name: 'T3-Codian', version: '0.1.0', minAppVersion: '1.5.0', description: 'T3 Code Agent integration for Obsidian', author: 'T3-Codian Team', isDesktopOnly: true }`。

- [ ] **Step 8: 运行测试确认失败（红灯）**
  ```bash
  npm test
  ```
  预期：FAIL，报错指向 `Failed to resolve import "../src/main"`（文件尚不存在）或 `src/main.ts` 未导出默认类。

  提供上列 `App`、`Plugin`、`PluginManifest`；`Plugin` 的 `registerView`/`addRibbonIcon`/`addCommand`/`addSettingTab` 均以数组形式记录调用以便断言；`loadData` 返回 `Promise.resolve(null)`，`saveData` 返回 `Promise.resolve()`；`App` 暴露 `workspace` 空对象占位。仅实现 Task 1 需要的面，其余 Obsidian API 留待后续 Task 按需扩展（YAGNI，避免 Mock 腐化）。

- [ ] **Step 10: 写入最小实现 `src/main.ts`**
  默认导出 `T3CodianPlugin extends Plugin`；`onload()` 中调用 `this.registerView(VIEW_TYPE_T3_CODIAN, (leaf) => new T3CodianView(leaf))` 与 `this.addCommand({ id: 't3-codian-open-chat', name: '打开 T3-Codian 聊天面板', callback: () => {} })`；`onunload()` 中调用 `this.app.workspace.detachLeavesOfType(VIEW_TYPE_T3_CODIAN)` 释放已注册视图。
  **必须同时创建 `src/ui/T3CodianView.ts`**：`tsc` 解析的是官方 `obsidian.d.ts`（Mock 仅在运行时生效），`registerView` 需要真实的 `View` 实例。该占位视图继承 `ItemView`，仅实现 `getViewType()` 与 `getDisplayText()`，不含任何 UI（真实 UI 属 Issue #6）。**不实现**任何网络或设置逻辑（属后续 Issue）。

- [ ] **Step 11: 运行测试确认通过（绿灯）**
  ```bash
  npm test
  npm run typecheck
  npm run lint
  ```
  预期：三者全部 PASS / 零输出（lint 无 error、warning）。

- [ ] **Step 12: 提交**
  ```bash
  git add package.json package-lock.json tsconfig.json eslint.config.mjs vitest.config.mts src/main.ts src/ui/T3CodianView.ts tests/ .gitignore
  git commit -m "chore(scaffold): bootstrap typescript, vitest and eslint engineering baseline"
  ```

**验收标准:**
1. `npm test` 一次执行并返回退出码 0（不进入 watch）；
2. `npm run typecheck` 零错误；
3. `npm run lint` 零 error 零 warning；
4. `obsidian` 导入在测试运行时来自 Mock，未触及真实 Obsidian 运行时。

**预计复杂度:** 低-中
**主要风险:** `obsidian` 包无运行时入口（`main` 为空串），若 alias 未生效会在测试中报 `Cannot find module 'obsidian'`；`obsidian.d.ts` 对 `@codemirror/view`、`@codemirror/state` 的 peer 依赖若未自动安装会导致 typecheck 报错（npm 10 默认自动安装 peer，正常情况无需干预）。

---

### Task 2: 构建链、产物校验与 manifest 合规

**依赖:** Task 1

**Files:**
- Create: `esbuild.config.mjs`
- Create: `scripts/verify-bundle.mjs`
- Create: `manifest.json`
- Create: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `package.json`（`version` 字段）、`src/main.ts` 入口。
- Produces: 根目录 `main.js`（CommonJS 单文件）；`npm run build` 的退出码即为产物合规性判定结果；`npm run dev` 进入 watch 模式。

- [ ] **Step 1: 编写失败的一致性测试 `tests/manifest.test.ts`**
  断言内容：
  - `it('keeps manifest and package versions in sync', ...)`：读取仓库根 `manifest.json` 与 `package.json`，断言 `manifest.version === pkg.version`；
  - `it('declares the required Obsidian manifest fields', ...)`：断言 `id === 't3-codian'`、`minAppVersion === '1.5.0'`、`isDesktopOnly === true`，且 `name`/`version`/`description`/`author` 均非空字符串。

- [ ] **Step 2: 运行测试确认失败（红灯）**
  ```bash
  npm test
  ```
  预期：FAIL，报错为读取 `manifest.json` 时的 `ENOENT`。

- [ ] **Step 3: 写入 `manifest.json`**
  内容固定：`{ "id": "t3-codian", "name": "T3-Codian", "version": "0.1.0", "minAppVersion": "1.5.0", "description": "T3 Code Agent integration for Obsidian", "author": "T3-Codian Team", "authorUrl": "https://github.com/sido-meet/t3-codian", "isDesktopOnly": true }`，`version` 必须与 `package.json` 一致。

- [ ] **Step 4: 写入 `esbuild.config.mjs`**
  使用 `esbuild.context()` 构建：`entryPoints: ["src/main.ts"]`、`bundle: true`、`format: "cjs"`、`platform: "browser"`、`target: "es2018"`、`outfile: "main.js"`、`external: ["obsidian", "electron", "node:*", ...builtinModules]`、`minify: production`、`sourcemap: production ? false : "inline"`、`logLevel: "info"`。脚本入口以 `process.argv.includes("--production")` 判定生产模式：生产模式 `rebuild()` 后 `dispose()` 退出；开发模式保持 `watch()` 常驻。

- [ ] **Step 5: 写入 `scripts/verify-bundle.mjs`**
  使用 `node:fs`/`node:path` 实现以下断言，任一不满足即 `process.exit(1)` 并打印明确原因：
  1. 仓库根 `main.js` 存在；
  2. `main.js` 字节数 `< 200 * 1024`；
  3. `main.js` 内含对 `obsidian` 的外部引用（即未被内联打包），可通过对产物做 `require("obsidian")` 形态的字符串匹配判定；
  4. `manifest.json` 与 `package.json` 的 `version` 一致。

- [ ] **Step 6: 运行测试确认通过（绿灯）**
  ```bash
  npm test
  npm run build
  ```
  预期：`npm test` PASS；`npm run build` 输出 esbuild 成功信息并由 `verify-bundle.mjs` 打印体积实测值，退出码 0。

- [ ] **Step 7: 负向验证断言有效性（防止假测试）**
  临时把 `main.js` 内容替换为超大文本、替换为不含 `require("obsidian")` 的内容、或删除 `main.js`，然后**直接执行 `node scripts/verify-bundle.mjs`**（不可用 `npm run build`，它会先重新生成产物从而掩盖失败）：
  预期：三种情形均以非 0 退出码失败并打印对应原因；验证后执行 `npm run build` 恢复真实构建产物。

- [ ] **Step 8: 提交**
  ```bash
  git add esbuild.config.mjs scripts/verify-bundle.mjs manifest.json tests/manifest.test.ts
  git commit -m "chore(build): add esbuild pipeline and bundle verification gate"
  ```

**验收标准:**
1. `npm run build` 生成根目录 `main.js`，体积 `< 200KB`；
2. `obsidian` 未被打进产物；
3. `manifest.json` 与 `package.json` 版本一致且字段合规；
4. 产物不合规时构建命令必然失败（非仅告警）。

**预计复杂度:** 低
**主要风险:** esbuild `external` 配置遗漏导致 `obsidian` 被内联（体积暴涨），由 Step 5 断言与 Step 7 负向验证双重守护。

---

### Task 3: CI / Release 流水线与仓库治理

**依赖:** Task 2

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `README.md`
- Modify: `docs/STATUS.md`

**Interfaces:**
- Consumes: Task 2 产出的 `npm run build`（含 `verify-bundle`）与 `npm test` 门禁。
- Produces: GitHub Actions 两条流水线；仓库协作模板；更新后的项目状态文档。

- [ ] **Step 1: 写入 `.github/workflows/ci.yml`**
  触发条件：`pull_request`（目标 `main`）与 `push`（分支 `main`）；`runs-on: ubuntu-latest`；步骤固定为 `actions/checkout@v4` → `actions/setup-node@v4`（`node-version: 22`，`cache: npm`）→ `npm ci` → `npm run typecheck` → `npm run lint` → `npm test` → `npm run build` → 产物存在性校验（`test -f main.js`、`test -f manifest.json`）。job 名 `validate`。

- [ ] **Step 2: 写入 `.github/workflows/release.yml`**
  触发条件：`push` 上的 tag 匹配 `v*`；步骤固定为 checkout → setup-node（`node-version: 22`，`cache: npm`）→ `npm ci` → `npm run build` → 版本一致性校验（比对 `package.json` 与 `manifest.json` 的 `version`）→ 使用 `softprops/action-gh-release` 上传 `main.js`、`manifest.json`（`styles.css` 若存在则一并上传）。**Agent 永不推送 tag、绝不触发该流水线。**

- [ ] **Step 3: 写入 Issue 与 PR 模板**
  `bug_report.yml`：字段包含复现步骤、期望行为、实际行为、日志、Obsidian 版本、T3 Code 版本；`feature_request.yml`：字段包含问题场景、期望收益、关联 PRD 需求编号、里程碑；`PULL_REQUEST_TEMPLATE.md`：包含关联 Issue 编号、TDD 证据（四条门禁命令的实际输出）、`docs/STATUS.md` 更新说明、合并权限声明（"Reviewer/合并由仓库维护者执行"）。

- [ ] **Step 4: 更新 `README.md`**
  在「目录结构概览」补充 `src/`、`tests/`、`scripts/`、`.github/` 四项；在「开发环境要求」后新增「本地开发命令」小节，列出 `npm install`、`npm run dev`、`npm run test:watch`、`npm run typecheck`、`npm run lint`、`npm run build` 及其作用。

- [ ] **Step 5: 本地复现 CI 门禁**
  ```bash
  npm ci
  npm run typecheck
  npm run lint
  npm test
  npm run build
  ```
  预期：五条命令依次成功，与 CI 步骤顺序一致。

- [ ] **Step 6: 推送分支、发起 PR 并观察 PR 检查实跑**
  ```bash
  git push -u origin feat/issue-1-plugin-scaffold
  gh pr create --base main --head feat/issue-1-plugin-scaffold --title "..." --body-file .github/PULL_REQUEST_TEMPLATE.md
  gh pr checks --watch
  ```
  预期：PR 检查结论为 `success`。CI 仅在「推送到 `main`」或「向 `main` 提 PR」时触发，推送特性分支本身不会触发工作流，因此必须以 PR 检查为准。**推送前须取得用户对远程 Push 的明确授权（AGENTS.md 第 2 节）。**

- [ ] **Step 7: 发起 PR（不合并）**
  ```bash
  gh pr create --base main --head feat/issue-1-plugin-scaffold --title "chore(scaffold): bootstrap engineering infrastructure and plugin scaffold" --body-file .github/PULL_REQUEST_TEMPLATE.md
  ```
  PR 关联 Issue #1；**严禁自行合并**（AGENTS.md 规则 11）。

- [ ] **Step 8: 独立 Code Review**
  按 AGENTS.md 规则 10，委派独立审阅者（子 Agent 或独立评审流程）检查：门禁真实性（是否存在假测试/被跳过的断言）、构建产物合规性、Mock 与官方 d.ts 的签名一致性、CI 步骤与本地命令一致性。审阅意见须在合并前逐条闭环。

- [ ] **Step 9: 更新 `docs/STATUS.md`**
  将「当前阶段」推进为「阶段 2 — 工程基础设施就绪，Issue #2 可启动」，在「已完成事项」追加本 Issue 的实际交付物与**实测证据**（CI run 链接、四条门禁命令输出），在「正在开发的 Issue」记录 Issue #1 状态与 PR 链接。严禁写入未实际发生的事项。

- [ ] **Step 10: 提交**
  ```bash
  git add .github/ README.md docs/STATUS.md
  git commit -m "chore(ci): add github actions pipelines and repository governance templates"
  ```

**验收标准:**
1. GitHub Actions CI 在 PR 上完整跑通并显示绿色；
2. Release 流水线定义存在且仅 tag 触发（不由 Agent 触发）；
3. README 与 STATUS.md 内容与仓库真实状态一致。

**预计复杂度:** 低
**主要风险:** `npm ci` 要求 lockfile 与 `package.json` 严格同步，Step 5 的 `npm ci` 是该风险的前置验证；`release.yml` 的 tag 触发机制若被误用会越权发布，务必由用户执行 tag 推送。

---

## 依赖与未完成 Issue 的关系

| 依赖项 | 状态 | 说明 |
| --- | --- | --- |
| Issue #2~#8 | 未完成 | 本 Issue **不依赖**其中任何一个，也不反向依赖；Task 1 只产出工程门禁本身 |
| `obsidian` 类型包 | 可用（1.14.4，已验证 registry 可达） | peer `@codemirror/view` `@codemirror/state` 由 npm 10 自动安装 |
| TypeScript 6/7 | **不可用** | `typescript-eslint@8.73` peer 范围 `>=4.8.4 <6.1.0`，故锁定 `typescript@^5.9.3` |
| Vitest 5 | 暂不采用 | Vitest 5 将 `vite` 降级为 peer 且要求 `node ^22.12.0`；选 `vitest@^3.2.7`（自带 vite 依赖）以降低首期风险，后续可单独升级 |

## 冲突与缺口检查结论

| 检查项 | 结论 | 处置 |
| --- | --- | --- |
| 与现有架构冲突 | 无实质冲突 | PRD 体积上限 500KB > ARCHITECTURE/Issue 的 200KB，取更严者；以 200KB 为断言门禁 |
| 重复实现 | 无 | 仓库当前无 `src/`、无 `package.json`；`scripts/verify-bundle.mjs` 是体积/外置性判定的唯一实现，CI 与本地共用 |
| 需求不明确 | 3 处 | ①「符合 Obsidian 格式的 main.js」→ 落为 4 条机器断言；②「lint 零告警」→ 明确规则集为 `js.recommended + typescript-eslint recommended`（非类型感知）；③「npm test」语义 → 固定 `vitest run` |
| 缺少测试条件 | 已补齐 | 补 `obsidian` alias、`package-lock.json` 入库、`test:coverage`/`test:watch` 脚本、产物负向验证（防假测试） |
| 依赖其他未完成 Issue | 无 | 全部交付物在 Issue #1 内部闭环 |

## 完成标准（DoD）

1. `npm run typecheck` 零错误、`npm run lint` 零告警、`npm test` 全部通过、`npm run build` 成功且 `main.js` `< 200KB`；
2. `manifest.json` 与 `package.json` 版本一致，manifest 必填字段齐全；
3. GitHub Actions CI 在 PR 上实跑为 `success`（附 run 链接作为证据）；
4. 冒烟测试为真实断言（含 `onload` 注册视图与 `onunload` 资源释放校验），无 no-op 测试；
5. 独立 Code Review 完成且意见闭环；
6. `docs/STATUS.md` 已按真实情况更新；
7. PR 已发起并**保持未合并**，等待用户执行合并。

## 自检（对照 writing-plans 清单）

1. **Spec coverage:** Issue #1 的 5 条验收标准（build / typecheck / lint / test / CI）分别由 Task 2、Task 1、Task 1、Task 1、Task 3 覆盖；上游计划阶段三的 6 个脚本、阶段四的 6 项合规要求、阶段五的分支名均已落地。
2. **Step scan:** 每个步骤均为单一可执行动作且带可判定结果（命令 + 预期输出）；无 "TBD"、无 "补充边界处理" 类空步骤。
3. **Type consistency:** `T3CodianPlugin`、`PluginManifest`、`App`、`Plugin` 的名称与签名在 Task 1 定义、Task 2/3 引用处完全一致；`npm run build` 在 CI 与本地为同一命令。
4. **Review Focus:** 6 条关注点全部落到具体步骤（watch 语义 → Task 1 Step 2；产物路径与跨平台 → Task 2 Step 5；obsidian external → Task 2 Step 5；lockfile → Task 3 Step 5；TS 版本漂移 → Task 1 Step 2；体积门禁 → Task 2 Step 5+7）。
5. **Proportion:** 本计划只描述文件、签名、命令与断言，不含实现代码正文；总长度与 Task 1 的复杂度相称。

