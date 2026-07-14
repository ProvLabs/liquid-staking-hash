# nvHASH App Implementation Plan

**Status:** APPROVED 2026-07-13 (phasing reviewed by Ira; four adjustments from
review incorporated: (1) the App is one logical unit built as split components
— `services/indexer`, `services/api`, `apps/web` — not the spec's
single-deployable nuva shape; (2) `app-spec.md` is certified for implementation
as of the migration into this repository and its check against `SECURITY.md`
and PR review, so there is no separate certification gate; (3) parallelizable
work is flagged explicitly so multiple contributors can run concurrently;
(4) the plan is expressed at PR granularity, with PRs attributable to
milestones and milestones to the top-level **App epic**)
**Epic:** the nvHASH App — [`docs/specs/app-spec.md`](../specs/app-spec.md) (v1.0-RC1)
**Companions:** [`application-boundary.md`](../architecture/application-boundary.md),
[`console-spec.md`](../specs/console-spec.md), [`liquid-staking-spec.md`](../specs/liquid-staking-spec.md),
[`SECURITY.md`](../../SECURITY.md)

## 1. Component architecture (governing decision)

The spec's §6 describes the `nuva-app` single-deployable shape (SSR app,
API routes, and indexer workers in one codebase). This repository intentionally
splits those concerns, and **the split is the intended direction**:

| Component | Owns | Never does |
| --- | --- | --- |
| `services/indexer` | Chain/event ingestion, backfill, checkpoints, reconciler, incident derivation, market/bridge sampling; writes the indexed tables | Serve HTTP to users; hold keys; sign |
| `services/api` | Versioned read-only `/api/v1` over indexed data, freshness envelope (`{ data, meta: { chain_height, indexed_height, generated_at, source } }`), rate limiting | Writes of any kind; transaction submission |
| `apps/web` | SSR UI, live LCD reads (canonical plane), wallet/session layer, and the App's **own** state: sessions, alert rules, notification log, push tokens, aggregate counters | Touch indexed tables directly (reads go through `services/api`); hold keys; expose fund-moving endpoints |

Consequences the M0 ADR must pin down (and amend `app-spec.md` §6/§9.4 in the
same change, per the repo rule that spec and behavior move together):

- **Database topology:** one PostgreSQL instance, two ownership domains —
  indexed tables written only by the indexer and read by the API; app-state
  tables written only by the web app. Whether that is two schemas in one
  database or two databases is the ADR's call.
- **Personal reads:** `services/api` stays unauthenticated-read-only; address
  scoping for personal endpoints (`/portfolio`, `/transactions`) is enforced by
  `apps/web`'s session layer, which is the API's only caller for those routes.
- **The notifier** (alert evaluation on indexer ticks) is app-state machinery
  and lives with `apps/web` (worker process in that codebase), consuming the
  API/indexed data, not the indexer's internals.

Everything else in the spec (three-layer discipline within each component,
amount discipline, freshness labeling, chart honesty, trust model §12) carries
over unchanged.

## 2. Milestones and PRs

Notation: **[P]** marks PRs that can proceed in parallel with their siblings
once their listed dependencies are met. Every PR title should carry the epic
reference and its milestone (e.g. `app/M2: chain-events worker`). Each PR
lands with its own tests (see §4) and any spec/CLAUDE.md updates its behavior
implies — no "docs later" PRs.

### M0 — Groundwork (unblocks all lanes)

| PR | Scope | Depends on |
| --- | --- | --- |
| 0.1 | **ADR: App component architecture.** The §1 split, DB topology, personal-read auth path, notifier home. Amends `app-spec.md` §6/§9.4 and the `services/*/CLAUDE.md` command sections. | — |
| 0.2 [P] | **Devnet fixture corpus** (spec §14.2 VERIFY). Capture scripts driven by `contracts/drills/`: vault `MsgSwapIn`/`MsgSwapOut` shapes, swap/expedite/payout/refund event attributes, `RunEpoch` snapshot events, query response shapes. Fixtures land in a shared location consumed by both indexer decode tests and MSW mocks. | devnet up |
| 0.3 [P] | **Shared typed LCD client package** (contract + vault + staking + group queries, `BigInt` amount discipline), fixture-backed tests. | 0.2 for fixtures (can scaffold before) |

### M1 — Scaffolds & CI (three parallel lanes open here)

| PR | Scope | Depends on |
| --- | --- | --- |
| 1.1 [P] | **`services/indexer` scaffold:** TS project, Prisma multi-file schema for the indexed tables (§9.1) incl. `indexer_checkpoints`, migrations proven clean on an empty database, CI (typecheck, Vitest). | 0.1 |
| 1.2 [P] | **`services/api` scaffold:** `/api/v1` skeleton, the freshness envelope as a shared response type, zod-validated query params, rate limiting, CI + contract-test harness. | 0.1 |
| 1.3 [P] | **`apps/web` scaffold:** React Router 7 SSR, TS strict, Tailwind 4, shadcn/ui, `$lang+` i18n (en), Auto/Light/Dark themes, env config with boot checks (vault-address cross-check, console chain-id match), CI (typecheck, Vitest, Playwright, axe, palette validator), MSW harness wired to the 0.2 fixtures. | 0.1 |
| 1.4 | **Design tokens + brand pass** (§14.8): program-specific accent/status tokens over the nuva base, dataviz palette validated on both themes; packaged shared or web-local per the 0.1/0.3 decision. | 1.3 |
| 1.5 | **Local full-stack wiring** in `infra/devnet/`: Postgres + indexer + api + web against the dev node, one command up. This is the substrate for all later e2e. | 1.1–1.3 |

### M2 — Indexer & honesty machinery (services lane)

Per spec R1, the reconciler ships **in this milestone**, before any page exists.

| PR | Scope | Depends on |
| --- | --- | --- |
| 2.1 [P] | **chain-events worker:** vault/contract event ingestion → `transactions`, `redemption_requests`; idempotent upserts keyed (txhash, event index); **replay proof**: re-run from height 0 converges to byte-identical derived state. | 1.1, 0.3 |
| 2.2 [P] | **epoch-history worker + genesis backfill** → `epoch_snapshots`; per-(chain_id, contract) isolation. | 1.1, 0.3 |
| 2.3 [P] | **validator-sampler** → `validator_registry`, `validator_epochs` (uptime, eligibility, tip, commission, jail events). | 1.1, 0.3 |
| 2.4 [P] | **market-sampler + bridge-supply sampler** (viem) → `market_samples`, `bridge_supply_samples`. ⚠ Blocked on §14.3 VERIFY (pool addresses/pair/fee tier); until those land, build against recorded pool fixtures and a testnet pool config so the worker is done except for config. | 1.1 |
| 2.5 | **Reconciler + incident derivation + lag accounting:** indexed-vs-live deltas per §9.5.6, incident rules per §9.6, `indexed_height` vs `chain_height` exposure per stream; alarm proven by feeding a deliberately corrupted row and observing the incident open. | 2.1, 2.2 |

### M3 — Query API (services lane; contracts first)

Endpoint **contracts** (envelope + shapes) should be defined and mocked at the
start of this milestone so the web lane (M4) can build against MSW without
waiting for implementations.

| PR | Scope | Depends on |
| --- | --- | --- |
| 3.1 [P] | **Public program endpoints:** `/metrics`, `/epochs`, `/validators`, `/incidents` + envelope contract tests. | 1.2, 2.1–2.3 |
| 3.2 [P] | **Market endpoints:** `/market` (price, premium/discount, depth bands, supply split), venue+sample-time labeling in the envelope. | 1.2, 2.4 |
| 3.3 [P] | **Address-scoped endpoints:** `/portfolio`, `/transactions` (+ `?format=csv`), auth path per ADR 0.1. | 1.2, 2.1 |

### M4 — Public read surfaces (web lane; parallel with M2/M3 via MSW)

| PR | Scope | Depends on |
| --- | --- | --- |
| 4.1 | **Global chrome:** nav, banner slot (paused/halted/data-degraded), environment badge, footer freshness line, verify-link component (per-figure Console deep links, environment-locked), alerts bell placeholder. | 1.3, 1.4 |
| 4.2 [P] | **Learn page** (§8.1): hero + mechanism explainer with stepwise honesty, live proof strip, yield decomposition, security/trust posture (audit MDX content plane §5.4), incident history, exit explainer, CTA. Cold-start renderings for every below-threshold metric. | 4.1, 3.1 contracts |
| 4.3 [P] | **Validators public page** (§8.6 public view): set table/cards, set-health aggregates, Console verify links. | 4.1, 3.1 contracts |
| 4.4 [P] | **Market page + program history views** (§8.5): NAV-vs-market step/line pair, premium/discount explainer, depth, supply location; epoch trend views from `epoch_snapshots`. | 4.1, 3.1/3.2 contracts |

### M5 — Wallet & transacting flows (wallet lane; 5.1 can start alongside M4)

| PR | Scope | Depends on |
| --- | --- | --- |
| 5.1 [P] | **WalletConnect v2 + sessions:** pairing, nonce-signature session (HttpOnly/SameSite cookie), role detection re-checked on-chain per refresh. Consumes the §14.1 wallet-set decision. | 1.3 |
| 5.2 | **Transaction lifecycle framework** (§10.2): build → preflight (reasons on every disabled control) → simulate → confirm (consumer summary + exact JSON disclosure) → sign/broadcast → track, with optimistic pending rows and indexer fast-poll reconcile. | 5.1, 0.3 |
| 5.3 [P] | **Stake flow** (§8.3): inline education, amount entry with limits and vesting-lock preflight, preview at execution-time NAV, land-on-Portfolio. | 5.2 |
| 5.4 [P] | **Redeem & Exit** (§8.4): exit-path comparison table (guaranteed-vs-typical framing is normative), native redemption flow, redemption tracker (queue position, funded state, countdown), DEX path hand-off. e2e must render every terminal state — expedite, matured payout, unfunded-maturity refund — from real drill history. | 5.2, 3.3, 2.1 |

### M6 — Portfolio, alerts, notifier

| PR | Scope | Depends on |
| --- | --- | --- |
| 6.1 [P] | **Portfolio page + derived-metrics service** (§8.2, §9.5): position summary, effective-yield panel, accrual step chart with markers, transaction history + CSV export (consumes §14.11 cost-basis decision). Property tests per spec R3 (see §4). | 5.1, 3.3 |
| 6.2 [P] | **Alert rules + in-app notifications + notifier worker:** rule CRUD, evaluation on indexer ticks, `notifications` log, bell UI. Default-on rules per spec R2 (redemption matured/expedited; operator arrears). | 5.1, 2.5 |
| 6.3 | **Web Push channel** (§10.4, decision §14.7 recorded): per-browser opt-in, opaque revocable endpoint tokens, minimal payloads, deletion on opt-out/session delete. | 6.2 |
| 6.4 [P] | **Operator view** (`/validators/mine`, §8.6): participation economics, arrears loudness, Console deep-links on every obligation. | 5.1, 2.3, 3.1 |

### M7 — Governance & admin (two parallel sub-lanes)

| PR | Scope | Depends on |
| --- | --- | --- |
| 7.1 [P] | **Governance indexing + endpoints:** `x/group` stream → `gov_proposals`/`gov_votes`; proposal list/detail endpoints. | 2.x harness |
| 7.2 | **Governance center read UI** (§8.7): decoded proposals, tallies, per-member status, outcome history. | 7.1, 4.1 |
| 7.3 | **Vote/execute signing:** `MsgVote`/`MsgExec` through the 5.2 lifecycle, would-fail simulation before sign. | 7.2, 5.2 |
| 7.4 | **Template proposal composer** — scope gated on the §14.6 decision; if it resolves to vote/execute-only at launch, this PR moves post-v1. | 7.3, §14.6 |
| 7.5 [P] | **Admin analytics endpoints + dashboard** (§8.8): program health, holder/validator cohorts, upkeep timeliness, incident feed w/ acknowledgment; admin gate re-verifies group membership on-chain. | 3.1, 2.x, 5.1 |
| 7.6 [P] | **Aggregate funnel counters** (§14.10 taxonomy): first-party, aggregate-only stage tallies + the Learn funnel view; includes the executable no-per-wallet-keying test (§4). | 1.3 |

### M8 — Hardening & pilot

| PR | Scope | Depends on |
| --- | --- | --- |
| 8.1 [P] | **Degradation drills as e2e:** corrupt an indexed row → reconciler incident → surfaces flip to live-read + "history temporarily degraded"; kill the indexer → canonical values survive, history dims; kill the LCD → indexed values carry stale labels. | 2.5, M4 |
| 8.2 [P] | **Load test + rate-limit tuning** on the public API. | M3 |
| 8.3 [P] | **Accessibility walk** on both themes, keyboard-only pass, reduced-motion audit; fixes. | M4–M7 |
| 8.4 | **Deployment configs** (`infra/`: Docker images per component, ArgoCD, per-environment profiles) + **testnet pilot** alongside the Console — the verify-link contract is only testable with both deployed (needs console follow-on §14.13 for entity anchors). | all |
| 8.5 | **Mainnet launch checklist:** remaining §14 closures (naming/domain §14.14, locale set §14.9 confirmation), security review against `SECURITY.md`, runbook in `docs/user/`. | 8.1–8.4 |

## 3. Parallelization map

After M0+M1 land, three lanes run concurrently and only join at M5.4/M6:

```
M0 ─ M1 ─┬─ services lane:  2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4 → 2.5 → 3.1 ∥ 3.2 ∥ 3.3
          ├─ web lane:       1.4 → 4.1 → 4.2 ∥ 4.3 ∥ 4.4     (MSW until 3.x lands)
          └─ wallet lane:    5.1 → 5.2 ────────────→ 5.3 ∥ 5.4
                                          (5.4 also needs 3.3)
M6: 6.1 ∥ 6.2 ∥ 6.4 → 6.3
M7: (7.1 → 7.2 → 7.3 → 7.4)  ∥  (7.5 ∥ 7.6)      — can start once M2 harness + 5.1 exist
M8: 8.1 ∥ 8.2 ∥ 8.3 → 8.4 → 8.5
```

Practical staffing note: the web lane never blocks on the services lane —
API endpoint contracts are defined (and mocked) at the top of M3, and every
page is required to build offline against MSW. The wallet lane's 5.1 is
independent of both.

## 4. Automated testing plan

Each layer is introduced in the milestone that creates its subject and then
**gates every subsequent PR in CI** — no layer is a one-time exercise.

| Layer | Tooling | Introduced | What it proves |
| --- | --- | --- | --- |
| Unit | Vitest | M1 | `BigInt`/`Decimal(39,0)` amount math, scale-then-floor, formatters, preflight rules (paused/min-max/vesting), i18n key coverage |
| Property | Vitest + fast-check | M2, M6 | **Indexer idempotency** (replay from 0 converges; random restart points converge); **R3:** effective-yield and cost-basis math against the contract simulation suite's deposit/redeem traces (`contracts/` sim as trace generator) |
| Fixture / decode | Vitest + the M0.2 corpus | M2 | Every event/query shape the indexer decodes matches devnet-captured fixtures — a contract event change breaks tests, not production |
| API contract | Vitest supertest-style harness | M3 | Envelope shape (`meta.source`, heights) on every endpoint; zod bounds on every query param; rate-limit behavior; CSV column set |
| e2e (offline) | Playwright + MSW | M4 | Every page renders from mocks: content, banners, freshness labels, verify-link hrefs, **cold-start/below-threshold states**, chart honesty (step-after NAV present, no interpolation, "n/a" under minimum window) |
| e2e (live) | Playwright against the 1.5 stack + `contracts/drills/` | M5 | Fund-moving flows signed on devnet through full drill cycles; every redemption terminal state (expedite, matured, refund) rendered from real chain history |
| Security-executable | Vitest/CI checks | M1, M6, M7 | No secrets in client bundle beyond the §7 client-safe subset; analytics tables/counters never keyed by wallet/session/device; personal endpoints reject cross-address access; push-token deletion on opt-out |
| Accessibility | axe in Playwright + manual walk | M4, M8 | WCAG AA both themes, keyboard operability, reduced-motion |
| Visual/design | palette validator in CI | M1 | Both theme token sets pass the dataviz validation on every change |
| Degradation drills | Playwright scenarios (8.1) | M8 | The honesty machinery works under failure: reconciler alarm, indexer outage, LCD outage each produce the specified labeled degradation, never silence |
| Load | k6 (or team standard) | M8 | Public API under load with rate limits; indexer keeps lag under the DATA DEGRADED threshold during backfill |

CI gate summary per component: `services/indexer` — typecheck, unit, property,
fixture; `services/api` — typecheck, unit, contract; `apps/web` — typecheck,
unit, Playwright (offline suite), axe, palette validator, bundle-secret check.
The live-devnet suite runs on a schedule and on release branches rather than
every PR (drill cycles are minutes-long).

## 5. Spec §14 decisions → where they are consumed

| Item | Status | Consumed by |
| --- | --- | --- |
| §14.1 wallet vendor set | DECIDE — needed before 5.1; coordinate with console §14.1 | PR 5.1 |
| §14.2 vault msg/event shapes | VERIFY — resolved by PR 0.2 | 0.2, 2.1, 5.2 |
| §14.3 pool/bridge facts | VERIFY — external (NUVA bridge deployment) | 2.4, 3.2 config |
| §14.4 bridge transit UX | DECIDE — v1 assumption: hand-off, no in-app transit | 5.4 |
| §14.5 indexer transport/depth | DECIDE/VERIFY — resolved inside 2.1 (tx-search primary, ws optional) | 2.1 |
| §14.6 governance composer scope | DECIDE — needed before 7.4 only; 7.1–7.3 unaffected | 7.4 |
| §14.7 notification channels | DECIDED 2026-07-13 (Web Push, no email) | 6.3 |
| §14.8 design-system packaging | DECIDE — resolved by ADR 0.1 + PR 1.4 | 0.3, 1.4 |
| §14.9 locale set | DECIDE — `en` assumed; confirm at 8.5 | 1.3, 8.5 |
| §14.10 analytics taxonomy | DECIDE — needed before 7.6 | 7.6 |
| §14.11 cost-basis method + CSV columns | DECIDE — needed before 6.1 | 6.1 |
| §14.12 typical-payout sample threshold | DECIDE — needed before 5.4 copy finalizes | 5.4, 6.2 |
| §14.13 console entity anchors | FOLLOW-ON (console repo/area) — schedule with console work before 8.4 | 4.x verify links, 8.4 |
| §14.14 name & domain | DECIDE — launch decision | 8.5 |

Decisions are recorded where the repo already records them: architecture-shaping
ones as ADRs in `docs/architecture/`, the rest inline in `app-spec.md` §14 with
date and owner (the §14.7 entry is the pattern).

---

*2026-07-13: initial plan, approved phasing per Ira's review. Milestone/PR
numbering here is the reference for PR titles (`app/M<n>` prefix) and for
attributing work to the App epic.*
