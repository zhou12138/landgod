---
name: landgod
description: "Manage LandGod remote device fleet. Use when: deploying gateway (Node.js or Python), deploying workers to remote machines (Linux/Windows), checking connected devices, executing commands on remote workers, managing tokens, security scanning, or any task involving remote device management through LandGod. Triggers on: deploy landgod, setup gateway, list devices, check workers, remote execute, patrol, scan devices, add worker, landgod, tool_call, headless."
---

# LandGod — AI Remote Device Management

## Architecture

```
Agent → HTTP API (:8081) → LandGod Gateway → WebSocket (:8080) → Workers (土地公)
```

## Install (All from GitHub remote)

```bash
# Node.js Gateway
npm install -g https://github.com/zhou12138/landgod/raw/master/downloads/landgod-gateway-0.1.3.tgz

# Node.js Worker
npm install -g https://github.com/zhou12138/landgod/raw/master/downloads/landgod-0.1.27.tgz

# Python Gateway (supports single-node + Redis cluster)
pip install https://github.com/zhou12138/landgod/raw/master/downloads/landgod_gateway_server-0.1.3-py3-none-any.whl

# Python SDK
pip install https://github.com/zhou12138/landgod/raw/master/downloads/landgod_gateway-0.1.3-py3-none-any.whl
```

## Gateway

### Start (Python — recommended)
```bash
landgod-gateway-py start                              # single node
landgod-gateway-py start --redis redis://host:6379    # cluster mode
```

### Start (Node.js)
```bash
landgod-gateway start --daemon
```

### API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| GET | /clients | List connected workers |
| GET | /agents | List observed Agent activity |
| POST | /agents/heartbeat | Agent presence + MVP identity proof |
| POST | /tool_call | Execute command on worker |
| POST | /tokens | Create token |
| GET | /tokens | List tokens |
| DELETE | /tokens/:token | Revoke token |

### Agent Heartbeat / Identity Proof (MVP)

When acting as an Agent that calls LandGod Gateway, report presence before tool calls and periodically during long tasks.

Gateway accepts Agent identity from:

- JSON body: `agent_id` or `agentId`
- Header: `x-landgod-agent-id`, `x-agent-id`, or `x-openclaw-agent-id`

MVP identity proof:

- Preferred: set `LANDGOD_AGENT_TOKEN` on Gateway and send `Authorization: Bearer <agent-token>` or `x-landgod-agent-token: <agent-token>`.
- Dev fallback: if no `LANDGOD_AGENT_TOKEN` is configured, Gateway accepts admin auth; if admin auth is disabled too, heartbeat is accepted as `dev-unverified`.
- Never put agent tokens in memory/docs/logs. Use env vars or local secret files.

Heartbeat example:

```bash
curl -X POST http://GATEWAY:8081/agents/heartbeat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LANDGOD_AGENT_TOKEN" \
  -d '{
    "agent_id": "agent-business-demo",
    "version": "openclaw-main",
    "capabilities": ["tool_call", "credential_ref", "scenario-demo"]
  }'
```

Tool calls should include the same `agent_id`:

```json
{
  "agent_id": "agent-business-demo",
  "clientName": "BusinessReportWorker",
  "tool_name": "business-report-demo.run_monthly_close_demo",
  "credential_ref": "cred_demo_finance_readonly",
  "credential_scope": "report",
  "arguments": { "month": "2026-06" }
}
```

WebUI `Agents` page shows last heartbeat, identity proof mode, source IP/User-Agent, used tools, credentials, workers, and recent operations.

## Worker

### Configure
```bash
landgod config set enabled true
landgod config set mode managed-client-mcp-ws
landgod config set bootstrapBaseUrl "ws://GATEWAY:8080"   # or wss:// for tunnel
landgod config set token "YOUR_TOKEN"
landgod config set toolCallApprovalMode auto
landgod config set builtInTools.permissionProfile full-local-admin
```

### Start
```bash
landgod daemon start --headless    # Linux/Windows server (recommended)
landgod daemon start               # GUI mode (Windows/Mac desktop)
```

### Permission Profiles
| Profile | Shell | File Read | MCP Admin | Use Case |
|---------|-------|-----------|-----------|----------|
| command-only | limited | ❌ | ❌ | Read-only patrol |
| interactive-trusted | more cmds | ❌ | ❌ | Dev tools |
| full-local-admin | all cmds | ✅ | ✅ | Full management |

## tool_call Examples

```bash
# Execute command on specific worker (by name)
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{"clientName":"ZhouTest1","tool_name":"shell_execute","arguments":{"command":"hostname"}}'

# Execute on specific connection
curl -X POST http://localhost:8081/tool_call \
  -d '{"connection_id":"conn-xxx","tool_name":"shell_execute","arguments":{"command":"uname -a"}}'
```

### clientName routing
- `clientName` specified + found → route to that worker
- `clientName` specified + NOT found → **404 error** (won't silently route elsewhere)
- Neither specified → route to first connected worker

## Connection Methods

| Method | Command | Use Case |
|--------|---------|----------|
| Direct | `ws://localhost:8080` | Same machine |
| SSH tunnel | `autossh -R 8080:localhost:8080 user@gateway` | Same cloud/VPN |
| Cloudflare Tunnel | `wss://xxx.trycloudflare.com` | Cross-border/GFW |
| Direct public | `ws://PUBLIC_IP:8080` | Open port needed |

## Security
- **Token auth**: HTTP header `Authorization: Bearer <token>` during WebSocket upgrade
- **Ed25519 signing**: Every tool_call signed with server key (nonce + iat + exp + body_sha256)
- **toolCallApprovalMode**: `auto` (no confirmation) or `manual` (requires UI approval)

## Keepalive

### Linux (cron)
```bash
# Check every minute, restart if dead
* * * * * /path/to/landgod-keepalive.sh
```

### Windows (scheduled task)
```powershell
schtasks /Create /TN "LandGod Worker" /TR "cmd /c cd /d LANDGOD_DIR && node .vite\build\headless-entry.js" /SC ONSTART /RU Administrator /F
```

### systemd (Gateway)
```bash
sudo systemctl enable landgod-python-gateway
```

## Known Issues
- Quick Tunnel address changes on restart → need domain for stable URL
- Windows headless needs correct cwd (must cd to landgod package dir first)
- headless-entry.js has bundled electron references (works on Linux, may crash on Windows without electron)
