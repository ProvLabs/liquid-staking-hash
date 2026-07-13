# nvHASH Console — layout derivation

This document is the **front half of the `page-layout` skill applied to the console**,
produced before any markup was written. It is the spec the implementation is checked
against. For each surface: the page's job, the ranked reader-task list (the committed
hierarchy), the block roles and emphasis levels derived from that ranking, and a
persona triangulation against personas chosen for *conflict*.

Sources: `docs/specs/console-spec.md` (§8 pages, §4 roles, §11 design language),
`docs/specs/dashboard-personas.md` (the five personas). The console is a
**chain-truth verification tool** whose primary user is the Protocol Engineer (Theo);
the load-bearing product value is honesty about state (freshness, guard reasons,
invariant pills), not consumer polish.

## Method recap (why this document exists)

A layout can only be *wrong* against a written ranking. Without one, section placement
is argued locally and post-hoc. So every page below commits a ranked task list first,
maps blocks to roles and four emphasis levels from that ranking, then survives a
triangulation of personas whose objectives collide. Where personas collide, the trade
is **stated and located**, not stumbled into.

### The console's emphasis levels (from spec §11.3 type scale)

- **L1** — 28/36 headline figure or 20/28 page title. The page's #1 answer.
- **L2** — 16/24 section title (600). Prominent, subordinate to L1.
- **L3** — 14/20 body, dense tables. Scannable evidence.
- **L4** — 12/16 caption, `--ink-2/3`. Metadata, deferred, recessive.

### Personas (console projection, spec §4 / §16), used for triangulation

- **Theo** (Protocol Engineer, *primary*): trusts nothing he cannot prove from chain;
  wants raw payloads, invariant/identity pass-fail, guard truth, environment certainty.
- **Kai** (Keeper): runs cranks on cadence; wants guard state + exact clearing times,
  and never to strand a `Releasing` epoch.
- **Pat** (Validator operator): manages eligibility/priority; wants *itemized* failure
  causes and the exact arrears amount + consequence.
- **Ada** (Admin): executes the `x/group` policy; wants diffs, units, blast radius, and
  friction proportional to consequence.
- **Dep** (Technical depositor, verification tail): wants to prove one number (NAV,
  redemption status) against chain, no writes.

These conflict on purpose: Theo/Dep want *maximal visible proof*; Kai/Pat want *fast
reach to one action*; Ada wants *friction before action*. A dense proof surface fights
Kai's speed; a lean action surface fights Theo's proof. That tension drives every trade
below.

---

## Global chrome (spec §8.0)

**Job:** make environment, program health, and data freshness ambient and unmissable on
every page, and route between surfaces by role.

**Ranked tasks:** 1) know *which environment* I am acting against (Theo/Ada's top
anxiety: acting on mainnet when they meant devnet); 2) see any true program alarm
(halted / paused / jail / stale) without hunting; 3) know data freshness before I trust
a number; 4) move between surfaces; 5) connect a wallet and see my role.
**Non-goals:** branding, marketing, anything decorative.

**Roles → placement/emphasis:**
- *Orient* — network badge, non-mainnet is warning-tinted (L2 prominence by color, not
  size). Top bar, first fixation. This is rank 1: environment certainty is a safety
  property, so it gets prominence disproportionate to its size.
- *Reassure/alarm* — banner slot directly under the top bar, computed, non-dismissible
  while true, priority-stacked halted>paused>jail>stale (L1 color / L3 text). Rank 2.
- *Orient* — freshness indicator + block height in top bar and footer (L4). Rank 3.
- *Navigate* — left rail grouped **Monitor** / **Operate** (L4 caption headers, L3
  entries; active = `--accent` indicator + L1 ink). Recessive. Rank 4.
- *Act* — wallet button with detected-role caption (L3). Rank 5, top-right (last
  fixation on the top bar), because most reads need no wallet.

**Triangulation.** Theo vs Kai: Theo wants the proof strip everywhere; Kai wants to
reach a crank fast. Trade (located): health/freshness live in *chrome* (always present,
never in the way), so the page body is free for each surface's own #1 task. Ada:
environment badge is high-visibility off-mainnet precisely so an admin screenshot is
never ambiguous — serves Ada's "signed against the wrong environment" failure directly.

---

## 1. Overview (`/`) — spec §8.1

**Job:** answer "is this instance healthy and are its invariants holding?" in one screen,
with every figure provable from chain. **No write controls.**

**Ranked tasks:**
1. Is it healthy right now? (halted/paused/jail/stale — but those live in chrome) and
   what are the four headline numbers (NAV, net APR, TVV, eligible/enrolled)?
2. Do the invariants hold? (receipt invariant + epoch identity as pass/fail pills.)
3. How is NAV trending, and what did the last epoch actually do?
4. Where is capital deployed (delegated/unbonding/liquid/pending)?
5. Epoch-by-epoch history (the ledger table).
**Non-goals:** any control; consumer education; DEX price (App's job).

**Roles → placement/emphasis:**
- *Act→answer* — four stat tiles (L1 figures over L4 captions), top row, first fixation.
  Rank 1.
- *Evidence (proof)* — the **proof row**: receipt-invariant + identity pills, always on,
  first-class (L2 by position, not size). Rank 2. Per spec §17.1 the honesty surface is
  the product, so it sits above trend/history, not buried.
- *Orient* — health strip (epoch #, phase, last-run, next-eligible) as pills (L3). Rank
  1-adjacent; supports the "healthy?" question.
- *Evidence* — NAV-over-time step line + last-epoch waterfall, side by side (L3, panel
  titles L2). Rank 3.
- *Evidence* — deployment split stacked bar with receipt cross-check caption (L3). Rank 4.
- *Defer* — epoch history table (L3 dense), newest first, below the fold. Rank 5.

**Triangulation.** Theo (prove correctness fast) vs Dep (prove one number): both served
by the tile→proof-row order — the invariant pills are Theo's fastest correctness read
*and* Dep's "is it accruing right" check. Conflict with Kai/Pat: they don't act here at
all, so Overview owes them nothing — resisting the urge to add cranks here keeps rank 1
(health read) uncluttered. **Located trade:** proof row is above trends even though
trends are "prettier"; honesty outranks charts because the primary user is a verifier.

## 2. Validators (`/validators`) — spec §8.2

**Job:** the full participation table in program-priority order, with live eligibility.

**Ranked tasks:** 1) who is eligible/ineligible and *why* (itemized); 2) priority/drain
order (rank 1 = last drained); 3) arrears + commission standing; 4) uptime vs threshold;
5) act on a row (pay commission/tip, report jailed) — secondary.
**Non-goals:** operator's own deep economics (that's the Desk); consumer validator view.

**Roles:**
- *Orient* — summary tiles (enrolled/eligible/arrears/jailed-now), L1 figures. Rank 1 gist.
- *Evidence* — the priority-ordered table (L3 dense, tabular figures), rank number first
  column, status pills itemized. The spine of the page. Rank 1-2.
- *Navigate/act* — row expansion → operator address, grace explanation, per-row secondary
  actions (L4 until expanded). Rank 5, deliberately subordinate.
- *Orient* — filters (eligibility, text) one row above the table; **never re-sort or
  recolor** (rank numbers stay unfiltered-list values). L4.
- *Defer* — drain-order caption under the table (L4).

**Triangulation.** Pat (why am I ineligible?) vs Theo (is the set correct?) vs Kai (who
needs action?). Pat needs *itemized* reasons, not a red dot — so ineligibility renders
each failing condition, not a single pill. Theo needs the whole set sortable by chain
priority — so the table is authoritative-ordered and filtering never reorders (a reorder
would lie about drain order, Theo's failure mode). **Located trade:** row *actions* are
demoted behind expansion so the scan-the-set task (all three personas' shared rank 1)
is never crowded by buttons.

## 3. Epoch & Operations (`/epoch`) — spec §8.3

**Job:** the keeper's cockpit — drive the four cranks with honest guard state, and read
the last epoch's decomposition leg by leg.

**Ranked tasks:** 1) can I run a crank right now, and if not *why and when*; 2) is a
continuation stranded (`Releasing`)?; 3) what did the last epoch do, and does the
identity reconcile?; 4) the live program parameters.
**Non-goals:** scheduling/automation (console is cockpit not autopilot, §16.2); editing
config (that's Admin).

**Roles:**
- *Act* — the four crank buttons with guard preflight (enabled / disabled-with-reason-and-
  time / hidden). **This is the page's rank-1 Act.** L2 buttons, top of content, at the
  keeper's first fixation. The claim-before-run cadence hint sits between Claim and Run.
- *Orient* — lifecycle panel: phase + explanation, last-run, next-eligible countdown,
  pending queues as tables. When `Releasing`, foregrounds "continuation pending". Rank 2,
  adjacent to the Act it unblocks (Reassure role for the guard state).
- *Evidence* — last-snapshot decomposition with the **identity cross-check pass/fail
  pill** (L2 pill; a fail is a critical pill, monitoring not decoration). Rank 3.
- *Defer* — program parameters read-only (L3). Rank 4.

**Triangulation.** Kai (act fast, never strand a continuation) vs Theo (verify the epoch
reconciled). Kai's rank 1 is the crank + its guard; Theo's is the identity check. **Located
trade:** cranks lead (Kai) but the identity pill is first-class and adjacent to the
snapshot (Theo), not buried in a tooltip — both rank-1 needs are on one screen, cranks
top-left (Kai's fixation), decomposition below (Theo reads after acting). The `Releasing`
foregrounding is the located compromise for Kai's "stranded epoch" failure mode.

## 4. Redemptions (`/redemptions`) — spec §8.4

**Job:** show the pending swap-out queue, each request's funded/maturity state, and the
reserve math — provable against chain.

**Ranked tasks:** 1) reserve need vs marker liquidity (is the queue funded?); 2) per-
request funded/maturity/estimate, own rows pinned; 3) service redemptions (the one
action); 4) the 60-day/expedite framing for a depositor verifying.
**Non-goals:** guided redeem flow, DEX quote, slippage (App's job).

**Roles:**
- *Act→answer* — reserve panel: need = Σ estimate×1.005 vs marker liquid, two figures +
  one proportion bar (L1 figures). Rank 1.
- *Evidence* — queue table: id, owner chip (own rows highlighted+pinned), shares, estimate,
  enqueue, maturity countdown, funded pill. L3 dense. Rank 2.
- *Act* — `Service redemptions` button (same guard component as Epoch page). Rank 3, L2.
- *Reassure* — depositor framing explainer at top (L4, static). Rank 4.

**Triangulation.** Dep (prove my redemption is safe/funded) vs Theo (does reserve math
reconcile) vs Kai (should I service now?). Dep and Theo share the reserve-panel-first
ordering; Kai's action is present but subordinate (rank 3) because the *read* is the
page's job. **Located trade:** the depositor explainer is L4 at the top, not a hero — the
audience is technical, so framing is available but never crowds the reserve figures
(resisting the consumer-calm register the spec §17.1 explicitly forbids here).

## 5. Validator Desk (`/desk`, wallet required) — spec §8.5

**Job:** the operator's home — enroll, read own eligibility *itemized*, manage commission
and TIP.

**Ranked tasks:** 1) am I eligible, and if not exactly which conditions fail; 2) arrears
— exact amount to clear + consequence; 3) TIP/priority — what a payment buys in rank; 4)
enroll/unregister.
**Non-goals:** the whole validator set (that's the Validators page); consumer economics.

**Roles:**
- *Orient/act* — enrollment card when not enrolled (the page's entry Act); after
  enrollment, `Unregister` behind warning confirm (L4). Rank 4 once enrolled.
- *Evidence* — own-validator card: eligibility with **each failing condition listed**
  (L1/L2). Rank 1. This is Pat's whole reason for the page.
- *Reassure/act* — commission panel: accrued/paid/due; in-arrears → serious callout with
  exact clear amount + "ineligible until paid" + `Pay commission…`. Rank 2.
- *Act* — TIP panel: current TIP, rank-neighbor hint ("500 HASH moves you above rank 6"),
  `Pay tip…` with per-epoch-reset + non-refundable called out. Rank 3.

**Triangulation.** Pat (fast, terse, act) vs the program (payments must be understood —
non-refundable, loud) vs Theo (verify the operator surface is correct). **Located trade:**
eligibility is itemized and top (Pat's rank 1), payment *actions* are one confirmed step
with the consequence loud (program's need for informed, non-refundable payment) — the
warning is a checkbox step, not inline prose that would slow Pat's read. This is the same
tension as the skill's worked example (power-user speed vs. informed caution); resolved by
"scannable state up top, consequence at the action."

## 6. Jail Watch (`/jail`) — spec §8.6

**Job:** open jail reports with purge countdowns and the two-phase purge action.

**Ranked tasks:** 1) which reports are open and when each becomes purge-ready; 2) is the
target *still* jailed (live); 3) report a newly-jailed validator; 4) purge (with/without
claimant).
**Non-goals:** validator economics; the full set (Validators page).

**Roles:**
- *Evidence* — open-reports table: valoper+moniker, reported-at, purge-ready countdown,
  live jailed status, purge action. L3. Rank 1.
- *Act* — report card (pre-filtered to jailed rows) → `ReportJailedValidator`. Rank 3.
- *Act* — purge flow with optional claimant selector (own eligible validators, headroom
  shown); claimant-less button is warning-styled "Unbond full program stake". Rank 4.
- *Reassure* — two-phase rule explained inline (L4). Rank 2 (it prevents a wrong action).

**Triangulation.** Kai (clear jails on cadence) vs Theo (verify the two-phase rule holds)
vs Pat-as-claimant (claim redelegation to my validator). **Located trade:** the countdown
+ live-jailed status lead (Kai/Theo); the claimant path is subordinate and only lists the
connected operator's eligible validators — Pat's opportunity is present but never the
page's focus, keeping the keeper read clean.

## 7. Admin (`/admin`, admin only) — spec §8.7

**Job:** execute admin controls with friction proportional to consequence; every action
danger/warning-styled and confirm-gated.

**Ranked tasks:** 1) understand exactly what an action does before signing (diff, units,
blast radius); 2) edit config safely (diff preview, only changed fields submitted); 3)
halt/resume + vault pause/unpause; 4) recovery (`ClearPendingDelegations`).
**Non-goals:** any non-admin surface; casual use (this page is deliberately high-friction).

**Roles:**
- *Reassure* — opening note: authority is the `x/group` policy; console builds the
  message, the group executes (L3). Rank 1-adjacent (frames the whole page).
- *Act* — config editor with **diff preview** (old→new, changed-only), per-field units +
  % equivalents (L2 sections). Rank 2.
- *Act* — halt/resume + vault pause/unpause, blast radius listed, danger-styled (L2). Rank 3.
- *Act* — recovery with the §9.9 safety explanation + typed confirmation (L2). Rank 4.

**Triangulation.** Ada (act safely, understand blast radius) vs Theo (verify the message
JSON is what will execute). Both served by "message preview is total" — the diff + exact
JSON before signing serves Ada's "signed something whose effect wasn't clear" failure
*and* Theo's "prove what executes". **Located trade:** the page is uniformly high-friction
(typed confirms, danger styling) — friction that would be wrong on the keeper page is
*correct* here because consequence is maximal; emphasis (danger color) is spent on making
irreversibility legible, not on visual calm.

---

## Cross-surface invariants (checked at build, per the skill's non-negotiables)

- **One primary action per view.** Overview/Validators/Redemptions/JailWatch are read-first;
  their single "primary" is a `Service redemptions` / crank where present, everything else
  secondary/ghost. Epoch page's four cranks are guard-gated peers, not four filled
  primaries — `Run epoch` carries primary, the rest secondary (avoids the two-primary
  anti-pattern).
- **Emphasis follows the task ranking, never decoration.** Proof pills outrank charts on
  Overview; itemized eligibility outranks actions on the Desk.
- **Visual order == DOM order == focus order.** Authored top-to-bottom in reading order;
  no CSS reordering. Left rail is `<nav>` first in DOM for skip-nav, visually left.
- **Group by proximity** (spec §11.4: section gap 24, panel padding 20, panel-header 12px
  gap owned by the header wrapper not the title — spec §11.4 normative rule).
- **Status is never color alone** (spec §11.5 pills = icon + label); satisfies the skill's
  reserved-status rule and CVD safety.
- Charts follow the repo dataviz method; palette changes re-run `validate_palette.js`
  (spec §11.6.5). Layout structure re-runs `page-layout/scripts/validate_layout.js`.
