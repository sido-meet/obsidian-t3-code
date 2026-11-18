# ADR-0001: T3-Codian 核心集成架构选型（轻量原生客户端与 V2 协议桥接）

## 状态
**Accepted**

## 日期
2026-11-18

## 背景与上下文
T3-Codian 的核心目标是将 T3 Code 工业级的多智能体（尤其是 Codex）能力引入 Obsidian 本地知识库。在技术架构设计初期，面临根本性的方案分歧：
1. **方案 A（Iframe / Webview 内嵌）**：在 Obsidian 窗口内直接通过 iframe 嵌入 T3 Code Web 界面；
2. **方案 B（外部服务纯客户端直连）**：参考 `t3-obsidian`，插件仅作为纯网络客户端，通过 HTTP/WebSocket 连接外部运行的 T3 Code；
3. **方案 C（进程内子进程自建宿主）**：参考 `claudian`，在 Obsidian 插件内部使用 Node.js `child_process` 直接启动 `codex app-server` 与 `agy acp`；
4. **方案 D（推荐：Obsidian 原生 UI + T3 Orchestrator V2 协议桥接）**：以方案 B 为底层通信骨架，结合方案 C 的深度笔记上下文感知与原生交互体验。

## 决策内容
经过多维度技术预研与代码分析，我们决定全面采纳 **方案 D**：

1. **坚持纯轻量网络客户端（Pure Client）**：
   - 严禁在 Obsidian 插件内自建、启动或管理复杂的 Node.js / CLI 守护子进程。
   - 插件通过标准 HTTP REST（握手探测）与 WebSocket（实时数据流），连接本地默认的 T3 Code 实例（`127.0.0.1:3425`）。
2. **采用 Obsidian 原生 DOM 构建侧边栏**：
   - 坚决不使用 WebView/Iframe，采用 Obsidian 原生 `ItemView` 与内置 `MarkdownRenderer`，实现极小体积（`<200KB`）与 100% 主题契合。
3. **贯彻 Vault 零修改安全保护原则**：
   - 上下文提取严格只读；
   - MVP 阶段 Agent 不在后台自动修改 Markdown 文件，仅通过“插入光标处”由用户显式触发并受控写入。
4. **全量继承 T3 Code 后端资产**：
   - 插件不管理 Skills、MCP 服务器与 ChatGPT OAuth 轮转，全部委托给 T3 Code 本地服务完成，杜绝重复实现。

## 架构影响与推论

### 正面收益 (Pros)
- **极度稳定且轻量**：无任何原生编译依赖与进程树管理，内存占用极低（通常 `< 20MB`），彻底规避 Windows 下的僵尸进程与句柄泄漏。
- **免密复用 Codex**：直接享受 T3 Code 已有的 ChatGPT 账号授权体系与影子 `CODEX_HOME` 机制。
- **天然跨平台能力**：纯 Web 标准通信使代码库具备无缝兼容未来移动端（iOS / Android）的结构。
- **开发周期大幅缩减**：复用成熟的 Orchestration V2 契约，核心研发周期缩短至 3 周左右。

### 妥协与代价 (Cons)
- **依赖外部 T3 Code 实例运行**：若用户未打开 T3 Code，插件无法直接独立进行 AI 推理。
- **缓解对策**：在侧边栏设计高辨识度的未连接引导卡片，提供快捷唤醒桌面端应用的辅助路径。
