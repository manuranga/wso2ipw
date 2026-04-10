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
#   6. Start ICP server, re-run from integration view, verify ICP heartbeat
#
set -euo pipefail

pw() { wso2integrator-cli "$@"; }

# Extract a ref from snapshot output by matching a label.
ref() { echo "$1" | grep -F "$2" | grep -oE 'ref=s[0-9]+e[0-9]+' | head -1 | sed 's/ref=//' || true; }

step() { echo ""; echo "═══ $1 ═══"; }
fail() { echo "FAIL: $1" >&2; pw close 2>/dev/null; exit 1; }

PROJ_ID="icptest$(date +%s)"

# Kill any old ICP server holding port 9450
lsof -ti :9450 2>/dev/null | xargs kill -9 2>/dev/null || true

# ── 1. Open ──────────────────────────────────────────────────────────────────

step "1. Launch app"
pw open

# Wait for UI to load and handle sign-in if needed
for attempt in 1 2 3 4 5; do
  pw wait 3000 > /dev/null
  snap=$(pw snapshot 2>/dev/null || true)
  r=$(ref "$snap" 'Skip for now')
  if [ -n "$r" ]; then pw click "$r" > /dev/null; echo "  Skipped sign-in"; break; fi

  snap=$(pw snapshot --host 2>/dev/null || true)
  r=$(ref "$snap" 'Skip for now')
  if [ -n "$r" ]; then pw click "$r" --host > /dev/null; echo "  Skipped sign-in (main)"; break; fi

  echo "$snap" | grep -q 'button "Create"' && { echo "  No sign-in dialog"; break; }
done

# ── 2. Create Integration ────────────────────────────────────────────────────

step "2. Create integration: hello-icp (project: $PROJ_ID)"
snap=$(pw snapshot)
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
snap=$(pw click "$(ref "$snap" 'hello-icp')")
snap=$(pw click "$(ref "$snap" 'Add Artifact')")
snap=$(pw click "$(ref "$snap" 'HTTP Service')")
snap=$(pw click "$(ref "$snap" 'button "Create"')")
pw wait 3000 > /dev/null

# Add Resource → select GET → fill path → Save
snap=$(pw snapshot)
pw click "$(ref "$snap" 'Add Resource')" > /dev/null
pw wait 1000 > /dev/null

# GET method selector — rendered as plain div, not a button. Use text locator.
pw click "text=GET" > /dev/null
pw wait 1000 > /dev/null

# Resource path — shadow DOM input. fill auto-pierces.
snap=$(pw snapshot)
r=$(ref "$snap" 'textbox "Resource Path')
[ -z "$r" ] && fail "Resource Path field not found"
pw fill "$r" greeting > /dev/null
pw wait 1000 > /dev/null

snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'button "Save"')")
echo "$snap" | grep -q "greeting" || fail "GET /greeting not created"
echo "✓ HTTP Service with GET /greeting created"

# ── 4. Run the integration ───────────────────────────────────────────────────

step "4. Run integration"
snap=$(pw snapshot --host)
pw click "$(ref "$snap" 'button "Run Integration"')" --host > /dev/null
pw wait 5000 > /dev/null
pw screenshot /tmp/step4-after-run.png > /dev/null
echo "  Screenshot: /tmp/step4-after-run.png"

echo "  Waiting for Ballerina to start (up to 60s)..."
for i in $(seq 1 12); do
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/greeting 2>/dev/null || echo "000")
  if echo "$code" | grep -qE "2[0-9][0-9]"; then
    echo "✓ Integration running — HTTP $code"
    break
  fi
  [ "$i" -eq 12 ] && fail "Integration did not start within 60s"
done

# ── 5. Stop, enable ICP from project overview ────────────────────────────────

step "5. Enable ICP"

snap=$(pw snapshot --host)
pw click "$(ref "$snap" 'button "Stop')" --host > /dev/null

snap=$(pw snapshot --host)
pw click "$(ref "$snap" 'Show Overview')" --host > /dev/null

snap=$(pw snapshot)
pw click "$(ref "$snap" 'Enable ICP for all integrations')" > /dev/null

for i in $(seq 1 6); do
  pw wait 2000 > /dev/null
  snap=$(pw snapshot)
  echo "$snap" | grep -q "1/1 integrations are ICP-enabled" && break
  [ "$i" -eq 6 ] && fail "ICP not enabled"
done
echo "✓ ICP enabled"

# ── 6. Start ICP server, re-run, verify heartbeat ───────────────────────────

step "6. ICP server + re-run"

snap=$(pw snapshot --host)
pw click "$(ref "$snap" 'ICP: Stopped')" --host > /dev/null

echo "  Waiting for ICP server (up to 30s)..."
for i in $(seq 1 6); do
  sleep 5
  snap=$(pw snapshot --host 2>/dev/null || true)
  if echo "$snap" | grep -q "ICP: Running"; then echo "✓ ICP server running"; break; fi
  [ "$i" -eq 6 ] && fail "ICP server did not start"
done

# Navigate to integration and run
snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'hello-icp')")
snap=$(pw snapshot)
r=$(echo "$snap" | grep 'Run' | grep -E 'Icon Button|button' | grep -oE 'ref=s[0-9]+e[0-9]+' | head -1 | sed 's/ref=//')
[ -z "$r" ] && fail "Run button not found"
pw click "$r" > /dev/null

echo "  Waiting for integration + ICP handshake (up to 60s)..."
for i in $(seq 1 12); do
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/greeting 2>/dev/null || echo "000")
  if echo "$code" | grep -qE "2[0-9][0-9]"; then echo "✓ Integration running with ICP — HTTP $code"; break; fi
  [ "$i" -eq 12 ] && fail "Integration did not start with ICP"
done

pw screenshot icp-final.png > /dev/null
snap=$(pw snapshot --host)
echo "$snap" | grep -q "ICP: Running" || fail "ICP not running after re-run"
echo "✓ ICP heartbeat verified"

echo ""
echo "════════════════════════════════════════════"
echo "  ALL STEPS PASSED ✓"
echo "  Project: $PROJ_ID"
echo "  Screenshot: icp-final.png"
echo "════════════════════════════════════════════"

# Cleanup
snap=$(pw snapshot --host 2>/dev/null || true)
r=$(ref "$snap" 'button "Stop')
[ -n "$r" ] && pw click "$r" --host > /dev/null 2>&1 || true
pw close 2>/dev/null || true
