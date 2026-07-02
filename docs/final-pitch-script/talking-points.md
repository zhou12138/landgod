# 终极版 Pitch 讲述要点

## 1. 开场一句话

```text
MCPHub 解决的是：云端 Agent 很会思考，但真实工作环境仍然在用户本地设备上。
```

核心口号：

```text
Cloud intelligence, local execution.
云端智能，本地执行。
```

## 2. Slide 1 — 从 WorkIQ 集成泛化成产品模式

- 起点是真实业务场景：Societas 想集成 WorkIQ 能力。
- WorkIQ 不是现成云端 API，实际能力在用户本地 WorkIQ CLI。
- CLI 背后绑定 AAD、设备权限、VPN、文件、Repo、浏览器 session、企业内部访问环境。
- 这些上下文不能搬到云端。
- WorkIQ 只是例子，真正产品类别是：

```text
Local Computer Access for cloud Agents
```

## 3. Slide 2 — MCPHub Gateway 架构

三层：

```text
Cloud Agents → MCPHub Gateway → MCPHub Client / Local Capabilities
```

Gateway 负责：

- Agent / MCP API
- Auth + Policy
- Router + Registry
- Signed Call Dispatcher
- Activity History

Client 负责：

- outbound 连接 Gateway；
- 发布本地能力；
- 在用户设备上执行工具；
- 不做独立决策，不是完整 Agent。

关键原则：

```text
Agent 不直接连接用户设备。
```

## 4. Slide 3 — Trusted Execution Workflow

阶段 A：Client 注册能力。

```text
WS connect
→ token auth + session_opened
→ register binding: session + server key
→ update_tools
→ publish capability catalog
```

阶段 B：Agent 调用，本地执行。

```text
Agent HTTP /tool_call
→ Gateway route / sign / audit
→ signed tool_call
→ Client verify signed meta
→ Tool Registry
→ Local Tool
→ result returns through Gateway
```

安全点：

- Gateway 不是简单转发，而是签名、绑定、分发。
- signed meta 绑定 request、user、client、connection、session、body hash、nonce、exp。
- Client 先验签、验 body hash、验 replay、验过期时间和 binding，再执行。

## 5. 差异化讲法

和普通 MCP Server 区别：

```text
MCP 标准化的是 Agent 怎么调用工具；
MCPHub 产品化的是这些工具如何在用户真实环境中安全执行。
```

和每台机器装 Agent 区别：

```text
每台机器装 Agent，只是得到很多分散的执行端；
MCPHub 提供的是跨多台用户设备的统一受治理执行网络。
```

## 6. 收尾三句话

```text
Gateway governs.
Client executes.
Activity proves.
```

中文：

```text
Gateway 负责治理；
Client 负责执行；
Activity 负责证明。
```
