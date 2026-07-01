# Example: Distributed Testing with LandGod

> Run the same tests across multiple OS, regions, and networks simultaneously. Compare results in one view.

Mission fit:

- execution happens where the environment really exists
- network truth comes from the right region
- the Agent does not need direct access to every test environment

## Scenario Setup

```
Agent (orchestrator)
  │
  ├→ ZhouTest1    (Azure US, Linux)
  ├→ ZhouTest4    (Azure US, Linux)
  └→ China Node   (Alibaba Cloud, Linux, behind GFW)
```

---

## 1. Cross-Platform Compatibility Testing

Run the same test suite on all machines in parallel:

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "calls": [
      {
        "clientName": "ZhouTest1",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== $(hostname) $(uname -s) $(uname -m) ===\" && node -e \"console.log(JSON.stringify({node:process.version, arch:process.arch, platform:process.platform, mem:Math.round(require(\\\"os\\\").freemem()/1e6)+\\\"MB\\\"}))\""
        }
      },
      {
        "clientName": "ZhouTest4",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== $(hostname) $(uname -s) $(uname -m) ===\" && node -e \"console.log(JSON.stringify({node:process.version, arch:process.arch, platform:process.platform, mem:Math.round(require(\\\"os\\\").freemem()/1e6)+\\\"MB\\\"}))\""
        }
      },
      {
        "clientName": "iZ2ze9uw5uxdsyxknwfzx1Z",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== $(hostname) $(uname -s) $(uname -m) ===\" && node -e \"console.log(JSON.stringify({node:process.version, arch:process.arch, platform:process.platform, mem:Math.round(require(\\\"os\\\").freemem()/1e6)+\\\"MB\\\"}))\""
        }
      }
    ]
  }'
```

One request, three machines, instant comparison.

---

## 2. Multi-Region Web Latency Test

Test the same URL from different geographic locations:

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "calls": [
      {
        "clientName": "ZhouTest1",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "curl -so /dev/null -w \"{\\\"host\\\":\\\"$(hostname)\\\",\\\"url\\\":\\\"https://www.google.com\\\",\\\"dns\\\":\\\"%{time_namelookup}\\\",\\\"connect\\\":\\\"%{time_connect}\\\",\\\"ttfb\\\":\\\"%{time_starttransfer}\\\",\\\"total\\\":\\\"%{time_total}\\\",\\\"http\\\":\\\"%{http_code}\\\"}\" https://www.google.com"
        }
      },
      {
        "clientName": "ZhouTest4",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "curl -so /dev/null -w \"{\\\"host\\\":\\\"$(hostname)\\\",\\\"url\\\":\\\"https://www.google.com\\\",\\\"dns\\\":\\\"%{time_namelookup}\\\",\\\"connect\\\":\\\"%{time_connect}\\\",\\\"ttfb\\\":\\\"%{time_starttransfer}\\\",\\\"total\\\":\\\"%{time_total}\\\",\\\"http\\\":\\\"%{http_code}\\\"}\" https://www.google.com"
        }
      },
      {
        "clientName": "iZ2ze9uw5uxdsyxknwfzx1Z",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "curl -so /dev/null -w \"{\\\"host\\\":\\\"$(hostname)\\\",\\\"url\\\":\\\"https://www.google.com\\\",\\\"dns\\\":\\\"%{time_namelookup}\\\",\\\"connect\\\":\\\"%{time_connect}\\\",\\\"ttfb\\\":\\\"%{time_starttransfer}\\\",\\\"total\\\":\\\"%{time_total}\\\",\\\"http\\\":\\\"%{http_code}\\\"}\" https://www.google.com --max-time 10 2>/dev/null || echo '{\"error\":\"blocked_or_timeout\"}'"
        }
      }
    ]
  }'
```

**What this reveals:**
- DNS resolution time per region
- TCP connection latency
- Time to first byte (TTFB)
- Whether a site is blocked in China (GFW detection)

### CDN & Geo-Blocking Detection

```bash
# Test multiple URLs from multiple locations
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"ZhouTest1","tool_name":"shell_execute","arguments":{"command":"curl -sI https://target.com | head -5"}},
      {"clientName":"iZ2ze9uw5uxdsyxknwfzx1Z","tool_name":"shell_execute","arguments":{"command":"curl -sI https://target.com --max-time 10 | head -5 || echo BLOCKED"}}
    ]
  }'
```

---

## 3. Distributed Load Testing

### Quick Load Test (parallel from multiple machines)

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {
        "clientName": "ZhouTest1",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "python3 -c \"import urllib.request,time,json; results=[]; [results.append(time.time()) or urllib.request.urlopen(\\\"https://httpbin.org/get\\\") for _ in range(50)]; times=[results[i+1]-results[i] for i in range(len(results)-1)]; print(json.dumps({\\\"host\\\":\\\"$(hostname)\\\",\\\"requests\\\":50,\\\"avg_ms\\\":round(sum(times)/len(times)*1000,1),\\\"min_ms\\\":round(min(times)*1000,1),\\\"max_ms\\\":round(max(times)*1000,1)}))\""
        }
      },
      {
        "clientName": "ZhouTest4",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "python3 -c \"import urllib.request,time,json; results=[]; [results.append(time.time()) or urllib.request.urlopen(\\\"https://httpbin.org/get\\\") for _ in range(50)]; times=[results[i+1]-results[i] for i in range(len(results)-1)]; print(json.dumps({\\\"host\\\":\\\"$(hostname)\\\",\\\"requests\\\":50,\\\"avg_ms\\\":round(sum(times)/len(times)*1000,1),\\\"min_ms\\\":round(min(times)*1000,1),\\\"max_ms\\\":round(max(times)*1000,1)}))\""
        }
      }
    ]
  }'
```

### Long-Running Load Test (async)

```bash
# Submit async — don't wait for results
curl -X POST "http://localhost:8081/tool_call?async=true" \
  -d '{
    "clientName": "ZhouTest1",
    "tool_name": "shell_execute",
    "arguments": {
      "command": "python3 -c \"import urllib.request,time; start=time.time(); count=0; errs=0;\nwhile time.time()-start < 300:\n try: urllib.request.urlopen(\\\"https://target.com/api/health\\\"); count+=1\n except: errs+=1\nprint(f\\\"5min test: {count} ok, {errs} errors, {count/300:.1f} rps\\\")\""
    }
  }'
# → {"taskId": "task-xxx", "status": "pending"}

# Check results after 5 minutes
curl http://localhost:8081/tasks/task-xxx
```

---

## 4. Security Scanning

### Port Scan from Multiple Networks

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {
        "clientName": "ZhouTest1",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== Scan from $(hostname) $(curl -s ifconfig.me) ===\"; for port in 22 80 443 3306 5432 6379 8080 8443 9090; do (echo > /dev/tcp/TARGET_IP/$port) 2>/dev/null && echo \"$port OPEN\" || echo \"$port closed\"; done"
        }
      },
      {
        "clientName": "iZ2ze9uw5uxdsyxknwfzx1Z",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== Scan from $(hostname) $(curl -s ifconfig.me) ===\"; for port in 22 80 443 3306 5432 6379 8080 8443 9090; do (echo > /dev/tcp/TARGET_IP/$port) 2>/dev/null && echo \"$port OPEN\" || echo \"$port closed\"; done"
        }
      }
    ]
  }'
```

**Why multi-origin?** Different networks may have different firewall rules. A port open from Azure may be closed from Alibaba Cloud.

### Bulk Security Audit

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {
        "clientName": "ZhouTest1",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== Security Audit $(hostname) ===\"; echo \"Failed SSH:\"; grep -c \"Failed password\" /var/log/auth.log 2>/dev/null || echo N/A; echo \"Suspicious processes:\"; ps aux | grep -iE \"miner|xmrig|crypto|kinsing\" | grep -v grep | wc -l; echo \"Open ports:\"; ss -tlnp | grep LISTEN | awk \"{print \\$4}\" | sort; echo \"Disk:\"; df -h / | tail -1"
        }
      },
      {
        "clientName": "ZhouTest4",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== Security Audit $(hostname) ===\"; echo \"Failed SSH:\"; grep -c \"Failed password\" /var/log/auth.log 2>/dev/null || echo N/A; echo \"Suspicious processes:\"; ps aux | grep -iE \"miner|xmrig|crypto|kinsing\" | grep -v grep | wc -l; echo \"Open ports:\"; ss -tlnp | grep LISTEN | awk \"{print \\$4}\" | sort; echo \"Disk:\"; df -h / | tail -1"
        }
      },
      {
        "clientName": "iZ2ze9uw5uxdsyxknwfzx1Z",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "echo \"=== Security Audit $(hostname) ===\"; echo \"Failed SSH:\"; grep -c \"Failed password\" /var/log/auth.log 2>/dev/null || echo N/A; echo \"Suspicious processes:\"; ps aux | grep -iE \"miner|xmrig|crypto|kinsing\" | grep -v grep | wc -l; echo \"Open ports:\"; ss -tlnp | grep LISTEN | awk \"{print \\$4}\" | sort; echo \"Disk:\"; df -h / | tail -1"
        }
      }
    ]
  }'
```

### Centralized Audit Log Review

```bash
# View audit logs from all workers
curl "http://localhost:8081/audit?limit=10"

# Filter by specific worker
curl "http://localhost:8081/audit?clientName=ZhouTest1&limit=20"
```

---

## 5. End-to-End Web Testing with Playwright

Workers with Playwright MCP server can run browser automation:

```bash
# Navigate and screenshot from different regions
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {
        "clientName": "ZhouTest1",
        "tool_name": "browser_navigate",
        "arguments": {"url": "https://target.com"}
      },
      {
        "clientName": "ZhouTest4",
        "tool_name": "browser_navigate",
        "arguments": {"url": "https://target.com"}
      }
    ]
  }'

# Then take screenshots
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"ZhouTest1","tool_name":"browser_take_screenshot","arguments":{}},
      {"clientName":"ZhouTest4","tool_name":"browser_take_screenshot","arguments":{}}
    ]
  }'
```

**Use cases:**
- Visual regression testing across regions
- customer portal or supplier portal verification from the right geography
- browser-backend validation where login state must stay on the worker node
- Check if content differs by geo-location
- Verify CDN is serving correct assets
- Detect geo-blocking or censorship

---

## Summary

| Test Type | Method | Workers | Key Benefit |
|-----------|--------|---------|-------------|
| Cross-platform | `batch_tool_call` | All | One command, multi-OS comparison |
| Latency/CDN | `batch_tool_call` | Multi-region | Geo-distributed timing data |
| Load test | `?async=true` | Multiple | Parallel load, no timeout |
| Security scan | `batch_tool_call` | Multi-network | Different firewall perspectives |
| Browser E2E | `batch_tool_call` | Playwright workers | Visual + functional from multiple locations |
| Audit review | `GET /audit` | All | Centralized log analysis |
