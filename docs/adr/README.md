# 架构决策记录 (Architecture Decision Records, ADR)

本项目使用 ADR 记录重大架构与技术选型决策。每一个重要技术拐点或架构变迁均应在此留下可追溯的历史。

---

## 决策记录索引

| 编号 | 标题 | 状态 | 决策日期 |
| :---: | :--- | :---: | :---: |
| [0001-A](0001-init-project-and-engineering-governance.md) | 工程初始化与严谨治理规范建立 | **Accepted** | 2026-11-18 |
| [0001-B](0001-integration-architecture.md) | T3-Codian 核心集成架构选型（轻量原生客户端与 V2 协议） | **Accepted** | 2026-11-18 |

---

## ADR 编写规范

每个 ADR 文件应采用统一模板：
- **状态 (Status)**: Proposed / Accepted / Deprecated / Superseded
- **背景与上下文 (Context)**: 遇到了什么问题或需求？
- **决策内容 (Decision)**: 我们选择了什么方案？为什么？
- **后果与影响 (Consequences)**: 带来哪些收益与妥协？
