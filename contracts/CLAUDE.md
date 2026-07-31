# CLAUDE.md — contracts

CosmWasm asset-manager contract for the nvHASH liquid staking vault on
Provenance.

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
- The optimized wasm artifact is never committed (repo policy): build it on
  demand with `scripts/build-artifact.sh` (Docker; skips when fresh, rebuilds
  when source is newer). The test-tube integration tests and the devnet
  bootstrap load it from `artifacts/`. `cargo schema` regenerates `schema/`.
- `cargo test --lib` needs `GOTOOLCHAIN=go1.24.5` on Go >= 1.26 hosts
  (provwasm-test-tube's bundled Go deps do not build on 1.26).
- The toolchain is pinned by the **repository-root** `rust-toolchain.toml`, and
  it must stay there. `scripts/build-artifact.sh` bind-mounts this directory
  into the cosmwasm/optimizer image, which builds the wasm from its own
  toolchain; a `rust-toolchain.toml` inside `contracts/` is visible to rustup in
  that container, which then switches away from the image's toolchain to one
  carrying no `wasm32-unknown-unknown` target and the build fails with "can't
  find crate for `std`".

## CI gates

`.github/workflows/contracts-ci.yaml`. All fail the build on violation; each is
runnable locally with the same command.

- **`cargo fmt --check`** and **`cargo clippy --all-targets --locked -D
  warnings`**. The crate is warning-clean, so a new warning is a new defect.
- **Committed schema is current** — `cargo run --bin schema` then
  `git diff --exit-code -- schema`. Enforces the `SECURITY.md` audit-readiness
  rule that the reviewed interface is the shipped one. It also protects a
  consumer: `apps/web/test/governance-templates.test.ts` asserts template
  totality *against the committed JSON*, so a stale schema would not fail that
  test — it would make it assert against the wrong interface.
- **`cargo test --locked`** over a freshly built artifact, so the test-tube
  suite runs against the wasm the current source produces.
- **Bounded simulation soak** — fixed seed, 500 scenarios, halts on first
  failure, and uploads `sim-failures.log`. Reproduce a CI failure with the
  scenario seed it prints: `cargo run --release --bin simulate -- --seed <seed>
  --scenarios 1`.

Not gated here: the live devnet drills under `drills/`, which need the
pre-release vault node image.

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
