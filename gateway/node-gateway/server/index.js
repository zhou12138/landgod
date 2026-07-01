const WebSocket = require('ws');
const uuid = require('uuid');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateKeyPairSync, createHash, sign, randomUUID } = require('node:crypto');
const {
    createCredentialBroker,
    canonicalizeJson: canonicalizeCredentialJson,
    buildGrantSigningPayload,
} = require('./credential-broker');

// ========================
// 配置
// ========================
// Parse --token CLI argument
const tokenArg = process.argv.find(a => a.startsWith('--token='));
const tokenArgValue = tokenArg ? tokenArg.split('=')[1] : (process.argv.indexOf('--token') >= 0 ? process.argv[process.argv.indexOf('--token') + 1] : null);
const AUTH_TOKEN = tokenArgValue || process.env.LANDGOD_AUTH_TOKEN || "";
if (!AUTH_TOKEN) {
    console.error("ERROR: Auth token is required. Use --token=YOUR_TOKEN or set LANDGOD_AUTH_TOKEN environment variable.");
    process.exit(1);
}
const WS_PORT = parseInt(process.env.LANDGOD_WS_PORT || "8080");
const HTTP_PORT = parseInt(process.env.LANDGOD_HTTP_PORT || "8081");
const DATA_DIR = process.env.LANDGOD_DATA_DIR || path.join(require('os').homedir(), '.landgod-gateway');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ========================
// 生成 Ed25519 密钥对
// ========================
const { publicKey: SERVER_PUBLIC_KEY_PEM, privateKey: SERVER_PRIVATE_KEY_PEM } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
console.log("Server Ed25519 key pair generated.");

// ========================
// 工具函数
// ========================
function sortJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map(item => sortJsonValue(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    return Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .reduce((result, key) => {
            result[key] = sortJsonValue(value[key]);
            return result;
        }, {});
}

function canonicalizeJson(value) {
    return JSON.stringify(sortJsonValue(value));
}

function toBase64Url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function computeToolCallBodySha256(toolName, argumentsPayload) {
    return toBase64Url(
        createHash('sha256')
            .update(canonicalizeJson({ tool_name: toolName, arguments: argumentsPayload }), 'utf-8')
            .digest()
    );
}

function buildToolCallSignaturePayload(requestId, meta, toolName, argumentsPayload) {
    return {
        schema_version: meta.schema_version,
        request_id: requestId,
        session_id: meta.session_id,
        connection_id: meta.connection_id,
        user_id: meta.user_id,
        client_id: meta.client_id,
        iat: meta.iat,
        exp: meta.exp,
        nonce: meta.nonce,
        tool_name: toolName,
        arguments: argumentsPayload,
    };
}

function signToolCall(requestId, toolName, argumentsPayload, binding) {
    const now = new Date();
    const exp = new Date(now.getTime() + 60000); // 1 分钟过期
    const nonce = randomUUID();
    const bodySha256 = computeToolCallBodySha256(toolName, argumentsPayload);

    const meta = {
        schema_version: "1.0",
        request_id: requestId,
        user_id: binding.userId,
        client_id: binding.clientId,
        connection_id: binding.connectionId,
        session_id: binding.sessionId,
        key_id: binding.serverKeyId,
        nonce: nonce,
        body_sha256: bodySha256,
        iat: now.toISOString(),
        exp: exp.toISOString(),
    };

    const signaturePayload = buildToolCallSignaturePayload(requestId, meta, toolName, argumentsPayload);
    const signatureBuffer = sign(
        null,
        Buffer.from(canonicalizeJson(signaturePayload), 'utf-8'),
        SERVER_PRIVATE_KEY_PEM
    );
    meta.signature = toBase64Url(signatureBuffer);

    return meta;
}

function signCredentialGrant(grantPayload) {
    const signatureBuffer = sign(
        null,
        Buffer.from(canonicalizeCredentialJson(buildGrantSigningPayload(grantPayload)), 'utf-8'),
        SERVER_PRIVATE_KEY_PEM
    );
    return toBase64Url(signatureBuffer);
}

const credentialBroker = createCredentialBroker({
    dataDir: DATA_DIR,
    signGrant: signCredentialGrant,
});

// ========================
// Token 注册表
// ========================
// tokens.json no longer used (single-token mode)
const tokenRegistry = new Map();

function loadTokens() {
    require('fs').mkdirSync(DATA_DIR, { recursive: true });
    // Single-token mode: only the startup token is valid
    tokenRegistry.clear();
    tokenRegistry.set(AUTH_TOKEN, { device_name: '*', created_at: 'startup', active: true });
    console.log('Auth token registered (single-token mode)');
}

function saveTokens() {
    // Single-token mode: no file persistence
}

function isValidToken(token) {
    if (!token) return false;
    // 兼容旧的硬编码 token
    if (token === AUTH_TOKEN) return true;
    const entry = tokenRegistry.get(token);
    return entry && entry.active;
}

loadTokens();

// ========================
// 连接状态管理
// ========================
const connectedClients = new Map(); // connectionId -> { client, binding }

// Async task store + task queue
const tasks = new Map(); // taskId -> { status, result, error, createdAt, completedAt, request }
const taskQueue = []; // { taskId, clientName, labels, tool_name, arguments, timeout, createdAt }
const TASK_TTL = 3600000; // 1 hour, auto-cleanup

function createTask(request) {
    const taskId = `task-${uuid.v4()}`;
    tasks.set(taskId, {
        taskId,
        status: 'pending',
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        request,
    });
    return taskId;
}

function completeTask(taskId, result) {
    const task = tasks.get(taskId);
    if (task) {
        task.status = 'completed';
        task.result = result;
        task.completedAt = new Date().toISOString();
    }
}

function failTask(taskId, error) {
    const task = tasks.get(taskId);
    if (task) {
        task.status = 'failed';
        task.error = error;
        task.completedAt = new Date().toISOString();
    }
}

// ========================
// Gateway central audit (remote backup)
// ========================
const GATEWAY_AUDIT_PATH = path.join(DATA_DIR, 'gateway-audit.jsonl');
const GATEWAY_AUDIT_SECRET_KEYS = new Set([
    'secret', 'password', 'passwd', 'token', 'api_key', 'apikey', 'authorization',
    '_landgod_credential', 'credential_grant', 'signature',
]);

function redactGatewayAuditValue(value) {
    if (Array.isArray(value)) return value.map((item) => redactGatewayAuditValue(item));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (GATEWAY_AUDIT_SECRET_KEYS.has(key.toLowerCase())) {
            if (key === 'credential_grant' && entry && typeof entry === 'object') {
                result[key] = {
                    grant_id: entry.grant_id,
                    credential_ref: entry.credential_ref,
                    tool_name: entry.tool_name,
                    worker_id: entry.worker_id,
                    connection_id: entry.connection_id,
                    task_id: entry.task_id,
                    request_id: entry.request_id,
                    exp: entry.exp,
                };
            } else {
                result[key] = '***REDACTED***';
            }
            continue;
        }
        result[key] = redactGatewayAuditValue(entry);
    }
    return result;
}

function summarizeGatewayToolMessage(message) {
    if (!message || typeof message !== 'object') return message;
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    const text = payload.data && typeof payload.data === 'object' && typeof payload.data.text === 'string'
        ? payload.data.text
        : undefined;
    return {
        type: message.type,
        event: message.event,
        request_id: payload.request_id,
        is_final: payload.is_final,
        error: payload.error ? redactGatewayAuditValue(payload.error) : undefined,
        dataTextBytes: typeof text === 'string' ? Buffer.byteLength(text, 'utf-8') : undefined,
    };
}

function appendGatewayAudit(event, payload = {}) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const entry = {
            ...redactGatewayAuditValue(payload),
            event,
            eventId: `gw-audit-${randomUUID()}`,
            timestamp: new Date().toISOString(),
        };
        fs.appendFileSync(GATEWAY_AUDIT_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        return entry;
    } catch (error) {
        console.error('[gateway-audit] append failed:', error.message);
        return null;
    }
}

function readGatewayAudit(limit = 200) {
    if (!fs.existsSync(GATEWAY_AUDIT_PATH)) return [];
    const lines = fs.readFileSync(GATEWAY_AUDIT_PATH, 'utf-8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => {
        try { return JSON.parse(line); } catch { return { event: 'parse_error', raw: line }; }
    });
}

// Drain queued tasks for a newly-registered worker
async function drainQueue(connectionId, clientName, workerLabels) {
    const toRemove = [];
    for (let i = 0; i < taskQueue.length; i++) {
        const queued = taskQueue[i];
        let match = false;
        if (queued.clientName && queued.clientName === clientName) {
            match = true;
        } else if (queued.labels && typeof queued.labels === 'object') {
            match = Object.entries(queued.labels).every(([k, v]) => (workerLabels || {})[k] === v);
        }
        if (match) {
            toRemove.push(i);
            // Execute in background
            (async () => {
                try {
                    const result = await sendToolCall(connectionId, queued.tool_name, queued.arguments || {}, queued.timeout || 30000, {
                        credentialRef: queued.credential_ref || null,
                        agentId: queued.agent_id || 'default-agent',
                        taskId: queued.taskId,
                    });
                    completeTask(queued.taskId, result);
                    console.log(`[queue] Drained task ${queued.taskId} → ${clientName}`);
                } catch (err) {
                    failTask(queued.taskId, err.message);
                    console.error(`[queue] Task ${queued.taskId} failed: ${err.message}`);
                }
            })();
        }
    }
    // Remove processed items (reverse order)
    for (let i = toRemove.length - 1; i >= 0; i--) {
        taskQueue.splice(toRemove[i], 1);
    }
}

// Periodic cleanup of old tasks (every 10 min)
setInterval(() => {
    const now = Date.now();
    for (const [taskId, task] of tasks) {
        if (now - new Date(task.createdAt).getTime() > TASK_TTL) {
            tasks.delete(taskId);
        }
    }
}, 600000);

// ========================
// WebSocket 服务
// ========================
const server = new WebSocket.Server({ port: WS_PORT });
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`ERROR: Port ${WS_PORT} is already in use. Kill the old process first.`);
        process.exit(1);
    }
    console.error('WebSocket server error:', err.message);
});
console.log(`WebSocket server running at ws://0.0.0.0:${WS_PORT}`);

server.on("connection", (client, req) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!isValidToken(token)) {
        console.log("Client connection rejected due to invalid token.");
        client.close(4001, "Invalid token");
        return;
    }

    const tokenInfo = tokenRegistry.get(token) || { device_name: "legacy" };
    console.log(`Client connected with valid token! (${token.substring(0, 12)}... device: ${tokenInfo.device_name})`);

    const connectionId = `conn-${uuid.v4()}`;
    appendGatewayAudit('worker_connection_opened', {
        connectionId,
        workerTokenId: tokenInfo.id || tokenInfo.device_name || 'legacy',
        deviceName: tokenInfo.device_name || 'legacy',
        remoteAddress: req.socket?.remoteAddress,
    });

    // 发送 session_opened 事件
    client.send(JSON.stringify({
        type: "event",
        event: "session_opened",
        payload: { connection_id: connectionId }
    }));

    // 心跳
    const interval = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
        }
    }, 30000);

    // 存储待处理的 tool_call 响应回调
    const pendingRequests = new Map();

    client.on("message", (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log("DEBUG: Parsed message:", JSON.stringify(message, null, 2).substring(0, 500));
            const taskId = message.id;

            if (message.method === "ping") {
                client.send(JSON.stringify({
                    type: "res", id: taskId, ok: true,
                    payload: { message: "Pong!" }
                }));

            } else if (message.method === "register") {
                const sessionId = `session-${uuid.v4()}`;
                const serverKeyId = `key-${uuid.v4()}`;
                const userId = `user-${uuid.v4()}`;

                const binding = {
                    userId,
                    clientId: message.params.client_id,
                    clientName: message.params.client_name,
                    labels: message.params.labels || {},
                    resources: message.params.resources || {},
                    connectionId,
                    sessionId,
                    serverKeyId,
                };

                // 清理同名旧连接（防止重连后残留）
                for (const [oldConnId, oldInfo] of connectedClients) {
                    if (oldInfo.binding && oldInfo.binding.clientName === message.params.client_name && oldConnId !== connectionId) {
                        console.log(`[register] Removing stale connection for ${message.params.client_name}: ${oldConnId}`);
                        if (oldInfo.client.readyState === WebSocket.OPEN) {
                            oldInfo.client.close(1000, 'Replaced by new connection');
                        }
                        connectedClients.delete(oldConnId);
                    }
                }

                // 保存连接信息
                connectedClients.set(connectionId, { client, binding, pendingRequests, token });

                const response = {
                    type: "res", id: taskId, ok: true,
                    payload: {
                        user_id: userId,
                        client_id: message.params.client_id,
                        connection_id: connectionId,
                        session_id: sessionId,
                        server_key_id: serverKeyId,
                        server_public_key: SERVER_PUBLIC_KEY_PEM,
                        server_time: new Date().toISOString()
                    }
                };
                client.send(JSON.stringify(response));
                appendGatewayAudit('worker_registered', {
                    connectionId,
                    clientId: binding.clientId,
                    clientName: binding.clientName,
                    sessionId,
                    labels: binding.labels,
                    resources: binding.resources,
                });
                console.log(`[register] Client registered: ${message.params.client_name}. session_id: ${sessionId}, connectionId: ${connectionId}`);

                // Drain queued tasks for this worker
                drainQueue(connectionId, message.params.client_name, message.params.labels || {});

            } else if (message.method === "update_tools") {
                client.send(JSON.stringify({
                    type: "res", id: taskId, ok: true,
                    payload: { accepted: true }
                }));
                const tools = message.params?.tools ? Object.keys(message.params.tools) : [];
                // Store tools in connection info
                const ci = connectedClients.get(connectionId);
                if (ci) ci.tools = message.params?.tools || {};
                appendGatewayAudit('worker_tools_updated', {
                    connectionId,
                    clientId: ci?.binding?.clientId,
                    clientName: ci?.binding?.clientName,
                    toolCount: tools.length,
                    tools,
                });
                console.log(`[update_tools] Tools updated: ${tools.join(', ')}`);

            } else if (message.method === "resource_heartbeat") {
                // Update stored resources
                const ci2 = connectedClients.get(connectionId);
                if (ci2 && ci2.binding) {
                    ci2.binding.resources = message.params?.resources || {};
                }
                client.send(JSON.stringify({
                    type: "res", id: taskId, ok: true,
                    payload: { accepted: true }
                }));

            } else if (message.type === "res") {
                // 处理来自客户端的 tool_call 响应
                const clientInfo = connectedClients.get(connectionId);
                if (clientInfo && clientInfo.pendingRequests.has(message.id)) {
                    const pending = clientInfo.pendingRequests.get(message.id);
                    clientInfo.pendingRequests.delete(message.id);
                    const callback = typeof pending === 'function' ? pending : pending.callback;
                    appendGatewayAudit('tool_call_response_received', {
                        ...(typeof pending === 'object' ? pending.auditContext : {}),
                        requestId: message.id,
                        response: summarizeGatewayToolMessage(message),
                    });
                    callback(message);
                }

            } else if (message.type === "event") {
                // 处理客户端事件（tool_result / tool_error）
                const clientInfo = connectedClients.get(connectionId);
                const reqId = message.payload?.request_id;
                if (clientInfo && reqId && clientInfo.pendingRequests.has(reqId)) {
                    const pending = clientInfo.pendingRequests.get(reqId);
                    clientInfo.pendingRequests.delete(reqId);
                    const callback = typeof pending === 'function' ? pending : pending.callback;
                    appendGatewayAudit(message.event === 'tool_error' ? 'tool_call_error_received' : 'tool_call_result_received', {
                        ...(typeof pending === 'object' ? pending.auditContext : {}),
                        requestId: reqId,
                        responseEvent: message.event,
                        response: summarizeGatewayToolMessage(message),
                    });
                    callback(message);
                } else {
                    console.log(`[event] ${message.event}:`, JSON.stringify(message.payload || {}).substring(0, 300));
                }

            } else {
                console.error(`Unknown method: ${message.method}`);
                client.send(JSON.stringify({
                    type: "res", id: taskId, ok: false,
                    payload: { error: `Unknown method: ${message.method}` }
                }));
            }
        } catch (err) {
            console.error("Failed to process client message:", err.message);
        }
    });

    client.on("ping", () => {
        if (client.readyState === WebSocket.OPEN) client.pong();
    });

    client.on("close", (code, reason) => {
        clearInterval(interval);
        const clientInfo = connectedClients.get(connectionId);
        appendGatewayAudit('worker_connection_closed', {
            connectionId,
            clientId: clientInfo?.binding?.clientId,
            clientName: clientInfo?.binding?.clientName,
            code,
            reason: reason ? reason.toString() : '',
        });
        connectedClients.delete(connectionId);
        console.log(`Client disconnected: ${connectionId}, Code: ${code}`);
    });
});

// ========================
// 发送 tool_call 到客户端
// ========================
function sendToolCall(connectionId, toolName, args, timeout = 30000, options = {}) {
    return new Promise((resolve, reject) => {
        const clientInfo = connectedClients.get(connectionId);
        if (!clientInfo) {
            return reject(new Error(`No connected client with connectionId: ${connectionId}`));
        }

        const { client, binding, pendingRequests } = clientInfo;
        if (client.readyState !== WebSocket.OPEN) {
            return reject(new Error(`Client ${connectionId} is not in OPEN state`));
        }

        const requestId = `tool_call-${randomUUID()}`;
        const taskId = options.taskId || `task-${randomUUID()}`;
        const meta = signToolCall(requestId, toolName, args, binding);
        let credentialGrant = null;
        if (options.credentialRef) {
            credentialGrant = credentialBroker.issueGrant({
                credentialRef: options.credentialRef,
                agentId: options.agentId || 'default-agent',
                binding,
                toolName,
                argumentsPayload: args || {},
                taskId,
                requestId,
            });
        }

        const params = {
            tool_name: toolName,
            arguments: args,
            meta: meta,
        };
        if (credentialGrant) {
            params.credential_grant = credentialGrant;
        }

        const message = {
            type: "req",
            id: requestId,
            method: "tool_call",
            params,
        };

        const auditContext = {
            requestId,
            taskId,
            agentId: options.agentId || 'default-agent',
            connectionId,
            clientId: binding.clientId,
            clientName: binding.clientName,
            sessionId: binding.sessionId,
            workerLabels: binding.labels || {},
            toolName,
            arguments: args || {},
            timeout,
            credentialRef: options.credentialRef || null,
            credentialGrant: credentialGrant ? {
                grant_id: credentialGrant.grant_id,
                credential_ref: credentialGrant.credential_ref,
                task_id: credentialGrant.task_id,
                request_id: credentialGrant.request_id,
                worker_id: credentialGrant.worker_id,
                connection_id: credentialGrant.connection_id,
                tool_name: credentialGrant.tool_name,
                exp: credentialGrant.exp,
            } : null,
        };
        appendGatewayAudit('tool_call_dispatched', auditContext);

        const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            appendGatewayAudit('tool_call_timeout', auditContext);
            reject(new Error(`tool_call ${toolName} timed out after ${timeout}ms`));
        }, timeout);

        pendingRequests.set(requestId, {
            auditContext,
            callback: (response) => {
                clearTimeout(timer);
                resolve(response);
            },
        });

        client.send(JSON.stringify(message));
        console.log(`[tool_call] Sent ${toolName} to ${connectionId}, requestId: ${requestId}${credentialGrant ? `, credentialGrant: ${credentialGrant.grant_id}` : ''}`);
    });
}

function extractToolResultText(result) {
    if (!result || typeof result !== 'object') {
        return '';
    }

    const text = result?.payload?.data?.text;
    if (typeof text === 'string') {
        return text;
    }

    if (typeof result.stdout === 'string') return result.stdout;
    if (typeof result.output === 'string') return result.output;
    return '';
}

function extractAuditEntries(result) {
    const text = extractToolResultText(result);
    if (!text) {
        return [];
    }

    try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.entries)) {
            return parsed.entries.filter((entry) => entry && typeof entry === 'object');
        }
    } catch {}

    return [];
}

function getTokenFingerprint(token) {
    if (!token) return null;
    return createHash('sha256').update(String(token), 'utf-8').digest('hex');
}

function findActiveWorkerBindingByToken(token) {
    if (!token) return null;
    const matches = [];
    for (const [connectionId, info] of connectedClients) {
        if (info.token !== token || !info.binding) continue;
        if (info.client.readyState !== WebSocket.OPEN) continue;
        matches.push({
            connectionId,
            binding: info.binding,
        });
    }
    if (matches.length !== 1) {
        return { ambiguous: true, matches };
    }
    return { ambiguous: false, ...matches[0] };
}

// ========================
// Gateway WebUI static assets
// ========================
const STATIC_CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ico': 'image/x-icon',
};

function serveStaticAsset(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(urlObj.pathname);
    if (pathname === '/') pathname = '/index.html';
    if (!pathname.startsWith('/ui/') && pathname !== '/index.html') return false;

    const relativePath = pathname === '/index.html' ? 'index.html' : pathname.slice('/ui/'.length);
    const resolved = path.resolve(PUBLIC_DIR, relativePath);
    if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        if (req.method !== 'HEAD') res.end(JSON.stringify({ error: 'Forbidden' }));
        return true;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return false;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
        'Content-Type': STATIC_CONTENT_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    fs.createReadStream(resolved).pipe(res);
    return true;
}

// ========================
// HTTP API (供主 Agent 调用)
// ========================
const httpServer = http.createServer(async (req, res) => {
    if (serveStaticAsset(req, res)) return;
    res.setHeader('Content-Type', 'application/json');

    // GET /clients - 列出所有已连接的客户端（自动清理死连接）
    if (req.method === 'GET' && req.url === '/clients') {
        const clients = [];
        const toDelete = [];
        for (const [connId, info] of connectedClients) {
            if (info.client.readyState !== WebSocket.OPEN) {
                toDelete.push(connId);
                continue;
            }
            clients.push({
                connectionId: connId,
                clientId: info.binding.clientId,
                clientName: info.binding.clientName,
                labels: info.binding.labels || {},
                resources: info.binding.resources || {},
                sessionId: info.binding.sessionId,
                connected: true,
            });
        }
        for (const connId of toDelete) {
            connectedClients.delete(connId);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ clients }));
        return;
    }

    // Credential Center MVP — metadata/admin APIs never return secret values.
    if (req.method === 'GET' && req.url.startsWith('/credentials/audit')) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const limit = parseInt(urlObj.searchParams.get('limit') || '100', 10);
        res.writeHead(200);
        res.end(JSON.stringify({ entries: credentialBroker.readAudit(limit) }));
        return;
    }

    if (req.method === 'GET' && req.url === '/credentials') {
        res.writeHead(200);
        res.end(JSON.stringify({ credentials: credentialBroker.listCredentials() }));
        return;
    }

    if (req.method === 'POST' && req.url === '/credentials') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const credential = credentialBroker.createCredential(parsed, 'http-admin');
                res.writeHead(201);
                res.end(JSON.stringify({ credential }));
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url.startsWith('/credentials/') && req.url.endsWith('/revoke')) {
        const credentialId = decodeURIComponent(req.url.split('/credentials/')[1].split('/revoke')[0]);
        try {
            const credential = credentialBroker.revokeCredential(credentialId, 'http-admin');
            res.writeHead(200);
            res.end(JSON.stringify({ credential }));
        } catch (err) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // POST /credential/exchange - Worker-only exchange from task-scoped grant to short-lived credential.
    if (req.method === 'POST' && req.url === '/credential/exchange') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const authHeader = req.headers['authorization'];
                const token = authHeader && String(authHeader).split(' ')[1];
                if (!isValidToken(token)) {
                    res.writeHead(401);
                    res.end(JSON.stringify({ error: 'invalid_worker_token' }));
                    return;
                }
                const parsed = JSON.parse(body || '{}');
                const grantId = parsed.grant_id;
                if (!grantId || typeof grantId !== 'string') {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'missing_grant_id' }));
                    return;
                }
                const grant = credentialBroker.peekGrant ? credentialBroker.peekGrant(grantId) : null;
                const boundWorker = findActiveWorkerBindingByToken(token);
                if (!boundWorker) {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'worker_token_not_bound_to_active_worker' }));
                    return;
                }
                if (boundWorker.ambiguous) {
                    res.writeHead(409);
                    res.end(JSON.stringify({ error: 'worker_token_binding_ambiguous' }));
                    return;
                }
                if (grant && grant.worker_id && grant.worker_id !== boundWorker.binding.clientId) {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'worker_token_not_bound_to_grant' }));
                    return;
                }
                if (grant && grant.connection_id && grant.connection_id !== boundWorker.connectionId) {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'worker_connection_not_bound_to_grant' }));
                    return;
                }
                const exchanged = credentialBroker.exchangeGrant({
                    grant_id: grantId,
                    task_id: parsed.task_id,
                    tool_name: parsed.tool_name,
                    workerId: boundWorker.binding.clientId,
                    workerConnectionId: boundWorker.connectionId,
                    workerTokenId: getTokenFingerprint(token),
                });
                res.writeHead(200);
                res.end(JSON.stringify(exchanged));
            } catch (err) {
                res.writeHead(403);
                res.end(JSON.stringify({ error: err.code || 'credential_exchange_denied', message: err.message }));
            }
        });
        return;
    }

    // POST /tool_call - 向客户端发送工具调用
    if (req.method === 'POST' && req.url.startsWith('/tool_call')) {
        const toolCallUrl = new URL(req.url, `http://${req.headers.host}`);
        const isAsync = toolCallUrl.searchParams.get('async') === 'true';
        const isQueue = toolCallUrl.searchParams.get('queue') === 'true';
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body);
                const { connection_id, tool_name, arguments: args, timeout, labels } = parsed;
                const credentialRef = typeof parsed.credential_ref === 'string' ? parsed.credential_ref : (typeof parsed.credentialRef === 'string' ? parsed.credentialRef : null);
                const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id : (typeof parsed.agentId === 'string' ? parsed.agentId : 'default-agent');
                const clientName = parsed.clientName || parsed.client_name || (parsed.target && parsed.target.clientName);

                if (!tool_name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing tool_name" }));
                    return;
                }

                let targetConnId = connection_id;
                if (!targetConnId && clientName) {
                    for (const [connId, info] of connectedClients) {
                        if (info.binding && info.binding.clientName === clientName && info.client.readyState === WebSocket.OPEN) {
                            targetConnId = connId;
                            break;
                        }
                    }
                    if (!targetConnId) {
                        if (isQueue) {
                            const taskId = createTask({ clientName, labels, tool_name, arguments: args, timeout, credential_ref: credentialRef, agent_id: agentId });
                            taskQueue.push({ taskId, clientName, labels, tool_name, arguments: args, timeout: timeout || 30000, credential_ref: credentialRef, agent_id: agentId, createdAt: new Date().toISOString() });
                            console.log(`[queue] Task ${taskId} queued for ${clientName}`);
                            res.writeHead(202);
                            res.end(JSON.stringify({ taskId, status: 'queued' }));
                            return;
                        }
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: "No connected client named: " + clientName }));
                        return;
                    }
                }
                // Label-based routing: find a worker matching all requested labels
                if (!targetConnId && labels && typeof labels === 'object') {
                    for (const [connId, info] of connectedClients) {
                        if (info.client.readyState !== WebSocket.OPEN || !info.binding) continue;
                        const workerLabels = info.binding.labels || {};
                        const match = Object.entries(labels).every(([k, v]) => workerLabels[k] === v);
                        if (match) {
                            targetConnId = connId;
                            break;
                        }
                    }
                    if (!targetConnId) {
                        if (isQueue) {
                            const taskId = createTask({ clientName, labels, tool_name, arguments: args, timeout, credential_ref: credentialRef, agent_id: agentId });
                            taskQueue.push({ taskId, clientName, labels, tool_name, arguments: args, timeout: timeout || 30000, credential_ref: credentialRef, agent_id: agentId, createdAt: new Date().toISOString() });
                            console.log(`[queue] Task ${taskId} queued for labels ${JSON.stringify(labels)}`);
                            res.writeHead(202);
                            res.end(JSON.stringify({ taskId, status: 'queued' }));
                            return;
                        }
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: "No connected client matching labels: " + JSON.stringify(labels) }));
                        return;
                    }
                }
                if (!targetConnId) {
                    let firstEntry = null;
                    for (const [connId, info] of connectedClients) {
                        if (info.client.readyState === WebSocket.OPEN) {
                            firstEntry = [connId, info];
                            break;
                        }
                    }
                    if (!firstEntry) {
                        // Queue mode: store task for later execution
                        if (isQueue) {
                            const taskId = createTask({ clientName, labels, tool_name, arguments: args, timeout, credential_ref: credentialRef, agent_id: agentId });
                            taskQueue.push({ taskId, clientName, labels, tool_name, arguments: args, timeout: timeout || 30000, credential_ref: credentialRef, agent_id: agentId, createdAt: new Date().toISOString() });
                            console.log(`[queue] Task ${taskId} queued (no clients online)`);
                            res.writeHead(202);
                            res.end(JSON.stringify({ taskId, status: 'queued' }));
                            return;
                        }
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: "No connected clients" }));
                        return;
                    }
                    targetConnId = firstEntry[0];
                }

                // Async mode: return task_id immediately, execute in background
                if (isAsync) {
                    const taskId = createTask({ clientName, labels, tool_name, arguments: args, timeout, credential_ref: credentialRef, agent_id: agentId });
                    res.writeHead(202);
                    res.end(JSON.stringify({ taskId, status: 'pending' }));
                    // Execute in background
                    sendToolCall(targetConnId, tool_name, args || {}, timeout || 30000, { credentialRef, agentId, taskId })
                        .then(result => completeTask(taskId, result))
                        .catch(err => failTask(taskId, err.message));
                    return;
                }

                const result = await sendToolCall(targetConnId, tool_name, args || {}, timeout || 30000, { credentialRef, agentId });
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error(`[HTTP] tool_call error: ${err.message}`);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // POST /batch_tool_call - 并行批量工具调用
    if (req.method === 'POST' && req.url === '/batch_tool_call') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body);
                const { calls, timeout: globalTimeout } = parsed;

                if (!Array.isArray(calls) || calls.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing or empty 'calls' array" }));
                    return;
                }

                // Resolve targets and execute in parallel
                const promises = calls.map(async (call, index) => {
                    try {
                        const { tool_name, arguments: args, timeout } = call;
                        const credentialRef = typeof call.credential_ref === 'string' ? call.credential_ref : (typeof call.credentialRef === 'string' ? call.credentialRef : null);
                        const agentId = typeof call.agent_id === 'string' ? call.agent_id : (typeof call.agentId === 'string' ? call.agentId : 'default-agent');
                        const clientName = call.clientName || call.client_name;
                        let targetConnId = call.connection_id;

                        if (!tool_name) {
                            return { index, clientName, error: "Missing tool_name" };
                        }

                        if (!targetConnId && clientName) {
                            for (const [connId, info] of connectedClients) {
                                if (info.binding && info.binding.clientName === clientName && info.client.readyState === WebSocket.OPEN) {
                                    targetConnId = connId;
                                    break;
                                }
                            }
                            if (!targetConnId) {
                                return { index, clientName, error: "No connected client named: " + clientName };
                            }
                        }

                        if (!targetConnId) {
                            // Label-based routing in batch
                            const batchLabels = call.labels;
                            if (batchLabels && typeof batchLabels === 'object') {
                                for (const [connId, info] of connectedClients) {
                                    if (info.client.readyState !== WebSocket.OPEN || !info.binding) continue;
                                    const wl = info.binding.labels || {};
                                    if (Object.entries(batchLabels).every(([k, v]) => wl[k] === v)) {
                                        targetConnId = connId;
                                        break;
                                    }
                                }
                            }
                        }

                        if (!targetConnId) {
                            return { index, clientName, error: "No target specified (provide clientName, labels, or connection_id)" };
                        }

                        const taskId = typeof call.task_id === 'string' ? call.task_id : (typeof call.taskId === 'string' ? call.taskId : undefined);
                        const result = await sendToolCall(targetConnId, tool_name, args || {}, timeout || globalTimeout || 30000, { credentialRef, agentId, taskId });
                        return { index, clientName, tool_name, credential_ref: credentialRef, result };
                    } catch (err) {
                        return { index, clientName: call.clientName || call.client_name, error: err.message };
                    }
                });

                const results = await Promise.all(promises);
                res.writeHead(200);
                res.end(JSON.stringify({ results }));
            } catch (err) {
                console.error(`[HTTP] batch_tool_call error: ${err.message}`);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // GET /gateway/audit - Gateway 中央审计日志（远程备份）
    if (req.method === 'GET' && req.url.startsWith('/gateway/audit')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
        res.end(JSON.stringify({ entries: readGatewayAudit(limit) }));
        return;
    }

    // GET /audit - 获取所有 Worker 的审计日志（集中查看）
    if (req.method === 'GET' && req.url.startsWith('/audit')) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const clientName = urlObj.searchParams.get('clientName');
        const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
        const timeout = parseInt(urlObj.searchParams.get('timeout') || '15000', 10);

        // Collect audit logs from targeted or all workers
        const targets = [];
        for (const [connId, info] of connectedClients) {
            if (info.client.readyState !== WebSocket.OPEN) continue;
            if (clientName && (!info.binding || info.binding.clientName !== clientName)) continue;
            targets.push({ connId, clientName: info.binding?.clientName || connId });
        }

        if (targets.length === 0) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: clientName ? "No connected client named: " + clientName : "No connected clients" }));
            return;
        }

        const auditPromises = targets.map(async (t) => {
            try {
                const result = await sendToolCall(t.connId, 'audit_read', { limit }, timeout);
                const entries = extractAuditEntries(result);
                return { clientName: t.clientName, entries, error: null };
            } catch (err) {
                return { clientName: t.clientName, entries: [], error: err.message };
            }
        });

        const auditResults = await Promise.all(auditPromises);
        res.writeHead(200);
        res.end(JSON.stringify({ audit: auditResults }));
        return;
    }

    // GET /tools - 列出所有已注册的工具
    if (req.method === 'GET' && req.url === '/tools') {
        const result = [];
        for (const [connId, info] of connectedClients) {
            if (info.client.readyState === WebSocket.OPEN && info.binding) {
                const toolNames = info.tools ? Object.keys(info.tools) : [];
                result.push({
                    clientName: info.binding.clientName,
                    connectionId: connId,
                    toolCount: toolNames.length,
                    tools: toolNames,
                });
            }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ tools: result }));
        return;
    }

    // GET /tasks/:id - 查看单个任务状态
    if (req.method === 'GET' && req.url.startsWith('/tasks/')) {
        const taskId = req.url.split('/tasks/')[1].split('?')[0];
        const task = tasks.get(taskId);
        if (!task) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Task not found: " + taskId }));
            return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(task));
        return;
    }

    // GET /tasks - 列出所有任务
    if (req.method === 'GET' && req.url.startsWith('/tasks')) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const status = urlObj.searchParams.get('status');
        const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
        let result = Array.from(tasks.values());
        if (status) {
            result = result.filter(t => t.status === status);
        }
        result = result.slice(-limit);
        const queueInfo = taskQueue.map(q => ({
            taskId: q.taskId,
            clientName: q.clientName,
            labels: q.labels,
            tool_name: q.tool_name,
            createdAt: q.createdAt,
        }));
        res.writeHead(200);
        res.end(JSON.stringify({ tasks: result, queued: queueInfo }));
        return;
    }

    // GET /health - 健康检查
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'ok',
            connectedClients: connectedClients.size,
            registeredTokens: tokenRegistry.size,
            wsPort: WS_PORT,
            httpPort: HTTP_PORT,
        }));
        return;
    }

    // POST /tokens - 创建新设备 Token
    if (req.method === 'POST' && req.url === '/tokens') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { device_name } = JSON.parse(body);
                if (!device_name) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing device_name" }));
                    return;
                }
                const token = `tok_${randomUUID().replace(/-/g, '')}`;
                tokenRegistry.set(token, {
                    device_name,
                    created_at: new Date().toISOString(),
                    active: true
                });
                saveTokens();
                console.log(`[token] Created token for ${device_name}: ${token.substring(0, 12)}...`);
                res.writeHead(201);
                res.end(JSON.stringify({ token, device_name, created_at: tokenRegistry.get(token).created_at }));
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // GET /tokens - 列出所有 Token
    if (req.method === 'GET' && req.url === '/tokens') {
        const tokens = [];
        for (const [token, info] of tokenRegistry) {
            tokens.push({
                token: token.substring(0, 12) + '...',
                token_full: token,
                device_name: info.device_name,
                created_at: info.created_at,
                active: info.active,
            });
        }
        res.writeHead(200);
        res.end(JSON.stringify({ tokens }));
        return;
    }

    // DELETE /tokens/:token - 吊销 Token
    if (req.method === 'DELETE' && req.url.startsWith('/tokens/')) {
        const token = req.url.replace('/tokens/', '');
        if (tokenRegistry.has(token)) {
            tokenRegistry.get(token).active = false;
            saveTokens();
            // 断开使用该 token 的连接
            for (const [connId, info] of connectedClients) {
                if (info.token === token) {
                    info.client.close(4002, 'Token revoked');
                    connectedClients.delete(connId);
                    console.log(`[token] Revoked and disconnected: ${connId}`);
                }
            }
            res.writeHead(200);
            res.end(JSON.stringify({ revoked: true, token: token.substring(0, 12) + '...' }));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Token not found" }));
        }
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP API server running at http://0.0.0.0:${HTTP_PORT}`);
    console.log('');
    console.log('=== API Endpoints ===');
    console.log('GET  /tools      - 列出已注册的工具');
    console.log('GET  /health      - 健康检查');
    console.log('GET  /clients     - 列出已连接的客户端');
    console.log('POST /tool_call   - 发送工具调用 (?async=true|?queue=true)');
    console.log('POST /batch_tool_call - 并行批量工具调用');
    console.log('GET  /tasks       - 列出异步任务');
    console.log('GET  /tasks/:id   - 查看任务状态');
    console.log('GET  /gateway/audit - Gateway 中央审计日志');
    console.log('GET  /audit       - 集中查看 Worker 审计日志');
    console.log('  Body: { "tool_name": "shell_execute", "arguments": { "command": "ls" } }');
    console.log('');
});
