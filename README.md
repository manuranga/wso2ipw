# wso2ipw

CLI to automate WSO2 Integrator, wrapper around Playwright.

## Install

```bash
npm install -g wso2ipw
```

WSO2 Integrator must be installed separately.

## Usage

```bash
wso2ipw open
wso2ipw snapshot
wso2ipw click g:s1e29
wso2ipw fill g:s2e33 "my-integration"
wso2ipw screenshot page.png
wso2ipw close
```

Refs require a frame prefix: `g:` (guest — extension webview) or `h:` (host — VS Code chrome).

See [`examples/`](examples/) for end-to-end scripts.

## License

Apache-2.0
