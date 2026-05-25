/**
 * Built-in Shiproom MCP server detection — follows the same pattern as
 * computer-use: auto-injected as a stdio MCP server when server.py is present.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

// ── Path resolution ────────────────────────────────────────────────────────

function getShiproomMcpRoot(): string {
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'shiproom-mcp');
    }
  } catch {
    // Not running in Electron (e.g. headless-entry.js with plain Node)
  }
  return path.resolve(__dirname, '../../src/shiproom-mcp');
}

// ── Detection ──────────────────────────────────────────────────────────────

let cachedShiproomPython: string | false | undefined;

/**
 * Check if server.py exists in the shiproom-mcp directory.
 */
export function isShiproomAvailable(): boolean {
  const root = getShiproomMcpRoot();
  return fs.existsSync(path.join(root, 'server.py'));
}

/**
 * Detect a working Python command that can import mcp.server.fastmcp.
 * Returns the resolved python executable path, or false if unavailable.
 */
function detectShiproomPython(): boolean {
  if (cachedShiproomPython !== undefined) {
    return cachedShiproomPython !== false;
  }
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const out = execSync(
        `${cmd} -c "import mcp.server.fastmcp; import sys; print(sys.executable)"`,
        { timeout: 5000, stdio: 'pipe' },
      );
      cachedShiproomPython = out.toString().trim();
      console.log('[shiproom] detectPython: found', cachedShiproomPython);
      return true;
    } catch (err: any) {
      const msg = (err?.stderr?.toString() || err?.message || '').slice(0, 200);
      console.log('[shiproom] detectPython: failed for', cmd, '-', msg);
    }
  }
  cachedShiproomPython = false;
  return false;
}

export function isShiproomPythonAvailable(): boolean {
  return isShiproomAvailable() && detectShiproomPython();
}

export function getShiproomPythonCommand(): string {
  if (cachedShiproomPython !== undefined && cachedShiproomPython !== false) {
    return cachedShiproomPython;
  }
  detectShiproomPython();
  return cachedShiproomPython as unknown as string;
}

export function getShiproomServerPath(): string {
  return path.join(getShiproomMcpRoot(), 'server.py');
}

export function getShiproomEnv(): Record<string, string> {
  const root = getShiproomMcpRoot();
  return {
    SHIPROOM_SKILL_SCRIPTS: path.join(root, 'scripts'),
    SHIPROOM_CONFIG: process.env.SHIPROOM_CONFIG?.trim() || path.join(root, 'shiproom-config.yaml'),
    PYTHONUTF8: '1',
  };
}

// Re-export tool names from types (which is renderer-safe, no Node.js imports)
export { SHIPROOM_TOOL_NAMES } from './types';
