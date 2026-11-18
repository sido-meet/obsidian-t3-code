# T3-Codian 项目当前状态与里程碑进展 (STATUS)

> **当前阶段**：阶段 2 — 工程基础设施本地就绪，等待 PR 评审（Phase 2: Engineering Baseline Ready, PR Pending Review）  
> **最后更新时间**：2026-11-18 16:52:00  
> **维护责任人**：技术负责人 (AI Tech Lead)

---

## 1. 当前阶段概况

当前项目处于**阶段 2：工程基础设施本地就绪，等待 PR 评审**阶段。  
Issue #1（工程基础设施搭建与基础插件脚手架）已在特性分支 `feat/issue-1-plugin-scaffold` 上完成本地实现，四条门禁命令（typecheck / lint / test / build）全部通过，构建产物 `main.js` 为 943 字节且 `obsidian` 保持外部化。GitHub Actions 流水线已定义但**尚未在远端实跑**（分支尚未推送），因此 Issue #1 的「CI 流水线成功跑通」验收项仍处于未验证状态。

---

## 2. 已完成事项 (Completed Items)

- [x] **P0 环境深度核查**：
  - 验证本地工具链：Node.js v22.23.1、npm 10.9.8、Git 2.48.1、GitHub CLI 2.97.0 全量就绪。
  - 验证 GitHub 认证：账号 `sido-meet` 鉴权正常，具备 `repo` 读写及管理权限。
  - 验证 T3 Code 原生能力：独立 Agent 会话派发、Git Worktree 支持、GitHub Issue/PR 操作完全可用。
- [x] **Superpowers 全局技能挂载**：
  - 在 Antigravity（T3 Code 核心驱动）完成 Superpowers 6.3.0 插件全量 14 项 Skills 的加载与启用。
  - 在 Codex 运行时完成 `superpowers@openai-curated` 插件的安装与启用。
- [x] **本地 Git 仓库初始化**：
  - 目标目录 `E:\Projects\T3-Codian` 完成 Git 仓库初始化，默认主干分支为 `main`。
  - 配置工程级 `.gitignore`（过滤 `node_modules`、构建产物、测试 Vault 及敏感凭证）。
- [x] **远程 GitHub 仓库创建与首次推送**：
  - 成功创建公开仓库：https://github.com/sido-meet/t3-codian
  - 配置远程源 `origin`（`git@github.com:sido-meet/t3-codian.git`），完成 `main` 分支上游跟踪推送。
- [x] **三大参考项目深度技术调研与方案对比**：
  - 深度阅读并剖析 `YishenTu/claudian`、`pingdotgg/t3code`、`7bgsbm749g-boop/t3-obsidian` 三大源码库。
  - 完成 4 份调研与对比决策报告：`docs/research/claudian.md`、`docs/research/t3code.md`、`docs/research/t3-obsidian.md`、`docs/research/architecture-comparison.md`。
  - 确立以“方案 D（深度原生 UI + T3 V2 协议桥接）”为核心推荐的技术路径。
- [x] **完整技术架构设计与测试策略定稿**：
  - 发布系统架构设计规范：`docs/ARCHITECTURE.md`。
  - 发布端到端四层测试金字塔规范：`docs/TESTING.md`。
  - 发布集成架构决策记录：`docs/adr/0001-integration-architecture.md`。
- [x] **Superpowers writing-plans 实施计划定稿**：
  - 编制完成可独立验证、适合独立 Review 的 8 大核心任务与 12 个 Issue 规划。
  - 归档于 `docs/superpowers/plans/mvp-v0.1.md`，涵盖工程基础设施设计与 Obsidian 官方发布策略。
- [x] **GitHub Milestone 与 Issues 远程创建完成**：
  - 创建 Milestone `MVP v0.1`（编号 #1，截止 2026-12-15），目标发布标签 `v0.1.0`。
  - 创建 22 个自定义标签：`type:*`（feature/bug/documentation/tech-debt，4 个）、`area:*`（9 个）、`stage:scaffold`、`protocol:v2`、`streaming`、`agent:codex`、`obsidian-native`、`vault-safety`、`bug:*`（2 个）、`testing:integration`。
  - 批量创建 12 个 Issue 并全部归入 Milestone `MVP v0.1`：
    - Feature #1~#8（脚手架 / 设置 / 连接状态机 / 协议客户端 / 上下文提取 / 侧边栏视图 / 流式对话 / 内容采纳）
    - Bug #9~#10（断线重连状态 / 未闭合 Markdown 渲染）
    - Documentation #11（快速上手指引）
    - Technical Debt #12（端到端 Mock Server 集成测试套件）
- [x] **Issue #1 工程基础设施本地实现完成（分支 `feat/issue-1-plugin-scaffold`，未推送）**：
  - 工程基线：TypeScript 5.9 严格模式、ESLint 10 flat config、Vitest 3.2（`obsidian` 运行时别名指向 `tests/__mocks__/obsidian.ts`）。
  - 构建链：esbuild 单文件 CommonJS 构建，`obsidian` 与 Node 内置模块外部化；`scripts/verify-bundle.mjs` 断言产物存在、体积 `< 200KB`、`obsidian` 未内联、manifest 与 package 版本一致（负向验证：超限/内联/缺失三种情形均以非 0 退出码失败）。
  - 测试基线：冒烟测试覆盖插件实例化、`onload` 注册视图与命令、`onunload` 卸载视图；manifest 一致性测试覆盖版本同步与必填字段。
  - 流水线与治理：`ci.yml`（PR + main push 门禁）、`release.yml`（仅 `v*` tag 触发，Agent 永不推送 tag）、Issue/PR 模板、README 目录结构与开发命令。
  - 实测证据：`npm run typecheck` 零错误、`npm run lint` 零告警、`npm test` 6/6 通过、`npm run build` 产出 `main.js` 943 字节。

---

## 3. 正在开发的 Issue (Active Issues)

- **Issue #1（工程基础设施搭建与基础插件脚手架）**：实现已完成，等待推送授权、独立 Code Review 与 PR 评审。
  - 计划文档：`docs/superpowers/plans/2026-11-18-issue-1-plugin-scaffold.md`
  - 特性分支：`feat/issue-1-plugin-scaffold`（基于 `main`）
- 后续 Issue（#2~#8、#11、#12）尚未启动，依赖 Issue #1 合并后推进。
- Issue 清单与远程地址（仓库 `sido-meet/t3-codian`）：
  - #1 https://github.com/sido-meet/t3-codian/issues/1
  - #2 https://github.com/sido-meet/t3-codian/issues/2
  - #3 https://github.com/sido-meet/t3-codian/issues/3
  - #4 https://github.com/sido-meet/t3-codian/issues/4
  - #5 https://github.com/sido-meet/t3-codian/issues/5
  - #6 https://github.com/sido-meet/t3-codian/issues/6
  - #7 https://github.com/sido-meet/t3-codian/issues/7
  - #8 https://github.com/sido-meet/t3-codian/issues/8
  - #9 https://github.com/sido-meet/t3-codian/issues/9
  - #10 https://github.com/sido-meet/t3-codian/issues/10
  - #11 https://github.com/sido-meet/t3-codian/issues/11
  - #12 https://github.com/sido-meet/t3-codian/issues/12

---

## 4. 阻塞问题 (Blockers)

- **推送授权待确认**：AGENTS.md 要求远程 Push 前须取得用户明确授权，因此分支尚未推送，CI 未能实跑。
- **GitHub Actions 未实跑**：Issue #1 验收标准「CI 流水线成功跑通」在远端验证前不视为完成。

---

## 5. 下一步任务 (Next Tasks)

1. **取得推送授权并推送 `feat/issue-1-plugin-scaffold`**，随后向 `main` 发起 PR 并以 PR 检查（CI 只在推送到 `main` 或向 `main` 提 PR 时触发）确认 GitHub Actions 实跑结论，回填 run 链接。
2. **完成独立 Code Review 与整分支复审**，闭环全部发现项。
3. **发起 PR**（关联 Issue #1），合并权限保留给用户，Agent 严禁自行合并、严禁推送 `v*` tag。
4. **启动 Issue #2（配置管理与设置选项卡）**，依赖 Issue #1 合并完成。
