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
| `fixtures/run-epoch/` | RunEpoch crank txs: deploy settlement (payment + `AcceptAsset` legs), return settlement (marker burn leg), expedite | LCD tx endpoint, verbatim |
| `fixtures/block-events/` | Payout (`EventSwapOutCompleted`) and unfunded-maturity refund (`EventSwapOutRefunded`) | RPC `block_results` — **EndBlocker events; never visible to tx-search** |
| `fixtures/queries/vault/` | vault get/list/params/pending-swap-outs/estimates/payments | CLI/gRPC proto JSON — **the vault module registers no LCD REST routes on this build** |
| `fixtures/queries/contract/` | config, epoch_status, epoch_snapshot, apr, validators, jail_reports | LCD `/cosmwasm/wasm/v1/.../smart/`, verbatim |
| `fixtures/queries/staking/` | validators, contract delegations | LCD, verbatim |
| `fixtures/manifest.json` | capture context, pinned facts, per-fixture source tx/blocks | — |

Facts consumers must not re-derive wrongly (also pinned in the manifest):

- Vault msg type URLs carry a `Request` suffix.
- Vault event attribute values are **JSON-encoded strings** (one extra
  quoting layer to unwrap).
- Payout and refund happen in the **EndBlocker** (`finalize_block_events`
  via RPC `block_results`, `txs_results` empty) — an indexer reading only
  tx-search never sees a redemption reach its terminal state.
- `block_search` indexes EndBlocker events on this build (kv indexer).
- Contract cranks emit plain `wasm` events with `action` attributes; epoch
  snapshot/APR data comes from smart queries, not events.

## Regenerating

```sh
scripts/generate-corpus.sh    # fresh devnet reset + bootstrap + p2p drill
                              #   + unfunded-maturity refund (~30 min)
scripts/capture-fixtures.sh   # feature probe, capture, completeness gate
scripts/capture-fixtures.sh --check   # verify an existing corpus only
```

**Completeness is verified, not assumed:** capture fails unless every
required terminal state is present — swap in, swap out (enqueue), expedite,
payout, refund, and both RunEpoch settlement legs. The gate also runs
standalone via `--check`.

The generator resets the devnet with `SLASH_WINDOW=10000000` so the drill's
anchor validator stays bonded (see `contracts/drills/p2p-drill.sh` phase 0
and `contracts/IMPLEMENTATION-STATUS.md` §5).
