# WSO2 Integrator Gotchas

## Sign-in / Launch
- On fresh launch, the sign-in/skip dialog is in the host frame. Its refs appear under `- host:` in `snapshot` output (e.g. `h:s1eN`).
- A fresh launch does not reopen the previous project. The files remain on disk but must be reopened explicitly.
- Using a persistent profile path preserves session state across restarts — skips sign-in and reopens the last project.

## Project Creation
- If a project directory already exists at the target path, creation fails with "A directory with this name already exists at the selected location". Use a unique project name.

## HTTP Service / Resource Creation
- HTTP methods (GET, POST, PUT, DELETE, PATCH, DEFAULT) in the "Select HTTP Method to Add" panel are now tagged as buttons by pseudo-element injection. Target them with their snapshot refs (e.g. `g:s1eN` for `button "GET"`) like any other button.
- The **Resource Path** field uses client-side validation that only triggers on keyboard input events. Programmatic `fill` (or `setValue`) sets the value but does not fire the change/input events the framework listens to, leaving a "path cannot be empty" validation error and the Save button disabled. Simulating key-by-key input works.

## Flow Editor
- The "+" (add node) button between Start and Error Handler is an SVG element not present in the accessibility/aria tree. It has `data-testid="empty-node-add-button-1"` and must be interacted with via DOM APIs (e.g. `eval 'g:document.querySelector("[data-testid=empty-node-add-button-1]")?.dispatchEvent(new MouseEvent("click", {bubbles:true}))'`). Note: the SVG element's `.click()` method does not exist — use `dispatchEvent` instead.
- The flow diagram nodes (Return, etc.) are also not in the accessibility tree. They can be found via DOM queries (e.g. CSS class or text content) but not via ARIA snapshots.
- The node palette's "Return" item (under Control) may be outside the viewport depending on window size. It needs to be scrolled into view before clicking.
- The node palette search filters items but returns no results for "Respond" — use "Return" from the Control section for HTTP responses.
- After saving a resource, the flow editor may need a moment to fully render the SVG canvas. Wait for "Error Handler" text to appear before interacting with the "+" add-node button.

## Return Node Expression
- The Return node's expression field is a code editor, not a plain input. It may retain previous values when reopened. Always select-all and delete before typing a new value to avoid appending.
- When re-editing a Return node, clicking the expression field opens a Helper Panel (Inputs, Variables, Configurables, Functions). The panel can be closed via "Close Helper Panel".

## External File Edits — Do Not Do This
- **Do not edit `.bal` files manually while the UI is open.**

## Running / Debugging
- The default HTTP listener (`httpDefaultListener`) serves on `http://localhost:9090` (HTTP, not HTTPS).
- The "Run Integration" button is in the host frame — its ref will be `h:s1eN`. Click it with `click h:<ref>`. Terminal output and run controls (pause, stop, restart) are also in the host frame.
- Both "Run" and "Run Integration" buttons start the integration in **debug mode** (status bar shows "Ballerina Debug"). There is no plain "run without debugging" option visible in the default UI.
- Ballerina/JVM startup is slow. The terminal shows "Running executable" with a spinner for 30+ seconds before the HTTP listener is ready.
- While starting, the HTTP listener accepts TCP connections and returns `202 Accepted` with an empty body before the service is fully registered. This can persist for a long time and is easily mistaken for a working but broken service. Wait for terminal output confirming the listener has started.
- When a resource function's `do` block is empty (e.g. no Return expression), the function returns `()` (nil), and Ballerina maps this to `202 Accepted` with no body — no error is surfaced.

## HTTP Proxy / Client Connection
- To call an external HTTP service, first create a **Connection** (not a flow node). In the node palette, click "Add Connection" → search for "HTTP" → select "HTTP" / "ballerina / http". Fill the URL, then Save Connection.
- The URL code-editor field adds its own string quoting. Do not wrap the value in quotes yourself or it will be double-quoted in the generated code.
- After saving, `httpClient` appears under "Connections" in the palette. Clicking it reveals HTTP methods (Get, Post, Put, Delete, etc.).
- The **httpClient→get** palette node stores its result variable (`var1`) inside the `do` block. A Return node added afterward lands **outside** the `do` block, so `var1` is out of scope (`undefined symbol 'var1'`). Workaround: skip the httpClient→get node entirely and put the full call directly in the Return expression: `check httpClient->get("/path", targetType = json)`.
- The **Target Type** code-editor field has aggressive autocomplete. After clearing and typing a value like `json`, an autocomplete dropdown appears. You must explicitly select the correct suggestion from the dropdown; pressing Escape or Tab often commits the wrong one (e.g., a long service type signature instead of `json`).
- After saving a Connection, the palette remains open with "Select node from node panel" active. However, the insertion-point context may be stale. If clicking a palette item does nothing, re-click the "+" add-node button first, then retry.

## Node Palette Clicks
- Palette items (Return, If, etc.) are React components. The visible label div (CSS class `css-lbgul4`) does not respond to standard click events. You must target the **parent** wrapper div and dispatch the full pointer event sequence: `pointerdown` → `pointerup` → `click` (all with `{bubbles: true}`).
- The palette search/filter text box does not respond to any form of programmatic input — not `fill`, not keystroke simulation, not synthetic `input`/`change` events. It only works with real user keyboard input.

## Project Overview Navigation
- After "Create Integration", the project overview shows the integration name in both the breadcrumb trail and as a clickable card/paragraph. When locating the card to click into the integration, be careful not to match the breadcrumb text instead — the breadcrumb appears earlier in the DOM/accessibility tree.

## Resource Configuration (Payload / Parameters)
- A POST resource function is generated without parameters by default: `resource function post route()`. The request body is **not** accessible unless you explicitly add a payload parameter.
- To add a payload parameter: in the flow editor, click **Configure** → **Define Payload** → **Continue with JSON Type** → **Save**. This generates `resource function post route(@http:Payload json payload)`.
- The Configure button only works when the side panel (node palette/form) is **not** blocking it. Close any open node form first (see "Closing Node Forms" below).
- After configuring, the `payload` variable appears in the Helper Panel's **Inputs** section inside expression editors.

## If Node
- The If node form has: Condition (boolean textbox), "Add Else IF Block", "Add Else Block", and Save.
- **The If node only creates a then-branch by default.** You must click "Add Else Block" in the form before saving to get an `if {} else {}` structure. Otherwise only `if {}` is generated.
- After saving an If node with an else block, the flow shows multiple add-buttons: `empty-node-add-button-2` (then-branch body) and `empty-node-add-button-3` (else-branch body). The `link-add-button-*` buttons insert between nodes, not inside branches.
- **Ballerina reserved words cannot be used as JSON field names** in dot-access expressions. For example, `payload.type` fails because `type` is a keyword. Use `payload.kind`, `payload.category`, etc. instead. Alternatively, use indexed access: `payload["type"]`.

## Expression Editor — Autocomplete Issues
- All code-editor fields (condition, expression, type, etc.) have **aggressive autocomplete** that can corrupt programmatic input.
- When typing multi-token expressions like `payload.kind == "order"`, the autocomplete may fire after the dot and insert an unwanted suggestion, causing subsequent tokens to be rejected as "invalid token".
- Typing the entire expression at once (without pauses between tokens) is more reliable than typing token-by-token with pauses.
- Pressing Escape after typing dismisses the autocomplete dropdown.
- As a last resort, use `true` as the condition and fix the generated `.bal` file directly (if the UI is not open, or after closing the side panel).

## Closing Node Forms
- Each node form (If, Return, Declare Variable, etc.) has a small icon button between the title text and the first field. Clicking this icon **closes** the form and dismisses the side panel.
- This is the **only reliable way** to dismiss a stuck palette/panel state. Pressing Escape, clicking the canvas, or clicking breadcrumbs does not dismiss it.
- After closing a form, the flow editor returns to its normal state with the SVG "+" add-buttons visible again.

## Connection — Creating Multiple Connections
- After saving the first connection, the palette enters "Select node from node panel" mode. The "Add Connection" link becomes **hidden** (CSS `visibility: hidden`, `opacity: 0`).
- The SVG "+" add-buttons disappear while the palette is in this state.
- You **cannot** create a second connection via the palette in this state. No combination of clicking, Escape, or DOM manipulation reliably reopens the "Add Connection" panel.
- **Workaround**: open a node form (e.g., click "If" from palette) and then close it via the icon button. This resets the panel state and makes the "+" buttons reappear. Then click "+" → "Add Connection" for the second connection.
- Alternatively, design integrations that use a **single connection** with different paths, avoiding the need for multiple connections.
- The **Connection Name** field (default "httpClient") can be changed to a custom name. After modifying it, re-take a snapshot since refs go stale.

## File Picker
- The "Open" button (Open Integration) triggers a native OS file picker dialog. This dialog is outside the Electron/Chromium rendering pipeline and cannot be automated via browser-level APIs.

## ICP Server — Embedded Instance
- The embedded ICP server ships inside the WSO2 Integrator app bundle. On macOS the path is: `<app>/Contents/components/icp/` (e.g. `~/Applications/WSO2 Integrator.app/Contents/components/icp/`).
- The path contains spaces ("WSO2 Integrator.app"). Always quote it. Naive path extraction from `ps` output (splitting on spaces) breaks.
- To discover the ICP home at runtime: get the PID from port 9450 (`lsof -ti :9450`), then extract the jar path from `ps -p <PID> -o command=` using a pattern match for `icp-server.jar`. The ICP home is two directories above the jar.
- `deployment.toml` lives at `<ICP_HOME>/conf/deployment.toml`.
- Toggling ICP on/off in the status bar sometimes has a delay before the status text updates. A short sleep (2–3s) before checking the new status avoids race conditions. The ICP toggle button is in the host frame (`h:` ref).

## ICP Log Monitoring (Fluent Bit + OpenSearch)
- Log monitoring is **not configurable through the Integrator UI**. It requires manual setup: OpenSearch, Fluent Bit, and edits to both the ICP `deployment.toml` and the BI app's `Config.toml`.
- The BI project directory lives at `~/wso2integrator/projects/<project-id>/`. The Ballerina package (containing `Config.toml`) is a subdirectory named after the integration (underscored, e.g. `hello_logs/`).
- `Config.toml` needs three additions for log output: `[ballerina.log] format = "logfmt"`, `[[ballerina.log.destinations]] path = "logs/<app>/app.log"`, and `[ballerina.observe] metricsLogsEnabled = true`.
- The log file path in `Config.toml` is relative to the Ballerina package directory (where `Ballerina.toml` is), not the workspace root.
- Homebrew OpenSearch has no security plugin — use `http://` not `https://`. ICP requires non-empty credentials even when OpenSearch ignores them; use placeholder values like `"ignored"`.
- After editing `deployment.toml`, ICP must be restarted (stop then start via the status bar button) for changes to take effect.
- **TOML section scoping trap**: The `opensearchUrl`, `opensearchUsername`, `opensearchPassword` keys must be **top-level** (before any `[section]` header). The default `deployment.toml` has a commented-out OPENSEARCH section positioned after `[ballerina.http.traceLogAdvancedConfig]`. Uncommenting those lines places them under that section, causing `undefined field 'opensearchUrl' provided for closed record 'http:TraceLogAdvancedConfiguration'`. Move them above the first `[section]` header in the file.
- Fluent Bit must run from its config directory so relative paths (`db/`, `buffer/`) resolve correctly.
- The `$logger` and `$module` references in Fluent Bit rewrite_tag rules must be escaped (`\$`) in shell heredocs to prevent variable expansion.
