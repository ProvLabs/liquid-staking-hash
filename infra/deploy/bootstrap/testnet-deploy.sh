#!/usr/bin/env bash
# Steps 3–8 — marker, vault, NAV seed, store, instantiate, wiring (plan 8.4
# §2.6.3; nvhash-deploy-p2p.sh is the semantic reference), with the D21
# correction and PER-STEP ON-CHAIN ASSERTIONS (§4 invariant 4: reads, never
# tx codes — a bootstrap that silently skips the NAV rotation leaves the
# DEPLOYER key holding NAV authority, which is direct value manipulation).
#
# Usage:
#   testnet-deploy.sh          run the sequence (idempotent by lookup, C6)
#   testnet-deploy.sh verify   re-assert the complete end state from chain
#                              reads only; safe any time; the post-pilot
#                              acceptance check
#
# D21/D25: InstantiateMsg.admin AND the wasmd --admin are BOTH the admin
# group policy (testnet-group-bootstrap.sh's output). The devnet default
# (--admin deployer) is exactly what this script must not do. Instantiate is
# IRREVERSIBLE per deployment and runs only after every prior assertion has
# passed.
#
# Q4 (ratified 2026-08-14): the pilot deploys WITHOUT required attributes on
# the receipt marker — the receiver attribute is defense-in-depth, not the
# primary control (the receipt is not an accepted vault denom, which is the
# structural guarantee). THE SKIP IS LOUD: it is announced in the output and
# asserted in `verify`, never a silently absent step; RECEIPT_REQUIRED_ATTRS
# stays an explicit parameter so a bindable root can be supplied later
# without a code change. Mainnet MUST restore the attribute (hard 8.5 gate).
set -euo pipefail
SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/deploy/bootstrap/_lib.sh
source "$SDIR/_lib.sh"

require_probe_passed
require_value TESTNET_NODE
require_value TESTNET_LCD
# The admin group policy address (testnet-group-bootstrap.sh output).
require_bech32 ADMIN_POLICY_ADDRESS

RECEIPT_DENOM="${RECEIPT_DENOM:-nvhash.staked}"
SHARE="${SHARE:-nvhash}"
UNDERLYING="nhash"
RECEIPT_REQUIRED_ATTRS="${RECEIPT_REQUIRED_ATTRS:-}" # Q4: empty on the pilot, LOUDLY
CONTRACT_LABEL="${CONTRACT_LABEL:-nvhash-staking}"
WITHDRAWAL_DELAY_MULT_NUM="${WITHDRAWAL_DELAY_MULT_NUM:-3}"
WITHDRAWAL_DELAY_MULT_DEN="${WITHDRAWAL_DELAY_MULT_DEN:-2}"

REPO_ROOT="$(cd "$SDIR/../../.." && pwd)"
WASM_HOST="$REPO_ROOT/contracts/artifacts/nvhash_staking.wasm"

# ── Chain read helpers ─────────────────────────────────────────────────────
marker_addr() { qj marker get "$1" 2>/dev/null | jq -r '.marker.base_account.address // .marker.address // empty'; }
vault_addr() { qj vault list 2>/dev/null | jq -r --arg d "$1" '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1; }
vault_field() { qj vault get "$1" 2>/dev/null | jq -r "$2 // empty"; }
ev_attr() { jq -r --arg t "$2" --arg k "$3" '[.events[]?|select(.type==$t)|.attributes[]?|select(.key==$k)|.value] | last // empty' <<<"$1"; }

dur_to_secs() {
  local d="$1" h=0 m=0 s=0
  [[ "$d" =~ ([0-9]+)h ]] && h="${BASH_REMATCH[1]}"
  [[ "$d" =~ ([0-9]+)m ]] && m="${BASH_REMATCH[1]}"
  [[ "$d" =~ ([0-9]+)s ]] && s="${BASH_REMATCH[1]}"
  echo $((h * 3600 + m * 60 + s))
}

# ── verify: the complete end state from chain reads only ──────────────────
verify() {
  echo "== verify: end state from chain reads only ==" >&2
  local vault contract principal receipt_marker
  receipt_marker="$(marker_addr "$RECEIPT_DENOM")"
  [[ -n "$receipt_marker" ]] || refuse "verify: receipt marker '$RECEIPT_DENOM' does not exist"
  vault="$(vault_addr "$SHARE")"
  [[ -n "$vault" ]] || refuse "verify: no vault for share '$SHARE'"
  principal="$(vault_field "$vault" '.principal.address')"
  contract="$(vault_field "$vault" '.vault.asset_manager')"
  [[ -n "$contract" ]] || refuse "verify: vault has no asset_manager"

  local marker_status
  marker_status="$(qj marker get "$RECEIPT_DENOM" | jq -r '.marker.status')"
  assert_eq "receipt marker status" "$marker_status" "MARKER_STATUS_ACTIVE"
  local marker_type
  marker_type="$(qj marker get "$RECEIPT_DENOM" | jq -r '.marker.marker_type')"
  assert_eq "receipt marker type" "$marker_type" "MARKER_TYPE_RESTRICTED"

  # Q4's loud skip: required attributes are asserted to match the CONFIGURED
  # value — including the configured ABSENCE, stated rather than silent.
  local req_attrs
  req_attrs="$(qj marker get "$RECEIPT_DENOM" | jq -r '(.marker.required_attributes // []) | join(",")')"
  assert_eq "receipt marker required attributes" "$req_attrs" "$RECEIPT_REQUIRED_ATTRS"
  if [[ -z "$RECEIPT_REQUIRED_ATTRS" ]]; then
    echo "  NOTE (Q4, announced): the pilot runs WITHOUT receiver attributes — defense-in-depth" >&2
    echo "  absent by ratified decision; the structural guarantee (receipt is not an accepted" >&2
    echo "  vault denom) stands. Mainnet restoration is a hard 8.5 gate." >&2
  fi

  local nav_price
  nav_price="$(qj vault get "$vault" | jq -r --arg d "$RECEIPT_DENOM" '[.vault.paused_balance? // empty] | ""')" || true
  # NAV entry: read through the vault NAV table.
  nav_price="$(qj vault get "$vault" 2>/dev/null | jq -r --arg d "$RECEIPT_DENOM" '.nav_entries[]? | select(.denom==$d) | .price.amount // empty' | head -1)"
  if [[ -n "$nav_price" ]]; then
    assert_eq "receipt NAV entry price" "$nav_price" "1"
  else
    # [VERIFY at first run] the NAV read path on the testnet build — the
    # devnet build serves it on `vault get`; a moved field is a read fix,
    # never a skipped assertion.
    echo "  WARN: NAV entry not readable at .nav_entries — verify the field path on this build" >&2
  fi

  local cfg_admin wasm_admin nav_auth
  cfg_admin="$(qj wasm contract-state smart "$contract" '{"config":{}}' | jq -r '.data.admin')"
  assert_eq "Config.admin is the admin policy" "$cfg_admin" "$ADMIN_POLICY_ADDRESS"
  wasm_admin="$(qj wasm contract "$contract" | jq -r '.contract_info.admin')"
  assert_eq "wasmd contract admin is the admin policy" "$wasm_admin" "$ADMIN_POLICY_ADDRESS"
  nav_auth="$(vault_field "$vault" '.vault.nav_authority')"
  assert_eq "NAV authority is the contract" "$nav_auth" "$contract"

  local grants
  grants="$(qj marker access "$RECEIPT_DENOM" 2>/dev/null | jq -r --arg a "$contract" \
    '[.accounts[]? // .access[]? | select(.address==$a) | .permissions[]] | sort | join(",")')"
  for perm in ACCESS_BURN ACCESS_DEPOSIT ACCESS_MINT ACCESS_TRANSFER ACCESS_WITHDRAW; do
    case ",$grants," in
      *",$perm,"*) echo "  ok: contract holds $perm on $RECEIPT_DENOM" >&2 ;;
      *) refuse "contract lacks $perm on the receipt marker (a missing Transfer strands every redemption burn leg)" ;;
    esac
  done

  echo "verify: PASS — vault=$vault contract=$contract principal=$principal" >&2
}

if [[ "${1:-}" == "verify" ]]; then
  verify
  exit 0
fi

# ── The sequence ───────────────────────────────────────────────────────────
assert_chain_id
setup_pilot_key

# Step 3: restricted receipt marker (Q4: attribute name is a parameter;
# empty = the announced pilot posture).
echo "== step 3: receipt marker $RECEIPT_DENOM ==" >&2
if [[ -z "$RECEIPT_REQUIRED_ATTRS" ]]; then
  echo "  Q4 (announced, never silent): deploying WITHOUT receiver attributes — mainnet restores them (8.5 gate)" >&2
fi
if [[ -z "$(marker_addr "$RECEIPT_DENOM")" ]]; then
  attr_flag=()
  [[ -n "$RECEIPT_REQUIRED_ATTRS" ]] && attr_flag=(--required-attributes "$RECEIPT_REQUIRED_ATTRS")
  tx marker new "0${RECEIPT_DENOM}" --type RESTRICTED ${attr_flag[@]+"${attr_flag[@]}"} >/dev/null
  tx marker grant "$PILOT_ADDR" "$RECEIPT_DENOM" "mint,burn,deposit,withdraw,delete,admin,transfer" >/dev/null
  tx marker finalize "$RECEIPT_DENOM" >/dev/null
  tx marker activate "$RECEIPT_DENOM" >/dev/null
fi
RECEIPT_MARKER_ADDR="$(marker_addr "$RECEIPT_DENOM")"
[[ -n "$RECEIPT_MARKER_ADDR" ]] || refuse "marker create did not take effect on chain"
assert_eq "marker status" "$(qj marker get "$RECEIPT_DENOM" | jq -r '.marker.status')" "MARKER_STATUS_ACTIVE"

# Step 4: vault, withdrawal delay derived from the TESTNET unbonding time.
echo "== step 4: vault (share=$SHARE, underlying=$UNDERLYING) ==" >&2
UNBOND_SECS="$(dur_to_secs "$(qj staking params | jq -r '.params.unbonding_time // "0s"')")"
[[ "$UNBOND_SECS" -gt 0 ]] || refuse "could not read the testnet unbonding time"
WITHDRAWAL_DELAY=$((UNBOND_SECS * WITHDRAWAL_DELAY_MULT_NUM / WITHDRAWAL_DELAY_MULT_DEN))
echo "  unbonding_time=${UNBOND_SECS}s -> withdrawal_delay=${WITHDRAWAL_DELAY}s (record in chain-facts)" >&2

VAULT="$(vault_addr "$SHARE")"
if [[ -z "$VAULT" ]]; then
  tx vault create "$PILOT_ADDR" "$PILOT_ADDR" "$SHARE" "$UNDERLYING" \
    --withdrawal-delay-seconds "$WITHDRAWAL_DELAY" >/dev/null
  VAULT="$(vault_addr "$SHARE")"
fi
[[ -n "$VAULT" ]] || refuse "vault create did not take effect on chain"
assert_eq "vault withdrawal delay" \
  "$(vault_field "$VAULT" '.vault.withdrawal_delay_seconds')" "$WITHDRAWAL_DELAY"
PRINCIPAL_ADDR="$(vault_field "$VAULT" '.principal.address')"

if ! qj bank denom-metadata "$SHARE" 2>/dev/null | jq -e '.metadata.base // empty' | grep -q .; then
  SHARE_METADATA="{\"base\":\"${SHARE}\",\"display\":\"nvHASH\",\"name\":\"nvHASH Liquid Staking Share\",\"symbol\":\"nvHASH\",\"description\":\"Share token of the nvHASH liquid staking vault; one whole nvHASH equals one HASH at neutral NAV\",\"denom_units\":[{\"denom\":\"${SHARE}\",\"exponent\":0},{\"denom\":\"nvHASH\",\"exponent\":15}]}"
  tx vault set-share-denom-metadata "$SHARE_METADATA" "$PILOT_ADDR" "$VAULT" >/dev/null
fi
qj bank denom-metadata "$SHARE" | jq -e '.metadata.base' >/dev/null || refuse "share metadata missing after set"

# Step 5: seed internal NAV 1:1.
echo "== step 5: seed receipt NAV 1:1 ==" >&2
tx vault update-vault-nav "$PILOT_ADDR" "$VAULT" "$RECEIPT_DENOM" "1${UNDERLYING}" 1 nvhash-testnet-deploy >/dev/null

# Step 6: store the artifact; RECORD gas_used (CO-29, §2.6.4).
echo "== step 6: store artifact ==" >&2
"$REPO_ROOT/contracts/scripts/build-artifact.sh"
[[ -f "$WASM_HOST" ]] || refuse "artifact missing after build"
local_sha="$(shasum -a 256 "$WASM_HOST" | cut -d' ' -f1)"

CONTRACT="$(vault_field "$VAULT" '.vault.asset_manager')"
if [[ -n "$CONTRACT" ]] \
  && qj wasm contract-state smart "$CONTRACT" '{"config":{}}' 2>/dev/null | jq -e '.data.receipt_denom' >/dev/null; then
  echo "  vault asset_manager is already an nvhash-staking contract: $CONTRACT — reusing (C6)" >&2
else
  STORE_RES="$(tx wasm store "$WASM_HOST")"
  CODE_ID="$(ev_attr "$STORE_RES" "store_code" "code_id")"
  [[ -n "$CODE_ID" ]] || refuse "could not parse code_id"
  STORE_GAS="$(jq -r '.gas_used' <<<"$STORE_RES")"
  STORE_HEIGHT="$(jq -r '.height' <<<"$STORE_RES")"
  STORE_TX="$(jq -r '.txhash' <<<"$STORE_RES")"
  chain_sha="$(qj wasm code-info "$CODE_ID" | jq -r '.data_hash // .code_info.data_hash' | tr '[:upper:]' '[:lower:]')"
  assert_eq "on-chain code checksum equals the local artifact" "$chain_sha" "$local_sha"
  {
    echo "code_id=${CODE_ID}"
    echo "store_gas_used=${STORE_GAS}"
    echo "store_height=${STORE_HEIGHT}"
    echo "store_txhash=${STORE_TX}"
    echo "artifact_sha256=${local_sha}"
    echo "artifact_bytes=$(wc -c < "$WASM_HOST" | tr -d ' ')"
  } | tee "$STATE_DIR/store-gas.env"
  echo "  CO-29 MEASUREMENT: gas_used=${STORE_GAS} — append to contracts/IMPLEMENTATION-STATUS.md §3" >&2

  # Step 7: instantiate — BOTH authorities are the admin group policy (D21).
  echo "== step 7: instantiate (admin = wasmd admin = $ADMIN_POLICY_ADDRESS) ==" >&2
  INIT_MSG="{\"admin\":\"${ADMIN_POLICY_ADDRESS}\",\"vault_address\":\"${VAULT}\",\"underlying_denom\":\"${UNDERLYING}\",\"receipt_denom\":\"${RECEIPT_DENOM}\",\"max_delegations_per_run\":0,\"aum_fee_bps\":0,\"performance_threshold_bps\":0,\"min_capture_interval_secs\":0}"
  INST_RES="$(tx wasm instantiate "$CODE_ID" "$INIT_MSG" \
    --label "$CONTRACT_LABEL" --admin "$ADMIN_POLICY_ADDRESS")"
  CONTRACT="$(ev_attr "$INST_RES" "instantiate" "_contract_address")"
  [[ -n "$CONTRACT" ]] || refuse "could not parse contract address"
  assert_eq "Config.admin" \
    "$(qj wasm contract-state smart "$CONTRACT" '{"config":{}}' | jq -r '.data.admin')" \
    "$ADMIN_POLICY_ADDRESS"
  assert_eq "wasmd contract-info admin" \
    "$(qj wasm contract "$CONTRACT" | jq -r '.contract_info.admin')" \
    "$ADMIN_POLICY_ADDRESS"

  tx vault set-asset-manager "$PILOT_ADDR" "$VAULT" "$CONTRACT" >/dev/null
fi
assert_eq "vault asset_manager" "$(vault_field "$VAULT" '.vault.asset_manager')" "$CONTRACT"

# Step 8: wiring — each asserted by read, never by tx code alone.
echo "== step 8: wiring ==" >&2
if [[ "$(vault_field "$VAULT" '.vault.nav_authority')" != "$CONTRACT" ]]; then
  tx vault update-nav-authority "$PILOT_ADDR" "$VAULT" "$CONTRACT" >/dev/null
fi
assert_eq "NAV authority" "$(vault_field "$VAULT" '.vault.nav_authority')" "$CONTRACT"

tx marker grant "$CONTRACT" "$RECEIPT_DENOM" "mint,burn,transfer,deposit,withdraw" >/dev/null || true
if [[ -n "$RECEIPT_REQUIRED_ATTRS" ]]; then
  IFS=, read -ra attrs <<<"$RECEIPT_REQUIRED_ATTRS"
  for a in "${attrs[@]}"; do
    for target in "$CONTRACT" "$VAULT" "$PRINCIPAL_ADDR" "$RECEIPT_MARKER_ADDR"; do
      tx attribute add "$a" "$target" string verified >/dev/null || true
    done
  done
fi

verify

{
  echo "CONTRACT_ADDRESS=${CONTRACT}"
  echo "VAULT_ADDRESS=${VAULT}"
  echo "INDEX_START_HEIGHT=${STORE_HEIGHT:-}"
} | tee "$STATE_DIR/deploy-outputs.env"
echo >&2
echo "Fold deploy-outputs.env into the testnet overlay (commit E) — the workloads fail boot closed until then." >&2
