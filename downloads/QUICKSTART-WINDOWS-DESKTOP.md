# 🖥️ LandGod Worker — Windows & macOS 安装指南

> 在本地电脑上安装 LandGod Worker，让你的设备接入 LandGod 远程管理网络。

---

## 📋 前置条件

| 依赖 | Windows | macOS |
|------|---------|-------|
| Node.js (v18+) | [nodejs.org](https://nodejs.org/) 下载安装 | `brew install node` |
| npm | Node.js 自带 | Node.js 自带 |

---

## 🚀 安装 LandGod Worker

打开终端（Windows: PowerShell，macOS: Terminal）：

```bash
npm install -g https://raw.githubusercontent.com/zhou12138/cli-server/master/downloads/landgod-0.1.3.tgz
```

验证安装成功：

```bash
landgod --version
# 输出: landgod 0.1.3
```

> 💡 如果提示 `landgod` 不是可识别的命令，关闭终端重新打开再试。

---

## 🐍 安装 Python 环境（可选 — 截图/远程操作功能需要）

LandGod 内置了 Computer Use 功能（截图、点击、输入、滚动），需要 Python 支持。如果不需要这些功能可以跳过。

### Windows

```powershell
# 安装 Python
winget install Python.Python.3

# 关闭终端，重新打开，然后安装依赖：
python -m pip install pyautogui
python -m pip install Pillow
```

### macOS

```bash
# macOS 通常自带 python3，如果没有：
brew install python3

# 安装依赖
python3 -m pip install pyautogui
python3 -m pip install Pillow
```

> Worker 启动时会自动检测 Python 环境，未安装则静默跳过 Computer Use 功能，不影响其他功能。

---

## ⚙️ 配置

### 方式一：交互式向导（推荐）

```bash
landgod onboard
```

按提示完成 Gateway 地址、Token、权限等配置。

### 方式二：手动配置

```bash
landgod config set enabled true
landgod config set mode managed-client-mcp-ws
landgod config set bootstrapBaseUrl "ws://你的GATEWAY地址:8080"
landgod config set token "你的TOKEN"
landgod config set toolCallApprovalMode auto
```

查看当前配置：

```bash
landgod config show
```

---

## ▶️ 启动

```bash
# 桌面 UI 模式（推荐桌面用户）
landgod start --ui

# Demo 模式 — 跳过所有安全检查，适合演示和本地测试
landgod start --ui --demo

# 后台守护进程模式
landgod start

# 无 GUI 后台模式（适合服务器）
landgod start --headless
```

> ⚠️ `--demo` 模式会禁用命令白名单、内容过滤等所有安全限制，**仅用于演示和本地测试**。

---

## 🔍 日常管理

```bash
# 查看运行状态
landgod status

# 查看日志
landgod logs

# 实时跟踪日志
landgod logs --follow

# 停止
landgod stop

# 查看 MCP 服务器配置
landgod mcp show
```

---

## ✅ 验证连接

在 Gateway 机器上执行：

```bash
curl -s http://GATEWAY地址:8081/clients
```

应该能看到你的设备出现在列表中。

---

## ❓ 常见问题

| 问题 | 解决方案 |
|------|---------|
| `landgod` 命令找不到 | 关闭终端重新打开；或检查 `npm prefix -g` 路径是否在系统 PATH 中 |
| Python 功能不可用 | 安装 Python 后需要重启终端，确认 `python --version`（Windows）或 `python3 --version`（macOS）正常 |
| 连接不上 Gateway | 检查 `bootstrapBaseUrl` 地址和 `token` 是否正确，确认网络/防火墙放通 |
| Electron 相关报错 | 首次运行 `landgod start --ui` 时会自动安装 Electron 依赖，需要联网 |
| macOS 权限弹窗 | 截图功能需要在 系统设置 → 隐私与安全 → 屏幕录制 中授权终端 |

---

## 📁 文件位置

| 内容 | Windows | macOS |
|------|---------|-------|
| 配置文件 | `%APPDATA%\npm\node_modules\landgod\managed-client.config.json` | `/usr/local/lib/node_modules/landgod/managed-client.config.json` |
| MCP 服务器配置 | 同目录下 `managed-client.mcp-servers.json` | 同上 |
| 运行数据/日志 | 同目录下 `.landgod-data/` | 同上 |

---

## 🔗 相关链接

- [Gateway 安装指南](./QUICKSTART-GATEWAY.md)
- [完整文档](../docs/)
