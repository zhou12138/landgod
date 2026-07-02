# LandGod / MCPHub Gateway 三页 Pitch 演讲稿

## 开场

今天我想用一个真实的集成问题，讲一下 LandGod / MCPHub Gateway 为什么会出现，以及它解决的到底是什么问题。

它不是一个单纯的远程控制工具，也不是一个简单的 MCP proxy。  
它解决的是云上 Agent 落地时非常具体的最后一公里问题：

> Agent 在云上能理解任务，但真正能完成任务的工具、登录态、文件、repo、VPN 和公司环境，往往都在用户自己的设备上。

所以这套东西的核心可以概括成一句话：

> Cloud Agent, Local Tools.  
> 云上 Agent，本地工具。

---

## 第 1 页：WorkIQ 真实问题

我们最开始遇到的问题，是 Societas 想要集成 WorkIQ。

但是 WorkIQ 当时没有一个标准 API。  
它真正可用的入口，是用户工作电脑上已经配置好的 `workiq` CLI。

这就产生了一个天然冲突：

Societas 和 Agent 都在云上。  
但是 WorkIQ CLI、AAD token、cookie、公司网络环境、VPN、权限上下文，都在用户自己的工作设备上。

而且这里有两个事情不能做：

第一，不能让个人电脑直接暴露公网端口。  
第二，不能把用户的 AAD token、cookie、SSH key 或公司内部环境搬到云端。

所以问题不是简单地“接一个 API”。  
问题其实是：

> 云上 Agent 怎么安全地调用用户本地电脑上的真实工作工具？

我们的第一性方案是：

```text
Cloud Agent / Societas
→ Gateway
→ Local Worker
→ workiq CLI
```

这里最关键的一点是：

> 这不是远控，也不是把用户电脑暴露给云端。  
> 而是本地 Worker 主动出站连接 Gateway，在安全边界内让云上 Agent 接触真实工作环境。

这样，个人设备不需要暴露公网端口，凭据和登录态也仍然留在用户设备里。

---

## 第 2 页：从 WorkIQ 泛化成个人生产力入口

后来我们发现，这不是 WorkIQ 一个工具的问题。

WorkIQ 只是一个例子。  
在真实工作流里，用户真正有价值的工具箱，往往本来就在自己的设备上。

比如：

```text
workiq
az
copilot
gh
kubectl
ssh
公司 Portal
本地 repo
浏览器登录态
VPN 环境
```

这些工具很多没有干净的云端 API。  
就算有 API，也经常无法复刻用户本地电脑上的完整上下文。

比如：

- 当前登录态
- AAD 权限
- 本地 repo 状态
- DevBox 环境
- 公司内网访问能力
- 已经配置好的 CLI profile

所以 LandGod / MCPHub Gateway 的价值，不只是帮 Societas 接一个 WorkIQ。

它更大的价值是：

> 让云上 Agent 可以安全使用用户个人设备里的工具箱。

在这个模型里，用户可能有多台设备：

```text
台式机
笔记本
云上 VM
DevBox
```

这些设备都属于同一个用户身份和权限边界。  
Gateway 负责把这些设备组织起来，做设备路由、能力目录、权限边界和 Activity History。

也就是说，LandGod / MCPHub Gateway 不是再做一个 Agent。  
它补的是 Agent 缺的执行环境：

> Agent 负责理解和规划；  
> Gateway 负责治理和路由；  
> Worker 负责在用户自己的设备上执行真实工具。

这就是为什么它可以从一个 WorkIQ bridge，泛化成个人生产力入口。

---

## 第 3 页：可信落地

最后讲它具体怎么跑起来。

这一页分成左右两部分。

左边是：

> Worker 怎么注册和发布本地能力。

右边是：

> Agent 怎么调用这些能力。

先看左边。

Agent 不是凭空知道 LandGod / MCPHub 的。  
以我作为 OpenClaw Agent 为例，我是通过 LandGod Skill 和本地配置知道 Gateway 地址、API 规范和调用方式的。

也就是：

```text
Agent
→ Skill + config
→ Gateway HTTP API
```

然后 Worker 这一侧，会主动通过 WebSocket 连接 Gateway。  
连接时带 Worker token。Gateway 校验 token 后，创建 connectionId，并发送 `session_opened`。

接着 Worker 会发 `register`，里面包含：

```text
client_id
client_name
labels
resources
```

Gateway 返回绑定信息，比如：

```text
userId
sessionId
serverKeyId
server public key
```

这一步建立的是 Worker 和 Gateway 之间的身份绑定。

然后 Worker 会整理本地能力。  
这里不是把本地命令粗暴暴露出去，而是先把两类能力包装起来：

第一类是内置工具，比如：

```text
shell
file
browser
desktop tools
```

第二类是 MCP tools，比如：

```text
stdio MCP
HTTP MCP
computer-use
external MCP tools
```

这些能力会进入 `ManagedClientMcpToolRegistry`，通过 `buildBindings()` 包装成统一的 tool binding：

```text
advertisedName → upstreamName
```

然后调用：

```text
getToolDefinitions()
```

生成 Gateway 可识别的工具定义：

```text
name
description
input_schema
```

最后通过 WebSocket 的 `update_tools` 发布给 Gateway。  
这样 Gateway 就知道这个 Worker 当前有哪些能力可以被调用。

再看右边。

当 Agent 要调用一个本地能力时，它通过 HTTP 进入 Gateway：

```text
POST /tool_call
```

请求里可以带：

```text
agent_id
clientName
labels
tool_name
arguments
credential_ref
```

Gateway 收到之后，会做几件事。

第一，记录 Agent Activity。  
第二，根据 `connection_id`、`clientName` 或 labels 找到具体 Worker。  
第三，通过 `sendToolCall` 对请求做签名，必要时发 credential grant。  
第四，通过 Worker 已经建立的 WebSocket，把请求发过去。

Worker 收到 `tool_call` 后，不会直接执行。  
它会先校验：

```text
signature
body hash
nonce
tool binding
approval
credential grant
```

校验通过之后，才会调用：

```text
toolRegistry.callTool()
```

这一步才真正落到本地工具上，比如：

```text
workiq
az
copilot
kubectl
MCP tool
本地 CLI
```

执行结果再通过 WebSocket 回到 Gateway，Gateway 再把它转成 HTTP response 返回给 Agent。

所以完整链路是：

```text
Agent HTTP
→ Gateway
→ WebSocket
→ Worker
→ Local Tool
→ WebSocket result
→ HTTP response
→ Agent
```

这就是为什么第三页标题叫：

> HTTP 进 Gateway，WebSocket 到 Worker，本地工具执行。

---

## 收尾

总结一下，这套 PPT 想表达的是：

LandGod / MCPHub Gateway 不是一个抽象的远控系统，也不是单纯 MCP proxy。

它是从 WorkIQ 这个真实问题里长出来的：

> 云上 Agent 想真正替用户做事，就必须能安全使用用户本地设备里的工具、登录态、文件、CLI 和工作环境。

LandGod 提供的就是这层桥：

```text
Gateway governs.
Worker executes.
Activity proves.
```

最终一句话：

> LandGod 把个人设备变成云上 Agent 的安全本地工具运行时。
