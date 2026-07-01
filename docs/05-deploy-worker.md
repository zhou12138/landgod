# Deploy Worker

## 两种部署方式

| 方式 | Agent 需要 | 目标机器需要 | 适合场景 |
|------|-----------|-------------|---------|
| **Push（推送）** | SSH 到目标机器 | 开放 SSH | Agent 能直接 SSH |
| **Pull（拉取）** | 无 | 访问公网 | Agent 无法 SSH |

---

## Push 模式：Agent 远程安装

### 前提

- Agent 能 SSH 到目标机器
- 目标机器有 Node.js 或能安装

### 自动部署脚本

```bash
# 下载脚本
curl -fsSL -o /tmp/landgod-deploy.sh \
  https://github.com/zhou12138/cli-server/raw/master/scripts/landgod-deploy.sh
chmod +x /tmp/landgod-deploy.sh

# 执行
/tmp/landgod-deploy.sh <IP> <SSH用户> <SSH密码> [设备名]
```

**脚本自动完成**：
1. SSH 连接目标机器
2. 注入部署密钥（后续不需要密码）
3. 检查/安装 Node.js
4. 从 GitHub 下载安装 LandGod Worker
5. 安装系统依赖（Electron 模式）
6. 写入配置
7. 建立反向 SSH 隧道
8. 注册 systemd 服务（开机自启）
9. 启动 daemon
10. 验证连接
11. **焚毁密码**

### 手动安装

```bash
# 在目标机器上执行

# 1. 安装 Worker
npm install -g https://github.com/zhou12138/cli-server/raw/master/downloads/landgod-<VERSION>.tgz

# 2. 安装 Electron 依赖（Electron 模式）或跳过（Headless 模式）
cd $(node -e "console.log(require.resolve('landgod/package.json').replace('/package.json',''))")
npm install  # Electron 模式需要

# 3. 系统依赖（Linux Electron 模式）
sudo apt-get install -y libgtk-3-0 libnss3 libasound2t64 libcups2 xvfb
```

---

## Pull 模式：目标机器自助安装

当 Agent 无法 SSH 到目标机器时，在目标机器上直接执行：

```bash
# 一键安装
npm install -g https://github.com/zhou12138/cli-server/raw/master/downloads/landgod-<VERSION>.tgz
```

然后按 [06-worker-config.md](./06-worker-config.md) 配置。

---

## Headless vs Electron

| | Headless（推荐） | Electron |
|---|---|---|
| 命令 | `landgod daemon start --headless` | `landgod daemon start` |
| 需要 Electron | ❌ | ✅ (~170MB) |
| 需要系统依赖 | ❌ | ✅ libgtk, xvfb... |
| 需要 npm install | ❌ | ✅ |
| 跨平台 | ✅ Linux/Mac/Windows | 主要 Linux |
| UI 界面 | ❌ | ✅ |

**服务器部署首选 Headless 模式。**

如果是企业机器 demo，尤其是 PPT / Office / `computer-use` / 首次浏览器登录态准备，建议使用有真实桌面 session 的 GUI 或 Electron daemon。长期服务器 Worker、容器、后台任务优先使用 `landgod daemon start --headless`。

---

## 验证安装

```bash
landgod --help     # CLI 正常
landgod health     # 查看状态
```
