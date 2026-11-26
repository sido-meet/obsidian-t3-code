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
