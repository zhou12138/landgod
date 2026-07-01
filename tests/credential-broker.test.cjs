const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { generateKeyPairSync, sign, verify, createPublicKey } = require('node:crypto');
const {
  createCredentialBroker,
  canonicalizeJson,
  buildGrantSigningPayload,
} = require('../gateway/node-gateway/server/credential-broker.js');

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(paddingLength)}`, 'base64');
}

function createSigningContext() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKey,
    signGrant(payload) {
      return toBase64Url(sign(null, Buffer.from(canonicalizeJson(buildGrantSigningPayload(payload)), 'utf-8'), privateKey));
    },
  };
}

test('credential broker issues single-use worker-bound grants', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'landgod-cred-test-'));
  const signing = createSigningContext();
  const broker = createCredentialBroker({
    dataDir: tmp,
    signGrant: signing.signGrant,
  });

  broker.createCredential({
    id: 'cred_demo_readonly',
    type: 'api_token',
    secret: { token: 'secret-token' },
    allowedAgents: ['agent-a'],
    allowedWorkerIds: ['worker-1'],
    allowedTools: ['demo.fetch'],
    deniedTools: ['shell_execute'],
    allowedScopes: ['read:data'],
  });

  const grant = broker.issueGrant({
    credentialRef: 'cred_demo_readonly',
    agentId: 'agent-a',
    binding: { clientId: 'worker-1', connectionId: 'conn-1', labels: {} },
    toolName: 'demo.fetch',
    argumentsPayload: { id: 1 },
    taskId: 'task-1',
    requestId: 'req-1',
  });

  assert.deepEqual(grant.allowed_scopes, ['read:data']);
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalizeJson(buildGrantSigningPayload(grant)), 'utf-8'),
      createPublicKey(signing.publicKey),
      fromBase64Url(grant.signature),
    ),
    true,
  );

  const exchanged = broker.exchangeGrant({
    grant_id: grant.grant_id,
    task_id: 'task-1',
    tool_name: 'demo.fetch',
    workerId: 'worker-1',
    workerConnectionId: 'conn-1',
    workerTokenId: 'tokfp-1',
  });
  assert.equal(exchanged.secret.token, 'secret-token');
  assert.throws(
    () => broker.exchangeGrant({
      grant_id: grant.grant_id,
      task_id: 'task-1',
      tool_name: 'demo.fetch',
      workerId: 'worker-1',
      workerConnectionId: 'conn-1',
      workerTokenId: 'tokfp-1',
    }),
    /Grant is exchanged/,
  );
});

test('credential broker denies unauthorized tool and worker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'landgod-cred-test-'));
  const signing = createSigningContext();
  const broker = createCredentialBroker({
    dataDir: tmp,
    signGrant: signing.signGrant,
  });
  broker.createCredential({ id: 'cred_demo_readonly', type: 'api_token', secret: { token: 'x' }, allowedAgents: ['agent-a'], allowedWorkerIds: ['worker-1'], allowedTools: ['demo.fetch'] });
  assert.throws(() => broker.issueGrant({ credentialRef: 'cred_demo_readonly', agentId: 'agent-a', binding: { clientId: 'worker-1', connectionId: 'conn-1', labels: {} }, toolName: 'shell_execute', argumentsPayload: {}, taskId: 't', requestId: 'r' }), /denies tool|not allowed/);
  assert.throws(() => broker.issueGrant({ credentialRef: 'cred_demo_readonly', agentId: 'agent-a', binding: { clientId: 'worker-2', connectionId: 'conn-2', labels: {} }, toolName: 'demo.fetch', argumentsPayload: {}, taskId: 't', requestId: 'r' }), /target worker/);
});

test('credential broker binds exchange to connection and token audit metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'landgod-cred-test-'));
  const signing = createSigningContext();
  const broker = createCredentialBroker({
    dataDir: tmp,
    signGrant: signing.signGrant,
  });

  broker.createCredential({
    id: 'cred_exchange_bound',
    type: 'api_token',
    secret: { token: 'bound-secret' },
    allowedAgents: ['agent-a'],
    allowedWorkerIds: ['worker-1'],
    allowedTools: ['demo.fetch'],
  });

  const grant = broker.issueGrant({
    credentialRef: 'cred_exchange_bound',
    agentId: 'agent-a',
    binding: { clientId: 'worker-1', connectionId: 'conn-1', labels: {} },
    toolName: 'demo.fetch',
    argumentsPayload: { id: 1 },
    taskId: 'task-2',
    requestId: 'req-2',
  });

  assert.throws(() => broker.exchangeGrant({
    grant_id: grant.grant_id,
    task_id: 'task-2',
    tool_name: 'demo.fetch',
    workerId: 'worker-1',
    workerConnectionId: 'conn-2',
    workerTokenId: 'tokfp-x',
  }), /connection_id mismatch/);

  const entries = broker.readAudit(20);
  const denial = entries.find((entry) => entry.event === 'credential_exchange_denied' && entry.code === 'grant_connection_mismatch');
  assert.ok(denial);
  assert.equal(denial.workerTokenId, '***REDACTED***');
  assert.equal(denial.workerConnectionId, 'conn-2');
});

test('credential broker audit redacts secrets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'landgod-cred-test-'));
  const signing = createSigningContext();
  const broker = createCredentialBroker({
    dataDir: tmp,
    signGrant: signing.signGrant,
  });

  broker.createCredential({
    id: 'cred_audit_redact',
    type: 'username_password',
    secret: { username: 'alice', password: 'super-secret' },
    allowedAgents: ['agent-a'],
    allowedWorkerIds: ['worker-1'],
    allowedTools: ['demo.login'],
  });

  const entries = broker.readAudit(10);
  const created = entries.find((entry) => entry.event === 'credential_created');
  assert.ok(created);
  assert.equal(created.credential.allowedWorkerIds[0], 'worker-1');
  assert.equal(created.credential.type, 'username_password');
  assert.ok(!('secret' in created.credential));
});
