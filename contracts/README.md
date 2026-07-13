# Contracts

CosmWasm asset-manager contract for the nvHASH liquid staking vault on
Provenance.

> **Migration pending:** the contract crate (`src/`, `Cargo.toml`, `schema/`,
> `artifacts/`) and the drill scripts still live in the exploratory
> `nvhash-cosmos-contracts` repository and migrate here in a future tranche.
> The layout and commands below describe where things land.

Governing spec: [`docs/specs/liquid-staking-spec.md`](../docs/specs/liquid-staking-spec.md)
(v1.0, baselined). Delivery ledger and open work:
[`IMPLEMENTATION-STATUS.md`](IMPLEMENTATION-STATUS.md).

## Layout

- `src/` — the staking contract crate (contract entry points, epoch engine,
  planners, validator marketplace, simulation harness).
- `schema/` — generated JSON schemas for contract messages (`cargo schema`).
- `scripts/` — build/optimizer scripts.
- `drills/` — scripted end-to-end verification against a live dev chain
  (see [`drills/README.md`](drills/README.md)).

## Build, test, and verify

Pinned stack: cosmwasm-std 2.2, provwasm-std 2.8.0, provwasm-test-tube 0.5.0.
Release profile enforces overflow checks; all arithmetic is
saturating/checked/floor.

**Build and unit/integration tests**

    cargo run-script optimize-arm64    # or optimize (x86): builds the wasm artifact
    cargo test --lib                   # unit + embedded-chain integration tests
    cargo schema                       # regenerate schema/

The integration tests load the optimized artifact, so rebuild it (Docker
required) after contract changes. On hosts with Go >= 1.26, prefix test runs
with `GOTOOLCHAIN=go1.24.5` (a provwasm-test-tube dependency does not build on
newer Go).

**Simulation soak** (chain-free stability harness; run for minutes or days)

    cargo run --release --bin simulate
    # options: --seed N --scenarios N --epochs N --report-secs N --halt-on-failure

Replays randomized multi-decade economies through the production planning code
(~25,000 epochs per second), asserting the full invariant battery every
simulated epoch; violations log their scenario seed to `sim-failures.log` and
reproduce exactly with `--seed <seed> --scenarios 1`.

**Devnet drills** (end-to-end verification against a real chain)

Stand up the dev chain per [`infra/devnet/`](../infra/devnet/), then run the
drills in [`drills/`](drills/). The drills assert the receipt-conservation
invariant and TVV neutrality against live vault and marker state after every
phase.
