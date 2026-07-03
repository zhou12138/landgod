# MCPHub Gateway / MCPHub Client — 3分钟产品 Pitch 文稿

大家好，今天我介绍的是 **MCPHub Gateway / MCPHub Client**。

一句话定位：**MCPHub 解决的是云端 Agent 的最后一公里执行问题。**

现在云端 Agent 已经很擅长理解需求、拆解任务、生成计划。但在很多真实业务场景里，真正能完成动作的能力，并不在云端，而在用户自己的工作环境里。

我们最开始遇到的是 WorkIQ 场景：Societas 想集成 WorkIQ 的能力，让 WorkIQ 成为 Societas 里一个可以被 Agent 调用的本地能力。

但 WorkIQ 并不是一个可以直接调用的云端 API。真正可用的能力，是用户电脑上已经配置好的本地 WorkIQ CLI。而这个 CLI 背后绑定的不只是命令行工具，还包括用户已有的 AAD 身份、设备权限、VPN、配置文件、代码仓库、浏览器 session，以及企业内部访问环境。

这些东西不能简单搬到云端。搬过去不安全、不稳定，很多情况下也根本搬不了。

所以 MCPHub 要解决的不是“远程控制电脑”，而是建立一条受治理的执行桥梁：

> A governed execution bridge from cloud Agents to the user’s real work environment.

也就是：让云端 Agent 可以在用户已有身份、权限和设备上下文下，安全调用本地能力。

一句话总结就是：

> Cloud intelligence, local execution.  
> 云端智能，本地执行。

---

## Slide 1 — From WorkIQ Integration to a Reusable Local Execution Pattern

第一页讲的是：一个 WorkIQ 集成问题，如何泛化成一个可复用的产品模式。

最开始，我们只是想把 WorkIQ 能力集成进 Societas。Societas 在云端负责 reasoning 和任务规划，但 WorkIQ 的实际执行能力在用户本地电脑上。

这暴露了一个更普遍的问题：很多真正能完成工作的工具，并不在云端。它们存在于用户本地环境里，比如 CLI、门户系统、文件、浏览器、代码仓库，以及各种内部系统。

更重要的是，这些能力通常和用户身份强绑定：AAD、设备、权限、VPN、cookie、token，这些上下文必须留在本地。

所以 WorkIQ 不是一个孤立问题。它代表的是一个更大的产品类别：

> Local Computer Access for cloud Agents.

这里的核心不是复制一个 Agent 到每台机器上，也不是让 Agent 远程遥控电脑。

核心是：

```text
Cloud Agent → MCPHub Gateway → MCPHub Client → Local Capabilities
```

云端 Agent 负责理解和规划；MCPHub Gateway 负责治理、路由和审计；MCPHub Client 在用户本地设备上，以用户已有身份和设备上下文执行真实动作。

---

## Slide 2 — WorkIQ Integration: Societas → MCPHub → WorkIQ CLI

第二页讲的是 WorkIQ 怎么真正集成进 Societas。

目标很简单：把 WorkIQ 变成 Societas 里一个可调用的本地能力。用户不再需要截图、复制粘贴，也不需要手动把 CLI 结果转交给 Agent。

调用路径是：

```text
Societas → MCPHub Gateway → MCPHub Client → WorkIQ CLI
```

Societas 发起 tool call；Gateway 负责认证、路由、签名和审计；MCPHub Client 在用户设备上验证请求，然后调用本地 WorkIQ CLI。最后结果和 Activity trace 通过 Gateway 返回给 Societas。

这页的重点是：Societas 看到的是一个可调用 capability，但 WorkIQ 仍然运行在用户设备上。用户的身份、凭据和执行上下文都留在本地。

---

## Slide 3 — MCPHub Gateway Architecture & Demo

第三页是产品架构。

左边是 Cloud Agents，比如 OpenClaw、Societas、GitHub Copilot，以及其他 Agent。它们不直接连接用户设备，而是统一调用 MCPHub Gateway。

中间是 **MCPHub Gateway**。它是云端控制面，负责几件事：

第一，提供 Agent / MCP API，让不同 Agent 可以通过统一接口调用工具；  
第二，做 Auth + Policy，控制谁可以调用什么能力；  
第三，维护 Router + Registry，也就是路由和能力目录；  
第四，通过 Signed Call Dispatcher 对 tool call 做签名、绑定和分发；  
第五，记录 Activity History，留下可审计的执行轨迹。

右边是用户设备，比如 Laptop、VM、DevBox 或 Workshop 机器。每台设备上运行 **MCPHub Client**。Client 不是一个独立做决策的 Agent，而是一个本地 Worker Runtime。

它负责把本地能力发布出来，比如 WorkIQ CLI、文件工具、浏览器工具、Shell、Custom MCP Server，或者企业内部工具链。

这里最关键的原则是：

> Agent 不直接连接用户设备。

MCPHub Client 主动 outbound 连接 Gateway。这样用户设备不需要开放 inbound port，也不需要把本地身份、密钥、cookie、VPN 环境暴露到云端。

Demo 要展示的就是一个端到端动作：

```text
Agent → MCPHub Gateway → MCPHub Client → Local Tool → Result + Activity Trace
```

也就是从云端意图，到本地执行，再到结果和审计记录返回。

---

## Slide 4 — Trusted Execution: How Agents Invoke Local Capabilities

第四页讲完整 workflow，分成两个阶段。

第一阶段，是 **MCPHub Client 连接并发布工具能力**。

Client 启动后，会从用户现场环境主动连接 Gateway，完成 WebSocket connect、token auth 和 session_opened。

接着它注册 binding，建立一组信任上下文，包括 user、client、connection、session 和 server key。然后通过 update_tools 发布本地工具能力，形成一个用户级 capability catalog，也就是能力目录。

从 Agent 的视角看，这些本地工具变成了可调用能力；但从执行位置看，它们仍然留在用户本地设备上。

第二阶段，是 **Agent 调用，Client 本地执行**。

Agent 发起 HTTP /tool_call 到 Gateway。Gateway 根据 connectionId、clientName 或 labels 选择正确的 MCPHub Client。

这里 Gateway 不是简单转发。它会通过 Signed Call Dispatcher 对请求做签名和绑定。签名内容会绑定 request、user、client、connection、session、tool name、arguments、body hash、nonce、iat 和 exp。

这里几个字段很关键：

- `body hash` 证明 tool name 和 arguments 没有被篡改；
- `nonce` 是一次性随机数，防止同一个请求被重放；
- `iat` 是 issued at，也就是签发时间；
- `exp` 是过期时间，限制这次调用的有效窗口；
- `signature` 证明这个请求确实由 Gateway 签发。

然后 Gateway 通过 WebSocket 发送 signed tool_call 给 MCPHub Client。

Client 收到请求后，也不会直接执行。它会先验证 signed meta：验签、校验 body hash、防 replay、检查 iat / exp、检查 user / client / connection / session binding。

验证通过以后，还会经过本地策略门，也就是 Local Policy Gate。低风险动作可以自动放行；高风险动作可以要求用户 approve；危险动作可以直接 deny。

只有这些都通过后，Client 才会进入本地 Tool Registry，调用真正的本地能力，比如 WorkIQ、Files、Shell 或 Custom MCP Server。

执行结果会沿着同一条受治理路径返回：

```text
Local Tool → MCPHub Client → MCPHub Gateway → Agent
```

同时 Gateway 记录 Response + Activity，证明谁调用了什么工具、在哪台设备上执行、结果是什么。

---

## Closing

所以 MCPHub 和普通 MCP Server 的区别是：

> MCP 标准化的是 Agent 怎么调用工具；MCPHub 产品化的是这些工具如何在用户真实环境中安全执行。

和“每台机器装一个 Agent”也不同。每台机器装 Agent，只是得到很多分散的执行端；MCPHub 提供的是跨多台用户设备的统一受治理执行网络。

最后用三句话总结：

```text
Gateway governs.
Client executes.
Activity proves.
```

中文就是：

```text
Gateway 负责治理；
Client 负责执行；
Activity 负责证明。
```

MCPHub 的价值，就是让云端 Agent 从“只能给建议”，变成“可以安全完成真实动作”，同时不需要把本地身份、密钥、登录态和设备上下文搬到云端。
