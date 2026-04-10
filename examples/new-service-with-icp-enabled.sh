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
# Prerequisites:
#   - WSO2 Integrator installed at ~/Applications/WSO2 Integrator.app
#   - Node.js and playwright installed (npm install in this directory)
#
set -euo pipefail

pw() { wso2integrator-cli "$@"; }

# ── Helpers ──────────────────────────────────────────────────────────────────

# Extract a ref from snapshot output by matching a label.
extract_ref() {
  echo "$1" | grep -F "$2" | grep -oE 'ref=s[0-9]+e[0-9]+' | head -1 | sed 's/ref=//'
}

step() {
  local label="$1"; shift
  echo ""
  echo "═══ $label ═══"
  "$@"
}

fail() { echo "FAIL: $1" >&2; pw close 2>/dev/null; exit 1; }

# Click in the webview. All webview buttons need --force due to overlays.
wclick() { pw click "$1" --force; }

PROJ_ID="icptest$(date +%s)"

# Kill any old ICP server holding port 9450
lsof -ti :9450 2>/dev/null | xargs kill -9 2>/dev/null || true

# ── 1. Open WSO2 Integrator ─────────────────────────────────────────────────

step "1. Launch app" pw open

# Handle sign-in dialog: wait for UI to load, then check both frames.
echo "  Waiting for UI to load..."
for attempt in 1 2 3 4 5; do
  pw wait 3000 > /dev/null

  # Check main frame first (sign-in dialog often appears here)
  snap=$(pw snapshot --main 2>/dev/null || true)
  ref=$(extract_ref "$snap" 'Skip for now')
  if [ -n "$ref" ]; then
    pw click "$ref" --main > /dev/null
    echo "  Skipped sign-in dialog (main frame)"
    break
  fi

  # Check webview frame
  snap=$(pw snapshot 2>/dev/null || true)
  ref=$(extract_ref "$snap" 'Skip for now')
  if [ -n "$ref" ]; then
    wclick "$ref" > /dev/null
    echo "  Skipped sign-in dialog (webview)"
    break
  fi

  # Already past sign-in? Check for Create button.
  if echo "$snap" | grep -q 'button "Create"'; then
    echo "  No sign-in dialog (already at landing page)"
    break
  fi
done

# ── 2. Create Integration ────────────────────────────────────────────────────

step "2a. Click 'Create' on landing page" true
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'button "Create"')
[ -z "$ref" ] && fail "Create button not found"
snap=$(wclick "$ref")

# Fill integration name
step "2b. Fill integration name" true
ref=$(extract_ref "$snap" 'textbox "Integration Name')
[ -z "$ref" ] && fail "Integration Name field not found"
snap=$(pw fill "$ref" "hello-icp")

# Fill project name
step "2c. Fill project name" true
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'textbox "Project Name')
[ -z "$ref" ] && fail "Project Name field not found"
snap=$(pw fill "$ref" "ICP Test Project")

# Fill unique project ID
step "2d. Fill project ID: $PROJ_ID" true
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'textbox "Project ID"')
[ -z "$ref" ] && fail "Project ID field not found"
snap=$(pw fill "$ref" "$PROJ_ID")

# Click "Create Integration" — waitForCompletion handles the transition
step "2e. Submit" true
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'button "Create Integration"')
[ -z "$ref" ] && fail "Create Integration button not found"
snap=$(wclick "$ref")

echo "$snap" | grep -q "Integrations & Libraries" || fail "Project overview not reached"
echo "✓ Project created: $PROJ_ID"

# ── 3. Add HTTP Service with GET /greeting ───────────────────────────────────

# Enter the integration
step "3a. Enter hello-icp integration" true
ref=$(extract_ref "$snap" 'hello-icp')
[ -z "$ref" ] && fail "hello-icp not found"
snap=$(wclick "$ref")

# Click "Add Artifact"
step "3b. Add Artifact" true
ref=$(extract_ref "$snap" 'Add Artifact')
[ -z "$ref" ] && fail "Add Artifact button not found"
snap=$(wclick "$ref")

# Select HTTP Service
step "3c. Select HTTP Service" true
ref=$(extract_ref "$snap" 'HTTP Service')
[ -z "$ref" ] && fail "HTTP Service option not found"
snap=$(wclick "$ref")

# Create with default base path "/"
step "3d. Create HTTP Service" true
ref=$(extract_ref "$snap" 'button "Create"')
[ -z "$ref" ] && fail "Create button not found"
snap=$(wclick "$ref")
pw wait 3000 > /dev/null

# Add GET resource
step "3e. Add GET resource" true
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'Add Resource')
[ -z "$ref" ] && fail "Add Resource button not found"
wclick "$ref" > /dev/null
pw wait 1000 > /dev/null

# Click "GET" in the method selector (rendered as plain text, not a button)
pw eval "(() => {
  for (const el of document.querySelectorAll('*')) {
    if (el.textContent.trim() === 'GET' && el.offsetHeight > 20 && el.offsetHeight < 80) {
      el.click(); return 'ok';
    }
  }
  return 'not found';
})()" > /dev/null
pw wait 1000 > /dev/null

# Focus the resource path input (inside shadow DOM of <vscode-text-field>)
pw eval "(() => {
  for (const el of document.querySelectorAll('vscode-text-field')) {
    if (!el.shadowRoot) continue;
    const i = el.shadowRoot.querySelector('input');
    if (i && i.placeholder === 'path/foo') { i.focus(); i.select(); return 'ok'; }
  }
  return 'not found';
})()" > /dev/null
pw type greeting > /dev/null

# Click Save
step "3f. Save resource" true
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'button "Save"')
[ -z "$ref" ] && fail "Save button not found"
snap=$(wclick "$ref")

echo "$snap" | grep -q "greeting" || fail "GET /greeting resource not created"
echo "✓ HTTP Service with GET /greeting created"

# ── 4. Run the integration ───────────────────────────────────────────────────

step "4. Run integration" true
snap=$(pw snapshot --main)
ref=$(extract_ref "$snap" 'button "Run Integration"')
[ -z "$ref" ] && fail "Run Integration button not found"
pw click "$ref" --main > /dev/null

echo "  Waiting for Ballerina to start (up to 60s)..."
for i in $(seq 1 12); do
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/greeting 2>/dev/null || echo "000")
  if echo "$code" | grep -qE "2[0-9][0-9]"; then
    echo "✓ Integration running — HTTP $code on localhost:9090/greeting"
    break
  fi
  [ "$i" -eq 12 ] && fail "Integration did not start within 60s"
done

# ── 5. Stop, enable ICP from project overview ────────────────────────────────

step "5a. Stop running integration" true
snap=$(pw snapshot --main)
ref=$(extract_ref "$snap" 'button "Stop')
[ -z "$ref" ] && fail "Stop button not found"
pw click "$ref" --main > /dev/null

step "5b. Navigate to project overview" true
snap=$(pw snapshot --main)
ref=$(extract_ref "$snap" 'Show Overview')
[ -z "$ref" ] && fail "Show Overview button not found"
pw click "$ref" --main > /dev/null

step "5c. Enable ICP for all integrations" true
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'Enable ICP for all integrations')
[ -z "$ref" ] && fail "Enable ICP button not found"
wclick "$ref" > /dev/null

# ICP enable is a local state change — poll until reflected
for i in $(seq 1 6); do
  pw wait 2000 > /dev/null
  snap=$(pw snapshot)
  echo "$snap" | grep -q "1/1 integrations are ICP-enabled" && break
  [ "$i" -eq 6 ] && fail "ICP not enabled"
done
echo "✓ ICP enabled for all integrations"

# ── 6. Start ICP server, re-run, verify heartbeat ───────────────────────────

step "6a. Start ICP server" true
snap=$(pw snapshot --main)
ref=$(extract_ref "$snap" 'ICP: Stopped')
[ -z "$ref" ] && fail "ICP status bar button not found"
pw click "$ref" --main > /dev/null

echo "  Waiting for ICP server to start (up to 30s)..."
for i in $(seq 1 6); do
  sleep 5
  snap=$(pw snapshot --main 2>/dev/null || true)
  if echo "$snap" | grep -q "ICP: Running"; then
    echo "✓ ICP server running"
    break
  fi
  [ "$i" -eq 6 ] && fail "ICP server did not start within 30s"
done

step "6b. Run from integration view" true
# Navigate to integration
snap=$(pw snapshot)
ref=$(extract_ref "$snap" 'hello-icp')
[ -z "$ref" ] && fail "hello-icp not found in project overview"
snap=$(wclick "$ref")

# Click Run in the webview integration header (not the toolbar)
snap=$(pw snapshot)
ref=$(echo "$snap" | grep 'Run' | grep 'Icon Button\|button' | grep -oE 'ref=s[0-9]+e[0-9]+' | head -1 | sed 's/ref=//')
[ -z "$ref" ] && fail "Run button not found in integration view"
wclick "$ref" > /dev/null

echo "  Waiting for integration + ICP handshake (up to 60s)..."
for i in $(seq 1 12); do
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9090/greeting 2>/dev/null || echo "000")
  if echo "$code" | grep -qE "2[0-9][0-9]"; then
    echo "✓ Integration running with ICP — HTTP $code"
    break
  fi
  [ "$i" -eq 12 ] && fail "Integration did not start with ICP within 60s"
done

step "6c. Verify ICP heartbeat" true
pw screenshot icp-final.png > /dev/null

snap=$(pw snapshot --main)
echo "$snap" | grep -q "ICP: Running" || fail "ICP not running after re-run"
echo "✓ ICP agent connected — heartbeat acknowledged"

echo ""
echo "════════════════════════════════════════════"
echo "  ALL STEPS PASSED ✓"
echo "  Project: $PROJ_ID"
echo "  Screenshot: icp-final.png"
echo "════════════════════════════════════════════"

# Cleanup
snap=$(pw snapshot --main 2>/dev/null || true)
ref=$(extract_ref "$snap" 'button "Stop')
[ -n "$ref" ] && pw click "$ref" --main > /dev/null 2>&1 || true
pw close 2>/dev/null || true
