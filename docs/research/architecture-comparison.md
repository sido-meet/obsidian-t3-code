# T3-Codian 技术架构对比与选型评估报告

> **调研对象**：Claudian、T3 Code、t3-obsidian  
> **编写日期**：2026-11-18  
> **责任人**：T3-Codian 技术负责人

---

## 一、8 项核心技术命题深度研究

### 1. T3 Code 如何管理 Codex 会话？
- **源码依据**：
  - `t3code/apps/server/src/provider/Drivers/CodexDriver.ts`
  - `t3code/apps/server/src/provider/Drivers/CodexHomeLayout.ts`
  - `t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`
  - `t3code/packages/effect-codex-app-server/src/client.ts`
- **实现机制**：
  1. **影子环境隔离**：T3 Code 并非直接使用全局 `~/.codex`，而是通过 `materializeCodexShadowHome` 为每个工作区/项目物化一个影子目录（Shadow CODEX_HOME），写入受管的 `config.toml`，避免会话间锁冲突。
  2. **协议接入**：基于 `packages/effect-codex-app-server`，启动 `codex app-server --listen stdio://` 或直接连接 `app-server-control.sock`。
  3. **生命周期映射**：T3 Code 的 `threadId` 严格映射到 Codex 的内部 `threadId`。通过 `V2TurnStartParams` 发起请求，实时消费 Codex 下发的 `turn/completed`、`item/append` 等通知。

---

### 2. T3 Code 如何与其服务端通信？
- **源码依据**：
  - `t3code/apps/server/src/http.ts` 与 `ws.ts`
  - `t3-obsidian/src/connection/direct.ts` 与 `t3-rpc.ts`
- **实现机制**：
  - **控制面（REST）**：
    - `/.well-known/t3/environment`：握手并返回环境信息与协议版本（Orchestration Protocol v2）。
    - `/oauth/token`：Token Exchange 认证发放。
    - `/api/orchestration/dispatch`：会话动作派发。
  - **数据面（WebSocket RPC）**：
    - 路径 `ws://<host>:<port>/api/orchestration/v2`。采用双向 JSON-RPC 2.0，承载文件树投影（`projects.listEntries`、`projects.readFile`）以及实时 Token 与思考链推送。

---

### 3. T3 Code 是否有稳定、可复用的接口？
- **结论**：**是，具备稳定成熟的 Orchestrator V2 协议**。
- **证据**：
  - `T3_PROTOCOL_VERSION = 2` 是跨多个产品（Web、Desktop、t3-obsidian 插件）长期支持的标准协议。
  - 所有请求参数与返回帧在 `packages/contracts` 中均有严格的 `@effect/schema` 类型契约约束。

---

### 4. t3-obsidian 如何连接 T3 Code？
- **源码依据**：`t3-obsidian/src/connection/direct.ts`
- **连接流程**：
  1. 用户在 Obsidian 设置中输入本地地址（如 `http://localhost:<port>`）或远程配对链接；
  2. 插件生成本地 DPoP 密钥对（使用纯 JS 库 `@noble/hashes`），发起 OAuth 令牌交换，获取绑定的 Bearer Token；
  3. 建立 WebSocket 连接，实现笔记内容同步与流式对话。整个过程**不需要在插件内启动任何子进程**。

---

### 5. Claudian 如何接入 Obsidian？
- **源码依据**：
  - `claudian/src/main.ts`
  - `claudian/src/core/process/ManagedStdioProcess.ts`
  - `claudian/src/providers/codex/runtime/CodexLaunchSpecBuilder.ts`
- **接入方式**：
  - **进程内直连**：依靠 Obsidian 桌面端的 Electron 环境，直接使用 Node.js `child_process.spawn` 拉起 `codex app-server --listen stdio://` 或 `agy acp`。
  - 通过标准输入输出管道（stdio）收发 JSON-RPC，会话状态完全自理保存在 Obsidian 本地存储中。

---

### 6. 是否需要在插件中启动独立进程？
- **技术裁定**：
  - **如果走 Claudian 模式**：**必须**启动子进程。缺点是强绑定桌面端（无法支持移动端），且在 Windows 环境下极易受子进程环境变量（`PATH`、WSL 路径转换、Node 孤儿进程）干扰。
  - **如果走 t3-obsidian 模式**：**完全不需要**启动子进程。插件仅是一个极度轻量的高性能网络客户端，把沉重的多模型管理、Worktree 操作全部卸载到外部 T3 Code 服务端。
  - **工程建议**：**优先采用无进程网络客户端架构**，若用户本地未运行 T3 Code，可在桌面端提供一键唤起已安装 T3 Code 桌面应用（通过 URL Scheme 或快捷指令）的辅助引导。

---

### 7. 如何兼容 ChatGPT 账号授权的 Codex？
- **底层原理**：
  - ChatGPT 授权的 Codex 运行时依赖保存在 `~/.codex/auth.json` 中的 Refresh Token 与短期 Access Token。
- **两种兼容方案对比**：
  - **方案 1（Claudian 方式）**：通过子进程以当前登录用户身份执行 `codex app-server`。由于运行在同一系统用户权限下，Codex 原生二进制自动读取自身配置文件，无需插件做任何额外授权。
  - **方案 2（T3 Code 方式，最推荐）**：T3 Code 服务端内部已完整实现了 ChatGPT 账号授权管理（`CodexChatGptAuth.ts`）与会话锁机制（`CodexChatGptSessionLock.ts`）。如果 Obsidian 插件连接 T3 Code，将**直接免费继承**这一能力，插件本身完全无需触碰任何 OpenAI 授权令牌。

---

### 8. 如何避免重复实现 T3 Code 已有能力？
- T3 Code 历经大量工程迭代，已经具备了非常重型的核心资产：
  1. 多 Agent Swarm 编排与并行委托调度（`delegate_task`）；
  2. Git Worktree 隔离机制（避免在主工作区产生脏提交）；
  3. 真实的 Checkpoint 与原子回滚（`CheckpointService.ts`）；
  4. 完善的 MCP / Tool 沙箱与用户审批流。
- **避免重复造轮子的核心策略**：
  - **绝不在 Obsidian 插件中从头重写一套 Agent 运行时**。
  - 将 T3-Codian 的定位收敛为 **“Obsidian 顶级笔记知识视图 + T3 Code 工业级通信桥接器”**。

---

## 二、三种技术方案多维度对比

| 评价维度 | 方案 A：Webview/Iframe 内嵌 T3 界面 | 方案 B：连接已有 T3 Code Server (t3-obsidian模式) | 方案 C：仿照 Claudian 独立实现进程适配层 | 方案 D（推荐）：深度原生 UI + T3 V2 协议桥接 |
| :--- | :--- | :--- | :--- | :--- |
| **技术复杂度** | **极低** | **中等** | **极高**（需自建进程守护、协议分发、多Agent管理） | **中高**（专注笔记融合与协议对接） |
| **功能完整性** | 低（与 Obsidian 双链、选区、笔记无法深度联动） | 高（具备 T3 全量 Agent 能力） | 中高（功能全靠插件自身一行行实现） | **极高**（双向打通笔记知识库与 T3 引擎） |
| **维护成本** | 低 | **低**（后端升级不影响插件） | **极高**（Codex/Claude CLI 升级即坏） | **低**（依托稳定 V2 协议） |
| **安全性** | 中 | **极高**（严格基于 DPoP Token 授权） | 中（插件直接掌控操作系统 Stdio，风险高） | **极高**（沙箱隔离 + 用户 Diff 拦截） |
| **Windows 兼容性** | 优秀 | **优秀**（纯 HTTP/WebSocket，无路径编码坑） | **较差**（Windows 进程树、句柄泄露、WSL 转换繁琐） | **优秀**（跨平台一致性高） |
| **移动端支持** | 依赖本地环境 | **具备天然支持潜力**（无 native 依赖） | **彻底无缘**（仅限 Desktop） | **支持桌面优先，兼顾移动架构** |
| **开发周期** | 1 周 | 3~4 周 | 8~12 周 | **3~5 周** |

---

## 三、技术判断与推荐方案

### 推荐方案：**方案 D（深度原生 UI + T3 Code Orchestrator V2 协议桥接）**

#### 1. 架构定位
- **复用 `t3-obsidian` 的成熟连接基座**：直接采用其经过严密验证的 `src/connection/`（包含环境探测、DPoP 签名生成、WebSocket RPC 与流式响应），确保 100% 稳定连接到本机或远端 T3 Code 引擎。
- **借鉴 `claudian` 的极致原生交互设计**：
  - 打造比单纯的聊天框更懂 Obsidian 的交互界面（侧边栏 Dual-pane、Zen Mode、行内实时词级 Diff 预览）。
  - 深挖 Obsidian 双链知识网络，提供 `@` 引用笔记自动解析、标签关联上下文注入能力。
- **坚守 Agent 安全红线**：
  - 继承 T3 Code 的 Git Worktree 隔离理念，在 Obsidian 侧为所有笔记写操作设立 **Diff 审查拦截层**，绝不破坏用户真实知识资产。

#### 2. 主要潜在风险与防御策略

| 风险项 | 严重等级 | 触发条件 | 防御对策 |
| :--- | :---: | :--- | :--- |
| **T3 Code 未常驻后台** | 中 | 用户打开 Obsidian 时未启动 T3 Code | 提供直观的状态引导界面；在 Windows/macOS 桌面端支持一键唤起 T3 Code 桌面应用。 |
| **网络端口或配对失效** | 低 | 本地端口冲突或配对 Token 过期 | 实现完善的静默重连与一键重新配对向导（集成自动发现 `/.well-known/t3/environment`）。 |
| **大笔记同步性能损耗** | 中 | 用户 Vault 包含超大文件或海量双链 | 采用 `Smart Send` 策略，仅发送增量 diff 或经过摘要过滤的上下文，防止上下文爆仓。 |

---

## 四、结论

经对三个核心参考项目的源码级深度穿透与对比分析，**T3-Codian 应当坚定走“轻量原生协议客户端”路线**，以成熟的 T3 Orchestrator V2 协议为桥梁，全力聚焦于 **Obsidian 极致的知识流交互与安全防护体验**。

本调研报告已归档，等待技术决策确认。
