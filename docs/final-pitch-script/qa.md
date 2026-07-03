# MCPHub / WorkIQ Pitch — Q&A 准备

## 1. MCPHub 和普通 MCP Server 有什么区别？

**短答：**

```text
MCP 标准化的是 Agent 怎么调用工具；
MCPHub 产品化的是这些工具如何在用户真实环境中安全执行。
```

**展开：**

普通 MCP Server 主要解决工具接口协议：tools/list、tools/call、schema、transport。MCPHub 在这个基础上增加了执行层和治理层：设备注册、能力目录、路由、签名调用、凭据边界、Local Policy Gate、Activity History，以及本地执行。

所以 MCPHub 可以对外暴露 MCP-compatible API，但它不是单纯的 MCP Server，而是 MCP 背后的 governed local execution layer。

---

## 2. 这和每台机器装一个 Agent 有什么区别？

**短答：**

```text
每台机器装 Agent，只是得到很多分散的执行端；
MCPHub 提供的是跨多台用户设备的统一受治理执行网络。
```

**展开：**

MCPHub Client 不是本地大脑，不负责推理、规划和自主决策。Agent 在云端做 reasoning，Gateway 做治理、路由、签名和审计，Client 只在本地验证请求并执行工具。

这避免了 N 个 Agent × M 台机器的点对点集成复杂度，也让企业可以统一管理权限、审计、设备状态和能力目录。

---

## 3. 为什么不直接把 WorkIQ 做成云端 API？

因为 WorkIQ 的真实可用能力依赖用户本地上下文：AAD 身份、设备权限、VPN、配置文件、本地 CLI、浏览器 session、Repo 和企业内部网络。

这些上下文不能简单搬到云端。搬过去会带来安全风险、稳定性问题和合规问题。MCPHub 的设计是让这些上下文留在本地，由 Client 在用户设备上执行。

---

## 4. MCPHub 是远程控制电脑吗？

不是。

远程控制通常意味着云端或远端直接控制用户桌面、键鼠或整台机器。MCPHub 的定位是：

```text
A governed execution bridge from cloud Agents to the user's real work environment.
```

Agent 不直接连接用户设备。Client 主动 outbound 连接 Gateway，发布受控能力目录。Agent 只能调用被发布、被授权、被审计的工具能力。

---

## 5. 云端 Agent 是不是在“以用户身份”执行？这安全吗？

是的，关键价值之一就是：

```text
云端 Agent 可以在用户已有身份、权限和设备上下文下调用本地能力。
```

安全性来自几层边界：

1. 用户身份、token、cookie、VPN、文件等上下文留在本地；
2. Agent 不直接连接用户设备；
3. Gateway 对 tool_call 做签名、绑定和审计；
4. Client 验证 signed meta 后才执行；
5. Local Policy Gate 可以决定 auto / approve / deny；
6. Gateway 记录 Activity trace，证明发生了什么。

---

## 6. 为什么需要 Signed Call Dispatcher？

因为 Gateway 不能只是转发请求。它要证明这次 tool_call：

- 确实来自 Gateway；
- 发给正确的 user / client / connection / session；
- tool name 和 arguments 没被篡改；
- 请求没有过期；
- 请求没有被重放；
- 可以被审计追踪。

所以 Gateway 会生成 signed meta，包括 body hash、nonce、iat、exp、binding 和 signature，再分发给 MCPHub Client。

---

## 7. nonce、iat、exp、body hash 分别是什么？

- `body hash`：对 tool name + arguments 算 hash，证明请求内容没被改。
- `nonce`：一次性随机数，防止同一个请求被重复执行，也就是 replay attack。
- `iat`：issued at，签发时间。
- `exp`：expiration time，过期时间。
- `signature`：Gateway 用私钥生成的数字签名，Client 用公钥验证。

一句话：

```text
签名证明请求是真的；body hash 证明参数没被改；nonce 防重放；iat/exp 限制有效时间。
```

---

## 8. Human approval 是不是每次 tool call 都需要？

不是。

更准确的说法是 **Local Policy Gate**：

```text
低风险动作：auto
高风险动作：approve
危险动作：deny
```

签名验证解决的是请求真实性和完整性；Local Policy Gate 解决的是这个动作是否允许用用户身份执行。

也就是：

```text
Signed meta proves the request is valid.
Policy Gate decides whether the action is allowed.
```

---

## 9. MCPHub Client 为什么要 outbound 连接 Gateway？

因为这样用户设备不需要开放 inbound port，也不需要暴露公网服务。

流程是：

```text
MCPHub Client → outbound WebSocket → MCPHub Gateway
```

而不是：

```text
Gateway → 打进用户内网 / 用户设备
```

这更符合企业和个人设备的安全边界。

---

## 10. Capability Catalog 是什么？

Capability Catalog 中文可以叫 **能力目录**。

MCPHub Client 会把本地可用工具通过 update_tools 发布给 Gateway，例如：

- WorkIQ CLI；
- Files；
- Browser；
- Shell；
- Custom MCP Server；
- 企业内部 CLI。

Gateway 看到的是用户级能力目录；工具本体和身份上下文仍然留在用户设备上。

---

## 11. MCPHub 如何处理凭据？

原则是：

```text
credentials stay local
```

本地身份、token、cookie、VPN、AAD 上下文不需要搬到云端。Gateway 负责治理、路由、签名和审计；Client 在本地环境里使用已有身份和权限执行工具。

如果涉及更复杂的凭据授权，可以通过 Credential Broker 或本地策略来做临时授权、范围控制和审计。

---

## 12. 如果 Client 离线怎么办？

Gateway 可以知道 Client 当前连接状态。离线时，这台设备上的能力不可调用，或者进入等待/重试/任务失败路径。

MCPHub 的设计是把设备连接、能力目录和路由集中在 Gateway 管理，避免 Agent 自己逐台机器处理在线状态。

---

## 13. 这个方案最大的产品价值是什么？

一句话：

```text
让云端 Agent 从“只能给建议”变成“可以安全完成真实动作”。
```

更完整地说：

MCPHub 让 Agent 可以调用用户真实工作环境中的本地能力，同时不把本地身份、密钥、登录态、VPN 和设备上下文搬到云端。

---

## 14. 这个方案适合哪些场景？

适合任何“能力在本地、身份在本地、环境在本地”的场景：

- 企业 CLI；
- 内部门户；
- 本地文件和代码仓库；
- 浏览器 session；
- DevBox / Workshop；
- VPN 内网工具；
- 本地 MCP Server；
- 需要用户身份和设备权限的业务系统。

WorkIQ 只是第一个例子，不是唯一场景。

---

## 15. 最后一句怎么总结？

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
