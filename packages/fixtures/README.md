# @nvhash/fixtures

Devnet-captured fixture corpus: every message, event, and query shape the
nvHASH App decodes from the chain, recorded **verbatim** from a live devnet
driven through the full money path (app implementation plan PR 0.2;
app-spec §14.2 stage 1).

Consumers: the indexer's fixture-decode tests (a contract/vault event change
breaks tests, not production) and the web app's MSW mock harness.

## Provisional status — read this first

The settlement-era vault module has **no formal upstream release**. This
corpus was captured against a development build identified by **feature
probe** (`AcceptAsset` present), never by version pin. The shapes here pin
our assumptions so drift is detectable; they do **not** certify
compatibility. Before any App release is certified, the corpus must be
re-captured against the vault's formal release and diffed (plan PR 8.0 hard
gate). Capture context (chain id, height, node image, probe result) is in
[`fixtures/manifest.json`](fixtures/manifest.json).

## Layout

| Path | Contents | Source plane |
| --- | --- | --- |
| `fixtures/msgs/` | `MsgSwapInRequest` / `MsgSwapOutRequest` txs with their events (swap-in, enqueue) | LCD `GET /cosmos/tx/v1beta1/txs/{hash}`, verbatim |
| `fixtures/operator/` | `MsgExecuteContract` operator-action txs: enroll, pay commission, pay TIP — with their `wasm` events and the bank `transfer` that carries the attached funds | LCD `GET /cosmos/tx/v1beta1/txs/{hash}`, verbatim |
| `fixtures/run-epoch/` | RunEpoch crank txs: deploy settlement (payment + `AcceptAsset` legs), return settlement (marker burn leg), expedite | LCD tx endpoint, verbatim |
| `fixtures/block-events/` | Payout (`EventSwapOutCompleted`) and unfunded-maturity refund (`EventSwapOutRefunded`) | RPC `block_results` — **EndBlocker events; never visible to tx-search** |
| `fixtures/queries/vault/` | vault get/list/params/pending-swap-outs/estimates/payments | LCD REST under **`/vault/v1`** (not `/provlabs/vault/v1`), verbatim — except `estimate-swap-in.json` (CLI/gRPC proto JSON; see below) |
| `fixtures/queries/contract/` | config, epoch_status, epoch_snapshot, apr, validators, jail_reports | LCD `/cosmwasm/wasm/v1/.../smart/`, verbatim |
| `fixtures/queries/staking/`, `fixtures/queries/group/` | validators, contract delegations; groups (empty — pins the pagination envelope) | LCD, verbatim |
| `fixtures/manifest.json` | capture context, pinned facts, per-fixture source tx/blocks | — |

Facts consumers must not re-derive wrongly (also pinned in the manifest):

- Vault msg type URLs carry a `Request` suffix.
- Vault event attribute values are **JSON-encoded strings** (one extra
  quoting layer to unwrap).
- Payout and refund happen in the **EndBlocker** (`finalize_block_events`
  via RPC `block_results`, `txs_results` empty) — an indexer reading only
  tx-search never sees a redemption reach its terminal state.
- `block_search` indexes EndBlocker events on this build (kv indexer).
- Vault LCD REST lives under `/vault/v1`, and **`estimate_swap_in` is
  gRPC/CLI-only**: grpc-gateway rejects `Coin`/`math.Int` query parameters.
  `estimate_swap_out` (string fields) serves over REST.
- Contract cranks emit plain `wasm` events with `action` attributes; epoch
  snapshot/APR data comes from smart queries, not events. Unlike the vault's,
  contract `wasm` attribute values are **not** JSON-quoted — they arrive bare.
- `pay_commission` emits the **per-payment** `amount` (plus `outstanding`);
  `pay_tip` emits only the **epoch-cumulative** `tip_epoch`. A payment's own
  nhash and its payer therefore come from the bank `transfer` event at the
  **same `msg_index`** whose recipient is the contract — the msg's attached
  funds, which `cw_utils::must_pay` bounds to exactly one coin in the
  underlying denom.

## Partial captures

`manifest.json` may carry a `partial_captures` array: fixtures added on their
own rather than by a full corpus regeneration, each recording its own chain
instance, height and node image. They are honest about being from a *different*
devnet bootstrap than `captured_at`/`head_height` describe (addresses match
only because the bootstrap is deterministic). A full
`generate-corpus.sh` + `capture-fixtures.sh` run captures everything from one
chain and the array disappears.

## Regenerating

```sh
scripts/generate-corpus.sh    # fresh devnet reset + bootstrap + p2p drill
                              #   + unfunded-maturity refund (~30 min)
scripts/capture-fixtures.sh   # feature probe, capture, completeness gate
scripts/capture-fixtures.sh --check   # verify an existing corpus only
```

**Completeness is verified, not assumed:** capture fails unless every
required terminal state is present — swap in, swap out (enqueue), expedite,
payout, refund, both RunEpoch settlement legs, and the three operator actions
(enroll, pay commission, pay TIP) with the funds `transfer` each payment's
amount is decoded from. The gate also runs standalone via `--check`.

The generator resets the devnet with `SLASH_WINDOW=10000000` so the drill's
anchor validator stays bonded (see `contracts/drills/p2p-drill.sh` phase 0
and `contracts/IMPLEMENTATION-STATUS.md` §5).
