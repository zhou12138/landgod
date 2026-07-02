# LandGod / MCPHub Technical Architecture, Harness Design, and Technical Highlights Review

> Review focus: overall technical architecture, core design philosophy, Enterprise Execution Harness model, current technical highlights, risks, and recommended roadmap.

## 1. Executive Verdict

LandGod / MCPHub is directionally strong because it targets the real enterprise Agent bottleneck:

```text
The problem is not that Agents cannot think.
The problem is that Agents cannot safely execute inside real enterprise environments.
```

LandGod should not be positioned as a remote shell, remote desktop, simple MCP server, or ordinary tool proxy. Its stronger category is:

```text
Enterprise Execution Harness for AI Agents
```

In Chinese:

```text
LandGod / MCPHub 是 AI Agent 的企业级执行 Harness：
让任意 Agent 安全调用企业真实环境里的机器、工具、凭据和流程，
并留下可审计、可追责的执行证据。
```

The core technical value is not merely remote tool calling. The core value is combining:

```text
execution environment
+ permission boundary
+ credential boundary
+ scheduling
+ governance
+ audit evidence
```

into one controlled execution layer.

---

## 2. Overall Technical Architecture

Current architecture can be understood as three layers:

```text
Agent Layer
  ↓
Gateway / MCPHub Control Plane
  ↓
Worker Execution Plane
  ↓
Local Tools / MCP / CLI / Office / Browser / ERP / Files / UKey / Intranet
```

### 2.1 Agent Layer

Agents may include:

```text
OpenClaw / Claude / ChatGPT / Cursor / LangGraph / Dify / enterprise-owned Agents
```

Agents should not directly enter enterprise networks, hold machine credentials, or own local machine permissions.

Agents send requests such as:

```text
tool_call
credential_ref
credential_scope
arguments
```

Core idea:

```text
Agent is replaceable.
Execution layer is stable.
```

This is important because enterprises will not standardize on only one Agent. Different departments may use different models or workflow systems, but the underlying Worker, credential, approval, audit, and policy layer should remain stable.

### 2.2 Gateway / MCPHub Control Plane

Gateway is the control plane, not the execution plane.

Current and emerging responsibilities:

```text
Worker registry
Tool registry
Routing / scheduling
Credential Broker
Admin Auth
Central control policy
Worker / tool enable-disable
Async task / queue / batch
Gateway audit
Credential audit
WebUI
Effective Access
Scenario management
```

Gateway is evolving from a forwarder into an:

```text
Agent Execution Governance Plane
```

Core principle:

```text
Gateway says MAY.
Worker says CAN.
```

Gateway decides whether an action is allowed. Worker decides whether it can safely and locally execute the action.

### 2.3 Worker Execution Plane

Workers run on machines that hold real enterprise capability:

```text
intranet machines
Windows finance machines
Office / PPT / Excel machines
UKey / certificate machines
browser-login-state machines
GPU / local model machines
legacy ERP / local script machines
```

Workers connect outbound to Gateway:

```text
Worker → Gateway WebSocket
```

This is a strong enterprise deployment choice because:

- Workers do not need to expose inbound ports.
- It works well behind NAT and firewalls.
- It fits customer-site and branch-office environments.
- Gateway remains the unified control entry.
- Worker keeps local execution and local audit.

---

## 3. Core Technical Design Philosophy

### 3.1 Origin: CLI / No-API Gap

LandGod started from a practical enterprise gap:

```text
Some valuable capabilities only exist as CLI tools, local programs,
desktop workflows, login-state workflows, or machine-bound environments.
They do not have clean cloud APIs, so cloud Agents cannot call them directly.
```

The original problem was not:

```text
How can an Agent remote-control a computer?
```

The original problem was:

```text
How can an Agent safely call useful local CLI/tool capabilities that do not expose an API?
```

From this gap, the broader thesis emerged:

```text
Enterprise capabilities are scattered across machines, networks, permissions,
login states, UKeys, files, Office installs, browsers, and local scripts.
LandGod turns these machine-bound capabilities into governed Agent tools.
```

### 3.2 Tool as the Smallest Schedulable Unit

The strongest technical analogy is:

```text
Kubernetes schedules containers.
LandGod schedules tools.
```

Or:

```text
In the AI era, the smallest schedulable unit is not the container.
It is the tool + machine environment + permission + credential + audit trail.
```

An enterprise capability is often not just an API endpoint. It may be:

```text
a specific machine
a local login state
a CLI
a UKey
an Office installation
an intranet location
a permission context
an audit chain
```

LandGod packages those into a schedulable tool capability.

### 3.3 Agent Is Not a Security Boundary

LandGod should assume Agents are untrusted.

Security posture:

```text
Agent is untrusted.
Gateway policy decides authority.
Worker executes only within its allowed trust boundary.
Credentials enter trusted narrow tools, never general tools.
Every sensitive execution is auditable.
```

The system should assume:

- Agents may be prompt-injected.
- Web pages, PDFs, emails, and tool outputs may be hostile.
- Agents may attempt to call shell/file/browser_eval to extract secrets.
- MCP servers may be compromised or malicious.

Therefore, security boundaries must be enforced by:

```text
Gateway policy
Credential Broker
Worker identity
Worker isolation
Tool allowlist
Audit
```

not by prompt instructions.

---

## 4. Enterprise Execution Harness Design

LandGod's Harness can be defined as:

```text
Enterprise Execution Harness =
A constraint shell, scheduler, credential boundary, and evidence chain
that allows any Agent to safely execute inside real enterprise environments.
```

It is not an Agent Framework.

Agent frameworks answer:

```text
How does the Agent think?
How does the Agent plan?
How does the Agent call tools?
How does the Agent remember context?
```

LandGod answers:

```text
Where should this action execute?
Under which identity and permission boundary?
Which Worker should run it?
Is this tool allowed?
Is this credential allowed?
Does this require approval?
How is evidence recorded?
How are results and artifacts recovered?
How can the action be investigated later?
```

### 4.1 Execution Adapter

LandGod adapts local capabilities into Agent-callable tools:

```text
CLI
MCP server
local scripts
Office
browser
ERP
UKey
file system
intranet services
```

### 4.2 Execution Scheduler

LandGod decides where a request should run:

```text
connection_id
clientName
labels
worker group
resource status
queue
async
batch
```

### 4.3 Execution Boundary

LandGod restricts what an Agent may do:

```text
tool allowlist
denied tools
credential allowedTools
worker/tool central disable
finance Worker isolation
admin auth
```

### 4.4 Credential Boundary

Agent sees only:

```text
credential_ref
credential_scope
```

Agent must not see:

```text
token
password
private key
session secret
```

### 4.5 Evidence Harness

Execution must leave evidence:

```text
Gateway audit
Credential audit
Worker audit
Task records
Artifacts
Scenario result
```

This is the foundation for enterprise auditability and accountability.

---

## 5. Current Technical Highlights

### 5.1 Worker Outbound WebSocket

Workers connect to Gateway outbound:

```text
Worker → Gateway WebSocket
```

This fits enterprise deployment better than inbound SSH or direct remote access because it works behind NAT, firewalls, branch networks, and customer machines.

### 5.2 Clear Gateway / Worker Separation

Gateway responsibilities:

```text
control plane
scheduling
policy
credentials
audit
WebUI
```

Worker responsibilities:

```text
execution plane
local tools
local MCP
local audit
local safety fallback
```

This separation naturally supports future features such as:

```text
Gateway policy
Worker Security Profile
Policy Sync / Ack
Worker attestation
```

### 5.3 Credential Broker

Credential Broker is one of the key enterprise trust features.

Current chain:

```text
Agent sends credential_ref + credential_scope
Gateway checks policy
Gateway signs single-use grant
Worker validates grant
Worker exchanges short-lived credential
Trusted tool receives credential
Audit records the lifecycle
```

Important properties:

- Agent does not receive secret values.
- Grant is bound to agent, worker, connection, tool, arguments hash, scope, and expiry.
- Grant is single-use.
- `allowedTools: ["*"]` is blocked by default.
- `credential_scope` flows end-to-end.
- Finance / credential Workers block generic shell/file/browser_eval style tools.
- Exact secret values are redacted from Worker responses.

### 5.4 Signed and Bound Tool Calls

LandGod uses verifiable metadata such as:

```text
Ed25519 signing
canonical JSON
arguments_hash
request_id
task_id
connection_id
worker_id
tool_name
nbf / exp
```

This makes the system more than a simple HTTP-to-WS proxy. It creates a verifiable execution chain.

### 5.5 Triple Audit Model

Current audit model:

```text
Gateway central audit
Credential audit
Worker local audit
```

This answers three enterprise questions:

```text
Did Gateway dispatch it?
Was credential use approved/exchanged?
Did Worker actually execute locally?
```

Future additions should include:

```text
hash chain
SIEM export
immutable storage
approval events
artifact checksums
```

### 5.6 WebUI as Governance Console

The WebUI is moving beyond a demo panel into a Gateway governance console.

Current/desired sections:

```text
Overview
Workers
Tools
Credentials
Scenarios
Tasks
Audit
Effective Access
Worker/tool enable-disable
Audit filters
Scenario demo
Task details
```

Important WebUI concepts:

- Effective Access explains why an action is allowed or denied.
- Worker/tool central enable-disable gives security teams a control surface.
- Scenarios package low-level tools into business workflows.
- Audit filters help demos, operations, and security investigations.
- Rich task details turn the UI into an operations tool.

### 5.7 Finance Monthly Report Scenario

The Finance Monthly Report scenario is stronger than a shell demo because it shows business value and security boundaries together.

Flow:

```text
Business request
→ Agent
→ Gateway policy
→ Credential grant
→ Finance Worker
→ Trusted MCP
→ Report artifacts
→ Audit evidence
```

It appeals to:

- Business users: monthly report / PPT / HTML artifacts.
- Security teams: Agent never sees secrets.
- IT teams: Worker outbound connection and audit.
- Platform teams: reusable scenario pattern.

---

## 6. Current Risks and Hard Truths

### 6.1 MVP, Not Yet Full Production Platform

The core loop is proven, but production enterprise readiness still needs:

```text
SSO / OIDC
fine-grained RBAC
Approval Engine
Policy Sync / Ack
Audit hash chain
SIEM export
Vault / KMS integration
MCP connector signing
Worker attestation
Release signing / SBOM
Network egress control
```

Correct external phrasing:

```text
Current LandGod is an Enterprise Execution Harness MVP skeleton.
It has validated the core loop; the next step is governance, security, and operational hardening.
```

### 6.2 Policy Is Still Distributed

Current policy surfaces include:

```text
Gateway credential policy
Gateway central control policy
Worker local defense
MCP tool trustLevel
Tool credentialAccess
Admin Auth
```

These should evolve into:

```text
Policy Bundle
Policy Version
Worker Security Profile
Policy Sync / Ack
Server-side Effective Access API
```

### 6.3 Worker Identity Needs Hardening

Token binding and server-side labels are a good P0 direction, but production requires:

```text
per-worker token
first registration approval
worker fingerprint
machine identity
certificate-based auth
token rotation
worker quarantine
attestation
```

Principle:

```text
Worker labels are routing hints, not identity proof.
```

### 6.4 Audit Is Not Yet Tamper-Evident

JSONL audit is useful for MVP, demo, and debugging. It is not enough as strong evidence.

Next steps:

```text
hash chain
sequence number
artifact checksum
signed audit batch
remote immutable storage
SIEM export
retention policy
```

### 6.5 Credential Broker Needs Vault / KMS

Gateway-local credential storage is acceptable for MVP. Production should integrate with:

```text
Vault
KMS
cloud Secret Manager
HSM / envelope encryption
credential rotation
approval-before-exchange
```

### 6.6 MCP Supply Chain Requires Governance

Since LandGod depends on MCP tools, MCP supply chain must be governed:

```text
MCP manifest signing
trusted publisher
tool hash
version pinning
capability declaration
credentialAccess review
sandbox profile
```

### 6.7 Network Egress Needs Hard Controls

Logical restrictions are useful, but production needs system/network-level controls:

```text
Worker egress allowlist
firewall rules
container sandbox
Windows AppLocker / Defender policy
proxy allowlist
DNS logging
```

---

## 7. Overall Assessment

Technical architecture assessment:

```text
Direction: very strong
Abstraction: correct
Security awareness: ahead of ordinary MCP/Agent tool platforms
Engineering loop: MVP is established
Production maturity: needs governance and operations hardening
```

Three strongest conclusions:

### 7.1 LandGod Is Not Remote Tool Calling

Better category:

```text
Enterprise Execution Harness for AI Agents
```

### 7.2 Gateway Control Plane Is the Core Asset

Workers are execution nodes. The product moat is in:

```text
Policy
Credential Broker
Audit
Scenarios
Effective Access
Approval
Worker/tool governance
```

### 7.3 LandGod Is an Enterprise Execution Layer for MCP

MCP answers:

```text
What is the tool interface?
```

LandGod answers:

```text
Where, how, under which permission, with which credential,
and with which audit trail does this tool execute?
```

Therefore:

```text
MCPHub = MCP compatibility + enterprise execution governance
```

---

## 8. Recommended Roadmap

### P1 — Governance Layer

```text
Worker Security Profile
Policy Sync / Ack
Server-side Effective Access API
Approval Engine
RBAC role model
```

Goal: make Gateway a true enterprise control plane.

### P2 — Evidence Chain

```text
Audit hash chain
artifact checksum
SIEM export
signed audit batches
audit retention
```

Goal: make audit acceptable to security and compliance teams.

### P3 — Worker Identity

```text
per-worker token
worker approve/quarantine
certificate auth
token rotation
server-side labels only
worker attestation
```

Goal: make Worker identity trustworthy.

### P4 — Vault / KMS Credential Backend

```text
Vault / KMS
secret rotation
short-lived credentials
approval-before-exchange
scope-based secret issue
```

Goal: avoid long-term local secret ownership by Gateway.

### P5 — Scenario Productization

Scenarios should become product units:

```text
business workflow template
+ policy template
+ credential template
+ approval template
+ audit story
+ artifacts
```

Candidate scenarios:

```text
Finance Monthly Close
IT Ops Patrol
Supplier Reconciliation
Office / PPT Generator
ERP Export
Browser Portal Download
```

---

## 9. Final Summary

LandGod's core technical design can be summarized as:

```text
Do not give Agents raw enterprise execution power.
Register real enterprise machine capabilities as governed tools.
Let Gateway control policy, credentials, scheduling, and audit.
Let Worker execute locally within a bounded trust context.
Agent thinks. LandGod lets it act safely.
```

Short version:

```text
Agent thinks.
Gateway governs.
Worker executes.
Audit proves.
```
