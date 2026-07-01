# Example: Small Team Ops — 6 Capability Matrix

> One Gateway, multiple execution nodes with different roles. Agent routes by capability labels instead of machine-by-machine coordination.

This example shows the platform pattern behind the deck's message:

- one Agent acts as the brain
- Gateway is the control plane
- multiple workers become specialized enterprise hands

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              LandGod Gateway (scheduling plane)       │
│         Routes tasks by worker labels                 │
└───┬──────┬──────┬──────┬──────┬──────┬───────────────┘
    │      │      │      │      │      │
  🔍     🌐     📊     🛡️     🔧     📡
 Monitor Browser Data  Security Build  Network
```

## Worker Label Setup

```bash
# Monitor node (lightweight VPS, always online)
landgod config set labels '{"role":"monitor","always_on":true}'

# Browser node (has Chrome/Playwright)
landgod config set labels '{"role":"browser","playwright":true}'

# Data node (high memory, large disk)
landgod config set labels '{"role":"data","memory":"high"}'

# Security node (isolated)
landgod config set labels '{"role":"security","isolated":true}'

# Build node (high CPU)
landgod config set labels '{"role":"build","docker":true}'

# Network probe (China region)
landgod config set labels '{"role":"network","region":"cn"}'
```

> One machine can have multiple roles. A small team might run 2-3 machines covering all 6 capabilities and still present them as one controlled execution network.

---

## 🔍 Monitor — Health Checks & Alerting

### HTTP health check across services

```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{
    "labels": {"role": "monitor"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "for url in https://api.example.com/health https://web.example.com https://db.example.com:5432; do code=$(curl -so /dev/null -w \"%{http_code}\" --max-time 5 \"$url\" 2>/dev/null || echo \"000\"); echo \"$url → $code\"; done"
    }
  }'
```

### SSL certificate expiry check

```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{
    "labels": {"role": "monitor"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "for domain in example.com api.example.com; do expiry=$(echo | openssl s_client -connect $domain:443 -servername $domain 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2); days=$(( ($(date -d \"$expiry\" +%s 2>/dev/null || echo 0) - $(date +%s)) / 86400 )); echo \"$domain: expires in ${days} days ($expiry)\"; done"
    }
  }'
```

### Log error scanning

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"Worker1","tool_name":"shell_execute","arguments":{"command":"echo \"=== $(hostname) errors (last 1h) ===\"; journalctl --since \"1 hour ago\" -p err --no-pager 2>/dev/null | tail -20 || grep -i error /var/log/syslog 2>/dev/null | tail -20"}},
      {"clientName":"Worker2","tool_name":"shell_execute","arguments":{"command":"echo \"=== $(hostname) errors (last 1h) ===\"; journalctl --since \"1 hour ago\" -p err --no-pager 2>/dev/null | tail -20 || grep -i error /var/log/syslog 2>/dev/null | tail -20"}}
    ]
  }'
```

---

## 🌐 Browser — Playwright Web Automation

### Screenshot a website

```bash
# Navigate
curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"playwright":true},"tool_name":"browser_navigate","arguments":{"url":"https://example.com"}}'

# Screenshot
curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"playwright":true},"tool_name":"browser_take_screenshot","arguments":{}}'
```

### Competitor price monitoring

```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{
    "labels": {"playwright": true},
    "tool_name": "browser_navigate",
    "arguments": {"url": "https://competitor.com/pricing"}
  }'

# Get page content
curl -X POST http://localhost:8081/tool_call \
  -d '{
    "labels": {"playwright": true},
    "tool_name": "browser_snapshot",
    "arguments": {}
  }'
```

### Form automation

```bash
# Fill and submit a form
curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"playwright":true},"tool_name":"browser_navigate","arguments":{"url":"https://app.example.com/login"}}'

curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"playwright":true},"tool_name":"browser_fill_form","arguments":{"selector":"#email","value":"test@example.com"}}'

curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"playwright":true},"tool_name":"browser_click","arguments":{"selector":"#submit-btn"}}'
```

---

## 📊 Data — Analysis & Reporting

### Remote CSV analysis

```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{
    "labels": {"role": "data"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "python3 -c \"\nimport csv, json\nwith open(\"/var/log/access.log\") as f:\n    lines = f.readlines()[-10000:]\nstatus = {}\nfor l in lines:\n    parts = l.split()\n    if len(parts) > 8:\n        code = parts[8]\n        status[code] = status.get(code, 0) + 1\nprint(json.dumps({\\\"last_10k_requests\\\": status}, indent=2))\n\""
    }
  }'
```

### Database backup verification

```bash
curl -X POST "http://localhost:8081/tool_call?async=true" \
  -d '{
    "labels": {"role": "data"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "echo \"=== Backup Verification ===\"; ls -lh /backups/db/*.sql.gz 2>/dev/null | tail -5; latest=$(ls -t /backups/db/*.sql.gz 2>/dev/null | head -1); if [ -n \"$latest\" ]; then size=$(stat -f%z \"$latest\" 2>/dev/null || stat -c%s \"$latest\"); age=$(( ($(date +%s) - $(stat -c%Y \"$latest\")) / 3600 )); echo \"Latest: $latest ($size bytes, ${age}h ago)\"; gunzip -t \"$latest\" 2>&1 && echo \"Integrity: OK\" || echo \"Integrity: CORRUPTED\"; fi"
    }
  }'
```

### Log aggregation across all machines

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"Worker1","tool_name":"shell_execute","arguments":{"command":"echo \"{\\\"host\\\":\\\"$(hostname)\\\",\\\"disk_used\\\":\\\"$(df -h / | tail -1 | awk \"{print \\$5}\")\\\",\\\"errors_24h\\\":$(journalctl --since \"24h ago\" -p err --no-pager 2>/dev/null | wc -l),\\\"load\\\":\\\"$(uptime | awk -F\"average:\" \"{print \\$2}\")\\\"}\""}},
      {"clientName":"Worker2","tool_name":"shell_execute","arguments":{"command":"echo \"{\\\"host\\\":\\\"$(hostname)\\\",\\\"disk_used\\\":\\\"$(df -h / | tail -1 | awk \"{print \\$5}\")\\\",\\\"errors_24h\\\":$(journalctl --since \"24h ago\" -p err --no-pager 2>/dev/null | wc -l),\\\"load\\\":\\\"$(uptime | awk -F\"average:\" \"{print \\$2}\")\\\"}\""}},
      {"clientName":"Worker3","tool_name":"shell_execute","arguments":{"command":"echo \"{\\\"host\\\":\\\"$(hostname)\\\",\\\"disk_used\\\":\\\"$(df -h / | tail -1 | awk \"{print \\$5}\")\\\",\\\"errors_24h\\\":$(journalctl --since \"24h ago\" -p err --no-pager 2>/dev/null | wc -l),\\\"load\\\":\\\"$(uptime | awk -F\"average:\" \"{print \\$2}\")\\\"}\"" }}
    ]
  }'
```

---

## 🛡️ Security — Scanning & Auditing

### Suspicious process detection

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"Worker1","tool_name":"shell_execute","arguments":{"command":"echo \"$(hostname):\"; ps aux | grep -iE \"miner|xmrig|crypto|kinsing|masscan|botnet\" | grep -v grep | wc -l; echo \"open ports:\"; ss -tlnp | awk \"/LISTEN/{print \\$4}\" | sort -u"}},
      {"clientName":"Worker2","tool_name":"shell_execute","arguments":{"command":"echo \"$(hostname):\"; ps aux | grep -iE \"miner|xmrig|crypto|kinsing|masscan|botnet\" | grep -v grep | wc -l; echo \"open ports:\"; ss -tlnp | awk \"/LISTEN/{print \\$4}\" | sort -u"}}
    ]
  }'
```

### SSH brute-force monitoring

```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{
    "labels": {"role": "security"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "echo \"=== SSH Brute Force Report ===\"; echo \"Failed attempts:\"; grep \"Failed password\" /var/log/auth.log 2>/dev/null | awk \"{print \\$(NF-3)}\" | sort | uniq -c | sort -rn | head -10; echo \"\nBanned IPs (fail2ban):\"; fail2ban-client status sshd 2>/dev/null | grep \"Banned\" || echo \"fail2ban not installed\""
    }
  }'
```

### Firewall rule audit

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"Worker1","tool_name":"shell_execute","arguments":{"command":"echo \"=== $(hostname) firewall ===\"; iptables -L -n --line-numbers 2>/dev/null | head -30 || ufw status 2>/dev/null || echo \"no firewall detected\""}},
      {"clientName":"Worker2","tool_name":"shell_execute","arguments":{"command":"echo \"=== $(hostname) firewall ===\"; iptables -L -n --line-numbers 2>/dev/null | head -30 || ufw status 2>/dev/null || echo \"no firewall detected\""}}
    ]
  }'
```

---

## 🔧 Build — CI/CD & Deployment

### Docker build (async, takes time)

```bash
curl -X POST "http://localhost:8081/tool_call?async=true" \
  -d '{
    "labels": {"role": "build", "docker": true},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "cd /opt/myapp && git pull && docker build -t myapp:$(date +%Y%m%d) . && docker images myapp --format \"{{.Tag}} {{.Size}}\" | head -3"
    }
  }'
# → {"taskId":"task-xxx","status":"pending"}
# Check: curl http://localhost:8081/tasks/task-xxx
```

### Deploy to multiple machines

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"Worker1","tool_name":"shell_execute","arguments":{"command":"cd /opt/myapp && git pull origin main && npm install --production && pm2 restart myapp && echo \"$(hostname) deployed $(git rev-parse --short HEAD)\""}},
      {"clientName":"Worker2","tool_name":"shell_execute","arguments":{"command":"cd /opt/myapp && git pull origin main && npm install --production && pm2 restart myapp && echo \"$(hostname) deployed $(git rev-parse --short HEAD)\""}}
    ]
  }'
```

### Queue deploy for offline machine

```bash
curl -X POST "http://localhost:8081/tool_call?queue=true" \
  -d '{
    "clientName": "NightlyBuildServer",
    "tool_name": "shell_execute",
    "arguments": {
      "command": "cd /opt/myapp && git pull && npm test && npm run build"
    }
  }'
# Queued. Executes when NightlyBuildServer comes online.
```

---

## 📡 Network — Multi-Region Probing

### Cross-region latency comparison

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"ZhouTest1","tool_name":"shell_execute","arguments":{"command":"echo \"{\\\"from\\\":\\\"$(hostname) ($(curl -s ifconfig.me))\\\",\\\"to\\\":\\\"cloudflare.com\\\",\\\"dns_ms\\\":$(curl -so /dev/null -w \"%{time_namelookup}\" https://cloudflare.com),\\\"connect_ms\\\":$(curl -so /dev/null -w \"%{time_connect}\" https://cloudflare.com),\\\"total_ms\\\":$(curl -so /dev/null -w \"%{time_total}\" https://cloudflare.com)}\""}},
      {"clientName":"iZ2ze9uw5uxdsyxknwfzx1Z","tool_name":"shell_execute","arguments":{"command":"echo \"{\\\"from\\\":\\\"$(hostname) ($(curl -s ifconfig.me))\\\",\\\"to\\\":\\\"cloudflare.com\\\",\\\"dns_ms\\\":$(curl -so /dev/null -w \"%{time_namelookup}\" https://cloudflare.com),\\\"connect_ms\\\":$(curl -so /dev/null -w \"%{time_connect}\" https://cloudflare.com),\\\"total_ms\\\":$(curl -so /dev/null -w \"%{time_total}\" https://cloudflare.com)}\"" }}
    ]
  }'
```

### DNS resolution comparison

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"ZhouTest1","tool_name":"shell_execute","arguments":{"command":"echo \"$(hostname):\"; for d in google.com github.com openai.com; do echo \"$d → $(dig +short $d | head -1)\"; done"}},
      {"clientName":"iZ2ze9uw5uxdsyxknwfzx1Z","tool_name":"shell_execute","arguments":{"command":"echo \"$(hostname):\"; for d in google.com github.com openai.com; do echo \"$d → $(dig +short $d | head -1 || echo NXDOMAIN)\"; done"}}
    ]
  }'
```

### GFW block detection

```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{
    "labels": {"region": "cn"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "echo \"=== GFW Check from $(hostname) ===\"; for site in google.com youtube.com github.com npmjs.com pypi.org; do result=$(curl -so /dev/null -w \"%{http_code}\" --max-time 5 \"https://$site\" 2>/dev/null || echo \"000\"); if [ \"$result\" = \"000\" ]; then echo \"❌ $site BLOCKED\"; else echo \"✅ $site ($result)\"; fi; done"
    }
  }'
```

---

## Summary Matrix

| Capability | Label | Key Commands | Async? | Batch? |
|-----------|-------|-------------|--------|--------|
| 🔍 Monitor | `role:monitor` | curl, openssl, journalctl | ❌ Quick | ✅ Multi-host |
| 🌐 Browser | `playwright:true` | browser_* MCP tools | ❌ Quick | ✅ Multi-region |
| 📊 Data | `role:data` | python3, sqlite3 | ✅ Long analysis | ✅ Log aggregation |
| 🛡️ Security | `role:security` | grep, ss, fail2ban | ❌ Quick | ✅ Multi-host scan |
| 🔧 Build | `role:build` | docker, git, npm | ✅ Build tasks | ✅ Multi-deploy |
| 📡 Network | `region:cn/us` | curl, dig, traceroute | ❌ Quick | ✅ Multi-region |

**The agent doesn't need to know which machine does what — it routes by capability labels and treats the fleet as one execution layer.**
