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

// Re-export tool names from types (which is renderer-safe, no Node.js imports)
export { PPTX_EDITOR_TOOL_NAMES } from './types';
