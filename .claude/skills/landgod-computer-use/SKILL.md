---
name: landgod-computer-use
description: Use LandGod Computer Use for desktop automation via PyAutoGUI. Use when an agent needs a fallback GUI action layer on a worker with a real desktop session — screenshots, clicks, typing, scrolling, or desktop app demos. Current LandGod bundles computer-use via mcp-servers/computer-use/landgod.mcp.json, so manual MCP config is usually unnecessary. NOT for web-only automation (use Playwright) or sensitive business workflows that should be domain MCPs.
---

# LandGod Computer Use — Desktop Automation via MCP

Operate a Windows desktop (or Linux/Mac with a display) through a LandGod execution node.

Use this as a **generic GUI action layer**. For sensitive enterprise workflows, prefer a domain MCP that exposes business actions instead of raw screenshots and clicks.

## Current Integration Model

Current LandGod workers can discover bundled `computer-use` automatically from:

```text
mcp-servers/computer-use/landgod.mcp.json
```

Manual `managed-client.mcp-servers.json` configuration is only needed when overriding the bundled defaults or troubleshooting a custom deployment.

## Quick Reference

| Tool | Action |
|------|--------|
| `computer_screenshot` | Capture screen (JPEG, ~10KB) |
| `computer_click` | Click at x,y coordinates |
| `computer_type` | Type text, press keys, hotkeys |
| `computer_scroll` | Scroll up/down/left/right |

## Environment Requirements

### GPU vs No-GPU Decision Tree

```
Target machine has GPU/display? 
  ├─ YES → Install & use directly (no special setup)
  └─ NO (cloud VM) → Must use standard RDP client
       ├─ RDP connected → Start Worker IN RDP desktop → works
       └─ Only VNC/SSH → ❌ Screenshot won't work
```

**One rule:** Has GPU = direct. No GPU = need RDP.

### Cloud VM Compatibility

| Setup | Screenshot | Click/Type/Scroll |
|-------|-----------|-------------------|
| Physical PC with display | ✅ | ✅ |
| Cloud VM + standard RDP | ✅ (start Worker in RDP) | ✅ |
| Cloud VM + VNC console only | ❌ | ✅ |
| Cloud VM + SSH only | ❌ | ✅ |

## Installation / Discovery

### Default: Bundled MCP autodiscovery

In the current LandGod package, `computer-use` is bundled under `mcp-servers/` and discovered automatically if Python and dependencies are available.

Verify discovery:

```bash
curl http://localhost:8081/tools
# Should show computer_screenshot, computer_click, computer_type, computer_scroll
```

### Manual override (only if needed)

Use this only when you are not using the bundled MCP or need custom settings.

#### Step 1: Install Python package on Worker

```bash
pip install https://github.com/zhou12138/cli-server/raw/master/downloads/landgod_computer_use-0.1.0-py3-none-any.whl
```

China network? Use mirror:
```bash
pip install <path-to-whl> -i https://mirrors.aliyun.com/pypi/simple/
```

#### Step 2: Configure MCP Server

In Worker's landgod directory, create `managed-client.mcp-servers.json`:

```json
{
  "computer-use": {
    "enabled": true,
    "transport": "stdio",
    "command": "python",
    "args": ["-m", "landgod_computer_use"],
    "trustLevel": "trusted",
    "publishedRemotely": true,
    "tools": ["computer_screenshot", "computer_click", "computer_type", "computer_scroll"]
  }
}
```

⚠️ `trustLevel` must allow remote publication. Bundled MCP manifests already set this. For custom external MCP servers, `experimental` can block publication.

#### Step 3: Registry settings (Windows Server only)

```cmd
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" /v fDisableWallpaper /t REG_DWORD /d 0 /f
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" /v fEnableVirtualizedGraphics /t REG_DWORD /d 1 /f
```

### Start Worker

**With GPU/display (easy):**
```bash
landgod daemon start --headless
```

**Cloud VM without GPU (must use RDP):**
1. Connect via standard RDP client (mstsc.exe, NOT cloud VNC)
2. Open cmd IN the RDP desktop
3. Run: `cd /d C:\...\landgod && node .vite\build\headless-entry.js`
4. Keep RDP connected (disconnect OK, logout NOT OK)

⚠️ PsExec/SSH/schtasks won't work for screenshot — Worker must be started directly by user in RDP desktop.

### Verify

```bash
curl http://localhost:8081/tools
# Should show computer_screenshot, computer_click, computer_type, computer_scroll
```

## Usage

### Screenshot (MCP tool — preferred)

```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{"clientName":"WindowsPC","tool_name":"computer_screenshot","arguments":{"max_width":800,"quality":40}}'
```

Returns JPEG base64, ~10KB. Default: 800px width, quality 40.

### Screenshot (shell fallback — if MCP times out)

```bash
# Pre-encode python script as base64
SCRIPT=$(echo 'import pyautogui,base64,io
img=pyautogui.screenshot()
r=800/img.width
img=img.resize((800,int(img.height*r)))
buf=io.BytesIO()
img.save(buf,format="JPEG",quality=40)
print(base64.b64encode(buf.getvalue()).decode())' | base64 -w0)

curl -X POST http://localhost:8081/tool_call \
  -d "{\"clientName\":\"WindowsPC\",\"tool_name\":\"shell_execute\",\"arguments\":{\"command\":\"python -c \\\"import base64 as b;exec(b.b64decode('$SCRIPT'))\\\"\"}}"
# Decode stdout base64 → save as .jpg
```

### Click

```bash
# Single click
{"tool_name":"computer_click","arguments":{"x":500,"y":300}}

# Double click
{"tool_name":"computer_click","arguments":{"x":500,"y":300,"clicks":2}}

# Right click
{"tool_name":"computer_click","arguments":{"x":500,"y":300,"button":"right"}}
```

### Type

```bash
# Text
{"tool_name":"computer_type","arguments":{"text":"Hello World"}}

# Single key
{"tool_name":"computer_type","arguments":{"key":"enter"}}

# Hotkey
{"tool_name":"computer_type","arguments":{"hotkey":["ctrl","c"]}}
{"tool_name":"computer_type","arguments":{"hotkey":["alt","f4"]}}
{"tool_name":"computer_type","arguments":{"hotkey":["ctrl","shift","escape"]}}
```

### Scroll

```bash
# Down
{"tool_name":"computer_scroll","arguments":{"amount":-5}}

# Up
{"tool_name":"computer_scroll","arguments":{"amount":3}}
```

## Workflow: Screenshot → Analyze → Act

```
1. computer_screenshot          → Get screen image
2. Analyze image (or send to user) → Find element coordinates
3. computer_click/type/scroll   → Interact
4. computer_screenshot          → Verify result
```

## Coordinate System

Screenshots are resized (default 800px width). Screen coordinates are ORIGINAL resolution.

```
Screenshot 800x450 → element at pixel (200, 100)
Screen is 2560x1440 → actual coordinate: (200 * 2560/800, 100 * 1440/450) = (640, 320)
```

⚠️ Always use screen coordinates for click, not screenshot coordinates.

Use `screen_width` and `screen_height` from screenshot response to calculate.

## Shell Escaping Tip

Use base64 encoding for python scripts to avoid JSON → shell → python triple escaping:

```bash
SCRIPT=$(echo 'print("hello")' | base64 -w0)
python -c "import base64 as b;exec(b.b64decode('$SCRIPT'))"
```

## Pre-flight Checks (Run Before Every Screenshot)

Before attempting any screenshot, run these checks in order. Stop at the first failure and report the issue.

### Automated Checks (agent can fix)

```
Step 1: Gateway alive?
  curl -s -m 5 http://localhost:8081/health
  ├─ OK → continue
  └─ FAIL (exit 7) → restart: landgod-gateway start --daemon --token <TOKEN>
                      wait 3s, retry

Step 2: Target Worker online?
  curl -s http://localhost:8081/clients
  ├─ clientName found + connected=true → continue
  └─ NOT found → Worker is offline, cannot proceed
       Possible causes:
       - SSH reverse tunnel down (for cross-network workers)
       - Worker process crashed
       - Quick Tunnel address changed (if using trycloudflare.com)
       Agent action: notify user or ask 太白金星 to rebuild tunnel

Step 3: Active desktop session?
  tool_call → shell_execute: "query user"
  ├─ Shows active RDP session → continue
  └─ Empty or only "console" with "Disc" status → NO desktop available
       ❌ Screenshot will fail — user must RDP in first

Step 4: Test screenshot (small, fast)
  tool_call → shell_execute with PIL ImageGrab (100px, quality=20)
  ├─ Returns base64 data → ✅ Ready to take real screenshot
  └─ "screen grab failed" or "BitBlt" error → Worker not in desktop session
       ❌ Worker was started via PsExec/SSH/schtasks, not from RDP desktop
       User must manually restart Worker inside RDP (see below)
```

### Cannot Auto-fix (requires user action)

| Problem | Why agent can't fix | User action needed |
|---------|--------------------|--------------------|
| No RDP session | Agent has no RDP client | User must RDP to the Windows machine |
| Worker started via PsExec/SSH | Process lacks desktop handle even if in correct session | User opens CMD **inside RDP** and runs: `taskkill /F /IM node.exe` then `cd /d C:\...\landgod && node .vite\build\headless-entry.js` |
| RDP disconnected (logged out) | Desktop destroyed on logout | User must RDP again (disconnect is OK, logout is NOT) |
| Quick Tunnel address changed | New URL unknown until cloudflared restarts | Buy a domain + bind Cloudflare named tunnel (permanent fix) |

### Recommended Pre-flight Script

```bash
# All-in-one pre-flight check
echo "=== Pre-flight Check ==="

# 1. Gateway
GW=$(curl -s -m 5 http://localhost:8081/health 2>&1)
if echo "$GW" | grep -q '"status":"ok"'; then
  echo "✅ Gateway: OK"
else
  echo "❌ Gateway: DOWN — restarting..."
  landgod-gateway start --daemon --token "$LANDGOD_TOKEN"
  sleep 3
fi

# 2. Worker online
CLIENTS=$(curl -s http://localhost:8081/clients)
if echo "$CLIENTS" | grep -q '"WindowsServer"'; then
  echo "✅ Worker: Online"
else
  echo "❌ Worker: Offline — check tunnel/worker process"
  exit 1
fi

# 3. Desktop session (via tool_call)
# query user → check for active RDP session

# 4. Test grab (via tool_call)
# PIL ImageGrab.grab() with tiny resolution → if fails, report
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `screen grab failed` | No GPU + no RDP session | Connect via standard RDP, start Worker in RDP |
| `screen grab failed` (with RDP) | Worker started via SSH/PsExec | Restart Worker directly in RDP cmd |
| MCP tool timeout | Image too large | Use `max_width:800, quality:40` or shell fallback |
| Tools not in `/tools` | MCP config missing or trustLevel wrong | Check `managed-client.mcp-servers.json`, set `trustLevel:"trusted"` |
| `WinError 6` | Old version of computer-use | Update to latest whl |
| Click lands wrong spot | Coordinate mismatch | Use screen resolution, not screenshot resolution |

## When to Use This vs Playwright

| | Computer Use | Playwright |
|---|---|---|
| Target | Any desktop application | Web browsers only |
| Input | Screen coordinates (x, y) | CSS selectors / DOM |
| Use case | Excel, Notepad, OS dialogs, native apps | Web apps, forms, scraping |
| Needs display | Yes | No |

## Chunked Transfer for HD Screenshots

For high-resolution screenshots (>10KB), use chunked transfer to avoid timeout:

### Step 1: Save full-res screenshot on Windows
```bash
SAVE=$(echo 'import pyautogui
img=pyautogui.screenshot()
img.save("C:/Users/Administrator/screen.jpg",quality=60)
import os,math
s=os.path.getsize("C:/Users/Administrator/screen.jpg")
print(f"SIZE:{s} CHUNKS:{math.ceil(s/8000)}")' | base64 -w0)

# Execute on worker
shell_execute: python -c "import base64 as b;exec(b.b64decode('$SAVE'))"
# → SIZE:323735 CHUNKS:41
```

### Step 2: Transfer chunks (8KB each)
```bash
for i in $(seq 0 <CHUNKS-1>); do
  READ=$(printf "import base64\nf=open('C:/Users/Administrator/screen.jpg','rb')\nf.seek(%d)\nchunk=f.read(8000)\nprint(base64.b64encode(chunk).decode())" $((i*8000)) | base64 -w0)

  shell_execute: python -c "import base64 as b;exec(b.b64decode('$READ'))"
  # → decode stdout base64, append to local file
done
```

### Step 3: Concatenate binary chunks locally
Each chunk is independently base64-encoded. Decode each chunk separately, then concatenate the binary data.

### Transfer speed reference (Cloudflare Tunnel cross-border)

| Resolution | Quality | File size | Chunks (8KB) | Time |
|-----------|---------|-----------|--------------|------|
| 400px | q=20 | ~6KB | 1 (direct) | ~3s |
| 600px | q=40 | ~18KB | 3 | ~10s |
| 1024px | q=50 | ~52KB | 7 | ~20s |
| 2560x1440 | q=60 | ~317KB | 41 | ~2min |

**Recommendation:** Use 1024px q=50 for daily use (good clarity, 20s). Use full-res only when needed.
