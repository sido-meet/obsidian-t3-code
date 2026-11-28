# ADR-0003: RPC First + CLI Fallback 混合后端架构与统一状态层设计

## 状态 (Status)
**Accepted**（用户已确认采用 ADR-0003 架构：M0 迁移至原生 `MarkdownRenderer.render()` 保留 200 KiB 打包约束；默认桌面端通过自动发现 T3 CLI 签发受限短期 Session，保留手动配对备选；按 M0 → M6 计划推进实施）

## 日期
2026-11-28

---

## 背景与上下文 (Context)

T3-Codian V2 侧栏已完成 Obsidian 原生双形态界面（`< 300px` 紧凑 / `300–599px` 单栏多标签 / `>= 600px` 持久双栏）、三列 `Agent · 模型 · 思考度` 弹层、240° SVG 用量仪表与只读权限说明，但在实际接入本机 T3 Code 时仍受限于 [ADR-0002](0002-t3-cli-backend.md) 的纯 CLI 包装模式（仅调用 `t3 thread list/start/send/show`）：

1. **模型选择器无法自动发现本机多 Agent 与全部模型**：公开 `t3` CLI 没有查询 Provider/Model 目录的子命令，只能读取插件设置中的单默认项 + 手动填写的 `modelPresets`。
2. **上下文用量与账号额度缺失**：`t3 thread show --json` 不返回 `tokenUsage` / `contextUsage` / `usageLimits`，导致 240° 用量仪表只能诚实显示 `—`。
3. **实时流式与交互能力受限**：缺少服务端实时事件推送、任务中断（Stop）、会话内切模型/权限以及内联审批响应。

因此需要基于本地实测与源码审计，将架构升级为 **RPC First + CLI Fallback**：以 T3 Code 官方 Orchestrator v2（WebSocket Effect RPC + HTTP v2）为主后端，保留现有 `t3` CLI 包装作为无服务端或版本不兼容时的基础降级后端。

---

## 第一阶段：源码、生态与包复用评估

### 1. 本机运行环境与源码镜像实测
- **本机 `t3` CLI**：`t3 v0.1.13-nightly.20261125.5258`（Launcher：`%USERPROFILE%\.t3\bin\t3.cmd`）
- **本机运行中 T3 Code Server**：`serverVersion: "0.1.13-nightly.20261125.5258"`、`orchestrationProtocolVersion: 2`、`databaseMigration: 119`、`platform: { os: "windows", arch: "x64" }`、服务端能力标志共 **85** 项。
- **官方 `pingdotgg/t3code` 本地镜像**：commit `70e4319d`（monorepo `@t3tools/monorepo`，`effect: 4.1.3`，`pnpm@12.14.0`）。

### 2. 官方源码包直接复用可行性评估
对 `pingdotgg/t3code` 五个核心目录的依赖与打包体量评估如下：

| 目录 / 包名 | 发布与导出形式 | 核心运行依赖 | Obsidian 插件直接复用评估 |
| :--- | :--- | :--- | :--- |
| `packages/contracts` (`@t3tools/contracts`) | `private: true`，原始 `.ts` 导出 | `effect@4.1.3`（`effect/Schema`、`effect/rpc/*`、`effect/http-api/*`、`effect/DateTime`） | **不适合运行时直接引入**：模块加载时即执行 `Schema.Struct`/`Rpc.make`/`RpcGroup.make` 构建，无法被 esbuild Tree-shake 干净；且解码类型（`Type`）含 `DateTime.Utc`/`Option` 等 Effect 运行时对象，与 JSON 线协议格式（`Encoded` ISO 字符串）不一致，`import type` 直用易产生类型失真。 |
| `packages/client-runtime` (`@t3tools/client-runtime`) | `private: true`，原始 `.ts` 子路径导出 | `@t3tools/contracts`、`@t3tools/shared`、`effect`、`effect/reactivity`、`gt-i18n`、`three`、`jszip`、`@pierre/diffs`、9 个 `@t3tools/provider-*` 包 | **不可引入**：重度绑定桌面/Web 客户端 UI 与重型三维/压缩/Diff 依赖，远超 `< 200 KB` 包体积上限。 |
| `packages/shared` (`@t3tools/shared`) | `private: true`，原始 `.ts` 子路径导出 | `effect`、**`ffi-rs`（原生 Node FFI）**、`nodeSqliteClient.ts` 等 Node 专属模块 | **不可整体引入**：含原生 FFI 与 Node 专属运行时，破坏纯 JS bundle 与跨平台边界；仅纯辅助逻辑（如 `socketFrameParts.ts`）可按需等价实现。 |
| `apps/web` (`@t3tools/web`) | React 19 Vite SPA | React、Tiptap、`@effect/atom-react`、`client-runtime` | 提供状态归约（`shellReducer.ts`、`threads.ts`、`contextWindow.ts`）的精确参考设计，不运行于 Obsidian 原生 `ItemView`。 |
| `apps/server` (`t3`) | Node CLI + HTTP/WS 守护进程 | `effect`、`@effect/platform-node`、`node-pty`、各 Provider SDK | 定义服务端权威契约：`ws.ts`、`http.ts`、`orchestration-v2/Orchestrator.ts`、`EnvironmentAuth.ts`、`CommandReceiptStore.ts`。 |

**关键打包体量实测（当前 `feat/sidebar-v2-redesign` 分支）**：
- `npm run build` 当前 `main.js` 实测 **`192,306` 字节**（门禁上限 `MAX_BUNDLE_BYTES = 204,800` 字节，剩余空间仅 **`12,494` 字节**）：
  - `markdown-it` + 传递依赖（`entities`、`linkify-it`、`uc.micro`、`mdurl`、`punycode.js`）+ `highlight.js` 共占 **`136,501` 字节（71.0%）**
  - `src/ui/ObsidianT3CodeView.ts` 占 **`40,451` 字节（21.0%）**
  - 其余业务源码合計仅 **`15,354` 字节**

**结论**：直接捆绑 `@t3tools/*` 与 `effect@4.1.3` 在体积与模块形态上不可行；应参照 `t3-obsidian` 与 `gfsaaser24/t3-code-agent-mcp` 的实践，在插件内实现**零 `effect` 依赖的轻量级 TypeScript Effect-RPC JSON 客户端与线协议类型层**（扩展既有 `src/t3/rpc.ts` 与 `src/t3/connection.ts`），并在 CI 中用官方真实响应夹具做回归校验。同时建议在实施前通过「移除内置 `markdown-it + highlight.js` 改用 Obsidian 原生 `MarkdownRenderer.render()`（释放约 `136 KB`）」或「显式评估调整打包预算」解决体积余量问题。

### 3. 已有第三方实现对比

| 参考项目 | 形态与协议策略 | 优势 / 可借鉴之处 | 对 T3-Codian 的启示 |
| :--- | :--- | :--- | :--- |
| **`t3-obsidian`**（`v0.0.455`） | Obsidian 插件；零 `effect`，手写 ~150 行 Effect RPC JSON 帧层 + HTTP v2 + `wsTicket` | `T3UnaryRpcPool` 多路复用、写入前 Write-Ahead `commandId`/`DirectPlan` 防重发、Vault 隔离保护；保留独立历史 `t3.cmd` 14 行模板安全解析 | 证明零 `effect` 方案与 `< 200 KB` 原生 DOM 侧栏高度契合；`t3-obsidian` 故意省略 `contextUsage` 与 `usageLimits`，本方案需补齐这两项真实解析 |
| **`kcosr/t3code-threads`**（`v0.2.0`） | Bun 独立 CLI；直接 workspace 引用 `../t3code/packages/{contracts,client-runtime,shared}`（`effect@4.0.0-beta.73`） | 直接复用官方流与状态逻辑，覆盖项目/会话/模型/思考度/中断/归档 | 依赖未发布 monorepo 源码与 Bun/Effect 重依赖，无法直接嵌入 Obsidian 浏览器目标 bundle |
| **`gfsaaser24/t3-code-agent-mcp`**（`v0.2.0`） | Node stdio MCP Server（目标 server `0.0.40`）；手写 Effect RPC JSON 帧 | 读取 `server-runtime.json` 发现服务；`Ping`/`Pong`/`Chunk`+`Ack` 流控；基于 SHA-256 `idempotencyKey` 的 `commandId`/`messageId`/`threadId` | 验证了纯 JS 实现 Effect RPC `Request`/`Chunk`/`Ack`/`Exit`/`Interrupt` 的简洁性与跨版本稳健性 |
| **`marcuscastelo/t3-connector`**（`v0.15.0`） | Node MCP Server（面向外部隧道） | 严格区分 `orchestration:read` 只读服务与 WebAuthn 租约写入网关，多环境隔离 | 强化最小权限范围原则：读能力仅需 `orchestration:read`，写/中断/审批需显式申请 `orchestration:operate` |

### 4. 三种传输通道能力与兼容性对比矩阵

| 维度 | 官方 HTTP MCP（`/mcp`） | WebSocket RPC + HTTP v2（本方案主路径） | 官方 `t3` CLI（`thread *`，本方案降级路径） |
| :--- | :--- | :--- | :--- |
| **定位** | 面向外部 LLM 工具调用（Agent-to-Agent） | T3 Code 官方 Web / Desktop / Mobile 客户端协议 | 独立命令行工具（短生命期进程包装） |
| **服务发现与鉴权** | MCP OAuth + 配对码/登录页 | `server-runtime.json` + `/.well-known/t3/environment` + `t3 auth session issue` 或 `/oauth/token` 配对 | 直接执行 `t3.cmd` / `t3`，CLI 自行处理认证 |
| **Agent / 模型 / 思考度目录** | 无 `server.getConfig` 全量目录接口 | **`server.getConfig` + `subscribeServerConfig`** 一次返回全量实例、模型与 `optionDescriptors` | 不支持（依赖插件设置手动预设） |
| **实时增量与流式状态** | 无原生高刷新率 UI 增量事件流 | **`orchestration.subscribeThread`** + **`subscribeShell`** + `Ack` 流控逐条推送 | 不支持（只能 1.6s 轮询 `t3 thread show --json`） |
| **真实上下文窗口用量** | 无专用流式快照订阅 | `providerTurns[].tokenUsage` 与 `providerThreads[].contextUsage` + `compaction` 回退 | 不返回（只能显示 `—`） |
| **Provider 账号额度** | 无标准化 UI 推送 | `ServerProvider.usageLimits` / `usageLimitSources`（实测按 Provider 支持情况如实返回或报 `unsupported`） | 不返回 |
| **任务中断 / 会话内切换 / 审批** | 部分工具封装 | 完整原语：`thread.stop`、`run.interrupt`、`thread.model-selection.set`、`thread.runtime-mode.set`、`runtime-request.respond` | 均不支持（需跳转 T3 Code 桌面端） |
| **断线恢复与跨端同步** | 无 `snapshotSequence` 增量同步 | `resumeFrom` / `afterSequence` 增量重放 + SQLite `CommandReceiptStoreV2` 幂等防重 | 仅依靠整表重读覆盖 |
| **稳定性与适用边界** | 受外部调用场景与宿主审批模式限制 | 需本机 T3 Code Server 在线；若断连或协议 != 2 可无缝降级 | 不依赖常驻 WS/Ticket，只要 CLI 可执行即可收发基础对话 |

---

## 第二阶段：本机真实服务端最小可行性实验 (MVE) 实测记录

2026-11-28 使用本机真实运行的 `t3` CLI 与 T3 Code Server（`0.1.13-nightly.20261125.5258`）在完全隔离的 `No project` 临时目录（`projectId: 6c3585ae-d666-4dec-be92-325ecb779be1`）执行了只读与受控写实验，实验结束后已删除测试线程并吊销全部短期凭据（校验残留 session 数为 `0`）。

### 1. 服务端发现与鉴权实测
- **发现地址与文件**：读取 `%USERPROFILE%\.t3\userdata\server-runtime.json`（仅允许 `127.0.0.1` / `localhost` / `[::1]` 回环 origin），请求 `GET /.well-known/t3/environment`（HTTP `200`）：
  - `serverVersion`: `"0.1.13-nightly.20261125.5258"`
  - `orchestrationProtocolVersion`: `2`
  - `databaseMigration`: `119`
  - `capabilities`（共 85 个键，含 `threadStop: true`、`threadForceStop: true`、`modelCatalogRefresh: true`、`usageLimitSources: true`、`shellOlderSettled: true`、`freshContext: true`）
- **鉴权实测**：
  - 执行 `t3 auth session issue --ttl 5m --scope orchestration:read [--scope orchestration:operate] --label <label> --json` 签发短期 Bearer Session；`GET /api/auth/session` 返回 `{ authenticated: true, scopes: [...], permissions: [...], sessionMethod: "bearer-access-token" }`。
  - `POST /api/auth/websocket-ticket/rpc`（返回 `200`；若遇旧服 `404` 降级 `POST /api/auth/websocket-ticket`）签发 `wsTicket`。
  - 建立 `WebSocket` 至 `/ws?orchestrationProtocol=2&wsTicket=<ticket>`（不携带 `x-t3-orchestration-protocol` 头于 WS，该头仅用于 `/api/orchestration/*` HTTP 请求）。
  - **实测关键规则**：流式订阅（`subscribeServerConfig`、`orchestration.subscribeShell`、`orchestration.subscribeThread`）每收到一帧 `Chunk` 后**必须回发** `{ _tag: "Ack", requestId }`，否则服务端 `OutputProtocol` 达到 `MAX_PENDING_CHUNKS = 8` 窗口上限后会暂停推流；心跳收到 `{ _tag: "Ping" }` 须回复 `{ _tag: "Pong" }`。

### 2. Provider、模型目录与思考度选项实测（`server.getConfig`）
- `server.probe` 返回 `{ serverTime }`。
- `server.getConfig` 返回 **`10` 个 Provider**，本机就绪（`enabled: true && status: "ready"`）共有 **3 个**：
  1. **`codex`**（`displayName: "Codex"`，`version: "0.172.0"`，`reportsContextWindow: true`，`showInteractionModeToggle: true`，`13` 个模型）：`optionDescriptors` 含 `{ id: "reasoningEffort", type: "select", label: "Reasoning", options: ["low","medium","high","xhigh","max","ultra"] }`（注意：**无 `role` 字段**），另有 `serviceTier`、`cyberAccessProgram`。
  2. **`claudeAgent`**（`displayName: "Claude"`，`version: "2.1.332"`，`reportsContextWindow: true`，`showInteractionModeToggle: true`，`161` 个模型）：`optionDescriptors` 含 `{ id: "effort", type: "select", label: "Reasoning", options: ["low","medium","high","xhigh","max","ultrathink"] }`（注意：**同样无 `role` 字段**），另有布尔选项 `ultracode`、`fastMode`。
  3. **`antigravity`**（`displayName: "Antigravity"`，`version: "1.5.15"`）：`optionDescriptors` 含 `{ id: "thought_level", type: "select", role: "reasoning", label: "Thinking Level", options: ["low","medium","high","xhigh"] }`。
  - 其余 7 个（`cursor`、`grok`、`opencode`、`fx`、`kiro`、`muse`、`pi`）在本机状态为 `enabled: false, installed: false, status: "disabled"`。
- **关键实测发现**：客户端识别思考度控件时不能只依赖 `role === 'reasoning'`，必须同时按 `role === 'reasoning' || /^(reasoningEffort|effort|thought_level|thinking)$/i.test(id)` 匹配；其余非思考 `select`/`boolean` 描述符应由契约透传保留，避免写死选项列表。

### 3. Provider 账号额度实测（`usageLimits` / `subscribeServerConfig`）
- `codex.usageLimits` 实测返回：`{ checkedAt: "2026-11-28T02:25:37.362Z", unavailable: { reason: "unsupported" }, windows: [] }`
- `claudeAgent.usageLimits` 实测返回：`{ checkedAt: "2026-11-28T03:13:20.082Z", unavailable: { reason: "unsupported" }, windows: [] }`
- `antigravity.usageLimits` 实测返回：`null`
- `subscribeServerConfig({ usageLimitSources: true })` 触发事件 `["snapshot", "usageLimitSourcesUpdated"]`，本机 `usageLimitSources` 为 `[]`。
- **关键实测发现**：账号额度并非所有 Provider/鉴权方式都会产出数值窗口；UI 在收到非空 `windows[]`（含 `label`、`kind`、`usedPercent`、`resetsAt`）时正常渲染，遇到 `unavailable.reason` 或 `null` / 空数组时必须如实展示「当前 Provider 暂不支持或未返回额度」而非伪造百分比。

### 4. 历史会话、实时订阅与事件结构实测
- `GET /api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1`（带 `x-t3-orchestration-protocol: 2`）：
  - 返回 `schemaVersion: 2`、`snapshotSequence`、`projects[]`、`threads[]`、`olderSettled`；带 `?resumeFrom=<seq>` 返回 `{ resumable: true }`，随后 `orchestration.subscribeShell` 推送 `["snapshot", "synchronized"]`。
- `GET /api/orchestration/threads/:id/bounded?compactTurnItems=1&deferWork=1`：
  - **关键结构实测**：返回 `{ snapshotSequence, projection, historyCursor, hasMoreHistory, latestLocalTurnOrdinal, turnItemsOmitLocalVisible }`——会话、消息、Turn 用量全部位于 **`projection`** 子对象内（包括 `thread`、`runs`、`attempts`、`nodes`、`providerSessions`、`providerThreads`、`providerTurns`、`runtimeRequests`、`messages`、`plans`、`turnItems`、`checkpointScopes`、`checkpoints`、`contextHandoffs`、`contextTransfers`）。
- `orchestration.subscribeThread({ threadId, acceptBoundedSnapshot: true, acceptCompactTurnItems: true, acceptDeferredWork: true, requestCompletionMarker: true })`：
  - 推送 `snapshot`（结构同上含 `projection` 与 `snapshotSequence`）、`synchronized` 及后续增量 `event`。
  - 实时对话实测捕获到的领域事件（31 条事件覆盖完整 Turn 生命周期）：`thread.metadata-updated`、`thread.model-selection-updated`、`thread.interaction-mode-updated`、`provider-thread.updated`、`provider-session.attached`、`provider-session.updated`、`run.created`、`run.updated`、`run-attempt.created`、`run-attempt.updated`、`node.updated`、`message.updated`（`{ id, runId, nodeId, role, text, streaming, createdAt, updatedAt }`）、`turn-item.updated`、`provider-turn.updated`、`checkpoint-scope.created`、`checkpoint.captured`、`runtime-request.updated`。

### 5. 真实上下文窗口用量实测（`tokenUsage` / `contextUsage`）
- **既有会话实测**：
  - `projection.providerTurns[].tokenUsage`: `{ usedTokens: 96951, maxTokens: 950000, inputTokens: 96086, cachedInputTokens: 88832, outputTokens: 865, reasoningOutputTokens: 79, updatedAt: "2026-11-14T12:59:46.038Z" }`
  - `projection.providerThreads[].contextUsage`: `{ usedTokens: 235592, maxTokens: 950000 }`
- **新建 Turn 1 实时跑完后实测**：
  - `projection.providerTurns[0].tokenUsage`: `{ usedTokens: 23888, maxTokens: 258400, inputTokens: 23883, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, updatedAt: "2026-11-28T03:18:14.474Z" }`
- **采信优先级**（对齐 `packages/client-runtime/src/state/contextWindow.ts`）：
  1. `projection.providerTurns[].tokenUsage`（筛选 `activeProviderThreadId` 且按最新 `updatedAt`，附带 fork `contextTransfers[].sourceTokenUsage` 回退）
  2. `projection.providerThreads[].contextUsage`
  3. 最近一条 `compaction` 类型 `turnItem` 的 `afterTokenCount`
  4. 以上均不存在时诚实显示 `—`（未知），严禁估算或捏造。

### 6. 会话控制、幂等性、任务中断、审批响应与断线恢复实测
- **创建与发送幂等实测**：
  - `orchestration.dispatchCommand` 执行 `thread.create`，同 `commandId` 两次调用均返回 `{ sequence: 79631 }`。
  - 执行 `message.dispatch`（`dispatchMode: { type: "start_immediately" }`），同 `commandId` 两次调用均返回 `{ sequence: 79644 }`，无重复消息（`messageCount: 2`）。
- **会话内变更实测**：`thread.model-selection.set`（`seq: 79632`）、`thread.interaction-mode.set`（`plan` `seq: 79633` / `default` `seq: 79634`）、`thread.runtime-mode.set`（`seq: 79635`）均返回成功。
- **任务中断实测**：Turn 2 运行期间调用 `thread.stop`（`{ type: "thread.stop", commandId, threadId, reason }`）返回 `{ sequence: 79687 }` 并触发停止事件落盘。
- **权限审批流安全实测**：
  - 沙箱会话在 `runtimeMode: "approval-required"` 下收到命令审批请求：`runtime-request.updated` 推送 `{ kind: "command", status: "pending", responseCapability: { type: "live", providerSessionId } }`。
  - **关键报错发现**：若审批不支持原因文本时向 `runtime-request.respond` 携带 `feedback`，服务端会明确拒绝：`OrchestrationV2DispatchCommandError: "Feedback requires a live approval that supports it and a decline decision."`。
  - 不带 `feedback` 调用 `{ type: "runtime-request.respond", commandId, threadId, requestId, decision: "decline" }` 返回 `{ sequence: 79785 }`，事件流立即推送 `status: "resolved"` 且**零命令被执行**。
- **跨客户端实时同步与断线重连实测**：
  - 独立第二客户端（Client B）在 Client A 派发 `thread.interaction-mode.set`（`seq: 79756..79757`）时实时收到对应序列事件（`syncedToClientB: true`）。
  - 关闭 Client A WebSocket 后重新获取 `wsTicket` 并发起 `orchestration.subscribeThread({ afterSequence: 79792, ... })`，服务端增量补推 `79793..79799` 并以 `{ kind: "synchronized" }` 收尾（`resumedIncrementally: true`）。

### 7. 已确认不支持或受限的能力清单（不得假设存在）
1. V2 协议不存在 `orchestration.getSnapshot` 方法；须使用 `GET /api/orchestration/shell` + `orchestration.subscribeShell` + `orchestration.subscribeThread`。
2. `projects.deleteEntry` 未受服务端支持（参考 `t3-obsidian` 实证记录）。
3. `ServerProvider.usageLimits` / `usageLimitSources` 可能因当前登录凭据或 Provider 实现而返回 `unsupported` / `null` / `[]`。
4. 移动端或未运行本机 T3 Server / 未安装 `t3.cmd` 场景下，自动 CLI Session 签发不可用，需走手动 Bearer Token/配对入口或自动降级 `CliBackend`。
5. `CliBackend` 降级路径（`t3 thread list/start/send/show`）不支持流式消息、多模型目录发现、`contextUsage`、`usageLimits`、任务停止、会话内切模型/权限及内联审批。

---

## 第三阶段：架构设计 (`T3Backend` 统一抽象)

### 1. 模块分层与职责
```text
ObsidianT3CodeView / V2 UI Components (仅依赖 UI 状态与后端能力标志，零协议耦合)
        │
        ▼ 订阅状态 & 派发动作
  src/t3/store.ts          ── 统一客户端状态仓库（Providers / Threads / Messages / Usage / Requests / ConnectionState）
        │
        ▼
  src/t3/backend.ts        ── 统一 `T3Backend` 接口、`T3BackendManager` 路由器、能力表与 Vault 安全前置拦截
     ├──▶ src/t3/rpc-backend.ts    (主后端: discovery + auth + rpc + http v2 + protocol-v2 + idempotency)
     └──▶ src/t3/cli-backend.ts    (降级后端: 复用现有 src/t3/cli.ts 轮询与基础会话收发)
```

- **UI 层解耦**：`ObsidianT3CodeView.ts` 与 `sidebar-model.ts` 不再直接实例化 `CliChat` 或解析 `t3` 命令行输出，改为订阅 `T3Store` 并在操作按钮中调用 `T3BackendManager` 暴露的高层方法。保留既有的零内部顶栏、异常专用横幅、`<300px` / `600px` 双形态布局、多标签独立状态、三列 `Agent · 模型 · 思考度` 弹层、240° 用量圆弧仪表、权限胶囊及框外笔记注脚。

### 2. 核心 `T3Backend` 与统一域模型接口设计
> 注：最终文件名与字段在实施阶段可随单元拆解微调，契约约束如下。

```ts
export type BackendMode = 'rpc' | 'cli';

export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'connected-rpc'
  | 'fallback-cli'
  | 'disconnected';

export interface BackendCapabilities {
  mode: BackendMode;
  supportsLiveCatalog: boolean;       // RPC: true; CLI: false (Settings presets)
  supportsProviderRefresh: boolean;   // RPC: capabilities.modelCatalogRefresh === true
  supportsStreaming: boolean;         // RPC: true; CLI: false (1.6s poll)
  supportsStop: boolean;              // RPC: capabilities.threadStop || threadForceStop
  supportsMidThreadModelSwitch: boolean;   // RPC: true; CLI: false
  supportsRuntimeModeSwitch: boolean;      // RPC: true; CLI: false
  supportsInteractionModeSwitch: boolean;  // RPC: true; CLI: false
  supportsApprovals: boolean;         // RPC: true; CLI: false (link to T3 Code)
  supportsContextUsage: boolean;      // RPC: true (per-provider/turn availability)
  supportsQuotaUsage: boolean;        // RPC: true (explicitly handles unsupported/null)
}

export interface ModelOptionChoice {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface ModelOptionDescriptor {
  id: string;
  type: 'select' | 'boolean';
  label: string;
  role?: string;                      // e.g. 'reasoning' (not guaranteed by all providers)
  currentValue?: string | boolean;
  options?: ModelOptionChoice[];
}

export interface ProviderModelDescriptor {
  providerId: string;
  slug: string;
  name: string;
  shortName?: string;
  isDefault?: boolean;
  isLegacy?: boolean;
  reasoningOption?: ModelOptionDescriptor;
  extraOptions: ModelOptionDescriptor[];
}

export interface ProviderDescriptor {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: 'ready' | 'warning' | 'error' | 'disabled';
  reportsContextWindow: boolean;
  supportedRuntimeModes: string[];
  showInteractionModeToggle: boolean;
  models: ProviderModelDescriptor[];
  quota: AccountQuotaSnapshot;
}

export interface ContextUsageSnapshot {
  status: 'available' | 'unknown';
  usedTokens?: number;
  maxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  percent?: number;                   // clamped 0..100 when maxTokens > 0
  source?: 'providerTurn' | 'providerThread' | 'compaction';
  updatedAt?: string;
}

export interface AccountQuotaSnapshot {
  status: 'available' | 'unsupported' | 'unknown';
  reason?: string;
  checkedAt?: string;
  windows: Array<{
    id: string;
    kind: 'session' | 'weekly' | 'monthly' | 'other';
    label: string;
    usedPercent: number;
    resetsAt?: string;
    windowDurationMins?: number;
  }>;
}

export interface RuntimeRequestItem {
  id: string;
  threadId: string;
  kind: string;                       // e.g. 'command' | 'file' | 'user_input'
  status: 'pending' | 'resolved' | string;
  title?: string;
  command?: string;
  supportsFeedback: boolean;          // only allow feedback when capability explicitly allows
  createdAt?: string;
}

export interface SendMessageInput {
  projectId: string;
  threadId?: string;
  commandId: string;                  // stable UUIDv4 per user submission (never regenerated on transport retry)
  messageId: string;                  // stable UUIDv4 per user message
  text: string;
  modelSelection?: {
    instanceId: string;
    model: string;
    options?: Array<{ id: string; value: string | boolean }>;
  };
  runtimeMode?: string;
  interactionMode?: 'default' | 'plan';
}

export interface T3Backend {
  readonly mode: BackendMode;
  connect(projectWorkspacePath: string, projectId: string): Promise<BackendCapabilities>;
  disconnect(): Promise<void>;
  getProviders(refresh?: boolean): Promise<ProviderDescriptor[]>;
  listThreads(projectId: string): Promise<CliThread[]>;
  openThread(threadId: string, onEvent: (ev: BackendEvent) => void): Promise<{
    unsubscribe: () => void;
  }>;
  sendMessage(input: SendMessageInput): Promise<{ threadId: string; sequence?: number }>;
  stopThread(threadId: string, commandId: string, activeRunId?: string): Promise<void>;
  setModelSelection(threadId: string, commandId: string, sel: NonNullable<SendMessageInput['modelSelection']>): Promise<void>;
  setRuntimeMode(threadId: string, commandId: string, runtimeMode: string): Promise<void>;
  setInteractionMode(threadId: string, commandId: string, mode: 'default' | 'plan'): Promise<void>;
  respondRuntimeRequest(input: {
    threadId: string;
    requestId: string;
    commandId: string;
    decision?: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
    feedback?: string;
    answers?: Record<string, unknown>;
  }): Promise<void>;
}
```

### 3. `RpcBackend` 发现、鉴权与降级策略
1. **服务发现与协议协商（`src/t3/discovery.ts`）**：
   - 校验显式配置的 origin 或读取 `<baseDir>/userdata/server-runtime.json`，强制回环地址校验（仅允许 `127.0.0.1`、`localhost`、`[::1]`，禁止非回环与 URL 内嵌凭据）。
   - 调用 `GET /.well-known/t3/environment` 验证 `orchestrationProtocolVersion === 2` 与非空 `environmentId`，缓存 `ExecutionEnvironmentDescriptor.capabilities`。
2. **Scoped Bearer 鉴权（`src/t3/auth.ts`）**：
   - 桌面本机优先复用 `t3.cmd` 14 行模板严格校验解析器（借鉴 `t3-obsidian` `desktop-cli.ts`），无 Shell 注入地执行 `t3 auth session issue --ttl 30m --scope orchestration:read --scope orchestration:operate --label t3-codian --json` 获取内存短期凭据，在插件卸载/重配时执行 `t3 auth session revoke <sessionId>`。
   - 同步支持通过配对码兑换 `/oauth/token` 并将会话凭据安全保存于设备本地 `localStorage`（绝不写入同步 `data.json` 或知识库目录）。
   - 所有诊断日志与错误对象必须经过键值/正则脱敏，严禁泄露 Token、`wsTicket`、Authorization 头或笔记正文。
3. **自动降级与恢复（`T3BackendManager`）**：
   - 优先连接 `RpcBackend`；当未发现本地运行 Server、协议非 v2、CLI 签发与配对凭据均不可用、或建连失败时，自动降级至 `CliBackend`（`connectionPhase = 'fallback-cli'`），在异常横幅或权限/用量弹窗内用非侵入文案说明当前运行在 CLI 降级模式并提供一键重试 RPC 连接。
   - **重连同步**：`RpcBackend` 断线按指数退避加随机抖动重连，重连时用 `GET /api/orchestration/shell?resumeFrom=<seq>` 与 `orchestration.subscribeThread({ afterSequence })` 增量追平；若间隔过长或序列已修剪，自动吸收服务端派发的 `snapshot` 并丢弃过期事件。

### 4. 动态能力驱动 UI 矩阵

| UI 模块 | `RpcBackend`（全能力 / 部分支持） | `CliBackend`（降级模式） |
| :--- | :--- | :--- |
| **Agent · 模型 · 思考度弹层** | 展示全量 `enabled` 且 `ready`/`warning` Provider、全部模型与真实 `optionDescriptors`（支持刷新、搜索过滤、切换思考度；支持 `supportsMidThreadModelSwitch` 时已有会话可直接切换） | 退化为设置页单模型 + `modelPresets`；已有会话提示 CLI 锁定并提供「带着草稿新开会话」 |
| **240° SVG 用量仪表 & 弹窗** | `contextUsage.status === 'available'` 时绘制真实百分比弧度与详细 token 分项；`quota.windows[]` 非空时展示额度，为 `unsupported`/`null` 时明确显示「当前 Provider 不支持额度查询」 | 始终显示 `—` 与「CLI 模式暂不提供上下文与额度数据」 |
| **运行权限胶囊 & 弹窗** | 展示当前 `runtimeMode` 与该 Provider 的 `supportedRuntimeModes` 切换控件；若目标目录与 Vault 重叠则限制并高亮提示 `approval-required` | 保持只读展示并提供 T3 Code 外链（校验 `^https://app\.t3\.codes/threads/`） |
| **发送 / 中断控制** | 生成期间显示实时增量流与 Stop 按钮（调用 `thread.stop` / `run.interrupt`） | 仅发送并按 1.6s 轮询，不伪造 Stop 按钮 |
| **审批 / 提问卡片** | 收到 `runtime-request.updated (pending)` 时展示内联审批按钮（`允许一次` / `本会话允许` / `拒绝` 等，按 `responseCapability` 决定是否允许反馈文本） | 发现 `waiting`/`pendingRequestCount > 0` 时展示横幅并引导至 T3 Code 处理 |

---

## 安全与稳定性约束 (Security & Stability Invariants)

1. **Vault 安全保护不降级**：`T3BackendManager` 在委托 `RpcBackend` 或 `CliBackend` 执行任何创建/发送/权限修改前，统一执行 `realpath` + `workspacesOverlap` 检查；当目标目录与当前 Obsidian Vault 重叠且会话权限不是 `approval-required` 时**一律拦截发送并拒绝静默提权到 `full-access`/`auto`**；笔记读取保持严格只读，写回笔记仍只能由用户显式点击「插入当前光标处」触发。
2. **不直接触碰 T3 数据库**：严禁读写 `~/.t3` 下的 SQLite（`state.sqlite` / `statev2.sqlite`）或内部私有状态目录中的会话密钥文件；仅允许以只读方式读取发现文件 `server-runtime.json`。
3. **防重复发送与重复建聊**：
   - UI 每次点击发送生成稳定的 `commandId`（UUIDv4）与 `messageId`（UUIDv4）并写入内存/设备本地 pending 记录。
   - **硬性规定**：遇到 WS 断线或未确认结果时，只允许使用**同一个 `commandId` / `messageId`** 发起重放或先拉取线程快照核对消息 ID 是否已落盘（依赖服务端 `CommandReceiptStoreV2` 去重），绝对禁止生成新的 `commandId` 自动重发。
4. **凭据零泄露**：所有错误提示、`Notice` 与日志必须剥离 Bearer Token、`wsTicket` 与配对码；测试与 MVE 脚本不得把凭据打印到终端或写入仓库。
5. **打包体积预算控制**：`scripts/verify-bundle.mjs` 当前限定 `main.js < 204,800` 字节，目前已达 `192,306` 字节（主要因 `markdown-it` + `highlight.js` 占 `136,501` 字节）。计划在 M0 与用户确认：**将消息渲染迁移至 Obsidian 原生 `MarkdownRenderer.render()`（推荐，释放约 `136 KB` 余量并更好融入 Obsidian 主题与安全清洗）**，或评估调高打包体积上限。

---

## 后果与影响 (Consequences)

- **正面收益**：在保持 Zero-Header、极简原生界面与 Vault 强安全边界的前提下，为桌面端 Obsidian 用户真正补全多 Agent/多模型动态发现、真实思考度选项、实时上下文窗口百分比、增量流式回复、任务中断、会话内切换与内联审批；同时在无服务/离线异常时优雅退回 `CliBackend` 保底。
- **代价与风险**：插件内需维护一套轻量级 Effect-RPC JSON 帧与线协议适配层，在 T3 Code 升级协议版本时需通过协议回归夹具（含未知事件前移、v1 拦截、`Ack` 流控窗口测试）持续验证兼容性；且 `usageLimits` 依赖各 Provider 本身能力，部分 Provider 在未提供该字段时 UI 需清晰标示「不支持/未知」。
