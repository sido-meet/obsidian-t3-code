# T3-Codian

在 Obsidian 原生右侧栏中使用本机 T3 Code，发送消息时可以带上当前笔记或选区。

## 安装与使用

1. 使用 Node.js 22 运行 `npm ci` 和 `npm run build`。
2. 在专用 Obsidian 测试库的 `.obsidian/plugins/t3-codian/` 中放入 `main.js`、`manifest.json` 和 `styles.css`，然后启用 **T3-Codian**。
3. 启动本机 T3 Code。在 T3 Code 中将当前知识库目录注册为项目，将项目默认运行权限设为「需要审批」。
4. 「T3 项目目录」留空时使用当前知识库。在「T3 项目 ID」填写该目录在 T3 Code 中登记的 ID，避免 CLI 将未登记的目录解析到上层项目。若要改用其他已注册项目，可填写其根目录及 ID。确认本机 CLI 路径、Provider 实例 ID 和模型。Windows 默认寻找 T3 Code 生成的 `%USERPROFILE%\.t3\bin\t3.cmd`，其他桌面平台使用 PATH 中的 `t3`。
5. 如需更多可选模型，在插件设置中的「侧栏模型预设」每行填入一组 Provider 实例、模型和可选推理参数。
6. 打开侧栏。看到「本地 CLI 已连接」后，输入消息即可开始。顶栏「历史」可恢复同项目会话。输入框底部可选择 Agent、模型和推理选项，或通过「@ 笔记」引用其他笔记。勾选「引用当前笔记」时，优先发送选区，最多 8,000 个字符。
7. 可复制原始 Markdown，也可在笔记中定位光标后点击「插入当前光标处」。待审批操作在 T3 Code 中处理。

侧栏调用 `t3 thread list/start/send/show`，由 CLI 处理认证和服务发现。插件通过 stdin 传递正文，并轮询刷新会话。当前 CLI 的公开命令尚不提供实时事件订阅、终止运行、审批回传、可用模型目录、额度查询或逐次指定只读模式。权限标签来自线程实际运行状态。使用 Vault 的已有会话若权限不是「需要审批」，侧栏会停用发送。新会话继承 T3 项目设置。

## 开发验证

运行 `npm run typecheck`、`npm run lint`、`npm run test:coverage` 和 `npm run build`。验收记录见 [STATUS](docs/STATUS.md)。

[MIT License](LICENSE)
