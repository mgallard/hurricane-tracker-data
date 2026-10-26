#!/bin/bash
# Fetch NHC, rebuild the Pages files at the repo root, commit and push only if they changed.
set -euo pipefail
cd "$(dirname "$0")"
git pull -q --rebase origin main
node scripts/fetch-nhc.js >/dev/null
cp install/upload/hurricane-tracker.txt install/upload/hurricane-tracker.json src/hurricane-tracker.min.js src/hurricane-tracker.min.css .
touch .nojekyll
git add -A
if git diff --cached --quiet; then echo "no change"; exit 0; fi
git -c user.name="Grok Bot" -c user.email=bot@local commit -qm "Data refresh $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q origin main
echo "pushed $(git rev-parse --short HEAD)"
