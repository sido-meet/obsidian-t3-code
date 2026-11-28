# T3-Codian M7 验收与 M8 上线准备报告

- **分支 / Worktree**：`feat/sidebar-v2-redesign`（`C:\Users\Administrator\.t3\worktrees\T3-Codian\feat-sidebar-v2-redesig-30fa75b8dc76a49d`）
- **日期**：2026-11-28
- **目标版本**：`v0.1.0`（`manifest.json` id: `t3-codian`）
- **当前上线门禁状态**：**待用户审批确认后部署至 `E:\Documents\Obsidian-Vault`**（当前 `main` 分支与生产 Vault 均保持未修改）

---

## 一、最终候选发布产物清单（Final Candidate Manifest）

以下文件已在最后一次代码/样式/脚本修改后重新执行 `npm run typecheck && npm run lint && npm run test:coverage && npm run build` 生成，并完成 `verify-bundle.mjs` 与 SHA-256 校验：

| 产物文件名 | 实际字节数 | SHA-256 校验和 | 门禁检查 |
| --- | ---: | --- | --- |
| `main.js` | `150,112` bytes | `5E2C348FB160737CCCCAC6E35096E04C0648BBDDC12C3B908FF0177A43445F1A` | `< 204,800` B（余量 `54,688` B），`obsidian` external |
| `manifest.json` | `303` bytes | `84148C0A62FC2A1347C938856BAA84AAB122E7EB0F74E86E7483EECB7BDEFCE0` | `id === 't3-codian'`, `version === '0.1.0'` |
| `styles.css` | `23,524` bytes | `4B563F6AEC411699B8B33AB7D210F36B844BDC44F6F851E39CBDC4232E517CE3` | 已完成 `.obsidian-t3-code` 作用域覆盖校验 |

---

## 二、M7 全链路验收矩阵（按实测层级严格标注）

> 严格区分四类验证层级：**Real Obsidian 1.15.1 Automated**（隔离真实 Obsidian 桌面端 `1.15.1` + CDP）、**Live T3 Server E2E**（真实本机 T3 Server Node 实测）、**Vitest Automated**（单元测试与 Mock DOM 集成测试）、**Manual Checklist**（留待用户人工目视/交互确认）。

| 编号 | 验收项 | 验证层级 | 最新结果与实证摘要 |
| --- | --- | --- | --- |
| M7-01 | 类型检查、Lint、单测与覆盖率总门禁（最终代码修改后重跑） | Vitest Automated | `tsc --noEmit` 退出码 `0`；`eslint . --max-warnings=0` 退出码 `0`；**`23` 个测试文件 / `119` 条测试全过**（总覆盖率 **`89.3%` Stmts / `81.87%` Branch / `91.64%` Funcs**）；`main.js` **`150,112` 字节**。 |
| M7-02 | 真实 Obsidian 插件加载、零顶栏侧栏渲染、无感回环发现与短期 Session 签发 | Real Obsidian 1.15.1 Automated | 隔离 Obsidian `1.15.1`（`--user-data-dir` + `--remote-debugging-port=9239`）加载 `t3-codian`；`@1s` 达到 `connectionPhase: 'connected-rpc'`、`ready: true`、异常横幅隐藏、识别 `10` 个 Provider。 |
| M7-03 | 大目录搜索与异步 `setProviders` 下输入框焦点/选区保持 | Real Obsidian 1.15.1 Automated | `claudeAgent` 含 `161` 模型（实测同时就绪 `antigravity` `11` 模型），筛选 `"sonnet"` 得 `8` 项；触发 `store.setProviders` 后 `.t3c-mp-filter` 保持聚焦及光标选区 `(2, 5)`，样式无原生阴影溢出。 |
| M7-04 | 增量流式文本、原生 Markdown / KaTeX / Table / Code Copy 与实时上下文用量 | Real Obsidian 1.15.1 Automated | 实测 `turn-item.updated` (`assistant_message`) 触发 `18` 次增量 DOM 更新，`Stop` 按钮在运行期可见；正确渲染 `table`（`1`）、`code + copy-code-button`（`1`）、KaTeX `.math`（`2`）；实时 `contextUsage` 显示 `3%`（`23,943 / 950,000`，输入 `22,109` 含缓存 `4,352`，输出 `1,834` 含思考 `444`），额度诚实显示「未知 / Provider 未提供」。 |
| M7-05 | 会话历史弹层、权限切换弹层排版、>=600px 宽双栏与浅色 `moonstone` 主题 | Real Obsidian 1.15.1 Automated | 权限弹层全部 `4` 项行高与描述均不越界（`rowRightDiff: -9`, `descRightDiff: -14`），`当前生效` 高亮正常；`680px` 进入 `is-wide` 双栏并展示右侧项目会话列表；`moonstone` 浅色主题无错位。 |
| M7-06 | 长会话回溯阅读滚动位置保护与运行中 Stop 中断 | Real Obsidian 1.15.1 Automated | 上滑固定 `scrollTop = 40` 后发送 Turn 2，`400ms` 流式追加期间保持 `postScrollTop = 40` 未跳底；点击 Stop 按钮后会话进入 `interrupted`。 |
| M7-07 | 双工作区标签/Leaf 隔离、插件禁用/重载清理、临时会话零残留 | Real Obsidian 1.15.1 Automated | 创建并统计 `twoLeavesCount: 2`，禁用插件后 `afterDisableLeaves: 0`、重新启用正常；清理本次测试线程后 `scratch` 仅余原有线程，`t3 auth session list --json` 核验 **`LEAKED t3-codian SESSIONS: 0`**，用户原有 `4` 个 Obsidian 进程均未受影响。 |
| M7-08 | `MarkdownRenderer` 前置净化实机金丝雀验证（防第三方可执行代码块与 XSS） | Real Obsidian 1.15.1 Automated | 安装真实 `dataviewjs-canary` 插件并插桩 `obsidian.MarkdownRenderer.render`；注入 `dataviewjs`/`> dataviewjs`/`- templater`/`![[TestNote]]`/`https://evil.invalid`/<script>/`onerror`/`javascript:` 负载后：`spyInstalled: true`、`interceptedCount: 1`、`preSanitizedHadRawDataview: false`、`canaryExecCount: 0`、`xssGlobal: null`、`dangerousCount: 0`、`jsLinks: 0`、`hasSafeTextClass: true`。 |
| M7-09 | 协议事件降噪/终态保真、断线重连 `afterSequence`、内联审批 `decline`、真实 `CLI Fallback -> RPC 恢复` | Live T3 Server E2E + Vitest Automated | 在最终代码修补前于本机真实 T3 Server（`v0.1.13-nightly.20261125.5258`, protocol v2）完成 E2E 验证（预订阅次序严格先 `synchronized` 再 `message.dispatch`、`19` 次增量、Stop、Client B 断线重连 `afterSequence` 逐字一致、真实审批 `decline`、完整 CLI 降级双轮对话 + RPC 恢复 + 防重放）；最终修补后的等价状态机、并发竞态与断线清理逻辑已在 Vitest `119` 项单测全量回归通过。 |
| M7-10 | Vault 安全拦截、NTFS Junction/符号链接穿透阻断、发现文件防伪造与凭据脱敏 | Vitest Automated + Earlier Node Suite | `tests/vault-guard.test.ts`、`tests/backend-manager.test.ts`、`tests/discovery.test.ts`、`tests/auth.test.ts`、`tests/rpc.test.ts` 在最终修改后全过；前期隔离安全套件亦已验证 Windows NTFS Junction（`cmd /c mklink /J`）、不存在子目录、`.cmd` 篡改与 `401` 续期吊销（`leaked=0`）。 |
| M7-11 | `>= 600px` 双栏分隔线真实鼠标按住拖拽调整宽度、以及用户正式知识库部署后首次开机体验 | Manual Checklist | 待用户在本机真窗口拖拽操作确认，及审批部署到正式 Vault 后按下方第 5 节执行快速冒烟。 |

---

## 三、三层安全边界验收汇总

1. **Layer 1 — Obsidian Vault 写隔离与项目绑定防护**
   - `VaultSafetyGuard`（`src/t3/vault-guard.ts`）通过逐级回溯存在祖先的 `realpath` + `workspacesOverlap`，阻断直接指向 Vault、Vault 子目录、Vault 上级目录、符号链接及 Windows NTFS Junction（含尚未创建的嵌套子路径）在非 `approval-required` 权限下发送消息。
   - 当 `T3BackendManager.connect()` 发现设置的 `projectId` 在服务端真实 `workspaceRoot` 落在 Vault 内而用户 `projectPath` 指向 Vault 外时，抛出 `VaultSecurityError`，保持 `resolvedServerRoot` 记录、**拒绝降级为 CLI 绕过** 并置连接为 `disconnected`。
   - `CliBackend.verifyWorkspaceProjectBinding()`（`src/t3/cli-backend.ts`）与 `ObsidianT3CodeView.validateCliProjectBinding()` 协同在 CLI / `fallback-cli` 模式下核对工作区目录解析出的 `projectId`。
2. **Layer 2 — 非可信 AI 输出 Markdown 渲染安全（`MarkdownRenderer.render()`）**
   - `sanitizeUntrustedMarkdown()` 在进入 `MarkdownRenderer.render()` 前完成代码块降级重写（拦截 `dataviewjs`/`templater` 等及引用块/列表缩进嵌套围栏）、阻断 `![[...]]` 嵌入与远程图片/引用定义、剔除高危 HTML 标签及非 `http(s):`/`mailto:` 链接；`renderSafeMarkdown()` 渲染后再做二次 DOM 净化，`> 40,000` 字符自动退化为惰性纯文本。
   - 经隔离 Obsidian `1.15.1` 配合 `dataviewjs-canary` 与 `MarkdownRenderer.render` spy 实测：`MarkdownRenderer` 本身收到的即为净化后文本（`preSanitizedHadRawDataview: false`），金丝雀回调执行次数 `0`。
3. **Layer 3 — 发现、短期纯内存鉴权与凭据零泄露**
   - 仅允许回环服务源（`127.0.0.1` / `localhost` / `[::1]`，拒绝含内嵌账密 URL）、强校验 `orchestrationProtocolVersion === 2`、严格按 14 行模板解析 Windows `t3.cmd`（`shell: false`）。
   - `T3AuthManager` 仅在内存中保存 Bearer Session 与一次性 `/oauth/token` 配对凭据，退出或禁用插件时自动吊销（实测 `0` 条未吊销残留 `t3-codian` 会话）。
   - `redactSensitiveText()`（`src/t3/rpc.ts`）统一脱敏 `Bearer`/`DPoP`、URL 及裸 `key=value`（`wsTicket`/`ticket`/`token`/`access_token`/`subject_token`/`refresh_token`/`pairingCode`/`code`/`secret`）以及普通与转义 JSON 字段。

---

## 四、独立 Code Review 闭环摘要

由独立只读 Review 子 Agent（`bc88412f-2d19-44ab-baf1-d7234b54c4fb`）完成全量工作树差异审阅，结论：**0 Critical / 4 High / 7 Medium / 5 Low**。所有 **4 项 High（`H1`–`H4`）**、**7 项 Medium（`M1`–`M7`）** 与 **4 项 Low（`L1`、`L3`、`L4`、`L5` + `L2` 同步完成）** 均已在工作树内完成修复并新增回归测试（117 -> 119 条全过）：
- **H1 (`protocol-v2.ts`)**：`parseAssistantTurnItemMessage` 严格过滤 `textOmitted === true`，在缺失布尔 `streaming` 时结合 `item.status` / `runs` 推断流式态；`mergeAssistantTurnItemMessage` 禁止覆写已终态消息；`parseThreadSnapshot` 优先读取 `runs` 态并用长 `turnItems` 替换空流式占位；`run.updated` 终态统一清理遗留 `streaming: true`。
- **H2 & M1 & L2 (`rpc-backend.ts`, `backend-manager.ts`)**：`establishTransport` 失败与降级切换 CLI 时强制执行 socket 清理与 `disconnect()`，修复仅限显式 `disconnect()` 才触发 `revokeAndClear()` 的 `explicitDisconnect` 状态隔离，重连前清除旧定时器，并在 `handleShellStreamItem` / `resyncThreadOverHttp` 加入 `connectEpoch` 与退订守卫。
- **H3 (`backend-manager.ts`, `cli-backend.ts`)**：新增 `VaultSecurityError` 在根目录与 Vault 冲突时 fail-closed 拒降级，并在 `connectCliOnly` 中调用 `verifyWorkspaceProjectBinding()`。
- **H4 & M6 & M7 & L5 (`scripts/deploy-obsidian.ps1`, `scripts/rollback-obsidian.ps1`)**：修复 Windows PowerShell 5.1 单备份目录 `@(...)` 标量下标崩溃；拒绝缺失 `.obsidian` 的非 Vault 目标；空目录不再产生空清单；备份与部署双重 SHA-256 校验并在拷贝失败时自动回滚；回滚前预检所有备份条目及路径叶子名合法性。已在临时 Mock Vault 完成 `pwsh` 部署 + 存在干扰空目录条件下 **`powershell.exe` 5.1 单备份回滚全校验**（`MOCK_DEPLOY_MAIN_MATCH=True`、`MOCK_DEPLOY_DATA_UNTOUCHED=True`、`MOCK_ROLLBACK_MAIN_MATCH=True`、`MOCK_ROLLBACK_DATA_MATCH=True`）。
- **M2 (`cli-backend.ts`)**：集中管理 `pollerCancels` 随 `disconnect()` 一并中止；`poll()` 串行互斥防重叠覆盖；Turn 2 唤醒附带 `expectedRunId` 与有界宽限轮询。
- **M3 (`protocol-v2.ts`)**：`provider-turn.updated` 与 `provider-thread.updated` 遇到 `null` 时均保留先前用量字段。
- **M4 & L4 (`styles.css`)**：全面以 `.obsidian-t3-code` 前缀提高按钮、筛选框、禁用态度行与刷新图标优先级，隔离 Send/Stop 按钮悬停颜色。
- **M5 & L3 (`ObsidianT3CodeView.ts`, `backend-manager.ts`)**：待确认发送横幅严格按 `tab.uncertainCommandId` 隔离至所属标签页并在关闭标签时清理 `pendingDispatches`；避免 RPC 模式下重复派发 `store.setThreadDetail`。

---

## 五、旧版 `data.json` 兼容性报告与正式 Vault 预检

- 只读核验 `scripts/deploy-obsidian.ps1 -VaultPath 'E:\Documents\Obsidian-Vault' -DryRun` 实测结果：
  - 目标插件目录：`E:\Documents\Obsidian-Vault\.obsidian\plugins\t3-codian`
  - 检测到既有 `data.json` 存在（合法 JSON，零写入，现有生产 `main.js` 仍保持 `192,306` 字节）
  - 实有配置键名：`cliPath`、`projectPath`、`provider`、`model`、`includeNote`、`projectId`
- 兼容性结论：新版 `normalizeSettings()`（`src/settings.ts`）完全兼容上述 6 项现有键，`serverUrl` 与 `backendPreference` 安全默认为 `""` 与 `'auto'`，`modelPresets` 默认为 `""`；`deploy-obsidian.ps1` 仅备份既有全部文件（含 `data.json`）并仅覆盖 `main.js`、`manifest.json`、`styles.css`，绝不修改用户 `data.json`。

---

## 六、部署、回滚指令与上线后人工检查表（待用户批准后执行）

### 1. 标准预演（只读，可随时运行）
```powershell
pwsh -NoProfile -File "C:\Users\Administrator\.t3\worktrees\T3-Codian\feat-sidebar-v2-redesig-30fa75b8dc76a49d\scripts\deploy-obsidian.ps1" -VaultPath "E:\Documents\Obsidian-Vault" -DryRun
```

### 2. 正式部署（需用户明确批准后执行）
```powershell
pwsh -NoProfile -File "C:\Users\Administrator\.t3\worktrees\T3-Codian\feat-sidebar-v2-redesig-30fa75b8dc76a49d\scripts\deploy-obsidian.ps1" -VaultPath "E:\Documents\Obsidian-Vault"
```
> 默认自动将旧版插件文件（含 `data.json` 副本）完整备份至 `%LOCALAPPDATA%\T3-Codian\backups\t3-codian-<yyyyMMdd-HHmmss-fff>` 并生成 `backup-manifest.json`，然后写入 3 个产物并逐一核对 SHA-256。

### 3. 一键回滚（兼容 Windows PowerShell 5.1 与 PowerShell 7）
```powershell
pwsh -NoProfile -File "C:\Users\Administrator\.t3\worktrees\T3-Codian\feat-sidebar-v2-redesig-30fa75b8dc76a49d\scripts\rollback-obsidian.ps1" -VaultPath "E:\Documents\Obsidian-Vault" -Latest
```

### 4. 部署后最小人工检查表（Post-Deploy Smoke Checklist）
1. 在 Obsidian 设置 -> 第三方插件 中重新开启 **T3-Codian**（或重载插件 / 重启 Obsidian），打开侧栏确认状态静默无异常横幅且旧配置完整保留。
2. 观察底部模型按钮可展示本机实时 Agent 与模型列表；检查 Vault 权限胶囊是否准确锁定并提示「需要审批（知识库推荐）」。
3. 若将侧栏拖宽至 `>= 600px`，手动用鼠标按住中间分隔线验证宽栏尺寸平滑拖拽保存；关闭侧栏或退出 Obsidian 时确认无残留会话。
