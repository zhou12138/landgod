/**
 * Built-in PPTX Editor MCP server detection — follows the same pattern as
 * computer-use: auto-injected as a stdio MCP server when Python + pywin32
 * are available on Windows.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

// ── Path resolution ────────────────────────────────────────────────────────

function getPptxEditorMcpRoot(): string {
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'mcp-servers', 'pptx-editor');
    }
  } catch {
    // Not running in Electron (e.g. headless-entry.js with plain Node)
  }
  return path.join(process.cwd(), 'mcp-servers', 'pptx-editor');
}

// ── Detection ──────────────────────────────────────────────────────────────

let cachedPptxEditorPython: string | false | undefined;

/**
 * Check if __init__.py exists in the pptx-editor package directory.
 */
export function isPptxEditorAvailable(): boolean {
  const root = getPptxEditorMcpRoot();
  return fs.existsSync(path.join(root, 'landgod_pptx_editor', '__init__.py'));
}

/**
 * Detect a working Python command that can import the pptx-editor module.
 * Only available on Windows (requires COM / pywin32).
 */
function detectPptxEditorPython(): boolean {
  if (cachedPptxEditorPython !== undefined) {
    return cachedPptxEditorPython !== false;
  }
  // Only available on Windows
  if (process.platform !== 'win32') {
    cachedPptxEditorPython = false;
    return false;
  }
  const pptxEditorPath = getPptxEditorMcpRoot();
  const candidates = ['python', 'python3'];
  for (const cmd of candidates) {
    try {
      const out = execSync(
        `${cmd} -c "import landgod_pptx_editor; import sys; print(sys.executable)"`,
        { timeout: 10000, stdio: 'pipe', env: { ...process.env, PYTHONPATH: pptxEditorPath } },
      );
      cachedPptxEditorPython = out.toString().trim();
      console.log('[pptx-editor] detectPython: found', cachedPptxEditorPython);
      return true;
    } catch (err: any) {
      const msg = (err?.stderr?.toString() || err?.message || '').slice(0, 200);
      console.log('[pptx-editor] detectPython: failed for', cmd, '-', msg);
    }
  }
  cachedPptxEditorPython = false;
  return false;
}

export function isPptxEditorPythonAvailable(): boolean {
  return isPptxEditorAvailable() && detectPptxEditorPython();
}

export function getPptxEditorPythonCommand(): string {
  if (cachedPptxEditorPython !== undefined && cachedPptxEditorPython !== false) {
    return cachedPptxEditorPython;
  }
  detectPptxEditorPython();
  return cachedPptxEditorPython as unknown as string;
}

export function getPptxEditorPythonPath(): string {
  return getPptxEditorMcpRoot();
}

// ── C# / .NET SDK detection ─────────────────────────────────────────────────

let cachedDotnetVersion: string | false | undefined;

/**
 * Detect .NET SDK availability (needed for csharp backend auto-build).
 * Returns the version string or false.
 */
function detectDotnetSdk(): string | false {
  if (cachedDotnetVersion !== undefined) {
    return cachedDotnetVersion;
  }
  try {
    const out = execSync('dotnet --version', { timeout: 10000, stdio: 'pipe' });
    cachedDotnetVersion = out.toString().trim();
    return cachedDotnetVersion;
  } catch {
    cachedDotnetVersion = false;
    return false;
  }
}

/**
 * Check if the C# host exe is already built (skip build detection noise).
 */
function isCSharpHostBuilt(): boolean {
  const root = getPptxEditorMcpRoot();
  const hostDir = path.join(root, 'csharp_host', 'PptInteropHost', 'bin');
  if (!fs.existsSync(hostDir)) return false;
  // Check common build output paths
  for (const cfg of ['Release', 'Debug']) {
    for (const tfm of ['net9.0-windows', 'net8.0-windows', 'net10.0-windows']) {
      if (fs.existsSync(path.join(hostDir, cfg, tfm, 'PptInteropHost.exe'))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if the C# host source (.csproj) is bundled in the package.
 */
function isCSharpSourceBundled(): boolean {
  const root = getPptxEditorMcpRoot();
  return fs.existsSync(path.join(root, 'csharp_host', 'PptInteropHost', 'PptInteropHost.csproj'));
}

/**
 * Log C# backend readiness during startup.
 */
export function logCSharpBackendStatus(): void {
  if (process.platform !== 'win32') {
    console.log('[pptx-editor] csharp backend: skipped (not Windows)');
    return;
  }

  const hasCsproj = isCSharpSourceBundled();
  const hostBuilt = isCSharpHostBuilt();
  const dotnetVersion = detectDotnetSdk();

  if (hostBuilt) {
    console.log('[pptx-editor] csharp backend: ✅ ready (PptInteropHost.exe built)');
  } else if (hasCsproj && dotnetVersion) {
    console.log(`[pptx-editor] csharp backend: ⏳ will auto-build on first use (.NET SDK ${dotnetVersion})`);
  } else if (hasCsproj && !dotnetVersion) {
    console.log('[pptx-editor] csharp backend: ⚠️  .NET SDK not found — install with: winget install Microsoft.DotNet.SDK.9');
  } else {
    console.log('[pptx-editor] csharp backend: ❌ source not bundled');
  }
}

// Re-export tool names from types (which is renderer-safe, no Node.js imports)
export { PPTX_EDITOR_TOOL_NAMES } from './types';
