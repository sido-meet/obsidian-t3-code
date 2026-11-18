# T3-Codian

> 将 T3 Code 的自主 AI Agent 能力深度集成到 Obsidian 双链知识库中。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Obsidian Plugin](https://img.shields.io/badge/Obsidian-Plugin-purple.svg)](https://obsidian.md)
[![Agent Protocol](https://img.shields.io/badge/Protocol-T3%20ACP%20%2F%20MCP-blue.svg)](https://github.com/sido-meet/t3-codian)

---

## 1. 项目定位

**T3-Codian** 是一款将 **T3 Code** 强大的多智能体编排与执行引擎无缝引入 **Obsidian** 的官方风格插件。

- **插件 ID**：`t3-codian`
- **代码仓库**：`t3-codian`
- **目标愿景**：让 Obsidian 创作者和研究者在本地笔记工作流中，直接指挥具备工具调用、文件读写、自主思考、Git Worktree 隔离与协同能力的 AI Agent，实现从“知识记录”到“自主执行与知识共创”的质变。

---

## 2. 核心架构与特性构想

```text
┌────────────────────────────────────────────────────────┐
│                   Obsidian Desktop                     │
│  ┌──────────────────┐            ┌──────────────────┐  │
│  │   Vault Notes    │ ◄────────► │ T3-Codian View   │  │
│  │  (Markdown/Tags) │            │ (Chat & Panels)  │  │
│  └──────────────────┘            └─────────┬────────┘  │
└────────────────────────────────────────────┼───────────┘
                                             │ JSON-RPC / IPC
                                             ▼
┌────────────────────────────────────────────────────────┐
│                   T3 Code Agent Core                   │
│  ┌────────────────────────┐    ┌────────────────────┐  │
│  │ Agent Client Protocol  │    │  MCP / Tool Server │  │
│  │ (Multi-Agent Swarm)    │    │ (Sandbox & Safety) │  │
│  └────────────────────────┘    └────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

- **笔记上下文注入**：支持将 Obsidian 当前笔记、双链图谱、选中文本一键注入 Agent 会话。
- **Agent 对话面板**：在 Obsidian 侧边栏提供直观、响应迅速的 Agent 交互界面，实时展示思考链路、工具执行过程。
- **安全沙箱与 Vault 保护**：严格区分真实 Vault 与安全沙箱，对笔记文件的修改采用 Diff 预览及用户确认机制。
- **T3 Code 生态互通**：支持共享会话、Worktree 分支管理及跨智能体协同。

---

## 3. 开发环境要求

- **操作系统**：Windows 11 / macOS / Linux
- **Node.js**：`>= v20.0.0`（推荐 LTS v22.x）
- **包管理器**：`npm >= 10.x`
- **版本控制**：`Git >= 2.40.0`，`GitHub CLI (gh)`
- **编辑器推荐**：VS Code 或具备 TypeScript 支持的 IDE
- **Agent 开发规范**：遵循 [AGENTS.md](file:///E:/Projects/T3-Codian/AGENTS.md) 与 [Superpowers](file:///C:/Users/Administrator/.gemini/config/plugins/superpowers) 技能规范

---

## 4. 目录结构概览

```text
t3-codian/
├── AGENTS.md               # AI Agent 必须遵守的工程规则
├── CONTRIBUTING.md         # 参与协作与贡献指南
├── README.md               # 本文件
├── LICENSE                 # MIT 许可证
├── package.json            # 依赖与脚本唯一真源
├── manifest.json           # Obsidian 插件元数据（版本与 package.json 强一致）
├── esbuild.config.mjs      # esbuild 单文件构建（CJS，obsidian 外部化）
├── vitest.config.mts       # Vitest 配置（obsidian 运行时别名、覆盖率）
├── eslint.config.mjs       # ESLint flat config
├── tsconfig.json           # TypeScript 严格模式（仅类型检查）
├── scripts/                # 构建产物校验脚本
├── src/                    # 插件源码
│   ├── main.ts             # 插件入口（T3CodianPlugin）
│   └── ui/                 # 侧边栏视图
├── tests/                  # 单元测试与 Obsidian Mock
├── .github/                # Actions 流水线、Issue 与 PR 模板
├── docs/                   # 项目设计与文档
│   ├── PRD.md              # 产品需求文档
│   ├── ARCHITECTURE.md     # 架构设计方案
│   ├── STATUS.md           # 项目状态跟踪（阶段、Issue、阻塞项）
│   ├── WORKFLOW.md         # 完整开发工作流（TDD、Review、分支）
│   ├── TESTING.md          # 测试策略与质量门禁
│   ├── reviews/            # 独立 Code Review 记录归档
│   ├── superpowers/plans/  # 实施计划（Issue 级）
│   └── adr/                # 架构决策记录（Architecture Decision Records）
│       ├── README.md
│       ├── 0001-init-project-and-engineering-governance.md
│       └── 0001-integration-architecture.md
```

## 5. 本地开发命令

```bash
npm install          # 安装依赖（首次或依赖变更后）
npm run dev          # esbuild 监听模式，产出根目录 main.js + main.js.map（调试版，会覆写产物）
npm run build        # 生产构建 + 产物合规校验（体积/外部化/版本一致）
npm run typecheck    # tsc --noEmit，零容忍类型错误
npm run lint         # ESLint，零告警
npm test             # Vitest 单次执行（TDD 红灯/绿灯验证）
npm run test:watch   # Vitest 监听模式
npm run test:coverage # 输出覆盖率报告
```

本地 T3 Code 服务端默认地址为 `http://127.0.0.1:3425`；可视化设置项将在 Issue #2（配置管理与设置选项卡）落地。

---

## 6. 工程规约速查

本项目推行严格的软件工程规约：
- **禁止在 `main` 直接开发**：必须通过 `feat/*` 特性分支或 Worktree 推进。
- **禁止 Force Push**。
- **测试驱动开发（TDD）**：Bug 修复与核心逻辑优先编写测试。
- **独立 Code Review**：合并 PR 前必须通过代码审查。
- 更多细则详见 [AGENTS.md](file:///E:/Projects/T3-Codian/AGENTS.md) 与 [docs/WORKFLOW.md](file:///E:/Projects/T3-Codian/docs/WORKFLOW.md)。

---

## 7. 开源协议

本项目采用 [MIT License](LICENSE) 授权。
