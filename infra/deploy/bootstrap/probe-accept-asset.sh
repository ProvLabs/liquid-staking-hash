#!/usr/bin/env bash
# Step 0 — the AcceptAsset feature probe (plan 8.4 §2.6.1): the FIRST task of
# the pilot and the go/no-go for everything after it (D27: public Provenance
# testnet only; if the settlement-era vault module is absent, the pilot WAITS
# on upstream — the designed outcome, not an error state. There is no
# program-operated fallback and no "deploy anyway" flag; the other scripts
# refuse to run without this probe's success marker).
#
# Checks, all read-only:
#   1. the vault module is served on the testnet LCD under /vault/v1
#      (the pinned path fact, app-spec §14.2);
#   2. the node build carries provlabs/vault at v1.2.4 OR LATER — the
#      contract's settlement path is shaped for v1.2.4 specifically and
#      fails on earlier 1.2.x. [VERIFY at first run] the exact build_deps
#      field path on the testnet build; the jq below scans node_info
#      application_version.build_deps for the vault dependency.
#   3. the result (pass/fail, version, date, node) is recorded — append the
#      printed block to docs/specs/chain-facts.md §testnet with provenance in
#      the same change (§6).
set -euo pipefail
SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/deploy/bootstrap/_lib.sh
source "$SDIR/_lib.sh"

require_value TESTNET_LCD
require_value CHAIN_ID
mkdir -p "$STATE_DIR"
rm -f "$PROBE_MARKER"

echo "probe: node identity" >&2
assert_chain_id

echo "probe: /vault/v1 served on the LCD" >&2
if ! lcd_get "/vault/v1/params" >/dev/null 2>&1 && ! lcd_get "/vault/v1/vaults?pagination.limit=1" >/dev/null 2>&1; then
  echo "PROBE FAILED: the vault module is not served under /vault/v1 on ${TESTNET_LCD}" >&2
  echo "D27: the pilot WAITS on upstream availability. Record this result in chain-facts.md." >&2
  exit 1
fi

echo "probe: vault module version >= 1.2.4" >&2
node_info="$(lcd_get /cosmos/base/tendermint/v1beta1/node_info)"
vault_dep="$(jq -r '
  .application_version.build_deps[]?
  | select((.path // "") | test("provlabs/vault"))
  | .version' <<<"$node_info" | head -1)"
if [[ -z "$vault_dep" ]]; then
  echo "PROBE FAILED: no provlabs/vault dependency visible in node_info build_deps" >&2
  echo "[VERIFY] the field path on this build — inspect node_info manually before concluding absence." >&2
  exit 1
fi
version="${vault_dep#v}"
IFS=. read -r major minor patch <<<"${version%%-*}"
if (( major < 1 )) || { (( major == 1 )) && (( minor < 2 )); } \
   || { (( major == 1 )) && (( minor == 2 )) && (( patch < 4 )); }; then
  echo "PROBE FAILED: vault module ${vault_dep} < v1.2.4 — the settlement path is shaped for v1.2.4+" >&2
  echo "D27: the pilot WAITS. Record this result in chain-facts.md." >&2
  exit 1
fi

date_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
height="$(lcd_get /cosmos/base/tendermint/v1beta1/blocks/latest | jq -r '.block.header.height')"
{
  echo "probe=pass"
  echo "vault_version=${vault_dep}"
  echo "chain_id=${CHAIN_ID}"
  echo "lcd=${TESTNET_LCD}"
  echo "height=${height}"
  echo "date=${date_utc}"
} | tee "$PROBE_MARKER"

cat >&2 <<EOF

PROBE PASSED. Record in docs/specs/chain-facts.md (testnet provenance):
  vault module ${vault_dep} on ${CHAIN_ID} at height ${height} (${date_utc}, via ${TESTNET_LCD})
EOF
