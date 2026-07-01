# Credential Broker MVP

## Status

MVP implementation started in the Node Gateway and managed-client Worker runtime.

This is intentionally narrow:

- Agent uses `credential_ref`; Agent never receives secret values.
- Gateway validates policy and issues a task-scoped, single-use credential grant.
- Worker validates grant binding/signature and exchanges the grant for a short-lived credential.
- Only tools explicitly declared as credential-capable and trusted may receive credentials.
- Generic shell / file / session / arbitrary execution tools are forbidden for credential grants.

Non-goals for MVP:

- Browser session persistence
- UKey / OTP / QR login automation
- SSH key / certificate private key handling
- Arbitrary MCP credential injection
- `shell_execute` with credentials
- Full WebUI / RBAC / Vault integration

## Node Gateway APIs

### `POST /credentials`

Create a credential. Response never returns secret values.

```json
{
  "id": "cred_demo_readonly",
  "type": "api_token",
  "secret": { "token": "..." },
  "allowedAgents": ["agent-a"],
  "allowedWorkerIds": ["worker-1"],
  "allowedWorkerGroups": [],
  "allowedTools": ["demo.fetch"],
  "deniedTools": ["shell_execute", "external_http_post"]
}
```

Supported MVP types:

- `api_token`
- `username_password`

### `GET /credentials`

List credential metadata only.

### `POST /credentials/:id/revoke`

Revoke a credential and invalidate issued grants that have not been exchanged.

### `GET /credentials/audit?limit=100`

Read Credential Broker audit events.

### `POST /credential/exchange`

Worker-only endpoint. Requires Worker token and a task-scoped grant.

```json
{
  "grant_id": "grant_...",
  "task_id": "task_...",
  "tool_name": "demo.fetch",
  "worker_id": "worker-1"
}
```

## `POST /tool_call` Extension

Agent requests a credential by alias:

```json
{
  "agent_id": "agent-a",
  "clientName": "finance-win-01",
  "tool_name": "demo.fetch",
  "credential_ref": "cred_demo_readonly",
  "arguments": { "id": 1 }
}
```

Gateway behavior:

1. Resolve target Worker.
2. Check credential policy: agent, worker, tool, status, expiry.
3. Issue credential grant.
4. Attach `credential_grant` to Gateway → Worker `tool_call`.

## Worker Runtime

Worker validates:

- grant issuer/audience
- request id
- worker id / connection id
- tool name
- arguments hash
- grant expiration
- Gateway signature

Worker then calls `/credential/exchange`. The exchanged credential is injected into trusted connector arguments as `_landgod_credential`.

This injection is MVP-only and must not be used for generic tools. Future versions should use credential handles or connector-local secure injection.

## Trusted Tool Declaration

MCP manifests/config can opt into credential access:

```json
{
  "credentials": {
    "enabled": true,
    "acceptedTypes": ["api_token", "username_password"],
    "allowedScopes": ["read"]
  }
}
```

Rules:

- Default is disabled.
- `trustLevel` must be `trusted`.
- Untrusted / experimental MCP tools cannot receive credentials.
- Shell/file/session/admin tools are always forbidden.

## Audit Events

MVP emits:

- `credential_created`
- `credential_grant_issued`
- `credential_grant_denied`
- `credential_exchange_allowed`
- `credential_exchange_denied`
- `credential_revoked`

Audit never includes secret values.

## Implementation Files

Gateway:

- `gateway/node-gateway/server/credential-broker.js`
- `gateway/node-gateway/server/index.js`

Worker:

- `src/main/managed-client/credential-runtime.ts`
- `src/main/managed-client/mcp-ws-runtime.ts`
- `src/main/managed-client/mcp-tool-registry.ts`
- `src/main/managed-client/mcp-server-config.ts`
- `src/main/managed-client/types.ts`

Tests:

- `tests/credential-broker.test.cjs`
