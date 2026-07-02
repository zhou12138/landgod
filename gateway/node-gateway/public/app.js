const state = {
  health: null,
  clients: [],
  agents: [],
  tools: [],
  credentials: [],
  tasks: [],
  queued: [],
  financeDemoResult: null,
  auditFilters: { query: '', tool: '', credential: '', source: 'all', decision: 'all' },
  logFilters: { query: '', tool: '', agent: '', worker: '', status: 'all' },
  gatewayAudit: [],
  credentialAudit: [],
  workerAudit: [],
  controlPolicy: { workers: {}, tools: {} },
  currentView: 'overview',
};

const titles = {
  overview: ['Overview', 'Central status for workers, tools, credentials, tasks, and audit.'],
  agents: ['Agents', 'Observed Agent/API callers and their recent Gateway operations.'],
  workers: ['Workers', 'Connected Worker nodes and their reported labels/resources.'],
  tools: ['Tools', 'Published remote capabilities grouped by Worker.'],
  credentials: ['Credentials', 'Gateway-managed credential metadata and policy. Secrets are never displayed.'],
  'finance-demo': ['Scenarios', 'Scenario templates and demos. Current scenario: Finance Monthly Report — Agent → Gateway → Worker → MCP → Credential Broker → Audit.'],
  tasks: ['Tasks', 'Recent async tasks and queued tool calls.'],
  logs: ['Logs', 'Tool call request/dispatch/response exchanges and Worker-side execution evidence.'],
  audit: ['Audit', 'Credential Broker audit and Worker audit_read aggregation.'],
  access: ['Effective Access', 'Explain whether a tool call can use a credential across Gateway, Worker, and Tool layers.'],
};

function $(selector) { return document.querySelector(selector); }
function $all(selector) { return Array.from(document.querySelectorAll(selector)); }

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function json(value) {
  return escapeHtml(JSON.stringify(value ?? {}, null, 2));
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 4200);
}

function getAdminToken() {
  return localStorage.getItem('landgodAdminToken') || '';
}

function setAdminToken(token) {
  if (token) localStorage.setItem('landgodAdminToken', token);
  else localStorage.removeItem('landgodAdminToken');
}

async function api(path, options = {}, retryAuth = true) {
  const adminToken = getAdminToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(adminToken ? { 'x-landgod-admin-token': adminToken } : {}),
      ...(options.headers || {}),
    },
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401 && body?.error === 'admin_auth_required' && retryAuth) {
    const token = prompt('LandGod admin token required');
    if (token) {
      setAdminToken(token.trim());
      return api(path, options, false);
    }
  }
  if (!response.ok) {
    const message = body?.message || body?.error || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

async function refreshData({ quiet = false } = {}) {
  const results = await Promise.allSettled([
    api('/health'),
    api('/clients'),
    api('/agents'),
    api('/tools'),
    api('/credentials'),
    api('/tasks?limit=50'),
    api('/gateway/audit?limit=120'),
    api('/credentials/audit?limit=80'),
    api('/audit?limit=50'),
    api('/control/policy'),
  ]);

  const [health, clients, agents, tools, credentials, tasks, gatewayAudit, credentialAudit, workerAudit, controlPolicy] = results;
  if (health.status === 'fulfilled') state.health = health.value;
  if (clients.status === 'fulfilled') state.clients = clients.value.clients || [];
  if (agents.status === 'fulfilled') state.agents = agents.value.agents || [];
  if (tools.status === 'fulfilled') state.tools = tools.value.tools || [];
  if (credentials.status === 'fulfilled') state.credentials = credentials.value.credentials || [];
  if (tasks.status === 'fulfilled') {
    state.tasks = tasks.value.tasks || [];
    state.queued = tasks.value.queued || [];
  }
  if (gatewayAudit.status === 'fulfilled') state.gatewayAudit = gatewayAudit.value.entries || [];
  if (credentialAudit.status === 'fulfilled') state.credentialAudit = credentialAudit.value.entries || [];
  if (workerAudit.status === 'fulfilled') state.workerAudit = workerAudit.value.audit || [];
  if (controlPolicy.status === 'fulfilled') state.controlPolicy = controlPolicy.value.policy || { workers: {}, tools: {} };

  render();

  const failed = results.filter((item) => item.status === 'rejected');
  if (failed.length && !quiet) {
    showToast(`Loaded with ${failed.length} warning(s): ${failed[0].reason.message}`, true);
  } else if (!quiet) {
    showToast('Gateway console refreshed.');
  }
}

function setView(view) {
  state.currentView = view;
  $all('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $all('.nav-subitem[data-view-jump]').forEach((item) => item.classList.toggle('active', item.dataset.viewJump === view));
  $all('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  $('#pageTitle').textContent = titles[view]?.[0] || view;
  $('#pageSubtitle').textContent = titles[view]?.[1] || '';
  render();
}

function statusPill(text, tone = '') {
  return `<span class="status-pill ${tone}">${escapeHtml(text)}</span>`;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function formatDuration(start, end) {
  if (!start) return '—';
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '—';
  const ms = Math.max(0, endMs - startMs);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function summarizeObject(value) {
  if (!value || typeof value !== 'object') return '—';
  const entries = Object.entries(value);
  if (!entries.length) return '—';
  return entries.map(([key, entry]) => `${key}=${entry}`).join(', ');
}

function summarizeResult(result) {
  if (!result) return '—';
  const payload = result.payload || result.result || result;
  if (payload && typeof payload === 'object') {
    const status = firstDefined(payload.status, payload.ok, payload.type, result.type);
    const artifact = firstDefined(payload.artifact, payload.output, payload.output_path, payload.report_path, payload.summary_path);
    const keys = Object.keys(payload).slice(0, 6).join(', ');
    return [status ? `status=${status}` : null, artifact ? `artifact=${artifact}` : null, keys ? `keys=${keys}` : null].filter(Boolean).join('\n') || 'object result';
  }
  return String(payload).slice(0, 320);
}

function renderTable(element, headers, rows, emptyText = 'No data') {
  const table = typeof element === 'string' ? $(element) : element;
  if (!rows.length) {
    table.innerHTML = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${headers.length}">${escapeHtml(emptyText)}</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function renderOverview() {
  const totalTools = state.tools.reduce((sum, worker) => sum + (worker.toolCount || 0), 0);
  $('#metricStatus').textContent = state.health?.status || 'unknown';
  $('#metricPorts').textContent = state.health ? `HTTP ${state.health.httpPort} / WS ${state.health.wsPort}` : '—';
  $('#metricWorkers').textContent = state.clients.length;
  $('#metricTools').textContent = totalTools;
  $('#metricCredentials').textContent = state.credentials.length;

  $('#overviewWorkers').innerHTML = state.clients.length ? state.clients.slice(0, 6).map((worker) => {
    const toolInfo = state.tools.find((item) => item.connectionId === worker.connectionId);
    return `<div class="card-row">
      <div class="card-row-head">
        <span class="card-title">${escapeHtml(worker.clientName || worker.clientId)}</span>
        ${statusPill('online', 'good')}
      </div>
      <div class="card-meta">
        <span>${escapeHtml(worker.clientId)}</span>
        <span>${escapeHtml(worker.connectionId)}</span>
        <span>${toolInfo?.toolCount || 0} tools</span>
      </div>
    </div>`;
  }).join('') : '<div class="card-row muted">No online Workers.</div>';

  $('#overviewAudit').innerHTML = state.credentialAudit.length ? state.credentialAudit.slice(-6).reverse().map(renderAuditCard).join('') : '<div class="card-row muted">No credential audit events.</div>';
}

function renderAgents() {
  renderTable('#agentsTable', ['Agent', 'Last Seen', 'Source', 'Ops', 'Tools / Credentials', 'Recent Activity'], state.agents.map((agent) => [
    `<strong>${escapeHtml(agent.agentId || 'unknown-agent')}</strong><br><span class="muted">first ${escapeHtml(agent.firstSeenAt || '—')}</span><br><span class="muted">version ${escapeHtml(agent.agentVersion || '—')}</span>`,
    `<span>${escapeHtml(agent.lastSeenAt || '—')}</span><br>${statusPill(agent.lastStatus || 'observed', agent.lastStatus === 'completed' || agent.lastStatus === 'online' ? 'good' : agent.lastStatus === 'failed' ? 'bad' : '')}<br>${statusPill(agent.identityProof || 'unknown-proof', agent.identityProof === 'agent-token' ? 'good' : agent.identityProof === 'dev-unverified' ? 'warn' : '')}`,
    `<div class="kv compact-kv">
      <span>IP</span><strong>${escapeHtml(agent.lastRemoteAddress || '—')}</strong>
      <span>UA</span><strong>${escapeHtml(agent.lastUserAgent || '—')}</strong>
    </div>`,
    `<strong>${escapeHtml(agent.operationCount || 0)}</strong><br><span class="muted">last ${escapeHtml(agent.lastAction || '—')}</span>`,
    `<div class="kv compact-kv">
      <span>Tools</span><strong>${escapeHtml((agent.tools || []).slice(0, 6).join(', ') || '—')}</strong>
      <span>Creds</span><strong>${escapeHtml((agent.credentials || []).slice(0, 6).join(', ') || '—')}</strong>
      <span>Workers</span><strong>${escapeHtml((agent.workers || []).slice(0, 6).join(', ') || '—')}</strong>
      <span>Caps</span><strong>${escapeHtml((agent.capabilities || []).slice(0, 6).join(', ') || '—')}</strong>
    </div>`,
    `<details>
      <summary>${escapeHtml((agent.recentOperations || []).length)} recent operations</summary>
      <pre class="pre-wrap">${json(agent.recentOperations || [])}</pre>
    </details>`,
  ]), 'No Agent activity observed yet. Use /tool_call with agent_id or x-landgod-agent-id.');
}

function renderWorkers() {
  renderTable('#workersTable', ['Status', 'Client', 'IP', 'Connection', 'Labels', 'Resources', 'Session', 'Control'], state.clients.map((worker) => [
    `${statusPill('online', 'good')} ${statusPill(worker.enabled === false ? 'disabled' : 'enabled', worker.enabled === false ? 'bad' : 'good')}`,
    `<strong>${escapeHtml(worker.clientName)}</strong><br><span class="muted">${escapeHtml(worker.clientId)}</span>`,
    escapeHtml(worker.ip || worker.remoteAddress || '—'),
    `<span class="pre-wrap">${escapeHtml(worker.connectionId)}</span>`,
    `<pre class="pre-wrap">${json(worker.labels)}</pre>`,
    `<pre class="pre-wrap">${json(worker.resources)}</pre>`,
    escapeHtml(worker.sessionId || '—'),
    `<button class="${worker.enabled === false ? 'primary-button' : 'danger-button'}" data-control-worker="${escapeHtml(worker.control?.key || worker.clientId || worker.clientName || worker.connectionId)}" data-enabled="${worker.enabled === false ? 'true' : 'false'}">${worker.enabled === false ? 'Enable' : 'Disable'}</button>
     ${worker.control?.reason ? `<br><span class="muted">${escapeHtml(worker.control.reason)}</span>` : ''}`,
  ]), 'No connected Workers.');
}

function toolDetailFor(worker, tool) {
  if (tool && typeof tool === 'object') return tool;
  const name = String(tool || '');
  return (worker.toolDetails || []).find((item) => item.name === name) || { name, enabled: true };
}

function renderTools() {
  $('#toolsList').innerHTML = state.tools.length ? state.tools.map((worker) => `
    <div class="card-row">
      <div class="card-row-head">
        <span class="card-title">${escapeHtml(worker.clientName)}</span>
        <span>${statusPill(worker.enabled === false ? 'worker disabled' : 'worker enabled', worker.enabled === false ? 'bad' : 'good')} ${statusPill(`${worker.toolCount || 0} tools`, worker.toolCount ? 'good' : 'warn')}</span>
      </div>
      <div class="card-meta"><span>${escapeHtml(worker.connectionId)}</span></div>
      <div class="tool-cloud">${(worker.toolDetails || worker.tools || []).map((rawTool) => {
        const tool = toolDetailFor(worker, rawTool);
        const workerKey = tool.control?.workerKey || worker.clientId || worker.clientName || worker.connectionId;
        return `<span class="pill ${tool.enabled === false ? 'disabled-pill' : ''}">${escapeHtml(tool.name)} ${tool.enabled === false ? '⛔' : '✅'}
          <button class="mini-button" data-control-tool="${escapeHtml(tool.name)}" data-worker-key="${escapeHtml(workerKey)}" data-enabled="${tool.enabled === false ? 'true' : 'false'}">${tool.enabled === false ? 'Enable' : 'Disable'}</button>
        </span>`;
      }).join(' ') || '<span class="muted">No tools</span>'}</div>
    </div>
  `).join('') : '<div class="card-row muted">No published tools.</div>';
}

function renderCredentials() {
  renderTable('#credentialsTable', ['Status', 'Credential', 'Policy', 'Scopes', 'Last used', 'Actions'], state.credentials.map((cred) => [
    statusPill(cred.status || 'unknown', cred.status === 'active' ? 'good' : 'bad'),
    `<strong>${escapeHtml(cred.id)}</strong><br><span class="muted">${escapeHtml(cred.type)}</span><br><span class="muted">${escapeHtml(cred.description || '')}</span>`,
    `<div class="kv">
      <span>Agents</span><strong>${escapeHtml((cred.allowedAgents || []).join(', ') || '—')}</strong>
      <span>Workers</span><strong>${escapeHtml((cred.allowedWorkerIds || []).join(', ') || '—')}</strong>
      <span>Groups</span><strong>${escapeHtml((cred.allowedWorkerGroups || []).join(', ') || '—')}</strong>
      <span>Tools</span><strong>${escapeHtml((cred.allowedTools || []).join(', ') || '—')}</strong>
      <span>Denied</span><strong>${escapeHtml((cred.deniedTools || []).join(', ') || '—')}</strong>
    </div>`,
    escapeHtml((cred.allowedScopes || []).join(', ') || '—'),
    escapeHtml(cred.lastUsedAt || 'never'),
    cred.status === 'active' ? `<button class="danger-button" data-revoke="${escapeHtml(cred.id)}">Revoke</button>` : '—',
  ]), 'No credentials yet.');
}

function renderTasks() {
  const taskMap = new Map();
  for (const task of state.tasks) taskMap.set(task.taskId || task.id, task);
  for (const task of state.queued) {
    const taskId = task.taskId || task.id;
    taskMap.set(taskId, { ...(taskMap.get(taskId) || {}), ...task, status: 'queued' });
  }
  const taskRows = Array.from(taskMap.values())
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  renderTable('#tasksTable', ['Status', 'Task / Timing', 'Route', 'Tool / Agent', 'Credential', 'Request', 'Outcome'], taskRows.map((task) => {
    const request = task.request || {};
    const toolName = firstDefined(task.tool_name, task.toolName, request.tool_name, request.toolName);
    const clientName = firstDefined(task.clientName, request.clientName, request.client_name);
    const connectionId = firstDefined(task.connectionId, request.connection_id, request.connectionId);
    const labels = firstDefined(task.labels, request.labels);
    const credentialRef = firstDefined(task.credential_ref, task.credentialRef, request.credential_ref, request.credentialRef);
    const credentialScope = firstDefined(task.credential_scope, task.credentialScope, request.credential_scope, request.credentialScope);
    const agentId = firstDefined(task.agent_id, task.agentId, request.agent_id, request.agentId);
    const args = firstDefined(task.arguments, request.arguments);
    const argKeys = task.argumentKeys || (args && typeof args === 'object' ? Object.keys(args) : []);
    const error = task.error && (typeof task.error === 'object' ? JSON.stringify(task.error) : String(task.error));
    return [
      statusPill(task.status || 'unknown', task.status === 'completed' ? 'good' : task.status === 'failed' ? 'bad' : 'warn'),
      `<strong class="pre-wrap">${escapeHtml(task.taskId || task.id || '—')}</strong><br>
        <span class="muted">created ${escapeHtml(task.createdAt || '—')}</span><br>
        <span class="muted">completed ${escapeHtml(task.completedAt || '—')}</span><br>
        <span class="muted">duration ${escapeHtml(formatDuration(task.createdAt, task.completedAt))}</span>`,
      `<div class="kv compact-kv">
        <span>Client</span><strong>${escapeHtml(clientName || '—')}</strong>
        <span>Conn</span><strong>${escapeHtml(connectionId || '—')}</strong>
        <span>Labels</span><strong>${escapeHtml(labels ? summarizeObject(labels) : '—')}</strong>
        <span>Timeout</span><strong>${escapeHtml(firstDefined(task.timeout, request.timeout) || '—')}</strong>
      </div>`,
      `<strong>${escapeHtml(toolName || '—')}</strong><br><span class="muted">agent ${escapeHtml(agentId || '—')}</span>`,
      `<div class="kv compact-kv">
        <span>Ref</span><strong>${escapeHtml(credentialRef || '—')}</strong>
        <span>Scope</span><strong>${escapeHtml(credentialScope || '—')}</strong>
      </div>`,
      `<details>
        <summary>${escapeHtml(argKeys.length ? `args: ${argKeys.join(', ')}` : 'no args')}</summary>
        <pre class="pre-wrap">${json(args || {})}</pre>
      </details>`,
      error
        ? `<span class="status-pill bad">error</span><pre class="pre-wrap">${escapeHtml(error)}</pre>`
        : `<pre class="pre-wrap">${escapeHtml(summarizeResult(task.result))}</pre>`,
    ];
  }), 'No tasks yet.');
}

function eventTime(entry) {
  return entry?.timestamp || entry?.ts || entry?.time || '';
}

function toolCallStatusFor(events) {
  const names = events.map((entry) => entry.event || entry.action || '');
  if (names.some((name) => name.includes('timeout'))) return 'timeout';
  if (names.some((name) => name.includes('error') || name.includes('failed'))) return 'failed';
  if (names.some((name) => name.includes('result_received') || name.includes('response_received') || name.includes('completed'))) return 'completed';
  if (names.some((name) => name.includes('queued'))) return 'queued';
  return 'pending';
}

function isToolCallAuditEvent(entry) {
  const event = String(entry.event || entry.action || '');
  return event.includes('tool_call') || event.includes('batch_tool_call');
}

function workerAuditLooksLikeToolCall(entry) {
  const text = JSON.stringify(entry || {});
  return text.includes('tool_call') || text.includes('[managed-client-mcp-ws] tool_call');
}

function buildToolCallLogs() {
  const groups = new Map();
  const put = (key, kind, entry, extra = {}) => {
    if (!key) key = `event:${entry.eventId || entry.id || eventTime(entry) || Math.random()}`;
    if (!groups.has(key)) groups.set(key, { key, events: [], workerEvents: [] });
    groups.get(key)[kind].push({ ...entry, ...extra });
  };

  for (const entry of state.gatewayAudit || []) {
    if (!isToolCallAuditEvent(entry) && !(entry.event === 'agent_activity_observed' && isToolCallAuditEvent(entry))) continue;
    const key = entry.requestId || entry.request_id || entry.taskId || entry.task_id || entry.eventId;
    put(key, 'events', entry, { source: 'gateway' });
  }

  for (const agent of state.agents || []) {
    for (const op of agent.recentOperations || []) {
      if (!isToolCallAuditEvent(op)) continue;
      const key = op.requestId || op.request_id || op.taskId || op.task_id || `${agent.agentId}:${op.timestamp}:${op.action}:${op.toolName}`;
      put(key, 'events', { ...op, agentId: agent.agentId, event: op.action }, { source: 'agent_activity' });
    }
  }

  for (const group of state.workerAudit || []) {
    for (const entry of group.entries || []) {
      if (!workerAuditLooksLikeToolCall(entry)) continue;
      const text = JSON.stringify(entry || {});
      const requestId = text.match(/tool_call-[0-9a-f-]+/i)?.[0];
      put(requestId || entry.id, 'workerEvents', entry, { source: 'worker', clientName: group.clientName, connectionId: group.connectionId });
    }
  }

  return Array.from(groups.values()).map((log) => {
    const all = [...log.events, ...log.workerEvents].sort((a, b) => Date.parse(eventTime(a) || 0) - Date.parse(eventTime(b) || 0));
    const primary = all.find((entry) => entry.toolName || entry.tool_name || entry.requestId || entry.taskId) || all[0] || {};
    return {
      ...log,
      all,
      requestId: primary.requestId || primary.request_id || log.key,
      taskId: primary.taskId || primary.task_id || '',
      toolName: primary.toolName || primary.tool_name || primary.tool || '',
      agentId: primary.agentId || primary.agent_id || '',
      clientName: primary.clientName || primary.workerKey || '',
      status: toolCallStatusFor(all),
      startedAt: eventTime(all[0]),
      endedAt: eventTime(all[all.length - 1]),
    };
  }).sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
}

function logMatches(log) {
  const filters = state.logFilters;
  const text = JSON.stringify(log || {}).toLowerCase();
  if (filters.query && !text.includes(filters.query.toLowerCase())) return false;
  if (filters.tool && !String(log.toolName || '').toLowerCase().includes(filters.tool.toLowerCase()) && !text.includes(filters.tool.toLowerCase())) return false;
  if (filters.agent && !String(log.agentId || '').toLowerCase().includes(filters.agent.toLowerCase()) && !text.includes(filters.agent.toLowerCase())) return false;
  if (filters.worker && !String(log.clientName || '').toLowerCase().includes(filters.worker.toLowerCase()) && !text.includes(filters.worker.toLowerCase())) return false;
  if (filters.status !== 'all' && log.status !== filters.status) return false;
  return true;
}

function renderToolCallLog(log) {
  const tone = log.status === 'completed' ? 'good' : log.status === 'failed' || log.status === 'timeout' ? 'bad' : 'warn';
  const requestEvents = log.all.filter((entry) => String(entry.event || entry.action || '').includes('received') || String(entry.event || '').includes('dispatched'));
  const responseEvents = log.all.filter((entry) => String(entry.event || entry.action || '').includes('result') || String(entry.event || entry.action || '').includes('response') || String(entry.event || entry.action || '').includes('completed') || String(entry.event || '').includes('error') || String(entry.event || '').includes('timeout'));
  return `<div class="card-row log-card">
    <div class="card-row-head">
      <span class="card-title">${escapeHtml(log.toolName || 'tool_call')}</span>
      ${statusPill(log.status, tone)}
    </div>
    <div class="card-meta">
      <span>${escapeHtml(log.startedAt || '—')}</span>
      <span>duration ${escapeHtml(formatDuration(log.startedAt, log.endedAt))}</span>
      <span>agent ${escapeHtml(log.agentId || '—')}</span>
      <span>worker ${escapeHtml(log.clientName || '—')}</span>
      <span>request ${escapeHtml(log.requestId || '—')}</span>
      ${log.taskId ? `<span>task ${escapeHtml(log.taskId)}</span>` : ''}
    </div>
    <div class="log-columns">
      <details open>
        <summary>Request / dispatch (${requestEvents.length || log.events.length})</summary>
        <pre class="pre-wrap">${json(requestEvents.length ? requestEvents : log.events)}</pre>
      </details>
      <details open>
        <summary>Response / result (${responseEvents.length})</summary>
        <pre class="pre-wrap">${json(responseEvents)}</pre>
      </details>
    </div>
    <details class="compact-details">
      <summary>Worker local audit (${log.workerEvents.length}) + full timeline (${log.all.length})</summary>
      <pre class="pre-wrap">${json(log.all)}</pre>
    </details>
  </div>`;
}

function renderLogs() {
  const logs = buildToolCallLogs();
  const filtered = logs.filter(logMatches);
  const node = $('#logsFilterSummary');
  if (node) {
    const active = Object.entries(state.logFilters).filter(([, value]) => value && value !== 'all');
    node.textContent = active.length
      ? `Filters: ${active.map(([key, value]) => `${key}=${value}`).join(', ')} · Showing ${filtered.length} of ${logs.length} tool call exchanges`
      : `No filters applied. Showing ${filtered.length} tool call exchanges.`;
  }
  $('#toolCallLogs').innerHTML = filtered.length ? filtered.slice(0, 80).map(renderToolCallLog).join('') : '<div class="card-row muted">No tool call logs match filters.</div>';
}

function renderAuditCard(entry) {
  const event = entry.event || entry.type || entry.message || 'event';
  const tone = entry.decision === 'deny' ? 'bad' : entry.decision === 'allow' ? 'good' : '';
  const when = entry.ts || entry.timestamp || entry.time || '';
  const credential = entry.credentialRef || entry.credential_ref || '';
  const tool = entry.toolName || entry.tool_name || entry.tool || '';
  const target = entry.clientName || entry.workerId || entry.connectionId || '';
  return `<div class="card-row audit-card">
    <div class="card-row-head">
      <span class="card-title">${escapeHtml(event)}</span>
      ${statusPill(entry.decision || entry.level || 'audit', tone)}
    </div>
    <div class="card-meta">
      ${when ? `<span>${escapeHtml(when)}</span>` : ''}
      ${tool ? `<span>${escapeHtml(tool)}</span>` : ''}
      ${credential ? `<span>${escapeHtml(credential)}</span>` : ''}
      ${target ? `<span>${escapeHtml(target)}</span>` : ''}
    </div>
    <details class="compact-details">
      <summary>Raw event JSON</summary>
      <pre class="pre-wrap">${json(entry)}</pre>
    </details>
  </div>`;
}

function auditEntryMatches(entry, source = 'gateway') {
  const filters = state.auditFilters;
  if (filters.source !== 'all' && filters.source !== source) return false;
  const text = JSON.stringify(entry || {}).toLowerCase();
  if (filters.query && !text.includes(filters.query.toLowerCase())) return false;
  if (filters.tool) {
    const tool = String(entry.toolName || entry.tool_name || entry.tool || '').toLowerCase();
    if (!tool.includes(filters.tool.toLowerCase()) && !text.includes(filters.tool.toLowerCase())) return false;
  }
  if (filters.credential) {
    const cred = String(entry.credentialRef || entry.credential_ref || entry.credential || '').toLowerCase();
    if (!cred.includes(filters.credential.toLowerCase()) && !text.includes(filters.credential.toLowerCase())) return false;
  }
  if (filters.decision !== 'all') {
    const decision = String(entry.decision || entry.level || '').toLowerCase();
    if (filters.decision === 'audit') {
      if (decision === 'allow' || decision === 'deny') return false;
    } else if (decision !== filters.decision) {
      return false;
    }
  }
  return true;
}

function renderAuditFilterSummary(counts) {
  const node = $('#auditFilterSummary');
  if (!node) return;
  const filters = state.auditFilters;
  const active = Object.entries(filters).filter(([, value]) => value && value !== 'all');
  node.textContent = active.length
    ? `Filters: ${active.map(([key, value]) => `${key}=${value}`).join(', ')} · Showing Gateway ${counts.gateway}, Credential ${counts.credential}, Worker ${counts.worker}`
    : `No filters applied. Showing Gateway ${counts.gateway}, Credential ${counts.credential}, Worker ${counts.worker}`;
}

function renderAudit() {
  const gateway = state.gatewayAudit.filter((entry) => auditEntryMatches(entry, 'gateway'));
  const credential = state.credentialAudit.filter((entry) => auditEntryMatches(entry, 'credential'));
  const filtersActive = Object.values(state.auditFilters).some((value) => value && value !== 'all');
  const workerGroups = state.workerAudit.map((group) => ({
    ...group,
    entries: (group.entries || []).filter((entry) => auditEntryMatches({ ...entry, clientName: group.clientName, clientId: group.clientId, connectionId: group.connectionId }, 'worker')),
  })).filter((group) => group.error || (group.entries || []).length > 0 || !filtersActive);

  renderAuditFilterSummary({
    gateway: gateway.length,
    credential: credential.length,
    worker: workerGroups.reduce((sum, group) => sum + (group.entries || []).length, 0),
  });

  $('#gatewayAudit').innerHTML = gateway.length ? gateway.slice().reverse().map(renderAuditCard).join('') : '<div class="card-row muted">No Gateway central audit events match filters.</div>';
  $('#credentialAudit').innerHTML = credential.length ? credential.slice().reverse().map(renderAuditCard).join('') : '<div class="card-row muted">No credential audit events match filters.</div>';
  $('#workerAudit').innerHTML = workerGroups.length ? workerGroups.map((group) => `
    <div class="card-row">
      <div class="card-row-head"><span class="card-title">${escapeHtml(group.clientName)}</span>${group.error ? statusPill('error', 'bad') : statusPill(`${(group.entries || []).length} entries`, 'good')}</div>
      ${group.error ? `<p class="muted">${escapeHtml(group.error)}</p>` : (group.entries || []).slice(0, 12).map((entry) => renderAuditCard({ ...entry, clientName: group.clientName })).join('')}
    </div>
  `).join('') : '<div class="card-row muted">No Worker audit data matches filters.</div>';
}

function setDatalistOptions(selector, values) {
  const node = $(selector);
  if (!node) return;
  const unique = Array.from(new Set(values.filter(Boolean).map(String))).sort((a, b) => a.localeCompare(b));
  node.innerHTML = unique.map((value) => `<option value="${escapeHtml(value)}"></option>`).join('');
}

function renderAccessOptions() {
  const workers = [];
  const workerGroups = [];
  for (const worker of state.clients) {
    workers.push(worker.clientId, worker.clientName, worker.connectionId);
    const labels = worker.labels || {};
    workerGroups.push(labels.group, labels.workerGroup, labels.worker_group, labels.department, labels.env);
  }

  const tools = [];
  for (const group of state.tools) tools.push(...(group.tools || []));

  const agents = [];
  const credentials = [];
  const scopes = [];
  for (const credential of state.credentials) {
    credentials.push(credential.id);
    agents.push(...(credential.allowedAgents || []).filter((item) => item !== '*'));
    scopes.push(...(credential.allowedScopes || []));
  }
  for (const task of [...state.tasks, ...state.queued]) {
    const request = task.request || {};
    agents.push(task.agent_id, task.agentId, request.agent_id, request.agentId);
  }

  setDatalistOptions('#accessAgentOptions', agents);
  setDatalistOptions('#accessWorkerOptions', workers);
  setDatalistOptions('#accessWorkerGroupOptions', workerGroups);
  setDatalistOptions('#accessToolOptions', tools);
  setDatalistOptions('#accessCredentialOptions', credentials);
  setDatalistOptions('#toolCallScopeOptions', scopes);
}

function setFormValue(form, name, value) {
  const field = form?.elements?.[name];
  if (!field || value === undefined || value === null) return;
  field.value = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function selectedCredentialScope(credentialRef) {
  const credential = state.credentials.find((item) => item.id === credentialRef);
  const scopes = credential?.allowedScopes || [];
  if (scopes.includes('report')) return 'report';
  if (scopes.includes('read')) return 'read';
  return scopes[0] || '';
}

function prefillToolCallFromAccess() {
  const accessForm = $('#accessForm');
  const toolForm = $('#toolCallForm');
  if (!accessForm || !toolForm) return;
  const data = new FormData(accessForm);
  const credentialRef = data.get('credentialRef')?.trim() || '';
  setFormValue(toolForm, 'agent_id', data.get('agentId')?.trim() || 'default-agent');
  setFormValue(toolForm, 'clientName', data.get('workerId')?.trim() || '');
  setFormValue(toolForm, 'tool_name', data.get('toolName')?.trim() || '');
  setFormValue(toolForm, 'credential_ref', credentialRef);
  setFormValue(toolForm, 'credential_scope', selectedCredentialScope(credentialRef));
  const toolName = data.get('toolName')?.trim() || '';
  const defaultArgs = toolName === 'business-report-demo.run_monthly_close_demo'
    ? { month: '2026-06', output_dir: '/tmp/landgod-business-report-demo-webui' }
    : {};
  setFormValue(toolForm, 'arguments', defaultArgs);
  showToast('Tool call form prefilled from Effective Access inputs.');
}

function prefillFinanceDemoToolCall() {
  const toolForm = $('#toolCallForm');
  if (!toolForm) return;
  setFormValue(toolForm, 'agent_id', 'agent-business-demo');
  setFormValue(toolForm, 'clientName', 'BusinessReportWorker');
  setFormValue(toolForm, 'tool_name', 'business-report-demo.run_monthly_close_demo');
  setFormValue(toolForm, 'credential_ref', 'cred_demo_finance_readonly');
  setFormValue(toolForm, 'credential_scope', 'report');
  setFormValue(toolForm, 'arguments', { month: '2026-06', output_dir: '/tmp/landgod-business-report-demo-webui' });
  showToast('Finance demo smoke test preset filled.');
}

function evaluateAccess(formData) {
  const agentId = formData.get('agentId')?.trim();
  const workerId = formData.get('workerId')?.trim();
  const workerGroup = formData.get('workerGroup')?.trim();
  const toolName = formData.get('toolName')?.trim();
  const credentialRef = formData.get('credentialRef')?.trim();
  const reasons = [];

  const credential = state.credentials.find((item) => item.id === credentialRef);
  const worker = state.clients.find((item) => item.clientId === workerId || item.connectionId === workerId || item.clientName === workerId);
  const toolOwner = state.tools.find((item) => item.connectionId === worker?.connectionId || item.clientName === worker?.clientName || (!workerId && (item.tools || []).includes(toolName)));

  if (!credential) reasons.push({ layer: 'gateway_credential', code: 'credential_not_found', message: 'Credential does not exist or metadata failed to load.' });
  if (credential && credential.status !== 'active') reasons.push({ layer: 'gateway_credential', code: 'credential_inactive', message: `Credential is ${credential.status}.` });
  if (credential && !(credential.allowedAgents || []).includes('*') && !(credential.allowedAgents || []).includes(agentId)) reasons.push({ layer: 'gateway_credential', code: 'credential_agent_not_allowed', message: 'Agent is not in allowedAgents.' });
  if (credential && (credential.deniedTools || []).includes(toolName)) reasons.push({ layer: 'gateway_credential', code: 'credential_tool_denied', message: 'Tool is explicitly denied by credential policy.' });
  if (credential && !(credential.allowedTools || []).includes('*') && !(credential.allowedTools || []).includes(toolName)) reasons.push({ layer: 'gateway_credential', code: 'credential_tool_not_allowed', message: 'Tool is not in allowedTools.' });
  if (!worker) reasons.push({ layer: 'worker', code: 'worker_not_online', message: 'Worker is not currently online/registered.' });
  if (worker && worker.enabled === false) reasons.push({ layer: 'gateway_control', code: 'worker_disabled', message: 'Worker is disabled by Gateway central control policy.' });
  const selectedTool = toolOwner ? toolDetailFor(toolOwner, toolName) : null;
  if (selectedTool && selectedTool.enabled === false) reasons.push({ layer: 'gateway_control', code: 'tool_disabled', message: 'Tool is disabled by Gateway central control policy.' });
  if (credential && worker) {
    const labels = worker.labels || {};
    const groupMatches = (credential.allowedWorkerGroups || []).includes('*')
      || (credential.allowedWorkerGroups || []).some((group) => labels.group === group || labels.workerGroup === group || labels.worker_group === group || workerGroup === group);
    const workerMatches = (credential.allowedWorkerIds || []).includes('*')
      || (credential.allowedWorkerIds || []).includes(worker.clientId)
      || (credential.allowedWorkerIds || []).includes(worker.connectionId);
    if (!workerMatches && !groupMatches) reasons.push({ layer: 'gateway_credential', code: 'credential_worker_not_allowed', message: 'Credential is not allowed for this Worker or Worker group.' });
  }
  if (!toolOwner || !(toolOwner.tools || []).includes(toolName)) reasons.push({ layer: 'tool_registry', code: 'tool_not_published', message: 'Tool is not currently published by the selected Worker.' });

  return {
    allowed: reasons.length === 0,
    reasons,
    note: 'This is a WebUI MVP pre-check. Worker grant validation and tool credentialAccess remain final enforcement.',
  };
}

function buildFinanceDemoCredentialPayload() {
  return {
    id: 'cred_demo_finance_readonly',
    type: 'api_token',
    description: 'Finance Monthly Report scenario · readonly mock Finance/ERP reporting credential',
    secret: { token: 'demo-finance-readonly-token' },
    allowedAgents: ['agent-business-demo'],
    allowedWorkerIds: [],
    allowedWorkerGroups: ['finance-demo'],
    allowedTools: ['business-report-demo.run_monthly_close_demo'],
    deniedTools: [
      'shell_execute',
      'file_read',
      'audit_read',
      'remote_configure_mcp_server',
      'session_create',
      'session_stdin',
      'session_read_output',
      'session_wait',
      'external_http_post',
    ],
    allowedScopes: ['read', 'report'],
  };
}

function getFinanceDemoStatus() {
  const worker = state.clients.find((item) => item.clientName === 'BusinessReportWorker' || item.labels?.group === 'finance-demo' || item.labels?.role === 'business-report');
  const toolOwner = state.tools.find((item) => (item.tools || []).includes('business-report-demo.run_monthly_close_demo'));
  const credential = state.credentials.find((item) => item.id === 'cred_demo_finance_readonly');
  const gatewayEvents = new Set(state.gatewayAudit.map((entry) => entry.event));
  const credentialEvents = new Set(state.credentialAudit.map((entry) => entry.event));
  const workerHasCompleted = state.workerAudit.some((group) => (group.entries || []).some((entry) => JSON.stringify(entry).includes('business-report-demo.run_monthly_close_demo') && JSON.stringify(entry).includes('completed')));
  return { worker, toolOwner, credential, gatewayEvents, credentialEvents, workerHasCompleted };
}

function renderFinanceDemo() {
  const flow = $('#financeDemoFlow');
  if (!flow) return;
  const status = getFinanceDemoStatus();
  const steps = [
    { title: '1. Worker online', desc: 'BusinessReportWorker connected with finance-demo labels.', ok: !!status.worker, detail: status.worker?.connectionId || 'No matching Worker online.' },
    { title: '2. MCP tool published', desc: 'business-report-demo.run_monthly_close_demo visible through Gateway.', ok: !!status.toolOwner, detail: status.toolOwner?.clientName || 'Tool not published yet.' },
    { title: '3. Demo credential ready', desc: 'cred_demo_finance_readonly exists; secret remains hidden.', ok: !!status.credential && status.credential.status === 'active', detail: status.credential ? `status=${status.credential.status}` : 'Create the demo credential.' },
    { title: '4. Gateway dispatch audit', desc: 'Gateway central audit records dispatch/result.', ok: status.gatewayEvents.has('tool_call_dispatched') && status.gatewayEvents.has('tool_call_result_received'), detail: 'tool_call_dispatched + tool_call_result_received' },
    { title: '5. Credential exchange audit', desc: 'Credential Broker records grant and exchange.', ok: status.credentialEvents.has('credential_grant_issued') && status.credentialEvents.has('credential_exchange_allowed'), detail: 'credential_grant_issued + credential_exchange_allowed' },
    { title: '6. Worker local audit', desc: 'Worker audit confirms local tool execution.', ok: status.workerHasCompleted, detail: status.workerHasCompleted ? 'tool_call completed' : 'Run the demo to produce worker audit.' },
  ];
  flow.innerHTML = steps.map((step) => `
    <article class="flow-step ${step.ok ? 'ok' : 'pending'}">
      <div class="flow-marker">${step.ok ? '✓' : '•'}</div>
      <div>
        <h3>${escapeHtml(step.title)}</h3>
        <p>${escapeHtml(step.desc)}</p>
        <small>${escapeHtml(step.detail)}</small>
      </div>
    </article>
  `).join('');
  const expected = buildFinanceDemoCredentialPayload();
  const credential = status.credential;
  const effectivePolicy = credential || { ...expected, status: 'missing', secret: undefined };
  $('#financeCredentialPolicy').innerHTML = `
    <div class="policy-grid">
      <div><span class="muted">credential_ref</span><strong>${escapeHtml(expected.id)}</strong></div>
      <div><span class="muted">status</span>${credential ? statusPill(credential.status, credential.status === 'active' ? 'good' : 'bad') : statusPill('missing', 'warn')}</div>
      <div><span class="muted">allowed agent</span><strong>${escapeHtml(expected.allowedAgents.join(', '))}</strong></div>
      <div><span class="muted">worker group</span><strong>${escapeHtml(expected.allowedWorkerGroups.join(', '))}</strong></div>
      <div><span class="muted">allowed tool</span><strong>${escapeHtml(expected.allowedTools.join(', '))}</strong></div>
      <div><span class="muted">scopes</span><strong>${escapeHtml(expected.allowedScopes.join(', '))}</strong></div>
    </div>
    <details class="policy-details">
      <summary>Current Gateway credential metadata</summary>
      <pre class="pre-wrap">${json(effectivePolicy)}</pre>
    </details>
  `;
  const credentialButton = $('#demoCreateCredentialBtn');
  if (credentialButton) {
    credentialButton.textContent = credential?.status === 'active' ? 'Credential ready' : 'Create demo credential';
    credentialButton.disabled = credential?.status === 'active';
  }
  if (state.financeDemoResult) {
    $('#financeDemoResult').textContent = JSON.stringify(state.financeDemoResult, null, 2);
  }
}

function renderAccessResult(result) {
  const box = $('#accessResult');
  box.classList.remove('empty', 'allowed', 'denied');
  box.classList.add(result.allowed ? 'allowed' : 'denied');
  box.innerHTML = `${result.allowed ? '✅ Allowed by loaded Gateway/Worker metadata' : '⛔ Denied / needs attention'}\n\n${escapeHtml(JSON.stringify(result, null, 2))}`;
}

function render() {
  $('#apiBase').textContent = `API: ${location.origin}`;
  renderOverview();
  renderAgents();
  renderWorkers();
  renderTools();
  renderCredentials();
  renderFinanceDemo();
  renderTasks();
  renderLogs();
  renderAudit();
  renderAccessOptions();
}

function bindEvents() {
  $all('.nav-item').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));
  $all('[data-nav-toggle]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    const group = item.closest('.nav-group');
    const expanded = !group.classList.contains('expanded');
    group.classList.toggle('expanded', expanded);
    item.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }));
  $all('[data-view-jump]').forEach((item) => item.addEventListener('click', () => setView(item.dataset.viewJump)));
  $('#refreshBtn').addEventListener('click', () => refreshData());

  $('#credentialForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let secret;
    try { secret = JSON.parse(data.get('secret') || '{}'); } catch (err) { showToast(`Secret JSON is invalid: ${err.message}`, true); return; }
    const payload = {
      id: data.get('id')?.trim(),
      type: data.get('type'),
      description: data.get('description')?.trim(),
      secret,
      allowedAgents: asArray(data.get('allowedAgents')),
      allowedWorkerIds: asArray(data.get('allowedWorkerIds')),
      allowedWorkerGroups: asArray(data.get('allowedWorkerGroups')),
      allowedTools: asArray(data.get('allowedTools')),
      deniedTools: asArray(data.get('deniedTools')),
      allowedScopes: asArray(data.get('allowedScopes')),
    };
    try {
      await api('/credentials', { method: 'POST', body: JSON.stringify(payload) });
      event.currentTarget.reset();
      showToast('Credential created.');
      await refreshData({ quiet: true });
    } catch (err) { showToast(err.message, true); }
  });

  document.body.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-revoke]');
    if (!target) return;
    const id = target.dataset.revoke;
    if (!confirm(`Revoke credential ${id}? Existing grants will be invalidated.`)) return;
    try {
      await api(`/credentials/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' });
      showToast(`Credential revoked: ${id}`);
      await refreshData({ quiet: true });
    } catch (err) { showToast(err.message, true); }
  });

  document.body.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-control-worker]');
    if (!target) return;
    const workerKey = target.dataset.controlWorker;
    const enabled = target.dataset.enabled === 'true';
    const reason = enabled ? '' : (prompt(`Reason for disabling Worker ${workerKey}?`, 'disabled from WebUI') || 'disabled from WebUI');
    try {
      await api('/control/worker', { method: 'POST', body: JSON.stringify({ workerKey, enabled, reason }) });
      showToast(`${enabled ? 'Enabled' : 'Disabled'} Worker: ${workerKey}`);
      await refreshData({ quiet: true });
    } catch (err) { showToast(err.message, true); }
  });

  document.body.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-control-tool]');
    if (!target) return;
    const toolName = target.dataset.controlTool;
    const workerKey = target.dataset.workerKey || '*';
    const enabled = target.dataset.enabled === 'true';
    const reason = enabled ? '' : (prompt(`Reason for disabling Tool ${toolName}?`, 'disabled from WebUI') || 'disabled from WebUI');
    try {
      await api('/control/tool', { method: 'POST', body: JSON.stringify({ workerKey, toolName, enabled, reason }) });
      showToast(`${enabled ? 'Enabled' : 'Disabled'} Tool: ${toolName}`);
      await refreshData({ quiet: true });
    } catch (err) { showToast(err.message, true); }
  });

  $('#logsFilterForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.logFilters = {
      query: data.get('query')?.trim() || '',
      tool: data.get('tool')?.trim() || '',
      agent: data.get('agent')?.trim() || '',
      worker: data.get('worker')?.trim() || '',
      status: data.get('status') || 'all',
    };
    renderLogs();
  });

  $('#logsFilterClearBtn')?.addEventListener('click', () => {
    state.logFilters = { query: '', tool: '', agent: '', worker: '', status: 'all' };
    $('#logsFilterForm')?.reset();
    renderLogs();
  });

  $('#auditFilterForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.auditFilters = {
      query: data.get('query')?.trim() || '',
      tool: data.get('tool')?.trim() || '',
      credential: data.get('credential')?.trim() || '',
      source: data.get('source') || 'all',
      decision: data.get('decision') || 'all',
    };
    renderAudit();
  });

  $('#auditFilterClearBtn')?.addEventListener('click', () => {
    state.auditFilters = { query: '', tool: '', credential: '', source: 'all', decision: 'all' };
    $('#auditFilterForm')?.reset();
    renderAudit();
  });

  $('#accessForm').addEventListener('submit', (event) => {
    event.preventDefault();
    renderAccessResult(evaluateAccess(new FormData(event.currentTarget)));
  });

  $('#prefillFromAccessBtn')?.addEventListener('click', prefillToolCallFromAccess);
  $('#prefillFinanceDemoBtn')?.addEventListener('click', prefillFinanceDemoToolCall);

  $('#demoCreateCredentialBtn')?.addEventListener('click', async () => {
    const payload = buildFinanceDemoCredentialPayload();
    try {
      const button = $('#demoCreateCredentialBtn');
      button.disabled = true;
      await api('/credentials', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Demo credential created.');
      await refreshData({ quiet: true });
    } catch (err) {
      showToast(err.message.includes('already') || err.message.includes('exists') ? 'Demo credential already exists.' : err.message, true);
    } finally {
      const exists = state.credentials.some((item) => item.id === 'cred_demo_finance_readonly' && item.status === 'active');
      $('#demoCreateCredentialBtn').disabled = exists;
      $('#demoCreateCredentialBtn').textContent = exists ? 'Credential ready' : 'Create demo credential';
    }
  });

  $('#demoRunBtn')?.addEventListener('click', async () => {
    const data = new FormData($('#financeDemoForm'));
    const payload = {
      agent_id: data.get('agent_id')?.trim() || 'agent-business-demo',
      clientName: data.get('clientName')?.trim() || 'BusinessReportWorker',
      tool_name: 'business-report-demo.run_monthly_close_demo',
      credential_ref: data.get('credential_ref')?.trim() || 'cred_demo_finance_readonly',
      credential_scope: 'report',
      arguments: {
        month: data.get('month')?.trim() || '2026-06',
        output_dir: data.get('output_dir')?.trim() || '/tmp/landgod-business-report-demo-webui',
      },
      timeout: 60000,
    };
    const runButton = $('#demoRunBtn');
    runButton.disabled = true;
    runButton.textContent = 'Running...';
    $('#financeDemoResult').textContent = 'Running demo...';
    try {
      const result = await api('/tool_call', { method: 'POST', body: JSON.stringify(payload) });
      const text = result?.payload?.data?.text || result?.content?.[0]?.text || result?.result?.content?.[0]?.text;
      let parsed = result;
      if (typeof text === 'string') {
        try { parsed = JSON.parse(text); } catch { parsed = { rawText: text, rawResult: result }; }
      }
      state.financeDemoResult = parsed;
      $('#financeDemoResult').textContent = JSON.stringify(parsed, null, 2);
      showToast('Finance demo completed.');
      await refreshData({ quiet: true });
    } catch (err) {
      $('#financeDemoResult').textContent = err.message;
      showToast(err.message, true);
    } finally {
      runButton.disabled = false;
      runButton.textContent = 'Run finance demo';
    }
  });

  $('#toolCallForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let args;
    try { args = JSON.parse(data.get('arguments') || '{}'); } catch (err) { showToast(`Arguments JSON is invalid: ${err.message}`, true); return; }
    const payload = {
      agent_id: data.get('agent_id')?.trim() || 'default-agent',
      clientName: data.get('clientName')?.trim() || undefined,
      tool_name: data.get('tool_name')?.trim(),
      credential_ref: data.get('credential_ref')?.trim() || undefined,
      credential_scope: data.get('credential_scope')?.trim() || undefined,
      arguments: args,
    };
    try {
      const result = await api('/tool_call', { method: 'POST', body: JSON.stringify(payload) });
      $('#toolCallResult').textContent = JSON.stringify(result, null, 2);
      showToast('Tool call completed.');
      await refreshData({ quiet: true });
    } catch (err) {
      $('#toolCallResult').textContent = err.message;
      showToast(err.message, true);
    }
  });
}

bindEvents();
refreshData({ quiet: true }).catch((err) => showToast(err.message, true));
setInterval(() => refreshData({ quiet: true }).catch(() => {}), 15000);
