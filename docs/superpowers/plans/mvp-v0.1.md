# T3-Codian MVP v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个轻量、安全、原生的 Obsidian 插件，将本地 T3 Code 的多智能体编排与 Codex 编程 Agent 接入 Obsidian 侧边栏，支持自动上下文感知、流式推理对话与一键内容采纳回流。

**Architecture:** 采用“轻量客户端，后端重计算”架构，插件作为纯前端客户端通过 HTTP 探测与 WebSocket JSON-RPC 2.0（T3 Orchestrator V2 协议）直连本地 T3 Code 实例（默认 `http://127.0.0.1:3425`）。UI 依托 Obsidian 原生 DOM API 与 MarkdownRenderer 构建，杜绝重型进程与 WebView 依赖；Vault 访问严格遵循只读探测与显式光标回写，保障用户笔记零污染。

**Tech Stack:** TypeScript 5.x (`strict: true`), Obsidian Plugin API, esbuild, vitest, 原生 fetch & WebSocket, `@noble/hashes` (轻量纯 JS SHA-256 用于 DPoP 签名)。

**Spec:** [docs/PRD.md](file:///E:/Projects/T3-Codian/docs/PRD.md), [docs/ARCHITECTURE.md](file:///E:/Projects/T3-Codian/docs/ARCHITECTURE.md), [docs/TESTING.md](file:///E:/Projects/T3-Codian/docs/TESTING.md), [docs/adr/0001-integration-architecture.md](file:///E:/Projects/T3-Codian/docs/adr/0001-integration-architecture.md)

## Global Constraints

- 严禁在 Obsidian 插件内部派发独立 Node 子进程启动 T3 Server，纯网络客户端直连。
- 严禁静默或后台篡改用户 Vault 中的任何 Markdown 笔记，所有回写必须经由用户显式点击触发并通过 `editor.replaceRange` 纳入原生撤销栈（Ctrl+Z）。
- 插件打包产物仅为单文件 `main.js`（以及可选 `styles.css` 和 `manifest.json`），体积必须控制在 `< 200KB`。
- 本地通信仅允许绑定并访问本地回环网络（`127.0.0.1` / `localhost`），禁止向非受信任的公网端点外泄笔记内容。
- 协议必须严格遵循 T3 Orchestrator V2 规范（`orchestrationProtocolVersion === 2`）。
- 编码必须遵循 TDD 循环：红灯用例 -> 最小实现 -> 绿灯验证 -> 重构 -> 提交。

## Review Focus

- **Input/Condition 1: T3 Code 未开启或端口拒绝连接**  
  *Expected:* 侧边栏渲染友好引导卡片提示“T3 Code 未运行”，展示重试按钮与启动指引，不抛出未捕获错误，阻断消息发送。  
  *Owning Task:* Task 3 & Task 6.
- **Input/Condition 2: 用户在未打开任何 Markdown 笔记时点击“插入到光标处”**  
  *Expected:* 弹窗友好警告“当前未打开活动笔记”，拦截写入操作，不破坏剪贴板与编辑器状态。  
  *Owning Task:* Task 8.
- **Input/Condition 3: 活动笔记正文超出最大限制（> 8000 字符）**  
  *Expected:* 上下文提取器自动截取前 8000 字符并附加 `[...截断提示...]`，UI 给出轻量视觉提示，不发生请求溢出或卡死。  
  *Owning Task:* Task 5.
- **Input/Condition 4: 模型生成中途用户点击“停止生成”或关闭侧边栏标签页**  
  *Expected:* 立即发送 `turn/interrupt` 协议通知，前端终止动画，保留已流式生成的回答片段并标明状态，零句柄泄漏。  
  *Owning Task:* Task 4 & Task 7.
- **Input/Condition 5: T3 服务端下发畸变 JSON 或非协议字段**  
  *Expected:* 流式解码器安全忽略未知字段与畸变包并记录告警日志，不使界面白屏或崩溃。  
  *Owning Task:* Task 4.

---

## 阶段一：计划拆解 (Task Decomposition)

### Task 1: 工程基础设施与 Obsidian 插件脚手架 (Scaffolding & Engineering Infrastructure)

**目标:** 建立完整的 TypeScript、esbuild 构建、ESLint、Vitest 测试套件、GitHub Actions CI/Release 流水线及基础插件骨架，形成可独立运行的验证门禁。  
**依赖:** 无  
**修改范围:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.config.mjs`
- Create: `eslint.config.mjs`
- Create: `vitest.config.mts`
- Create: `manifest.json`
- Create: `src/main.ts`
- Create: `tests/__mocks__/obsidian.ts`
- Create: `tests/smoke.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: 构建产物 `main.js`；可供所有测试套件引用的 `tests/__mocks__/obsidian.ts`。

- [ ] **Step 1: 编写失败的脚手架验证测试**
  在 `tests/smoke.test.ts` 中编写测试，验证 `T3CodianPlugin` 能从 `src/main.ts` 导出并能在 Mock Obsidian 环境中完成基本实例化：
  ```typescript
  import { describe, it, expect } from 'vitest';
  import T3CodianPlugin from '../src/main';
  import { App, PluginManifest } from 'obsidian';

  describe('T3CodianPlugin Scaffold Smoke', () => {
    it('initializes cleanly in mock environment', () => {
      const app = new App();
      const manifest: PluginManifest = {
        id: 't3-codian',
        name: 'T3-Codian',
        version: '0.1.0',
        minAppVersion: '1.5.0',
        description: 'T3 Code Agent integration for Obsidian',
        author: 'T3-Codian Team',
      };
      const plugin = new T3CodianPlugin(app, manifest);
      expect(plugin).toBeDefined();
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL（文件不存在或模块未安装）。

- [ ] **Step 3: 配置工程配置文件并实现最小化脚手架**
  - 创建 `package.json`（定义 `build`, `dev`, `lint`, `typecheck`, `test` 脚本）；
  - 配置 `tsconfig.json`（开启 `strict: true`, `target: ES2022`, `moduleResolution: bundler`）；
  - 配置 `esbuild.config.mjs`（输出单一文件 `main.js`，外部化 `obsidian`）；
  - 配置 `eslint.config.mjs`、`vitest.config.mts`；
  - 创建 `manifest.json` 符合 Obsidian 插件元数据规范；
  - 创建 `tests/__mocks__/obsidian.ts`（Mock `App`, `Plugin`, `ItemView`, `Workspace`, `Editor` 等基本结构）；
  - 在 `src/main.ts` 中实现最小导出类 `T3CodianPlugin extends Plugin`；
  - 配置 `.github/workflows/ci.yml`（执行依赖安装、Typecheck、Lint、单元测试、构建产物检查）。

- [ ] **Step 4: 运行全套门禁命令确认通过**
  运行：
  ```bash
  npm run typecheck
  npm run lint
  npm test
  npm run build
  ```
  预期：全部 PASS，根目录产出体积 `< 50KB` 的 `main.js`。

- [ ] **Step 5: 提交**
  ```bash
  git add .
  git commit -m "chore: scaffold engineering infrastructure and basic plugin entry"
  ```

**验收标准:**
1. `npm run typecheck` 零错误通过；
2. `npm run lint` 零告警通过；
3. `npm test` 测试绿灯通过；
4. `npm run build` 正确生成 `main.js` 且体积小于 200KB。  
**预计复杂度:** 中等（配置项与 Mock 较多）  
**主要风险:** esbuild 外部化配置不当导致打包 `obsidian` 运行时模块。

---

### Task 2: 插件配置与持久化存储 (Settings & Storage Store)

**目标:** 建立类型安全、带默认值回退的持久化配置系统与设置面板。  
**依赖:** Task 1  
**修改范围:**
- Create: `src/settings/types.ts`
- Create: `src/settings/defaultSettings.ts`
- Create: `src/settings/T3CodianSettingTab.ts`
- Create: `tests/settings/settings.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface T3CodianSettings {
    serverUrl: string;          // 默认: "http://127.0.0.1:3425"
    autoAttachContext: boolean; // 默认: true
    maxContextLength: number;   // 默认: 8000
    defaultProvider: string;    // 默认: "codex"
    defaultModel: string;       // 默认: ""
  }
  export const DEFAULT_SETTINGS: T3CodianSettings;
  ```

- [ ] **Step 1: 编写配置读取、合并与校验的失败测试**
  在 `tests/settings/settings.test.ts` 中：
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { reconcileSettings, validateServerUrl } from '../../src/settings/defaultSettings';

  describe('Settings Reconciliation', () => {
    it('applies defaults for missing fields', () => {
      const loaded = { serverUrl: 'http://127.0.0.1:9999' };
      const settings = reconcileSettings(loaded);
      expect(settings.serverUrl).toBe('http://127.0.0.1:9999');
      expect(settings.autoAttachContext).toBe(true);
      expect(settings.maxContextLength).toBe(8000);
      expect(settings.defaultProvider).toBe('codex');
    });

    it('rejects invalid or unsafe server URLs', () => {
      expect(validateServerUrl('http://127.0.0.1:3425')).toBe(true);
      expect(validateServerUrl('http://localhost:3425')).toBe(true);
      expect(validateServerUrl('https://evil.external.com')).toBe(false);
      expect(validateServerUrl('invalid-url')).toBe(false);
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL。

- [ ] **Step 3: 实现配置模型与设置界面**
  - 在 `src/settings/types.ts` 中声明 `T3CodianSettings` 接口；
  - 在 `src/settings/defaultSettings.ts` 中实现 `DEFAULT_SETTINGS`、`reconcileSettings()` 与本地回环 URL 校验器 `validateServerUrl()`；
  - 在 `src/settings/T3CodianSettingTab.ts` 中实现继承自 `PluginSettingTab` 的设置页，绑定各配置项输入与保存操作；
  - 在 `src/main.ts` 的 `onload()` 中加载配置（`loadData`）并注册 `SettingTab`。

- [ ] **Step 4: 运行测试验证通过**
  运行：`npm test`  
  预期：PASS。

- [ ] **Step 5: 提交**
  ```bash
  git add src/settings/ tests/settings/ src/main.ts
  git commit -m "feat(settings): add typed settings store and setting tab"
  ```

**验收标准:**
1. 配置缺失字段自动补充默认值，不覆盖已保存的有效项；
2. 非本地回环地址（如外网不可信地址）被安全拦截校验；
3. `SettingTab` 正确挂载到 Obsidian 设置面板。  
**预计复杂度:** 低  
**主要风险:** 用户输入带末尾斜杠（`/`）的 URL 未做规范化处理。

---

### Task 3: T3 Code 健康探测与连接状态机 (T3 Probe & Connection Manager)

**目标:** 实现对本地 T3 Code 服务端（`/.well-known/t3/environment`）的健康探测、协议版本检查与带指数退避的状态机管理器。  
**依赖:** Task 2  
**修改范围:**
- Create: `src/connection/types.ts`
- Create: `src/connection/ConnectionFSM.ts`
- Create: `src/connection/T3EnvironmentProbe.ts`
- Create: `src/connection/T3ConnectionManager.ts`
- Create: `tests/connection/ConnectionFSM.test.ts`
- Create: `tests/connection/T3EnvironmentProbe.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export enum ConnectionStatus {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Reconnecting = 'reconnecting',
    Error = 'error',
  }
  export interface T3EnvironmentDescriptor {
    environmentId: string;
    label: string;
    orchestrationProtocolVersion: number;
  }
  export class T3ConnectionManager {
    readonly status: ConnectionStatus;
    probe(serverUrl: string): Promise<T3EnvironmentDescriptor>;
    connect(serverUrl: string): Promise<void>;
    disconnect(): void;
    onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
  }
  ```

- [ ] **Step 1: 编写连接状态机与探测逻辑失败测试**
  在 `tests/connection/ConnectionFSM.test.ts` 中编写测试：
  ```typescript
  import { describe, it, expect, vi } from 'vitest';
  import { ConnectionFSM } from '../../src/connection/ConnectionFSM';
  import { ConnectionStatus } from '../../src/connection/types';

  describe('ConnectionFSM', () => {
    it('transitions from Disconnected -> Connecting -> Connected', () => {
      const fsm = new ConnectionFSM();
      expect(fsm.status).toBe(ConnectionStatus.Disconnected);
      fsm.transition(ConnectionStatus.Connecting);
      expect(fsm.status).toBe(ConnectionStatus.Connecting);
      fsm.transition(ConnectionStatus.Connected);
      expect(fsm.status).toBe(ConnectionStatus.Connected);
    });

    it('calculates exponential backoff delay within bounds', () => {
      const fsm = new ConnectionFSM();
      expect(fsm.getBackoffDelay(0)).toBe(1000);
      expect(fsm.getBackoffDelay(1)).toBe(2000);
      expect(fsm.getBackoffDelay(2)).toBe(4000);
      expect(fsm.getBackoffDelay(5)).toBe(15000); // capped at 15s
    });
  });
  ```
  在 `tests/connection/T3EnvironmentProbe.test.ts` 中编写 HTTP 探测与版本校验测试（支持协议版本 2 正常通过，版本不匹配或端口拒绝时抛出特定异常）。

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL。

- [ ] **Step 3: 实现环境探测器与连接状态机**
  - 在 `src/connection/ConnectionFSM.ts` 中实现有限状态机与指数退避延迟计算；
  - 在 `src/connection/T3EnvironmentProbe.ts` 中使用标准 `fetch` 请求 `GET /.well-known/t3/environment`，校验响应体并提取 `orchestrationProtocolVersion === 2`；
  - 在 `src/connection/T3ConnectionManager.ts` 中编排探测、状态广播与退避重试流程。

- [ ] **Step 4: 运行测试验证通过**
  运行：`npm test`  
  预期：PASS。

- [ ] **Step 5: 提交**
  ```bash
  git add src/connection/ tests/connection/
  git commit -m "feat(connection): implement T3 environment probe and connection state machine"
  ```

**验收标准:**
1. 状态机在探测前为 `disconnected`，探测中为 `connecting`，成功为 `connected`；
2. 服务端离线或返回非 200 时，平稳转入 `error` / `reconnecting` 并不抛出全局未捕获异常；
3. 协议版本非 2 时明确抛出 `ProtocolMismatchError`。  
**预计复杂度:** 中等  
**主要风险:** Windows 本地防火墙或代理导致 `127.0.0.1` 路由至外部网关（需确保强制直连）。

---

### Task 4: T3 WebSocket 协议客户端与流式解码器 (T3 WebSocket Client & Stream Decoder)

**目标:** 建立基于 Web 标准 WebSocket 的 JSON-RPC 2.0 通信链路，支持请求应答、`turn/start` 派发、`item/append` 流式事件解码与 `turn/interrupt` 中断。  
**依赖:** Task 3  
**修改范围:**
- Create: `src/protocol/types.ts`
- Create: `src/protocol/JSONRPC.ts`
- Create: `src/protocol/StreamDecoder.ts`
- Create: `src/protocol/T3WebSocketClient.ts`
- Create: `tests/protocol/StreamDecoder.test.ts`
- Create: `tests/protocol/T3WebSocketClient.test.ts`

**Interfaces:**
- Consumes: `src/connection/types.ts`
- Produces:
  ```typescript
  export interface StreamEvent {
    type: 'delta' | 'thought' | 'completed' | 'interrupted' | 'error';
    text?: string;
    error?: string;
    turnId?: string;
  }
  export class T3WebSocketClient {
    connect(wsUrl: string): Promise<void>;
    disconnect(): void;
    sendTurnStart(params: { threadId: string; prompt: string; provider?: string; model?: string }): Promise<{ turnId: string }>;
    interruptTurn(turnId: string): Promise<void>;
    onStreamEvent(listener: (event: StreamEvent) => void): () => void;
  }
  ```

- [ ] **Step 1: 编写流式解码器与客户端失败测试**
  在 `tests/protocol/StreamDecoder.test.ts` 中编写测试：
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { StreamDecoder } from '../../src/protocol/StreamDecoder';

  describe('StreamDecoder', () => {
    it('decodes item/append text delta frames', () => {
      const decoder = new StreamDecoder();
      const frame = JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/append',
        params: { delta: 'Hello from Codex' }
      });
      const event = decoder.decode(frame);
      expect(event?.type).toBe('delta');
      expect(event?.text).toBe('Hello from Codex');
    });

    it('safely handles malformed json without throwing', () => {
      const decoder = new StreamDecoder();
      const event = decoder.decode('{ invalid-json');
      expect(event).toBeNull();
    });
  });
  ```
  在 `tests/protocol/T3WebSocketClient.test.ts` 中通过 Node 内置 `ws` 搭建微型 Mock WebSocket Server，验证连通握手、`turn/start` 消息发送及接收事件分发。

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL。

- [ ] **Step 3: 实现 JSON-RPC 包装器、增量解码器与 WebSocket 客户端**
  - 在 `src/protocol/JSONRPC.ts` 中实现符合 JSON-RPC 2.0 规范的 `createRequest`、`createNotification` 与响应匹配器；
  - 在 `src/protocol/StreamDecoder.ts` 中对服务端推送的 `item/append`、`turn/completed`、`turn/interrupted` 等通知进行规范化解析；
  - 在 `src/protocol/T3WebSocketClient.ts` 中封装原生 WebSocket 连接管理与消息收发。

- [ ] **Step 4: 运行测试验证通过**
  运行：`npm test`  
  预期：PASS。

- [ ] **Step 5: 提交**
  ```bash
  git add src/protocol/ tests/protocol/
  git commit -m "feat(protocol): implement T3 WebSocket client and stream decoder"
  ```

**验收标准:**
1. 正确封装 JSON-RPC 2.0 请求（附带自增 `id` 与协议头）；
2. 准确解析流式文本片断与轮次完成通知；
3. 遭遇畸形 JSON 帧能够优雅容错，不抛出 Uncaught Exception。  
**预计复杂度:** 中等  
**主要风险:** WebSocket 连接在空闲时被服务端心跳超时掐断（需支持基本 ping/pong 保活探测）。

---

### Task 5: 活动笔记与选区上下文提取器 (Editor Context Bridge & ContextBuilder)

**目标:** 安全提取当前活动 MarkdownView 的文件标题、路径及选中文本，支持空选区回退、长文本智能截断（8000 字符）与 Markdown 引用安全包装。  
**依赖:** Task 1  
**修改范围:**
- Create: `src/context/types.ts`
- Create: `src/context/ContextBuilder.ts`
- Create: `src/context/EditorContextBridge.ts`
- Create: `tests/context/ContextBuilder.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface NoteContext {
    filePath: string;
    title: string;
    selectedText: string;
    hasSelection: boolean;
    rawContent: string;
  }
  export class ContextBuilder {
    constructor(private readonly maxChars: number = 8000) {}
    formatPromptWithContext(userPrompt: string, context?: NoteContext): string;
    truncate(text: string): { text: string; truncated: boolean };
  }
  ```

- [ ] **Step 1: 编写上下文组装与截断逻辑的失败测试**
  在 `tests/context/ContextBuilder.test.ts` 中编写测试：
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { ContextBuilder } from '../../src/context/ContextBuilder';
  import { NoteContext } from '../../src/context/types';

  describe('ContextBuilder', () => {
    it('wraps selected text into markdown quote block when selection exists', () => {
      const builder = new ContextBuilder(8000);
      const ctx: NoteContext = {
        filePath: 'Notes/Tech.md',
        title: 'Tech',
        selectedText: 'const x = 1;',
        hasSelection: true,
        rawContent: 'full content'
      };
      const result = builder.formatPromptWithContext('Explain this code', ctx);
      expect(result).toContain('> const x = 1;');
      expect(result).toContain('Explain this code');
      expect(result).toContain('Notes/Tech.md');
    });

    it('truncates content exceeding maxChars with visual indicator', () => {
      const builder = new ContextBuilder(100);
      const longText = 'A'.repeat(200);
      const { text, truncated } = builder.truncate(longText);
      expect(truncated).toBe(true);
      expect(text.length).toBeLessThan(150);
      expect(text).toContain('[...上下文已截断...');
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL。

- [ ] **Step 3: 实现 ContextBuilder 与 EditorContextBridge**
  - 在 `src/context/ContextBuilder.ts` 中实现提示词装配、字符限制截断与代码块安全转义；
  - 在 `src/context/EditorContextBridge.ts` 中封装对 Obsidian `Workspace.getActiveViewOfType(MarkdownView)` 的安全只读探测。

- [ ] **Step 4: 运行测试验证通过**
  运行：`npm test`  
  预期：PASS。

- [ ] **Step 5: 提交**
  ```bash
  git add src/context/ tests/context/
  git commit -m "feat(context): implement note context extraction and safe prompt formatting"
  ```

**验收标准:**
1. 有选区时优先引用选区，无选区时引用正文前文；
2. 正文超过 `maxContextLength`（默认 8000）严格执行截断并添加提示；
3. 严格只读调用 Obsidian API，不发起任何修改。  
**预计复杂度:** 低  
**主要风险:** Markdown 中包含未闭合的反引号导致上下文引用格式混乱。

---

### Task 6: 侧边栏原生聊天视图与状态布局 (T3CodianView & UI Layout)

**目标:** 继承 Obsidian `ItemView`，构建零第三方框架依赖、完全适配原生明暗主题的侧边栏视图，包含 Header 状态条、Message Container、Composer 输入区及“服务未连接”引导卡片。  
**依赖:** Task 1, Task 2, Task 3  
**修改范围:**
- Create: `src/ui/types.ts`
- Create: `src/ui/T3CodianView.ts`
- Create: `src/ui/components/HeaderBar.ts`
- Create: `src/ui/components/MessageContainer.ts`
- Create: `src/ui/components/ComposerBar.ts`
- Create: `src/ui/components/OfflineCard.ts`
- Create: `styles.css`
- Create: `tests/ui/T3CodianView.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `src/connection/types.ts`, `src/settings/types.ts`
- Produces: `export const VIEW_TYPE_T3_CODIAN = 't3-codian-chat-view';`

- [ ] **Step 1: 编写视图初始化与 DOM 渲染失败测试**
  在 `tests/ui/T3CodianView.test.ts` 中：
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { T3CodianView, VIEW_TYPE_T3_CODIAN } from '../../src/ui/T3CodianView';
  import { WorkspaceLeaf } from 'obsidian';

  describe('T3CodianView DOM Rendering', () => {
    it('creates header, message container and composer elements', () => {
      const leaf = new WorkspaceLeaf();
      const view = new T3CodianView(leaf);
      expect(view.getViewType()).toBe(VIEW_TYPE_T3_CODIAN);
      view.onOpen();
      const container = view.containerEl;
      expect(container.querySelector('.t3-codian-header')).toBeDefined();
      expect(container.querySelector('.t3-codian-messages')).toBeDefined();
      expect(container.querySelector('.t3-codian-composer')).toBeDefined();
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL。

- [ ] **Step 3: 实现原生 DOM 视图与样式规范**
  - 在 `src/ui/components/HeaderBar.ts` 中实现包含连接红绿指示灯、模型徽章与新会话按钮的头部；
  - 在 `src/ui/components/MessageContainer.ts` 中实现气泡列表容器；
  - 在 `src/ui/components/ComposerBar.ts` 中实现输入文本框（Enter 发送，Shift+Enter 换行）、选区开关复选框与发送/停止按钮；
  - 在 `src/ui/components/OfflineCard.ts` 中实现服务端未就绪时的指引卡片；
  - 在 `styles.css` 中编写高对比度、基于 `--background-primary`、`--text-normal` 等 Obsidian CSS 原生变量的样式；
  - 在 `src/main.ts` 中注册 ViewType 并添加 Ribbon 图标和命令面板入口。

- [ ] **Step 4: 运行测试验证通过**
  运行：`npm test`  
  预期：PASS。

- [ ] **Step 5: 提交**
  ```bash
  git add src/ui/ styles.css tests/ui/ src/main.ts
  git commit -m "feat(ui): create native sidebar chat view with theme-adaptive styles"
  ```

**验收标准:**
1. 侧边栏通过 Ribbon 图标或快捷命令稳定打开；
2. 服务离线时展示友好的 `OfflineCard`，阻断发送按钮；
3. 样式 100% 采用 Obsidian 官方 CSS 变量，亮色与暗色模式无缝自适应。  
**预计复杂度:** 中等  
**主要风险:** Obsidian 更新版本时部分内部 CSS 变量名发生变动（严格采用官方公共变量）。

---

### Task 7: Codex 流式对话控制器与 Markdown 渲染 (TurnController & Streaming Rendering)

**目标:** 串联输入发送、增量接收、节流更新、Markdown 语法渲染（代码高亮）与中途停止（Stop Turn）完整流式闭环。  
**依赖:** Task 4, Task 5, Task 6  
**修改范围:**
- Create: `src/session/types.ts`
- Create: `src/session/TurnController.ts`
- Create: `src/session/SessionController.ts`
- Create: `src/ui/renderers/MarkdownStreamRenderer.ts`
- Create: `tests/session/TurnController.test.ts`
- Create: `tests/session/SessionController.test.ts`

**Interfaces:**
- Consumes: `T3WebSocketClient`, `ContextBuilder`, `MessageContainer`
- Produces:
  ```typescript
  export interface TurnState {
    turnId: string;
    status: 'idle' | 'running' | 'completed' | 'interrupted' | 'error';
    rawMarkdown: string;
  }
  export class SessionController {
    sendPrompt(prompt: string, attachContext: boolean): Promise<void>;
    stopCurrentTurn(): Promise<void>;
    clearConversation(): void;
  }
  ```

- [ ] **Step 1: 编写会话流式流转与中断失败测试**
  在 `tests/session/TurnController.test.ts` 中：
  ```typescript
  import { describe, it, expect, vi } from 'vitest';
  import { TurnController } from '../../src/session/TurnController';

  describe('TurnController', () => {
    it('accumulates stream deltas and triggers throttled update', () => {
      const updateFn = vi.fn();
      const controller = new TurnController({ onTextUpdate: updateFn });
      controller.startTurn('turn-1');
      controller.appendDelta('Hello ');
      controller.appendDelta('World!');
      expect(controller.getFullText()).toBe('Hello World!');
    });

    it('marks state as interrupted upon stop call', () => {
      const controller = new TurnController({});
      controller.startTurn('turn-2');
      controller.interrupt();
      expect(controller.getState().status).toBe('interrupted');
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL。

- [ ] **Step 3: 实现控制器与渲染器**
  - 在 `src/session/TurnController.ts` 中管理单次对话轮次的文本累加、思考链解析与状态切换；
  - 在 `src/session/SessionController.ts` 中串联网络客户端、上下文提供者与 UI 气泡增删；
  - 在 `src/ui/renderers/MarkdownStreamRenderer.ts` 中调用 Obsidian 官方 `MarkdownRenderer.renderMarkdown` 实时呈现富文本与代码高亮。

- [ ] **Step 4: 运行测试验证通过**
  运行：`npm test`  
  预期：PASS。

- [ ] **Step 5: 提交**
  ```bash
  git add src/session/ src/ui/renderers/ tests/session/
  git commit -m "feat(session): implement turn controller and markdown stream renderer"
  ```

**验收标准:**
1. 发送 Prompt 后实时逐字输出，Markdown 列表、粗体、代码块正常着色；
2. 点击“停止生成”向后端发送中断，流式输出立即停止并保留已有文字；
3. 高频 Token 更新采用节流策略，保证 Obsidian 界面不掉帧、不卡死。  
**预计复杂度:** 高  
**主要风险:** 流式渲染中未闭合的代码块导致 Obsidian Markdown 渲染器抛出语法解析异常（做兜底 try-catch 保护）。

---

### Task 8: 会话管理与知识回流采纳 (Session Management & Content Adoption)

**目标:** 实现新建/清空会话功能、一键复制回答到剪贴板，以及将 Agent 生成内容安全回写到当前笔记光标停留处（`editor.replaceRange`，可完美 `Ctrl+Z` 撤销）。  
**依赖:** Task 7  
**修改范围:**
- Create: `src/actions/ContentAdoptionService.ts`
- Create: `tests/actions/ContentAdoptionService.test.ts`
- Modify: `src/ui/components/MessageContainer.ts`
- Modify: `src/ui/T3CodianView.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: Obsidian `Editor`, `Notice`, `Clipboard`
- Produces:
  ```typescript
  export class ContentAdoptionService {
    copyToClipboard(text: string): Promise<boolean>;
    insertAtCursor(editor: Editor | null, text: string): { success: boolean; error?: string };
  }
  ```

- [ ] **Step 1: 编写采纳与光标插入逻辑失败测试**
  在 `tests/actions/ContentAdoptionService.test.ts` 中：
  ```typescript
  import { describe, it, expect, vi } from 'vitest';
  import { ContentAdoptionService } from '../../src/actions/ContentAdoptionService';
  import { Editor } from 'obsidian';

  describe('ContentAdoptionService', () => {
    it('inserts text into editor cursor position cleanly', () => {
      const service = new ContentAdoptionService();
      const mockEditor = {
        getCursor: vi.fn().mockReturnValue({ line: 1, ch: 0 }),
        replaceRange: vi.fn(),
      } as unknown as Editor;

      const result = service.insertAtCursor(mockEditor, 'Generated Note Text');
      expect(result.success).toBe(true);
      expect(mockEditor.replaceRange).toHaveBeenCalledWith('Generated Note Text', { line: 1, ch: 0 });
    });

    it('returns error when no active editor is open', () => {
      const service = new ContentAdoptionService();
      const result = service.insertAtCursor(null, 'Some text');
      expect(result.success).toBe(false);
      expect(result.error).toContain('未打开活动笔记');
    });
  });
  ```

- [ ] **Step 2: 运行测试确认失败**
  运行：`npm test`  
  预期：FAIL。

- [ ] **Step 3: 实现知识回流采纳服务与消息气泡操作条**
  - 在 `src/actions/ContentAdoptionService.ts` 中实现剪贴板写入与编辑器安全光标回写；
  - 在 `src/ui/components/MessageContainer.ts` 的每个 Assistant 消息气泡底栏增加“复制全文”与“插入文档”按钮；
  - 弹出 `new Notice(...)` 提示操作成功或失败拦截。

- [ ] **Step 4: 运行测试验证通过**
  运行：`npm test`  
  预期：PASS。

- [ ] **Step 5: 提交**
  ```bash
  git add src/actions/ tests/actions/ src/ui/ src/main.ts
  git commit -m "feat(adoption): add clipboard copy and undo-safe editor insertion"
  ```

**验收标准:**
1. 点击“复制”成功写入系统剪贴板并弹窗提示；
2. 点击“插入文档”能精确将回答插入当前 Markdown 笔记光标处，且在 Obsidian 中按 `Ctrl+Z` 可一键撤回；
3. 未打开笔记时点击插入触发友好警告，绝不引发未捕获错误。  
**预计复杂度:** 低  
**主要风险:** 多行富文本写入时首尾换行符处理不一致导致笔记格式粘连。

---

## 阶段二：GitHub 管理规划 (Milestone & Issues)

### Milestone: `MVP v0.1 - Minimal Viable Agent Bridge`
- **目标交付物:** T3-Codian 插件核心闭环（连接探测、上下文注入、Codex 流式生成、安全光标回写）。
- **预期发布标签:** `v0.1.0`

### 1. Feature Issues

#### Issue 1: [Feature] 工程基础设施搭建与基础插件脚手架
- **Type:** `feature` | **Labels:** `area:core`, `stage:scaffold`
- **目标:** 建立 TypeScript、esbuild 构建、Vitest 测试套件、ESLint 及 GitHub Actions CI 流水线。
- **验收标准 (Acceptance Criteria):**
  - [ ] `npm run build` 生成符合 Obsidian 格式的 `main.js`；
  - [ ] `npm run typecheck` 零报错；
  - [ ] `npm run lint` 零告警；
  - [ ] `npm test` 通过 Smoke 测试；
  - [ ] GitHub Actions CI 流水线成功跑通。

#### Issue 2: [Feature] 插件配置管理与设置选项卡 (SettingsTab)
- **Type:** `feature` | **Labels:** `area:settings`
- **目标:** 实现 `T3CodianSettings` 数据存储、默认值回退逻辑与本地回环 URL 校验。
- **验收标准:**
  - [ ] 支持配置 T3 Code 服务端地址（默认 `http://127.0.0.1:3425`）；
  - [ ] 设置项持久化保存在 Obsidian `data.json` 中，重启不丢失；
  - [ ] 针对非本地回环地址输入给予拦截或安全警告。

#### Issue 3: [Feature] T3 Code 服务端探测与连接状态机
- **Type:** `feature` | **Labels:** `area:connection`, `protocol:v2`
- **目标:** 探测 `/.well-known/t3/environment`，校验协议版本 2，并实现指数退避重连状态机。
- **验收标准:**
  - [ ] 服务正常运行时状态平稳置为 `connected`；
  - [ ] 服务离线时转为 `disconnected`/`reconnecting`，计算指数退避时间（1s~15s）；
  - [ ] 协议版本不匹配时抛出可捕获的协议版本异常。

#### Issue 4: [Feature] T3 WebSocket 客户端与 JSON-RPC 2.0 流式解码器
- **Type:** `feature` | **Labels:** `area:protocol`, `streaming`
- **目标:** 基于 Web 标准 WebSocket 建立长连接，封装 `turn/start` 请求并解码 `item/append` 增量帧。
- **验收标准:**
  - [ ] 稳定完成 WebSocket 连接与心跳保活；
  - [ ] 正确分发文本增量与完成事件；
  - [ ] 支持发送 `turn/interrupt` 中断生成。

#### Issue 5: [Feature] 活动笔记与选区上下文提取器 (ContextBuilder)
- **Type:** `feature` | **Labels:** `area:context`, `vault-safety`
- **目标:** 从活动编辑页中提取文件元数据与高亮选区，支持截断与 Markdown 引用组装。
- **验收标准:**
  - [ ] 选区存在时精准引用所选文字；
  - [ ] 选区为空时安全回退至全文；
  - [ ] 超出 8000 字符限制时自动截断并附带显著标记。

#### Issue 6: [Feature] 侧边栏原生聊天交互面板 (T3CodianView)
- **Type:** `feature` | **Labels:** `area:ui`, `obsidian-native`
- **目标:** 使用原生 DOM 构建包含 Header、消息区、Composer 的侧边栏视图，适配官方 CSS 变量。
- **验收标准:**
  - [ ] 点击 Ribbon 图标可快速打开/隐藏侧边栏；
  - [ ] 连接指示灯动态反映真实连接状态；
  - [ ] 服务离线时展示醒目的指引卡片并阻断发送。

#### Issue 7: [Feature] Codex 流式对话控制器与 Markdown 渲染
- **Type:** `feature` | **Labels:** `area:streaming`, `agent:codex`
- **目标:** 串联用户输入、流式分词接收与 Obsidian MarkdownRenderer 富文本/代码着色，支持中途打断。
- **验收标准:**
  - [ ] 输入提问后 2 秒内开始逐字渲染回答；
  - [ ] 代码块语法高亮完整可用；
  - [ ] 点击停止按钮能立刻终止流式生成。

#### Issue 8: [Feature] 知识回流采纳：一键复制与安全光标回写
- **Type:** `feature` | **Labels:** `area:adoption`, `vault-safety`
- **目标:** 在气泡底栏提供“复制全文”与“插入文档光标处”，确保操作纳入 Obsidian 原生撤销树。
- **验收标准:**
  - [ ] 复制按钮成功将内容置入系统剪贴板；
  - [ ] 插入按钮通过 `editor.replaceRange` 写入，且按 `Ctrl+Z` 可一键撤回；
  - [ ] 无活动文档时拦截操作并弹出友好警告 Notice。

### 2. Bug Issues (预置追踪模板)

#### Issue 9: [Bug] WebSocket 断线未能在 UI 及时呈现重连状态
- **Type:** `bug` | **Labels:** `bug:connection`
- **验收标准:** 模拟网络中断或服务端退出，侧边栏状态灯在 1 秒内变为红/橙色，重连成功后恢复绿色。

#### Issue 10: [Bug] 未闭合的 Markdown 语法块导致渲染流卡顿
- **Type:** `bug` | **Labels:** `bug:ui`
- **验收标准:** 流式生成过程中的临时未闭合代码块或粗体标签被安全解析包裹，不抛出控制台未捕获错误。

### 3. Documentation Issues

#### Issue 11: [Docs] 编写插件快速上手指引与本地 T3 Code 配置手册
- **Type:** `documentation` | **Labels:** `area:docs`
- **目标:** 在 `README.md` 与 `docs/` 下提供图文安装指引、默认端口配置及常见问题排查。
- **验收标准:**
  - [ ] 明确说明如何启动本地 T3 Code 与 Codex；
  - [ ] 提供解压安装到 Obsidian 测试库的详细步骤。

### 4. Technical Debt Issues

#### Issue 12: [Tech Debt] 构建端到端自动化 Mock Server 集成测试套件
- **Type:** `tech-debt` | **Labels:** `testing:integration`
- **目标:** 在 CI 中启动无头本地 HTTP/WS Mock Server，对完整的消息收发与中断循环做全流程覆盖。
- **验收标准:**
  - [ ] CI 无需依赖实际外部桌面软件即可全自动运行端到端集成测试用例。

---

## 阶段三：工程基础设施设计规范

### 1. 脚本与流水线契约
在 `package.json` 中明确统一标准：
- `npm run build`: 调用 esbuild 打包成单文件 `main.js`；
- `npm run dev`: 监听文件变动并实时打包；
- `npm run typecheck`: 执行 `tsc --noEmit`，零容忍任何类型错误；
- `npm run lint`: 执行 ESLint（含 `@typescript-eslint` 校验）；
- `npm test`: 执行 Vitest 纯内存单测套件；
- `npm run test:coverage`: 输出覆盖率报告。

### 2. GitHub Actions CI 矩阵设计
位于 `.github/workflows/ci.yml`，对每次 Push 与 PR 触发：
```yaml
name: CI
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'
      - name: Install dependencies
        run: npm ci
      - name: Typecheck
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Unit & Integration Tests
        run: npm test
      - name: Build plugin artifact
        run: npm run build
      - name: Verify build artifacts
        run: |
          test -f main.js || exit 1
          test -f manifest.json || exit 1
```

### 3. GitHub Actions Release 流水线设计
位于 `.github/workflows/release.yml`，在发布 Tag（如 `v*`）时触发：
- 自动构建 `main.js` 与 `styles.css`；
- 校验 `manifest.json` 与 `package.json` 的版本号强一致；
- 自动创建 GitHub Release，将 `manifest.json`、`main.js`、`styles.css`（如包含）作为资产打包上传。

---

## 阶段四：发布策略与 Obsidian 官方合规规范

发布前必须严格执行以下六重核对：
1. **`manifest.json` 合规性**：
   - 字段完整包含 `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `isDesktopOnly: true`（涉及本地回环网络）；
2. **`main.js` 纯净度**：
   - 由 esbuild 单独产出，不得包含对外部 `obsidian` 库的硬打包（声明为 external）；
   - 文件大小必须 `< 200KB`；
3. **`styles.css` 主题兼容性**：
   - 仅使用 Obsidian 官方 CSS 变量（`--background-*`, `--text-*`, `--interactive-*`），严禁写死纯黑或纯白十六进制颜色；
4. **版本号一致性 (Version Parity)**：
   - `package.json` 与 `manifest.json` 中的 `version` 必须 100% 保持一致；
5. **`minAppVersion` 设定**：
   - 基线设定为 `1.5.0`，确保具备现代 MarkdownRenderer 与事件流特性；
6. **Release 附件资产**：
   - 每次 Release 必须附带且仅附带 `manifest.json`、`main.js` 与 `styles.css`。

---

## 阶段五：完整 Issue 开发实施顺序表

所有任务必须按照以下单向依赖顺序依次开辟独立特性分支开发，严禁跳步：

| 顺序 | Issue ID | 分支名称 | 核心交付物 | 关键依赖 | 验收门禁 |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **01** | **Issue #1** | `feat/issue-1-plugin-scaffold` | 工程构建、CI/CD、ESLint、Vitest、Obsidian Mock | 无 | `typecheck + lint + test + build` 全通 |
| **02** | **Issue #2** | `feat/issue-2-settings-tab` | 配置持久化与设置面板界面 | Issue #1 | 配置存取与本地回环校验单测通过 |
| **03** | **Issue #3** | `feat/issue-3-connection-fsm` | T3 协议探测与指数退避状态机 | Issue #2 | 状态流转与退避计算单测通过 |
| **04** | **Issue #4** | `feat/issue-4-protocol-client` | WebSocket 传输与 JSON-RPC 2.0 流式解码器 | Issue #3 | Mock WS 增量帧解码通过 |
| **05** | **Issue #5** | `feat/issue-5-context-bridge` | 活动笔记上下文与高亮选区提取器 | Issue #1 | 截断与安全引用单测通过 |
| **06** | **Issue #6** | `feat/issue-6-sidebar-view` | 侧边栏原生 ItemView 与离线引导卡片 | Issue #2, #3 | DOM 结构与样式适配测试通过 |
| **07** | **Issue #7** | `feat/issue-7-streaming-turn` | Codex 流式生成、Markdown 渲染与中途停止 | Issue #4, #5, #6 | 端到端流式渲染与停止逻辑通过 |
| **08** | **Issue #8** | `feat/issue-8-content-adoption` | 剪贴板一键复制与 Ctrl+Z 可撤回的光标回写 | Issue #7 | 撤销安全光标插入单测通过 |
| **09** | **Issue #11** | `docs/issue-11-user-guide` | 插件安装指引与本地 T3 Code 联调文档 | Issue #8 | 文档与测试库实机复核通过 |
| **10** | **Issue #12** | `chore/issue-12-e2e-suite` | 端到端集成测试闭环与 CI 固化 | Issue #8 | 全流程自动集成测试通过 |

---

## 自我审查与一致性核验 (Self-Review Checklist)

1. **Spec coverage (需求覆盖)**:
   - PRD 中 MVP P0 阶段的 7 个核心功能（F-01 至 F-07）全量映射到了 Task 1 至 Task 8。
2. **Step scan (步骤明确度)**:
   - 每个 Task 均遵循 TDD 模式（先写失败用例 -> 确认失败 -> 最小编码 -> 绿灯验证 -> 提交）。
3. **Type consistency (类型与签名一致性)**:
   - `ConnectionStatus`, `T3EnvironmentDescriptor`, `StreamEvent`, `NoteContext`, `T3CodianSettings` 的接口在各 Task 之间保持绝对一致。
4. **Review Focus (核心异常边界覆盖)**:
   - 服务离线、未打开笔记采纳、8000 字符截断、流式中途打断、畸变 JSON 容错均有专属 Task 与单元测试对应。
5. **Proportion (篇幅与深度)**:
   - 结构清晰，聚焦于技术接口、文件路径、执行步骤与命令，杜绝空洞叙述。
