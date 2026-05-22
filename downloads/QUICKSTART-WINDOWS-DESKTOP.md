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

## ▶️ 启动

```bash
landgod start --ui --demo
```

> ⚠️ `--demo` 模式会禁用命令白名单、内容过滤等所有安全限制，**仅用于演示和本地测试**。

---

## ❓ 常见问题

| 问题 | 解决方案 |
|------|---------|
| `landgod` 命令找不到 | 关闭终端重新打开；或检查 `npm prefix -g` 路径是否在系统 PATH 中 |
| Python 功能不可用 | 安装 Python 后需要重启终端，确认 `python --version`（Windows）或 `python3 --version`（macOS）正常 |
| Electron 相关报错 | 首次运行 `landgod start --ui` 时会自动安装 Electron 依赖，需要联网 |
| macOS 权限弹窗 | 截图功能需要在 系统设置 → 隐私与安全 → 屏幕录制 中授权终端 |

---

## 🔗 相关链接

- [Gateway 安装指南](./QUICKSTART-GATEWAY.md)
- [完整文档](../docs/)
