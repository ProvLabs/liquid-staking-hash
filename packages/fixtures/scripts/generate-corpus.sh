#!/usr/bin/env bash
# generate-corpus.sh — drive the devnet through every chain state the fixture
# corpus requires (app plan PR 0.2), so capture-fixtures.sh can record it.
#
#   1. contracts/drills/p2p-drill.sh — the proven money path: deposit,
#      deploy settlement (AcceptAsset), reward NAV step, redeem enqueue,
#      matured payout, return settlement + burn, expedite, arrears, rebalance.
#      It also produces the operator action shapes the corpus pins (App M6.4
#      §2.1): enroll (phase 1), pay_tip (phase 2), pay_commission (phase 8's
#      arrears clearing) — so no separate operator drill is needed here.
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
  echo "== 1/5: fresh chain (slashing window patched for the anchor validator) =="
  SLASH_WINDOW="${SLASH_WINDOW:-10000000}" "$REPO/infra/devnet/dev-node.sh" reset

  # The x/group substrate goes up BEFORE the deploy, and the contract is
  # instantiated with the policy as its admin (App PR 7.1 commit A). Order is
  # forced, not preferred: `ExecuteMsg` has no admin-rotation variant and
  # `InstantiateMsg.admin` is set once, so a policy created after instantiate can
  # never become the admin. Doing it here means the corpus records the GOVERNED
  # topology — the one liquid-staking-spec §12.1 describes — instead of the
  # plain-account admin every earlier capture ran against.
  echo "== 2/5: x/group substrate (group + policy set), then a governed deploy =="
  GOV_POLICY_ADDR="$("$REPO/infra/devnet/bootstrap/nvhash-group-bootstrap.sh" --quiet)"
  echo "  policy: $GOV_POLICY_ADDR"
  CONTRACT_ADMIN="$GOV_POLICY_ADDR" "$REPO/infra/devnet/bootstrap/nvhash-deploy-p2p.sh"
fi

echo "== 3/5: p2p drill (full money path) =="
bash "$REPO/contracts/drills/p2p-drill.sh"

echo
echo "== 4/5: unfunded-maturity refund =="
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

echo
echo "== 5/5: standalone expedite (burn-free crank) =="
# A swap-out small enough that standing marker liquidity covers its payout,
# then service_redemptions: the D2 expedite leg lives in that crank too
# (epoch.rs "Phases B + D2 alone"), so the already-funded request expedites
# immediately — a crank tx carrying the expedite event with NO burn leg. This
# gives the corpus an expedite fixture distinct from the return-settlement
# crank: one run_epoch can legitimately carry deploy, return, AND expedite
# legs at once, and presence-only capture once pinned the same tx under two
# fixture names (PR #5 review).
CONTRACT="$(cli_q vault get "$VAULT" | jq -r '.vault.asset_manager')"
LIQUID="$(cli_q bank balances "$PRINCIPAL" | jq -r --arg d "$UNDERLYING" \
  '[.balances[]|select(.denom==$d)|.amount][0] // "0"')"
[ "$LIQUID" -gt 10000000 ] || { echo "marker liquidity ${LIQUID} too small for the expedite scenario" >&2; exit 1; }
EXP_SHARES="$(echo "$LIQUID / 2 * 1000000" | bc)"
echo "marker liquid=${LIQUID}${UNDERLYING}; standalone-expedite swap-out of ${EXP_SHARES}${SHARE}"

tx_commit() { # tx_commit <tx subcommand and flags…> -> committed tx JSON on stdout
  local out txhash code res
  out="$(pexec tx "$@" $TXFLAGS 2>/dev/null)"
  txhash="$(echo "$out" | jq -r '.txhash // empty')"
  [ -n "$txhash" ] || { echo "broadcast failed: $out" >&2; exit 1; }
  [ "$(echo "$out" | jq -r '.code')" = "0" ] || { echo "rejected: $(echo "$out" | jq -r '.raw_log')" >&2; exit 1; }
  for _ in $(seq 1 30); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  [ "$code" = "0" ] || { echo "tx failed (code=${code:-?}): $(echo "$res" | jq -r '.raw_log // "not committed"' | head -c 300)" >&2; exit 1; }
  echo "$res"
}

tx_commit vault swap-out "$USER_ADDR" "$VAULT" "${EXP_SHARES}${SHARE}" \
  --gas auto --gas-adjustment 2.0 --gas-prices 1nhash --from "$USER_ACCT" >/dev/null
CRANK_RES="$(tx_commit wasm execute "$CONTRACT" '{"service_redemptions":{}}' \
  --gas 4000000 --gas-prices 1nhash --from account-1)"

echo "$CRANK_RES" | jq -e '[.events[].type] | index("provlabs.vault.v1.EventPendingSwapOutExpedited")' >/dev/null \
  || { echo "service crank did not expedite — liquidity or D2 assumptions changed" >&2; exit 1; }
echo "$CRANK_RES" | jq -e '[.events[].type] | index("provenance.marker.v1.EventMarkerBurn") | not' >/dev/null \
  || { echo "service crank unexpectedly carried a burn leg" >&2; exit 1; }
echo "  OK   expedite crank $(echo "$CRANK_RES" | jq -r '.txhash') is burn-free"

echo "== corpus state generation complete =="
