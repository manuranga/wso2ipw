#!/usr/bin/env node
/**
 * wso2integrator-cli — Drive WSO2 Integrator (Electron/VS Code fork) via Playwright.
 *
 * Architecture:
 *   open  → spawns a detached daemon that launches Electron via Playwright's
 *           _electron.launch(), listens on a Unix socket for commands.
 *   other → client connects to the daemon socket, sends the command, prints result.
 *
 * The app has two targetable frames:
 *   host  — VS Code chrome (sidebar, toolbar, status bar, terminal)
 *   guest — WSO2 extension UI (landing page, design canvas, forms)
 * Commands default to guest; pass --host to target VS Code chrome.
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import { spawn, execSync } from 'child_process';

// ─── Config ─────────────────────────────────────────────────────────────────

const APP_PATHS = [
  path.join(os.homedir(), 'Applications/WSO2 Integrator.app/Contents/MacOS/Electron'),
  '/Applications/WSO2 Integrator.app/Contents/MacOS/Electron',
  '/usr/share/wso2-integrator/wso2-integrator',
  path.join(os.homedir(), '.local/share/wso2-integrator/wso2-integrator'),
];

const STATE_DIR = path.join(os.homedir(), '.wso2integrator-cli');
const SOCKET = path.join(STATE_DIR, 'daemon.sock');
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const ERR_LOG = path.join(STATE_DIR, 'daemon.err');
const DAEMON_LOG = path.join(STATE_DIR, 'daemon.log');

function findApp() {
  if (process.env.WSO2_INTEGRATOR_PATH) {
    const p = process.env.WSO2_INTEGRATOR_PATH;
    if (fs.existsSync(p)) return p;
    throw new Error(`WSO2_INTEGRATOR_PATH not found: ${p}`);
  }
  for (const p of APP_PATHS) if (fs.existsSync(p)) return p;
  throw new Error('WSO2 Integrator not found. Set WSO2_INTEGRATOR_PATH.');
}

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(DAEMON_LOG, line); } catch {}
}

function parseFlag(args, name) {
  const f = args.find(a => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : undefined;
}

// ─── Message framing: length-prefixed JSON ──────────────────────────────────

function writeMessage(socket, obj) {
  const json = JSON.stringify(obj);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(Buffer.byteLength(json));
  socket.write(header);
  socket.write(json);
}

function readMessage(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), msgLen = null;
    socket.on('data', onData);
    socket.on('end', () => reject(new Error('Connection closed')));
    socket.on('error', reject);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (msgLen === null && buf.length >= 4) {
        msgLen = buf.readUInt32BE(0);
        buf = buf.subarray(4);
      }
      if (msgLen !== null && buf.length >= msgLen) {
        socket.off('data', onData);
        resolve(JSON.parse(buf.subarray(0, msgLen).toString()));
      }
    }
  });
}

// ─── Daemon ─────────────────────────────────────────────────────────────────

async function startDaemonProcess() {
  const { _electron: electron } = await import('playwright');
  const appPath = findApp();

  fs.mkdirSync(STATE_DIR, { recursive: true });
  try { fs.unlinkSync(SOCKET); } catch {}

  const userDataDir = process.env.WSO2I_USER_DATA_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'wso2integrator-cli-'));

  log(`Launching: ${appPath}`);
  log(`User data: ${userDataDir}`);

  const app = await electron.launch({
    executablePath: appPath,
    args: [`--user-data-dir=${userDataDir}`],
  });
  app.on('close', () => log('Electron closed'));
  app.process().on('exit', code => log(`Electron exited: ${code}`));

  const window = await app.firstWindow();
  window.on('close', () => log('Window closed'));
  window.on('crash', () => log('Window CRASHED'));
  await window.waitForLoadState('domcontentloaded');
  log('Window loaded');

  // ── Frame resolution ──

  let _webviewFrame = null;

  function webviewFrame() {
    if (_webviewFrame) {
      try { _webviewFrame.url(); return _webviewFrame; }
      catch { _webviewFrame = null; }
    }
    for (const f of window.frames().reverse()) {
      try { if (f.url().includes('vscode-webview://')) return _webviewFrame = f; }
      catch {}
    }
    return window.frames()[0];
  }

  function mainFrame() { return window.frames()[0]; }

  function pickFrame(args) {
    return args.includes('--host') ? mainFrame() : webviewFrame();
  }

  function whichFrame(args) {
    return args.includes('--host') ? 'host' : 'guest';
  }

  // Poll until a live webview frame with buttons exists.
  async function ensureWebviewFrame(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      _webviewFrame = null;
      const f = webviewFrame();
      try { if (await f.evaluate(() => document.querySelectorAll('button').length) > 0) return f; }
      catch {}
      await window.waitForTimeout(200);
    }
    return webviewFrame();
  }

  // ── Snapshot ──

  async function snapshot(which) {
    const frame = which === 'host' ? mainFrame() : webviewFrame();
    try {
      return await frame.locator('body').ariaSnapshot({ ref: true });
    } catch {
      if (which === 'host') throw new Error('Host frame unavailable');
      return await (await ensureWebviewFrame()).locator('body').ariaSnapshot({ ref: true });
    }
  }

  // After a mutation: brief settle, then snapshot.
  // 500ms is enough for React re-renders; frame destruction is caught by snapshot().
  async function settledSnapshot(which) {
    await window.waitForTimeout(500);
    return await snapshot(which);
  }

  // ── Locator resolution ──
  //   s1e29              → aria-ref
  //   getByRole(...)     → Playwright locator API
  //   anything else      → CSS selector

  function resolveLocator(frame, target) {
    if (/^s\d+e\d+$/.test(target))
      return frame.locator(`aria-ref=${target}`);
    if (target.startsWith('getBy'))
      return new Function('frame', `return frame.${target}`)(frame);
    return frame.locator(target);
  }

  // ── Command handler ──

  async function handleCommand(cmd, args) {
    const which = whichFrame(args);

    switch (cmd) {

      case 'snapshot':
        return await snapshot(which);

      case 'screenshot': {
        const file = args.find(a => !a.startsWith('-'))
          || `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const outPath = args._cwd && !path.isAbsolute(file) ? path.join(args._cwd, file) : file;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await window.screenshot({ path: outPath, type: 'png' });
        return `Screenshot saved: ${outPath}`;
      }

      case 'click':
      case 'dblclick': {
        const target = args.find(a => !a.startsWith('-'));
        if (!target) throw new Error(`Usage: ${cmd} <target> [--force] [--host]`);
        const force = args.includes('--no-force') ? false
          : (args.includes('--force') || which === 'guest');
        const locator = resolveLocator(pickFrame(args), target);
        const opts = { timeout: 5000, force };
        if (cmd === 'dblclick') await locator.dblclick(opts);
        else await locator.click(opts);
        return `${cmd === 'dblclick' ? 'Double-clicked' : 'Clicked'}: ${target}\n` + await settledSnapshot(which);
      }

      case 'fill': {
        const target = args[0];
        if (!target || args.length < 2) throw new Error('Usage: fill <target> <text> [--host]');
        const text = args.filter(a => a !== target && !a.startsWith('-')).join(' ');
        const locator = resolveLocator(pickFrame(args), target);
        // Shadow DOM inputs (vscode-text-field) need focus+keyboard instead of fill()
        const hasShadowInput = await locator.evaluate(el =>
          !!el.shadowRoot?.querySelector('input, textarea')
        ).catch(() => false);
        if (hasShadowInput) {
          await locator.evaluate(el => {
            const input = el.shadowRoot.querySelector('input, textarea');
            input.focus(); input.select();
          });
          await window.keyboard.type(text);
        } else {
          await locator.fill(text, { timeout: 5000 });
        }
        return `Filled: ${target}\n` + await settledSnapshot(which);
      }

      case 'type': {
        if (!args[0]) throw new Error('Usage: type <text>');
        await window.keyboard.type(args.join(' '));
        return `Typed: ${args.join(' ')}`;
      }

      case 'press': {
        if (!args[0]) throw new Error('Usage: press <key>');
        await window.keyboard.press(args[0]);
        return `Pressed: ${args[0]}`;
      }

      case 'eval': {
        if (!args[0]) throw new Error('Usage: eval <js> [--host]');
        const js = args.filter(a => !a.startsWith('-')).join(' ');
        return String(await pickFrame(args).evaluate(js));
      }

      case 'wait': {
        const ms = parseInt(args[0]) || 2000;
        await window.waitForTimeout(ms);
        return `Waited ${ms}ms`;
      }

      case 'close': {
        await app.close();
        cleanup();
        return 'Closed.';
      }

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  // ── Socket server ──

  const server = net.createServer(socket => {
    readMessage(socket).then(async ({ cmd, args, cwd }) => {
      args._cwd = cwd;
      log(`CMD: ${cmd} ${args.filter(a => typeof a === 'string').join(' ')}`);
      try {
        const result = await handleCommand(cmd, args);
        log(`OK: ${cmd} (${result?.length ?? 0} chars)`);
        writeMessage(socket, { ok: true, result });
        socket.end();
        if (cmd === 'close') process.exit(0);
      } catch (err) {
        log(`ERR: ${cmd}: ${err.message}`);
        writeMessage(socket, { ok: false, error: err.message });
        socket.end();
      }
    }).catch(e => { log(`SOCKET: ${e.message}`); socket.destroy(); });
  });

  function cleanup() {
    try { fs.unlinkSync(SOCKET); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    server.close();
  }

  server.listen(SOCKET, () => {
    fs.writeFileSync(PID_FILE, String(process.pid));
    log(`Daemon ready. PID: ${process.pid}`);
    process.stdout.write('ready\n');
  });

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

// ─── Client ─────────────────────────────────────────────────────────────────

function sendCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET))
      return reject(new Error('App not running. Run: wso2integrator-cli open'));
    const socket = net.createConnection(SOCKET, () => {
      writeMessage(socket, { cmd, args, cwd: process.cwd() });
    });
    readMessage(socket).then(res => {
      socket.destroy();
      res.ok ? resolve(res.result) : reject(new Error(res.error));
    }).catch(reject);
  });
}

function isDaemonRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'));
    process.kill(pid, 0);
    return pid;
  } catch { return false; }
}

function spawnDaemon(userDataDir) {
  return new Promise((resolve, reject) => {
    try { execSync('pkill -f "WSO2.*Electron"', { stdio: 'ignore' }); } catch {}

    fs.mkdirSync(STATE_DIR, { recursive: true });
    const err = fs.openSync(ERR_LOG, 'w');
    const env = { ...process.env };
    if (userDataDir) env.WSO2I_USER_DATA_DIR = userDataDir;

    const child = spawn(process.execPath, [import.meta.filename, '__daemon__'], {
      detached: true,
      stdio: ['ignore', 'pipe', err],
      cwd: process.cwd(),
      env,
    });

    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('ready')) { child.stdout.destroy(); child.unref(); resolve(); }
    });
    child.on('close', code => {
      if (!output.includes('ready')) {
        const errLog = fs.readFileSync(ERR_LOG, 'utf-8').trim();
        reject(new Error(`Daemon exited (${code})${errLog ? '\n' + errLog : ''}`));
      }
    });
    const timer = setTimeout(() => {
      if (!output.includes('ready')) { child.kill(); reject(new Error('Daemon startup timed out')); }
    }, 60000);
    timer.unref();
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

if (cmd === '__daemon__') {
  startDaemonProcess().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });

} else if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`wso2integrator-cli — Automate WSO2 Integrator via Playwright

Usage: wso2integrator-cli <command> [args]

Commands:
  open [--user-data-dir=p]     Launch app (fresh temp profile by default)
  snapshot [--host]            Aria tree with element refs
  click <target> [--host]      Click element (auto --force for guest)
  dblclick <target> [--host]   Double-click element
  fill <target> <text> [--host] Fill input field
  type <text>                  Type via keyboard
  press <key>                  Press key (Enter, Tab, Meta+k, etc.)
  eval <js> [--host]           Evaluate JS in frame
  screenshot [file]            Save screenshot
  wait [ms]                    Sleep (default 2000ms)
  close                        Quit the app

Targeting:
  s1e29                            aria-ref from snapshot
  "#submit-btn"                    CSS selector
  "getByRole('button', {name:'X'})" Playwright locator

Flags:
  --host                Target VS Code chrome instead of guest (WSO2 extension UI)
  --force / --no-force  Override pointer-event checks on click
  --user-data-dir=<p>   Persistent profile directory

Environment:
  WSO2_INTEGRATOR_PATH  Path to Electron binary (auto-detected if unset)`);

} else if (cmd === 'open') {
  const pid = isDaemonRunning();
  if (pid) {
    try {
      await sendCommand('wait', ['0']);
      console.log(`Already running (PID: ${pid})`);
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try { execSync('pkill -f "WSO2.*Electron"', { stdio: 'ignore' }); } catch {}
      try { fs.unlinkSync(SOCKET); } catch {}
      try { fs.unlinkSync(PID_FILE); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      await spawnDaemon(parseFlag(args, 'user-data-dir'));
      console.log('WSO2 Integrator is ready. (restarted)');
    }
  } else {
    await spawnDaemon(parseFlag(args, 'user-data-dir'));
    console.log('WSO2 Integrator is ready.');
  }

} else {
  try {
    const result = await sendCommand(cmd, args);
    if (result) console.log(result);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
