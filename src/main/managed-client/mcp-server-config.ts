import type {
  ManagedClientExternalMcpServerConfig,
  ManagedClientExternalMcpHttpServerConfig,
  ManagedClientExternalMcpStdioServerConfig,
  ManagedClientExternalMcpTrustLevel,
} from './types';
import {
  normalizeExternalMcpPermissionProfile,
  type BuiltInToolsPermissionProfile,
} from '../builtin-tools/types';

export interface ManagedClientFileMcpServerConfig {
  transport?: string;
  url?: string;
  timeout?: number;
  command?: string;
  args?: string[];
  tools?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  toolPrefix?: string;
  requiredPermissionProfile?: BuiltInToolsPermissionProfile;
  trustLevel?: ManagedClientExternalMcpTrustLevel;
  publishedRemotely?: boolean;
  credentials?: {
    enabled?: boolean;
    acceptedTypes?: Array<'api_token' | 'username_password'>;
    allowedScopes?: string[];
  };
}

export type ManagedClientExternalMcpPublicationBlockedReason = 'not-published-remotely' | 'trust-level-blocked' | 'tool-list-required' | 'wildcard-tools-blocked';

const REMOTE_PUBLICATION_ALLOWED_TRUST_LEVELS = new Set<ManagedClientExternalMcpTrustLevel>(['trusted', 'internal-reviewed', 'experimental']);

export function normalizeManagedClientExternalMcpTrustLevel(value: unknown): ManagedClientExternalMcpTrustLevel {
  if (value === 'trusted' || value === 'internal-reviewed' || value === 'experimental' || value === 'blocked') {
    return value;
  }

  return 'trusted';
}

export function getExternalMcpRemotePublicationDecision(serverConfig: {
  publishedRemotely?: boolean;
  trustLevel?: ManagedClientExternalMcpTrustLevel;
  tools?: string[];
}): {
  allowed: boolean;
  blockedReason?: ManagedClientExternalMcpPublicationBlockedReason;
} {
  if (!serverConfig.publishedRemotely) {
    return {
      allowed: false,
      blockedReason: 'not-published-remotely',
    };
  }

  if (!REMOTE_PUBLICATION_ALLOWED_TRUST_LEVELS.has(normalizeManagedClientExternalMcpTrustLevel(serverConfig.trustLevel))) {
    return {
      allowed: false,
      blockedReason: 'trust-level-blocked',
    };
  }

  if (!Array.isArray(serverConfig.tools) || serverConfig.tools.length === 0) {
    return {
      allowed: false,
      blockedReason: 'tool-list-required',
    };
  }

  if (Array.isArray(serverConfig.tools) && serverConfig.tools.includes('*')) {
    return {
      allowed: false,
      blockedReason: 'wildcard-tools-blocked',
    };
  }

  return { allowed: true };
}

export function parseManagedClientMcpServers(
  mcpServers: Record<string, ManagedClientFileMcpServerConfig> | undefined,
): ManagedClientExternalMcpServerConfig[] {
  if (!mcpServers || typeof mcpServers !== 'object') {
    return [];
  }

  const servers: ManagedClientExternalMcpServerConfig[] = [];

  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server || server.enabled === false) {
      continue;
    }

    const toolPrefix = typeof server.toolPrefix === 'string' && server.toolPrefix.trim()
      ? server.toolPrefix.trim()
      : undefined;
    const tools = Array.isArray(server.tools)
      ? server.tools.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : undefined;
    const trustLevel = normalizeManagedClientExternalMcpTrustLevel(server.trustLevel);
    const publishedRemotely = server.publishedRemotely !== false; // 默认 true
    const credentials = server.credentials && typeof server.credentials === 'object'
      ? {
        enabled: server.credentials.enabled === true,
        acceptedTypes: Array.isArray(server.credentials.acceptedTypes)
          ? server.credentials.acceptedTypes.filter((value): value is 'api_token' | 'username_password' => value === 'api_token' || value === 'username_password')
          : undefined,
        allowedScopes: Array.isArray(server.credentials.allowedScopes)
          ? server.credentials.allowedScopes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : undefined,
      }
      : undefined;

    if (server.transport === 'http') {
      if (typeof server.url !== 'string' || !server.url.trim()) {
        continue;
      }

      servers.push({
        name,
        transport: 'http',
        url: server.url.trim(),
        timeout: typeof server.timeout === 'number' && server.timeout > 0 ? Math.floor(server.timeout) : undefined,
        toolPrefix,
        tools,
        requiredPermissionProfile: normalizeExternalMcpPermissionProfile(server.requiredPermissionProfile, 'http'),
        trustLevel,
        publishedRemotely,
        credentials,
      } satisfies ManagedClientExternalMcpHttpServerConfig);
      continue;
    }

    if (typeof server.command !== 'string' || !server.command.trim()) {
      continue;
    }

    servers.push({
      name,
      transport: 'stdio',
      command: server.command,
      args: Array.isArray(server.args) ? server.args.filter((value): value is string => typeof value === 'string') : [],
      cwd: typeof server.cwd === 'string' && server.cwd.trim() ? server.cwd : undefined,
      env: server.env && typeof server.env === 'object'
        ? Object.fromEntries(Object.entries(server.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : undefined,
      toolPrefix,
      tools,
      requiredPermissionProfile: normalizeExternalMcpPermissionProfile(server.requiredPermissionProfile, 'stdio'),
      trustLevel,
      publishedRemotely,
      credentials,
    } satisfies ManagedClientExternalMcpStdioServerConfig);
  }

  return servers;
}