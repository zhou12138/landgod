# LandGod / MCPHub Gateway — 3-Minute Pitch Script

## Opening

This deck tells the origin story of LandGod / MCPHub Gateway.

The core message is simple:

> Cloud Agents can reason in the cloud, but real work often depends on tools, identity, and network context on the user’s own device.

LandGod bridges that gap.

It is not remote control. It is not exposing a personal computer to the internet. It is a governed execution bridge from cloud Agents to local tools.

---

## Slide 1 — WorkIQ Integration Gap

The initial problem came from a WorkIQ integration.

Societas was running in the cloud as the reasoning Agent. But WorkIQ did not expose a clean API. The usable entrypoint was a local `workiq` CLI already configured on the user’s work machine.

That created a hard boundary:

- the Agent was in the cloud;
- the tool was local;
- the CLI depended on local login state, VPN, and device context;
- AAD tokens, cookies, and corporate access could not be moved to the cloud;
- personal devices could not expose inbound ports.

So the design principle became:

> outbound Worker, no exposed personal device ports.

The first bridge was:

```text
Cloud Agent → Gateway → Local Worker → Local CLI
```

The insight was that the Agent had intelligence, but it lacked a safe local execution runtime.

---

## Slide 2 — Product Insight

After WorkIQ, we realized this was not WorkIQ-specific.

The user’s real productivity context already lives on their own devices:

```text
workiq, az, copilot, gh, kubectl, ssh, Portal, local repo
```

These tools are valuable because they are already configured with identity, permissions, repos, browser state, VPN, and internal access.

So the product opportunity is broader:

> Let cloud Agents use the user’s existing local tool ecosystem safely.

MCPHub Gateway becomes a personal local-tool runtime across trusted devices:

```text
Desktop, Laptop, Cloud VM, DevBox
```

The Gateway provides:

- AAD identity and permission boundary;
- device routing;
- capability registry;
- activity history.

This is not another Agent. It is the runtime layer that lets Agents move from suggestions to real actions.

---

## Slide 3 — Trusted Execution Workflow

The actual workflow has two parts.

First, capability publishing.

The Agent discovers the Gateway through Skill and local configuration. Separately, the Worker connects outbound to the Gateway over WebSocket.

The Worker registers itself, establishes a binding, and publishes its capability catalog.

Local capabilities come from two sources:

- built-in tools, such as shell, file, and browser tools;
- MCP tools, discovered through MCP `listTools()`.

The Worker packages those into `toolRegistry`, then publishes tool definitions through `update_tools`.

Second, tool execution.

When the Agent wants to act, it calls the Gateway over HTTP:

```text
POST /tool_call
```

The Gateway applies policy, records activity, selects a Worker by connection ID, client name, or labels, then signs and dispatches the request over WebSocket.

The Worker validates the request, checks the tool binding, runs approval or credential logic if needed, and finally calls:

```text
toolRegistry.callTool()
```

The result goes back over WebSocket to the Gateway, then back as an HTTP response to the Agent.

In one sentence:

> HTTP to Gateway. WebSocket to Worker. Local tools execute.

---

## Closing

LandGod / MCPHub Gateway turns personal devices into secure local tool runtimes for cloud Agents.

The operating model is:

```text
Gateway governs.
Worker executes.
Activity proves.
```
