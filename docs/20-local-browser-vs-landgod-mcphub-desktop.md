# 20. Local Browser vs LandGod MCPHub Desktop

> Purpose: compare two different Agent execution surfaces: **Local Browser** and **LandGod MCPHub Desktop**.
>
> Key framing: **MCPHub Desktop is the LandGod system** — Gateway / MCPHub control plane + registered Worker / desktop client / enterprise machine execution plane.

---

## 1. One-Sentence Summary

```text
Local Browser is the browser/webpage execution surface.
LandGod MCPHub Desktop is the enterprise machine/desktop execution surface.
```

They both extend what an Agent can do, but they extend it in very different directions.

```text
Local Browser:
  Agent -> user's current browser -> web pages / DOM / cookies / SSO session

LandGod MCPHub Desktop:
  Agent -> LandGod Gateway / MCPHub -> registered Worker machine -> desktop apps / local tools / enterprise resources
```

---

## 2. High-Level Architecture Comparison

```text
+--------------------------------------------------------------------------------+
|                                  Agent Layer                                   |
|                                                                                |
|        OpenClaw / Claude / ChatGPT / LangGraph / Dify / Custom Agent            |
+-------------------------------+------------------------------------------------+
                                |
                                | tool request
                                v
        +-----------------------+------------------------+
        |                                                |
        v                                                v
+----------------------+                         +-------------------------------+
| Local Browser Path   |                         | LandGod MCPHub Desktop Path    |
+----------------------+                         +-------------------------------+
| Browser Extension    |                         | LandGod Gateway / MCPHub       |
| local_browser_event  |                         | Policy / Routing / Audit       |
+----------+-----------+                         +---------------+---------------+
           |                                                     |
           | controls current browser                            | outbound WS tool_call
           v                                                     v
+----------+-----------+                         +---------------+---------------+
| User Browser         |                         | Registered Worker / Desktop    |
| Chrome / Edge        |                         | Windows / Linux / macOS        |
+----------+-----------+                         +---------------+---------------+
           |                                                     |
           | DOM / JS / cookies / web session                    | MCP tools / desktop / files
           v                                                     v
+----------+-----------+                         +---------------+---------------+
| Web Sites / SaaS     |                         | Enterprise Resources           |
| Web pages            |                         | Office / PPT / ERP / UKey      |
| Web apps             |                         | Browser login state / CLI      |
+----------------------+                         +-------------------------------+
```

The key difference is **where execution happens**:

```text
Local Browser executes inside the user's browser.
LandGod MCPHub Desktop executes inside registered enterprise machines.
```

---

## 3. Capability Boundary

### Local Browser

Local Browser solves:

```text
Can the Agent operate the user's current browser and webpage state?
```

It is optimized for:

- webpage navigation;
- webpage reading;
- DOM interaction;
- clicking buttons and links;
- filling forms;
- scrolling;
- executing page JavaScript;
- taking page screenshots;
- reusing current browser cookies, SSO, and login state.

Typical tools:

```text
browser_navigate
browser_view
browser_click
browser_input
browser_scroll
browser_execute_js
```

Best for:

```text
web apps
SaaS portals
pages requiring user's current logged-in browser session
JS-rendered websites
browser-only workflows
```

Not good for:

```text
desktop apps
PowerPoint control
file explorer
system windows
UKey-bound desktop clients
machine-local CLI tools
non-browser enterprise software
```

### LandGod MCPHub Desktop

LandGod MCPHub Desktop solves:

```text
Can the Agent operate capabilities exposed by a registered enterprise machine?
```

It is optimized for:

- remote desktop screenshots;
- desktop automation;
- PowerPoint / Office tooling;
- machine-local files;
- local CLI tools;
- intranet-only systems;
- ERP / finance clients;
- UKey / certificate machines;
- Worker-hosted MCP servers;
- machine-bound login state;
- governed enterprise execution.

Typical tools:

```text
computer_screenshot
computer_click
computer_type
computer_scroll
pptx_open
pptx-slide-image
shell_execute
file_read
business-report-demo.run_monthly_close_demo
shiproom_fetch_loop
custom MCP tools exposed by the Worker
```

Best for:

```text
desktop apps
Office / PowerPoint / Excel
enterprise machines
local CLI/no-API tools
intranet-only resources
ERP/finance systems
browser state that exists on a specific remote machine
machine-bound credentials or certificates
```

Not good for:

```text
quick one-off webpage operations already available in the user's current browser
pure DOM-level interaction when a browser extension can do it faster
```

---

## 4. Component-Level Comparison

| Dimension | Local Browser | LandGod MCPHub Desktop |
|---|---|---|
| Product role | Browser/web execution surface | Enterprise machine/desktop execution surface |
| Execution location | User's current browser | Registered Worker / desktop client / enterprise machine |
| Main dependency | Browser extension + backend event bridge | LandGod Gateway + Worker + MCP tools |
| Control plane | Usually lightweight event relay | Gateway / MCPHub governance plane |
| Target object | Web page / DOM / tab | Machine / desktop / local tools / enterprise resources |
| Login state source | Current browser cookies / SSO | Worker machine session, browser profile, desktop login, UKey, local config |
| Typical state | Webpage DOM and JS state | Desktop state, app state, local filesystem, local network, MCP runtime |
| Tool style | Browser actions | Device / MCP / tool calls |
| Screenshot type | Browser/page screenshot | Desktop/window/tool-specific screenshots |
| Security boundary | Browser permission + extension boundary | Gateway policy + Worker trust + Credential Broker + audit |
| Best value | Reuse user's active browser login | Execute inside real enterprise machines |
| Main risk | Webpage prompt/data injection | Remote execution, credential misuse, Worker trust, MCP supply chain |
| Audit need | Page/tool-call trace | Enterprise-grade Gateway/Worker/Credential audit |

---

## 5. Execution Flow: Local Browser

```text
+--------+      browser tool call       +---------------------+
| Agent  | ---------------------------> | Backend Tool Layer  |
+--------+                              | local_browser_event |
                                        +----------+----------+
                                                   |
                                                   | event bridge
                                                   v
                                        +----------+----------+
                                        | Browser Extension   |
                                        | Chrome / Edge       |
                                        +----------+----------+
                                                   |
                                                   | DOM / JS / tab action
                                                   v
                                        +----------+----------+
                                        | User Browser Page   |
                                        | SaaS / website      |
                                        +----------+----------+
                                                   |
                                                   | page view / screenshot / result
                                                   v
+--------+      tool result             +----------+----------+
| Agent  | <--------------------------- | Backend Tool Layer  |
+--------+                              +---------------------+
```

Important property:

```text
The browser session belongs to the user.
The Agent benefits from existing cookies, SSO, and page state.
```

---

## 6. Execution Flow: LandGod MCPHub Desktop

```text
+--------+     tool_call / MCP request      +--------------------------+
| Agent  | -------------------------------> | LandGod Gateway / MCPHub |
+--------+                                  +------------+-------------+
                                                        |
                                                        | auth / policy / routing
                                                        v
                                           +------------+-------------+
                                           | Worker Registry          |
                                           | Tool Registry            |
                                           | Credential Broker        |
                                           | Audit                    |
                                           +------------+-------------+
                                                        |
                                                        | outbound WebSocket channel
                                                        v
                                           +------------+-------------+
                                           | Registered Worker        |
                                           | Desktop / enterprise box |
                                           +------------+-------------+
                                                        |
                     +----------------------------------+----------------------------------+
                     |                                  |                                  |
                     v                                  v                                  v
        +------------+------------+        +------------+------------+        +------------+------------+
        | Desktop Automation      |        | Local MCP Tools         |        | Local Enterprise State  |
        | screenshot/click/type   |        | Office/PPT/finance/etc  |        | files/browser/UKey/ERP  |
        +------------+------------+        +------------+------------+        +------------+------------+
                     |                                  |                                  |
                     +----------------------------------+----------------------------------+
                                                        |
                                                        | result / artifact / audit
                                                        v
+--------+       tool result               +------------+-------------+
| Agent  | <------------------------------ | LandGod Gateway / MCPHub |
+--------+                                  +--------------------------+
```

Important property:

```text
Execution happens where the enterprise capability actually lives.
The Agent does not need direct network access, desktop access, or secret values.
```

---

## 7. Login State and Credential Difference

### Local Browser Login State

```text
User browser already logged in
        |
        v
Agent controls the current page through extension
        |
        v
Website sees normal browser cookies/session
```

The strength is convenience:

```text
No credential broker needed if the user browser already has the session.
```

The limitation:

```text
Only helps with browser-based resources reachable from that browser.
```

### LandGod MCPHub Desktop Login State

```text
Enterprise machine already has local capability
        |
        +-- desktop app login
        +-- browser profile login
        +-- UKey / certificate
        +-- intranet routing
        +-- local files/scripts
        +-- configured MCP tools
        |
        v
Worker exposes governed tools through Gateway
```

The strength is enterprise realism:

```text
Many enterprise tasks can only run on a specific machine or network segment.
```

The risk is higher, so LandGod needs stronger governance:

```text
Policy
Approval
Credential Broker
Worker trust boundary
Audit
Tool allowlist
RBAC
```

---

## 8. Return Result Difference

### Local Browser Results

Typical result shapes:

```text
page text
DOM element list
current URL
browser screenshot
downloaded content
JavaScript execution result
```

The output is usually webpage-centric.

### LandGod MCPHub Desktop Results

Typical result shapes:

```text
image_base64 from desktop screenshot
PPT slide preview
file content
shell stdout/stderr/exit_code
business artifact paths
MCP tool JSON result
credential-audited operation result
machine capability result
```

The output is usually machine/tool/artifact-centric.

---

## 9. When to Choose Which

```text
Need to open a website, click around, read data from current web session?
=> Local Browser
```

```text
Need to control a registered desktop, inspect PowerPoint, use local files,
run enterprise machine tools, or operate intranet-only systems?
=> LandGod MCPHub Desktop
```

```text
Need user's current browser login state specifically?
=> Local Browser
```

```text
Need a specific enterprise machine's environment, network, desktop session,
UKey, certificate, Office installation, or local MCP tools?
=> LandGod MCPHub Desktop
```

```text
Need a governed, auditable execution path for enterprise Agent work?
=> LandGod MCPHub Desktop
```

---

## 10. Scenario Examples

| Scenario | Better Choice | Reason |
|---|---|---|
| Read a SaaS dashboard already open in user's Chrome | Local Browser | Reuses current browser cookies and DOM state |
| Fill a web form in the user's active browser session | Local Browser | Direct page interaction is enough |
| Take screenshot of a remote Windows desktop | LandGod MCPHub Desktop | Requires desktop/Worker execution surface |
| Generate monthly finance report from ERP + Excel files | LandGod MCPHub Desktop | Needs enterprise machine, local tools, credentials, audit |
| Inspect a PowerPoint slide preview | LandGod MCPHub Desktop | PPT is desktop/app/file capability |
| Run a local CLI tool with no cloud API | LandGod MCPHub Desktop | CLI exists only on the Worker machine |
| Access an intranet-only ERP from a finance LAN | LandGod MCPHub Desktop | Network location matters |
| Use a UKey/certificate-bound system | LandGod MCPHub Desktop | Credential/device binding matters |
| Scrape visible page data from current browser | Local Browser | Browser DOM access is simpler |
| Run controlled tools on a sensitive Worker with audit | LandGod MCPHub Desktop | Governance and audit are required |

---

## 11. Product Boundary

### Local Browser Product Boundary

```text
Browser-local assistant capability.
```

It lets Agents operate the user's browser.

It should focus on:

- browser action fidelity;
- page observation;
- DOM extraction;
- session reuse;
- extension reliability;
- low-latency web tasks.

### LandGod MCPHub Desktop Product Boundary

```text
Enterprise execution harness.
```

It lets Agents operate registered machines under governance.

It should focus on:

- Worker registration;
- device inventory;
- tool discovery;
- policy and approval;
- credential boundary;
- audit evidence;
- desktop and local MCP capabilities;
- enterprise deployment topology;
- Worker trust profiles.

---

## 12. Security Review

### Local Browser Security Concerns

```text
webpage prompt injection
malicious DOM content
cross-site data leakage
browser extension permission scope
accidental action in user's active session
```

Mitigation direction:

```text
human confirmation for destructive browser actions
origin/domain allowlist
clear browser action preview
DOM/result sanitization
permission minimization
```

### LandGod MCPHub Desktop Security Concerns

```text
remote tool execution
credential misuse
unsafe generic tools
malicious MCP tools
Worker impersonation
network/resource overreach
audit tampering
```

Mitigation direction:

```text
Gateway auth / RBAC
Worker identity
Worker security profile
Policy Engine
Credential Broker
Approval Engine
Tool allowlist
MCP trust workflow
Central + local audit
SIEM export
Vault/KMS integration
```

This is why LandGod cannot be positioned as a simple remote tool proxy. It must remain a governed execution platform.

---

## 13. Relationship Between the Two

They are complementary, not replacements.

```text
                         Agent
                           |
           +---------------+---------------+
           |                               |
           v                               v
  +--------+--------+             +--------+--------+
  | Local Browser   |             | LandGod MCPHub  |
  | Web execution   |             | Desktop / Worker|
  +--------+--------+             +--------+--------+
           |                               |
           v                               v
  +--------+--------+             +--------+--------+
  | Web pages       |             | Enterprise      |
  | SaaS / DOM      |             | machines/tools  |
  +-----------------+             +-----------------+
```

A mature Agent platform may need both:

```text
Local Browser for user's web session.
LandGod MCPHub Desktop for governed enterprise machine execution.
```

---

## 14. Final Recommendation

Use this naming and positioning consistently:

```text
Local Browser
= Browser/Web Execution Surface
```

```text
LandGod MCPHub Desktop
= Enterprise Machine/Desktop Execution Surface
= the LandGod Gateway + Worker + MCP tool governance system
```

Final distinction:

```text
Local Browser answers:
"Can the Agent operate this web page in my browser?"

LandGod MCPHub Desktop answers:
"Can the Agent safely operate this enterprise machine and its local capabilities?"
```
