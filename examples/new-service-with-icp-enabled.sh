#!/bin/bash
#
# End-to-end test: Create a new HTTP service integration with ICP enabled.
#
# Flow:
#   1. Open WSO2 Integrator
#   2. Create a new integration with a unique Project ID
#   3. Add an HTTP Service with a GET /greeting resource
#   4. Run the integration, verify it starts
#   5. Stop, enable ICP for all integrations from project overview
#   6. Start ICP server, re-run, verify ICP heartbeat
#
set -euo pipefail

pw() { wso2ipw "$@"; }

# Extract an aria-ref matching a label substring.
ref() { echo "$1" | grep -F "$2" | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1; }

step() { echo ""; echo "═══ $1 ═══"; }
fail() { echo "FAIL: $1" >&2; pw close 2>/dev/null; exit 1; }

PROJ_ID="icptest$(date +%s)"

# Kill any old ICP server holding port 9450
lsof -ti :9450 2>/dev/null | xargs kill -9 2>/dev/null || true

# ── 1. Open ──────────────────────────────────────────────────────────────────

step "1. Launch app"
pw open

# Handle sign-in dialog (appears in main frame)
snap=$(pw wait-for-text "Skip for now" --timeout=15000 2>/dev/null || true)
r=$(ref "$snap" 'Skip for now') || true
if [ -n "$r" ]; then
  pw click "$r" > /dev/null
  echo "  Skipped sign-in"
fi

# Wait for webview landing page
snap=$(pw wait-for-text "Create" --timeout=15000)
echo "  App ready"

# ── 2. Create Integration ────────────────────────────────────────────────────

step "2. Create integration: hello-icp (project: $PROJ_ID)"

snap=$(pw click "$(ref "$snap" 'button "Create"')")

pw fill "$(ref "$snap" 'textbox "Integration Name')" hello-icp > /dev/null
snap=$(pw snapshot)
pw fill "$(ref "$snap" 'textbox "Project Name')" "ICP Test Project" > /dev/null
snap=$(pw snapshot)
pw fill "$(ref "$snap" 'textbox "Project ID"')" "$PROJ_ID" > /dev/null

snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'button "Create Integration"')")
echo "$snap" | grep -q "Integrations & Libraries" || fail "Project overview not reached"
echo "✓ Project created"

# ── 3. Add HTTP Service with GET /greeting ───────────────────────────────────

step "3. Add HTTP Service with GET /greeting"

# Enter integration → Add Artifact → HTTP Service → Create
snap=$(pw wait-for-text "hello-icp" --timeout=15000)
snap=$(pw click "$(ref "$snap" 'hello-icp')")
snap=$(pw wait-for-text "Add Artifact" --timeout=10000)
snap=$(pw click "$(ref "$snap" 'Add Artifact')")
snap=$(pw wait-for-text "HTTP Service" --timeout=10000)
snap=$(pw click "$(ref "$snap" 'HTTP Service')")
snap=$(pw wait-for-text "Base Path" --timeout=15000)
snap=$(pw click "$(ref "$snap" 'button "Create"')")

# Wait for design canvas to load, then add resource
snap=$(pw wait-for-text "Add Resource" --timeout=15000)
pw click "$(ref "$snap" 'Add Resource')" > /dev/null

# Wait for method selector, then click GET
snap=$(pw wait-for-text "GET" --timeout=10000)
pw click "g:text=GET" > /dev/null

# Wait for resource path field, then fill it
snap=$(pw wait-for-text "Resource Path" --timeout=10000)
r=$(ref "$snap" 'textbox "Resource Path')
[ -z "$r" ] && fail "Resource Path field not found"
pw fill "$r" greeting > /dev/null
pw press Tab > /dev/null  # blur triggers onBlur validation, enabling Save

snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'button "Save"')")
echo "$snap" | grep -q "greeting" || fail "GET /greeting not created"
echo "✓ HTTP Service with GET /greeting created"

# ── 4. Run the integration ───────────────────────────────────────────────────

step "4. Run integration"
snap=$(pw snapshot)
pw click "$(ref "$snap" 'button "Run Integration"')" > /dev/null

echo "  Waiting for Ballerina to compile and start..."
for i in $(seq 1 18); do
  sleep 5
  if code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/greeting 2>/dev/null) && [ "$code" = "202" ]; then
    echo "✓ Integration running (HTTP $code)"; break
  fi
  [ "$i" -eq 18 ] && fail "GET /greeting did not return 202 within 90s"
done

# ── 5. Stop, enable ICP from project overview ────────────────────────────────

step "5. Enable ICP"

snap=$(pw snapshot)
pw click "$(ref "$snap" 'button "Stop')" > /dev/null

# Wait for active debug session to end (tab label loses "active session")
pw wait-for-text "active session" --hidden --timeout=15000 > /dev/null

snap=$(pw snapshot)
pw click "$(ref "$snap" 'Show Overview')" > /dev/null

# Wait for project overview to load in webview
snap=$(pw wait-for-text "Enable ICP" --timeout=15000)
pw click "$(ref "$snap" 'Enable ICP for all integrations')" > /dev/null

snap=$(pw wait-for-text "1/1 integrations are ICP-enabled" --timeout=15000)
echo "✓ ICP enabled"

# ── 6. Start ICP server, re-run, verify heartbeat ───────────────────────────

step "6. ICP server + re-run"

snap=$(pw snapshot)
pw click "$(ref "$snap" 'ICP: Stopped')" > /dev/null

echo "  Waiting for ICP server..."
snap=$(pw wait-for-text "ICP: Running" --timeout=30000)
echo "✓ ICP server running"

# Navigate to integration and run
snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'hello-icp')")
snap=$(pw snapshot)
r=$(echo "$snap" | grep 'Run' | grep -E 'Icon Button|button' | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1)
[ -z "$r" ] && fail "Run button not found"
pw click "$r" > /dev/null

echo "  Waiting for integration to start with ICP..."
for i in $(seq 1 18); do
  sleep 5
  if code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/greeting 2>/dev/null) && [ "$code" = "202" ]; then
    echo "✓ Integration running with ICP (HTTP $code)"; break
  fi
  [ "$i" -eq 18 ] && fail "GET /greeting did not return 202 with ICP within 90s"
done

pw screenshot icp-final.png > /dev/null
snap=$(pw snapshot)
echo "$snap" | grep -q "ICP: Running" || fail "ICP not running after re-run"
echo "✓ ICP heartbeat verified"

echo ""
echo "════════════════════════════════════════════"
echo "  ALL STEPS PASSED ✓"
echo "  Project: $PROJ_ID"
echo "  Screenshot: icp-final.png"
echo "════════════════════════════════════════════"

# Cleanup
snap=$(pw snapshot 2>/dev/null || true)
r=$(ref "$snap" 'button "Stop') || true
[ -n "$r" ] && pw click "$r" > /dev/null 2>&1 || true
#pw close 2>/dev/null || true
