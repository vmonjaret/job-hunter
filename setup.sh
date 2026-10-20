#!/usr/bin/env bash
# First-time setup: build workflows and import them into n8n.
# Run after completing steps 1–4 in the README.
set -euo pipefail

# ── detect compose runtime ────────────────────────────────────────────────────
if command -v podman &>/dev/null && podman compose version &>/dev/null 2>&1; then
  COMPOSE="podman compose"
  EXEC="podman exec"
elif command -v docker &>/dev/null; then
  COMPOSE="docker compose"
  EXEC="docker exec"
else
  echo "Error: neither podman nor docker found." >&2
  exit 1
fi

# ── check required local files ────────────────────────────────────────────────
for f in src/config.local.js prompts/candidate-profile.md; do
  if [[ ! -f "$f" ]]; then
    echo "Error: $f not found. Copy the example and fill it in first." >&2
    echo "  cp src/config.local.example.js src/config.local.js" >&2
    echo "  cp prompts/candidate-profile.example.md prompts/candidate-profile.md" >&2
    exit 1
  fi
done

# ── build workflows ───────────────────────────────────────────────────────────
echo "==> Installing dependencies…"
npm install --silent

echo "==> Running tests…"
npm test

echo "==> Building workflows with local config…"
npm run build:local

# ── start n8n ─────────────────────────────────────────────────────────────────
echo "==> Starting n8n…"
$COMPOSE up -d

# ── wait for n8n to be ready ──────────────────────────────────────────────────
echo -n "==> Waiting for n8n on http://localhost:5678"
for i in $(seq 1 30); do
  if curl -sf http://localhost:5678/healthz &>/dev/null; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo ""
    echo "Error: n8n did not become ready in time. Check logs with: $COMPOSE logs n8n" >&2
    exit 1
  fi
done

# ── import workflows ──────────────────────────────────────────────────────────
echo "==> Importing workflows into n8n…"
# /workflows is mounted from dist/workflows/ (see compose.yaml).
# Import in dependency order: error-handler first, then collector and digest.
for wf in job-hunter-error-handler job-hunter-collector job-hunter-digest; do
  $EXEC n8n n8n import:workflow --input="/workflows/${wf}.json"
  echo "    imported ${wf}"
done

echo ""
echo "Done. Open http://localhost:5678, then:"
echo "  1. Create the owner account (first run only)."
echo "  2. In each workflow, open every node with a credential warning and pick the matching credential."
echo "  3. In the collector and digest: Settings → Error workflow → job-hunter-error-handler."
echo "  4. Run the collector once manually, then activate all three workflows."
