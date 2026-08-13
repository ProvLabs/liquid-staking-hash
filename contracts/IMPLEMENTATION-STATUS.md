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

Update this file as tranches land. Last updated: 2026-07-22.

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
- [x] **Calendar-month epoch alignment (app-spec §14.12; contract behavior
      change)** [MEDIUM, CONTRACT + SIM + DOCS] — done 2026-07-22 (E-CAL)
      Replace the `RunEpoch` eligibility gate: `min_run_interval_secs`
      (fixed-duration minimum since `last_run`) is **retired** in favor of
      "the calendar month of block time is later than `last_run`'s"
      (`env.block.time`, the consensus-agreed BFT timestamp — the only valid
      deterministic clock; Unix/UTC-based but authoritative by consensus,
      never wall-clock UTC). The gate is an eligibility floor, not a trigger:
      the epoch still ends only when a permissionless caller cranks, so epoch
      durations were always variable — the change makes the earliest-valid
      boundary calendar-deterministic and caller-independent (no interval
      guard remains; after a run the predicate itself rejects until the next
      rollover). Same change (SECURITY.md): extend the simulation domain
      (crank jitter incl. compressed gaps from a late run before a rollover —
      safe by the plan-time defensive deferral guards, asserted, not assumed;
      all month lengths; skipped-month catch-up) with per-epoch invariant
      assertions, re-pin `withdrawal_delay_seconds`, and amend the spec. Full
      breakdown in
      [`docs/plans/2026-07-15-calendar-month-epoch-alignment.md`](../docs/plans/2026-07-15-calendar-month-epoch-alignment.md);
      implementation record in
      [`docs/plans/2026-07-22-e-cal-calendar-month-implementation.md`](../docs/plans/2026-07-22-e-cal-calendar-month-implementation.md).
      Confirmed v1-launch-blocking and scheduled; shipped as four commits
      (E-CAL.1 predicate + `month.rs` + sim domain + spec; E-CAL.2 devnet
      `calendar-drill.sh`; E-CAL.3 `withdrawal_delay` re-pin + keeper runbook;
      E-CAL.4 close). Verified: `cargo test --lib` 74/74 (incl. the `month`
      proptest over the full u64 nanosecond domain, the embedded-chain calendar
      gate via `increase_time`, and the calendar sim domain — compressed-gap,
      skipped-month, leap-February, mobilization-ceiling); a seed-7 /
      2,000-scenario / 96,000-epoch soak with zero violations; and the live
      devnet `calendar-drill.sh` (eligible crank runs a full epoch; a same-month
      re-crank is rejected with the next-eligible instant one month later).
      Spec §14 item 12 records the resolution.
- [ ] **Dual x/group policies (spec §12.1)** [SMALL]
      Split single `admin` into `admin_group_policy` (fund administration,
      pause/halt/clear) and `ops_group_policy` (`UpdateConfig`).
      **Two facts recorded 2026-07-28 during M7 planning.** (a) **The App does
      not assume the split.** Its governance indexer discovers the policy set
      (`Config.admin` → policy → group → all policies on that group) and
      mirrors 1..n of them, so this item can land with **zero App change** —
      hardcoding a single "admin policy" would have been the topology
      assumption `SECURITY.md` forbids. (b) **There is no admin-rotation
      path**: `ExecuteMsg` has no variant that changes `Config.admin`, and
      `InstantiateMsg.admin` is set once. Performing this split therefore
      requires a redeploy or a new admin-rotation message — a spec-level event
      under the enumerated-trust-surfaces rule, not a config change. The same
      constraint is why the devnet bootstrap must create the group and policy
      **before** contract instantiation (M7.1 plan §3.1).
      **VERIFIED 2026-07-29 (App PR 7.1 commit A), devnet `chain-dev`, node
      image `sha256:d7e307a6…`:** the described topology had never been run —
      the devnet deployed `Config.admin` as a plain account and
      `fixtures/queries/group/groups.json` was empty. It is now real and
      drilled. `infra/devnet/bootstrap/nvhash-group-bootstrap.sh` creates a
      3-member group (weights 1/1/1) with **two** threshold policies on it
      (threshold 2), deliberately two so the set-valued discovery above is
      exercised by data rather than claimed; it prints the primary policy
      address for `nvhash-deploy-p2p.sh`'s existing `CONTRACT_ADMIN` hook.
      `contracts/drills/gov-drill.sh` then drives the lifecycle: **30
      assertions passed, 1 skipped.** Produced and asserted — a two-message
      proposal accepted and executed (`SUCCESS`); an accepted proposal whose
      messages failed (`ACCEPTED` + `FAILURE`); an accepted-but-unexecuted
      proposal (`ACCEPTED` + `NOT_RUN`); `REJECTED` at voting-period end in a
      block carrying no `x/group` transaction (38 of 39 heights in the
      transition span were txless); `WITHDRAWN`; two prune routes; and the
      multiplicity cases — two messages in one proposal, two proposals in one
      transaction sharing a `voting_period_end`, two `MsgVote`s in one
      transaction at distinct `msg_index`es, and a real two-page paginated read.
      **Six findings, four of which contradicted the plan's assumptions:**
      (1) a successfully executed proposal is **pruned in the same
      transaction**, so `ACCEPTED` + `SUCCESS` is a pair no state read can ever
      observe — `EventExec.result` plus `EventProposalPruned` (which carries the
      terminal status AND the full tally) are its only record; (2) **votes are
      deleted at the voting-period-end tally** even for an accepted proposal, so
      per-voter provenance for any closed proposal exists only in transaction
      history; (3) the LCD answers a missing proposal with **HTTP 500, not 404**,
      and the body is byte-identical for a pruned and a never-existing id — so
      prune can never be inferred from a status code, only from absence in the
      authoritative paginated sweep or from `EventProposalPruned`; (4)
      voting-period-end transitions are **eventless** (no tally event in
      `finalize_block_events`; `EventProposalPruned` is the only `x/group`
      EndBlocker event observed across 295 scanned heights); (5) the `Vote`
      payload carries **no weight**, so a voter's weight must come from
      `group_members` or stay null; (6) a second `MsgVote` from the same voter is
      **rejected by the chain**, so `(proposalId, voter)` is a sound natural key
      — measured, not assumed. **One state was NOT produced:**
      `PROPOSAL_STATUS_ABORTED` proved unreachable on this build (a mid-vote
      group-members change did not abort an open proposal; the proposal executed
      successfully at `group_version` 1 against a group already at version 2).
      It stays in the status enum because it is in the module's proto, and the
      gap is recorded in `packages/fixtures/fixtures/manifest.json` rather than
      assumed away. The devnet voting periods (300s / 40s) and the
      two-policies-on-one-group shape are **devnet-only drill affordances**,
      labeled as such in the manifest.
      **ENUMERATION CONFIRMED EXHAUSTIVE 2026-07-30 (App PRs 7.3–7.4).** The
      App's governance write path composes proposals from a closed template set
      covering the admin-gated `ExecuteMsg` variants, so `SECURITY.md`'s
      "every admin capability is a spec-level event" now has a mechanical
      consequence in the App: `apps/web/test/governance-templates.test.ts`
      asserts the template ↔ admin-variant mapping is **total in both
      directions** against the committed `cargo schema` output
      (`contracts/schema/nvhash-staking.json` — the tracked IDL; `schema/raw/`
      is gitignored), reading authority from each
      variant's own `Admin-gated:` doc comment rather than from a list restated
      in TypeScript. **The admin-capability surface is unchanged by that PR** —
      it remains exactly `PauseVault`, `UnpauseVault`, `UpdateConfig`,
      `SetHalted`, `ClearPendingDelegations`, plus `UnregisterParticipation`
      which the contract accepts from the operator OR the admin. What is new is
      that adding a sixth admin variant here now **fails App CI** until it is
      given a template, rather than shipping an admin capability the App's
      composer cannot reach. *(Amended the same day: that gate is a PRODUCT
      completeness property, not a security one — the App's relay guard does not
      restrict a proposal's contents, because a proposal executes nothing until
      this group's threshold is met. See the App §12.3 correction of
      2026-07-30.)* This item's dual-policy split still needs no App change:
      policy discovery stays set-valued and is used for display and composer
      convenience.
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
- [ ] Vault module version gating — **pinned 2026-08-13 to v1.2.4**,
      superseding the feature-probe rule of 2026-07-13. The 1.2.x line is the
      first to ship `AcceptAsset` (v1.2.0, 2026-07-21) and the contract's
      settlement path is now shaped for **v1.2.4** specifically: the approval
      carries the full payment, repricing a held asset requires a paused
      vault, and a drained denom's NAV entry is removed. Devnet runs
      `ghcr.io/provlabs/vault-dev-node:v1.2.4-rc2`. Share-NAV uint64 publish
      behavior is resolved upstream (vault #233, in v1.2.0). Remaining tails:
      the write-down half of the drill coverage (see the [VERIFY] block
      below), the App fixture/test suites (app plan PR 8.0), and confirmation
      that the launch chain ships v1.2.4 or later — no release is certified
      until all three are green
- [x] **Deploy-settlement path re-drilled against v1.2.4** — 2026-08-13,
      image `vault-dev-node:v1.2.4-rc2` (digest
      `sha256:740970d4…166c556`), contract built from this branch. Bootstrap
      (`nvhash-deploy-p2p.sh`, including the new `tx vault create [authority]
      [admin] …` signature) and `p2p-drill.sh` phases 0–3 pass: enrollment,
      swap-in, and the full deploy settlement, with all four accounting
      invariants, TVV neutrality, and an unpaused vault at the end. The crank
      landed as ONE successful transaction (`DA781F01…`, height 105) emitting
      `EventNAVUpdated` → `EventPaymentCreated` → `EventPaymentAccepted` →
      `EventAssetAccepted`. This closes [VERIFY] (a) below: a
      `MsgAcceptAssetRequest` carrying the full payment terms settles against
      the pending payment, so the v1.2.4 exact-match check passes on the terms
      the contract builds. It also confirms the par NAV restate is accepted on
      a LIVE vault that HOLDS the receipt — the vault's NAV table now carries
      the entry with `source: "nvhash-nav-assert"` — which is the assumption
      the defensive restate rests on
- [x] **`gov-drill.sh` re-run against v1.2.4** — 2026-08-13, same chain, exit
      0. All ten proposals reached their expected outcomes and every recorded
      x/group behavior is unchanged on this image: execution-success prunes
      immediately, votes unreadable after tally, a vote change is rejected,
      two proposers in one signature refused, a missing proposal returns 500
      (not 404) with a body identical for pruned and never-existing, and
      `PROPOSAL_STATUS_ABORTED` remains unreachable (lands ACCEPTED).
      `Config.admin` was the group policy throughout
- [ ] Runtime [VERIFY] items still open after the 2026-08-13 drill. Each needs
      a SECOND epoch crank in a later calendar month, or a real slash, so none
      could run in this session (see the drill-coverage note in §4):
      (b) a full-return epoch drains the receipt and removes its NAV entry
      (`EventNAVRemoved`), and the next crank's par restate re-creates it and
      settles; (c) the close-out pause is entered while the receipt is marked
      at zero, so confirm `PausedBalance`, the restore, and unpause leave TVV
      exact — the `total-value` crisis invariant registered in v1.2.4 is the
      cross-check; (d) two pause/unpause cycles in one transaction perturb
      neither AUM-fee accrual nor the accrual queue (all windows share a block
      timestamp). Until (b)–(d) are drilled, the **write-down bracket is
      verified only in unit tests**, not on a chain
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
order (claims → undelegate → par NAV restate → return settlement →
bracketed write-down sandwich → pause/restore-or-deposit/unpause →
transfer-then-burn → mint/deploy → delegate) on both the reward-deposit and
write-down paths, so refactors cannot silently reorder legs. Extended
2026-08-13 for the v1.2.4 pause rules with four further locks: every
settlement pair's create and accept legs carry identical terms (the vault
settles only on an exact match); every `AcceptAsset` is emitted with the
vault live and every off-par receipt repricing with it paused; every par
settlement is immediately preceded by its own par NAV restate, with the
write-down extraction the sole exception (a settlement that drains a denom
removes its NAV entry, so one restate per crank would let a full-unwind
return leg delete the entry the same crank's deploy leg needs); and the
write-down and reward-deposit paths are mutually exclusive on any crank.

**NOT covered (the honest headline):** no automated test moves value end to
end in CI — provwasm-test-tube 0.5.0 ships a vault module without
`AcceptAsset`, so every in-test `RunEpoch` takes the empty-vault path. The
money-path invariants are unit-asserted on the plan functions and drilled
live on devnet, but never checked against actual vault state in CI. The
sequence locks above assert the messages the crank *emits*; only the devnet
drills prove the chain accepts them.

**Drill coverage is capped at one epoch per calendar month (E-CAL
consequence).** `RunEpoch` eligibility is `civil_month(block_time) >
civil_month(last_run)`, block time on a single-node devnet tracks the
container's real wall clock, and the dev image carries no libfaketime — so a
freshly bootstrapped contract gets exactly ONE crank, and every drill phase
past the first settlement is unreachable until the next month rollover
(`calendar-drill.sh` documents the same limit). The 2026-08-13 v1.2.4 run
therefore verified the deploy settlement and stopped at `p2p-drill.sh` phase
4 with `too soon: next run allowed at 1788220800` (2026-09-01). Anything
needing a second crank — the return settlement, the burn leg, expedites, and
the whole **write-down bracket** — waits for a month boundary or the
accelerated-clock harness E-CAL deferred. This is a standing environmental
constraint, not a regression; plan drill sessions across a rollover.

- [x] Message-sequence assertion test for `run_epoch` — done 2026-07-13, see
      above
- [ ] Gas profile at the 100-validator bound (MAX_VALIDATORS raised 50 → 100
      on 2026-07-09 to match the Provenance active-set ceiling). Rebalance
      moves are already gas-chunked; profile the fixed per-crank work (up to
      100 reward claims + 100 assessment query sets) against the per-tx gas
      limit, with claim batching across cranks as the fallback
- [ ] Upgrade provwasm-test-tube when a release ships the current vault
      module, so the money path runs in CI rather than only on devnet.
      Still blocked 2026-08-13: provwasm-test-tube 0.5.0 and provwasm-std
      2.8.0 remain the latest published crates, and neither carries vault
      1.2.x — which is also why `src/vault_ext.rs` is still hand-rolled

---

## 5. Environment notes (local dev)

Devnet lifecycle, bootstrap, and per-operation action scripts are organized
under [`infra/devnet/`](../infra/devnet/); drills under
[`drills/`](drills/). Facts that carry over:

- The dev node uses `ghcr.io/provlabs/vault-dev-node:v1.2.4-rc2` (pulled
  automatically by `infra/devnet/dev-node.sh`), which ships vault module
  v1.2.4. To build an equivalent image locally instead (set `IMAGE` to its
  tag): from a Provenance checkout whose `go.mod` pins
  `github.com/provlabs/vault v1.2.4`, plus an `app/app.go` patch wiring the
  vault keeper deps (Name, Attribute, exchange). The `vaultExchangeAdapter`
  shim that patch previously needed for the exchange keeper's
  GetPaymentsWithTarget query is likely obsolete — vault v1.2.0 split out an
  `ExchangeQueryServer` dependency so apps can wire
  `exchangekeeper.NewQueryServer` directly — but that is unverified here,
  since the published image is what the drills run. Rebuild:
  `GOTOOLCHAIN=go1.25.8 make
  docker-build-dev`.
- Drill genesis tweaks (applied by the lifecycle script):
  `staking.params.unbonding_time = "120s"`; `config.toml indexer = "kv"`
  (tx indexing is off by default and the scripts poll by tx hash).
- **p2p drill needs a two-validator chain since the cap bounding
  (2026-07-14).** The 2026-07-13 input bounding correctly rejects the drill's
  old 300% cap widen (`max_bonded_cap_bps` is clamped to `1..=10000`), and at
  a 100% cap a single-validator chain has zero concentration headroom by
  arithmetic — the engine defers every delegation and no settlement deploys.
  `p2p-drill.sh` phase 0 now stands up a never-signing, never-enrolled
  "anchor" validator (20k HASH self-bond; the genesis validator keeps > 2/3
  power), which requires resetting with
  `SLASH_WINDOW=10000000 infra/devnet/dev-node.sh reset` so the anchor is not
  downtime-jailed. `jail-drill.sh` still needs a default-window chain (real
  downtime jailing); under the patched window no incidental slash write-down
  occurs in p2p phase 9.
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
