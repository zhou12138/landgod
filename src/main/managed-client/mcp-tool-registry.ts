import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'node:path';
import type { ManagedClientExternalMcpServerConfig } from './types';
import { getExternalMcpRemotePublicationDecision, type ManagedClientExternalMcpPublicationBlockedReason } from './mcp-server-config';
import { getBuiltInToolsSecurityConfig } from './config';
import {
  getExternalMcpAccessDecision,
  isDesktopToolPublishedForPermissionProfile,
  type BuiltInToolsPermissionProfile,
  type ExternalMcpAccessBlockedReason,
} from '../builtin-tools/types';
import { buildSandboxEnv } from '../sandbox-env';
import { SHIPROOM_TOOL_NAMES } from '../builtin-tools/types';
import { PPTX_EDITOR_TOOL_NAMES } from '../builtin-tools/types';
import { isShiproomPythonAvailable } from '../builtin-tools/shiproom';
import { isPptxEditorPythonAvailable } from '../builtin-tools/pptx-editor';

const SESSION_DESKTOP_TOOL_NAMES = [
  'session_create',
  'session_stdin',
  'session_wait',
  'session_read_output',
] as const;

const ADVERTISED_DESKTOP_TOOL_NAMES = new Set([
  'shell_execute',
  'file_read',
  'audit_read',
  'remote_configure_mcp_server',
  ...SESSION_DESKTOP_TOOL_NAMES,
  ...(isShiproomPythonAvailable() ? SHIPROOM_TOOL_NAMES : []),
  ...(isPptxEditorPythonAvailable() ? PPTX_EDITOR_TOOL_NAMES : []),
]);

const EXTERNAL_MCP_CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const EXTERNAL_MCP_LIST_TOOLS_TIMEOUT_MS = 5 * 60 * 1000;
const COMPUTER_USE_SERVER_NAME = 'computer-use';
const SHIPROOM_SERVER_NAME = 'shiproom';
const PPTX_EDITOR_SERVER_NAME = 'pptx-editor';

function getEnabledDesktopToolNames(): Set<string> {
  const config = getBuiltInToolsSecurityConfig();
  const enabledTools = new Set<string>();

  if (config.shellExecute.enabled && isDesktopToolPublishedForPermissionProfile(config.permissionProfile, 'shell_execute')) {
    enabledTools.add('shell_execute');
    for (const toolName of SESSION_DESKTOP_TOOL_NAMES.filter((toolName) => isDesktopToolPublishedForPermissionProfile(config.permissionProfile, toolName))) {
      enabledTools.add(toolName);
    }
  }

  if (config.fileRead.enabled && isDesktopToolPublishedForPermissionProfile(config.permissionProfile, 'file_read')) {
    enabledTools.add('file_read');
  }

  if (isDesktopToolPublishedForPermissionProfile(config.permissionProfile, 'audit_read')) {
    enabledTools.add('audit_read');
  }

  if (config.managedMcpServerAdmin.enabled && isDesktopToolPublishedForPermissionProfile(config.permissionProfile, 'remote_configure_mcp_server')) {
    enabledTools.add('remote_configure_mcp_server');
  }

  // Shiproom tools — promoted to built-in when shiproom MCP server is injected
  if (isShiproomPythonAvailable()) {
    for (const toolName of SHIPROOM_TOOL_NAMES) {
      if (isDesktopToolPublishedForPermissionProfile(config.permissionProfile, toolName)) {
        enabledTools.add(toolName);
      }
    }
  }

  // PPTX Editor tools — promoted to built-in when pptx-editor MCP server is injected
  if (isPptxEditorPythonAvailable()) {
    for (const toolName of PPTX_EDITOR_TOOL_NAMES) {
      if (isDesktopToolPublishedForPermissionProfile(config.permissionProfile, toolName)) {
        enabledTools.add(toolName);
      }
    }
  }

  return enabledTools;
}

function filterExternalServersByPermissionProfile(
  serverConfigs: ManagedClientExternalMcpServerConfig[],
): ManagedClientExternalMcpServerConfig[] {
  const permissionProfile = getBuiltInToolsSecurityConfig().permissionProfile;
  return serverConfigs.filter((serverConfig) => {
    // computer-use, shiproom, and pptx-editor are promoted to built-in — always allow through.
    if (serverConfig.name === COMPUTER_USE_SERVER_NAME) return true;
    if (serverConfig.name === SHIPROOM_SERVER_NAME) return true;
    if (serverConfig.name === PPTX_EDITOR_SERVER_NAME) return true;
    return getExternalMcpAccessDecision(
      permissionProfile,
      serverConfig.transport,
      serverConfig.requiredPermissionProfile,
    ).allowed;
  });
}

function getExternalServerAccessDecision(
  permissionProfile: BuiltInToolsPermissionProfile,
  serverConfig: ManagedClientExternalMcpServerConfig,
): {
  allowed: boolean;
  requiredPermissionProfile: BuiltInToolsPermissionProfile;
  blockedReason?: ExternalMcpAccessBlockedReason;
} {
  return getExternalMcpAccessDecision(
    permissionProfile,
    serverConfig.transport,
    serverConfig.requiredPermissionProfile,
  );
}

export interface ToolCredentialAccess {
  enabled: boolean;
  acceptedTypes: Array<'api_token' | 'username_password'>;
  allowedScopes: string[];
}

export interface ToolBinding {
  advertisedName: string;
  upstreamName: string;
  description: string;
  inputSchema: unknown;
  client: Client;
  source: 'local' | 'external';
  sourceName: string;
  credentialAccess?: ToolCredentialAccess;
}

export interface ManagedClientMcpServerConnectionTestResult {
  name: string;
  transport: 'http' | 'stdio';
  requiredPermissionProfile: BuiltInToolsPermissionProfile;
  success: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
  blockedReason?: ExternalMcpAccessBlockedReason | ManagedClientExternalMcpPublicationBlockedReason;
}

interface ConnectedExternalMcpServer {
  config: ManagedClientExternalMcpServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

interface ToolRegistryLogger {
  info: (command: string, stdout: unknown) => void;
  error: (command: string, stdout: unknown, stderr: string) => void;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function pathMatchesRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(rootPath);
  const normalizedCandidate = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const normalizedRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function resolveExternalServerWorkingDirectory(
  serverConfig: ManagedClientExternalMcpServerConfig,
  workspaceRoot?: string,
  defaultWorkingDirectory?: string,
): string | undefined {
  if (serverConfig.transport !== 'stdio') {
    return undefined;
  }

  const configuredCwd = serverConfig.cwd?.trim();
  if (!workspaceRoot) {
    return configuredCwd || defaultWorkingDirectory;
  }

  if (configuredCwd) {
    if (!pathMatchesRoot(configuredCwd, workspaceRoot)) {
      throw new Error(`STDIO MCP server cwd must stay inside managed workspace: ${serverConfig.name}`);
    }
    return configuredCwd;
  }

  return defaultWorkingDirectory ?? workspaceRoot;
}

/**
 * Resolve the environment for a stdio MCP server process.
 * When sandboxStdioServers is enabled, applies sandbox env filtering
 * (strips credentials, sets HOME/TEMP inside workspace).
 * Any explicit env from the server config is merged on top.
 */
function resolveStdioServerEnv(
  configEnv: Record<string, string> | undefined,
  resolvedCwd: string | undefined,
): Record<string, string> | undefined {
  const securityConfig = getBuiltInToolsSecurityConfig().managedMcpServerAdmin;

  if (!securityConfig.sandboxStdioServers) {
    return configEnv;
  }

  // Build sandbox base env using the resolved cwd (or process.cwd() fallback)
  const sandboxBase = buildSandboxEnv(resolvedCwd ?? process.cwd());
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(sandboxBase)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // Merge user-specified env on top (e.g. API keys the operator intentionally provides)
  if (configEnv) {
    for (const [key, value] of Object.entries(configEnv)) {
      merged[key] = value;
    }
  }

  return merged;
}

function getAllowedTools(config: ManagedClientExternalMcpServerConfig): Set<string> | null {
  if (!config.tools || config.tools.length === 0) {
    return null;
  }

  if (config.tools.includes('*')) {
    return null;
  }

  return new Set(config.tools);
}

function filterToolsByConfig<T extends { name: string }>(
  config: ManagedClientExternalMcpServerConfig,
  tools: T[],
): T[] {
  const allowedTools = getAllowedTools(config);
  if (!allowedTools) {
    return tools;
  }

  return tools.filter((tool) => allowedTools.has(tool.name));
}

function shouldPublishExternalServerRemotely(serverConfig: ManagedClientExternalMcpServerConfig): {
  allowed: boolean;
  blockedReason?: ManagedClientExternalMcpPublicationBlockedReason;
} {
  return getExternalMcpRemotePublicationDecision(serverConfig);
}

function getExternalAdvertisedToolName(config: ManagedClientExternalMcpServerConfig, toolName: string): string {
  const prefix = (config.toolPrefix ?? config.name).trim();
  return `${prefix}.${toolName}`;
}

export class ManagedClientMcpToolRegistry {
  private readonly toolBindings = new Map<string, ToolBinding>();

  private constructor(
    private readonly localClient: Client,
    private readonly externalServers: ConnectedExternalMcpServer[],
    private readonly logger: ToolRegistryLogger,
  ) {}

  static async create(params: {
    localClient: Client;
    externalServerConfigs: ManagedClientExternalMcpServerConfig[];
    version: string;
    logger: ToolRegistryLogger;
    workspaceRoot?: string;
    defaultWorkingDirectory?: string;
  }): Promise<ManagedClientMcpToolRegistry> {
    const filtered = filterExternalServersByPermissionProfile(params.externalServerConfigs);
    console.log('[tool-registry] create: all external servers', params.externalServerConfigs.map(s => ({ name: s.name, transport: s.transport, requiredPermissionProfile: s.requiredPermissionProfile })));
    console.log('[tool-registry] create: after permission filter', filtered.map(s => s.name));
    const externalServers = await ManagedClientMcpToolRegistry.connectExternalMcpServers(
      filtered,
      params.version,
      params.logger,
      params.workspaceRoot,
      params.defaultWorkingDirectory,
    );
    console.log('[tool-registry] create: connected servers', externalServers.map(s => s.config.name));
    const registry = new ManagedClientMcpToolRegistry(params.localClient, externalServers, params.logger);
    await registry.buildBindings();
    return registry;
  }

  static async testExternalServers(params: {
    externalServerConfigs: ManagedClientExternalMcpServerConfig[];
    version: string;
    workspaceRoot?: string;
    defaultWorkingDirectory?: string;
  }): Promise<ManagedClientMcpServerConnectionTestResult[]> {
    const results: ManagedClientMcpServerConnectionTestResult[] = [];
    const permissionProfile = getBuiltInToolsSecurityConfig().permissionProfile;

    for (const serverConfig of params.externalServerConfigs) {
      const accessDecision = getExternalServerAccessDecision(permissionProfile, serverConfig);
      if (!accessDecision.allowed) {
        results.push({
          name: serverConfig.name,
          transport: serverConfig.transport,
          requiredPermissionProfile: accessDecision.requiredPermissionProfile,
          success: false,
          toolCount: 0,
          tools: [],
          blockedReason: accessDecision.blockedReason,
          error: `Blocked by current permission profile: ${permissionProfile}`,
        });
        continue;
      }

      const client = new Client({
        name: `cli-server-managed-client-mcp-ws-test-${serverConfig.name}`,
        version: params.version,
      });
      const resolvedWorkingDirectory = resolveExternalServerWorkingDirectory(
        serverConfig,
        params.workspaceRoot,
        params.defaultWorkingDirectory,
      );
      const stdioEnv = serverConfig.transport === 'stdio'
        ? resolveStdioServerEnv(serverConfig.env, resolvedWorkingDirectory)
        : undefined;
      const transport = serverConfig.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(serverConfig.url))
        : new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          cwd: resolvedWorkingDirectory,
          env: stdioEnv,
          stderr: 'inherit',
        });

      try {
        await withTimeout(
          client.connect(transport),
          EXTERNAL_MCP_CONNECT_TIMEOUT_MS,
          `Timed out connecting to external MCP server: ${serverConfig.name}`,
        );
        const toolList = await withTimeout(
          client.listTools(),
          EXTERNAL_MCP_LIST_TOOLS_TIMEOUT_MS,
          `Timed out listing tools from external MCP server: ${serverConfig.name}`,
        );
        const filteredTools = filterToolsByConfig(serverConfig, toolList.tools);
        results.push({
          name: serverConfig.name,
          transport: serverConfig.transport,
          requiredPermissionProfile: accessDecision.requiredPermissionProfile,
          success: true,
          toolCount: filteredTools.length,
          tools: filteredTools.map((tool) => tool.name),
        });
      } catch (error) {
        results.push({
          name: serverConfig.name,
          transport: serverConfig.transport,
          requiredPermissionProfile: accessDecision.requiredPermissionProfile,
          success: false,
          toolCount: 0,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    }

    return results;
  }

  async rebuildBindings(): Promise<void> {
    this.toolBindings.clear();
    await this.buildBindings();
  }

  async close(): Promise<void> {
    await Promise.all(this.externalServers.map(async (externalServer) => {
      await externalServer.client.close().catch(() => undefined);
      await externalServer.transport.close().catch(() => undefined);
    }));
    this.toolBindings.clear();
  }

  getToolDefinitions(): Record<string, unknown> {
    return Object.fromEntries(
      Array.from(this.toolBindings.values()).map((binding) => [binding.advertisedName, {
        name: binding.advertisedName,
        description: binding.source === 'external'
          ? `[${binding.sourceName}] ${binding.description}`
          : binding.description,
        input_schema: binding.inputSchema,
      }]),
    );
  }

  getToolBinding(toolName: string): ToolBinding | null {
    return this.toolBindings.get(toolName) ?? null;
  }

  async callTool(toolName: string, argumentsPayload: Record<string, unknown>) {
    const binding = this.toolBindings.get(toolName);
    if (!binding) {
      throw new Error(`Unknown desktop tool: ${toolName}`);
    }

    // Stdio servers injected as built-in (computer-use, shiproom) run slow subprocesses.
    // They are registered with source='local' but sourceName is the server name, not 'local'.
    // Give any non-truly-local binding 10 minutes (Playwright fetch + Graph API retries).
    const callOptions = binding.sourceName !== 'local' ? { timeout: 600_000 } : undefined;

    const result = await binding.client.callTool({
      name: binding.upstreamName,
      arguments: argumentsPayload,
    }, undefined, callOptions);

    return {
      binding,
      result,
    };
  }

  private async buildBindings(): Promise<void> {
    const localToolList = await this.localClient.listTools();
    const enabledDesktopToolNames = getEnabledDesktopToolNames();

    for (const tool of localToolList.tools) {
      if (!ADVERTISED_DESKTOP_TOOL_NAMES.has(tool.name)) {
        continue;
      }

      if (!enabledDesktopToolNames.has(tool.name)) {
        continue;
      }

      this.toolBindings.set(tool.name, {
        advertisedName: tool.name,
        upstreamName: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        client: this.localClient,
        source: 'local',
        sourceName: 'local',
      });
    }

    // Inject computer-use, shiproom, and pptx-editor tools as built-in (source: 'local') when available
    const builtInServerNames = [COMPUTER_USE_SERVER_NAME, SHIPROOM_SERVER_NAME, PPTX_EDITOR_SERVER_NAME];
    for (const serverName of builtInServerNames) {
      const builtInServer = this.externalServers.find((s) => s.config.name === serverName);
      if (!builtInServer) continue;
      try {
        const toolList = await withTimeout(
          builtInServer.client.listTools(),
          EXTERNAL_MCP_LIST_TOOLS_TIMEOUT_MS,
          `Timed out listing tools from ${serverName} MCP server`,
        );
        const filteredTools = filterToolsByConfig(builtInServer.config, toolList.tools);
        console.log(`[tool-registry] buildBindings: ${serverName} tools injected =`, filteredTools.map(t => t.name));
        for (const tool of filteredTools) {
          this.toolBindings.set(tool.name, {
            advertisedName: tool.name,
            upstreamName: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            client: builtInServer.client,
            source: 'local',
            sourceName: serverName,
            credentialAccess: builtInServer.config.credentials?.enabled === true && builtInServer.config.trustLevel === 'trusted'
              ? {
                enabled: true,
                acceptedTypes: builtInServer.config.credentials.acceptedTypes ?? ['api_token', 'username_password'],
                allowedScopes: builtInServer.config.credentials.allowedScopes ?? [],
              }
              : undefined,
          });
        }
      } catch (error) {
        this.logger.error(`[managed-client-mcp-ws] ${serverName} tools injection failed`, {}, error instanceof Error ? error.message : String(error));
      }
    }

    for (const externalServer of this.externalServers) {
      // Built-in servers are injected above — skip here
      if (builtInServerNames.includes(externalServer.config.name)) continue;

      const publicationDecision = shouldPublishExternalServerRemotely(externalServer.config);
      if (!publicationDecision.allowed) {
        continue;
      }

      try {
        const toolList = await withTimeout(
          externalServer.client.listTools(),
          EXTERNAL_MCP_LIST_TOOLS_TIMEOUT_MS,
          `Timed out listing tools from external MCP server: ${externalServer.config.name}`,
        );
        const filteredTools = filterToolsByConfig(externalServer.config, toolList.tools);
        for (const tool of filteredTools) {
          const advertisedName = getExternalAdvertisedToolName(externalServer.config, tool.name);
          this.toolBindings.set(advertisedName, {
            advertisedName,
            upstreamName: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            client: externalServer.client,
            source: 'external',
            sourceName: externalServer.config.name,
            credentialAccess: externalServer.config.credentials?.enabled === true && externalServer.config.trustLevel === 'trusted'
              ? {
                enabled: true,
                acceptedTypes: externalServer.config.credentials.acceptedTypes ?? ['api_token', 'username_password'],
                allowedScopes: externalServer.config.credentials.allowedScopes ?? [],
              }
              : undefined,
          });
        }
      } catch (error) {
        this.logger.error('[managed-client-mcp-ws] external mcp server tools skipped', {
          name: externalServer.config.name,
          transport: externalServer.config.transport,
          publishedRemotely: externalServer.config.publishedRemotely,
          trustLevel: externalServer.config.trustLevel,
          tools: externalServer.config.tools,
        }, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private static async connectExternalMcpServers(
    serverConfigs: ManagedClientExternalMcpServerConfig[],
    version: string,
    logger: ToolRegistryLogger,
    workspaceRoot?: string,
    defaultWorkingDirectory?: string,
  ): Promise<ConnectedExternalMcpServer[]> {
    if (serverConfigs.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(serverConfigs.map(async (serverConfig) => {
      const client = new Client({
        name: `cli-server-managed-client-mcp-ws-${serverConfig.name}`,
        version,
      });
      const resolvedWorkingDirectory = resolveExternalServerWorkingDirectory(
        serverConfig,
        workspaceRoot,
        defaultWorkingDirectory,
      );
      const stdioEnv = serverConfig.transport === 'stdio'
        ? resolveStdioServerEnv(serverConfig.env, resolvedWorkingDirectory)
        : undefined;
      const transport = serverConfig.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(serverConfig.url))
        : new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          cwd: resolvedWorkingDirectory,
          env: stdioEnv,
          stderr: 'inherit',
        });

      try {
        await withTimeout(
          client.connect(transport),
          EXTERNAL_MCP_CONNECT_TIMEOUT_MS,
          `Timed out connecting to external MCP server: ${serverConfig.name}`,
        );
        logger.info('[managed-client-mcp-ws] external mcp server connected', {
          name: serverConfig.name,
          transport: serverConfig.transport,
          publishedRemotely: serverConfig.publishedRemotely,
          trustLevel: serverConfig.trustLevel,
          command: serverConfig.transport === 'stdio' ? serverConfig.command : undefined,
          args: serverConfig.transport === 'stdio' ? serverConfig.args : undefined,
          cwd: serverConfig.transport === 'stdio' ? resolvedWorkingDirectory : undefined,
          tools: serverConfig.tools,
          url: serverConfig.transport === 'http' ? serverConfig.url : undefined,
        });
        return { config: serverConfig, client, transport } as ConnectedExternalMcpServer;
      } catch (error) {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('[tool-registry] connectExternalMcpServers: failed to connect', serverConfig.name, errMsg);
        logger.error('[managed-client-mcp-ws] external mcp server failed', {
          name: serverConfig.name,
          transport: serverConfig.transport,
          publishedRemotely: serverConfig.publishedRemotely,
          trustLevel: serverConfig.trustLevel,
          command: serverConfig.transport === 'stdio' ? serverConfig.command : undefined,
          args: serverConfig.transport === 'stdio' ? serverConfig.args : undefined,
          cwd: serverConfig.transport === 'stdio' ? resolvedWorkingDirectory : undefined,
          tools: serverConfig.tools,
          url: serverConfig.transport === 'http' ? serverConfig.url : undefined,
        }, error instanceof Error ? error.message : String(error));
        return null;
      }
    }));

    return results
      .filter((r): r is PromiseFulfilledResult<ConnectedExternalMcpServer | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((v): v is ConnectedExternalMcpServer => v !== null);
  }
}