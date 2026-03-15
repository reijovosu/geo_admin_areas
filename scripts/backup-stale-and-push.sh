#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run backup:global:stale
npm run backups:zip

git add data

if git diff --cached --quiet; then
  echo "No backup changes to commit."
  exit 0
fi

git commit -m "chore: refresh stale geo admin backups"
git push

echo "Stale backup refresh committed and pushed."
