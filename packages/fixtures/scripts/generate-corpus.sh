#!/usr/bin/env bash
# generate-corpus.sh — drive the devnet through every chain state the fixture
# corpus requires (app plan PR 0.2), so capture-fixtures.sh can record it.
#
#   1. contracts/drills/p2p-drill.sh — the proven money path: deposit,
#      deploy settlement (AcceptAsset), reward NAV step, redeem enqueue,
#      matured payout, return settlement + burn, expedite, arrears, rebalance.
#   2. Unfunded-maturity refund — a swap-out larger than the principal
#      marker's liquid balance, left unserviced past the withdrawal delay:
#      the vault EndBlocker refunds the escrowed shares (contract §8's
#      "failure mode is a refund").
#
# Starts from a FRESH chain (the drill's assertions assume no stale contract
# liquid), reset with a huge slashing window so the drill's never-signing
# anchor validator stays bonded (see p2p-drill.sh phase 0). Set SKIP_RESET=1
# to reuse a chain already reset+bootstrapped that way.
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SDIR/../../.." && pwd)"
CONTAINER="${CONTAINER:-dev-node}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"
RPC="${RPC:-http://localhost:26657}"
SHARE="${SHARE:-nvhash}"
UNDERLYING="${UNDERLYING:-nhash}"
USER_ACCT="${USER_ACCT:-account-2}"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
cli_q() { pexec query "$@" -t --home "$HOME_DIR" -o json; }

if [ "${SKIP_RESET:-0}" != "1" ]; then
  echo "== 1/3: fresh chain (slashing window patched for the anchor validator) =="
  SLASH_WINDOW="${SLASH_WINDOW:-10000000}" "$REPO/infra/devnet/dev-node.sh" reset
  "$REPO/infra/devnet/dev-node.sh" bootstrap
fi

echo "== 2/3: p2p drill (full money path) =="
bash "$REPO/contracts/drills/p2p-drill.sh"

echo
echo "== 3/3: unfunded-maturity refund =="
VAULT="$(cli_q vault list | jq -r --arg d "$SHARE" \
  '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1)"
PRINCIPAL="$(cli_q vault get "$VAULT" | jq -r '.principal.address')"
USER_ADDR="$(pexec keys show "$USER_ACCT" -a -t --home "$HOME_DIR" --keyring-backend test)"

LIQUID="$(cli_q bank balances "$PRINCIPAL" | jq -r --arg d "$UNDERLYING" \
  '[.balances[]|select(.denom==$d)|.amount][0] // "0"')"
USER_SHARES="$(cli_q bank balances "$USER_ADDR" | jq -r --arg d "$SHARE" \
  '[.balances[]|select(.denom==$d)|.amount][0] // "0"')"
# Face value that cannot be covered by marker liquidity: twice the liquid
# balance (share scalar 1e6), capped at the user's share balance.
WANT="$(echo "($LIQUID + 1000000000) * 2 * 1000000" | bc)"
SHARES="$(echo "if ($WANT > $USER_SHARES) $USER_SHARES else $WANT" | bc)"
echo "marker liquid=${LIQUID}${UNDERLYING}; refund swap-out of ${SHARES}${SHARE}"

TXFLAGS="-t --home ${HOME_DIR} --keyring-backend test --chain-id chain-dev --broadcast-mode sync -y -o json"
OUT="$(pexec tx vault swap-out "$USER_ADDR" "$VAULT" "${SHARES}${SHARE}" \
  $TXFLAGS --gas auto --gas-adjustment 2.0 --gas-prices 1nhash --from "$USER_ACCT" 2>/dev/null)"
[ "$(echo "$OUT" | jq -r '.code')" = "0" ] || { echo "swap-out rejected: $(echo "$OUT" | jq -r '.raw_log')" >&2; exit 1; }
echo "swap-out broadcast: $(echo "$OUT" | jq -r '.txhash') — leaving it UNSERVICED past the withdrawal delay"

# Wait for the vault EndBlocker to time the request out and refund it.
echo -n "waiting for EventSwapOutRefunded "
DEADLINE=$(( $(date +%s) + 900 ))
while :; do
  H="$(curl -sf --get "$RPC/block_search" \
    --data-urlencode 'query="provlabs.vault.v1.EventSwapOutRefunded.vault_address EXISTS"' \
    --data-urlencode 'per_page=1' --data-urlencode 'order_by="desc"' \
    | jq -r '.result.blocks[0].block.header.height // empty')"
  [ -n "$H" ] && { echo "-> refunded at block $H"; break; }
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo; echo "refund did not fire within 900s" >&2; exit 1; }
  echo -n "."
  sleep 5
done

echo "== corpus state generation complete =="
