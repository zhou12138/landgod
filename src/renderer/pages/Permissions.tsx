import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { AlertTriangle } from 'lucide-react';
import {
  DEFAULT_BUILT_IN_TOOLS_SECURITY_CONFIG,
  getDefaultExternalMcpPermissionProfile,
  getExternalMcpAccessDecision,
  getManagedClientToolResultMode,
  getBuiltInToolsSecurityConfigForProfile,
  isDesktopToolPublishedForPermissionProfile,
  isExternalMcpTransportAllowedForPermissionProfile,
  type BuiltInToolsPermissionProfile,
  type BuiltInToolsSecurityConfig,
} from '../../main/builtin-tools/types';
import type { ManagedClientFileMcpServerConfig } from '../../main/managed-client/mcp-server-config';

const PERMISSION_PROFILE_OPTIONS: BuiltInToolsPermissionProfile[] = ['command-only', 'interactive-trusted', 'full-local-admin', 'demo'];
const DESKTOP_TOOL_NAMES = [
  'shell_execute',
  'file_read',
  'remote_configure_mcp_server',
  'session_create',
  'session_stdin',
  'session_wait',
  'session_read_output',
] as const;

const EXTERNAL_TRANSPORTS = ['http', 'stdio'] as const;

function getPermissionProfileSummaryKey(profile: BuiltInToolsPermissionProfile): string {
  switch (profile) {
    case 'command-only':
      return 'builtInTools.permissionProfileCommandOnlySummary';
    case 'full-local-admin':
      return 'builtInTools.permissionProfileFullLocalAdminSummary';
    case 'demo':
      return 'builtInTools.permissionProfileDemoSummary';
    case 'interactive-trusted':
    default:
      return 'builtInTools.permissionProfileInteractiveTrustedSummary';
  }
}

function getToolResultModeDescriptionKey(mode: 'status-only' | 'handle' | 'full'): string {
  switch (mode) {
    case 'handle':
      return 'permissions.toolResultModeDescription.handle';
    case 'full':
      return 'permissions.toolResultModeDescription.full';
    case 'status-only':
    default:
      return 'permissions.toolResultModeDescription.status-only';
  }
}

function getTransportDescriptionKey(transport: 'http' | 'stdio'): string {
  return transport === 'http'
    ? 'permissions.transportDescription.http'
    : 'permissions.transportDescription.stdio';
}

function normalizeConfig(config: Partial<BuiltInToolsSecurityConfig> | null | undefined): BuiltInToolsSecurityConfig {
  const permissionProfile = config?.permissionProfile ?? DEFAULT_BUILT_IN_TOOLS_SECURITY_CONFIG.permissionProfile;
  const defaults = getBuiltInToolsSecurityConfigForProfile(permissionProfile);

  return {
    permissionProfile,
    shellExecute: {
      ...defaults.shellExecute,
      ...(config?.shellExecute ?? {}),
    },
    fileRead: {
      ...defaults.fileRead,
      ...(config?.fileRead ?? {}),
    },
    managedMcpServerAdmin: {
      ...defaults.managedMcpServerAdmin,
      ...(config?.managedMcpServerAdmin ?? {}),
    },
  };
}

export default function Permissions() {
  const { t } = useI18n();
  const [savedConfig, setSavedConfig] = useState<BuiltInToolsSecurityConfig | null>(null);
  const [savedMcpServers, setSavedMcpServers] = useState<Record<string, ManagedClientFileMcpServerConfig>>({});
  const [selectedProfile, setSelectedProfile] = useState<BuiltInToolsPermissionProfile>(DEFAULT_BUILT_IN_TOOLS_SECURITY_CONFIG.permissionProfile);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      window.electronAPI.getBuiltInToolsSecurityConfig(),
      window.electronAPI.getManagedClientMcpServersConfig(),
    ])
      .then(([{ config }, mcpConfigState]) => {
        const normalized = normalizeConfig(config);
        setSavedConfig(normalized);
        setSelectedProfile(normalized.permissionProfile);
        setSavedMcpServers(mcpConfigState.mcpServers);
      })
      .catch((error) => {
        const fallback = normalizeConfig(DEFAULT_BUILT_IN_TOOLS_SECURITY_CONFIG);
        setSavedConfig(fallback);
        setSelectedProfile(fallback.permissionProfile);
        setMessage({
          type: 'error',
          text: t('builtInTools.loadFailed', { error: String(error) }),
        });
      });
  }, []);

  // Built-in computer-use tools (promoted from MCP server to built-in display)
  const COMPUTER_USE_SERVER_NAME = 'computer-use';
  const computerUseTools = useMemo(() => {
    const server = savedMcpServers[COMPUTER_USE_SERVER_NAME];
    if (!server || server.enabled === false) return [];
    return server.tools ?? [];
  }, [savedMcpServers]);

  const externalMcpPreview = useMemo(() => {
    const available: Array<{ name: string; transport: 'http' | 'stdio' }> = [];
    const unavailable: Array<{ name: string; transport: 'http' | 'stdio'; reason: string }> = [];

    for (const [name, server] of Object.entries(savedMcpServers)) {
      // computer-use is promoted to built-in tools section — skip here
      if (name === COMPUTER_USE_SERVER_NAME) continue;
      const transport = server.transport === 'http' ? 'http' : 'stdio';

      if (server.enabled === false) {
        unavailable.push({
          name,
          transport,
          reason: t('permissions.externalMcpDisabledReason'),
        });
        continue;
      }

      const decision = getExternalMcpAccessDecision(
        selectedProfile,
        transport,
        server.requiredPermissionProfile ?? getDefaultExternalMcpPermissionProfile(transport),
      );

      if (decision.allowed) {
        available.push({ name, transport });
        continue;
      }

      unavailable.push({
        name,
        transport,
        reason: decision.blockedReason === 'transport-blocked'
          ? t('permissions.externalMcpBlockedTransport')
          : t('permissions.externalMcpBlockedProfile', { required: t(`builtInTools.permissionProfile.${decision.requiredPermissionProfile}`) }),
      });
    }

    return { available, unavailable };
  }, [savedMcpServers, selectedProfile, t]);

  if (!savedConfig) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-white">{t('permissions.title')}</h2>
        <p className="text-sm text-slate-400">{t('builtInTools.loading')}</p>
      </div>
    );
  }

  const isDirty = selectedProfile !== savedConfig.permissionProfile;
  const nextDefaults = getBuiltInToolsSecurityConfigForProfile(selectedProfile);
  const currentProfileDefaults = getBuiltInToolsSecurityConfigForProfile(savedConfig.permissionProfile);
  const hasProfileOverrides = JSON.stringify(savedConfig) !== JSON.stringify(currentProfileDefaults);
  const availableDesktopTools = DESKTOP_TOOL_NAMES.filter((toolName) => isDesktopToolPublishedForPermissionProfile(selectedProfile, toolName));
  const unavailableDesktopTools = DESKTOP_TOOL_NAMES.filter((toolName) => !isDesktopToolPublishedForPermissionProfile(selectedProfile, toolName));
  const allAvailableTools = [...availableDesktopTools, ...computerUseTools];

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.saveBuiltInToolsSecurityConfig({ config: nextDefaults });
      setSavedConfig(result.config);
      setSelectedProfile(result.config.permissionProfile);
      window.dispatchEvent(new Event('managed-client:built-in-tools-config-changed'));
      setMessage({
        type: result.applied || result.reason === 'runtime-inactive' || result.reason === 'bridge-not-ready' || result.reason === 'republish-pending'
          ? 'success'
          : 'error',
        text: result.applied
          ? t('builtInTools.saveApplied', { toolCount: result.toolCount })
          : result.reason === 'runtime-inactive'
            ? t('builtInTools.savePendingPublishRuntimeInactive')
            : result.reason === 'republish-pending'
              ? t('builtInTools.savePendingPublishRepublishPending')
              : t('builtInTools.savePendingPublishBridgeNotReady'),
      });
    } catch (error) {
      setMessage({ type: 'error', text: t('builtInTools.saveFailed', { error: String(error) }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">{t('permissions.title')}</h2>
          <p className="mt-1 text-sm text-slate-400">{t('permissions.description')}</p>
        </div>
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? t('builtInTools.saving') : t('builtInTools.save')}
        </button>
      </div>

      {message && (
        <div className={`text-sm ${message.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
          {message.text}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('builtInTools.permissionProfileTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-400">{t('builtInTools.permissionProfileDescription')}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {PERMISSION_PROFILE_OPTIONS.map((profile) => {
              const selected = selectedProfile === profile;
              return (
                <button
                  key={profile}
                  type="button"
                  onClick={() => {
                    setMessage(null);
                    setSelectedProfile(profile);
                  }}
                  className={`rounded-lg border px-4 py-3 text-left transition-colors ${selected
                    ? 'border-blue-500 bg-blue-500/10 text-white'
                    : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-600'
                    }`}
                >
                  <div className="text-sm font-medium">{t(`builtInTools.permissionProfile.${profile}`)}</div>
                  <div className="mt-1 text-xs text-slate-400">{t(getPermissionProfileSummaryKey(profile))}</div>
                </button>
              );
            })}
          </div>
          {selectedProfile === 'full-local-admin' && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('permissions.fullLocalAdminWarning')}</span>
            </div>
          )}
          {selectedProfile === 'demo' && (
            <div className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <span>{t('permissions.demoWarning')}</span>
            </div>
          )}
          <p className="text-xs text-slate-500">{hasProfileOverrides ? t('builtInTools.permissionProfileOverridesActive') : t('builtInTools.permissionProfileNoOverrides')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('permissions.previewTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-400">{t('permissions.previewDescription')}</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-green-900/50 bg-green-950/20 p-4">
              <div className="text-sm font-medium text-green-200">{t('permissions.availableToolsTitle')}</div>
              <div className="mt-3 space-y-2">
                {allAvailableTools.map((toolName) => {
                  const isComputerUse = computerUseTools.includes(toolName as string);
                  const resultMode = isComputerUse ? 'full' : getManagedClientToolResultMode(selectedProfile, toolName as (typeof DESKTOP_TOOL_NAMES)[number], 'local');
                  return (
                    <div key={toolName} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-green-900/40 bg-slate-950/60 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-green-100">{toolName}</code>
                        {isComputerUse && <Badge variant="outline" className="text-[10px] px-1 py-0 text-slate-400 border-slate-600">computer-use</Badge>}
                      </div>
                      <Badge
                        variant="success"
                        title={t(getToolResultModeDescriptionKey(resultMode))}
                      >
                        {t(`permissions.toolResultMode.${resultMode}`)}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4">
              <div className="text-sm font-medium text-red-200">{t('permissions.unavailableToolsTitle')}</div>
              <div className="mt-3 space-y-2">
                {unavailableDesktopTools.map((toolName) => (
                  <div key={toolName} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-900/40 bg-slate-950/60 px-3 py-2">
                    <code className="text-xs text-red-100">{toolName}</code>
                    <Badge variant="destructive">{t('permissions.unavailableBadge')}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
            <div className="text-sm font-medium text-white">{t('permissions.externalCapabilitiesTitle')}</div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {EXTERNAL_TRANSPORTS.map((transport) => {
                const allowed = isExternalMcpTransportAllowedForPermissionProfile(selectedProfile, transport);
                return (
                  <div key={transport} className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950 px-3 py-2">
                    <span className="text-xs text-slate-300">{t(`permissions.transport.${transport}`)}</span>
                    <Badge variant={allowed ? 'success' : 'destructive'}>
                      {allowed ? t('permissions.availableBadge') : t('permissions.unavailableBadge')}
                    </Badge>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-md border border-green-900/40 bg-green-950/20 p-3">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-green-200">{t('permissions.availableExternalMcpTitle')}</div>
                <div className="mt-3 space-y-2">
                  {externalMcpPreview.available.length === 0 && (
                    <div className="text-xs text-slate-500">{t('permissions.emptyExternalMcpList')}</div>
                  )}
                  {externalMcpPreview.available.map((server) => (
                    <div key={`${server.transport}:${server.name}`} className="rounded-md border border-green-900/40 bg-slate-950/60 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code className="text-xs text-green-100">{server.name}</code>
                        <Badge
                          variant="success"
                          title={t(getTransportDescriptionKey(server.transport))}
                        >
                          {t(`permissions.transport.${server.transport}`)}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-red-900/40 bg-red-950/20 p-3">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-red-200">{t('permissions.unavailableExternalMcpTitle')}</div>
                <div className="mt-3 space-y-2">
                  {externalMcpPreview.unavailable.length === 0 && (
                    <div className="text-xs text-slate-500">{t('permissions.emptyExternalMcpList')}</div>
                  )}
                  {externalMcpPreview.unavailable.map((server) => (
                    <div key={`${server.transport}:${server.name}`} className="rounded-md border border-red-900/40 bg-slate-950/60 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code className="text-xs text-red-100">{server.name}</code>
                        <Badge
                          variant="destructive"
                          title={t(getTransportDescriptionKey(server.transport))}
                        >
                          {t(`permissions.transport.${server.transport}`)}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">{server.reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}