# wso2ipw

CLI to automate WSO2 Integrator via Playwright.


### WSO2 Integrator

WSO2 Integrator is a visual integration development tool. It lets you build integration services such as HTTP APIs, proxies,.

- WSO2 Integrator is a fork of VS Code with an extension installed. Extension has webview UI (guest frame) alongside VS Code's native chrome (host frame)
- Visual flow editor — Users design service logic by adding nodes (Return, If, etc.) to an SVG-based flow diagram, connecting them visually
- Code generation — Behind the scenes it generates Ballerina (.bal) source code from the visual flow
- Connectors — Supports HTTP connections and others via a connector palette
- Integrated run/debug — Has "Run Integration" that compiles and runs the Ballerina project, starting an HTTP listener (default on localhost:9090)
- Embedded version of WSO2 ICP (Integration Control Plane) is included. Enable it and run an integration to monitor it.

## Install

```bash
npm install -g wso2ipw
```

WSO2 Integrator must be installed.

## Quick start

```bash
wso2ipw open
wso2ipw snapshot
wso2ipw click g:s1e29
wso2ipw fill g:s2e33 "my-integration"
wso2ipw screenshot page.png
wso2ipw close
```

## Prefix

Two frames (unified in snapshot output, disambiguated by `g:`/`h:` ref prefix):
Required for all ref-targeting commands

- g: guest/extension webview, WSO2 extension UI: landing page, design canvas, forms
- h: host/VS Code chrome, sidebar tree, toolbar, terminal, status bar

## Commands

- app: open [--user-data-dir=path], close
- inspect: snapshot, screenshot [file], eval <g:|h:><js>
- interact: click/dblclick <g:|h:><ref> [--force], fill <g:|h:><ref> <text>
- keys: type <text>, press <key>
- util: wait [ms], wait-for-text <text> [--timeout=N] [--hidden]
- flags: --force (bypass overlay/pointer-event checks, default for g:)

## Architecture

- open    spawn daemon → Playwright Electron → listen on Unix socket → signal ready
- <cmd>   connect to socket → send command → print result

## Examples

See [`examples/`](examples/) for full end-to-end test scripts.
