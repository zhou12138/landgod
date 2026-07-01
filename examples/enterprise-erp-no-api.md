# Example: Non-API ERP / Internal System

> Mission fit: let AI enter a real business workflow without rebuilding the legacy system as APIs first.

## Scenario

The company has a legacy ERP or internal web system.

- no stable API
- only accessible on an internal Windows workstation or browser session
- data export is still manual
- business users copy results into Excel and then into management reports

LandGod changes the flow from:

`AI suggests` → `human clicks through ERP`

to:

`AI decides` → `Gateway routes` → `ERP Worker executes in the original environment`

## Topology

```text
Agent
  |
  | HTTP tool_call
  v
Gateway / MCPHub
  |
  | WS tool dispatch
  v
ERP Worker (Windows / internal browser / internal network)
```

## Worker Labels

```bash
landgod config set labels '{"role":"erp","system":"legacy-erp","network":"internal","platform":"windows"}'
```

## Example 1: Trigger a Query Export on the ERP Node

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "labels": {"role": "erp", "system": "legacy-erp"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "python C:\\\\ERP\\\\scripts\\\\export_pending_orders.py --date 2026-07-01 --out C:\\\\ERP\\\\exports\\\\pending-orders.xlsx"
    }
  }'
```

## Example 2: Read Back the Export Metadata

```bash
curl -X POST http://localhost:8081/tool_call \
  -H "Content-Type: application/json" \
  -d '{
    "labels": {"role": "erp", "system": "legacy-erp"},
    "tool_name": "shell_execute",
    "arguments": {
      "command": "powershell -NoProfile -Command \"Get-ChildItem C:\\\\ERP\\\\exports\\\\pending-orders.xlsx | Select-Object Name,Length,LastWriteTime | ConvertTo-Json -Compress\""
    }
  }'
```

## Example 3: Queue a Task For An Offline ERP Workstation

```bash
curl -X POST "http://localhost:8081/tool_call?queue=true" \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "ERP-Finance-01",
    "tool_name": "shell_execute",
    "arguments": {
      "command": "python C:\\\\ERP\\\\scripts\\\\daily_close_prep.py"
    }
  }'
```

## Example 4: Human Approval Boundary

For low-risk read/export tasks, the worker can run in `auto` approval mode.

For sensitive actions such as posting invoices, tax submission, or payment release:

- switch the node to manual approval
- keep the tool allowlist narrow
- preserve the action trace in centralized audit

## Why This Matters

- no ERP API reconstruction needed for the first PoC
- no need to expose the ERP directly to the Agent
- browser login state and internal access stay on the ERP workstation
- AI can enter a real workflow using the original business environment

## PoC Goal

Use this scenario to prove:

1. execution inside the real enterprise environment
2. auditability of the action path
3. value before system refactoring
