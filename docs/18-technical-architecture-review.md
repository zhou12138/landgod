# 18. LandGod / MCPHub Technical Architecture Review

> Role: professional architecture review of LandGod's overall architecture, technical design points, security boundaries, execution harness model, risks, and recommended evolution path.
>
> Summary: LandGod is best understood as an **Enterprise Execution Harness for AI Agents**. It is not merely remote shell, remote desktop, MCP hosting, or a tool proxy. Its core technical value is to let interchangeable Agents safely operate real enterprise capabilities through a governed Gateway + Worker execution network.

---

## 1. Executive Verdict

LandGod's overall architecture is directionally correct and technically meaningful because it targets the real bottleneck of enterprise Agent adoption:

```text
Agents can reason.
But they cannot safely execute inside real enterprise environments.
```

Enterprise execution is usually trapped inside:

```text
local CLI tools
Windows desktop software
Office / Excel / PowerPoint
browser login state
UKey / certificate machines
intranet-only systems
legacy ERP / finance clients
local files and scripts
machine-bound permissions
```

LandGod's core thesis is therefore strong:

```text
Agent thinks.
Gateway governs.
Worker executes.
Audit proves.
```

From an architect's perspective, the strongest technical design is the split between:

- **Agent Layer** — reasoning and intent;
- **Gateway / MCPHub Control Plane** — routing, policy, credentials, approval, audit, WebUI;
- **Worker Execution Plane** — local tools, local MCP servers, local environment, local enforcement;
- **Enterprise Resource Layer** — real systems, files, apps, login states, UKeys, networks.

This separation creates a reusable execution substrate that is independent of any single Agent framework.

---

## 2. Architecture Positioning

LandGod should be positioned as:

```text
Enterprise Execution Harness for AI Agents
```

Not as:

```text
remote shell
remote desktop
single MCP server
RPA replacement
simple device management
raw tool proxy
```

A more precise technical definition:

```text
LandGod is a governed distributed execution layer that turns machine-bound,
network-bound, credential-bound, and local-tool capabilities into auditable
Agent-callable tools.
```

Key category claim:

```text
MCPHub = MCP compatibility + enterprise execution governance
```

MCP defines the tool interface. LandGod defines where, how, under what policy, with which credential, and with which audit chain that tool executes.

---

## 3. High-Level Architecture

```text
+--------------------------------------------------------------------------+
|                             Agent Layer                                  |
|                                                                          |
|  OpenClaw / Claude / ChatGPT / Cursor / LangGraph / Dify / 自研 Agent     |
|                                                                          |
|  Responsibilities:                                                       |
|  - understand business intent                                            |
|  - plan steps                                                            |
|  - request tool calls                                                    |
|  - pass agent_id, credential_ref, credential_scope, arguments            |
+-----------------------------------+--------------------------------------+
                                    |
                                    | HTTP / SDK / MCP Adapter
                                    v
+-----------------------------------+--------------------------------------+
|                 LandGod Gateway / MCPHub Control Plane                   |
|                                                                          |
|  +------------------+   +------------------+   +----------------------+  |
|  | Agent API        |   | Worker Registry  |   | Tool Registry        |  |
|  | /tool_call       |   | clients/labels   |   | published tools      |  |
|  +---------+--------+   +---------+--------+   +----------+-----------+  |
|            |                      |                       |              |
|            v                      v                       v              |
|  +------------------+   +------------------+   +----------------------+  |
|  | Policy Engine    |   | Credential Broker|   | Approval Engine      |  |
|  | Effective Access |   | ref->grant->cred |   | future / high risk   |  |
|  +---------+--------+   +---------+--------+   +----------+-----------+  |
|            |                      |                       |              |
|            v                      v                       v              |
|  +------------------+   +------------------+   +----------------------+  |
|  | Gateway WebUI    |   | Central Control  |   | Gateway Audit        |  |
|  | Governance Console|  | worker/tool gate |   | central evidence     |  |
|  +------------------+   +------------------+   +----------------------+  |
+-----------------------------------+--------------------------------------+
                                    |
                                    | signed tool_call / credential_grant
                                    | Worker outbound WebSocket channel
                                    v
+-----------------------------------+--------------------------------------+
|                         Worker Execution Plane                           |
|                                                                          |
|  +------------------+   +------------------+   +----------------------+  |
|  | Managed Runtime  |   | Local Enforcement|   | Worker Local Audit   |  |
|  | WS client        |   | final veto       |   | local evidence       |  |
|  +---------+--------+   +---------+--------+   +----------+-----------+  |
|            |                      |                       |              |
|            v                      v                       |              |
|  +------------------+   +------------------+              |              |
|  | MCP Runtime      |   | Built-in Tools   |              |              |
|  | stdio/http tools |   | shell/file/etc   |              |              |
|  +---------+--------+   +---------+--------+              |              |
+------------|----------------------|-----------------------|--------------+
             |                      |                       |
             v                      v                       v
+------------+-------------------------------------------------------------+
|                       Enterprise Resource Layer                           |
|                                                                          |
|  ERP / Finance / Office / Browser / UKey / Files / Local CLI / Intranet   |
+--------------------------------------------------------------------------+
```

---

## 4. Network Deployment Topology

LandGod's network model is enterprise-friendly because Workers establish outbound WebSocket connections to the Gateway.

```text
                         Agent / Workflow Zone
        +------------------------------------------------------+
        | OpenClaw / Claude / ChatGPT / LangGraph / 自研 Agent  |
        +---------------------------+--------------------------+
                                    |
                                    | HTTP / MCP / SDK
                                    v
        +------------------------------------------------------+
        |       Private Cloud / DMZ / Gateway Zone              |
        |                                                       |
        |  +--------------------+      +---------------------+  |
        |  | Gateway WebUI      | ---> | LandGod Gateway     |  |
        |  | Governance Console |      | MCPHub Control Plane|  |
        |  +--------------------+      +----+-----+-----+----+  |
        |                                   |     |     |       |
        |                    +--------------+     |     +----------------+
        |                    |                    |                      |
        |            +-------v--------+   +-------v--------+     +-------v-------+
        |            | Policy /       |   | Credential     |     | Gateway       |
        |            | Approval       |   | Broker         |     | Central Audit |
        |            +-------+--------+   +-------+--------+     +-------+-------+
        +--------------------|--------------------|---------------------|--------+
                             |                    |                     |
                             | future             | future              | export
                             v                    v                     v
                    +----------------+    +----------------+     +---------------+
                    | SSO/OIDC/RBAC  |    | Vault / KMS    |     | SIEM / Logs   |
                    +----------------+    +----------------+     +---------------+

        Workers connect OUTBOUND. Gateway does not need inbound access
        to enterprise machines.

        +----------------------+      outbound WebSocket       +------------------+
        | Finance LAN          | ----------------------------> | LandGod Gateway  |
        |  Finance Worker      |                               |                  |
        |   -> ERP / Finance   |                               |                  |
        |   -> Excel / PPT     |                               |                  |
        +----------------------+                               |                  |
                                                               |                  |
        +----------------------+      outbound WebSocket       |                  |
        | Ops / Production Net | ----------------------------> |                  |
        |  Ops Worker          |                               |                  |
        |   -> Internal Systems|                               |                  |
        +----------------------+                               |                  |
                                                               |                  |
        +----------------------+      outbound WebSocket       |                  |
        | Branch / Remote Site | ----------------------------> |                  |
        |  Site Worker         |                               |                  |
        |   -> Local Apps      |                               |                  |
        |   -> Files / Browser |                               |                  |
        +----------------------+                               +------------------+
```

Topology advantages:

- no inbound port exposure on Worker machines;
- NAT/firewall/customer-site friendly;
- one Gateway entry point for many network zones;
- Worker can hold local login state, local files, UKey, Office, browser, ERP access;
- Agent never directly connects to internal enterprise machines.

---

## 5. Core Design Philosophy

### 5.1 Origin: CLI / No-API Gap

LandGod originates from a practical gap:

```text
Many useful enterprise tools have CLI/local workflows but no clean cloud API.
Cloud Agents cannot directly call them.
```

The first-order problem is not remote controlling computers. It is:

```text
How can Agents safely call local capabilities that have no API?
```

This expands naturally into a broader enterprise execution layer:

```text
local CLI
+ local desktop apps
+ intranet systems
+ browser login state
+ Office files
+ UKey/certificates
+ local credentials
+ audit evidence
```

### 5.2 Tool as the Schedulable Unit

A strong architectural analogy:

```text
Kubernetes schedules containers.
LandGod schedules enterprise tools.
```

The schedulable unit is not merely a process. It is:

```text
tool + machine + network location + permission + credential + audit
```

This is the right abstraction for enterprise Agent execution.

### 5.3 Agent Is Not a Security Boundary

LandGod must assume Agents are untrusted:

```text
Agent may be prompt-injected.
Web/PDF/email/tool output may be hostile.
MCP output may be malicious.
Agent may request shell/file/browser_eval to extract secrets.
```

Therefore security must be enforced by system boundaries:

```text
Gateway policy
Credential Broker
Worker identity
Worker isolation
Tool allowlist
Central control policy
Audit trail
```

Not by prompts.

---

## 6. Gateway / MCPHub Review

The Gateway is the most important product asset.

It should be treated as the enterprise control plane:

```text
Gateway = policy + routing + credential boundary + audit + management UI
```

Current responsibilities:

- Worker WebSocket admission;
- Worker registry and online status;
- Tool registry;
- `/tool_call`, async tasks, queue, batch dispatch;
- Credential Broker;
- central control for Worker/tool enable-disable;
- Agent activity registry and heartbeat;
- Gateway audit;
- WebUI governance console;
- Effective Access explanation.

Architectural assessment:

```text
Good: Gateway is becoming a governance plane, not just a forwarder.
Risk: policy surfaces are still distributed and need unification.
```

Recommended next step:

```text
Policy Bundle + Policy Version + Server-side Effective Access API
```

---

## 7. Worker Runtime Review

Worker is the execution plane.

Worker should be seen as:

```text
local capability adapter + local trust boundary + local evidence collector
```

Worker strengths:

- outbound WebSocket connection;
- local execution in real enterprise environment;
- MCP tool publication;
- local audit;
- local enforcement / final veto;
- finance/credential Worker isolation for sensitive cases.

Critical architectural principle:

```text
Gateway says MAY.
Worker says CAN.
```

Worker should not blindly execute every Gateway instruction. For production, Worker needs stronger profiles:

```text
Worker Security Profile
Policy Sync / Ack
quarantine mode
local allowlist
network egress profile
version attestation
machine identity
```

---

## 8. Credential Broker Review

Credential Broker is the key difference between toy automation and enterprise trust.

Current model:

```text
Agent sends credential_ref + credential_scope
Gateway checks credential policy
Gateway signs single-use grant
Worker validates grant binding/signature
Worker exchanges grant for short-lived credential
Trusted MCP tool receives credential
Audit records grant/exchange/result
```

ASCII flow:

```text
+--------+       credential_ref       +----------------------+       signed grant
| Agent  | -------------------------> | Gateway Credential   | ----------------+
+--------+                            | Broker               |                 |
                                      +----------+-----------+                 |
                                                 | policy check               |
                                                 v                            v
                                      +----------+-----------+       +----------------+
                                      | Credential Policy    |       | Worker Runtime |
                                      | agent/worker/tool/   |       | validate grant |
                                      | scope/expiry         |       +--------+-------+
                                      +----------------------+                |
                                                                              | exchange
                                                                              v
                                      +----------------------+       +--------+-------+
                                      | Credential Audit     | <---- | /credential/   |
                                      | grant/exchange/deny  |       | exchange       |
                                      +----------------------+       +--------+-------+
                                                                              |
                                                                              v
                                                                     +--------+-------+
                                                                     | Trusted Tool   |
                                                                     | _landgod_cred  |
                                                                     +----------------+
```

Strong points:

- Agent never receives secret values;
- grant is task-scoped and single-use;
- grant binds agent, worker, connection, tool, argument hash, expiry, and scope;
- `allowedTools: ["*"]` is blocked by default;
- `credential_scope` flows end-to-end;
- generic tools like shell/file/browser_eval are forbidden for credentials;
- exact secret values are redacted from Worker responses.

Production gaps:

- integrate Vault / KMS / Secret Manager;
- add approval-before-exchange for high-value credentials;
- add credential rotation and revocation propagation;
- avoid long-term Gateway-local secret storage for high-value production secrets.

---

## 9. Agent Identity and Heartbeat Review

Agents are currently HTTP callers, so without tracking they are effectively stateless from Gateway's point of view.

The MVP Agent heartbeat is the right minimal step. Current temporary policy intentionally treats heartbeat as presence registration, not authorization:

```text
Agent -> POST /agents/heartbeat -> Gateway
```

Temporary MVP heartbeat policy:

```text
agent_id only is accepted for presence registration.
LANDGOD_AGENT_TOKEN is optional proof metadata, not required.
Unauthenticated heartbeat is recorded as unauthenticated-heartbeat.
```

Gateway records:

- agent id;
- last heartbeat;
- proof/presence mode;
- version;
- capabilities;
- source IP / User-Agent;
- tools used;
- credentials used;
- workers operated;
- recent operations.

This makes WebUI able to answer:

```text
Which Agent is online?
Which Agent operated the Gateway?
Which tools/credentials/workers did it use?
When did it last report presence?
How did it prove identity?
```

Future production direction:

```text
per-agent API key
OIDC workload identity
signed request / mTLS
agent registration approval
agent RBAC
agent key rotation
```

---

## 10. WebUI Governance Console Review

The WebUI is evolving correctly from a demo panel into a governance console.

Important screens:

```text
Overview
Agents
Workers
Tools
Credentials
Scenarios
Tasks
Audit
Effective Access
```

Key governance features:

- Agents page: who operated Gateway;
- Workers page: Worker state and central enable-disable;
- Tools page: per-tool enable-disable;
- Credentials page: metadata-only secret governance;
- Scenarios page: business workflow packaging;
- Tasks page: operational trace;
- Audit page: investigation surface;
- Effective Access: explain allow/deny before execution.

Architectural recommendation:

```text
WebUI should become the operational source of truth for Gateway policy,
not merely a status dashboard.
```

---

## 11. Harness Design Review

LandGod's Harness model is strong because it separates reasoning from execution.

Agent frameworks answer:

```text
How does the Agent think and plan?
```

LandGod answers:

```text
Where does execution happen?
Under what identity?
On which Worker?
With which tool?
With which credential?
Under which policy?
With which approval?
With what audit evidence?
```

Harness responsibilities:

```text
Execution Adapter   -> expose CLI/MCP/local apps as tools
Execution Scheduler -> route by worker/client/labels/resources
Execution Boundary  -> enforce allowed tools and worker trust zones
Credential Boundary -> keep secrets out of Agent context
Evidence Harness    -> produce Gateway/Credential/Worker audit
```

This is the correct abstraction for enterprise Agent platforms.

---

## 12. Security Architecture Review

The security model is on the right track.

Core principles:

```text
Agent is untrusted.
Gateway policy decides authority.
Worker executes only within its allowed trust boundary.
Secrets enter trusted narrow tools, never general tools.
Every sensitive execution is auditable.
```

Important current protections:

- optional Gateway admin auth;
- Worker token admission;
- server-side Worker token bindings / labels;
- Credential Broker with task-scoped grants;
- blocked wildcard credential tools by default;
- credential scope enforcement;
- exact worker requirement for sensitive credentials;
- finance/credential Worker isolation;
- exact secret redaction;
- Worker/tool central disable;
- Agent heartbeat presence registration MVP;
- Gateway / Credential / Worker audit.

Recommended production hardening:

```text
SSO/OIDC/RBAC
approval engine
policy sync / ack
worker attestation
mTLS / cert-based Worker identity
Vault/KMS
SIEM export
audit hash chain
MCP connector signing
network egress control
release signing / SBOM
```

---

## 13. Audit and Evidence Review

Current audit model:

```text
Gateway central audit
Credential audit
Worker local audit
Task records
Scenario artifacts
```

This is the correct direction because enterprise customers need to answer:

```text
Who requested it?
Which Agent did it?
Which Gateway allowed it?
Which Worker executed it?
Which credential was used?
What result/artifact was produced?
Was anything denied?
```

Current weakness:

```text
JSONL audit is useful for MVP but not yet tamper-evident.
```

Recommended evidence chain:

```text
sequence number
hash chain
signed audit batch
artifact checksum
remote immutable storage
SIEM export
retention policy
```

---

## 14. MCP and Tool Supply Chain Review

LandGod depends heavily on MCP tools and local connectors.

This creates a supply-chain risk:

```text
malicious MCP tool
poisoned manifest
unexpected credentialAccess
untrusted tool returning prompt injection
external connector exfiltrating data
```

Recommended governance:

```text
MCP manifest signing
trusted publisher model
tool hash / version pinning
credentialAccess review
trustLevel promotion workflow
sandbox profile
network egress allowlist
```

Tool trust should be explicit:

```text
experimental -> local only
trusted      -> published remotely
blocked      -> disabled
```

---

## 15. Scalability and Reliability Review

Current architecture supports MVP and small deployments well.

Strengths:

- WebSocket fan-in from many Workers;
- queue for offline Workers;
- async tasks;
- batch dispatch;
- label-based routing;
- resources exposed by Workers;
- Gateway as central registry.

Future scalability needs:

```text
persistent task store
clustered Gateway
Redis/Postgres backend
worker leasing / heartbeat timeout
retry policy
backpressure
rate limits
multi-tenant isolation
HA Gateway
```

Recommended control-plane evolution:

```text
single-node Gateway MVP
→ persistent store
→ clustered Gateway
→ policy/version distribution
→ multi-tenant enterprise control plane
```

---

## 16. Key Risks

### Risk 1: Product Category Confusion

LandGod may be misread as remote shell, RPA, remote desktop, or MCP hosting.

Mitigation:

```text
Always position as Enterprise Execution Harness / MCPHub Governance Platform.
```

### Risk 2: Policy Fragmentation

Policy currently exists across Gateway, Worker, Credential, MCP trust, and WebUI controls.

Mitigation:

```text
Introduce Policy Bundle + Policy Version + Effective Access API.
```

### Risk 3: Worker Identity Weakness

Worker labels alone are not identity proof.

Mitigation:

```text
per-worker token
server-side labels
registration approval
certificate identity
attestation
```

### Risk 4: Audit Mutability

MVP audit is not strong compliance evidence.

Mitigation:

```text
hash chain + signed audit + immutable sink + SIEM export
```

### Risk 5: Credential Storage

Gateway-local credential storage is not enough for production high-value secrets.

Mitigation:

```text
Vault / KMS / Secret Manager integration
```

### Risk 6: MCP Supply Chain

Untrusted MCP tools can become attack surfaces.

Mitigation:

```text
manifest signing + trust workflow + version pinning + sandboxing
```

---

## 17. Recommended Roadmap

### P1: Governance Core

```text
Server-side Effective Access API
Policy Bundle / Policy Version
Worker Security Profile
Policy Sync / Ack
Approval Engine
RBAC role model
```

### P2: Identity and Trust

```text
per-agent token
per-worker token
agent registration
worker registration approval
mTLS / cert identity
worker attestation
```

### P3: Evidence Chain

```text
audit hash chain
artifact checksum
signed audit batch
SIEM export
retention policy
immutable storage
```

### P4: Credential Backend

```text
Vault / KMS
secret rotation
approval-before-exchange
scope-based credential issue
short-lived credential backend
```

### P5: Scenario Productization

```text
Finance Monthly Close
IT Ops Patrol
Supplier Reconciliation
Office / PPT Generator
ERP Export
Browser Portal Download
```

A Scenario should package:

```text
business workflow template
+ tool manifest
+ policy template
+ credential template
+ approval template
+ audit story
+ artifact outputs
```

---

## 18. Final Architecture Assessment

Overall assessment:

```text
Direction: strong
Abstraction: correct
MVP loop: proven
Enterprise story: credible
Security model: ahead of ordinary Agent tool platforms
Production maturity: needs governance, identity, audit, and secret backend hardening
```

Most important architectural conclusion:

```text
LandGod's moat is not remote execution itself.
The moat is governed execution: policy + credential boundary + Worker trust + audit evidence.
```

Final summary:

```text
Do not give Agents raw enterprise power.
Register enterprise capabilities as governed tools.
Let Gateway control policy, credentials, routing, and audit.
Let Worker execute locally inside bounded trust zones.
Let audit prove what happened.
```
