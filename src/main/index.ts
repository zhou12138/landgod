import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer, stopServer, isServerRunning, emitServerEvent } from './server';
import { registerIpcHandlers, getPort } from './ipc/handlers';
import { activityLogger, type ActivityEntry } from './activity/logger';
import { auditLogger } from './audit/logger';
import { createT, type Locale } from '../i18n';
import { SessionManager } from './session/manager';
import { ManagedClientMcpWsRuntime, validateManagedClientTlsConfig } from './managed-client/mcp-ws-runtime';
import { registerManagedMcpServerApplyHook } from './managed-client/admin-tools';
import { startManagedClientSignin, type ManagedClientSigninResult } from './managed-client/signin';
import { getManagedClientWorkspacePaths } from './managed-client/workspace';
import {
  getBuiltInToolsSecurityConfig,
  getManagedClientMcpServersConfig,
  getEffectiveMcpServersForDisplay,
  getManagedClientRuntimeConfig,
  getManagedClientWorkspaceRoot,
  loadManagedClientFileConfig,
  saveBuiltInToolsSecurityConfig,
  saveManagedClientFileConfig,
  saveManagedClientMcpServersConfig,
  getToolCallApprovalMode,
  setToolCallApprovalMode,
} from './managed-client/config';
import type { ToolCallApprovalMode } from './managed-client/config';
import { parseManagedClientMcpServers, type ManagedClientFileMcpServerConfig } from './managed-client/mcp-server-config';
import { ManagedClientMcpToolRegistry } from './managed-client/mcp-tool-registry';
import type { ManagedClientMode, ManagedClientRuntimeConfig } from './managed-client/types';
import type { BuiltInToolsSecurityConfig } from './builtin-tools/types';

// Handle Squirrel.Windows install/uninstall events inline
// (replaces electron-squirrel-startup to avoid bundling issues)
if (process.platform === 'win32') {
  const cmd = process.argv[1];
  if (cmd === '--squirrel-install' || cmd === '--squirrel-updated' || cmd === '--squirrel-uninstall' || cmd === '--squirrel-obsolete') {
    app.quit();
  }
}

function configureElectronStoragePaths(): void {
  // Keep Chromium cache in a known writable location to avoid AccessDenied cache errors on Windows.
  const baseDir = process.env.LANDGOD_DATA_DIR?.trim()
    ? path.resolve(process.env.LANDGOD_DATA_DIR)
    : path.resolve(process.cwd(), '.landgod-data');
  const sessionDir = path.join(baseDir, 'session');
  const cacheDir = path.join(sessionDir, 'Cache');

  fs.mkdirSync(cacheDir, { recursive: true });

  app.setPath('userData', baseDir);
  app.setPath('sessionData', sessionDir);
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
}

configureElectronStoragePaths();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const MCP_REPUBLISH_WAIT_TIMEOUT_MS = 4000;

async function awaitManagedMcpRepublishWithTimeout(
  republishOperation: Promise<{
    applied: boolean;
    toolCount: number;
    tools: string[];
    reason?: 'runtime-inactive' | 'bridge-not-ready';
  }>,
): Promise<{
  applied: boolean;
  toolCount: number;
  tools: string[];
  reason?: 'runtime-inactive' | 'bridge-not-ready' | 'republish-pending';
}> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      republishOperation,
      new Promise<{
        applied: boolean;
        toolCount: number;
        tools: string[];
        reason: 'republish-pending';
      }>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve({
            applied: false,
            toolCount: 0,
            tools: [],
            reason: 'republish-pending',
          });
        }, MCP_REPUBLISH_WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

// Detect system locale for main process
function getMainLocale(): Locale {
  const lang = app.getLocale();
  if (lang.startsWith('zh')) return 'zh-CN';
  return 'en';
}

const t = createT(getMainLocale());

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function shouldOpenDevTools(): boolean {
  const flag = process.env.CLI_SERVER_OPEN_DEVTOOLS;
  if (!flag) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(flag.toLowerCase());
}

function createWindow(): void {
  const devUrlCandidates: string[] = [];
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    devUrlCandidates.push(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    try {
      const parsed = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.protocol.startsWith('http')) {
        for (let port = 5173; port <= 5183; port += 1) {
          const candidate = `${parsed.protocol}//${parsed.hostname}:${port}/`;
          if (!devUrlCandidates.includes(candidate)) {
            devUrlCandidates.push(candidate);
          }
        }
      }
    } catch {
      // Ignore malformed dev URL and let the default load path handle it.
    }
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    title: t('app.title'),
    webPreferences: {
      preload: path.join(__dirname, `preload.js`),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let devUrlIndex = 0;
  const loadDevUrl = () => {
    if (!mainWindow) {
      return;
    }

    const url = devUrlCandidates[devUrlIndex];
    if (!url) {
      return;
    }

    void mainWindow.loadURL(url).catch((error) => {
      console.error('[main] Failed to load renderer dev URL', { url, error: String(error) });
    });
  };

  const showRendererLoadFailurePage = (message: string) => {
    if (!mainWindow) {
      return;
    }

    const escapedMessage = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const fallbackHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Renderer Load Failed</title>
    <style>
      body { margin: 0; font-family: Segoe UI, sans-serif; background: #020617; color: #e2e8f0; }
      .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: min(920px, 100%); border: 1px solid #1e293b; background: rgba(15, 23, 42, 0.9); border-radius: 12px; padding: 20px; }
      h1 { margin: 0 0 10px; font-size: 20px; }
      p { margin: 0 0 12px; color: #94a3b8; }
      code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; color: #cbd5e1; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Renderer failed to load</h1>
        <p>The desktop UI could not connect to the renderer dev server. Restart onboarding and try UI mode again.</p>
        <code>${escapedMessage}</code>
      </div>
    </div>
  </body>
</html>`;

    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml)}`);
  };

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      console.error('[main] Renderer failed to load', { errorCode, errorDescription, validatedURL });
      return;
    }

    console.error('[main] Renderer dev URL failed to load', {
      errorCode,
      errorDescription,
      validatedURL,
      attemptedIndex: devUrlIndex,
    });

    if (devUrlIndex < devUrlCandidates.length - 1) {
      devUrlIndex += 1;
      setTimeout(() => {
        loadDevUrl();
      }, 300);
      return;
    }

    const attemptedUrls = devUrlCandidates.join(', ');
    showRendererLoadFailurePage(`Attempted renderer URLs: ${attemptedUrls}\nLast error: ${errorCode} ${errorDescription}`);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    loadDevUrl();
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Always open DevTools in dev mode, or if explicitly requested
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL || shouldOpenDevTools()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of quitting
    if (tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(isManagedClientMode: boolean): void {
  // Create a simple 16x16 tray icon
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(t('app.title'));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('tray.show'),
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: isManagedClientMode ? t('tray.managedClientMode') : t('tray.serverRunning', { port: getPort() }),
      enabled: false,
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: () => {
        tray?.destroy();
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

const sessionManager = new SessionManager();
type ManagedClientRuntimeInstance = ManagedClientMcpWsRuntime;

let managedClientRuntime: ManagedClientRuntimeInstance | null = null;
let managedClientConfig = getManagedClientRuntimeConfig(app.getVersion());
let managedClientSessionToken: string | null = null;
let managedClientIdentityOverride: { label: string; detail: string | null } | null = null;
let currentMode: 'cli-server' | ManagedClientMode = managedClientConfig.enabled ? managedClientConfig.mode : 'cli-server';
let needsModeSelection = false;
let managedClientSigninPromise: Promise<ManagedClientSigninResult> | null = null;
let managedClientSigninAbort: AbortController | null = null;

function appendActivity(
  area: string,
  action: string,
  summary: string,
  status: ActivityEntry['status'] = 'success',
  details?: Record<string, unknown>,
): void {
  const entry: ActivityEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    area,
    action,
    summary,
    status,
    details,
  };

  activityLogger.appendEntry(entry);
  emitServerEvent('activity:appended', { id: entry.id });
}

async function stopManagedClientRuntime(): Promise<void> {
  const runtime = managedClientRuntime;
  if (!runtime) {
    return;
  }

  managedClientRuntime = null;
  await runtime.stopAndWait();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function firstStringClaim(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) {
    return null;
  }

  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getManagedClientSessionIdentity(token: string | null): {
  label: string | null;
  detail: string | null;
} {
  const normalizedToken = token?.trim();
  if (!normalizedToken) {
    return managedClientIdentityOverride ?? { label: null, detail: null };
  }

  // Priority 1: identity from signin callback (works with non-JWT tokens)
  if (managedClientIdentityOverride) {
    return managedClientIdentityOverride;
  }

  // Priority 2: decode standard JWT payload
  const payload = decodeJwtPayload(normalizedToken);
  const username = firstStringClaim(payload, ['preferred_username', 'email', 'upn']);
  const displayName = firstStringClaim(payload, ['name', 'given_name']);
  const subject = firstStringClaim(payload, ['sub']);

  if (username) {
    return {
      label: username,
      detail: displayName && displayName !== username ? displayName : null,
    };
  }

  if (displayName) {
    return {
      label: displayName,
      detail: subject && subject !== displayName ? subject : null,
    };
  }

  if (subject) {
    return {
      label: subject,
      detail: null,
    };
  }

  return {
    label: null,
    detail: null,
  };
}

function canClearAuditHistory(): boolean {
  if (currentMode !== 'managed-client-mcp-ws') {
    return true;
  }

  return Boolean(managedClientSessionToken) || Boolean(managedClientRuntime?.getStatus().running);
}

// Session notification setting
let sessionNotificationEnabled = true;

function buildBootstrapState() {
  const runtimeStatus = managedClientRuntime?.getStatus();
  const mcpWsStatus = managedClientRuntime instanceof ManagedClientMcpWsRuntime
    ? managedClientRuntime.getStatus()
    : null;
  const workspacePaths = getManagedClientWorkspacePaths(managedClientConfig.workspaceRoot);
  const sessionIdentity = getManagedClientSessionIdentity(managedClientSessionToken);

  return {
    mode: currentMode,
    headless: managedClientConfig.headless,
    baseUrl: managedClientConfig.baseUrl,
    signinPageUrl: managedClientConfig.signinPageUrl,
    tlsServername: managedClientConfig.tlsServername,
    workspaceRoot: workspacePaths.rootDir,
    workspaceDirectory: workspacePaths.workDir,
    needsModeSelection,
    needsBaseUrl: currentMode !== 'cli-server' && !managedClientConfig.headless && !needsModeSelection && !(runtimeStatus?.running ?? false),
    running: runtimeStatus?.running ?? false,
    sessionAuthenticated: Boolean(managedClientSessionToken) || Boolean(runtimeStatus?.running),
    clientId: runtimeStatus?.clientId ?? managedClientConfig.clientId,
    connectionId: mcpWsStatus?.connectionId ?? null,
    sessionIdentityLabel: sessionIdentity.label,
    sessionIdentityDetail: sessionIdentity.detail,
    pullStatus: mcpWsStatus?.pullStatus ?? 'idle',
    pulledTaskCount: mcpWsStatus?.pulledTaskCount ?? 0,
    emptyPollCount: mcpWsStatus?.emptyPollCount ?? 0,
    lastPollStatus: mcpWsStatus?.lastPollStatus ?? null,
    lastTaskCommand: mcpWsStatus?.lastTaskCommand ?? null,
    lastPolledAt: mcpWsStatus?.lastPolledAt ?? null,
    receivedEventCount: mcpWsStatus?.receivedEventCount ?? 0,
    pingCount: mcpWsStatus?.pingCount ?? 0,
    pongSentCount: mcpWsStatus?.pongSentCount ?? 0,
    lastEventAt: mcpWsStatus?.lastEventAt ?? null,
    lastEventName: mcpWsStatus?.lastEventName ?? null,
    lastPingAt: mcpWsStatus?.lastPingAt ?? null,
  };
}

function createManagedClientRuntime(config: ManagedClientRuntimeConfig): ManagedClientRuntimeInstance {
  const runtime = new ManagedClientMcpWsRuntime(config, sessionManager);
  runtime.onActivity = appendActivity;
  return runtime;
}

async function ensureServerStarted(): Promise<void> {
  if (isServerRunning()) {
    return;
  }

  await startServer(getPort(), sessionManager);
}

function refreshTray(): void {
  if (!tray) {
    return;
  }

  tray.destroy();
  tray = null;
  createTray(currentMode !== 'cli-server');
}

app.whenReady().then(async () => {
  managedClientConfig = getManagedClientRuntimeConfig(app.getVersion());
  currentMode = managedClientConfig.enabled ? managedClientConfig.mode : 'cli-server';
  // Only ask for mode selection if no mode is saved yet in the file config
  const fileConfig = loadManagedClientFileConfig();
  needsModeSelection = !managedClientConfig.headless && !fileConfig.enabled && !fileConfig.mode;
  registerManagedMcpServerApplyHook(async () => {
    managedClientConfig = {
      ...getManagedClientRuntimeConfig(app.getVersion()),
      token: managedClientSessionToken,
    };

    if (!(managedClientRuntime instanceof ManagedClientMcpWsRuntime)) {
      return {
        applied: false,
        toolCount: 0,
        tools: [],
        reason: 'runtime-inactive' as const,
      };
    }

    return managedClientRuntime.updateMcpServers(managedClientConfig.mcpServers);
  });

  // Initialize audit logger
  auditLogger.init();
  activityLogger.init();

  ipcMain.handle('activity:getEntries', (_e, options?: { offset?: number; limit?: number; search?: string }) => {
    return activityLogger.getEntries(options);
  });

  ipcMain.handle('activity:clear', () => {
    activityLogger.clear();
    return { success: true };
  });

  // IPC for notification setting
  ipcMain.handle('settings:getNotification', () => sessionNotificationEnabled);
  ipcMain.handle('settings:setNotification', (_e, enabled: boolean) => {
    sessionNotificationEnabled = enabled;
    appendActivity('settings', 'set-notification', enabled ? 'Enabled activity notifications' : 'Disabled activity notifications', 'success', { enabled });
    return sessionNotificationEnabled;
  });

  // IPC for tool call approval setting
  ipcMain.handle('settings:getToolCallApprovalMode', () => getToolCallApprovalMode());
  ipcMain.handle('settings:setToolCallApprovalMode', (_e, mode: ToolCallApprovalMode) => {
    setToolCallApprovalMode(mode);
    appendActivity('settings', 'set-tool-call-approval', `Tool call approval mode set to: ${mode}`, 'success', { mode });
    return getToolCallApprovalMode();
  });

  // IPC for tool call approval responses from renderer
  ipcMain.handle('tool-approval:respond', (_e, requestId: string, decision: 'approve-once' | 'approve-all' | 'reject') => {
    if (managedClientRuntime instanceof ManagedClientMcpWsRuntime) {
      managedClientRuntime.resolveToolCallApproval(requestId, decision);
    }
    const status = decision === 'reject' ? 'error' : 'success';
    const summaryMap = {
      'approve-once': 'Tool call approved (once)',
      'approve-all': 'Tool call approved (all this session)',
      'reject': 'Tool call rejected by user',
    } as const;
    appendActivity('tool-approval', decision, summaryMap[decision], status, { requestId });
  });

  ipcMain.handle('managed-client:getBootstrapState', () => buildBootstrapState());
  ipcMain.handle('managed-client:validateTls', async (_e, payload: {
    baseUrl: string;
    tlsServername?: string | null;
  }) => validateManagedClientTlsConfig({
    baseUrl: payload.baseUrl,
    tlsServername: payload.tlsServername ?? null,
  }));
  ipcMain.handle('managed-client:getMcpServersConfig', () => ({
    mcpServers: getEffectiveMcpServersForDisplay(),
  }));
  ipcMain.handle('built-in-tools:getSecurityConfig', () => ({
    config: getBuiltInToolsSecurityConfig(),
  }));
  ipcMain.handle('built-in-tools:saveSecurityConfig', async (_e, payload: { config: BuiltInToolsSecurityConfig }) => {
    saveBuiltInToolsSecurityConfig(payload.config);
    managedClientConfig = {
      ...getManagedClientRuntimeConfig(app.getVersion()),
      token: managedClientSessionToken,
    };

    let applied = false;
    let toolCount = 0;
    let tools: string[] = [];
    let reason: 'runtime-inactive' | 'bridge-not-ready' | undefined;

    if (managedClientRuntime instanceof ManagedClientMcpWsRuntime) {
      const result = await managedClientRuntime.republishTools();
      applied = result.applied;
      toolCount = result.toolCount;
      tools = result.tools;
      reason = result.reason;
    }

    appendActivity('built-in-tools', 'save-security-config', 'Saved built-in tool rules', 'success', {
      permissionProfile: payload.config.permissionProfile,
      applied,
      toolCount,
      tools,
      reason,
    });

    return {
      saved: true,
      config: getBuiltInToolsSecurityConfig(),
      applied,
      toolCount,
      tools,
      reason,
    };
  });
  ipcMain.handle('managed-client:testMcpServersConfig', async (_e, payload: { mcpServers: Record<string, ManagedClientFileMcpServerConfig> }) => {
    const externalServers = parseManagedClientMcpServers(payload.mcpServers);
    const workspacePaths = getManagedClientWorkspacePaths(getManagedClientWorkspaceRoot());
    const results = await ManagedClientMcpToolRegistry.testExternalServers({
      externalServerConfigs: externalServers,
      version: app.getVersion(),
      workspaceRoot: workspacePaths.rootDir,
      defaultWorkingDirectory: workspacePaths.workDir,
    });
    appendActivity('mcp-servers', 'test', 'Tested MCP server configuration', 'info', {
      serverCount: Object.keys(payload.mcpServers).length,
      successCount: results.filter((entry) => entry.success).length,
    });
    return { results };
  });
  ipcMain.handle('managed-client:saveMcpServersConfig', async (_e, payload: {
    mcpServers: Record<string, ManagedClientFileMcpServerConfig>;
    apply?: boolean;
  }) => {
    saveManagedClientMcpServersConfig(payload.mcpServers);
    managedClientConfig = {
      ...getManagedClientRuntimeConfig(app.getVersion()),
      token: managedClientSessionToken,
    };

    let applied = false;
    let toolCount = 0;
    let tools: string[] = [];
    let reason: 'runtime-inactive' | 'bridge-not-ready' | undefined;

    const shouldApply = payload.apply !== false;

    if (shouldApply && managedClientRuntime instanceof ManagedClientMcpWsRuntime) {
      const result = await managedClientRuntime.updateMcpServers(managedClientConfig.mcpServers);
      applied = result.applied;
      toolCount = result.toolCount;
      tools = result.tools;
      reason = result.reason;
    } else if (shouldApply) {
      reason = 'runtime-inactive';
    }

    appendActivity('mcp-servers', 'save', shouldApply ? 'Saved MCP server configuration and requested apply' : 'Saved MCP server configuration', 'success', {
      serverCount: Object.keys(payload.mcpServers).length,
      applied,
      toolCount,
      reason,
    });

    return {
      saved: true,
      applied,
      toolCount,
      tools,
      reason,
    };
  });
  ipcMain.handle('managed-client:refreshMcpTools', async () => {
    managedClientConfig = {
      ...getManagedClientRuntimeConfig(app.getVersion()),
      token: managedClientSessionToken,
    };

    if (!(managedClientRuntime instanceof ManagedClientMcpWsRuntime)) {
      appendActivity('mcp-servers', 'refresh-tools', 'Skipped MCP tool republish because runtime is inactive', 'info');
      return {
        applied: false,
        toolCount: 0,
        tools: [],
      };
    }

    const result = await managedClientRuntime.updateMcpServers(managedClientConfig.mcpServers);
    appendActivity('mcp-servers', 'refresh-tools', 'Republished MCP tools', result.applied ? 'success' : 'info', {
      toolCount: result.toolCount,
      reason: result.reason,
    });
    return result;
  });
  ipcMain.handle('managed-client:selectMode', async (_e, mode: 'cli-server' | ManagedClientMode) => {
    await stopManagedClientRuntime();
    await stopServer();

    saveManagedClientFileConfig({
      enabled: mode !== 'cli-server',
      mode: mode === 'cli-server' ? undefined : mode,
    });
    managedClientConfig = getManagedClientRuntimeConfig(app.getVersion());
    managedClientSessionToken = null;
    currentMode = managedClientConfig.enabled ? managedClientConfig.mode : 'cli-server';
    needsModeSelection = false;

    if (mode === 'cli-server') {
      await ensureServerStarted();
    }

    appendActivity('app', 'select-mode', `Switched app mode to ${mode}`, 'success', { mode });

    refreshTray();
    return buildBootstrapState();
  });
  ipcMain.handle('managed-client:saveBaseUrlAndStart', async (_e, payload: {
    baseUrl: string;
    signinPageUrl?: string | null;
    tlsServername?: string | null;
    token?: string | null;
    persistToken?: boolean;
    identityLabel?: string | null;
    identityDetail?: string | null;
  }) => {
    const normalizedToken = payload.token?.trim();
    const normalizedSigninPageUrl = payload.signinPageUrl?.trim();
    const normalizedTlsServername = payload.tlsServername?.trim();

    await stopManagedClientRuntime();

    saveManagedClientFileConfig({
      bootstrapBaseUrl: payload.baseUrl,
      signinPageUrl: normalizedSigninPageUrl ? normalizedSigninPageUrl : undefined,
      tlsServername: normalizedTlsServername ? normalizedTlsServername : undefined,
      token: payload.persistToken ? normalizedToken ?? undefined : undefined,
    });
    managedClientSessionToken = normalizedToken ? normalizedToken : null;
    managedClientIdentityOverride = payload.identityLabel?.trim()
      ? { label: payload.identityLabel.trim(), detail: payload.identityDetail?.trim() || null }
      : null;
    managedClientConfig = {
      ...getManagedClientRuntimeConfig(app.getVersion()),
      token: managedClientSessionToken,
    };
    currentMode = managedClientConfig.enabled ? managedClientConfig.mode : 'cli-server';
    needsModeSelection = false;

    if (managedClientConfig.enabled) {
      managedClientRuntime = createManagedClientRuntime(managedClientConfig);
      managedClientRuntime.start();
    }

    appendActivity('managed-client', 'save-base-url-and-start', 'Saved managed client connection settings and started runtime', 'success', {
      baseUrl: payload.baseUrl,
      signinPageUrl: normalizedSigninPageUrl || null,
      tlsServername: normalizedTlsServername || null,
      mode: managedClientConfig.mode,
    });

    refreshTray();
    return buildBootstrapState();
  });
  ipcMain.handle('managed-client:signOut', async () => {
    managedClientSessionToken = null;
    managedClientIdentityOverride = null;
    saveManagedClientFileConfig({ token: undefined });
    await stopManagedClientRuntime();
    managedClientSessionToken = null;
    managedClientIdentityOverride = null;
    managedClientConfig = {
      ...getManagedClientRuntimeConfig(app.getVersion()),
      token: null,
    };
    currentMode = managedClientConfig.enabled ? managedClientConfig.mode : 'cli-server';
    needsModeSelection = false;

    appendActivity('managed-client', 'sign-out', 'Signed out of managed client session', 'success');

    refreshTray();
    return buildBootstrapState();
  });
  ipcMain.handle('managed-client:startSignin', async (_e, payload?: { signinPageUrl?: string | null; baseUrl?: string | null }) => {
    if (managedClientSigninPromise) {
      return managedClientSigninPromise;
    }

    const abort = new AbortController();
    managedClientSigninAbort = abort;

    managedClientSigninPromise = startManagedClientSignin({ ...payload, signal: abort.signal }).finally(() => {
      managedClientSigninPromise = null;
      managedClientSigninAbort = null;
    });

    appendActivity('managed-client', 'start-signin', 'Started browser sign-in flow', 'info', {
      baseUrl: payload?.baseUrl ?? null,
      signinPageUrl: payload?.signinPageUrl ?? null,
    });

    appendActivity('managed-client', 'start-signin', 'Started browser sign-in flow', 'info', {
      baseUrl: payload?.baseUrl ?? null,
      signinPageUrl: payload?.signinPageUrl ?? null,
    });

    return managedClientSigninPromise;
  });

  ipcMain.handle('managed-client:cancelSignin', async () => {
    if (managedClientSigninAbort) {
      managedClientSigninAbort.abort();
      managedClientSigninAbort = null;
    }
  });

  if (!managedClientConfig.headless) {
    // Create the browser window
    createWindow();
  }

  // Register IPC handlers
  if (mainWindow) {
    registerIpcHandlers(mainWindow, sessionManager, () => sessionNotificationEnabled, canClearAuditHistory);
  }

  if (!managedClientConfig.headless && currentMode === 'cli-server' && !needsModeSelection) {
    // Start the embedded server
    try {
      await startServer(getPort(), sessionManager);
      console.log(`Server started on port ${getPort()}`);
    } catch (err) {
      console.error('Failed to start server:', err);
    }
  }

  if (!managedClientConfig.headless) {
    // Create system tray
    createTray(currentMode !== 'cli-server');
  }

  if (managedClientConfig.enabled) {
    try {
      if (managedClientConfig.headless && managedClientConfig.baseUrl) {
        managedClientRuntime = createManagedClientRuntime(managedClientConfig);
        managedClientRuntime.start();
        console.log(`Managed client runtime enabled (${managedClientConfig.mode})`);
      } else if (!managedClientConfig.headless) {
        console.log('Managed client runtime waiting for UI bootstrap configuration');
      } else {
        throw new Error('Managed client runtime requires MANAGED_CLIENT_BASE_URL');
      }
    } catch (err) {
      console.error('Failed to start managed client runtime:', err);
      if (managedClientConfig.headless) {
        app.quit();
      }
    }
  } else if (managedClientConfig.headless) {
    console.error('Managed client headless mode requires --enable-managed-client-runtime or ENABLE_MANAGED_CLIENT_RUNTIME=true');
    app.quit();
  }
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit — server should keep running (tray icon)
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
    if (mainWindow) {
      registerIpcHandlers(mainWindow, sessionManager, () => sessionNotificationEnabled, canClearAuditHistory);
    }
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  managedClientRuntime?.stop();
  managedClientRuntime = null;
});
