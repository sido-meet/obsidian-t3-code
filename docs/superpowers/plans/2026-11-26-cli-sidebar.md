# CLI 后端迁移与侧栏改版

1. 在 `src/t3/cli.ts` 使用已安装的 t3 命令，固定 argv，正文 UTF-8 stdin，解析 JSON，限制子进程等待时长。用 Vitest 锁定命令参数、状态和消息顺序。
2. 在 `src/settings.ts`、`src/settings-tab.ts` 和侧栏接入 CLI 路径及独立项目目录。检查项目后用 `thread start/send/show` 派发和读取，任务未完成时轮询，显示失败和等待审批。保持笔记采纳为明确操作。
3. 侧栏借鉴 Claudian 的顶栏、对话区域和底部输入框。CLI 当前只支持查询，不提供可靠中断或实时事件流，界面用明确状态表示。
4. 跑类型检查、Lint、覆盖率和构建，在临时项目验证 CLI JSON。至少应支持无需配对的新会话、同线程追问、CLI 无响应错误及关闭侧栏时停止轮询。
