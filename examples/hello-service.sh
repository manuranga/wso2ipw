#!/bin/bash
#
# End-to-end test: Create an HTTP hello world service and verify it responds.
#
# Flow:
#   1. Open WSO2 Integrator
#   2. Create a new integration
#   3. Add an HTTP Service with a GET /greeting resource
#   4. Add a Return node with "Hello, World!" expression
#   5. Run the integration, verify GET /greeting returns "Hello, World!"
#
set -euo pipefail

pw() { wso2ipw "$@"; }

ref() { echo "$1" | grep -F "$2" | grep -oE 's[0-9]+e[0-9]+' | head -1; }

step() { echo ""; echo "═══ $1 ═══"; }
fail() { echo "FAIL: $1" >&2; pw close 2>/dev/null; exit 1; }

PROJ_ID="hello$(date +%s)"

# ── 1. Open ──────────────────────────────────────────────────────────────────

step "1. Launch app"
pw open

snap=$(pw wait-for-text "Skip for now" --host --timeout=15000 2>/dev/null || true)
r=$(ref "$snap" 'Skip for now') || true
if [ -n "$r" ]; then
  pw click "$r" --host > /dev/null
  echo "  Skipped sign-in"
fi

snap=$(pw wait-for-text "Create" --timeout=15000)
echo "  App ready"

# ── 2. Create Integration ────────────────────────────────────────────────────

step "2. Create integration (project: $PROJ_ID)"

snap=$(pw click "$(ref "$snap" 'button "Create"')")

pw fill "$(ref "$snap" 'textbox "Integration Name')" HelloWorld > /dev/null
snap=$(pw snapshot)
pw fill "$(ref "$snap" 'textbox "Project Name')" "Hello Project" > /dev/null
snap=$(pw snapshot)
pw fill "$(ref "$snap" 'textbox "Project ID"')" "$PROJ_ID" > /dev/null

snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'button "Create Integration"')")
echo "$snap" | grep -q "Integrations & Libraries" || fail "Project overview not reached"
echo "✓ Project created"

# ── 3. Add HTTP Service with GET /greeting ───────────────────────────────────

step "3. Add HTTP Service with GET /greeting"

snap=$(pw click "$(ref "$snap" 'HelloWorld')")
snap=$(pw wait-for-text "Add Artifact" --timeout=10000)
snap=$(pw click "$(ref "$snap" 'Add Artifact')")
snap=$(pw wait-for-text "HTTP Service" --timeout=10000)
snap=$(pw click "$(ref "$snap" 'HTTP Service')")
snap=$(pw wait-for-text "Base Path" --timeout=15000)
snap=$(pw click "$(ref "$snap" 'button "Create"')")

snap=$(pw wait-for-text "Add Resource" --timeout=15000)
pw click "$(ref "$snap" 'Add Resource')" > /dev/null

snap=$(pw wait-for-text "GET" --timeout=10000)
pw click "text=GET" > /dev/null

snap=$(pw wait-for-text "Resource Path" --timeout=10000)
r=$(ref "$snap" 'textbox "Resource Path')
[ -z "$r" ] && fail "Resource Path field not found"
pw fill "$r" greeting > /dev/null
pw press Tab > /dev/null

snap=$(pw snapshot)
snap=$(pw click "$(ref "$snap" 'button "Save"')")
echo "$snap" | grep -q "greeting" || fail "GET /greeting not created"
echo "✓ GET /greeting resource created"

# ── 4. Add Return "Hello, World!" ────────────────────────────────────────────

step "4. Add Return node"

# Wait for flow editor to render the SVG canvas
pw wait-for-text "Error Handler" --timeout=15000 > /dev/null

# The "+" add-node button is an SVG element outside the aria tree
pw eval 'document.querySelector("[data-testid=empty-node-add-button-1]")?.dispatchEvent(new MouseEvent("click", {bubbles:true}))' > /dev/null
snap=$(pw wait-for-text "Declare Variable" --timeout=10000)

pw eval 'document.querySelectorAll(".css-lbgul4").forEach(e => { if (e.textContent==="Return") e.scrollIntoView() })' > /dev/null
pw click "text=Return" > /dev/null
snap=$(pw wait-for-text "Expression" --timeout=10000)

r=$(ref "$snap" 'textbox')
[ -z "$r" ] && fail "Expression field not found"
pw click "$r" > /dev/null
pw type '"Hello, World!"'

snap=$(pw snapshot)
r=$(ref "$snap" 'button "Save"')
[ -z "$r" ] && fail "Save button not found"
snap=$(pw click "$r")
pw wait-for-text 'Return' --timeout=10000 > /dev/null
echo "✓ Return \"Hello, World!\" saved"

# Verify generated code
BAL_FILE="$HOME/wso2integrator/projects/$PROJ_ID/helloworld/main.bal"
grep -q 'return "Hello, World!"' "$BAL_FILE" || fail "Expression not found in $BAL_FILE"
echo "✓ Verified in generated code"

# ── 5. Run and verify ────────────────────────────────────────────────────────

step "5. Run integration"
snap=$(pw snapshot --host)
pw click "$(ref "$snap" 'button "Run Integration"')" --host > /dev/null

echo "  Waiting for Ballerina to compile and start..."
for i in $(seq 1 24); do
  sleep 5
  body=$(curl -s http://localhost:9090/greeting 2>/dev/null) || true
  if [ "$body" = "Hello, World!" ]; then
    echo "✓ GET /greeting → \"Hello, World!\""; break
  fi
  [ "$i" -eq 24 ] && fail "GET /greeting did not return expected body within 120s"
done

echo ""
echo "════════════════════════════════════════════"
echo "  ALL STEPS PASSED ✓"
echo "  Project: $PROJ_ID"
echo "  Screenshot: hello-service-final.png"
echo "════════════════════════════════════════════"

# Cleanup
snap=$(pw snapshot --host 2>/dev/null || true)
r=$(ref "$snap" 'button "Stop') || true
[ -n "$r" ] && pw click "$r" --host > /dev/null 2>&1 || true
pw close 2>/dev/null || true
