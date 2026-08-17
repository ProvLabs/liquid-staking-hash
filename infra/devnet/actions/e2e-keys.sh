#!/usr/bin/env bash
# infra/devnet/actions/e2e-keys.sh — provision the e2e-live signer keys
# (8.1 §2.10, CO-16). Prints `export` lines for the caller to eval:
#
#   eval "$(infra/devnet/actions/e2e-keys.sh)"
#
#   E2E_LIVE_SIGNER_KEY      a FRESH throwaway account, created and funded here
#   E2E_LIVE_GOV_MEMBER_KEY  account-2 — funded at genesis AND a group member
#                            with weight 1 (nvhash-group-bootstrap.sh), which
#                            is exactly what the governance write leg needs
#   E2E_LIVE_BASE_URL / E2E_LIVE_LCD_URL / E2E_LIVE_VAULT_ADDRESS
#
# DEVNET ONLY (SECURITY.md): throwaway keys; the chain-id guard refuses any
# chain outside the dev family, and nothing is written to the repo.
set -euo pipefail

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/devnet/actions/_common.sh
source "$SDIR/_common.sh"

# Refuse off-devnet: drills and keys point only at disposable chains.
NODE_CHAIN="$(pexec status 2>/dev/null | jq -r '.node_info.network // .NodeInfo.network' || true)"
case "$NODE_CHAIN" in
  chain-dev*) ;;
  *)
    echo "e2e-keys.sh: node reports chain-id '$NODE_CHAIN', not the chain-dev family — refusing." >&2
    echo "Drill keys are throwaway devnet material and never touch another chain (SECURITY.md)." >&2
    exit 1
    ;;
esac

SIGNER_NAME="${SIGNER_NAME:-e2e-signer}"
FUND_AMOUNT="${FUND_AMOUNT:-100000000000nhash}"

# Create the throwaway signer if absent (idempotent re-run: reuse it).
if ! pexec keys show "$SIGNER_NAME" -t --home "$HOME_DIR" --keyring-backend test >/dev/null 2>&1; then
  pexec keys add "$SIGNER_NAME" -t --home "$HOME_DIR" --keyring-backend test >/dev/null
fi
SIGNER_ADDR="$(addr_of "$SIGNER_NAME")"

# Fund it from the validator genesis key (bank send; poll to commit).
FROM=validator tx --gas auto --gas-adjustment 1.4 --fees 1nhash -- \
  bank send "$(addr_of validator)" "$SIGNER_ADDR" "$FUND_AMOUNT" >/dev/null

export_hex() {
  # [VERIFY at first live run: the --unarmored-hex flag on the image's
  # provenanced build.] Falls back loudly if the flag is absent.
  pexec keys export "$1" -t --home "$HOME_DIR" --keyring-backend test \
    --unarmored-hex --unsafe 2>/dev/null <<<"y" \
    || {
      echo "e2e-keys.sh: 'keys export --unarmored-hex --unsafe' failed for $1 — the image's provenanced may not support the flag" >&2
      exit 1
    }
}

resolve
# In-network defaults: the sanctioned runner is the compose playwright
# container (./dev pw), where localhost is the container itself.
LCD_URL_OUT="${E2E_LIVE_LCD_URL:-http://dev-node:1317}"
BASE_URL_OUT="${E2E_LIVE_BASE_URL:-http://web:3000}"

echo "export E2E_LIVE_SIGNER_KEY=$(export_hex "$SIGNER_NAME")"
echo "export E2E_LIVE_GOV_MEMBER_KEY=$(export_hex account-2)"
echo "export E2E_LIVE_BASE_URL=$BASE_URL_OUT"
echo "export E2E_LIVE_LCD_URL=$LCD_URL_OUT"
echo "export E2E_LIVE_VAULT_ADDRESS=$VAULT"
