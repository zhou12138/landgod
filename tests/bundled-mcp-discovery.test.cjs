const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function buildDiscoveryModule() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'landgod-discovery-build-'));
  const outfile = path.join(outdir, 'bundled-mcp-discovery.cjs');
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../src/main/managed-client/bundled-mcp-discovery.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
  });
  return require(outfile);
}

function withTempWorkspace(callback) {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landgod-discovery-test-'));
  try {
    fs.mkdirSync(path.join(root, 'mcp-servers'), { recursive: true });
    process.chdir(root);
    return callback(root);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeServer(root, name, manifest) {
  const serverRoot = path.join(root, 'mcp-servers', name);
  fs.mkdirSync(serverRoot, { recursive: true });
  fs.writeFileSync(path.join(serverRoot, 'server.py'), 'print("ok")\n', 'utf-8');
  fs.writeFileSync(path.join(serverRoot, 'landgod.mcp.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

const { discoverBundledMcpServers } = buildDiscoveryModule();

test('discovers a bundled python-script MCP manifest', () => {
  withTempWorkspace((root) => {
    writeServer(root, 'erp-domain', {
      name: 'erp-domain',
      kind: 'bundled-mcp',
      transport: 'stdio',
      commandStrategy: { type: 'python-script', script: 'server.py' },
      availability: { python: true, exists: ['server.py'] },
      publication: {
        publishedRemotely: true,
        trustLevel: 'trusted',
        requiredPermissionProfile: 'full-local-admin',
      },
      tools: ['erp_export_orders'],
      env: { ERP_ROOT: '${ROOT}' },
    });

    const discovered = discoverBundledMcpServers({ args: [], fileConfig: {}, userMcpConfig: {} });
    assert.equal(Object.keys(discovered).length, 1);
    assert.equal(discovered['erp-domain'].transport, 'stdio');
    assert.deepEqual(discovered['erp-domain'].args, [path.join(root, 'mcp-servers', 'erp-domain', 'server.py')]);
    assert.deepEqual(discovered['erp-domain'].tools, ['erp_export_orders']);
    assert.equal(discovered['erp-domain'].env.ERP_ROOT, path.join(root, 'mcp-servers', 'erp-domain'));
    assert.equal(discovered['erp-domain'].requiredPermissionProfile, 'full-local-admin');
  });
});

test('user MCP config overrides bundled manifest discovery', () => {
  withTempWorkspace((root) => {
    writeServer(root, 'erp-domain', {
      name: 'erp-domain',
      kind: 'bundled-mcp',
      transport: 'stdio',
      commandStrategy: { type: 'python-script', script: 'server.py' },
      availability: { python: true, exists: ['server.py'] },
      tools: ['erp_export_orders'],
    });

    const discovered = discoverBundledMcpServers({
      args: [],
      fileConfig: {},
      userMcpConfig: {
        'erp-domain': { command: 'custom-python', args: ['custom.py'], tools: ['custom_tool'] },
      },
    });

    assert.deepEqual(discovered, {});
  });
});

test('disable arg suppresses bundled MCP discovery', () => {
  withTempWorkspace((root) => {
    writeServer(root, 'erp-domain', {
      name: 'erp-domain',
      kind: 'bundled-mcp',
      transport: 'stdio',
      commandStrategy: { type: 'python-script', script: 'server.py' },
      availability: { python: true, exists: ['server.py'] },
      tools: ['erp_export_orders'],
      disable: { arg: '--disable-erp-domain' },
    });

    const discovered = discoverBundledMcpServers({ args: ['--disable-erp-domain'], fileConfig: {}, userMcpConfig: {} });
    assert.deepEqual(discovered, {});
  });
});