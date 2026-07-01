# 🚀 Quick Start: Install Gateway

> Gateway is an agent sidecar service. It can run on the same machine as your AI agent or on any reachable host.
> For the current MVP/POC stage, deploying Gateway on the same machine as the agent is recommended for debugging and testing.

## Install

Find the latest package version first:
```bash
curl -sL https://api.github.com/repos/zhou12138/cli-server/contents/downloads | python3 -c "
import sys,json
for f in json.load(sys.stdin):
    if f['name'].endswith(('.tgz','.whl')): print(f['name'])
"
```

Then install:
```bash
BASE=https://github.com/zhou12138/cli-server/raw/master/downloads

# Node.js
npm install -g $BASE/landgod-gateway-<VERSION>.tgz

# Or Python
pip install $BASE/landgod_gateway_server-<VERSION>-py3-none-any.whl
```

## Start

```bash
# Node.js (background)
landgod-gateway start --daemon --token YOUR_SECRET_TOKEN

# Node.js (foreground, for debugging)
landgod-gateway start --token YOUR_SECRET_TOKEN

# Python
landgod-gateway-py start --token YOUR_SECRET_TOKEN
```

> ⚠️ `--token` is **required**. Gateway will not start without it.
> In the current MVP/POC stage, this token is used for Worker-to-Gateway access. Gateway does not authenticate Agent HTTP API requests yet.

## Verify

```bash
landgod-gateway status
curl -s http://localhost:8081/health
```

Expected:
```json
{"status":"ok","connectedClients":0}
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/clients` | List connected workers |
| GET | `/tools` | List tools per worker |
| POST | `/tool_call` | Execute command on a worker |
| POST | `/batch_tool_call` | Parallel execution on multiple workers |
| GET | `/audit` | Centralized audit logs |
| GET | `/tasks` | List async/queued tasks |
| GET | `/tasks/:id` | Get task status and result |

## Ports

| Port | Protocol | Used By |
|------|----------|---------|
| 8081 | HTTP | Agent requests |
| 8080 | WebSocket | Worker connections |

## Auto-start (optional)

```bash
# Linux systemd
sudo tee /etc/systemd/system/landgod-gateway.service > /dev/null << 'EOF'
[Unit]
Description=LandGod Gateway
After=network.target
[Service]
Type=simple
User=YOUR_USER
Environment=LANDGOD_AUTH_TOKEN=YOUR_SECRET_TOKEN
ExecStart=landgod-gateway start
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now landgod-gateway
```

## Next

→ [Install Worker](./QUICKSTART-WORKER.md)
