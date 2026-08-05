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
| 5.4 [P] | **Redeem & Exit** (§8.4): exit-path comparison table (guaranteed-vs-typical framing is normative), native redemption flow, redemption tracker (queue position, funded state, countdown), DEX path hand-off. e2e must render every terminal state — expedite, matured payout, unfunded-maturity refund — from real drill history. | 5.2, 3.3, 2.1; §14.4 + §14.12 (both DECIDED 2026-07-15, app-spec §14 — no longer blocking) |

### M6 — Portfolio, alerts, notifier

| PR | Scope | Depends on |
| --- | --- | --- |
| 6.1 [P] | **Portfolio page + derived-metrics service** (§8.2, §9.5): position summary, effective-yield panel, accrual step chart with markers, transaction history + CSV export (consumes §14.11 cost-basis decision). Property tests per spec R3 (see §4). | 5.1, 3.3; **§14.11 cost-basis decision (blocking)** |
| 6.2 [P] | **Alert rules + in-app notifications + notifier worker:** rule CRUD, evaluation on indexer ticks, `notifications` log, bell UI. Default-on rules per spec R2 (redemption matured/expedited; operator arrears). | 5.1, 2.5; **§14.12 sample-threshold decision (blocking, for payout-timing alert copy)** |
| 6.3 | **Web Push channel** (§10.4, decision §14.7 recorded): per-browser opt-in, opaque revocable endpoint tokens, minimal payloads, deletion on opt-out/session delete. | 6.2 |
| 6.4 | **Operator view + operator transaction flows** (`/validators/mine`, §8.6, §14.6): participation economics and commission-standing loudness (three states — in arrears / current / **prepaid**), the per-epoch and per-payment history the Console cannot show with its §14.11 CSV export, **and all five operator actions as first-class App transaction flows** — pay commission, pay TIP, enroll, unregister, and the two-phase jailed purge — through the §10.2 lifecycle, carried by a **two-level** broadcast allowlist (§12.3 amendment). Console links remain on material figures as §12.2 *verify* links: verification, no longer the action path. | 5.1, 2.3, 3.1, 5.2; 6.2/6.3 by ordering |

> **Row 6.4 amended 2026-07-27 (scope decision, Ira 2026-07-24).** The original
> row — "participation economics, arrears loudness, Console deep-links on every
> obligation" — was written before §14.6 was decided on 2026-07-15, and was
> stale against it: §14.6 graduates the operator actions to first-class App
> transaction flows, "no half-implementation", superseding "every action lands
> in the Console". The row above is the delivered §14.6 scope; the decision and
> its reasoning are recorded in
> [`2026-07-24-app-m6.4-operator-view.md`](2026-07-24-app-m6.4-operator-view.md)
> §1. Two scope facts worth carrying forward: **peer-rank context is NOT
> delivered** (that plan's §7 Q5 was not approved — the public `/validators`
> page remains where the set is seen), and **admin program-ops remain
> outstanding** (halt/resume, pause/unpause, config) — they are absent from the
> relay's variant set and provably rejected by its matrix, so delivering them is
> a design-review event, not a config change.

### M7 — Governance & admin (two parallel sub-lanes)

| PR | Scope | Depends on |
| --- | --- | --- |
| 7.0 | **Planning & documentation:** the [milestone overview](2026-07-28-app-m7-governance.md) + one plan per PR (7.1–7.6), plus the four same-change doc amendments below. Resolves D3/D7/D9/D10 so no later PR starts on an open decision. | — |
| 7.1 | **Governance indexing + endpoints:** devnet `x/group` substrate + drill + fixtures; `x/group` stream → `gov_proposals`/`gov_votes`; proposal list/detail/policies endpoints. | 2.x harness; **devnet x/group substrate (none exists today)** |
| 7.2 | **Governance center read UI** (§8.7): decoded proposals, tallies, per-member status, outcome history. | 7.1, 4.1 |
| 7.3 ⟂ | **Vote/execute signing:** `MsgVote`/`MsgExec` through the 5.2 lifecycle, would-fail simulation before sign; carries the §12.3 relay amendment. | 7.2, 5.2 |
| 7.4 ⟂ | **Template proposal composer** (§8.7, §14.6): decoded admin-action templates with a config diff view, behind a three-level `MsgSubmitProposal` guard. | 7.3 |
| 7.5 [P] ⟂ ✅ | **Admin analytics endpoints + dashboard** (§8.8): program health, holder/validator cohorts, upkeep timeliness, incident feed w/ acknowledgment; admin gate re-verifies group membership on-chain. **Delivered 2026-07-31** with 7.6, as scheduled. | 3.1, 2.x, 5.1; **ADR-001 Decision 2 amendment (`admin:` scope)** |
| 7.6 [P] ⟂ ✅ | **Aggregate funnel counters** (§14.10 taxonomy): first-party, aggregate-only stage tallies. **Delivered 2026-07-31.** The "Learn funnel view" is **not** built: §8.8 puts the funnel behind `/admin` and a public view needs honesty labeling the admin panel does not (plan §7.1 Q6). | 1.3 |

⟂ marks rows **delivered as a paired PR**: 7.3+7.4 as
[m7.3–7.4 governance write path](2026-07-28-app-m7.3-7.4-governance-write-path.md),
7.5+7.6 as
[m7.5–7.6 admin analytics + funnel](2026-07-28-app-m7.5-7.6-admin-analytics-and-funnel.md).
The rows keep their numbers for attribution and for §5's cross-references; see
§3 for the pairing rationale and file counts.

> **Row 7.4 amended 2026-07-28 (M7.0 planning).** The original row — "scope
> gated on the §14.6 decision; if it resolves to vote/execute-only at launch,
> this PR moves post-v1" — was written before §14.6 was decided on 2026-07-15
> and is stale against it: §14.6 ships **template-scoped creation in v1** and
> states the App is "**not** vote/execute-only". Same defect and same fix as
> row 6.4's 2026-07-27 amendment. 7.4 stays in v1.
>
> **Row 7.1 dependency widened, same date.** There is no `x/group` anything on
> the devnet — `fixtures/queries/group/groups.json` is empty and
> `CONTRACT_ADMIN` defaults to a plain account — and the contract has **no
> admin-rotation message**, so the group and policy must be bootstrapped before
> deploy. Building that substrate, its drill and its fixture family is inside
> 7.1, which is why it is roughly twice its original size. Every developer
> resets devnet when it lands.
>
> **Row 7.6's blocking marker dropped, same date:** §14.10 is DECIDED
> 2026-07-28 (§5).

### M8 — Hardening & pilot

| PR | Scope | Depends on |
| --- | --- | --- |
| 8.0 | **Upstream vault release vetting (hard gate).** When the vault module cuts its formal release: pin the released version, re-capture the 0.2 fixture corpus against the released build, diff against the dev-build corpus, resolve any decoder/flow divergence, and re-run the full test suite (unit, property, fixture-decode, live-devnet drills) against it. Until this passes, everything vault-facing is compatible-by-feature-probe only (§1 upstream status) and **no App release can be certified**. | formal vault module release (external, timing not ours) |
| 8.1 [P] | **Degradation drills as e2e:** corrupt an indexed row → reconciler incident → surfaces flip to live-read + "history temporarily degraded"; kill the indexer → canonical values survive, history dims; kill the LCD → indexed values carry stale labels. | 2.5, M4 |
| 8.2 [P] | **Load test + rate-limit tuning** on the public API. | M3 |
| 8.3 [P] | **Accessibility walk** on both themes, keyboard-only pass, reduced-motion audit; fixes. | M4–M7 |
| 8.4a | **Migration-mode entry point (decision).** The row after which the program is no longer in complete reset-and-rebuild mode. Three parts land together. **(i) Contract upgradability** — decide whether `nvhash-staking` gains a `migrate` entry point (`contracts/src/contract.rs` exposes `instantiate`/`execute`/`query` only; the cw2 marker it already writes at instantiate is the version prerequisite such a path checks) and who holds the **wasmd contract admin** that authorizes `MsgMigrateContract` — a different authority from `InstantiateMsg.admin`, set by `--admin` at instantiate (`infra/devnet/bootstrap/nvhash-deploy-p2p.sh`, today the deployer key). A contract instantiated with **no** admin can never be given one, so the choice is irreversible per deployment and must be settled before anything is deployed that we intend to keep. A migrate path is a new **admin capability**: `liquid-staking-spec.md` §12 trust surface and `contracts/IMPLEMENTATION-STATUS.md` are amended in the same change, and the authorization is established by a devnet drill under `contracts/drills/` (an unauthorized migrate is rejected; post-migrate state and cw2 version asserted) rather than by reading wasmd's semantics — the `chain-facts` rule. **(ii) Database schemas leave baseline mode** — `services/indexer` and `apps/web` stop regenerating their single baseline migration and begin appending incremental ones. The trigger is the first environment whose contents cannot be recreated: `app` (sessions, notification log, push subscriptions) crosses it before `indexed`, which is rebuildable from chain by definition. **(iii)** The reset-and-rebuild rule in `services/indexer/CLAUDE.md`, `apps/web/CLAUDE.md` and `indexer-design-notes.md` is replaced by the migration rule in the same change, so no environment is left following stale instructions. | a decision, not code-blocked; **blocks 8.4** — nothing non-devnet deploys until it is made |
| 8.4 | **Deployment configs** (`infra/`: Docker images per component, ArgoCD, per-environment profiles) + **testnet pilot** alongside the Console — the verify-link contract is only testable with both deployed (needs console follow-on §14.13 for entity anchors). | all; **8.0 (release certification blocked until upstream vetting passes)**; **8.4a (the contract admin it deploys with is irreversible)** |
| 8.5 | **Mainnet launch checklist:** remaining §14 closures (naming/domain §14.14, locale set §14.9 confirmation), security review against `SECURITY.md`, runbook in `docs/user/`. | 8.0–8.4 |

> **Row 8.4a added 2026-07-30 (Ira's direction).** Every row before it assumes a
> complete reset and rebuild: each Prisma schema is ONE baseline migration
> regenerated from its models rather than an appended history (collapsed
> 2026-07-30), devnet is wiped whenever a change lands that needs it (the 7.1
> precedent), and the contract is redeployed rather than migrated. That is the
> right posture while nothing runs outside dev and CI, and it stops being right
> at the first environment whose contents cannot be recreated. 8.4 stands up the
> **first non-devnet targets** (§6), so the crossing has to be *decided before it
> deploys*, not discovered after — most sharply for the contract, where the
> wasmd admin is fixed at instantiate.
>
> Row numbering is unchanged: 8.4a is **inserted, not renumbered**, so §5/§6
> cross-references and PR-title attribution stay valid (the M7 precedent). Work
> after 8.4a should assume migrations, not rebuilds.

## 3. Parallelization map

After M0+M1 land, three lanes run concurrently and only join at M5.4/M6:

```
M0 ─ M1 ─┬─ services lane:  2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4 → 2.5 → 3.1 ∥ 3.2 ∥ 3.3
          ├─ web lane:       1.4 → 4.1 → 4.2 ∥ 4.3 ∥ 4.4     (MSW until 3.x lands)
          └─ wallet lane:    5.1 → 5.2 ────────────→ 5.3 ∥ 5.4
                                          (5.4 also needs 3.3)
M6: 6.1 → 6.2 → 6.3 → 6.4          (planned 6.1 ∥ 6.2 ∥ 6.4 → 6.3; ran serialized)
M7: 7.0 → 7.1 → 7.2 → [7.3+7.4]  ∥  [7.5+7.6]    — 4 PRs; 7.1 also needs a devnet x/group substrate
M8: (8.0 external gate) ∥ 8.1 ∥ 8.2 ∥ 8.3 → 8.4a → 8.4 → 8.5   (8.4/8.5 also gated on 8.0)
```

Practical staffing note: the web lane never blocks on the services lane —
API endpoint contracts are defined (and mocked) at the top of M3, and every
page is required to build offline against MSW. The wallet lane's 5.1 is
independent of both.

**M6 delivery ran serialized (recorded 2026-07-27).** The map planned
`6.1 ∥ 6.2 ∥ 6.4 → 6.3`; delivery was `6.1 → 6.2 → 6.3 → 6.4`, each merged
before the next began. Two reasons, both worth keeping in mind for M7's
sub-lanes: 6.4's arrears surface is what the 6.2 alert and its 6.3 push channel
point AT, so building it against merged alert behavior beat building it against
a parallel branch's assumptions; and 6.4 grew from a read view into a read view
plus five privileged write flows (§14.6), which made it the largest M6 PR rather
than a parallelizable leaf. The `[P]` marker on row 6.4 is dropped accordingly.

**M7 delivers its six rows as four PRs (recorded 2026-07-28).** Estimated
changed files against a ~70-file review ceiling: **7.0 + 7.1 ≈ 64** (branch 1),
**7.2 ≈ 27**, **7.3 + 7.4 ≈ 32**, **7.5 + 7.6 ≈ 50**. Row numbering is
unchanged — two plans each cover a numbered pair, the way the M3 plan covers
PRs 3.1–3.3 — so §5's cross-references and PR-title attribution stay valid.

Two rows were paired, both on cohesion rather than headroom. **7.3 + 7.4 are
the same guard:** the three-level `MsgSubmitProposal` shape was fixed at 7.0,
so staging it as present-but-provably-rejected across one intervening PR bought
nothing, and splitting would have had 7.4 immediately re-edit the guard files
7.3 had just written. Merged, the guard is written once, §12.3 is amended once,
and the rejection matrix is authored once. **7.6 feeds one of 7.5's six
panels:** split, 7.5 must ship a placeholder for the evaluator funnel and be
provably correct in either merge order — merged, that contingency disappears
and both `app`-schema tables land under one data-minimization review.

The break before 7.2 holds. Bundling it into branch 1 reaches ≈89; folding it
forward into the write-path branch reaches ≈55, under the ceiling but justified
only by headroom, and it would put the relay-guard review in the same PR as
decoded-message honesty and a11y — the 6.4 failure mode in miniature. Branch 1
ends at the frozen `@nvhash/api-types` governance shapes, the seam this section
already relies on: the web lane builds offline against MSW.

The `[P]` markers on 7.5/7.6 stand — that pair is genuinely independent of the
7.1→7.4 chain — but the M6 lesson above applies to whether it is *run*
parallel. Note also that 7.1 flips a switch for everyone: once `Config.admin`
is a real group policy, the previously-dead `groupPolicyInfo → groupMembers`
branch of `roles.server.ts` goes live in every environment, which is its own
reason to merge it alone.

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
| Security-executable | Vitest/CI checks | M1, M6, M7 | No secrets in client bundle beyond the §7 client-safe subset; analytics tables/counters never keyed by wallet/session/device (**gating `apps/web` CI from 7.5–7.6 on**: `test/app-schema-allowlist.test.ts` pins `FunnelCounter`'s columns at exactly `{stage, day, count}` and applies a per-model identifier denylist that `address` trips on this model though it is legitimate on `Session`; `test/funnel-counters.test.ts` reads every `recordFunnelEvent` call site from source and asserts it identifier-free); personal endpoints reject cross-address access (the `PERSONAL_PATHS` matrix is registry-derived since 6.4, so a new address-scoped route joins automatically); push-token deletion on opt-out; **the broadcast relay stays closed** — the 6.4 two-level allowlist's rejection matrix proves no `MsgExecuteContract` outside the six operator variants, on the configured contract, in canonical form, can be relayed; **operator ownership** — an unowned valoper answers honest-empty, indistinguishable from a nonexistent one, never a 403 that would reveal who operates what; **M7 governance additions** — the relay stays closed across the governance amendment (7.3's two-level matrix admits only `MsgVote`/`MsgExec` in canonical form with `MsgVote.exec` pinned, and 7.4's three-level matrix admits `MsgSubmitProposal` only when **every** inner message is an exact template instance, while the 6.4 direct-admin variants stay rejected throughout); **the mirror never claims chain state it no longer holds** — `x/group` prunes, so a 404 preserves the indexed row and stamps `prunedAtHeight` rather than deleting, and no verify affordance is offered for it (7.1); **admin capability is never served from a cached role** — minting an `admin:` assertion performs a fresh on-chain membership read and bypasses the 60 s role cache, so a revoked member's next request fails (7.5) |
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
| §14.4 bridge transit UX | DECIDED 2026-07-15 (deferred to post-launch; DEX/market surfaces ship as labeled "coming soon" shells; v1 exit is native-redemption-only in practice) | 5.4 |
| §14.5 indexer transport/depth | DECIDE/VERIFY — resolved inside 2.1 (tx-search primary, ws optional) | 2.1 |
| §14.6 governance composer scope | DECIDED 2026-07-15 (template-scoped creation ships in v1; the App is **not** vote/execute-only; free-form compose stays Console-only). Operator side IMPLEMENTED 2026-07-27 (PR 6.4); governance side **DELIVERED 2026-07-30** (PRs 7.3–7.4): template-scoped creation ships with four of the five §8.7 surfaces — bridge config is **absent, not stubbed**, since no contract variant backs it while §14.3 is unresolved — and admin program-ops reach the chain only as §8.7 templates, gated by the §12.3 amendment of the same date | DISCHARGED (row amended 2026-07-28 — the "may move post-v1" caveat was stale) |
| §14.7 notification channels | DECIDED 2026-07-13 (Web Push, no email) | 6.3 |
| §14.8 design-system packaging | DECIDED 2026-07-14 (ADR-001 Decision 4: web-local tokens, shared validation method, root pnpm workspace for shared packages); **brand pass DELIVERED 2026-07-17 (PR 1.4): web-local accent/status tokens, both themes validated by `check:palette` + `test/brand-tokens.test.ts`** | 0.3, 1.4 |
| §14.9 locale set | DECIDE — `en` assumed; confirm at 8.5 | 1.3, 8.5 |
| §14.10 analytics taxonomy | **IMPLEMENTED 2026-07-31 (PRs 7.5–7.6)**; DECIDED 2026-07-28, Ira (one `app`-schema `funnel_counters` table keyed `(stage, day)` with an integer count and no other columns; closed stage + page-class enums; incremented **server-side in the loader**; no cookie, no client script, no consent surface because nothing personal is collected; stated retention; totals labeled as events, not unique people). Shipped with four recorded deltas, all forced by the decision's own constraints: the page class folds into the stage enum rather than adding a column; the class set is three, not five (`learn_deep`/`spec_link` are not server-observable without the client script §14.10 forbids); `due_diligence_depth` is a load of `/validators` or `/market`, since scroll depth is not measurable at all; retention is 400 days. See app-spec §14.10. | 7.6 |
| §14.11 cost-basis method + CSV columns | DECIDE — needed before 6.1 | 6.1 |
| §14.12 typical-payout sample threshold | DECIDED 2026-07-15 (≥ 10 terminal requests, else the 60-day guarantee alone; epoch-metric cold-start rules; calendar-month cadence — E-CAL delivered 2026-07-22) | 5.4, 6.2 |
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
| No custody, no signing in services | No signing endpoint exists in any component (§1 ownership table); wallet lane (5.x) signs client-side only; 5.2's confirm step shows exact message JSON. The 5.2 web-tier broadcast relay carries only fully user-signed bytes under the app-spec §12.3 amendment (2026-07-23): closed msg allowlist, sole-signer = session address, size + rate caps — gated by `apps/web/test/broadcast-guard.test.ts` |
| Chain is source of truth; indexer input untrusted; idempotent replay | Fixture-decode layer (event shapes validated against captured corpus), replay-convergence property tests (PR 2.1), reconciler + incident machinery (PR 2.5) |
| APIs read-only and defensive: bounded params, rate limits, address scoping | zod bounds + rate limiting from scaffold PR 1.2; **in-process address authorization on personal endpoints** (§1, PR 3.3) with cross-address-rejection tests gating `services/api` CI |
| Secrets via environment only; nothing non-public in the client bundle | Bundle-secret check in web CI from PR 1.3; `.env.example` placeholders only |
| Never lie about state (freshness, labeled estimates) | Envelope contract tests (source/heights on every response), chart-honesty e2e assertions, M8 degradation drills |
| Spec/code parity: spec amended in the same change | Certification recorded in `app-spec.md`'s 2026-07-13 revision note (this change); every PR carries its own spec/CLAUDE.md updates — no "docs later" PRs (§2 preamble) |
| Devnet keys are throwaway; drills point only at disposable chains | PR 1.5 wires the full stack to `infra/devnet/` only; deployment profiles (PR 8.4) are the first non-devnet targets, gated on the 8.4a admin decision |
| Enumerated trust surfaces: every admin capability is listed in the spec, and adding one is a spec-level event | The contract exposes `instantiate`/`execute`/`query` and no upgrade path today. If PR 8.4a adds one, it lands as a spec amendment (`liquid-staking-spec.md` §12 + `contracts/IMPLEMENTATION-STATUS.md`, same change) plus a `contracts/drills/` drill asserting that a migrate from a non-admin is rejected and that the post-migrate cw2 version and state are what was intended — never "only the admin key can reach it" as a deployment assumption |

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

*2026-07-22 (rev 16): **M3.3 delivered — M3 milestone complete** (third
commit of the `app-m3-query-api` branch): the address-scoped endpoints
(`/portfolio?address=`, `/transactions?address=` + `format=csv`) behind the
ADR-001 Decision 2 in-process authorization, delivered as machinery: an
`auth.ts` verifier (HMAC-SHA256, constant-time compare, `exp − iat ≤ 60 s`,
[R7d] 10 s `iat` forward-skew bound, fail-closed without a key; wire format
recorded in the ADR-001 amendment and spec §9.4), a registry-declared
`auth` requirement per route, and the [R4]-pinned pipeline
(429→404→405→401→400→403→dispatch; bech32 bound on `?address=`).
`/portfolio` serves indexed facts only ([R2]: no balance field — the live
plane's job; `estimates` omitted, no producer). The CSV export carries the
§14.11 pinned column set with formula-injection guarding and [R3] X-header
freshness (recorded §9.4 deviation). **The cross-address-rejection suite
(`test/cross-address.test.ts`) is a standing `services/api` CI gate from
this change on** — A→B 403, absent/expired/mis-signed/future-minted 401,
`internal:notifier` on personal routes 403, public routes credential-free,
CSV under the same gate — plus address-plane seeds in `test:db`. Spec §9.4
+ ADR-001 amended in the same change. M3 exits on one branch as three
commits (3.1/3.2/3.3), one PR/CI cycle; next in the services lane: 8.2
load-testing when M8 opens.*

*2026-07-22 (rev 17): **M4.3 delivered** (working plan
`app-m4.3-validators-page`, reconciled with the M3 merge): the §8.6 public
validators page in `apps/web` (`app/validators/validators.server.ts`;
set-health strip and the consumer table with icon+label reliability on the
console §11.2 family). The live table joins contract `validators()` with
x/staking monikers and the asset-manager contract's delegations; the uptime
threshold comes from `Config {}`. Set-health aggregates consume PR 3.1's
`/api/v1/validators` (`ValidatorsPayload` `set_health`; only
total/active/eligible cross to the client). The per-settlement trend/churn
view has no serving endpoint and is a recorded follow-on (spec §8.6 note).
The client-crossing row is a closed public projection (no operator
economics; gated by `test/validators-data.test.ts`). Also fixes the
dev-profile `CONSOLE_URL` defaults (the console pins port 5273, not 5173,
so local verify links finally land). Gates: `test/validators-data.test.ts`,
`e2e/validators.spec.ts`. Next: 4.4 (market/history) on the delivered 3.2
contract.*

*2026-07-22 (rev 18): **M4.4 delivered; M4 milestone complete** (working
plan `app-m4.4-market-history`): the §8.5 Market page in `apps/web` as the
labeled v1 shell over the delivered 3.2 contract (three states: unavailable /
forthcoming / active sample; premium rendered verbatim from the API, null
never fabricated to 0; venue + sample-time labels on every market figure; NO
verify link on the market plane per §12.1 rule 4), local supply composed
live from vault `total_shares`, and the program-history views (NAV, TVV,
net APR per settlement) on real `/epochs` data via a shared step-chart
extracted from the Learn chart (`app/components/charts/step-chart.tsx`).
Gates: `test/market-data.test.ts`, `e2e/market.spec.ts`. All four M4 public
read surfaces now render real or honestly-labeled data inside the 4.1
chrome. Next lane: M5 (wallet + sessions).*

*2026-07-23 (rev 19): **M5 elaborated to a working plan** (working plan
[`app-m5-wallet-flows`](2026-07-23-app-m5-wallet-flows.md), single multi-PR
file per the M3 precedent; plan-first — the plan document is committed
before any M5 code). Delivery is tranched per Ira: Tranche A = 5.1 + 5.2
(full grain, two commits on `m5.x-wallet-flows`, one GitHub PR/CI cycle);
Tranche B = 5.3 + 5.4 (coarser grain, refined in a same-file revision
before build). Decisions recorded there: guarded web-tier broadcast relay
of the user-signed tx (a §12.3 amendment lands with 5.2), and the e2e-live
layer staged as harness + bundle-gated test signer in 5.2 with fund-moving
drill specs in 5.3/5.4. Stale-row correction in this change: §5's §14.4 and
§14.12 rows still read DECIDE, but both were DECIDED 2026-07-15 in
`app-spec.md` §14 — the rows and 5.4's §2 dependency cell now point at the
recorded decisions; 5.4's remaining gates are Tranche B plan refinement and
the typical-payout serving source (plan §7 Q4), not open decisions.*

*2026-07-28 (rev 20): M7 planned and documented (PR 7.0, docs-only). Structure
per Ira: **one plan per PR** under a
[milestone overview](2026-07-28-app-m7-governance.md), not a single multi-PR
file — the M3/M5 precedent is superseded for this milestone. Five new plan
documents; §2 gains a 7.0 row and amends rows 7.1/7.4/7.5/7.6; §3 records the
branch split with file-count estimates against the ~70-file review ceiling;
§4's security-executable row gains the three M7 governance checks; §5 flips
§14.6 and §14.10 to their recorded decisions.*

*Six rows, four PRs. Two pairs were consolidated on cohesion after the initial
per-row estimates proved inflated (7.3 ≈19 not 30, 7.4 ≈23 not 34, 7.5 ≈40 not
60, 7.6 ≈19 not 27). **7.3+7.4** are one guard — the three-level
`MsgSubmitProposal` shape was fixed at 7.0, so staging it across an intervening
PR bought nothing and splitting would have had 7.4 immediately re-edit the
guard files 7.3 had just written. **7.5+7.6** — 7.6 feeds one of 7.5's six
panels, so splitting forced a placeholder state and an either-merge-order
correctness burden for no benefit. Folding 7.2 forward as well would have fit
under the ceiling (≈55) but was declined: it would put the relay-guard review
in the same PR as decoded-message honesty and a11y, and filling a ceiling is
not a goal.*

*2026-07-28 (rev 21): **§4b completeness obligations added to the plan format**,
piloted on the four M7 plans. Cause: a defect review of PRs #19–#22 found seven
P1s, six genuine, and **all six were the same shape** — a discrete space with an
unenumerated cell (cardinality assumed 1 where the domain allows N ×2; a wire
bound paired across components but agreed only by eye; plane precedence for a
stale-but-successful read; a state×affordance gap; a read-then-write race).
None was a wrong algorithm, a misunderstood protocol, or a security-model
error.*

*The decisive observation is that two of those P1s were **plan** defects, not
code defects: [the M6.4 plan §4](2026-07-24-app-m6.4-operator-view.md:685)
asserted `(txhash, msgIndex)` as the `operator_payments` natural key with a
gating test, payment is permissionless so a caller can batch, and the test
verified the wrong invariant while CI stayed green. Code review cannot catch a
faithfully-implemented wrong spec, so the remedy belongs in the plan format.*

*An initial reading — that the contract side's lower defect rate proves a
better method — **was corrected by Ira on 2026-07-29 and is not the
justification.** Most of `contracts/` came from a separate research spike and
was ported in, with many defects found during that work; `sim.rs`'s invariant
battery is better read as the residue of a discovery phase than as evidence
that up-front enumeration prevents defects. The real asymmetry is that the app
side has **no discovery phase**: plan → implement → review → merge, with
external review as the only thing that ever contradicts an assumption. What
stands without inference is narrower and sufficient: §4's *named* invariants
with *named* gating tests prove every case the author thought of, cannot
surface the one they did not, and make a wrong assumption **look verified**.
§4b is an attempt to buy on paper some of what a spike buys empirically — an
unproven substitution, deliberately piloted rather than adopted. It adds five
closed spaces (natural keys & cardinality, wire bounds, concurrency,
state×affordance, plane precedence) that a plan must enumerate or mark n/a with
a reason; a `*Disproof:*` line on every invariant asserting a domain fact; and
drills that must generate the N>1 case for each "one per X" assumption, since
M6.4's drill covered every terminal state and never a batched payment. Defined
in [the M7 overview](2026-07-28-app-m7-governance.md) §7. Repo-wide adoption is
deliberately deferred until M7.1 has run the format once.*

*Four findings from the planning pass, each of which changed scope. (1)
**There is no `x/group` anything on the devnet** — the groups fixture is empty
and `CONTRACT_ADMIN` defaults to a plain account, so `roles.server.ts`'s
group-policy branch has never executed. (2) **The contract has no
admin-rotation message**, so the group and policy must be bootstrapped before
deploy; every developer resets devnet when 7.1 lands. Together these put an
entire devnet substrate, drill and fixture family inside 7.1 and are why it is
roughly twice its original row. (3) **`services/api` has no path parameters**
(`findRoute` is an exact match), so proposal detail is a query param. (4)
**`x/group` prunes** — closed proposals leave chain state, which is what makes
the indexed mirror load-bearing rather than a convenience, and which is a
second, independent reason the `governance` verify-link target stays absent.*

*Four decisions resolved in the same change so no later PR starts on an open
question: the `gov_proposals`/`gov_votes` column additions (app-spec §9.1
forward note); the three-level `MsgSubmitProposal` guard shape, decided now so
§12.3 is amended once at 7.3 rather than twice; the `admin:<bech32>` scope
(ADR-001 Decision 2 amendment), including the rule that minting bypasses the
60 s role cache; and §14.10's analytics taxonomy, which was the milestone's one
blocking decision. `contracts/IMPLEMENTATION-STATUS.md` records that the App
does not assume the pending dual-policy split and that performing it needs a
redeploy or a new message.*


*2026-07-29 — **PR 7.1 (governance indexing + endpoints) delivered**, closing
branch 1. The devnet gained an `x/group` substrate (group + two threshold
policies, bootstrapped BEFORE deploy through the existing `CONTRACT_ADMIN` hook,
since the contract has no admin-rotation message), a scripted lifecycle drill
(`contracts/drills/gov-drill.sh`, 30 assertions), and a governance fixture
family. The `governance` indexer stream mirrors `x/group` into `gov_proposals`/
`gov_votes` across three planes, and `services/api` serves three public
governance routes. `liquid-staking-spec` §12.1's policy topology is now
EXERCISED rather than merely described.*

*The drill contradicted **four** of the 7.1 plan's own mechanism assumptions, and
that is the milestone's most useful output. A successfully executed proposal is
pruned in its own transaction, so `ACCEPTED`+`SUCCESS` is a state pair no chain
read can return; votes are deleted at the voting-period-end tally even when a
proposal passes; a missing proposal answers HTTP 500 — not 404 — with a body
identical to an outage's, so prune can never be inferred from a status code; and
voting-period-end transitions are eventless. All four are corrected in app-spec
§9.1/§9.2, the 7.1 plan §3.5, and `services/indexer/CLAUDE.md`, with the fixture
manifest's `pinned_facts` as authority. Two states remain unproduced and are
recorded rather than assumed away: `PROPOSAL_STATUS_ABORTED` is unreachable on
the drilled build, so 7.2's rendering of it is unexercised by real data.*

*§4's Security-executable row gains two standing mechanisms. The **wire-bounds
registry** (`packages/api-types/src/bounds.ts` + its table-driven test) closes
the PR #19 defect class rather than instancing it again: bounds that cross the
API↔web boundary are now one declaration imported by both tiers, and the three
M6.1 portfolio pairs — previously coupled by a COMMENT in the row types — were
adopted into it. The **governance monotonicity guard** is enforced by SQL
(`ON CONFLICT … WHERE observedHeight < EXCLUDED.observedHeight`) rather than
application logic, gated by a Postgres-backed round-trip that the TypeScript
replay suite deliberately cannot substitute for.*

*On the §4b pilot (overview §7.5), the honest reading is narrower than "it
worked": C1, C2 and C3 each changed the implementation, C4 and C5 were forward
obligations only, and the four plan-contradicting findings came from the DRILL
rather than from the prose tables. What §4b contributed was telling the drill
what to try to falsify. The overview §7.2 obligation table stands for 7.2–7.6;
the case for the prose cells (C4, C5) remains untested, since neither applied
here.*

*2026-07-29 (PR #23 review) — two issues raised, both valid, both fixed in the
branch. The **P1** was silent data loss in the common case: a proposal submitted,
executed and pruned inside ONE indexing window was absent from that window's
ending sweep, and since every event-derived write is an UPDATE keyed on
`proposalId`, the whole lifecycle affected zero rows while the votes survived as
orphans. The M7.1 plan had specified the height-pinned recovery read that prevents
it; the read was dropped in implementation while correcting the
404-means-pruned semantics. Restored, with the AS-OF of the recovery read rather
than the window's end, and with orphan votes refused where recovery is impossible.
The **P2** was an unflagged proposer truncation, fixed with `proposers_truncated`.*

*The §4b consequence is recorded rather than smoothed over: the escaped P1 sits in
a category none of C1–C5 names, so per the overview's own reading rule the list was
incomplete and **C6 — temporal spans** is added to it (which windows can an
entity's lifecycle occupy, and does each write path hold when they collapse into
one?). The sharper lesson is that the replay suite already carried an invariant
named for exactly that behavior which seeded its row in a PRIOR window — passing
while the defect it named was live. That is the M6.4 failure mode reproduced inside
the PR piloting the fix for it, and it strengthens §7.5's own prediction that a
leaking-but-filled table should be answered by generating the matrix from the drill
corpus rather than by hand.*

*2026-07-30 — **PR 7.2 delivered**: the §8.7 governance read UI (`/governance` +
`/governance/:proposalId`), public read, still no signing path. Two things are
worth carrying forward. **First, the plan was wrong about where a live tally
comes from, and only the build could find it:** a proposal's
`final_tally_result` is zeros for the whole voting period, so the state read the
plan named would have rendered "nobody has voted" on an open proposal with
votes. The fix is x/group's own `TallyResult` query, plus a chain-client test
asserting that every SUBMITTED proposal in the captured sweep does carry an
all-zero final tally — the assumption is now falsifiable rather than believed.
**Second, §4b's C4 and C5 finally got exercised**, having been n/a for 7.1 and
left "on probation" by the overview. C5's stale-versus-down distinction is what
produced the `plane` field and its badge, and C5's both-down cell is what made
every tally count nullable — a non-nullable count would have forced a fabricated
`0` into exactly the figure that must never be one. C4 was filled and every row
read "read only", which is the point: 7.3–7.4 inherits it as the state set each
new affordance must be decided against.*

*2026-07-30 — **PRs 7.3 and 7.4 delivered together**, as one PR per the M7
consolidation: the governance WRITE path (vote, execute, template composer) and
the **§12.3 relay amendment** that carries it. Rows 7.3 and 7.4 are both
complete, and the §14.6 governance-side constraint in §5 is **discharged**.

**The amendment is the substance.** Three `cosmos.group.v1` types are admitted
under one review — `MsgVote` and `MsgExec` structurally, and
`MsgSubmitProposal` behind six conditions ending, as M6.4's does, in a
byte-identical canonical re-encode. Admin program-ops now reach the chain, and
**only** as template-scoped proposals: the direct-`MsgExecuteContract` admin
rejection rows are unchanged and re-asserted beside the new matrix, adjacent to
a case proving the same variant IS carried as a proposal. That pair is where a
future regression would show.

**And then the guard was CUT, which is the milestone's sharpest result.** A
security review of the finished branch found overview D7's rationale backwards:
it justified template-matching every inner message by calling an unguarded
`MsgSubmitProposal` "strictly worse than the `MsgExecuteContract` hole M6.4
closed", but an unguarded `MsgExecuteContract` **executes on inclusion under the
signer's own authority** while a proposal **executes nothing** until the group's
decision policy is satisfied by other members voting. The threshold is the
enforcement boundary; restricting what may be *proposed* reduced no authority
available to anyone. Conditions 3, 4 and 5 are gone — with them the async relay
guard, the per-submission chain read, the 503 failure mode, and the registry the
relay had to keep in lockstep with the contract. The template set survives as the
**composer's** vocabulary, which is what §8.7 asked for. Retained: the
allowlist closure, the session binding, the closed field set, the `exec` pin
(re-labelled a confirmation-rigor control, not an authorization one) and an
envelope re-encode. Recorded in the 7.3–7.4 plan §10.4, D7's superseded row, and
the app-spec §12.3 correction. **The generalizable lesson: §4 requires every
invariant to name its gating test, and every one of these had a passing one — so
§4 should also require each invariant to name WHAT AN ATTACKER GAINS IF IT DOES
NOT HOLD.** That question collapsed three conditions in a sentence, and no §4b
cell asks it. Proposed for M8's plan review.

**Three things the build settled before that.** (1) **Condition 3
forced the guard async.** "Is this a program policy" is a live, set-valued read
(D1), and the alternatives were hardcoding a policy address — the topology
assumption `SECURITY.md` forbids — or moving the condition out of a guard whose
order is non-negotiable. An unresolvable policy set now rejects **503**, which
is a state the plan did not name at all. (2) **Guard 6 had to become
per-shape.** Every message the relay carried before this PR held its signer in
field 1; `MsgVote` field 1 is a varint proposal id and `MsgSubmitProposal`
field 1 is the policy address, so the single outer check would have bound a
vote to a proposal id and rejected everything — a failure that reads as
"working" from the outside. (3) **The affordance plane is not the display
plane.** §4b C5 said actions come from the live plane; the build showed that
`plane` cannot be that signal, because a closed proposal's honest display plane
is the mirror, so execute would have been permanently hidden. `liveState` is a
separate nullable field, and accepted proposals are now live-read — which pays
for itself, since x/group prunes a successful exec in its own transaction and a
failed read on an accepted proposal is therefore itself evidence.

**§4b's verdict this time, against the overview's §7.5 predictions.** C1 changed
the implementation again and in the way it was supposed to: the "every entry of
`proposers`, not just the first" row and the zero-element row are guard
conditions that exist because the table demanded them, and both are matrix cases.
C2 produced `WRITE_READ_BOUNDS` — the write side of the pairing the 7.1 mechanism
only covered on the read side. **C4 came off probation and earned it here**,
which is the outcome 7.2 deferred: filled as a table, it became a pure function
and a case-per-row suite instead of conditions in JSX, and two of its rows
(membership-unknown as distinct from not-a-member; disabled-with-an-unknown-time
for an unparseable waiting period) are cells that would not have been written
otherwise. C3's "not idempotent" row is the reason the confirm step says signing
twice creates two proposals rather than the flow trying to deduplicate one.*

*2026-07-30 — **M8 row 8.4a added** (Ira's direction), the point at which the
program leaves complete reset-and-rebuild mode. Occasioned by collapsing both
Prisma histories into one regenerated baseline per schema the same day: with
nothing running outside dev and CI, an incremental migration chain encodes a
history no database has, and it rots silently — the indexer's chain could not
replay on a fresh database, because its init migration was search_path-dependent
while every later one was schema-qualified. Rebuild-not-migrate is therefore the
standing rule up to 8.4a, recorded in `services/indexer/CLAUDE.md`,
`apps/web/CLAUDE.md` and `indexer-design-notes.md`, and 8.4a is the change that
replaces it. The contract half is the irreversible one and the reason the row
sits before 8.4 rather than inside it: `nvhash-staking` has no `migrate` entry
point, and the wasmd contract admin that would authorize one is fixed at
instantiate — a contract instantiated without an admin can never be given one,
so the first deployment we intend to keep is also the last moment the choice
exists. §6 gains the matching trust-surface row: if an upgrade path is adopted,
it is a spec amendment plus a drill that an unauthorized migrate is rejected,
not a deployment assumption about who holds a key.*

*2026-07-31 — **rows 7.5 and 7.6 delivered as one PR**, per the 2026-07-28 scope
decision. The merge paid off exactly where it was argued it would: the two
`app`-schema tables landed under a single data-minimization review, and 7.5's
evaluator-funnel panel never needed the "not yet collected" placeholder a split
would have required. Four things are worth recording because they changed the
shipped surface relative to the plan, and each is a limit the plan's own
constraints forced rather than a softening of them.*

*First, **§14.10's page-class enum shrank from five members to three.** Two of
the proposed classes — `learn_deep` and `spec_link` — are not server-observable:
Learn is a single route with in-page progressive disclosure, and the spec links
are plain external anchors. Counting either needs client instrumentation, which
§14.10 forbids outright, so shipping them would have meant breaking that rule or
carrying enum members nothing could ever write. The same discovery reshaped
`due_diligence_depth`, which §8.1.7 words as "scroll depth": scroll depth is not
measurable here at all, so the stage is defined as what a loader can honestly
observe — a load of `/validators` or `/market` — and the surfaces say so rather
than letting the name imply tracking that does not exist. The privacy property
Q3 was asked for is unaffected and slightly stronger, since three broad classes
name no niche page.*

*Second, **the page class is stored inside the stage enum rather than as a
fourth column.** §2.4 described "a closed page-class enum on `visit`" while
invariant 6 pinned the column set at exactly `{stage, day, count}`; a `pageClass`
column would have satisfied the prose by breaking the invariant. The call-site
API still keeps stage and page class as separate closed types over a
discriminated union, so a caller cannot attach a class to a stage that has none —
three columns, and the impossible call unrepresentable.*

*Third, **§2.4's buffering question is closed by measurement, not by argument.**
The plan recorded a guess that concentrating a day's visits onto one row might
need a bounded in-process buffer. Measured on the dev database with every client
deliberately on the same row: 0.21 ms uncontended, 2.05 ms at 8 clients, 10.06 ms
at 32, zero failures — and 82 000 concurrent increments produced a stored count
of exactly 82 000, which is the property that matters and the reason the
single-statement upsert is the whole remedy. No buffer is built; it would have
added a flush-on-shutdown loss window to avoid a cost that is not there. The
measurement is reproducible (`apps/web/scripts/measure-funnel-contention.sh`).*

*Fourth, **§8.8's capture-signal cadence distribution is not delivered**, and
that is stated on the panel rather than left as an empty chart. No
capture-signal series is indexed — the NAV marker is consumed at ingest and not
retained as its own row — so deriving it is an indexer change, not an API one.
An empty histogram would have read as a measured result of zero gaps, which is a
different claim from "we do not collect this".*

*One structural note for future readers: the `admin:` mint gate lives in
`app/lib/services/admin-auth.server.ts`, separate from `assertion.server.ts`,
because `notifier/index.ts` loads the minting module under Node's strip-only TS
and must not acquire a runtime chain-client dependency. Minting stays pure so
the golden vectors can pin its bytes; the fresh-membership precondition lives
beside the chain read. And the ADR amendment was tightened rather than merely
confirmed: a fresh read at mint time reduces the stale-admin window from "60 s
cache plus the assertion" to "the assertion", not to zero, and the ADR now says
so instead of implying otherwise.*

*2026-08-03 — **M7 closed**, and a second review pass over 7.5–7.6 landed nine
fixes plus the milestone's closure records. Four were honesty defects of one
shape — the gate for an invariant tested the layer next to the one that was
wrong — and are tabled in that PR's plan §10.4: concentration bands divided by a
truncated denominator; a 90-day funnel whose terminal stage counted all history;
a failed acknowledgment read rendered as "nothing is acknowledged"; and a
transient x/group failure reported as "not an administrator" rather than as
unknown. Five were the hygiene items from the same pass: two admin reads that
grew without bound (now capped and flagged, with the scan cost **measured** at
two depths rather than asserted), literal NUL bytes that made a source file
undiffable in git, a funnel bound declared twice in two packages, a read-then-write
on the acknowledgment reversal, and an `incidentId` column narrower than the id
it references.*

*The load-bearing lesson is recorded in the milestone overview §7.5 rather than
here: **§4b's C1–C3 each changed implementations and stay; C4 was filled
completely and still leaked**, because its axis is record state while the defect
lived on per-input availability — two schemas that fail independently. The fix
that held was a type change (`Map | null`) rather than the new test beside it.
M8 should generate C4's matrix from the loader's own inputs instead of tabulating
it by hand, and C5 remains untested as a format.*

*One process note worth keeping: every fix in this pass was verified by
**disproof** — reintroduce the defect locally, confirm the new case goes red,
revert. That is what surfaced two gates that were passing for the wrong reason
(both tested a pure mapper while the defect was in the loader feeding it), and
one fix that would have introduced a regression in the opposite direction
(folding an x/group failure into the flag the operator view gates on). Neither
was visible from reading the diff.*
