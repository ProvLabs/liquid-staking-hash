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
| 7.1 | [m7.1 governance indexing + endpoints](2026-07-28-app-m7.1-governance-indexing.md) | ≈55 | 1 |
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

**Branch 1 = 7.0 + 7.1 ≈ 64 files** (7.1 gained `bounds.ts` and its test from
§7's C2 obligation), and the break is before 7.2. Folding 7.2
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

## 7. Completeness obligations (new with M7 — read before writing any §4b)

### 7.1 Why this exists

A defect review of PRs #19–#22 (2026-07-28) found seven P1s. Six were genuine,
and **all six were the same shape**: a discrete space had a cell nobody
enumerated. Two were batched-payment cardinality; one was a wire bound paired
across two components but agreed only by eye; one was plane precedence for a
*stale-but-successful* read; one was a state×affordance gap; one was a
read-then-write race. None was a wrong algorithm, a misunderstood protocol, or
a security-model error.

The sharpest one: [the M6.4 plan §4](2026-07-24-app-m6.4-operator-view.md:685)
asserted `(txhash, msgIndex)` as the `operator_payments` natural key, with a
gating test. Payment is permissionless, so a caller can batch several into one
message — **the invariant was wrong, the test verified it anyway, and CI was
green.** Two of that PR's four P1s were therefore *plan* defects, not code
defects. No amount of code review catches a faithfully-implemented wrong spec.

The initial framing of this — that the contract side's lower defect rate proves
a better *method* — **is confounded and has been corrected (Ira, 2026-07-29).**
Most of `contracts/` was built in a separate research spike and ported in;
plenty of defects were found during that work. What the app side sees is a
matured artifact, not a process that prevented defects the first time. On the
evidence available, `contracts/src/sim.rs`'s invariant battery is better read as
the **residue** of a discovery phase — lessons encoded after the fact — than as
proof that enumeration up front prevents them.

The correction sharpens the actual problem rather than dissolving it. The app
side has **no discovery phase at all**: it goes plan → implement → review →
merge, with external review as the only mechanism that ever contradicts an
assumption. The contract side got to be wrong repeatedly in a spike, cheaply.
The app side gets to be wrong once, in a PR, expensively.

What survives without inference, because it is direct observation: §4's *named*
invariants with *named* gating tests prove every case the author thought of and
cannot surface the one they did not, and a named-and-gated wrong assumption
**looks verified** — which is exactly what happened to M6.4's natural key.

§4b is therefore an attempt to buy some of what a spike buys, on paper. **That
substitution is unproven** and is the thing 7.1 tests (§7.5).

§4b is the app-side analogue of the simulation domain: not "here are the cases
I checked" but "here is the space, and here is why it has no other cells."

### 7.2 The obligation table

Every M7 PR plan carries a **§4b Completeness obligations** section that walks
this closed list. Each row is either filled or explicitly marked *n/a with a
reason*. "Not mentioned" is not an allowed state — an unfilled row fails plan
review the way a missing gating test fails §4.

| # | Space | What the plan must enumerate |
| --- | --- | --- |
| C1 | **Natural keys & cardinality** | For every key: what makes each component unique, and the **maximum multiplicity of each component sourced from the producing system** — the chain, the contract, the module — **never from the observed happy path**. State the N>1 case explicitly even when you believe N is always 1. |
| C2 | **Wire bounds** | Every bound that exists on both sides of a component boundary (server cap ↔ client schema cap). Each pair must be **one declaration imported by both**, not two numbers that happen to agree, with a test asserting the producer's bound is inside the consumer's. |
| C3 | **Concurrency** | Every read-then-write on a uniqueness or cap constraint. The default remedy is a **database constraint**, not application logic; application-level enforcement requires a stated reason. |
| C4 | **State × affordance** | Every state a record can occupy × every action the UI offers on it. Adding a state — including a state introduced by fixing something else — re-derives the whole matrix. |
| C5 | **Plane precedence** | Per field: `{live ok, live stale, live down} × {indexed ok, indexed stale, indexed down}`. Note **stale** is a distinct column from **down**: M6.4's honesty matrix had degradation on its axes but not staleness, and that is precisely the cell that leaked. |
| C6 | **Temporal spans** *(added 2026-07-29 by 7.1's own escaped P1)* | For every entity: which INDEXING WINDOWS can its lifecycle occupy, and does each write path still hold when they **collapse into one**? State the single-window case explicitly. 7.1 lost proposals whose submit, execute and prune all landed in one window — every event-derived write was an UPDATE with no row to update, and the votes survived as orphans. §7.2's reading rule is explicit that a P1 in a category the list does not name means the list is incomplete, so this is that amendment rather than a note. |

### 7.3 Invariants carry a disproof

Any §4 invariant that asserts a **fact about the domain** — a cardinality, a
precedence, the closure of a set, a uniqueness claim — carries a
`*Disproof:*` line naming the observation that would show the invariant is the
wrong one. For M6.4's natural key that line would have read *"a transaction
emitting two payments under one msgIndex"* — a sentence that, once written,
makes the gap self-evident and is directly executable as a drill case.

Invariants that merely restate a standing gate ("axe passes", "i18n coverage")
need no disproof line. The test is whether the invariant could be *wrong*, not
merely *unmet*.

### 7.4 Drills generate multiplicity

Terminal-state coverage is necessary and not sufficient. M6.4's drill produced
every terminal payment state and never a batched payment, which is why the
corpus could not contradict the plan. **Every C1 "one per X" assumption gets a
drill case that produces N>1**, so the fixture corpus can falsify the
assumption rather than merely illustrate it.

### 7.5 How to tell, after 7.1, whether this earned its cost

§4b is a pilot. It could plausibly be ceremony, and the honest position is that
some of it probably is. Predictions are recorded **now**, before 7.1 is built,
so the retrospective is a check rather than a rationalization.

**Expected to pay** — because each produces an *executable* artifact that can
contradict the author:

- **C1 + §7.4 drill multiplicity.** The drill either emits the N>1 case or it
  does not, and the corpus either contradicts the assumed key or does not. This
  is the direct analogue of what a spike buys.
- **C2 bounds.** `packages/api-types/test/bounds.test.ts` mechanically fails on
  an unpaired bound. No judgment involved.
- **C3 concurrency.** "DB constraint, or state why not" is a binary the
  reviewer can check.

**At risk of being ceremony** — because they are prose tables whose quality is
bounded by the author's imagination, which is the faculty that failed:

- **C4 state × affordance** and **C5 plane precedence.** A table can be filled
  completely and still omit the row nobody conceived of. If 7.2/7.3 ship a
  state×affordance defect *despite* a filled C4, the remedy is not a better
  table — it is generating the matrix from the type system or the drill corpus
  rather than by hand.
- **`*Disproof:*` lines.** Genuinely useful when they name a *runnable*
  observation; decorative when they restate the invariant in the negative.
  Count how many became drill cases or tests. If the ratio is low, drop the
  convention and keep only the drill requirement.

**The ceremony detector.** For each filled §4b cell in 7.1, record at closure
(commit D) whether it **changed the implementation** — a different key, an
added constraint, a new drill case, a test that did not exist — or was filled
and had no effect. Cells with no effect across two milestones should be cut.

**Reading the review outcome.** A P1 in a category C1–C5 *names* means the
obligation was filled but filled wrongly — the format is sound, the enumeration
was lazy. A P1 in a category C1–C5 *does not name* means the list is incomplete
and that category joins it. **Zero P1s is the ambiguous case** and must not be
read as success on its own: 7.1 has a devnet substrate and a fixture corpus
that M6.4 lacked, which is a confound in the same family as the one that
invalidated the original contract-side comparison. Weigh it against how many
§4b cells actually changed the implementation.

Five §4b claims are already falsifiable during 7.1, most of them before much
code exists: the `(proposalId, voter)` vote-change verdict, the `incident_acks`
key, the conditional-update guard, the bounds pairing, and the residual
stale-admin window. If none of the five turns out to matter, that is real
evidence for the ceremony reading.

> **RECORDED 2026-07-29 at 7.1 closure. The full detector table is in
> [the 7.1 plan §3.7](2026-07-28-app-m7.1-governance-indexing.md); the summary
> is that the substitution partly worked, for a reason the pilot did not
> predict.**
>
> **C1, C2 and C3 each changed the implementation.** C1's cardinality table sent
> the drill after a vote change, which is what made `(proposalId, voter)` a
> measured key instead of a believed one, and it produced `proposers String[]`
> plus per-`msgIndex` discovery. C2 became `packages/api-types/src/bounds.ts` and
> its table-driven test — a mechanism that did not exist, and which immediately
> covered three PRE-EXISTING pairs that PR #19's fix had left coupled by a
> comment. C3's "DB constraint or state why not" produced an
> `ON CONFLICT … WHERE` guard plus the Postgres-backed round-trip that exists
> because the TypeScript replay suite would still pass without it — and that
> suite then caught a real regression review had missed.
>
> **C4 and C5 were n/a for 7.1** (no UI, DB-only API), so the two cells §7.5
> predicted were at risk of being ceremony remain **untested as a format**. Their
> forward obligations did hold, and C5 earned itself indirectly: finding 3 showed
> the *down* column has two shapes — absent versus unreadable — that no status
> code distinguishes, which is exactly the axis M6.4's matrix was missing.
>
> **Three of the five predicted claims landed in 7.1 and all three mattered**
> (the vote-change verdict, the conditional-update guard, the bounds pairing).
> `incident_acks` and the stale-admin window belong to 7.5.
>
> **And a P1 escaped in a category none of C1–C5 named** (7.1 plan §3.5b): a
> proposal whose whole lifecycle fell inside ONE window was silently dropped,
> because every event-derived write is an UPDATE and the ending sweep could not
> supply the row. §7.2's reading rule says a P1 outside the named categories means
> the LIST is incomplete — so **C6 (temporal spans) is added above**, not merely
> noted. Two things make this the sharpest evidence in the pilot: the space was
> temporal, which no existing cell touches; and the replay suite already held an
> invariant named for exactly that behavior which seeded the row in a PRIOR window,
> so it passed while the defect it named was live. That is the M6.4 failure mode
> reproduced inside the PR piloting the fix for it, and it is an argument for
> generating these matrices from the drill corpus rather than by hand — which is
> what §7.5 predicted the remedy would be if a filled table still leaked.
>
> **The correction to §7.1's framing.** The four assumptions this milestone got
> WRONG were caught by the **drill**, not by the §4b tables: a successful exec
> prunes itself, votes are deleted at tally, a missing proposal is a 500 not a
> 404, and voting-period-end is eventless. §7.4's "drills generate multiplicity"
> rule did the work; C1's table is what told the drill where to aim. So the
> evidence supports a narrower claim than "enumeration on paper substitutes for a
> spike": what the app side lacked was a **discovery phase**, and a scripted drill
> against a live chain is the cheapest available one. §4b's contribution was
> naming what to falsify. Keep C1–C3 and the drill rule; leave C4/C5 on probation
> until 7.2 exercises them.

## 8. Revision log

*2026-07-28: initial milestone overview and the six PR plans, written as the
M7.0 documentation commit. Structure follows Ira's standing preference —
plans at PR level under the milestone, parallel work flagged — rather than the
M3/M5 multi-PR single-file precedent.*

*2026-07-29: PR 7.1 delivered, closing branch 1. §4's D1/D2/D2b/D13/D17 are all
discharged; §7.5's ceremony detector is recorded above. Two findings amend this
document's own §2: **F4 is stronger than written** — `x/group` prunes a
SUCCESSFULLY EXECUTED proposal in its own transaction, not only at the EndBlocker,
so the happy path is precisely the path that leaves no chain state, which
strengthens rather than weakens the case for the durable mirror. And **F1 needs a
qualifier**: `x/group` was always SERVED on this build; what was missing was any
group on the devnet. The module was never in doubt, only the substrate. Two
obligations pass to 7.2: `PROPOSAL_STATUS_ABORTED` is renderable but unreachable
on the drilled build, so its UI is unexercised by real data; and per-voter history
for any CLOSED proposal exists only in the mirror, since the module deletes votes
at the tally.*

*2026-07-30: PR 7.2 delivered, closing branch 2. §4's D5, D6, D8 and D15 are
discharged in the [7.2 plan](2026-07-28-app-m7.2-governance-read-ui.md) §2.1,
§2.2, §2.4 and invariant 10.*

*__C4 and C5 come off probation, and the verdict is split.__ §7.5 predicted both
were at risk of being ceremony — prose tables bounded by the author's
imagination — and left them untested after 7.1 had no UI. 7.2 exercised both.*

*__C5 changed the implementation, twice, and neither change was in the plan's
prose.__ Its stale-versus-down column is what produced the `plane` field and the
badge that renders it, rather than a `liveAvailable` boolean of the kind M6.4
shipped; and its both-down cell is what made every tally count nullable, because
that cell has no honest number and a non-nullable field would have forced a
fabricated `0` into precisely the figure this page must never fabricate. Both
are mechanisms a reviewer can check, which is the bar §7.5 set.*

*__C4 was filled, every row read "read only", and it changed nothing in this
PR.__ That is the honest reading, and it is not the same as ceremony: the table's
value is a forward obligation on 7.3–7.4, which inherits it as the state set each
new affordance must be decided against — the M6.4 "inactive validators retain
actions" P1 in its preventable form. Judge C4 there, not here.*

*__One assumption was contradicted by the module rather than by a table__, and
neither C4 nor C5 could have caught it: an open proposal's `final_tally_result`
is zeros until the module tallies, so the state read the 7.2 plan named as the
live plane would have rendered "nobody has voted". It was found by building
against the corpus, which is the same lesson 7.1 closed with — the app side's
missing discovery phase is the real gap, and §4b's contribution is telling the
discovery where to aim.*
