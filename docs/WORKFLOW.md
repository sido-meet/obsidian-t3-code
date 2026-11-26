# Obsidian T3 Code 研发工作流与质量保障规范 (WORKFLOW)

> 本文档规范了 Obsidian T3 Code 从需求提出、方案设计、编码实现、验证测试到最终合并的完整生命周期。全体开发人员与 AI Agent 必须严格遵守此闭环流程。

---

## 1. 完整研发流总览

```text
[Issue 规划/认领]
       │
       ▼
[阶段 1: 需求研读与设计讨论] ◄─── (Superpowers: brainstorming)
       │
       ▼
[阶段 2: 制定实施计划与验收标准] ◄─── (Superpowers: writing-plans)
       │
       ▼
[阶段 3: 创建分支 / Worktree 隔离] ◄─── (Superpowers: using-git-worktrees)
       │
       ▼
[阶段 4: 测试驱动开发 (TDD 循环)] ◄─── (Superpowers: test-driven-development)
  ├── 1. 编写失败的测试 (Red)
  ├── 2. 最小化实现代码 (Green)
  └── 3. 重构优化并保持测试绿灯 (Refactor)
       │
       ▼ (若遇缺陷: systematic-debugging)
[阶段 5: 交付前全量验证] ◄─── (Superpowers: verification-before-completion)
       │
       ▼
[阶段 6: 独立代码审查] ◄─── (Superpowers: requesting-code-review)
       │
       ▼
[阶段 7: 提交 Pull Request] ◄─── (Superpowers: finishing-a-development-branch)
       │
       ▼
[阶段 8: 用户最终审核与合并] ──► [同步更新 docs/STATUS.md]
```

---

## 2. 各阶段执行规约详解

### 阶段 1：需求研读与设计对齐 (Brainstorming)
- **触发条件**：认领新功能或重大 Issue。
- **操作规范**：
  1. 仔细阅读 Issue 描述及相关联的 PRD、架构文档。
  2. 针对技术方案、用户交互和数据边界进行充分讨论，如有技术分歧或方案权衡，编写 ADR（架构决策记录）。
  3. 确认无未决争议后，方可进入实施规划。

### 阶段 2：制定实施计划 (Writing Plans)
- **输出成果**：形成清晰可执行的《实施计划清单》。
- **计划要素**：
  - 清单化文件变动范围（创建、修改、删除）。
  - 分步实现的先后依赖。
  - **明确的验收标准（Acceptance Criteria）**：包括测试覆盖目标、性能指标与边界行为。

### 阶段 3：分支隔离 (Branching & Worktree)
- **原则**：严禁在 `main` 直接编码。
- **操作**：
  - 基于最新 `main` 检出特性分支：`git checkout -b feat/<issue-id>-<slug>`。
  - 对于耗时或并行任务，优先使用 T3 Code 原生支持的 Git Worktree 隔离空间。

### 阶段 4：测试驱动开发 (TDD)
- **执行规则**：
  - 核心逻辑先写单元测试，在确认测试用例失败（预期内报错）后，再编写业务实现代码。
  - **禁止跳过测试**：不得使用假断言、不得注释测试。
  - 修复 Bug 时，必须首先编写能够精准复现该缺陷的回归测试用例。

### 阶段 5：完工全量验证 (Verification Before Completion)
- 在宣称代码开发完成前，必须按顺序执行以下验证：
  1. `npm run lint`：静态代码检查无任何报错与警告。
  2. `npm run typecheck`：TypeScript 严格类型检查通过。
  3. `npm test`：全量测试套件通过（100% 测试绿灯）。
  4. `npm run build`：生产环境打包成功，无异常体积或依赖缺失。
  5. 对照实施计划中的“验收标准”进行自查确认。

### 阶段 6：独立代码审查 (Code Review)
- 通过独立的 Review 子 Agent 或审阅规约，对代码变更进行客观检查：
  - 是否存在性能缺陷或内存泄露？
  - 是否侵入了未授权的 Vault 目录？
  - 是否泄露了敏感字符串或缺少错误处理？
  - 代码风格是否符合规范？

### 阶段 7：发起 Pull Request (PR)
- 提交规范的 Commit 记录（遵循 Conventional Commits 规范）。
- 严禁 Force Push。
- 提交 PR，详实记录：改动概述、关联 Issue、测试通过证据、验证截图或日志。

### 阶段 8：用户审核、合并与状态更新
- **合并特权**：Agent 严禁自行 Merge PR。由项目所有者（用户）在 GitHub 上完成审核与合并。
- **状态同步**：合并完成后，同步更新 [docs/STATUS.md](file:///E:/Projects/T3-Codian/docs/STATUS.md)，推进里程碑并归档已解决 Issue。
