#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'managed-client.config.json');
const DATA_DIR = path.join(ROOT_DIR, '.landgod-data');
const DAEMON_META_PATH = path.join(DATA_DIR, 'daemon.json');
const DAEMON_LOG_PATH = path.join(DATA_DIR, 'daemon.log');
const ACTIVITIES_PATH = path.join(DATA_DIR, 'activities.jsonl');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.jsonl');
const RECOMMENDED_EXECUTABLES = ['git', 'node', 'npm', 'npx', 'python', 'python3', 'winget', 'wget', 'apt-get'];
const STARTUP_MODES = ['cli-server', 'managed-client-mcp-ws'];
const TOOL_CALL_APPROVAL_MODES = ['auto', 'manual'];
const PERMISSION_PROFILES = ['command-only', 'interactive-trusted', 'full-local-admin'];

function printUsage() {
  console.log('Usage: landgod <command>');
  console.log('');
  console.log('Commands:');
  console.log('  onboard                   Interactive setup wizard');
  console.log('  start                     Start worker daemon');
  console.log('  start --ui [--demo]       Start in UI mode (foreground, with Electron GUI). --demo bypasses all security checks.');
  console.log('  start [--demo]            Start in headless daemon mode.');
  console.log('  start --headless          Start in headless mode (no GUI, recommended for servers)');
  console.log('  stop                      Stop worker daemon');
  console.log('  status                    Show worker status');
  console.log('  logs [--follow]           Show daemon logs');
  console.log('  activities                Show activity log');
  console.log('  audit                     Show audit log');
  console.log('  audit clear               Clear audit log');
  console.log('  config                    Edit config interactively');
  console.log('  config show               Print current config');
  console.log('  config set <key> <value>  Set config value');
  console.log('  mcp show                  Show MCP server configuration');
  console.log('  --version, -v             Show version');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function loadConfig() {
  if (!fileExists(CONFIG_PATH)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {};
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, sanitizeValue(entry)]),
  );
}

function saveConfig(config) {
  const current = loadConfig();
  const next = sanitizeValue({
    ...current,
    ...config,
  });

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

function loadJsonLines(filePath) {
  if (!fileExists(filePath)) {
    return [];
  }

  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    rl,
    ask(prompt) {
      return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer));
      });
    },
  };
}

async function askYesNo(question, defaultYes) {
  const { rl, ask } = createPrompt();
  const suffix = defaultYes ? 'Y/n' : 'y/N';

  try {
    while (true) {
      const answer = String(await ask(`${question} [${suffix}]: `)).trim().toLowerCase();
      if (!answer) {
        return defaultYes;
      }
      if (answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }
      console.log('Please answer yes or no.');
    }
  } finally {
    rl.close();
  }
}

async function askInput(question, defaultValue = '') {
  const { rl, ask } = createPrompt();
  const suffix = defaultValue ? ` [${defaultValue}]` : '';

  try {
    const answer = String(await ask(`${question}${suffix}: `));
    const trimmed = answer.trim();
    return trimmed || defaultValue;
  } finally {
    rl.close();
  }
}

async function askChoice(question, options, defaultIndex = 0, allowSkip = false) {
  console.log(question);
  options.forEach((option, index) => {
    const marker = index === defaultIndex ? ' (default)' : '';
    console.log(`  ${index + 1}) ${option}${marker}`);
  });
  if (allowSkip) {
    console.log('  s) Skip for now');
  }

  const { rl, ask } = createPrompt();
  try {
    while (true) {
      const answer = String(await ask('Select: ')).trim().toLowerCase();
      if (!answer) {
        return options[defaultIndex];
      }
      if (allowSkip && (answer === 's' || answer === 'skip')) {
        return null;
      }
      const numeric = Number(answer);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
        return options[numeric - 1];
      }
      console.log('Invalid selection.');
    }
  } finally {
    rl.close();
  }
}

async function askMultiSelect(question, options, defaults = []) {
  console.log(question);
  console.log('Enter comma-separated numbers. Type skip to leave unchanged.');
  options.forEach((option, index) => {
    const marker = defaults.includes(option) ? ' [default]' : '';
    console.log(`  ${index + 1}) ${option}${marker}`);
  });

  const { rl, ask } = createPrompt();
  const optionIndex = new Map(options.map((option, index) => [option.toLowerCase(), index]));
  try {
    while (true) {
      const answer = String(await ask('Select: ')).trim().toLowerCase();
      if (!answer) {
        return [...defaults];
      }
      if (answer === 'skip') {
        return null;
      }

      const tokens = answer
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

      const selectedIndexes = [];
      let valid = tokens.length > 0;

      for (const token of tokens) {
        const numeric = Number(token);
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
          selectedIndexes.push(numeric - 1);
          continue;
        }

        const byName = optionIndex.get(token);
        if (byName !== undefined) {
          selectedIndexes.push(byName);
          continue;
        }

        valid = false;
        break;
      }

      if (valid) {
        const uniqueIndexes = Array.from(new Set(selectedIndexes));
        if (uniqueIndexes.length > 0) {
          return uniqueIndexes.map((index) => options[index]);
        }
      }

      console.log('Invalid selection.');
    }
  } finally {
    rl.close();
  }
}

function parseListInput(value) {
  return String(value || '')
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getDaemonMeta() {
  if (!fileExists(DAEMON_META_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(DAEMON_META_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveDaemonMeta(meta) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(DAEMON_META_PATH, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
}

function clearDaemonMeta() {
  if (fileExists(DAEMON_META_PATH)) {
    fs.unlinkSync(DAEMON_META_PATH);
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command, args) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', command, ...args], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    })
    : spawnSync(command, args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 0) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureClientId(config) {
  if (typeof config.clientId === 'string' && config.clientId.trim()) {
    return config.clientId.trim();
  }
  return randomUUID();
}

// --- Computer-use dependency check ---

function detectPythonForComputerUse() {
  const computerUsePath = path.join(ROOT_DIR, 'mcp-servers', 'computer-use');
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['-c', 'import landgod_computer_use'], {
        timeout: 5000,
        encoding: 'utf-8',
        env: { ...process.env, PYTHONPATH: computerUsePath },
      });
      if (r.status === 0) return { pythonCmd: cmd, hasDeps: true };
      // Python found but module missing — check which packages are absent
      const missingPackages = [];
      for (const pkg of ['pyautogui', 'PIL']) {
        const check = spawnSync(cmd, ['-c', `import ${pkg}`], { timeout: 3000, encoding: 'utf-8' });
        if (check.status !== 0) missingPackages.push(pkg === 'PIL' ? 'Pillow' : pkg);
      }
      return { pythonCmd: cmd, hasDeps: false, missingPackages };
    } catch {
      // try next
    }
  }
  return { pythonCmd: null, hasDeps: false, missingPackages: ['pyautogui', 'Pillow'] };
}

async function checkAndOfferComputerUseSetup() {
  const { pythonCmd, hasDeps, missingPackages } = detectPythonForComputerUse();
  if (hasDeps) return; // all good

  if (!pythonCmd) {
    console.log('[computer-use] Python not found — computer_screenshot/click/type/scroll will be unavailable.');
    console.log('  Install Python 3.10+ to enable computer-use tools.');
    return;
  }

  const missing = missingPackages.join(' ');
  console.log(`[computer-use] Missing packages: ${missing}`);
  if (await askYesNo(`Install ${missing} now? (required for computer_screenshot, computer_click, etc.)`, true)) {
    runCommand(pythonCmd, ['-m', 'pip', 'install', ...missingPackages]);
    console.log('[computer-use] Packages installed successfully.');
  } else {
    console.log('[computer-use] Skipped. Computer-use tools will be unavailable until packages are installed.');
  }
}

function ensureElectronBinary() {
  try {
    return require('electron');
  } catch {
    throw new Error('Electron is not installed for this package yet. Run `landgod onboard` and choose to install dependencies first.');
  }
}

function buildHeadlessArgs() {
  const args = [ROOT_DIR, '--enable-managed-client-mcp-ws', '--managed-client-mcp-ws-only'];
  if (process.argv.includes('--demo')) args.push('--demo');
  return args;
}

function startDaemon(useHeadlessNode = false) {
  const currentConfig = loadConfig();
  if (!currentConfig.enabled || currentConfig.mode !== 'managed-client-mcp-ws' || !currentConfig.bootstrapBaseUrl) {
    throw new Error('Headless daemon requires managed-client-mcp-ws config with enabled=true and bootstrapBaseUrl.');
  }

  const existing = getDaemonMeta();
  if (existing && existing.pid) {
    if (isProcessRunning(existing.pid)) {
      console.log(`Stopping old daemon (pid ${existing.pid})...`);
      try { process.kill(existing.pid); } catch {}
    }
    clearDaemonMeta();
    // Wait for process cleanup
    const wait = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
    wait(2000);
  }

  ensureDir(DATA_DIR);
  const logFd = fs.openSync(DAEMON_LOG_PATH, 'a');

  let child;
  const commonEnv = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':99',
    LANDGOD_DATA_DIR: DATA_DIR,
  };

  if (useHeadlessNode) {
    // 纯 Node.js headless 模式（无 Electron）
    const headlessEntry = path.join(ROOT_DIR, '.vite', 'build', 'headless-entry.js');
    const nodeCmd = process.execPath; // 当前 node 二进制

    if (!fileExists(headlessEntry)) {
      throw new Error(`Headless entry not found: ${headlessEntry}. Run build first or use --electron mode.`);
    }

    child = spawn(nodeCmd, [headlessEntry], {
      cwd: ROOT_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: commonEnv,
    });
    console.log(`Headless daemon started in Node.js mode (pid ${child.pid}).`);
  } else {
    // Electron 模式（默认）
    const electronBinary = ensureElectronBinary();
    child = spawn(electronBinary, ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--in-process-gpu", ...buildHeadlessArgs()], {
      cwd: ROOT_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: commonEnv,
    });
    console.log(`Headless daemon started in Electron mode (pid ${child.pid}).`);
  }

  child.unref();
  fs.closeSync(logFd);

  saveDaemonMeta({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    mode: useHeadlessNode ? 'headless-node' : 'managed-client-mcp-ws',
    logPath: DAEMON_LOG_PATH,
    dataDir: DATA_DIR,
  });
}

function stopDaemon() {
  const meta = getDaemonMeta();
  if (!meta || !meta.pid) {
    console.log('Daemon is not running.');
    return;
  }

  if (!isProcessRunning(meta.pid)) {
    clearDaemonMeta();
    console.log('Daemon metadata was stale and has been cleared.');
    return;
  }

  process.kill(meta.pid);
  clearDaemonMeta();
  console.log(`Stopped daemon pid ${meta.pid}.`);
}

function printHealth() {
  const config = loadConfig();
  const daemonMeta = getDaemonMeta();
  const daemonRunning = daemonMeta ? isProcessRunning(daemonMeta.pid) : false;
  const activities = loadJsonLines(ACTIVITIES_PATH);
  const latestActivity = activities.length > 0 ? activities[activities.length - 1] : null;

  console.log('LandGod Status');
  console.log('---------------');
  console.log(`Config path: ${CONFIG_PATH}`);
  console.log(`Enabled: ${config.enabled === true ? 'yes' : 'no'}`);
  console.log(`Mode: ${config.mode || 'cli-server'}`);
  console.log(`Base URL: ${config.bootstrapBaseUrl || '(not set)'}`);
  console.log(`Daemon running: ${daemonRunning ? 'yes' : 'no'}`);
  console.log(`Daemon log path: ${DAEMON_LOG_PATH}`);
  console.log(`Activities path: ${ACTIVITIES_PATH}`);
  console.log(`Audit path: ${AUDIT_PATH}`);
  if (daemonMeta) {
    console.log(`Daemon pid: ${daemonMeta.pid}`);
    console.log(`Daemon startedAt: ${daemonMeta.startedAt || '(unknown)'}`);
  }
  if (latestActivity) {
    console.log(`Latest activity: ${latestActivity.timestamp} [${latestActivity.status}] ${latestActivity.summary}`);
  }
}

function printTail(filePath, lineCount) {
  if (!fileExists(filePath)) {
    console.log(`No file found at ${filePath}`);
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  console.log(lines.slice(Math.max(0, lines.length - lineCount)).join(os.EOL));
}

function followFile(filePath) {
  let lastSize = fileExists(filePath) ? fs.statSync(filePath).size : 0;
  console.log(`Following ${filePath}. Press Ctrl+C to stop.`);
  if (fileExists(filePath)) {
    printTail(filePath, 50);
  }

  fs.watchFile(filePath, { interval: 1000 }, (current) => {
    if (current.size <= lastSize) {
      lastSize = current.size;
      return;
    }
    const stream = fs.createReadStream(filePath, { start: lastSize, end: current.size });
    stream.pipe(process.stdout);
    lastSize = current.size;
  });
}

function parseFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  return args[index + 1] ?? fallback;
}

function parseConfigValue(rawValue) {
  const trimmed = String(rawValue ?? '').trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed === 'clear' || trimmed === '--unset') {
    return undefined;
  }

  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function setValueByPath(target, keyPath, value) {
  const keys = keyPath.split('.').map((entry) => entry.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('Config key cannot be empty.');
  }

  let cursor = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }

  cursor[keys[keys.length - 1]] = value;
}

function applyConfigSideEffects(config, keyPath, value) {
  if (keyPath === 'mode' && typeof value === 'string') {
    config.enabled = value !== 'cli-server';
  }

  if (keyPath === 'enabled' && value === false) {
    config.mode = 'cli-server';
  }
}

function setConfigFromCommand(keyPath, rawValue) {
  const current = loadConfig();
  const next = JSON.parse(JSON.stringify(current || {}));
  const parsedValue = parseConfigValue(rawValue);

  // P0 安全检查：警告危险的 shell 白名单配置
  if (keyPath === 'builtInTools.shellExecute.allowedExecutableNames') {
    const DANGEROUS_EXECUTABLES = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'csh', 'fish', 'cmd', 'powershell', 'pwsh'];
    const names = Array.isArray(parsedValue) ? parsedValue : [];
    const dangerous = names.filter(n => DANGEROUS_EXECUTABLES.includes(n.toLowerCase()));
    if (dangerous.length > 0) {
      console.warn(`\n⚠️  SECURITY WARNING: Adding shell interpreters to allowlist: ${dangerous.join(', ')}`);
      console.warn('   This effectively bypasses ALL command restrictions.');
      console.warn('   Any command can be executed via: bash -c "arbitrary command"');
      console.warn('   Consider removing these from the allowlist.\n');
    }
  }

  // P0 安全检查：警告危险的工作目录配置（包含配置文件路径）
  if (keyPath === 'builtInTools.shellExecute.allowedWorkingDirectories') {
    const dirs = Array.isArray(parsedValue) ? parsedValue : [];
    const configDir = path.dirname(CONFIG_PATH);
    const dangerous = dirs.filter(d => configDir.startsWith(d) || d.startsWith(configDir));
    if (dangerous.length > 0) {
      console.warn(`\n⚠️  SECURITY WARNING: Working directory allowlist includes config path: ${dangerous.join(', ')}`);
      console.warn('   Commands could read/modify LandGod configuration files.');
      console.warn('   Consider using a separate directory.\n');
    }
  }

  setValueByPath(next, keyPath, parsedValue);
  applyConfigSideEffects(next, keyPath, parsedValue);

  saveConfig(next);
  console.log(`Updated ${keyPath} in ${CONFIG_PATH}`);
}

function printActivities(args) {
  const limit = Number(parseFlag(args, '--limit', '20')) || 20;
  const search = String(parseFlag(args, '--search', '')).toLowerCase();
  const jsonOutput = args.includes('--json');
  const entries = loadJsonLines(ACTIVITIES_PATH)
    .filter((entry) => !search || JSON.stringify(entry).toLowerCase().includes(search))
    .slice(-limit)
    .reverse();

  if (jsonOutput) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log('No activity entries found.');
    return;
  }

  entries.forEach((entry) => {
    console.log(`${entry.timestamp} [${entry.status}] ${entry.area}/${entry.action}`);
    console.log(`  ${entry.summary}`);
    if (entry.details) {
      console.log(`  details: ${JSON.stringify(entry.details)}`);
    }
  });
}

function printAuditLog(args) {
  if (args.includes('--follow')) {
    followFile(AUDIT_PATH);
    return;
  }

  const limit = Number(parseFlag(args, '--limit', '20')) || 20;
  const search = String(parseFlag(args, '--search', '')).toLowerCase();
  const jsonOutput = args.includes('--json');
  const entries = loadJsonLines(AUDIT_PATH)
    .filter((entry) => !search || JSON.stringify(entry).toLowerCase().includes(search))
    .slice(-limit)
    .reverse();

  if (jsonOutput) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log('No audit entries found.');
    return;
  }

  entries.forEach((entry, index) => {
    const timestamp = entry.timestamp || '(no-timestamp)';
    const command = entry.command || '(no-command)';
    const exitCode = entry.exitCode;
    const exitLabel = exitCode === null ? 'killed' : exitCode === 0 ? 'success' : `exit:${exitCode}`;
    const durationMs = typeof entry.durationMs === 'number' ? `${entry.durationMs}ms` : '-';
    const clientIp = entry.clientIp || '-';
    const cwd = entry.cwd || entry.workingDirectory || '';

    // Header line
    console.log(`${timestamp}  [${exitLabel}]  ${command}`);

    // Detail lines
    if (cwd) {
      console.log(`  cwd:      ${cwd}`);
    }
    if (clientIp !== '-') {
      console.log(`  client:   ${clientIp}`);
    }
    if (durationMs !== '-') {
      console.log(`  duration: ${durationMs}`);
    }
    if (entry.stdout) {
      console.log(`  stdout:`);
      String(entry.stdout).split(/\r?\n/).forEach((line) => {
        console.log(`    ${line}`);
      });
    }
    if (entry.stderr) {
      console.log(`  stderr:`);
      String(entry.stderr).split(/\r?\n/).forEach((line) => {
        if (line.trim()) {
          console.log(`    ${line}`);
        }
      });
    }
    if (!entry.stdout && !entry.stderr) {
      console.log(`  (no output)`);
    }

    // Separator between entries
    if (index < entries.length - 1) {
      console.log('');
    }
  });
}

function mergeBuiltInTools(config, updates) {
  const nextBuiltInTools = { ...(config.builtInTools || {}) };

  if (updates.permissionProfile) {
    nextBuiltInTools.permissionProfile = updates.permissionProfile;
  }
  if (updates.shellExecute) {
    nextBuiltInTools.shellExecute = {
      ...(nextBuiltInTools.shellExecute || {}),
      ...updates.shellExecute,
    };
  }
  if (updates.fileRead) {
    nextBuiltInTools.fileRead = {
      ...(nextBuiltInTools.fileRead || {}),
      ...updates.fileRead,
    };
  }

  return nextBuiltInTools;
}

async function runConfigWizard(seed = {}) {
  const current = loadConfig();
  const merged = { ...current, ...seed };
  console.log('Interactive config wizard');
  console.log('Use numbered choices, yes/no, skip for now, and free-form list input.');

  const selectedMode = await askChoice('Select startup mode:', STARTUP_MODES, Math.max(0, STARTUP_MODES.indexOf(merged.mode || 'managed-client-mcp-ws')), true);
  const mode = selectedMode || merged.mode || 'managed-client-mcp-ws';
  const next = {
    ...merged,
    clientId: ensureClientId(merged),
    enabled: mode !== 'cli-server',
    mode,
  };

  if (mode !== 'cli-server') {
    next.bootstrapBaseUrl = await askInput('Managed client base URL', merged.bootstrapBaseUrl || merged.baseUrl || '');
    next.tlsServername = await askInput('TLS servername override (optional)', merged.tlsServername || '');
    if (mode === 'managed-client-mcp-ws') {
      next.signinPageUrl = await askInput('Sign-in page URL (optional)', merged.signinPageUrl || '');
    }

    const tokenValue = await askInput('Bearer token (blank keeps current, enter clear to remove)', '');
    if (tokenValue.toLowerCase() === 'clear') {
      next.token = undefined;
    } else if (tokenValue) {
      next.token = tokenValue;
    }

    next.toolCallApprovalMode = await askChoice('Tool call approval mode:', TOOL_CALL_APPROVAL_MODES, Math.max(0, TOOL_CALL_APPROVAL_MODES.indexOf(merged.toolCallApprovalMode || 'manual')));

    const permissionProfile = await askChoice('Permission profile:', PERMISSION_PROFILES, Math.max(0, PERMISSION_PROFILES.indexOf(merged.builtInTools?.permissionProfile || 'interactive-trusted')), true);
    if (permissionProfile) {
      next.builtInTools = mergeBuiltInTools(next, { permissionProfile });
    }

    const executablePrompt = await askInput('Configure shell executable allowlist now? (y/N, or paste executable names)', '');
    const executablePromptNormalized = executablePrompt.trim().toLowerCase();
    const pastedExecutables = parseListInput(executablePrompt);

    if (executablePromptNormalized === 'y' || executablePromptNormalized === 'yes') {
      const selectedExecutables = await askMultiSelect('Select recommended executables:', RECOMMENDED_EXECUTABLES, RECOMMENDED_EXECUTABLES);
      const manualExecutables = await askInput('Additional executable names (comma/newline/semicolon separated)', '');
      next.builtInTools = mergeBuiltInTools(next, {
        shellExecute: {
          enabled: true,
          allowedExecutableNames: Array.from(new Set([...(selectedExecutables || []), ...parseListInput(manualExecutables)])),
        },
      });
    } else if (executablePromptNormalized === 'n' || executablePromptNormalized === 'no' || executablePromptNormalized === '') {
      // Keep existing allowlist unchanged.
    } else if (pastedExecutables.length > 0) {
      next.builtInTools = mergeBuiltInTools(next, {
        shellExecute: {
          enabled: true,
          allowedExecutableNames: Array.from(new Set(pastedExecutables)),
        },
      });
      console.log('Detected pasted executable list and applied it directly.');
    } else {
      console.log('Input not recognized. Skipping executable allowlist update.');
    }

    if (await askYesNo('Configure shell working directory allowlist now?', false)) {
      const dirs = await askInput('Allowed working directories (comma/newline/semicolon separated)', merged.builtInTools?.shellExecute?.allowedWorkingDirectories?.join(', ') || ROOT_DIR);
      next.builtInTools = mergeBuiltInTools(next, {
        shellExecute: {
          enabled: true,
          allowedWorkingDirectories: parseListInput(dirs),
        },
      });
    }

    if (await askYesNo('Configure file-read allowlist now?', false)) {
      const readPaths = await askInput('Allowed file-read roots (comma/newline/semicolon separated)', merged.builtInTools?.fileRead?.allowedPaths?.join(', ') || ROOT_DIR);
      next.builtInTools = mergeBuiltInTools(next, {
        fileRead: {
          enabled: true,
          allowedPaths: parseListInput(readPaths),
        },
      });
    }
  }

  saveConfig(next);
  console.log(`Saved config to ${CONFIG_PATH}`);
  return next;
}

function launchUiMode() {
  const electronBinary = ensureElectronBinary();
  const builtEntry = path.join(ROOT_DIR, '.vite', 'build', 'index.js');
  if (!fileExists(builtEntry)) {
    throw new Error(
      `UI build not found at ${builtEntry}.\n` +
      'Run "npm run make" to build the app first, or run "npm run build" for a faster development build.',
    );
  }
  const electronArgs = [ROOT_DIR, '--enable-managed-client-mcp-ws', '--managed-client-mode=managed-client-mcp-ws'];
  if (process.argv.includes('--demo')) {
    electronArgs.push('--demo');
    console.log('[demo] Starting in demo mode — all security checks are disabled.');
  }
  const result = spawnSync(
    electronBinary,
    electronArgs,
    {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: { ...process.env, LANDGOD_DATA_DIR: DATA_DIR },
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}

function launchHeadlessForeground() {
  const electronBinary = ensureElectronBinary();
  const result = spawnSync(electronBinary, buildHeadlessArgs(), {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      LANDGOD_DATA_DIR: DATA_DIR,
    },
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

async function runOnboard() {
  console.log('========================================');
  console.log('  LandGod Worker Setup');
  console.log('========================================');
  console.log('');

  const currentConfig = loadConfig();

  // Step 1: 安装依赖
  if (await askYesNo('Install dependencies now?', true)) {
    runCommand(getNpmCommand(), ['install']);
  }

  // Step 2: 选择模式
  const modeLabel = await askChoice('Choose mode:', ['GUI (图形界面)', 'Headless (无界面，推荐)'], 1);
  let useHeadless = modeLabel === 'Headless (无界面，推荐)';

  // Step 3: Gateway URL
  const baseUrl = await askInput('Gateway URL', currentConfig.bootstrapBaseUrl || currentConfig.baseUrl || 'ws://localhost:8080');

  // Step 4: Token
  const token = await askInput('Token (optional)', currentConfig.token || '');

  if (token && !useHeadless) {
    console.log('Token detected. Switching to headless mode.');
    useHeadless = true;
  }

  // Step 5: Sign-in page URL (GUI 模式)
  let signinPageUrl = currentConfig.signinPageUrl || '';
  if (!useHeadless) {
    signinPageUrl = await askInput('Sign-in page URL (optional, skip to use default)', signinPageUrl);
  }

  // Step 6: TLS servername (可选)
  const tlsServername = await askInput('TLS servername override (optional, skip if unsure)', currentConfig.tlsServername || '');

  // Step 7: Permission profile
  const permissionProfile = await askChoice('Permission level:', PERMISSION_PROFILES, 1);

  // Step 8: Tool call approval mode
  const approvalMode = await askChoice('Tool call approval mode:', TOOL_CALL_APPROVAL_MODES, 0);

  // Step 9: 自定义白名单（可选）
  const executablePrompt = await askInput('Configure executable allowlist? (y/N, or paste names)', '');
  let customExecutables = null;
  if (executablePrompt.trim().toLowerCase() === 'y' || executablePrompt.trim().toLowerCase() === 'yes') {
    const selected = await askMultiSelect('Select executables:', RECOMMENDED_EXECUTABLES, RECOMMENDED_EXECUTABLES);
    const manual = await askInput('Additional executables (comma separated, optional)', '');
    customExecutables = Array.from(new Set([...(selected || []), ...parseListInput(manual)]));
  } else if (executablePrompt.trim() && executablePrompt.trim().toLowerCase() !== 'n' && executablePrompt.trim().toLowerCase() !== 'no') {
    customExecutables = parseListInput(executablePrompt);
    if (customExecutables.length > 0) {
      console.log('Detected pasted executable list and applied.');
    } else {
      customExecutables = null;
    }
  }

  // 保存配置
  const config = {
    ...currentConfig,
    clientId: ensureClientId(currentConfig),
    enabled: true,
    mode: 'managed-client-mcp-ws',
    bootstrapBaseUrl: baseUrl,
    token: token || currentConfig.token,
    signinPageUrl: signinPageUrl || undefined,
    tlsServername: tlsServername || undefined,
    toolCallApprovalMode: approvalMode,
    builtInTools: mergeBuiltInTools(currentConfig, { permissionProfile }),
  };

  if (customExecutables && customExecutables.length > 0) {
    config.builtInTools = mergeBuiltInTools(config, {
      shellExecute: { enabled: true, allowedExecutableNames: customExecutables },
    });
  }

  saveConfig(config);
  console.log('');
  console.log('Config saved.');

  // Step 10: 启动
  if (await askYesNo('Start now?', true)) {
    if (useHeadless) {
      startDaemon(true);
    } else {
      launchUiMode();
    }
  } else {
    console.log('');
    console.log('To start later:');
    console.log(useHeadless ? '  landgod start --headless' : '  landgod start');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(`landgod ${require(require('path').resolve(__dirname, '..', 'package.json')).version}`);
    return;
  }

  if (command === 'onboard') {
    await runOnboard();
    return;
  }

  if (command === 'start' || (command === 'daemon' && args[1] === 'start')) {
    if (args.includes('--ui') || args.includes('--foreground')) {
      launchUiMode();
      return;
    }
    const useHeadlessNode = args.includes('--headless');
    if (!args.includes('--skip-computer-use-check')) {
      await checkAndOfferComputerUseSetup();
    }
    startDaemon(useHeadlessNode);
    return;
  }

  if (command === 'stop' || (command === 'daemon' && args[1] === 'stop')) {
    stopDaemon();
    return;
  }

  if (command === 'daemon') {
    throw new Error('Usage: landgod start|stop');
  }

  if (command === 'status' || command === 'health') {
    printHealth();
    return;
  }

  if (command === 'logs') {
    if (args.includes('--follow')) {
      followFile(DAEMON_LOG_PATH);
      return;
    }
    const lineCount = Number(parseFlag(args, '--lines', '100')) || 100;
    printTail(DAEMON_LOG_PATH, lineCount);
    return;
  }

  if (command === 'activities') {
    printActivities(args.slice(1));
    return;
  }

  if (command === 'audit') {
    if (args[1] === 'clear') {
      const auditPath = path.join(DATA_DIR, 'audit.jsonl');
      if (fileExists(auditPath)) {
        fs.writeFileSync(auditPath, '', 'utf-8');
        console.log('Audit log cleared.');
      } else {
        console.log('No audit log to clear.');
      }
      return;
    }
    if (args[1] === 'log') {
      printAuditLog(args.slice(2));
      return;
    }
    // 'landgod audit' 直接等同于 'landgod audit log'
    printAuditLog(args.slice(1));
    return;
  }

  if (command === 'mcp') {
    const MCP_SERVERS_PATH = path.join(ROOT_DIR, 'managed-client.mcp-servers.json');
    if (args[1] === 'show' || args[1] === 'config' && args[2] === 'show') {
      if (!fileExists(MCP_SERVERS_PATH)) {
        console.log('No MCP servers configured. File not found: managed-client.mcp-servers.json');
        return;
      }
      console.log(fs.readFileSync(MCP_SERVERS_PATH, 'utf-8'));
      return;
    }
    console.log('Usage: landgod mcp show       Show MCP server configuration');
    return;
  }

  if (command === 'config') {
    if (args[1] === 'show') {
      if (!fileExists(CONFIG_PATH)) {
        console.log('{}');
        return;
      }
      console.log(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return;
    }
    if (args[1] === 'set') {
      const keyPath = args[2];
      const rawValue = args.slice(3).join(' ');
      if (!keyPath || !rawValue) {
        throw new Error('Usage: landgod config set <keyPath> <value>');
      }
      setConfigFromCommand(keyPath, rawValue);
      return;
    }
    await runConfigWizard();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exit(1);
});