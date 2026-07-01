# LandGod 启动模式对比：GUI vs Headless

## 一句话总结

| 模式 | 一句话 |
|------|--------|
| **GUI** | 有界面，能看到状态面板，适合桌面电脑 |
| **Headless** | 无界面，纯后台运行，适合服务器 |

---

## 详细对比

| 维度 | GUI 模式 | Headless 模式 |
|------|---------|--------------|
| **启动命令** | `landgod start` | `landgod start --headless` |
| **界面** | ✅ Electron 桌面窗口 | ❌ 无界面 |
| **依赖 Electron** | ✅ 需要（~170MB） | ❌ 不需要 |
| **依赖系统库** | ✅ libgtk, libnss, libasound... | ❌ 无 |
| **依赖虚拟显示** | ✅ 服务器需要 xvfb | ❌ 不需要 |
| **安装后额外步骤** | `npm install` + 系统依赖 | 无 |
| **安装时间** | 5-10 分钟 | 10 秒 |
| **内存占用** | ~200MB | ~50MB |
| **跨平台** | 主要 Linux | ✅ Linux / macOS / Windows |
| **Docker 友好** | ❌ 镜像 ~500MB | ✅ 镜像 ~80MB |
| **功能差异** | 有状态面板、托盘图标，更适合本地交互/审批/登录态准备 | 核心 Worker 协议能力相同（无 UI） |
| **远程管理能力** | 相同 | 相同 |
| **MCP 插件支持** | 相同 | 相同 |
| **适合场景** | 桌面开发机、需要可视化 | 服务器、容器、批量部署 |

---

## 功能对等

两种模式在**远程管理能力上完全相同**：

| 功能 | GUI | Headless |
|------|-----|----------|
| WebSocket 连接 Gateway | ✅ | ✅ |
| shell_execute | ✅ | ✅ |
| file_read | ✅ | ✅ |
| session_create/stdin/read/wait | ✅ | ✅ |
| remote_configure_mcp_server | ✅ | ✅ |
| 外部 MCP 插件 (Playwright 等) | ✅ | ✅ |
| Ed25519 签名验证 | ✅ | ✅ |
| 审计日志 | ✅ | ✅ |
| 命令白名单 | ✅ | ✅ |

核心 Gateway/Worker 协议能力保持一致。GUI 模式多了一个 Electron 桌面窗口，可以在本地查看状态、审计日志、活动日志等。这些信息在 Headless 模式下通过 CLI 命令同样可以查看：

```bash
landgod status          # 对应 GUI 的 Dashboard
landgod audit           # 对应 GUI 的 Audit Log 页面
landgod activities      # 对应 GUI 的 Activities 页面
landgod config show     # 对应 GUI 的 Settings 页面
```

---

## 如何选择

```
Q: 你的机器有桌面环境吗？
  → 没有（服务器 / 容器）→ Headless ✅
  → 有 ↓

Q: 你需要可视化状态面板吗？
  → 需要 → GUI
  → 不需要 → Headless ✅（更轻量）
```

**绝大多数服务器场景选 Headless**。GUI 仅在需要本地可视化、交互式审批、登录态准备或真实桌面能力演示时使用。

---

## 企业机器 Demo 选择建议

如果 Worker 要演示或执行依赖真实桌面会话的能力，建议使用有真实桌面 session 的模式：

- PPT / Office 自动化：建议使用 GUI 或 Electron daemon，确保 Windows、Office、COM 和用户桌面会话可用。
- `computer-use` 截图、点击、输入：建议使用 GUI 或带显示环境的 Electron daemon；Linux 服务器需要准备 `DISPLAY` / Xvfb。
- 首次 Shiproom / Loop / Graph 登录：建议先在 GUI 或可见浏览器环境中完成登录态准备，再切换长期运行模式。

如果 Worker 只是长期在线执行服务器型任务，优先使用：

```bash
landgod start --headless
```

典型服务器型任务包括：

- shell 执行
- 文件读取
- 数据分析
- 网络探测
- 后台 MCP 工具
- 不依赖可见桌面 session 的自动化

一句话：**真实桌面能力 demo 用 GUI / Electron daemon；长期服务器 Worker 用 `landgod start --headless`。**

### Tool Call Approval In Headless

Tool call approval is controlled by `toolCallApprovalMode`, `LANDGOD_TOOL_CALL_APPROVAL_MODE`, or the startup override:

```bash
landgod start --headless --approval-mode auto
landgod start --ui --approval-mode manual
```

`--demo` no longer controls approval. Use `--demo --approval-mode auto` when you want demo security behavior and automatic execution.

`--tool-call-approval-mode` is still accepted as a compatibility alias, but `--approval-mode` is preferred.

`toolCallApprovalMode=manual` 在不同 headless 形态下表现不同：

- 前台 headless 且有交互式 TTY：会在启动控制台提示 `Approve? [y] once / [a] all / [n] reject`。
- 后台 daemon / 没有 TTY：无法人工确认，工具调用会被明确拒绝，并提示改用 `toolCallApprovalMode auto` 或 GUI/Electron 模式。

长期服务器 Worker 建议：

```bash
landgod config set toolCallApprovalMode auto
```

需要人工审批演示时，使用 GUI/Electron 模式，或者在交互式控制台中运行 headless。

---

## 技术原理

### GUI 模式

```
landgod start
  ↓
启动 Electron 进程
  ├── 渲染进程 (React UI)   → 桌面窗口
  └── 主进程 (Node.js)      → managed-client-mcp-ws 运行时
       ├── WebSocket 连接 Gateway
       ├── 工具执行
       └── MCP 插件管理
```

### Headless 模式

```
landgod start --headless
  ↓
启动 Node.js 进程 (headless-bootstrap.js)
  └── mock Electron API → 直接运行 managed-client-mcp-ws 运行时
       ├── WebSocket 连接 Gateway
       ├── 工具执行
       └── MCP 插件管理
```

Headless 模式通过 `headless-bootstrap.js` mock 了 Electron 的 API（`app.getPath`、`BrowserWindow`、`ipcMain` 等），使相同的运行时代码可以在纯 Node.js 环境中运行，无需 Electron 二进制。
