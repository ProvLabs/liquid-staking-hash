# nvHASH Liquid Staking Program — User Personas

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/liquid-staking-dashboard-personas.md`. Paths updated for this repository's layout.

> **Status:** Baselined. Product parameters in §2 are confirmed except where marked _(open)_. This
> artifact defines **personas only** — the people who use the whole nvHASH program, across every
> surface they touch: the on-chain contract and vault, validator participation and permissionless
> upkeep, multisig governance, secondary-market (DEX) liquidity, and the web console that makes those
> legible. Concrete screens, data contracts, and on-chain message shapes live in the downstream specs
> that reference this document.

---

## 1. Purpose & Scope

This document defines the user personas for the **liquid staking (LST) program** as a whole — not a
single interface. The product pools deposited tokens, stakes them against network validators, actively
manages those stakes for network performance and security, and issues a transferable liquid staking
token that represents the staked position without requiring the holder to unstake the underlying.
These personas describe the people who use that program across **every surface it exposes**: the
on-chain contract and vault, validator participation and permissionless upkeep, multisig governance,
secondary-market (DEX) liquidity, and the web console that makes those legible.

These five personas are the primary input for downstream specification across the system: the contract
interface and role model, information architecture and role-based access, screen/widget definition,
governance flows, and the trust and education surfaces. Each persona is written as a build-usable
unit — goals, jobs-to-be-done, required data, permitted actions, success signals, and failure modes —
so it can be traded directly against contract, UI, and operational requirements.

**Scope of this artifact: personas only.** Concrete screens, widgets, data contracts, and on-chain
message shapes live in the specifications that reference this document, not here.

---

## 2. Confirmed Product Parameters

- **Personas:** Five (Evaluator, Position Holder, Validator, Administrator, Protocol Engineer).
- **Delivery surface:** **Two complementary applications**, split along the trust/architecture seam
  (see `../architecture/application-boundary.md`): a **chain-truth verification console** — no backend, reads and
  proves on-chain state directly, the primary home of the Protocol Engineer and the technical operator
  roles — and a **full-featured application on top of the vault** — holds its own state and serves
  education, transactions, off-chain-augmented data, and analytics for the Evaluator, Position Holder,
  and the consumer-facing needs of the other personas. Each persona is served by whichever surface fits
  its job; several use both.
- **Chain / stack:** **Provenance Blockchain** (Cosmos SDK). The underlying staking asset is **HASH**;
  the LST is a liquid staked-HASH representation.
- **Token model:** **Value-accrual** LST. Program rewards flow back into the pool, raising each
  token's value in underlying (HASH) terms over time. There is no rebasing and no separate "peg" to
  defend — the LST↔underlying exchange rate rises monotonically as rewards accrue.
- **Creation:** Instant. Underlying → LST at the current protocol exchange rate.
- **Native redemption:** LST → underlying at the protocol rate, subject to a **lengthy unbonding
  period (several weeks)**.
- **Secondary liquidity:** LST trades on **DEX pools and similar venues**, giving holders an
  instant exit at market price (which may sit at a premium or discount to protocol redemption value)
  without waiting out unbonding.
- **Admin governance:** An **n-of-m multisig of designated, known admins**, implemented with the
  **Cosmos `group` module** on Provenance. Proposals, votes, and execution follow `group`/`group-policy`
  semantics.
- **Validator participation:** Opt-in by accepting program terms; self-removal at will. Validators may
  execute other appropriate program actions (e.g. voting for new governance admins) and
  monitor/execute permissionless upkeep actions that keep the program running. Eligibility to
  **receive** stake is gated on performance metrics (e.g. uptime, minimum operating tenure) — not on
  compliance.
- **Validator fees:** A **pro-rata share of the commission** a validator earns on program-delegated
  stake, owed to stay in good standing. Example: earn 100 HASH in commission from program delegation →
  owe 10 HASH in fees. The fee scales with program-derived commission, so it is zero when program
  stake earns nothing.
- **Compliance:** No KYC/allowlist gating for stakers or validators.

- **Auth / signing:** **WalletConnect v2** interface to wallets, across all roles.

**Still open _(low-order; do not block persona work)_:** the published eligibility-threshold values
(uptime, minimum tenure) are TBD; the specific permissionless upkeep action set is TBD; the concrete
`n`/`m` values for the `group` policy are TBD.

---

## 3. Shared Design Principles

1. **Progressive disclosure.** Every persona starts at a glanceable overview and drills into
   verifiable detail. No persona is forced through data it doesn't need to reach its goal.
2. **Verifiability over assertion.** Wherever the UI states a number (APR, exchange rate, TVL,
   commission, fees), a path to the on-chain source or contract call should exist.
3. **Read-safe by default, write-gated explicitly.** Viewing is open within a role; any state-changing
   or fund-moving action is confirmed, previewed (decoded), and signed.
4. **Consistent economic vocabulary.** APR vs. APY, "underlying" vs. "LST," "exchange rate" vs.
   "market price," gross vs. net-of-fee yield — defined once, used identically across all four views.
5. **Trust signals are persistent.** Audit status, exchange-rate/accrual health, validator-set health,
   and incident state are surfaced at the surface level, not only in an admin console.

---

## 4. Access & Role Model

| Role | Auth | Read scope | Write scope |
|------|------|-----------|-------------|
| Evaluator | None / read-only wallet connect | Public system + historical data | None |
| Position Holder | Connected wallet | Own position + public system data | Create, redeem/unbond, transfer/trade |
| Validator | Authorized validator identity + signer | Own allocation, obligations, benefits + public data | Opt-in/out, pay fees, govern-vote, run upkeep actions |
| Administrator | Multisig-member identity + signer | Full system state, all cohorts' health signals, governance queue | Propose, vote, and dispatch admin transactions via multisig |
| Protocol Engineer | Direct devnet key or connected wallet, per environment | Full on-chain state of any instance (local / testnet / mainnet) and the raw query surface | Every contract endpoint available to the connected address (keeper / operator / admin as it qualifies); no off-chain writes |

Roles are additive (a Position Holder may also be a Validator), so the view model should compose
rather than assume mutual exclusivity. The **Protocol Engineer** is a cross-cutting technical role
rather than a fund-holding one: on a local devnet they typically hold every key and exercise all
endpoints, while against testnet/mainnet their write scope is whatever the connected address qualifies
for. They are the primary user of the chain-truth verification surface (see
`../architecture/application-boundary.md`).

---

## 5. Persona 1 — The Evaluator

**Archetype:** Prospective participant doing first-pass and then deeper due diligence.

**Narrative.** Casey has heard of liquid staking and is comparing options. They arrive knowing little
about *this specific* product and want to understand — quickly and in plain language — what it does,
how the token stays exchangeable without unstaking, and where the yield comes from. If the concept
lands, curiosity converts into scrutiny: is it secure, has it performed, and can I exit when I want?
Casey holds no position and will not connect a wallet until convinced.

**Primary goal.** Decide whether the product is understandable, safe, and performant enough to
participate.

**Journey stages.**
1. *Comprehension* — grasp the mechanism at a high level.
2. *Due diligence* — validate security and historical performance before committing.

**Jobs to be done.**
- When I first land, help me understand *what this is* and *how the token gains value* without jargon,
  so I can decide whether it's worth my time.
- When I'm interested, let me verify the system is secure and has performed, so I can trust it with capital.
- Before I commit, show me both exit paths — instant DEX trade vs. multi-week unbonding — so I know
  I'm not trapped.

**Key questions to answer.**
- What is a liquid staking token, and how does its value grow while the underlying stays staked?
- Where does the yield come from, and what's the current and historical rate?
- Who runs the validators, and what happens if one misbehaves (slashing, downtime)?
- Has this been audited? What's the smart-contract risk?
- How large/mature is the system (TVL, age, participant count)?
- How do I exit — trade on a DEX now, or unbond and wait several weeks?

**Data & views required.**
- Plain-language explainer + a visual flow: *deposit → pool → validators → rewards → value accrues into LST*.
- Current APR/APY and a historical performance chart (clear gross vs. net framing).
- Total value staked (TVL), participant count, system age/maturity indicators.
- Exchange-rate (accrual) history, and current DEX market price vs. protocol redemption value.
- Security posture panel: audits (with links), validator-set overview, slashing/incident history.
- Exit explainer: DEX liquidity depth (instant, market price) vs. native unbonding (protocol rate, multi-week).

**Actions / controls.** None (read-only). Primary CTA: "Connect wallet to deposit" once convinced.

**Success signals.** Low time-to-comprehension; a meaningful share of Evaluators proceed to
due-diligence views and then to first deposit.

**Anxieties & failure modes.** "Is this a scam?"; fear of being unable to exit; opaque yield source;
unaudited contracts; jargon that fails the comprehension stage and causes bounce.

---

## 6. Persona 2 — The Position Holder

**Archetype:** Active depositor managing an existing LST position.

**Narrative.** Priya has tokens deposited and now cares about performance and correctness. She checks
in to confirm her position is growing as expected via the rising exchange rate, and that the system is
healthy. She wants to manage her position — add, exit via DEX, or start unbonding — and be alerted if
anything looks wrong. Her trust is conditional and ongoing.

**Primary goal.** Monitor and manage her position's performance and confirm the system is operating
correctly.

**Jobs to be done.**
- When I check in, show me what my position is worth and how it's accruing, so I know it's working.
- When I decide to act, let me add, trade on a DEX, or start unbonding cleanly, so I stay in control.
- When something's off, alert me and let me verify the exchange rate and market price, so I'm not
  silently losing.

**Key questions to answer.**
- What is my position worth, in both LST and underlying terms?
- What have I earned via accrual, and what's my effective yield vs. the advertised rate?
- Is the exchange rate accruing correctly, and where is LST trading on the DEX relative to redemption value?
- What are my exit options right now — instant DEX trade (with slippage) vs. unbond (with the multi-week wait)?
- Is the underlying system healthy (validator set, incidents)?
- What's my full transaction history for records/taxes?

**Data & views required.**
- Position summary: balance in LST and underlying, current value, accrued gains.
- Personal performance: effective APR/APY over time vs. system-advertised rate.
- Exchange-rate / accrual tracker, plus DEX market price and the premium/discount spread to redemption value.
- Exit panel: DEX quote (liquidity/slippage, instant) vs. native unbond (protocol rate, unbonding countdown).
- Transaction history (creations, redemptions/unbonds, transfers, DEX trades) — exportable.
- System-health strip (shared with Evaluator) for self-verification without leaving the dashboard.
- Configurable alerts (large rate movement, DEX depeg from redemption value, incident).

**Actions / controls.** Create/add; trade LST on DEX; start native unbonding; transfer LST; set alert
thresholds.

**Success signals.** Regular return visits; low support load on "where are my funds / is this right?";
retained TVL; positions managed in-app rather than exited to a competitor.

**Anxieties & failure modes.** DEX price diverging unfavorably from redemption value; yield quietly
underperforming the headline; the multi-week unbonding wait; fear that a validator issue erodes her
stake; unclear exit trade-offs.

---

## 7. Persona 3 — The Participating Validator

**Archetype:** Validator operator enrolled in the program.

**Narrative.** Owen runs a validator that receives delegated stake from the pool. He needs a fast read
on stake coming his way, what he owes (a pro-rata share of his program commission, owed to stay in good
standing), and what he earns net of that. He accepts
program terms to participate and can remove himself at any time. Beyond his own position, he takes part
in program governance — voting for new governance admins — and keeps an eye on the permissionless
upkeep actions that keep the system running, executing them himself when needed. He's economically
motivated and watching whether he's clearing the performance bar to keep receiving stake.

**Primary goal.** Understand the economics and obligations of participation, execute his authorized
program actions, and keep the program healthy where he can.

**Jobs to be done.**
- When I open the dashboard, show me current and incoming stake, so I can plan capacity.
- Show me what I owe (fees) and what I earn, so I can judge whether participation pays.
- Let me accept terms, leave, pay fees, and vote for governance admins, so I can operate without going off-platform.
- Show me the permissionless upkeep actions and their status, so I can run them if the program needs it.
- Show me how I'm performing against the eligibility bar, so I don't lose my ability to receive stake.

**Key questions to answer.**
- How much stake do I have from the program now, and how much is inbound (or being reallocated away)?
- What am I earning from program stake, net of fees?
- What fee is due (my pro-rata share of program-derived commission), and what's my current standing?
- Am I clearing the performance thresholds (uptime, tenure) required to receive stake?
- What program/governance actions can I take right now (accept terms, opt out, vote for admins)?
- Which permissionless upkeep actions are pending or overdue, and should I execute them?

**Data & views required.**
- Stake overview: current delegated stake, projected/incoming stake, recent reallocations.
- Economics: rewards earned, distribution schedule, net benefit after fees.
- Standing & fees: commission earned from program stake, the derived pro-rata fee owed, payment
  history, and good-standing status.
- Eligibility panel: uptime, tenure, and other threshold metrics vs. the program's bar, with headroom.
- Participation controls: accept/renew terms, opt out, pay fees, vote for governance admins.
- Upkeep console: list of permissionless "keeper"/crank actions, their state (pending/overdue), and an
  execute control with a decoded preview.
- Performance vs. peers (rank/comparison) for context.

**Actions / controls.** Accept program terms (opt-in); self-remove (opt-out); pay fees; vote for new
governance admins; execute permissionless upkeep actions. Each state-changing action is decoded and
signed.

**Success signals.** Validators self-serve in-app; low churn/opt-out; performance thresholds met;
upkeep actions run promptly; disputes about fees/allocation are low because the criteria are transparent.

**Anxieties & failure modes.** Unpredictable stake swings; falling below the eligibility bar and losing
allocation; slashing risk; fees eroding the benefit; missing an overdue upkeep action; executing a
control without understanding its effect.

---

## 8. Persona 4 — The Program Administrator

**Archetype:** Steward of the contracts and overall program, governing via multisig.

**Narrative.** Grace is one of a designated, known set of admins responsible for the system. She wants
a system-wide health read, the ability to spot and address issues fast, and a sense of whether each
user cohort is satisfied. Admin actions are not unilateral — they go through an n-of-m multisig. So she
needs to see governance proposals in progress, the current tally and threshold status, who has voted
and how, and to cast her own vote and dispatch the transaction once the threshold is met.

**Primary goal.** Keep the system healthy and correctly governed — monitor, respond to issues, and
participate in multisig governance.

**Jobs to be done.**
- When I open the console, give me a system-wide health read, so I know if anything needs me.
- When something breaks, let me diagnose and act fast, so impact stays contained.
- Show me whether each cohort (evaluators, holders, validators) is satisfied, so I can steer the program.
- Let me review, vote on, and dispatch admin actions once the multisig threshold is met, so governance
  is safe and auditable.

**Key questions to answer.**
- What is the overall system state — TVL, APR, exchange-rate/accrual health, validator-set health, treasury?
- Are there active incidents or anomalies, and where?
- How are the other cohorts doing (adoption, retention, validator churn, upkeep-action lag, complaint signals)?
- What admin proposals are in progress, what's the tally, and does it meet the n-of-m threshold?
- Who has voted, and how?
- What exactly does a proposed transaction do (decoded) before I sign?

**Data & views required.**
- System overview: TVL, aggregate APR, exchange-rate/accrual health, validator-set health, treasury/reserves.
- Incident / alert feed with drill-down and severity.
- Cohort-satisfaction dashboard: holder adoption/retention, validator churn/eligibility, evaluator
  conversion, upkeep-action timeliness, support/complaint signals.
- Governance console:
  - list of pending proposals with decoded action, proposer, and rationale;
  - tally + n-of-m threshold state;
  - per-signer vote status (who voted, how, when);
  - cast-vote and dispatch/execute controls, signed;
  - history/audit trail of past proposals and outcomes.

**Actions / controls.** Create proposals; cast votes; dispatch/execute admin transactions once the
threshold is satisfied; acknowledge/triage incidents. All privileged actions decoded and signed.

**Success signals.** Issues detected and resolved quickly (low MTTR); governance actions are quorate,
auditable, and completed without out-of-band coordination; cohort-health metrics trend positive.

**Anxieties & failure modes.** Missing a critical incident; a proposal stalling for lack of quorum;
signing a transaction whose true effect wasn't clear (decoding failure); governance-key security; not
knowing a cohort is churning until it's material.

---

## 9. Persona 5 — The Protocol Engineer

**Archetype:** Blockchain protocol & smart-contract engineer with decades of experience, who both
builds the system and operates/observes its deployments.

**Narrative.** Theo has spent decades writing protocol and smart-contract code. On this program he
wears two hats that feed each other. As a **builder**, Theo develops and maintains the CosmWasm
contract and its surrounding tooling — sometimes writing code directly, sometimes pairing with Claude
for assisted development, and continuously validating changes against a **local devnet instance** where
the full epoch lifecycle can be driven and inspected end to end. As an **operator/observer**, he watches
the **testnet and mainnet** deployments of that same software, confirming they behave as designed and
catching anomalies early. When Theo — or a downstream user — finds a bug or a needed feature on a live
deployment, it becomes a work item that cycles back into development, is verified locally, and ships
forward into test and then mainnet. Theo trusts nothing he cannot verify against the chain itself; a
tool that paraphrases state instead of proving it is worse than useless to him.

**Primary goal.** Keep the deployed software correct and evolving: verify that any instance — local,
testnet, or mainnet — behaves exactly as the contract specifies, and close the loop from observed
defect to fix to redeployment.

**Journey stages.**
1. *Develop & verify locally* — build or change code (direct or Claude-assisted), then drive and
   inspect a local devnet instance to confirm the change is correct.
2. *Observe deployments* — monitor testnet/mainnet instances for correct behavior and anomalies.
3. *Diagnose & cycle* — turn an observed defect or request into a development work item, fix it,
   re-verify locally, and promote it through test to mainnet.

**Jobs to be done.**
- When I change the contract, let me drive a local instance through its full lifecycle and see every
  state transition exactly, so I can confirm the change is correct before it leaves my machine.
- When I review any instance, show me the raw chain truth — queries, invariants, guard state — not a
  summary, so I can trust what I'm seeing.
- When I operate a deployment, let me execute every contract endpoint from one place, so I can
  reproduce, probe, and exercise the system without hand-building transactions.
- When something looks wrong on a deployment, give me enough on-chain evidence to reproduce it locally,
  so I can turn it into a fix.
- When I promote a fix, let me point the same tool at devnet, testnet, and mainnet, so verification is
  identical across environments.

**Key questions to answer.**
- Does this instance's on-chain state satisfy the contract's invariants right now (receipt invariant,
  epoch identity, reserve math)?
- What is every guard's current state, and would a given execute succeed or fail — and why?
- What did the last epoch actually do, decomposed leg by leg, and does it reconcile?
- Is the deployed build the one I expect (contract code hash / version), and does its config match intent?
- When a value looks wrong, what raw query produced it, and can I reproduce it against a local instance?
- Which environment am I looking at, unambiguously, and am I about to act against the right one?

**Data & views required.**
- The full contract query surface rendered exactly (config, epoch status, validators, jail reports,
  snapshot, APR), with raw-payload access behind every derived number.
- Invariant and identity checks as first-class pass/fail signals, not buried tooltips.
- Guard-state preflight for every execute endpoint, with the specific reason and clearing time when blocked.
- The complete execute surface (cranks, operator, admin) reachable from one place, with full
  message-JSON preview before signing.
- Unambiguous environment identification (chain id, contract address, deployed build/version) surfaced
  persistently.
- A devnet direct-key signing mode for driving local drills without a browser wallet.
- Read freshness/liveness, so a stalled node is visible immediately.

**Actions / controls.** Every contract endpoint — permissionless cranks, operator actions, admin
controls — executed with full transaction preview; against local devnet (direct-key drills) or a wallet
on test/mainnet. No off-chain state is created; the tool only reads the chain and submits transactions
to it.

**Success signals.** Changes are verified locally before promotion; deployed-instance anomalies are
caught and reproduced quickly; the loop from observed defect to fixed redeployment is short; the same
tool serves devnet, testnet, and mainnet without modification; no "the UI said X but the chain said Y"
surprises.

**Anxieties & failure modes.** A tool that paraphrases chain state instead of proving it; acting against
the wrong environment (mainnet when they meant devnet); a stale or wishful UI masking true on-chain
state; missing an invariant break because it was buried; being unable to reproduce a live defect
locally; signing a transaction whose true effect wasn't shown.

---

## 10. Cross-Persona Feature Matrix

| Capability | Evaluator | Holder | Validator | Admin | Engineer |
|---|:--:|:--:|:--:|:--:|:--:|
| Mechanism explainer / education | ● | ○ | ○ | ○ | ○ |
| System health & security posture | ● | ● | ● | ● | ● |
| Historical performance / APR | ● | ● | ● | ● | ● |
| Exchange-rate / accrual tracker | ● | ● | ○ | ● | ● |
| DEX market price vs. redemption value | ● | ● | ○ | ○ | ○ |
| Personal position & accrued gains | — | ● | — | — | — |
| Create / trade / unbond | — | ● | — | — | ○ |
| Stake allocation (incoming/current) | — | — | ● | ● | ● |
| Fees & good-standing | — | — | ● | ● | ● |
| Validator eligibility metrics | — | — | ● | ● | ● |
| Governance-admin voting | — | — | ● | ● | ○ |
| Permissionless upkeep monitor/execute | — | ○ | ● | ○ | ● |
| Cohort-satisfaction signals | — | — | — | ● | — |
| Incident / alert feed | ○ | ○ | ○ | ● | ● |
| Multisig governance console | — | — | — | ● | ○ |
| Raw chain-truth queries & invariant checks | ○ | ○ | ○ | ● | ● |
| Full contract execute surface (all endpoints) | — | — | ○ | ○ | ● |
| Multi-environment operation (devnet/testnet/mainnet) | — | — | — | ○ | ● |

● primary · ○ secondary/shared · — not applicable

The last three rows are the chain-truth verification capabilities the Protocol Engineer centers on;
they map primarily to the **console** surface, while most rows above map to the **app** surface for the
consumer personas (see `../architecture/application-boundary.md`).

---

## 11. Remaining Open Items (non-blocking)

Persona work is complete. The following are deferred configuration/enumeration details that refine
downstream screen and contract specs but do not change the personas:

1. **Eligibility thresholds** — the published config parameters (uptime, minimum tenure) for receiving
   stake are not yet defined.
2. **Permissionless upkeep set** — the specific keeper/crank actions and their triggers are TBD.
3. **`group` policy values** — concrete `n`/`m` (decision threshold, member set) for the Cosmos `group`
   admin policy on Provenance.
4. **Fee cadence** — how often the pro-rata commission fee is assessed/settled (per epoch, per claim, etc.).
