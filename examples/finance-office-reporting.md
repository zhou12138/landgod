# Example: Finance UKey + Office Reporting

> Mission fit: keep sensitive credentials and desktop-only tools on their original machines while letting one Agent orchestrate the workflow.

## Scenario

The monthly management report needs three different kinds of execution:

- finance workstation: UKey / certificate / tax or banking download
- Office workstation: Excel cleanup and PowerPoint rendering
- analysis node: summarize, compare, and draft commentary

This is exactly the type of workflow the leadership deck describes as:

`one brain, multiple hands`

## Topology

```text
Agent
  |
  +--> Gateway / MCPHub
         |
         +--> Finance Worker   (UKey, bank/tax portal, browser session)
         +--> Office Worker    (Windows, Excel/PPT, templates)
         +--> Data Worker      (Python, analysis scripts, optional GPU)
```

## Worker Labels

```bash
# Finance node
landgod config set labels '{"role":"finance","ukey":true,"platform":"windows"}'

# Office node
landgod config set labels '{"role":"office","ppt":true,"excel":true,"platform":"windows"}'

# Analysis node
landgod config set labels '{"role":"analysis","python":true,"memory":"high"}'
```

## Step 1: Download Statement Or Reconciliation Input On Finance Node

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "labels": {"role": "finance", "ukey": true},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "powershell -NoProfile -File C:\\\\FinanceOps\\\\download_reconciliation.ps1 -Month 2026-06 -OutDir C:\\\\FinanceOps\\\\exports"
    }
  }'
```

## Step 2: Normalize The Workbook On Office Node

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "labels": {"role": "office", "excel": true},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "python C:\\\\OfficeOps\\\\normalize_finance_workbook.py --input C:\\\\FinanceOps\\\\exports\\\\reconciliation.xlsx --output C:\\\\OfficeOps\\\\prepared\\\\reconciliation-clean.xlsx"
    }
  }'
```

## Step 3: Produce Summary Metrics On Analysis Node

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "labels": {"role": "analysis"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "python /opt/reporting/monthly_summary.py --input /data/reconciliation-clean.xlsx --output /data/monthly-summary.json"
    }
  }'
```

## Step 4: Render The Executive Deck On Office Node

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "labels": {"role": "office", "ppt": true},
    "tool_name": "pptx_exec_actions",
    "arguments": {
      "presentationPath": "C:\\\\OfficeOps\\\\templates\\\\monthly-business-review.pptx",
      "actions": [
        {"type": "replace_text", "find": "{{MONTH}}", "replace": "2026-06"},
        {"type": "replace_text", "find": "{{SUMMARY_JSON}}", "replace": "C:\\\\OfficeOps\\\\prepared\\\\monthly-summary.json"}
      ]
    }
  }'
```

## Step 5: Audit The Whole Workflow Centrally

```bash
curl "http://localhost:8081/audit?limit=20"
```

## Why This Matters

- UKey, certificate, and browser login state never leave the finance machine
- PPT and Excel execute in the real Windows + Office environment
- the Agent coordinates the flow without holding the raw enterprise permissions itself
- each step is still routed, traceable, and revocable through Gateway

## PoC Goal

This is a strong leadership-facing demo because it shows:

1. sensitive permissions stay local
2. desktop-only execution still becomes tool-callable
3. one Agent can orchestrate finance, Office, and analysis as a single workflow
