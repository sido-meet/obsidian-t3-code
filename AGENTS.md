# Obsidian T3 Code Agent 工程规范与行为约束指南

> 本文档是所有参与 Obsidian T3 Code 项目的 AI Agent（包括 Antigravity、Codex、Claude 等）必须严格遵守的不可违背法则（Non-negotiable Rules）。任何 Agent 在开始执行任务前，必须通读并严格履行本文档定义的全部要求。

---

## 1. 核心行为准则（15 条铁律）

1. **先读文档再动手**：开发前必须先阅读项目文档（`README.md`、`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/STATUS.md`、`docs/WORKFLOW.md`）和当前处理的 Issue，严禁盲目行动。
2. **需求变更先对齐设计**：任何涉及需求蔓延、架构调整或接口变更的改动，必须先与用户讨论并确认设计方案，不得擅自修改既定范围。
3. **任务必带验收标准**：每一个开发任务都必须有明确、可量化、可测试的验收标准（Acceptance Criteria）。
4. **编码前必须有计划**：在编写具体代码前，必须形成详细的开发实施计划（Implementation Plan），明确文件修改点与步骤顺序。
5. **分支隔离与 Worktree 策略**：严禁直接在 `main` 分支进行功能开发。所有功能特性开发必须使用独立的 Git 特性分支（`feat/*`）或通过 Git Worktree 进行环境隔离。
6. **Bug 修复先复现后测试**：对于 Bug 修复任务，必须先编写能够稳定复现问题的测试用例，确认失败后再进行修复，并在修复后确保回归测试通过。
7. **优先使用 Superpowers 技能体系**：在各开发阶段，优先调用对应 Superpowers 技能（如 `brainstorming`、`writing-plans`、`test-driven-development`、`systematic-debugging`、`subagent-driven-development`、`requesting-code-review`、`verification-before-completion`、`finishing-a-development-branch` 等）。
8. **严禁跳过测试**：不允许为了任务通过而注释掉测试、使用假测试（No-op tests）、或者跳过既有单元测试与集成测试。
9. **严禁未验证即宣称完成**：不允许在未经实际编译、运行、测试校验通过的情况下宣称任务已完成。
10. **独立代码审查**：任何功能代码提交或 PR 发起前，必须经过独立的 Code Review（通过子 Agent、专门审阅指令或同行审查流程）。
11. **严禁擅自合并 PR**：AI Agent 严禁自行合并 Pull Request 到 `main` 分支，合并权限归用户独占。
12. **严禁擅自发布正式版本**：严禁自行发布 npm 包、GitHub Release 或 Obsidian Community Plugin 版本。
13. **严禁未经批准修改用户的正式 Obsidian Vault**：开发与测试必须使用沙箱或专门的测试库（`test-vault`），严禁读写或修改用户的真实笔记数据。
14. **严禁泄露密钥与敏感信息**：严禁在代码、日志、提交信息中输出或提交 Token、密码、API Key 等任何机密，敏感配置必须使用环境变量或系统凭据管理。
15. **阶段完成必须更新 STATUS.md**：每完成一个开发阶段、里程碑或关键任务，必须同步更新 `docs/STATUS.md`，真实记录阶段成果与待办事项。

---

## 2. Git 工作流与分支规范

- **主干分支**：`main` 保持稳定、可发布状态。只接受经过 Review 并由用户批准合并的 PR。
- **分支命名规范**：
  - 特性开发：`feat/<issue-id>-<short-description>`
  - 缺陷修复：`fix/<issue-id>-<short-description>`
  - 重构优化：`refactor/<short-description>`
  - 文档维护：`docs/<short-description>`
  - 工程配置：`chore/<short-description>`
- **禁止 Force Push**：严禁在任何分支执行带破坏性的 `--force` 推送。
- **远程操作授权**：创建远程 GitHub 仓库、首次关联远程或执行 Push 操作前，必须明确请求用户确认。
- **提交信息格式（Conventional Commits）**：
  ```text
  <type>(<scope>): <subject>

  [optional body]

  [optional footer(s)]
  ```

---

## 3. 技术决策记录（ADR）

- 当面临重大技术选型、架构重构或协议设计（如 Obsidian 与 T3 Code ACP 桥接方式、IPC 通信机制、鉴权方案等）时，必须在 `docs/adr/` 目录下按序号撰写 ADR（Architecture Decision Record）文档。
- 格式遵循：状态、背景、决策内容、影响与推论。

---

## 4. 文档自洽性与真实性

- 所有文档内容必须反映实际代码仓库和运行环境的真实状态，**严禁凭空编造已完成的实现记录**。
- 实施计划、产品需求与系统架构必须分开归档，保持单向依赖与可追溯性。
