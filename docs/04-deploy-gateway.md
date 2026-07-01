# Deploy Gateway

## 前置要求

- Node.js 18+（推荐 22）
- 一台 Agent 和 Worker 都可访问的机器

> 当前 MVP/POC 阶段，建议调试和测试时将 Gateway 部署在 Agent 同机器上。

## 一键安装

```bash
# 从 GitHub 安装
# Find latest: curl -sL https://api.github.com/repos/zhou12138/cli-server/contents/downloads | python3 -c "import sys,json;[print(f[\x27name\x27]) for f in json.load(sys.stdin) if f[\x27name\x27].endswith(\x27.tgz\x27)]"
npm install -g https://github.com/zhou12138/cli-server/raw/master/downloads/landgod-gateway-<VERSION>.tgz

# 或从本地文件
npm install -g ./downloads/landgod-gateway-<VERSION>.tgz
```

## 启动

```bash
# 后台启动（推荐）
landgod-gateway start --daemon --token YOUR_SECRET_TOKEN

# 前台启动（调试）
landgod-gateway start --token YOUR_SECRET_TOKEN

# 自定义端口
landgod-gateway start --daemon --port 9081 --ws-port 9080
```

## 验证

```bash
# 检查状态
landgod-gateway status

# 测试 API
curl -s http://localhost:8081/health
```

预期输出：
```json
{"status":"ok","connectedClients":0,"registeredTokens":1}
```

## 管理

```bash
landgod-gateway status     # 查看状态
landgod-gateway stop       # 停止
```

## 数据目录

默认：`~/.landgod-gateway/`

```
~/.landgod-gateway/
├── gateway.pid      进程 PID
├── gateway.log      运行日志
# tokens.json removed (single-token mode)
```

## 告诉 Agent

Gateway 启动后，Agent 只需要知道一件事：

```
HTTP API: http://localhost:8081
```

Agent 用自带的 HTTP 能力调用即可，不需要安装 SDK。

当前 Gateway 暂不对 Agent 的 HTTP API 请求做鉴权；启动参数里的 `--token` 用于 Worker 连接 Gateway。

## 开机自启（可选）

### Linux (systemd)
```bash
sudo tee /etc/systemd/system/landgod-gateway.service > /dev/null << 'EOF'
[Unit]
Description=LandGod-Link Gateway
After=network.target

[Service]
Type=simple
User=YOUR_USER
ExecStart=/usr/bin/env landgod-gateway start --token YOUR_SECRET_TOKEN
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable landgod-gateway
sudo systemctl start landgod-gateway
```
