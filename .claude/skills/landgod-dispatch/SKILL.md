---
name: landgod-dispatch
description: Intelligently dispatch tasks to LandGod Worker execution nodes based on capabilities, labels, and resources. Use when an AI agent needs to route tool calls by GPU/region/platform/business role, run async long-running tasks, queue tasks for offline workers, batch parallel execution, or check worker resource status. Covers label-based routing, async tasks, task queues, resource-aware scheduling, and centralized audit. NOT for initial deployment (use landgod-setup) or basic operations (use landgod-operate).
---

# LandGod Dispatch — AI Agent Resource Scheduling

Route tool calls to the right execution node automatically based on labels, resources, and availability.

## Gateway API

Default: `http://localhost:8081`

## Worker Discovery

### List workers with resources
```bash
curl -s http://localhost:8081/clients
```

Response includes per-worker metadata:
```json
{
  "clients": [{
    "clientName": "Worker1",
    "labels": {"gpu": true, "region": "us", "role": "ml"},
    "resources": {
      "platform": "linux",
      "cpuCount": 8,
      "totalMemoryMB": 32768,
      "freeMemoryMB": 16384,
      "usedMemoryPercent": 50,
      "loadAvg1m": 0.5,
      "uptime": 86400
    }
  }]
}
```

### List tools per worker
```bash
curl -s http://localhost:8081/tools
```

## Routing Strategies

### 1. By name (explicit)
```bash
curl -X POST http://localhost:8081/tool_call \
  -d '{"clientName":"Worker1","tool_name":"shell_execute","arguments":{"command":"hostname"}}'
```

### 2. By labels (capability-based)

Find a worker matching ALL specified labels:
```bash
# Route to a GPU worker
curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"gpu":true},"tool_name":"shell_execute","arguments":{"command":"nvidia-smi"}}'

# Route to a specific region
curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"region":"jp"},"tool_name":"shell_execute","arguments":{"command":"curl -s ifconfig.me"}}'

# Route by platform
curl -X POST http://localhost:8081/tool_call \
  -d '{"labels":{"platform":"windows"},"tool_name":"shell_execute","arguments":{"command":"systeminfo"}}'
```

### 3. Routing priority

`connection_id` → `clientName` → `labels` → first available worker

## Parallel Dispatch (batch_tool_call)

Execute on multiple workers simultaneously:
```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -d '{
    "calls": [
      {"clientName":"Worker-US","tool_name":"shell_execute","arguments":{"command":"curl -w %{time_total} -o /dev/null -s https://target.com"}},
      {"clientName":"Worker-JP","tool_name":"shell_execute","arguments":{"command":"curl -w %{time_total} -o /dev/null -s https://target.com"}},
      {"labels":{"region":"cn"},"tool_name":"shell_execute","arguments":{"command":"curl -w %{time_total} -o /dev/null -s https://target.com"}}
    ],
    "timeout": 30000
  }'
```

Each call runs independently — one failure does not block others.

## Async Tasks (long-running)

For tasks that take minutes or hours (model training, large scans):

### Submit async
```bash
curl -X POST "http://localhost:8081/tool_call?async=true" \
  -d '{"clientName":"GPU-Worker","tool_name":"shell_execute","arguments":{"command":"python train.py --epochs 100"}}'
```
Returns immediately:
```json
{"taskId": "task-xxx", "status": "pending"}
```

### Poll result
```bash
curl http://localhost:8081/tasks/task-xxx
```
```json
{"taskId": "task-xxx", "status": "completed", "result": {...}, "completedAt": "..."}
```

### List all tasks
```bash
curl http://localhost:8081/tasks
curl "http://localhost:8081/tasks?status=pending"
```

## Task Queue (offline workers)

Queue tasks for workers that are currently offline:

### Submit to queue
```bash
curl -X POST "http://localhost:8081/tool_call?queue=true" \
  -d '{"clientName":"OfflineWorker","tool_name":"shell_execute","arguments":{"command":"hostname"}}'
```
Returns:
```json
{"taskId": "task-xxx", "status": "queued"}
```

When the worker comes online, the task executes automatically. Check result via `GET /tasks/task-xxx`.

### Queue + labels
```bash
curl -X POST "http://localhost:8081/tool_call?queue=true" \
  -d '{"labels":{"gpu":true},"tool_name":"shell_execute","arguments":{"command":"nvidia-smi"}}'
```
Queued until any GPU-labeled worker connects.

## Resource-Aware Scheduling

Workers report resources every 60 seconds. Use `/clients` to make scheduling decisions.

### Decision pattern
```
1. GET /clients → check resources
2. Find worker with: lowest loadAvg1m, most freeMemoryMB, matching labels
3. POST /tool_call with chosen target
```

### Resource fields
| Field | Type | Description |
|-------|------|-------------|
| `platform` | string | linux, win32, darwin |
| `arch` | string | x64, arm64 |
| `cpuCount` | number | CPU core count |
| `cpuModel` | string | CPU model name |
| `totalMemoryMB` | number | Total RAM |
| `freeMemoryMB` | number | Available RAM |
| `usedMemoryPercent` | number | RAM usage % |
| `loadAvg1m` | number | 1-min load average |
| `uptime` | number | System uptime (seconds) |

## Worker Labels

Workers declare labels in config:
```bash
landgod config set labels '{"gpu":true,"region":"us","role":"ml"}'
```

Common label patterns:
| Label | Values | Use case |
|-------|--------|----------|
| `gpu` | true/false | Route ML tasks |
| `region` | us, jp, cn, eu | Geo-distributed testing |
| `platform` | linux, windows, macos | OS-specific tasks |
| `role` | ml, web, db, build | Functional role |
| `env` | prod, staging, dev | Environment isolation |

## Centralized Audit

View audit logs from all workers:
```bash
# All workers
curl http://localhost:8081/audit

# Specific worker
curl "http://localhost:8081/audit?clientName=Worker1&limit=20"
```

## Common Dispatch Patterns

### Multi-region latency test
1. `POST /batch_tool_call` with workers in different regions
2. Each runs `curl -w "%{time_total}"` to the target
3. Compare results

### Distribute scan across workers
1. `GET /clients` → get worker list
2. Split targets evenly
3. `POST /batch_tool_call` with each worker scanning its portion
4. Aggregate results

### Long training job
1. `POST /tool_call?async=true` with `labels:{"gpu":true}`
2. Store task_id
3. Periodically `GET /tasks/:id` to check status
4. When completed, read result

### Queue for nightly maintenance
1. `POST /tool_call?queue=true` for each offline worker
2. Workers execute queued tasks when they boot for nightly maintenance
3. Check results next morning via `GET /tasks`
