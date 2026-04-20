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

// ─── Timeouts ───────────────────────────────────────────────────────────────

const POLL_MS        = 200;   // retry-loop polling interval
const TERM_POLL_MS   = 500;   // terminal polling (clipboard round-trip is heavier)
const SETTLE_MS      = 500;   // post-mutation settle before snapshot
const SLOW_SETTLE_MS = 2000;  // CM/LSP settle, wait default, flush delays
const ACTION_TIMEOUT = 5000;  // Playwright click/fill, webview frame wait
const LONG_TIMEOUT   = 30000; // wait-for-text default
const TERM_TIMEOUT   = 60000; // wait-for-terminal default (compile + start)
const STARTUP_TIMEOUT = 120000; // daemon startup

function lcs(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const seq = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { seq.push({ ai: i, bj: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return seq;
}

// Strip snapshot counter from refs so s5e33 and s6e33 match during LCS.
function normalizeRefs(line) {
  return line.replace(/\b([gh]:)?s\d+e(\d+)/g, '$1_e$2');
}

function unifiedDiff(oldText, newText, context = 3) {
  const oldL = oldText.split('\n'), newL = newText.split('\n');
  // LCS on normalized lines so ref counter churn doesn't cause false diffs
  const common = lcs(oldL.map(normalizeRefs), newL.map(normalizeRefs));
  const ops = [];
  let oi = 0, ni = 0;
  for (const { ai, bj } of common) {
    while (oi < ai) ops.push({ type: '-', line: oldL[oi++] });
    while (ni < bj) ops.push({ type: '+', line: newL[ni++] });
    ops.push({ type: '=', line: newL[ni] });
    oi++; ni++;
  }
  while (oi < oldL.length) ops.push({ type: '-', line: oldL[oi++] });
  while (ni < newL.length) ops.push({ type: '+', line: newL[ni++] });

  // Collect indices of changed ops, then build context-padded hunks
  const changes = [];
  for (let k = 0; k < ops.length; k++) if (ops[k].type !== '=') changes.push(k);
  if (!changes.length) return null;
  const hunks = [];
  let start = Math.max(0, changes[0] - context);
  let end = Math.min(ops.length, changes[0] + context + 1);
  for (let c = 1; c < changes.length; c++) {
    const cs = Math.max(0, changes[c] - context);
    const ce = Math.min(ops.length, changes[c] + context + 1);
    if (cs <= end) { end = Math.max(end, ce); }
    else { hunks.push({ start, end }); start = cs; end = ce; }
  }
  hunks.push({ start, end });

  const lines = ['--- previous', '+++ current'];
  for (const h of hunks) {
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < h.start; k++) {
      if (ops[k].type !== '+') oldStart++;
      if (ops[k].type !== '-') newStart++;
    }
    let oldCount = 0, newCount = 0;
    for (let k = h.start; k < h.end; k++) {
      if (ops[k].type !== '+') oldCount++;
      if (ops[k].type !== '-') newCount++;
    }
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let k = h.start; k < h.end; k++) {
      const prefix = ops[k].type === '=' ? ' ' : ops[k].type;
      lines.push(prefix + ops[k].line);
    }
  }
  return compressRemovals(lines).join('\n');
}

// Collapse runs of >5 consecutive `-` lines to: 2 head, `…`, 2 tail
function compressRemovals(lines) {
  const out = [];
  let run = [];
  const flushRun = () => {
    if (run.length > 5) out.push(...run.slice(0, 2), ' …', ...run.slice(-2));
    else out.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (l.startsWith('-') && !l.startsWith('---')) { run.push(l); continue; }
    if (run.length) flushRun();
    out.push(l);
  }
  if (run.length) flushRun();
  return out;
}

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
    if (div?.tagName === 'DIV' && !dominated(div)) {
      // Rename to avoid collision with Copilot chip that shares the numeric id
      const testId = el.getAttribute('data-testid');
      const label = testId.replace('link-add-button', 'add-node-between')
                          .replace('empty-node-add-button', 'add-node-empty');
      tag(div, label);
      // The div is display:none until hover. Force it visible and sized.
      if (testId.startsWith('link-add-button')) {
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.justifyContent = 'center';
        div.style.minWidth = '24px';
        div.style.minHeight = '24px';
        div.style.overflow = 'visible';
      }
    }
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
    if (el.parentElement?.closest('button,a,vscode-button,[role]:not([role="document"]):not([role="main"]):not([role="navigation"]):not([role="region"]):not([role="complementary"]):not([role="contentinfo"]):not([role="banner"]):not(body)')) continue;
    const text = el.textContent?.trim();
    if (!text || text.length > 50) continue;
    if ([...el.children].some(c => c.textContent?.trim())) continue;
    if (el.querySelector('button, vscode-button, [role="button"]')) continue;
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
// Windows named pipes aren't filesystem paths; derive one from the workspace hash.
const SOCKET = () => IS_WIN
  ? `\\\\.\\pipe\\wso2ipw-${path.basename(stateDir())}`
  : statePath('daemon.sock');
const PID_FILE = () => statePath('daemon.pid');
const ERR_LOG  = () => statePath('daemon.err');
const DAEMON_LOG = () => statePath('daemon.log');
// Written by daemon so clients can discover which cwd this dir belongs to.
const SESSION_FILE = () => statePath('session.json');

function killApp() {
  try {
    if (IS_WIN) execSync('taskkill /F /IM "WSO2 Integrator.exe"', { stdio: 'ignore' });
    else execSync('pkill -f "WSO2.*Electron"', { stdio: 'ignore' });
  } catch {}
}

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

  const extraArgs = (process.env.WSO2IPW_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean);
  const app = await electron.launch({
    executablePath: appPath,
    args: [`--user-data-dir=${userDataDir}`, ...extraArgs],
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

  // Click via mouse coordinates — bypasses actionability checks while
  // producing trusted pointer events (unlike Playwright's force option).
  // Translates element coords from a nested iframe to the top-level window.
  async function guestMouseClick(frame, locator, dblclick) {
    // Get element center in the guest frame's viewport
    const elBox = await locator.evaluate(el => {
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    // Walk up the frame chain, accumulating iframe offsets.
    // Each parent frame has an <iframe> whose src matches the child frame's url.
    let x = elBox.x, y = elBox.y;
    let f = frame;
    while (f !== mainFrame() && f.parentFrame()) {
      const parent = f.parentFrame();
      const childUrl = f.url();
      const offset = await parent.evaluate((url) => {
        for (const iframe of document.querySelectorAll('iframe')) {
          try {
            if (iframe.src === url || iframe.contentWindow?.location?.href === url) {
              const r = iframe.getBoundingClientRect();
              return { x: r.x, y: r.y };
            }
          } catch {}
        }
        // Fallback: find any webview iframe
        const iframe = document.querySelector('iframe');
        if (iframe) { const r = iframe.getBoundingClientRect(); return { x: r.x, y: r.y }; }
        return { x: 0, y: 0 };
      }, childUrl);
      x += offset.x;
      y += offset.y;
      f = parent;
    }
    const mouse = window.mouse;
    if (dblclick) {
      await mouse.dblclick(x, y);
    } else {
      await mouse.click(x, y);
    }
  }

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
  async function ensureWebviewFrame(timeoutMs = ACTION_TIMEOUT) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const f = webviewFrame();
      if (f) {
        try { if (await f.evaluate(() => document.querySelectorAll('button').length) > 0) return f; }
        catch {}
      }
      await window.waitForTimeout(POLL_MS);
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
      try { await frame.locator('body').waitFor({ timeout: SETTLE_MS }); }
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

  // Replace top-level role (document/application) with frame label.
  function relabelRoot(snap, label) {
    return snap.replace(/^- \w+/, `- ${label}`);
  }

  async function unifiedSnapshot() {
    const [guest, host, occluded] = await Promise.all([
      snapshotGuest().catch(() => null),
      snapshotHost(),
      isGuestOccluded(),
    ]);
    const sections = [];
    if (guest !== null && !occluded) sections.push(relabelRoot(prefixRefs(guest, 'g'), 'guest'));
    else if (guest !== null) sections.push('- guest: [occluded by host overlay]');
    sections.push(relabelRoot(prefixRefs(host, 'h'), 'host'));
    return sections.join('\n');
  }

  // ── Snapshot diff state ──
  let lastSnapshot = null;

  function snapshotWithDiff(current, noDiff) {
    if (noDiff || !lastSnapshot) { lastSnapshot = current; return current; }
    const diff = unifiedDiff(lastSnapshot, current);
    lastSnapshot = current;
    return diff ?? '(no changes)';
  }

  // After a mutation: brief settle, then snapshot.
  async function settledSnapshot(noDiff) {
    await window.waitForTimeout(SETTLE_MS);
    const snap = await unifiedSnapshot();
    return snapshotWithDiff(snap, noDiff);
  }

  // CM fields need longer settle for LSP validation (1-3s).
  async function cmSettledSnapshot(noDiff) {
    await window.waitForTimeout(SLOW_SETTLE_MS);
    const snap = await unifiedSnapshot();
    return snapshotWithDiff(snap, noDiff);
  }

  // Check for codicon-warning/error text near any CM editor in the frame.
  async function checkCmErrors(frame) {
    return frame.evaluate(() => {
      const icon = document.querySelector('.codicon-warning') || document.querySelector('.codicon-error');
      return icon?.parentElement?.textContent?.trim() || '';
    }).catch(() => '');
  }

  // ── Terminal read ──
  // xterm renders on <canvas>; must select-all + copy via keyboard.

  const readClip = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const writeClip = (t) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), t);
  const termMod = IS_WIN ? 'Control' : 'Meta';

  async function readTerminal(name) {
    // Ensure the Terminal tab is active (panel may show Debug Console, Output, etc.)
    const termTab = mainFrame().getByRole('tab', { name: /^Terminal/ });
    try { await termTab.click({ timeout: 1500, force: true }); } catch {}
    const termSel = '.terminal-wrapper > div > .terminal.xterm';
    const terminals = await mainFrame().locator(termSel).all();
    if (terminals.length === 0) throw new Error('No terminal found');
    let target;
    if (terminals.length === 1) {
      target = terminals[0];
    } else {
      if (!name) throw new Error(
        `Multiple terminals found (${terminals.length}). Specify terminal name, e.g.: wait-for-terminal <text> --terminal=<name>`);
      // Find tab whose text contains the name, click it to focus that terminal
      const tabList = mainFrame().getByRole('list', { name: 'Terminal tabs' }).getByRole('listitem');
      const tabs = await tabList.all();
      let found = false;
      for (const tab of tabs) {
        const label = await tab.innerText();
        if (label.toLowerCase().includes(name.toLowerCase())) {
          await tab.click({ timeout: ACTION_TIMEOUT, force: true });
          await window.waitForTimeout(200);
          found = true;
          break;
        }
      }
      if (!found) throw new Error(`Terminal "${name}" not found in tabs`);
      // After focusing, the active terminal is the visible one
      target = mainFrame().locator(`${termSel}:visible`).first();
    }
    const saved = await readClip();
    try {
      await target.click({ timeout: ACTION_TIMEOUT, force: true });
      await window.keyboard.press(`${termMod}+a`);
      await window.waitForTimeout(100);
      await window.keyboard.press(`${termMod}+c`);
      await window.waitForTimeout(100);
      const text = await readClip();
      await window.keyboard.press('Escape');
      return text.replace(/\n+$/, '');
    } finally {
      await writeClip(saved);
    }
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

      case 'snapshot': {
        const noDiff = args.includes('--no-diff');
        const snap = await unifiedSnapshot();
        return snapshotWithDiff(snap, noDiff);
      }

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
        if (!raw) throw new Error(`Usage: ${cmd} <g:|h:><target>`);
        const { frame: prefix, target } = parsePrefix(raw);
        const frame = frameFor(prefix);
        // Ensure pseudo ARIA roles are fresh before resolving locators,
        // since DOM re-renders may have stripped previously injected attrs.
        if (prefix === 'g') await injectPseudoElements(frame);
        const locator = resolveLocator(frame, target);
        if (prefix === 'g') {
          // Guest frame: click via mouse coordinates to get trusted pointer
          // events without actionability checks (overlays block non-forced
          // clicks, and force-clicks produce synthetic untrusted events).
          await guestMouseClick(frame, locator, cmd === 'dblclick');
        } else {
          const opts = { timeout: ACTION_TIMEOUT };
          if (cmd === 'dblclick') await locator.dblclick(opts);
          else await locator.click(opts);
        }
        const noDiff = args.includes('--no-diff');
        return `${cmd === 'dblclick' ? 'Double-clicked' : 'Clicked'}: ${raw}\n` + await settledSnapshot(noDiff);
      }

      case 'fill': {
        const raw = args[0];
        if (!raw || args.length < 2) throw new Error('Usage: fill <g:|h:><target> <text>');
        const { frame: prefix, target } = parsePrefix(raw);
        const frame = frameFor(prefix);
        if (prefix === 'g') await injectPseudoElements(frame);
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
          if (el.closest?.('.cm-editor') || el.classList?.contains('cm-content') || el.querySelector?.('.cm-editor')) return 'codemirror';
          return 'default';
        }).catch(() => 'default');

        if (inputType === 'shadow') {
          // Two sub-cases:
          //   a) Locator resolved to the HOST element (has shadowRoot) —
          //      fill the inner shadow <input>/<textarea> via evaluate.
          //   b) Locator resolved to the shadow <input> itself (ARIA pierced) —
          //      Playwright fill() works directly.
          const isHost = await locator.evaluate(el => !!el.shadowRoot);
          if (isHost) {
            await locator.evaluate((el, text) => {
              const input = el.shadowRoot.querySelector('input, textarea');
              if (!input) throw new Error('No input/textarea in shadow root');
              const nativeSetter = Object.getOwnPropertyDescriptor(
                input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
              )?.set;
              if (nativeSetter) nativeSetter.call(input, text);
              else input.value = text;
              input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }, text);
          } else {
            await locator.fill(text, { timeout: ACTION_TIMEOUT });
          }
          await locator.evaluate(el => {
            const host = el.getRootNode()?.host;
            el.blur();
            if (host) host.blur?.();
          }).catch(() => {});
        } else if (inputType === 'codemirror') {
          // CM6 ignores Playwright fill() and insertText — they set DOM but not
          // CM's internal state. keyboard.type() triggers autocomplete that
          // swallows chars. keyboard.press() misroutes after frame operations.
          // Solution: use CM6's view.dispatch() to replace the document directly.
          await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
          await locator.evaluate((el, text) => {
            const content = el.closest?.('.cm-editor')?.querySelector('.cm-content') ||
              (el.classList?.contains('cm-content') ? el : null) ||
              el.querySelector?.('.cm-editor')?.querySelector('.cm-content');
            const view = content?.cmView?.view;
            if (!view) throw new Error('CM view not found');
            view.focus();
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: text }
            });
            // Force CM6 to re-render (it skips repaint for off-screen editors)
            view.requestMeasure();
          }, text);
        } else {
          await locator.fill(text, { timeout: ACTION_TIMEOUT });
        }

        // For CM fields, wait longer before snapshot — LSP validation takes 1-3s.
        const noDiff = args.includes('--no-diff');
        const snap = inputType === 'codemirror'
          ? await cmSettledSnapshot(noDiff)
          : await settledSnapshot(noDiff);
        const cmErrors = inputType === 'codemirror' ? await checkCmErrors(frame) : '';
        if (cmErrors) log(`CM warning (non-fatal): ${cmErrors}`);
        return `Filled: ${raw}\n` + snap;
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
        const ms = parseInt(args[0]) || SLOW_SETTLE_MS;
        await window.waitForTimeout(ms);
        return `Waited ${ms}ms`;
      }

      case 'wait-for-text': {
        const text = args.find(a => !a.startsWith('-'));
        if (!text) throw new Error('Usage: wait-for-text <text> [--timeout=N] [--hidden]');
        const timeout = parseInt(parseFlag(args, 'timeout') ?? String(LONG_TIMEOUT));
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
            if (!guestHas && !hostHas) {
              const snap = await unifiedSnapshot();
              return `Text hidden: ${text}\n` + snapshotWithDiff(snap, args.includes('--no-diff'));
            }
            await window.waitForTimeout(POLL_MS);
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
          if (guestHas || hostHas) {
            const snap = await unifiedSnapshot();
            return `Text visible: ${text}\n` + snapshotWithDiff(snap, args.includes('--no-diff'));
          }
          await window.waitForTimeout(POLL_MS);
        }
        throw new Error(`Timeout waiting for text: ${text}`);
      }

      case 'terminal': {
        const termName = parseFlag(args, 'terminal') ?? args.find(a => !a.startsWith('-'));
        return await readTerminal(termName);
      }

      case 'wait-for-terminal': {
        const text = args.find(a => !a.startsWith('-'));
        if (!text) throw new Error('Usage: wait-for-terminal <text> [--timeout=N] [--terminal=<name>]');
        const termName = parseFlag(args, 'terminal');
        const timeout = parseInt(parseFlag(args, 'timeout') ?? String(TERM_TIMEOUT));
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          try {
            const content = await readTerminal(termName);
            if (content.includes(text)) return content;
          } catch (e) {
            // Terminal may not exist yet (e.g. just clicked Run Integration).
            // Retry until deadline.
            log(`wait-for-terminal: ${e.message}, retrying...`);
          }
          await window.waitForTimeout(TERM_POLL_MS);
        }
        throw new Error(`Timeout waiting for terminal text: ${text}`);
      }

      case 'close': {
        // Don't await app.close() — Electron may show save dialogs or
        // hang.  Kill the process tree after replying to the client.
        app.close().catch(() => {});
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
        if (cmd === 'close') {
          // Wait for the response to flush before exiting.
          socket.on('close', () => process.exit(0));
          // Safety: exit anyway after 2s if socket lingers.
          setTimeout(() => process.exit(0), SLOW_SETTLE_MS).unref();
        }
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
    if (!IS_WIN && !fs.existsSync(sock))
      return reject(new Error('App not running. Run: wso2ipw open'));
    const socket = net.createConnection(sock, () => {
      writeMessage(socket, { cmd, args, cwd: process.cwd() });
    });
    // For 'close', the daemon may exit before flushing the reply.
    // Treat a clean socket close as success.
    const isClose = cmd === 'close';
    readMessage(socket).then(res => {
      socket.destroy();
      res.ok ? resolve(res.result) : reject(new Error(res.error));
    }).catch(err => {
      if (isClose) resolve('Closed.');
      else reject(err);
    });
    socket.on('error', err => {
      if (isClose) resolve('Closed.');
      // readMessage will also reject; avoid double-call via .catch above
    });
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
    killApp();

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
    }, STARTUP_TIMEOUT);
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
  snapshot [--no-diff]           Aria tree of both frames (diff vs previous by default)
  click <g:|h:><ref>            Click element
  dblclick <g:|h:><ref>         Double-click element
  fill <g:|h:><ref> <text>      Fill input field
  type <text>                   Type via keyboard
  press <key>                   Press key (Enter, Tab, Meta+k, etc.)
  eval <g:|h:><js>              Evaluate JS in frame
  screenshot [file]             Save screenshot
  wait [ms]                     Sleep (default ${SLOW_SETTLE_MS}ms)
  wait-for-text <text>          Wait for text in either frame (--hidden for disappear)
  wait-for-terminal <text>      Wait for text in terminal buffer [--terminal=<name>]
  terminal [--terminal=<name>]  Read terminal buffer text (canvas-rendered, from memory)
  close                         Quit the app

Targeting (prefix required):
  g:s1e29                          guest aria-ref from snapshot
  h:s1e280                         host aria-ref from snapshot
  g:"#submit-btn"                  CSS selector in guest
  h:"getByRole('button', {name:'X'})" Playwright locator in host

Flags:
  --timeout=N           Timeout in ms (for wait-for-text, wait-for-terminal)
  --hidden              Wait for text to disappear from both frames
  --no-diff             Output full snapshot instead of diff against previous
  --user-data-dir=<p>   Persistent profile directory

Environment:
  WSO2_INTEGRATOR_PATH    Path to Electron binary (auto-detected if unset)
  WSO2IPW_ELECTRON_ARGS   Extra args for Electron (e.g. --no-sandbox for CI)`);

} else if (cmd === 'open') {
  const pid = isDaemonRunning();
  if (pid) {
    try {
      await sendCommand('wait', ['0']);
      console.log(`Already running (PID: ${pid}). Log: ${DAEMON_LOG()}`);
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      killApp();
      try { fs.unlinkSync(SOCKET()); } catch {}
      try { fs.unlinkSync(PID_FILE()); } catch {}
      await new Promise(r => setTimeout(r, SLOW_SETTLE_MS));
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
