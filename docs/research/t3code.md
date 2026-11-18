# T3 Code 技术调研报告

> **目标项目**：[pingdotgg/t3code](https://github.com/pingdotgg/t3code)  
> **调研基线 Commit**：`70e4319da82f75240cba6b47956e77b5bde611ee`  
> **调研日期**：2026-11-18  
> **调研责任人**：T3-Codian 技术负责人

---

## 1. 整体架构

T3 Code 是一套工业级的**多智能体分布式编排系统与开发平台**。采用 pnpm workspace 单体大仓（Monorepo）架构，核心分为：
- **`apps/server`**：基于 **Effect-TS** 深度构建的后端中枢服务，负责进程管理、Git Worktree 隔离、MCP 工具网桥、多 Provider 适配与会话持久化。
- **`apps/desktop`**：基于 Electron 的跨平台桌面外壳，内嵌并拉起 Server 与 Web 前端。
- **`apps/web`**：基于 React 与 Tailwind 的交互控制台。
- **`packages/*`**：高度解耦的领域契约包（如 `contracts`、`effect-codex-app-server`、`provider-acp`）。

```text
┌────────────────────────────────────────────────────────┐
│                   T3 Code Client Tier                  │
│  ┌───────────────────────┐  ┌───────────────────────┐  │
│  │    Web / Desktop UI   │  │ External Client (e.g. │  │
│  │      (React SPA)      │  │     t3-obsidian)      │  │
│  └───────────┬───────────┘  └───────────┬───────────┘  │
└──────────────┼──────────────────────────┼──────────────┘
               │ HTTP / WebSocket         │ HTTP / WebSocket
┌──────────────▼──────────────────────────▼──────────────┐
│          T3 Code Server (`apps/server/src`)            │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Orchestrator V2 (Thread, Turn, Checkpoint, Sink) │  │
│  │ - State machine driven by Effect-TS              │  │
│  └───────────┬──────────────────────────┬───────────┘  │
│              │                          │              │
│  ┌───────────▼───────────┐  ┌───────────▼───────────┐  │
│  │ CodexDriver & Adapter │  │ ACP Driver & Adapter  │  │
│  │ - Shadow CODEX_HOME   │  │ - Stdio / JSON-RPC    │  │
│  │ - ChatGptAuth Loopback│  │ - mcpOverAcpBridge    │  │
│  └───────────┬───────────┘  └───────────┬───────────┘  │
└──────────────┼──────────────────────────┼──────────────┘
               │ IPC / Stdio              │ Stdio / ACP
┌──────────────▼───────────┐  ┌───────────▼───────────┐
│     Codex App Server     │  │  Antigravity CLI Daemon│
│  (app-server-control.sock│  │      (`agy acp`)      │
└──────────────────────────┘  └───────────────────────┘
```

---

## 2. 技术栈

| 领域 | 选型与版本 | 源码依据 |
| :--- | :--- | :--- |
| **语言与框架** | TypeScript 5.x，**Effect-TS** 体系（`effect`, `@effect/schema`） | [package.json](file:///E:/Projects/T3-Codian/.research_repos/t3code/package.json#L75-L82) |
| **工作区架构** | pnpm workspaces（含 apps, packages） | [pnpm-workspace.yaml](file:///E:/Projects/T3-Codian/.research_repos/t3code/pnpm-workspace.yaml) |
| **通信协议** | JSON-RPC 2.0、WebSocket（`ws.ts`）、SSE / HTTP Chunked | [apps/server/src/ws.ts](file:///E:/Projects/T3-Codian/.research_repos/t3code/apps/server/src/ws.ts) |
| **持久化存储** | SQLite（轻量关系存储与迁移脚本） | [apps/server/src/persistence/](file:///E:/Projects/T3-Codian/.research_repos/t3code/apps/server/src/persistence/) |
| **版本隔离** | Git Worktrees 原生调度与分支状态机 | [apps/server/src/orchestration-v2/WorktreeBranchSync.ts](file:///E:/Projects/T3-Codian/.research_repos/t3code/apps/server/src/orchestration-v2/WorktreeBranchSync.ts) |

---

## 3. 核心模块分析

1. **`apps/server/src/orchestration-v2/`**（核心调度中枢）：
   - `ThreadLaunchService.ts`：负责会话启动、多智能体委派（`delegate_task`）、Worktree 分支自动隔离。
   - `Adapters/CodexAdapterV2.ts`（长达 380KB）：处理 T3 Code 事件与 Codex App Server 规范化双向转换。
   - `CheckpointService.ts`：支持在任务执行前后创建代码快照并支持无损回滚（Rollback）。
2. **`packages/effect-codex-app-server/`**：
   - `client.ts`：基于 Effect-TS 规范化封装的 Codex App Server 客户端。
   - `protocol.ts`：定义了与 Codex 进行握手、通知和请求的 Schema 类型。
3. **`apps/server/src/provider/`**：
   - `Drivers/CodexDriver.ts`：检测本地已安装的 Codex，管理影子目录与运行时。
   - `CodexChatGptAuth.ts`：专门处理 ChatGPT 账号授权的完整 OAuth Loopback 回调。

---

## 4. Agent 通信方式

T3 Code 内部通过标准化 **Orchestration Protocol V2** 暴露服务（支持双向流式传输）：
- **元数据发现**：客户端通过 `GET /.well-known/t3/environment` 获取服务器 `environmentId` 与协议版本 (`orchestrationProtocolVersion: 2`)。
- **指令分发 (Dispatch)**：通过 `POST /api/orchestration/dispatch` 提交线程创建、启停、回滚等指令。
- **实时事件流 (WebSocket)**：
  - 路径：`ws://<host>:<port>/api/orchestration/v2`
  - 核心事件帧：
    - `turn/start`：启动一轮执行；
    - `item/append`：实时文本/思考/代码增量 Token 分发；
    - `tool/call` 与 `tool/result`：工具执行生命周期；
    - `approval/request`：高危操作向客户端请求人机审批；
    - `turn/completed`：轮次结束与状态收敛。

---

## 5. 会话管理机制

- **全局线程模型（Thread）**：所有对话、Agent 协同均以 `threadId` 为核心单元持久化至 SQLite。
- **子 Agent 派发（Delegate Task）**：
  - 支持 `isolation: 'shared'`（共享父目录）与 `isolation: 'worktree'`（独立 Git 工作树隔离检出）。
- **影子目录机制（Shadow CODEX_HOME）**：
  - 参考 [CodexHomeLayout.ts](file:///E:/Projects/T3-Codian/.research_repos/t3code/apps/server/src/provider/Drivers/CodexHomeLayout.ts)，通过为每个环境物化独立的影子目录，隔离环境变量、插件与会话缓存，防止并发污染。

---

## 6. 认证方式

1. **ChatGPT 账号授权对接**：
   - [CodexChatGptAuth.ts:40-100](file:///E:/Projects/T3-Codian/.research_repos/t3code/apps/server/src/provider/CodexChatGptAuth.ts#L40-L100) 实现了完整的 OAuth 2.0 PKCE 流程与本地回调服务器（`http://127.0.0.1:<port>/auth/callback`）。
   - 自动获取并刷新带 DPoP 签名的短期 Access Token，并无缝写入 Codex 配置。
2. **客户端配对连接（T3 Pairing）**：
   - 外部客户端通过一键配对链接（含一次性 Token）访问 `/oauth/token`，通过 Token Exchange 换取高时效性 Bearer 访问令牌。

---

## 7. Obsidian API 使用方式

- **本项目自身未引入 Obsidian API**。
- 但其服务层设计了极具通用性的文件投影 API（如 `projects.readFile`、`projects.writeFile`、`filesystem.browse`），正是为了被外部编辑器（如 Obsidian、VS Code 扩展）作为无头后端安全挂载。

---

## 8. Skills / MCP 相关能力

- **MCP 深度支持**：
  - 支持 stdio 与 streamable_http 模式的 MCP 插件；
  - 具备 `mcpOverAcpBridge.ts`，可将标准 MCP 工具无缝转接给支持 ACP 协议的 Agent（如 Antigravity）。
- **动态表单与确认（Elicitation）**：
  - `CodexMcpElicitation.ts`：将 MCP 工具的入参表单化，支持向前端动态请求用户输入。

---

## 9. 已有测试体系

- **单测与集成测试**：基于 `vitest` 与 Effect-TS 官方测试套件。
- **重放测试（Replay Testkit）**：
  - 拥有极其先进的真实 Agent 录像重放机制（[testkit/fixtures/](file:///E:/Projects/T3-Codian/.research_repos/t3code/apps/server/src/orchestration-v2/testkit/fixtures/)）。
  - 将真实模型运行时的 NDJSON 报文固化为 Fixture，能在断网无真实 API Key 情况下进行 100% 确定性的端到端逻辑回归。

---

## 10. 可以复用的模块与设计

1. **`packages/contracts`**：完整的 TypeScript 类型定义与 JSON-Schema，直接定义了所有会话操作的数据结构。
2. **Orchestrator V2 交互时序契约**：定义了人机审批、多轮对话、子 Agent 协同的工业级流转标准。
3. **影子 CODEX_HOME 目录隔离逻辑**：杜绝多任务并发下的环境锁冲突。

---

## 11. 存在的限制

1. **系统复杂度高**：严重依赖 Effect-TS 函数式响应式编程范式，学习与二开修改门槛陡峭。
2. **体积与资源消耗大**：作为一个完整的多智能体服务器，后台需要维持 Node.js 运行时及多个后台服务，不适合直接打包进 Obsidian 纯前端插件内部。

---

## 12. License 与复用约束

- **许可证**：**MIT License**（Copyright (c) 2026 T3 Tools Inc.）。
- **约束要求**：完全开源，允许代码引用和协议实现，仅需保留版权归属。
