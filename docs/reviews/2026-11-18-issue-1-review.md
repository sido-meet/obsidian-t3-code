# Issue #1 独立 Code Review 记录

> **分支**：`feat/issue-1-plugin-scaffold` · **基线**：`main` @ `9891b96` · **关联 Issue**：#1  
> **记录原则**：仅登记实际发生的审查与实际闭环的处置，不写入未发生的结论。

## 1. 审查轮次

| 轮次 | 范围 | 结论 | 发现数 | 闭环方式 |
| --- | --- | --- | --- | --- |
| R1 任务级 | Task 1（工程基线与冒烟测试） | Spec ✅ / Approved | 3 Minor | 2 项随任务级修复波次闭环；1 项（开发工具链审计告警）转为依赖升级跟进项 |
| R2 整分支 | `9891b96..9882aa9` | Needs fixes | 1 Critical + 6 Important + 3 Minor | 全部闭环于 `f0baa43` 与 `0db1f05`，定向复审确认 9/10 闭环，剩余 1 项（PR 创建步骤重复）于 `0db1f05` 闭环 |
| R3 外部独立审查 | 整分支（含 R2 修复） | REQUEST CHANGES | 4 P2 + 10 P3 | 见第 3 节处置表；未闭环项均标注原因与后续归属 |

## 2. R2 关键发现的闭环方式（摘要）

| 级别 | 发现 | 闭环 |
| --- | --- | --- |
| Critical | `docs/STATUS.md` 标签数（21）与测试数（5/5）与事实不符 | 以 `gh label list` 实测更正为 22 个自定义标签、6/6 测试 |
| Important | `release.yml` YAML 解析失败 | 改用块标量 `run: |`；四个工作流/模板文件均以 `yaml` 包解析通过 |
| Important | lint 允许告警通过 | `npm run lint` 改为 `eslint . --max-warnings=0`，探针验证告警即非 0 退出 |
| Important | 负向验证被 `npm run build` 重建掩盖 | 计划与 STATUS 明确要求直跑 `node scripts/verify-bundle.mjs` |
| Important | CI 触发序列错误 | 统一为：独立审查 → 推送授权 → 推送 → 创建唯一 PR → 观察 PR 检查 |
| Important | `node:*` 未外部化 | esbuild external 增加 `node:*`，探针验证 `node:fs` 与 `fs` 均可解析 |
| Important | CI 令牌权限过宽 | `ci.yml` 设 `permissions: contents: read` 且 `persist-credentials: false`；`release.yml` 仅保留发布所需的 `contents: write` |
| Minor | 计划片段与实现不一致、README 暗示已有设置页、Bug 模板强制勾选排除数据丢失报告 | 均已按实际实现与真实状态更正 |

## 3. R3（外部独立审查）处置表

| 编号 | 问题 | 判断 | 处置 |
| --- | --- | --- | --- |
| P2-1 | `async onunload()` 偏离 Obsidian 同步卸载契约，且未调用 `super.onunload()` | 成立（`obsidian.d.ts:3010` 为 `onunload(): void`） | 已修复：`onunload()` 改为同步 `void` 并调用 `super.onunload()`，Mock 补齐 `register`/`registerEvent`/`registerDomEvent`/`registerInterval` 与基类清理语义，测试覆盖资源释放 |
| P2-2 | 注册了空回调命令，用户无法打开视图 | 成立（命令回调为 `() => {}`） | 已修复：命令回调改为 `getRightLeaf(false).setViewState({ type })` 打开右侧边栏视图，并补充对应断言 |
| P2-3 | Release 未校验 tag 与包版本一致 | 成立 | 已修复：新增 `Verify release tag matches package version` 步骤，`v${package.json.version}` 与触发 tag 不一致即失败 |
| P2-4 | CI 缺少 Windows 车道 | 成立（项目为 Windows 优先） | 已修复：CI 矩阵扩展为 `ubuntu-latest` + `windows-latest`，产物校验步骤改用 `shell: bash` 以跨平台执行 |
| P3-5 | `getDisplayText()` 无测试覆盖 | 成立 | 已修复：视图工厂断言补充 `getDisplayText() === 'T3-Codian'` |
| P3-6 | 产物门禁脚本自身无测试、外置性判定依赖正则 | 部分成立 | 已修复核心风险：合规判定抽为纯函数 `scripts/bundlePolicy.mjs`，由脚本与 `tests/verify-bundle.test.ts` 共同调用，覆盖超限/内联/版本错配三种失败；外置性判定仍为字符串匹配，未改用 esbuild metafile（收益有限，属后续增强） |
| P3-7 | Mock 自带 `PluginManifest` 影子类型 | 成立 | 已修复：删除影子类型，改为 `import type` 引用官方 d.ts 类型 |
| P3-8 | Mock 缺少 Component 清理面 | 成立 | 已修复：Mock 补齐 `register`/`registerEvent`/`registerDomEvent`/`registerInterval` 与卸载清理，测试断言资源被释放 |
| P3-9 | README 目录树过时、LICENSE 文件缺失 | 成立 | 已修复：补齐目录树条目、新增 MIT `LICENSE` 文件、修正协议徽章链接 |
| P3-10 | CI 无依赖审计环节 | 部分成立 | 已修复可自动化部分：CI 增加 `npm audit --omit=dev --audit-level=high` 门禁（产物零第三方依赖，已实测 0 漏洞）；dev 依赖的 17 条告警按版本锁保留，升级列入跟进项 |
| P3-11 | `docs/adr/` 两份 ADR 编号重复 | 成立但**属既有问题**（存在于 `main`） | **未在本 Issue 修复**：重命名需同步 `docs/ARCHITECTURE.md`、`docs/PRD.md` 等引用，超出 Issue #1 范围，留作独立 `docs/` Issue |
| P3-12 | STATUS.md 存在仓库内不可验证的复审声明 | 成立 | 已修复：本文件即为可追溯的审查记录，STATUS.md 改为引用本文件路径 |
| P3-13 | esbuild 路径按 CWD 解析、dev 模式覆写生产产物 | 部分成立 | 已修复 CWD 依赖：esbuild 增设 `absWorkingDir`，跨目录调用构建脚本已实测通过；dev 模式 sourcemap 由 `inline` 改为 `external`（`main.js.map` 独立文件并已忽略），仍会覆写 `main.js`，README 已注明 dev 产物为调试版、可执行 `npm run build` 重新生成发布产物 |

## 4. 尚未验证事项

- **GitHub Actions CI 未实跑**：分支尚未推送，Issue #1 验收标准第 5 条仍未验证；`docs/STATUS.md` 已如实登记为阻塞项。
- **Obsidian 运行时未实测**：`onunload()` 同步契约的结论来自官方 d.ts 签名与参考实现，未在真实 Obsidian 中验证（未安装 Obsidian，未触碰任何真实 Vault）。
