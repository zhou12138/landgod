import type { BuiltInToolsPermissionProfile } from '../builtin-tools/types';

export type ManagedClientMode = 'managed-client-mcp-ws';
export type ManagedClientExternalMcpTrustLevel = 'trusted' | 'internal-reviewed' | 'experimental' | 'blocked';

export interface ManagedClientExternalMcpServerBaseConfig {
  name: string;
  toolPrefix?: string;
  tools?: string[];
  requiredPermissionProfile: BuiltInToolsPermissionProfile;
  trustLevel: ManagedClientExternalMcpTrustLevel;
  publishedRemotely: boolean;
}

export interface ManagedClientExternalMcpHttpServerConfig extends ManagedClientExternalMcpServerBaseConfig {
  transport: 'http';
  url: string;
  timeout?: number;
}

export interface ManagedClientExternalMcpStdioServerConfig extends ManagedClientExternalMcpServerBaseConfig {
  transport: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type ManagedClientExternalMcpServerConfig =
  | ManagedClientExternalMcpHttpServerConfig
  | ManagedClientExternalMcpStdioServerConfig;



export interface ManagedClientRuntimeConfig {
  mode: ManagedClientMode;
  enabled: boolean;
  headless: boolean;
  demo: boolean;
  baseUrl: string | null;
  signinPageUrl: string | null;
  tlsServername: string | null;
  workspaceRoot: string;
  token: string | null;
  clientId: string;
  clientName: string;
  labels: Record<string, string | boolean | number>;
  pollWaitSeconds: number;
  retryDelayMs: number;
  version: string;
  supportedCommands: string[];
  mcpServers: ManagedClientExternalMcpServerConfig[];
}