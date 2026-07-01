# LandGod Domain Glossary

## Purpose

This glossary defines the recommended product and architecture vocabulary for LandGod / MCPHub.

The goal is to align:

- leadership messaging
- architecture documents
- package metadata
- implementation naming

The target framing is:

**LandGod / MCPHub is enterprise AI agent execution infrastructure.**

It is not primarily a remote-control product, and it is not only an MCP server wrapper.

---

## Core Mission

### LandGod / MCPHub

**Definition:** An execution infrastructure and controlled tool network for enterprise AI agents.

**Meaning:** It registers distributed enterprise capabilities, local tools, login states, Office environments, UKey-bound workflows, files, shells, and internal systems as controlled tools that agents can schedule through a unified gateway.

### Mission

**Definition:** Move AI from answering and planning into real execution.

**Meaning:** LandGod allows agents to act inside real enterprise environments without requiring full API reconstruction of legacy systems and without moving sensitive permissions off the original machines.

### Execution Infrastructure

**Definition:** The combined control plane, execution plane, capability plane, and governance plane that allow agents to safely execute work in real environments.

**Preferred usage:** Use this as the top-level product description.

---

## System Roles

### Agent

**Definition:** The reasoning and decision-making brain.

**Responsibilities:**

- understand intent
- plan work
- choose tools
- interpret results

**Non-goals:**

- directly hold every enterprise permission
- directly log into every enterprise machine
- directly own execution environments

### Gateway / MCPHub

**Definition:** The control plane.

**Responsibilities:**

- provide the unified API entry point
- register and discover workers and tools
- route tool calls
- manage queueing, async execution, and fan-out
- enforce governance controls
- aggregate audit and execution state

**Recommended framing:**

- control plane
- scheduling plane
- execution gateway

### Worker

**Definition:** An execution node that hosts capabilities on a real machine.

**Responsibilities:**

- maintain a long-lived connection to Gateway
- register tools and capabilities
- execute tool calls inside the local environment
- keep sensitive state local to the machine

**Recommended framing:**

- execution node
- capability node
- enterprise tool node

**Avoid overusing:** `remote device`

### Tool

**Definition:** The smallest schedulable execution unit in LandGod.

**Examples:**

- `shell_execute`
- `file_read`
- `audit_read`
- `shiproom_fetch_loop`
- `pptx_open`

**Meaning:** LandGod schedules tools, not just machines.

### MCP Server

**Definition:** A provider of one or more tools.

**Meaning inside LandGod:** MCP servers are capability providers attached to workers or injected into the local execution environment.

**Important distinction:** MCP Server is not the same thing as LandGod itself.

---

## Architecture Layers

### Control Plane

**Definition:** Gateway / MCPHub.

**Contains:**

- registration
- discovery
- routing
- batch dispatch
- async tasks
- task queue
- governance and policy enforcement
- centralized audit access

### Execution Plane

**Definition:** Workers and their local runtime environments.

**Contains:**

- local commands
- local files
- Office automation
- browser automation
- local MCP tools
- internal system access

### Capability Plane

**Definition:** The published tool surface exposed to agents.

**Contains:**

- built-in tools
- injected MCP servers
- external MCP tools published through workers

### Governance Plane

**Definition:** The security and operational boundary wrapped around execution.

**Contains:**

- token-based access
- allowlists
- approvals
- auditing
- revocation
- traceability
- queue control

---

## Connectivity Model

### Agent → Gateway

**Definition:** Control-plane invocation path.

**Protocol:** HTTP API.

**Meaning:** Agents ask the system to execute capabilities through Gateway. They do not connect directly to workers.

### Worker → Gateway

**Definition:** Execution-node registration and command channel.

**Protocol:** WebSocket.

**Meaning:** Workers connect outbound, register their tools, and receive tool calls over a persistent channel.

### Capability Registration

**Definition:** The process where a worker announces its tool surface, labels, and resources to the control plane.

**Meaning:** Execution becomes schedulable only after registration.

---

## Scheduling Concepts

### Routing

**Definition:** Selecting the correct execution node for a tool call.

**Selectors may include:**

- connection ID
- client name
- labels
- resource state

### Label

**Definition:** A worker-declared capability attribute.

**Examples:**

- `gpu=true`
- `platform=windows`
- `role=finance`
- `region=cn`

**Meaning:** Labels describe what a node is suitable for.

### Resource Awareness

**Definition:** Using current CPU, memory, and load information to guide routing.

### Batch Dispatch

**Definition:** Parallel execution across multiple workers from a single request.

### Async Task

**Definition:** A long-running execution request that returns immediately with a task ID.

### Queued Task

**Definition:** A task stored for later execution when the target worker is not currently online.

---

## Security And Governance Concepts

### Worker Token

**Definition:** The bearer credential used by a worker to connect to Gateway.

**Meaning:** This is a worker access credential, not an agent API credential.

### Bootstrap Token

**Definition:** The initial root token configured when Gateway starts.

**Meaning:** Used as the initial worker admission credential and as the root of token-based worker access.

### Issued Worker Token

**Definition:** A worker access token created dynamically through Gateway token APIs.

**Meaning:** Device-scoped or worker-scoped admission token.

### Session Token

**Definition:** A token returned through a sign-in / callback flow and used to start or resume a managed client session.

**Meaning:** This is session-scoped and should not be conflated with long-lived worker admission credentials.

### Agent Credential

**Definition:** The future credential used by agents to call the Gateway control plane.

**Meaning:** This should remain conceptually separate from worker tokens.

### Approval Gate

**Definition:** A human approval checkpoint for sensitive actions.

### Allowlist

**Definition:** The explicit boundary of what a worker may execute or access.

### Audit

**Definition:** Execution evidence that records who invoked what, where, with what parameters, and with what result.

### Revoke

**Definition:** Immediate removal of access for a token, worker, or capability.

---

## Deployment Concepts

### Execution Node

**Definition:** A machine that hosts business-critical capability.

**Examples:**

- ERP workstation
- finance workstation with UKey
- Office automation machine
- shared browser session host
- GPU node
- internal data node

### Gateway Host

**Definition:** The machine where Gateway / MCPHub runs.

**Requirement:** Reachable by both agents and workers.

**Note:** Same-machine deployment with the agent is a debugging and PoC convenience, not a hard architecture requirement.

### Tool Network

**Definition:** The full connected system of Gateway, workers, tools, policies, and registered execution capability.

---

## Recommended Product Language

### Prefer

- enterprise AI agent execution infrastructure
- distributed tool scheduling platform
- execution network
- controlled enterprise tool network
- control plane / execution plane
- execution node
- capability node

### Use Carefully

- worker node
- sidecar gateway
- remote device

These are not wrong, but they are lower-level and less aligned with the mission in leadership-facing material.

### Avoid As Primary Positioning

- remote device management
- remote control tool
- RPA replacement

These framings understate the scheduling, governance, and execution-infrastructure mission.
