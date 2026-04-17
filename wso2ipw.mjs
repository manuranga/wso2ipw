#!/usr/bin/env node
/**
 * wso2ipw — Drive WSO2 Integrator (Electron/VS Code fork) via Playwright.
 *
 * Architecture:
 *   open  → spawns a detached daemon that launches Electron via Playwright's
 *           _electron.launch(), listens on a Unix socket for commands.
 *   other → client connects to the daemon socket, sends the command, prints result.
 *
 * The app has two targetable frames:
 *   host  (h:) — VS Code chrome (sidebar, toolbar, status bar, terminal)
 *   guest (g:) — WSO2 extension UI (landing page, design canvas, forms)
 * All ref-targeting commands require a g: or h: prefix to pick the frame.
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import crypto from 'crypto';
import { spawn, execSync } from 'child_process';

// ─── Pseudoelement injection ────────────────────────────────────────────────
// WSO2's extension renders many interactive elements without ARIA roles.
// Before each snapshot we inject role + aria-label so they get refs.
//
// Three rules cover everything:
//   1. Any leaf <div> with cursor:pointer — palette items, HTTP method labels,
//      action links (Define Payload, Add Connection, Add Else Block, …)
//   2. SVG add-node buttons ([data-testid*="add-button"]) — target parent <div>
//      because the <svg> itself reports 0×0 layout
//   3. Flow diagram nodes (.node inside the canvas) — cursor:move, not pointer
//
// Special case: <vscode-button data-testid="close-panel-btn"> already has an
// implicit button role; we only override its aria-label.

const INJECT_PSEUDOS_FN = () => {
  // Strip previous cycle
  for (const el of document.querySelectorAll('[data-pseudo]')) {
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
    el.removeAttribute('data-pseudo');
  }
  const dominated = (el) =>
    el.getAttribute('role') || el.matches('button,a,[role]');
  const tag = (el, label) => {
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', label);
    el.setAttribute('data-pseudo', '1');
  };
  // 1. Specific selectors first (take priority over generic scan)
  //    SVG add-node buttons → tag parent div (has layout)
  for (const el of document.querySelectorAll('[data-testid*="add-button"]')) {
    const div = el.parentElement;
    if (div?.tagName === 'DIV' && !dominated(div))
      tag(div, el.getAttribute('data-testid'));
  }
  //    Flow diagram nodes (cursor:move, not pointer)
  for (const el of document.querySelectorAll(
    '[data-testid="bi-diagram-canvas"] .node'
  )) {
    const text = el.textContent?.trim().split('\n')[0];
    if (text && !dominated(el)) tag(el, text);
  }
  //    close-panel-btn — label override only
  const cp = document.querySelector('[data-testid="close-panel-btn"]');
  if (cp) {
    cp.setAttribute('aria-label', 'Close Panel');
    cp.setAttribute('data-pseudo', '1');
  }
  // 2. Generic: divs and spans with cursor:pointer (innermost first)
  //    Skip elements whose child elements contain meaningful text (avoids
  //    tagging wrapper divs that duplicate their children's labels).
  const els = document.querySelectorAll('div, span');
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (dominated(el) || el.querySelector('[data-pseudo]')) continue;
    if (el.parentElement?.closest('button,a,[role]:not([role="document"]):not([role="main"]):not([role="navigation"]):not([role="region"]):not([role="complementary"]):not([role="contentinfo"]):not([role="banner"]):not(body)')) continue;
    const text = el.textContent?.trim();
    if (!text || text.length > 50) continue;
    if ([...el.children].some(c => c.textContent?.trim())) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    tag(el, text);
  }
};

const injectPseudos = INJECT_PSEUDOS_FN;

// ─── Config ─────────────────────────────────────────────────────────────────

const IS_WIN = process.platform === 'win32';

const APP_PATHS = IS_WIN ? [
  path.join(process.env.APPDATA || '', 'WSO2', 'Integrator', 'WSO2 Integrator.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WSO2 Integrator', 'WSO2 Integrator.exe'),
  path.join(process.env.ProgramFiles || '', 'WSO2 Integrator', 'WSO2 Integrator.exe'),
] : [
  path.join(os.homedir(), 'Applications/WSO2 Integrator.app/Contents/MacOS/Electron'),
  '/Applications/WSO2 Integrator.app/Contents/MacOS/Electron',
  '/usr/share/wso2-integrator/wso2-integrator',
  path.join(os.homedir(), '.local/share/wso2-integrator/wso2-integrator'),
];

const BASE_DIR = path.join(os.homedir(), '.wso2ipw');

// Workspace-scoped state dir: ~/.wso2ipw/<sha1(cwd)[0:16]>/
// Daemon receives the resolved dir via WSO2I_STATE_DIR env var.
function workspaceDir(cwd) {
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').substring(0, 16);
  return path.join(BASE_DIR, hash);
}

function stateDir() {
  return process.env.WSO2I_STATE_DIR || workspaceDir(process.cwd());
}

function statePath(name) { return path.join(stateDir(), name); }
// On Windows, Node's net server can't listen on a plain file path — it needs
// a named-pipe URI. Use one derived from the workspace hash so each cwd still
// gets its own daemon endpoint.
const SOCKET = () => {
  if (IS_WIN) {
    const hash = crypto.createHash('sha1').update(stateDir()).digest('hex').substring(0, 16);
    return `\\\\.\\pipe\\wso2ipw-${hash}`;
  }
  return statePath('daemon.sock');
};
const PID_FILE = () => statePath('daemon.pid');
const ERR_LOG  = () => statePath('daemon.err');
const DAEMON_LOG = () => statePath('daemon.log');
// Written by daemon so clients can discover which cwd this dir belongs to.
const SESSION_FILE = () => statePath('session.json');

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
  try { fs.appendFileSync(DAEMON_LOG(), line); } catch {}
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

  fs.mkdirSync(stateDir(), { recursive: true });
  try { fs.unlinkSync(SOCKET()); } catch {}

  const userDataDir = process.env.WSO2I_USER_DATA_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'wso2ipw-'));

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

  function webviewFrame() {
    // Always scan: frame references go stale after navigation (e.g. sign-in dismiss).
    // Pick the deepest vscode-webview:// frame (last in reverse = innermost iframe with content).
    for (const f of window.frames().reverse()) {
      try { if (f.url().includes('vscode-webview://')) return f; }
      catch {}
    }
    return null;
  }

  function mainFrame() { return window.frames()[0]; }

  // ── Ref prefix parsing ──

  function parsePrefix(target) {
    const m = target.match(/^([gh]):(.+)$/s);
    if (!m) {
      if (/^s\d+e\d+$/.test(target))
        throw new Error(`Missing frame prefix. Use g:${target} or h:${target}`);
      throw new Error(`Missing frame prefix. Use g:${target} or h:${target}`);
    }
    return { frame: m[1], target: m[2] };
  }

  function frameFor(prefix) {
    if (prefix === 'h') return mainFrame();
    const f = webviewFrame();
    if (!f) throw new Error('Guest frame not available');
    return f;
  }

  // Poll until a live webview frame with buttons exists.
  async function ensureWebviewFrame(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const f = webviewFrame();
      if (f) {
        try { if (await f.evaluate(() => document.querySelectorAll('button').length) > 0) return f; }
        catch {}
      }
      await window.waitForTimeout(200);
    }
    throw new Error('Guest frame not available (timeout)');
  }

  // ── Snapshot ──

  async function injectPseudoElements(frame) {
    try { await frame.evaluate(injectPseudos); } catch {}
  }

  async function snapshotGuest() {
    let frame = webviewFrame();
    if (!frame) frame = await ensureWebviewFrame();
    else {
      try { await frame.locator('body').waitFor({ timeout: 500 }); }
      catch { frame = await ensureWebviewFrame(); }
    }
    await injectPseudoElements(frame);
    return await frame.locator('body').ariaSnapshot({ ref: true });
  }

  async function snapshotHost() {
    return await mainFrame().locator('body').ariaSnapshot({ ref: true });
  }

  function prefixRefs(snap, prefix) {
    return snap.replace(/ref=s/g, `ref=${prefix}:s`);
  }

  // Hit-test the iframe center in the host frame to detect modal overlays.
  async function isGuestOccluded() {
    return mainFrame().evaluate(() => {
      const iframe = document.querySelector('iframe');
      if (!iframe) return true;
      const r = iframe.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return true;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== iframe && !iframe.contains(hit);
    }).catch(() => true);
  }

  async function unifiedSnapshot() {
    const [guest, host, occluded] = await Promise.all([
      snapshotGuest().catch(() => null),
      snapshotHost(),
      isGuestOccluded(),
    ]);
    const sections = [];
    if (guest !== null && !occluded) sections.push(`- guest:\n${indent(prefixRefs(guest, 'g'))}`);
    else if (guest !== null) sections.push('- guest: [occluded by host overlay]');
    sections.push(`- host:\n${indent(prefixRefs(host, 'h'))}`);
    return sections.join('\n');
  }

  function indent(text) {
    return text.split('\n').map(l => '  ' + l).join('\n');
  }

  // After a mutation: brief settle, then snapshot.
  async function settledSnapshot() {
    await window.waitForTimeout(500);
    return await unifiedSnapshot();
  }

  // CM fields need longer settle for LSP validation (1-3s).
  async function cmSettledSnapshot() {
    await window.waitForTimeout(2000);
    return await unifiedSnapshot();
  }

  // Check for codicon-warning error text near any CM editor in the frame.
  async function checkCmErrors(frame) {
    return frame.evaluate(() => {
      const icon = document.querySelector('.codicon-warning');
      return icon?.parentElement?.textContent?.trim() || '';
    }).catch(() => '');
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
    switch (cmd) {

      case 'snapshot':
        return await unifiedSnapshot();

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
        const raw = args.find(a => !a.startsWith('-'));
        if (!raw) throw new Error(`Usage: ${cmd} <g:|h:><target> [--force]`);
        const { frame: prefix, target } = parsePrefix(raw);
        const frame = frameFor(prefix);
        const forceExplicit = args.includes('--force') ? true
          : args.includes('--no-force') ? false : null;
        const locator = resolveLocator(frame, target);

        // <vscode-button> has a shadow DOM <button> that must receive the click.
        // Playwright force-click bypasses shadow DOM propagation; non-force times
        // out when overlays cover the button. So we click the shadow button via JS.
        const isVscodeBtn = await locator.evaluate(
          el => el.tagName === 'VSCODE-BUTTON'
            || el.closest?.('vscode-button') !== null
        ).catch(() => false);

        if (isVscodeBtn && cmd === 'click' && forceExplicit === null) {
          await locator.evaluate(el => {
            const host = el.tagName === 'VSCODE-BUTTON' ? el : el.closest('vscode-button');
            if (host?.disabled) throw new Error('Button is disabled');
            const btn = host?.shadowRoot?.querySelector('button');
            (btn || host).click();
          });
        } else {
          const force = forceExplicit ?? (prefix === 'g');
          const opts = { timeout: 5000, force };
          if (cmd === 'dblclick') await locator.dblclick(opts);
          else await locator.click(opts);
        }
        return `${cmd === 'dblclick' ? 'Double-clicked' : 'Clicked'}: ${raw}\n` + await settledSnapshot();
      }

      case 'fill': {
        const raw = args[0];
        if (!raw || args.length < 2) throw new Error('Usage: fill <g:|h:><target> <text>');
        const { frame: prefix, target } = parsePrefix(raw);
        const frame = frameFor(prefix);
        const text = args.filter(a => a !== raw && !a.startsWith('-')).join(' ');
        const locator = resolveLocator(frame, target);
        // Three input types need different fill strategies:
        //   1. vscode-text-field (shadow DOM <input>) — type into shadow input,
        //      fire composed input/change events, blur for validation
        //   2. CodeMirror (contentEditable .cm-content) — Playwright fill() sets
        //      DOM text but bypasses CM6's input system; must use keyboard
        //   3. Normal inputs — Playwright fill() works directly
        const inputType = await locator.evaluate(el => {
          if (el.shadowRoot?.querySelector('input, textarea')) return 'shadow';
          // Playwright aria-refs pierce shadow DOM: the locator may resolve to
          // the <input> inside a shadow root rather than the host element.
          if (el.getRootNode() instanceof ShadowRoot) return 'shadow';
          if (el.closest?.('.cm-editor') || el.classList?.contains('cm-content')) return 'codemirror';
          return 'default';
        }).catch(() => 'default');

        if (inputType === 'shadow') {
          // Locate the native <input> — locator may be the host or the input itself.
          await locator.evaluate(el => {
            const input = el.shadowRoot?.querySelector('input, textarea') || el;
            input.focus(); input.select();
          });
          await window.keyboard.type(text);
          // Blur the host element to trigger framework validation.
          // The locator is stale after typing (React re-render), so target
          // the host via the active element's shadow root chain.
          await frameFor(prefix).evaluate(() => {
            const active = document.activeElement;
            // active may be the host (vscode-text-field) with shadow containing input
            const input = active?.shadowRoot?.querySelector('input, textarea')
              || (active?.getRootNode() instanceof ShadowRoot ? active : null);
            const host = active?.shadowRoot ? active : active?.getRootNode()?.host;
            if (input) {
              input.dispatchEvent(new InputEvent('input', {
                bubbles: true, composed: true,
                inputType: 'insertText', data: input.value,
              }));
              input.blur();
            }
            if (host) host.blur();
          }).catch(() => {});
        } else if (inputType === 'codemirror') {
          // CM6 ignores Playwright fill() and insertText — they set DOM but not
          // CM's internal state. keyboard.type() triggers autocomplete that
          // swallows chars. keyboard.press() misroutes after frame operations.
          // Solution: use CM6's view.dispatch() to replace the document directly.
          await locator.evaluate((el, text) => {
            const content = el.closest?.('.cm-editor')?.querySelector('.cm-content') ||
              (el.classList?.contains('cm-content') ? el : null);
            const view = content?.cmView?.view;
            if (!view) throw new Error('CM view not found');
            view.focus();
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: text }
            });
          }, text);
        } else {
          await locator.fill(text, { timeout: 5000 });
        }

        // For CM fields, wait longer before snapshot — LSP validation takes 1-3s.
        const snap = inputType === 'codemirror'
          ? await cmSettledSnapshot()
          : await settledSnapshot();
        const cmErrors = inputType === 'codemirror' ? await checkCmErrors(frame) : '';
        return `Filled: ${raw}` + (cmErrors ? `\n⚠ ${cmErrors}` : '') + '\n' + snap;
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
        const raw = args[0];
        if (!raw) throw new Error('Usage: eval <g:|h:><js>');
        const { frame: prefix, target: js } = parsePrefix(raw);
        // Remaining non-flag args are part of the JS expression
        const rest = args.slice(1).filter(a => !a.startsWith('-'));
        const fullJs = rest.length ? js + ' ' + rest.join(' ') : js;
        return String(await frameFor(prefix).evaluate(fullJs));
      }

      case 'wait': {
        const ms = parseInt(args[0]) || 2000;
        await window.waitForTimeout(ms);
        return `Waited ${ms}ms`;
      }

      case 'wait-for-text': {
        const text = args.find(a => !a.startsWith('-'));
        if (!text) throw new Error('Usage: wait-for-text <text> [--timeout=N] [--hidden]');
        const timeout = parseInt(parseFlag(args, 'timeout') ?? '30000');
        const hidden = args.includes('--hidden');

        if (hidden) {
          // Wait for text to disappear from BOTH frames
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const [guestHas, hostHas] = await Promise.all([
              (async () => {
                const f = webviewFrame();
                if (!f) return false;
                try { return await f.getByText(text).first().isVisible(); }
                catch { return false; }
              })(),
              mainFrame().getByText(text).first().isVisible().catch(() => false),
            ]);
            if (!guestHas && !hostHas)
              return `Text hidden: ${text}\n` + await unifiedSnapshot();
            await window.waitForTimeout(200);
          }
          throw new Error(`Timeout waiting for text to hide: ${text}`);
        }

        // Wait for text to appear in EITHER frame (poll to handle guest frame recreation)
        const deadline2 = Date.now() + timeout;
        while (Date.now() < deadline2) {
          const [guestHas, hostHas] = await Promise.all([
            (async () => {
              const f = webviewFrame();
              if (!f) return false;
              try { return await f.getByText(text).first().isVisible(); }
              catch { return false; }
            })(),
            mainFrame().getByText(text).first().isVisible().catch(() => false),
          ]);
          if (guestHas || hostHas)
            return `Text visible: ${text}\n` + await unifiedSnapshot();
          await window.waitForTimeout(200);
        }
        throw new Error(`Timeout waiting for text: ${text}`);
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
    try { fs.unlinkSync(SOCKET()); } catch {}
    try { fs.unlinkSync(PID_FILE()); } catch {}
    try { fs.unlinkSync(SESSION_FILE()); } catch {}
    server.close();
  }

  server.listen(SOCKET(), () => {
    fs.writeFileSync(PID_FILE(), String(process.pid));
    fs.writeFileSync(SESSION_FILE(), JSON.stringify({
      pid: process.pid,
      socketPath: SOCKET(),
      userDataDir,
      cwd: process.env.WSO2I_ORIG_CWD || process.cwd(),
      timestamp: Date.now(),
    }, null, 2));
    log(`Daemon ready. PID: ${process.pid}`);
    process.stdout.write('ready\n');
  });

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

// ─── Client ─────────────────────────────────────────────────────────────────

function sendCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const sock = SOCKET();
    // Named pipes on Windows aren't filesystem entries; fall back to the PID file.
    const available = IS_WIN ? fs.existsSync(PID_FILE()) : fs.existsSync(sock);
    if (!available)
      return reject(new Error('App not running. Run: wso2ipw open'));
    const socket = net.createConnection(sock, () => {
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
    const pid = parseInt(fs.readFileSync(PID_FILE(), 'utf-8'));
    process.kill(pid, 0);
    return pid;
  } catch { return false; }
}

function spawnDaemon(userDataDir) {
  return new Promise((resolve, reject) => {
    try {
      if (IS_WIN) execSync('taskkill /F /IM "WSO2 Integrator.exe"', { stdio: 'ignore' });
      else execSync('pkill -f "WSO2.*Electron"', { stdio: 'ignore' });
    } catch {}

    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const err = fs.openSync(ERR_LOG(), 'w');
    const env = { ...process.env };
    env.WSO2I_STATE_DIR = dir;
    env.WSO2I_ORIG_CWD = process.cwd();
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
        const errLog = fs.readFileSync(ERR_LOG(), 'utf-8').trim();
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
  console.log(`wso2ipw — Automate WSO2 Integrator via Playwright

Usage: wso2ipw <command> [args]

Commands:
  open [--user-data-dir=p]      Launch app (fresh temp profile by default)
  snapshot                      Aria tree of both frames with prefixed refs
  click <g:|h:><ref> [--force]  Click element (auto --force for g:)
  dblclick <g:|h:><ref>         Double-click element
  fill <g:|h:><ref> <text>      Fill input field
  type <text>                   Type via keyboard
  press <key>                   Press key (Enter, Tab, Meta+k, etc.)
  eval <g:|h:><js>              Evaluate JS in frame
  screenshot [file]             Save screenshot
  wait [ms]                     Sleep (default 2000ms)
  wait-for-text <text>          Wait for text in either frame (--hidden for disappear)
  close                         Quit the app

Targeting (prefix required):
  g:s1e29                          guest aria-ref from snapshot
  h:s1e280                         host aria-ref from snapshot
  g:"#submit-btn"                  CSS selector in guest
  h:"getByRole('button', {name:'X'})" Playwright locator in host

Flags:
  --force / --no-force  Override pointer-event checks (auto for g: except vscode-button)
  --timeout=N           Timeout in ms (for wait-for-text)
  --hidden              Wait for text to disappear from both frames
  --user-data-dir=<p>   Persistent profile directory

Environment:
  WSO2_INTEGRATOR_PATH  Path to Electron binary (auto-detected if unset)`);

} else if (cmd === 'open') {
  const pid = isDaemonRunning();
  if (pid) {
    try {
      await sendCommand('wait', ['0']);
      console.log(`Already running (PID: ${pid}). Log: ${DAEMON_LOG()}`);
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try {
        if (IS_WIN) execSync('taskkill /F /IM "WSO2 Integrator.exe"', { stdio: 'ignore' });
        else execSync('pkill -f "WSO2.*Electron"', { stdio: 'ignore' });
      } catch {}
      try { fs.unlinkSync(SOCKET()); } catch {}
      try { fs.unlinkSync(PID_FILE()); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      await spawnDaemon(parseFlag(args, 'user-data-dir'));
      console.log(`WSO2 Integrator is ready. (restarted)\nLog: ${DAEMON_LOG()}`);
    }
  } else {
    await spawnDaemon(parseFlag(args, 'user-data-dir'));
    console.log(`WSO2 Integrator is ready.\nLog: ${DAEMON_LOG()}`);
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
