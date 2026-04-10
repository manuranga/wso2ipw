#!/usr/bin/env node
/**
 * wso2integrator-cli — Drive WSO2 Integrator (Electron/VS Code fork) via Playwright.
 *
 * Architecture:
 *   open  → spawns a detached daemon that launches Electron via Playwright's
 *           _electron.launch(), listens on a Unix socket for commands.
 *   other → client connects to the daemon socket, sends the command, prints result.
 *
 * The app has two frames:
 *   main    — VS Code chrome (sidebar tree, toolbar, status bar, terminal)
 *   webview — WSO2 extension UI (landing page, design canvas, forms)
 * Commands default to webview; pass --main to target VS Code chrome.
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import { spawn, execSync } from 'child_process';

const APP_PATHS = [
  // macOS
  path.join(os.homedir(), 'Applications/WSO2 Integrator.app/Contents/MacOS/Electron'),
  '/Applications/WSO2 Integrator.app/Contents/MacOS/Electron',
  // Linux (common locations)
  '/usr/share/wso2-integrator/wso2-integrator',
  path.join(os.homedir(), '.local/share/wso2-integrator/wso2-integrator'),
];

function findApp() {
  const envPath = process.env.WSO2_INTEGRATOR_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    throw new Error(`WSO2_INTEGRATOR_PATH set but not found: ${envPath}`);
  }
  for (const p of APP_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'WSO2 Integrator not found. Set WSO2_INTEGRATOR_PATH or install to a standard location.'
  );
}

const STATE_DIR = path.join(os.homedir(), '.wso2integrator-cli');
const SOCKET = path.join(STATE_DIR, 'daemon.sock');
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const ERR_LOG = path.join(STATE_DIR, 'daemon.err');
const DAEMON_LOG = path.join(STATE_DIR, 'daemon.log');

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(DAEMON_LOG, line); } catch {}
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
    let buf = Buffer.alloc(0);
    let msgLen = null;
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

  log(`Launching WSO2 Integrator...`);
  log(`  app: ${appPath}`);
  log(`  user-data-dir: ${userDataDir}`);

  const app = await electron.launch({
    executablePath: appPath,
    args: [`--user-data-dir=${userDataDir}`],
  });

  app.on('close', () => log('EVENT: ElectronApplication closed'));
  app.process().on('exit', (code) => log(`EVENT: Electron process exited with code ${code}`));

  const window = await app.firstWindow();
  window.on('close', () => log('EVENT: Window closed'));
  window.on('crash', () => log('EVENT: Window crashed!'));
  await window.waitForLoadState('domcontentloaded');
  log('Window loaded');

  // ── Frame helpers ──

  function webviewFrame() {
    const frames = window.frames();
    for (let i = frames.length - 1; i >= 0; i--) {
      try { if (frames[i].url().includes('vscode-webview://')) return frames[i]; } catch {}
    }
    return frames[0];
  }

  function mainFrame() {
    return window.frames()[0];
  }

  function pickFrame(args) {
    return args.includes('--main') ? mainFrame() : webviewFrame();
  }

  async function snapshot(which) {
    if (which !== 'main') await waitForWebviewFrame();
    const frame = which === 'main' ? mainFrame() : webviewFrame();
    return await frame.locator('body').ariaSnapshot({ ref: true });
  }

  // ── Wait for network/navigation to settle after an action ──

  async function waitForCompletion(page, callback) {
    const requests = [];
    const onRequest = r => requests.push(r);
    page.on('request', onRequest);
    try {
      await callback();
      await page.waitForTimeout(500);
    } finally {
      page.off('request', onRequest);
    }

    const hasNavigation = requests.some(r => r.isNavigationRequest());
    if (hasNavigation) {
      await page.mainFrame().waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      // Webview frame may have been recreated — wait for it to have content
      await waitForWebviewFrame();
      return;
    }

    const tracked = requests.filter(r =>
      ['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(r.resourceType())
    );
    const settled = tracked.map(r => r.response().then(res => res?.finished()).catch(() => {}));
    const timeout = new Promise(r => setTimeout(r, 5000));
    await Promise.race([Promise.all(settled), timeout]);
  }

  // Wait for a webview frame to appear and have content (at least one button).
  // Needed after actions that cause the webview to be destroyed and recreated.
  async function waitForWebviewFrame(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = webviewFrame();
      try {
        const n = await frame.evaluate(() => document.querySelectorAll('button').length);
        if (n > 0) return;
      } catch {}
      await window.waitForTimeout(500);
    }
  }

  // ── Resolve a target string to a Playwright locator ──
  //   aria-ref:  s1e29
  //   CSS:       #main > button, .submit-btn
  //   Locator:   getByRole('button', { name: 'Create' })

  function resolveLocator(frame, target) {
    if (/^s\d+e\d+$/.test(target))
      return frame.locator(`aria-ref=${target}`);
    if (target.startsWith('getBy'))
      return new Function('frame', `return frame.${target}`)(frame);
    return frame.locator(target);
  }

  // ── Command handler ──

  async function handleCommand(cmd, args) {
    switch (cmd) {
      case 'snapshot': {
        return await snapshot(args.includes('--main') ? 'main' : 'webview');
      }
      case 'screenshot': {
        const file = args.find(a => !a.startsWith('-'))
          || `.wso2integrator-cli/screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const outPath = args._cwd && !path.isAbsolute(file) ? path.join(args._cwd, file) : file;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await window.screenshot({ path: outPath, type: 'png' });
        return `Screenshot saved: ${outPath}`;
      }
      case 'click':
      case 'dblclick': {
        const target = args.find(a => !a.startsWith('-'));
        if (!target) throw new Error(`Usage: ${cmd} <target> [--force] [--no-force] [--main]`);
        const isWebview = !args.includes('--main');
        // Auto-force for webview (overlay divs intercept pointer events), opt out with --no-force
        const force = args.includes('--no-force') ? false : (args.includes('--force') || isWebview);
        const frame = pickFrame(args);
        const locator = resolveLocator(frame, target);
        const opts = { timeout: 5000, force };
        await waitForCompletion(window, async () => {
          if (cmd === 'dblclick') await locator.dblclick(opts);
          else await locator.click(opts);
        });
        const which = isWebview ? 'webview' : 'main';
        return `${cmd === 'dblclick' ? 'Double-clicked' : 'Clicked'}: ${target}\n` + await snapshot(which);
      }
      case 'fill': {
        const target = args[0];
        if (!target || args.length < 2) throw new Error('Usage: fill <target> <text> [--main]');
        const frame = pickFrame(args);
        const text = args.filter(a => a !== target && !a.startsWith('-')).join(' ');
        await waitForCompletion(window, async () => {
          const locator = resolveLocator(frame, target);
          // Auto-pierce shadow DOM: if the target has a shadowRoot with an <input>,
          // focus that inner input and type via keyboard instead of Playwright fill().
          const hasShadowInput = await locator.evaluate(el => {
            if (!el.shadowRoot) return false;
            const input = el.shadowRoot.querySelector('input, textarea');
            return !!input;
          }).catch(() => false);
          if (hasShadowInput) {
            await locator.evaluate(el => {
              const input = el.shadowRoot.querySelector('input, textarea');
              input.focus();
              input.select();
            });
            await window.keyboard.type(text);
          } else {
            await locator.fill(text, { timeout: 5000 });
          }
        });
        const which = args.includes('--main') ? 'main' : 'webview';
        return `Filled: ${target}\n` + await snapshot(which);
      }
      case 'type': {
        if (!args[0]) throw new Error('Usage: type <text>');
        const text = args.join(' ');
        await window.keyboard.type(text);
        await window.waitForTimeout(300);
        return `Typed: ${text}`;
      }
      case 'press': {
        if (!args[0]) throw new Error('Usage: press <key>');
        await window.keyboard.press(args[0]);
        await window.waitForTimeout(300);
        return `Pressed: ${args[0]}`;
      }
      case 'eval': {
        if (!args[0]) throw new Error('Usage: eval <js> [--main]');
        const js = args.filter(a => !a.startsWith('-')).join(' ');
        const frame = pickFrame(args);
        return String(await frame.evaluate(js));
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
        log(`CMD OK: ${cmd} (${result?.length || 0} chars)`);
        writeMessage(socket, { ok: true, result });
        socket.end();
        if (cmd === 'close') process.exit(0);
      } catch (err) {
        log(`CMD ERR: ${cmd}: ${err.message}`);
        writeMessage(socket, { ok: false, error: err.message });
        socket.end();
      }
    }).catch((e) => { log(`SOCKET ERR: ${e.message}`); socket.destroy(); });
  });

  server.listen(SOCKET, () => {
    fs.writeFileSync(PID_FILE, String(process.pid));
    log(`Daemon ready. PID: ${process.pid}`);
    process.stdout.write('ready\n');
  });

  function cleanup() {
    try { fs.unlinkSync(SOCKET); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    server.close();
  }

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

// ─── Client ─────────────────────────────────────────────────────────────────

function sendCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET)) {
      reject(new Error('App not running. Run: wso2integrator-cli open'));
      return;
    }
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
      if (output.includes('ready')) {
        child.stdout.destroy();
        child.unref();
        resolve();
      }
    });

    child.on('close', code => {
      if (!output.includes('ready')) {
        const errLog = fs.readFileSync(ERR_LOG, 'utf-8').trim();
        reject(new Error(`Daemon exited (code ${code})${errLog ? '\n' + errLog : ''}`));
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
  open [--user-data-dir=p]  Launch app (fresh temp profile by default)
  snapshot [--main]         Aria tree with element refs
  click <target> [--force] [--main]   Click element
  dblclick <target> [--force] [--main] Double-click element
  fill <target> <text> [--main]       Fill input field
  type <text>               Type via keyboard
  press <key>               Press key (Enter, Tab, Meta+k, etc.)
  eval <js> [--main]        Evaluate JS in frame
  screenshot [file]         Save screenshot
  wait [ms]                 Wait (default 2000ms)
  close                     Quit the app

Targeting:
  <target> can be:
    s1e29                            aria-ref from snapshot
    "#submit-btn"                    CSS selector
    "getByRole('button', {name:'X'})" Playwright locator

Flags:
  --main      Target VS Code chrome instead of the webview
  --force     Bypass overlay/pointer-event checks on click
  --user-data-dir=<path>  Use a specific profile directory (persistent state)

Environment:
  WSO2_INTEGRATOR_PATH  Path to the Electron binary (auto-detected if not set)

Examples:
  wso2integrator-cli open
  wso2integrator-cli snapshot
  wso2integrator-cli click s1e29 --force
  wso2integrator-cli click "button.submit-btn"
  wso2integrator-cli fill s2e33 "hello-icp"
  wso2integrator-cli screenshot before.png
  wso2integrator-cli close`);
} else if (cmd === 'open') {
  const pid = isDaemonRunning();
  if (pid) {
    // Verify the daemon is actually responsive
    try {
      await sendCommand('wait', ['0']);
      console.log(`Already running (PID: ${pid})`);
    } catch {
      // Stale daemon — kill and restart
      log(`Stale daemon (PID: ${pid}), restarting...`);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try { execSync('pkill -f "WSO2.*Electron"', { stdio: 'ignore' }); } catch {}
      try { fs.unlinkSync(SOCKET); } catch {}
      try { fs.unlinkSync(PID_FILE); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      const uddArg = args.find(a => a.startsWith('--user-data-dir'));
      const userDataDir = uddArg ? uddArg.split('=')[1] : undefined;
      await spawnDaemon(userDataDir);
      console.log('WSO2 Integrator is ready. (restarted)');
    }
  } else {
    const uddArg = args.find(a => a.startsWith('--user-data-dir'));
    const userDataDir = uddArg ? uddArg.split('=')[1] : undefined;
    await spawnDaemon(userDataDir);
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
