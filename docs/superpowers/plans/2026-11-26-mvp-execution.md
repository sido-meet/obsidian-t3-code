# MVP v0.1 执行补充

承接 `mvp-v0.1.md` 的 Task 2–8 和 PRD F-01–F-07。

1. `src/settings.ts` 与 `src/context.ts`。先测试默认地址、非法地址、选区优先和正文上限，再接入 PluginData 与 Obsidian 编辑器。
2. `src/t3/connection.ts`、`rpc.ts` 和 `session.ts`。先用上游帧建立失败测试，再实现发现、配对、连接票据、实际 /ws Effect RPC、线程订阅和停止。验证断线不自动重新派发，重连恢复当前线程投影。
3. `src/main.ts`、`src/ui/T3CodianView.ts` 和 `styles.css`。将同一个插件会话控制器接入原生视图，提供连接状态、笔记选项、多轮追问、新建会话、流式回复和显式采纳。
4. 运行本地门禁、隔离服务联调和独立审查，记录可复验的结果与仍需桌面验收的项目。

协议实现依据上游 contracts 和服务器 /ws 路由。使用单独的执行工作区，笔记内容通过提示词传入，执行目录无需指向 Vault。
