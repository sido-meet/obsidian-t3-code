# Obsidian T3 Code

在 Obsidian 原生右侧栏中使用本机 T3 Code 的 Codex 会话。侧栏负责对话和笔记上下文，T3 Code 负责模型、会话和执行。

- 插件 ID 和安装目录名为 `obsidian-t3-code`。
- 本地服务使用 T3 Orchestrator v2，经 HTTP 配对和 WebSocket Effect RPC 接入。
- 首版支持流式输出、停止、同一会话内追问、新会话、断线重连、当前笔记或选区，以及复制 Markdown 和显式插入光标处。

## 安装与使用

1. 使用 Node.js 22 运行 `npm ci` 和 `npm run build`。
2. 在专用 Obsidian 测试库的 `.obsidian/plugins/obsidian-t3-code/` 中放入 `main.js`、`manifest.json` 和 `styles.css`，然后启用 **Obsidian T3 Code**。
3. 启动支持 Orchestrator v2 的本地 T3 Code，并配置 Codex。在 T3 Code 中添加一个与 Vault 分离的项目目录。
4. 在插件设置中填写服务地址，默认值为 `http://127.0.0.1:3425`。打开侧栏，输入 T3 一次性配对码。若使用 CLI，可以通过 `t3 pair --scope orchestration:read --scope orchestration:operate` 生成配对链接，配对码是链接片段中的 `token` 值。
5. 选择 T3 项目并发送消息。如需引用笔记，勾选「包含笔记」。有选区时使用选区，否则取当前正文，最多 8,000 个字符。
6. 回复结束后可复制原始 Markdown，或确认目标笔记与光标位置后点击「插入当前光标处」。如果 Codex 等待审批，请在 T3 Code 中处理。

插件仅连接回环地址。配对凭据保存在内存中，重开侧栏或重启 Obsidian 后需要重新配对。Codex 会话使用只读执行模式。工具与模型可用性由本地 T3 Code 决定。

## 开发验证

运行 `npm run typecheck`、`npm run lint`、`npm test` 和 `npm run build`。进度与验收状态见 [STATUS](docs/STATUS.md)，工程约束见 [AGENTS.md](AGENTS.md)。

[MIT License](LICENSE)
