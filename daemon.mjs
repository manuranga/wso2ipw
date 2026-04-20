#!/usr/bin/env node
import fs   from 'fs';
import http from 'http';
import os   from 'os';
import path from 'path';
import vm   from 'vm';

const dir = process.env.WSO2I_STATE_DIR;
fs.mkdirSync(dir, { recursive: true });

const log = msg => fs.appendFileSync(path.join(dir, 'daemon.log'),
  `[${new Date().toISOString().slice(11, 23)}] ${msg}\n`);

const { _electron: electron } = await import('playwright');
const appPath    = findApp();
const userDataDir = process.env.WSO2I_USER_DATA_DIR
                 || fs.mkdtempSync(path.join(os.tmpdir(), 'wso2ipw-'));

log(`launching ${appPath}`);
const app    = await electron.launch({ executablePath: appPath, args: [`--user-data-dir=${userDataDir}`, ...process.argv.slice(2)] });
const window = await app.firstWindow();
await window.waitForLoadState('domcontentloaded');
log('window ready');

const ctx = vm.createContext({ app, window, electron, fs });

// ── Serial request queue ──────────────────────────────────────────────────
let tail = Promise.resolve();

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const preview = body.trim().slice(0, 80).replace(/\n/g, ' ');
    const run = () => {
      log(`run: ${preview}`);
      ctx.console = { log: (...a) => res.write(a.map(String).join(' ') + '\n') };
      const wrapped = `(async () => { return (${body}) })()`;
      let code;
      try { new vm.Script(wrapped); code = wrapped; }
      catch { code = `(async () => { ${body} })()`; }
      const r = vm.runInContext(code, ctx);
      return r instanceof Promise ? r : Promise.resolve(r);
    };
    const next = tail.then(run);
    tail = next.then(() => {}, () => {});
    next.then(
      r => {
        if (r instanceof Buffer || r instanceof Uint8Array) {
          const msg = 'Binary result — use { path: "..." } to write to disk';
          log(`err: ${msg}`); res.end(msg + '\n'); return;
        }
        log(`ok:  ${preview}`);
        const out = typeof r === 'string' ? r : JSON.stringify(r) ?? '';
        if (out) res.write(out);
        res.end();
      },
      e => { log(`err: ${e.message}`); res.end((e.stack ?? e.message) + '\n'); },
    );
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(
    { pid: process.pid, port, userDataDir, cwd: process.env.WSO2I_ORIG_CWD }, null, 2));
  log(`ready on :${port}`);
  process.stdout.write('ready\n');
});

app.on('close', () => { log('electron closed'); process.exit(0); });
process.on('SIGTERM', () => { app.close().catch(() => {}); process.exit(0); });

// ─────────────────────────────────────────────────────────────────────────────

function findApp() {
  if (process.env.WSO2_INTEGRATOR_PATH) return process.env.WSO2_INTEGRATOR_PATH;
  const candidates = process.platform === 'win32' ? [
    path.join(process.env.APPDATA    || '', 'WSO2', 'Integrator', 'WSO2 Integrator.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WSO2 Integrator', 'WSO2 Integrator.exe'),
  ] : [
    path.join(os.homedir(), 'Applications/WSO2 Integrator.app/Contents/MacOS/Electron'),
    '/Applications/WSO2 Integrator.app/Contents/MacOS/Electron',
    '/usr/share/wso2-integrator/wso2-integrator',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('WSO2 Integrator not found. Set WSO2_INTEGRATOR_PATH.');
}
