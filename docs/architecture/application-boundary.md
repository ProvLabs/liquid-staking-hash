# nvHASH Application Boundary: Console vs. App — Division of Responsibility

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/nvHASH-application-boundary.md`. Paths updated for this repository's layout.

**Version:** 1.0 (2026-07-10)
**Owner:** Ira
**Companion to:** `../specs/dashboard-personas.md` (the five personas) and
`../specs/console-spec.md` (the console's build spec). Where a persona is named, it is defined there.

**Purpose.** The nvHASH program is delivered through **two applications**, not one. This document is the
authoritative statement of which capability lives where, why the line falls where it does, how the two
surfaces relate for trust, and which questions are still open. It exists because a single application
was being asked to hold two incompatible architectures at once — a zero-trust chain-truth verifier and
a stateful consumer product — and every unresolved scope tension traced back to that conflict. Splitting
along the architecture seam resolves it; this doc pins the seam.

---

## 1. The two applications

**A. The Console — chain-truth verification tool.** A static single-page app with **no backend**: the
chain is its only database, one configured node its only peer. It reads and *proves* on-chain state and
exposes the full contract execute surface behind on-chain guards. Its job is verification and direct
protocol operation, identical across devnet, testnet, and mainnet. It is specified in
`../specs/console-spec.md` and already partially built (`apps/console/`, code migration pending). Its design values — "never lie about
state," freshness contracts, guard preflight, invariant/identity pills, "mirror, not measurement"
captions — are exactly the values a verifier needs, and are load-bearing, not decorative.

**B. The App — full-featured program application.** A stateful application built on top of the vault
that **holds its own state** (indexer/backend), integrates off-chain and cross-chain data, and delivers
a consumer-grade experience: education, guided transactions, secondary-market context, durable history,
analytics, and notifications. It does not exist yet; it needs its own spec. This document seeds that
spec by fixing its boundary with the Console.

---

## 2. The boundary rule (single deciding principle)

> **A capability belongs to the Console if and only if it can be proven from chain state alone (one
> node, no stored state) and its purpose is verification or direct protocol operation. Everything that
> requires off-chain state, cross-chain or durable historical data, education, or a consumer-grade
> transacting experience belongs to the App.**

Two corollaries make the rule decidable in edge cases:

- **Provability test.** If answering "is this number true?" requires trusting anything other than the
  chain and the code that reads it, the capability is not the Console's.
- **Purpose test.** If the capability's reason for existing is to *persuade, retain, notify, or
  aggregate* rather than to *verify or operate*, it is the App's — even when the underlying datum is
  on-chain.

---

## 3. Division of responsibility

| Capability | Owner | Why |
|---|---|---|
| Contract query surface (config, epoch status, validators, jail reports, snapshot, APR), raw payloads | **Console** | Pure chain read; verification purpose. |
| Invariant & identity checks (receipt invariant, epoch identity, reserve math) | **Console** | Derivable from chain; the cheapest continuous audit. |
| Guard preflight + full contract execute surface (cranks, operator, admin) | **Console** | Chain-native state changes; verification and direct operation. |
| Deployed-build verification (code hash / version) and config-vs-intent check | **Console** | A chain fact; answers "is the audited build live?" |
| Multi-environment operation (devnet/testnet/mainnet), devnet direct-key drills | **Console** | Identical verification across instances is the Console's reason to exist. |
| Read freshness / node-liveness signal | **Console** | A stalled node must be visible where truth is claimed. |
| Plain-language education / mechanism explainer | **App** | Not chain state; acquisition purpose. |
| Guided create / redeem / unbond (consumer flow) | **App** | Consumer UX. (Console still exposes raw execute for engineers.) |
| DEX market price vs. redemption value; secondary-market liquidity | **App** | Off-chain / cross-chain data; not provable from one node. |
| Personal position, accrued gains, tax/transaction history & export | **App** | Needs durable, indexed off-chain history. |
| Configurable alerts / notifications (halt, jail, arrears, matured redemption) | **App** | Needs a backend and push infrastructure. |
| Cohort / business analytics (retention, conversion, churn, complaints) | **App** | Off-chain, longitudinal, aggregated. |
| Audit links / security marketing | **App** | Not chain state; persuasion purpose. |
| Durable epoch trend history | **Split** | Console keeps a best-effort per-browser ledger for verification; the App owns canonical indexed history. |
| Headline metrics (NAV, APR, TVV) | **Both — Console canonical** | Chain-truth in the Console; the App displays and must reconcile (see §5). |
| Multisig (`x/group`) governance | **Split** | Signing is chain-native (either surface); rich proposal/tally/analytics workflow → App; raw message compose + execute + verify → Console. |
| Validator economics & eligibility | **Split — Console canonical** | Chain facts (uptime, arrears, priority, headroom) are the Console's; the App may re-present them with consumer UX. |

---

## 4. Persona → surface mapping

| Persona | Primary surface | Also uses | Notes |
|---|---|---|---|
| **Protocol Engineer** (Theo) | Console | App (rare) | The Console's reason to exist; verification and operation across all environments. |
| **Keeper** (technical operator) | Console | — | Cranks, guard state, jail watch. |
| **Validator operator** | Console (chain ops) | App (economics UX) | Enrollment, fees, eligibility are chain ops in the Console; a friendlier economics view may live in the App. |
| **Administrator** | Console (governance execute + verify) | App (cohort analytics) | The persona genuinely splits: signing/verification is Console; business analytics is App. |
| **Position Holder** | App | Console (verification tail) | Consumer management in the App; the technically-inclined holder can verify any number in the Console. |
| **Evaluator** | App | Console (technical due diligence) | The Evaluator splits: plain-language trust in the App; the sophisticated evaluator verifies at chain level in the Console. |

The recurring pattern: **every persona with a technical tail can drop from the App into the Console to
verify.** That is the intended relationship, not an accident of overlap.

---

## 5. Trust & reconciliation model

The split only works if the two surfaces cannot disagree about truth without a resolution rule.

1. **The Console is canonical.** For any material number (NAV, APR, redemption status, validator state,
   governance tally), on-chain state as shown by the Console is the source of truth.
2. **The App reconciles to chain; it never becomes an authority.** The App may show derived or indexed
   values for speed and richness, but it must be able to tie every material number back to chain, must
   label its own data freshness, and on conflict must defer to chain.
3. **The App links out to the Console to prove.** Material numbers in the App carry a "verify on chain"
   affordance that deep-links into the Console at the corresponding view and environment. This turns the
   relationship into a trust architecture: **the App is the product, the Console is the proof.**
4. **Transient divergence is expected and bounded.** Indexer lag may make the App briefly trail the
   chain; that is acceptable if labeled. The App must never present a number it cannot ultimately
   reconcile to chain, and must never present a chain-contradicting number as current.
5. **Neither surface moves the trust boundary.** The chain remains the enforcement boundary (Console
   spec §12); the Console is its faithful mirror; the App is an experience layered above it.

---

## 6. Architecture implications

- **Console (unchanged from `../specs/console-spec.md` §3, §12):** static SPA, no backend, single
  configured node, strict CSP (`connect-src` = the node only), self-contained assets, devnet direct-key
  mode compile-excluded from production. Nothing here changes; the split *affirms* this posture instead
  of straining it.
- **App (new, to be specified):** its own backend/indexer, off-chain and cross-chain data feeds
  (notably DEX pricing), session/auth, notification infrastructure, and durable per-user history. Its
  trust model must be written explicitly and must encode §5 (canonical deference to chain, "verify on
  chain" deep-links, freshness labeling).
- **Shared where sensible:** the App should inherit the Console's validated dataviz method and design
  tokens for family coherence, while being free to adopt a calmer consumer register. Shared packaging of
  tokens/components is an open item (§7).

---

## 7. Open items / decisions

1. **App name and scope baseline.** Stand up a dedicated App spec; name the product.
2. **Governance (`x/group`) home.** Decide whether the primary signing/voting UX lives in the App
   (richer workflow) or the Console (chain-native compose+execute), given §3's split.
3. **Deep-link contract App → Console.** URL scheme, view addressing, and explicit environment pinning
   so a "verify on chain" link can never land on the wrong network.
4. **Shared design system packaging.** Whether Console and App share a token/component library or the
   App re-implements against the same method.
5. **App read path.** Whether the App reads chain exclusively through its indexer, or also talks to a
   node directly for the canonical checks it surfaces.
6. **App auth model.** The Console has none beyond wallet connect; the App likely needs sessions — scope
   this without importing custody or KYC the program has explicitly declined (personas §2).
7. **Console re-baseline.** Fold the Protocol Engineer in as the Console's stated primary persona and
   reclassify its "depositor" surface as *technical read-only* (a follow-on edit to
   `../specs/console-spec.md`).

---

## 8. References

- Personas: `./../specs/dashboard-personas.md` (§9 Protocol Engineer; §4 access model; §10 matrix).
- Console build spec: `./../specs/console-spec.md` (§3 confirmed decisions, §12 trust model).
- Governing contract spec: `./../specs/liquid-staking-spec.md`.
- As-built interface: `contracts/src/msg.rs`, `contracts/src/state.rs`; existing console implementation: `apps/console/` (code migration pending).

---

*v1.0, 2026-07-10. Establishes the two-application split (chain-truth Console vs. stateful App), the
boundary rule, the division of responsibility, the persona-to-surface map, and the trust-reconciliation
model. Downstream: an App spec and a Console re-baseline (§7).*
