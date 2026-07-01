# Semantic Alignment Audit

## Purpose

This document compares the current repository language against the recommended mission framing from the leadership deck.

Target framing:

**LandGod / MCPHub is enterprise AI agent execution infrastructure.**

Current repository language is partially aligned, but still mixes this framing with older wording such as `remote device management`, `worker node`, and `sidecar gateway`.

---

## Summary

### Aligned Areas

- [docs/architecture.md](docs/architecture.md) already frames LandGod as an AI agent resource scheduling platform.
- The Gateway / Worker control-plane and execution-plane split is visible in both docs and code.
- Recent updates already clarify that Worker access uses bearer tokens and Agent HTTP access is not yet formally authenticated.

### Misaligned Areas

- Top-level positioning still often says `remote device management`.
- Multiple package descriptions still frame the product primarily as a worker or remote-control tool.
- Token vocabulary is overloaded and not consistently separated into worker admission vs session sign-in vs future agent credential concepts.
- Security / governance messaging is stronger in mission decks than in current control-plane implementation.

---

## Findings

### 1. Top-Level Product Positioning Still Uses Remote-Management Framing

**Why it matters:** This pulls the reader toward an SSH / remote-control / ops-tool mental model instead of execution infrastructure.

**Current examples:**

- [README.md](README.md) — `LandGod — Remote Device Management for AI Agents`
- [package.json](package.json) — `AI-driven remote device management — LandGod Worker Node`
- [docs/07-npm-publish.md](docs/07-npm-publish.md) — repeats the same package description example
- [gateway/node-gateway/package.json](gateway/node-gateway/package.json) — `Agent Sidecar Gateway for remote device management`
- [gateway/python-sdk/pyproject.toml](gateway/python-sdk/pyproject.toml) — Python SDK for `remote device management`
- [openclaw-plugin-landgod/package.json](openclaw-plugin-landgod/package.json) — remote device management plugin wording

**Recommended direction:** Reframe these primary descriptions around execution infrastructure, tool scheduling, and controlled enterprise execution.

---

### 2. “Worker Node” Is Overused Relative to “Execution Node” or “Capability Node”

**Why it matters:** `Worker Node` is technically acceptable, but it describes the implementation role more than the business value.

**Current examples:**

- [package.json](package.json)
- [README.md](README.md)
- several quickstart and deployment materials focused on worker install

**Recommended direction:**

- keep `Worker` as the implementation name
- prefer `execution node` or `capability node` in architecture and mission-facing language

---

### 3. “Sidecar Gateway” Is Accurate But Too Narrow As The Main Identity

**Why it matters:** `sidecar gateway` describes deployment topology, not the full platform role.

**Current examples:**

- [docs/02-gateway-api.md](docs/02-gateway-api.md)
- [gateway/node-gateway/bin/landgod-gateway.js](gateway/node-gateway/bin/landgod-gateway.js)
- [gateway/python-sdk/README.md](gateway/python-sdk/README.md)

**Recommended direction:** Use `control plane`, `execution gateway`, or `MCPHub control plane` in leadership-facing and product-facing descriptions. Keep `sidecar` only where deployment topology is the point.

---

### 4. Token Semantics Are Overloaded

**Why it matters:** The current implementation uses one generic word, `token`, for distinct concepts with different lifecycle and risk boundaries.

**Observed concepts in the repo:**

- Worker admission token from Gateway startup token
- Worker admission token created via `/tokens`
- Managed client session token returned by sign-in / callback flow
- implied future Agent control-plane credential (not yet implemented as a distinct model)

**Current examples:**

- [docs/06-worker-config.md](docs/06-worker-config.md) — device token examples
- [src/main/managed-client/config.ts](src/main/managed-client/config.ts) — `token` field in runtime config
- [src/main/index.ts](src/main/index.ts) — sign-in callback writes `token` into runtime / persisted config
- [gateway/python-gateway/landgod_gateway_server/http_handler.py](gateway/python-gateway/landgod_gateway_server/http_handler.py) — `/tokens` APIs

**Recommended direction:** Introduce and consistently use separate terms:

- Worker Token
- Bootstrap Token
- Session Token
- Agent Credential

---

### 5. Governance Promise Is Ahead Of Control-Plane Authentication Reality

**Why it matters:** The leadership deck frames Gateway as the unified governance plane, but the current implementation still leaves Agent → Gateway control-plane calls unauthenticated.

**Current examples:**

- [docs/02-gateway-api.md](docs/02-gateway-api.md) explicitly says Agent HTTP API requests are not yet authenticated.
- [docs/04-deploy-gateway.md](docs/04-deploy-gateway.md) repeats that `--token` is currently for Worker access.

**Recommended direction:** Keep the doc honesty, but explicitly distinguish:

- current governance: Worker admission + local execution boundaries + audit
- target governance: full control-plane authentication and authorization for agent callers

---

### 6. Some End-User Surfaces Still Sound Like Remote Control

**Why it matters:** These phrases weaken the “controlled execution network” framing.

**Current examples:**

- [downloads/QUICKSTART-WINDOWS-DESKTOP.md](downloads/QUICKSTART-WINDOWS-DESKTOP.md) mentions `screenshot/remote control`
- [openclaw-plugin-landgod/openclaw.plugin.json](openclaw-plugin-landgod/openclaw.plugin.json) describes browsing files and screenshots across distributed machines using remote-device language

**Recommended direction:** Reframe around tool execution on real enterprise environments rather than remote controlling machines.

---

## Suggested Normalized Vocabulary

### Product

- LandGod / MCPHub = enterprise AI agent execution infrastructure
- Gateway / MCPHub = control plane
- Worker = execution node

### Execution

- Tool = smallest schedulable unit
- MCP Server = capability provider
- Tool network = registered execution capability fabric

### Security

- Worker Token = worker admission credential
- Session Token = sign-in callback session credential
- Agent Credential = future control-plane caller credential

---

## Recommended Next Edits

### High Priority

1. Reword top-level package descriptions and README headings away from `remote device management`.
2. Split token terminology in docs and UI wording.
3. Add an explicit note in architecture docs that current control-plane governance is stronger for Worker admission than for Agent API callers.

### Medium Priority

1. Rework SDK descriptions to emphasize scheduling and execution infrastructure.
2. Review plugin descriptions and quickstarts for remote-control phrasing.
3. Normalize `Worker Node` to `Worker (execution node)` in user-facing docs.

### Low Priority

1. Align CLI banners and package keywords with the new framing.
2. Review old proposal and historical docs for legacy wording that may still surface in copy-paste reuse.
