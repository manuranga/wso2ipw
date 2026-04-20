# Why reading a specific terminal is hard

## What we need

`wso2ipw terminal --terminal="Ballerina Run"` must read the text content of a
named terminal when multiple terminals are open (e.g. ICP Server + Ballerina Run).

## The approach: clipboard round-trip

Terminal content in VS Code is rendered on a `<canvas>` by xterm.js — there is no
DOM text to read. The current approach:

1. Click the xterm element to focus it
2. Cmd+A (select all), Cmd+C (copy to clipboard)
3. Read clipboard
4. Escape (deselect)

This works fine for a single terminal.

## Why multiple terminals break it

### Problem 1: Only one xterm widget exists at a time

VS Code lazily creates/destroys xterm DOM elements. Only the focused terminal has
a live xterm widget. Unfocused terminals have no DOM presence — or leave behind
stale zero-sized elements. You cannot enumerate terminals by counting xterm nodes.

This means the selector `.terminal-wrapper > div > .terminal.xterm` may return:
- Zero elements (terminal panel collapsed)
- One element (the currently focused terminal — could be any of N)
- Multiple elements, but stale ones with 0×0 dimensions from crashed/closed terminals

### Problem 2: Clicking a terminal tab can destroy it

VS Code's terminal tabs are not simple focus-switchers. For task-backed terminals
(like "Ballerina Run"), clicking the tab can trigger a task restart attempt. If the
task definition is stale or unresolvable, VS Code shows:

> "Task Ballerina Run no longer exists or has been modified. Cannot restart."

...and **destroys the terminal entirely**. This makes tab-clicking an unsafe
mechanism for reading terminal content.

### Problem 3: The xterm widget is reused

When you do successfully switch terminals (without destroying them), VS Code reuses
the same xterm DOM element and rebinds it to a different terminal backend
asynchronously. There is no reliable DOM signal that the swap completed. A fixed
`waitForTimeout()` is a race condition.

### Problem 4: Keyboard shortcuts target the focused terminal

Cmd+A / Cmd+C go to whichever terminal VS Code considers focused — which is
determined by internal state, not by which xterm element Playwright clicked. After
a tab click, there's a window where keyboard input still goes to the previous
terminal.

## Approaches considered

### A. Tab index → xterm widget index
Click the Nth tab, read the Nth xterm widget. Fails because widget count ≠ tab
count (lazy creation, stale elements).

### B. `.terminal-wrapper.active` selector
Use the VS Code `.active` class to find the focused terminal's xterm. Fails because
there's only ever one `.active` wrapper, and it doesn't change identity on tab
switch — VS Code rebinds its backend in-place.

### C. `:visible` + `.first()`
The original approach. Fails because multiple xterm elements can be `:visible`
(Playwright's definition is generous), and `.first()` returns DOM order, not
focus order.

### D. Wait longer after tab click
Increase `waitForTimeout` to let VS Code finish swapping. Unreliable race
condition, and doesn't solve Problem 2 (tab click destroying task terminals).

## What would actually work

### E. Inject a VS Code extension at startup

VS Code extensions have access to the `vscode.window.terminals` API, which provides:

- List of all terminals by name
- Direct access to terminal buffer content (via `Terminal.shellIntegration` or
  by sending commands)
- Ability to focus a terminal without triggering task restart
- No dependency on DOM structure, xterm lifecycle, or clipboard

The extension would expose a simple IPC endpoint (e.g. respond to a command) that
returns the text content of a named terminal. `readTerminal()` would call this
instead of the clipboard round-trip.

This is the only approach that avoids all four problems simultaneously.
