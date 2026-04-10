# wso2integrator-cli

CLI to automate [WSO2 Integrator](https://wso2.com/integrator/) via [Playwright](https://playwright.dev/).

Built on Playwright's `_electron.launch()` — full access to the app's UI including VS Code webviews, with element refs for reliable interaction.

## Install

```bash
npm install -g wso2integrator-cli
```

WSO2 Integrator must be installed. The CLI auto-detects it at standard locations, or set `WSO2_INTEGRATOR_PATH`.

## Quick start

```bash
# Launch (fresh profile each time by default)
wso2integrator-cli open

# See what's on screen
wso2integrator-cli snapshot

# Interact using refs from the snapshot
wso2integrator-cli click s1e29 --force
wso2integrator-cli fill s2e33 "my-integration"

# Screenshot
wso2integrator-cli screenshot page.png

# Done
wso2integrator-cli close
```

## Commands

| Command                             | Description                                |
| ----------------------------------- | ------------------------------------------ |
| `open [--user-data-dir=p]`          | Launch app. Fresh temp profile by default. |
| `snapshot [--main]`                 | Aria tree with element refs                |
| `click <ref> [--force] [--main]`    | Click element                              |
| `dblclick <ref> [--force] [--main]` | Double-click element                       |
| `fill <ref> <text> [--main]`        | Fill input field                           |
| `type <text>`                       | Type via keyboard                          |
| `press <key>`                       | Press key (Enter, Tab, Meta+k, etc.)       |
| `eval <js> [--main]`                | Evaluate JS in frame                       |
| `screenshot [file]`                 | Save screenshot                            |
| `wait [ms]`                         | Wait (default 2000ms)                      |
| `close`                             | Quit the app                               |

### Flags

- **`--main`** — Target VS Code chrome (sidebar, toolbar, status bar) instead of the webview
- **`--force`** — Bypass overlay/pointer-event checks (needed for most webview buttons)
- **`--user-data-dir=<path>`** — Persist state across runs (omit for fresh profile each time)

## Architecture

```
wso2integrator-cli open
        │
        ├─ spawns detached daemon process
        │       │
        │       ├─ Playwright _electron.launch()
        │       │       → full frame access including webviews
        │       │
        │       └─ listens on Unix socket (~/.wso2integrator-cli/daemon.sock)
        │
        └─ returns when daemon signals "ready"

wso2integrator-cli <command>
        │
        └─ connects to daemon socket → sends command → prints result
```

Two frames:

- **webview** (default) — WSO2 extension UI: landing page, design canvas, forms
- **main** (`--main`) — VS Code chrome: sidebar tree, toolbar, terminal, status bar

## Examples

See [`examples/`](examples/) for full end-to-end test scripts.

## License

Apache-2.0
