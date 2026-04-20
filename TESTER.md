# WSO2 Integrator Tester Guide

## Setup

### 1. Read the code first
Before doing anything, read:
- `daemon.mjs` — eval context, how requests work
- `utils.js` — all available helpers

### 2. Start the daemon
```bash
bash open.sh
```
Kills any existing instance, starts fresh, prints `session.json` with the port when ready.
Pass extra Electron args if needed (e.g. to open a folder):
```bash
bash open.sh /path/to/project
```

### 3. Load utils
```bash
curl -s --max-time 10 -X POST http://127.0.0.1:<PORT> --data-binary @utils.js
```
Post more functions/replace directly if you need later

## Sending code
```bash
curl -s --max-time <N> -X POST http://127.0.0.1:<PORT> --data-binary @- <<'EOF'
// JS here
EOF
```
Use `--max-time 30` for navigation steps, `--max-time 10` for simple interactions.

## Critical rules

**Clicks**: always use `guestClick(locator)` inside the guest frame, never `.click()`. The webview requires trusted mouse-coordinate events.

**After every navigation**: call `await waitForGuest()` — the webview tears down and recreates on each page transition. A stale frame and a wrong locator look identical (both timeout silently after 30s).

**Screenshots**: write to disk, never return binary from eval:
```js
await window.screenshot({ path: '/tmp/wso2.png' })
// then read /tmp/wso2.png from filesystem
```
Prefer `console.log(await snapshot())` — instant, no file needed.

**`snapshot()` is guest-only**: host frame overlays (sign-in dialog, modals) are invisible to it. If clicks don't respond, check for host overlays:
```js
console.log(await window.frames()[0].locator("body").ariaSnapshot())
```

## Locating elements

WSO2 Integrator has three distinct interactive element types — each needs a different locator:

| Element | Use |
|---------|-----|
| Toolbar/form buttons | `guestFrame.locator('vscode-button').filter({hasText: '...'})` |
| Node panel items, method options (GET, POST, Return…) | `guestFrame.getByText('...', {exact: true}).first()` |
| Text inputs | `guestFrame.getByRole('textbox', {name: /label/})` |

`locator('button')` and `getByRole('button')` match nothing in WSO2 — do not use them.

## Input fields

- **Shadow DOM inputs** (`vscode-text-field`): use `guestFill(locator, text)`
- **CodeMirror editors**: use `cmFill(text)` — do NOT call `guestClick` before it

## Known specifics

- **Sign-in screen**: skip via host frame — `await window.frames()[0].getByRole("button", {name: "Skip for now"}).click()`
- **Resource path**: no leading slash — `hello` not `/hello`
- **Add-node buttons** are `display:none` until hover — target by data-testid:
  ```js
  guestFrame.locator('[data-testid="empty-node-add-button-1"]').locator("..")
  ```
- **After saving a flow node** the canvas lags — call `await window.waitForTimeout(2000)` before the next `snapshot()` to see the saved state
- **Project names**: use a timestamp suffix to avoid directory conflicts — e.g. `` `Hello${Date.now()}` ``
- **Never edit generated source files directly** — only interact through the UI
