# LandGod / MCPHub Positioning

## Idea Origin

LandGod started from a practical gap: many valuable tools only exist as local CLI tools, desktop tools, or machine-bound workflows. They do not have clean cloud APIs, so a cloud-hosted Agent cannot directly call them.

The first-order problem was not “remote control a computer.” It was:

```text
How can an Agent safely call useful local CLI/tool capabilities that do not expose an API?
```

From that CLI/no-API gap, the broader LandGod thesis emerged: enterprise capabilities are scattered across machines, networks, permissions, login states, UKeys, files, Office installs, browsers, and local scripts. LandGod turns those local capabilities into governed, schedulable Agent tools.

---

## One-Line Understanding

**LandGod is a distributed execution network for AI agents. MCPHub is the customer-facing control-plane and tool-gateway form of that network.**

External-facing version:

**LandGod / MCPHub is a distributed tool registration and scheduling platform for AI agents. It turns capabilities scattered across machines, networks, permissions, login states, and local environments into a unified tool pool that any authorized agent can call through Gateway / MCPHub.**

Core analogy:

```text
Kubernetes schedules Pods.
LandGod schedules Tools.
```

Or, in Chinese:

```text
K8s 调度容器。
LandGod 调度工具能力。
```

Core sentence:

**In the AI era, the smallest schedulable unit is no longer the container. It is the tool.**

---

## Core Architecture

LandGod uses a simple division of responsibility:

- **Agent thinks**
- **Gateway / MCPHub governs, routes, and schedules**
- **Worker executes on the real machine**

```text
Any Agent / Client
  ↓ MCP / HTTP / SDK
Gateway / MCPHub
  ↓ Worker outbound connection / dispatch
Workers on enterprise machines, branches, departments, or edge nodes
  ↓ local tools / login state / intranet / UKey / files / GPU / Office / ERP
Existing enterprise systems
```

---

## Agent Layer

Agents can include:

- Claude / Codex / OpenClaw
- Enterprise Copilot
- Cursor / LangGraph / AutoGen / CrewAI
- enterprise-owned workflow apps
- human approval operators

Agents do not need to directly enter the enterprise intranet, own every machine credential, or hold every local permission. They call Gateway / MCPHub.

---

## Gateway / MCPHub Layer

Gateway / MCPHub is the control plane.

It is responsible for:

- MCP Server / HTTP API entry points
- Tool Registry
- Worker Registry
- Policy / Auth / RBAC
- tool allowlists
- approval gates
- Credential Broker
- Worker identity binding
- credential scope enforcement
- queueing and routing
- label-based routing
- batch execution
- async tasks
- trace and audit
- artifacts

It is not just a forwarder. It is an agent execution governance plane.

Security posture:

```text
Agent is untrusted.
Gateway policy decides authority.
Worker executes only within its allowed trust boundary.
Credentials enter trusted narrow tools, never general tools.
Every sensitive execution is auditable.
```

---

## Worker Layer

Workers run on machines that hold real enterprise capability.

Examples:

- ERP intranet access machines
- finance machines with UKey / certificates
- Office / PPT / Excel / COM machines
- browser-login-state machines
- DB / shared-drive / ETL nodes
- GPU / dev / shell / Docker machines
- store POS or edge devices

Key principle:

**Wherever there is a capability that cannot be moved, install a Worker there.**

Not every machine needs a Worker. API-only systems can be exposed directly as MCP servers or services without a Worker.

---

## Product Positioning

MCPHub should be presented as the customer-facing, security-governed form of LandGod. It is not merely a tool proxy or MCP aggregator. It is a controlled gateway for enterprise agent execution.

Security is not optional for MCPHub. Without policy, RBAC, credential isolation, Worker identity, approval, and audit, LandGod becomes a high-risk remote execution surface: any compromised or injected Agent could potentially route actions into real machines, intranets, login sessions, UKeys, files, or credentials. Therefore MCPHub must ship as a governed control plane by default, not as a naked pass-through.

Core product claim:

```text
MCPHub = MCP compatibility + enterprise execution governance.
```

LandGod / MCPHub is not:

- a normal remote desktop product
- traditional RPA
- a single MCP Server
- a way to hand an agent a raw computer
- a simple SSH batch executor
- a multi-agent framework

It is closer to:

```text
Distributed Tool Registry + Execution Scheduler for Agents
```

Or:

```text
Kubernetes for Agent Tools
```

It answers:

> Where, under which permission context, and through which local tool should an agent execute this task?

Not only:

> Which API can the agent call?

---

## Difference From Enterprise MCP Servers

### Enterprise MCP Server

Enterprise MCP servers assume the capability is already API-like, service-like, or structurally accessible.

```text
Agent
  ↓ MCP
Enterprise MCP Server
  ↓
Enterprise API / DB / SaaS / internal service
```

Best for:

- CRM APIs
- order APIs
- inventory APIs
- ticketing APIs
- enterprise knowledge bases
- structured databases

Core question:

> What capability should I expose to the agent?

### LandGod / MCPHub

LandGod assumes many enterprise capabilities are not clean APIs. They are scattered across machines, networks, files, login states, UKeys, GUI apps, Office installs, and local execution contexts.

```text
Agent
  ↓
LandGod / MCPHub Gateway
  ↓
Worker on real enterprise machine
  ↓
Local tools / GUI / browser / Office / ERP / UKey / DB / GPU
```

Core question:

> On which machine, under which permission context, and inside which local environment should this capability execute?

LandGod adds the missing layer of execution location, permission context, environment locality, and scheduling.

---

## Sales Narrative

LandGod should not be sold by starting from protocol details.

Start from enterprise pain:

1. AI agents can already reason and plan.
2. Real enterprise tasks still fail at the execution layer.
3. Enterprise capabilities live inside legacy systems, intranets, machines, files, login sessions, UKeys, Office installs, and local scripts.
4. LandGod / MCPHub registers those capabilities into a unified tool pool.
5. Agents call those tools through Gateway / MCPHub with governance, routing, and audit.
6. AI moves from answering to executing.

Core sales line:

**AI thinks and decides. LandGod / MCPHub connects, schedules, and executes.**

For leadership:

**LandGod / MCPHub closes the last mile of AI agent adoption.**

For enterprise buyers:

**You do not need to rebuild every legacy system as an API first. You do not need to move accounts, files, UKeys, or intranet permissions to the cloud. Tools and permissions stay where they already are. Agents call them through a governed Gateway.**

---

## Typical Enterprise Scenarios

### Non-API ERP / Inventory / Legacy Systems

Many ERP systems have no usable API and can only be accessed through an intranet page or Windows client.

LandGod pattern:

- install Worker on a machine that can access ERP
- expose browser / UI / script / file tools
- let Agent trigger queries, exports, and reports through Gateway

### Finance / Tax / Banking / UKey

Finance workflows often depend on:

- UKey
- certificates
- browser login state
- specific finance machines
- security agents and local software

LandGod pattern:

- UKey never leaves the finance machine
- browser session stays local
- Worker executes approved local tools
- Agent only sees governed results

### Office / PPT / Excel / COM

Real Office workflows depend on:

- local Windows Office
- COM automation
- fonts
- macros
- templates
- local files

LandGod turns the Office machine into an agent-callable execution node.

### Intranet / Government / Healthcare / State-Owned Enterprise Systems

Many systems cannot be exposed publicly and cannot be quickly API-ified.

LandGod pattern:

- Worker connects outbound
- intranet does not open inbound ports
- Agent does not directly access the intranet
- Gateway only exposes governed tool calls

### GPU / Dev / Shell / Docker

When the agent's own machine lacks the right environment, LandGod can schedule execution onto the correct machine:

- model training
- batch processing
- build jobs
- Docker workflows
- data processing

### Multi-Machine Workflows

One Agent can coordinate multiple execution nodes:

- finance machine downloads statement
- Office machine generates Excel / PPT
- data node reads internal DB
- browser node logs into supplier portal
- GPU node runs model inference

This is the meaning of:

**One brain, many enterprise hands.**

---

## Network And Deployment Principles

Key network rule:

**Workers connect outbound to Gateway. Enterprise intranets do not need inbound ports.**

Basic requirements:

- Workers can reach Gateway WebSocket endpoint, usually `ws://GATEWAY:8080` or `wss://...`
- Agents can reach Gateway HTTP / MCP-facing endpoint, usually `http://GATEWAY:8081`

Common deployment forms:

- same-machine MVP / debugging
- public Gateway host
- same LAN / same VPC
- SSH tunnel
- Cloudflare Tunnel / Tailscale / ngrok / FRP

Operational lesson:

For cross-border or unstable network paths, prefer Cloudflare Tunnel or Tailscale over SSH reverse tunnels.

---

## API And Protocol Model

### Agent-Side HTTP API

Gateway exposes:

- `GET /health`
- `GET /clients`
- `GET /tools`
- `POST /tool_call`
- `POST /batch_tool_call`
- `GET /tasks`
- `GET /tasks/:id`
- `GET /audit`
- `POST /tokens`
- `GET /tokens`
- `DELETE /tokens/:token`

These APIs support:

- single tool calls
- batch tool calls
- async tasks
- queueing for offline workers
- worker discovery
- tool discovery
- Worker Token management
- audit queries

### Worker-Side MCP-WS Protocol

Worker connects through WebSocket:

```text
connect
→ register
→ update_tools
→ receive tool_call
→ execute locally
→ return tool_result / tool_error
→ heartbeat / reconnect
```

The Worker registers local capabilities. Gateway schedules and dispatches calls.

---

## Security And Governance Narrative

The correct security framing is:

**Do not give AI a raw computer. Give AI a governed execution boundary.**

Governance mechanisms include:

- Worker Tokens
- tool allowlists
- Worker labels
- permission profiles
- policy / RBAC direction
- approval gate
- audit log
- trace
- artifacts
- revocation
- local secrets and credentials staying local

Correct statements:

- Agent only calls authorized tools.
- Gateway handles routing, audit, and policy boundaries.
- Worker executes inside its local permission context.
- Enterprise intranet does not need inbound exposure.
- UKey, browser login state, Office session, files, and local credentials remain on the execution node.

Avoid saying:

- AI remotely controls the whole computer.
- Agent enters the enterprise intranet directly.
- Agent gets the user's password, UKey, or local credential.
- Every machine is exposed to the cloud.

---

## Market And Competitive Framing

Adjacent categories include:

- OpenAI Operator / ChatGPT Agent
- Claude Computer Use / MCP
- Manus-like agent systems
- browser automation / cloud browser
- RPA
- enterprise MCP servers
- SSH / ops automation
- agent frameworks

LandGod is differentiated because it is not only browser operation, not only RPA, and not only an MCP server.

It lets any Agent safely schedule enterprise-local capabilities across many machines and environments:

- browser
- shell
- file
- Office
- ERP
- UKey
- DB
- GPU
- intranet
- local scripts
- MCP tools

---

## Default Writing Guidelines

Use this positioning when writing plans, docs, examples, proposals, or decks:

### Product Positioning

**LandGod / MCPHub is a distributed tool registration and scheduling platform for AI agents.**

### Core Value

**Move AI from answering into execution.**

### Technical Architecture

```text
Agent → Gateway / MCPHub → Worker → Local tools / Enterprise systems
```

### Deployment Principle

**Wherever there is capability that cannot be moved, install a Worker there.**

### Security Principle

**Workers connect outbound. Agents do not directly enter the intranet. Execution happens through governed tool calls.**

### Differentiation

**Not remote desktop, not traditional RPA, not a single MCP server. LandGod is enterprise agent execution infrastructure.**

### Strongest Sales Line

**Enterprises do not lack AI. They lack the execution layer that lets AI safely enter real business environments. LandGod / MCPHub registers intranet machines, local tools, login states, UKeys, Office, GPU, ERP environments, and scripts into a unified tool pool. Agents think and decide; LandGod connects, schedules, and executes.**
