# Example: AI Monthly Business Report Demo

> Mission fit: show LandGod / MCPHub as an Enterprise Execution Harness, not a shell demo.

## Scenario

A manager asks an AI Agent:

> Generate this month's business review: revenue, expense, watchlist suppliers, executive insights, and a PPT/HTML report.

The Agent should not hold finance passwords or read all data locally. Instead, LandGod routes the work to a trusted business MCP running on a Worker.

```text
Agent
  |
  | tool_call + credential_ref
  v
Gateway / MCPHub
  | policy check + single-use grant + central audit
  v
Worker
  | trusted business-report-demo MCP
  v
Mock ERP + Mock Finance data -> CSV / HTML / PPTX / audit story
```

## Demo MCP

Path:

```text
mcp-servers/business-report-demo/
```

Tools published remotely:

```text
business-report-demo.load_erp_orders
business-report-demo.load_finance_invoices
business-report-demo.generate_monthly_report
business-report-demo.run_monthly_close_demo
```

The main business-facing tool is:

```text
business-report-demo.run_monthly_close_demo
```

It creates:

```text
business_summary_2026-06.json
business_scorecard_2026-06.csv
business_report_2026-06.html
business_report_2026-06.pptx
audit_story_2026-06.md
```

## Local Smoke Test

```bash
./scripts/demo-business-report-smoke.sh /tmp/landgod-business-report-demo
```

## LandGod Demo Flow

### 1. Start Gateway and Worker

Use the normal Gateway + Worker flow. The bundled MCP manifest will auto-discover `business-report-demo` when Python and the MCP package are available.

### 2. Confirm Tool Publication

```bash
curl http://localhost:8081/tools
```

Look for:

```text
business-report-demo.run_monthly_close_demo
```

### 3. Create a Demo Credential

Use Gateway WebUI or API to create a credential with:

```text
credential_ref: cred_demo_finance_readonly
type: api_token
allowedTools: [business-report-demo.run_monthly_close_demo]
allowedScopes: [report]
allowedWorkerGroups: [finance-demo]
```

The secret can be a mock token. The tool only reports secret keys and never returns secret values.

### 4. Run the Business Tool

```bash
curl -X POST http://localhost:8081/tool_call \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "agent-business-demo",
    "clientName": "BusinessReportWorker",
    "tool_name": "business-report-demo.run_monthly_close_demo",
    "credential_ref": "cred_demo_finance_readonly",
    "credential_scope": "report",
    "arguments": {
      "month": "2026-06",
      "output_dir": "/tmp/landgod-business-report-demo"
    },
    "timeout": 60000
  }'
```

### 5. Show the Artifacts

```bash
ls -lh /tmp/landgod-business-report-demo
```

Open:

```text
business_report_2026-06.html
business_report_2026-06.pptx
```

### 6. Show the Audit Story

Gateway WebUI should show:

```text
Gateway central audit: tool_call_dispatched / tool_call_result_received
Credential audit: credential_grant_issued / credential_exchange_allowed
Worker audit: tool_call received / completed
```

## Sales Talk Track

Do not pitch this as "AI ran a script".

Pitch it as:

> An AI Agent generated a monthly business review by calling a trusted business tool on an enterprise Worker. The Agent never saw the finance secret. Gateway issued a single-use grant, the Worker exchanged it locally, and the whole execution is visible in Gateway, Worker, and Credential audit.

## Why This Demo Works

- Business users see a report, not a shell command.
- Security sees credential boundaries and audit.
- IT sees Worker-based execution with no inbound port requirement.
- Platform teams see a reusable domain MCP pattern.

## Upgrade Path

The mock data can later be replaced by:

```text
ERP API / internal DB
Finance portal / UKey workstation
Windows Office Worker
PowerPoint template renderer
Approval before export
```
