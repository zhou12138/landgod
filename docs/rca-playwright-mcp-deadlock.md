# RCA: Playwright MCP Tool Call Deadlock

**Date**: 2026-05-26  
**Severity**: P1 — `shiproom_fetch_loop` tool completely non-functional via MCP  
**Status**: Resolved  

## Symptom

`shiproom_fetch_loop` called via MCP Hub → Gateway → WebSocket → Electron → StdioClientTransport → Python `server.py` would hang indefinitely. Chrome never launched; no error output visible.

Running the same code directly via CLI (`python cloud_cli.py fetch-loop`) worked perfectly.

## Root Cause

Two independent issues compounded:

### 1. `subprocess.check_call` inheriting MCP protocol stdin (PRIMARY)

`_ensure_playwright()` in `loop_fetch.py` called:

```python
subprocess.check_call(
    [sys.executable, "-m", "playwright", "--version"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
```

**No `stdin` override** — the child process inherited the parent's stdin.

In CLI mode, stdin is the terminal — harmless.  
In MCP mode, stdin is a **JSON-RPC protocol pipe** managed by `StdioClientTransport`. The `playwright --version` subprocess inherited this pipe, creating a race condition / deadlock on the shared stdin file descriptor. The MCP protocol reader and the subprocess both competed to read from the same pipe, causing the entire process to freeze.

### 2. `stderr: 'pipe'` hiding all diagnostic output (SECONDARY)

`mcp-tool-registry.ts` spawned the Python MCP server with:

```typescript
new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    stderr: 'pipe',   // ← all Python stderr silently consumed
});
```

All Python `sys.stderr` and `sys.__stderr__` output was piped into the MCP SDK and never surfaced anywhere visible. This made it impossible to see where the hang occurred — no error messages, no Playwright logs, no trace output.

## Fix

| File | Change |
|------|--------|
| `loop_fetch.py` | Added `stdin=subprocess.DEVNULL` to all `subprocess.check_call` invocations in `_ensure_playwright()` |
| `mcp-tool-registry.ts` | Changed `stderr: 'pipe'` → `stderr: 'inherit'` (both spawn sites, lines ~327 and ~544) |

## Commits

- `86ec38e` — `stderr: 'inherit'` for MCP subprocess
- `c4c25d2` — `stdin=subprocess.DEVNULL` fix + trace logging

## Lesson Learned

Any Python code running inside an MCP stdio server **must never** spawn subprocesses that inherit stdin, because stdin is the MCP protocol channel. All subprocess calls should use `stdin=subprocess.DEVNULL` (or `subprocess.PIPE` with explicit input).

This applies to:
- `subprocess.run()` / `check_call()` / `Popen()`
- Any library that internally spawns processes (e.g., `pip`, `playwright install`)

**Rule**: In MCP stdio servers, always set `stdin=subprocess.DEVNULL` for child processes.
