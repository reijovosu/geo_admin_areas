#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

shopt -s nullglob

for file in data/[A-Za-z][A-Za-z]_L*.json; do
  base="$(basename "$file")"
  if [[ ! "$base" =~ ^[A-Za-z]{2}_L[0-9]+\.json$ ]]; then
    continue
  fi

  gz_file="${file}.gz"

  if [[ -f "$gz_file" && "$gz_file" -nt "$file" ]]; then
    rm -f "$file"
    echo "Already compressed: $gz_file"
    continue
  fi

  gzip -c "$file" > "$gz_file"
  rm -f "$file"
  echo "Compressed: $gz_file"
done
