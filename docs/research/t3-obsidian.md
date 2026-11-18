# t3-obsidian 技术调研报告

> **目标项目**：[7bgsbm749g-boop/t3-obsidian](https://github.com/7bgsbm749g-boop/t3-obsidian)  
> **调研基线 Commit**：`78ff6a29a2d925cf2f43023572c04a0eb1fe91c9` (`v0.0.455`)  
> **调研日期**：2026-11-18  
> **调研责任人**：T3-Codian 技术负责人

---

## 1. 整体架构

`t3-obsidian` 采用 **纯轻量级客户端（Pure Client）架构**。  
与 Claudian“在插件内直接起子进程”截然不同，`t3-obsidian` 明确将 Obsidian 定位为**纯前端视图与文件宿主**：
- **插件内部不包含、不启动、不管理 T3 Code 服务端进程**。
- 它通过标准网络通信（本地 Localhost、Tailscale HTTPS、SSH 隧道或 T3 Connect 云端中继），将 Obsidian 连接到外部正在运行的 T3 Code 实例。
- 支持桌面端与移动端双端运行（`isDesktopOnly: false`）。

```text
┌────────────────────────────────────────────────────────┐
│              Obsidian (Desktop or Mobile)              │
│  ┌───────────────────────┐  ┌───────────────────────┐  │
│  │   Sidebar Chat View   │  │  Note Stream & Inbox  │  │
│  │ (ItemView / SideChat) │  │  (Editor Markdown)    │  │
│  └───────────┬───────────┘  └───────────┬───────────┘  │
│              │                          │              │
│  ┌───────────▼──────────────────────────▼───────────┐  │
│  │           t3-obsidian Connection Layer           │  │
│  │  - `direct.ts` (OAuth Pairing / Environment API) │  │
│  │  - `t3-rpc.ts` (WebSocket JSON-RPC Client)       │  │
│  │  - `vault-connection.ts` (Virtual Vault Remote)  │  │
│  └──────────────────────────┬───────────────────────┘  │
└─────────────────────────────┼──────────────────────────┘
                              │ HTTP & WebSocket (DPoP Auth)
                              ▼
┌────────────────────────────────────────────────────────┐
│            Existing Running T3 Code Server             │
│        (Localhost / Remote VPS / Tailscale)            │
│  - Multi-Agent Orchestrator V2                         │
│  - Git Worktree, Checkpoint, Rollback                  │
│  - Codex & Antigravity Managed Providers               │
└────────────────────────────────────────────────────────┘
```

---

## 2. 技术栈

| 领域 | 选型与版本 | 源码依据 |
| :--- | :--- | :--- |
| **语言规范** | TypeScript 5.x，浏览器标准运行环境（`platform: 'browser'`） | [esbuild.config.mjs:30](file:///E:/Projects/T3-Codian/.research_repos/t3-obsidian/esbuild.config.mjs#L30) |
| **加密与签名** | `@noble/hashes` 1.8.x（轻量纯 JS 实现 sha256/sha1，替代 Node crypto） | [package.json:44](file:///E:/Projects/T3-Codian/.research_repos/t3-obsidian/package.json#L44) |
| **网络通信** | 原生 `fetch` 与标准 `WebSocket` | [src/connection/t3-rpc.ts](file:///E:/Projects/T3-Codian/.research_repos/t3-obsidian/src/connection/t3-rpc.ts) |
| **跨端兼容** | `isDesktopOnly: false`（严禁打包 native `child_process` / `net` / `fs`） | [esbuild.config.mjs:32-34](file:///E:/Projects/T3-Codian/.research_repos/t3-obsidian/esbuild.config.mjs#L32-L34) |
| **构建打包** | `esbuild` 0.25+ | [esbuild.config.mjs](file:///E:/Projects/T3-Codian/.research_repos/t3-obsidian/esbuild.config.mjs) |
| **Markdown** | `micromark` 4.x、`unified` 11.x、`remark-parse` | [package.json:46-51](file:///E:/Projects/T3-Codian/.research_repos/t3-obsidian/package.json#L46-L51) |

---

## 3. 核心模块分析

1. **`src/connection/`**（与 T3 Code 通信的黄金参考实现）：
   - `direct.ts`：负责环境发现 (`/.well-known/t3/environment`) 与 OAuth Token 交换配对。
   - `dpop.ts`：生成并维护非对称密钥对，为每次 HTTP/RPC 请求附加安全证明（DPoP Proof）。
   - `t3-rpc.ts`：实现基于 WebSocket 的单路与多路流式 RPC 调用，处理心跳与自动断线重连。
   - `vault-connection.ts`：将 T3 远程环境中的文件操作虚拟化为 `VaultRemote` 接口。
2. **`src/notes/`**：
   - 笔记流式写入（Note Streaming）：Agent 回答以实时动态块注入笔记正文，支持折叠查看思考与工具调用过程，完工后序列化为标准 Markdown。
   - `Smart Send`：智能去除重复前置笔记上下文，节省 Token 消耗。
3. **`src/ui/`**：
   - 侧边栏对话面板（`ItemView`），支持常规会话、临时侧聊（Side Chat）与子 Agent 状态透视。
   - 文件树拦截视图（Note Inbox）：在 Obsidian 左侧导航栏增加“工作状态筛选”（Working, Snoozed, Settled）。

---

## 4. Agent 通信方式

完全基于 T3 Code 的 **Orchestrator V2 协议**：
1. **握手与发现**：
   - 访问 `GET <url>/.well-known/t3/environment`，校验 `orchestrationProtocolVersion === 2`。
2. **配对与授权**：
   - 使用一次性配对链接（含凭据代码）向 `<url>/oauth/token` 发起 POST 请求，通过 DPoP 绑定令牌交换获得 `access_token`。
3. **流式分发与控制**：
   - 建立 WebSocket 长连接，调用 `projects.listEntries`、`projects.readFile` 同步笔记内容。
   - 监听服务端下发的 `turn/start`、`item/append`、`tool/call` 事件并实时渲染。

---

## 5. 会话管理机制

- **与笔记绑定**：会话可以直接与单篇 Markdown 笔记建立“从属绑定”，会话进度与回答保存在笔记元数据中。
- **Side Chat（临时侧聊）**：用户可在笔记边上拉出临时会话探讨分支问题，探讨完成后一键“Bring back”将结论合并回主会话。
- **状态看板机制**：在侧边栏按 `Working`（进行中）、`Snoozed`（休眠）、`Settled`（已完成）三级管理所有涉及 Agent 的笔记。

---

## 6. 认证方式

- **委托认证（Delegated Auth）**：插件本身**不接触任何 LLM API Key 或 ChatGPT 密码**。
- 所有的模型鉴权与计费直接由外部的 T3 Code 服务器承担，插件端仅存储与 T3 Code 服务器配对的短期 OAuth Bearer Token。

---

## 7. Obsidian API 使用方式

- **编辑器深度集成**：不仅使用 `ItemView` 侧边栏，更通过扩展 CodeMirror 6 StateField 将 Agent 响应直接无缝嵌入笔记阅读/编辑模式中。
- **文件树交互**：巧妙借用 Obsidian 官方文件管理器结构，通过样式与过滤器呈现 Agent Inbox。

---

## 8. Skills / MCP 相关能力

- **透传机制**：自身不解析 MCP 配置，而是通过 RPC 询问 T3 Code 当前环境支持的所有 MCP 工具、Skills 与 Slash Commands。
- **人机交互卡片**：当 T3 Code 遇到高危工具调用或需要参数确认时，向插件推送结构化表单，插件以弹窗/行内组件呈现并回传确认。

---

## 9. 已有测试体系

- **仿真实验台（Simulation Labs）**：
  - 位于 `tests/simulation/`，包含多达数十个细致场景脚本（如 `conflict-recovery-lab.ts`、`autosave-recovery-lab.ts`、`stream-stop-lab.ts`）。
  - 通过 Python 脚本 `scripts/change_checks.py` 驱动自动化回归测试。

---

## 10. 可以复用的模块与设计

1. **`src/connection/` 目录全套通信基础设施**：这是目前业界对 T3 Code Orchestration V2 协议最成熟、最完备的开源 TypeScript 客户端实现。包含 Token 交换、DPoP 签名生成、WebSocket RPC 与流式解析器。
2. **Note Inbox 交互设计**：将“待办任务”与“Agent 执行中笔记”相结合的看板式体验。
3. **纯浏览器级构建模式**：杜绝 Node.js 私有依赖，让插件具备未来无缝支持移动端的可能。

---

## 11. 存在的限制

1. **强依赖外部 T3 Code 实例**：用户必须在本地或远端预先安装并启动 T3 Code；如果 T3 Code 没开，插件无法单飞使用。
2. **连接配置门槛**：用户首次使用需执行配对（Copy-paste pairing code），对纯新手用户有一定引导成本。

---

## 12. License 与复用约束

- **许可证**：**MIT License**（Copyright (c) 2026 jslepx, 7bgsbm749g-boop）。
- **约束要求**：完全开源，允许代码引用和协议实现，仅需保留版权归属。
