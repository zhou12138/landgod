# MCP Directory Autodiscovery V1

## Status

V1 has been implemented as a manifest-driven bundled MCP discovery system.

Implemented pieces:

- discovery module: [src/main/managed-client/bundled-mcp-discovery.ts](c:/edge_workspace_1/cli-server/src/main/managed-client/bundled-mcp-discovery.ts)
- manifest schema: [mcp-servers/landgod.mcp.schema.json](c:/edge_workspace_1/cli-server/mcp-servers/landgod.mcp.schema.json)
- unit tests: [tests/bundled-mcp-discovery.test.cjs](c:/edge_workspace_1/cli-server/tests/bundled-mcp-discovery.test.cjs)
- manifests for the current bundled MCP servers:
  - [mcp-servers/computer-use/landgod.mcp.json](c:/edge_workspace_1/cli-server/mcp-servers/computer-use/landgod.mcp.json)
  - [mcp-servers/pptx-editor/landgod.mcp.json](c:/edge_workspace_1/cli-server/mcp-servers/pptx-editor/landgod.mcp.json)
  - [mcp-servers/shiproom-mcp/landgod.mcp.json](c:/edge_workspace_1/cli-server/mcp-servers/shiproom-mcp/landgod.mcp.json)

The rest of this document describes the implemented V1 behavior and the rationale behind it.

---

## Goal

Allow new bundled MCP servers under [mcp-servers](c:/edge_workspace_1/cli-server/mcp-servers) to be discovered without adding hardcoded injection logic to [src/main/managed-client/config.ts](c:/edge_workspace_1/cli-server/src/main/managed-client/config.ts).

Desired outcome:

- adding `mcp-servers/foo` should not require editing `config.ts`
- each bundled MCP should declare how it is started and published
- Worker startup should remain predictable and auditable
- existing behavior for `computer-use`, `shiproom`, and `pptx-editor` should continue to work

---

## Non-Goals

This design is not trying to:

- auto-publish arbitrary directories with no metadata
- execute unknown code just because it exists in the tree
- replace `managed-client.mcp-servers.json`
- remove trust, tool allow-list, or publication policy controls

The system should remain explicit and governed.

---

## Current Problem

Today the Worker uses hardcoded detection and injection for specific bundled MCP servers:

- `computer-use`
- `shiproom`
- `pptx-editor`

That creates several issues:

1. each new bundled MCP requires code changes in startup config logic
2. MCP-specific path and detection logic is spread across multiple files
3. the `mcp-servers` directory is only a storage convention, not a true discovery boundary
4. product teams cannot add a new bundled MCP without touching runtime wiring

---

## Implemented Design

### Core Idea

Each bundled MCP server can declare a manifest file in its server directory.

Example path:

```text
mcp-servers/<server-name>/landgod.mcp.json
```

Worker startup now:

1. enumerate `mcp-servers/*`
2. load `landgod.mcp.json` if present
3. validate the manifest
4. evaluate its availability checks
5. synthesize a `ManagedClientFileMcpServerConfig`
6. merge it with user overrides from `managed-client.mcp-servers.json`

---

## Manifest Schema

The JSON schema lives at [mcp-servers/landgod.mcp.schema.json](c:/edge_workspace_1/cli-server/mcp-servers/landgod.mcp.schema.json).

Minimal example:

```json
{
  "name": "computer-use",
  "kind": "bundled-mcp",
  "transport": "stdio",
  "commandStrategy": {
    "type": "python-module",
    "module": "landgod_computer_use",
    "pythonPath": "."
  },
  "availability": {
    "platforms": ["win32", "linux", "darwin"],
    "python": true,
    "import": "landgod_computer_use"
  },
  "publication": {
    "enabled": true,
    "publishedRemotely": true,
    "trustLevel": "trusted",
    "requiredPermissionProfile": "command-only"
  },
  "tools": [
    "computer_screenshot",
    "computer_click",
    "computer_type",
    "computer_scroll"
  ]
}
```

Suggested top-level fields:

- `name`
- `kind`
- `transport`
- `commandStrategy`
- `availability`
- `publication`
- `tools`
- `envTemplate`
- `notes`

---

## Command Strategy Variants

The manifest must support the three patterns already present in the repo.

### 1. Python Module

Used by `computer-use` and `pptx-editor`.

```json
{
  "type": "python-module",
  "module": "landgod_pptx_editor",
  "pythonPath": "."
}
```

Runtime expansion:

- detect python executable
- set `PYTHONPATH` to the MCP directory if requested
- execute `python -m <module>`

### 2. Python Script

Used by `shiproom-mcp`.

```json
{
  "type": "python-script",
  "script": "server.py"
}
```

Runtime expansion:

- detect python executable
- execute `python <resolved script path>`

### 3. Custom Command Template

Reserved for future flexibility.

```json
{
  "type": "command-template",
  "command": "python",
  "args": ["-m", "my_server"]
}
```

This should be supported, but only after validation and explicit allowlisting of what a bundled MCP manifest may declare.

---

## Availability Checks

The manifest should allow declarative checks instead of custom per-server logic in `config.ts`.

Suggested support:

- `platforms`: allowed `process.platform` values
- `python`: whether a Python command is required
- `import`: Python import that must succeed
- `exists`: relative files that must exist
- `env`: required environment variables

Example for `shiproom-mcp`:

```json
{
  "availability": {
    "python": true,
    "exists": ["server.py", "scripts/cloud_cli.py"]
  }
}
```

Example for `pptx-editor`:

```json
{
  "availability": {
    "platforms": ["win32"],
    "python": true,
    "import": "landgod_pptx_editor",
    "exists": ["landgod_pptx_editor/__init__.py"]
  }
}
```

---

## Publication Model

The manifest should declare only the default publication behavior.

Suggested fields:

- `enabled`
- `publishedRemotely`
- `trustLevel`
- `requiredPermissionProfile`
- `tools`
- `toolPrefix`

User config in `managed-client.mcp-servers.json` must still be able to override these.

Priority should be:

1. built-in manifest provides defaults
2. user config overrides manifest for the same server name
3. disabled user config can fully suppress a bundled MCP

---

## Runtime Merge Model

### Current

```text
hardcoded injected configs + user config -> effectiveMcpConfig
```

### Proposed

```text
directory manifests -> discovered bundled MCP defaults
discovered defaults + user config -> effectiveMcpConfig
```

This keeps the rest of the runtime mostly unchanged.

The main refactor point is replacing hardcoded injection blocks inside `getManagedClientRuntimeConfig()` with a single call such as:

```ts
const discoveredBundledServers = discoverBundledMcpServers({ args, fileConfig, userMcpConfig });
```

---

## Implemented Refactor Shape

### Discovery Module

The implementation uses:

```text
src/main/managed-client/bundled-mcp-discovery.ts
```

Responsibilities:

- enumerate `mcp-servers` directory
- load and validate manifests
- evaluate availability
- expand command strategy into `ManagedClientFileMcpServerConfig`
- merge with user config precedence rules

The old hardcoded injection path in `config.ts` has been replaced by `discoverBundledMcpServers(...)` for both runtime config and display config.

---

## Migration Notes

Completed in V1:

- manifest files added for the three existing bundled MCP servers
- loader and manifest expansion module added
- `computer-use`, `shiproom`, and `pptx-editor` switched to manifest-driven injection
- hardcoded injected config blocks removed from `config.ts`

Still useful follow-up work:

- generate type definitions from the JSON schema
- add a dedicated manifest authoring guide
- validate manifests against the JSON schema in CI

---

## Benefits

### For Engineering

- fewer startup code changes when adding a bundled MCP
- one discovery model instead of N custom branches
- clearer ownership boundary between MCP package and Worker runtime

### For Product

- `mcp-servers/` becomes a real extension surface
- new domain MCPs can be added faster
- bundled MCP packaging becomes more understandable

### For Governance

- every bundled MCP explicitly declares trust, publication intent, and tool list
- easier review of what gets exposed to remote agents
- clearer audit trail for platform capability growth

---

## Risks

### 1. Over-Automation

If manifests are too permissive, a dropped-in directory could become executable without enough governance.

Mitigation:

- require explicit manifest presence
- validate manifest schema strictly
- keep user override precedence
- keep publication allow-list rules

### 2. Complex Per-Server Detection

Some servers have nontrivial availability rules, especially `pptx-editor`.

Mitigation:

- support a small set of declarative checks first
- allow the discovery layer to call named helper strategies when necessary

### 3. Drift Between Manifest And Reality

Tools declared in manifest may drift from actual `listTools()` output.

Mitigation:

- treat manifest `tools` as intended publication allow-list
- still use runtime `listTools()` as the source of actual tool presence

---

## Recommendation

Implement this as a **manifest-driven bundled MCP discovery system**, not as a blind directory scan.

That preserves the governance model while removing the current need to hardcode every bundled MCP in `config.ts`.

In short:

- yes to directory-level discovery
- no to directory-level implicit execution
- use explicit manifests as the contract
