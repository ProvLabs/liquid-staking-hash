#!/usr/bin/env bash
# nvHASH Design C (p2p/settlement) bootstrap: restricted RECEIPT marker -> vault
# (underlying = nhash) -> seeded 1:1 internal receipt NAV -> contract deploy + wiring.
#
# Design C differences from nvhash-deploy.sh (Design B, kept for reference):
#   - Vault underlying_asset = nhash; NO payment denom (collapse-compatible).
#   - The receipt is NOT an accepted denom: it enters the principal marker as a
#     held asset via x/exchange payment settlements (AcceptAsset), valued through
#     the vault's internal NAV table, seeded here at 1:1 receipt -> nhash.
#   - The receipt marker's own account also receives the required attribute:
#     the burn leg transfers receipt INTO the marker account before MsgBurn.
#   - Contract instantiate uses the enrollment-era msg (no validators list).
#
# Runs via `docker exec dev-node` against the in-container `test` keyring.
# Assumes the chain is already up (provenance repo: make devnet-start).
set -euo pipefail

CONTAINER="${CONTAINER:-dev-node}"
CHAIN_ID="${CHAIN_ID:-chain-dev}"
HOME_DIR="${HOME_DIR:-/provenance/nodedev}"

ADMIN="${ADMIN:-account-1}"
VALIDATOR="${VALIDATOR:-validator}"

RECEIPT_DENOM="${RECEIPT_DENOM:-nvhash.staked}"
RECEIPT_SUPPLY="${RECEIPT_SUPPLY:-0}"   # Design C mints on demand at deploy legs
RECEIPT_REQUIRED_ATTRS="${RECEIPT_REQUIRED_ATTRS:-nvhash.pb}"
ATTR_VALUE="${ATTR_VALUE:-verified}"

SHARE="${SHARE:-nvhash}"
UNDERLYING="${UNDERLYING:-nhash}"       # vault underlying AND the staked asset
WITHDRAWAL_DELAY="${WITHDRAWAL_DELAY:-}"
WITHDRAWAL_DELAY_MULT_NUM="${WITHDRAWAL_DELAY_MULT_NUM:-3}"
WITHDRAWAL_DELAY_MULT_DEN="${WITHDRAWAL_DELAY_MULT_DEN:-2}"

SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SDIR/../../.." && pwd)"
WASM_DEFAULT="$REPO_ROOT/contracts/artifacts/nvhash_staking.wasm"
WASM_HOST="${WASM_HOST:-$WASM_DEFAULT}"
# The artifact is not committed; keep the default one fresh on EVERY bootstrap
# (the build script no-ops when the artifact already matches the source, so
# this also rebuilds after a pull that only changed src/ or Cargo.lock). An
# explicit WASM_HOST override is deployed as-is and must already exist.
if [ "$WASM_HOST" = "$WASM_DEFAULT" ]; then
  "$REPO_ROOT/contracts/scripts/build-artifact.sh"
elif [ ! -f "$WASM_HOST" ]; then
  echo "WASM_HOST not found: $WASM_HOST" >&2
  exit 1
fi
WASM_IN="${WASM_IN:-/tmp/nvhash_staking.wasm}"
CONTRACT_LABEL="${CONTRACT_LABEL:-nvhash-staking}"
CONTRACT_ADMIN="${CONTRACT_ADMIN:-}"
# The wasmd contract admin (MsgMigrateContract authority) — a DIFFERENT
# authority from InstantiateMsg.admin above, fixed at instantiate and
# irreversible per deployment. Defaults to CONTRACT_ADMIN so the governed
# bootstrap (group policy as CONTRACT_ADMIN) puts BOTH authorities on the
# admin policy (8.4a D21); a plain bootstrap keeps the deployer key, today's
# devnet behavior. There is deliberately NO no-admin path: renouncing
# upgradability is MsgClearAdmin through the group ceremony, reversible right
# up until executed.
WASM_ADMIN="${WASM_ADMIN:-}"
MAX_DELEGATIONS_PER_RUN="${MAX_DELEGATIONS_PER_RUN:-0}"
AUM_FEE_BPS="${AUM_FEE_BPS:-0}"

GAS_ARGS="--gas auto --gas-adjustment 2.0 --gas-prices 1nhash"
COMMON="-t --home ${HOME_DIR} --keyring-backend test --chain-id ${CHAIN_ID} ${GAS_ARGS} --broadcast-mode sync -y -o json"

pexec() { docker exec "$CONTAINER" provenanced "$@"; }
qj()    { pexec query "$@" -t --home "$HOME_DIR" -o json; }
q()     { echo "--- query $*" >&2; qj "$@" | jq .; }
addr_of() { pexec keys show "$1" -a -t --home "$HOME_DIR" --keyring-backend test 2>/dev/null; }

tx() {
  echo "+ tx $*" >&2
  local out txhash code res
  out="$(pexec tx "$@" $COMMON 2>/dev/null)"
  code="$(echo "$out" | jq -r '.code // empty')"; txhash="$(echo "$out" | jq -r '.txhash // empty')"
  [ -n "$txhash" ] || { echo "TX BROADCAST FAILED: $out" >&2; exit 1; }
  [ "$code" = "0" ] || { echo "TX REJECTED (code=$code): $(echo "$out" | jq -r '.raw_log')" >&2; exit 1; }
  for _ in $(seq 1 20); do
    res="$(pexec query tx "$txhash" -t --home "$HOME_DIR" -o json 2>/dev/null || true)"
    code="$(echo "$res" | jq -r '.code // empty' 2>/dev/null || true)"
    [ -n "$code" ] && break; sleep 1
  done
  [ "$code" = "0" ] || { echo "TX FAILED (code=${code:-?}): $(echo "$res" | jq -r '.raw_log // "not committed"')" >&2; exit 1; }
  echo "  ok ($txhash)" >&2; echo "$res"
}

ev_attr() {
  echo "$1" | jq -r --arg t "$2" --arg k "$3" \
    '[.events[]?|select(.type==$t)|.attributes[]?|select(.key==$k)|.value] | last // empty'
}

dur_to_secs() {
  local d="$1" h=0 m=0 s=0
  [[ "$d" =~ ([0-9]+)h ]] && h="${BASH_REMATCH[1]}"
  [[ "$d" =~ ([0-9]+)m ]] && m="${BASH_REMATCH[1]}"
  [[ "$d" =~ ([0-9]+)s ]] && s="${BASH_REMATCH[1]}"
  echo $((h * 3600 + m * 60 + s))
}
unbonding_secs() { dur_to_secs "$(qj staking params 2>/dev/null | jq -r '.params.unbonding_time // "0s"')"; }

vault_addr() { qj vault list 2>/dev/null | jq -r --arg d "$1" '.vaults[]?|select(.total_shares.denom==$d)|.base_account.address' | head -1; }
marker_addr() { qj marker get "$1" 2>/dev/null | jq -r '.marker.base_account.address // .marker.address // empty' 2>/dev/null; }
principal_addr() { qj vault get "$1" 2>/dev/null | jq -r '.principal.address // empty' 2>/dev/null; }

bind_attr_name() {
  local attr="$1" leaf root
  leaf="${attr%%.*}"; root="${attr#*.}"
  if qj name resolve "$attr" 2>/dev/null | jq -e -r '.address // empty' 2>/dev/null | grep -q .; then
    echo "  name '$attr' already bound"
  else
    echo "  bind name '$attr' (leaf '$leaf' under '$root') via $VALIDATOR"
    tx name bind "$leaf" "$VAL_ADDR" "$root" --from "$VALIDATOR" >/dev/null
  fi
}

grant_attr() {
  local addr="$1" attr="$2" label="${3:-$1}"
  [ -n "$addr" ] && [ "$addr" != "null" ] || return 0
  if qj attribute get "$addr" "$attr" 2>/dev/null | jq -e --arg n "$attr" '.attributes[]?|select(.name==$n)' >/dev/null 2>&1; then
    echo "  attr '$attr' already on $label"
  else
    echo "  grant '$attr' -> $label ($addr)"
    tx attribute add "$attr" "$addr" string "$ATTR_VALUE" --from "$VALIDATOR" >/dev/null
  fi
}

existing_contract() {
  local am
  am="$(qj vault get "$1" 2>/dev/null | jq -r '.vault.asset_manager // empty')"
  [ -n "$am" ] || return 0
  if qj wasm contract-state smart "$am" '{"config":{}}' 2>/dev/null | jq -e '.data.receipt_denom' >/dev/null 2>&1; then
    echo "$am"
  fi
}

REQ_ATTRS=()
[ -n "$RECEIPT_REQUIRED_ATTRS" ] && IFS=',' read -r -a REQ_ATTRS <<< "$RECEIPT_REQUIRED_ATTRS"

echo "== Waiting for node to produce blocks =="
until [ "$(pexec status -t --home "$HOME_DIR" 2>/dev/null | jq -r '.sync_info.latest_block_height // 0')" -ge 1 ] 2>/dev/null; do
  echo "  ...waiting"; sleep 2
done

ADMIN_ADDR="$(addr_of "$ADMIN")"
VAL_ADDR="$(addr_of "$VALIDATOR")"
[ -n "$ADMIN_ADDR" ] || { echo "admin key '$ADMIN' not in keyring" >&2; exit 1; }
[ -n "$VAL_ADDR" ] || { echo "validator key '$VALIDATOR' not in keyring" >&2; exit 1; }
[ -n "$CONTRACT_ADMIN" ] || CONTRACT_ADMIN="$ADMIN_ADDR"
[ -n "$WASM_ADMIN" ] || WASM_ADMIN="$CONTRACT_ADMIN"
echo "  admin=$ADMIN_ADDR  validator=$VAL_ADDR  contract-admin=$CONTRACT_ADMIN  wasm-admin=$WASM_ADMIN"

# ============================================================================
# 1) RESTRICTED receipt marker (held asset; NOT the vault underlying)
# ============================================================================
echo; echo "########## 1/4  RECEIPT MARKER: $RECEIPT_DENOM (RESTRICTED, held asset) ##########"
for a in ${REQ_ATTRS[@]+"${REQ_ATTRS[@]}"}; do bind_attr_name "$a"; done

if [ -n "$(marker_addr "$RECEIPT_DENOM")" ]; then
  echo "  marker '$RECEIPT_DENOM' already exists"
else
  attr_flag=()
  [ -n "$RECEIPT_REQUIRED_ATTRS" ] && attr_flag=(--required-attributes "$RECEIPT_REQUIRED_ATTRS")
  echo "== new restricted marker (${RECEIPT_SUPPLY}${RECEIPT_DENOM}) =="
  tx marker new "${RECEIPT_SUPPLY}${RECEIPT_DENOM}" \
      --type RESTRICTED ${attr_flag[@]+"${attr_flag[@]}"} --from "$ADMIN" >/dev/null
  tx marker grant "$ADMIN_ADDR" "$RECEIPT_DENOM" \
      "mint,burn,deposit,withdraw,delete,admin,transfer" --from "$ADMIN" >/dev/null
  tx marker finalize "$RECEIPT_DENOM" --from "$ADMIN" >/dev/null
  tx marker activate "$RECEIPT_DENOM" --from "$ADMIN" >/dev/null
fi
RECEIPT_MARKER_ADDR="$(marker_addr "$RECEIPT_DENOM")"
echo "  receipt marker account: $RECEIPT_MARKER_ADDR"

# ============================================================================
# 2) Vault: underlying = nhash, share = nvhash, NO payment denom (Design C)
# ============================================================================
echo; echo "########## 2/4  VAULT: $SHARE (underlying=$UNDERLYING, no payment denom) ##########"
if [ -z "$WITHDRAWAL_DELAY" ]; then
  UNBOND_SECS="$(unbonding_secs)"
  WITHDRAWAL_DELAY=$((UNBOND_SECS * WITHDRAWAL_DELAY_MULT_NUM / WITHDRAWAL_DELAY_MULT_DEN))
  echo "  withdrawal delay = ${WITHDRAWAL_DELAY}s (${WITHDRAWAL_DELAY_MULT_NUM}/${WITHDRAWAL_DELAY_MULT_DEN}x unbonding_time ${UNBOND_SECS}s)"
fi

VAULT="$(vault_addr "$SHARE")"
if [ -n "$VAULT" ] && [ "$VAULT" != "null" ]; then
  echo "  vault for share '$SHARE' exists at $VAULT — skipping create"
else
  echo "== vault create (share=$SHARE, underlying=$UNDERLYING, delay=$WITHDRAWAL_DELAY) =="
  # create [authority] [admin] [share_denom] [underlying_asset]: the authority
  # signs. It must be the governance module account only where the module's
  # gov_only_vault_creation param is enabled, which the param defaults to off
  # and this dev chain leaves off — so the admin creates its own vault directly.
  tx vault create "$ADMIN_ADDR" "$ADMIN_ADDR" "$SHARE" "$UNDERLYING" \
      --withdrawal-delay-seconds "$WITHDRAWAL_DELAY" --from "$ADMIN" >/dev/null
  VAULT="$(vault_addr "$SHARE")"
fi
[ -n "$VAULT" ] && [ "$VAULT" != "null" ] || { echo "could not resolve $SHARE vault address" >&2; exit 1; }
PRINCIPAL_ADDR="$(principal_addr "$VAULT")"
echo "  VAULT=$VAULT  principal=$PRINCIPAL_ADDR"

# Share denom metadata (vault SetShareDenomMetadata, vault-admin gated): one
# whole displayed nvHASH = 1e15 base shares = 1 HASH at neutral NAV (the vault
# mints ShareScalar = 1e6 shares per nhash; 1e6 x 1e9 nhash/HASH = 1e15).
if qj bank denom-metadata "$SHARE" 2>/dev/null | jq -e '.metadata.base // empty' | grep -q .; then
  echo "  share denom metadata already set for '$SHARE'"
else
  SHARE_METADATA="$(cat <<JSON
{"base":"${SHARE}","display":"nvHASH","name":"nvHASH Liquid Staking Share","symbol":"nvHASH","description":"Share token of the nvHASH liquid staking vault; one whole nvHASH equals one HASH at neutral NAV","denom_units":[{"denom":"${SHARE}","exponent":0},{"denom":"nvHASH","exponent":15}]}
JSON
)"
  tx vault set-share-denom-metadata "$SHARE_METADATA" "$ADMIN_ADDR" "$VAULT" --from "$ADMIN" >/dev/null
  echo "  share denom metadata set: 1 nvHASH = 1e15 $SHARE (= 1 HASH at 1:1 NAV)"
fi

# ============================================================================
# 3) Seed the vault's internal receipt -> nhash NAV at exactly 1:1 (Design C D3)
# ============================================================================
echo; echo "########## 3/4  INTERNAL NAV: 1 $RECEIPT_DENOM = 1 $UNDERLYING ##########"
# update-vault-nav [signer] [vault_address] [denom] [price] [volume] [source]:
# price is the total value of volume units in the vault's underlying asset, so
# price=1nhash volume=1 seeds exactly 1:1. Signer must be the NAV authority
# (defaults to the vault admin at creation).
tx vault update-vault-nav "$ADMIN_ADDR" "$VAULT" "$RECEIPT_DENOM" "1${UNDERLYING}" 1 nvhash-deploy --from "$ADMIN" >/dev/null

# ============================================================================
# 4) Contract: store, instantiate (enrollment-era msg), wire as asset manager
# ============================================================================
echo; echo "########## 4/4  DEPLOY CONTRACT ##########"
CODE_ID="(reused)"
CONTRACT="$(existing_contract "$VAULT")"
if [ -n "$CONTRACT" ]; then
  echo "  vault asset_manager is already an nvhash-staking contract: $CONTRACT — reusing"
else
  [ -f "$WASM_HOST" ] || {
    echo "wasm not found: $WASM_HOST (build: contracts/scripts/build-artifact.sh)" >&2; exit 1; }
  docker cp "$WASM_HOST" "$CONTAINER:$WASM_IN"

  STORE_RES="$(tx wasm store "$WASM_IN" --from "$ADMIN")"
  CODE_ID="$(ev_attr "$STORE_RES" "store_code" "code_id")"
  [ -n "$CODE_ID" ] || { echo "could not parse code_id" >&2; exit 1; }
  echo "  CODE_ID=$CODE_ID"

  INIT_MSG="$(cat <<JSON
{"admin":"${CONTRACT_ADMIN}","vault_address":"${VAULT}","underlying_denom":"${UNDERLYING}","receipt_denom":"${RECEIPT_DENOM}","max_delegations_per_run":${MAX_DELEGATIONS_PER_RUN},"aum_fee_bps":${AUM_FEE_BPS},"performance_threshold_bps":0,"min_capture_interval_secs":0}
JSON
)"
  INST_RES="$(tx wasm instantiate "$CODE_ID" "$INIT_MSG" \
      --label "$CONTRACT_LABEL" --admin "$WASM_ADMIN" --from "$ADMIN")"
  CONTRACT="$(ev_attr "$INST_RES" "instantiate" "_contract_address")"
  [ -n "$CONTRACT" ] || { echo "could not parse contract address" >&2; exit 1; }
  echo "  CONTRACT=$CONTRACT"

  tx vault set-asset-manager "$ADMIN" "$VAULT" "$CONTRACT" --from "$ADMIN" >/dev/null
fi

# The slash write-down runs as a NAV guardrail sandwich (the vault rejects
# WithdrawPrincipalFunds of a non-accepted denom), so the contract must hold
# the vault's NAV authority.
if [ "$(qj vault get "$VAULT" 2>/dev/null | jq -r '.vault.nav_authority // empty')" != "$CONTRACT" ]; then
  echo "== rotate NAV authority to the contract (write-down sandwich) =="
  tx vault update-nav-authority "$ADMIN_ADDR" "$VAULT" "$CONTRACT" --from "$ADMIN" >/dev/null
fi

# Receipt-marker access for the contract: mint/burn (issue/retire), transfer (the
# burn leg moves receipt into the marker account; settlements move restricted
# receipt), withdraw (mint recipient path), deposit (belt-and-braces).
echo "== grant contract receipt-marker access =="
tx marker grant "$CONTRACT" "$RECEIPT_DENOM" "mint,burn,transfer,deposit,withdraw" --from "$ADMIN" >/dev/null

# Required attribute on every account that RECEIVES receipt: contract, vault base
# account, principal marker, and the receipt marker's own account (burn leg).
if [ "${#REQ_ATTRS[@]}" -gt 0 ]; then
  echo "== grant receipt required attribute(s) =="
  for a in "${REQ_ATTRS[@]}"; do
    grant_attr "$CONTRACT" "$a" "contract"
    grant_attr "$VAULT" "$a" "vault"
    grant_attr "$PRINCIPAL_ADDR" "$a" "principal-marker"
    grant_attr "$RECEIPT_MARKER_ADDR" "$a" "receipt-marker-account"
  done
fi

echo; echo "== DONE =="
echo "  receipt marker : $RECEIPT_DENOM ($RECEIPT_MARKER_ADDR)"
echo "  vault          : $VAULT (share=$SHARE, underlying=$UNDERLYING)"
echo "  principal      : $PRINCIPAL_ADDR"
echo "  code id        : $CODE_ID"
echo "  contract       : $CONTRACT (asset_manager)"
echo "  next           : contracts/drills/p2p-drill.sh (settlement drill with assertions)"
