# RPC First + CLI Fallback 实施计划（待用户审阅确认）

> 本文档对应 [ADR-0003](../../adr/0003-rpc-first-cli-fallback.md)，涵盖从统一后端抽象到全能力接入、降级兜底与回归验证的分阶段实施计划。**当前处于审阅阶段，尚未修改 `src/` 与 `tests/` 生产代码。**

---

## 0. 开工前需用户拍板的 2 个前置决策 (M0)

1. **打包体积余量方案（`main.js` 当前 `192,306 / 204,800` 字节，仅余 `12,494` 字节）**：
   - **方案 1（推荐）**：在 M1/M2 前先将消息渲染（`src/ui/markdown.ts`）从内置 `markdown-it` + `highlight.js`（合计占 **`136,501` 字节 / 71.0%**）迁移到 Obsidian 原生 `MarkdownRenderer.render()`，直接释放约 `136 KB` 预算并复用 Obsidian 主题代码块与内置清洗；
   - **方案 2**：保留自定义 `markdown-it` 管线，将 `scripts/bundlePolicy.mjs` 的 `MAX_BUNDLE_BYTES` 上调（例如 260 KB）。
2. **默认鉴权接入优先级**：
   - **方案 A（推荐，面向当前桌面版）**：主路径采用严格 14 行 `t3.cmd` Launcher 解析 + `t3 auth session issue`（仅申请 `orchestration:read orchestration:operate`，关闭卸载时 `revoke`），同时在插件设置保留「手动配对码 `/oauth/token`」作为高级/无 CLI 备选；
   - **方案 B**：优先要求用户在设置贴入一次性配对码兑换 30 天 Bearer Token 并存入 `localStorage`。

---

## 1. 分阶段实施路线与验收标准 (TDD)

### M1：`T3Backend` 抽象、`T3Store` 与 `CliBackend` 无损迁出
- **目标文件**：
  - 新增 `src/t3/backend.ts`（统一接口、能力模型、统一域类型、错误分类）
  - 新增 `src/t3/store.ts`（可订阅状态容器：providers / threads / activeDetail / usage / requests / connectionState）
  - 新增 `src/t3/cli-backend.ts`（包装现有 `src/t3/cli.ts` `CliChat`，实现 `T3Backend` 只读降级能力）
  - 改造 `src/ui/ObsidianT3CodeView.ts` 经 `T3Backend` + `T3Store` 驱动，不直接耦合 CLI 命令参数
  - 保留并扩展 `tests/sidebar-view.test.ts` 与新增 `tests/backend-cli.test.ts`
- **验收标准**：
  - 先写 `CliBackend` 与 `T3Store` 单测再实现；
  - 既有 V2 UI 全部交互保持一致，全部现有 15 个测试套件及新增测试 **100% 通过**。

### M2：协议 v2 服务发现、鉴权器与轻量 Effect-RPC 传输层
- **目标文件**：
  - 新增 `src/t3/discovery.ts`：回环 `origin` 校验、读取 `<T3CODE_HOME>/userdata/server-runtime.json`、探测 `GET /.well-known/t3/environment`（强制校验 `orchestrationProtocolVersion === 2` 与 capabilities 解析）
  - 新增 `src/t3/auth.ts`：严格 14 行 `t3.cmd` Launcher 解析（无 shell）、`t3 auth session issue/revoke`、`/oauth/token` 配对兑换、设备本地 Token 存取与错误脱敏
  - 升级 `src/t3/rpc.ts`：保留现有单元测试覆盖，补齐流式 `subscribe(tag, payload, onChunk)`、`{ _tag: 'Ack', requestId }` 背压回执（严防 8-chunk 窗口阻塞）、`Interrupt` 退订、`Effect v4 Cause` 数组错误解析（`Fail`/`Die`/`Interrupt`）、`Ping`/`Pong` 心跳
  - 新增 `src/t3/protocol-v2.ts`：HTTP v2 请求封装（自动附带 `x-t3-orchestration-protocol: 2` + `Authorization: Bearer`）、线格式规范化与容错解析、`contextUsage` 三级优先级提取、`usageLimits` 诚实解析、`optionDescriptors` 识别
  - 单元测试：`tests/discovery.test.ts`、`tests/auth.test.ts`、`tests/rpc.test.ts`、`tests/protocol-v2.test.ts`
- **验收标准**：
  - `src/t3/rpc.ts` 与 `src/t3/protocol-v2.ts` 测试覆盖率达到 **100%**；
  - 协议 v1 服务端明确拒连并降级；日志与错误对象经脱敏测试验证不含任何 Bearer Token 或 `wsTicket`。

### M3：`RpcBackend` 只读/订阅实现与 `T3BackendManager` 自动降级
- **目标文件**：
  - 新增 `src/t3/rpc-backend.ts`（首阶段实现 connect、capabilities、`server.getConfig` + `subscribeServerConfig`、`/api/orchestration/shell` + `?resumeFrom=` + `orchestration.subscribeShell`、`/api/orchestration/threads/:id/bounded` + `orchestration.subscribeThread`）
  - 新增 `src/t3/backend-manager.ts`（`RpcBackend -> CliBackend` 自动切换路由器、指数退避+抖动重连、`afterSequence` 增量追平与 `snapshot-required` 回退、跨客户端同步事件派发、Vault `realpath` 安全门卫）
  - 测试：`tests/rpc-backend.test.ts`、`tests/backend-manager.test.ts`（模拟断连重连、8-chunk Ack 窗口、未知事件序列前移、WS 失效降级 CLI）
- **验收标准**：
  - 本机连入真实 T3 Server 时可列出全部就绪 Agent（`codex` / `claudeAgent` / `antigravity` 等）与完整模型列表；
  - 关闭 T3 Server 或注入协议 != 2 时自动切至 `CliBackend` 保持基础读写可用，且切换过程不丢失用户输入框草稿与选定标签。

### M4：`RpcBackend` 写操作、确定性幂等防重与审批响应
- **目标文件**：
  - 扩展 `src/t3/rpc-backend.ts` 与 `src/t3/store.ts`：
    - 会话创建与首条消息：`thread.create` / `message.dispatch` 携带稳定 UUIDv4 `commandId` 与 `messageId`，写前持久化 pending 状态并在重连后仅同 ID 重放或先读核对，绝不产生重复消息
    - 任务停止：`capabilities.threadStop` 时发 `thread.stop`，否则 `run.interrupt`（`holdQueue: true`）
    - 会话内变更：`thread.model-selection.set`、`thread.runtime-mode.set`、`thread.interaction-mode.set`
    - 审批与提问响应：`runtime-request.respond`（按 `responseCapability` 判断是否允许传 `feedback`，杜绝非 `decline` 或不支持时报错）
    - **Vault 强制防线**：当工作区目录 `realpath` 与当前 Vault 重叠时，后端路由层前置拦截所有非 `approval-required` 发送，并禁止前端触发切换到 `full-access` / `auto`
  - 测试：扩展 `tests/rpc-backend.test.ts`（同 `commandId` 重放、Vault 重叠提权拦截、不支持 feedback 的审批校验）
- **验收标准**：
  - 模拟发出 `message.dispatch` 后立刻断网重连，验证仅用原 `commandId` 检查/重试且不会产生第 2 条消息；
  - 全部写操作受 Vault 安全矩阵单元测试保护。

### M5：动态能力驱动 V2 侧栏 UI 联动
- **目标文件**：
  - 更新 `src/ui/sidebar-model.ts`、`src/ui/ObsidianT3CodeView.ts`、`styles.css`、`src/settings-tab.ts`
  - 功能点：
    1. 三列 `Agent · 模型 · 思考度` 弹层：RPC 模式下自动展示本机全部就绪 Agent、模型筛选及真实思考度级别（兼容 `reasoningEffort` / `effort` / `thought_level`），并支持切换其他可透传选项（如布尔快捷开关）；支持 `supportsMidThreadModelSwitch` 时解除已有会话锁定可直接切模型（仍对不兼容权限做拦截提醒）。
    2. 240° SVG 用量圆弧仪表与弹层：接入真实 `ContextUsageSnapshot`（百分比 + input/cached/output/reasoning 明细）与 `AccountQuotaSnapshot`；遇到 `unsupported` / `null` / 降级 `CliBackend` 时保持诚实未知提示。
    3. 流式输出与 Stop 按钮：收到 `message.updated (streaming: true)` 增量更新，运行中在发送/停止位显示停止按钮；支持 `supportsRuntimeModeSwitch` 时在权限弹层提供合法模式切换按钮；收到 `pending` 审批请求时渲染内联安全审批卡片。
    4. CLI 降级指示：保持零内部顶栏极简原则，仅在处于 CLI 降级模式或 RPC 异常时通过非侵入横幅/设置提示告知并提供「重试 RPC」入口。
- **验收标准**：
  - `src/ui/sidebar-model.ts` 保持 **100%** 单测覆盖率；
  - `tests/sidebar-view.test.ts` 覆盖 RPC 全能力模式、配额不支持诚实降级、流式 Stop、内联审批拒绝与 `CliBackend` 降级模式 UI 联动。

### M6：全量回归验证、真机 Scratch Smoke、独立审查与状态更新
- **检查命令（全部工作区变更后执行）**：
  - `npm run typecheck`（0 错误）
  - `npm run lint`（`eslint . --max-warnings=0`，0 警告）
  - `npm run test:coverage`（核心契约、RPC、状态与模型模块达标且无任何跳过测试）
  - `npm run build`（`scripts/verify-bundle.mjs` 通过，包体积在约定阈值内）
- **实机验证**：在隔离 `No project` scratch 执行一轮端到端只读+写+停止+安全拒绝+清理测试；检查 `t3 auth session list` 零残留调试 session。
- **收尾规范**：
  - 调用独立只读 Code Review 子 Agent 审查完整 diff 并闭环修复；
  - 同步更新 `docs/STATUS.md`；在独立特性分支本地提交，不擅自 Push 或合并到 `main`。

---

## 2. 风险与缓解措施

| 风险 | 影响 | 缓解策略 |
| :--- | :--- | :--- |
| `main.js` 体积逼近 200 KB 上限 | 阻断构建校验 | 在 M0 确认迁移 `MarkdownRenderer`（省 ~136 KB）或调整 `bundlePolicy.mjs` 阈值 |
| T3 Code 夜间版本协议细节演进 | 增量事件字段缺失或新增未知类型 | 参考 `t3code` 客户端策略：`unknown-event` 仍递增游标；序列断层回落 HTTP `bounded` / WS `snapshot` |
| 某些 Provider 不回报 `usageLimits` 或思考度不带 `role` | UI 错判能力或显示假数据 | 按真实属性与 `status: 'unsupported'` 显式建模，思考度按 ID 白名单+`role` 联合识别 |
| 重连并发引发重复发送 | 对话出现重复消息 | UI 到后端全链路携带单次操作 `commandId`/`messageId`，断线重试前校验服务端回执与快照 |
| 真实 Obsidian Vault 误修改或权限失控 | 笔记数据损坏风险 | `T3BackendManager` 统一加装 `realpath` 重叠拦截与 `approval-required` 护栏，严禁注入自动执行授权 |
