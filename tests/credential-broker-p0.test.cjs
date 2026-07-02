const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialBroker } = require('../gateway/node-gateway/server/credential-broker');

function createBroker() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landgod-cred-test-'));
  return createCredentialBroker({ dataDir, signGrant: () => 'test-signature' });
}

test('credential policy rejects wildcard allowedTools by default', () => {
  const broker = createBroker();
  assert.throws(() => broker.createCredential({
    id: 'cred_wildcard_test',
    type: 'api_token',
    secret: { token: 'secret-token' },
    allowedTools: ['*'],
  }), /wildcard is disabled/);
});

test('credential scope is checked, carried into grant, and returned on exchange', () => {
  const broker = createBroker();
  broker.createCredential({
    id: 'cred_scope_test',
    type: 'api_token',
    secret: { token: 'secret-token' },
    allowedAgents: ['agent-finance'],
    allowedWorkerIds: ['worker-finance-01'],
    allowedTools: ['finance.report.generate'],
    allowedScopes: ['report'],
  });

  assert.throws(() => broker.issueGrant({
    credentialRef: 'cred_scope_test',
    agentId: 'agent-finance',
    binding: { clientId: 'worker-finance-01', connectionId: 'conn-1', labels: {} },
    toolName: 'finance.report.generate',
    argumentsPayload: { month: '2026-06' },
    credentialScope: 'submit',
    taskId: 'task-1',
    requestId: 'req-1',
  }), /Credential scope is not allowed: submit/);

  const grant = broker.issueGrant({
    credentialRef: 'cred_scope_test',
    agentId: 'agent-finance',
    binding: { clientId: 'worker-finance-01', connectionId: 'conn-1', labels: {} },
    toolName: 'finance.report.generate',
    argumentsPayload: { month: '2026-06' },
    credentialScope: 'report',
    taskId: 'task-2',
    requestId: 'req-2',
  });

  assert.equal(grant.requested_scope, 'report');
  const exchanged = broker.exchangeGrant({
    grant_id: grant.grant_id,
    task_id: 'task-2',
    tool_name: 'finance.report.generate',
    workerId: 'worker-finance-01',
    workerConnectionId: 'conn-1',
    workerTokenId: 'token-fp',
  });

  assert.equal(exchanged.scope, 'report');
  assert.equal(exchanged.credential_ref, 'cred_scope_test');
  assert.deepEqual(Object.keys(exchanged.secret), ['token']);

  assert.throws(() => broker.exchangeGrant({
    grant_id: grant.grant_id,
    task_id: 'task-2',
    tool_name: 'finance.report.generate',
    workerId: 'worker-finance-01',
    workerConnectionId: 'conn-1',
    workerTokenId: 'token-fp',
  }), /Grant is exchanged/);
});

test('requireExactWorkerId rejects label-only credential use', () => {
  const broker = createBroker();
  broker.createCredential({
    id: 'cred_exact_worker_test',
    type: 'api_token',
    secret: { token: 'secret-token' },
    allowedAgents: ['agent-finance'],
    allowedWorkerGroups: ['finance'],
    allowedTools: ['finance.report.generate'],
    requireExactWorkerId: true,
  });

  assert.throws(() => broker.issueGrant({
    credentialRef: 'cred_exact_worker_test',
    agentId: 'agent-finance',
    binding: { clientId: 'worker-unknown', connectionId: 'conn-1', labels: { group: 'finance' } },
    toolName: 'finance.report.generate',
    argumentsPayload: {},
    taskId: 'task-1',
    requestId: 'req-1',
  }), /Credential is not allowed for target worker/);
});
