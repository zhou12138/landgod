---
name: landgod-operate
description: "Operate LandGod execution nodes through the Gateway HTTP API. Use when executing tools on workers, reading files, scanning for security issues, batch operations across capability nodes, checking worker status, or any task that requires interacting with registered worker tools. Triggers on: run command on, execute on, check worker, list workers, remote scan, batch execute, tool_call, landgod operate."
---

# LandGod Operate Skill

Execute tools on Worker execution nodes through the LandGod Gateway HTTP API.

## Gateway API

Default: `http://localhost:8081` (adjust if gateway is on a different host).

## Check Status

```bash
# Gateway health
curl -s http://localhost:8081/health

# List online workers
curl -s http://localhost:8081/clients
```

Parse clients response:
```python
import json, subprocess
result = subprocess.run(["curl", "-s", "http://localhost:8081/clients"], capture_output=True, text=True)
clients = json.loads(result.stdout).get("clients", [])
for c in clients:
    print(f"🟢 {c['clientName']}")  # or 🔴 if not connected
```

## Execute Command on a Device

```bash
curl -s -m 30 -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{"clientName":"DEVICE_NAME","tool_name":"shell_execute","arguments":{"command":"YOUR_COMMAND"}}'
```

### Parse response

The response is a JSON envelope. Extract stdout:

```bash
# One-liner parse
curl -s -m 30 -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{"clientName":"MY_DEVICE","tool_name":"shell_execute","arguments":{"command":"hostname"}}' \
  | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(json.loads(d['payload']['data']['text']).get('stdout','').strip())"
```

Response structure:
```json
{
  "type": "event",
  "event": "tool_result_chunk",
  "payload": {
    "data": {
      "text": "{\"stdout\":\"...\",\"stderr\":\"...\",\"exit_code\":0,\"signal\":null,\"cwd\":\"...\"}"
    },
    "is_final": false
  }
}
```

### Error responses

- **404** `{"error":"No connected client named: XXX"}` — device offline or name wrong
- **tool_error** with `tool_execution_failed` — command blocked by allowlist or execution error

## Routing Rules

- `{"clientName":"MY_DEVICE"}` — route by device name (recommended)
- `{"connection_id":"conn-xxx"}` — route by connection ID (from /clients)
- Neither specified — routes to first connected device (avoid this)
- ⚠️ If `clientName` not found, returns 404 (never silently routes elsewhere)

## Available Tools

| Tool | Description | Example |
|------|-------------|---------|
| `shell_execute` | Run shell command | `{"command":"ls -la"}` |
| `file_read` | Read file content | `{"path":"/etc/hostname"}` |
| `remote_configure_mcp_server` | Install/update MCP server on worker | See MCP section below |
| `session_create` | Create interactive session | `{"command":"python3"}` |
| `session_stdin` | Send input to session | `{"sessionId":"...","data":"print('hi')\\n"}` |
| `session_read_output` | Read session output | `{"sessionId":"...","stream":"stdout"}` |
| `session_wait` | Wait for session state | `{"sessionId":"...","exited":true}` |
| `audit_read` | Read local audit entries from the worker | `{"limit":20}` |

Bundled MCP tools such as `computer_screenshot`, `pptx_open`, and `shiproom_fetch_loop` may also appear automatically when their bundled MCP manifests are available on the worker.

## Remote MCP Server Configuration

Install or update custom external MCP servers on workers remotely via `remote_configure_mcp_server`.

Bundled MCP servers under `mcp-servers/*/landgod.mcp.json` are auto-discovered and do not need this path unless you are overriding defaults.

⚠️ Requires worker `permissionProfile` = `full-local-admin` and `managedMcpServerAdmin.enabled = true`.

### Install HTTP MCP server
```bash
curl -s -m 30 -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "clientName":"MY_DEVICE",
    "tool_name":"remote_configure_mcp_server",
    "arguments":{
      "name":"my-mcp-service",
      "transport":"http",
      "url":"http://localhost:3000/mcp",
      "tools":["tool1","tool2"],
      "published_remotely":true
    }
  }'
```

### Install stdio MCP server
```bash
curl -s -m 30 -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "clientName":"MY_DEVICE",
    "tool_name":"remote_configure_mcp_server",
    "arguments":{
      "name":"playwright",
      "transport":"stdio",
      "command":"npx",
      "args":["@anthropic/mcp-playwright"],
      "tools":["browser_navigate","browser_screenshot"],
      "published_remotely":true
    }
  }'
```

### Trust levels
- `experimental` (default for remote-created) — local only, not published upstream
- `trusted` — published remotely (must be manually promoted by device owner)
- `blocked` — disabled

New servers created via `remote_configure_mcp_server` default to `experimental`. The device operator must promote to `trusted` before tools are published upstream.

## Batch Operations

### POST /batch_tool_call (recommended)

Execute the same or different commands on multiple workers in parallel:

```bash
curl -s -X POST http://localhost:8081/batch_tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "calls": [
      {"clientName":"Worker1","tool_name":"shell_execute","arguments":{"command":"hostname && uname -a"}},
      {"clientName":"Worker2","tool_name":"shell_execute","arguments":{"command":"hostname && uname -a"}}
    ],
    "timeout": 30000
  }'
```

Response:
```json
{
  "results": [
    {"index":0,"clientName":"Worker1","tool_name":"shell_execute","result":{"stdout":"..."}},
    {"index":1,"clientName":"Worker2","tool_name":"shell_execute","result":{"stdout":"..."}}
  ]
}
```

Each call runs independently — one failure doesn't block others.

### Centralized Audit Logs

```bash
# All workers
curl -s http://localhost:8081/audit

# Specific worker, last 20 entries
curl -s "http://localhost:8081/audit?clientName=Worker1&limit=20"
```

### Loop-based fallback (for dynamic device list)
```bash
for client in $(curl -s http://localhost:8081/clients | python3 -c "
import sys,json
for c in json.load(sys.stdin).get('clients',[]):
    print(c['clientName'])
"); do
  echo "=== $client ==="
  curl -s -m 30 -X POST http://localhost:8081/tool_call \
    -H "Content-Type: application/json" \
    -d "{\"clientName\":\"$client\",\"tool_name\":\"shell_execute\",\"arguments\":{\"command\":\"hostname && uname -a\"}}"
  echo ""
done
```

## Common Operations

### Security scan
```bash
# Check for suspicious processes
curl -s -m 30 -X POST http://localhost:8081/tool_call \
  -d '{"clientName":"DEVICE","tool_name":"shell_execute","arguments":{"command":"ps aux | grep -iE \"miner|xmrig|crypto|kinsing\" | grep -v grep"}}'

# Check SSH brute force attempts
curl -s -m 30 -X POST http://localhost:8081/tool_call \
  -d '{"clientName":"DEVICE","tool_name":"shell_execute","arguments":{"command":"grep \"Failed password\" /var/log/auth.log | tail -10"}}'

# Check listening ports
curl -s -m 30 -X POST http://localhost:8081/tool_call \
  -d '{"clientName":"DEVICE","tool_name":"shell_execute","arguments":{"command":"ss -tlnp"}}'
```

### System info
```bash
# Disk usage
{"command":"df -h /"}

# Memory
{"command":"free -h"}

# Uptime + load
{"command":"uptime"}

# OS info
{"command":"cat /etc/os-release | head -5"}
```

### Windows commands
```bash
# Process list (Windows)
{"command":"tasklist"}

# Network connections (Windows)
{"command":"netstat -an"}

# System info (Windows)
{"command":"systeminfo | findstr /B /C:\"OS Name\" /C:\"Total Physical Memory\""}
```

## Timeouts

- Default Gateway timeout: **30 seconds**
- For long-running commands, pass `timeout` parameter:
  ```json
  {"clientName":"X","tool_name":"shell_execute","arguments":{"command":"long-cmd"},"timeout":120000}
  ```
- ⚠️ Commands exceeding timeout will be killed on the worker side

## Permission Profiles

Worker allowlist controls what commands can run:

| Profile | Allowed | Blocked |
|---------|---------|---------|
| `command-only` | echo, ls, cat, hostname, ps | npm, git, curl, rm |
| `interactive-trusted` | + git, node, npm, curl, find | rm, chmod, wget |
| `full-local-admin` | everything | nothing |

If a command is blocked: `"error":"Executable is outside the allowlist: xxx"`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `No connected client named` | Device offline — check worker process |
| `tool_call timeout` | Command too slow or worker unresponsive — increase timeout or restart worker |
| `Executable is outside the allowlist` | Change worker's `permissionProfile` to `full-local-admin` |
| `{success: true}` only, no stdout | Worker profile is `command-only` — change to `full-local-admin` |
| `user_rejected` | `toolCallApprovalMode` is `manual` — set to `auto` |

## External MCP Server (remote_configure_mcp_server)

### Why external MCP tools may not appear in `/tools`

Custom external MCP servers (like Playwright) configured via `managed-client.mcp-servers.json` must meet ALL conditions:

1. **`permissionProfile` = `full-local-admin`** — required for external MCP
2. **`managedMcpServerAdmin` enabled** in config:
   ```bash
   landgod config set builtInTools.managedMcpServerAdmin.enabled true
   landgod config set builtInTools.managedMcpServerAdmin.allowStdioServers true
   landgod config set builtInTools.managedMcpServerAdmin.allowHttpServers true
   ```
3. **`trustLevel` = `trusted`** — servers at `experimental` level are NOT published remotely
4. **`publishedRemotely` = true** — must be explicitly set
5. **The MCP server command must work** — e.g. `npx @playwright/mcp` must be installed and runnable on the machine
6. **Worker must be restarted** after config changes

### Check `/tools` endpoint
```bash
curl http://localhost:8081/tools
```
Returns per-worker tool list including external MCP tools if loaded successfully.

### MCP server startup timing
External MCP servers (like Playwright) are stdio processes that take a few seconds to start. After worker connects to Gateway:
1. First `update_tools` sends only built-in tools (7)
2. External MCP server process starts in background
3. Second `update_tools` sends all tools (built-in + external)
4. `/tools` may show only 7 tools for the first ~10 seconds, then updates to full count

If external MCP tools never appear, check:
```bash
# Worker audit log - look for "external mcp server connected"
cat <landgod_dir>/.landgod-data/audit.jsonl | grep "external mcp"

# Worker config - managedMcpServerAdmin must be enabled
landgod config show | grep managedMcpServerAdmin

# MCP servers config file
cat <landgod_dir>/managed-client.mcp-servers.json
```

### Configure external MCP server via config file
Create `managed-client.mcp-servers.json` next to `managed-client.config.json`.

Full playwright config with all 21 tools (current `@playwright/mcp` naming):
```json
{
  "playwright": {
    "enabled": true,
    "transport": "stdio",
    "command": "npx",
    "args": ["@playwright/mcp"],
    "tools": [
      "browser_close", "browser_resize", "browser_console_messages",
      "browser_handle_dialog", "browser_evaluate", "browser_file_upload",
      "browser_fill_form", "browser_press_key", "browser_type",
      "browser_navigate", "browser_navigate_back", "browser_network_requests",
      "browser_run_code", "browser_take_screenshot", "browser_snapshot",
      "browser_click", "browser_drag", "browser_hover",
      "browser_select_option", "browser_tabs", "browser_wait_for"
    ],
    "trustLevel": "trusted",
    "publishedRemotely": true,
    "requiredPermissionProfile": "full-local-admin"
  }
}
```
Then restart worker. Tools will appear with prefix: `playwright.browser_navigate`.

### Tool name matching is strict whitelist
The `tools` array must list exact names returned by the MCP server `tools/list`. Mismatched names are silently filtered — no error, tools just don't appear in `/tools`.

Always verify actual tool names before configuring by running the MCP server with JSON-RPC `tools/list` call. Old names like `init-browser`, `get-full-dom` are wrong — current `@playwright/mcp` uses `browser_*` naming. Wildcard `["*"]` and empty `[]` are both blocked.

### remote_configure_mcp_server default trustLevel
Servers created via the remote API default to `trustLevel=experimental`, blocking remote publication. Promote custom external servers to `"trustLevel": "trusted"` before expecting tools to appear upstream. Bundled MCP servers use their `landgod.mcp.json` manifest defaults and are not fixed through this manual step.

### Worker reconnect may lose external MCP tools
Workers sometimes disconnect and reconnect shortly after starting. On reconnect, external MCP tools can be lost (first `update_tools` has full count, second has only 7 built-in). Check `audit.jsonl` for two `update_tools` entries. Workaround: retry after a few seconds, or restart worker.

