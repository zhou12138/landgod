import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { logCSharpBackendStatus } from '../builtin-tools/pptx-editor';
import type { BuiltInToolsPermissionProfile } from '../builtin-tools/types';
import type { ManagedClientFileMcpServerConfig } from './mcp-server-config';

interface BundledMcpManifest {
  name: string;
  kind: 'bundled-mcp';
  transport: 'stdio';
  commandStrategy:
    | {
      type: 'python-module';
      module: string;
      pythonPath?: string;
    }
    | {
      type: 'python-script';
      script: string;
      pythonPath?: string;
    };
  availability?: {
    platforms?: string[];
    python?: boolean;
    import?: string;
    exists?: string[];
  };
  publication?: {
    enabled?: boolean;
    publishedRemotely?: boolean;
    trustLevel?: 'trusted' | 'internal-reviewed' | 'experimental' | 'blocked';
    requiredPermissionProfile?: BuiltInToolsPermissionProfile;
    toolPrefix?: string;
  };
  credentials?: {
    enabled?: boolean;
    acceptedTypes?: Array<'api_token' | 'username_password'>;
    allowedScopes?: string[];
  };
  tools: string[];
  env?: Record<string, string>;
  forwardProcessEnv?: string[];
  disable?: {
    arg?: string;
    env?: string;
    fileConfigFlagFalseDisables?: string;
  };
  postDetectLog?: 'pptx-csharp-status';
}

interface DiscoverBundledMcpServersOptions {
  args: string[];
  fileConfig: Record<string, unknown>;
  userMcpConfig: Record<string, ManagedClientFileMcpServerConfig>;
}

const pythonCommandCache = new Map<string, string | false>();

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function getBundledMcpServersPath(): string {
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

function getArgValue(args: string[], flag: string): string | null {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }

  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function hasArg(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`));
}

function resolveManifestValue(value: string, root: string): string {
  return value.replaceAll('${ROOT}', root);
}

function resolveManifestEnv(manifest: BundledMcpManifest, root: string): Record<string, string> | undefined {
  const entries = Object.entries(manifest.env ?? {});
  const forwardedKeys = new Set(manifest.forwardProcessEnv ?? []);
  const resolved: Record<string, string> = {};

  for (const [key, rawValue] of entries) {
    resolved[key] = process.env[key] ?? resolveManifestValue(rawValue, root);
  }

  for (const key of forwardedKeys) {
    if (!(key in resolved) && process.env[key]) {
      resolved[key] = process.env[key] as string;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function detectPythonExecutable(importName: string | undefined, pythonPath: string | undefined): string | false {
  const cacheKey = `${importName ?? '<none>'}::${pythonPath ?? '<none>'}`;
  const cached = pythonCommandCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const checkCommand = importName
        ? `${cmd} -c "import ${importName}; import sys; print(sys.executable)"`
        : `${cmd} -c "import sys; print(sys.executable)"`;
      const out = execSync(checkCommand, {
        timeout: 10000,
        stdio: 'pipe',
        env: {
          ...process.env,
          ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
        },
      });
      const executable = out.toString().trim();
      pythonCommandCache.set(cacheKey, executable);
      return executable;
    } catch {
      // Try next candidate.
    }
  }

  pythonCommandCache.set(cacheKey, false);
  return false;
}

function isManifestDisabled(
  manifest: BundledMcpManifest,
  args: string[],
  fileConfig: Record<string, unknown>,
): boolean {
  const disable = manifest.disable;
  if (!disable) {
    return false;
  }

  if (disable.arg && hasArg(args, disable.arg)) {
    return true;
  }

  if (disable.env) {
    const value = process.env[disable.env]?.toLowerCase();
    if (value && ['1', 'true', 'yes', 'on'].includes(value)) {
      return true;
    }
  }

  if (disable.fileConfigFlagFalseDisables) {
    const configValue = fileConfig[disable.fileConfigFlagFalseDisables];
    if (configValue === false) {
      return true;
    }
  }

  return false;
}

function isManifestAvailable(manifest: BundledMcpManifest, root: string): { available: boolean; command?: string } {
  const availability = manifest.availability;

  if (availability?.platforms && availability.platforms.length > 0 && !availability.platforms.includes(process.platform)) {
    return { available: false };
  }

  for (const relativePath of availability?.exists ?? []) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      return { available: false };
    }
  }

  if (!availability?.python) {
    return { available: true };
  }

  const pythonPath = manifest.commandStrategy.pythonPath
    ? resolveManifestValue(manifest.commandStrategy.pythonPath, root)
    : undefined;
  const command = detectPythonExecutable(availability.import, pythonPath);
  if (!command) {
    return { available: false };
  }

  return { available: true, command };
}

function loadBundledManifest(directory: string): BundledMcpManifest | null {
  const manifestPath = path.join(directory, 'landgod.mcp.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(manifestPath, 'utf-8'))) as BundledMcpManifest;
    if (!parsed || parsed.kind !== 'bundled-mcp' || typeof parsed.name !== 'string' || !parsed.name.trim()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function manifestToConfig(
  manifest: BundledMcpManifest,
  root: string,
  pythonCommand: string | undefined,
): ManagedClientFileMcpServerConfig | null {
  if (manifest.transport !== 'stdio') {
    return null;
  }

  if (manifest.commandStrategy.type === 'python-module') {
    if (!pythonCommand) {
      return null;
    }
    const pythonPath = manifest.commandStrategy.pythonPath
      ? resolveManifestValue(manifest.commandStrategy.pythonPath, root)
      : undefined;
    return {
      command: pythonCommand,
      args: ['-m', manifest.commandStrategy.module],
      env: {
        ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
        ...(resolveManifestEnv(manifest, root) ?? {}),
      },
      tools: manifest.tools,
      enabled: manifest.publication?.enabled ?? true,
      toolPrefix: manifest.publication?.toolPrefix,
      requiredPermissionProfile: manifest.publication?.requiredPermissionProfile ?? 'command-only',
      trustLevel: manifest.publication?.trustLevel ?? 'trusted',
      publishedRemotely: manifest.publication?.publishedRemotely ?? true,
      credentials: manifest.credentials,
      transport: 'stdio',
    };
  }

  if (manifest.commandStrategy.type === 'python-script') {
    if (!pythonCommand) {
      return null;
    }
    return {
      command: pythonCommand,
      args: [path.join(root, manifest.commandStrategy.script)],
      env: resolveManifestEnv(manifest, root),
      tools: manifest.tools,
      enabled: manifest.publication?.enabled ?? true,
      toolPrefix: manifest.publication?.toolPrefix,
      requiredPermissionProfile: manifest.publication?.requiredPermissionProfile ?? 'command-only',
      trustLevel: manifest.publication?.trustLevel ?? 'trusted',
      publishedRemotely: manifest.publication?.publishedRemotely ?? true,
      credentials: manifest.credentials,
      transport: 'stdio',
    };
  }

  return null;
}

export function discoverBundledMcpServers(
  options: DiscoverBundledMcpServersOptions,
): Record<string, ManagedClientFileMcpServerConfig> {
  const bundledRoot = getBundledMcpServersPath();
  if (!fs.existsSync(bundledRoot)) {
    return {};
  }

  const discovered: Record<string, ManagedClientFileMcpServerConfig> = {};
  const directories = fs.readdirSync(bundledRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());

  for (const entry of directories) {
    const root = path.join(bundledRoot, entry.name);
    const manifest = loadBundledManifest(root);
    if (!manifest) {
      continue;
    }

    if (options.userMcpConfig[manifest.name]) {
      continue;
    }

    if (isManifestDisabled(manifest, options.args, options.fileConfig)) {
      continue;
    }

    const availability = isManifestAvailable(manifest, root);
    if (!availability.available) {
      continue;
    }

    const config = manifestToConfig(manifest, root, availability.command);
    if (!config) {
      continue;
    }

    discovered[manifest.name] = config;

    if (manifest.postDetectLog === 'pptx-csharp-status') {
      logCSharpBackendStatus();
    }
  }

  return discovered;
}