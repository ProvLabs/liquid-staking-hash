# App M8 — Hardening & pilot (milestone overview)

**Status:** PLANNED 2026-08-05 (PR 8.0a, docs-only). The §4 carryover
dispositions and the §6 decision register are **proposals until ratified at
this PR's review** — ratification is the re-review of unresolved M0–M7 tasking
that opens the milestone.
This document is **not a build plan** — it is the milestone-level index, the
M7-overview pattern. Each Phase A PR gets its own plan at branch open (§3);
this file carries only what is cross-cutting: the phase structure (§2), the
carryover register (§4), the certification checklist (§5), the decision
register (§6), the `SECURITY.md` conformance map (§7), and the §4b format
revision M7's closure recommended (§8).
**Epic:** the nvHASH App — [`app-spec.md`](../specs/app-spec.md) (v1.0-RC1)
**Milestone:** M8 — Hardening & pilot,
[master plan](2026-07-13-app-implementation-plan.md) §2 PRs 8.0–8.5
**Companions:** [`SECURITY.md`](../../SECURITY.md),
[`liquid-staking-spec.md`](../specs/liquid-staking-spec.md) §12 / §14 / §15,
[`console-spec.md`](../specs/console-spec.md) §14,
[`contracts/IMPLEMENTATION-STATUS.md`](../../contracts/IMPLEMENTATION-STATUS.md),
[`chain-facts.md`](../specs/chain-facts.md),
[m5.1 wallet certification runbook](2026-07-23-m5.1-wallet-certification-runbook.md)

## 1. What M8 delivers

The program's first non-devnet deployment (testnet pilot, App + Console
side-by-side), the certification that no earlier milestone could perform
(vault-release re-vetting, wallet certification, third-party audit,
live-chain verification), and the mainnet launch. M8 is also where every
unresolved item from M0–M7 is re-reviewed once, dispositioned, and either
discharged, scheduled, or explicitly recorded as post-v1 — the §4 register is
that review's agenda.

## 2. Phase structure

M8 is shaped differently from M1–M7: it contains a **deliberate pause**. The
first stage ends at the testnet deployment; then testing and certification run
for as long as they need (two of the gates — the formal vault release and the
third-party audit — are on external clocks); only then do the final steps and
the mainnet rollout begin.

```
Phase A — testnet readiness & pilot deploy (all local/devnet + first deploy)
  8.0a → (8.0b ∥ 8.1 ∥ 8.2 ∥ 8.3 ∥ 8.4b) → 8.4a → 8.4 (testnet pilot live)

Phase B — certification pause (testnet running; external clocks)
  8.0 (vault release vetting, when the release cuts)
  W1  (§14.1 wallet certification runbook, both vendors)
  T1  (testnet verification ledger — live-chain verify items)
  S1  (security review + third-party audit engagement)

Phase C — mainnet rollout
  8.5 (launch checklist) → mainnet deploy → conservative-caps launch window
```

Three sequencing facts govern the shape:

1. **The audit freezes the contract.** Every open contract-side item — the
   8.4a migrate-entry-point decision, the redemption-margin configurability
   recommendation, the `ReceiptAccounting` query, any dual-policy support —
   must be **decided and landed before S1's audit engagement**, because a
   post-audit contract change re-opens the audit. Phase A is the last cheap
   window for contract changes. (§6 D21, D25, D29.)
2. **8.4a is irreversible per deployment and blocks 8.4.** The wasmd contract
   admin is fixed at instantiate; a contract instantiated without one can
   never be given one (master plan row 8.4a). Nothing non-devnet deploys
   until the decision is recorded.
3. **8.0 is external and untimed** — the formal vault release does not exist
   yet, and until it does, everything vault-facing remains
   compatible-by-feature-probe only and **no App release can be certified**
   (master plan §1 upstream status). If the release lands during Phase A,
   8.0 runs early; certification cannot complete without it either way, and
   the launch chain must ship that release
   (`contracts/IMPLEMENTATION-STATUS.md` §3).

The pause is not idle time: it is when W1/T1/S1 run, and it naturally spans
calendar-month boundaries, which is what makes the E-CAL live-boundary
observations (§5 T1.6) possible on testnet without the accelerated-clock
harness the E-CAL plan deferred.

## 3. PR split and sizing (Phase A)

Per the plan-first rule, **each Phase A PR's detailed plan is written at
branch open**, not in this commit. This deviates from M7's write-all-at-7.0
precedent deliberately: 8.0's and 8.5's content depends on external events
(the release's actual diff; the audit's findings; the 8.4a decision), so plans
written now are guaranteed stale by Phase B — the M5 Tranche-B precedent
(coarse now, refined in a same-file revision before build) applies to the
whole milestone. This overview carries each row's scope at the grain needed to
write those plans. (Ratify as §6 D28.)

| PR | Scope | Depends on | Est. files |
| --- | --- | --- | --- |
| 8.0a | **This docs change** + the §4 carryover triage review. Creates this overview; amends the master plan (rows 8.0a/8.0b/8.4b inserted, §3 map, two stale §5 rows), and updates `persona-review-action-register.md` with resolved-by annotations (§4.3 CO-52). | — | ≈4 |
| 8.0b [P] | **Carryover small-fix tranche** (app-side code hygiene with existing recorded remedies): explicit Prisma generator `output` so the two schemas stop racing over the hoisted client (M7.5–7.6 §10.4); `apps/web` switch to the shared `navHashPerShare` helper (M3 follow-on); adopt the three web-only collection bounds into the `bounds.ts` registry (M7.1 §3.5); `cargo audit`/`pnpm audit` release gates in CI (`SECURITY.md`'s "CI enforcement to follow" tail). | 8.0a dispositions | ≈15 |
| 8.1 [P] | **Degradation drills as e2e** — plan: [m8.1 degradation drills](2026-08-14-app-m8.1-degradation-drills.md) (**verified 2026-08-14**: citations exact; Q1–Q6 resolved as recommended, §7.1. **D30's conditional is answered with evidence — `jail_report` IS cheap and lands with `vault_paused`, leaving `epoch_overdue` the sole §9.6 deferral.** The plan also found **two live defects in `main`**, both confirmed: a dead indexer currently renders as *healthy* (chain and indexed heights come from the same `reconciler_runs` row, so they freeze together and the lag never grows, while the footer age derives from the response clock), and `services/indexer/src/index.ts:20-22`'s "compose restarts the process" contract is asserted but no `restart:` policy exists. **Two forward obligations:** 8.0's release-pin PR flips both drill crons on; 8.4's `repo-secret-scan` must classify the committed dev assertion key as placeholder-pattern.) Master plan row: corrupt-row → reconciler incident → surfaces flip; indexer kill → canonical survives, history dims; LCD kill → stale labels. Plus the carryover live-coverage gaps that belong to the same harness: the drill → notifier tick → bell chain end-to-end (M6.2 deviation 2), the env-gated governance live-transport suite joining a scheduled lane, `E2E_LIVE_GOV_MEMBER_KEY` provisioning, the `group_policy_info` 404-vs-500 live assertion, and the stale-bundle process fix (restart `web` before trusting a green live run — `web-design-notes.md`). Open question for its plan: whether the three deferred reconciler kinds (`vault_paused`, `jail_report`, `epoch_overdue`) land here or stay recorded (§6 D30). | 8.0a | ≈25 |
| 8.2 [P] | **Load test + rate-limit tuning** on the public API — plan: [m8.2 load test](2026-08-14-app-m8.2-load-test.md) (**verified 2026-08-14**: citations exact; **gate discharged** — T1–T7 ratified as proposed, T3 breach auto-lands the materialization, rate-limit work scoped to the aggregate channel. **Q1 departs from the plan's recommendation: load runs stay manual / release-branch only, with no scheduled lane** — so §4b C7's between-runs cell is unfilled by decision, and T5 (rate-limit correctness, the one security-posture threshold) stays in that manual suite, meaning a limiter regression can sit undetected between releases. Accepted and recorded, not mitigated). It also corrects two of this row's premises (the backfill-lag criterion is restated as steady-state margin + catch-up rate, since any deep backfill correctly opens `indexer_lag`; and rate-limit tuning is aggregate-channel sizing — all end users share one limiter key behind the SSR tier, identity forwarding being 8.4 territory). Named inputs from the carryover review: the holder-lifecycle fold (measured 1 407 ms @ 1.2 M tx, superlinear, uncached, per `/admin` load — its recorded remedy is indexer-side materialization, contingent on this PR's thresholds), the two accepted seq scans and the `operatorPaymentTotalsFor` planner flip (re-measure; `services/api/CLAUDE.md` says do **not** index-fix without a measured need), deep-`OFFSET` behavior, and indexer lag under backfill vs the DATA DEGRADED threshold (§4 test table). | 8.0a | ≈15 |
| 8.3 [P] | **Accessibility — automated coverage** (row retitled 2026-08-14; the manual walk moved to 8.5, see CO-38a) — plan: [m8.3 accessibility](2026-08-14-app-m8.3-accessibility-walk.md) (**verified 2026-08-14**: citations exact; gate discharged, §7.1. **CO-22 closes offline** — `login()` is chain-free, so an authenticated session is fabricated through the app's own public login path with no injection seam, no session backdoor and no role column; role-bearing renders come from a `toolingOnly` MSW knob reachable only under `NVHASH_MOCK=1`. Three corrections to the row's assumptions: the app uses **no `next-themes`** (hand-rolled cookie theme) and **no `recharts`** — so **app-spec §11's "Recharts renders" is a stale spec/code parity defect** this PR fixes — and M6.2 deviation 1's "no session because no wallet" premise was never structural). Scope: both themes, keyboard-only pass, reduced-motion audit, fixes — **including the authenticated surfaces the offline axe suite never covered** (alerts settings, portfolio, operator, admin: M6.2 deviation 1), and the §14.4 "coming soon" shells, which must survive this pass as labeled states. | 8.0a | ≈20 |
| 8.4a | **Migration-mode entry point (decision + change)** — plan: [m8.4a migration mode](2026-08-14-app-m8.4a-migration-mode.md) (**verified 2026-08-14**: every source citation exact; **pre-build refinement gate discharged the same day** — Q1–Q7 all resolved as recommended, §7.1. Ready to build). As specified in the master plan row: (i) contract upgradability + wasmd admin holder (irreversible; §6 D21), (ii) both Prisma schemas leave baseline mode, (iii) the reset-and-rebuild rule replaced by the migration rule in `services/indexer/CLAUDE.md`, `apps/web/CLAUDE.md`, `indexer-design-notes.md` in the same change. If D21/D25/D29 decide contract changes, they land here as one pre-audit contracts PR with the required drill + spec §12 amendment. | decision; blocks 8.4 | ≈12 (+contracts) |
| 8.4b | **Console testnet-readiness tranche** — plan: [m8.4b console testnet readiness](2026-08-14-app-m8.4b-console-testnet-readiness.md) (**verified 2026-08-14**: every source citation exact; **pre-build refinement gate discharged the same day** — Q1–Q7 all resolved as recommended, §7.1, with two `[VERIFY]` chain-behavior items left open by design for devnet. Two of this row's premises were corrected — see CO-25. Ready to build). The console follow-on pair the App has depended on since M4.1: entity-level verify anchors (**recording §14.13 in console-spec §14 in the same change** — the item exists today only in app-spec), the governance panel + the App's `governance` verify-link target (one pair, M7 D8), the **extension-wallet adapter** (`wallet.tsx` throws today; re-add only the needed `@cosmjs/*` packages at current audited versions per the recorded `elliptic`-advisory constraint), the stale 1905nhash gas price (flat-fee chain fact: 1 nhash), CSP `connect-src` mechanism for per-environment LCD hosts, and console §14 items 5–7 (epoch backfill, admin exec path, moniker/identicon policy) resolved in its plan. | 8.0a | ≈45 |
| 8.4 | **Deployment configs + testnet pilot**: Docker images per component, ArgoCD, per-environment profiles; per-environment secrets/config posture (§6 D24: VAPID key pairs, `WALLETCONNECT_PROJECT_ID`, `EXPLORER_URL`, `CONSOLE_URL`, LCD hosts); webfont self-hosting via build-time fetch (no binaries in git); bootstrap scripts encoding the ledger's per-environment requirements (receipt-marker **Transfer** grant, NAV-authority rotation, **group + policy created before instantiate** — there is no admin-rotation message); and an early store-gas measurement of the ~639 KB artifact on testnet (the ≈4.26 M-gas upload vs a possible 4 M cap is a candidate mainnet blocker — measure it in Phase A, not at 8.5). | all Phase A; 8.0 for release certification (pilot may run pre-release with the feature-probe caveat displayed); 8.4a; 8.4b | ≈40 |

Phase B (W1/T1/S1) and Phase C (8.5) are checklist-driven rather than
PR-shaped; their ledgers are §5 and the liquid-staking-spec §14 launch
checklist. 8.0 becomes a PR when the release cuts (re-capture + diff + suite
runs + version pin); 8.5 becomes one or more PRs when Phase B's exit criteria
are green.

**Lane notes.** 8.0b/8.1/8.2/8.3/8.4b are genuinely independent of each other
(different components; 8.4b is console-only). The M6/M7 lesson stands: whether
they *run* parallel is a staffing call. 8.4a is a decision plus a mostly
mechanical change and can be settled any time in Phase A, but the §2 contract
freeze means its contract half should be decided **early**, not at the 8.4
deadline.

## 4. Carryover register — unresolved M0–M7 tasking

Compiled 2026-08-05 by a full sweep of `docs/plans/`, `docs/specs/`,
`contracts/IMPLEMENTATION-STATUS.md`, area `CLAUDE.md`s and the design notes.
Zero TODO/FIXME markers exist in tracked source — these ledgers are the only
inventory. Each row proposes a disposition; **the 8.0a review ratifies or
overrides each one**. IDs are stable for that review's minutes.

### 4.1 Verified already resolved — propose CLOSE (no M8 action)

| ID | Item | Evidence |
| --- | --- | --- |
| CO-1 | Contracts CI job absent (E-CAL closing note) | `.github/workflows/contracts-ci.yaml` exists (PR #26) |
| CO-2 | Height-pinned smart-query home (m2.0/m2.2 §6) | Settled moot, master plan rev 9 (runtime type-strip constraint) |
| CO-3 | `SlashingClient` home (m2.3 §6) | Closed unnecessary, rev 9 (contract's own `uptimeBps`) |
| CO-4 | Standalone PR 2.0 question; synthetic-PK blessing (m2.0/m2.1) | Delivered/blessed at the M2 merges |
| CO-5 | `/validators` endpoint home wording (m3 §7) | Settled rev 14 (owned by 3.1; §9.4 amended) |
| CO-6 | Assertion wire format alignment (m3 §7) | Recorded in ADR-001 Decision 2 + spec §9.4 at rev 16 |
| CO-7 | Migration tranche-1 file moves (MT §5) | Homes populated by M2–M7 work (`contracts/drills/`, `infra/devnet/*`) — verify listing at review |
| CO-8 | Master plan §5 says §14.9 still DECIDE | Stale row: app-spec §14.9 is DECIDED 2026-07-15 (`en` only). Corrected in this change; 8.5 keeps a confirmation line only |

### 4.2 Scheduled into M8 rows

| ID | Item (origin) | Source | → M8 home |
| --- | --- | --- | --- |
| CO-9 | Prisma dual-generate race — explicit generator `output` (M7.5–7.6; also the durable fix behind M6.3's two-step deletion note) | 7.5–7.6 plan §10.4; `apps/web/CLAUDE.md` | 8.0b |
| CO-10 | Web switch to shared `navHashPerShare` helper (M3) | m3 §3.1; app-spec §9.5 note | 8.0b |
| CO-11 | Web-only collection bounds (`/validators`, `/portfolio.active_redemptions`, `/market`) join `bounds.ts` (M7.1) | 7.1 plan §3.5 | 8.0b |
| CO-12 | `cargo audit`/`pnpm audit` release gates in CI (M0-era tail) | `SECURITY.md` §Dependencies | 8.0b |
| CO-13 | Reconciler alarm drill was unit-level precursor only (M2.5) | m2.5 §3 gate 1 | 8.1 (core scope) |
| CO-14 | Drill → notifier tick → bell chain never driven end-to-end live (M6.2) | m6.2 §3 deviation 2 | 8.1 |
| CO-15 | Governance live-transport suite env-gated, outside default CI (M7.1) | `indexer-design-notes.md` | 8.1 (scheduled live lane) |
| CO-16 | `E2E_LIVE_GOV_MEMBER_KEY` unprovisioned; propose/vote live legs skip (M7.3–7.4) | 7.3–7.4 plan §10.2 | 8.1 |
| CO-17 | `group_policy_info` 404-vs-500 claim carried as unverified live assertion (M7.2) | 7.2 plan §3.4 R2 | 8.1 (resolves when the live spec runs) |
| CO-18 | Live-run stale-bundle trap (compose `web` builds at container start) (M4-era) | `web-design-notes.md` | 8.1 (harness process fix) |
| CO-19 | Jail flows have no e2e-live coverage; `jail-drill.sh` needs a dedicated chain (M6.4) | m6.4 §7 Q4 | 8.1 plan decides: dedicated-chain scheduled lane vs recorded gap (§6 D30) |
| CO-20 | Holder-lifecycle fold superlinear + uncached on `/admin` (M7.5–7.6) | `api-design-notes.md`; 7.5–7.6 §10.4 | 8.2 (measure; materialization is the recorded contingent remedy) |
| CO-21 | Accepted seq scans + `operatorPaymentTotalsFor` planner flip + deep `OFFSET` (M6.4) | `services/api/CLAUDE.md` | 8.2 (re-measure only; no speculative indexes) |
| CO-22 | Authenticated surfaces missing from offline axe route list (M6.2) | m6.2 §3 deviation 1 | 8.3 |
| CO-23 | "Coming soon" shells must survive a11y/degradation passes as labeled states (M4/M5) | app-spec §14.4 | 8.3 + 8.1 |
| CO-24 | Incident severity mapping vs console §11.2 confirmation (M2.5) | m2.5 §6 | 8.4b (console side) / 8.0a ratify |
| CO-25 | Console: §14.13 entity anchors not recorded in console-spec §14; governance panel + `governance` verify target; extension-wallet adapter absent; CSP `connect-src` list (M4→M7 accumulation) | console-spec; `apps/console/CLAUDE.md`; m7 D8 | 8.4b (core scope) |
| | **Two corrections from 8.4b's verification (2026-08-14).** The *"stale 1905nhash gas price"* item this row used to carry is **already fixed** — removed 2026-07-27 in PR #22; `1905` survives only as comments documenting the removal, and there is no `gasPrice` knob to restore. And the *"cosmjs `elliptic` constraint"* framing is obsolete: `apps/web` ships the same vendor with **zero** `@cosmjs/*` packages, so 8.4b mirrors that stack and the `SECURITY.md` reviewed-dependency event **resolves to the empty set** rather than to an audited re-add. | | |
| CO-26 | Per-environment provisioning: VAPID pairs (M6.3), `EXPLORER_URL` (M6.1), `WALLETCONNECT_PROJECT_ID` (M5.1), LCD/CSP hosts | m6.3 §7 Q1; m6.1 §7 Q4; runbook §Setup | 8.4 (§6 D24) |
| CO-27 | Webfont self-hosting (type stack), no binaries committed (M4-era) | app-spec §11; `web-design-notes.md` | 8.4 (build-time fetch) |
| CO-28 | Bootstrap requirements per environment: receipt-marker Transfer grant, NAV-authority rotation, group-before-deploy (M7 F2) | `IMPLEMENTATION-STATUS.md` §1; m7 §2 F2 | 8.4 (deploy scripts encode them) |
| CO-29 | Artifact store gas: ~639 KB ⇒ ≈4.26 M gas vs possible 4 M mainnet cap (contracts ledger) | `IMPLEMENTATION-STATUS.md` §3 | 8.4 (measure on testnet) → 8.5 (confirm mainnet) |
| CO-30 | Corpus regeneration blocked: `generate-corpus.sh` cannot complete on a mid-month fresh chain (E-CAL constraint, M7.2 record); three operator fixtures sit in `manifest.partial_captures` (M6.4); no App-built governance tx captured — canonical goldens are hex (M7.3–7.4); batched pure-`pay_tip` shape unexercised (indexer notes); byte-golden `body_bytes`/`auth_info_bytes` emission (M5 §7 Q1) | 7.2 plan §3.4 R1; m6.4 commit A note; 7.3–7.4 §10.2; m5 §7 | 8.0 (the release re-capture is a full-reset capture; its plan must first unblock the E-CAL boundary constraint — accelerated clock or scheduled boundary window) |
| CO-31 | Reorg-handling posture (depth 0, instant finality) re-vet against released build (M2.1) | m2.1 §7 | 8.0 |
| CO-32 | `provwasm-test-tube` upgrade so the money path runs in CI — closes the "NOT covered" headline (contracts ledger) | `IMPLEMENTATION-STATUS.md` §4 | 8.0 (gated on the same upstream release) |
| CO-33 | Gov-drill extensions: non-zero `min_execution_period` execution-window case (+ does an ACCEPTED proposal survive a policy update); attempt to produce `PROPOSAL_STATUS_ABORTED` (M7.1/M7.3–7.4) | 7.3–7.4 §10.5; manifest gap | 8.0 (drill + re-capture) |
| CO-34 | Wallet certification runbook never executed — results table all `—`, both vendors (M5.1) | runbook §Results | Phase B W1 (any FAIL reopens §14.1) |
| CO-35 | Live-chain verify items: LCD/CORS posture, gas envelopes (`RunEpoch` continuations near the cap), valoper derivation incl. operator-key ≠ account-key and consensus-key rotation, flat-fee re-confirmation, chain-facts re-measurement (devnet-provenance sections), governance execution-window observation, calendar-month boundary observations, manual push check (M2–M7 accumulation) | console-spec §14 items 2–4; `chain-facts.md`; `apps/web/CLAUDE.md`; e-cal plan | Phase B T1 (§5) |
| CO-36 | Third-party audit (contract + bridge-adapter authorization; NAV-authority grant in scope); MDX/§5.4 trust panel gains the audit report when it exists (M4.2 follow-on) | `SECURITY.md`; liquid-staking-spec §12; m4.2 §6 Q2 | Phase B S1 → 8.5 (publish) |
| CO-37 | Launch checklist: live mainnet params (unbonding_time, MaxEntries, concentration options, slashing window, exchange fees, gas cap), `withdrawal_delay_seconds` pinning ≤ 60 d, commission/threshold/margin sizing, `min_capture_interval_secs` re-derivation + keeper standup per runbook, marker metadata + attribute grants, uniform-commission enforcement confirmation (spec §17.2 R3 tail — note its "§14.14" cross-reference is dangling and needs a spec fix) | liquid-staking-spec §14 checklist, §17.2; `IMPLEMENTATION-STATUS.md` §2–3 | 8.5 |
| CO-38a | **The manual screen-reader accessibility walk** — deferred out of 8.3 on 2026-08-14 (that plan's §7.1 Q5) and rehomed here, so 8.5 runs it with the NVDA/Windows leg it already scheduled rather than splitting the two screen readers. **8.3 delivers automated coverage only**, and a green axe suite is not a completed accessibility review: scanning cannot judge reading-order coherence, label ambiguity, focus management through the transaction confirm dialog, or whether live regions actually announce the degradation and caveat states. | 8.3 §7.1 Q5 → 8.5 |
| CO-38 | §14.14 domain decision; §14.9 confirmation line; footer docs link (needs a hosted docs URL — with the `docs/user/` runbook); hosting/team-only-vs-public posture with console §14 item 8 | app-spec §14.14; m4.1 §6 | 8.5 (+ 8.4 for testnet exposure posture) |

### 4.3 Ratifications — shipped-as-proposed; confirm in bulk at the 8.0a review

| ID | Item | Source |
| --- | --- | --- |
| CO-39 | `participant_count` = distinct addresses across all kinds (vs depositors-only) | m3 §7 |
| CO-40 | M6.2's six open ratifications: `redemption_update` granularity; evaluation population = `address_activity` presence; incident→kind mapping; 90 d/180 d retention sweeps; `nav_step_posted` default-off; index-migration ride-along | m6.2 §7 Q1–Q6 |
| CO-41 | M6.3's push posture: at-most-once delivery, per-address subscription cap | m6.3 §7 Q2/Q4 |
| CO-42 | M6.1's: transfer-exclusion semantics (pins §9.5.1), CSV full-history amendment, 200-marker cap, no selectable windows in v1 | m6.1 §7 Q2/Q3/Q6/Q7 |
| CO-43 | M6.4 deliberate scope: peer-rank context absent (asserted by test); `operator_payments.epochIndex` nullable-and-unwritten; net-benefit "rewards earned" a labeled estimate | m6.4 §7 Q5/Q2, commit notes |
| CO-44 | Pruned-chain retention caveat (M2.2) — confirm the spec note actually landed; add it if not | m2.2 §6 |

### 4.4 Deferred post-v1 — confirm the recording, no M8 work

| ID | Item | Recorded in |
| --- | --- | --- |
| CO-45 | The **§14.3 cluster** (largest single deferral): PR 2.4 market/bridge samplers, `MarketDepthBand` producer, NAV-vs-market pairing, `market_spread` alert kind, portfolio market value, bridge-config governance template, DEX exit path. All gated on the external NUVA bridge deployment; enabling is a spec-recorded amendment, not a config toggle. M8's only obligation is CO-23 (shells survive the passes) | app-spec §14.3/§14.4; m7.3–7.4 §2.3 |
| CO-46 | Transfer kinds have no producing worker; `RedemptionRow.estimates` has no producer; cost basis for `transfer_in` decided with its worker | m3 §3.3; m6.1 §7 Q2 |
| CO-47 | Per-settlement validator trend/churn endpoint; numeric compare-to-self-staking baseline; animated hero pipeline; literal per-epoch payout cohort; capture-signal series + third upkeep distribution; public Learn funnel view; rewards-earned precise attribution; incident resumed/closed notifications; SW copy into i18n catalog (rides first added locale); live push-service stand-in | app-spec §8 notes; m4.2/m4.4/m5/m6.x/m7.5–7.6 plans |
| CO-48 | E-CAL configurable cadence (quarterly/annual) — separate accepted spec modification with knock-ons | e-cal design plan §5 |
| CO-49 | Contract: capture-signal incentive (optional unless voluntary participation proves insufficient); bridge integration (external, post-adapter-audit) | `IMPLEMENTATION-STATUS.md` §2 |
| CO-50 | Console: multi-endpoint cross-checking (single LCD trust root stands) | console-spec §12/§17.3 |

### 4.5 Decisions required (feed §6)

| ID | Item | Decision |
| --- | --- | --- |
| CO-51 | Contract-side pre-audit set: migrate entry point + wasmd admin (D21); `REDEMPTION_MARGIN_BPS` admin-configurable per the 2026-07-09 simulation finding (D29); `ReceiptAccounting` query (D29); dual-policy split now-or-per-deployment (D25) | §6 |
| CO-52 | Persona-review action register: all 16 items still read OPEN in-file; most are resolved by delivered App work (A1→M4.2, A2→M5, A4→M7.5, D1/D2→M6.2–6.4). 8.0a annotates resolved-by rows in that file; genuinely open residue (B1/B2 actor-model alignment, C2/C3, E1–E5 doc alignment, F1) is dispositioned at the review — most are spec-alignment edits to schedule with 8.5's doc pass | that register |
| CO-53 | M6.4 jail e2e-live posture (CO-19) and the deferred reconciler kinds (D30) | §6 |

## 5. Certification checklist (Phase B exit criteria)

Phase C does not begin until every line is green or explicitly waived by a
recorded decision. Results are recorded where the repo already records them:
`IMPLEMENTATION-STATUS.md` with dates and builds, the runbook's results
table, spec revision notes, `chain-facts.md` provenance columns.

**8.0 — vault release vetting (hard gate, external clock):**

*Status 2026-08-13: the release exists (ProvLabs/vault v1.2.4, cut
2026-08-12) and the **contracts/devnet half is in flight** on branch
`upgrade-vault-version` —
[plan](2026-08-13-m8.0-contracts-vault-1.2.4-upgrade.md). The rows below stay
unticked: each also covers app-side work (fixture re-capture, suite re-runs)
that PR excludes, and its own drill coverage is partial until a session spans
a month rollover.*

- [ ] Formal vault release pinned; feature-probe language retired.
- [ ] Fixture corpus re-captured against the released build (full reset; the
      E-CAL boundary constraint resolved per CO-30) and diffed against the
      dev-build corpus; divergences resolved; `manifest.json` status flips
      from PROVISIONAL.
- [ ] Full suite green against the release: unit, property, fixture-decode,
      live-devnet drills (incl. the CO-33 gov-drill extensions).
- [ ] `provwasm-test-tube` upgraded; the money path runs in CI; the
      "NOT covered" headline rewritten truthfully (CO-32).
- [ ] Reorg/confirmation-depth posture re-affirmed (CO-31).
- [ ] Launch chain confirmed to ship this release.
- [ ] **Both 8.1 drill crons flipped on in this same change** (weekly stack
      lane, monthly jail lane). They land dispatch-only because
      `app-ci.yaml:8-12` keeps devnet-dependent work out of automated runs
      while the dev-node image carries the pre-release vault — this PR is
      what retires that rationale. Drills that exist but never run are the
      failure mode 8.1 was built to prevent, one level up. (8.1 §7.1 Q5.)

**W1 — wallet certification (§14.1 runbook):**
- [ ] Results table filled for all five items × Figure (mobile + extension)
      and Arculus (mobile), on testnet. Any FAIL reopens §14.1.

**T1 — testnet verification ledger (CO-35):**
- [ ] LCD/CORS posture of the program-operated node; `chain-facts.md` §lcd
      re-measured with testnet provenance.
- [ ] Flat-fee params re-confirmed (the 1 nhash fact is chain-configured).
- [ ] Gas envelopes calibrated per execute, incl. `RunEpoch` continuation
      near the per-tx cap and the 100-validator-bound profile.
- [ ] Governance execution window observed under a non-zero
      `min_execution_period` policy.
- [ ] valoper derivation verified, incl. operator-key ≠ account-key; consensus
      key rotation exercised or the risk recorded.
- [ ] At least one live calendar-month boundary observed end-to-end
      (epoch alignment, withdrawal-delay arithmetic) — the pause spans
      boundaries by construction.
- [ ] Web Push verified manually on the pilot (no CI stand-in exists).
- [ ] x/group prune/tally behaviors re-confirmed on the testnet build
      (`chain-facts.md` §x/group is single-build devnet provenance).

**S1 — security review + audit:**
- [ ] Security review of the full system against `SECURITY.md` (8.5's named
      gate, run during the pause, not at its end).
- [ ] Third-party audit of the staking contract + bridge-adapter
      authorization complete; findings resolved or accepted; report published
      to the §5.4 trust surface (CO-36). Bridging stays disabled regardless
      until the adapter audit (post-v1 anyway per §14.3/§14.4).

## 6. Decision register

Numbering continues from M7 (D1–D20). Blocking relationships are stated per
row; a consuming PR must not land before its row resolves.

| # | Decision | Blocks | Resolve by/at |
| --- | --- | --- | --- |
| **D21** | **Contract upgradability + wasmd admin holder** (master plan 8.4a(i)). Migrate entry point yes/no; who holds the admin that authorizes `MsgMigrateContract` (distinct from `InstantiateMsg.admin`). Irreversible per deployment. If yes: spec §12 trust-surface amendment + `IMPLEMENTATION-STATUS.md` + unauthorized-migrate drill in the same change. | 8.4, S1 (contract freeze) | early Phase A |
| **D22** | **Hosting, domain, environment exposure**: §14.14 domain; console §14 item 8; testnet builds team-only vs public. Testnet half needed at 8.4; mainnet half at 8.5. | 8.4 (testnet posture), 8.5 | 8.4 / 8.5 |
| **D23** | §14.9 confirmation line only — the decision is recorded (`en` only, 2026-07-15); 8.5 confirms no late reversal. | 8.5 | 8.5 |
| **D24** | **Per-environment secrets/config posture** (CO-26): where VAPID pairs, `WALLETCONNECT_PROJECT_ID`, `EXPLORER_URL`, LCD/CSP hosts live per environment, and the secret-store mechanism in the ArgoCD profiles. Constraint: `SECURITY.md` secrets-via-environment; nothing non-public client-side. | 8.4 | 8.4 plan |
| **D25** | **Dual-policy (`admin`/`ops`) split**: with no admin-rotation message, the split is fixed per deployment at bootstrap. Decide the testnet and mainnet group/policy topology before each deploy; the App is already set-valued and needs zero change. Membership + thresholds are launch-operations parameters (8.5). | 8.4 bootstrap, 8.5 | with D21 |
| **D26** | **§4b format v2 adoption** (§8): C7 gate-property check; C4 generated from loader inputs; attacker-gain line on §4 invariants. Proposed at M7 closure; ratified here as the design-review event. | all Phase A plans | 8.0a review |
| **D27** | **Testnet chain target**: which testnet, whether it ships (or will ship) the formal vault release, and the pilot's caveat labeling if it deploys pre-release (feature-probe status displayed, no certification claimed). | 8.4 | before 8.4 |
| **D28** | **Plan cadence**: per-PR plans at branch open (this §3) vs M7's all-at-7.0. | Phase A process | 8.0a review |
| **D29** | **Pre-audit contract tidy set** (CO-51): `REDEMPTION_MARGIN_BPS` admin-configurable (simulation recommends sizing ≥ expected epoch yield × unbonding fraction); `ReceiptAccounting` query (trivial); anything else the audit scoping surfaces. Whatever is adopted lands with 8.4a's contracts PR; whatever is declined is recorded as an accepted exception in the ledger. | S1 | with D21 |
| **D30** | **8.1 scope edges**: do the three deferred reconciler kinds (`vault_paused`, `jail_report`, `epoch_overdue` — each needs a live decoder) land inside 8.1; does jail e2e-live get a dedicated-chain scheduled lane or stay a recorded gap (CO-19). **DECIDED 2026-08-14 (Ira): `vault_paused` lands in 8.1; `jail_report`/`epoch_overdue` stay recorded unless the 8.1 plan finds them cheap** (it found `jail_report` cheap — the decoder already exists in-package — and `epoch_overdue` not, with evidence); **jail e2e-live gets a scheduled dedicated-chain lane**, not per-PR CI. | 8.1 | resolved |
| **D31** | **Carryover dispositions**: the §4 register wholesale — each CLOSE (§4.1), ratification (§4.3), and post-v1 recording (§4.4) confirmed or overridden. | milestone | 8.0a review |

## 7. `SECURITY.md` conformance across the milestone

"Enforced" means a mechanism plus a gating check, never a caller or topology
assumption. Per-PR invariants live in each Phase A plan's §4; this is the map
for what M8 newly touches.

| `SECURITY.md` requirement | Enforced by |
| --- | --- |
| Devnet keys are throwaway; drills point only at disposable chains | Unchanged for the dev stack. 8.4 extends the rule's intent to real environments: testnet/mainnet key material lives only in the per-environment secret store (D24), never in repo files, images, or compose profiles; deploy scripts read from the store and fail closed. Gating: a repo-scan check in `app-ci` (no non-placeholder secrets outside `.env.example` patterns) plus review of the 8.4 profiles |
| Secrets via environment only | The D24 mechanism in the ArgoCD profiles; bundle-secret check already gates web CI and runs unchanged against production builds at 8.4 |
| Enumerated trust surfaces; adding an admin capability is a spec-level event | D21: if a migrate path is adopted, `liquid-staking-spec.md` §12 + `IMPLEMENTATION-STATUS.md` amend in the same change, and a `contracts/drills/` drill asserts an unauthorized migrate is rejected and post-migrate cw2 version/state are intended — never a key-holding assumption (master plan §6 row) |
| Audit readiness: spec/code parity, reproducible verification, truthful status ledger | Every Phase B result recorded with date + build in the ledger it belongs to (§5 preamble); the "NOT covered" headline stays truthful until CO-32 closes it; contract freeze before S1 (§2) |
| Dependencies: `cargo audit`/`npm audit` before releases | 8.0b closes the "(CI enforcement to follow)" tail as CI gates; the cosmjs re-add in 8.4b is the recorded reviewed-dependency event (audited versions only, per `apps/console/CLAUDE.md`) |
| Data minimization — no new PII | M8 adds no schema columns except any 8.2-contingent materialization, which is an aggregate over already-indexed public rows and passes the existing schema-allowlist gates; load tests use synthetic addresses only |
| Never lie about state | 8.1 proves the honesty machinery under failure (its named purpose); a pre-release testnet pilot (D27) displays its feature-probe status rather than implying certification |
| APIs read-only and defensive | 8.2's rate-limit tuning is measured against the existing envelope/bounds harnesses — tuning changes limits, never removes a bound |

## 8. Completeness obligations for M8 (§4b v2)

M7's closure record (overview §7.5) is the input; this section is the format
Phase A plans use, pending D26.

- **C1 (natural keys & cardinality), C2 (wire bounds), C3 (concurrency),
  C6 (temporal spans)** — unchanged. Each changed implementations in M7 (C6
  was added by a real escape and still needs a second exercise).
- **C4 (state × affordance) — generated, not tabulated.** The M7.5–7.6
  leak happened on an axis the hand-written table did not have. A C4 cell is
  filled only by an enumeration over
  `record state × {each loader input: ok, unavailable}` derived from the
  loader's own inputs, with the missing-input case carried in the types
  (`Map | null`, not a flag) so consumers are forced by the compiler.
- **C5 (plane precedence)** — retained, still untested as a format; carries
  the M7.3–7.4 lesson that the affordance plane is not the display plane
  (`liveState` separate from `plane`).
- **C7 (gate property) — new.** For every C1–C6 cell whose remedy is a
  mechanism (a DB constraint, an atomic statement, a conditional write), the
  plan names the gating test **and states what breaking the mechanism would
  make fail**. "A suite running against an in-memory double" means the cell
  is unfilled. This is a check on gates, not a seventh space — the spaces
  were not what failed in the four 7.5–7.6 review rounds.
- **Attacker-gain line — new, on §4 not §4b.** Every §4 invariant that is an
  authorization or honesty control names **what an attacker gains if it does
  not hold**. This question collapsed three relay-guard conditions in a
  sentence at 7.3–7.4; asking it at plan time is cheaper than at review.
- **Nullable-gates-affordance review question** (7.3–7.4 §10.5b): for every
  nullable that gates an affordance, the plan states whether `null` means
  "no" or "unknown" and that it is treated conservatively.
- **Drill rule (§7.4)** — unchanged; it remains the strongest single item
  (four wrong assumptions caught in 7.1 that no table did). 8.1's drills and
  8.0's re-capture are this milestone's discovery phase.

## 9. The 8.0a documentation change

**Created (1):** this overview.

**Amended (1):**

- **[master plan](2026-07-13-app-implementation-plan.md)** — M8 table gains
  rows 8.0a/8.0b/8.4b (inserted, not renumbered — the 8.4a precedent); the
  phase note under the table; §3 map updated; §5's stale §14.9 row corrected
  and §14.13 row pointed at 8.4b; revision-log entry.

**Deferred to the 8.0a review itself:**
[persona-review-action-register.md](persona-review-action-register.md) gains
its resolved-by annotations (CO-52) once the §4 dispositions are ratified —
annotating it before ratification would record proposals as resolutions.
No spec is amended in this change: spec amendments belong to the PRs that
change behavior (8.4a's rule replacement, 8.4b's console §14.13 recording,
8.5's closures), per the same-change rule.

## 10. Revision log

*2026-08-05: initial overview, written as the PR 8.0a docs change. Sources:
full sweep of `docs/plans/`, `docs/specs/`, `contracts/IMPLEMENTATION-STATUS.md`,
area `CLAUDE.md`s and design notes for unresolved M0–M7 tasking (§4);
M7 overview §7.5 closure recommendations adopted as §8 pending D26. Phase
structure per Ira's direction: testnet deploy first, a certification pause on
external clocks, then the mainnet rollout.*
