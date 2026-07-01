# LandGod Business Report Demo MCP

Business-facing demo MCP for the LandGod / MCPHub Enterprise Execution Harness story.

It simulates a monthly business review workflow:

1. Read mock ERP orders.
2. Read mock Finance invoices.
3. Generate executive CSV/HTML/PPTX artifacts.
4. Demonstrate `credential_ref -> grant -> exchange -> _landgod_credential` without returning secrets.
5. Tell the Gateway + Worker + Credential audit story.

## Tools

- `load_erp_orders`
- `load_finance_invoices`
- `generate_monthly_report`
- `run_monthly_close_demo`

Remotely advertised names are prefixed by the MCP server name:

- `business-report-demo.load_erp_orders`
- `business-report-demo.load_finance_invoices`
- `business-report-demo.generate_monthly_report`
- `business-report-demo.run_monthly_close_demo`

## Local smoke test

```bash
python3 mcp-servers/business-report-demo/server.py --smoke --output-dir /tmp/landgod-business-demo
```

Expected artifacts:

- `business_summary_2026-06.json`
- `business_scorecard_2026-06.csv`
- `business_report_2026-06.html`
- `business_report_2026-06.pptx` if `python-pptx` is available
- `audit_story_2026-06.md`

## Sales message

This demo is intentionally not a shell demo. It shows the business flow:

> AI Agent coordinates monthly reporting, LandGod routes execution to trusted enterprise tools, Credential Broker controls secrets, and Gateway/Worker/Credential audit proves what happened.
