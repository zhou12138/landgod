# Example: Distributed Data Analysis with LandGod

> Agent stays lightweight. Workers do the heavy lifting. Only results travel back.

Mission fit:

- data stays near the right machine
- compute stays near the right machine
- the Agent only orchestrates and interprets

## The Problem

Your AI agent runs on a small machine (8GB RAM, 50GB disk). You need to analyze a large dataset (weather data, logs, CSV files) that won't fit on the agent's machine.

**Traditional approach:** Download data to agent → OOM / disk full → 💥

**LandGod approach:** Agent sends commands → Workers download & analyze locally → Only results come back (a few KB)

```
Agent (8GB, small)                    Worker (32GB, large disk)
  │                                     │
  │  "download this dataset"  ────────→ │ curl -o /tmp/data.csv https://...
  │                                     │ (50GB downloaded locally)
  │  "run this analysis"      ────────→ │ python3 analyze.py
  │                                     │ (processed locally)
  │  ←──── "avg: 23.5°C, max: 41°C"    │
  │  (only results, ~100 bytes)         │
```

## Example 1: Single Worker Analysis

### Step 1: Download data on the Worker

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Worker1",
    "tool_name": "shell_execute",
    "arguments": {
      "command": "curl -sL -o /tmp/weather.csv https://bulk.meteostat.net/v2/daily/72502.csv.gz && gunzip -f /tmp/weather.csv.gz && wc -l /tmp/weather.csv"
    }
  }'
```

Data never touches the agent. Worker downloads directly.

### Step 2: Write analysis script on the Worker

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Worker1",
    "tool_name": "shell_execute",
    "arguments": {
      "command": "cat > /tmp/analyze.py << '\''SCRIPT'\''\nimport csv\nwith open(\"/tmp/weather.csv\") as f:\n    reader = csv.reader(f)\n    temps = [float(row[1]) for row in reader if len(row) > 1 and row[1].replace(\".\",\"\").replace(\"-\",\"\").isdigit()]\nprint(f\"Records: {len(temps)}\")\nprint(f\"Avg temp: {sum(temps)/len(temps):.1f}°C\")\nprint(f\"Max temp: {max(temps):.1f}°C\")\nprint(f\"Min temp: {min(temps):.1f}°C\")\nSCRIPT"
    }
  }'
```

### Step 3: Run analysis, get only results

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Worker1",
    "tool_name": "shell_execute",
    "arguments": {"command": "python3 /tmp/analyze.py"}
  }'
```

Response (~100 bytes):
```
Records: 18250
Avg temp: 12.3°C
Max temp: 41.0°C
Min temp: -15.2°C
```

## Example 2: Parallel Analysis (Multi-Worker)

Split the work across two workers for 2x speed:

```bash
curl -X POST http://localhost:8081/batch_tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "calls": [
      {
        "clientName": "Worker1",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "curl -sL https://bulk.meteostat.net/v2/daily/72502.csv.gz | gunzip | python3 -c \"import csv,sys; temps=[float(r[1]) for r in csv.reader(sys.stdin) if len(r)>1 and r[1].replace(\\\".\\\",\\\"\\\").replace(\\\"-\\\",\\\"\\\").isdigit()]; print(f\\\"NYC: {sum(temps)/len(temps):.1f}°C avg, {max(temps):.1f}°C max\\\")\""
        }
      },
      {
        "clientName": "Worker2",
        "tool_name": "shell_execute",
        "arguments": {
          "command": "curl -sL https://bulk.meteostat.net/v2/daily/47662.csv.gz | gunzip | python3 -c \"import csv,sys; temps=[float(r[1]) for r in csv.reader(sys.stdin) if len(r)>1 and r[1].replace(\\\".\\\",\\\"\\\").replace(\\\"-\\\",\\\"\\\").isdigit()]; print(f\\\"Tokyo: {sum(temps)/len(temps):.1f}°C avg, {max(temps):.1f}°C max\\\")\""
        }
      }
    ]
  }'
```

Both workers download and analyze simultaneously. Results return together:
```json
{
  "results": [
    {"clientName": "Worker1", "result": "NYC: 12.3°C avg, 41.0°C max"},
    {"clientName": "Worker2", "result": "Tokyo: 16.1°C avg, 39.5°C max"}
  ]
}
```

## Example 3: Async Long-Running Analysis

For analysis that takes minutes or hours:

```bash
# Submit async — returns immediately
curl -X POST "http://localhost:8081/tool_call?async=true" \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Worker1",
    "tool_name": "shell_execute",
    "arguments": {
      "command": "python3 -c \"import time; time.sleep(60); print(\\\"Analysis complete: 42 anomalies found\\\")\""
    }
  }'
# → {"taskId": "task-xxx", "status": "pending"}

# Check later
curl http://localhost:8081/tasks/task-xxx
# → {"status": "completed", "result": {"stdout": "Analysis complete: 42 anomalies found"}}
```

## Example 4: Label-Based Routing

Route data analysis to the right machine automatically:

```bash
# Configure workers with labels
# Worker1: landgod config set labels '{"role":"analytics","memory":"high"}'
# Worker2: landgod config set labels '{"role":"web","region":"us"}'

# Agent doesn't need to know machine names — just capabilities
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "labels": {"role": "analytics", "memory": "high"},
    "tool_name": "shell_execute",
    "arguments": {"command": "python3 /opt/heavy_analysis.py"}
  }'
```

Gateway automatically routes to the worker with matching labels.

## Why This Matters

| | Traditional Agent | LandGod |
|---|---|---|
| 50GB dataset | 💥 Disk full | ✅ Worker downloads locally |
| pandas on 2GB CSV | 💥 OOM | ✅ Route to high-memory Worker |
| Analyze 10 cities | ⏳ Serial, 10 min | ✅ Parallel, 1 min |
| GPU training | ❌ No GPU | ✅ Route to GPU Worker |
| Data in China | ❌ Can't download | ✅ China-region Worker downloads |

**The agent never needs to become the data plane. It only thinks, routes, and interprets.**
