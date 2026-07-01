# LandGod Examples

These examples show how LandGod / MCPHub maps to real enterprise execution scenarios.

The examples are organized around the mission:

**AI does the reasoning. LandGod provides the execution network.**

## Scenario Index

### Mission-Aligned Enterprise Scenarios

- [enterprise-erp-no-api.md](enterprise-erp-no-api.md)
  Non-API ERP / internal web system execution without rebuilding the system.

- [finance-office-reporting.md](finance-office-reporting.md)
  Finance UKey + Office automation + multi-node reporting workflow.

- [business-report-demo.md](business-report-demo.md)
  Runnable mock monthly business report demo with ERP/Finance data, credential-aware MCP tool, HTML/PPTX artifacts, and audit story.

### Platform Capability Scenarios

- [small-team-ops.md](small-team-ops.md)
  One Gateway, multiple execution nodes, routed by labels and capability.

- [distributed-data-analysis.md](distributed-data-analysis.md)
  Keep large datasets and heavy compute on the right worker nodes.

- [distributed-testing.md](distributed-testing.md)
  Run the same test or probing task across regions, networks, and environments.

## How To Read These Examples

- `Gateway` is the control plane.
- `Worker` is the execution node on the real machine.
- `Tool` is the smallest schedulable unit.
- `labels` let the Agent target capability instead of hardcoding machine identity.

These examples intentionally focus on execution topology and business flow, not only API syntax.
