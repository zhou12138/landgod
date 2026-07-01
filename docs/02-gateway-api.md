# Gateway API Reference

## 定位

LandGod-Link 是 Agent 的 **Sidecar Gateway**。它可以部署在 Agent 同机器上，也可以部署在任何 Agent 和 Worker 都可访问的机器上，提供两个端口：

| 端口 | 协议 | 服务对象 | 用途 |
|------|------|---------|------|
| **8081** (HTTP) | REST API | **AI Agent** | Agent 通过此端口发送指令、查询设备 |
| **8080** (WebSocket) | WS | **LandGod Worker** | Worker 通过此端口连接 Gateway |

```
AI Agent ──HTTP:8081──► LandGod-Link ◄──WS:8080── LandGod Worker
```

**Agent 只需要知道可访问的 Gateway HTTP 地址（例如 `http://localhost:8081`），Worker 只需要知道 `ws://GATEWAY:8080`。**

> 当前 MVP/POC 阶段，建议调试和测试时将 Gateway 与 Agent 部署在同一台机器上，以简化网络排查。

> 当前 Gateway 暂不对 Agent 的 HTTP API 请求做鉴权；`Authorization: Bearer <token>` 仅用于 Worker 连接 Gateway。

---

## Agent 端接口 (HTTP :8081)

### GET /health

健康检查。

**响应**:
```json
{
  "status": "ok",
  "connectedClients": 2,
  "registeredTokens": 3,
  "wsPort": 8080,
  "httpPort": 8081
}
```

### GET /clients

列出所有在线 Worker。

**响应**:
```json
{
  "clients": [
    {
      "connectionId": "conn-xxx",
      "clientId": "uuid",
      "clientName": "ZhouTest1",
      "sessionId": "session-xxx",
      "connected": true
    }
  ]
}
```

### POST /tool_call

向 Worker 发送工具调用。

**请求**:
```json
{
  "tool_name": "shell_execute",
  "arguments": { "command": "hostname" },
  "connection_id": "conn-xxx",
  "timeout": 10000
}
```

- `tool_name`: 必填。可用工具见 Worker 能力。
- `arguments`: 必填。工具参数。
- `connection_id`: 可选。不填则自动选择第一个在线 Worker。
- `timeout`: 可选。超时毫秒数，默认 30000。

**响应（成功）**:
```json
{
  "type": "event",
  "event": "tool_result_chunk",
  "payload": {
    "request_id": "tool_call-xxx",
    "data": {
      "text": "{\"stdout\":\"ZhouTest1\\n\",\"stderr\":\"\",\"exit_code\":0}"
    },
    "is_final": false
  }
}
```

**响应（失败）**:
```json
{
  "type": "event",
  "event": "tool_error",
  "payload": {
    "request_id": "tool_call-xxx",
    "error": {
      "code": "tool_execution_failed",
      "message": "Executable is outside the allowlist: rm",
      "retryable": false
    }
  }
}
```

### POST /tokens

创建设备专属 Token。

**请求**:
```json
{ "device_name": "my-server" }
```

**响应**:
```json
{
  "token": "tok_abc123...",
  "device_name": "my-server",
  "created_at": "2026-04-15T10:00:00Z"
}
```

### GET /tokens

列出所有 Token。

### DELETE /tokens/:token

吊销 Token。吊销后使用该 Token 的 Worker 会被立即断开。

### GET /tools

列出每个 Worker 注册的工具列表。

```json
{
  "tools": {
    "WorkerA": ["shell_execute", "file_read", "session_create", ...],
    "WorkerB": ["shell_execute", "file_read", "browser_navigate", ...]
  }
}
```

### POST /batch_tool_call

并行批量工具调用。同时向多个 Worker 发送命令，互不阻塞。

**Request body:**
```json
{
  "calls": [
    {"clientName": "WorkerA", "tool_name": "shell_execute", "arguments": {"command": "hostname"}},
    {"clientName": "WorkerB", "tool_name": "shell_execute", "arguments": {"command": "hostname"}}
  ],
  "timeout": 30000
}
```

**Response:**
```json
{
  "results": [
    {"index": 0, "clientName": "WorkerA", "tool_name": "shell_execute", "result": {"stdout": "..."}},
    {"index": 1, "clientName": "WorkerB", "tool_name": "shell_execute", "result": {"stdout": "..."}}
  ]
}
```

### GET /audit

集中查看 Worker 审计日志。

| Parameter | Default | Description |
|-----------|---------|-------------|
| `clientName` | all | Filter by worker name |
| `limit` | 50 | Number of recent audit entries |
| `timeout` | 15000 | Timeout per worker (ms) |

```json
{
  "audit": [
    {"clientName": "WorkerA", "entries": [...], "error": null},
    {"clientName": "WorkerB", "entries": [...], "error": null}
  ]
}
```

### POST /tool_call — Async & Queue Modes

除了同步调用外，支持两种扩展模式：

**异步模式** (`?async=true`)：立即返回 taskId，后台执行。

```bash
POST /tool_call?async=true
{"clientName": "Worker1", "tool_name": "shell_execute", "arguments": {"command": "python train.py"}}
```
```json
{"taskId": "task-xxx", "status": "pending"}
```

**队列模式** (`?queue=true`)：Worker 不在线时入队，上线后自动执行。

```bash
POST /tool_call?queue=true
{"clientName": "OfflineWorker", "tool_name": "shell_execute", "arguments": {"command": "hostname"}}
```
```json
{"taskId": "task-xxx", "status": "queued"}
```

**标签路由**：按 Worker 能力标签匹配，而非硬编码名称。

```bash
POST /tool_call
{"labels": {"gpu": true}, "tool_name": "shell_execute", "arguments": {"command": "nvidia-smi"}}
```

### GET /tasks

列出所有异步/队列任务。

| Parameter | Default | Description |
|-----------|---------|-------------|
| `status` | all | Filter: pending, completed, failed |
| `limit` | 50 | Max results |

### GET /tasks/:id

查看单个任务状态和结果。

```json
{
  "taskId": "task-xxx",
  "status": "completed",
  "result": {"stdout": "..."},
  "createdAt": "2026-04-21T05:00:00Z",
  "completedAt": "2026-04-21T05:01:00Z"
}
```

---

## Worker 端接口 (WebSocket :8080)

Worker 连接 `ws://GATEWAY:8080/api/mcphub/ws`，使用 Bearer Token 认证。

### 连接握手

```
1. Worker → Gateway: WebSocket 连接 + Authorization: Bearer <token>
2. Gateway → Worker: { type: "event", event: "session_opened", payload: { connection_id } }
3. Worker → Gateway: { type: "req", method: "register", params: { client_id, client_name, labels, resources } }
4. Gateway → Worker: { type: "res", ok: true, payload: { user_id, session_id, server_public_key, ... } }
5. Worker → Gateway: { type: "req", method: "update_tools", params: { tools: {...} } }
6. Gateway → Worker: { type: "res", ok: true, payload: { accepted: true } }
```

### 指令执行

```
7. Gateway → Worker: { type: "req", method: "tool_call", params: { tool_name, arguments, meta: { signature, ... } } }
8. Worker → Gateway: { type: "event", event: "tool_result_chunk", payload: { data, is_final } }
```

---

## Node.js 版本

### 安装
```bash
npm install -g landgod-gateway-0.1.1.tgz
```

### CLI
```bash
landgod-gateway start [--daemon] [--port 8081] [--ws-port 8080]
landgod-gateway stop
landgod-gateway status
```

### 配置
环境变量：
- `LANDGOD_HTTP_PORT` — HTTP 端口（默认 8081）
- `LANDGOD_WS_PORT` — WebSocket 端口（默认 8080）
- `LANDGOD_DATA_DIR` — 数据目录（默认 ~/.landgod-gateway）
- `LANDGOD_AUTH_TOKEN` — 默认认证 Token

---

## Python 版本

### 安装
```bash
pip install landgod_gateway-0.1.1-py3-none-any.whl
pip install landgod-gateway[redis]  # 可选 Redis 支持
```

### 使用
```python
from landgod_gateway import LandGod

# 单机模式
link = LandGod('http://localhost:8081', store='memory')

# 分布式模式（多 Agent 共享状态）
link = LandGod('http://localhost:8081', store='redis://localhost:6379')

# 查看设备
clients = link.clients_sync()

# 执行命令
result = link.execute_sync('hostname', target='ZhouTest1')

# 广播
results = link.broadcast_sync('uname -a')

# Token 管理
token = await link.create_token('new-device')
await link.revoke_token('tok_xxx')
```

### 状态存储

| 模式 | 后端 | 适合场景 |
|------|------|---------|
| `memory` | 内存 | 单 Agent 单机 |
| `redis://...` | Redis | 多 Agent 分布式 |

自动记录执行历史和统计到 store 中。
