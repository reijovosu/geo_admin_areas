#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

shopt -s nullglob

max_split_bytes=50000000

split_gzip_if_needed() {
  local gz_file="$1"
  local size
  size=$(wc -c < "$gz_file")

  rm -f "${gz_file}.part-"*

  if (( size <= max_split_bytes )); then
    echo "Compressed: $gz_file"
    return
  fi

  split -b "$max_split_bytes" -d -a 4 "$gz_file" "${gz_file}.part-"
  rm -f "$gz_file"
  echo "Split compressed backup: $gz_file"
}

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

  gzip -9 -n -c "$file" > "$gz_file"
  split_gzip_if_needed "$gz_file"
  rm -f "$file"
done

for gz_file in data/[A-Za-z][A-Za-z]_L*.json.gz; do
  split_gzip_if_needed "$gz_file"
done
