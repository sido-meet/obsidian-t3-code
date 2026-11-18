# Claudian 技术调研报告

> **目标项目**：[YishenTu/claudian](https://github.com/YishenTu/claudian)  
> **调研基线 Commit**：`1358534a5abac3df6315014032c2edf03339b493` (`v2.3.44`)  
> **调研日期**：2026-11-18  
> **调研责任人**：T3-Codian 技术负责人

---

## 1. 整体架构

Claudian 采用 **Obsidian 进程内（In-Process）多 Agent 编排宿主** 架构。它将 Obsidian 视为 Agent 的运行沙箱与主工作空间（Vault即工作目录），直接在 Obsidian 的 Electron 渲染/Node 宿主进程中通过子进程（`child_process`）拉起各 AI 编程 Agent 的 CLI 守护进程，并在插件内部自行实现会话状态机、消息分发与双栏/单栏渲染视图。

```text
┌────────────────────────────────────────────────────────┐
│               Obsidian Desktop (Electron)              │
│  ┌───────────────────────┐  ┌───────────────────────┐  │
│  │   ClaudianChatView    │  │  Editor Context &     │  │
│  │  (Dual-Pane / Zen)    │  │  Inline Diff Decorator │  │
│  └───────────┬───────────┘  └───────────┬───────────┘  │
│              │                          │              │
│  ┌───────────▼──────────────────────────▼───────────┐  │
│  │     Claudian Core Orchestrator (TypeScript)      │  │
│  │  - ManagedStdioProcess & Session State Machine   │  │
│  │  - Tool Interceptor & Vault Permission System    │  │
│  └───────────────────────┬──────────────────────────┘  │
│                          │                             │
│       ┌──────────────────┼──────────────────┐          │
│       ▼                  ▼                  ▼          │
│  ┌──────────┐      ┌───────────┐      ┌───────────┐    │
│  │ Codex    │      │ Antigra-  │      │ Claude /  │    │
│  │ Provider │      │ vity ACP  │      │ DeepSeek  │    │
│  └────┬─────┘      └─────┬─────┘      └─────┬─────┘    │
└───────┼──────────────────┼──────────────────┼──────────┘
        │ stdio / JSON-RPC │ stdio / JSON-RPC │
┌───────▼──────────────────▼──────────────────▼──────────┐
│              Local CLI Daemon Subprocesses             │
│  - codex app-server --listen stdio://                  │
│  - agy acp (Antigravity Agent Client Protocol)         │
│  - claude (Claude Agent SDK / CLI)                     │
└────────────────────────────────────────────────────────┘
```

---

## 2. 技术栈

| 领域 | 选型与版本 | 源码依据 |
| :--- | :--- | :--- |
| **语言与运行时** | TypeScript 5.x，Node.js 22.x（Electron 内部） | [package.json](file:///E:/Projects/T3-Codian/.research_repos/claudian/package.json#L47-L50) |
| **宿主框架** | Obsidian API (`obsidian: latest`)，`isDesktopOnly: true` | [manifest.json](file:///E:/Projects/T3-Codian/.research_repos/claudian/manifest.json#L9) |
| **编辑器内核** | `@codemirror/view`, `@codemirror/state` 6.x | [package.json](file:///E:/Projects/T3-Codian/.research_repos/claudian/package.json#L32-L40) |
| **构建与打包** | `esbuild` 0.25+，CJS 模块格式，Tree-shaking 强化 | [esbuild.config.mjs](file:///E:/Projects/T3-Codian/.research_repos/claudian/esbuild.config.mjs#L182-L213) |
| **测试框架** | `vitest` 3.x，配置自定义 DOM 与 WSL 模拟夹具 | [vitest.config.mts](file:///E:/Projects/T3-Codian/.research_repos/claudian/vitest.config.mts) |
| **进程与 IPC** | Node 原生 `node:child_process` + `node:stream` | [src/core/process/ManagedStdioProcess.ts](file:///E:/Projects/T3-Codian/.research_repos/claudian/src/core/process/ManagedStdioProcess.ts) |

---

## 3. 核心模块分析

Claudian 代码库组织非常严密，核心代码位于 `src/`：

1. **`src/core/process/`**：
   - `ManagedStdioProcess.ts`：封装跨平台（含 Windows / WSL）的子进程生命周期，包含标准输入输出流缓冲（8KB 限制）、退出监听与优雅关机（Shutdown）。
   - `execution-target/`：实现宿主系统（Windows 原生 vs WSL Linux 发行版）之间的路径与环境变量自动映射。
2. **`src/providers/`**：多 Agent 适配核心：
   - `acp/`：通用的 Agent Client Protocol (JSON-RPC 2.0 over stdio) 客户端实现，包含连接管理、事件规范化（Normalizer）与权限转接。
   - `codex/`：Codex 专属提供商，包含 `CodexAppServerRuntime.ts`、`CodexAppServerProcess.ts` 与 `CodexRPCTransport.ts`。
   - `antigravity/`：Google Antigravity CLI 驱动，通过 `agy acp` 对接。
3. **`src/features/`**：
   - `chat/`：侧边栏与独立标签页对话 UI（支持单栏/双栏 Dual-pane、Zen 极简模式）。
   - `inline-edit/`：文档内选区原位修改，集成行级/词级 Diff 预览与批准采纳。
   - `projects/`：跨会话协作与共享项目记忆（`project.md`）。

---

## 4. Agent 通信方式

- **通信管道**：标准输入输出（Stdio）与 JSON-RPC 2.0。
- **针对 Codex**：
  - 启动命令：`codex app-server --listen stdio://`（参考 [CodexLaunchSpecBuilder.ts:23](file:///E:/Projects/T3-Codian/.research_repos/claudian/src/providers/codex/runtime/CodexLaunchSpecBuilder.ts#L23)）。
  - 握手协议：通过 `initialize` 请求交换客户端信息 (`name: 'claudian'`)，等待服务器 `initialized` 回应后就绪（参考 [codexAppServerSupport.ts:72-82](file:///E:/Projects/T3-Codian/.research_repos/claudian/src/providers/codex/runtime/codexAppServerSupport.ts#L72-L82)）。
- **针对 Antigravity / ACP**：
  - 启动命令：`agy acp`。
  - 协议规范：遵循开源 Agent Client Protocol，请求方法如 `session/prompt`、通知方法如 `session/update`，支持实时 Token 增量流式分发。

---

## 5. 会话管理机制

- **会话持久化**：会话历史及元数据存储在 Vault 本地 `.obsidian/plugins/realclaudian/data.json` 或 IndexedDB。
- **线程路由**：
  - 在 Codex 模块中，通过 `CodexThreadRouter.ts` 与 `CodexThreadScope.ts` 将 Obsidian 标签页/会话绑定到 Codex 的 `threadId`。
  - 支持恢复历史会话（Resume）与 Fork 会话。
- **跨会话协同**：支持 Cross-Session Messaging，允许一个 Agent 通过内部会话协议向另一个 Agent 所在会话发送 steer 指令或读取最新回答。

---

## 6. 认证方式

- **零 Token 侵入机制**：Claudian 本身**不保存、不请求、不转发用户的 API Key 或账号密码**。
- **机制原理**：
  - Codex：直接复用本地已经通过 `codex login` 完成的授权（无论是 ChatGPT 网页授权的 OAuth Token，还是 API Key）。因为子进程以当前系统用户身份执行 `codex app-server`，Codex 自身会自动读取 `~/.codex/auth.json`。
  - Antigravity：自动读取 `~/.gemini/` 与系统 Keychain。
  - Claude：读取本地 `~/.claude.json` 授权状态。

---

## 7. Obsidian API 使用方式

- **视图挂载**：扩展 `ItemView`（`CLAUDIAN_VIEW_TYPE`），注册到侧边栏与主工作区（`registerView`）。
- **上下文提取**：
  - 监听 `workspace.on('active-leaf-change')` 获取当前正在编辑的 Markdown 笔记。
  - 通过 `editor.getSelection()` 捕获用户高亮片段，结合 `editor.getCursor()` 注入行号坐标。
- **Diff 与文件操作**：
  - 尽量调用 Obsidian 的 `Vault.modify()` 与 `Vault.read()`，确保修改能触发 Obsidian 的文件变动历史。
  - 采用 CodeMirror 6 State Field 与 Decoration 实现行内无缝差异比对。

---

## 8. Skills / MCP 相关能力

- **Skills 发现**：通过 `skills/changed` 通知与 `plugin/reconcile` 请求（参考 [CodexAppServerRuntime.ts:51,79](file:///E:/Projects/T3-Codian/.research_repos/claudian/src/providers/codex/runtime/CodexAppServerRuntime.ts#L51-L79)），动态发现 `~/.codex/skills/` 下的可用技能。
- **MCP 支持**：支持各 Agent 已经配置的外部 MCP 服务器，并在前端提供工具执行参数卡片和授权确认。

---

## 9. 已有测试体系

- **测试框架**：`vitest` 强类型测试套件。
- **深度 Mock 机制**：
  - [tests/__mocks__/obsidian.ts](file:///E:/Projects/T3-Codian/.research_repos/claudian/tests/__mocks__/obsidian.ts)（长达 35KB，完整模拟了 Obsidian App、Vault、Workspace、ItemView、Notice）。
  - [tests/__mocks__/claude-agent-sdk.ts](file:///E:/Projects/T3-Codian/.research_repos/claudian/tests/__mocks__/claude-agent-sdk.ts)（模拟 Agent SDK 通信流）。
- **平台模拟**：提供 `WindowsHostFS.ts` 与 `WSLProcessFixture.ts`，在 CI 环境下模拟 Windows 路径与 WSL Linux 容器环境。

---

## 10. 可以复用的模块与设计

1. **`tests/__mocks__/obsidian.ts`**：业内最完备的 Obsidian Headless 测试 Mock 夹具，可直接引入 T3-Codian 的 Vitest 单元测试体系。
2. **`ManagedStdioProcess.ts`**：稳健的 Windows/Linux 子进程生命周期守护封装（防僵尸进程、错误缓冲与编码兼容）。
3. **`CodexLaunchSpecBuilder.ts`**：精简的 `codex app-server` 启动参数与环境变量组装逻辑。
4. **CodeMirror 6 Inline Diff 渲染器**：直接在笔记内进行词级差异高亮与快捷接受/拒绝的交互模式。

---

## 11. 存在的限制

1. **桌面平台限定**：由于大量使用 Node.js 原生 `child_process` 和文件系统调用，**完全无法在 iOS / Android 移动端运行**（`manifest.json` 显式声明 `isDesktopOnly: true`）。
2. **进程管理开销**：当用户同时打开多个 Provider 会话时，本地可能同时常驻多个庞大的 CLI 守护子进程，占用较多内存。
3. **依赖本地 CLI 安装**：若用户未在系统 PATH 中正确安装配置 `codex` 或 `agy`，插件会直接报错中断。

---

## 12. License 与复用约束

- **许可证**：**MIT License**（Copyright (c) 2025 Yishen Tu）。
- **约束要求**：允许商业与非商业复用、修改与再分发，唯一要求在衍生代码中保留原始版权声明与 MIT License 全文。
