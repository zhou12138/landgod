import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import * as readline from 'node:readline';
import tls from 'node:tls';
import type { ClientOptions as WebSocketClientOptions } from 'ws';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SessionManager } from '../session/manager';
import { auditLogger } from '../audit/logger';
import { emitServerEvent } from '../server';
import { createMcpServer } from '../mcp/server';
import type { ManagedClientRuntimeConfig } from './types';
import { getBuiltInToolsSecurityConfig, getToolCallApprovalMode } from './config';
import { ManagedClientMcpToolRegistry } from './mcp-tool-registry';
import { createManagedClientDefenseLayer } from './tool-defense';
import { prepareManagedClientWorkspace } from './workspace';
import { getManagedClientToolResultMode } from '../builtin-tools/types';
import {
  exchangeCredentialGrant,
  isCredentialForbiddenTool,
  parseCredentialGrant,
  validateCredentialGrant,
  type ExchangedCredential,
} from './credential-runtime';

type DesktopWsMessage = Record<string, unknown>;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const TOOL_CALL_CLOCK_SKEW_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function canPromptForApprovalInTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptForToolCallApproval(params: {
  requestId: string;
  toolName: string;
  sourceName: string;
  argumentsPayload: unknown;
}): Promise<'approve-once' | 'approve-all' | 'reject'> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const argsPreview = stringifyForAudit(params.argumentsPayload).slice(0, 1200);
  try {
    process.stdout.write('\n[tool-approval] Tool call approval required\n');
    process.stdout.write(`  requestId: ${params.requestId}\n`);
    process.stdout.write(`  tool: ${params.toolName}\n`);
    process.stdout.write(`  source: ${params.sourceName}\n`);
    if (argsPreview) {
      process.stdout.write(`  arguments: ${argsPreview}\n`);
    }

    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question('Approve? [y] once / [a] all this session / [n] reject: ', resolve);
      });
      const normalized = answer.trim().toLowerCase();
      if (['y', 'yes', 'once', 'approve'].includes(normalized)) {
        return 'approve-once';
      }
      if (['a', 'all', 'approve-all'].includes(normalized)) {
        return 'approve-all';
      }
      if (['n', 'no', 'r', 'reject'].includes(normalized)) {
        return 'reject';
      }
    }
  } finally {
    rl.close();
  }
}

function redactCredentialForAudit(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentialForAudit(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (key === 'credential_grant' && item && typeof item === 'object') {
      const grantInput = item as Record<string, unknown>;
      output[key] = {
        grant_id: grantInput.grant_id ?? null,
        credential_ref: grantInput.credential_ref ?? null,
        tool_name: grantInput.tool_name ?? null,
        task_id: grantInput.task_id ?? null,
        request_id: grantInput.request_id ?? null,
      };
      continue;
    }
    if (key === '_landgod_credential' && item && typeof item === 'object') {
      const credential = item as Record<string, unknown>;
      output[key] = {
        credential_ref: credential.credential_ref ?? null,
        credential_type: credential.credential_type ?? null,
        expires_in: credential.expires_in ?? null,
        secret: '***REDACTED***',
      };
      continue;
    }
    if (key === 'secret' || /password|token|secret|api[_-]?key/i.test(key)) {
      output[key] = '***REDACTED***';
    } else {
      output[key] = redactCredentialForAudit(item);
    }
  }
  return output;
}

function stringifyForAudit(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  try {
    const text = typeof value === 'string' ? value : JSON.stringify(redactCredentialForAudit(value), null, 2);
    return text.length > 10_000 ? `${text.slice(0, 10_000)}...` : text;
  } catch {
    return String(value);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeManagedClientToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^Bearer\s+/i, '').trim();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function getWebSocketTlsSocket(socket: WebSocket): tls.TLSSocket | null {
  const candidate = (socket as WebSocket & { _socket?: unknown })._socket;
  return candidate instanceof tls.TLSSocket ? candidate : null;
}

function buildTlsTrustLogPayload(wsUrl: string, servername: string, tlsSocket: tls.TLSSocket): Record<string, unknown> {
  const peerCertificate = tlsSocket.getPeerCertificate();
  const subject = peerCertificate && typeof peerCertificate === 'object' ? peerCertificate.subject : undefined;
  const issuer = peerCertificate && typeof peerCertificate === 'object' ? peerCertificate.issuer : undefined;

  return {
    wsUrl,
    servername,
    authorized: tlsSocket.authorized,
    authorizationError: tlsSocket.authorizationError ?? null,
    subject,
    issuer,
    validFrom: peerCertificate?.valid_from ?? null,
    validTo: peerCertificate?.valid_to ?? null,
  };
}

function getManagedClientTlsConnectionOptions(
  wsUrl: string,
  config: Pick<ManagedClientRuntimeConfig, 'tlsServername'>,
): tls.ConnectionOptions | undefined {
  const url = new URL(wsUrl);
  if (url.protocol !== 'wss:') {
    return undefined;
  }

  const servername = config.tlsServername?.trim() || url.hostname;

  return {
    rejectUnauthorized: true,
    servername,
    checkServerIdentity: (_hostname: string, peerCertificate: tls.PeerCertificate) => {
      return tls.checkServerIdentity(servername, peerCertificate);
    },
  };
}

function getManagedClientTlsOptions(
  wsUrl: string,
  config: Pick<ManagedClientRuntimeConfig, 'tlsServername'>,
): (WebSocketClientOptions & tls.ConnectionOptions) | undefined {
  const tlsOptions = getManagedClientTlsConnectionOptions(wsUrl, config);
  if (!tlsOptions) {
    return undefined;
  }

  return tlsOptions as WebSocketClientOptions & tls.ConnectionOptions;
}

function getManagedClientWebSocketOptions(
  wsUrl: string,
  config: Pick<ManagedClientRuntimeConfig, 'tlsServername'>,
  token: string | null,
): (WebSocketClientOptions & tls.ConnectionOptions) | undefined {
  const tlsOptions = getManagedClientTlsOptions(wsUrl, config);
  const url = new URL(wsUrl);
  const origin = `${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}`;
  const headers: Record<string, string> = {
    Origin: origin,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (!tlsOptions) {
    return { headers, origin } as WebSocketClientOptions & tls.ConnectionOptions;
  }

  return {
    ...tlsOptions,
    headers,
    origin,
  } as WebSocketClientOptions & tls.ConnectionOptions;
}

function getDesktopWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const isLoopback = isLoopbackHostname(url.hostname);

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!isLoopback && url.protocol !== 'https:') {
      throw new Error(`Managed MCP websocket mode requires https:// for non-localhost base URLs: ${baseUrl}`);
    }

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Managed MCP websocket mode requires http(s) or ws(s) base URL, received ${url.protocol}`);
  }

  if (!isLoopback && url.protocol !== 'wss:') {
    throw new Error(`Managed MCP websocket mode requires wss:// for non-localhost base URLs: ${baseUrl}`);
  }

  const normalizedPath = url.pathname.replace(/\/+$/, '');
  // Keep the path as-is — LandGod Gateway listens on root '/'
  // Only append /mcphub/ws if the path explicitly contains /api
  if (normalizedPath && normalizedPath.startsWith('/api') && !normalizedPath.endsWith('/mcphub/ws') && !normalizedPath.endsWith('/desktop/ws')) {
    url.pathname = `${normalizedPath}/mcphub/ws`;
  } else if (normalizedPath) {
    url.pathname = normalizedPath;
  }

  url.hash = '';
  url.searchParams.delete('access_token');

  return url.toString();
}

export async function validateManagedClientTlsConfig(config: Pick<ManagedClientRuntimeConfig, 'baseUrl' | 'tlsServername'>): Promise<{
  valid: boolean;
  skipped: boolean;
  wsUrl: string;
  servername: string | null;
  message: string;
}> {
  if (!config.baseUrl?.trim()) {
    throw new Error('MANAGED_CLIENT_BASE_URL is required');
  }

  const wsUrl = getDesktopWebSocketUrl(config.baseUrl);
  const url = new URL(wsUrl);
  const servername = config.tlsServername?.trim() || url.hostname;

  if (isLoopbackHostname(url.hostname) || url.protocol !== 'wss:') {
    return {
      valid: true,
      skipped: true,
      wsUrl,
      servername,
      message: 'Loopback base URL skips TLS validation.',
    };
  }

  const tlsOptions = getManagedClientTlsConnectionOptions(wsUrl, config);
  if (!tlsOptions) {
    throw new Error(`Managed MCP websocket TLS validation requires a wss:// endpoint: ${wsUrl}`);
  }

  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname,
      port: url.port ? Number(url.port) : 443,
      ...tlsOptions,
    });

    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      finish(() => reject(new Error(`Timed out validating TLS for ${url.hostname}`)));
    });
    socket.once('secureConnect', () => finish(resolve));
    socket.once('error', (error) => finish(() => reject(error)));
  });

  return {
    valid: true,
    skipped: false,
    wsUrl,
    servername,
    message: `TLS validation succeeded for ${servername}`,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortJsonValue(value[key]);
      return result;
    }, {});
}

function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(paddingLength)}`, 'base64');
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function computeToolCallBodySha256(toolName: string, argumentsPayload: Record<string, unknown>): string {
  return toBase64Url(
    createHash('sha256')
      .update(canonicalizeJson({
        tool_name: toolName,
        arguments: argumentsPayload,
      }), 'utf-8')
      .digest(),
  );
}

function buildToolCallSignaturePayload(
  requestId: string,
  meta: Record<string, unknown>,
  toolName: string,
  argumentsPayload: Record<string, unknown>,
): Record<string, unknown> {
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

function flattenToolResult(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts: string[] = [];

  for (const item of content) {
    if (!isJsonObject(item)) {
      continue;
    }

    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
      continue;
    }

    textParts.push(JSON.stringify(item, null, 2));
  }

  if (textParts.length > 0) {
    return textParts.join('\n');
  }

  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }

  return '(no output)';
}

function parseStructuredToolResult(result: Record<string, unknown>): Record<string, unknown> | null {
  if (isJsonObject(result.structuredContent)) {
    return result.structuredContent;
  }

  const text = flattenToolResult(result);
  if (!text || text === '(no output)') {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildMinimalToolSuccessPayload(
  toolName: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const parsedResult = parseStructuredToolResult(result);

  if (toolName === 'session_create' && parsedResult) {
    return {
      success: true,
      sessionId: typeof parsedResult.sessionId === 'string' ? parsedResult.sessionId : null,
      pid: typeof parsedResult.pid === 'number' ? parsedResult.pid : null,
      state: typeof parsedResult.state === 'string' ? parsedResult.state : null,
    };
  }

  if (toolName === 'session_wait' && parsedResult) {
    return {
      success: true,
      triggered: typeof parsedResult.triggered === 'string' ? parsedResult.triggered : null,
      state: typeof parsedResult.state === 'string' ? parsedResult.state : null,
      exitCode: typeof parsedResult.exitCode === 'number' || parsedResult.exitCode === null ? parsedResult.exitCode : null,
      stdoutLength: typeof parsedResult.stdoutLength === 'number' ? parsedResult.stdoutLength : null,
      stderrLength: typeof parsedResult.stderrLength === 'number' ? parsedResult.stderrLength : null,
    };
  }

  return { success: true };
}

export class ManagedClientMcpWsRuntime {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private socket: WebSocket | null = null;
  private readonly defenseLayer;
  private pullStatus: 'idle' | 'waiting' | 'task-assigned' | 'task-completed' | 'task-failed' = 'idle';
  private pulledTaskCount = 0;
  private emptyPollCount = 0;
  private lastPollStatus: number | null = null;
  private lastTaskCommand: string | null = null;
  private lastPolledAt: string | null = null;
  private receivedEventCount = 0;
  private pingCount = 0;
  private pongSentCount = 0;
  private lastEventAt: string | null = null;
  private lastEventName: string | null = null;
  private lastPingAt: string | null = null;
  private connectionId: string | null = null;
  private expectedUserId: string | null = null;
  private expectedClientId: string | null = null;
  private expectedSessionId: string | null = null;
  private expectedServerKeyId: string | null = null;
  private expectedServerPublicKeyPem: string | null = null;
  private serverClockOffsetMs = 0;
  private readonly replayCache = new Map<string, number>();
  private toolRegistry: ManagedClientMcpToolRegistry | null = null;
  private localClient: Client | null = null;
  private activeConnectionSignal: AbortSignal | null = null;
  private readonly approvedSessions = new Set<string>();
  private readonly pendingApprovals = new Map<string, (decision: 'approve-once' | 'approve-all' | 'reject') => void>();

  onActivity?: (area: string, action: string, summary: string, status: 'success' | 'info' | 'error', details?: Record<string, unknown>) => void;

  constructor(
    private readonly config: ManagedClientRuntimeConfig,
    private readonly sessionManager: SessionManager,
  ) {
    this.defenseLayer = createManagedClientDefenseLayer(config);
  }

  resolveToolCallApproval(requestId: string, decision: 'approve-once' | 'approve-all' | 'reject'): void {
    const resolver = this.pendingApprovals.get(requestId);
    if (resolver) {
      this.pendingApprovals.delete(requestId);
      resolver(decision);
    }
  }

  start(): void {
    if (!this.config.enabled || this.running) {
      return;
    }

    if (!this.config.baseUrl) {
      throw new Error('Managed MCP websocket mode requires MANAGED_CLIENT_BASE_URL');
    }

    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop(this.abortController.signal)
      .catch((error) => {
        const message = toErrorMessage(error);
        this.running = false;
        this.pullStatus = 'task-failed';
        this.appendAuditEntry('[managed-client-mcp-ws] startup failed', '', 1, message);
        emitServerEvent('managed-client-mcp-ws:error', { message });
      })
      .finally(() => {
        this.loopPromise = null;
      });
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    await this.loopPromise?.catch(() => undefined);
  }

  async republishTools(): Promise<{
    applied: boolean;
    toolCount: number;
    tools: string[];
    reason?: 'runtime-inactive' | 'bridge-not-ready';
  }> {
    if (!this.running) {
      return { applied: false, toolCount: 0, tools: [], reason: 'runtime-inactive' };
    }

    if (!this.toolRegistry || !this.localClient) {
      return { applied: false, toolCount: 0, tools: [], reason: 'bridge-not-ready' };
    }

    await this.toolRegistry.rebuildBindings();
    const toolDefinitions = this.toolRegistry.getToolDefinitions();
    const toolNames = Object.keys(toolDefinitions);

    const socket = this.socket;
    const activeConnectionSignal = this.activeConnectionSignal;
    const connectionId = this.connectionId;
    const canPublishImmediately = socket
      && socket.readyState === WebSocket.OPEN
      && activeConnectionSignal
      && connectionId;

    if (canPublishImmediately) {
      await this.sendRequest(socket, activeConnectionSignal, 'update_tools', {
        reset: true,
        tools: toolDefinitions,
      });

      this.appendAuditEntry('[managed-client-mcp-ws] update_tools request (republish)', {
        connectionId,
        reset: true,
        toolCount: toolNames.length,
        tools: toolNames,
        note: 'Desktop-facing tool set re-published after built-in tools config change.',
      }, 0);
      emitServerEvent('managed-client-mcp-ws:update-tools:request', {
        connectionId,
        reset: true,
        toolCount: toolNames.length,
        tools: toolNames,
      });
    }

    return canPublishImmediately
      ? { applied: true, toolCount: toolNames.length, tools: toolNames }
      : { applied: false, toolCount: toolNames.length, tools: toolNames, reason: 'bridge-not-ready' };
  }

  async updateMcpServers(mcpServers: ManagedClientRuntimeConfig['mcpServers']): Promise<{
    applied: boolean;
    toolCount: number;
    tools: string[];
    reason?: 'runtime-inactive' | 'bridge-not-ready';
  }> {
    this.config.mcpServers = mcpServers;

    if (!this.running) {
      return {
        applied: false,
        toolCount: 0,
        tools: [],
        reason: 'runtime-inactive',
      };
    }

    if (!this.localClient) {
      return {
        applied: false,
        toolCount: 0,
        tools: [],
        reason: 'bridge-not-ready',
      };
    }

    const nextRegistry = await ManagedClientMcpToolRegistry.create({
      localClient: this.localClient,
      externalServerConfigs: mcpServers,
      version: this.config.version,
      logger: {
        info: (command, stdout) => this.appendAuditEntry(command, stdout, 0),
        error: (command, stdout, stderr) => this.appendAuditEntry(command, stdout, 1, stderr),
      },
    });

    const toolDefinitions = nextRegistry.getToolDefinitions();
    const toolNames = Object.keys(toolDefinitions);

    const socket = this.socket;
    const activeConnectionSignal = this.activeConnectionSignal;
    const connectionId = this.connectionId;
    const canPublishImmediately = socket
      && socket.readyState === WebSocket.OPEN
      && activeConnectionSignal
      && connectionId;

    if (canPublishImmediately) {
      await this.sendRequest(socket, activeConnectionSignal, 'update_tools', {
        reset: true,
        tools: toolDefinitions,
      });

      this.appendAuditEntry('[managed-client-mcp-ws] update_tools request (dynamic)', {
        connectionId,
        reset: true,
        toolCount: toolNames.length,
        tools: toolNames,
        note: 'Desktop-facing tool set re-published after config update.',
      }, 0);
      emitServerEvent('managed-client-mcp-ws:update-tools:request', {
        connectionId,
        reset: true,
        toolCount: toolNames.length,
        tools: toolNames,
      });
    }

    await this.toolRegistry?.close().catch(() => undefined);
    this.toolRegistry = nextRegistry;

    return canPublishImmediately
      ? {
        applied: true,
        toolCount: toolNames.length,
        tools: toolNames,
      }
      : {
        applied: false,
        toolCount: toolNames.length,
        tools: toolNames,
        reason: 'bridge-not-ready',
      };
  }

  getStatus(): {
    enabled: boolean;
    running: boolean;
    clientId: string | null;
    connectionId: string | null;
    baseUrl: string | null;
    pullStatus: 'idle' | 'waiting' | 'task-assigned' | 'task-completed' | 'task-failed';
    pulledTaskCount: number;
    emptyPollCount: number;
    lastPollStatus: number | null;
    lastTaskCommand: string | null;
    lastPolledAt: string | null;
    receivedEventCount: number;
    pingCount: number;
    pongSentCount: number;
    lastEventAt: string | null;
    lastEventName: string | null;
    lastPingAt: string | null;
  } {
    return {
      enabled: this.config.enabled,
      running: this.running,
      clientId: this.config.clientId,
      connectionId: this.connectionId,
      baseUrl: this.config.baseUrl,
      pullStatus: this.pullStatus,
      pulledTaskCount: this.pulledTaskCount,
      emptyPollCount: this.emptyPollCount,
      lastPollStatus: this.lastPollStatus,
      lastTaskCommand: this.lastTaskCommand,
      lastPolledAt: this.lastPolledAt,
      receivedEventCount: this.receivedEventCount,
      pingCount: this.pingCount,
      pongSentCount: this.pongSentCount,
      lastEventAt: this.lastEventAt,
      lastEventName: this.lastEventName,
      lastPingAt: this.lastPingAt,
    };
  }

  private resetConnectionSecurityContext(): void {
    this.connectionId = null;
    this.expectedUserId = null;
    this.expectedClientId = null;
    this.expectedSessionId = null;
    this.expectedServerKeyId = null;
    this.expectedServerPublicKeyPem = null;
    this.serverClockOffsetMs = 0;
    this.replayCache.clear();
    this.approvedSessions.clear();
    for (const resolver of this.pendingApprovals.values()) {
      resolver('reject');
    }
    this.pendingApprovals.clear();
  }

  private purgeExpiredReplayCache(referenceTimeMs: number): void {
    for (const [key, expirationTimeMs] of this.replayCache.entries()) {
      if (expirationTimeMs + TOOL_CALL_CLOCK_SKEW_MS < referenceTimeMs) {
        this.replayCache.delete(key);
      }
    }
  }

  private validateToolCallSecurity(
    requestId: string,
    toolName: string,
    argumentsPayload: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): { valid: true } | { valid: false; code: string; message: string; details: Record<string, unknown> } {
    const meta = isJsonObject(payload.meta) ? payload.meta : null;
    if (!meta) {
      return {
        valid: false,
        code: 'missing_binding',
        message: 'tool_call payload is missing signed meta',
        details: {},
      };
    }

    if (!this.connectionId || !this.expectedUserId || !this.expectedClientId || !this.expectedSessionId || !this.expectedServerKeyId || !this.expectedServerPublicKeyPem) {
      return {
        valid: false,
        code: 'unbound_session',
        message: 'tool_call received before register binding context was established',
        details: {},
      };
    }

    const metaRequestId = typeof meta.request_id === 'string' ? meta.request_id : '';
    const userId = typeof meta.user_id === 'string' ? meta.user_id : '';
    const clientId = typeof meta.client_id === 'string' ? meta.client_id : '';
    const connectionId = typeof meta.connection_id === 'string' ? meta.connection_id : '';
    const sessionId = typeof meta.session_id === 'string' ? meta.session_id : '';
    const keyId = typeof meta.key_id === 'string' ? meta.key_id : '';
    const nonce = typeof meta.nonce === 'string' ? meta.nonce : '';
    const bodySha256 = typeof meta.body_sha256 === 'string' ? meta.body_sha256 : '';
    const signature = typeof meta.signature === 'string' ? meta.signature : '';
    const issuedAtMs = parseIsoTimestamp(meta.iat);
    const expiresAtMs = parseIsoTimestamp(meta.exp);

    if (!metaRequestId || !userId || !clientId || !connectionId || !sessionId || !keyId || !nonce || !bodySha256 || !signature || issuedAtMs === null || expiresAtMs === null) {
      return {
        valid: false,
        code: 'missing_binding',
        message: 'tool_call meta is missing one or more required binding fields',
        details: {
          requestId: metaRequestId || null,
          userId: userId || null,
          clientId: clientId || null,
          connectionId: connectionId || null,
          sessionId: sessionId || null,
          keyId: keyId || null,
          nonce: nonce || null,
        },
      };
    }

    if (metaRequestId !== requestId) {
      return {
        valid: false,
        code: 'missing_binding',
        message: 'tool_call meta request_id does not match the frame request id',
        details: { metaRequestId, requestId },
      };
    }

    if (userId !== this.expectedUserId) {
      return {
        valid: false,
        code: 'user_mismatch',
        message: 'tool_call user_id did not match the registered session user',
        details: { expectedUserId: this.expectedUserId, actualUserId: userId },
      };
    }

    if (clientId !== this.expectedClientId) {
      return {
        valid: false,
        code: 'client_mismatch',
        message: 'tool_call client_id did not match the registered client',
        details: { expectedClientId: this.expectedClientId, actualClientId: clientId },
      };
    }

    if (connectionId !== this.connectionId) {
      return {
        valid: false,
        code: 'connection_mismatch',
        message: 'tool_call connection_id did not match the active websocket connection',
        details: { expectedConnectionId: this.connectionId, actualConnectionId: connectionId },
      };
    }

    if (sessionId !== this.expectedSessionId) {
      return {
        valid: false,
        code: 'session_mismatch',
        message: 'tool_call session_id did not match the active registered session',
        details: { expectedSessionId: this.expectedSessionId, actualSessionId: sessionId },
      };
    }

    if (keyId !== this.expectedServerKeyId) {
      return {
        valid: false,
        code: 'invalid_server_key',
        message: 'tool_call key_id did not match the registered server signing key',
        details: { expectedKeyId: this.expectedServerKeyId, actualKeyId: keyId },
      };
    }

    const adjustedNowMs = Date.now() + this.serverClockOffsetMs;
    if (expiresAtMs < issuedAtMs || issuedAtMs > adjustedNowMs + TOOL_CALL_CLOCK_SKEW_MS || expiresAtMs < adjustedNowMs - TOOL_CALL_CLOCK_SKEW_MS) {
      return {
        valid: false,
        code: 'stale_request',
        message: 'tool_call iat/exp was outside the accepted clock skew window',
        details: {
          issuedAt: meta.iat,
          expiresAt: meta.exp,
          adjustedNow: new Date(adjustedNowMs).toISOString(),
        },
      };
    }

    this.purgeExpiredReplayCache(adjustedNowMs);
    const replayKey = `${sessionId}:${nonce}`;
    if (this.replayCache.has(replayKey)) {
      return {
        valid: false,
        code: 'replay_detected',
        message: 'tool_call nonce has already been processed for this session',
        details: { sessionId, nonce },
      };
    }

    const computedBodySha256 = computeToolCallBodySha256(toolName, argumentsPayload);
    if (computedBodySha256 !== bodySha256) {
      return {
        valid: false,
        code: 'body_hash_mismatch',
        message: 'tool_call body_sha256 did not match the received tool payload',
        details: { expectedBodySha256: computedBodySha256, actualBodySha256: bodySha256 },
      };
    }

    try {
      const publicKey = createPublicKey(this.expectedServerPublicKeyPem);
      const isSignatureValid = verify(
        null,
        Buffer.from(canonicalizeJson(buildToolCallSignaturePayload(requestId, meta, toolName, argumentsPayload)), 'utf-8'),
        publicKey,
        fromBase64Url(signature),
      );

      if (!isSignatureValid) {
        return {
          valid: false,
          code: 'invalid_signature',
          message: 'tool_call signature verification failed',
          details: { keyId },
        };
      }
    } catch (error) {
      return {
        valid: false,
        code: 'invalid_signature',
        message: `tool_call signature verification failed: ${toErrorMessage(error)}`,
        details: { keyId },
      };
    }

    this.replayCache.set(replayKey, expiresAtMs);
    return { valid: true };
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    const token = normalizeManagedClientToken(this.config.token);
    const workspace = prepareManagedClientWorkspace(this.config.workspaceRoot);
    const wsUrl = getDesktopWebSocketUrl(this.config.baseUrl!);

    console.log('[managed-client-mcp-ws] Connecting to MCP Hub websocket', {
      baseUrl: this.config.baseUrl,
      wsUrl,
      hasAuthorizationHeader: Boolean(token),
      workspaceRoot: workspace.rootDir,
      workspaceDirectory: workspace.workDir,
    });

    this.appendAuditEntry('[managed-client-mcp-ws] runtime start', {
      baseUrl: this.config.baseUrl,
      wsUrl,
      hasAuthorizationHeader: Boolean(token),
      workspaceRoot: workspace.rootDir,
      workspaceDirectory: workspace.workDir,
      clientId: this.config.clientId,
      clientName: this.config.clientName,
      headless: this.config.headless,
    }, 0);
    emitServerEvent('managed-client-mcp-ws:starting', {
      baseUrl: this.config.baseUrl,
      wsUrl,
      hasAuthorizationHeader: Boolean(token),
      workspaceRoot: workspace.rootDir,
      workspaceDirectory: workspace.workDir,
      clientId: this.config.clientId,
      clientName: this.config.clientName,
      headless: this.config.headless,
    });

    // Exponential backoff: start at retryDelayMs, double each failure, cap at 60s, reset on success
    const baseDelay = this.config.retryDelayMs;
    const maxDelay = 60000;
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        await this.connectOnce(wsUrl, token, signal, workspace);
        // Connection closed normally (server disconnect, etc.) — reset backoff
        consecutiveFailures = 0;
        if (!signal.aborted) {
          this.emptyPollCount += 1;
          await sleep(baseDelay);
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }

        consecutiveFailures += 1;
        const delay = Math.min(baseDelay * Math.pow(2, consecutiveFailures - 1), maxDelay);
        const jitter = Math.floor(Math.random() * 1000);

        const message = toErrorMessage(error);
        this.pullStatus = 'task-failed';
        this.appendAuditEntry('[managed-client-mcp-ws] error', '', 1, `${message} (retry in ${Math.round(delay / 1000)}s, attempt #${consecutiveFailures})`);
        emitServerEvent('managed-client-mcp-ws:error', { message, retryIn: delay, attempt: consecutiveFailures });
        this.emptyPollCount += 1;
        await sleep(delay + jitter);
      }
    }

    this.running = false;
    this.pullStatus = 'idle';
    this.appendAuditEntry('[managed-client-mcp-ws] runtime stopped', '', 0);
    emitServerEvent('managed-client-mcp-ws:stopped');
  }

  private async connectOnce(
    wsUrl: string,
    token: string | null,
    signal: AbortSignal,
    workspace: ReturnType<typeof prepareManagedClientWorkspace>,
  ): Promise<void> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(this.sessionManager, 'managed-client-mcp-ws', {
      defaultWorkingDirectory: workspace.workDir,
      enforcedWorkingDirectoryRoot: this.config.demo ? undefined : workspace.rootDir,
      requireShellAllowlist: !this.config.demo,
      exposeManagedAdminTool: true,
      onActivity: this.onActivity,
    });
    const client = new Client({
      name: 'cli-server-managed-client-mcp-ws',
      version: this.config.version,
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    this.localClient = client;
    this.activeConnectionSignal = signal;
    this.toolRegistry = await ManagedClientMcpToolRegistry.create({
      localClient: client,
      externalServerConfigs: this.config.mcpServers,
      version: this.config.version,
      workspaceRoot: this.config.demo ? undefined : workspace.rootDir,
      defaultWorkingDirectory: workspace.workDir,
      logger: {
        info: (command, stdout) => this.appendAuditEntry(command, stdout, 0),
        error: (command, stdout, stderr) => this.appendAuditEntry(command, stdout, 1, stderr),
      },
    });

    const socket = await this.openSocket(wsUrl, token, signal);
    this.socket = socket;

    try {
      await this.performHandshake(socket, signal);
      this.startResourceHeartbeat(socket, signal);
      await this.readLoop(socket, signal);
    } finally {
      this.resetConnectionSecurityContext();
      this.socket = null;
      this.localClient = null;
      this.activeConnectionSignal = null;
      await this.toolRegistry?.close().catch(() => undefined);
      this.toolRegistry = null;
      this.lastPollStatus = null;
      this.lastPolledAt = new Date().toISOString();
      if (!signal.aborted) {
        this.pullStatus = 'idle';
        this.appendAuditEntry('[managed-client-mcp-ws] disconnected', { wsUrl }, 0);
        emitServerEvent('managed-client-mcp-ws:disconnected', { wsUrl });
      }

      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  }

  private async openSocket(wsUrl: string, token: string | null, signal: AbortSignal): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      console.log('[managed-client-mcp-ws] openSocket', {
        wsUrl,
        hasToken: Boolean(token),
      });
      const socket = new WebSocket(wsUrl, getManagedClientWebSocketOptions(wsUrl, this.config, token));
      const servername = this.config.tlsServername?.trim() || new URL(wsUrl).hostname;

      socket.once('unexpected-response', (_req, res) => {
        signal.removeEventListener('abort', onAbort);
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => {
          const msg = `Unexpected server response: ${res.statusCode} (url=${wsUrl}, hasToken=${Boolean(token)}, body=${body.slice(0, 200)})`;
          console.log('[managed-client-mcp-ws] unexpected-response', msg);
          reject(new Error(msg));
        });
      });
      const onAbort = () => {
        socket.close();
        reject(new Error('Managed MCP websocket connection aborted'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      socket.once('open', () => {
        signal.removeEventListener('abort', onAbort);
        this.lastPollStatus = 101;
        this.lastPolledAt = new Date().toISOString();
        const tlsSocket = getWebSocketTlsSocket(socket);
        if (tlsSocket) {
          const tlsTrustLog = buildTlsTrustLogPayload(wsUrl, servername, tlsSocket);
          console.log('[managed-client-mcp-ws] TLS trust status', tlsTrustLog);
          this.appendAuditEntry('[managed-client-mcp-ws] tls trust status', tlsTrustLog, tlsSocket.authorized ? 0 : 1);
        }
        this.appendAuditEntry('[managed-client-mcp-ws] socket open', { wsUrl }, 0);
        emitServerEvent('managed-client-mcp-ws:connected', { wsUrl });
        resolve(socket);
      });

      socket.once('error', (error) => {
        signal.removeEventListener('abort', onAbort);
        const tlsSocket = getWebSocketTlsSocket(socket);
        if (tlsSocket && tlsSocket.authorizationError) {
          const tlsTrustLog = buildTlsTrustLogPayload(wsUrl, servername, tlsSocket);
          console.log('[managed-client-mcp-ws] TLS trust status', tlsTrustLog);
          this.appendAuditEntry('[managed-client-mcp-ws] tls trust status', tlsTrustLog, 1, toErrorMessage(tlsSocket.authorizationError));
        }

        reject(error instanceof Error ? error : new Error(String(error)));
      });

      socket.once('close', (code, reason) => {
        signal.removeEventListener('abort', onAbort);
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error(`Managed MCP websocket closed during connect (${code}): ${reason.toString('utf-8')}`));
        }
      });
    });
  }

  private async performHandshake(socket: WebSocket, signal: AbortSignal): Promise<void> {
    this.appendAuditEntry('[managed-client-mcp-ws] waiting for session_opened', {
      baseUrl: this.config.baseUrl,
      clientId: this.config.clientId,
      clientName: this.config.clientName,
    }, 0);
    emitServerEvent('managed-client-mcp-ws:waiting-for-session-opened', {
      clientId: this.config.clientId,
      clientName: this.config.clientName,
    });
    const openedMessage = await this.waitForEvent(socket, signal, 'session_opened', HANDSHAKE_TIMEOUT_MS);
    const openedPayload = isJsonObject(openedMessage.payload) ? openedMessage.payload : null;
    const connectionId = typeof openedPayload?.connection_id === 'string' ? openedPayload.connection_id : null;
    if (!connectionId) {
      throw new Error('Desktop websocket protocol did not provide connection_id in session_opened event');
    }

    this.connectionId = connectionId;
    this.pullStatus = 'waiting';
    this.lastPolledAt = new Date().toISOString();
    this.appendAuditEntry('[managed-client-mcp-ws] session opened', {
      connectionId: this.connectionId,
      clientId: this.config.clientId,
      clientName: this.config.clientName,
    }, 0);
    emitServerEvent('managed-client-mcp-ws:session-opened', {
      connectionId: this.connectionId,
      clientId: this.config.clientId,
      clientName: this.config.clientName,
    });

    this.appendAuditEntry('[managed-client-mcp-ws] register request', {
      connectionId: this.connectionId,
      clientId: this.config.clientId,
      clientName: this.config.clientName,
      note: 'Desktop capabilities are advertised in update_tools, not register.',
    }, 0);
    emitServerEvent('managed-client-mcp-ws:register:request', {
      connectionId: this.connectionId,
      clientId: this.config.clientId,
      clientName: this.config.clientName,
    });
    const registerResponse = await this.sendRequest(socket, signal, 'register', {
      client_id: this.config.clientId,
      client_name: this.config.clientName,
      labels: this.config.labels,
      resources: await this.collectResources(),
    });
    this.appendAuditEntry('[managed-client-mcp-ws] register response', {
      connectionId: this.connectionId,
      ok: registerResponse.ok === true,
      response: registerResponse,
    }, registerResponse.ok === true ? 0 : 1);
    emitServerEvent('managed-client-mcp-ws:register:response', {
      connectionId: this.connectionId,
      ok: registerResponse.ok === true,
    });
    if (!registerResponse.ok) {
      throw new Error(`Desktop websocket register failed: ${stringifyForAudit(registerResponse)}`);
    }

    const registerPayload = isJsonObject(registerResponse.payload) ? registerResponse.payload : null;
    const registeredUserId = typeof registerPayload?.user_id === 'string' ? registerPayload.user_id : null;
    const registeredClientId = typeof registerPayload?.client_id === 'string' ? registerPayload.client_id : null;
    const registeredConnectionId = typeof registerPayload?.connection_id === 'string' ? registerPayload.connection_id : null;
    const registeredSessionId = typeof registerPayload?.session_id === 'string' ? registerPayload.session_id : null;
    const registeredServerKeyId = typeof registerPayload?.server_key_id === 'string' ? registerPayload.server_key_id : null;
    const registeredServerTime = typeof registerPayload?.server_time === 'string' ? registerPayload.server_time : null;
    const registeredServerPublicKey = typeof registerPayload?.server_public_key === 'string'
      ? registerPayload.server_public_key.trim()
      : null;
    const serverTimeMs = parseIsoTimestamp(registeredServerTime);

    if (!registeredUserId || !registeredClientId || !registeredConnectionId || !registeredSessionId || !registeredServerKeyId || !registeredServerPublicKey || serverTimeMs === null) {
      throw new Error(`Desktop websocket register response missing binding fields: ${stringifyForAudit(registerPayload)}`);
    }

    if (registeredConnectionId !== this.connectionId) {
      throw new Error(`Desktop websocket register response connection_id mismatch: expected ${this.connectionId}, received ${registeredConnectionId}`);
    }

    if (registeredClientId !== this.config.clientId) {
      throw new Error(`Desktop websocket register response client_id mismatch: expected ${this.config.clientId}, received ${registeredClientId}`);
    }

    createPublicKey(registeredServerPublicKey);
    this.expectedUserId = registeredUserId;
    this.expectedClientId = registeredClientId;
    this.expectedSessionId = registeredSessionId;
    this.expectedServerKeyId = registeredServerKeyId;
    this.expectedServerPublicKeyPem = registeredServerPublicKey;
    this.serverClockOffsetMs = serverTimeMs - Date.now();

    this.appendAuditEntry('[managed-client-mcp-ws] register binding established', {
      connectionId: this.connectionId,
      userId: this.expectedUserId,
      clientId: this.expectedClientId,
      sessionId: this.expectedSessionId,
      serverKeyId: this.expectedServerKeyId,
      serverClockOffsetMs: this.serverClockOffsetMs,
    }, 0);
    emitServerEvent('managed-client-mcp-ws:register:bound', {
      connectionId: this.connectionId,
      userId: this.expectedUserId,
      clientId: this.expectedClientId,
      sessionId: this.expectedSessionId,
      serverKeyId: this.expectedServerKeyId,
    });

    const toolDefinitions = this.toolRegistry?.getToolDefinitions() ?? {};
    this.appendAuditEntry('[managed-client-mcp-ws] update_tools request', {
      connectionId: this.connectionId,
      reset: true,
      toolCount: Object.keys(toolDefinitions).length,
      tools: Object.keys(toolDefinitions),
      note: 'Desktop-facing tool set advertised to the server.',
    }, 0);
    emitServerEvent('managed-client-mcp-ws:update-tools:request', {
      connectionId: this.connectionId,
      reset: true,
      toolCount: Object.keys(toolDefinitions).length,
      tools: Object.keys(toolDefinitions),
    });
    const updateToolsResponse = await this.sendRequest(socket, signal, 'update_tools', {
      reset: true,
      tools: toolDefinitions,
    });
    this.appendAuditEntry('[managed-client-mcp-ws] update_tools response', {
      connectionId: this.connectionId,
      ok: updateToolsResponse.ok === true,
      response: updateToolsResponse,
    }, updateToolsResponse.ok === true ? 0 : 1);
    emitServerEvent('managed-client-mcp-ws:update-tools:response', {
      connectionId: this.connectionId,
      ok: updateToolsResponse.ok === true,
    });
    if (!updateToolsResponse.ok) {
      throw new Error(`Desktop websocket update_tools failed: ${stringifyForAudit(updateToolsResponse)}`);
    }

    this.appendAuditEntry('[managed-client-mcp-ws] tools published', {
      connectionId: this.connectionId,
      toolCount: Object.keys(toolDefinitions).length,
      tools: Object.keys(toolDefinitions),
    }, 0);
    emitServerEvent('managed-client-mcp-ws:tools-published', {
      connectionId: this.connectionId,
      toolCount: Object.keys(toolDefinitions).length,
      tools: Object.keys(toolDefinitions),
    });
  }

  private async readLoop(socket: WebSocket, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        resolve();
      };

      const onMessage = (raw: WebSocket.RawData) => {
        void this.handleRawMessage(socket, raw).catch((error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      const onClose = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        socket.off('message', onMessage);
        socket.off('close', onClose);
        socket.off('error', onError);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('message', onMessage);
      socket.once('close', onClose);
      socket.once('error', onError);
    });
  }

  private async handleRawMessage(socket: WebSocket, raw: WebSocket.RawData): Promise<void> {
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
    const message = JSON.parse(text) as DesktopWsMessage;

    if (message.type === 'event' && message.event === 'ping') {
      this.recordIncomingEvent('ping');
      this.lastPingAt = this.lastEventAt;
      await this.sendPong(socket);
      return;
    }

    if (message.type === 'event') {
      this.recordIncomingEvent(typeof message.event === 'string' ? message.event : 'unknown');
      return;
    }

    if (message.type === 'req') {
      const requestId = typeof message.id === 'string' ? message.id : randomUUID();
      const method = typeof message.method === 'string' ? message.method : '';
      const params = isJsonObject(message.params) ? message.params : {};

      if (method === 'tool_call') {
        await this.handleToolCall(socket, requestId, params);
        return;
      }

      await this.sendToolError(socket, requestId, 'unsupported_method', `Unknown request method: ${method || '(missing)'}`);
    }
  }

  private async handleToolCall(socket: WebSocket, requestId: string, payload: Record<string, unknown>): Promise<void> {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    const argumentsPayload = isJsonObject(payload.arguments) ? payload.arguments : {};

    if (!toolName) {
      await this.sendToolError(socket, requestId, 'invalid_request', 'tool_call payload is missing tool_name');
      return;
    }

    if (!this.config.demo) {
      const securityValidation = this.validateToolCallSecurity(requestId, toolName, argumentsPayload, payload);
      if (!securityValidation.valid) {
        const failedValidation = securityValidation as { valid: false; code: string; message: string; details: Record<string, unknown> };
        this.pullStatus = 'task-failed';
        this.lastTaskCommand = toolName;
        this.lastPolledAt = new Date().toISOString();
        this.appendAuditEntry(`[managed-client-mcp-ws] tool_call rejected: ${toolName}`, {
          requestId,
          toolName,
          rawPayload: payload,
          validation: failedValidation.details,
        }, 1, `${failedValidation.code}: ${failedValidation.message}`);
        emitServerEvent('managed-client-mcp-ws:task:rejected', {
          requestId,
          toolName,
          code: failedValidation.code,
        });
        await this.sendToolError(socket, requestId, failedValidation.code, failedValidation.message);
        return;
      }
    }

    const binding = this.toolRegistry?.getToolBinding(toolName) ?? null;

    if (!binding) {
      await this.sendToolError(socket, requestId, 'unknown_tool', `Unknown desktop tool: ${toolName}`);
      return;
    }

    const requestInspection = await this.defenseLayer.inspectToolCall({
      requestId,
      connectionId: this.connectionId,
      toolName,
      argumentsPayload,
      rawPayload: payload,
      binding,
      runtimeConfig: {
        baseUrl: this.config.baseUrl,
        clientId: this.config.clientId,
        clientName: this.config.clientName,
        mode: this.config.mode,
      },
    });

    if (!requestInspection.allowed) {
      const message = requestInspection.message ?? `Desktop tool call blocked by defense layer: ${toolName}`;
      this.pullStatus = 'task-failed';
      this.lastTaskCommand = toolName;
      this.lastPolledAt = new Date().toISOString();
      this.appendAuditEntry(`[managed-client-mcp-ws] tool_call blocked: ${toolName}`, {
        requestId,
        toolName,
        rawPayload: payload,
        source: binding.source,
        sourceName: binding.sourceName,
        findings: requestInspection.findings,
      }, 1, message);
      emitServerEvent('managed-client-mcp-ws:task:blocked', {
        requestId,
        toolName,
        code: requestInspection.code ?? 'tool_call_blocked',
      });
      await this.sendToolError(socket, requestId, requestInspection.code ?? 'tool_call_blocked', message);
      return;
    }

    let effectiveArgumentsPayload = requestInspection.argumentsPayload;
    const credentialGrant = parseCredentialGrant(payload.credential_grant);
    let exchangedCredential: ExchangedCredential | null = null;
    if (payload.credential_grant !== undefined && !credentialGrant) {
      await this.sendToolError(socket, requestId, 'invalid_credential_grant', 'credential_grant payload is malformed');
      return;
    }
    if (credentialGrant) {
      if (isCredentialForbiddenTool(toolName)) {
        await this.sendToolError(socket, requestId, 'credential_tool_forbidden', `Credential grants are forbidden for tool: ${toolName}`);
        return;
      }
      if (!binding.credentialAccess?.enabled) {
        this.appendAuditEntry(`[managed-client-mcp-ws] credential grant denied: ${toolName}`, {
          requestId,
          toolName,
          credentialRef: credentialGrant.credential_ref,
          reason: 'Tool is not declared credential-capable',
        }, 1);
        await this.sendToolError(socket, requestId, 'credential_tool_not_capable', `Tool is not declared credential-capable: ${toolName}`);
        return;
      }
      const grantValidation = validateCredentialGrant({
        grant: credentialGrant,
        toolName,
        argumentsPayload: effectiveArgumentsPayload,
        requestId,
        clientId: this.config.clientId,
        connectionId: this.connectionId,
        serverPublicKeyPem: this.expectedServerPublicKeyPem,
      });
      if (!grantValidation.valid) {
        this.appendAuditEntry(`[managed-client-mcp-ws] credential grant rejected: ${toolName}`, {
          requestId,
          toolName,
          credentialRef: credentialGrant.credential_ref,
          code: grantValidation.code,
        }, 1, grantValidation.message);
        await this.sendToolError(socket, requestId, grantValidation.code ?? 'invalid_credential_grant', grantValidation.message ?? 'credential grant is invalid');
        return;
      }
      exchangedCredential = await exchangeCredentialGrant({
        config: this.config,
        grant: credentialGrant,
        toolName,
      });
      if (!binding.credentialAccess.acceptedTypes.includes(exchangedCredential.credential_type)) {
        this.appendAuditEntry(`[managed-client-mcp-ws] credential grant denied: ${toolName}`, {
          requestId,
          toolName,
          credentialRef: credentialGrant.credential_ref,
          credentialType: exchangedCredential.credential_type,
          reason: 'Tool does not accept exchanged credential type',
        }, 1);
        await this.sendToolError(socket, requestId, 'credential_type_not_accepted', `Tool does not accept credential type: ${exchangedCredential.credential_type}`);
        return;
      }
      const grantScopes = Array.isArray(credentialGrant.allowed_scopes) ? credentialGrant.allowed_scopes : [];
      const allowedScopes = binding.credentialAccess.allowedScopes;
      if (grantScopes.length > 0 && allowedScopes.length > 0 && grantScopes.some((scope) => !allowedScopes.includes(scope))) {
        this.appendAuditEntry(`[managed-client-mcp-ws] credential grant denied: ${toolName}`, {
          requestId,
          toolName,
          credentialRef: credentialGrant.credential_ref,
          grantScopes,
          allowedScopes,
          reason: 'Grant scopes exceed tool allowed scopes',
        }, 1);
        await this.sendToolError(socket, requestId, 'credential_scope_not_accepted', 'Credential grant scopes are not accepted by this tool');
        return;
      }
      effectiveArgumentsPayload = {
        ...effectiveArgumentsPayload,
        _landgod_credential: exchangedCredential,
      };
    }

    // Tool call approval gate
    const metaForApproval = isJsonObject(payload.meta) ? payload.meta : null;
    const toolCallSessionId = typeof metaForApproval?.session_id === 'string' ? metaForApproval.session_id : '';

    if (getToolCallApprovalMode() === 'manual' && !this.approvedSessions.has(toolCallSessionId)) {
      emitServerEvent('tool-call:approval-required', {
        requestId,
        toolName,
        arguments: redactCredentialForAudit(effectiveArgumentsPayload),
        source: binding.source,
        sourceName: binding.sourceName,
        sessionId: toolCallSessionId,
      });

      let decision: 'approve-once' | 'approve-all' | 'reject';
      if (this.config.headless) {
        if (!canPromptForApprovalInTerminal()) {
          decision = 'reject';
          this.appendAuditEntry(`[managed-client-mcp-ws] tool_call rejected: ${toolName}`, {
            requestId,
            toolName,
            rawPayload: payload,
            reason: 'Headless manual approval requires an interactive TTY. Set toolCallApprovalMode=auto or run GUI/Electron mode for manual approval.',
          }, 1, 'Headless manual approval unavailable without an interactive TTY');
        } else {
          decision = await promptForToolCallApproval({
            requestId,
            toolName,
            sourceName: binding.sourceName,
            argumentsPayload: effectiveArgumentsPayload,
          });
        }
      } else {
        decision = await new Promise<'approve-once' | 'approve-all' | 'reject'>((resolve) => {
          this.pendingApprovals.set(requestId, resolve);
        });
      }

      if (decision === 'reject') {
        this.pullStatus = 'task-failed';
        this.lastTaskCommand = toolName;
        this.lastPolledAt = new Date().toISOString();
        this.appendAuditEntry(`[managed-client-mcp-ws] tool_call rejected by user: ${toolName}`, {
          requestId,
          toolName,
          rawPayload: payload,
        }, 1, 'User rejected tool call');
        emitServerEvent('managed-client-mcp-ws:task:rejected', {
          requestId,
          toolName,
          code: 'user_rejected',
        });
        await this.sendToolError(socket, requestId, 'user_rejected', this.config.headless && !canPromptForApprovalInTerminal()
          ? 'Tool call requires manual approval, but headless mode has no interactive TTY. Set toolCallApprovalMode=auto or run GUI/Electron mode.'
          : 'Tool call was rejected by the user');
        return;
      }

      if (decision === 'approve-all' && toolCallSessionId) {
        this.approvedSessions.add(toolCallSessionId);
      }
    }

    this.pullStatus = 'task-assigned';
    this.pulledTaskCount += 1;
    this.lastTaskCommand = toolName;
    this.lastPolledAt = new Date().toISOString();
    this.appendAuditEntry('[managed-client-mcp-ws] tool_call received', {
      requestId,
      toolName,
      rawPayload: payload,
      arguments: redactCredentialForAudit(effectiveArgumentsPayload),
      defenseFindings: requestInspection.findings,
    }, 0);
    emitServerEvent('managed-client-mcp-ws:task:started', { requestId, toolName });
    console.log(`[tool-call] ▶ ${toolName} (requestId=${requestId.slice(0, 8)}…) source=${binding.sourceName}`);
    const toolCallStartMs = Date.now();

    try {
      const { result } = await this.toolRegistry!.callTool(toolName, effectiveArgumentsPayload);
      const elapsedSec = ((Date.now() - toolCallStartMs) / 1000).toFixed(1);
      const text = flattenToolResult(result);
      console.log(`[tool-call] ${result.isError ? '✖' : '✔'} ${toolName} done in ${elapsedSec}s (${(text?.length ?? 0)} chars)`);

      if (result.isError) {
        const rawMessage = text && text !== '(no output)' ? text : 'Tool execution failed';
        const responseInspection = await this.defenseLayer.inspectToolResponse({
          requestId,
          connectionId: this.connectionId,
          toolName,
          binding,
          success: false,
          responseText: rawMessage,
          responseMode: 'error',
          rawResult: result,
          runtimeConfig: {
            baseUrl: this.config.baseUrl,
            clientId: this.config.clientId,
            clientName: this.config.clientName,
            mode: this.config.mode,
          },
        });
        const message = responseInspection.allowed
          ? responseInspection.responseText
          : (responseInspection.message ?? `Desktop tool response blocked by defense layer: ${toolName}`);
        this.pullStatus = 'task-failed';
        this.lastTaskCommand = toolName;
        this.appendAuditEntry(`[managed-client-mcp-ws] tool_call failed: ${toolName}`, {
          requestId,
          toolName,
          rawPayload: payload,
          source: binding.source,
          sourceName: binding.sourceName,
          result: redactCredentialForAudit(result),
          defenseFindings: responseInspection.findings,
        }, 1, message);
        emitServerEvent('managed-client-mcp-ws:task:completed', {
          requestId,
          toolName,
          success: false,
        });
        await this.sendToolError(socket, requestId, responseInspection.allowed ? 'tool_execution_failed' : (responseInspection.code ?? 'tool_response_blocked'), message);
        return;
      }

      const permissionProfile = getBuiltInToolsSecurityConfig().permissionProfile;
      const resultMode = getManagedClientToolResultMode(permissionProfile, toolName, binding.source);
      const outboundResponseText = resultMode === 'full'
        ? (text && text !== '(no output)' ? text : '(no output)')
        : JSON.stringify(resultMode === 'handle'
          ? buildMinimalToolSuccessPayload(toolName, result)
          : { success: true });
      const responseInspection = await this.defenseLayer.inspectToolResponse({
        requestId,
        connectionId: this.connectionId,
        toolName,
        binding,
        success: true,
        responseText: outboundResponseText,
        responseMode: resultMode,
        rawResult: result,
        runtimeConfig: {
          baseUrl: this.config.baseUrl,
          clientId: this.config.clientId,
          clientName: this.config.clientName,
          mode: this.config.mode,
        },
      });

      if (!responseInspection.allowed) {
        const message = responseInspection.message ?? `Desktop tool response blocked by defense layer: ${toolName}`;
        this.pullStatus = 'task-failed';
        this.lastTaskCommand = toolName;
        this.appendAuditEntry(`[managed-client-mcp-ws] tool_call response blocked: ${toolName}`, {
          requestId,
          toolName,
          rawPayload: payload,
          source: binding.source,
          sourceName: binding.sourceName,
          result: redactCredentialForAudit(result),
          defenseFindings: responseInspection.findings,
        }, 1, message);
        emitServerEvent('managed-client-mcp-ws:task:completed', {
          requestId,
          toolName,
          success: false,
        });
        await this.sendToolError(socket, requestId, responseInspection.code ?? 'tool_response_blocked', message);
        return;
      }

      if (resultMode === 'full') {
        if (responseInspection.responseText && responseInspection.responseText !== '(no output)') {
          await this.sendToolResultChunk(socket, requestId, responseInspection.responseText, false);
        }
        await this.sendToolResultChunk(
          socket,
          requestId,
          responseInspection.responseText && responseInspection.responseText !== '(no output)' ? '\n[completed]' : '(no output)',
          true,
        );
      } else {
        await this.sendToolResultChunk(socket, requestId, responseInspection.responseText, true);
      }

      this.pullStatus = 'task-completed';
      this.lastTaskCommand = toolName;
      this.appendAuditEntry(`[managed-client-mcp-ws] tool_call completed: ${toolName}`, {
        requestId,
        toolName,
        rawPayload: payload,
        source: binding.source,
        sourceName: binding.sourceName,
        result: redactCredentialForAudit(result),
        defenseFindings: responseInspection.findings,
      }, 0);
      emitServerEvent('managed-client-mcp-ws:task:completed', {
        requestId,
        toolName,
        success: true,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      const elapsedSec = ((Date.now() - toolCallStartMs) / 1000).toFixed(1);
      console.error(`[tool-call] ✖ ${toolName} EXCEPTION after ${elapsedSec}s: ${message}`);
      this.pullStatus = 'task-failed';
      this.appendAuditEntry(`[managed-client-mcp-ws] tool_call failed: ${toolName}`, {
        requestId,
        toolName,
        rawPayload: payload,
      }, 1, message);
      emitServerEvent('managed-client-mcp-ws:task:completed', {
        requestId,
        toolName,
        success: false,
      });
      await this.sendToolError(socket, requestId, 'tool_execution_failed', message);
    }
  }

  private async waitForEvent(
    socket: WebSocket,
    signal: AbortSignal,
    expectedEvent: string,
    timeoutMs = 0,
  ): Promise<DesktopWsMessage> {
    return new Promise<DesktopWsMessage>((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;

      const onAbort = () => {
        cleanup();
        reject(new Error(`Aborted while waiting for ${expectedEvent}`));
      };

      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
          const message = JSON.parse(text) as DesktopWsMessage;
          if (message.type === 'event' && message.event === expectedEvent) {
            this.recordIncomingEvent(expectedEvent);
            cleanup();
            resolve(message);
            return;
          }

          if (message.type === 'event' && message.event === 'ping') {
            this.recordIncomingEvent('ping');
            this.lastPingAt = this.lastEventAt;
            void this.sendPong(socket).catch(reject);
            return;
          }

          if (message.type === 'event') {
            this.recordIncomingEvent(typeof message.event === 'string' ? message.event : 'unknown');
          }

          this.appendAuditEntry(`[managed-client-mcp-ws] handshake message while waiting for ${expectedEvent}`, {
            message,
          }, 0);
          emitServerEvent('managed-client-mcp-ws:handshake-message', {
            expectedEvent,
            messageType: typeof message.type === 'string' ? message.type : null,
            event: typeof message.event === 'string' ? message.event : null,
            method: typeof message.method === 'string' ? message.method : null,
          });
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error(`Connection closed while waiting for ${expectedEvent}`));
      };

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        signal.removeEventListener('abort', onAbort);
        socket.off('message', onMessage);
        socket.off('close', onClose);
      };

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          this.appendAuditEntry(`[managed-client-mcp-ws] timeout waiting for ${expectedEvent}`, {
            timeoutMs,
          }, 1);
          emitServerEvent('managed-client-mcp-ws:handshake-timeout', {
            expectedEvent,
            timeoutMs,
          });
          cleanup();
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${expectedEvent}`));
        }, timeoutMs);
      }

      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('message', onMessage);
      socket.once('close', onClose);
    });
  }

  private async collectResources(): Promise<Record<string, unknown>> {
    const os = await import('os');
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || 'unknown',
      totalMemoryMB: Math.round(totalMem / 1024 / 1024),
      freeMemoryMB: Math.round(freeMem / 1024 / 1024),
      usedMemoryPercent: Math.round((1 - freeMem / totalMem) * 100),
      loadAvg1m: loadAvg[0],
      loadAvg5m: loadAvg[1],
      loadAvg15m: loadAvg[2],
      uptime: Math.round(os.uptime()),
      hostname: os.hostname(),
    };
  }

  private startResourceHeartbeat(socket: WebSocket, signal: AbortSignal): void {
    const RESOURCE_INTERVAL = 60000; // 60 seconds
    const interval = setInterval(async () => {
      if (signal.aborted || socket.readyState !== 1 /* WebSocket.OPEN */) {
        clearInterval(interval);
        return;
      }
      try {
        const resources = await this.collectResources();
        socket.send(JSON.stringify({
          type: 'req',
          id: `heartbeat-${randomUUID()}`,
          method: 'resource_heartbeat',
          params: { resources },
        }));
      } catch {
        // ignore heartbeat errors
      }
    }, RESOURCE_INTERVAL);
    signal.addEventListener('abort', () => clearInterval(interval), { once: true });
  }

  private async sendRequest(socket: WebSocket, signal: AbortSignal, method: string, params: Record<string, unknown>): Promise<DesktopWsMessage> {
    const requestId = `${method}-${randomUUID()}`;
    return new Promise<DesktopWsMessage>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error(`Aborted while waiting for response to ${method}`));
      };

      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
          const message = JSON.parse(text) as DesktopWsMessage;

          if (message.type === 'event' && message.event === 'ping') {
            this.recordIncomingEvent('ping');
            this.lastPingAt = this.lastEventAt;
            void this.sendPong(socket).catch((error) => {
              cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            });
            return;
          }

          if (message.type === 'event') {
            this.recordIncomingEvent(typeof message.event === 'string' ? message.event : 'unknown');
          }

          if (message.type === 'res' && message.id === requestId) {
            cleanup();
            resolve(message);
          }
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error(`Connection closed while waiting for response to ${method}`));
      };

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        socket.off('message', onMessage);
        socket.off('close', onClose);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('message', onMessage);
      socket.once('close', onClose);

      void this.sendJson(socket, {
        type: 'req',
        id: requestId,
        method,
        params,
      }).catch((error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async sendToolResultChunk(socket: WebSocket, requestId: string, text: string, isFinal: boolean): Promise<void> {
    await this.sendEvent(socket, 'tool_result_chunk', {
      request_id: requestId,
      data: { text },
      is_final: isFinal,
    });
  }

  private async sendToolError(socket: WebSocket, requestId: string, code: string, message: string): Promise<void> {
    await this.sendEvent(socket, 'tool_error', {
      request_id: requestId,
      error: {
        code,
        message,
        retryable: false,
      },
    });
  }

  private async sendEvent(socket: WebSocket, event: string, payload: Record<string, unknown>): Promise<void> {
    await this.sendJson(socket, {
      type: 'event',
      event,
      payload,
    });
  }

  private async sendPong(socket: WebSocket): Promise<void> {
    this.pongSentCount += 1;
    await this.sendEvent(socket, 'pong', {
      connection_id: this.connectionId,
    });
  }

  private recordIncomingEvent(eventName: string): void {
    this.receivedEventCount += 1;
    this.lastEventName = eventName;
    this.lastEventAt = new Date().toISOString();
    this.lastPolledAt = this.lastEventAt;
    if (eventName === 'ping') {
      this.pingCount += 1;
    }
  }

  private async sendJson(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
  private appendAuditEntry(command: string, stdout: unknown, exitCode: number | null, stderr = ''): void {
    auditLogger.appendEntry({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      command,
      cwd: this.config.baseUrl ?? '',
      exitCode,
      signal: null,
      stdout: stringifyForAudit(stdout),
      stderr,
      durationMs: 0,
      clientIp: 'managed-client-mcp-ws',
    });
  }
}
