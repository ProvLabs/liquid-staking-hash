#!/usr/bin/env bash
# Builds the deployable images: nvhash-indexer, nvhash-api, nvhash-web, nvhash-console.
# Usage: infra/deploy/build-images.sh [tag]   (default tag: git short SHA)
set -euo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
tag="${1:-$(git -C "$root" rev-parse --short HEAD)}"

for component in services/indexer services/api apps/web apps/console; do
  image="nvhash-$(basename "$component"):$tag"
  echo "==> $image"
  docker build -f "$root/$component/Dockerfile" -t "$image" "$root"
done
