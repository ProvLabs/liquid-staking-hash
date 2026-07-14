#!/usr/bin/env bash
# Dev-node lifecycle for drills and console work: stand up, tear down and
# reset a single-node Provenance devnet configured the way this repo's drills
# expect (short unbonding for real maturities, tx indexing on).
#
#   infra/devnet/dev-node.sh up          create/patch config if needed, start, wait for blocks
#   infra/devnet/dev-node.sh down        stop and remove the container (state kept)
#   infra/devnet/dev-node.sh reset       down + wipe state + up (fresh chain)
#   infra/devnet/dev-node.sh bootstrap   up (if needed) + nvhash-deploy-p2p.sh
#   infra/devnet/dev-node.sh status      container + block height
#
# IMAGE REQUIREMENT (documented, not automated here): a locally built
# `provenance-io/blockchain-dev:latest` containing the settlement-era vault
# module (AcceptAsset). Build it once from a provenance checkout whose go.mod
# points at pre-release vault main — no tagged vault release ships AcceptAsset
# yet (`make docker-build-dev`); afterwards this
# script needs no provenance repo at all: the image's entrypoint generates
# genesis/config into the mounted state dir on first run.
#
# Environment overrides:
#   DEVNET_HOME=infra/devnet/state  state dir (bind-mounted at /provenance)
#   CONTAINER=dev-node         container name
#   IMAGE=provenance-io/blockchain-dev:latest
#   UNBONDING=120s             staking unbonding_time patched into genesis
#   PUBLISH_PORTS=1            expose 26657/9090/1317 on localhost (0 = off)
#   SLASH_WINDOW=              if set, slashing signed_blocks_window patched
#                              into genesis. A huge value (e.g. 10000000) keeps
#                              the p2p drill's never-signing anchor validator
#                              bonded (needed since the 2026-07-13 cap bounding:
#                              a single-validator chain has zero concentration
#                              headroom). Leave unset for jail-drill sessions —
#                              that drill needs real downtime jailing.
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_HOME="${DEVNET_HOME:-$SDIR/state}"
CONTAINER="${CONTAINER:-dev-node}"
IMAGE="${IMAGE:-provenance-io/blockchain-dev:latest}"
UNBONDING="${UNBONDING:-120s}"
PUBLISH_PORTS="${PUBLISH_PORTS:-1}"
CMD="${1:-up}"

height() {
  docker exec "$CONTAINER" provenanced status -t --home /provenance/nodedev 2>/dev/null \
    | jq -r '.sync_info.latest_block_height // 0' 2>/dev/null || echo 0
}

require_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "image '$IMAGE' not found locally." >&2
    echo "Build it once from a provenance checkout wired to the settlement-era" >&2
    echo "vault module: make docker-build-dev  (see header of this script)." >&2
    exit 1
  }
}

generate_config() {
  [ -f "$DEVNET_HOME/nodedev/config/genesis.json" ] && return 0
  echo "== generating genesis/config into $DEVNET_HOME =="
  mkdir -p "$DEVNET_HOME"
  # The entrypoint creates genesis when absent; `keys list` is a harmless
  # command to ride that path. The Docker Desktop mount can lag a just-wiped
  # dir, so retry with pacing until the genesis actually lands.
  for _ in 1 2 3 4 5; do
    docker run --rm -v "$DEVNET_HOME:/provenance" "$IMAGE" keys list >/dev/null 2>&1 || true
    [ -f "$DEVNET_HOME/nodedev/config/genesis.json" ] && break
    sleep 3
  done
  [ -f "$DEVNET_HOME/nodedev/config/genesis.json" ] || {
    echo "genesis generation failed; run manually to see why:" >&2
    echo "  docker run --rm -v \"$DEVNET_HOME:/provenance\" $IMAGE keys list" >&2
    exit 1
  }

  echo "== patching genesis (unbonding_time=$UNBONDING) and config (kv indexer) =="
  local g="$DEVNET_HOME/nodedev/config/genesis.json"
  jq --arg u "$UNBONDING" '.app_state.staking.params.unbonding_time = $u' "$g" > "$g.tmp" \
    && mv "$g.tmp" "$g"
  if [ -n "${SLASH_WINDOW:-}" ]; then
    echo "== patching genesis (signed_blocks_window=$SLASH_WINDOW) =="
    jq --arg w "$SLASH_WINDOW" '.app_state.slashing.params.signed_blocks_window = $w' "$g" > "$g.tmp" \
      && mv "$g.tmp" "$g"
  fi
  # Tx indexing is off by default; the drills and action scripts poll by hash.
  sed -i '' 's/^indexer = .*/indexer = "kv"/' "$DEVNET_HOME/nodedev/config/config.toml" 2>/dev/null \
    || sed -i 's/^indexer = .*/indexer = "kv"/' "$DEVNET_HOME/nodedev/config/config.toml"
  # The LCD (1317) and gRPC (9090) default to container-loopback binds, which
  # published ports cannot reach; the web console needs the LCD from the host.
  local app="$DEVNET_HOME/nodedev/config/app.toml"
  sed -i '' 's|tcp://localhost:1317|tcp://0.0.0.0:1317|; s|"localhost:9090"|"0.0.0.0:9090"|' "$app" 2>/dev/null \
    || sed -i 's|tcp://localhost:1317|tcp://0.0.0.0:1317|; s|"localhost:9090"|"0.0.0.0:9090"|' "$app"
}

up() {
  require_image
  if [ "$(docker ps -q -f name="^${CONTAINER}$")" ]; then
    echo "container '$CONTAINER' already running (height $(height))"
    return 0
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  generate_config
  # A torn shutdown can leave data/ without the consensus WAL dir, which the
  # node then refuses to create through the mount; pre-create it.
  mkdir -p "$DEVNET_HOME/nodedev/data/cs.wal"

  local ports=()
  [ "$PUBLISH_PORTS" = "1" ] && ports=(-p 26657:26657 -p 9090:9090 -p 1317:1317)
  echo "== starting $CONTAINER ($IMAGE) =="
  docker run -d --name "$CONTAINER" \
    -v "$DEVNET_HOME:/provenance" \
    ${ports[@]+"${ports[@]}"} \
    "$IMAGE" start >/dev/null

  echo -n "== waiting for block production "
  for _ in $(seq 1 30); do
    if [ "$(height)" -ge 2 ] 2>/dev/null; then
      echo "-> height $(height) =="
      return 0
    fi
    echo -n "."
    sleep 2
  done
  echo
  echo "node did not start producing blocks; last log lines:" >&2
  docker logs "$CONTAINER" 2>&1 | tail -8 >&2
  exit 1
}

down() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "stopped $CONTAINER" || echo "$CONTAINER not running"
}

case "$CMD" in
  up) up ;;
  down) down ;;
  reset)
    down
    echo "== wiping $DEVNET_HOME/nodedev =="
    rm -rf "$DEVNET_HOME/nodedev"
    sleep 2
    up
    ;;
  bootstrap)
    up
    echo "== bootstrapping vault + contract =="
    "$SDIR/bootstrap/nvhash-deploy-p2p.sh"
    ;;
  status)
    if [ "$(docker ps -q -f name="^${CONTAINER}$")" ]; then
      echo "running: height $(height)"
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 [up|down|reset|bootstrap|status]" >&2
    exit 1
    ;;
esac
