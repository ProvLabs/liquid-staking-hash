#!/usr/bin/env bash
# Build the optimized contract artifact (artifacts/nvhash_staking.wasm) via the
# pinned CosmWasm optimizer image. The artifact is NOT committed to git; the
# test-tube integration tests and the devnet bootstrap load it from here, so
# run this after any contract source change (and once after a fresh clone).
#
#   contracts/scripts/build-artifact.sh            build if missing or stale
#   contracts/scripts/build-artifact.sh --force    always rebuild
#
# Requires Docker. Uses cosmwasm/optimizer-arm64 on Apple Silicon and
# cosmwasm/optimizer (amd64) elsewhere — the same pinned version as the
# Cargo.toml run-scripts.
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE="$(cd "$SDIR/.." && pwd)"
ARTIFACT="$CRATE/artifacts/nvhash_staking.wasm"
OPTIMIZER_VERSION="0.17.0"

if [ "${1:-}" != "--force" ] && [ -f "$ARTIFACT" ]; then
  # Stale check: any tracked source newer than the artifact forces a rebuild.
  if [ -z "$(find "$CRATE/src" "$CRATE/Cargo.toml" -newer "$ARTIFACT" -print -quit)" ]; then
    echo "artifact up to date: $ARTIFACT"
    exit 0
  fi
  echo "artifact is older than the contract source; rebuilding"
fi

case "$(uname -m)" in
  arm64|aarch64) IMAGE="cosmwasm/optimizer-arm64:$OPTIMIZER_VERSION" ;;
  *)             IMAGE="cosmwasm/optimizer:$OPTIMIZER_VERSION"
                 export DOCKER_DEFAULT_PLATFORM=linux/amd64 ;;
esac

echo "building $ARTIFACT with $IMAGE"
docker run --rm -v "$CRATE":/code \
  --mount type=volume,source="$(basename "$CRATE")_cache",target=/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  "$IMAGE"

# The arm64 optimizer may emit a -aarch64 suffixed artifact; tests and the
# bootstrap load the plain name.
if [ ! -f "$ARTIFACT" ] && [ -f "${ARTIFACT%.wasm}-aarch64.wasm" ]; then
  cp "${ARTIFACT%.wasm}-aarch64.wasm" "$ARTIFACT"
fi

ls -lh "$ARTIFACT"
