# 终极版 Pitch 讲述要点

## 1. 开场一句话

```text
MCPHub 解决的是云端 Agent 的最后一公里执行问题。
```

核心口号：

```text
Cloud intelligence, local execution.
云端智能，本地执行。
```

最关键的补充句：

```text
云端 Agent 可以在用户已有身份、权限和设备上下文下，安全调用本地能力。
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

一句话讲清：

```text
不是复制 Agent 到每台机器，也不是远程控制电脑，而是把用户设备变成受治理的本地执行运行时。
```

## 3. Slide 2 — WorkIQ Integration

目标：

```text
Add WorkIQ as a callable local capability inside Societas.
```

路径：

```text
Societas → MCPHub Gateway → MCPHub Client → WorkIQ CLI
```

讲清三点：

- Societas 看到的是可调用 capability。
- WorkIQ 仍然在用户设备上通过本地 CLI 执行。
- 用户身份、凭据、VPN、设备上下文都留在本地。

一句话：

```text
WorkIQ becomes Agent-operable without breaking the user's local trust boundary.
```

## 4. Slide 3 — MCPHub Gateway 架构

三层：

```text
Cloud Agents → MCPHub Gateway → MCPHub Client → Local Capabilities
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
- 验证 signed tool_call；
- 执行 Local Policy Gate；
- 在用户本地身份和设备上下文下执行工具；
- 不做独立决策，不是完整 Agent。

关键原则：

```text
Agent 不直接连接用户设备。
Client 主动 outbound 连接 Gateway。
```

## 5. Slide 4 — Trusted Execution Workflow

阶段 A：Client 注册能力。

```text
WS connect
→ token auth + session_opened
→ register binding: user + client + connection + session + server key
→ update_tools
→ publish capability catalog
```

一句话：

```text
先让 Gateway 知道这台设备在线、可信、有什么本地工具。
```

阶段 B：Agent 调用，本地执行。

```text
Agent HTTP /tool_call
→ Gateway route / sign / audit
→ signed tool_call
→ Client verify signed meta
→ Local Policy Gate: auto / approve / deny
→ Tool Registry
→ Local Tool
→ result returns through Gateway
```

一句话：

```text
每次调用先签名验证，再按本地策略决定是否以用户身份执行。
```

## 6. 签名安全点

Gateway 不是简单转发，而是签名、绑定、分发。

signed meta 绑定：

```text
request
user
client
connection
session
tool name
arguments
body hash
nonce
iat
exp
signature
```

字段解释：

- `body hash`：证明 tool name 和 arguments 没被篡改。
- `nonce`：一次性随机数，防止重放。
- `iat`：issued at，签发时间。
- `exp`：过期时间，限制有效窗口。
- `signature`：证明请求确实由 Gateway 签发。
- `binding`：保证请求只属于当前用户、当前 Client、当前 connection、当前 session。

## 7. Human / Policy Gate

Human approval 不是每次都要。

更准确叫：

```text
Local Policy Gate
```

作用：

```text
签名证明请求是真的；
Policy Gate 判断这个动作是否允许用用户身份执行。
```

策略：

```text
低风险：auto
高风险：approve
危险动作：deny
```

## 8. 差异化讲法

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

## 9. 收尾三句话

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
