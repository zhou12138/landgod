import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { ManagedClientMode, ManagedClientRuntimeConfig } from './types';
import { getDefaultManagedClientWorkspaceRoot } from './workspace';
import { parseManagedClientMcpServers, type ManagedClientFileMcpServerConfig } from './mcp-server-config';
import {
  applyPermissionProfileGuards,
  DEFAULT_BUILT_IN_TOOLS_SECURITY_CONFIG,
  getBuiltInToolsSecurityConfigForProfile,
  normalizeBuiltInToolsPermissionProfile,
  type BuiltInToolsSecurityConfig,
  type BuiltInToolsPermissionProfile,
} from '../builtin-tools/types';
import {
  isShiproomPythonAvailable,
  getShiproomPythonCommand,
  getShiproomServerPath,
  getShiproomEnv,
  SHIPROOM_TOOL_NAMES,
} from '../builtin-tools/shiproom';
import {
  isPptxEditorPythonAvailable,
  getPptxEditorPythonCommand,
  getPptxEditorPythonPath,
  PPTX_EDITOR_TOOL_NAMES,
} from '../builtin-tools/pptx-editor';

export type ToolCallApprovalMode = 'auto' | 'manual';

interface ManagedClientFileConfig {
  mode?: ManagedClientMode;
  bootstrapBaseUrl?: string;
  baseUrl?: string;
  signinPageUrl?: string;
  tlsServername?: string;
  workspaceRoot?: string;
  token?: string;
  clientId?: string;
  clientName?: string;
  labels?: Record<string, string | boolean | number>;
  pollWaitSeconds?: number;
  retryDelayMs?: number;
  enabled?: boolean;
  mcpServers?: Record<string, ManagedClientFileMcpServerConfig>;
  enableComputerUse?: boolean;
  builtInTools?: PartialBuiltInToolsSecurityConfig;
  toolCallApprovalMode?: ToolCallApprovalMode;
}

type PartialBuiltInToolsSecurityConfig = {
  permissionProfile?: BuiltInToolsPermissionProfile;
  shellExecute?: Partial<BuiltInToolsSecurityConfig['shellExecute']>;
  fileRead?: Partial<BuiltInToolsSecurityConfig['fileRead']>;
  managedMcpServerAdmin?: Partial<BuiltInToolsSecurityConfig['managedMcpServerAdmin']>;
};

interface PersistedManagedClientMcpServerConfig extends ManagedClientFileMcpServerConfig {
  name?: string;
}

/**
 * Strip UTF-8 BOM (byte-order mark) from a string.
 * Windows editors (Notepad, some PowerShell cmdlets) often prepend BOM to JSON files,
 * which breaks JSON.parse().
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function getManagedClientConfigPath(): string {
  return path.resolve(process.cwd(), 'managed-client.config.json');
}

function getManagedClientMcpConfigPath(): string {
  return path.resolve(process.cwd(), 'managed-client.mcp-servers.json');
}

function normalizeManagedClientMcpServers(
  parsed: unknown,
): Record<string, ManagedClientFileMcpServerConfig> {
  if (!parsed) {
    return {};
  }

  if (Array.isArray(parsed)) {
    return Object.fromEntries(
      parsed.flatMap((entry): Array<[string, ManagedClientFileMcpServerConfig]> => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }

        const { name, ...config } = entry as PersistedManagedClientMcpServerConfig;
        if (typeof name !== 'string' || !name.trim()) {
          return [];
        }

        return [[name.trim(), config]];
      }),
    );
  }

  if (typeof parsed === 'object') {
    return parsed as Record<string, ManagedClientFileMcpServerConfig>;
  }

  return {};
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function getChangedEntries<T extends object>(base: T, value: T): Partial<T> | undefined {
  const changedEntries = Object.entries(value).filter(([key, currentValue]) => base[key as keyof T] !== currentValue);
  if (changedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(changedEntries) as Partial<T>;
}

function serializeBuiltInToolsSecurityConfig(config: BuiltInToolsSecurityConfig): PartialBuiltInToolsSecurityConfig {
  const normalized = applyPermissionProfileGuards(config);
  const base = getBuiltInToolsSecurityConfigForProfile(normalized.permissionProfile);

  return {
    permissionProfile: normalized.permissionProfile,
    shellExecute: getChangedEntries(base.shellExecute, normalized.shellExecute),
    fileRead: getChangedEntries(base.fileRead, normalized.fileRead),
    managedMcpServerAdmin: {
      enabled: normalized.managedMcpServerAdmin.enabled,
      allowHttpServers: normalized.managedMcpServerAdmin.allowHttpServers,
      allowStdioServers: normalized.managedMcpServerAdmin.allowStdioServers,
      sandboxStdioServers: normalized.managedMcpServerAdmin.sandboxStdioServers,
      allowedStdioServerCommands: normalized.managedMcpServerAdmin.allowedStdioServerCommands,
    },
  };
}

function normalizeBuiltInToolsSecurityConfig(parsed: unknown): BuiltInToolsSecurityConfig {
  const permissionProfile = normalizeBuiltInToolsPermissionProfile(
    typeof parsed === 'object' && parsed !== null && 'permissionProfile' in parsed
      ? (parsed as { permissionProfile?: unknown }).permissionProfile
      : undefined,
  );
  const defaults = getBuiltInToolsSecurityConfigForProfile(permissionProfile);
  const shellExecute = typeof parsed === 'object' && parsed !== null && 'shellExecute' in parsed
    ? (parsed as { shellExecute?: unknown }).shellExecute
    : undefined;
  const fileRead = typeof parsed === 'object' && parsed !== null && 'fileRead' in parsed
    ? (parsed as { fileRead?: unknown }).fileRead
    : undefined;
  const managedMcpServerAdmin = typeof parsed === 'object' && parsed !== null && 'managedMcpServerAdmin' in parsed
    ? (parsed as { managedMcpServerAdmin?: unknown }).managedMcpServerAdmin
    : undefined;

  return applyPermissionProfileGuards({
    permissionProfile,
    shellExecute: {
      enabled: parseBooleanValue(
        typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { enabled?: unknown }).enabled : undefined,
        defaults.shellExecute.enabled,
      ),
      allowedExecutableNames: (() => {
        const list = parseStringList(
          typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { allowedExecutableNames?: unknown }).allowedExecutableNames : undefined,
        );
        return list.length > 0 ? list : defaults.shellExecute.allowedExecutableNames;
      })(),
      allowedWorkingDirectories: (() => {
        const list = parseStringList(
          typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { allowedWorkingDirectories?: unknown }).allowedWorkingDirectories : undefined,
        );
        return list.length > 0 ? list : defaults.shellExecute.allowedWorkingDirectories;
      })(),
      allowPipes: typeof shellExecute === 'object' && shellExecute !== null && 'allowPipes' in shellExecute
        ? parseBooleanValue((shellExecute as { allowPipes?: unknown }).allowPipes, defaults.shellExecute.allowPipes)
        : !parseBooleanValue(
          typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { blockPipes?: unknown }).blockPipes : undefined,
          !defaults.shellExecute.allowPipes,
        ),
      allowRedirection: typeof shellExecute === 'object' && shellExecute !== null && 'allowRedirection' in shellExecute
        ? parseBooleanValue((shellExecute as { allowRedirection?: unknown }).allowRedirection, defaults.shellExecute.allowRedirection)
        : !parseBooleanValue(
          typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { blockRedirection?: unknown }).blockRedirection : undefined,
          !defaults.shellExecute.allowRedirection,
        ),
      allowNetworkCommands: typeof shellExecute === 'object' && shellExecute !== null && 'allowNetworkCommands' in shellExecute
        ? parseBooleanValue((shellExecute as { allowNetworkCommands?: unknown }).allowNetworkCommands, defaults.shellExecute.allowNetworkCommands)
        : !parseBooleanValue(
          typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { blockNetworkCommands?: unknown }).blockNetworkCommands : undefined,
          !defaults.shellExecute.allowNetworkCommands,
        ),
      allowInlineScripts: parseBooleanValue(
        typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { allowInlineScripts?: unknown }).allowInlineScripts : undefined,
        defaults.shellExecute.allowInlineScripts,
      ),
      allowPathsOutsideWorkspace: parseBooleanValue(
        typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { allowPathsOutsideWorkspace?: unknown }).allowPathsOutsideWorkspace : undefined,
        defaults.shellExecute.allowPathsOutsideWorkspace,
      ),
      sandboxExecution: parseBooleanValue(
        typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { sandboxExecution?: unknown }).sandboxExecution : undefined,
        defaults.shellExecute.sandboxExecution,
      ),
      maxCommandLength: parsePositiveNumber(
        typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { maxCommandLength?: unknown }).maxCommandLength : undefined,
        defaults.shellExecute.maxCommandLength,
      ),
      maxTimeoutSeconds: parsePositiveNumber(
        typeof shellExecute === 'object' && shellExecute !== null ? (shellExecute as { maxTimeoutSeconds?: unknown }).maxTimeoutSeconds : undefined,
        defaults.shellExecute.maxTimeoutSeconds,
      ),
    },
    fileRead: {
      enabled: parseBooleanValue(
        typeof fileRead === 'object' && fileRead !== null ? (fileRead as { enabled?: unknown }).enabled : undefined,
        defaults.fileRead.enabled,
      ),
      allowRelativePaths: parseBooleanValue(
        typeof fileRead === 'object' && fileRead !== null ? (fileRead as { allowRelativePaths?: unknown }).allowRelativePaths : undefined,
        defaults.fileRead.allowRelativePaths,
      ),
      allowedPaths: parseStringList(
        typeof fileRead === 'object' && fileRead !== null ? (fileRead as { allowedPaths?: unknown }).allowedPaths : undefined,
      ),
      maxBytesPerRead: parsePositiveNumber(
        typeof fileRead === 'object' && fileRead !== null ? (fileRead as { maxBytesPerRead?: unknown }).maxBytesPerRead : undefined,
        defaults.fileRead.maxBytesPerRead,
      ),
      maxFileSizeBytes: parsePositiveNumber(
        typeof fileRead === 'object' && fileRead !== null ? (fileRead as { maxFileSizeBytes?: unknown }).maxFileSizeBytes : undefined,
        defaults.fileRead.maxFileSizeBytes,
      ),
    },
    managedMcpServerAdmin: {
      enabled: parseBooleanValue(
        typeof managedMcpServerAdmin === 'object' && managedMcpServerAdmin !== null ? (managedMcpServerAdmin as { enabled?: unknown }).enabled : undefined,
        defaults.managedMcpServerAdmin.enabled,
      ),
      allowHttpServers: parseBooleanValue(
        typeof managedMcpServerAdmin === 'object' && managedMcpServerAdmin !== null ? (managedMcpServerAdmin as { allowHttpServers?: unknown }).allowHttpServers : undefined,
        defaults.managedMcpServerAdmin.allowHttpServers,
      ),
      allowStdioServers: parseBooleanValue(
        typeof managedMcpServerAdmin === 'object' && managedMcpServerAdmin !== null ? (managedMcpServerAdmin as { allowStdioServers?: unknown }).allowStdioServers : undefined,
        defaults.managedMcpServerAdmin.allowStdioServers,
      ),
      sandboxStdioServers: parseBooleanValue(
        typeof managedMcpServerAdmin === 'object' && managedMcpServerAdmin !== null ? (managedMcpServerAdmin as { sandboxStdioServers?: unknown }).sandboxStdioServers : undefined,
        defaults.managedMcpServerAdmin.sandboxStdioServers,
      ),
      allowedStdioServerCommands: parseStringList(
        typeof managedMcpServerAdmin === 'object' && managedMcpServerAdmin !== null ? (managedMcpServerAdmin as { allowedStdioServerCommands?: unknown }).allowedStdioServerCommands : undefined,
      ),
    },
  });
}

export function loadManagedClientFileConfig(): ManagedClientFileConfig {
  const configPath = getManagedClientConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = stripBom(fs.readFileSync(configPath, 'utf-8'));
  const parsed = JSON.parse(raw) as ManagedClientFileConfig;
  return parsed ?? {};
}

export function saveManagedClientFileConfig(config: ManagedClientFileConfig): void {
  const current = loadManagedClientFileConfig();
  const next = {
    ...current,
    ...config,
  };

  const sanitized = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  );

  fs.writeFileSync(getManagedClientConfigPath(), JSON.stringify(sanitized, null, 2), 'utf-8');
}

export function isDemoMode(args: string[] = process.argv): boolean {
  return args.includes('--demo');
}

export function getBuiltInToolsSecurityConfig(): BuiltInToolsSecurityConfig {
  // Demo mode: bypass all security \u2014 return fully open config.
  if (isDemoMode()) {
    return getBuiltInToolsSecurityConfigForProfile('demo');
  }

  const config = normalizeBuiltInToolsSecurityConfig(loadManagedClientFileConfig().builtInTools);
  const defaults = getBuiltInToolsSecurityConfigForProfile(config.permissionProfile);

  // 如果用户未配置白名单（空数组），使用 profile 默认值
  const execNames = config.shellExecute.allowedExecutableNames.length === 0
    ? defaults.shellExecute.allowedExecutableNames
    : config.shellExecute.allowedExecutableNames;

  // 运行时填充默认工作目录（如果用户未配置）
  let workDirs = config.shellExecute.allowedWorkingDirectories;
  if (workDirs.length === 0) {
    const os = require('node:os');
    const p = require('node:path');
    workDirs = [os.homedir(), os.tmpdir(), p.resolve(process.cwd())];
  }

  return {
    ...config,
    shellExecute: {
      ...config.shellExecute,
      allowedExecutableNames: execNames,
      allowedWorkingDirectories: workDirs,
    },
  };
}

export function saveBuiltInToolsSecurityConfig(config: BuiltInToolsSecurityConfig): void {
  saveManagedClientFileConfig({
    builtInTools: serializeBuiltInToolsSecurityConfig(normalizeBuiltInToolsSecurityConfig(config)),
  });
}

export function getToolCallApprovalMode(): ToolCallApprovalMode {
  return loadManagedClientFileConfig().toolCallApprovalMode ?? 'manual';
}

export function setToolCallApprovalMode(mode: ToolCallApprovalMode): void {
  saveManagedClientFileConfig({ toolCallApprovalMode: mode });
}

function loadManagedClientMcpFileConfig(): Record<string, ManagedClientFileMcpServerConfig> {
  const configPath = getManagedClientMcpConfigPath();
  if (fs.existsSync(configPath)) {
    const raw = stripBom(fs.readFileSync(configPath, 'utf-8'));
    const parsed = JSON.parse(raw) as unknown;
    return normalizeManagedClientMcpServers(parsed);
  }

  return loadManagedClientFileConfig().mcpServers ?? {};
}

function saveManagedClientMcpFileConfig(mcpServers: Record<string, ManagedClientFileMcpServerConfig>): void {
  fs.writeFileSync(
    getManagedClientMcpConfigPath(),
    JSON.stringify(mcpServers, null, 2),
    'utf-8',
  );
}

function removeLegacyManagedClientMcpServersConfig(): void {
  const current = loadManagedClientFileConfig();
  if (!('mcpServers' in current)) {
    return;
  }

  const { mcpServers: _legacyMcpServers, ...rest } = current;
  const next = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  );

  fs.writeFileSync(getManagedClientConfigPath(), JSON.stringify(next, null, 2), 'utf-8');
}

export function getManagedClientMcpServersConfig(): Record<string, ManagedClientFileMcpServerConfig> {
  return loadManagedClientMcpFileConfig();
}

/**
 * Returns the effective MCP servers for display purposes, including built-in
 * injected servers (e.g. computer-use) that are not stored in mcp-servers.json.
 */
export function getEffectiveMcpServersForDisplay(): Record<string, ManagedClientFileMcpServerConfig> {
  const userMcpConfig = loadManagedClientMcpFileConfig();
  const fileConfig = loadManagedClientFileConfig();
  const disableComputerUse =
    parseBooleanFlag(process.env.DISABLE_COMPUTER_USE)
    || fileConfig.enableComputerUse === false;
  const shouldInjectComputerUse = !disableComputerUse && !userMcpConfig['computer-use'] && isPythonAvailable();

  const disablePptxEditor =
    parseBooleanFlag(process.env.DISABLE_PPTX_EDITOR);
  const shouldInjectPptxEditor = !disablePptxEditor && !userMcpConfig['pptx-editor'] && isPptxEditorPythonAvailable();

  const injected: Record<string, ManagedClientFileMcpServerConfig> = {};

  if (shouldInjectComputerUse) {
    injected['computer-use'] = {
      command: getPythonCommand(),
      args: ['-m', 'landgod_computer_use'],
      env: { PYTHONPATH: getComputerUsePythonPath() },
      tools: ['computer_screenshot', 'computer_click', 'computer_type', 'computer_scroll'],
      trustLevel: 'trusted' as const,
      publishedRemotely: true,
      enabled: true,
    };
  }

  if (shouldInjectPptxEditor) {
    injected['pptx-editor'] = {
      command: getPptxEditorPythonCommand(),
      args: ['-m', 'landgod_pptx_editor'],
      env: { PYTHONPATH: getPptxEditorPythonPath() },
      tools: [...PPTX_EDITOR_TOOL_NAMES],
      trustLevel: 'trusted' as const,
      publishedRemotely: true,
      enabled: true,
    };
  }

  if (Object.keys(injected).length === 0) return userMcpConfig;
  return {
    ...injected,
    ...userMcpConfig,
  };
}

export function saveManagedClientMcpServersConfig(mcpServers: Record<string, ManagedClientFileMcpServerConfig>): void {
  saveManagedClientMcpFileConfig(mcpServers);
  removeLegacyManagedClientMcpServersConfig();
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumberFlag(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getArgValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }

  return undefined;
}

function hasArg(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseManagedClientMode(value: string | undefined | null): ManagedClientMode | null {
  if (!value) {
    return null;
  }

  if (value === 'managed-client-mcp-ws') {
    return value;
  }

  return null;
}

function normalizeManagedClientToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^Bearer\s+/i, '').trim();
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function getOrCreateManagedClientId(fileConfig: ManagedClientFileConfig): string {
  if (fileConfig.clientId?.trim()) {
    return fileConfig.clientId.trim();
  }

  const clientId = randomUUID();
  saveManagedClientFileConfig({ clientId });
  return clientId;
}

export function getManagedClientWorkspaceRoot(args = process.argv): string {
  const fileConfig = loadManagedClientFileConfig();
  const workspaceRoot =
    getArgValue(args, '--managed-client-workspace-root')
    ?? process.env.MANAGED_CLIENT_WORKSPACE_ROOT
    ?? fileConfig.workspaceRoot
    ?? getDefaultManagedClientWorkspaceRoot();

  return path.resolve(workspaceRoot);
}

// --- Built-in computer-use Python detection ---

/**
 * Resolve the path to the bundled mcp-servers directory.
 * In development: <project-root>/mcp-servers
 * In packaged app: <resources>/mcp-servers (extraResource)
 */
function getMcpServersPath(): string {
  // When packaged with electron-forge, app.isPackaged is true and
  // process.resourcesPath points to the resources dir where extraResource files live.
  // In dev mode, we use process.cwd() (project root).
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'mcp-servers');
    }
  } catch {
    // Not running in Electron (e.g. headless-entry.js with plain Node)
  }
  return path.join(process.cwd(), 'mcp-servers');
}

/**
 * Get the path to the computer-use Python package directory.
 */
function getComputerUsePythonPath(): string {
  return path.join(getMcpServersPath(), 'computer-use');
}

let cachedPythonCommand: string | false | undefined;

/**
 * Detect which python command is available (python3 or python).
 * Also verifies that landgod_computer_use module is importable.
 * Result is cached for the process lifetime.
 */
function getPythonCommand(): string {
  if (cachedPythonCommand !== undefined) {
    return cachedPythonCommand as string;
  }
  // This should only be called after isPythonAvailable() returns true
  detectPython();
  return cachedPythonCommand as unknown as string;
}

function isPythonAvailable(): boolean {
  if (cachedPythonCommand !== undefined) {
    return cachedPythonCommand !== false;
  }
  return detectPython();
}

function detectPython(): boolean {
  const computerUsePath = getComputerUsePythonPath();
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  console.log('[config] detectPython: computerUsePath =', computerUsePath);
  for (const cmd of candidates) {
    try {
      // Use sys.executable to capture the real .exe path (avoids .bat shim issues on Windows)
      const out = execSync(
        `${cmd} -c "import landgod_computer_use; import sys; print(sys.executable)"`,
        {
          timeout: 5000,
          stdio: 'pipe',
          env: { ...process.env, PYTHONPATH: computerUsePath },
        },
      );
      cachedPythonCommand = out.toString().trim();
      console.log('[config] detectPython: found', cachedPythonCommand);
      return true;
    } catch (err: any) {
      const msg = (err?.stderr?.toString() || err?.message || '').slice(0, 200);
      console.log('[config] detectPython: failed for', cmd, '-', msg);
    }
  }
  cachedPythonCommand = false;
  return false;
}

export function getManagedClientRuntimeConfig(version: string, args = process.argv): ManagedClientRuntimeConfig {
  const fileConfig = loadManagedClientFileConfig();
  const explicitMode =
    parseManagedClientMode(getArgValue(args, '--managed-client-mode'))
    ?? parseManagedClientMode(process.env.MANAGED_CLIENT_MODE)
    ?? parseManagedClientMode(fileConfig.mode)
    ?? null;

  const wsManagedMode =
    explicitMode === 'managed-client-mcp-ws'
    || hasArg(args, '--enable-managed-client-mcp-ws')
    || hasArg(args, '--managed-client-mcp-ws-only');

  const enabled = wsManagedMode
    || parseBooleanFlag(process.env.ENABLE_MANAGED_CLIENT_RUNTIME)
    || fileConfig.enabled === true;
  const mode: ManagedClientMode = 'managed-client-mcp-ws';
  const headless = hasArg(args, '--managed-client-mcp-ws-only');
  const demo = isDemoMode(args);
  const baseUrl =
    getArgValue(args, '--managed-client-base-url')
    ?? fileConfig.bootstrapBaseUrl
    ?? process.env.MANAGED_CLIENT_BASE_URL
    ?? fileConfig.baseUrl
    ?? null;
  const signinPageUrl =
    getArgValue(args, '--managed-client-signin-page-url')
    ?? process.env.MANAGED_CLIENT_SIGNIN_PAGE_URL
    ?? fileConfig.signinPageUrl
    ?? null;
  const tlsServername =
    getArgValue(args, '--managed-client-tls-servername')
    ?? process.env.MANAGED_CLIENT_TLS_SERVERNAME
    ?? fileConfig.tlsServername
    ?? null;
  const workspaceRoot = getManagedClientWorkspaceRoot(args);
  const token = normalizeManagedClientToken(
    getArgValue(args, '--managed-client-token') ?? process.env.MANAGED_CLIENT_BEARER_TOKEN ?? fileConfig.token ?? null,
  );
  const clientId = getArgValue(args, '--managed-client-id') ?? process.env.MANAGED_CLIENT_ID ?? getOrCreateManagedClientId(fileConfig);
  const clientName = getArgValue(args, '--managed-client-name') ?? process.env.MANAGED_CLIENT_NAME ?? fileConfig.clientName ?? os.hostname();
  const pollWaitSeconds = parseNumberFlag(
    getArgValue(args, '--managed-client-wait-seconds') ?? process.env.MANAGED_CLIENT_WAIT_SECONDS ?? String(fileConfig.pollWaitSeconds ?? ''),
    20,
  );
  const retryDelayMs = parseNumberFlag(
    getArgValue(args, '--managed-client-retry-ms') ?? process.env.MANAGED_CLIENT_RETRY_MS ?? String(fileConfig.retryDelayMs ?? ''),
    3000,
  );
  const userMcpConfig = loadManagedClientMcpFileConfig();

  // Built-in computer-use MCP server: enabled by default if Python is available.
  // Can be disabled via --disable-computer-use flag, DISABLE_COMPUTER_USE env var,
  // or enableComputerUse: false in managed-client.config.json.
  // User-defined 'computer-use' in mcp-servers.json always takes precedence.
  const disableComputerUse =
    hasArg(args, '--disable-computer-use')
    || parseBooleanFlag(process.env.DISABLE_COMPUTER_USE)
    || fileConfig.enableComputerUse === false;

  const shouldInjectComputerUse = !disableComputerUse && !userMcpConfig['computer-use'] && isPythonAvailable();
  console.log('[config] getManagedClientRuntimeConfig computer-use:', { disableComputerUse, hasUserComputerUse: Boolean(userMcpConfig['computer-use']), pythonAvailable: isPythonAvailable(), shouldInject: shouldInjectComputerUse });

  // Built-in shiproom MCP server: auto-injected when server.py + Python are available.
  // Can be disabled via --disable-shiproom flag or DISABLE_SHIPROOM env var.
  // User-defined 'shiproom' in mcp-servers.json always takes precedence.
  const disableShiproom =
    hasArg(args, '--disable-shiproom')
    || parseBooleanFlag(process.env.DISABLE_SHIPROOM);

  const shouldInjectShiproom = !disableShiproom && !userMcpConfig['shiproom'] && isShiproomPythonAvailable();
  console.log('[config] getManagedClientRuntimeConfig shiproom:', { disableShiproom, hasUserShiproom: Boolean(userMcpConfig['shiproom']), pythonAvailable: isShiproomPythonAvailable(), shouldInject: shouldInjectShiproom });

  const injectedConfigs: Record<string, ManagedClientFileMcpServerConfig> = {};
  if (shouldInjectComputerUse) {
    injectedConfigs['computer-use'] = {
      command: getPythonCommand(),
      args: ['-m', 'landgod_computer_use'],
      env: { PYTHONPATH: getComputerUsePythonPath() },
      tools: ['computer_screenshot', 'computer_click', 'computer_type', 'computer_scroll'],
      trustLevel: 'trusted' as const,
      publishedRemotely: true,
      enabled: true,
      requiredPermissionProfile: 'command-only' as const,
    };
  }
  if (shouldInjectShiproom) {
    injectedConfigs['shiproom'] = {
      command: getShiproomPythonCommand(),
      args: [getShiproomServerPath()],
      env: getShiproomEnv(),
      tools: [...SHIPROOM_TOOL_NAMES],
      trustLevel: 'trusted' as const,
      publishedRemotely: true,
      enabled: true,
      requiredPermissionProfile: 'full-local-admin' as const,
    };
  }

  // Built-in pptx-editor MCP server: auto-injected on Windows when Python + pywin32 available.
  const disablePptxEditor =
    hasArg(args, '--disable-pptx-editor')
    || parseBooleanFlag(process.env.DISABLE_PPTX_EDITOR);

  const shouldInjectPptxEditor = !disablePptxEditor && !userMcpConfig['pptx-editor'] && isPptxEditorPythonAvailable();
  console.log('[config] getManagedClientRuntimeConfig pptx-editor:', { disablePptxEditor, hasUserPptxEditor: Boolean(userMcpConfig['pptx-editor']), pythonAvailable: isPptxEditorPythonAvailable(), shouldInject: shouldInjectPptxEditor });

  if (shouldInjectPptxEditor) {
    injectedConfigs['pptx-editor'] = {
      command: getPptxEditorPythonCommand(),
      args: ['-m', 'landgod_pptx_editor'],
      env: { PYTHONPATH: getPptxEditorPythonPath(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      tools: [...PPTX_EDITOR_TOOL_NAMES],
      trustLevel: 'trusted' as const,
      publishedRemotely: true,
      enabled: true,
      requiredPermissionProfile: 'command-only' as const,
    };
  }

  const effectiveMcpConfig: Record<string, ManagedClientFileMcpServerConfig> = {
    ...injectedConfigs,
    ...userMcpConfig,
  };

  const mcpServers = parseManagedClientMcpServers(effectiveMcpConfig);

  return {
    mode,
    enabled,
    headless,
    demo,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
    signinPageUrl: signinPageUrl ? signinPageUrl.replace(/\/+$/, '') : null,
    tlsServername: normalizeOptionalString(tlsServername),
    workspaceRoot,
    token,
    clientId,
    clientName,
    labels: fileConfig.labels || {},
    pollWaitSeconds,
    retryDelayMs,
    version,
    supportedCommands: ['run_command', 'read_file'],
    mcpServers,
  };
}