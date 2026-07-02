# LandGod / MCPHub Gateway — Speaker Script

## Opening

Today I want to explain the product idea behind LandGod and MCPHub Gateway.

The short version is:

> Cloud agents are becoming very good at reasoning, but real work still happens in the user’s local environment.

That local environment includes CLI tools, browser sessions, files, repositories, VPN access, enterprise identity, and device-specific configuration.

LandGod is the bridge between those two worlds: cloud intelligence and local execution.

---

## Slide 1 — Problem → Generalized Product Pattern

We started with a concrete WorkIQ problem.

Societas, as a cloud Agent, needed to operate WorkIQ for the user. But the useful WorkIQ capability was not exposed as a clean cloud API. It lived behind a local `workiq` CLI on the user’s computer.

So the first problem looked simple:

> How can a cloud Agent call a local CLI safely?

But the real boundary was larger than WorkIQ.

The valuable execution context was local:

- local CLI tools;
- browser login state;
- AAD tokens and cookies;
- VPN and internal network access;
- local repositories and files;
- device-specific configuration.

Moving all of that into the cloud would be risky, fragile, and often impossible.

So we generalized the problem directly:

> WorkIQ is just one example. The real product category is Local Computer Access for cloud Agents.

The pattern is:

```text
Cloud Agent → Gateway → Local Worker → User Tools
```

The Agent keeps reasoning in the cloud. The actual execution happens on the user’s own trusted device.

That is the thesis of the product:

> Cloud intelligence, local execution.

---

## Slide 2 — Product Architecture + Demo Placeholder

This slide shows the product architecture.

On the left, we have Agent producers:

- OpenClaw;
- Societas;
- GitHub Copilot;
- and other Agents.

They all call one governed service: MCPHub Gateway.

The Gateway is the cloud control plane. It provides:

- Agent and MCP-compatible APIs;
- authentication and policy;
- routing and capability registry;
- credential broker;
- activity history.

On the right, we have the user execution plane.

That can be a laptop, VM, DevBox, or workshop machine. Each device runs a LandGod Worker. The Worker exposes a local tool registry, which can include:

- WorkIQ CLI;
- file tools;
- browser tools;
- company CLI tools;
- local MCP tools.

The important architecture point is this:

> Agents do not directly connect to personal devices.

Instead, Workers connect outbound to the Gateway. The Gateway governs and routes. The Worker executes locally.

This gives us a clean separation:

```text
Gateway = control plane
Worker  = local execution plane
```

The demo slot on the right is where we can show one real end-to-end action:

```text
Agent → MCPHub → Worker → Local Tool → Result + Activity trace
```

For example, a cloud Agent can call `workiq`, a local CLI, or a browser tool, and the result returns through the Gateway with an activity record.

---

## Slide 3 — Product Workflow: Register, Invoke, Execute

The product flow has two phases.

### Phase A — Worker connects and publishes tools

First, the user’s Worker connects outbound to the Gateway.

The sequence is:

```text
1. WS connect
2. token auth + session_opened
3. register binding + update_tools
4. publish catalog
```

This is important because the user device does not need to expose an inbound port.

After the Worker connects, the Gateway establishes the device binding. Then the Worker publishes its local capabilities through `update_tools`.

Those capabilities become a user-scoped catalog.

So from the Agent’s point of view, local tools appear as available tools. But physically, the tools still live and execute on the user’s device.

### Phase B — Agent calls and Worker executes locally

Second, the Agent invokes a tool.

The request starts inside the Agent Runtime:

```text
HTTP /tool_call
```

The Gateway receives the call, then performs its control-plane responsibilities:

```text
route · sign · audit
```

It selects the right Worker by connection ID, client name, or labels. Then it sends a signed WebSocket call to that Worker.

On the Worker side, the request is verified before execution. The Worker checks the signed request, nonce, body hash, expiration, and tool binding.

Only then does it invoke the local tool runtime:

```text
toolRegistry.callTool()
```

The result comes back through the same governed path:

```text
Local Tool → Worker → Gateway → Agent Runtime
```

And the Gateway records the response and activity trace.

So the complete product workflow is:

```text
Register capabilities first.
Invoke later through Gateway.
Execute locally on the Worker.
Return results through Gateway.
Record Activity for proof.
```

---

## Closing

LandGod / MCPHub Gateway turns personal or enterprise devices into governed local execution runtimes for cloud Agents.

The core operating model is:

```text
Gateway governs.
Worker executes.
Activity proves.
```

That is how cloud Agents move from suggestions to real actions, without moving local identity, secrets, or device context into the cloud.
