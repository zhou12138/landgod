const state = {
  health: null,
  clients: [],
  tools: [],
  credentials: [],
  tasks: [],
  queued: [],
  gatewayAudit: [],
  credentialAudit: [],
  workerAudit: [],
  currentView: 'overview',
};

const titles = {
  overview: ['Overview', 'Central status for workers, tools, credentials, tasks, and audit.'],
  workers: ['Workers', 'Connected Worker nodes and their reported labels/resources.'],
  tools: ['Tools', 'Published remote capabilities grouped by Worker.'],
  credentials: ['Credentials', 'Gateway-managed credential metadata and policy. Secrets are never displayed.'],
  tasks: ['Tasks', 'Recent async tasks and queued tool calls.'],
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
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
    api('/tools'),
    api('/credentials'),
    api('/tasks?limit=50'),
    api('/gateway/audit?limit=120'),
    api('/credentials/audit?limit=80'),
    api('/audit?limit=50'),
  ]);

  const [health, clients, tools, credentials, tasks, gatewayAudit, credentialAudit, workerAudit] = results;
  if (health.status === 'fulfilled') state.health = health.value;
  if (clients.status === 'fulfilled') state.clients = clients.value.clients || [];
  if (tools.status === 'fulfilled') state.tools = tools.value.tools || [];
  if (credentials.status === 'fulfilled') state.credentials = credentials.value.credentials || [];
  if (tasks.status === 'fulfilled') {
    state.tasks = tasks.value.tasks || [];
    state.queued = tasks.value.queued || [];
  }
  if (gatewayAudit.status === 'fulfilled') state.gatewayAudit = gatewayAudit.value.entries || [];
  if (credentialAudit.status === 'fulfilled') state.credentialAudit = credentialAudit.value.entries || [];
  if (workerAudit.status === 'fulfilled') state.workerAudit = workerAudit.value.audit || [];

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
  $all('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  $('#pageTitle').textContent = titles[view]?.[0] || view;
  $('#pageSubtitle').textContent = titles[view]?.[1] || '';
  render();
}

function statusPill(text, tone = '') {
  return `<span class="status-pill ${tone}">${escapeHtml(text)}</span>`;
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

function renderWorkers() {
  renderTable('#workersTable', ['Status', 'Client', 'Connection', 'Labels', 'Resources', 'Session'], state.clients.map((worker) => [
    statusPill('online', 'good'),
    `<strong>${escapeHtml(worker.clientName)}</strong><br><span class="muted">${escapeHtml(worker.clientId)}</span>`,
    `<span class="pre-wrap">${escapeHtml(worker.connectionId)}</span>`,
    `<pre class="pre-wrap">${json(worker.labels)}</pre>`,
    `<pre class="pre-wrap">${json(worker.resources)}</pre>`,
    escapeHtml(worker.sessionId || '—'),
  ]), 'No connected Workers.');
}

function renderTools() {
  $('#toolsList').innerHTML = state.tools.length ? state.tools.map((worker) => `
    <div class="card-row">
      <div class="card-row-head">
        <span class="card-title">${escapeHtml(worker.clientName)}</span>
        ${statusPill(`${worker.toolCount || 0} tools`, worker.toolCount ? 'good' : 'warn')}
      </div>
      <div class="card-meta"><span>${escapeHtml(worker.connectionId)}</span></div>
      <div class="tool-cloud">${(worker.tools || []).map((tool) => `<span class="pill">${escapeHtml(tool)}</span>`).join(' ') || '<span class="muted">No tools</span>'}</div>
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
  const taskRows = [
    ...state.queued.map((task) => ({ ...task, status: 'queued' })),
    ...state.tasks,
  ];
  renderTable('#tasksTable', ['Status', 'Task', 'Target', 'Tool', 'Created / Updated', 'Credential'], taskRows.map((task) => [
    statusPill(task.status || 'unknown', task.status === 'completed' ? 'good' : task.status === 'failed' ? 'bad' : 'warn'),
    `<span class="pre-wrap">${escapeHtml(task.taskId || task.id || '—')}</span>`,
    escapeHtml(task.clientName || task.connectionId || '—'),
    escapeHtml(task.tool_name || task.toolName || '—'),
    `<span class="muted">${escapeHtml(task.createdAt || '—')}</span><br><span class="muted">${escapeHtml(task.updatedAt || '')}</span>`,
    escapeHtml(task.credential_ref || task.credentialRef || '—'),
  ]), 'No tasks yet.');
}

function renderAuditCard(entry) {
  const event = entry.event || entry.type || entry.message || 'event';
  const tone = entry.decision === 'deny' ? 'bad' : entry.decision === 'allow' ? 'good' : '';
  return `<div class="card-row">
    <div class="card-row-head">
      <span class="card-title">${escapeHtml(event)}</span>
      ${statusPill(entry.decision || entry.level || 'audit', tone)}
    </div>
    <div class="card-meta">
      <span>${escapeHtml(entry.ts || entry.timestamp || entry.time || '')}</span>
      <span>${escapeHtml(entry.credentialRef || entry.credential_ref || '')}</span>
      <span>${escapeHtml(entry.toolName || entry.tool_name || '')}</span>
    </div>
    <pre class="pre-wrap">${json(entry)}</pre>
  </div>`;
}

function renderAudit() {
  $('#gatewayAudit').innerHTML = state.gatewayAudit.length ? state.gatewayAudit.slice().reverse().map(renderAuditCard).join('') : '<div class="card-row muted">No Gateway central audit events.</div>';
  $('#credentialAudit').innerHTML = state.credentialAudit.length ? state.credentialAudit.slice().reverse().map(renderAuditCard).join('') : '<div class="card-row muted">No credential audit events.</div>';
  $('#workerAudit').innerHTML = state.workerAudit.length ? state.workerAudit.map((group) => `
    <div class="card-row">
      <div class="card-row-head"><span class="card-title">${escapeHtml(group.clientName)}</span>${group.error ? statusPill('error', 'bad') : statusPill(`${(group.entries || []).length} entries`, 'good')}</div>
      ${group.error ? `<p class="muted">${escapeHtml(group.error)}</p>` : (group.entries || []).slice(0, 12).map((entry) => `<pre class="pre-wrap">${json(entry)}</pre>`).join('')}
    </div>
  `).join('') : '<div class="card-row muted">No Worker audit data. Worker may be offline or audit_read may be disabled.</div>';
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

function renderAccessResult(result) {
  const box = $('#accessResult');
  box.classList.remove('empty', 'allowed', 'denied');
  box.classList.add(result.allowed ? 'allowed' : 'denied');
  box.innerHTML = `${result.allowed ? '✅ Allowed by loaded Gateway/Worker metadata' : '⛔ Denied / needs attention'}\n\n${escapeHtml(JSON.stringify(result, null, 2))}`;
}

function render() {
  $('#apiBase').textContent = `API: ${location.origin}`;
  renderOverview();
  renderWorkers();
  renderTools();
  renderCredentials();
  renderTasks();
  renderAudit();
}

function bindEvents() {
  $all('.nav-item').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));
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

  $('#accessForm').addEventListener('submit', (event) => {
    event.preventDefault();
    renderAccessResult(evaluateAccess(new FormData(event.currentTarget)));
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
