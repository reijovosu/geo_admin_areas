#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${FORCE_REFRESH_TODAY:-0}" != "1" ]] && [[ -f "./data/countries.json" ]]; then
  last_refresh_date="$(
    node -e '
      const fs = require("node:fs");
      try {
        const parsed = JSON.parse(fs.readFileSync("./data/countries.json", "utf8"));
        const value = parsed?.meta?.refreshed_at;
        if (typeof value === "string" && value.length >= 10) process.stdout.write(value.slice(0, 10));
      } catch {}
    '
  )"
  today_utc="$(node -p 'new Date().toISOString().slice(0, 10)')"

  if [[ -n "$last_refresh_date" ]] && [[ "$last_refresh_date" == "$today_utc" ]]; then
    echo "Skipping forced refresh: data/countries.json was already refreshed on ${today_utc} UTC."
    echo "Set FORCE_REFRESH_TODAY=1 to run anyway."
    exit 0
  fi
fi

npm run backup:global:refresh
npm run backups:zip

git add data

if git diff --cached --quiet; then
  echo "No backup changes to commit."
  exit 0
fi

git commit -m "chore: refresh geo admin backups"
git push

echo "Backup refresh committed and pushed."
