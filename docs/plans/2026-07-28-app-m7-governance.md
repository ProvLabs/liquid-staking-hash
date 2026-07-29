# App M7 — Governance & admin (milestone overview)

**Status:** PLANNED 2026-07-28. This document is **not a build plan** — it is
the milestone-level index. Each PR has its own plan (§5), and those are what
executors read. This file carries only what is genuinely cross-cutting: the
findings that reshaped the milestone (§2), the branch split and its file-count
rationale (§3), the decision register (§4), and the `SECURITY.md` conformance
map (§6).
**Epic:** the nvHASH App — [`app-spec.md`](../specs/app-spec.md) (v1.0-RC1)
**Milestone:** M7 — Governance & admin,
[master plan](2026-07-13-app-implementation-plan.md) §2 PRs 7.1–7.6
**Companions:** [`SECURITY.md`](../../SECURITY.md),
[ADR-001](../architecture/2026-07-14-adr-001-app-component-architecture.md),
[`application-boundary.md`](../architecture/application-boundary.md) §3,
app-spec §8.7 / §8.8 / §12.1–§12.3 / §14.6 / §14.10 / §14.13,
[`liquid-staking-spec.md`](../specs/liquid-staking-spec.md) §12.1,
[`contracts/IMPLEMENTATION-STATUS.md`](../../contracts/IMPLEMENTATION-STATUS.md)

## 1. What M7 delivers

The `x/group` governance workflow the boundary doc assigns to the App
(`application-boundary.md` §3: signing is chain-native on either surface, the
rich proposal/tally/analytics workflow is the App's, free-form message compose
stays a Console strength), plus the cohort-satisfaction dashboard the
no-backend Console cannot render (app-spec §8.8), plus the first-party
aggregate funnel counters (§14.10).

By the end of M7 the App is the primary governance home: proposals are
mirrored durably, members vote and execute from the App, and admin program-ops
(halt/resume, pause/unpause, config, bridge config) reach the chain **only** as
template-scoped governance proposals — never as direct admin transactions.

## 2. Findings that reshaped the milestone

Established during planning on 2026-07-28 and verified against `main` at
`8e66950`. Each one changes a PR's scope, so they live here rather than in one
plan.

**F1 — there is no `x/group` anything on the devnet.**
[`packages/fixtures/fixtures/queries/group/groups.json`](../../packages/fixtures/fixtures/queries/group/groups.json)
is `{"groups":[],"pagination":{"next_key":null,"total":"0"}}`, and
[`infra/devnet/bootstrap/nvhash-deploy-p2p.sh:141`](../../infra/devnet/bootstrap/nvhash-deploy-p2p.sh)
defaults `CONTRACT_ADMIN` to a plain account. The `groupPolicyInfo` branch of
[`roles.server.ts`](../../apps/web/app/lib/services/roles.server.ts) therefore
always throws today and falls through to address equality. 7.1 has no state to
index, no fixtures to capture and no e2e-live path until a governance
substrate exists — so building one is inside 7.1, and it is why that PR is
nearly twice its master-plan size.

**F2 — the contract has no admin-rotation path.** `ExecuteMsg::UpdateConfig`
([`contracts/src/msg.rs`](../../contracts/src/msg.rs)) has no `admin` field and
`InstantiateMsg.admin` is set once. The group and policy must be created
**before** deploy and injected through the existing `CONTRACT_ADMIN` hook. No
contract change is needed, but "just rotate the admin" is unavailable
everywhere downstream, and **every developer resets devnet** when 7.1 lands.

**F3 — `services/api` has no path parameters.** `findRoute` is an exact string
match ([`services/api/src/routes.ts:783`](../../services/api/src/routes.ts)).
Proposal detail is `GET /governance/proposal?id=`, never `/proposals/:id`. The
web tier is React Router and *can* use `/governance/:proposalId`.

**F4 — `x/group` prunes.** Rejected, aborted and executed proposals and their
votes are removed from chain state by the module's EndBlocker. That is why
`gov_proposals`/`gov_votes` exist as a durable mirror (app-spec §9.1), and it
disqualifies any poll-only indexing strategy: a sweep that runs a minute late
loses the row permanently. It also means a closed proposal may have **nothing
on chain to verify against** — which is one reason the `governance` verify-link
target stays absent (§4 D8).

## 3. PR split and sizing

Sizing is measured against what the M6 PRs actually touched (6.1 = 57 files,
6.2 = 55, 6.3 = 37, 6.4 = 95). The review ceiling for this series is ~70
changed files per PR.

| PR | Plan | Est. files | Branch |
| --- | --- | --- | --- |
| 7.0 | *this doc + the four below* | 9 | 1 |
| 7.1 | [m7.1 governance indexing + endpoints](2026-07-28-app-m7.1-governance-indexing.md) | ≈53 | 1 |
| 7.2 | [m7.2 governance read UI](2026-07-28-app-m7.2-governance-read-ui.md) | ≈27 | 2 |
| 7.3 + 7.4 | [m7.3–7.4 governance write path](2026-07-28-app-m7.3-7.4-governance-write-path.md) | ≈32 | 3 |
| 7.5 + 7.6 | [m7.5–7.6 admin analytics + funnel](2026-07-28-app-m7.5-7.6-admin-analytics-and-funnel.md) | ≈50 | 4 (∥) |

**Four branches (consolidation decision, Ira 2026-07-28).** The master plan's
row numbers are preserved — two plans each cover a numbered pair, the way
`2026-07-22-app-m3-query-api.md` covers PRs 3.1–3.3 — so §5's decision
cross-references and PR-title attribution stay valid.

Two merges were taken, both justified by cohesion rather than by headroom:

- **7.3 + 7.4 are the same guard.** D7 fixed the end-state three-level shape at
  M7.0, so staging `MsgSubmitProposal` as present-but-provably-rejected for
  exactly one PR is ceremony that only pays off if 7.3 ships meaningfully
  earlier — and it does not. Merged, the guard is written once, §12.3 is
  amended once, the rejection matrix is authored once. Split, 7.4 would
  immediately re-edit the `build.ts`, `proto.ts` and `broadcast-guard.test.ts`
  that 7.3 had just written. **This supersedes D7's staging, not D7's guard
  shape.**
- **7.6 feeds one of 7.5's six panels.** Split, 7.5 must ship a "not yet
  collected" placeholder for the evaluator funnel and be provably correct in
  either merge order — a contingency that costs design, code and test surface
  and buys nothing, since neither blocks the other. Merged, it disappears and
  the two `app`-schema tables land under a single data-minimization review.

**Branch 1 = 7.0 + 7.1 ≈ 62 files**, and the break is before 7.2. Folding 7.2
into branch 1 would reach ≈89. Folding 7.2 forward into the write-path branch
instead would reach ≈55 — under the ceiling, but justified only by headroom,
and it would put the relay-guard review in the same PR as decoded-message
honesty, tally arithmetic and a11y. That is the M6.4 failure mode in miniature,
and filling a ceiling is not a goal.

Ending branch 1 at the frozen `@nvhash/api-types` governance shapes is the
repo's designed seam — master plan §3: *"the web lane never blocks on the
services lane … every page is required to build offline against MSW."*

One further reason to merge 7.1 alone: once `Config.admin` is a real group
policy, the previously-dead `groupPolicyInfo → groupMembers` branch of
`roles.server.ts` goes live for **every session in every environment**. That
deserves its own merge and its own "does everyone's devnet still come up" beat.

**Lane order.** `7.1 → 7.2 → 7.3 → 7.4` is serial by dependency. 7.5 and 7.6
are genuinely parallel to that chain and to each other — but note the M6
lesson recorded in master plan §3 (M6 was planned parallel and ran serialized,
because building against merged behavior beat building against a parallel
branch's assumptions). 7.5 and 7.6 are marked `[P]` in the master plan and are
kept so here; whether they actually run parallel is a staffing call, not a
design constraint.

## 4. Decision register

Every decision M7 depends on, with where it is recorded. This table is the
milestone's contract with itself; a PR must not land before its blocking rows
are resolved.

**Resolved in the 7.0 docs commit and recorded in the repo:**

| # | Decision | Recorded in |
| --- | --- | --- |
| **D3** | **gov schema columns.** The 7.1 §3.2 table is approved as a design-review event: `decisionPolicy` snapshot (a historical proposal's threshold is otherwise unrenderable once the live policy changes), nullable `GovVote.height`/`txhash` plus `weight` (null is the honest value for a state-recovered vote), and `proposers String[]` replacing `proposer` (one column is a lie when x/group allows several). | app-spec §9.1 forward note |
| **D7** | **Governance relay guard shape.** `MsgSubmitProposal` carries `messages []Any`, so a plain type-URL allowlist entry would open the relay to **arbitrary messages from the policy account** — strictly worse than the `MsgExecuteContract` hole M6.4 closed. The guard is **three-level**: type URL → proposer/signer ↔ session-address binding → each inner `Any` against a closed template set → **byte-identical canonical re-encode per inner message** (M6.4's condition 5, which takes it out of a parser arms race). **Constrains 7.1:** proposal `messages` are stored verbatim. <br><br>*Staging superseded 2026-07-28 by the §3 consolidation:* D7 originally had 7.3 land the §12.3 amendment with `MsgSubmitProposal` present-but-provably-rejected and 7.4 flip it on. With 7.3 and 7.4 merged there is no intervening PR to stage across, so all three types are admitted together under one amendment. **The guard shape is unchanged** — only the two-step rollout disappears. | 7.3–7.4 plan §2; app-spec §12.3 amendment at 7.3–7.4 |
| **D9** | **`services/api` authorization for admin endpoints.** A new `admin:<bech32>` scope joins the union. The only option that keeps `services/api` DB-only (it has no chain client, by design) and keeps "re-verify group membership on-chain per session refresh" in the web tier where the LCD client lives. Minting **must bypass** the 60 s `ROLE_CACHE_TTL_SECONDS` cache — a 60 s stale admin is a privilege, whereas a stale operator only affects a read view. | ADR-001 Decision 2 amendment |
| **D10** | **§14.10 analytics taxonomy.** Per-`(stage, day)` integer counters in an `app`-schema table, incremented **server-side in the loader**, closed page-class enum, funnel stages per §8.8, stated retention window, **no cookie and no client script** — the latter because §12.3 requires transacting pages to work with third-party scripts blocked, and because there is nothing to consent to when nothing is keyed to a person. | app-spec §14.10 |

**Resolved by direction, recorded in the PR plans:**

| # | Decision | Home |
| --- | --- | --- |
| D1 | Policy discovery is **set-valued** — `Config.admin` → policy → group → all policies on that group. Never hardcode "the admin policy": `IMPLEMENTATION-STATUS.md` has the `admin`/`ops` split open, and hardcoding would be the topology assumption `SECURITY.md` forbids. | 7.1 §2.1 |
| D1b | Bootstrap group+policy **before** deploy via `CONTRACT_ADMIN`; no contract change (F2). | 7.1 §3.1 |
| D2 | Hybrid indexing — events for provenance, height-pinned state reads for authority. | 7.1 §2.2 |
| D8 | **No `governance` verify-link target through M7.** The Console has no governance panel, a verify link must never be dead, and §12.2 pins links under `{CONSOLE_URL}` so an external explorer is not a substitute. The target and the §14.13 console follow-on are one pair. A pruned proposal (F4) has nothing on chain to link to at all. | app-spec §12.2 note; 7.2 §4 |
| D12/D16 | The API serves durable mirrored facts; the web tier owns the live plane. The `/market` and `/portfolio` precedents. | 7.1 §2.4 |
| D13 | Stream start height 1, with `indexed_from_height` in the list payload so the page never implies completeness it lacks. | 7.1 §2.4 |
| D14 | Master-plan row 7.4 is stale against §14.6 (DECIDED 2026-07-15) and is amended in the 7.0 commit. | master plan §2 |
| D17 | The tally-vs-threshold comparison is a **shared pure helper** in `@nvhash/api-types`, not duplicated — the `navHashPerShare` precedent, which exists because a duplicated formula drifted once already. | 7.1 §3.3 |

**Open, resolved inside the PR that consumes them:**

| # | Decision | Resolved in |
| --- | --- | --- |
| D2b | Does this SDK build emit `EventProposalPruned` or a voting-period-end tally event in `finalize_block_events`? A `[VERIFY]` answered by observation in 7.1 commit A and pinned in `manifest.json`. The design works either way. | 7.1 |
| D5 | "Who hasn't voted yet" — live `groupMembers` at render for open proposals; for closed proposals whose `groupVersion` ≠ current, recorded votes only plus an explicit membership-changed note. No `gov_group_members` snapshot table. | 7.2 |
| D6 | Unknown/undecodable proposal messages — closed typed union plus a tagged `unknown` showing raw JSON and saying so. A heuristic summary is disqualified by §12.1. | 7.2 |
| D15 | `/governance` with an empty policy set renders honest-empty; the nav entry stays (§8.0: the nav must never 404, and hiding it is a different lie). | 7.2 |
| D19 | Which admin actions get proposal templates in v1, and the config-diff presentation. | 7.4 |
| D20 | Cohort/retention window definitions and the incident-acknowledgment model. | 7.5 |

## 5. The 7.0 documentation commit

Nine files, no code. This commit is the whole of M7.0 and lands before any
other M7 work.

**Created (5):** this overview and the four PR plans listed in §3.

**Amended (4):**

- **[`2026-07-13-app-implementation-plan.md`](2026-07-13-app-implementation-plan.md)** —
  row 7.4's stale-scope amendment (D14), row 7.1's dependency widened to
  include the devnet substrate, row 7.5's ADR-001 dependency, row 7.6's
  blocking marker dropped; §3 map gains the substrate prerequisite and the
  branch split; §4's Security-executable row gains the governance clauses; §5
  flips §14.6 and §14.10 to DECIDED; revision-log entry.
- **[`app-spec.md`](../specs/app-spec.md)** — §14.10 resolution (D10), §14.6
  governance-side note, §12.2 verify-target note (D8), §9.1 forward note (D3).
- **[ADR-001](../architecture/2026-07-14-adr-001-app-component-architecture.md)** —
  Decision 2 amendment for the `admin:` scope (D9), delivery checklist gains an
  unchecked PR 7.5 row.
- **[`contracts/IMPLEMENTATION-STATUS.md`](../../contracts/IMPLEMENTATION-STATUS.md)** —
  annotate the open dual-policy item: M7 does not assume the split (D1), and
  `ExecuteMsg` has no admin-rotation variant (F2), so the split needs a
  redeploy or a new message.

## 6. `SECURITY.md` conformance across the milestone

"Enforced" means a mechanism plus a CI-gating test, never a caller or topology
assumption. Per-PR invariants live in each plan's §4; this is the map.

| `SECURITY.md` requirement | Enforced by |
| --- | --- |
| Data minimization; no PII; a new column is a design-review event | `services/indexer/test/schema-allowlist.test.ts` over the extended `test/security/allowed-fields.ts` (7.1); `apps/web/test/app-schema-allowlist.test.ts` for `incident_acks` (7.5) and the funnel counters (7.6) — the latter is also the executable no-per-wallet/session/device keying test |
| No custody, no signing in services | No signing endpoint exists; 7.3/7.4 sign client-side and the web-tier relay carries only fully user-signed bytes under the closed allowlist — gated by `apps/web/test/broadcast-guard.test.ts`, whose rejection matrix grows with each of 7.1 (MsgVote still rejected), 7.3 and 7.4 |
| Never gate a safety property on who calls | The admin gate is a capability gate over public-derivable reads; the contract remains the enforcement boundary for every write. Gated at 7.5 by the `ADMIN_PATHS` matrix in `services/api/test/cross-address.test.ts` |
| APIs read-only and defensive; bounded params | Every governance/admin route is `defineEnveloped` in the registry, so the registry-driven envelope, GET-only/405, query-bound and rate-limit harnesses cover it automatically (7.1, 7.5) |
| No unbounded work; all chain reads paginate | The 7.1 state sweep paginates to exhaustion under a per-window page cap that logs rather than truncates — a truncated sweep is indistinguishable from a prune and would corrupt the mirror |
| Chain is source of truth; idempotent replay | The `observedHeight` monotonicity guard and the prune-preserves-the-row rule, gated by `governance-replay.test.ts` (7.1) |
| Never lie about state | `indexed_from_height` on the list payload (7.1); live-canonical tallies with a stale badge on live-read failure and no indexed-presented-as-current (7.2); decoded summaries never invented (7.2, D6); no dead verify link (D8) |
| Enumerated trust surfaces; every admin capability is a spec-level event | Admin program-ops enter only as §8.7 templates at 7.4, with the §14.6 note written at 7.0 and the §12.3 amendment at 7.3; `liquid-staking-spec.md` §12.1/§14 item 10 amended at 7.1 commit A when the described policy topology first becomes real |
| Reproducible verification documented in the status ledger with dates | `contracts/drills/gov-drill.sh` (7.1) and its result recorded in `IMPLEMENTATION-STATUS.md` with a date and the build it ran against |
| Devnet keys are throwaway | The 7.1 bootstrap uses existing keyring entries, generates no key material, accepts no mnemonic, and points only at the disposable local chain |

## 7. Revision log

*2026-07-28: initial milestone overview and the six PR plans, written as the
M7.0 documentation commit. Structure follows Ira's standing preference —
plans at PR level under the milestone, parallel work flagged — rather than the
M3/M5 multi-PR single-file precedent.*
