# nvHASH App Implementation Plan

**Status:** APPROVED 2026-07-13 (phasing reviewed by Ira; four adjustments from
review incorporated: (1) the App is one logical unit built as split components
— `services/indexer`, `services/api`, `apps/web` — not the spec's
single-deployable nuva shape; (2) `app-spec.md` is certified for implementation
as of the migration into this repository and its check against `SECURITY.md`
and PR review — recorded in the spec's 2026-07-13 certification revision note,
amended in the same change as this plan per the spec-parity rule; unresolved
§14 items gate their consuming PRs (wired as blocking dependencies in §2, not
just mapped in §5); (3) parallelizable
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
- **Personal reads are authorized at the API, not by topology.** Address-scoped
  endpoints (`/portfolio`, `/transactions`) must enforce that the requested
  address is bound to an authenticated caller **inside the serving process**,
  regardless of network layout — either (a) they are served only by the web
  tier's session layer (the API does not expose them at all), or (b) the API
  requires a service credential from the web tier that carries the verified
  session address and rejects any request for a different address. "The web
  app is the API's only caller" is a deployment fact, not a control; the
  control is the cross-address-rejection contract test that gates
  `services/api` CI (§4). ADR 0.1 picks mechanism (a) or (b); it may not
  weaken the requirement (app-spec §12.3). Public program endpoints remain
  unauthenticated read-only.
- **The notifier** (alert evaluation on indexer ticks) is app-state machinery
  and lives with `apps/web` (worker process in that codebase), consuming the
  API/indexed data, not the indexer's internals.

Everything else in the spec (three-layer discipline within each component,
amount discipline, freshness labeling, chart honesty, trust model §12) carries
over unchanged.

**Upstream dependency status (2026-07-13, Ira):** the settlement-era vault
module (`AcceptAsset`, restricted-receipt settlements) exists only on vault
`main` — there is **no formal upstream release to pin yet**. A release is due
to be cut soon but has not been. Until then, "compatible vault" can only be
established by **feature probe** (the `AcceptAsset` capability is present ⇒
we are on a development build expected to contain compatible
implementations), not by version assertion. Consequences for this plan:

- Fixtures, event decoders, and transaction flows built against the dev build
  **pin our assumptions so drift is detectable; they do not certify
  compatibility.** Dependency language elsewhere in this plan should be read
  in that light.
- **No release of the App can be certified until the vault module's formal
  release exists and the full test suite passes against it** — this is the
  M8 PR 8.0 hard gate.

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
| 0.2 [P] | **Devnet fixture corpus** (spec §14.2 VERIFY). Capture scripts driven by `contracts/drills/`: vault `MsgSwapIn`/`MsgSwapOut` shapes, swap/expedite/payout/refund event attributes, `RunEpoch` snapshot events, query response shapes. Fixtures land in a shared location consumed by both indexer decode tests and MSW mocks. **Completeness is verified, not assumed:** the capture script checks the corpus against the full event inventory (swap in/out, enqueue, expedite, payout, refund, `RunEpoch` settlement) and fails if any terminal state is missing. Captured fixtures are **provisional against the pre-release vault** (§1 upstream status): they pin assumptions for drift detection and are re-vetted at PR 8.0. | a devnet vault deployment that passes the **settlement-feature probe** (`AcceptAsset` present ⇒ development build ahead of the latest formal vault release; no upstream version exists yet to pin — see §1 upstream status and `contracts/IMPLEMENTATION-STATUS.md`), not merely "devnet up" |
| 0.3 [P] | **Shared typed LCD client package** (contract + vault + staking + group queries, `BigInt` amount discipline), fixture-backed tests. | 0.2 for fixtures (can scaffold before) |
| 0.4 | **Containerized dev toolchain** (ADR-002, added 2026-07-14): all JS task execution in pinned containers via the repo-root `./dev` wrapper over `infra/dev/compose.yaml` — node/pnpm tools runner, disposable postgres (profile `db`), shared `nvhash-dev` network joined by the dev node. Host toolchain versions stop being load-bearing before M1 bakes commands into scaffolds and CI; PR 1.5's full-stack wiring extends this compose file rather than introducing a new mechanism. | 0.1 (workspace shape); amends M1 scaffold expectations (scripts run under `./dev`, CI uses the same images) |
| 0.5 | **PR quality gates in GitHub Actions** (added 2026-07-14): `app-ci` workflow running in the ADR-002 image — frozen-lockfile install (lockfile discipline per `SECURITY.md`), `pnpm -r` typecheck + test (new packages join automatically as M1+ scaffolds define scripts), the fixture-corpus completeness gate (`--check`), and shellcheck at warning severity over all tracked shell scripts + `./dev`. Devnet-dependent work (capture, drills) stays local/scheduled — the blockchain-dev image with the pre-release vault has no registry copy until PR 8.0 pins a release. | 0.4 |

### M1 — Scaffolds & CI (three parallel lanes open here)

| PR | Scope | Depends on |
| --- | --- | --- |
| 1.1 [P] | **`services/indexer` scaffold:** TS project, Prisma multi-file schema for the indexed tables (§9.1) incl. `indexer_checkpoints`, migrations proven clean on an empty database, CI (typecheck, Vitest). | 0.1 |
| 1.2 [P] | **`services/api` scaffold:** `/api/v1` skeleton, the freshness envelope as a shared response type, zod-validated query params, rate limiting, CI + contract-test harness. | 0.1 |
| 1.3 [P] | **`apps/web` scaffold:** React Router 7 SSR, TS strict, Tailwind 4, shadcn/ui, `$lang+` i18n (en), Auto/Light/Dark themes, env config with boot checks (vault-address cross-check, console chain-id match), CI (typecheck, Vitest, Playwright, axe, palette validator), MSW harness wired to the 0.2 fixtures. | 0.1 |
| 1.4 | **Design tokens + brand pass** (§14.8): program-specific accent/status tokens over the nuva base, dataviz palette validated on both themes; packaged shared or web-local per the 0.1/0.3 decision. | 1.3; **§14.8 packaging decision (blocking; resolved by ADR 0.1)** |
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
| 3.3 [P] | **Address-scoped endpoints:** `/portfolio`, `/transactions` (+ `?format=csv`), with in-process address authorization per §1 (mechanism fixed by ADR 0.1 — never assumed from caller topology); ships with the cross-address-rejection contract tests, which gate `services/api` CI from this PR on. | 1.2, 2.1, ADR 0.1 auth mechanism |

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
| 5.1 [P] | **WalletConnect v2 + sessions:** pairing, nonce-signature session (HttpOnly/SameSite cookie), role detection re-checked on-chain per refresh. Runs the §14.1 certification checklist against **both v1 vendors — Figure (WC v2 mobile + extension) and Arculus (WC v2 mobile)** — as its acceptance gate; the shared WC v2 path uses standard pairing/Cosmos-namespace methods only, vendor-specific workarounds live behind per-vendor adapter entries recorded in §14.1. | 1.3; §14.1 wallet-set decision (DECIDED + amended 2026-07-14: Figure + Arculus v1) |
| 5.2 | **Transaction lifecycle framework** (§10.2): build → preflight (reasons on every disabled control) → simulate → confirm (consumer summary + exact JSON disclosure) → sign/broadcast → track, with optimistic pending rows and indexer fast-poll reconcile. | 5.1, 0.3 |
| 5.3 [P] | **Stake flow** (§8.3): inline education, amount entry with limits and vesting-lock preflight, preview at execution-time NAV, land-on-Portfolio. | 5.2 |
| 5.4 [P] | **Redeem & Exit** (§8.4): exit-path comparison table (guaranteed-vs-typical framing is normative), native redemption flow, redemption tracker (queue position, funded state, countdown), DEX path hand-off. e2e must render every terminal state — expedite, matured payout, unfunded-maturity refund — from real drill history. | 5.2, 3.3, 2.1; **§14.4 DEX hand-off and §14.12 sample-threshold decisions (blocking)** |

### M6 — Portfolio, alerts, notifier

| PR | Scope | Depends on |
| --- | --- | --- |
| 6.1 [P] | **Portfolio page + derived-metrics service** (§8.2, §9.5): position summary, effective-yield panel, accrual step chart with markers, transaction history + CSV export (consumes §14.11 cost-basis decision). Property tests per spec R3 (see §4). | 5.1, 3.3; **§14.11 cost-basis decision (blocking)** |
| 6.2 [P] | **Alert rules + in-app notifications + notifier worker:** rule CRUD, evaluation on indexer ticks, `notifications` log, bell UI. Default-on rules per spec R2 (redemption matured/expedited; operator arrears). | 5.1, 2.5; **§14.12 sample-threshold decision (blocking, for payout-timing alert copy)** |
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
| 7.6 [P] | **Aggregate funnel counters** (§14.10 taxonomy): first-party, aggregate-only stage tallies + the Learn funnel view; includes the executable no-per-wallet-keying test (§4). | 1.3; **§14.10 taxonomy decision (blocking)** |

### M8 — Hardening & pilot

| PR | Scope | Depends on |
| --- | --- | --- |
| 8.0 | **Upstream vault release vetting (hard gate).** When the vault module cuts its formal release: pin the released version, re-capture the 0.2 fixture corpus against the released build, diff against the dev-build corpus, resolve any decoder/flow divergence, and re-run the full test suite (unit, property, fixture-decode, live-devnet drills) against it. Until this passes, everything vault-facing is compatible-by-feature-probe only (§1 upstream status) and **no App release can be certified**. | formal vault module release (external, timing not ours) |
| 8.1 [P] | **Degradation drills as e2e:** corrupt an indexed row → reconciler incident → surfaces flip to live-read + "history temporarily degraded"; kill the indexer → canonical values survive, history dims; kill the LCD → indexed values carry stale labels. | 2.5, M4 |
| 8.2 [P] | **Load test + rate-limit tuning** on the public API. | M3 |
| 8.3 [P] | **Accessibility walk** on both themes, keyboard-only pass, reduced-motion audit; fixes. | M4–M7 |
| 8.4 | **Deployment configs** (`infra/`: Docker images per component, ArgoCD, per-environment profiles) + **testnet pilot** alongside the Console — the verify-link contract is only testable with both deployed (needs console follow-on §14.13 for entity anchors). | all; **8.0 (release certification blocked until upstream vetting passes)** |
| 8.5 | **Mainnet launch checklist:** remaining §14 closures (naming/domain §14.14, locale set §14.9 confirmation), security review against `SECURITY.md`, runbook in `docs/user/`. | 8.0–8.4 |

## 3. Parallelization map

After M0+M1 land, three lanes run concurrently and only join at M5.4/M6:

```
M0 ─ M1 ─┬─ services lane:  2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4 → 2.5 → 3.1 ∥ 3.2 ∥ 3.3
          ├─ web lane:       1.4 → 4.1 → 4.2 ∥ 4.3 ∥ 4.4     (MSW until 3.x lands)
          └─ wallet lane:    5.1 → 5.2 ────────────→ 5.3 ∥ 5.4
                                          (5.4 also needs 3.3)
M6: 6.1 ∥ 6.2 ∥ 6.4 → 6.3
M7: (7.1 → 7.2 → 7.3 → 7.4)  ∥  (7.5 ∥ 7.6)      — can start once M2 harness + 5.1 exist
M8: (8.0 external gate) ∥ 8.1 ∥ 8.2 ∥ 8.3 → 8.4 → 8.5   (8.4/8.5 also gated on 8.0)
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

A workspace-level gate runs **from M0** (PR 0.5, `.github/workflows/app-ci.yaml`,
in the ADR-002 image): frozen-lockfile install, `pnpm -r` typecheck/test,
the fixture-corpus completeness check, and shellcheck. Component scaffolds
(M1) attach their suites to it by defining package scripts — the per-component
gates below describe what those suites must contain.

CI gate summary per component — the **security-executable layer is a standing
gate in every component's CI from the milestone that introduces each check**,
never a one-time audit:

- `services/indexer` — typecheck, unit, property (idempotency), fixture-decode;
  security-executable: no PII columns in migrations (schema lint against the
  `SECURITY.md` allowed-fields list), log-scrubbing check (no IP/device
  identifiers alongside addresses).
- `services/api` — typecheck, unit, envelope contract; security-executable:
  **cross-address rejection on personal endpoints** (from PR 3.3 on),
  query-param bounding (zod at every route), rate-limit behavior.
- `apps/web` — typecheck, unit, Playwright (offline suite), axe, palette
  validator; security-executable: bundle-secret check (nothing beyond the §7
  client-safe subset), analytics counters never keyed by wallet/session/device
  (from PR 7.6 on), push-token deletion on opt-out/session delete (from PR 6.3
  on), personal-route session-scope enforcement (from PR 5.1 on).

The live-devnet suite runs on a schedule and on release branches rather than
every PR (drill cycles are minutes-long).

## 5. Spec §14 decisions → where they are consumed

This table is a cross-reference, **not the enforcement**: every unresolved
item below also appears as a blocking entry in the dependency column of its
consuming PR in §2. A consuming PR must not land before its item is resolved
and recorded in `app-spec.md` §14.

| Item | Status | Consumed by |
| --- | --- | --- |
| §14.1 wallet vendor set | DECIDED 2026-07-14, amended same day (v1: **Figure** — WC v2 mobile + extension — **and Arculus** — WC v2 mobile, App-only — dual-vendor as WC v2 standards-conformance guard; console §14.1 resolved same change — Figure extension + devnet key mode; Keplr/Leap fast-follow behind the certification checklist, which PR 5.1 runs against both v1 vendors as its acceptance gate) | PR 5.1 |
| §14.2 vault msg/event shapes | VERIFY — **two-stage:** stage 1 captured 2026-07-14 (PR 0.2, provisional, `packages/fixtures`); stage 2 re-vets against the formal vault release (PR 8.0) | 0.2, 2.1, 5.2; release gate 8.0 |
| §14.3 pool/bridge facts | VERIFY — external (NUVA bridge deployment) | 2.4, 3.2 config |
| §14.4 bridge transit UX | DECIDE — v1 assumption: hand-off, no in-app transit | 5.4 |
| §14.5 indexer transport/depth | DECIDE/VERIFY — resolved inside 2.1 (tx-search primary, ws optional) | 2.1 |
| §14.6 governance composer scope | DECIDE — needed before 7.4 only; 7.1–7.3 unaffected | 7.4 |
| §14.7 notification channels | DECIDED 2026-07-13 (Web Push, no email) | 6.3 |
| §14.8 design-system packaging | DECIDED 2026-07-14 (ADR-001 Decision 4: web-local tokens, shared validation method, root pnpm workspace for shared packages); **brand pass DELIVERED 2026-07-17 (PR 1.4): web-local accent/status tokens, both themes validated by `check:palette` + `test/brand-tokens.test.ts`** | 0.3, 1.4 |
| §14.9 locale set | DECIDE — `en` assumed; confirm at 8.5 | 1.3, 8.5 |
| §14.10 analytics taxonomy | DECIDE — needed before 7.6 | 7.6 |
| §14.11 cost-basis method + CSV columns | DECIDE — needed before 6.1 | 6.1 |
| §14.12 typical-payout sample threshold | DECIDE — needed before 5.4 copy finalizes | 5.4, 6.2 |
| §14.13 console entity anchors | FOLLOW-ON (console repo/area) — schedule with console work before 8.4 | 4.x verify links, 8.4 |
| §14.14 name & domain | DECIDE — launch decision | 8.5 |

Decisions are recorded where the repo already records them: architecture-shaping
ones as ADRs in `docs/architecture/`, the rest inline in `app-spec.md` §14 with
date and owner (the §14.7 entry is the pattern).

## 6. SECURITY.md conformance

Where each `SECURITY.md` requirement binding on this plan is enforced —
"enforced" means a mechanism plus a CI-gating test, never a caller or
topology assumption:

| SECURITY.md requirement | Enforced by |
| --- | --- |
| Data minimization: no PII, no IP/device linkage to addresses (incl. logs) | Schema lint + log-scrubbing checks in indexer CI (§4); accepted exceptions (push tokens, first/last-seen) implemented exactly as scoped in PRs 6.3 / 5.1 |
| No custody, no signing in services | No fund-moving endpoint exists in any component (§1 ownership table); wallet lane (5.x) signs client-side only; 5.2's confirm step shows exact message JSON |
| Chain is source of truth; indexer input untrusted; idempotent replay | Fixture-decode layer (event shapes validated against captured corpus), replay-convergence property tests (PR 2.1), reconciler + incident machinery (PR 2.5) |
| APIs read-only and defensive: bounded params, rate limits, address scoping | zod bounds + rate limiting from scaffold PR 1.2; **in-process address authorization on personal endpoints** (§1, PR 3.3) with cross-address-rejection tests gating `services/api` CI |
| Secrets via environment only; nothing non-public in the client bundle | Bundle-secret check in web CI from PR 1.3; `.env.example` placeholders only |
| Never lie about state (freshness, labeled estimates) | Envelope contract tests (source/heights on every response), chart-honesty e2e assertions, M8 degradation drills |
| Spec/code parity: spec amended in the same change | Certification recorded in `app-spec.md`'s 2026-07-13 revision note (this change); every PR carries its own spec/CLAUDE.md updates — no "docs later" PRs (§2 preamble) |
| Devnet keys are throwaway; drills point only at disposable chains | PR 1.5 wires the full stack to `infra/devnet/` only; deployment profiles (PR 8.4) are the first non-devnet targets |

---

*2026-07-13: initial plan, approved phasing per Ira's review. Milestone/PR
numbering here is the reference for PR titles (`app/M<n>` prefix) and for
attributing work to the App epic.*

*2026-07-13 (rev 2): resolved the six findings from the PR #4 review — spec
certification recorded in `app-spec.md` in the same change; personal-endpoint
authorization made an in-process, CI-tested control (§1, PR 3.3); PR 0.2
prerequisite hardened to a verified settlement-era vault build with a
fixture-completeness check; §14 decision items wired as blocking dependencies
in §2 (PRs 1.4, 3.3, 5.1, 5.4, 6.1, 6.2, 7.6); CI gate summary now enumerates
the security-executable checks per component; §6 conformance table added.*

*2026-07-14 (rev 4): M0 PR 0.4 added per Ira's direction — containerized dev
toolchain (ADR-002) established before M1 so host machine state never leaks
into builds, tests, or CI; M1 scaffolds and PR 1.5 build on the
`infra/dev/compose.yaml` substrate.*

*2026-07-14 (rev 5): M0 PR 0.5 added per Ira's direction — the `app-ci`
GitHub Actions workflow puts the M0 quality gates on every PR (same image as
`./dev`); §4 notes the workspace-level gate that M1 component suites attach
to.*

*2026-07-13 (rev 3): upstream vault dependency status clarified per Ira —
`AcceptAsset` detection is a **feature probe against an unreleased development
build**, not a version pin; vault-facing fixtures and decoders are provisional
(assumption-pinning for drift detection). Added the §1 upstream-status note
and the M8 PR 8.0 release-vetting hard gate: no App release is certified until
the vault module's formal release exists and the full suite passes against it.
`app-spec.md` §14.2 amended to two-stage verification in the same change.*

*2026-07-20 (rev 6): M2 elaborated to per-PR working plans (one file per PR
under `docs/plans/`, dated 2026-07-20): `app-m2.0-indexer-shared-infra`,
`app-m2.1-chain-events-worker`, `app-m2.2-epoch-history-worker`,
`app-m2.3-validator-sampler`, `app-m2.5-reconciler-and-incidents`. Two decisions
recorded there: (a) a small **PR 2.0** shared-infra tranche (atomic
checkpoint/window helper, RPC transports the LCD client lacks — `block_results`,
`tx_search`, height-pinned smart query — the JSON-string attribute decoder, and
per-`(chain_id, contract)` isolation) is factored out ahead of 2.1–2.4 so the
`2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4` parallelism is real; and (b) **PR 2.4 (market +
bridge-supply sampler) is parked** — blocked on §14.3 (pool/bridge facts) and
with no bridged nvHASH/live DEX in v1 (`app-spec.md` §13), it is deferred until
§14.3 resolves, at which point it reuses the 2.0 infra. M2 PR rows above are
unchanged; these notes refine sequencing and scope. Per-PR delivery lines are
appended here as each M2 PR lands.*

*2026-07-20 (rev 7): **M2.0 delivered** — indexer shared runtime
(`services/indexer/src/runtime/{checkpoint,worker,streams}.ts`,
`decode/attributes.ts`, `transport/rpc.ts`): atomic block-window cursor,
two-phase worker loop, `(chain_id, contract)` isolation boot check, the
JSON-string attribute decoder, and the RPC/height-pinned transports; unit gates
Postgres-free. **M2.1 delivered** — the `chain-events` worker (dual-source
tx-search + `block_results` ingestion → `transactions`/`redemption_requests`,
redemption status lattice, running marker NAV, synthetic PKs for txless
EndBlocker rows), with a fixture-decode gate over the corpus and a fast-check
replay-convergence property (replay from 0 == resume from any height). Resolves
`app-spec.md` §14.5 (dual-source transport, confirmation depth 0). Adds
`fast-check` (dev), `RPC_URL`/`RECEIPT_DENOM` config + compose env. Next:
2.2/2.3 (parallel) then 2.5.*

*2026-07-21 (rev 8): **M2.1 review fixes** (PR #8, both Greptile P2s valid) —
`assertChainIsolation` made atomic (`upsert` + read-back, was a `findUnique`/`create`
race), and the chain-events collector now fetches block time only for heights
that produce events (type pre-pass, mirroring the block phase). **M2.2 delivered**
— the `epoch-history` worker → `epoch_snapshots`: tx-search locates `run_epoch`
cranks, a **height-pinned smart query** (`x-cosmos-block-height`) at each crank
height recovers the epoch the contract no longer retains (single-snapshot,
§13/§9.10), upsert by `epochIndex`; fixture-decode + fast-check convergence gates.
Resolves the §9.3 backfill mechanism + retention caveat. The recurring
"height-pinned query → promote into `@nvhash/chain-client`?" fork is **settled as
moot**: the indexer runs raw `.ts` on Node, which refuses to type-strip a `.ts`
under `node_modules` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, verified 2026-07-21), so
chain-client cannot be imported at runtime — smart-query decoders are a local
mirror (`decode/scalars.ts`, fixture-locked). Next: 2.3, then 2.5.*

*2026-07-21 (rev 9): **M2.2 open fork resolved** — height-pinned smart query
stays App-local (the runtime-import constraint above makes promotion moot).
**M2.3 delivered** — the `validator-sampler` worker → `validator_registry` +
`validator_epochs`. Design refinement vs the plan's "continuous sampler": it is
**anchored to epoch cranks and read height-pinned** (finalized per-epoch
economics, structurally a sibling of epoch-history) so it backfills and replays
deterministically. Combines contract `validators()`/`jail_reports()` with
x/staking moniker + program delegation (new generic `PinnedLcdClient.getAtHeight`);
`failingReasons` derived from status flags; registry enrollment set-once with
forward-deterministic departure marking. Fixture-decode + fast-check convergence
(incl. departures) gates. Uptime comes from the contract's own SigningInfo-derived
`uptimeBps` (contract §10.3), so no separate slashing reader is needed — the
`SlashingClient` open question is closed as unnecessary. Next: 2.5 (reconciler).*

*2026-07-21 (rev 10): **M2.5 delivered — M2 milestone complete.** The reconciler
(`services/indexer/src/reconciler/`) runs as its own loop independent of the
workers (survives an indexer outage, §12.1.3), comparing the chain's retained
latest snapshot against the indexed copy. `deriveActions` is a pure function of
the live/indexed planes → the `reconciler_runs` row + incidents to open/close,
applied in one transaction; the reconciler is the **sole writer of `incidents`**.
Delivered incident kinds: `reconciler_divergence`, `indexer_lag`,
`contract_halted` (closeable), `slash_write_down`, `redemption_refund`
(point-in-time). **Acceptance gate proven** by a Postgres-backed test (corrupt an
indexed row → incident opens; fix → closes), in the `db-grants` job. Per-metric
tolerances live in code and are **not env-tunable** (§12.1.3) — recorded in
`app-spec.md` §9.5.6/§12.1. Deferred fast-follow (need more live decoders):
`vault_paused`, `jail_report`, `epoch_overdue`, and the queue-length delta —
recorded in §9.6. The services-lane honesty machinery for M2 is now in place; M3
(query API) builds on it.*

*2026-07-21 (rev 11): **PR #9 review fixes** (three Greptile P2s, all valid).
(1) The reconciler now opens point-in-time incidents (`slash_write_down`,
`redemption_refund`) only for facts not already recorded, so per-pass work stays
bounded as history grows (was re-upserting the whole lifetime every 30 s).
(2) Cold-start lag now reports `indexedHeight = 0` instead of the chain head — an
empty checkpoint set must not read as "caught up" (§12.1); cold start stays a
distinct rendered state, not a DATA-DEGRADED incident. (3) Corrected misleading
decode-error path labels in `parseProgramDelegations`. Also fixed a stray NUL
byte that had crept into the incident dedupe-key separator (caught by the new
bounded-work test).*
*2026-07-21 (rev 12): **M4.1 delivered** (working plan
`app-m4.1-global-chrome`): the §8.0 global chrome in `apps/web`:
`app/chrome/chrome.server.ts` (root-loader ChromeState: paused/halted banner
from live vault `get` + `epoch_status`, degraded from status-envelope lag or
open `reconciler_divergence`/`indexer_lag` incidents, freshness meta), the
chrome components (nav, env badge, banner, alerts advert, freshness footer)
plus the environment-locked `VerifyLink` closed map, five honest stub routes so
the nav never 404s (all in the axe scan), and the server-only `API_URL` config
row (spec §7 amended). Gates added: `test/chrome-state.test.ts`,
`test/verify-link.test.ts`, and an e2e live-down server instance proving
"program status unavailable" with no fabricated banner. Deliberate deltas
recorded in the spec: footer docs link deferred (no docs URL exists) and no
`governance` verify target (console panel does not exist yet); both are
follow-ons, not dead links. Next: 4.2–4.4 render inside this chrome.*

*2026-07-22 (rev 13): **M4.2 delivered** (working plan
`app-m4.2-learn-page`): the §8.1 Learn page in `apps/web`, plus the
Learn-facing subset of the 3.1 contracts frozen first per the M3
contracts-first note (Carlton, 2026-07-22): `ProgramMetrics`/`EpochRow`/
`IncidentRow` in `@nvhash/api-types`, honest all-null `/api/v1/metrics` and
empty `/api/v1/epochs` scaffold routes in `services/api` under the
registry-driven contract harness, MSW mocks in the web tier. The page
assembles per-figure-degradable data in `app/learn/learn.server.ts` (BigInt
NAV/TVL math in `amounts.ts`, golden-value gated; `MIN_APR_EPOCHS = 2`
minimum-window rule), renders all seven §8.1 sections with cold-start
states, a dependency-free step-after NAV chart with table view, the typed
§5.4 trust module (pre-audit posture), and the incident feed. Gates:
`test/learn-data.test.ts`, `test/amounts.test.ts`, extended
envelope-contract suite, `e2e/learn.spec.ts`. PR 3.1's remaining scope:
implement derivations against the frozen shapes; add `/validators` (4.3)
and `/market` (3.2). Next: 4.3/4.4 in parallel.*

*2026-07-22 (rev 14): **M3.1 delivered** (working plan `app-m3-query-api`,
which also records the M3 delivery shape — 3.1/3.2/3.3 as three commits on
one services-only branch, one PR/CI cycle — and the folded-in review
resolutions [R1]–[R7]): the public program endpoints serve real indexed data.
`@nvhash/db-indexed` (client GENERATED from the indexer's canonical schema
via a second generator block; read-only enforced by the `api_reader` role,
not the client), the injectable `IndexedReader` port (unit/contract suite
stays Postgres-free; honest empty reader when no `DATABASE_URL`), envelope
heights from the latest `reconciler_runs` with non-`meta:` checkpoint
fallback, real `/metrics` (`participant_count` = distinct addresses across
all kinds) / `/epochs` (shared golden-pinned `navHashPerShare` lifted into
`@nvhash/api-types`; `EpochRow.nav` widened `string|null` for zero-share
epochs) / `/incidents`, and `/validators` + frozen
`ValidatorRow`/`ValidatorSetHealth` (endpoint owned by 3.1, amending the
rev-13 note; 4.3 consumes). `/status` reports the wired data source with real
heights. Gates added: populated + honest-empty contract cases,
`derive.test.ts`, and the DB-backed reader gate (`test:db`, real queries as
`api_reader`) joining the app-ci `db-grants` job. Spec §9.4 amended in the
same change. Next: 3.2 ∥ 3.3 on the same branch.*

*2026-07-22 (rev 15): **M3.2 delivered** (second commit of the
`app-m3-query-api` branch): `/api/v1/market` shape-complete and
honest-empty — `MarketSummary`/`MarketSample`/`MarketDepthBand`/
`BridgedSupplyRow` frozen in `@nvhash/api-types` ahead of the parked PR 2.4
sampler (§14.3), venue + `sampled_at` labeling in the payload,
`premium_discount_bps` signed/truncated against the **NAV current at the
sample's time** ([R6], §9.5(4); null before any settled epoch), `price`
pinned as nhash per whole nvHASH, bridged-supply-only split (local = live
plane, web's job — recorded §8.5 amendment), and stored `depthBands` JSON
boundary-validated on read (loud failure, provisional shape PR 2.4 must
match). Gates: derive units (signed bps, band validation, NAV-price cross-pin),
honest-empty + populated contract cases (the populated sample proves the
[R6] epoch selection), and market seeds in the `test:db` reader gate (JSONB
round trip, latest-per-chain, null premium pre-NAV). Spec §9.4 amended in
the same change. Next: 3.3 closes the branch.*
