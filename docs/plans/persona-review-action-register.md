# Persona-Review Action Register — nvHASH Program & Console

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/persona-review-action-register.md`. Paths updated for this repository's layout.

**Created:** 2026-07-10 · **Owner:** Ira
**Inputs:** [`../specs/dashboard-personas.md`](../specs/dashboard-personas.md) (the canonical
four personas), [`../specs/liquid-staking-spec.md`](../specs/liquid-staking-spec.md) (root/contract spec,
v1.0 baselined), [`../specs/console-spec.md`](../specs/console-spec.md) (console spec, v1.0-RC1).

## Purpose

The four personas — **Evaluator, Position Holder, Validator, Administrator** — are used here as an
**adversarial check** on the two specifications. Not every persona is satisfiable by every design
decision, so each item below names the persona pressing the concern, the spec decision it collides
with, and a concrete action to resolve or consciously accept the trade-off. Work these one at a time;
each is written to be dispatched as its own follow-up.

**How to read the status column:** `OPEN` = needs a decision; `DECIDE` = a scoped choice; `ALIGN` =
make two documents agree; `SPEC` = design work to add once scoped. Priority: **P1** shapes product
scope, **P2** reconciles models/data, **P3** is consistency/messaging.

---

## P1 — Product-scope conflicts (decide before the console is certified)

### A1. The Evaluator has no home in the console — `OPEN`
**Persona:** Evaluator (Casey) — entire *Comprehension* stage; also the shared "trust signals are
persistent" principle.
**Collision:** The console is explicitly "depositor-**calm**" and the Overview (console §8.1) assumes a
reader who already understands liquid staking — NAV/APR/TVV tiles, no plain-language explainer, no
"what is this / where does the yield come from / how do I exit" content. The Evaluator "holds no
position and will not connect a wallet until convinced," and there is no surface built to convince
them.
**Action:** Decide whether the Evaluator is in scope for console v1.
- If **yes**: spec an education/orientation surface — mechanism flow (*deposit → pool → validators →
  rewards → value accrues*), yield-source explainer, stepwise-NAV honesty (see A/E4), and an exit
  explainer — as a new landing page or an Overview "Learn" mode.
- If **no**: record that the Evaluator is served by separate marketing/docs and specify the handoff
  point ("Connect wallet to deposit" CTA target), so the gap is a decision, not an omission.

### A2. In-console create / redeem / unbond — required by the Position Holder, deferred by the console — `DECIDE`
**Persona:** Position Holder (Priya) — core JTBD "let me add, trade, or start unbonding cleanly."
**Collision:** Console §4, §8.1 ("contains **no write controls**"), and §17.3 defer all depositor writes
(`SwapIn`/`SwapOut`) to post-v1; v1 depositors are told to act "against the vault directly or via
wallet tooling."
**Action:** Decide whether console v1 ships depositor create/redeem/unbond flows. Either (a) pull the
swap surfaces into v1 and revise §8.1/§17.3, or (b) accept vault-direct action for v1 and explicitly
downgrade the Position Holder's in-app expectation with rationale. This is the single largest
product-scope conflict; resolve it first because A1, D1, D2 partly depend on it.

### A3. DEX / secondary-market price — required by Evaluator + Holder, no data source in the console — `OPEN`
**Persona:** Evaluator and Position Holder — "DEX market price vs. redemption value," premium/discount
spread, slippage quotes, DEX liquidity depth; the "instant exit" path.
**Collision:** The console reads **only** the Provenance LCD (contract + vault + staking/bank modules,
console §5). The DEX/Uniswap liquidity lives on **Base/Ethereum** via the NUVA bridge (root §1, §11.5).
A no-backend, single-node, Provenance-only SPA has no path to secondary-market price or depth.
**Action:** Decide the source and scope of DEX price/liquidity: an off-chain price feed / oracle, a
cross-chain read, or out-of-scope for v1. If in scope, reconcile it with the "chain plus one node, no
backend" trust model (console §3.1, §12); if out, remove the DEX-price expectation from the personas
and note where holders find secondary pricing.

### A4. Admin cohort-satisfaction analytics vs. the no-backend architecture — `OPEN`
**Persona:** Administrator (Grace) — "cohort-satisfaction dashboard: holder adoption/retention,
validator churn, evaluator conversion, upkeep timeliness, support/complaint signals."
**Collision:** The console is a static SPA whose only history is a **per-browser** epoch ledger (console
§5.3, §9.3). Adoption/retention/conversion/complaint signals are off-chain, longitudinal analytics the
architecture cannot produce.
**Action:** Decide where admin cohort analytics live: the deferred indexer (console §17.3), a separate
ops/analytics tool, or out of scope for the console. Make the trade-off explicit in both the persona
doc and console §8.7/§16.4 so the Administrator persona is not promised a dashboard the console can't
render.

---

## P2 — Actor-model & data-source reconciliation

### B1. Two different four-actor models — `ALIGN`
**Collision:** Personas = {Evaluator, Position Holder, Validator, Administrator}. Console =
{Depositor/observer, Keeper, Validator operator, Admin}. Mapping is not one-to-one: **Evaluator** ↔
(nothing), **Keeper** ↔ folded into the persona-doc Validator, **Position Holder** ↔ read-only
Depositor (see A2).
**Action:** Ratify one reconciled actor map used by all three docs. Decide whether "Keeper" is a
first-class actor or a Validator sub-role, and where the Evaluator lands. The reference notes just added
to console §4 and both §16 sections are placeholders for this decision.

### B2. Validator governance-voting — in the personas, absent from both specs — `DECIDE`
**Persona:** Validator (Owen) — "vote for new governance admins" is a first-class permitted action;
personas §2/§4 grant validators governance participation.
**Collision:** Root §4 limits validators to register/unregister/commission/TIP. Governance authority is
the `x/group` **admin** policy (root §12.1), whose membership is TBD (root §14.10; personas §10.3
"`group` policy values"). Neither spec gives validators a vote or a voting surface; the console operator
role (console §4) has none.
**Action:** Decide whether validators are (or elect) `x/group` members with a voting surface.
- If **yes**: spec the governance-vote flow in the contract/group policy *and* a console surface for it
  (currently the console has no governance console for any non-admin role).
- If **no**: correct the Validator persona to drop admin-voting, keeping only opt-in/out, fees, and
  permissionless upkeep.

### B3. Keeper duties framed as Validator work — `ALIGN`
**Persona:** Validator — "monitor/execute permissionless upkeep actions" (the cranks).
**Collision:** The console assigns cranks to a standalone **Keeper (Kai)**; any connected wallet
qualifies (console §4). The persona folds keeper duties into the Validator with no standalone keeper.
**Action:** Confirm the intended operating model (dedicated keepers + opportunistic validators, or
validators as primary keepers) and align the Upkeep/Epoch-Ops surface framing (console §8.3) with the
Validator persona's upkeep console expectation. Depends on B1.

---

## P2 — Trust-signal & content gaps (shared "trust signals are persistent" principle)

### C1. No audit-status surface — `SPEC`
**Persona:** Evaluator ("Has this been audited? What's the smart-contract risk?"); shared trust-signal
principle.
**Collision:** A third-party audit is mandatory (root §1, §14) but the console has no audit/security
panel anywhere.
**Action:** Spec an audit / security-posture panel (audit firm, scope, date, report links, contract
version) and decide its data source (static build-time config vs. an on-chain attestation). Gated on A1
(where the Evaluator surface lives).

### C2. No slashing / incident history — `OPEN`
**Persona:** Evaluator ("what happens if a validator misbehaves — slashing, downtime?"); Holder wants
incident awareness.
**Collision:** The console shows only **current** jail reports (console §8.6) and single-snapshot chain
state; the client ledger is epoch-level, not an incident log.
**Action:** Decide the source and retention for historical slashing/incidents — indexer, an extension
to the epoch ledger, or deep-links to the Provenance explorer — and where it surfaces.

### C3. Participant count / maturity indicators unavailable — `DECIDE`
**Persona:** Evaluator ("how large/mature is the system — TVL, age, participant count?").
**Collision:** Holder/participant count is not a contract query; it needs indexing the console does not
have. TVV, validator counts, and epoch index are available; system age is derivable from the first
ledgered epoch only.
**Action:** Decide whether to show participant count (requires indexer) or substitute the available
maturity signals (TVV, epoch count/age, validator count) and set the Evaluator's expectation
accordingly.

---

## P2/P3 — Alerts, history, notifications

### D1. Configurable alerts / incident feed — required by Holder + Admin, deferred by the console — `DECIDE`
**Persona:** Position Holder ("configurable alerts: rate movement, DEX depeg, incident"); Administrator
("incident/alert feed with drill-down and severity").
**Collision:** The console has computed **banners** (halted/paused/jail/stale, console §8.0) but no
incident feed and no configurable/push alerts; notifications are deferred (console §17.3) and a static
SPA cannot push.
**Action:** Decide the alert channel (in-session only, browser notifications, webhook/indexer) and
whether any alerting ships in v1; align the Holder/Admin persona expectations with the answer. Note the
DEX-depeg alert also depends on A3.

### D2. Exportable per-user transaction history — required by the Holder, no console surface — `DECIDE`
**Persona:** Position Holder ("full transaction history for records/taxes — exportable").
**Collision:** The console is program-state-focused; the epoch ledger is program-level, not per-address.
Per-user history needs chain tx-history queries or an indexer.
**Action:** Decide whether v1 offers exportable per-address history and its data source (LCD tx search
vs. indexer vs. explorer deep-link). Depends partly on A2 (whether the console is where holders
transact at all).

---

## P3 — Consistency & messaging (align documents; low design risk)

### E1. Unbonding-window messaging mismatch — `ALIGN`
Personas describe native redemption as "**several weeks**" unbonding (personas §2, §5, §6); both specs
guarantee a **~60-day worst-case** window with expedite-usually-sooner (root §8; console §8.4).
**Action:** Standardize exit-time language across all three docs — the guaranteed *ceiling* vs. the
*typical* expedited experience — so the Evaluator and Holder see one honest number.

### E2. Auth commitment mismatch — `ALIGN`
Personas mandate **WalletConnect v2 across all roles** (personas §2); the console leaves the wallet set
an open `[DECIDE]` (console §14.1), recommending one extension wallet + devnet key mode, WalletConnect
"in scope?" unresolved.
**Action:** Confirm the wallet/auth commitment and reconcile console §14.1 with the persona parameter
(or amend the persona if WalletConnect is not the v1 path).

### E3. Economic-vocabulary ratification — `ALIGN`
Personas' shared principle 4 mandates one vocabulary (APR vs. APY, underlying vs. LST, exchange rate
vs. market price). The specs standardize on **APR** and **NAV**; personas mix **APR/APY** and
**"exchange rate / accrual."**
**Action:** Ratify one user-facing glossary shared by the personas doc and both specs — in particular
whether **APY** is ever shown and whether depositors see "**NAV**" or "**exchange rate**."

### E4. Stepwise-NAV honesty in the Evaluator/Holder framing — `SPEC`
Personas describe accrual as the LST↔underlying rate rising "monotonically"; the design accrues NAV in
**monthly steps** (root §5; console §8.1 step-line chart, deliberately non-interpolated).
**Action:** Fold the stepwise-accrual nuance into any Evaluator/Holder explainer (A1) so the education
surface matches the honest step form the charts already use; note the Base/Ethereum pre-/post-epoch
arbitrage seam (root §17.1) where relevant.

### E5. Validator-fee base definition mismatch — `ALIGN`
Personas define the fee as a pro-rata share of the **commission** a validator earns on program stake
(100 commission → 10 fee, personas §2). Root §10.1 defines it as a configured **%** of the **rewards**
the program's delegations earn, validator-funded. Same magnitude (~10%), different base.
**Action:** Reconcile the canonical fee definition and use it identically in the personas doc, root
§10.1, and the console Validator Desk copy (console §8.5).

### F1. Role additivity / personal-position composition — `DECIDE`
Personas §4: roles are additive (a Position Holder may also be a Validator/Admin), so the view model
should **compose**. The console's roles are hierarchical write-surface supersets, but the *personal
position* view (a Position Holder concern) is not composed onto the operator/admin surfaces.
**Action:** Confirm the console composes a personal-position panel for **any** connected address
regardless of operator/admin role, so a validator-who-also-holds isn't forced to choose a single view.

---

## Suggested working order

1. **A2** (in-console writes) — unblocks A1, D1, D2.
2. **A3** (DEX price source) and **A4** (admin analytics source) — both test the no-backend boundary.
3. **B1 → B2 → B3** (actor model, then validator governance, then keeper framing).
4. **A1 + C1/C2/C3** (Evaluator surface and its trust content) once A2/A3 are settled.
5. **D1/D2** (alerts, history) — scoped by the A-series outcomes.
6. **E1–E5, F1** — documentation alignment, cheap once the model decisions above are made.
