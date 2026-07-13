# CLAUDE.md — contracts

CosmWasm asset-manager contract for the nvHASH liquid staking vault on
Provenance. Contract code migrates here from the exploratory
`nvhash-cosmos-contracts` repository; until it lands, this file records the
durable facts that carry over.

## Governing documents

- Product spec: `docs/specs/liquid-staking-spec.md` (v1.0, BASELINED
  2026-07-09) — governs product scope and mechanics.
- Delivery ledger: `contracts/IMPLEMENTATION-STATUS.md` — open work, open
  [VERIFY] items, coverage gaps. Keep it updated as tranches land.
- Design rationale and flaw history: `docs/architecture/history/` (the POC
  flaw register's hardenings F1–F9 are load-bearing; do not "simplify" them
  away).

## Pinned stack and conventions

- cosmwasm-std 2.2, provwasm-std 2.8.0, provwasm-test-tube 0.5.0.
- Release profile has `overflow-checks = true`: saturating/checked/
  multiply_ratio math only, floor arithmetic everywhere.
- `cargo test --lib` = pure tests (no Docker); rebuild the optimized artifact
  (`cargo run-script optimize-arm64`, Docker) before test-tube runs or the
  suite exercises a stale binary. `cargo schema` regenerates `schema/`.
- `cargo test --lib` needs `GOTOOLCHAIN=go1.24.5` on Go >= 1.26 hosts
  (provwasm-test-tube's bundled Go deps do not build on 1.26).

## Bootstrap requirements (contract deployment)

- The contract needs **Transfer** access on the restricted receipt marker: the
  burn leg transfers receipt into the marker account before `MsgBurn` (marker
  burn only burns marker-account holdings).
- The contract must hold the vault's **NAV authority** (bootstrap rotates it
  via `update-nav-authority`) for the slash write-down guardrail sandwich.
- Full bootstrap is scripted: `infra/devnet/bootstrap/` (see
  `infra/devnet/README.md`).

## Security posture

This code custodies staked funds; the contract practices in the root
[`SECURITY.md`](../SECURITY.md) are requirements here. In particular: validate
and bound every input at the message boundary; checked/saturating/floor math
only; extend the simulation input domain and invariant assertions in the same
change that adds an input or parameter; keep permissionless endpoints safe for
any caller; no unbounded iteration; errors over panics. Flag any arithmetic
that can overflow, unchecked external input, or missing access control rather
than assuming it is handled elsewhere. NAV must move only via reward deposits
(up), slash write-downs (down), the AUM fee (down), and user swaps; slash
losses are recognized the epoch they are detected, never deferred.
