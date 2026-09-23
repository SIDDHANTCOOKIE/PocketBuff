#!/usr/bin/env bash
# Manual deploy of site/ to Vercel production, the alternative to the GitHub Action.
#   bash scripts/deploy-site.sh [project-name]      (default name: pocketbuff)
# Uses VERCEL_TOKEN when set (fully unattended), otherwise your `vercel login` session.
# The first run links site/ to a Vercel project (creates site/.vercel/project.json, git-ignored).
set -euo pipefail
cd "$(dirname "$0")/../site"
name="${1:-pocketbuff}"
command -v vercel >/dev/null 2>&1 || { echo "Vercel CLI not found. Install it once: npm i -g vercel"; exit 1; }
auth=(); [ -n "${VERCEL_TOKEN:-}" ] && auth=(--token "$VERCEL_TOKEN")
if [ ! -f .vercel/project.json ] && [ -z "${VERCEL_PROJECT_ID:-}" ]; then
  echo "First run: linking site/ to the Vercel project \"$name\""
  # Create the project if it does not exist yet (an "already exists" error is fine), then link to it.
  vercel project add "$name" ${auth[@]+"${auth[@]}"} >/dev/null 2>&1 || true
  vercel link --yes --project "$name" ${auth[@]+"${auth[@]}"}
fi
vercel deploy --prod --yes ${auth[@]+"${auth[@]}"}  # expansion is safe with set -u on macOS bash 3.2
