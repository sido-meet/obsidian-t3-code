# Obsidian T3 Code 侧栏设计规划

状态：待确认。本文只规划产品和交互，界面开发在设计确认后开始。

## 设计参考

| 参考 | 迁移到 Obsidian 的部分 |
| --- | --- |
| 用户截图 | 大块连续的回复正文、右对齐的用户消息、顶部留给内容的空间、底部固定的输入框和上下文操作。百分比的含义需要由数据源确认。 |
| T3 Code 原生前端 | 从 `MessagesTimeline` 和 `TimelineUserMessageRow` 学消息层级，从 `ComposerControlsBar` 学模型和推理强度的联动，从 `composerFooterLayout` 学窄栏收纳，从 `ThreadDetailsUsage` 和 `UsagePage` 学额度、重置时间及详情的层级。 |
| t3-obsidian | 从 `composer-model-picker.ts` 学模型菜单如何缩进到 Obsidian，参考搜索、Provider 分组与键盘交互。 |
| Claudian | 参考 Obsidian 主题变量、输入框内的底栏与窄屏布局。 |

## 布局

- 顶栏仅保留当前会话名、历史、新会话和更多。首次进入时呈现连接或配置引导，连接后显示紧凑状态。会话操作集中于历史面板。
- 对话区占剩余空间，延续截图中用户消息靠右、助手回复以正文展示的结构。表格与代码块局部横向滚动，消息操作在对应回复下方，保留复制与插入。
- 底部输入区固定。上下文附件显示为可移除标签，输入框下方安排「Agent · 模型」、额度入口、当前权限状态和发送。权限图标和当前状态常驻。窄栏用图标保留入口，额度详情和低频信息进更多菜单。
- Agent 与模型共用一个弹层，额度另有详情。先选择 Agent，再筛选该 Agent 的模型，最后显示模型支持的推理强度等选项。已选 Agent 和模型同时显示在输入框底栏，额度显示真实的账号或 Provider 实例、时间窗口和重置时间。

## 设计优先级与依赖

| 优先级 | 功能 | 本机 CLI 基线与验收 |
| --- | --- | --- |
| P0 | 基础聊天与会话历史 | `thread list/show/start/send` 支持。打开历史后可恢复选定线程，草稿归属清晰，新会话无需清空已有记录。当前回复通过轮询读取。 |
| P0 | Agent 选择 | 按 Agent 类型分组展示已配置的 Provider 实例，例如 Codex 和 Claude Code。多个同类实例须可区分。自动发现待 CLI 提供机器可读目录。新会话通过 `--provider` 使用选定的实例。 |
| P0 | 模型与推理强度选择 | 选择 Agent 后只提供对应的已配置模型及已知支持的选项，通过 `--model` 与 `--option` 传给首次发送。切换 Agent 时清除不兼容选项。已有会话显示实际 Agent 和模型，当前 `thread send` 无切换参数。切换时提供新建会话入口，并保留未发送的草稿。 |
| P0 | 额度监控 | 先设计底栏入口和详情。账户额度与当前会话上下文占用独立命名。原生前端从 Provider 实例数据读取 usageLimits，本机公开 CLI 暂无可靠查询。只有获得真实数据后才显示百分比、重置时间和刷新时间，覆盖加载、不可用、数据过期及已耗尽状态。 |
| P0 | 当前知识库与上下文 | 默认使用当前 Vault。设计选区、当前笔记及移除操作，确保发送前能看见会随本轮提交的内容。保留原有设置。 |
| P1 | 多文件引用和消息详情 | 规划 `@` 笔记搜索、附件、复制与回写、工具活动折叠。Mermaid 图和复杂 Markdown 需要单独验证渲染行为。 |
| P0 | 运行权限 | 底栏显示当前会话有效权限，待连接时显示未读取。支持切换后，按 Provider 支持和托管策略展示可用模式与禁用原因。CLI 当前可读取线程的 runtimeMode，不能用公开命令指定或切换。首批只展示实测权限，切换入口引导至 T3 Code。 |
| P0 | 运行状态与待处理请求 | 时间线区分排队、正在执行、等待审批、需要回答、失败、结束和断线。在 CLI 仅报告宽泛状态时保留通用提示。请求详情、审批按钮和提交结果等待 CLI 提供机器可读接口。 |
| P1 | 运行控制 | 停止、重试、排队消息的编辑或取消，以及可用时的跟进模式。以真实运行或消息 ID 操作，等待服务端确认后刷新。当前 CLI 的 send 可排队，停止和队列编辑仍缺公开命令。 |
| P2 | 完整用量页与高级能力 | 历史用量、成本、多个账户，以及 T3 Code 的高级运行管理入口。独立验证数据契约和窄栏使用需求。 |

## T3 Code 源码对照

核对基线为本地 T3 Code 源码提交 `70e4319d`。以下设计按桌面端的实际能力逐项核对。

### 权限模式、交互模式与审批

- 运行权限来自 `runtimeModeConfig.ts` 与 `providerPolicy.ts`。四种模式是「需要审批」(`approval-required`)、「自动接受编辑」(`auto-accept-edits`)、「自动」(`auto`) 和「完全访问」(`full-access`)。底栏用图标和短标签展示实际生效模式，详情解释差异。已知被 Provider 或组织策略禁用的条目显示原因。能力未知时不预设可切换。
- 实际沙箱由 Provider 适配器决定。模式标签不能单独证明文件或网络访问范围。默认项目为当前 Vault，保留该项目的「需要审批」配置，界面读取有效值后才显示对应标签。
- 计划与执行来自 `interactionMode` 的 `plan/default`。放进更多入口或模型弹层的独立区域，避免与权限模式混用。
- 每次审批独立于会话权限。依据 `TimelinePendingApprovalRow`、`ComposerPendingApprovalActions` 和 `runtime-request.respond` 设计内联卡片，展示来源、命令或目标路径、原因和服务端提供的选项。仅展示此请求支持的选项，例如批准一次、会话内批准、始终允许、拒绝或取消。高权限选项须保留原生警示。卡片覆盖提交中、已解决、请求失效与响应失败。
- Agent 提问和 MCP 表单参考 `ComposerPendingUserInputPanel`，使用独立的待回答卡片。用户回答通过对应请求返回。CLI 无法识别请求类型时，仅显示「等待处理」并提供 T3 Code 入口。

### 同批检查的原生交互

| 原生前端与契约 | 侧栏规划 |
| --- | --- |
| SidebarThreadHeader、ThreadTimeline | 当前会话、历史、恢复和新建优先。重命名、归档、分支及搜索放到会话菜单，按接口分批接入。 |
| ProviderModelPicker、ComposerModelEffort、ProviderStatusBanner | Agent、模型、推理强度、Provider 离线、账号未登录、模型不可用以及实际生效模型。 |
| ComposerAttachmentStrip、ComposerPendingTerminalContexts | 当前笔记和选区、文件与图片、引用移除。终端上下文及斜杠命令在支持数据契约后补齐。 |
| MessagesTimeline、TimelineV2EventRow、TimelinePendingApprovalRow | 助手正文、运行耗时、工具活动、审批和失败信息按时间排列。作业详情按需展开。 |
| ChatView、队列和运行控制契约 | 预留停止、重试、排队和待回答入口。对于 CLI 尚未开放的操作使用明确的 T3 Code 转接路径。 |
| ThreadDetailsUsage、ComposerUsageLimits、UsagePage | 账户额度、上下文占用、时间窗口、重置时间与无数据状态。刷新和历史用量按数据是否可用排期。 |
| checkpoint.rollback、thread.fork 及差异详情 | 检查点、文件差异和分支属于后续能力。设计阶段登记，并保留高影响操作的原生边界。 |
## 评审与实施顺序

1. 先评审窄栏关键状态。空会话、正常对话、Agent 与模型、额度、权限详情、运行中、审批与待回答。
2. 核对本机 T3 CLI 的 Agent 和模型目录、额度、有效权限、审批与运行状态契约。已支持的功能进入首个实现批次，缺失的能力作为 CLI 依赖记录。
3. 按顶栏与会话、消息、输入区与附件、Agent 与模型、权限与审批、额度拆分实施。在 240、320、480 像素宽度检查浅色、深色主题，验证键盘可达、长消息不推挤输入区以及无数据状态。
4. 用隔离 Vault 测试新旧会话、Agent 与模型参数、额度不可用、权限未知、审批失效以及复制和回写。验收通过后再部署到用户知识库。


---

## V2 架构演进与实现对齐（`feat/sidebar-v2-redesign`）

本节记录在 V1 原生侧栏基础上落地实现的 V2 设计（核心代码：`src/ui/ObsidianT3CodeView.ts`、`src/ui/sidebar-model.ts`、`src/t3/cli.ts`、`styles.css`）：

1. **零内部顶栏与异常专用横幅**：移除常驻顶部状态栏；CLI 健康连接期间保持静默（`.t3c-banner` 隐藏）。仅在断连报错、Vault 目录非 `approval-required` 权限拦截、会话处于 `waiting` / `pendingRequestCount > 0` 或运行 `failed`、以及已连接状态下同步操作失败时显示 `.t3c-banner`（外链经 `safeThreadLink` 严格限制为 `https://app.t3.codes/threads/...`）。
2. **双形态响应式布局（`resolveLayoutMode`）**：
   - `>= 600px`（`.is-wide`）：隐藏单栏顶行导航，展开 `.t3c-resizer`（支持指针拖拽与 `ArrowLeft`/`ArrowRight` 键盘调节，夹紧 `[180px, total - 325px]`）与持久右侧 `.t3c-wide-sidebar`（快捷动作、`项目` 目录名、可搜索的 `SESSIONS` 列表并支持 `时间` / `Inbox` 分组切换，剔除 `archived` 会话）。切换至宽栏时自动收起单栏 `historyPopover`。
   - `300px–599px`（单栏默认）与 `< 300px`（`.is-narrow`）：输入盒上方展示多标签独立兄弟按钮徽标（`.t3c-tab-badge` 内含选择按钮与仅活动多标签可见的关闭按钮，无嵌套交互元素）及 `[+][✎][🕒]` 动作组；`< 300px` 下收敛底栏辅助文案与模型弹层列宽。
3. **底部工具栏与锚定弹层（`.t3c-composer-dock`）**：
   - 左侧 `Agent · 模型 · 思考度` 胶囊按钮打开固定 `236px` 高三列弹层（Agent 图标栏 / 带过滤的模型两行列表 / 1–4 格信号条思考强度）；浏览其他 Agent 但未切模型时，思考列置 `is-inert` 且选项按钮 `disabled`；已在 CLI 创建的会话锁定变更并提供「带着草稿新开会话」。
   - 中间 240° SVG 圆弧用量仪表如实展示 `—` 与「CLI 暂未提供数据」说明。
   - 右侧权限胶囊只读展示当前 `runtimeMode`（并附安全的 T3 Code 外链）；Vault 目录重叠检查同时结合 `realpath` 缓存与标准化 `workspacesOverlap`。
   - 框外最底行 `.t3c-note-footer` 独立切换 `includeNote`，并将输入/选区变化更新局部化到发送按钮与注脚，避免频繁重建徽标与会话列表 DOM。
   - 所有弹层相对 `.t3c-composer-dock` 向上浮动（`bottom: calc(100% + 6px)`），维护 `aria-expanded`，并在文档级监听 `Escape` 关闭与焦点恢复。
