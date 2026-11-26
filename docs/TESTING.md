# Obsidian T3 Code 质量保障与测试策略 (TESTING)

> **文档版本**：v1.0.0  
> **适用范围**：Obsidian T3 Code 插件全生命周期测试
> **责任人**：Obsidian T3 Code 质量保障与技术研发团队

---

## 1. 质量保障原则与铁律

根据 [AGENTS.md](file:///E:/Projects/T3-Codian/AGENTS.md) 的核心行为规范：
1. **测试驱动开发 (TDD)**：核心逻辑（协议解析、上下文装配、状态机）在编写业务实现前必须先编写测试用例。
2. **严禁跳过测试 (Rule 8)**：严禁使用假断言（No-op tests）、严禁注释掉测试套件。
3. **未验证严禁宣称完成 (Rule 9)**：任何 Pull Request 必须提供全量测试绿灯通过的真实控制台证据。

---

## 2. 四层测试金字塔体系

```text
               ▲
              / \
             /   \      4. Windows 实机与真实服务集成测试 (E2E Verification)
            /─────\
           /       \    3. Obsidian Headless 冒烟测试 (Obsidian Smoke Test)
          /─────────\
         /           \  2. 模拟服务端集成测试 (Mock T3 Server Integration)
        /─────────────\
       /               \ 1. 纯逻辑单元测试 (Vitest Unit Tests)
      └─────────────────┘
```

---

## 3. 各测试层级实施方案

### 3.1 第一层：纯逻辑单元测试 (Unit Tests)
- **工具选型**：`vitest`
- **执行环境**：Node.js 内存无头环境，执行耗时要求 `< 3 秒`。
- **核心测试范围**：
  1. **上下文提取器 (`ContextBuilder.test.ts`)**：
     - 测试正常选区文本注入；
     - 测试选区为空时回退至当前文件全文；
     - 测试超长笔记截断（超过 `maxContextLength` 时优雅保留前文并附加截断标记）；
     - 测试特殊字符、Markdown 代码块的反转义安全性。
  2. **协议增量解码器 (`StreamDecoder.test.ts`)**：
     - 测试 JSON-RPC 2.0 数据帧正确解析；
     - 测试 `item/append` 增量分块拼接与乱序重排处理；
     - 测试畸变数据包与非法 JSON 的容错能力（不抛出未捕获异常）。
  3. **连接状态机 (`ConnectionFSM.test.ts`)**：
     - 测试 `DISCONNECTED` -> `PROBING` -> `CONNECTED` 的正向迁移；
     - 测试退避重连算法（1s -> 2s -> 4s -> 最大 15s）计算精度。

### 3.2 第二层：模拟服务端集成测试 (Mock Server Integration)
- **方案设计**：
  - 基于 Node.js 内置 `http` 与 `ws` 库，在测试进程中启动一个轻量级的 `MockT3Server`（监听随机可用本地端口）。
- **测试场景覆盖**：
  1. **标准握手与会话轮次**：
     - Mock 服务端响应 `/.well-known/t3/environment`（`orchestrationProtocolVersion: 2`）；
     - 插件建立 WebSocket 连接，发送 `turn/start`；
     - Mock 服务端连续推送 10 个 `item/append` 增量帧，随后推送 `turn/completed`；
     - 校验：插件前端 Store 准确聚合出完整的回复文本。
  2. **中途主动取消 (Interrupt)**：
     - 消息生成中途，模拟用户触发 `stopCurrentTurn()`；
     - 校验：向 Mock 服务端发出中断指令，前端状态立即置为非运行中。
  3. **服务端突然断开与重连**：
     - 传输中途强制关闭 Mock WebSocket；
     - 校验：客户端正确捕获异常，触发重试流程，界面提示“连接中断，正在重连...”。

### 3.3 第三层：Obsidian Headless 冒烟测试 (Smoke Test)
- **方案设计**：
  - 引入成熟的 Obsidian 模拟环境（参考 Claudian 的 `tests/__mocks__/obsidian.ts`）。
- **测试场景覆盖**：
  1. **插件生命周期**：
     - 实例化 `T3CodianPlugin`，执行 `onload()`，校验视图注册（`registerView`）与命令注册成功；
     - 执行 `onunload()`，校验连接被主动关闭、定时器被注销。
  2. **侧边栏视图实例化**：
     - 加载 `T3CodianView`，校验 DOM 结构正确渲染，包含状态指示灯、输入框与发送按钮。
  3. **笔记光标安全写入**：
     - 模拟活动编辑器 `MarkdownView`，测试点击“插入光标处”时，精准调用 `editor.replaceRange`，且不触发非受控的文件写入。

### 3.4 第四层：Windows 实机实测 (Real Environment Verification)
- **测试环境**：
  - 操作系统：Windows 11 ProfessionalWorkstation
  - 宿主应用：Obsidian Desktop 最新版本
  - 服务端：本地运行的 T3 Code 桌面端服务（绑定端口 `3425`），且配置 ChatGPT 授权的 Codex
- **实测用例清单**：
  - [ ] **用例 1**：在未启动 T3 Code 时打开 Obsidian 侧边栏，确认展示“服务未连接”引导，不报错崩溃。
  - [ ] **用例 2**：启动 T3 Code，点击插件“重试连接”，确认 1 秒内状态指示灯变绿。
  - [ ] **用例 3**：打开一篇中文测试笔记，选中第二段，在侧边栏提问“请解释这段代码”，确认流式生成顺畅、代码高亮正确。
  - [ ] **用例 4**：点击“插入光标处”，确认生成内容精确插入选区下方，按 `Ctrl+Z` 能完美撤回。

---

## 4. 自动化测试执行与门禁配置

在 `package.json` 中建立标准化测试脚本：

```bash
# 运行全部单测与模拟集成测试
npm test

# 监视模式运行单测 (TDD 循环)
npm run test:watch

# 输出代码覆盖率报告 (核心模块要求 > 90%)
npm run test:coverage
```

- **合并红线**：PR 提交前，本地运行 `npm test` 必须 100% 通过，杜绝破坏性变更。
