---
name: landgod-setup
description: Deploy and configure LandGod Worker execution nodes. Use when installing a worker on a new machine, configuring network connectivity (Cloudflare Tunnel, SSH tunnel fallback), setting permission profiles, choosing headless vs GUI/Electron mode, configuring worker labels, understanding bundled MCP autodiscovery, setting up keepalive, or troubleshooting worker connection issues. NOT for Gateway setup (use landgod-gateway-setup) or execution operations (use landgod-operate).
---

# LandGod Worker Setup

Deploy Worker execution nodes. Workers connect outbound to the Gateway via WebSocket and publish their local tool capabilities.

## Prerequisites

- **Node.js 18+** (22 recommended) on target machine
- Gateway already running (see `landgod-gateway-setup` skill)
- Gateway auth token (must match)

## Packages (from GitHub)

```bash
curl -sL https://api.github.com/repos/zhou12138/cli-server/contents/downloads | python3 -c "
import sys,json
for f in json.load(sys.stdin):
    if 'landgod-' in f['name'] and f['name'].endswith('.tgz') and 'gateway' not in f['name']:
        print(f['name'])
"
```

```bash
BASE=https://github.com/zhou12138/cli-server/raw/master/downloads
npm install -g $BASE/landgod-<VERSION>.tgz
```

## Interactive Setup

Ask the user these questions before deploying:

### Q1: How will you access the target machine?
| Option | Method | Prerequisites |
|--------|--------|--------------|
| **SSH access** | You SSH in and run commands | SSH credentials |
| **Direct access** | You're on the target machine | Terminal access |
| **No access** | User runs commands themselves | Give them instructions |

### Q2: What OS is the target machine?
| OS | Notes |
|----|-------|
| **Linux** | Most common, headless recommended |
| **Windows** | Must cd to package dir for headless |
| **macOS** | Same as Linux |

### Q3: Network connectivity — How can the worker reach the Gateway?
| Scenario | `bootstrapBaseUrl` | Setup needed |
|----------|--------------------|-------------|
| **Same machine** | `ws://localhost:8080` | None |
| **Same network/VPN** | `ws://<GATEWAY_IP>:8080` | Open port 8080 on gateway |
| **Different network** ⭐ | `wss://<TUNNEL>.trycloudflare.com` | **Cloudflare Tunnel (strongly recommended)** |
| **Cross-border/GFW** ⭐ | `wss://<TUNNEL>.trycloudflare.com` | **Cloudflare Tunnel (required)** |

⚠️ **For any cross-network deployment, strongly recommend Cloudflare Tunnel over SSH reverse tunnels.** SSH tunnels are fragile (drop on network hiccup, require keepalive hacks, blocked by some firewalls). Cloudflare Tunnel is free, reliable, auto-reconnects, and works through NAT/firewall/GFW.

**Cloudflare Tunnel setup (on Gateway machine):**
```bash
# Quick tunnel (testing — URL changes on restart)
cloudflared tunnel --url http://localhost:8080
# → Use the generated https://xxx.trycloudflare.com URL

# Named tunnel (production — stable URL, requires Cloudflare account + domain)
cloudflared tunnel create landgod
cloudflared tunnel route dns landgod your-domain.com
cloudflared tunnel run --url http://localhost:8080 landgod
```

**SSH reverse tunnel (fallback only, not recommended):**
```bash
ssh -fNR 8080:localhost:8080 user@target-machine -i <SSH_KEY>
# Fragile: drops on network hiccup, needs autossh or cron to keep alive
```

### Q4: What security level?
| Profile | Commands available | Risk | Best for |
|---------|-------------------|------|----------|
| `command-only` | echo, ls, cat, hostname, ps, df | Low | Read-only monitoring |
| `interactive-trusted` | + git, node, npm, curl, python, find | Medium | Dev environment |
| `full-local-admin` | Everything + rm, chmod, systemctl | High | Full management |

⚠️ `full-local-admin` gives complete control. Only use when you fully trust the remote agent.

### Q5: Run mode
| Mode | When to choose | Extra setup |
|------|---------------|-------------|
| **Headless** (recommended) | Servers, no GUI needed | None |
| **GUI / Electron daemon** | Enterprise desktop demo, PPT/Office, computer-use, manual approval, login-state prep | npm install + system deps + real desktop session |

Guideline:
- Long-running server Worker → use `landgod daemon start --headless`.
- Enterprise-machine demo for PPT / Office / `computer-use` / first-time browser login → use GUI or Electron daemon with a real desktop session.

### Q6: Worker labels (optional)
Ask if they want to tag this worker with capabilities for label-based routing:

```bash
# Examples:
landgod config set labels '{"role":"ml","gpu":true}'
landgod config set labels '{"region":"cn","role":"monitor"}'
landgod config set labels '{"platform":"windows","role":"build"}'
```

Common label patterns:
| Label | Values | Use case |
|-------|--------|----------|
| `gpu` | true/false | Route ML tasks |
| `region` | us, cn, jp, eu | Geo-distributed testing |
| `role` | ml, web, db, build, monitor | Functional role |
| `platform` | linux, windows, macos | OS-specific tasks |

## Step 1: Install

```bash
npm install -g $BASE/landgod-<VERSION>.tgz
```

For GUI mode (Q5 = GUI), also install Electron dependencies:
```bash
cd $(node -e "console.log(require.resolve('landgod/package.json').replace('/package.json',''))")
npm install
# Linux GUI also needs:
sudo apt-get install -y libgtk-3-0 libnss3 libasound2t64 libcups2 xvfb
```

## Step 2: Configure

⚠️ **Always use `landgod config set` command. Do NOT manually write/edit the JSON config file.** The command handles nested key paths correctly (e.g. `builtInTools.permissionProfile` → `{"builtInTools":{"permissionProfile":"..."}}`). Manual JSON editing often produces flat keys that are silently ignored.

Apply answers from the questions:



```bash
landgod config set enabled true
landgod config set mode managed-client-mcp-ws
landgod config set bootstrapBaseUrl "<ANSWER_FROM_Q3>"
landgod config set token "<GATEWAY_TOKEN>"
landgod config set toolCallApprovalMode auto
landgod config set builtInTools.permissionProfile <ANSWER_FROM_Q4>
```

If Q6 was answered:
```bash
landgod config set labels '<JSON_FROM_Q6>'
```

Verify config:
```bash
landgod config show
```

## Bundled MCP Autodiscovery

Current LandGod discovers bundled MCP servers from `mcp-servers/*/landgod.mcp.json`.

Built-in bundled MCPs include:

- `computer-use` — generic desktop actions
- `pptx-editor` — PowerPoint / Office automation
- `shiproom` — domain workflow MCP

Do not manually create `managed-client.mcp-servers.json` for these unless you are overriding the bundled defaults or troubleshooting. Custom external MCP servers can still be configured through `managed-client.mcp-servers.json` or `remote_configure_mcp_server`.

## Step 3: Start

```bash
# Headless (Q5 = headless, recommended)
landgod daemon start --headless

# GUI / Electron daemon (Q5 = GUI or desktop-dependent demo)
landgod daemon start

# Windows headless — must cd to package dir first!
cd C:\...\node_modules\landgod
node .vite\build\headless-entry.js
```

## Step 4: Verify

From the Gateway machine:
```bash
curl -s http://localhost:8081/clients
# The new worker should appear with its labels and resources
```

## Worker Keepalive

### Linux cron (every minute)
```bash
(crontab -l 2>/dev/null; echo "* * * * * pgrep -f headless-entry > /dev/null || cd <LANDGOD_DIR> && nohup node .vite/build/headless-entry.js >> /tmp/landgod.log 2>&1 &") | crontab -
```

### Windows scheduled task
```cmd
schtasks /Create /SC ONSTART /TN "LandGodWorker" /TR "cmd /c cd /d C:\...\landgod && node .vite\build\headless-entry.js" /RU SYSTEM /F
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `toolCallApprovalMode` is `manual` in daemon/no-TTY headless | Tool calls rejected because no approval responder exists | Set to `auto`, use GUI/Electron mode, or run foreground headless with TTY |
| `permissionProfile` shows `command-only` | Limited commands available | Set to `full-local-admin` |
| `clientName` routes to wrong worker | Gateway bug (old version) | Update gateway |
| `Electron is not installed` | GUI mode without Electron deps | Use `--headless` |
| Windows headless exits immediately | Wrong working directory | `cd` to landgod package dir first |
| Quick Tunnel URL changed | Tunnel restarted | Update worker `bootstrapBaseUrl` + restart |
| `Unexpected server response: 200` | Wrong port or path | Check bootstrapBaseUrl points to WS port 8080 |
| 403 error in packaged Electron | Origin header mismatch | Update to v0.1.2+ |

## WebSocket Path Rules

| bootstrapBaseUrl | Generated WS URL | Notes |
|---|---|---|
| `ws://localhost:8080` | `ws://localhost:8080/` | No path appended |
| `wss://tunnel.trycloudflare.com` | `wss://tunnel.trycloudflare.com/` | No path appended |
| `https://example.com/api` | `wss://example.com/api/mcphub/ws` | Auto-appends `/mcphub/ws` |

**Rule:** `/api/mcphub/ws` is only appended when the path starts with `/api`. LandGod Gateway accepts any path.

## Worker Reconnect Behavior

Workers use exponential backoff for reconnection:
- Start at 3 seconds, double each failure (3s → 6s → 12s → 24s → 48s → 60s cap)
- Random jitter (0-1s) added to prevent thundering herd
- Resets to 3s on successful connection

On reconnect, external MCP server tools can be temporarily lost. After stabilization they re-register.

## MCP Server Tool Name Matching

The `tools` array in `managed-client.mcp-servers.json` is a **strict whitelist**. Tool names must match exactly.

Verify actual tool names before configuring:
```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | timeout 5 npx @playwright/mcp 2>/dev/null
```

`"tools": ["*"]` and `tools: []` are both blocked. You must list every tool by exact name.

## Common Pitfalls

- **China networks can't reach GitHub** — configure proxy or download manually. Never SCP packages.
- **`remote_configure_mcp_server` creates external servers with `trustLevel=experimental`** — promote them to `"trustLevel": "trusted"` before remote publication. Bundled MCPs use manifest defaults and do not need this manual step.
- **npm start works but tgz fails** — see WebSocket Path Rules and Troubleshooting above.
- **Worker keepalive is per-machine** — each machine needs its own cron/schtasks.

### Do NOT manually edit managed-client.config.json
Always use `landgod config set <dotted.key> <value>`. The CLI correctly creates nested JSON objects from dot-separated keys. Manually writing `{"builtInTools.permissionProfile": "full-local-admin"}` creates a flat key that is **silently ignored** — the worker falls back to `command-only` profile with no error message.
