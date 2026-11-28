# Obsidian T3 Code 项目状态

**2026-11-26** · MVP v0.1 已实现，剩余首字时延目标和远端 CI 验收。

## 当前状态

- GitHub 仓库与插件 ID 已更名为 `obsidian-t3-code`。仓库地址为 [sido-meet/obsidian-t3-code](https://github.com/sido-meet/obsidian-t3-code)，原有 Issue 随仓库迁移。本地 `origin` 已更新。
- MVP 分支为 `feat/2-mvp-v0.1`，基于 Issue #1 脚手架分支。安装步骤见 [README](../README.md)，本次实施顺序见 [执行计划](superpowers/plans/2026-11-26-mvp-execution.md)，脚手架审查见 [Issue #1 审查记录](reviews/2026-11-18-issue-1-review.md)。

## 验证记录

| 验收项 | 证据 |
| --- | --- |
| 安装与配置 | Windows 的独立 Obsidian 1.12.7 配置和临时 Vault 成功加载插件，命令重复打开仍为同一个侧栏。连接地址和笔记开关由 PluginData 保存。 |
| 本地服务连接 | 隔离的 T3 Code `v0.1.12-nightly.20261121.5024` 中，服务发现、OAuth 配对、取得一次性票据和 WebSocket 握手成功。桌面侧栏从点击连接到可选项目实测 47 ms。 |
| Codex 对话 | 桌面测试从首轮和同线程追问收到了真实回复。隔离服务验证了重连恢复同一线程，以及停止当前运行。模拟帧测试覆盖增量输出、断线重连、会话切换和停止。 |
| 时延目标 | 桌面样本从点击发送到首条回复分别约为 15.5 秒和 19.8 秒，尚未达到 PRD 的 2 秒目标。 |
| 选区与采纳 | 在临时 Vault 选中测试文字，Codex 返回了该选区原文。点击插入后，回复准确写入光标位置。 |
| 工程门禁 | 47 个本地测试通过，协议帧解析、会话投影和笔记上下文模块的行、语句、函数及分支覆盖率均为 100%。构建体积约 157 KiB。 |
| 独立审查 | 审查发现并修复了重复侧栏、半开连接、快照竞态、重连次数继承、历史消息反复渲染和 Vault Markdown 处理器触发问题。 |
| GitHub Actions | 推送已获授权。Windows 与 Ubuntu 的 CI 结果以 [GitHub Actions](https://github.com/sido-meet/obsidian-t3-code/actions) 为准。 |

历史会话目录、桌面端双向会话恢复和侧栏内审批按现有 P0 范围留待后续。MVP 内 Codex 需要用户处理审批时会引导至 T3 Code。

## CLI 迁移分支

`feat/6-sidebar-layout` 以本机 t3 CLI 取代侧栏的手动配对流程，同时更新消息区、底部输入框和状态顶栏布局。PR #13 对应原协议直连基线，CLI 分支的设计见 [ADR 0002](adr/0002-t3-cli-backend.md)。CLI 支持新建、追问及轮询刷新，运行权限由 T3 项目配置决定。原生流式订阅和停止仍依赖 CLI 新增接口。

Windows 隔离联调验证：真实 t3.cmd 新建线程、轮询读取回复、同线程追问均成功。隔离 Obsidian 使用浅色和深色主题，在 246 像素侧栏无横向溢出。类型检查、Lint、50 项测试和生产构建通过。

项目路径默认值已改为当前 Vault 根目录。此变更新增 1 项回归测试，本地 51 项测试通过。

## 原生侧栏分支验收

`feat/6-sidebar-layout` 以已通过远端检查的 PR #13 为父级。脚手架提交已经包含在 MVP 中，旧分支和现有 worktree 保留。新侧栏提供同项目会话历史与恢复、按会话保存草稿、Agent 和模型预设、首次发送时的推理选项、真实权限显示、额度不可用提示以及 Markdown 笔记引用。CLI-only 的实际额度、模型自动发现、停止、权限切换及审批回传仍待 CLI 提供相应接口。

独立审查记录：已处理 Windows 批处理子进程取消、切换项目时草稿隔离、异步读取期间附件锁定、旧会话轮询覆盖和项目绑定。公开 CLI 缺少根目录查验命令，因此设置绑定的项目 ID 用于派发，并用路径查询的会话列表交叉检查，已有会话缺少「需要审批」时限制 Vault 发送。新会话仍继承 T3 项目默认权限。

本地验收：类型检查、Lint、56 项测试、覆盖率门禁及生产构建通过。隔离 Obsidian 与真实 CLI 验证了模型推理选项、笔记附件、回复、历史恢复、草稿和实际权限。浅色与深色在 240、320、480 像素下均无横向溢出。


---

## 2026-11-27 — 侧栏 V2 重构（分支 `feat/sidebar-v2-redesign`）

- **状态**：已在独立 worktree（`feat/sidebar-v2-redesign`）完成实现、独立只读 Code Review 及全量验证（尚未推送或合并到 `main`）。
- **核心改动**：
  - 扩展 `src/t3/cli.ts` `CliThread` / `readThread()` 可选元数据解析（`settled`、`pinned`、`snoozed`、`archived`、`parentThreadId`、`relationshipToParent`、`pendingRequestCount`、`createdAt`、`updatedAt`）。
  - 新增纯逻辑模块 `src/ui/sidebar-model.ts` 及单元测试 `tests/sidebar-model.test.ts`。
  - 重构 `src/ui/ObsidianT3CodeView.ts` 与 `styles.css`，落地零顶栏、异常专用横幅、`>= 600px` 持久会话侧栏与可拖拽分割线、`< 300px` 紧凑布局、多标签独立状态隔离、固定高度三列 `Agent · 模型 · 思考度` 弹层、诚实 `—` 用量提示、只读权限说明与框外笔记注脚切换；新增 UI 集成测试 `tests/sidebar-view.test.ts`。
  - 修复 `.eslint`（`eslint.config.mjs` 忽略 `.research_repos/**`）并消除独立 Code Review 指出的无障碍嵌套按钮、`Escape` 焦点管理、断连与失活标签异步竞态、已连接报错可见性及符号链接 Vault 安全检查问题。
- **验证结果（worktree 内最后一次代码改动后实测）**：
  - `npm run typecheck`：通过（0 错误）
  - `npm run lint`：`eslint . --max-warnings=0` 通过（0 警告/错误）
  - `npm run test:coverage`：15 个测试文件 / 71 条测试全部通过（总覆盖率 `85.96%` Stmts / `81.33%` Branch / `89.5%` Funcs；`sidebar-model.ts`、`context.ts`、`rpc.ts`、`transcript.ts`、`workspace.ts`、`markdown.ts`、`note-attachments.ts` 均 100%；`ObsidianT3CodeView.ts` `85.55%` Stmts / `88.6%` Funcs）
  - `npm run build`：`main.js` `192,341` 字节（`< 204,800` 字节上限），bundle 校验通过
- **待办**：等待用户审阅分支改动并决定是否发起/合并 PR。


---

## 2026-11-28 — RPC First + CLI Fallback 第一至第三阶段调研与 ADR-0003 设计（待审阅）

- **状态**：已完成源码/生态调研、本机运行中 T3 Code 服务端最小可行性实验（MVE）及架构设计文档输出；**代码层暂未开始大规模重构，等待用户审阅实施计划**。
- **调研与实测关键结论**：
  - **本机环境**：`t3` CLI 与本地 Server 均为 `0.1.13-nightly.20261125.5258`，协议版本 `orchestrationProtocolVersion = 2`（`databaseMigration = 119`，`85` 项服务端能力标志）。
  - **协议与包复用评估**：`pingdotgg/t3code`（commit `70e4319d`）全部 `@t3tools/*` 内部包均为 `private: true` 且耦合 `effect@4.1.3`（`packages/shared` 含原生 `ffi-rs`）；结合当前 `main.js` 已达 `192,306 / 204,800` 字节（`markdown-it + highlight.js` 占 `136,501` 字节），确立采用**零 `effect` 轻量原生 TypeScript Effect-RPC JSON 客户端**。
  - **本机 MVE 实测通过项目**：回环发现（`server-runtime.json` + `/.well-known/t3/environment`）、短期 Scope Session 签发与吊销（`t3 auth session issue/revoke`，零残留）、`wsTicket` 升级 `/ws?orchestrationProtocol=2`、`Ack` 8-chunk 窗口控制、`server.getConfig`（实测返回 `10` 个 Provider，其中 `codex`/`claudeAgent`/`antigravity` 3 个就绪，且识别出 `codex`/`claudeAgent` 思考度无 `role` 字段与部分 Provider `usageLimits` 为 `unsupported`/`null`）、`shell`/`bounded`（数据在 `.projection` 内）与 `tokenUsage`/`contextUsage`、同 `commandId` 幂等重放、`thread.stop` 中断、`runtime-request.respond` 审批拒绝（确认 `feedback` 约束）及双客户端跨端同步与 `afterSequence` 增量重连恢复。
- **产出文档**：
  - 新增架构决策记录：[docs/adr/0003-rpc-first-cli-fallback.md](adr/0003-rpc-first-cli-fallback.md)（状态：`Proposed`）
  - 更新索引：[docs/adr/README.md](adr/README.md)
  - 新增分阶段实施计划：[docs/superpowers/plans/2026-11-28-rpc-first-cli-fallback-plan.md](superpowers/plans/2026-11-28-rpc-first-cli-fallback-plan.md)
- **待用户确认**：M0 两项前置决策（`main.js` 体积余量方案 & 默认鉴权接入优先级）及各阶段改造范围确认后进入实施。


---

## 2026-11-28 — M0 完成：采纳 ADR-0003 并迁移原生 `MarkdownRenderer.render()`

- **状态**：已完成 M0（ADR-0003 正式转为 **Accepted**，移除内置 `markdown-it` 与 `highlight.js`，迁移至 Obsidian 原生 `MarkdownRenderer.render()`）。
- **核心改动**：
  - [package.json](../package.json) / [package-lock.json](../package-lock.json)：卸载 `markdown-it`、`highlight.js`、`@types/markdown-it`（移除 11 个包）。
  - [src/ui/markdown.ts](../src/ui/markdown.ts)：实现非可信 AI 输出前置清洗（拦截第三方可执行代码块 `dataviewjs`/`templater` 等重写为 `text`、阻断 `![[...]]` 嵌入与远程图片、过滤 `<script>` 等原始 HTML 与非 `http(s):`/`mailto:` 链接、超过 40,000 字符降级惰性纯文本）及离屏渲染后 DOM 二次加固（移除 `on*` 事件属性与高危元素）。
  - [src/ui/ObsidianT3CodeView.ts](../src/ui/ObsidianT3CodeView.ts)：引入行级 `Component` 生命周期绑定、异步 `renderSeq` 竞态丢弃保护、`120ms` 流式节流与不破坏阅读回溯的底部滚动锁定。
  - [styles.css](../styles.css)、[tests/__mocks__/obsidian.ts](../tests/__mocks__/obsidian.ts)、[tests/markdown.test.ts](../tests/markdown.test.ts)、[tests/sidebar-view.test.ts](../tests/sidebar-view.test.ts)。
- **验证结果**：`typecheck` 0 错误、`lint` (`--max-warnings=0`) 0 警告、`test:coverage` 15 个测试文件 / 75 条测试全过（总覆盖率 `86.46%` Stmts / `82.63%` Branch / `89.65%` Funcs，`markdown.ts` 100% Stmts & Funcs），`main.js` 体积由 **`192,306` 字节降至 `60,192` 字节**（释放 `132,114` 字节，`144,608` 字节余量低于 `204,800` 上限）。


---

## 2026-11-28 — M1 完成：`T3Backend` 抽象、`T3Store` 与 `CliBackend` 降级适配层

- **状态**：已完成 M1（UI 解耦基础设施与 CLI 降级后端适配器落地）。
- **新增文件**：
  - [src/t3/backend.ts](../src/t3/backend.ts)：定义统一 `T3Backend` 接口、能力矩阵契约 `BackendCapabilities`、Provider/Model/Quota/ContextUsage/RuntimeRequest 领域模型与写命令幂等入参。
  - [src/t3/store.ts](../src/t3/store.ts)：实现仅按需缓存当前打开会话详情的不可变客户端状态容器 `T3Store`。
  - [src/t3/cli-backend.ts](../src/t3/cli-backend.ts)：封装 `CliChat` 实现 `T3Backend`，支持预配置模型转换、轮询订阅，并对不支持的能力（中断/切模型/改权限/审批）明确报错而非静默伪装。
  - 单元测试：[tests/store.test.ts](../tests/store.test.ts)、[tests/cli-backend.test.ts](../tests/cli-backend.test.ts)。
- **验证结果**：`typecheck` 0 错误、`lint` (`--max-warnings=0`) 0 警告、`test:coverage` **17 个测试文件 / 79 条测试全过**（`cli-backend.ts` 100% Stmts/Funcs、`store.ts` 97.26% Stmts）、`main.js` 为 `60,192` 字节（`< 204,800`）。


---

## 2026-11-28 — M2 完成：协议 v2 服务发现、纯内存鉴权与流式 Effect-RPC 传输层

- **状态**：已完成 M2（本地 Server 发现、严格 `.cmd` 鉴权、流式 RPC + `Ack` 流控与 v2 线协议规范化层落地并通过验证）。
- **核心改动**：
  - [src/t3/discovery.ts](../src/t3/discovery.ts)：`validateLoopbackOrigin` 严格限制本机回环地址、`isProcessAlive` PID 存活检测、`discoverCliPath` 多路径/PATH 自动发现（排除桌面 GUI 误启动）、严格 14 行 `t3.cmd` Launcher 解析与 `discoverLocalServer`（`server-runtime.json` + `/.well-known/t3/environment` 协议 v2 强校验与版本比对）。
  - [src/t3/auth.ts](../src/t3/auth.ts)：纯内存短期会话管理器 `T3AuthManager`（`t3 auth session issue/revoke`、`shell: false` Fail-Closed `.cmd` 解析、单飞并发合并、到期前自动续期、HTTP `/api/auth/session` 权限核验与失败即吊销、`/oauth/token` 配对兑换与敏感凭据文本脱敏 `redactSensitiveText`）。
  - [src/t3/rpc.ts](../src/t3/rpc.ts)：补齐 `subscribe()`/`unsubscribe()`、8-chunk 窗口逐帧 `Ack`、`Interrupt` 退订、`Ping`/`Pong` 心跳与 Effect `Cause` 报错脱敏提取。
  - [src/t3/protocol-v2.ts](../src/t3/protocol-v2.ts)：Provider/Model 目录与动态 `optionDescriptors` 解析、`usageLimits` 五态诚实建模、三级 `contextUsage` 提取（turn -> transfer -> thread -> compaction）、全局递增游标归约（含 `unknown-event` 前移与 `snapshot-required` 回退信号）。
  - 单元测试：[tests/rpc.test.ts](../tests/rpc.test.ts)、[tests/discovery.test.ts](../tests/discovery.test.ts)、[tests/auth.test.ts](../tests/auth.test.ts)、[tests/protocol-v2.test.ts](../tests/protocol-v2.test.ts)。
- **验证结果**：`typecheck` 0 错误、`lint` (`--max-warnings=0`) 0 警告、`test:coverage` **20 个测试文件 / 94 条测试全过**（`rpc.ts` **100%** Stmts/Branch/Funcs/Lines、`protocol-v2.ts` **96.36%** Stmts / **100%** Funcs、`discovery.ts` **91.94%** Stmts），`main.js` 为 `60,192` 字节（`< 204,800`）。


---

## 2026-11-28 — M3 & M4 完成：`RpcBackend`、`T3BackendManager` 降级路由、幂等防重与 Vault 安全门卫

- **状态**：已完成 M3 与 M4（WebSocket RPC 主后端、断线增量追平/HTTP bounded 回落、确定性 `commandId`/`messageId` 幂等写操作、`UncertainWriteError` 防误降级重发、自动 `CliBackend` 降级与 `realpath` Vault 安全护栏落地）。
- **核心改动**：
  - [src/t3/vault-guard.ts](../src/t3/vault-guard.ts)：基于 `realpath` 解析真实路径并叠加 `workspacesOverlap`，统一在 `T3BackendManager` 层前置拦截 Vault 重叠下的非 `approval-required` 发送及权限提权切换。
  - [src/t3/rpc-backend.ts](../src/t3/rpc-backend.ts)：实现 `T3Backend` (`mode: 'rpc'`)，覆盖 `/api/auth/websocket-ticket/rpc`（含 `404` 降级）与 `401` 自动续期、`/api/orchestration/shell` 与 `orchestration.subscribeShell` / `subscribeServerConfig`、`openThread` 流式订阅及 `snapshot-required` HTTP 回落、指数退避+抖动重连与 `afterSequence` 追平；写路径实现 `thread.create` + `message.dispatch`（同 `commandId` 复用确定 `threadId`/`messageId` 并在断网抛出 `UncertainWriteError`）、`thread.stop`/`run.interrupt`、会话内切模型/权限/模式与受 `supportsFeedback` 约束的 `runtime-request.respond`。
  - [src/t3/backend-manager.ts](../src/t3/backend-manager.ts)：实现 RPC 优先 + 连接/协议失败自动切换 `CliBackend` 降级路由器、`pairWithCode` 内存配对连接、`retryPendingDispatch` 先查后重放及禁止通过 CLI 重放未确认 RPC 写入硬不变量。
  - 单元测试：[tests/vault-guard.test.ts](../tests/vault-guard.test.ts)（含临时目录 `junction`/`symlink` 穿透验证）、[tests/rpc-backend.test.ts](../tests/rpc-backend.test.ts)、[tests/backend-manager.test.ts](../tests/backend-manager.test.ts)。
- **验证结果**：`typecheck` 0 错误、`lint` (`--max-warnings=0`) 0 警告、`test:coverage` **23 个测试文件 / 107 条测试全过**（`vault-guard.ts` **100%** Stmts/Funcs/Lines、`store.ts` **100%**、`rpc.ts` **100%**），`main.js` 为 `60,192` 字节（`< 204,800`）。


---

## 2026-11-28 — M5 完成：设置扩展、动态能力模型与 V2 侧栏全能力接入

- **状态**：已完成 M5（插件设置与内存配对码入口、`sidebar-model` 实时目录/用量/额度格式化、V2 侧栏全量解耦迁移至 `T3BackendManager` + `T3Store` 驱动）。
- **核心改动**：
  - [src/settings.ts](../src/settings.ts) & [src/settings-tab.ts](../src/settings-tab.ts) & [src/main.ts](../src/main.ts)：新增 `backendPreference`（`auto`/`cli`）与可选回环 `serverUrl` 设置项，新增仅内存有效的手动一次性配对码提交入口（提交后立即清空输入且绝不写入 `data.json`/Vault）；扩展设置变更侦测触发后端重载。
  - [src/ui/sidebar-model.ts](../src/ui/sidebar-model.ts)：新增 `buildModelCatalogFromProviders`（兼容多 Agent、思考度信号条与布尔/扩展选项）、`formatContextUsage`、`formatQuotaSummary`（五态诚实渲染）及支持 `fallback-cli`/内联审批/未确认消息重试的 `resolveStatusBanner`。
  - [src/ui/ObsidianT3CodeView.ts](../src/ui/ObsidianT3CodeView.ts) & [styles.css](../styles.css)：全面移除对 `CliChat`/`cliRunner` 的直接耦合，改为通过 `T3BackendManager` + `T3Store` 驱动；在保留零顶栏、`>= 600px` 双栏布局、多标签隔离、安全外部链接与框外笔记注脚基础上，接入实时多 Agent/模型发现与刷新、会话内模型切换、240° SVG 用量进度圆弧与真实 token 明细、交互式权限切换（Vault 重叠锁定 `approval-required`）、流式输出与 Stop 中断按钮、Tool Call 紧凑胶囊及受 `supportsFeedback` 约束的内联安全审批卡片。
  - 单元测试：[tests/__mocks__/obsidian.ts](../tests/__mocks__/obsidian.ts)、[tests/input.test.ts](../tests/input.test.ts)、[tests/smoke.test.ts](../tests/smoke.test.ts)、[tests/sidebar-model.test.ts](../tests/sidebar-model.test.ts)、[tests/sidebar-view.test.ts](../tests/sidebar-view.test.ts)。
- **验证结果**：`typecheck` 0 错误、`lint` (`--max-warnings=0`) 0 警告、`test:coverage` **23 个测试文件 / 107 条测试全过**（`sidebar-model.ts` **100%** Stmts/Branch/Funcs/Lines、`rpc.ts` **100%**、`store.ts` **100%**、`ObsidianT3CodeView.ts` **86.58%** Stmts），`main.js` 为 **`135,542` 字节**（`< 204,800` 字节上限，仍低于 M0 前基线 `192,306` 字节）。


---

## 2026-11-28 — M6 完成：独立 Code Review、实时 tokenUsage 保真修复、全链路 E2E 与打包门禁收官

- **状态**：已完成 M6（独立子 Agent Code Review 问题全量闭环、live `tokenUsage` 保真修复、全量自动化门禁与本机真实 Server 端到端实测通过；工作区保持在独立特性分支 `feat/sidebar-v2-redesign`，正式 Vault 未动）。
- **独立 Review 与关键加固**：
  - 依据独立 Code Review 发现（7 项 High、6 项 Medium、1 项 Low），完成安全、并发与竞态加固：
    - [src/ui/markdown.ts](../src/ui/markdown.ts)：封堵反斜杠转义图片链接（`\\![...]`）、跨行/引用式图片与危险引用定义、`> \`\`\`dataviewjs` 等容器嵌套代码块、大写畸形 HTML 标签（`.toUpperCase()`）检查，以及异步离屏渲染与 `shouldCommit` 竞态防覆写。
    - [src/t3/vault-guard.ts](../src/t3/vault-guard.ts)：新增向上回溯最近存在祖先目录的 `realpath` 解析，防止未创建子路径通过符号链接/联接点穿透 Vault 护栏。
    - [src/t3/rpc.ts](../src/t3/rpc.ts) & [src/t3/rpc-backend.ts](../src/t3/rpc-backend.ts)：补齐 `code=` 与 JSON 字段凭据脱敏，提供 `getResolvedProjectWorkspaceRoot()` 与四态写入对账 `inspectPendingWrite()`。
    - [src/t3/store.ts](../src/t3/store.ts) & [src/t3/backend-manager.ts](../src/t3/backend-manager.ts)：消除 `retryPendingDispatch` 状态切换 TOCTOU 竞态，防止表单 `runtimeMode` 误覆盖既有会话权限模式，校验服务端 `projectId.workspaceRoot` 是否与 Vault 重叠，并统一保留重试模式字段。
    - [src/t3/protocol-v2.ts](../src/t3/protocol-v2.ts)：增量 `thread.*` 事件与本地 `rawProjection.thread` 合并（防止丢失 `title`/`status`/`runtimeMode`/`activeProviderThreadId`）；同时对齐官方 `orchestrationV2Projection.ts`，修复后继无 `tokenUsage` 的 `provider-turn.updated` 覆写清空前置实时用量的缺陷，并在非占位 `provider-thread.updated` 时同步更新 `activeProviderThreadId`。
    - [src/ui/sidebar-model.ts](../src/ui/sidebar-model.ts) & [src/ui/ObsidianT3CodeView.ts](../src/ui/ObsidianT3CodeView.ts)：修复未确认重放横幅死锁、`fallback-cli` 状态下 RPC 重连按钮路由、多标签异步切换 `isStaleTab` 守卫、流式刷新保留 `.t3c-approval-feedback` 焦点与输入，以及页签切换/关闭时释放 `subscribeThread` 订阅。
  - 扩展回归测试：[tests/markdown.test.ts](../tests/markdown.test.ts)、[tests/vault-guard.test.ts](../tests/vault-guard.test.ts)、[tests/protocol-v2.test.ts](../tests/protocol-v2.test.ts)、[tests/discovery.test.ts](../tests/discovery.test.ts)、[tests/auth.test.ts](../tests/auth.test.ts)、[tests/backend-manager.test.ts](../tests/backend-manager.test.ts)、[tests/rpc-backend.test.ts](../tests/rpc-backend.test.ts)、[tests/sidebar-view.test.ts](../tests/sidebar-view.test.ts)。
- **最终门禁验证结果**（全部基于最终代码编辑后实跑）：
  - `npm run typecheck`：退出码 0（0 错误）
  - `npm run lint`（`eslint . --max-warnings=0`）：退出码 0（0 警告）
  - `npm run test:coverage`：**23 个测试文件 / 112 条测试全过**（`All files` **89.25% Stmts / 81.77% Branch / 91.2% Funcs / 89.25% Lines**；`rpc.ts` / `store.ts` / `vault-guard.ts` / `sidebar-model.ts` / `backend.ts` / `cli-backend.ts` 均 **100% Stmts**，`protocol-v2.ts` **97.1%**、`markdown.ts` **98.79%**、`discovery.ts` **95.33%**、`backend-manager.ts` **90.22%**、`ObsidianT3CodeView.ts` **87.7%**、`auth.ts` **87.59%**、`rpc-backend.ts` **87.37%**）
  - `npm run build` + `verify-bundle.mjs`：`main.js` 为 **`141,443` 字节**（`< 204,800` 字节上限，剩余余量 `63,357` 字节；M0 前基线 `192,306` 字节 -> M0 后 `60,192` 字节 -> M6 终版 `141,443` 字节）
- **本机真实 T3 Code Server 端到端实测**：
  - 实测目标：`http://127.0.0.1:3773`（`serverVersion: 0.1.13-nightly.20261125.5258`，`orchestrationProtocolVersion: 2`），测试目录限缩于 `~/.t3/scratch/6c3585ae-d666-4dec-be92-325ecb779be1`。
  - 验证项全绿：服务端发现、`.cmd` `shell: false` 短期 Session 签发、`connected-rpc` 全 11 项能力位就绪、真实多 Agent 目录（`codex` 13 模型 `reasoningEffort`、`claudeAgent` 161 模型 `effort`、`antigravity` 11 模型 `thought_level`）、首轮真实问答及 Turn 1 实时 `contextUsage`（`usedTokens: 25823, maxTokens: 950000, source: 'providerTurn'`）、双客户端跨端状态同步（`plan` <-> `default`）、断线重连 `afterSequence` 追平、长回复 `stopThread` 中断（`interrupted`）、真实 `approval-required` 权限请求内联拒绝（`supportsFeedback: false`）、`401` 自动续期（`renewOnUnauthorized`）、不可达端口自动降级至 `CliBackend`（`phase: 'fallback-cli'`），以及退出后经 `t3 auth session list --json` 核验 **`0` 条未吊销残留 `t3-codian` 会话**。
- **已知边界与使用限制**：
  - `usageLimits` 诚实反映各 Provider 上行支持情况（本机实测 `codex`/`claudeAgent` 返回 `unsupported`，`antigravity` 返回 `unknown`）。
  - 仅支持 Obsidian 桌面端（依赖本机回环发现与 CLI 进程通信），不支持移动端。
  - 尚未自动覆盖用户正式知识库 `E:\Documents\Obsidian-Vault`，待用户审阅分支并按部署说明手动拷贝测试。


---

## 2026-11-28 — M7 & M8 完成：真实 Obsidian 桌面端验收、独立 Review 闭环与上线部署准备

- **状态**：已完成 **M7（真实 Obsidian 1.15.1 桌面端自动化验收 + 定向缺陷修复 + 独立 Code Review 全闭环）** 与 **M8（发布说明、部署/回滚脚本及用户正式 Vault 生产部署）**。代码与文档保持在独立特性分支 `feat/sidebar-v2-redesign`（worktree），`main` 分支保持未修改；经用户明确批准，已通过 `scripts/deploy-obsidian.ps1` 将本次产物正式部署至 `E:\Documents\Obsidian-Vault\.obsidian\plugins\t3-codian`。
- **阶段关键修复与工程产出**：
  - **协议实时增量流式落地**（[src/t3/protocol-v2.ts](../src/t3/protocol-v2.ts)）：对齐本机 T3 Server v2 实测帧契约，解析并归约 `turn-item.updated`（`type: 'assistant_message'`）与快照中 `turnItems` 的增量文本流；补充缺失 `streaming` 时的状态推断、`textOmitted` 过滤、终态锁防覆写与 `run.updated` 终态清理，以及 `provider-turn.updated` / `provider-thread.updated` 遇到 `null` 时保留既有实时用量。
  - **首轮预订阅竞态、连接生命周期与安全加固**（[src/t3/rpc-backend.ts](../src/t3/rpc-backend.ts)、[src/t3/backend-manager.ts](../src/t3/backend-manager.ts)、[src/t3/cli-backend.ts](../src/t3/cli-backend.ts)、[src/t3/rpc.ts](../src/t3/rpc.ts)、[src/t3/auth.ts](../src/t3/auth.ts)）：新增 `onThreadReady`（`thread.create` 与 `message.dispatch` 间同步订阅）、`VaultSecurityError` 根目录冲突 fail-closed 拒降级、CLI `verifyWorkspaceProjectBinding()`、全局集中管理 `pollerCancels` 与 Turn 2 有界宽限唤醒、`explicitDisconnect` 会话吊销隔离及全场景凭据脱敏。
  - **UI 交互、滚动保真与 Obsidian CSS 作用域收敛**（[src/ui/ObsidianT3CodeView.ts](../src/ui/ObsidianT3CodeView.ts)、[styles.css](../styles.css)）：修复流式结束重建 DOM 行导致的闪烁、`wasNearBottom` 捕获时机、`.t3c-mp-filter` 焦点/光标保留、待确认横幅按标签页隔离与关闭清理，以及 `.obsidian-t3-code` 前缀覆盖 Obsidian 原生按钮/输入框/权限弹层溢出与高亮样式。
  - **部署与回滚自动化 + 发布文档**：新增 [scripts/deploy-obsidian.ps1](../scripts/deploy-obsidian.ps1)、[scripts/rollback-obsidian.ps1](../scripts/rollback-obsidian.ps1)（含 SHA-256 双重核验、`data.json` 无损保留、失败自动恢复及 Windows PowerShell 5.1 单备份兼容修复）、[CHANGELOG.md](../CHANGELOG.md) 与 [M7/M8 验收报告](releases/2026-11-28-m7-m8-acceptance-report.md)。
- **最终代码门禁与实机验收结果（均在最终一次编辑后实跑通过）**：
  - `npm run typecheck`：退出码 `0`
  - `npm run lint`（`eslint . --max-warnings=0`）：退出码 `0`
  - `npm run test:coverage`：**`23` 个测试文件 / `119` 条测试全过**（总覆盖率 **`89.3%` Stmts / `81.87%` Branch / `91.64%` Funcs**）
  - `npm run build` + `verify-bundle.mjs`：`main.js` **`150,112` 字节**（`< 204,800` 上限，`SHA256=5E2C348F...`）、`styles.css` **`23,524` 字节**、`manifest.json` **`303` 字节**
  - 独立 Code Review（`bc88412f-2d19-44ab-baf1-d7234b54c4fb`）：`0` Critical、`4` High（`H1`–`H4`）、`7` Medium（`M1`–`M7`）、`5` Low（`L1`–`L5`），全部 High/Medium 及关键 Low 均已闭环。
  - 隔离 Obsidian Desktop `1.15.1`（`--user-data-dir` + CDP `9239`）第 1–8 步全量通过：`1s` 完成 RPC 自动建连、161 模型搜索与刷新保焦点、`18` 次流式增量 + 表格/代码复制/KaTeX 渲染 + `23,943 / 950,000` (`3%`) 实时用量、权限同步及弹层无溢出、`680px` 宽双栏与浅色 `moonstone` 主题、`dataviewjs-canary` + `MarkdownRenderer.render` 前置净化验证通过（`0` 执行/`0` 危险节点）、上滑读历史滚动锁与 mid-stream Stop、双 Leaf 生命周期与 **`0` 条未吊销残留 `t3-codian` 会话**。
  - 模拟 Vault 部署与 Windows PowerShell 5.1 单备份回滚闭环全绿；对 `E:\Documents\Obsidian-Vault` 只读 `-DryRun` 确认旧 `data.json`（`cliPath, projectPath, provider, model, includeNote, projectId`）可无损继承。
- **生产 Vault 部署实录（2026-11-28 20:58）**：
  - 部署目标：`E:\Documents\Obsidian-Vault\.obsidian\plugins\t3-codian`
  - 备份目录：`C:\Users\Administrator\AppData\Local\T3-Codian\backups\t3-codian-20261128-205848-448`（已完整备份旧版 `main.js` 192,306 B、`styles.css` 18,576 B、`manifest.json` 303 B、`data.json` 249 B 及 `backup-manifest.json`）
  - 产物核验：`main.js`（`150,112` B，`SHA256=5E2C348FB160737CCCCAC6E35096E04C0648BBDDC12C3B908FF0177A43445F1A`）、`manifest.json`（`303` B，`SHA256=84148C0A62FC2A1347C938856BAA84AAB122E7EB0F74E86E7483EECB7BDEFCE0`）、`styles.css`（`23,524` B，`SHA256=4B563F6AEC411699B8B33AB7D210F36B844BDC44F6F851E39CBDC4232E517CE3`），`data.json`（`249` B）原样保留未改动。
- **待办**：用户在 Obsidian 中关闭/重新开启（或重载）**T3-Codian** 插件即可激活新版侧栏；后续按需决定何时推送分支或发起 PR 合并到 `main`。
