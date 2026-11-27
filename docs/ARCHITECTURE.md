# Obsidian T3 Code 系统架构设计说明书

> **系统名称**：Obsidian T3 Code
> **文档版本**：v1.0.0 (MVP 阶段定稿)  
> **状态**：架构定稿 (Approved Architecture)  
> **日期**：2026-11-18  
> **责任人**：Obsidian T3 Code 技术负责人

---

## 1. 架构定位与设计哲学

Obsidian T3 Code 是连接 **Obsidian 本地双链知识库** 与 **T3 Code 分布式智能体编排引擎** 的专属桥梁。

### 核心设计原则：
1. **轻量客户端，后端重计算 (Lightweight Client, Heavy Server)**：
   - 彻底摒弃在插件内启动重量级子进程（Child Process）的方案，坚决不重写 Agent 状态机与工具执行器。
   - 插件作为一个轻量的高性能网络客户端，通过标准 HTTP 与 WebSocket 协议连接本地已运行的 T3 Code 实例。
2. **零破坏与 Vault 安全第一 (Zero-Disruption & Vault Safety)**：
   - 严格落实非接触式上下文提取（只读探测），禁止 Agent 在后台自动篡改 Markdown 笔记。
   - 所有回写操作必须经过用户显式触发（“插入当前光标处”），且完全进入 Obsidian 原生撤销栈（Ctrl+Z 可一键撤回）。
3. **原生体验与极致性能 (Obsidian-Native & Zero Bloat)**：
   - 采用 Obsidian 原生 DOM API 与隔离的 Markdown 渲染 构建侧边栏面板，零第三方重型 UI 框架依赖，打包体积 `< 200KB`，样式 100% 自动适配用户当前主题。
4. **协议驱动与版本解耦 (Protocol-Driven)**：
   - 基于成熟的 **T3 Orchestrator V2 协议**（`T3_PROTOCOL_VERSION = 2`），实现请求、流式事件分发与错误恢复的标准化。

---

## 2. 系统整体分层架构

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Obsidian 表现层 (Presentation Layer)            │
│  ┌───────────────────────┐  ┌───────────────────┐  ┌────────────────┐  │
│  │    ObsidianT3CodeView       │  │  EditorContext    │  │ SettingTab     │  │
│  │  (Sidebar Chat Panel) │  │  Bridge (Active/  │  │ (Server URL &  │  │
│  │  - Header & Status    │  │   Selection)      │  │  Connection)   │  │
│  │  - Message Stream     │  │                   │  │                │  │
│  │  - Composer & Actions │  │                   │  │                │  │
│  └───────────┬───────────┘  └─────────┬─────────┘  └───────┬────────┘  │
└──────────────┼────────────────────────┼────────────────────┼───────────┘
               │                        │                    │
┌──────────────▼────────────────────────▼────────────────────▼───────────┐
│                    插件业务与状态层 (Core & State Layer)               │
│  ┌────────────────────────┐  ┌───────────────────┐  ┌────────────────┐  │
│  │    SessionController   │  │ ContextInjection  │  │ Settings &     │  │
│  │    - Thread & Turn FSM │  │ Service           │  │ Storage Store  │  │
│  └───────────┬────────────┘  └─────────┬─────────┘  └───────┬────────┘  │
└──────────────┼─────────────────────────┼────────────────────┼───────────┘
               │                         │                    │
┌──────────────▼─────────────────────────▼────────────────────▼───────────┐
│                    T3 Code 通信与协议层 (Connection & Protocol)         │
│  ┌────────────────────────┐  ┌───────────────────┐  ┌────────────────┐  │
│  │  T3ConnectionManager   │  │ T3WebSocketClient │  │ DPoPToken      │  │
│  │  - FSM State Machine   │  │ - JSON-RPC 2.0    │  │ Broker         │  │
│  │  - Auto-reconnect      │  │ - Stream Decoder  │  │ (@noble/hashes)│  │
│  └────────────────────────┴──────────┬───────────┴───────────────────┘  │
└──────────────────────────────────────┼──────────────────────────────────┘
                                       │ HTTP REST & WebSocket
┌──────────────────────────────────────▼──────────────────────────────────┐
│                   本地 T3 Code 服务端 (http://127.0.0.1:3425)            │
│  ┌────────────────────────┐  ┌───────────────────┐  ┌────────────────┐  │
│  │ Multi-Agent Swarm      │  │ ChatGPT-Auth      │  │ Git Worktree   │  │
│  │ (Codex, Antigravity)   │  │ Codex Runtime     │  │ & Checkpoints  │  │
│  └────────────────────────┘  └───────────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心子系统架构设计

### 3.1 Obsidian 插件表现层 (`src/ui/`)
1. **`ObsidianT3CodePlugin`**：
   - 继承自 Obsidian `Plugin` 基类，管理插件生命周期：
     - `onload()`：初始化配置、注册命令、添加侧边栏图标、注册 `ObsidianT3CodeView` 视图、启动后台连接健康探测。
     - `onunload()`：断开 WebSocket 连接，释放定时器，清理事件监听，保证**零进程与句柄残留**。
2. **`ObsidianT3CodeView`**：
   - 继承自 `ItemView`（ViewType: `obsidian-t3-code-chat-view`），挂载在右侧边栏。
   - 内部由三部分组成：
     - **Header**：展示 T3 Code 连接状态绿灯/红灯、当前模型指示器（Codex）、一键新建会话按钮；
     - **Message Container**：气泡式展示用户与 Agent 对话，集成思考过程展开/折叠、Markdown 代码高亮；
     - **Composer**：Prompt 输入框、选区附件开关、发送/停止生成控制。
3. **`EditorContextBridge`**：
   - 安全读取 `app.workspace.getActiveViewOfType(MarkdownView)`：
     - 提取当前文件名称、路径与前言；
     - 提取用户选中的文本片段（`editor.getSelection()`）；
     - 将上下文格式化为 Markdown 引用块追加在用户 Prompt 前端。

---

### 3.2 T3 Code 连接与通信层 (`src/connection/`)
1. **`T3ConnectionManager` 连接状态机**：
   ```text
   [DISCONNECTED] ──(探测成功)──► [CONNECTING] ──(WS握手)──► [CONNECTED]
         ▲                              │                          │
         │ (探测失败/服务未开启)        │ (连接出错)               │ (连接中断)
         └── [PROBING / IDLE] ◄─────────┴──────────────────────────┘
                     │ (退避重试: 1s, 2s, 4s...)
                     ▼
             [RECONNECTING]
   ```
2. **协议端点契约**：
   - **握手探测**：`GET /.well-known/t3/environment`
     - 校验返回值中 `orchestrationProtocolVersion === 2`。
   - **配对认证**：向 `POST /oauth/token` 提交一次性配对码，仅请求 `orchestration:read` 与 `orchestration:operate`。凭据只保存在内存中。
   - **实时数据流**：通过 `POST /api/auth/websocket-ticket` 取得一次性票据，建立 `/ws` 连接。使用 Effect RPC 的 `orchestration.dispatchCommand` 和 `orchestration.subscribeThread`，并通过 Ping/Pong 检测断线。
---

### 3.3 会话与运行控制层 (`src/session/`)
1. **`SessionController`**：
   - 维护当前活跃的 `activeThreadId`。
   - 调用 T3 Code 的 `thread.create` 创建会话，或复用已有会话。
   - 提供 `resetSession()` 一键清空上下文并开辟新 Thread。
2. **`TurnController`**：
   - 跟踪单次回答的生命周期：
     - 发送 Prompt 时创建临时的 Assistant 消息占位符；
     - 接收增量 Token 时，通过节流函数（`requestAnimationFrame`）更新 UI；
     - 点击“停止”时，向服务端派发 `run.interrupt`。

---

### 3.4 安全沙箱与 Vault 保护体系 (`src/security/`)
- **只读探测原则**：除 Obsidian 官方公开只读 API（`editor.getSelection`、`file.vault.read`）外，插件不直接扫描或写入未受保护的文件。
- **用户显式操作写入**：
  - 点击“插入当前光标处”：调用 `editor.replaceRange(content, cursor)`，该操作完全在 Obsidian 编辑器事务内完成，直接纳入本地撤销树（Ctrl+Z）。
- **本地回环网络锁定**：
  - 默认仅允许连接 `127.0.0.1` 与 `localhost`，禁止向非受信的远程公网端点推送笔记上下文。

---

## 4. 技术选型判定表

| 核心问题 | 最终选型 | 理由与依据 |
| :--- | :--- | :--- |
| **编程语言** | TypeScript 5.x (`strict: true`) | 与 Obsidian API 深度契合，配合 `@effect/schema` 类型契约。 |
| **UI 渲染框架** | 原生 DOM API 与隔离的 Markdown 渲染 | 零 React 开销，打包体积极小（`<200KB`），无缝适配主题 CSS 变量。 |
| **通信机制** | 原生 `fetch` + 原生 `WebSocket` | 纯 Web 标准，跨平台高度一致，无任何 Node 平台原生绑定。 |
| **配对** | 本地回环服务的 OAuth token exchange | 仅使用一次性配对码和内存会话。 |
| **构建体系** | `esbuild` | 毫秒级打包，构建产物仅为单个 `main.js`。 |
| **测试套件** | `vitest` | 支持快速单元测试、模拟 WebSocket 服务端测试与 Obsidian 内存 Mock。 |

---

## 5. 核心接口与数据结构设计

### 5.1 基础数据结构
```typescript
/** 连接状态枚举 */
export enum ConnectionStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Error = 'error',
}

/** 插件持久化配置 */
export interface T3CodianSettings {
  serverUrl: string;          // 默认: "http://127.0.0.1:3425"
  autoAttachContext: boolean; // 默认: true (自动包含活动笔记/选区)
  maxContextLength: number;   // 默认: 8000
  defaultProvider: string;    // 默认: "codex"
  defaultModel: string;       // 默认: ""
}

/** 消息气泡结构 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thought?: string;           // 思考链路文本
  createdAt: number;
  isStreaming?: boolean;
}

/** T3 Code 环境描述符 */
export interface T3EnvironmentDescriptor {
  environmentId: string;
  label: string;
  orchestrationProtocolVersion: number;
}
```

### 5.2 核心服务接口契约
```typescript
/** T3 Code 传输连接服务 */
export interface IT3ConnectionService {
  readonly status: ConnectionStatus;
  connect(): Promise<void>;
  disconnect(): void;
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void;
}

/** 会话调度服务 */
export interface ISessionService {
  readonly currentThreadId: string | null;
  readonly isRunning: boolean;
  startNewThread(): Promise<string>;
  sendPrompt(prompt: string, context?: string): Promise<void>;
  stopCurrentTurn(): Promise<void>;
  onMessageUpdate(handler: (message: ChatMessage) => void): () => void;
}
```

---

## 6. 异常与错误恢复矩阵

| 异常类型 | 触发场景 | 表现与用户反馈 | 系统恢复动作 |
| :--- | :--- | :--- | :--- |
| **`ServerOfflineError`** | T3 Code 桌面端未运行，端口拒绝连接 | 侧边栏展示醒目橙色卡片：“T3 Code 服务未开启” | 进入低频探测模式（每 5s 探测一次），恢复后自动重连。 |
| **`ProtocolMismatchError`**| 服务端协议版本不为 2 | 提示“请升级 T3 Code 桌面端到最新版本” | 停止握手尝试，阻断消息发送，避免脏数据写入。 |
| **`TurnInterruptedError`** | 用户点击“停止生成”或关闭 Obsidian | 消息气泡标记“生成已取消”，保留已生成的片段 | 向服务端发送取消信号，安全关闭当前流监听。 |
| **`VaultAccessError`** | 当前未打开任何笔记却尝试插入 | 弹窗提示“请先在编辑器中打开一篇笔记” | 拦截插入动作，保护剪贴板内容。 |

## MVP 实施协议说明

桌面插件以实际验证的 T3 Orchestrator v2 服务契约为准。客户端发现服务后，通过 `/oauth/token` 交换一次性配对码，仅申请编排读取和操作权限，再通过 `/api/auth/websocket-ticket` 取得一次性连接票据。实时通信使用 `/ws` 上的 Effect RPC，通过 `orchestration.dispatchCommand` 创建线程和派发消息，通过 `orchestration.subscribeThread` 应用快照和增量事件。文中的接口命名与时序图用于说明设计，具体请求与模块见 `src/t3/`。

已完成的模型回复通过不调用 Vault 处理器的 Markdown 渲染器展示。代码围栏只用于显示和语法高亮，HTML 与图片嵌入保持静态。复制和显式插入仍使用原始 Markdown。

## CLI 迁移

`feat/6-sidebar-layout` 的桌面侧栏执行 [ADR 0002](adr/0002-t3-cli-backend.md)。本文件中的 WebSocket、配对和流式投影设计描述 PR #13 基线。
