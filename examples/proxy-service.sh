#!/bin/bash
#
# End-to-end test: Proxy an HTTP service through WSO2 Integrator.
#
# Flow:
#   1. Start a Node.js mock backend on port 3333
#   2. Open WSO2 Integrator, create a new integration
#   3. Add an HTTP Service with a GET /proxy resource
#   4. Add an HTTP Connection (httpClient) pointing at the mock backend
#   5. Add a Return node that calls httpClient->get("/proxy")
#   6. Run the integration, verify GET localhost:9090/proxy returns the mock body
#
#
set -euo pipefail

pw() { wso2ipw "$@"; }

# Extract first aria-ref from lines matching a string. Returns "" on no match.
ref() { echo "$1" | grep -F "$2" | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1 || true; }

step() { echo ""; echo "═══ $1 ═══"; }
fail() { echo "FAIL: $1" >&2; cleanup; exit 1; }

# Click a React palette item by exact text match. Dispatches pointer+click events.
click_palette_item() {
  pw eval "g:
    for (const e of document.querySelectorAll('.css-lbgul4')) {
      if (e.textContent === '$1') {
        var t = e.parentElement;
        t.scrollIntoView();
        t.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
        t.dispatchEvent(new PointerEvent('pointerup', {bubbles:true}));
        t.dispatchEvent(new MouseEvent('click', {bubbles:true}));
        break;
      }
    }
  " > /dev/null 2>&1 || true
}

# Click the "+" add-node SVG button. Tries empty-node first, then link-node.
click_add_node() {
  pw eval "g:
    var btn = document.querySelector('[data-testid=empty-node-add-button-1]') ||
              document.querySelector('[data-testid=link-add-button-1]');
    if (btn) btn.dispatchEvent(new MouseEvent('click', {bubbles:true}));
  " > /dev/null 2>&1 || true
}

PROJ_ID="proxy$(date +%s)"
MOCK_PID=""

cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  snap=$(pw snapshot 2>/dev/null || true)
  r=$(ref "$snap" 'button "Stop') || true
  [ -n "$r" ] && pw click "$r" > /dev/null 2>&1 || true
  pw close 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Mock backend ──────────────────────────────────────────────────────────

step "1. Start mock backend on :3333"

# Kill any leftover process on port 3333
lsof -ti:3333 | xargs kill -9 2>/dev/null || true
sleep 1

node -e '
  const http = require("http");
  http.createServer((req, res) => {
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({origin: "mock-backend", path: req.url}));
  }).listen(3333, () => console.log("Mock backend listening on :3333"));
' &
MOCK_PID=$!
sleep 1

body=$(curl -sf http://localhost:3333/health) || fail "Mock backend did not start"
echo "$body" | grep -q "mock-backend" || fail "Unexpected mock response"
echo "✓ Mock backend ready (pid $MOCK_PID)"

# ── 2. Open & create integration ─────────────────────────────────────────────

step "2. Launch app & create integration (project: $PROJ_ID)"
pw open

snap=$(pw wait-for-text "Skip for now" --timeout=15000 2>/dev/null || true)
r=$(ref "$snap" 'Skip for now')
if [ -n "$r" ]; then
  pw click "$r" > /dev/null
  echo "  Skipped sign-in"
fi

snap=$(pw wait-for-text "Create" --timeout=15000)
snap=$(pw click "$(ref "$snap" 'button "Create"')")

pw fill "$(ref "$snap" 'textbox "Integration Name')" ProxyDemo > /dev/null
snap=$(pw snapshot)
pw fill "$(ref "$snap" 'textbox "Project Name')" "Proxy Project" > /dev/null
snap=$(pw snapshot)
pw fill "$(ref "$snap" 'textbox "Project ID"')" "$PROJ_ID" > /dev/null

snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'button "Create Integration"')")
echo "$snap" | grep -q "Integrations & Libraries" || fail "Project overview not reached"
echo "✓ Project created"

# ── 3. Add HTTP Service with GET /proxy ───────────────────────────────────────

step "3. Add HTTP Service with GET /proxy"

# Wait for project overview to render, then click the integration paragraph
snap=$(pw wait-for-text "ProxyDemo" --timeout=15000)
r=$(echo "$snap" | grep 'paragraph.*ProxyDemo' | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1 || true)
[ -z "$r" ] && fail "ProxyDemo paragraph not found on project overview"
snap=$(pw click "$r")
snap=$(pw wait-for-text "Add Artifact" --timeout=10000)
snap=$(pw click "$(ref "$snap" 'Add Artifact')")
snap=$(pw wait-for-text "HTTP Service" --timeout=10000)
r=$(echo "$snap" | grep 'paragraph.*HTTP Service' | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1 || true)
[ -z "$r" ] && fail "HTTP Service paragraph not found"
snap=$(pw click "$r")
snap=$(pw wait-for-text "Base Path" --timeout=15000)
snap=$(pw click "$(ref "$snap" 'button "Create"')")

snap=$(pw wait-for-text "Add Resource" --timeout=15000)
pw click "$(ref "$snap" 'Add Resource')" > /dev/null

snap=$(pw wait-for-text "GET" --timeout=10000)
pw click "g:text=GET" > /dev/null

snap=$(pw wait-for-text "Resource Path" --timeout=10000)
r=$(ref "$snap" 'textbox "Resource Path')
[ -z "$r" ] && fail "Resource Path field not found"
pw fill "$r" proxy > /dev/null
pw press Tab > /dev/null

snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'button "Save"')")
echo "$snap" | grep -q "proxy" || fail "GET /proxy not created"
echo "✓ GET /proxy resource created"

# ── 4. Add HTTP Connection to mock backend ────────────────────────────────────

step "4. Add HTTP Connection (httpClient → localhost:3333)"

pw wait-for-text "Error Handler" --timeout=15000 > /dev/null

# Open node palette via the "+" SVG button
click_add_node
snap=$(pw wait-for-text "Declare Variable" --timeout=10000)

# Open "Add Connection" panel (first match = side panel)
pw click "g:text=Add Connection >> nth=0" > /dev/null
pw wait-for-text "Add Connection" --timeout=10000 > /dev/null

# Search for HTTP connector (use the connection panel search box — last "Text field")
snap=$(pw snapshot)
conn_search=$(echo "$snap" | grep -F 'textbox "Text field"' | tail -1 | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1 || true)
[ -z "$conn_search" ] && fail "Connection search box not found"
pw click "$conn_search" > /dev/null
pw type "HTTP" > /dev/null
sleep 2

# Select "HTTP" / "ballerina / http" connector
snap=$(pw snapshot)
r=$(echo "$snap" | grep -B1 "ballerina / http" | head -1 | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1 || true)
[ -z "$r" ] && fail "HTTP connector not found"
pw click "$r" > /dev/null

# Wait for connector pull + URL field
pw wait-for-text "Url" --timeout=30000 > /dev/null
snap=$(pw snapshot)

# Fill URL field (type without quotes)
url_field=$(echo "$snap" | grep 'textbox \[' | head -1 | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1 || true)
[ -z "$url_field" ] && fail "URL textbox not found"
pw click "$url_field" > /dev/null
pw type "http://localhost:3333" > /dev/null
pw press Escape > /dev/null

# Save connection
snap=$(pw snapshot)
r=$(ref "$snap" 'Save Connection')
[ -z "$r" ] && fail "Save Connection button not found"
pw click "$r" > /dev/null
sleep 2
echo "✓ HTTP Connection saved"

# ── 5. Add Return with httpClient->get call ───────────────────────────────────

step "5. Add Return node with httpClient→get call"

# The palette is still open with "Select node" active after connection save.
# Scroll to and click the Return palette item (needs pointer events for React).
sleep 1
click_palette_item "Return"
sleep 2

# Verify the Return form opened
snap=$(pw snapshot)
if ! echo "$snap" | grep -q "Return value"; then
  # First attempt failed — re-click the "+" button to reset insertion point
  click_add_node
  sleep 1
  click_palette_item "Return"
  sleep 2
fi
snap=$(pw wait-for-text "Return value" --timeout=10000)

# Type the full proxy call as the Return expression
r=$(echo "$snap" | grep 'textbox \[' | head -1 | grep -oE '[gh]:s[0-9]+e[0-9]+' | head -1 || true)
[ -z "$r" ] && fail "Expression textbox not found"
pw click "$r" > /dev/null
pw press Meta+a > /dev/null
pw press Backspace > /dev/null
pw type 'check httpClient->get("/proxy", targetType = json)' > /dev/null
pw press Escape > /dev/null
sleep 2

snap=$(pw snapshot)
r=$(ref "$snap" 'button "Save"')
[ -z "$r" ] && fail "Save button not found (expression may have a validation error)"
pw click "$r" > /dev/null
sleep 2

snap=$(pw snapshot)
echo "$snap" | grep -q "Return" || fail "Return node not in flow"
echo "✓ Return node saved"

# Verify generated code
BAL_DIR="$HOME/wso2integrator/projects/$PROJ_ID"
BAL_FILE=$(find "$BAL_DIR" -name main.bal 2>/dev/null | head -1)
echo "  Generated code:"
cat "$BAL_FILE"
grep -q 'httpClient->get' "$BAL_FILE" || fail "httpClient->get not found in generated code"

# ── 6. Run and verify ────────────────────────────────────────────────────────

step "6. Run integration & verify proxy"
snap=$(pw snapshot)
pw click "$(ref "$snap" 'button "Run Integration"')" > /dev/null

echo "  Waiting for Ballerina to compile and start..."
for i in $(seq 1 24); do
  sleep 5
  body=$(curl -s http://localhost:9090/proxy 2>/dev/null) || true
  if echo "$body" | grep -q "mock-backend"; then
    echo "✓ GET localhost:9090/proxy → proxied response from mock backend"
    echo "  Body: $body"
    break
  fi
  [ "$i" -eq 24 ] && fail "GET /proxy did not return mock-backend response within 120s"
done

echo ""
echo "════════════════════════════════════════════"
echo "  ALL STEPS PASSED ✓"
echo "  Project: $PROJ_ID"
echo "════════════════════════════════════════════"
