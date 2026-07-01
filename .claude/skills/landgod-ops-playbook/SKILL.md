---
name: landgod-ops-playbook
description: Hard-won operational lessons for managing LandGod clusters. Use when troubleshooting worker disconnections, Gateway restarts, token mismatches, config issues, cross-border tunnels, Windows headless quirks, or any LandGod operational problem. This is a collection of real-world pitfalls and fixes from production experience. NOT for initial deployment (use landgod-gateway-setup / landgod-setup).
---

# LandGod Ops Playbook — Lessons From Production

Real-world operational lessons. Every entry here cost us debugging time.

## 🔑 Token Management

### Token mismatch is the #1 cause of "all workers offline"

**Symptom:** Gateway shows `connectedClients: 0`, workers are running but can't connect.

**Root cause:** Gateway was restarted with a different token than workers use.

**How it happens:**
1. Agent A starts Gateway with token X
2. Agent B restarts Gateway with token Y
3. All workers still have token X → connection rejected

**Fix:** Check Gateway's actual token, then update all workers:
```bash
# Find Gateway's token
cat /proc/$(pgrep -f "landgod-gateway/server" | head -1)/environ | tr '\0' '\n' | grep LANDGOD_AUTH_TOKEN

# Update worker config
landgod config set token "<CORRECT_TOKEN>"
```

**Prevention:** Store the bootstrap Worker Token in a shared location (e.g. environment variable file, secrets manager). Prefer issuing per-worker tokens via `/tokens` for long-lived fleets.

### Gateway log shows "rejected" vs "connected"

```bash
# Quick check
grep -E "rejected|connected" ~/.landgod-gateway/gateway.log | tail -10
```
- `Client connection rejected due to invalid token.` → Token mismatch
- `Client connected with valid token!` → Working

## 🔄 Gateway Restart Behavior

### Gateway restart = all workers disconnect

Gateway generates new Ed25519 signing keys on every restart. All existing sessions become invalid. Workers must reconnect and re-register.

**What happens:**
1. Gateway restarts → new keys generated
2. Workers detect disconnect → exponential backoff retry (3s→6s→12s→...→60s)
3. Workers reconnect → re-register → re-publish tools
4. Normal operation resumes

**How long until recovery:** Usually 3-60 seconds depending on backoff state.

**If workers don't come back after 2 minutes:**
1. Check token matches
2. Check network/tunnel is still up
3. Restart workers manually

### Only run ONE Gateway

Running multiple Gateway instances on the same port causes silent failures. Workers connect to whichever instance answers first, tool_call may route to the wrong instance.

```bash
# Kill all gateway processes before starting
pkill -f "landgod-gateway" && sleep 2
landgod-gateway start --daemon --token <TOKEN>
```

## 📝 Config Pitfalls

### Always use `landgod config set`, never edit JSON manually

```bash
# ✅ Correct — creates proper nested JSON
landgod config set builtInTools.permissionProfile full-local-admin
# Result: {"builtInTools": {"permissionProfile": "full-local-admin"}}

# ❌ Wrong — manual edit creates flat key, silently ignored
echo '{"builtInTools.permissionProfile": "full-local-admin"}' > config.json
# Result: profile stays as command-only, no error message
```

### `permissionProfile` determines stdout visibility

| Profile | `shell_execute` returns | `file_read` works |
|---------|------------------------|-------------------|
| `command-only` | `{"success": true}` only, **no stdout** | ❌ |
| `interactive-trusted` | `{"success": true}` only, **no stdout** | ❌ |
| `full-local-admin` | Full stdout + stderr + exit_code | ✅ |

**If you see `{"success":true}` but no output** → profile is not `full-local-admin`.

### `toolCallApprovalMode` in headless

If set to `manual` (default), headless behavior depends on whether the process has an interactive TTY:

- Foreground headless with TTY: prompts in the console for approve-once / approve-all / reject.
- Background daemon or no TTY: rejects the tool call because there is no approval responder.

For long-running headless workers, set approval to `auto`:

```bash
landgod config set toolCallApprovalMode auto
```

### Config survives process restart but NOT `npm install -g`

`npm install -g` **overwrites the entire package directory**, including `managed-client.config.json`. Always re-configure after reinstalling.

## 🌐 Network & Tunnels

### Quick Tunnel URL changes on every restart

`cloudflared tunnel --url http://localhost:8080` generates a random URL like `https://xyz.trycloudflare.com`. If cloudflared restarts, the URL changes. All workers using the old URL will fail to connect.

**Fix:** Update all workers' `bootstrapBaseUrl` after tunnel restart.

**Prevention:** Use a named Cloudflare Tunnel with a fixed domain.

### SSH reverse tunnels are fragile

SSH tunnels drop on:
- Network hiccup
- SSH keepalive timeout
- Server-side `ClientAliveInterval` expiry
- Firewall session timeout

**Strongly recommend Cloudflare Tunnel instead.** If you must use SSH:
```bash
# Use autossh for auto-reconnect
autossh -M 0 -fNR 8080:localhost:8080 user@target -o ServerAliveInterval=30
```

### Cross-border (GFW) connectivity

| Works | Blocked |
|-------|---------|
| Cloudflare Tunnel (WSS) | Direct SSH (sometimes) |
| github.com (usually) | google.com |
| npmjs.com (sometimes) | docker hub (sometimes) |

For China workers:
1. Use Cloudflare Tunnel for Gateway connection
2. Configure npm proxy for package installation
3. Have a fallback: download packages manually if npm timeout

## 🪟 Windows-Specific Issues

### Windows headless MUST cd to package directory

```cmd
REM ❌ Wrong — cwd mismatch, config not found
node C:\path\to\landgod\.vite\build\headless-entry.js

REM ✅ Correct — cd first
cd /d C:\Users\Administrator\.npm-global\lib\node_modules\landgod
node .vite\build\headless-entry.js
```

### Windows Worker needs these commands in allowlist

Default `full-local-admin` profile includes Linux commands. For Windows add:
```
tasklist, systeminfo, ipconfig, netstat, whoami, dir, type, findstr, wmic
```

Or configure via:
```bash
landgod config set builtInTools.shellExecute.allowedExecutableNames '["echo","hostname","whoami","tasklist","systeminfo","ipconfig","netstat","dir","type","findstr","node","npm","python","pip","curl"]'
```

### Windows scheduled task for auto-start

```cmd
schtasks /Create /SC ONSTART /TN "LandGodWorker" /TR "cmd /c cd /d C:\...\landgod && node .vite\build\headless-entry.js" /RU SYSTEM /F
```

### Windows shell_execute doesn't support shell features

`shell_execute` on Windows runs commands directly, NOT through `cmd.exe`. So:
- ❌ `echo hello && echo world` (shell chaining doesn't work)
- ❌ `for /f ...` (shell built-ins don't work)
- ✅ `hostname` (direct executables work)
- ✅ `python -c "print('hello')"` (works via python)

For complex Windows operations, use `python -c "..."` as the command.

## 🔧 MCP Server Configuration

### `remote_configure_mcp_server` defaults to experimental

Custom external MCP servers created via the remote API get `trustLevel: "experimental"`, which **blocks remote publication**. Tools won't appear in `/tools` until promoted.

This does not apply to bundled MCP servers such as `computer-use`, `pptx-editor`, or `shiproom`; those are discovered from `mcp-servers/*/landgod.mcp.json` and use manifest defaults.

**Fix for custom external MCP servers:** promote the server in `managed-client.mcp-servers.json`:
```json
{"trustLevel": "trusted", "publishedRemotely": true}
```

### Tool names must match EXACTLY

The `tools` array in MCP config is a strict whitelist. Wrong names = tools silently don't appear.

```bash
# Verify actual tool names before configuring
printf '{"jsonrpc":"2.0","id":1,"method":"initialize",...}\n{"jsonrpc":"2.0","id":2,"method":"tools/list",...}\n' | npx @playwright/mcp
```

### MCP tools may take 10+ seconds to appear after worker start

Worker startup sequence:
1. Connect + register → 7 built-in tools appear
2. External MCP servers start (few seconds)
3. `update_tools` sent → full tool list appears

Don't panic if `/tools` shows only 7 tools right after restart.

## 📊 Monitoring Best Practices

### Resource awareness via `/clients`

```bash
curl -s http://localhost:8081/clients | python3 -c "
import sys,json
for c in json.load(sys.stdin)['clients']:
    r = c.get('resources',{})
    print(f\"{c['clientName']}: mem {r.get('usedMemoryPercent','-')}% load {r.get('loadAvg1m','-')}\")"
```

### Centralized audit

```bash
curl -s "http://localhost:8081/audit?limit=10"
```

### Worker reconnect behavior

Exponential backoff: 3s → 6s → 12s → 24s → 48s → 60s (cap). Resets on successful connection. Random jitter prevents thundering herd.

If a worker has been failing for a while, it may take up to 60 seconds to retry. Restarting the worker resets the backoff.

## 🚫 Things That Will Break

| Action | Consequence | Recovery |
|--------|-------------|----------|
| `npm install -g` worker | Config wiped | Re-configure |
| Restart Gateway with wrong token | All workers rejected | Fix token, wait for reconnect |
| Kill cloudflared | Cross-border workers lose connection | Restart tunnel, update URLs |
| Run two Gateway instances | Silent routing failures | Kill all, start one |
| Set `toolCallApprovalMode: manual` in daemon/no-TTY headless | Tool calls rejected because no approval responder exists | Set to `auto`, use GUI/Electron mode, or run foreground headless with TTY |
| Manual JSON edit with flat keys | Config silently ignored | Use `landgod config set` |
| `git add -A` in repo | node_modules committed | Use `git add <specific files>` |
| SCP packages between machines | Wrong platform binaries | Always install from GitHub URL |

## ✅ Operational Checklist

### Before deploying a new worker
- [ ] Gateway is running and healthy (`curl localhost:8081/health`)
- [ ] You have the Gateway token
- [ ] Network path is confirmed (same network / tunnel active)
- [ ] Node.js installed on target machine

### After deploying a new worker
- [ ] Worker appears in `curl localhost:8081/clients`
- [ ] `permissionProfile` is correct (test with `shell_execute hostname`)
- [ ] Stdout returns full output (not just `{"success":true}`)
- [ ] Keepalive is configured (cron/schtasks)

### After Gateway restart
- [ ] All workers reconnected (check `/clients` after 60 seconds)
- [ ] Quick Tunnel URL unchanged (or workers updated)
- [ ] Token matches all workers

### Regular health check
- [ ] `/health` returns ok
- [ ] `/clients` shows expected worker count
- [ ] `/audit` shows recent activity (not stale)
- [ ] No `rejected` entries in gateway.log

## 👥 Team Collaboration Flow

When multiple agents manage the same LandGod cluster:

```
Issue detected (夜游神 patrol)
  │
  ├─ Network/tunnel issue → @太白金星 (SSH credentials + tunnel rebuild)
  ├─ Code/config bug     → @悟空 (development + deployment)
  ├─ Security alert       → @夜游神 escalates to @zww
  └─ Scheduling/routing   → @二郎神 (task coordination)
```

### Rules

1. **夜游神 detects, doesn't fix** — patrol agent reports issues, doesn't modify systems
2. **太白金星 owns credentials** — SSH keys, tokens, tunnel configs are managed by 太白金星
3. **悟空 owns code** — code changes, package builds, Gateway/Worker restarts
4. **Token changes must be coordinated** — changing Gateway token requires updating ALL workers
5. **Always ack in channel** — when receiving a task, respond immediately, then work

### Common Coordination Scenarios

| Scenario | Who does what |
|----------|--------------|
| All workers offline | 夜游神 reports → 悟空 checks Gateway token → 太白金星 checks tunnels |
| New worker deployment | 悟空 or 太白金星 deploys → 夜游神 verifies in next patrol |
| Gateway restart needed | 悟空 restarts → all workers auto-reconnect → 夜游神 confirms |
| Quick Tunnel URL changed | 悟空 restarts tunnel → 太白金星 updates remote worker configs |
| Security incident | 夜游神 alerts → 悟空 investigates → escalate to zww if real threat |

## 🔄 Version Upgrade Flow

### Step-by-step upgrade process

```bash
# 1. Build new packages on dev machine
cd /path/to/cli-server
make clean && make

# 2. Push to GitHub
git add -f downloads/
git commit -m "release: v0.x.x"
git push origin master

# 3. Upgrade Gateway
npm install -g https://github.com/zhou12138/cli-server/raw/master/downloads/landgod-gateway-<VERSION>.tgz
# Restart gateway (token preserved via environment variable)
LANDGOD_AUTH_TOKEN=<TOKEN> landgod-gateway start --daemon

# 4. Upgrade each Worker (config will be WIPED by npm install)
# Save config first!
cp managed-client.config.json /tmp/config-backup.json
npm install -g https://github.com/zhou12138/cli-server/raw/master/downloads/landgod-<VERSION>.tgz
cp /tmp/config-backup.json <new-install-path>/managed-client.config.json
# Restart worker
```

⚠️ **`npm install -g` wipes the config file.** Always backup before upgrading.

### China workers: use npm proxy

```bash
npm config set registry https://registry.npmmirror.com
npm install -g <package-url>
```

## 🛡️ fail2ban for SSH Protection

### Install and configure

```bash
sudo apt install -y fail2ban

sudo tee /etc/fail2ban/jail.local > /dev/null << EOF
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
bantime = 3600
findtime = 600
ignoreip = 127.0.0.1/8 <GATEWAY_IP>
EOF

sudo systemctl enable --now fail2ban
```

### Check status
```bash
sudo fail2ban-client status sshd
# Shows: Currently banned + Total banned count
```

### Whitelist trusted IPs
Add Gateway IP and known management IPs to `ignoreip` to prevent self-lockout.

## 📋 Known Services (Do Not Alert)

These are known, expected services. Patrol agents should NOT flag them:

| Port | Service | Machine | Notes |
|------|---------|---------|-------|
| 1080 | Squid proxy | ZhouTest1 | HTTP proxy, listening on `*:1080` |
| 8080 | LandGod Gateway WS | ZhouTest1 | Worker connections |
| 8081 | LandGod Gateway HTTP | ZhouTest1 | Agent API |
| 18789 | OpenClaw | ZhouTest1 | Agent runtime |
| 20241-20244 | Cloudflared metrics | ZhouTest1 | Tunnel health |
| 5353 | mDNS/Avahi | ZhouTest1 | Service discovery |

Add new known services to this list to avoid repeated false alarms.

## 📦 Package Download & Dependency Issues

### China/slow network machines can't download packages

Common problem: Windows or China servers downloading from GitHub/python.org at ~7KB/s or timing out.

**Solution: Download on a fast machine first, then SCP/transfer to the target.**

```bash
# 1. Download on your fast machine (e.g. Azure VM with good network)
curl -LO https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe
curl -LO https://github.com/zhou12138/cli-server/raw/master/downloads/landgod-0.1.2.tgz

# 2. SCP to target machine
scp python-3.12.0-amd64.exe Administrator@target:/tmp/
scp landgod-0.1.2.tgz Administrator@target:/tmp/

# 3. Install on target
ssh Administrator@target "C:\tmp\python-3.12.0-amd64.exe /quiet InstallAllUsers=1 PrependPath=1"
ssh Administrator@target "npm install -g C:\tmp\landgod-0.1.2.tgz"
```

⚠️ **SCP is allowed for dependency binaries (Python, Node.js installers).** The "no SCP" rule only applies to LandGod packages between production machines — to ensure version consistency via GitHub URL. But for bootstrapping dependencies on fresh machines with bad network, SCP is the practical choice.

### Windows: Python not installed

Typical dependency chain on fresh Windows:
```
1. No Python → need to install Python first
2. No winget → can't use winget to install Python
3. Direct download → python.org is slow from China
4. Solution: Download Python installer on fast machine → SCP → install
```

Python silent install on Windows:
```cmd
python-3.12.0-amd64.exe /quiet InstallAllUsers=1 PrependPath=1
```

### Node.js: npm not available on fresh machine

```bash
# Linux: install via package manager
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or download binary and SCP
curl -LO https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz
scp node-v22.22.2-linux-x64.tar.xz user@target:/tmp/
ssh user@target "cd /usr/local && tar xf /tmp/node-v22.22.2-linux-x64.tar.xz --strip-components=1"

# Windows: download .msi and SCP
curl -LO https://nodejs.org/dist/v22.22.2/node-v22.22.2-x64.msi
scp node-v22.22.2-x64.msi Administrator@target:/tmp/
ssh Administrator@target "msiexec /i C:\tmp\node-v22.22.2-x64.msi /quiet"
```

### Download priority order

When a target machine has slow/no internet:
1. **Try direct install** (`npm install -g <github-url>`) — works if network is OK
2. **Try with proxy** (`npm config set registry https://registry.npmmirror.com`) — for China
3. **SCP from fast machine** — download on Azure/fast VPS, transfer to target
4. **Ask user to download manually** — last resort, give them the URL
