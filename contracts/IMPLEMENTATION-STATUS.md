# nvHASH Staking Contract: Implementation Status & Roadmap

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source
> `IMPLEMENTATION-STATUS.md`. Pruned on migration: completed-tranche detail and
> the full verification narrative remain in the exploratory repository's
> ledger and in the spec's §14 resolution record; this file carries forward
> the delivered baseline, open work, open [VERIFY] items, and environment
> notes.

Tracks progress against
[`docs/specs/liquid-staking-spec.md`](../docs/specs/liquid-staking-spec.md)
(v1.0, BASELINED 2026-07-09), delivered on the Design C mechanics. Scope
decisions (2026-07-08, Ira): the top-level spec governs product scope; Design
C governs deploy/settlement mechanics; the 60-day delay + single-tx epoch
model stands.

Update this file as tranches land. Last updated: 2026-07-13.

---

## 1. Delivered baseline (summary)

All v1 engine tranches are complete, spec-conformant, and verified (unit +
embedded-chain tests, devnet drills against a live chain, and the simulation
soak — 1,674 scenarios / 33,480 simulated years / 6.9M checks, zero
violations):

- Design C epoch engine: deploy/return exchange settlements + `AcceptAsset`,
  value-only pause window, single-tx crank with chunked continuation
- Redemption model: 60-day delay, marker-liquidity-gated expedites,
  off-cycle `ServiceRedemptions`, earmark-aware cover
- Validator marketplace: enrollment, on-chain uptime eligibility (with the
  bonded/unjailed validity filter), commission + TIP with priority ordering,
  two-phase jail report/purge, uniform-slot redelegation rebalance under the
  concentration cap
- Slash write-down via the NAV guardrail sandwich (requires NAV authority);
  losses recognized the epoch they are detected
- `EpochSnapshot {}` / `Apr {}` analytics with the exact TVV identity
- POC flaw hardenings F1–F9 (register:
  [`docs/architecture/history/2026-07-02-poc-flaw-register.md`](../docs/architecture/history/2026-07-02-poc-flaw-register.md))
- Emergency controls: `SetHalted`, `ClearPendingDelegations`
- Jail-episode fingerprint on reports (2026-07-13, PR #2 review): a
  `JailObservation` stores the validator's `unbonding_height` alongside the
  report timestamp; purge requires the SAME episode (a mismatch restarts the
  cooldown on the current episode), so a stale report can no longer authorize
  an immediate purge after an unjail/re-jail cycle. Reports are also recorded
  only for validators the program has live stake on. Regression-tested with a
  mocked chain (`validators.rs` jail_episode_tests)
- Config input bounding at the message boundary (2026-07-13, SECURITY.md
  conformance): `Config::validate()` enforced at instantiate and after every
  `UpdateConfig` merge — bps rates capped at 10000, cap ordering
  (min <= max, max > 0), non-zero concentration multiple, safety offset
  < 100%, SDK denom shape, distinct underlying/receipt denoms

**Bootstrap requirements:** the contract needs Transfer access on the
restricted receipt marker (burn leg) and must be rotated in as the vault's
NAV authority; full list in [`CLAUDE.md`](CLAUDE.md).

---

## 2. Open feature work

- [ ] **Capture cadence: decide, configure, and document the uptime capture
      interval (spec §10.4 [DECIDE])** [SMALL, ANALYSIS + CONFIG + DOCS]
      The SigningInfo ratio is a TRAILING metric over `signed_blocks_window`
      (mainnet 34,560 blocks ~= 2 days at ~5s block time), so a plan-time
      read sees only the last ~2 days of a ~30-day epoch; epoch-representative
      ordering REQUIRES periodic captures. Coverage math to encode:
      - The capture interval must be <= the trailing window W (~2 days
        mainnet) for the accumulator mean to tile the epoch with no gap.
      - Recommended target: interval = W/2 (~1 day on mainnet params), giving
        2x overlap so one missed keeper run leaves no blind spot and ~30
        samples per monthly epoch.
      - Set `min_capture_interval_secs` slightly BELOW the intended cadence
        (~0.9x, ~21-22h for a daily keeper) so scheduler jitter never rejects
        a legitimate run; extra calls are accepted no-ops.
      - Ensure one accepted capture lands shortly before epoch completion —
        the natural slot is alongside the keeper's pre-crank `ClaimRewards`.
      - Re-derive from the LIVE chain's slashing params at launch; if
        governance changes `signed_blocks_window`, revisit cadence and
        `min_capture_interval_secs` together.
      Deliverables: production `min_capture_interval_secs` (bootstrap +
      UpdateConfig), keeper schedule entry in the ops runbook, spec §10.4
      note documenting the derivation.
- [ ] **Dual x/group policies (spec §12.1)** [SMALL]
      Split single `admin` into `admin_group_policy` (fund administration,
      pause/halt/clear) and `ops_group_policy` (`UpdateConfig`).
- [ ] **ReceiptAccounting query (spec §11.3)** [TRIVIAL] (partially served by
      `EpochStatus.receipt_minted` today)
- [ ] **Capture-signal incentive (spec §10.4 [DECIDE])** [OPTIONAL, post-v1
      unless voluntary participation proves insufficient]
- [ ] **Bridge integration (spec §11.5)** [EXTERNAL] vault-side
      `SetBridgeAddress` / `ToggleBridgeEnabled` config with NUVA Labs
      adapter; enable only after the adapter is audited. No staking-contract
      code.

---

## 3. Open [VERIFY] items

The settlement-mechanics [VERIFY] wall was executed and closed 2026-07-08/09
(AcceptAsset shape, restricted-receipt settlements, burn leg, exact-price
guardrail, payment fees, refund failure mode, expedite path, commission
attribution, slash write-down); the full record is in spec §14. Still open:

- [ ] Live MAINNET chain params: `unbonding_time`, staking `MaxEntries`
      (assumed 7), concentration restriction options (5.5x / 5% / 33%),
      4M gas limit, exchange payment fee params. NOTE (2026-07-09): the
      optimized artifact (639KB) needs ~4.26M gas to store; if the mainnet
      per-tx cap really is 4M, the upload needs a size diet or a confirmed
      higher limit
- [ ] SIMULATION FINDING (2026-07-09): the fixed 50 bps redemption margin
      under-covers NAV drift over a redemption's final unbonding tail when
      realized yield is high (observed past ~8% annualized with
      harsher-than-mainnet timing; benign at typical parameters).
      Recommendation: make REDEMPTION_MARGIN_BPS admin-configurable and size
      it at or above expected epoch yield x the unbonding/delay fraction; the
      soak's refund counter quantifies any chosen setting
- [ ] Vault module version gating: `AcceptAsset` exists ONLY on vault main as
      of 2026-07-08 (v1.0.15 and v1.1.0 lack it) — the launch chain must ship
      a vault release containing it; share NAV uint64 publish behavior
- [ ] valcons derivation under consensus KEY ROTATION (drill validator never
      rotated)

---

## 4. Test coverage gaps

Covered today: all pure planners, every authz gate positive + negative,
control-plane integration on the real embedded chain, the devnet drill
harness, and the chain-free simulation soak (`src/sim.rs` + the `simulate`
binary; deterministic seeds, CI smoke test). Added 2026-07-13 (SECURITY.md
boundary domain): deterministic edge scenarios in CI — dust economy
(one-base-unit deposits), forced-empty vault, uint64 share-ceiling crossing,
1e30 TVL, rates at their configured maxima, and the 100-validator bound —
each asserting the targeted edge was actually exercised. The `run_epoch`
message-sequence lock also landed 2026-07-13 (`src/epoch.rs` sequence_tests,
via provwasm-mocks): the full mocked-querier crank asserts the exact emitted
order (claims → undelegate → return settlement → write-down sandwich →
pause/deposit/unpause → transfer-then-burn → mint/deploy → delegate) on both
the reward-deposit and write-down paths, so refactors cannot silently
reorder legs.

**NOT covered (the honest headline):** no automated test moves value end to
end in CI — provwasm-test-tube 0.5.0 ships a vault module without
`AcceptAsset`, so every in-test `RunEpoch` takes the empty-vault path. The
money-path invariants are unit-asserted on the plan functions and drilled
live on devnet, but never checked against actual vault state in CI.

- [x] Message-sequence assertion test for `run_epoch` — done 2026-07-13, see
      above
- [ ] Gas profile at the 100-validator bound (MAX_VALIDATORS raised 50 → 100
      on 2026-07-09 to match the Provenance active-set ceiling). Rebalance
      moves are already gas-chunked; profile the fixed per-crank work (up to
      100 reward claims + 100 assessment query sets) against the per-tx gas
      limit, with claim batching across cranks as the fallback
- [ ] Upgrade provwasm-test-tube when a release ships the current vault
      module, so the money path runs in CI rather than only on devnet

---

## 5. Environment notes (local dev)

Devnet lifecycle, bootstrap, and per-operation action scripts are organized
under [`infra/devnet/`](../infra/devnet/); drills under
[`drills/`](drills/). Facts that carry over:

- The dev node needs a `provenance-io/blockchain-dev:latest` image built with
  the settlement-era vault module: from a Provenance checkout with a `go.mod`
  replace pointing `github.com/provlabs/vault` at a vault checkout on main,
  plus an `app/app.go` patch wiring vault main's new keeper deps (Name,
  Attribute, and a small `vaultExchangeAdapter` for the exchange keeper's
  GetPaymentsWithTarget query). Rebuild: `GOTOOLCHAIN=go1.25.8 make
  docker-build-dev`.
- Drill genesis tweaks (applied by the lifecycle script):
  `staking.params.unbonding_time = "120s"`; `config.toml indexer = "kv"`
  (tx indexing is off by default and the scripts poll by tx hash).
- Exchange default params charge 10 HASH create / 8 HASH accept payment fees,
  assessed on the crank caller's tx: attach flat `--fees` (30 HASH covers an
  epoch with both legs).
- `cargo test --lib` needs `GOTOOLCHAIN=go1.24.5` on Go >= 1.26 hosts.
- The optimized artifact is not committed (repo policy: no binaries in git):
  `scripts/build-artifact.sh` is the SINGLE build path — it builds on demand
  (Docker) and no-ops when the artifact is newer than `src/`, `Cargo.toml`,
  and `Cargo.lock`. Every consumer enforces freshness (2026-07-13, PR #2
  review): the test-tube suite refuses to run against a stale artifact, the
  devnet bootstrap re-runs the check on every deploy (an explicit `WASM_HOST`
  override is deployed as-is), and the `cargo run-script optimize*` aliases
  delegate to the same script.
- The test-tube genesis validator's operator key is not recoverable; tests
  that need an operator create a real validator from a funded account
  (`src/tests.rs::create_validator`).
