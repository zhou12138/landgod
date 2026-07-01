# Domain MCP List

This document explains how the MCP servers under [mcp-servers](c:/edge_workspace_1/cli-server/mcp-servers) map to the LandGod / MCPHub mission.

Mission framing:

**AI does the reasoning. LandGod provides the execution network.**

These MCP servers are not identical in abstraction level. Together, they represent three different layers of enterprise execution capability.

---

## Why This Directory Exists

The servers in this directory demonstrate that LandGod / MCPHub can expose more than shell commands.

They show three kinds of capability:

1. generic desktop action capability
2. specialized local application capability
3. domain workflow capability

That layering matters because enterprise execution usually evolves in this order:

1. first make the machine operable
2. then make the desktop application operable
3. then encapsulate the business workflow as a domain MCP

---

## 1. computer-use

Path: [mcp-servers/computer-use](c:/edge_workspace_1/cli-server/mcp-servers/computer-use)

### What It Is

`computer-use` is a generic desktop action MCP.

It exposes low-level GUI actions such as:

- screenshot
- click
- type
- scroll

### Capability Layer

This is the **generic machine interaction layer**.

It is the closest thing to giving the agent hands and eyes on a desktop.

### Best-Fit Mission Scenarios

Use this when the capability is trapped in:

- a legacy internal website
- a Windows desktop client
- a portal with no usable API
- a browser flow that still depends on real page interaction

Examples:

- ERP login page interaction
- clicking through an internal export workflow
- handling browser dialogs or popups
- taking screenshots for verification

### Security / Governance Interpretation

`computer-use` is powerful but high risk because it exposes low-level action primitives rather than business meaning.

It can support the mission, but it should usually be treated as:

- a PoC accelerator
- a fallback execution layer
- a bridge until a stronger domain MCP exists

It is the least opinionated and therefore the least governance-friendly of the three.

### Summary

**Role:** generic action layer  
**Strength:** broad coverage  
**Weakness:** weak business boundary  
**Mission mapping:** lets AI operate real machines before the workflow is domain-encapsulated

---

## 2. pptx-editor

Path: [mcp-servers/pptx-editor](c:/edge_workspace_1/cli-server/mcp-servers/pptx-editor)

### What It Is

`pptx-editor` is a specialized local application MCP for Microsoft PowerPoint.

It exposes application-specific tools such as:

- `pptx_open`
- `pptx_inspect`
- `pptx_exec_actions`
- `pptx_exec_code`
- `pptx_save`
- `pptx_close`

### Capability Layer

This is the **specialized desktop application layer**.

It sits above generic mouse/keyboard automation and below full business workflow encapsulation.

### Best-Fit Mission Scenarios

Use this when execution must happen in a real Windows + Office environment:

- management deck generation
- template-based reporting
- PowerPoint inspection and patching
- enterprise presentation automation

Examples:

- producing a board update deck from structured data
- editing a PPT while preserving enterprise formatting
- automating slide-level content replacement

### Security / Governance Interpretation

`pptx-editor` is much narrower than `computer-use`.

It does not primarily expose generic control of the whole desktop. Instead, it exposes a constrained capability around one local application domain: PowerPoint.

That makes it more governance-friendly than `computer-use`, because:

- the tool surface is narrower
- the execution intent is clearer
- the returned artifacts are naturally scoped to PPT work

### Summary

**Role:** specialized application layer  
**Strength:** precise, high-value local app execution  
**Weakness:** platform-specific and app-specific  
**Mission mapping:** proves that enterprise-local application power can remain on the original machine while still becoming agent-callable

---

## 3. shiproom-mcp

Path: [mcp-servers/shiproom-mcp](c:/edge_workspace_1/cli-server/mcp-servers/shiproom-mcp)

### What It Is

`shiproom-mcp` is a domain workflow MCP.

It is not a generic desktop tool and not only an application adapter. It is a business-domain toolset that encapsulates a real workflow around:

- SharePoint
- Loop
- Teams-related notes
- meeting preparation
- archival and rendering
- update and document workflows

### Capability Layer

This is the **domain MCP layer**.

It represents the direction LandGod should move toward for sensitive or repeatable business execution.

### Best-Fit Mission Scenarios

Use this pattern when the real target is not “click this app” but “execute this business workflow safely”.

Examples:

- team operating cadence
- meeting pack generation
- structured content sync across collaboration tools
- domain-specific update / archive / reporting flows

### Security / Governance Interpretation

`shiproom-mcp` is the strongest match for the mission of keeping credentials, permissions, and execution inside the user's own environment while reducing what is exposed to the agent.

Why:

- the tool boundary is business-semantic, not coordinate-semantic
- local credentials and browser state remain on the original machine
- the MCP can return only the business-relevant result instead of exposing the whole UI surface
- approvals, allowlists, and audit become easier to reason about at the workflow level

This is the most mission-aligned model for enterprise deployment.

### Summary

**Role:** domain workflow layer  
**Strength:** best governance and best business fit  
**Weakness:** domain-specific, higher design cost  
**Mission mapping:** the clearest expression of LandGod as enterprise execution infrastructure rather than remote control

---

## Layered Interpretation

These three MCPs form a useful capability ladder:

1. `computer-use` — make the machine operable
2. `pptx-editor` — make the application operable
3. `shiproom-mcp` — make the business workflow operable

Another way to say it:

- `computer-use` gives the agent hands
- `pptx-editor` gives the agent a specialized toolbench
- `shiproom-mcp` gives the agent a business role

---

## How They Map To Enterprise Scenarios

### ERP / Internal Legacy System

- `computer-use` can log in, click through screens, trigger exports, and handle UI flows
- a future ERP domain MCP should encapsulate the actual business actions

### Finance / UKey / Sensitive Portals

- `computer-use` can be used as a bootstrap or fallback layer
- the long-term target should be a finance domain MCP so credentials stay local and exposed capabilities stay narrow

### Office Reporting

- `pptx-editor` is already the correct abstraction for PPT-based enterprise reporting
- a future Excel domain MCP could complement it for workbook-heavy flows

### Collaboration / Knowledge Workflow

- `shiproom-mcp` already demonstrates the domain MCP pattern for collaboration-heavy business processes

---

## Recommended Product Guidance

When positioning LandGod / MCPHub, use these servers to explain the mission like this:

- `computer-use` shows that LandGod can reach non-API desktop environments
- `pptx-editor` shows that LandGod can execute real local application work, not just shell commands
- `shiproom-mcp` shows that LandGod can encapsulate business workflows as governed domain tools

The long-term product direction should move sensitive, repetitive enterprise tasks upward from generic desktop control into domain MCPs.

That is how LandGod becomes enterprise execution infrastructure instead of just remote machine control.
