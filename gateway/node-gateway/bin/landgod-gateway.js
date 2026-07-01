#!/usr/bin/env node

/**
 * landgod-gateway — Agent Sidecar Gateway
 * 
 * Usage:
 *   landgod-gateway start [options]
 *   landgod-gateway status
 *   landgod-gateway stop
 * 
 * Options:
 *   --port <port>       HTTP API port (default: 8081)
 *   --ws-port <port>    WebSocket port (default: 8080)
 *   --data-dir <dir>    Data directory (default: ~/.landgod-gateway)
 *   --daemon            Run in background
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DATA_DIR = process.env.LANDGOD_LINK_DATA || path.join(require('os').homedir(), '.landgod-gateway');
const PID_FILE = path.join(DATA_DIR, 'gateway.pid');
const LOG_FILE = path.join(DATA_DIR, 'gateway.log');
const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function printUsage() {
    console.log(`
landgod-gateway — Agent Sidecar Gateway 🏮

Usage:
  landgod-gateway start [options]    Start the gateway
  landgod-gateway stop               Stop the gateway
  landgod-gateway status             Show gateway status
  landgod-gateway --version          Show version
  landgod-gateway --help             Show this help

Options:
  --port <port>       HTTP API port (default: 8081)
  --ws-port <port>    WebSocket port for Workers (default: 8080)
  --data-dir <dir>    Data directory (default: ~/.landgod-gateway)
  --daemon            Run in background

Quick Start:
  1. landgod-gateway start
  2. Tell your Agent: POST http://localhost:8081/tool_call

API Endpoints:
  GET  /health               Health check
  GET  /clients              List connected Workers
  POST /tool_call            Execute tool on Worker
  POST /tokens               Create device token
  GET  /tokens               List all tokens
  DELETE /tokens/:token      Revoke a token
`);
}

function getPid() {
    try {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
        try { process.kill(pid, 0); return pid; } catch { return null; }
    } catch { return null; }
}

function startGateway(args) {
    const port = getFlag(args, '--port', '8081');
    const wsPort = getFlag(args, '--ws-port', '8080');
    const dataDir = getFlag(args, '--data-dir', DATA_DIR);
    const daemon = args.includes('--daemon');

    const existingPid = getPid();
    if (existingPid) {
        console.log(`Stopping old gateway (pid ${existingPid})...`);
        try { process.kill(existingPid); } catch {}
        try { fs.unlinkSync(PID_FILE); } catch {}
        // Wait for port release
        const { execSync } = require('child_process');
        try { execSync(`sleep 1`); } catch {}
    }

    // Check port availability
    const net = require('net');
    const portCheck = (p) => new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => { s.close(); resolve(true); });
        s.listen(p);
    });

    ensureDir(dataDir);

    // Parse --token argument in both `--token value` and `--token=value` forms.
    const inlineTokenArg = args.find(arg => arg.startsWith('--token='));
    const tokenIdx = args.indexOf('--token');
    const tokenArg = inlineTokenArg
        ? inlineTokenArg.slice('--token='.length)
        : (tokenIdx >= 0 && args[tokenIdx + 1] ? args[tokenIdx + 1] : null);
    
    const env = {
        ...process.env,
        LANDGOD_HTTP_PORT: port,
        LANDGOD_WS_PORT: wsPort,
        LANDGOD_DATA_DIR: dataDir,
    };
    if (tokenArg) env.LANDGOD_AUTH_TOKEN = tokenArg;

    if (daemon) {
        const logFd = fs.openSync(LOG_FILE, 'a');
        const child = spawn('node', [SERVER_SCRIPT], {
            cwd: path.dirname(SERVER_SCRIPT),
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env,
        });
        child.unref();
        fs.closeSync(logFd);
        fs.writeFileSync(PID_FILE, String(child.pid));
        console.log(`🏮 LandGod-Link Gateway started (pid ${child.pid})`);
        console.log(`   HTTP API: http://localhost:${port}`);
        console.log(`   WebSocket: ws://0.0.0.0:${wsPort}`);
        console.log(`   Data dir: ${dataDir}`);
        console.log(`   Log: ${LOG_FILE}`);
        console.log('');
        console.log('   Your Agent can now call: POST http://localhost:' + port + '/tool_call');
    } else {
        console.log(`🏮 Starting LandGod-Link Gateway...`);
        console.log(`   HTTP API: http://localhost:${port}`);
        console.log(`   WebSocket: ws://0.0.0.0:${wsPort}`);
        console.log('');
        const child = spawn('node', [SERVER_SCRIPT], {
            cwd: path.dirname(SERVER_SCRIPT),
            stdio: 'inherit',
            env,
        });
        child.on('exit', (code) => process.exit(code ?? 0));
        process.on('SIGINT', () => { child.kill(); process.exit(0); });
        process.on('SIGTERM', () => { child.kill(); process.exit(0); });
    }
}

function stopGateway() {
    const pid = getPid();
    if (!pid) {
        console.log('Gateway is not running.');
        return;
    }
    process.kill(pid);
    try { fs.unlinkSync(PID_FILE); } catch {}
    console.log(`Stopped gateway (pid ${pid})`);
}

function showStatus() {
    const pid = getPid();
    if (!pid) {
        console.log('Gateway: not running');
        return;
    }
    console.log(`Gateway: running (pid ${pid})`);
    console.log(`PID file: ${PID_FILE}`);
    console.log(`Log file: ${LOG_FILE}`);

    // Try to reach the API
    const http = require('http');
    const port = process.env.LANDGOD_HTTP_PORT || '8081';
    http.get(`http://localhost:${port}/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const health = JSON.parse(data);
                console.log(`Connected Workers: ${health.connectedClients}`);
                console.log(`Registered Tokens: ${health.registeredTokens}`);
            } catch {}
        });
    }).on('error', () => {
        console.log('API not reachable');
    });
}

function getFlag(args, name, fallback) {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
    case '--version':
    case '-v':
        console.log(`landgod-gateway ${require('../package.json').version}`);
        break;
    case 'start':
        startGateway(args.slice(1));
        break;
    case 'stop':
        stopGateway();
        break;
    case 'status':
        showStatus();
        break;
    case '--help':
    case '-h':
    case 'help':
    case undefined:
        printUsage();
        break;
    default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
}
