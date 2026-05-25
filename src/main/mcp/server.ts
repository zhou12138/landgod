import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import pathModule from 'node:path';
import { z } from 'zod';
import type { Express, Request, Response } from 'express';
import * as os from 'node:os';
import type { SessionManager } from '../session/manager';
import { emitServerEvent } from '../server';
import { getBuiltInToolsSecurityConfig } from '../managed-client/config';
import { upsertManagedMcpServer } from '../managed-client/admin-tools';
import { isWorkspaceScopedPermissionProfile } from '../builtin-tools/types';
import { buildSandboxEnv } from '../sandbox-env';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function error(message: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...details }) }],
    isError: true as const,
  };
}

function buildShellAllowlistDetails() {
  const shellConfig = getBuiltInToolsSecurityConfig().shellExecute;
  return {
    localAllowlist: {
      allowedExecutableNames: shellConfig.allowedExecutableNames,
      allowedWorkingDirectories: shellConfig.allowedWorkingDirectories,
    },
  };
}

function buildFileReadAllowlistDetails() {
  const fileReadConfig = getBuiltInToolsSecurityConfig().fileRead;
  return {
    localAllowlist: {
      allowedPaths: fileReadConfig.allowedPaths,
    },
  };
}

function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function pathMatchesRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = normalizeForComparison(pathModule.resolve(candidatePath));
  const resolvedRoot = normalizeForComparison(pathModule.resolve(rootPath));
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${pathModule.sep}`);
}

function isAllowedPath(candidatePath: string, allowedPaths: string[]): string | null {
  for (const entry of allowedPaths) {
    const trimmed = entry.trim();
    if (trimmed && pathMatchesRoot(candidatePath, trimmed)) {
      return entry;
    }
  }

  return null;
}

function getCommandExecutableName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  const firstToken = trimmed.match(/^["']([^"']+)["']|^([^\s]+)/);
  const rawToken = firstToken?.[1] ?? firstToken?.[2] ?? '';
  const normalizedToken = rawToken.replace(/^.*[\\/]/, '');
  return normalizedToken.toLowerCase();
}

function hasShellRedirection(command: string): boolean {
  return /(^|[^0-9])>>?|<</.test(command);
}

function hasShellPipes(command: string): boolean {
  return /\|/.test(command);
}

function hasCommandChaining(command: string): boolean {
  return /;|&&|\|\|/.test(command);
}

// Detect inline script execution: python -c "...", node -e "...", powershell -Command "...", etc.
const INLINE_SCRIPT_PATTERNS = [
  // python/python3 -c "code"
  /\b(?:python[23]?|py)\b.*\s(?:-c|--command)\b/i,
  // node -e "code", node --eval "code", node -p "code", node --print "code"
  /\bnode\b.*\s(?:-e|--eval|-p|--print)\b/i,
  // ruby -e "code"
  /\bruby\b.*\s-e\b/i,
  // perl -e "code"
  /\bperl\b.*\s-e\b/i,
  // powershell -Command "...", pwsh -c "...", powershell -EncodedCommand "..."
  /\b(?:powershell|pwsh)(?:\.exe)?\b.*\s(?:-(?:c|command|encodedcommand|e|ec))\b/i,
  // cmd /c "...", cmd /k "..."
  /\b(?:cmd)(?:\.exe)?\b.*\s\/[ck]\b/i,
  // bash -c "...", sh -c "..."
  /\b(?:bash|sh|zsh|dash|ksh)\b.*\s-c\b/i,
  // eval/exec as standalone commands
  /^\s*(?:eval|exec)\s/i,
];

function hasInlineScript(command: string): boolean {
  return INLINE_SCRIPT_PATTERNS.some((pattern) => pattern.test(command));
}

// Extract path-like tokens from a command string for out-of-workspace scanning
function extractPathTokens(command: string): string[] {
  const tokens: string[] = [];

  // Match quoted strings
  const quotedPaths = command.matchAll(/["']([^"']+)["']/g);
  for (const match of quotedPaths) {
    tokens.push(match[1]);
  }

  // Match unquoted tokens that look like absolute paths
  // Windows: C:\..., D:\..., //server/...
  // Unix: /home/..., /etc/...
  const unquotedPaths = command.matchAll(/(?:^|\s)([A-Za-z]:[/\\][^\s"']+|\/[^\s"'|><;]+|\\\\[^\s"']+)/g);
  for (const match of unquotedPaths) {
    tokens.push(match[1]);
  }

  return tokens.filter((t) => t.length > 1);
}

function hasPathsOutsideAllowedRoots(
  command: string,
  allowedRoots: string[],
  enforcedRoot?: string,
): string | null {
  const pathTokens = extractPathTokens(command);
  if (pathTokens.length === 0) {
    return null;
  }

  // Combine allowed directories + enforced root into a single root list
  const allRoots = [...allowedRoots];
  if (enforcedRoot) {
    allRoots.push(enforcedRoot);
  }

  if (allRoots.length === 0) {
    return null;
  }

  for (const token of pathTokens) {
    // Only check tokens that look like absolute paths
    if (!pathModule.isAbsolute(token)) {
      continue;
    }

    if (!isAllowedPath(token, allRoots)) {
      return token;
    }
  }

  return null;
}

function isNetworkCommand(executableName: string): boolean {
  return new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'http', 'ftp', 'telnet', 'ssh', 'scp']).has(executableName);
}

interface McpServerOptions {
  defaultWorkingDirectory?: string;
  enforcedWorkingDirectoryRoot?: string;
  requireShellAllowlist?: boolean;
  exposeManagedAdminTool?: boolean;
  onActivity?: (area: string, action: string, summary: string, status: 'success' | 'info' | 'error', details?: Record<string, unknown>) => void;
}

function resolveWorkingDirectory(cwd: string | undefined, options?: McpServerOptions): string | undefined {
  const trimmedCwd = cwd?.trim();
  if (trimmedCwd) {
    return trimmedCwd;
  }

  return options?.defaultWorkingDirectory;
}

function resolveFilePath(filePath: string, options?: McpServerOptions): string {
  if (pathModule.isAbsolute(filePath)) {
    return filePath;
  }

  if (options?.defaultWorkingDirectory) {
    return pathModule.resolve(options.defaultWorkingDirectory, filePath);
  }

  return filePath;
}

function validateShellExecutionRequest(
  command: string,
  cwd: string | undefined,
  options: McpServerOptions | undefined,
): string | null {
  const securityConfig = getBuiltInToolsSecurityConfig();
  const shellConfig = securityConfig.shellExecute;

  if (!shellConfig.enabled) {
    return 'shell_execute is disabled by built-in tool policy';
  }

  if (command.length > shellConfig.maxCommandLength) {
    return `Command length exceeds limit (${shellConfig.maxCommandLength} characters)`;
  }

  const executableName = getCommandExecutableName(command);
  if (options?.requireShellAllowlist && shellConfig.allowedExecutableNames.length === 0) {
    return 'shell_execute requires at least one allowed executable name in managed-client-mcp-ws mode';
  }

  if (shellConfig.allowedExecutableNames.length > 0) {
    const normalizedAllowedExecutables = shellConfig.allowedExecutableNames
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    if (!executableName || !normalizedAllowedExecutables.includes(executableName)) {
      return `Executable is outside the allowlist${executableName ? `: ${executableName}` : ''}`;
    }
  }

  if (!shellConfig.allowPipes && hasShellPipes(command)) {
    return 'Command blocked by policy: shell pipes are not allowed';
  }

  if (!shellConfig.allowRedirection && hasShellRedirection(command)) {
    return 'Command blocked by policy: shell redirection is not allowed';
  }

  if (!shellConfig.allowPipes && hasCommandChaining(command)) {
    return 'Command blocked by policy: command chaining (;, &&, ||) is not allowed when pipes are disabled';
  }

  if (!shellConfig.allowNetworkCommands && executableName && isNetworkCommand(executableName)) {
    return `Executable blocked by policy: network command ${executableName} is not allowed`;
  }

  if (!shellConfig.allowInlineScripts && hasInlineScript(command)) {
    return 'Command blocked by policy: inline script execution (-c, -e, -Command, eval) is not allowed';
  }

  // Enforce non-empty allowedWorkingDirectories in managed-client-mcp-ws mode (mirrors requireShellAllowlist)
  if (options?.requireShellAllowlist && shellConfig.allowedWorkingDirectories.length === 0) {
    return 'shell_execute requires at least one allowed working directory in managed-client-mcp-ws mode';
  }

  // Always validate effective cwd (including the default), not just explicitly provided cwd
  if (cwd) {
    if (shellConfig.allowedWorkingDirectories.length > 0 && !isAllowedPath(cwd, shellConfig.allowedWorkingDirectories)) {
      return 'Working directory is outside the allowed roots';
    }

    if (options?.enforcedWorkingDirectoryRoot && !pathMatchesRoot(cwd, options.enforcedWorkingDirectoryRoot)) {
      return `Working directory must stay inside managed workspace: ${options.enforcedWorkingDirectoryRoot}`;
    }
  }

  if (!shellConfig.allowPathsOutsideWorkspace) {
    const disallowedPath = hasPathsOutsideAllowedRoots(
      command,
      shellConfig.allowedWorkingDirectories,
      options?.enforcedWorkingDirectoryRoot,
    );
    if (disallowedPath) {
      return `Command blocked by policy: path argument "${disallowedPath}" is outside the allowed workspace roots`;
    }
  }

  return null;
}

function areSessionToolsEnabled(): boolean {
  return getBuiltInToolsSecurityConfig().shellExecute.enabled;
}

export function createMcpServer(sessionManager: SessionManager, clientIp: string, options?: McpServerOptions): McpServer {
  const server = new McpServer({
    name: 'cli-server',
    version: '0.1.0',
  });

  const sessionShell = os.platform() === 'win32' ? 'powershell' : 'sh';

  server.tool(
    'shell_execute',
    `Execute a shell command on the desktop machine using ${sessionShell}. Returns stdout, stderr, exit code, signal, and working directory.`,
    {
      command: z.string().describe(`Shell command to execute (${sessionShell} syntax)`),
      cwd: z.string().optional().describe('Working directory'),
      timeout_seconds: z.number().int().positive().optional().describe('Optional timeout in seconds (default: 120)'),
    },
    async ({ command, cwd, timeout_seconds }) => {
      try {
        const securityConfig = getBuiltInToolsSecurityConfig().shellExecute;
        const effectiveCwd = resolveWorkingDirectory(cwd, options);
        const validationError = validateShellExecutionRequest(command, effectiveCwd, options);
        if (validationError) {
          return error(validationError, buildShellAllowlistDetails());
        }

        const requestedTimeoutSeconds = Math.max(1, timeout_seconds ?? 120);
        const timeoutSeconds = Math.min(requestedTimeoutSeconds, securityConfig.maxTimeoutSeconds);
        const sandboxEnv = securityConfig.sandboxExecution && effectiveCwd
          ? buildSandboxEnv(effectiveCwd)
          : undefined;
        const session = sessionManager.create(command, effectiveCwd, clientIp, false, sandboxEnv);
        const timeoutMs = timeoutSeconds * 1000;

        const waitResult = await sessionManager.wait(session.sessionId, {
          exited: true,
          timeout: timeoutMs,
        });

        if (waitResult.triggered === 'timeout' && waitResult.state === 'running') {
          sessionManager.kill(session.sessionId);
          await sessionManager.wait(session.sessionId, {
            exited: true,
            timeout: 5000,
          });
          return error(`Command timed out after ${timeoutSeconds} seconds`);
        }

        const info = sessionManager.getInfo(session.sessionId);
        const stdout = sessionManager.readOutput(session.sessionId, 'stdout', 0, Math.max(info.stdoutLength, 1)).data;
        const stderr = sessionManager.readOutput(session.sessionId, 'stderr', 0, Math.max(info.stderrLength, 1)).data;

        return json({
          stdout,
          stderr,
          exit_code: info.exitCode,
          signal: info.signal,
          cwd: info.cwd,
        });
      } catch (err) {
        return error(String(err));
      }
    },
  );

  server.tool(
    'file_read',
    'Read a UTF-8 text file from the desktop machine with an optional byte limit.',
    {
      path: z.string().describe('Absolute or relative file path to read'),
      encoding: z.string().optional().describe('Text encoding (default: utf-8)'),
      max_bytes: z.number().int().positive().optional().describe('Maximum bytes to read before truncation (default: 65536)'),
    },
    async ({ path, encoding, max_bytes }) => {
      try {
        const securityConfig = getBuiltInToolsSecurityConfig();
        const fileReadConfig = securityConfig.fileRead;
        const resolvedPath = resolveFilePath(path, options);
        if (!fileReadConfig.enabled) {
          return error('file_read is disabled by built-in tool policy', buildFileReadAllowlistDetails());
        }

        if (!fileReadConfig.allowRelativePaths && !pathModule.isAbsolute(path)) {
          return error('Relative paths are disabled by built-in tool policy', buildFileReadAllowlistDetails());
        }

        if (securityConfig.permissionProfile === 'full-local-admin' && fileReadConfig.allowedPaths.length === 0) {
          return error('file_read requires at least one allowed read root in full-local-admin mode', buildFileReadAllowlistDetails());
        }

        if (isWorkspaceScopedPermissionProfile(securityConfig.permissionProfile) && options?.enforcedWorkingDirectoryRoot && !pathMatchesRoot(resolvedPath, options.enforcedWorkingDirectoryRoot)) {
          return error(`Path must stay inside managed workspace: ${options.enforcedWorkingDirectoryRoot}`, buildFileReadAllowlistDetails());
        }

        if (fileReadConfig.allowedPaths.length > 0 && !isAllowedPath(resolvedPath, fileReadConfig.allowedPaths)) {
          return error('Path is outside the allowed read roots', buildFileReadAllowlistDetails());
        }

        const selectedEncoding = (encoding ?? 'utf-8') as BufferEncoding;
        const maxBytes = Math.min(Math.max(1, max_bytes ?? 64 * 1024), fileReadConfig.maxBytesPerRead);
        const fileStats = await stat(resolvedPath);
        if (fileStats.size > fileReadConfig.maxFileSizeBytes) {
          return error(`File size exceeds limit (${fileReadConfig.maxFileSizeBytes} bytes)`);
        }

        const buffer = await readFile(resolvedPath);
        const limited = buffer.subarray(0, maxBytes);

        return json({
          path: resolvedPath,
          encoding: selectedEncoding,
          content: limited.toString(selectedEncoding),
          bytes: limited.byteLength,
          max_bytes_applied: maxBytes,
          truncated: buffer.byteLength > limited.byteLength,
        });
      } catch (err) {
        return error(String(err));
      }
    },
  );

  if (options?.exposeManagedAdminTool) {
    server.tool(
      'remote_configure_mcp_server',
      'Create or update a managed external MCP server configuration on this desktop node. This is the official supported path for adding MCP servers locally when the built-in policy enables it.',
      {
        name: z.string().describe('Unique MCP server name used as the local config key'),
        transport: z.enum(['http', 'stdio']).describe('Transport type for the external MCP server'),
        enabled: z.boolean().optional().describe('Whether the configured MCP server is enabled locally (default: true)'),
        tool_prefix: z.string().optional().describe('Optional advertised tool prefix. Defaults to the server name.'),
        tools: z.array(z.string()).optional().describe('Optional allow-list of tools for this server. Remote publication now requires explicit tool names.'),
        trust_level: z.enum(['trusted', 'internal-reviewed', 'experimental', 'blocked']).optional().describe('Governance trust level for remote publication. New servers default to experimental.'),
        published_remotely: z.boolean().optional().describe('Whether this external MCP server may be published to the remote managed-client session.'),
        url: z.string().optional().describe('HTTP server URL when transport=http'),
        timeout: z.number().int().positive().optional().describe('Optional HTTP timeout in milliseconds when transport=http'),
        command: z.string().optional().describe('Command to launch when transport=stdio'),
        args: z.array(z.string()).optional().describe('Arguments for stdio transport'),
        cwd: z.string().optional().describe('Working directory for stdio transport'),
        env: z.record(z.string(), z.string()).optional().describe('Environment variables for stdio transport'),
      },
      async ({ name, transport, enabled, tool_prefix, tools, trust_level, published_remotely, url, timeout, command, args, cwd, env }) => {
        try {
          const result = await upsertManagedMcpServer({
            name,
            transport,
            enabled,
            toolPrefix: tool_prefix,
            tools,
            trustLevel: trust_level,
            publishedRemotely: published_remotely,
            url,
            timeout,
            command,
            args,
            cwd,
            env,
          });

          options?.onActivity?.(
            'mcp-servers',
            result.created ? 'remote-create' : 'remote-update',
            `Remote ${result.created ? 'created' : 'updated'} MCP server "${result.name}"`,
            'success',
            { name: result.name, transport, created: result.created, applied: result.applied, toolCount: result.toolCount },
          );

          return json({
            name: result.name,
            created: result.created,
            config: result.config,
            applied: result.applied,
            tool_count: result.toolCount,
            tools: result.tools,
            reason: result.reason ?? null,
          });
        } catch (err) {
          options?.onActivity?.(
            'mcp-servers',
            'remote-configure-error',
            `Remote configure MCP server "${name}" failed: ${String(err)}`,
            'error',
            { name, transport },
          );
          return error(String(err));
        }
      },
    );
  }

  // ── Tool: session_create ──
  server.tool(
    'session_create',
    `Create a new session and run a shell command. Commands are executed via ${sessionShell} on ${os.platform()} (${os.arch()}). Use ${sessionShell} syntax for pipes, redirects, and quoting.

After creating a session, use session_wait with idleMs (e.g. 5000-15000) to poll for output. This is the recommended pattern for commands that may take a while (e.g. network calls, API queries). Do NOT rely solely on exited — some commands produce output incrementally. Typical workflow:
1. session_create → get sessionId
2. session_wait(sessionId, idleMs=10000) → wait until output stabilizes
3. session_read_output → read the result
4. If still running and more output expected, repeat step 2-3`,
    {
      command: z.string().describe(`Shell command to execute (${sessionShell} syntax)`),
      cwd: z.string().optional().describe('Working directory'),
      enableStdin: z.boolean().optional().describe('Enable stdin pipe for interactive input (default: false). Only set to true if you plan to use session_stdin to send input. Most commands should leave this false.'),
    },
    async ({ command, cwd, enableStdin }) => {
      try {
        if (!areSessionToolsEnabled()) {
          return error('session tools are disabled by built-in tool policy');
        }

        const effectiveCwd = resolveWorkingDirectory(cwd, options);
        const validationError = validateShellExecutionRequest(command, effectiveCwd, options);
        if (validationError) {
          return error(validationError, buildShellAllowlistDetails());
        }

        const shellConfig = getBuiltInToolsSecurityConfig().shellExecute;
        const sandboxEnv = shellConfig.sandboxExecution && effectiveCwd
          ? buildSandboxEnv(effectiveCwd)
          : undefined;
        const info = sessionManager.create(command, effectiveCwd, clientIp, enableStdin ?? false, sandboxEnv);
        emitServerEvent('session:created', { sessionId: info.sessionId, command, clientIp });
        return json(info);
      } catch (err) {
        return error(String(err));
      }
    },
  );

  // ── Tool: session_stdin ──
  server.tool(
    'session_stdin',
    `Write data to a session's stdin pipe (requires enableStdin=true at creation).

Data encoding: The data string is written to stdin exactly as received after JSON decoding — no additional escape processing is performed. Standard JSON string escapes apply at the protocol level:
- JSON "\\n" → newline (0x0A) — use to send line input or press Enter
- JSON "\\t" → tab (0x09)
- JSON "\\\\" → literal backslash

Set close=true to close the stdin pipe (sends EOF) after writing. This is required for commands that read all of stdin before processing (e.g. piped input, heredocs).

Common patterns:
- Send a line of input: data="hello\\n"
- Send input then EOF: data="my question\\n", close=true
- Just send EOF (no data): close=true
- Multi-line input: data="line1\\nline2\\nline3\\n"`,
    {
      sessionId: z.string().describe('Session ID'),
      data: z.string().optional().describe('Raw data to write to stdin. Use JSON string escapes for control characters: \\n for newline, \\t for tab, \\\\ for backslash. Data is written as-is after JSON decoding.'),
      close: z.boolean().optional().describe('Close stdin after writing (sends EOF). Default: false'),
    },
    async ({ sessionId, data, close }) => {
      try {
        if (!areSessionToolsEnabled()) {
          return error('session tools are disabled by built-in tool policy');
        }

        sessionManager.writeStdin(sessionId, data ?? '', close ?? false);
        return json({ success: true });
      } catch (err) {
        return error(String(err));
      }
    },
  );

  // ── Tool: session_kill ──
  server.tool(
    'session_kill',
    'Kill a running session (kills entire process tree on Windows)',
    {
      sessionId: z.string().describe('Session ID'),
    },
    async ({ sessionId }) => {
      try {
        if (!areSessionToolsEnabled()) {
          return error('session tools are disabled by built-in tool policy');
        }

        sessionManager.kill(sessionId);
        return json({ success: true });
      } catch (err) {
        return error(String(err));
      }
    },
  );

  // ── Tool: session_read_output ──
  server.tool(
    'session_read_output',
    'Read stdout or stderr output from a session with pagination',
    {
      sessionId: z.string().describe('Session ID'),
      stream: z.enum(['stdout', 'stderr']).describe('Which output stream to read'),
      offset: z.number().optional().describe('Character offset (default: 0)'),
      limit: z.number().optional().describe('Max characters to return (default: 4096)'),
    },
    async ({ sessionId, stream, offset, limit }) => {
      try {
        if (!areSessionToolsEnabled()) {
          return error('session tools are disabled by built-in tool policy');
        }

        const result = sessionManager.readOutput(sessionId, stream, offset ?? 0, limit ?? 4096);
        return json(result);
      } catch (err) {
        return error(String(err));
      }
    },
  );

  // ── Tool: session_wait ──
  server.tool(
    'session_wait',
    `Wait for a session to meet one of several conditions (OR semantics). Returns when the first condition is met. A safety timeout of 5 minutes is always applied.

Recommended usage patterns:
- Fast commands (ls, cat, echo): use exited=true, timeoutMs=10000
- Slow commands (network/API calls like workiq, curl): use idleMs=10000 to detect when output stops, then read output. Repeat if the process is still running.
- Long-running processes: combine idleMs + exited for incremental output reading

The idleMs condition triggers when no new stdout/stderr output has been produced for N milliseconds, which is ideal for detecting that a command has finished producing its response even if the process hasn't exited yet.`,
    {
      sessionId: z.string().describe('Session ID'),
      exited: z.boolean().optional().describe('Wait until the session exits'),
      timeoutMs: z.number().optional().describe('Max milliseconds to wait (default: 300000 = 5 min)'),
      idleMs: z.number().optional().describe('Trigger after no output for N ms'),
      tailLength: z.number().optional().describe('Include last N chars of stdout/stderr in result'),
    },
    async ({ sessionId, exited, timeoutMs, idleMs, tailLength }) => {
      if (!areSessionToolsEnabled()) {
        return error('session tools are disabled by built-in tool policy');
      }

      if (!exited && !timeoutMs && !idleMs) {
        return error('At least one condition required (exited, timeoutMs, or idleMs)');
      }
      // Always enforce a max timeout to prevent indefinite waits
      const safeTimeout = Math.min(timeoutMs ?? 300_000, 300_000);
      try {
        const result = await sessionManager.wait(
          sessionId,
          { exited, timeout: safeTimeout, idle: idleMs },
          tailLength ?? 0,
        );
        return json(result);
      } catch (err) {
        return error(String(err));
      }
    },
  );

  // ── Tool: session_list ──
  server.tool(
    'session_list',
    'List sessions with optional state filter and pagination',
    {
      state: z.enum(['running', 'exited', 'all']).optional().describe('Filter by state (default: all)'),
      offset: z.number().optional().describe('Pagination offset (default: 0)'),
      limit: z.number().optional().describe('Max results (default: 20)'),
    },
    async ({ state, offset, limit }) => {
      if (!areSessionToolsEnabled()) {
        return error('session tools are disabled by built-in tool policy');
      }

      const result = sessionManager.list(state ?? 'all', offset ?? 0, limit ?? 20);
      return json(result);
    },
  );

  // ── Tool: session_info ──
  server.tool(
    'session_info',
    'Get detailed information about a specific session',
    {
      sessionId: z.string().describe('Session ID'),
    },
    async ({ sessionId }) => {
      try {
        if (!areSessionToolsEnabled()) {
          return error('session tools are disabled by built-in tool policy');
        }

        const info = sessionManager.getInfo(sessionId);
        return json(info);
      } catch (err) {
        return error(String(err));
      }
    },
  );

  // ── Resource: machine info ──
  server.resource(
    'machine-info',
    'machine://info',
    {
      description: 'System information about the host machine',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'machine://info',
        mimeType: 'application/json',
        text: JSON.stringify({
          os: `${os.type()} ${os.release()}`,
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          homedir: os.homedir(),
          shell: process.env.SHELL || process.env.COMSPEC || '',
          sessionShell,
          uptime: os.uptime(),
          cpus: os.cpus().length,
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
        }),
      }],
    }),
  );


  return server;
}

function pathModuleIsAbsolute(value: string): boolean {
  return pathModule.isAbsolute(value);
}

// ── Mount MCP Streamable HTTP endpoint on Express ──

export function mountMcpEndpoints(
  app: Express,
  sessionManager: SessionManager,
): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — reuse transport
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      const clientIp = req.socket.remoteAddress || 'unknown';
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const server = createMcpServer(sessionManager, clientIp);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID' },
      id: null,
    });
  });

  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      transports.delete(sessionId);
    } else {
      res.status(404).send('Session not found');
    }
  });
}
