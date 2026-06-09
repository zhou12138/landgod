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
| — | [GUI vs Headless](gui-vs-headless.md) | Worker run mode comparison | 06 |

## Additional Resources

- [`examples/`](../examples/) — Real-world deployment example
- [`skills/landgod-gateway-setup/ + skills/landgod-setup/`](../skills/landgod-gateway-setup/ + skills/landgod-setup/) — Agent skill for deployment
- [`skills/landgod-operate/`](../skills/landgod-operate/) — Agent skill for operations
- [`skills/landgod-dispatch/`](../skills/landgod-dispatch/) — Agent skill for task dispatch and scheduling
- [`downloads/`](../downloads/) — Release packages
