# Gateway Technical Guide

## Purpose

This document describes the technical implementation, build artifacts, APIs, and operational behaviors of LandGod Gateway / MCPHub.

It covers both Gateway implementations:

- Node Gateway: [gateway/node-gateway](c:/edge_workspace_1/cli-server/gateway/node-gateway)
- Python Gateway Server: [gateway/python-gateway](c:/edge_workspace_1/cli-server/gateway/python-gateway)

Current Gateway release line: `0.1.3`.

---

## Packages And Artifacts

### Node Gateway

Source:

```text
gateway/node-gateway
```

Package metadata:

```text
gateway/node-gateway/package.json
```

Artifact:

```text
downloads/landgod-gateway-0.1.3.tgz
```

Build command:

```bash
cd gateway/node-gateway
npm pack --pack-destination ../../downloads
```

### Python Gateway Server

Source:

```text
gateway/python-gateway
```

Package metadata:

```text
gateway/python-gateway/pyproject.toml
```

Artifacts:

```text
downloads/landgod_gateway_server-0.1.3-py3-none-any.whl
downloads/landgod_gateway_server-0.1.3.tar.gz
```

Build command:

```bash
cd gateway/python-gateway
python -m build
copy dist/landgod_gateway_server-0.1.3* ../../downloads/
```

### Python Gateway SDK

Source:

```text
gateway/python-sdk
```

Artifacts:

```text
downloads/landgod_gateway-0.1.3-py3-none-any.whl
downloads/landgod_gateway-0.1.3.tar.gz
```

Build command:

```bash
cd gateway/python-sdk
python -m build
copy dist/landgod_gateway-0.1.3* ../../downloads/
```

---

## Runtime Configuration

### Required Token

Gateway will not start without a Worker admission token.

Supported forms:

```bash
landgod-gateway start --token YOUR_TOKEN
landgod-gateway start --token=YOUR_TOKEN
LANDGOD_AUTH_TOKEN=YOUR_TOKEN landgod-gateway start

landgod-gateway-py start --token YOUR_TOKEN
LANDGOD_AUTH_TOKEN=YOUR_TOKEN landgod-gateway-py start
```

### Ports

| Env / Flag | Default | Purpose |
|---|---:|---|
| HTTP port | 8081 | Agent HTTP API |
| WS port | 8080 | Worker WebSocket admission |

Node Gateway env vars:

- `LANDGOD_HTTP_PORT`
- `LANDGOD_WS_PORT`
- `LANDGOD_AUTH_TOKEN`
- `LANDGOD_DATA_DIR`

Python Gateway accepts equivalent CLI arguments and `LANDGOD_AUTH_TOKEN`.

---

## HTTP API

### Health

```http
GET /health
```

Returns status, connected client count, registered token count, and ports.

### Clients

```http
GET /clients
```

Returns current and recently stored worker records:

- connection ID
- client ID
- client name
- labels
- resources
- session ID
- connected state

### Tools

```http
GET /tools
```

Returns registered tools per connected worker.

### Tool Call

```http
POST /tool_call
```

Request supports:

- `connection_id`
- `clientName` / `client_name`
- `labels`
- `tool_name`
- `arguments`
- `timeout`

Query options:

- `?async=true`
- `?queue=true`

### Batch Tool Call

```http
POST /batch_tool_call
```

Executes multiple calls in parallel and returns per-call results.

### Tasks

```http
GET /tasks
GET /tasks/:id
```

Lists async / queued tasks or returns a single task result.

### Audit

```http
GET /audit
```

Current implementation calls the worker-side `audit_read` tool and aggregates entries from matching workers.

This avoids shell-specific commands and works across platforms when workers publish `audit_read`.

### Tokens

```http
POST /tokens
GET /tokens
DELETE /tokens/:token
```

Used for Worker admission tokens.

These are not Agent HTTP API credentials.

---

## WebSocket Worker Protocol

Worker connects to Gateway with:

```text
Authorization: Bearer <worker-token>
```

Lifecycle:

1. Gateway validates token
2. Gateway sends `session_opened`
3. Worker sends `register`
4. Gateway returns session binding and public signing key
5. Worker sends `update_tools`
6. Gateway sends signed `tool_call`
7. Worker returns `tool_result` or `tool_error`

Python Gateway currently accepts `/api/mcphub/ws`. Node Gateway accepts WebSocket connections on its WS server without strict path enforcement.

---

## Tool Call Signing

Gateway signs each tool call using Ed25519 metadata.

Metadata includes:

- schema version
- request ID
- session ID
- connection ID
- user ID
- client ID
- issued-at timestamp
- expiry timestamp
- nonce
- tool name
- arguments hash
- signature

Workers use this metadata to reject replayed, expired, cross-session, or tampered tool calls.

---

## Token Model

### Bootstrap Worker Token

The startup token configured when Gateway starts.

### Issued Worker Token

A token created through `/tokens`.

Python Gateway validates both the bootstrap token and active issued tokens.

Node Gateway keeps issued tokens in memory for the current process.

### Agent Credential

Not implemented yet as a distinct control-plane credential.

Current Agent HTTP API calls are not independently authenticated by Gateway.

---

## Storage Model

### Node Gateway

- connected clients: in-memory map
- tasks: in-memory map
- task queue: in-memory array
- token registry: in-memory map seeded by startup token

### Python Gateway

Default single-node mode:

- `MemoryStore`

Cluster mode:

- `RedisStore`
- Redis pub/sub for cross-node tool-call routing

---

## Python Cluster Mode

Python Gateway supports Redis-backed cluster routing.

When enabled:

1. each Gateway node keeps its local WebSocket connections
2. worker metadata is stored in Redis
3. tool calls for remote connections are routed through Redis pub/sub
4. response waits are bounded by request timeout

This is the main technical reason to choose Python Gateway for clustered deployments.

---

## Known Operational Boundaries

### Agent HTTP API Authentication

Current Gateway does not yet implement a separate Agent Credential.

Place Gateway behind a trusted network, reverse proxy, VPN, or tunnel access policy if Agent-side API access must be restricted.

### In-Memory Node Gateway State

Node Gateway token and task state is process-local. Restarting Node Gateway clears issued tokens and task state.

### Ed25519 Key Rotation On Restart

Gateway generates a new signing keypair on restart. Workers reconnect and re-register to bind to the new key.

### Worker Reconnect

Workers use reconnect/backoff behavior. After Gateway restart, expect workers to reconnect and republish tools.

---

## Validation Commands

### Node Gateway

```bash
node --check gateway/node-gateway/bin/landgod-gateway.js
node --check gateway/node-gateway/server/index.js
```

### Python Gateway

```bash
cd gateway/python-gateway
python -m pytest tests/test_gateway.py -q
```

### Artifact Listing

```powershell
Get-ChildItem .\downloads\landgod-gateway-0.1.3.tgz, `
  .\downloads\landgod_gateway_server-0.1.3*, `
  .\downloads\landgod_gateway-0.1.3* |
  Select-Object Name,Length,LastWriteTime
```

---

## Recommended Implementation Direction

Gateway should continue moving toward the mission framing:

**Gateway / MCPHub is the control plane for enterprise execution infrastructure.**

Important future work:

1. introduce Agent control-plane authentication
2. persist token and task state where appropriate
3. align Node and Python Gateway feature parity
4. clarify versioning between Worker and Gateway release lines
5. keep `/audit` tool-based and cross-platform
