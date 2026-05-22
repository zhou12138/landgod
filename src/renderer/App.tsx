import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Routes, Route } from 'react-router-dom';
import { I18nProvider } from './hooks/useI18n';
import type { ManagedClientBootstrapState } from '../preload';
import Layout from './components/Layout';
import ToolCallApprovalDialog from './components/ToolCallApprovalDialog';
import Activities from './pages/Activities';
import Dashboard from './pages/Dashboard';
import AuditLog from './pages/AuditLog';
import ExternalMcpServers from './pages/ExternalMcpServers';
import Permissions from './pages/Permissions';
import BuiltInTools from './pages/BuiltInTools';
import Settings from './pages/Settings';
import { Input } from './components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';

function resolveManagedBaseUrl(localBaseUrl: string, signinBaseUrl?: string | null): string {
  const resolvedBaseUrl = signinBaseUrl?.trim() || localBaseUrl.trim();
  if (!resolvedBaseUrl) {
    throw new Error('Managed MCP WebSocket base URL is required after browser sign-in. Provide it in the sign-in page or local settings.');
  }

  return resolvedBaseUrl;
}

function isValidEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !!url.protocol && !!url.hostname;
  } catch {
    return false;
  }
}

function extractHostname(urlString: string): string {
  try {
    return new URL(urlString).hostname;
  } catch {
    return '';
  }
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<ManagedClientBootstrapState | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapSlow, setBootstrapSlow] = useState(false);
  
  // Log to help debug blank page issues
  console.log('[App] Rendering with state:', { bootstrap, bootstrapError, bootstrapSlow });
  const [baseUrl, setBaseUrl] = useState('');
  const [signinPageUrl, setSigninPageUrl] = useState('');
  const [tlsServername, setTlsServername] = useState('');
  const [token, setToken] = useState('');
  const [persistToken, setPersistToken] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [signinPending, setSigninPending] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      console.warn('[App] Bootstrap timeout after 8s');
      setBootstrapSlow(true);
    }, 8000);

    const loadBootstrap = async () => {
      try {
        console.log('[App] Attempting to load bootstrap state...');
        if (!window.electronAPI || typeof window.electronAPI.getManagedClientBootstrapState !== 'function') {
          const reason = !window.electronAPI ? 'electronAPI unavailable' : 'getManagedClientBootstrapState not a function';
          throw new Error(`electronAPI bridge is unavailable: ${reason}. Preload may not have initialized correctly.`);
        }

        console.log('[App] Calling getManagedClientBootstrapState...');
        const state = await window.electronAPI.getManagedClientBootstrapState();
        console.log('[App] Bootstrap state received:', state);
        setBootstrap(state);
        setBaseUrl(state.baseUrl ?? 'wss://officeagent-dev2.microsoft.com/api/mcphub/ws');
        setSigninPageUrl(state.signinPageUrl ?? state.baseUrl ?? 'https://officeagent-dev2.microsoft.com');
        setTlsServername(state.tlsServername ?? 'officeagent-dev2.microsoft.com');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[App] Bootstrap failed:', msg);
        setBootstrapError(msg);
      } finally {
        window.clearTimeout(timer);
      }
    };

    void loadBootstrap();

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  if (!bootstrap && (bootstrapError || bootstrapSlow)) {
    return (
      <I18nProvider>
        <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
          <Card className="w-full max-w-3xl border-slate-800/80 bg-slate-950/80 shadow-2xl shadow-slate-950/40">
            <CardHeader>
              <CardTitle>Renderer Initialization Failed</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-slate-300">
                The desktop UI could not load bootstrap state from the main process.
              </p>
              <div className="rounded-md border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-300 font-mono whitespace-pre-wrap break-all">
                {bootstrapError ?? 'Timed out waiting for bootstrap IPC response.'}
              </div>
              <p className="text-xs text-slate-500">
                Try restarting the app. If this persists, run from source with dev tools enabled to inspect renderer console errors.
              </p>
            </CardContent>
          </Card>
        </div>
      </I18nProvider>
    );
  }

  if (!bootstrap) {
    const errorText = bootstrapError ? ` Error: ${bootstrapError}` : (bootstrapSlow ? ' Bootstrap is taking longer than expected.' : '');
    return (
      <I18nProvider>
        <div style={{ minHeight: '100vh', background: '#020617', color: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: 'sans-serif' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '16px' }}>Loading desktop UI...{errorText}</div>
            {bootstrapError && <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: '12px' }}>Check the browser console (F12) for more details.</div>}
          </div>
        </div>
      </I18nProvider>
    );
  }

  const showManagedDesktopPages = bootstrap.mode === 'managed-client-mcp-ws';

  if (!bootstrap.headless && bootstrap.needsModeSelection) {
    return (
      <I18nProvider>
        <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
          <Card className="w-full max-w-3xl">
            <CardHeader>
              <CardTitle>Choose Startup Mode</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-slate-400">
                Select how this app should run on this device. You can still change the saved mode later by editing the local config.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={async () => {
                    setSaving(true);
                    setError('');
                    try {
                      const next = await window.electronAPI.selectManagedClientMode('cli-server');
                      setBootstrap(next);
                    } catch (saveError) {
                      setError(saveError instanceof Error ? saveError.message : String(saveError));
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                  className="rounded-lg border border-slate-800 bg-slate-900 p-5 text-left transition-colors hover:border-blue-500 hover:bg-slate-900/80 disabled:opacity-50"
                >
                  <div className="text-base font-semibold text-white">Server Mode</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">
                    Start the local MCP / CLI server and accept direct local connections.
                  </div>
                </button>

                <button
                  onClick={async () => {
                    setSaving(true);
                    setError('');
                    try {
                      const next = await window.electronAPI.selectManagedClientMode('managed-client-mcp-ws');
                      setBootstrap(next);
                      setBaseUrl(next.baseUrl ?? 'wss://officeagent-dev2.microsoft.com/api/mcphub/ws');
                      setSigninPageUrl(next.signinPageUrl ?? next.baseUrl ?? 'https://officeagent-dev2.microsoft.com');
                      setTlsServername(next.tlsServername ?? 'officeagent-dev2.microsoft.com');
                      setToken('');
                    } catch (saveError) {
                      setError(saveError instanceof Error ? saveError.message : String(saveError));
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                  className="rounded-lg border border-slate-800 bg-slate-900 p-5 text-left transition-colors hover:border-blue-500 hover:bg-slate-900/80 disabled:opacity-50"
                >
                  <div className="text-base font-semibold text-white">Managed MCP WebSocket Mode</div>
                  <div className="mt-2 text-sm leading-6 text-slate-400">
                    Connect to the remote desktop WebSocket endpoint and publish this machine&apos;s local MCP tools through the desktop websocket protocol.
                  </div>
                </button>
              </div>
              {error && <div className="text-sm text-red-400">{error}</div>}
            </CardContent>
          </Card>
        </div>
      </I18nProvider>
    );
  }

  if (bootstrap.mode !== 'cli-server' && !bootstrap.headless && bootstrap.needsBaseUrl) {
    const isDesktopWsMode = bootstrap.mode === 'managed-client-mcp-ws';
    const isBusy = saving || signinPending;
    return (
      <I18nProvider>
        <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
          <Card className="w-full max-w-4xl overflow-hidden border-slate-800/80 bg-slate-950/80 shadow-2xl shadow-slate-950/40">
            <CardHeader>
              <CardTitle>{isDesktopWsMode ? 'Managed MCP WebSocket Setup' : 'Managed Client Setup'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-slate-400">
                {isDesktopWsMode
                  ? 'Confirm the remote MCP Hub WebSocket endpoint before starting the managed MCP bridge.'
                  : 'Confirm the MCP Hub endpoint before starting managed client runtime.'}
              </p>
              <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-5 md:p-6 space-y-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-100">Connection</div>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      Configure the remote endpoint first. Authentication options below will reuse these values.
                    </p>
                  </div>
                  {isDesktopWsMode && (
                    <div className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-200">
                      Browser sign-in ready
                    </div>
                  )}
                </div>
                <div className={isDesktopWsMode ? 'grid gap-4 md:grid-cols-2' : 'space-y-4'}>
                  <div className="space-y-2">
                    <label className="block text-xs text-slate-500">MCP Hub Endpoint <span className="ml-1 text-red-400">*</span></label>
                    <Input
                      type="text"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={isDesktopWsMode ? 'wss://officeagent-dev2.microsoft.com/api/mcphub/ws' : 'https://officeagent-dev2.microsoft.com/api'}
                    />
                  </div>
                  {isDesktopWsMode && (
                    <div className="space-y-2">
                      <label className="block text-xs text-slate-500">Sign-in Page URL <span className="ml-1 text-red-400">*</span></label>
                      <Input
                        type="text"
                        value={signinPageUrl}
                        onChange={(event) => setSigninPageUrl(event.target.value)}
                        placeholder="https://officeagent-dev2.microsoft.com"
                      />
                    </div>
                  )}
                </div>
                {isDesktopWsMode && (
                  <div className="space-y-4">
                    <p className="text-xs leading-5 text-slate-500">
                      Leave the sign-in page URL aligned with the base URL when the frontend is served there, and the client will connect to the MCP Hub WebSocket endpoint at /api/mcphub/ws.
                    </p>
                  </div>
                )}
              </div>
              {isDesktopWsMode ? (
                <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
                  <section className="relative overflow-hidden rounded-2xl border border-emerald-500/25 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_55%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.92))] p-5 md:p-6">
                    <div className="absolute right-4 top-4 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-200">
                      Recommended
                    </div>
                    <div className="max-w-md space-y-4">
                      <div>
                        <div className="text-lg font-semibold text-white">Sign in with browser</div>
                        <p className="mt-2 text-sm leading-6 text-slate-300">
                          Open the Societas frontend in your default browser, complete Microsoft sign-in there, then return the access token to this desktop app for the MCP Hub WebSocket connection automatically.
                        </p>
                      </div>
                      <div className="grid gap-2 text-xs text-slate-300 md:grid-cols-3">
                        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/80">Step 1</div>
                          <div className="mt-2 leading-5">Launch browser sign-in</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/80">Step 2</div>
                          <div className="mt-2 leading-5">Complete Microsoft authentication</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/80">Step 3</div>
                          <div className="mt-2 leading-5">Return token and start bridge</div>
                        </div>
                      </div>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <button
                          onClick={async () => {
                            const trimmedBase = baseUrl.trim();
                            const trimmedSignin = signinPageUrl.trim();

                            if (trimmedBase && !isValidEndpointUrl(trimmedBase)) {
                              setError('MCP Hub Endpoint must be a valid URL (protocol://domain or protocol://domain:port)');
                              return;
                            }
                            if (trimmedSignin && !isValidEndpointUrl(trimmedSignin)) {
                              setError('Sign-in Page URL must be a valid URL (protocol://domain or protocol://domain:port)');
                              return;
                            }

                            setSigninPending(true);
                            setError('');

                            const effectiveTlsServername = tlsServername.trim() || extractHostname(trimmedBase) || null;

                            try {
                              const signin = await window.electronAPI.startManagedClientSignin({
                                baseUrl: trimmedBase || null,
                                signinPageUrl: trimmedSignin || null,
                              });
                              const effectiveBaseUrl = resolveManagedBaseUrl(baseUrl, signin.baseUrl);
                              setToken(signin.token);

                              const next = await window.electronAPI.saveManagedClientBaseUrlAndStart({
                                baseUrl: effectiveBaseUrl,
                                signinPageUrl: trimmedSignin || null,
                                tlsServername: effectiveTlsServername,
                                token: signin.token,
                                persistToken,
                                identityLabel: signin.username,
                                identityDetail: signin.displayName,
                              });

                              setBootstrap(next);
                            } catch (signinError) {
                              setError(signinError instanceof Error ? signinError.message : String(signinError));
                            } finally {
                              setSigninPending(false);
                            }
                          }}
                          disabled={isBusy}
                          className="inline-flex items-center justify-center rounded-xl bg-emerald-400 px-4 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-300 disabled:opacity-50"
                        >
                          {signinPending ? 'Waiting for browser sign-in...' : 'Continue In Browser'}
                        </button>
                        {signinPending && (
                          <button
                            onClick={() => {
                              window.electronAPI.cancelManagedClientSignin();
                              setSigninPending(false);
                              setError('Sign-in was cancelled. You can edit the form and try again.');
                            }}
                            className="inline-flex items-center justify-center rounded-xl border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-400 hover:text-white"
                          >
                            Cancel
                          </button>
                        )}
                        <div className="text-xs leading-5 text-slate-400">
                          Use this for normal login. The bridge starts automatically after the token is handed back and the app connects to /api/mcphub/ws.
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-2xl border border-amber-500/20 bg-slate-900/70 p-5 md:p-6">
                    <div className="space-y-4">
                      <div>
                        <div className="text-sm font-semibold text-white">Use static token</div>
                        <p className="mt-2 text-sm leading-6 text-slate-400">
                          Fallback for demos, local troubleshooting, or when browser sign-in is unavailable for the MCP Hub WebSocket bridge.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <label className="block text-xs text-slate-500">MANAGED_CLIENT_BEARER_TOKEN</label>
                        <Input
                          type="password"
                          value={token}
                          onChange={(event) => setToken(event.target.value)}
                          placeholder="Access token, with or without Bearer prefix"
                          className="border-amber-500/20 bg-slate-950/80"
                        />
                        <p className="text-xs leading-5 text-slate-500">
                          The app removes an optional Bearer prefix and forwards the token to the managed MCP WebSocket runtime.
                        </p>
                        <label className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                          <input
                            type="checkbox"
                            checked={persistToken}
                            onChange={(event) => setPersistToken(event.target.checked)}
                          />
                          Remember token in config file
                        </label>
                      </div>
                      <button
                        onClick={async () => {
                          if (!baseUrl.trim()) {
                            setError('MCP Hub Endpoint is required');
                            return;
                          }
                          if (!isValidEndpointUrl(baseUrl.trim())) {
                            setError('MCP Hub Endpoint must be a valid URL (protocol://domain or protocol://domain:port)');
                            return;
                          }

                          setSaving(true);
                          setError('');
                          try {
                            const next = await window.electronAPI.saveManagedClientBaseUrlAndStart({
                              baseUrl: baseUrl.trim(),
                              signinPageUrl: signinPageUrl.trim() || null,
                              tlsServername: tlsServername.trim() || extractHostname(baseUrl.trim()) || null,
                              token: token.trim() || null,
                              persistToken,
                            });
                            setBootstrap(next);
                          } catch (saveError) {
                            setError(String(saveError));
                          } finally {
                            setSaving(false);
                          }
                        }}
                        disabled={isBusy}
                        className="inline-flex items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-100 transition-colors hover:bg-amber-400/15 disabled:opacity-50"
                      >
                        {saving ? 'Starting...' : 'Start With Static Token'}
                      </button>
                    </div>
                  </section>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="block text-xs text-slate-500">MANAGED_CLIENT_BEARER_TOKEN</label>
                    <Input
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      placeholder="Access token, with or without Bearer prefix"
                    />
                    <p className="text-xs text-slate-500">
                      Optional. Fill this when the managed client should use a static bearer token for demo or local testing. The client forwards the token as-is after removing an optional Bearer prefix.
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                      <input
                        type="checkbox"
                        checked={persistToken}
                        onChange={(event) => setPersistToken(event.target.checked)}
                      />
                      Remember token in config file
                    </label>
                  </div>
                  <button
                    onClick={async () => {
                      if (!baseUrl.trim()) {
                        setError('MCP Hub Endpoint is required');
                        return;
                      }
                      if (!isValidEndpointUrl(baseUrl.trim())) {
                        setError('MCP Hub Endpoint must be a valid URL (protocol://domain or protocol://domain:port)');
                        return;
                      }

                      setSaving(true);
                      setError('');
                      try {
                        const next = await window.electronAPI.saveManagedClientBaseUrlAndStart({
                          baseUrl: baseUrl.trim(),
                          signinPageUrl: signinPageUrl.trim() || null,
                          tlsServername: tlsServername.trim() || extractHostname(baseUrl.trim()) || null,
                          token: token.trim() || null,
                          persistToken,
                        });
                        setBootstrap(next);
                      } catch (saveError) {
                        setError(String(saveError));
                      } finally {
                        setSaving(false);
                      }
                    }}
                    disabled={isBusy}
                    className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {saving ? 'Starting...' : 'Save and Start'}
                  </button>
                </>
              )}
              {error && <div className="text-sm text-red-400">{error}</div>}
            </CardContent>
          </Card>
        </div>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <ToolCallApprovalDialog />
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/activities" element={<Activities />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/mcp-servers" element={showManagedDesktopPages ? <ExternalMcpServers /> : <Navigate to="/built-in-tools" replace />} />
            <Route path="/permissions" element={showManagedDesktopPages ? <Permissions /> : <Navigate to="/built-in-tools" replace />} />
            <Route path="/built-in-tools" element={<BuiltInTools />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </HashRouter>
    </I18nProvider>
  );
}
