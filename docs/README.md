# 📖 LandGod Documentation

Read in order — each document builds on the previous one.

## Overview

| — | [Why LandGod?](why-landgod.md) | Core advantages and positioning | — |

## Getting Started

| # | Document | Description | Prerequisites |
|---|----------|-------------|---------------|
| 01 | [Network Prerequisites](01-network-prerequisites.md) | Network setup before deployment | None |
| 02 | [Gateway API](02-gateway-api.md) | HTTP & WebSocket API reference | — |
| 03 | [MCP-WS Protocol](03-mcp-ws-protocol.md) | WebSocket protocol specification | — |

## Deployment

| # | Document | Description | Prerequisites |
|---|----------|-------------|---------------|
| 04 | [Deploy Gateway](04-deploy-gateway.md) | Install and start the Gateway | 01 |
| 05 | [Deploy Worker](05-deploy-worker.md) | Install Worker on target machines | 01, 04 |
| 06 | [Worker Configuration](06-worker-config.md) | Configure Worker settings and permissions | 05 |

## Publishing

| # | Document | Description | Prerequisites |
|---|----------|-------------|---------------|
| 07 | [npm Publish](07-npm-publish.md) | 发布到 npm 公共仓库 | — |

## Reference

| # | Document | Description | Prerequisites |
|---|----------|-------------|---------------|
| — | [Architecture](architecture.md) | Architecture analysis and comparison | — |
| — | [Domain Glossary](08-domain-glossary.md) | Product and architecture vocabulary | — |
| — | [Semantic Alignment Audit](09-semantic-alignment-audit.md) | Current wording vs mission framing | — |
| — | [Worker MCP Discovery Sequence](10-worker-mcp-discovery-sequence.md) | Worker startup to MCP tool publication | — |
| — | [MCP Directory Autodiscovery](11-mcp-directory-autodiscovery-design.md) | Manifest-based bundled MCP discovery | — |
| — | [Gateway Architecture](12-gateway-architecture.md) | Gateway / MCPHub control plane architecture | — |
| — | [Gateway Technical Guide](13-gateway-technical-guide.md) | Gateway implementation, APIs, and artifacts | — |
| — | [LandGod / MCPHub Positioning](14-landgod-mcphub-positioning.md) | Product pitch, sales narrative, and messaging | — |
| — | [Credential Broker MVP](15-credential-broker-mvp.md) | Gateway-managed credentials with task-scoped grants | 02, 03, 12 |
| — | [Enterprise Pitch Script](16-enterprise-pitch-script.md) | Enterprise sales pitch: story, pain points, architecture, security, ROI, demo, objections | 12, 14, 15 |
| — | [Product / Business / Enterprise Review](17-product-business-enterprise-review.md) | Product verdict, business model, ICP, enterprise user views, maturity, risks, roadmap | 14, 15, 16 |
| — | [GUI vs Headless](gui-vs-headless.md) | Worker run mode comparison | 06 |

## Additional Resources

- [`examples/`](../examples/) — Real-world deployment example
- [`skills/landgod-gateway-setup/ + skills/landgod-setup/`](../skills/landgod-gateway-setup/ + skills/landgod-setup/) — Agent skill for deployment
- [`skills/landgod-operate/`](../skills/landgod-operate/) — Agent skill for operations
- [`skills/landgod-dispatch/`](../skills/landgod-dispatch/) — Agent skill for task dispatch and scheduling
- [`downloads/`](../downloads/) — Release packages
