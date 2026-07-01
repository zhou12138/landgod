# Gateway / MCPHub Architecture

## Purpose

LandGod Gateway / MCPHub is the control plane for the LandGod execution network.

It connects AI agents to Worker execution nodes without requiring agents to directly enter internal machines, hold desktop credentials, or manage machine-specific tool runtimes.

In the LandGod mission model:

- Agent = reasoning and decision-making brain
- Gateway / MCPHub = control plane and scheduling plane
- Worker = execution node
- Tool = smallest schedulable capability

---

## What Gateway Is

Gateway is responsible for:

- accepting Agent HTTP requests
- accepting Worker WebSocket connections
- authenticating Worker admission tokens
- tracking connected workers
- collecting worker tool registrations
- routing tool calls
- supporting labels, async tasks, queues, and batch calls
- aggregating audit views from workers

Gateway does not execute enterprise work itself. Execution happens on workers.

---

## What Gateway Is Not

Gateway is not:

- an LLM agent
- a desktop automation runtime
- the place where enterprise credentials should live
- the owner of ERP / UKey / Office login state
- a replacement for domain MCP servers

Gateway coordinates and governs execution. Workers perform execution inside their own local environments.

---

## Topology

```text
Agent
  |
  | HTTP API (:8081)
  v
Gateway / MCPHub
  |
  | WebSocket (:8080) + Worker Token
  v
Worker execution nodes
  |
  +-- built-in tools
  +-- bundled MCP servers
  +-- custom external MCP servers
  +-- local business systems / files / desktop apps
```

---

## Network Roles

| Direction | Protocol | Default Port | Purpose |
|---|---|---:|---|
| Agent → Gateway | HTTP | 8081 | Control-plane API calls |
| Worker → Gateway | WebSocket | 8080 | Worker registration and tool execution channel |

Workers connect outbound to Gateway. This keeps execution nodes friendly to NAT, firewalls, and internal enterprise networks.

Gateway can run on any host reachable by both Agent and Workers. Running Gateway on the Agent machine is useful for MVP/POC debugging, but it is not an architectural requirement.

---

## Connection Lifecycle

### 1. Gateway Starts

Gateway starts HTTP and WebSocket listeners.

It requires a startup Worker Token through either:

- `--token`
- `LANDGOD_AUTH_TOKEN`

Gateway also generates an Ed25519 signing keypair used to sign tool calls sent to workers.

### 2. Worker Connects

Worker opens a WebSocket connection and sends:

```text
Authorization: Bearer <worker-token>
```

Gateway validates the token before accepting the connection.

### 3. Gateway Opens Session

Gateway sends:

```json
{ "type": "event", "event": "session_opened", "payload": { "connection_id": "..." } }
```

### 4. Worker Registers

Worker sends a `register` request containing:

- `client_id`
- `client_name`
- labels
- resources

Gateway binds the connection to a worker identity and returns:

- user ID
- client ID
- connection ID
- session ID
- server key ID
- server public key
- server time

### 5. Worker Publishes Tools

Worker sends `update_tools` with the current tool surface.

Gateway stores tool names per connection.

### 6. Agent Calls Tool

Agent calls `POST /tool_call` or `POST /batch_tool_call`.

Gateway resolves the target worker and sends a signed `tool_call` request over WebSocket.

### 7. Worker Returns Result

Worker returns a tool result event. Gateway forwards the result to the Agent HTTP response or stores it in task state.

---

## Routing Model

Gateway resolves a target in this order:

1. explicit `connection_id`
2. `clientName` / `client_name`
3. `labels`
4. first available worker

For production and repeatable workflows, prefer explicit `clientName` or capability labels over implicit first-worker routing.

---

## Scheduling Capabilities

### Label Routing

Workers publish labels such as:

```json
{ "role": "finance", "platform": "windows", "ukey": true }
```

Agent requests can route by labels instead of hardcoding worker identity.

### Batch Dispatch

`POST /batch_tool_call` executes multiple calls in parallel.

One failed call does not block the others.

### Async Tasks

`POST /tool_call?async=true` returns a task ID immediately and executes in the background.

### Queue For Offline Workers

`POST /tool_call?queue=true` queues work for a named worker or label selector when no matching worker is online.

Queued tasks drain when a matching worker registers.

### Resource Awareness

Workers report CPU, memory, uptime, and related resource data. Agents can use `/clients` to make scheduling decisions.

---

## Security Model

### Current Worker Admission

Worker admission is token-based.

Gateway supports:

- a startup bootstrap Worker Token
- issued Worker Tokens through `/tokens`
- token revocation and disconnect

### Tool Call Signing

Gateway signs tool calls with Ed25519 metadata. Workers verify the session-bound signature before executing calls.

### Agent Control-Plane Authentication

Current Gateway implementations do not yet enforce a separate Agent HTTP API credential.

That means current governance is strongest on:

- Worker admission
- local worker tool policy
- tool call signatures
- audit records

Future control-plane authentication should introduce a distinct Agent Credential and authorization model.

---

## Node Gateway vs Python Gateway

| Area | Node Gateway | Python Gateway |
|---|---|---|
| Package | `landgod-gateway` | `landgod-gateway-server` |
| Current version | 0.1.3 | 0.1.3 |
| Runtime | Node.js | Python asyncio |
| HTTP implementation | Node `http` | `aiohttp` |
| WebSocket implementation | `ws` | `websockets` |
| Cluster support | Single-node only | Redis-backed cluster mode |
| Best fit | simple local Gateway | cluster / Python-first deployments |

Both implementations expose the same conceptual Gateway role and the same core API surface.

---

## Mission Alignment

Gateway / MCPHub exists so agents can schedule real enterprise execution without owning the credentials, tools, files, or desktop environments directly.

The Gateway is the coordination layer that lets LandGod become:

**enterprise AI agent execution infrastructure**

instead of a direct remote-control tool.
