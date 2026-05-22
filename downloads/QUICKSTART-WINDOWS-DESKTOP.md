# 🖥️ Windows 桌面快速上手

> 在 Windows 上安装 LandGod Worker 桌面客户端，5 分钟完成。

## 前置条件

- Windows 10/11
- [Node.js](https://nodejs.org/) 已安装（v18+）
- 管理员权限的终端（PowerShell 或 CMD）

## 第一步：安装 LandGod Worker

```powershell
npm install -g https://raw.githubusercontent.com/zhou12138/cli-server/master/downloads/landgod-0.1.2.tgz
```

验证安装：
```powershell
landgod --version
```

## 第二步：安装 Python 环境（截图/远程操作功能需要）

```powershell
# 1. 安装 Python
winget install Python.Python.3

# 重启终端使 python 生效，然后继续：

# 2. 安装依赖
python -m pip install pyautogui
python -m pip install Pillow
```

> 💡 如果不需要截图/远程操作功能，可以跳过此步骤。Worker 启动时会自动检测 Python，未安装则静默跳过 computer-use 功能。

## 第三步：配置

```powershell
landgod onboard
```

按向导完成配置，或手动设置：

```powershell
landgod config set enabled true
landgod config set mode managed-client-mcp-ws
landgod config set bootstrapBaseUrl "ws://GATEWAY_HOST:8080"
landgod config set token "YOUR_SECRET_TOKEN"
landgod config set toolCallApprovalMode auto
```

> 将 `GATEWAY_HOST` 替换为 Gateway 地址，`YOUR_SECRET_TOKEN` 替换为 Gateway 的 token。

## 第四步：启动

```powershell
# 桌面 UI 模式
landgod start --ui

# 或后台守护进程模式
landgod start
```

## 验证

在 Gateway 机器上检查设备是否已连接：
```bash
curl -s http://localhost:8081/clients
```

## 常见问题

| 问题 | 解决方案 |
|------|---------|
| `landgod` 不是可识别的命令 | 重启终端，或运行 `npm prefix -g` 确认全局路径在 PATH 中 |
| Python 相关功能不可用 | 重启终端后重试，确认 `python --version` 正常 |
| 连接不上 Gateway | 检查网络/防火墙，确认 Gateway 地址和 token 正确 |
| Electron 相关错误 | 运行 `npx electron-rebuild` 或改用 `landgod start`（无 UI 模式） |
