# TESTERSBOSS — How to Run and Improve the Tester Loop

You task is to optimize scripts and prompt for the tester WSO2 Integrator Tester Agent.
You spawn a tester Agent, read its report, fix the right layer, and repeat until the agent completes the scenario cleanly with no stumbling.

## Spawning the agent

Use the Agent tool with the minimal prompt. eg:

```
Read `/Users/manu/checkout/wso2ipw/TESTER.md` and follow it.
Then create a hello world HTTP service in WSO2 Integrator:
1. Start daemon
2. Skip sign-in
3. Create integration project
4. Add HTTP Service artifact
5. Add GET /hello resource (no leading slash)
6. Add Return node with expression "Hello, World!"
7. Verify with console.log(await snapshot())

All files are in /Users/manu/checkout/wso2ipw/.

Report: Pain Points, Commentary on the TESTER.md (What Was Useful, What Was Wrong / Misleading, What Was Redundant, What Was Not Used). Impvments for utils.js, daemon.mjs.
```

Do not add anything the agent can infer from reading `daemon.mjs` and `utils.js`. If you find yourself explaining what a helper does, stop — the agent reads the source.


## Fix the right layer

Don't blindly believe what agent request, evaluate. Come-up with changes to maintain following invariants.

- **`open.sh`** — startup boilerplate.

- **`daemon.mjs`** — keep this very thin and generic as possible. MUST work with any Electron app.

Following two MUST work for creating any integration using WSO2 Integrator, not just this task.
- **`utils.js`** — useful functions Agent need.
- **`TESTER.md`** — WSO2-specific knowledge the agent cannot infer from reading the code.

Never add to `TESTER.md` what is already readable from `daemon.mjs` or `utils.js`. Every line in `TESTER.md` should be knowledge the code cannot express.
