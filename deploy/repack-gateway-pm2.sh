#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifacts="$repo_root/artifacts/linux-gateway-build"
source_archive="$artifacts/geod-agent-gateway-linux-x64-20260928-geojson-validated.tar.gz"
release_tree="$artifacts/pm2-entry-release-tree"
output_archive="$artifacts/geod-agent-gateway-linux-x64-20260928-pm2-entry.tar.gz"

printf '%s  %s\n' \
  '69a6c52d87936f384b0763016531bb98c829ec80b92dc81b0a4ff9c819d5b405' \
  "$source_archive" | sha256sum --check --status
test ! -e "$release_tree"
test ! -e "$output_archive"
mkdir "$release_tree"
tar -xzf "$source_archive" -C "$release_tree" --no-same-owner
cp "$repo_root/services/geod-agent-model-gateway/start.mjs" "$release_tree/start.mjs"
cp "$repo_root/services/geod-agent-model-gateway/package.json" "$release_tree/package.json"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "$output_archive" -C "$release_tree" .
sha256sum "$output_archive"
