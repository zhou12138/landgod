import { contextBridge, ipcRenderer } from 'electron';
import type { ManagedClientFileMcpServerConfig } from '../main/managed-client/mcp-server-config';
import type { BuiltInToolsSecurityConfig, BuiltInToolsPermissionProfile, ExternalMcpAccessBlockedReason } from '../main/builtin-tools/types';
import type { ToolCallApprovalMode } from '../main/managed-client/config';

console.log('[Preload] Starting initialization');

export interface IOEvent {
  stream: 'stdin' | 'stdout' | 'stderr';
  time: number;
  data: string;
}

export interface ManagedClientBootstrapState {
  mode: 'cli-server' | 'managed-client' | 'managed-client-mcp-ws';
  headless: boolean;
  demo: boolean;
  baseUrl: string | null;
  signinPageUrl: string | null;
  tlsServername: string | null;
  workspaceRoot: string;
  workspaceDirectory: string;
  needsModeSelection: boolean;
  needsBaseUrl: boolean;
  running: boolean;
  sessionAuthenticated: boolean;
  clientId: string | null;
  connectionId: string | null;
  sessionIdentityLabel: string | null;
  sessionIdentityDetail: string | null;
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
}

export interface ElectronAPI {
  getActivityEntries: (options?: { offset?: number; limit?: number; search?: string }) => Promise<{
    entries: Array<{
      id: string;
      timestamp: string;
      area: string;
      action: string;
      summary: string;
      status: 'success' | 'info' | 'error';
      details?: Record<string, unknown>;
    }>;
    total: number;
  }>;
  clearActivityLog: () => Promise<{ success: boolean }>;
  getManagedClientBootstrapState: () => Promise<ManagedClientBootstrapState>;
  selectManagedClientMode: (mode: 'cli-server' | 'managed-client' | 'managed-client-mcp-ws') => Promise<ManagedClientBootstrapState>;
  saveManagedClientBaseUrlAndStart: (payload: {
    baseUrl: string;
    signinPageUrl?: string | null;
    tlsServername?: string | null;
    token?: string | null;
    persistToken?: boolean;
    identityLabel?: string | null;
    identityDetail?: string | null;
  }) => Promise<ManagedClientBootstrapState>;
  signOutManagedClient: () => Promise<ManagedClientBootstrapState>;
  startManagedClientSignin: (payload?: { signinPageUrl?: string | null; baseUrl?: string | null }) => Promise<{
    token: string;
    signinUrl: string;
    baseUrl: string | null;
    username: string | null;
    displayName: string | null;
  }>;
  cancelManagedClientSignin: () => Promise<void>;
  validateManagedClientTls: (payload: {
    baseUrl: string;
    tlsServername?: string | null;
  }) => Promise<{
    valid: boolean;
    skipped: boolean;
    wsUrl: string;
    servername: string | null;
    message: string;
  }>;
  getManagedClientMcpServersConfig: () => Promise<{
    mcpServers: Record<string, ManagedClientFileMcpServerConfig>;
  }>;
  testManagedClientMcpServersConfig: (payload: {
    mcpServers: Record<string, ManagedClientFileMcpServerConfig>;
  }) => Promise<{
    results: Array<{
      name: string;
      transport: 'http' | 'stdio';
      requiredPermissionProfile: BuiltInToolsPermissionProfile;
      success: boolean;
      toolCount: number;
      tools: string[];
      error?: string;
      blockedReason?: ExternalMcpAccessBlockedReason | 'not-published-remotely' | 'trust-level-blocked' | 'wildcard-tools-blocked';
    }>;
  }>;
  saveManagedClientMcpServersConfig: (payload: {
    mcpServers: Record<string, ManagedClientFileMcpServerConfig>;
    apply?: boolean;
  }) => Promise<{
    saved: boolean;
    applied: boolean;
    toolCount: number;
    tools: string[];
    reason?: 'runtime-inactive' | 'bridge-not-ready';
  }>;
  refreshManagedClientMcpTools: () => Promise<{
    applied: boolean;
    toolCount: number;
    tools: string[];
  }>;
  getBuiltInToolsSecurityConfig: () => Promise<{
    config: BuiltInToolsSecurityConfig;
  }>;
  saveBuiltInToolsSecurityConfig: (payload: {
    config: BuiltInToolsSecurityConfig;
  }) => Promise<{
    saved: boolean;
    config: BuiltInToolsSecurityConfig;
    applied: boolean;
    toolCount: number;
    tools: string[];
    reason?: 'runtime-inactive' | 'bridge-not-ready' | 'republish-pending';
  }>;
  getAuditEntries: (options?: { offset?: number; limit?: number; search?: string }) => Promise<{
    entries: Array<{
      id: string;
      timestamp: string;
      command: string;
      cwd: string;
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      ioEvents?: IOEvent[];
      durationMs: number;
      clientIp: string;
    }>;
    total: number;
  }>;
  getAuditEntry: (id: string) => Promise<{
    id: string;
    timestamp: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    ioEvents?: IOEvent[];
    durationMs: number;
    clientIp: string;
  } | undefined>;
  exportAuditEntries: (options?: { search?: string }) => Promise<{
    fileName: string;
    content: string;
    total: number;
  }>;
  getServerStatus: () => Promise<{ running: boolean; port: number; activeConnections: number }>;
  restartServer: (port?: number) => Promise<{ running: boolean; port: number }>;
  getSessions: (options?: { state?: string; offset?: number; limit?: number }) => Promise<{
    offset: number; limit: number; total: number; nextOffset: number | null;
    data: Array<{
      sessionId: string; command: string; cwd: string; pid: number;
      state: string; exitCode: number | null; signal: string | null;
      startedAt: string; endedAt: string | null; durationMs: number;
      stdoutLength: number; stderrLength: number; clientIp: string;
    }>;
  }>;
  killSession: (sessionId: string) => Promise<{ success: boolean }>;
  readSessionOutput: (sessionId: string, stream: 'stdout' | 'stderr', offset?: number, limit?: number) => Promise<{
    offset: number; limit: number; total: number; nextOffset: number | null; data: string;
  }>;
  readSessionIOLog: (sessionId: string) => Promise<IOEvent[]>;
  clearAuditLog: () => Promise<{ success: boolean; error?: string }>;
  getNotificationEnabled: () => Promise<boolean>;
  setNotificationEnabled: (enabled: boolean) => Promise<boolean>;
  getToolCallApprovalMode: () => Promise<ToolCallApprovalMode>;
  setToolCallApprovalMode: (mode: ToolCallApprovalMode) => Promise<ToolCallApprovalMode>;
  respondToToolCallApproval: (requestId: string, decision: 'approve-once' | 'approve-all' | 'reject') => Promise<void>;
  onServerEvent: (callback: (event: { type: string; data?: unknown }) => void) => () => void;
}

const api: ElectronAPI = {
  getActivityEntries: (options) => ipcRenderer.invoke('activity:getEntries', options),
  clearActivityLog: () => ipcRenderer.invoke('activity:clear'),
  getManagedClientBootstrapState: () => ipcRenderer.invoke('managed-client:getBootstrapState'),
  selectManagedClientMode: (mode) => ipcRenderer.invoke('managed-client:selectMode', mode),
  saveManagedClientBaseUrlAndStart: (payload) => ipcRenderer.invoke('managed-client:saveBaseUrlAndStart', payload),
  signOutManagedClient: () => ipcRenderer.invoke('managed-client:signOut'),
  startManagedClientSignin: (payload) => ipcRenderer.invoke('managed-client:startSignin', payload),
  cancelManagedClientSignin: () => ipcRenderer.invoke('managed-client:cancelSignin'),
  validateManagedClientTls: (payload) => ipcRenderer.invoke('managed-client:validateTls', payload),
  getManagedClientMcpServersConfig: () => ipcRenderer.invoke('managed-client:getMcpServersConfig'),
  testManagedClientMcpServersConfig: (payload) => ipcRenderer.invoke('managed-client:testMcpServersConfig', payload),
  saveManagedClientMcpServersConfig: (payload) => ipcRenderer.invoke('managed-client:saveMcpServersConfig', payload),
  refreshManagedClientMcpTools: () => ipcRenderer.invoke('managed-client:refreshMcpTools'),
  getBuiltInToolsSecurityConfig: () => ipcRenderer.invoke('built-in-tools:getSecurityConfig'),
  saveBuiltInToolsSecurityConfig: (payload) => ipcRenderer.invoke('built-in-tools:saveSecurityConfig', payload),
  getAuditEntries: (options) => ipcRenderer.invoke('audit:getEntries', options),
  getAuditEntry: (id) => ipcRenderer.invoke('audit:getEntry', id),
  exportAuditEntries: (options) => ipcRenderer.invoke('audit:export', options),
  getServerStatus: () => ipcRenderer.invoke('server:getStatus'),
  restartServer: (port) => ipcRenderer.invoke('server:restart', port),
  getSessions: (options) => ipcRenderer.invoke('session:list', options),
  killSession: (sessionId) => ipcRenderer.invoke('session:kill', sessionId),
  readSessionOutput: (sessionId, stream, offset, limit) => ipcRenderer.invoke('session:readOutput', sessionId, stream, offset, limit),
  readSessionIOLog: (sessionId) => ipcRenderer.invoke('session:readIOLog', sessionId),
  clearAuditLog: () => ipcRenderer.invoke('audit:clear'),
  getNotificationEnabled: () => ipcRenderer.invoke('settings:getNotification'),
  setNotificationEnabled: (enabled) => ipcRenderer.invoke('settings:setNotification', enabled),
  getToolCallApprovalMode: () => ipcRenderer.invoke('settings:getToolCallApprovalMode'),
  setToolCallApprovalMode: (mode) => ipcRenderer.invoke('settings:setToolCallApprovalMode', mode),
  respondToToolCallApproval: (requestId, decision) => ipcRenderer.invoke('tool-approval:respond', requestId, decision),
  onServerEvent: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { type: string; data?: unknown }) => callback(data);
    ipcRenderer.on('server:event', handler);
    return () => ipcRenderer.removeListener('server:event', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
console.log('[Preload] Exposed electronAPI successfully');
