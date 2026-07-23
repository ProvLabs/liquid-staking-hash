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
  # Stale check: source, manifest, or lockfile newer than the artifact forces
  # a rebuild (a lockfile-only change still changes the dependency graph the
  # wasm is built from).
  if [ -z "$(find "$CRATE/src" "$CRATE/Cargo.toml" "$CRATE/Cargo.lock" -newer "$ARTIFACT" -print -quit)" ]; then
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

# The image's stock pipeline is `bob` (the pinned cargo wasm build) followed by
# `wasm-opt -Os`. At -Os, wasm-opt inlines any function with a single caller
# REGARDLESS OF SIZE (one-caller-inline-max-function-size defaults to
# unlimited), which merges the big execute handlers (run_epoch et al) into the
# `execute` entrypoint — whose combined frame then exceeds the chain's
# 100-locals-per-function static wasm validation, and the store is rejected
# with "more than 100 locals". So run the SAME image in two explicit stages:
# the stock `bob` build, then the stock `wasm-opt -Os` with the one-caller
# inline size capped (small helpers still merge; big handlers stay out of
# line). A locals gate below fails the build if any function ever exceeds the
# chain limit again.
OCIMFS=65   # binaryen IR-size cap for single-caller inlining (~flexible limit)
MAX_LOCALS=100

MOUNTS=(
  -v "$CRATE":/code
  --mount "type=volume,source=$(basename "$CRATE")_cache,target=/target"
  --mount "type=volume,source=registry_cache,target=/usr/local/cargo/registry"
)

echo "building $ARTIFACT with $IMAGE (wasm-opt -ocimfs=$OCIMFS)"
docker run --rm "${MOUNTS[@]}" --entrypoint sh "$IMAGE" -c '
  set -e
  export PATH="$PATH:/root/.cargo/bin"
  rm -f /target/wasm32-unknown-unknown/release/*.wasm
  cd /code && /usr/local/bin/bob
  mkdir -p /code/artifacts
  RAW="$(ls /target/wasm32-unknown-unknown/release/*.wasm | head -1)"
  wasm-opt -Os --one-caller-inline-max-function-size='"$OCIMFS"' \
    "$RAW" -o /code/artifacts/nvhash_staking.wasm
  cd /code/artifacts && sha256sum nvhash_staking.wasm | tee checksums.txt
'

if [ ! -f "$ARTIFACT" ]; then
  echo "optimizer completed but $ARTIFACT was not produced" >&2
  exit 1
fi

# Gate: no function may exceed the chain's per-function locals limit, or the
# store tx is statically rejected on-chain ("more than 100 locals"). Enforced
# here so the failure is at build time, not at deploy.
python3 - "$ARTIFACT" "$MAX_LOCALS" <<'PY'
import sys
path, limit = sys.argv[1], int(sys.argv[2])
data = open(path, "rb").read()
def uleb(b, o):
    r = s = 0
    while True:
        x = b[o]; o += 1; r |= (x & 0x7F) << s
        if not x & 0x80: return r, o
        s += 7
assert data[:4] == b"\0asm", "not a wasm file"
o, worst = 8, 0
while o < len(data):
    sid = data[o]; o += 1
    size, o = uleb(data, o); end = o + size
    if sid == 10:  # code section
        cnt, p = uleb(data, o)
        for _ in range(cnt):
            bsz, p = uleb(data, p); bend = p + bsz
            nloc, q = uleb(data, p); total = 0
            for _ in range(nloc):
                c, q = uleb(data, q); q += 1; total += c
            worst = max(worst, total)
            p = bend
    o = end
print(f"max function locals: {worst} (limit {limit})")
if worst > limit:
    sys.exit(f"FAIL: a function has {worst} locals > chain limit {limit}; "
             "the store tx would be rejected. Check wasm-opt inlining flags.")
PY

ls -lh "$ARTIFACT"
