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
