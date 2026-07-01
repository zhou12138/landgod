const fs = require('fs');
const path = require('path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');

const SECRET_TYPES = new Set(['api_token', 'username_password']);
const GRANT_TTL_MS = parseInt(process.env.LANDGOD_CREDENTIAL_GRANT_TTL_MS || '300000', 10);
const CREDENTIALS_FILE = 'credentials.json';
const AUDIT_FILE = 'credential-audit.jsonl';
const GRANT_SIGN_VERSION = 1;

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort((a, b) => a.localeCompare(b)).reduce((result, key) => {
    result[key] = sortJsonValue(value[key]);
    return result;
  }, {});
}

function canonicalizeJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sha256Base64Url(value) {
  return toBase64Url(createHash('sha256').update(value, 'utf-8').digest());
}

function hashArguments(args) {
  return sha256Base64Url(canonicalizeJson(args || {}));
}

function normalizeAllowedScopes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function sanitizeAuditValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
  if (!value || typeof value !== 'object') return value;
  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'secret' || key === '_landgod_credential' || /password|token|secret|api[_-]?key/i.test(key)) {
      sanitized[key] = '***REDACTED***';
      continue;
    }
    sanitized[key] = sanitizeAuditValue(entry);
  }
  return sanitized;
}

function buildGrantSigningPayload(grant) {
  return {
    v: GRANT_SIGN_VERSION,
    iss: grant.iss,
    aud: grant.aud,
    grant_id: grant.grant_id,
    task_id: grant.task_id,
    request_id: grant.request_id,
    agent_id: grant.agent_id,
    worker_id: grant.worker_id,
    connection_id: grant.connection_id,
    tool_name: grant.tool_name,
    credential_ref: grant.credential_ref,
    arguments_hash: grant.arguments_hash,
    allowed_scopes: normalizeAllowedScopes(grant.allowed_scopes),
    iat: grant.iat,
    nbf: grant.nbf,
    exp: grant.exp,
    jti: grant.jti,
    single_use: Boolean(grant.single_use),
    policy_version: Number.isFinite(grant.policy_version) ? grant.policy_version : 1,
  };
}

function publicCredentialView(credential) {
  return {
    id: credential.id,
    type: credential.type,
    description: credential.description || '',
    status: credential.status,
    allowedAgents: credential.allowedAgents || [],
    allowedWorkerIds: credential.allowedWorkerIds || [],
    allowedWorkerGroups: credential.allowedWorkerGroups || [],
    allowedTools: credential.allowedTools || [],
    deniedTools: credential.deniedTools || [],
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    allowedScopes: normalizeAllowedScopes(credential.allowedScopes),
    expiresAt: credential.expiresAt || null,
    lastUsedAt: credential.lastUsedAt || null,
    policyVersion: credential.policyVersion || 1,
  };
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf-8');
  const right = Buffer.from(String(b || ''), 'utf-8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function createCredentialBroker(options) {
  const dataDir = options.dataDir;
  const signGrant = options.signGrant;
  fs.mkdirSync(dataDir, { recursive: true });
  const credentialsPath = path.join(dataDir, CREDENTIALS_FILE);
  const auditPath = path.join(dataDir, AUDIT_FILE);
  const credentials = new Map();
  const grants = new Map();

  function audit(event, payload = {}) {
    const entry = {
      event,
      eventId: `cred-audit-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      ...sanitizeAuditValue(payload),
    };
    fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  function load() {
    credentials.clear();
    if (!fs.existsSync(credentialsPath)) return;
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
    for (const item of parsed.credentials || []) {
      credentials.set(item.id, item);
    }
  }

  function save() {
    fs.writeFileSync(credentialsPath, JSON.stringify({ credentials: Array.from(credentials.values()) }, null, 2));
  }

  function createCredential(input, actor = 'admin') {
    if (!input || typeof input !== 'object') throw new Error('credential payload must be an object');
    const id = String(input.id || '').trim();
    if (!/^cred_[A-Za-z0-9_.:-]{3,128}$/.test(id)) {
      throw new Error('credential id must match /^cred_[A-Za-z0-9_.:-]{3,128}$/');
    }
    if (credentials.has(id)) throw new Error(`credential already exists: ${id}`);
    const type = String(input.type || '').trim();
    if (!SECRET_TYPES.has(type)) throw new Error(`unsupported credential type: ${type}`);
    const secret = input.secret;
    if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw new Error('secret must be an object');
    if (type === 'api_token' && typeof secret.token !== 'string') throw new Error('api_token secret.token is required');
    if (type === 'username_password' && (typeof secret.username !== 'string' || typeof secret.password !== 'string')) {
      throw new Error('username_password secret.username and secret.password are required');
    }
    const now = new Date().toISOString();
    const credential = {
      id,
      type,
      description: typeof input.description === 'string' ? input.description : '',
      status: 'active',
      secret,
      allowedAgents: Array.isArray(input.allowedAgents) ? input.allowedAgents.map(String) : ['*'],
      allowedWorkerIds: Array.isArray(input.allowedWorkerIds) ? input.allowedWorkerIds.map(String) : [],
      allowedWorkerGroups: Array.isArray(input.allowedWorkerGroups) ? input.allowedWorkerGroups.map(String) : [],
      allowedTools: Array.isArray(input.allowedTools) ? input.allowedTools.map(String) : [],
      deniedTools: Array.isArray(input.deniedTools) ? input.deniedTools.map(String) : ['shell_execute', 'external_http_post'],
      allowedScopes: normalizeAllowedScopes(input.allowedScopes),
      expiresAt: typeof input.expiresAt === 'string' ? input.expiresAt : null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      policyVersion: 1,
    };
    credentials.set(id, credential);
    save();
    audit('credential_created', { actor, credentialRef: id, credential: publicCredentialView(credential) });
    return publicCredentialView(credential);
  }

  function listCredentials() {
    return Array.from(credentials.values()).map(publicCredentialView);
  }

  function getCredential(id) {
    return credentials.get(id) || null;
  }

  function revokeCredential(id, actor = 'admin') {
    const credential = getCredential(id);
    if (!credential) throw new Error(`credential not found: ${id}`);
    credential.status = 'revoked';
    credential.updatedAt = new Date().toISOString();
    credential.policyVersion = (credential.policyVersion || 1) + 1;
    save();
    for (const grant of grants.values()) {
      if (grant.credential_ref === id && grant.status === 'issued') {
        grant.status = 'revoked';
      }
    }
    audit('credential_revoked', { actor, credentialRef: id });
    return publicCredentialView(credential);
  }

  function isAllowed(list, value) {
    if (!Array.isArray(list) || list.length === 0) return false;
    return list.includes('*') || list.includes(value);
  }

  function workerMatches(credential, binding) {
    if (isAllowed(credential.allowedWorkerIds, binding.clientId) || isAllowed(credential.allowedWorkerIds, binding.connectionId)) return true;
    const labels = binding.labels || {};
    if (credential.allowedWorkerGroups.includes('*')) return true;
    return credential.allowedWorkerGroups.some((group) => labels.group === group || labels.workerGroup === group || labels.worker_group === group);
  }

  function assertPolicyAllows(params) {
    const credential = getCredential(params.credentialRef);
    if (!credential) return { allowed: false, code: 'credential_not_found', reason: `Credential not found: ${params.credentialRef}` };
    if (credential.status !== 'active') return { allowed: false, code: 'credential_inactive', reason: `Credential is ${credential.status}` };
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) return { allowed: false, code: 'credential_expired', reason: 'Credential is expired' };
    if (credential.deniedTools.includes(params.toolName)) return { allowed: false, code: 'credential_tool_denied', reason: `Credential denies tool: ${params.toolName}` };
    if (!isAllowed(credential.allowedTools, params.toolName)) return { allowed: false, code: 'credential_tool_not_allowed', reason: `Credential is not allowed for tool: ${params.toolName}` };
    if (!isAllowed(credential.allowedAgents, params.agentId)) return { allowed: false, code: 'credential_agent_not_allowed', reason: `Agent is not allowed for credential: ${params.agentId}` };
    if (!workerMatches(credential, params.binding)) return { allowed: false, code: 'credential_worker_not_allowed', reason: 'Credential is not allowed for target worker' };
    return { allowed: true, credential };
  }

  function issueGrant(params) {
    const policy = assertPolicyAllows(params);
    if (!policy.allowed) {
      audit('credential_grant_denied', {
        agentId: params.agentId,
        credentialRef: params.credentialRef,
        workerId: params.binding.clientId,
        connectionId: params.binding.connectionId,
        toolName: params.toolName,
        decision: 'deny',
        reason: policy.reason,
        code: policy.code,
      });
      const err = new Error(policy.reason);
      err.code = policy.code;
      throw err;
    }
    const credential = policy.credential;
    const nowMs = Date.now();
    const expMs = nowMs + GRANT_TTL_MS;
    const grant = {
      iss: 'landgod-gateway',
      aud: 'credential-exchange',
      grant_id: `grant_${randomUUID()}`,
      task_id: params.taskId,
      request_id: params.requestId,
      agent_id: params.agentId,
      worker_id: params.binding.clientId,
      connection_id: params.binding.connectionId,
      tool_name: params.toolName,
      credential_ref: params.credentialRef,
      arguments_hash: hashArguments(params.argumentsPayload),
      allowed_scopes: normalizeAllowedScopes(credential.allowedScopes),
      iat: new Date(nowMs).toISOString(),
      nbf: new Date(nowMs).toISOString(),
      exp: new Date(expMs).toISOString(),
      jti: randomUUID(),
      single_use: true,
      policy_version: credential.policyVersion || 1,
      status: 'issued',
    };
    grant.signature = signGrant(buildGrantSigningPayload(grant));
    grants.set(grant.grant_id, grant);
    audit('credential_grant_issued', {
      agentId: params.agentId,
      credentialRef: params.credentialRef,
      workerId: params.binding.clientId,
      connectionId: params.binding.connectionId,
      toolName: params.toolName,
      taskId: params.taskId,
      grantId: grant.grant_id,
      decision: 'allow',
      argumentsHash: grant.arguments_hash,
      policyVersion: grant.policy_version,
    });
    return { ...grant };
  }

  function peekGrant(grantId) {
    const grant = grants.get(grantId);
    return grant ? { ...grant } : null;
  }

  function exchangeGrant(params) {
    const grant = grants.get(params.grant_id);
    const deny = (code, reason, extra = {}) => {
      audit('credential_exchange_denied', {
        grantId: params.grant_id,
        workerId: params.workerId,
        toolName: params.tool_name,
        taskId: params.task_id,
        workerTokenId: params.workerTokenId || null,
        workerConnectionId: params.workerConnectionId || null,
        decision: 'deny',
        code,
        reason,
        ...extra,
      });
      const err = new Error(reason);
      err.code = code;
      throw err;
    };
    if (!grant) deny('grant_not_found', 'Grant not found');
    if (grant.status !== 'issued') deny('grant_not_issued', `Grant is ${grant.status}`);
    if (Date.parse(grant.exp) <= Date.now()) {
      grant.status = 'expired';
      deny('grant_expired', 'Grant is expired');
    }
    if (grant.task_id !== params.task_id) deny('grant_task_mismatch', 'Grant task_id mismatch');
    if (grant.tool_name !== params.tool_name) deny('grant_tool_mismatch', 'Grant tool_name mismatch');
    if (!constantTimeEqual(grant.worker_id, params.workerId)) deny('grant_worker_mismatch', 'Grant worker_id mismatch');
    if (params.workerConnectionId && !constantTimeEqual(grant.connection_id, params.workerConnectionId)) {
      deny('grant_connection_mismatch', 'Grant connection_id mismatch');
    }
    const credential = credentials.get(grant.credential_ref);
    if (!credential || credential.status !== 'active') deny('credential_inactive', 'Credential is not active');
    if ((credential.policyVersion || 1) !== grant.policy_version) deny('policy_version_changed', 'Credential policy changed after grant issuance');
    grant.status = 'exchanged';
    credential.lastUsedAt = new Date().toISOString();
    save();
    audit('credential_exchange_allowed', {
      grantId: grant.grant_id,
      taskId: grant.task_id,
      workerId: params.workerId,
      workerTokenId: params.workerTokenId || null,
      workerConnectionId: params.workerConnectionId || null,
      toolName: grant.tool_name,
      credentialRef: grant.credential_ref,
      credentialType: credential.type,
      decision: 'allow',
      expiresIn: Math.max(0, Math.floor((Date.parse(grant.exp) - Date.now()) / 1000)),
    });
    return {
      credential_type: credential.type,
      credential_ref: credential.id,
      secret: credential.secret,
      expires_in: Math.max(0, Math.floor((Date.parse(grant.exp) - Date.now()) / 1000)),
    };
  }

  function readAudit(limit = 100) {
    if (!fs.existsSync(auditPath)) return [];
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  load();

  return {
    createCredential,
    listCredentials,
    revokeCredential,
    issueGrant,
    peekGrant,
    exchangeGrant,
    readAudit,
    hashArguments,
  };
}

module.exports = {
  createCredentialBroker,
  hashArguments,
  canonicalizeJson,
  sha256Base64Url,
  buildGrantSigningPayload,
};
