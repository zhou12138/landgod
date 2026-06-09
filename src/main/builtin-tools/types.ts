export const SHIPROOM_TOOL_NAMES = [
  'shiproom_login',
  'shiproom_whoami',
  'shiproom_status',
  'shiproom_read',
  'shiproom_list_history',
  'shiproom_url',
  'shiproom_update',
  'shiproom_notes',
  'shiproom_prep',
  'shiproom_fetch_loop',
  'shiproom_fetch_ocv',
  'shiproom_fetch_notes',
  'shiproom_split_loop',
  'shiproom_upload_md',
  'shiproom_archive',
  'shiproom_render_view',
] as const;

export const PPTX_EDITOR_TOOL_NAMES = [
  'pptx_open',
  'pptx_inspect',
  'pptx_exec_actions',
  'pptx_save',
  'pptx_switch',
  'pptx_close',
  'pptx_help',
] as const;

export interface ShellExecuteSecurityConfig {
  enabled: boolean;
  allowedExecutableNames: string[];
  allowedWorkingDirectories: string[];
  allowPipes: boolean;
  allowRedirection: boolean;
  allowNetworkCommands: boolean;
  allowInlineScripts: boolean;
  allowPathsOutsideWorkspace: boolean;
  sandboxExecution: boolean;
  maxCommandLength: number;
  maxTimeoutSeconds: number;
}

export interface FileReadSecurityConfig {
  enabled: boolean;
  allowRelativePaths: boolean;
  allowedPaths: string[];
  maxBytesPerRead: number;
  maxFileSizeBytes: number;
}

export interface ManagedMcpServerAdminSecurityConfig {
  enabled: boolean;
  allowHttpServers: boolean;
  allowStdioServers: boolean;
  sandboxStdioServers: boolean;
  allowedStdioServerCommands: string[];
}

export type BuiltInToolsPermissionProfile = 'command-only' | 'interactive-trusted' | 'full-local-admin' | 'demo';
export type ExternalMcpAccessBlockedReason = 'profile-too-low' | 'transport-blocked';
export type ManagedClientToolResultMode = 'status-only' | 'handle' | 'full';

export interface BuiltInToolsSecurityConfig {
  permissionProfile: BuiltInToolsPermissionProfile;
  shellExecute: ShellExecuteSecurityConfig;
  fileRead: FileReadSecurityConfig;
  managedMcpServerAdmin: ManagedMcpServerAdminSecurityConfig;
}

export const DEFAULT_BUILT_IN_TOOLS_PERMISSION_PROFILE: BuiltInToolsPermissionProfile = 'command-only';

const PERMISSION_PROFILE_ORDER: BuiltInToolsPermissionProfile[] = ['command-only', 'interactive-trusted', 'full-local-admin', 'demo'];
const COMMAND_ONLY_DESKTOP_TOOL_NAMES = new Set(['shell_execute']);
const INTERACTIVE_TRUSTED_DESKTOP_TOOL_NAMES = new Set(['shell_execute', 'session_create', 'session_stdin', 'session_wait']);
const FULL_LOCAL_ADMIN_DESKTOP_TOOL_NAMES = new Set([
  'shell_execute',
  'file_read',
  'remote_configure_mcp_server',
  'session_create',
  'session_stdin',
  'session_wait',
  'session_read_output',
  ...SHIPROOM_TOOL_NAMES,
  ...PPTX_EDITOR_TOOL_NAMES,
]);
// Demo profile exposes the full tool surface — identical to full-local-admin.
const DEMO_DESKTOP_TOOL_NAMES = FULL_LOCAL_ADMIN_DESKTOP_TOOL_NAMES;

export function getBuiltInToolsSecurityConfigForProfile(
  permissionProfile: BuiltInToolsPermissionProfile,
): BuiltInToolsSecurityConfig {
  switch (permissionProfile) {
    case 'command-only':
      return {
        permissionProfile,
        shellExecute: {
          enabled: true,
          allowedExecutableNames: ["echo", "ls", "cat", "whoami", "hostname", "uname", "pwd", "node", "ps", "df", "free", "nproc", "wc", "grep", "head", "tail", "date", "uptime", "env"],
          allowedWorkingDirectories: [],
          allowPipes: false,
          allowRedirection: false,
          allowNetworkCommands: false,
          allowInlineScripts: false,
          allowPathsOutsideWorkspace: false,
          sandboxExecution: true,
          maxCommandLength: 1000,
          maxTimeoutSeconds: 30,
        },
        fileRead: {
          enabled: false,
          allowRelativePaths: false,
          allowedPaths: [],
          maxBytesPerRead: 32 * 1024,
          maxFileSizeBytes: 1 * 1024 * 1024,
        },
        managedMcpServerAdmin: {
          enabled: false,
          allowHttpServers: false,
          allowStdioServers: false,
          sandboxStdioServers: true,
          allowedStdioServerCommands: [],
        },
      };
    case 'interactive-trusted':
      return {
        permissionProfile,
        shellExecute: {
          enabled: true,
          allowedExecutableNames: ["echo", "ls", "cat", "whoami", "hostname", "uname", "pwd", "node", "npm", "npx", "git", "python", "python3", "curl", "ps", "df", "free", "nproc", "wc", "grep", "head", "tail", "date", "uptime", "env", "which", "find", "sort", "uniq", "tr", "cut", "awk", "sed"],
          allowedWorkingDirectories: [],
          allowPipes: true,
          allowRedirection: true,
          allowNetworkCommands: false,
          allowInlineScripts: false,
          allowPathsOutsideWorkspace: false,
          sandboxExecution: true,
          maxCommandLength: 2000,
          maxTimeoutSeconds: 120,
        },
        fileRead: {
          enabled: false,
          allowRelativePaths: false,
          allowedPaths: [],
          maxBytesPerRead: 32 * 1024,
          maxFileSizeBytes: 1 * 1024 * 1024,
        },
        managedMcpServerAdmin: {
          enabled: false,
          allowHttpServers: false,
          allowStdioServers: false,
          sandboxStdioServers: true,
          allowedStdioServerCommands: [],
        },
      };
    case 'full-local-admin':
      return {
        permissionProfile,
        shellExecute: {
          enabled: true,
          allowedExecutableNames: ["echo", "ls", "cat", "whoami", "hostname", "uname", "pwd", "node", "npm", "npx", "git", "python", "python3", "curl", "ps", "df", "free", "nproc", "wc", "grep", "head", "tail", "date", "uptime", "env", "which", "find", "sort", "uniq", "tr", "cut", "awk", "sed", "mkdir", "rm", "cp", "mv", "chmod", "chown", "tar", "gzip", "wget", "ping", "netstat", "ss", "ip", "systemctl", "journalctl", "apt", "yum", "dnf"],
          allowedWorkingDirectories: [],
          allowPipes: true,
          allowRedirection: true,
          allowNetworkCommands: true,
          allowInlineScripts: true,
          allowPathsOutsideWorkspace: true,
          sandboxExecution: false,
          maxCommandLength: 4000,
          maxTimeoutSeconds: 120,
        },
        fileRead: {
          enabled: true,
          allowRelativePaths: true,
          allowedPaths: [],
          maxBytesPerRead: 64 * 1024,
          maxFileSizeBytes: 2 * 1024 * 1024,
        },
        managedMcpServerAdmin: {
          enabled: true,
          allowHttpServers: true,
          allowStdioServers: true,
          sandboxStdioServers: false,
          allowedStdioServerCommands: [],
        },
      };
    // Demo profile: all security checks disabled — for presentations and local testing only.
    case 'demo':
      return {
        permissionProfile,
        shellExecute: {
          enabled: true,
          allowedExecutableNames: [],
          allowedWorkingDirectories: [],
          allowPipes: true,
          allowRedirection: true,
          allowNetworkCommands: true,
          allowInlineScripts: true,
          allowPathsOutsideWorkspace: true,
          sandboxExecution: false,
          maxCommandLength: 100_000,
          maxTimeoutSeconds: 600,
        },
        fileRead: {
          enabled: true,
          allowRelativePaths: true,
          allowedPaths: [],
          maxBytesPerRead: 100 * 1024 * 1024,
          maxFileSizeBytes: 100 * 1024 * 1024,
        },
        managedMcpServerAdmin: {
          enabled: true,
          allowHttpServers: true,
          allowStdioServers: true,
          sandboxStdioServers: false,
          allowedStdioServerCommands: [],
        },
      };
    default:
      return getBuiltInToolsSecurityConfigForProfile(DEFAULT_BUILT_IN_TOOLS_PERMISSION_PROFILE);
  }
}

export function normalizeBuiltInToolsPermissionProfile(value: unknown): BuiltInToolsPermissionProfile {
  if (value === 'command-only' || value === 'interactive-trusted' || value === 'full-local-admin' || value === 'demo') {
    return value;
  }

  if (value === 'safe') {
    return 'command-only';
  }

  if (value === 'trusted') {
    return 'interactive-trusted';
  }

  return DEFAULT_BUILT_IN_TOOLS_PERMISSION_PROFILE;
}

export function getDefaultExternalMcpPermissionProfile(
  transport: 'http' | 'stdio',
): BuiltInToolsPermissionProfile {
  return 'full-local-admin';
}

export function normalizeExternalMcpPermissionProfile(
  value: unknown,
  transport: 'http' | 'stdio',
): BuiltInToolsPermissionProfile {
  if (value === 'command-only' || value === 'interactive-trusted' || value === 'full-local-admin' || value === 'demo') {
    return value;
  }

  if (value === 'safe') {
    return 'command-only';
  }

  if (value === 'trusted') {
    return 'interactive-trusted';
  }

  return getDefaultExternalMcpPermissionProfile(transport);
}

export function isPermissionProfileAtLeast(
  currentProfile: BuiltInToolsPermissionProfile,
  requiredProfile: BuiltInToolsPermissionProfile,
): boolean {
  return PERMISSION_PROFILE_ORDER.indexOf(currentProfile) >= PERMISSION_PROFILE_ORDER.indexOf(requiredProfile);
}

export function isShellAllowedForPermissionProfile(permissionProfile: BuiltInToolsPermissionProfile): boolean {
  return permissionProfile === 'command-only'
    || permissionProfile === 'interactive-trusted'
    || permissionProfile === 'full-local-admin'
    || permissionProfile === 'demo';
}

export function isWorkspaceScopedPermissionProfile(permissionProfile: BuiltInToolsPermissionProfile): boolean {
  return permissionProfile !== 'full-local-admin' && permissionProfile !== 'demo';
}

export function isManagedMcpServerAdminAllowedForPermissionProfile(
  permissionProfile: BuiltInToolsPermissionProfile,
): boolean {
  return permissionProfile === 'full-local-admin' || permissionProfile === 'demo';
}

export function isDesktopToolPublishedForPermissionProfile(
  permissionProfile: BuiltInToolsPermissionProfile,
  toolName: string,
): boolean {
  if (permissionProfile === 'command-only') {
    return COMMAND_ONLY_DESKTOP_TOOL_NAMES.has(toolName);
  }

  if (permissionProfile === 'interactive-trusted') {
    return INTERACTIVE_TRUSTED_DESKTOP_TOOL_NAMES.has(toolName);
  }

  if (permissionProfile === 'demo') {
    return DEMO_DESKTOP_TOOL_NAMES.has(toolName);
  }

  return FULL_LOCAL_ADMIN_DESKTOP_TOOL_NAMES.has(toolName);
}

export function getManagedClientToolResultMode(
  permissionProfile: BuiltInToolsPermissionProfile,
  toolName: string,
  source: 'local' | 'external',
): ManagedClientToolResultMode {
  if (permissionProfile === 'full-local-admin' || permissionProfile === 'demo') {
    return 'full';
  }

  if (source === 'external') {
    return 'status-only';
  }

  if (permissionProfile === 'interactive-trusted' && (toolName === 'session_create' || toolName === 'session_wait')) {
    return 'handle';
  }

  return 'status-only';
}

export function isExternalMcpTransportAllowedForPermissionProfile(
  permissionProfile: BuiltInToolsPermissionProfile,
  transport: 'http' | 'stdio',
): boolean {
  return (permissionProfile === 'full-local-admin' || permissionProfile === 'demo') && (transport === 'http' || transport === 'stdio');
}

export function getExternalMcpAccessDecision(
  permissionProfile: BuiltInToolsPermissionProfile,
  transport: 'http' | 'stdio',
  requiredPermissionProfile?: BuiltInToolsPermissionProfile,
): {
  allowed: boolean;
  requiredPermissionProfile: BuiltInToolsPermissionProfile;
  blockedReason?: ExternalMcpAccessBlockedReason;
} {
  const normalizedRequiredProfile = normalizeExternalMcpPermissionProfile(requiredPermissionProfile, transport);

  if (!isPermissionProfileAtLeast(permissionProfile, normalizedRequiredProfile)) {
    return {
      allowed: false,
      requiredPermissionProfile: normalizedRequiredProfile,
      blockedReason: 'profile-too-low',
    };
  }

  if (!isExternalMcpTransportAllowedForPermissionProfile(permissionProfile, transport)) {
    return {
      allowed: false,
      requiredPermissionProfile: normalizedRequiredProfile,
      blockedReason: 'transport-blocked',
    };
  }

  return {
    allowed: true,
    requiredPermissionProfile: normalizedRequiredProfile,
  };
}

export function applyPermissionProfileGuards(config: BuiltInToolsSecurityConfig): BuiltInToolsSecurityConfig {
  // Demo profile: no guards — all settings pass through as-is.
  if (config.permissionProfile === 'demo') {
    return config;
  }

  if (config.permissionProfile === 'command-only') {
    return {
      ...config,
      shellExecute: {
        ...config.shellExecute,
        allowPipes: false,
        allowRedirection: false,
        allowNetworkCommands: false,
        allowInlineScripts: false,
        allowPathsOutsideWorkspace: false,
        sandboxExecution: true,
      },
      fileRead: {
        ...config.fileRead,
        enabled: false,
        allowRelativePaths: false,
      },
      managedMcpServerAdmin: {
        enabled: false,
        allowHttpServers: false,
        allowStdioServers: false,
        sandboxStdioServers: true,
        allowedStdioServerCommands: config.managedMcpServerAdmin.allowedStdioServerCommands,
      },
    };
  }

  if (config.permissionProfile === 'interactive-trusted') {
    return {
      ...config,
      fileRead: {
        ...config.fileRead,
        enabled: false,
        allowRelativePaths: false,
      },
      shellExecute: {
        ...config.shellExecute,
        allowNetworkCommands: false,
        allowInlineScripts: false,
        allowPathsOutsideWorkspace: false,
        sandboxExecution: true,
      },
      managedMcpServerAdmin: {
        enabled: false,
        allowHttpServers: false,
        allowStdioServers: false,
        sandboxStdioServers: true,
        allowedStdioServerCommands: config.managedMcpServerAdmin.allowedStdioServerCommands,
      },
    };
  }

  return config;
}

export const DEFAULT_BUILT_IN_TOOLS_SECURITY_CONFIG = getBuiltInToolsSecurityConfigForProfile(
  DEFAULT_BUILT_IN_TOOLS_PERMISSION_PROFILE,
);