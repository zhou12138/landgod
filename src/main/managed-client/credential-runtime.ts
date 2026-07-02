import { createHash, createPublicKey, verify } from 'node:crypto';
import type { ManagedClientRuntimeConfig } from './types';

export interface CredentialGrant {
  iss: string;
  aud: string;
  grant_id: string;
  task_id: string;
  request_id: string;
  agent_id: string;
  worker_id: string;
  connection_id: string;
  tool_name: string;
  credential_ref: string;
  arguments_hash: string;
  allowed_scopes?: string[];
  requested_scope?: string | null;
  iat: string;
  nbf: string;
  exp: string;
  jti: string;
  single_use: boolean;
  policy_version: number;
  status?: string;
  signature: string;
}

export interface ExchangedCredential {
  credential_type: 'api_token' | 'username_password';
  credential_ref: string;
  secret: Record<string, unknown>;
  scope?: string | null;
  expires_in: number;
}

export interface CredentialGrantValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
}

const CREDENTIAL_FORBIDDEN_TOOLS = new Set([
  'shell_execute',
  'file_read',
  'audit_read',
  'remote_configure_mcp_server',
  'external_http_post',
]);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (!isJsonObject(value)) return value;
  return Object.keys(value).sort((a, b) => a.localeCompare(b)).reduce<Record<string, unknown>>((result, key) => {
    result[key] = sortJsonValue(value[key]);
    return result;
  }, {});
}

function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function normalizeAllowedScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

export function buildGrantSigningPayload(grant: CredentialGrant): Record<string, unknown> {
  return {
    v: 1,
    iss: grant.iss,
    aud: grant.aud,
    grant_id: grant.grant_id,
    task_id: grant.task_id,
    request_id: grant.request_id,
    agent_id: grant.agent_id,
    worker_id: grant.worker_id,
    connection_id: grant.connection_id,
    tool_name: grant.tool_name,
    credential_ref: grant.credential_ref,
    arguments_hash: grant.arguments_hash,
    allowed_scopes: normalizeAllowedScopes(grant.allowed_scopes),
    requested_scope: grant.requested_scope || null,
    iat: grant.iat,
    nbf: grant.nbf,
    exp: grant.exp,
    jti: grant.jti,
    single_use: Boolean(grant.single_use),
    policy_version: Number.isFinite(grant.policy_version) ? grant.policy_version : 1,
  };
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(paddingLength)}`, 'base64');
}

export function hashCredentialArguments(argumentsPayload: Record<string, unknown>): string {
  return toBase64Url(createHash('sha256').update(canonicalizeJson(argumentsPayload), 'utf-8').digest());
}

export function isCredentialForbiddenTool(toolName: string): boolean {
  return CREDENTIAL_FORBIDDEN_TOOLS.has(toolName)
    || toolName.startsWith('session_')
    || toolName.includes('shell')
    || toolName.includes('execute');
}

export function parseCredentialGrant(value: unknown): CredentialGrant | null {
  if (!isJsonObject(value)) return null;
  const required = ['iss', 'aud', 'grant_id', 'task_id', 'request_id', 'agent_id', 'worker_id', 'connection_id', 'tool_name', 'credential_ref', 'arguments_hash', 'iat', 'nbf', 'exp', 'jti', 'signature'];
  for (const key of required) {
    if (typeof value[key] !== 'string' || !String(value[key]).trim()) return null;
  }
  if (typeof value.single_use !== 'boolean') return null;
  if (typeof value.policy_version !== 'number' || !Number.isFinite(value.policy_version)) return null;
  if (value.allowed_scopes !== undefined && !Array.isArray(value.allowed_scopes)) return null;
  return value as unknown as CredentialGrant;
}

export function validateCredentialGrant(params: {
  grant: CredentialGrant;
  toolName: string;
  argumentsPayload: Record<string, unknown>;
  requestId: string;
  clientId: string;
  connectionId: string | null;
  serverPublicKeyPem: string | null;
}): CredentialGrantValidationResult {
  const { grant } = params;
  if (grant.iss !== 'landgod-gateway') return { valid: false, code: 'grant_bad_issuer', message: 'credential grant issuer is invalid' };
  if (grant.aud !== 'credential-exchange') return { valid: false, code: 'grant_bad_audience', message: 'credential grant audience is invalid' };
  if (grant.request_id !== params.requestId) return { valid: false, code: 'grant_request_mismatch', message: 'credential grant request_id mismatch' };
  if (grant.tool_name !== params.toolName) return { valid: false, code: 'grant_tool_mismatch', message: 'credential grant tool_name mismatch' };
  if (grant.worker_id !== params.clientId) return { valid: false, code: 'grant_worker_mismatch', message: 'credential grant worker_id mismatch' };
  if (params.connectionId && grant.connection_id !== params.connectionId) return { valid: false, code: 'grant_connection_mismatch', message: 'credential grant connection_id mismatch' };
  const now = Date.now();
  const nbf = Date.parse(grant.nbf);
  const exp = Date.parse(grant.exp);
  if (!Number.isFinite(nbf) || !Number.isFinite(exp) || nbf > now + 30_000 || exp < now - 30_000) {
    return { valid: false, code: 'grant_stale', message: 'credential grant is not currently valid' };
  }
  const computedArgumentsHash = hashCredentialArguments(params.argumentsPayload);
  if (computedArgumentsHash !== grant.arguments_hash) {
    return { valid: false, code: 'grant_arguments_mismatch', message: 'credential grant arguments_hash mismatch' };
  }
  const requestedScope = typeof grant.requested_scope === 'string' && grant.requested_scope.trim() ? grant.requested_scope.trim() : null;
  const allowedScopes = normalizeAllowedScopes(grant.allowed_scopes);
  if (requestedScope && allowedScopes.length > 0 && !allowedScopes.includes(requestedScope)) {
    return { valid: false, code: 'grant_scope_mismatch', message: 'credential grant requested_scope is not allowed' };
  }
  if (!params.serverPublicKeyPem) return { valid: false, code: 'grant_missing_key', message: 'server public key is unavailable' };
  try {
    const signature = grant.signature;
    const ok = verify(
      null,
      Buffer.from(canonicalizeJson(buildGrantSigningPayload(grant)), 'utf-8'),
      createPublicKey(params.serverPublicKeyPem),
      fromBase64Url(signature),
    );
    if (!ok) return { valid: false, code: 'grant_bad_signature', message: 'credential grant signature is invalid' };
  } catch (error) {
    return { valid: false, code: 'grant_bad_signature', message: error instanceof Error ? error.message : String(error) };
  }
  return { valid: true };
}

function getGatewayHttpBaseUrl(baseUrl: string): string {
  const explicitExchangeUrl = process.env.LANDGOD_CREDENTIAL_EXCHANGE_URL?.trim();
  if (explicitExchangeUrl) {
    const url = new URL(explicitExchangeUrl);
    url.pathname = url.pathname.replace(/\/credential\/exchange\/?$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }
  const explicitHttpUrl = process.env.LANDGOD_GATEWAY_HTTP_URL?.trim();
  if (explicitHttpUrl) {
    const url = new URL(explicitHttpUrl);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }

  const url = new URL(baseUrl);
  const originalProtocol = url.protocol;
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';

  // LandGod's default topology uses adjacent ports: WS 8080 and HTTP 8081.
  // Workers are configured with the WS bootstrap URL, but credential exchange is
  // an HTTP endpoint. If no explicit HTTP base URL exists yet, derive the
  // Gateway HTTP port from the WS port for local/self-hosted deployments.
  if ((originalProtocol === 'ws:' || originalProtocol === 'wss:') && url.port) {
    const port = Number.parseInt(url.port, 10);
    if (Number.isFinite(port) && port > 0 && port < 65535) {
      url.port = String(port + 1);
    }
  }

  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function exchangeCredentialGrant(params: {
  config: ManagedClientRuntimeConfig;
  grant: CredentialGrant;
  toolName: string;
}): Promise<ExchangedCredential> {
  if (!params.config.baseUrl) throw new Error('Gateway baseUrl is required for credential exchange');
  if (!params.config.token) throw new Error('Worker token is required for credential exchange');
  const endpoint = `${getGatewayHttpBaseUrl(params.config.baseUrl)}/credential/exchange`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.config.token}`,
    },
    body: JSON.stringify({
      grant_id: params.grant.grant_id,
      task_id: params.grant.task_id,
      tool_name: params.toolName,
      worker_id: params.config.clientId,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.message === 'string' ? body.message : (typeof body?.error === 'string' ? body.error : `credential exchange failed: ${response.status}`));
  }
  if (!isJsonObject(body) || !isJsonObject(body.secret) || typeof body.credential_ref !== 'string' || typeof body.credential_type !== 'string') {
    throw new Error('credential exchange response was malformed');
  }
  return body as unknown as ExchangedCredential;
}
