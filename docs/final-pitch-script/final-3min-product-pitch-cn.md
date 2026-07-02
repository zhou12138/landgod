# MCPHub Gateway / MCPHub Client — 3分钟产品 Pitch 文稿

大家好，今天我介绍的是 **MCPHub Gateway / MCPHub Client**。

这个产品来自一个真实业务场景：Societas 想集成 WorkIQ 的能力，让 WorkIQ 成为 Societas 里一个可以被 Agent 调用的本地能力。

但这里遇到一个关键问题：WorkIQ 的能力并不是一个现成的云端 API。真正可用的能力，是用户电脑上已经配置好的本地 WorkIQ CLI。而这个 CLI 背后绑定的不只是一个命令行工具，还包括用户的 AAD 身份、设备权限、VPN、配置文件、代码仓库、浏览器 session，以及企业内部访问环境。

这些东西不能简单搬到云端。搬过去不安全、不稳定，很多情况下也根本搬不了。

所以我们要解决的不是“远程控制电脑”，而是建立一条受治理的执行桥梁：

> A governed execution bridge from cloud Agents to the user’s real work environment.

中文就是：从云端 Agent 到用户真实工作环境的受治理执行桥梁。

一句话总结：

> Cloud intelligence, local execution.  
> 云端智能，本地执行。

---

## Slide 1 — From WorkIQ Integration to a Reusable Local Execution Pattern

第一页讲的是问题如何从 WorkIQ 集成，泛化成一个可复用的产品模式。

最开始，我们只是想把 WorkIQ 能力集成进 Societas。Societas 负责云端 reasoning 和任务规划，但 WorkIQ 的实际执行能力在用户本地电脑上。

这暴露了一个更普遍的问题：很多真正能完成工作的工具，并不在云端。它们存在于用户本地环境里，比如 CLI、门户系统、文件、浏览器、代码仓库，以及各种内部系统。

而这些能力通常又和身份强绑定：AAD、设备、权限、VPN、cookie、token，这些上下文都必须留在本地。

所以 WorkIQ 不是一个孤立问题。它代表的是一个更大的产品类别：

> Local Computer Access for cloud Agents.

也就是让云端 Agent 可以安全、受控地调用用户本地环境中的能力。

这里的核心不是复制一个远程 Agent 到每台机器上，而是把用户设备变成一个受治理的本地执行运行时。

---

## Slide 2 — MCPHub Gateway Architecture & Demo

第二页是产品架构。

左边是 Cloud Agents，比如 OpenClaw、Societas、GitHub Copilot，以及其他 Agent。它们不直接连接用户设备，而是统一调用 MCPHub Gateway。

中间是 **MCPHub Gateway**。它是云端控制面，负责几件事：

第一，提供 Agent / MCP API，让不同 Agent 可以通过统一接口调用工具；
第二，做 Auth + Policy，控制谁可以调用什么能力；
第三，维护 Router + Registry，也就是路由和能力目录；
第四，通过 Signed Call Dispatcher 对 tool call 做签名、绑定和分发；
第五，记录 Activity History，留下可审计的执行轨迹。

右边是用户设备，比如 Laptop、VM、DevBox 或 Workshop 机器。每台设备上运行 **MCPHub Client**。Client 不是一个独立做决策的 Agent，而是一个本地 Worker Runtime。

它负责把本地能力发布出来，比如 WorkIQ CLI、文件工具、浏览器工具、Shell、Custom MCP Server，或者企业内部工具链。

整个架构的关键原则是：

> Agent 不直接连接用户设备。

MCPHub Client 主动 outbound 连接 Gateway。这样用户设备不需要开放 inbound port，也不需要把本地身份、密钥、cookie、VPN 环境暴露到云端。

Demo 要展示的就是一个端到端动作：

```text
Agent → MCPHub Gateway → MCPHub Client → Local Tool → Result + Activity Trace
```

也就是从云端意图，到本地执行，再到结果和审计记录返回。

---

## Slide 3 — Trusted Execution: How Agents Invoke Local Capabilities

第三页讲完整 workflow，分成两个阶段。

第一阶段，是 **MCPHub Client 连接并发布工具能力**。

Client 主动连接 Gateway，完成 WebSocket connect、token auth 和 session_opened。接着它注册 binding，建立 session、client、connection 和 server key 的信任上下文。然后通过 update_tools 发布本地工具能力，形成一个用户级 capability catalog，也就是能力目录。

从 Agent 的视角看，这些本地工具变成了可调用能力；但从执行位置看，它们仍然留在用户本地设备上。

第二阶段，是 **Agent 调用，Client 本地执行**。

Agent 发起 HTTP /tool_call 到 Gateway。Gateway 根据 connectionId、clientName 或 labels 选择正确的 MCPHub Client。

这里 Gateway 不是简单转发。它会通过 Signed Call Dispatcher 对请求做签名和绑定，包括 request、user、client、connection、session、body hash、nonce 和过期时间。

然后 Gateway 通过 WebSocket 发送 signed tool_call 给 MCPHub Client。

Client 收到请求后，也不会直接执行。它会先验证 signed meta，包括签名、body hash、nonce replay、过期时间和 binding。只有验证通过后，才会进入本地 Tool Registry，调用真正的本地能力，比如 WorkIQ、Files、Shell 或 Custom MCP Server。

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
