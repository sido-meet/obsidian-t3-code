# T3-Codian 贡献指南 (CONTRIBUTING)

感谢你关注并参与 **T3-Codian** 的建设。为了保证代码库的高可靠性、结构清晰与知识沉淀，所有人类开发者与 AI Agent 均须严格遵守本贡献指南。

---

## 1. 核心协作原则

1. **零主干直接提交**：`main` 分支是神圣的稳定分支，禁止向 `main` 分支直接推送功能代码。
2. **严禁 Force Push**：不得对公共分支执行强制推送（`git push --force`）。
3. **安全第一**：严禁提交真实 Obsidian Vault 笔记内容、API Token、私钥或任何非公开配置。
4. **规范驱动**：AI Agent 贡献必须遵循 [AGENTS.md](file:///E:/Projects/T3-Codian/AGENTS.md) 规定的 15 条核心准则。

---

## 2. 分支模型与工作流

我们采用 **Trunk-Based with Short-Lived Feature Branches** 模式：

```text
main ───────────────────────────────●─────────────────────●──────►
        \                         /                     /
         \── feat/issue-12-chat ──/                     /
          \                                            /
           \────────────── fix/issue-15-leak ─────────/
```

1. **新建分支**：基于最新的 `main` 创建短生命周期特性分支或使用 Git Worktree：
   - 功能开发：`feat/<issue-id>-<slug>`
   - 缺陷修复：`fix/<issue-id>-<slug>`
   - 文档补充：`docs/<slug>`
   - 构建维护：`chore/<slug>`
2. **本地测试与验证**：编写测试用例，确保 `npm test` 与 `npm run build` 均无警告无报错通过。
3. **发起审查**：通过自动化工具或审查 Agent 进行独立 Code Review。
4. **提交 PR**：发起 GitHub Pull Request，填写完整的上下文与验收验证证据。
5. **最终合并**：由仓库所有者（用户）审查确认后完成合并，Agent **无权**自行合并。

---

## 3. 提交规范 (Conventional Commits)

提交信息应采用业界标准的 Conventional Commits 格式：

```text
<type>(<scope>): <short description>

[optional longer body explaining 'why', not 'what']

[optional issue reference: Closes #123]
```

**常用 Type**：
- `feat`: 新增功能
- `fix`: 修复缺陷
- `docs`: 文档变更
- `refactor`: 代码重构（不增减功能、不修复缺陷）
- `test`: 增加或修改测试用例
- `chore`: 构建系统、依赖更新或辅助工具调整

---

## 4. 质量红线与测试标准

- **拒绝无测试代码**：核心业务逻辑、协议解析与状态机迁移必须覆盖自动化单元测试。
- **真实复现**：修复 Bug 时，提交必须包含先失败后修复的测试证明。
- **完工确认**：任何功能宣称完成前，必须依据验收标准逐条对照自查。

---

## 5. 问题反馈与功能建议

- 优先在 GitHub Issues 中提出讨论。
- 架构层面的重大决策，请参阅并提议新的 [Architecture Decision Record (ADR)](file:///E:/Projects/T3-Codian/docs/adr/README.md)。
