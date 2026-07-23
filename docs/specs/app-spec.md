# nvHASH Program App: Full-Featured Application Technical Specification

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/nvHASH-app-spec.md`. Paths updated for this repository's layout.
>
> **Revision 2026-07-13 (security alignment):** email collection/delivery and third-party product analytics (Mixpanel) removed to conform to the repository security policy (`SECURITY.md`): no off-chain identity linked to wallet addresses, no third-party analytics that can deanonymize wallets. Notifications are in-app + optional Web Push; funnel/cohort analytics are first-party and aggregate-only. Decisions 5 and 14 (§3), §6, §7, §8.2, §8.8, §9.1, §10.4, §12.3, and §14.7/§14.10 updated accordingly.

> **Revision 2026-07-13 (certification):** **Certified for implementation** (Ira, 2026-07-13), granted on migration into `liquid-staking-hash` with review against `SECURITY.md` and the repository's PR process. The §14 open items are no longer a certification gate: each unresolved item is a **build-gating dependency of the specific PR that consumes it**, per the implementation plan (`../plans/2026-07-13-app-implementation-plan.md` §5) — a PR listed as consuming a `[DECIDE]`/`[VERIFY]` item must not land before that item is resolved and recorded here.

> **Revision 2026-07-14 (component architecture, ADR-001):** §6 and §9.4 amended per [ADR-001](../architecture/2026-07-14-adr-001-app-component-architecture.md) (implementation plan PR 0.1): the App is one logical unit built as three components — `services/indexer`, `services/api`, `apps/web` — replacing the single-deployable `nuva-app` shape. One PostgreSQL database, two role-owned schemas (`indexed`/`app`); address-scoped API reads authorized in-process via scoped service assertions; the notifier is an `apps/web` worker; design-system packaging (§14.8) resolved as web-local tokens validated by the shared method. §9.1 annotated with schema ownership (incident acknowledgment split into an `app`-schema `incident_acks` table).

> **Revision 2026-07-14 (wallet vendor set, §14.1):** resolved (Ira, 2026-07-14): v1 certifies **Figure Wallet** — mobile pairing over WalletConnect v2 plus the Figure browser extension on desktop. Keplr/Leap are fast-follow behind the §14.1 certification checklist, which is the gating test run against Figure in the wallet/session PR (implementation plan PR 5.1). Console §14.1 is resolved in the same change (Figure extension + devnet key mode for engineering) so the program certifies one wallet story. Decision 5 (§3), §10.1, and §14.1 updated.
>
> **Amendment 2026-07-14 (second v1 vendor, §14.1):** **Arculus** added as a second v1-certified vendor (Ira, 2026-07-14) as a **standards-conformance guard**: the WalletConnect v2 layer must pass the §14.1 checklist against two independent vendors, so it cannot silently depend on non-standard Figure behavior that would block wider WC v2 wallet support. Arculus is App-surface only (WC v2 mobile; no browser extension) — the console v1 set is unchanged. Decision 5 (§3), §10.1, and §14.1 updated.

**Version:** 1.0-RC1 (2026-07-10). **Certified for implementation 2026-07-13** (see certification revision note).
**Owner:** Ira
**Companion to:** `liquid-staking-spec.md` (v1.0, baselined 2026-07-09), the governing contract spec — section references of the form "contract §N" point there; `dashboard-personas.md` (the five personas); `../architecture/application-boundary.md` (the Console-vs-App split this spec implements — "boundary §N"); and `console-spec.md` (v2.0-RC1, the chain-truth verification counterpart — "console §N").

**Status:** Certified for implementation (2026-07-13 revision note above). This is the App seeded by boundary §7.1: the stateful, consumer-grade surface of the nvHASH program. The architecture follows the engineering team's established reference application (`Labs/nuva-app`) — React Router 7 SSR, PostgreSQL/Prisma with the three-layer route/service/model rule, Tailwind 4 + shadcn/Radix, and an in-house chain indexer — rather than introducing new stack dependencies. Unresolved **§14** items block the PRs that consume them (implementation plan §5), not the spec as a whole.

**How to read this:** §1 is the summary. §5 is the data the App consumes (chain, indexer, off-chain feeds); §8 (pages), §9 (backend & indexer), and §10 (transaction flows) are the build-defining sections. §11 is the design language (inherits the NUVA family register the console deliberately gave up). §12 encodes the boundary doc's trust-reconciliation model — it is normative, not advisory. **§14 is the open-items list**: `[DECIDE]` = a decision to make, `[VERIFY]` = a fact to confirm against the deployed chain, bridge, or vendors.

**Where review attention is most valuable:** (1) the indexer design and its reconciliation-to-chain contract (§9 — the App holds state, so honest freshness labeling and canonical deference are what keep the two-surface trust model sound); (2) the redemption flow's "guaranteed vs typical" framing (§8.4, §10.4 — the single most consequential piece of consumer communication in the program); and (3) the governance workflow split with the console (§8.7, §14.6).

---

## 1. Purpose & Approach

This document specifies the web application for **nvHASH** (formally "Liquid Staking HASH Vault", §14.14): the full-featured front end for the liquid staking program on Provenance Blockchain. Where the Console proves chain state to engineers, the App **explains, transacts, remembers, and notifies** for everyone else. It is the program's front door: the place an Evaluator learns what nvHASH is, a Position Holder deposits, monitors, and redeems, a Validator reads the economics of participating, and an Administrator watches whether the program's cohorts are healthy.

The App serves the **four primary (non-Protocol-Engineer) personas** (personas §5–§8): **Evaluator, Position Holder, Validator, Administrator**. Per the boundary rule (boundary §2), everything here either requires off-chain state (durable history, cross-chain pricing, notifications, analytics), or exists to educate and guide rather than to verify. Chain-truth verification remains the Console's job; the App links into it rather than duplicating it.

The App has **four objectives**:

1. **Convert understanding into trust** — plain-language education, security posture, historical performance, and honest exit-path framing for the Evaluator (closes register item A1).
2. **Guided transactions** — consumer-grade deposit (`SwapIn`), redemption (`SwapOut`), and exit-path comparison, with the user's own wallet signing every transaction (closes A2).
3. **Durable personal and program history** — indexed positions, accrued gains, effective yield, exportable transaction history, canonical epoch trends, and DEX market context (closes A3, C2, C3, D2).
4. **Awareness** — configurable alerts and an incident feed for holders and admins, plus the cohort-satisfaction analytics the no-backend console cannot produce (closes A4, D1).

**At a glance:**

- **Stateful application with its own backend and indexer.** React Router 7 (framework mode, SSR) serving both the UI and a versioned JSON API; PostgreSQL via Prisma; a chain indexer that turns Provenance events into durable history. This is the same architecture, layering discipline, and dependency set as the team's `nuva-app` reference (§3, §6).
- **The chain stays canonical.** Every material number the App shows is either read live from the node or reconciled to it, labeled with its freshness, and accompanied by a "Verify on chain" deep-link into the Console (§12). **The App is the product; the Console is the proof** (boundary §5).
- **Wallet-signed, never custodial.** All fund-moving actions are built in the browser, previewed decoded, and signed by the user's wallet over WalletConnect v2 (personas §2). The backend holds no keys and can move no funds (§10, §12).
- **Consumer register, same chart honesty.** The App wears the NUVA family design language (§11) — the brand accent, display typeface, and calm surfaces the console explicitly removed — but its charts obey the identical dataviz method and honesty rules (step-after NAV, no interpolation of stepwise values, minimum-window APR rule).

**The one rule that shapes the whole design: the App must never become an authority about chain state.** It may be faster, richer, and longer-remembering than the chain node, but on any conflict it defers, labels, and links to proof. A consumer product that quietly contradicts the chain would poison both surfaces (boundary §5); this spec treats reconciliation and freshness as load-bearing features, not plumbing.

Delivery path: *spec → backend/indexer against devnet → read-only pages → transacting flows on testnet → notification + analytics → mainnet* (§15).

---

## 2. Glossary

Economic vocabulary is shared with the console (console §2) and the contract spec; terms below are App-specific or repeated because pages depend on them. This shared table is the E3 (vocabulary ratification) deliverable: all three documents use these words identically.

| Term | Meaning |
|------|---------|
| **App** | The web application this document specifies. |
| **Console** | The chain-truth verification tool (`console-spec.md`); the target of every "Verify on chain" link. |
| **Contract** | The nvHASH staking CosmWasm contract (the vault's asset manager), contract §11. |
| **Vault** | The `ProvLabs/vault` module instance holding user funds; the App's `SwapIn`/`SwapOut` counterparty. |
| **Indexer** | The App's background ingestion workers that read chain blocks/tx events into PostgreSQL (§9.2). |
| **Freshness label** | The indexed-height/timestamp annotation every indexer-derived figure carries (§12). |
| **Verify link** | The per-figure deep-link into the Console at the corresponding view and environment (§12.2). |
| **NAV / exchange rate** | `Net TVV / total_shares` — HASH per nvHASH. Rises **stepwise at each monthly epoch** (contract §5); never interpolated in any App display. |
| **Market price** | What nvHASH trades for on a secondary venue (the Base/Ethereum Uniswap pool, contract §11.5) — may sit at a premium or discount to NAV. |
| **Premium / discount** | `(market price − NAV) / NAV`, the spread the exit-path comparison surfaces. |
| **Guaranteed window** | The `withdrawal_delay_seconds` redemption ceiling (~60 days, contract §8). The only promised number. |
| **Typical time-to-payout** | The indexed historical distribution of actual expedite times (§9.5) — displayed *beside*, never *instead of*, the guaranteed window. |
| **Effective yield** | A specific holder's realized accrual on their own position (§9.5), as distinct from the program's advertised APR. |
| **Gross / net APR** | The program-level rates from the contract's `Apr {}` (contract §9.10): gross = rewards + commission + TIP annualized; net = gross minus AUM-fee estimate and write-downs. |
| **Cohort analytics** | The admin-facing adoption/retention/churn/upkeep-timeliness metrics (§8.8), computed from indexed history and product analytics. |
| **bps / nhash / nvhash scales** | Identical to console §2: rates cross the wire in bps; 1 HASH = 1e9 nhash; 1 nvHASH = 1e15 base shares (= 1 HASH at neutral NAV). |

---

## 3. Confirmed Design Decisions

The following are settled, subject only to the §14 open items:

1. **Stack = the `nuva-app` reference architecture.** React Router 7 (framework mode, SSR, `remix-flat-routes` file routing), TypeScript strict, Vite. UI: Tailwind CSS 4 (`@tailwindcss/vite`), shadcn/ui on Radix primitives, `lucide-react` icons, `cn()` (clsx + tailwind-merge), `class-variance-authority`. Forms: `react-hook-form` + `zod`. Tables: `@tanstack/react-table`. Charts: **Recharts**. Toasts: `sonner`. Dates: `date-fns`. Matching: `ts-pattern`. No new framework, CSS system, or chart library is introduced.
2. **Backend = the same process, three layers.** Routes (loaders/actions + `api+/v1+` JSON routes) → services (`app/lib/services/*.server.ts`, business logic, logging) → models (`app/lib/models/*.server.ts`, the only Prisma import). Routes never touch the database; models hold no business logic (nuva `ARCHITECTURE.md` is normative here).
3. **PostgreSQL + Prisma, multi-file schema.** One model per `prisma/*.prisma` file; migrations via `prisma migrate`. Indexer cursors persist in an `indexer_checkpoints` table (the nuva precedent).
4. **The App both indexes and reads live.** Historical/aggregate data comes from the indexer; the canonical live numbers (NAV, TVV, vault paused state, pending swap-out queue, guard-relevant state) are read server-side from the configured LCD on request (short-TTL cached) so the App can label and reconcile rather than trail (resolves boundary §7.5: **both**).
5. **Wallet auth = WalletConnect v2, session by signature, no KYC.** Connecting a wallet is anonymous; a server session is established by signing a nonce (address-scoped, no account creation step). **No off-chain identity is collected — no email, no account creation, no KYC, no allowlist** (personas §2; `SECURITY.md` data minimization; resolves boundary §7.6). Notifications are in-app plus optional Web Push (§10.4). Wallet vendor set: **Figure Wallet + Arculus in v1** (decided §14.1; dual-vendor certification guards WC v2 standards conformance; Keplr/Leap fast-follow behind the §14.1 certification checklist).
6. **All fund-moving transactions are user-signed in the browser.** The backend never holds keys, never signs, and exposes no endpoint that could move funds. Server writes are limited to the App's own state (sessions, alert rules, notification log, analytics).
7. **The trust-reconciliation model of boundary §5 is implemented as stated:** chain canonical, freshness labels on indexed data, per-figure verify links into the Console, bounded and labeled divergence, automatic alarm on reconciliation failure (§12).
8. **Amount discipline is identical to the console.** `Uint128` decimal strings parse to `BigInt` in TypeScript; Postgres stores base-unit amounts as `NUMERIC(39,0)` via Prisma `Decimal`; display conversion (nhash → HASH, bps → %) happens at render only. No floating-point on amounts anywhere, including the indexer.
9. **Chart honesty rules carry over verbatim** from the shared dataviz method (console §11.6 is the sibling instance): NAV renders **step-after** (stepwise accrual is a fact, interpolation is a lie); APR windows under one day render "n/a" rather than absurd annualizations; diverging palettes only for genuinely signed measures; every chart offers a table view. Recharts is configured to these rules; the rules, not the library defaults, are normative.
10. **The App carries the NUVA family brand** (§11): the design tokens, type stack (Funnel Sans / Space Grotesk display / Geist Mono), and accent treatment from `nuva-app`'s design system, adapted to this program. The console stays austere; the App is the branded surface (boundary §6; resolves §7.4 as "shared method, App re-implements tokens in the nuva idiom" — §14.8 resolved: tokens are web-local per ADR-001 Decision 4, the accent/status brand pass landed in PR 1.4).
11. **i18n from day one, English-only at launch.** The nuva route-based localization pattern (`$lang+` segments, translation namespaces, no hardcoded UI strings) is adopted wholesale so later locales are additive; the launch locale set is `en` only (§14.9 decided; future locales TBD, not in v1). Admin-gated routes are English-only (nuva convention).
12. **Theme: Auto/Light/Dark three-way** via `next-themes`, dark default (the NUVA family register); both palettes are validated token sets per the dataviz method, not inversions.
13. **Environments mirror the program's:** devnet / testnet / mainnet deployments, each pinned to one chain, one contract, one console origin. No in-app network switcher; the environment badge is prominent on non-mainnet (§7).
14. **Product analytics = first-party, aggregate-only.** The nuva Mixpanel precedent does **not** carry over: `SECURITY.md` prohibits third-party analytics that can deanonymize wallets. Funnel/cohort measurement (§8.8) is computed server-side as aggregate counters (page-class visits, funnel-stage tallies) never keyed by wallet address, session, or device; no third-party analytics script ships. Event taxonomy is `[DECIDE §14.10]`.
15. **Deployment:** Docker image, ArgoCD, the team's standard pipeline (nuva precedent). Playwright e2e + Vitest unit tests gate CI; MSW mock fixtures make every page buildable offline.

---

## 4. Actors & Roles

> **Personas ground this section.** The App is the primary surface for the **Evaluator** and **Position
> Holder**, the consumer-economics surface for the **Validator**, and the analytics + governance-workflow
> surface for the **Administrator** (boundary §4). The **Protocol Engineer** uses the App rarely and by
> choice; nothing here is designed for him — his surface is the Console.

- **Evaluator ("Casey") — anonymous visitor.** No wallet, no session. Sees the full public surface: education, performance history, security posture, exit explainer, market context. Their only CTA is "Connect wallet to stake." Success is comprehension and conversion (personas §5).
- **Position Holder ("Priya") — connected wallet.** The core transacting user: deposits, monitors her position and effective yield, compares exit paths, redeems, exports history, configures alerts. Roles are additive (register F1): if her address also operates a validator or sits on the admin policy, those surfaces compose onto her session rather than replacing it.
- **Validator operator ("Owen/Pat") — connected wallet matching a `ValidatorStatus.operator`.** Reads his program economics (delegation, earnings, fees owed, standing, eligibility headroom, peer rank) in consumer form, and participates in governance votes where granted (register B2). **Chain-ops writes (enroll, unregister, pay commission/TIP, purge) are first-class App transaction flows** (§14.6 decided; the Console keeps them as an engineering surface, no longer the required path); every obligation shown in the App is actionable in place.
- **Administrator ("Grace") — connected wallet that is a member of the `x/group` admin policy.** Uses the governance center (proposals, tallies, votes, execution) and the cohort-analytics dashboard. Privileged *program* actions (config, halt, pause) are originated in the App's governance center as template-scoped proposals, with vote and execute there too (§8.7, §14.6 decided); the Console retains them as an engineering surface, no longer the required path.
- **The backend itself** is an actor with read-only chain access and no signing capability — worth stating because it is the one new trust surface the two-application split introduces (§12).

| Role | Detected by | App write surface |
|------|-------------|-------------------|
| Anonymous | no session | none (public reads) |
| Holder | wallet session | `SwapIn` / `SwapOut` (self-signed), alert rules, push opt-in, history export |
| Operator | session address = a `ValidatorStatus.operator` | holder surface + governance vote signing (if a group member) |
| Admin | session address ∈ admin `x/group` policy members (live chain read) | operator surface + proposal create/vote/execute signing + analytics access |

Role detection is an on-chain fact re-checked server-side per session refresh — the App stores no role list (same principle as console §3.4). Group membership comes from the whitelisted `x/group` queries (contract §12.1).

---

## 5. Key Dependencies: Chain, Contract, and Off-Chain Feeds

The App consumes four data planes. The first two are shared with the console; the last two are App-only and are why the App exists as a separate architecture.

### 5.1 Live chain reads (canonical plane)

Identical query surface to console §5.1–§5.2, executed **server-side** by a typed LCD client (the `nuva-app` `vault-client.ts` pattern: plain REST fetch, proto-shaped TypeScript types, no client-side chain access needed for reads):

| Data | Source | App use |
|------|--------|---------|
| `Config {}`, `EpochStatus {}`, `Validators {}`, `JailReports {}`, `EpochSnapshot {}`, `Apr {}` | contract smart queries | headline metrics, validator surfaces, incident detection, guard context for flows |
| Vault account, NAV inputs (`total_vault_value`, `total_shares`), paused state, `withdrawal_delay_seconds`, principal balances | `GET /vault/v1/vaults/{addr}` (route verified on devnet, console §14.2) | NAV, deposit/redeem previews, paused banners |
| Pending swap-out queue (paginated) + per-request estimates | vault queries | the user's redemption tracker, queue position, funded state |
| Delegations, unbonding, validator monikers/status | `cosmos.staking.v1beta1` | deployment split, validator pages |
| `x/group` group/policy/proposal/vote/tally queries | `cosmos.group.v1` | governance center (§8.7) |
| Latest block height/time | LCD node info | freshness labels, indexer lag measurement |

These live reads are short-TTL cached in-process (per query, seconds not minutes) and are the **canonical plane**: pages that show a material number prefer the live value and fall back to the indexed value *with a stale label* when the node is unreachable — never silently (§12).

### 5.2 Indexed history (durable plane)

The chain retains only the most recent `EpochSnapshot` (contract §9.10) and no per-user history at all. The indexer (§9.2) ingests, per environment:

- **Epoch history:** every `RunEpoch` transaction's snapshot/APR events → the canonical `epoch_snapshots` table. This is the durable ledger the boundary doc assigns to the App (boundary §3 "durable epoch trend history"), superseding the console's best-effort per-browser ledger for anything longitudinal.
- **User flows:** vault `SwapIn`/`SwapOut` events, share-denom bank transfers, redemption enqueue/expedite/payout/refund events → `transactions` and `redemption_requests`.
- **Validator lifecycle:** enrollment/unregistration, per-epoch eligibility, uptime, TIP, commission accrual/payment, jail reports and purges → `validator_epochs` samples for churn/history.
- **Program state changes:** halt toggles, vault pause/unpause, config updates, write-downs → `incidents` candidates (§9.6).

### 5.3 Cross-chain market data (App-only plane)

- **DEX price & depth:** the nvHASH/(paired asset) Uniswap pool on **Base** (and Ethereum if deployed) read via `viem` against configured RPC endpoints — pool address, fee tier, and pair denomination from the NUVA bridge deployment `[VERIFY §14.3]`. Sampled on a short cadence into `market_samples`; the App derives spot price, premium/discount to NAV, and depth-at-slippage bands. This is exactly the data the Provenance-only console structurally cannot have (register A3).
- **Bridge state (post-launch "coming soon" shell in v1, §14.4 decided):** the local vs remote share split (via the vault's bridge accounting) and destination-chain supply (via `viem`) have no data until nvHASH is bridged, so the Market page presents them as a forthcoming surface at launch. Both this market data and the transit UX activate with the NUVA Labs bridge deliverable (contract §11.5).

### 5.4 Static trust content

Audit reports (firm, scope, date, report links, covered commit/code-hash), program documentation, and the mechanism explainer are **build-reviewed content** (MDX/config in the repo, shipped with the App), not database rows — they change by pull request, which is the right auditability for trust claims (register C1). The displayed code-hash claim carries a verify link to the Console's deployed-build check so the "audited build is the live build" assertion is provable, not asserted.

> **Revision 2026-07-22 (PR 4.2):** the content plane exists as a typed
> build-reviewed module (`apps/web/app/content/trust.ts`, `AuditEntry[]`)
> rather than MDX: there is no audit report yet, and MDX tooling would be
> infrastructure for zero documents. The pre-audit posture renders honestly
> (SECURITY.md project status) instead of the section being omitted. MDX
> arrives with the first real report; the typed shape is the contract either
> way.

---

## 6. Architecture Overview

> **Revision 2026-07-14 (ADR-001):** this section originally described the
> `nuva-app` single-deployable shape (SSR app, API routes, and indexer workers
> in one codebase). Per
> [ADR-001](../architecture/2026-07-14-adr-001-app-component-architecture.md)
> the App is **one logical unit built as three components** —
> `services/indexer`, `services/api`, `apps/web` — with ownership enforced by
> database roles, not convention. The three-layer route/service/model
> discipline, amount discipline, freshness labeling, and trust model (§12)
> carry over unchanged **within each component**.

```
                      Browser
   ┌────────────────────────────────────────────────┐
   │  React Router 7 app (SSR-hydrated)             │
   │  public pages · portfolio · flows · governance │
   │        │ loaders/actions        │ sign         │
   └────────┼────────────────────────┼──────────────┘
            │ HTTPS                  ▼
            ▼                ┌────────────────────┐
   ┌─────────────────────┐   │ Wallet             │
   │ apps/web (server)   │   │ (WalletConnect v2) │
   │ SSR · sessions ·    │   └─────────┬──────────┘
   │ app-state routes ·  │             │ broadcast
   │ notifier worker     │             ▼
   │ live LCD reads ─────┼──▶ ┌──────────────────┐
   └──────┬───────┬──────┘    │ Provenance node  │
          │       │           │ (LCD/RPC)        │◀────┐
          │       │           └──────────────────┘     │
          │       │ app schema (app_writer):           │
          │       │ users · sessions · alerts ·        │
          │       │ notifications · push · counters    │ LCD tx-search
          │       ▼                                    │
          │   ┌────────────────────────────┐           │
          │   │ PostgreSQL — one database  │           │
          │   │ two schemas: app · indexed │           │
          │   └───▲───────────────▲────────┘           │
          │       │ SELECT only   │ indexed schema     │
          │       │ (api_reader)  │ (indexer_writer)   │
          ▼       │               │                    │
   ┌──────────────┴──────┐        │                    │
   │ services/api        │   ┌────┴─────────────────┐  │
   │ read-only /api/v1   │   │ services/indexer     │  │
   │ freshness envelope  │   │ workers · reconciler │──┘
   │ scoped assertions   │   │ incident derivation  │
   │ checked in-process  │   └──────────┬───────────┘
   └─────────────────────┘              │ viem (RPC, read-only)
                                        ▼
                                  Base / Ethereum RPC
                                  (Uniswap pool · bridge supply)

   "Verify on chain" deep-links ──▶  nvHASH Console (per env)
```

**Component summary (ownership per ADR-001):**

- **`services/indexer`:** long-running worker loops (separate process/container
  per stream), each with a durable cursor in `indexer_checkpoints`:
  `chain-events` (contract + vault + relevant module events by height),
  `epoch-history` (RunEpoch tx scan + backfill), `validator-sampler` (periodic
  `Validators {}` snapshot), `market-sampler` (DEX pool reads via viem).
  Idempotent upserts keyed by (txhash, event index) so replays are safe. The
  **reconciler** (scheduled comparison of indexed aggregates against live chain
  reads — NAV, total shares, queue length, epoch index) and **incident
  derivation** (§9.6) live here: divergence beyond tolerance raises an
  `incident` and flips affected surfaces to their live-read/stale-label mode
  (§12). Sole writer of the `indexed` schema (role `indexer_writer`). Never
  serves HTTP to users; never holds keys or signs.
- **`services/api`:** the versioned read-only JSON API under `/api/v1` over
  indexed data; every response carries the freshness envelope (§9.4);
  zod-validated query params and rate limiting at every route. Reads `indexed`
  via a SELECT-only role (`api_reader`); runs no migrations, performs no writes
  of any kind, submits no transactions. Address-scoped endpoints require a
  verified-address service assertion checked **in-process** (ADR-001 Decision 2;
  §12.3).
- **`apps/web`:** the SSR UI, the wallet/session layer, and the App's own
  state — sessions, alert rules, notification log, push tokens, aggregate
  counters, incident acknowledgments — in the `app` schema (role `app_writer`,
  no grants on `indexed`). Live LCD reads (the canonical plane, §5.1) happen in
  this server; indexed history is read **only through `services/api`**. The
  **notifier** runs as a separate worker entrypoint in this codebase,
  evaluating alert rules on indexer ticks and delivering in-app + Web Push
  (§10.4); its indexed-fact reads go through the API (public endpoints plus an
  `internal:notifier`-scoped read-only surface — ADR-001 Decision 3).
- **Wallet layer:** WalletConnect v2 session in the browser; message
  construction and decoded preview client-side; the server supplies read-only
  context (estimates, guard state) but never touches the signing path.

Configuration (§7) is provisioned per component; `DATABASE_URL` resolves to the
component's own role credential (`indexer_writer`, `api_reader`, `app_writer`),
and the web tier additionally carries `API_SERVICE_ASSERTION_KEY` (server-only,
never in the client-safe subset).

---

## 7. Application Configuration (concrete values)

Per-environment server config (env vars via the nuva `config.ts` pattern) plus a client-safe subset serialized into the root loader:

| Parameter | Value (mainnet profile) | Notes |
|-----------|------------------------|-------|
| `CHAIN_ID` | `pio-mainnet-1` | Devnet/testnet profiles substitute theirs; rendered in the environment badge. |
| `LCD_URL` | program-operated node | Server-side reads; the browser never needs LCD CORS. |
| `CONTRACT_ADDRESS` / `VAULT_ADDRESS` | deployed addresses | Vault address cross-checked against `Config {}` at boot; mismatch fails startup. |
| `CONSOLE_URL` | the same-environment Console origin | Verify-link base (§12.2). One console per environment; links never cross environments. |
| `CONSOLE_CHAIN_ID` | chain id of the configured console profile | Added 2026-07-15 (PR 1.3): the operator-declared chain id the `CONSOLE_URL` console serves. Must equal `CHAIN_ID` or boot fails — the §12.2 "checked at boot" cross-environment guard needs the console profile's chain id as an explicit config fact (the console is a static app with no endpoint to ask). |
| `API_URL` | the same-environment `services/api` origin | Added 2026-07-21 (PR 4.1): server-only base URL for the web tier's indexed-plane reads (footer freshness, degraded banner; zod-bounded http/https at load). The browser never calls the API directly for chrome state; reads go through the web server's loaders, and the value is classified server-only in the bundle-secret gate. |
| `DATABASE_URL` | PostgreSQL | Indexer + app state. Web tier (PR 5.1): the `app` schema as `app_writer`; optional — absent, sessions are in-memory (dev/mock posture). |
| `BASE_RPC_URL` / `ETH_RPC_URL` | EVM read endpoints | Market + bridge-supply sampling (§5.3). |
| `UNISWAP_POOL_BASE` (…`_ETH`) | pool addresses | `[VERIFY §14.3]` from the NUVA bridge deployment. |
| `WALLETCONNECT_PROJECT_ID` | — | WalletConnect v2 pairing. **Client-safe** (PR 5.1 allowlist amendment): a WC project id is public by design — it rides in every pairing URI. |
| `WEB_PUSH_VAPID_*` | — | Web Push credentials `[DECIDE §14.7]`. |
| denom/share scales | exponent 9 / 15, `HASH`/`nhash`, `nvHASH`/`nvhash` | Identical to console §7. |
| `REDEMPTION_MARGIN_BPS` | `50` | Display mirror of the contract constant (contract §8). |
| `RECONCILE_TOLERANCE` / cadence | tolerance per metric; ~1 min cadence | §12 reconciler thresholds. |
| `APP_ENV` | `development` \| `staging` \| `production` | nuva convention; drives the environment badge. |

> **Revision 2026-07-15 (PR 1.3, `apps/web` scaffold):** the web tier's config
> boundary now exists and is enforced. The scaffold consumes only what it uses
> (`APP_ENV`, `CHAIN_ID`, `LCD_URL`, `CONTRACT_ADDRESS`, `VAULT_ADDRESS`,
> `CONSOLE_URL`, `CONSOLE_CHAIN_ID` — all zod-bounded at load); the remaining
> table rows are documented `.env.example` placeholders consumed by their own
> PRs. Both boot checks are wired and fail startup loudly: console chain-id
> match (`CONSOLE_CHAIN_ID` row above) and the vault-address cross-check
> against `Config {}`. The **client-safe subset** is now a concrete allowlist
> (`appEnv`, `chainId`, `contractAddress`, `vaultAddress`, `consoleUrl` —
> `apps/web/app/config/client.ts`), enforced by a standing bundle-secret CI
> gate (build with sentinels in every server-only var, scan the client bundle)
> plus a unit test on the root-loader projection and an e2e assertion that no
> server-only value reaches the rendered page. Adding a client-visible config
> key amends this section and that allowlist in the same change.

> **Revision 2026-07-23 (PR 5.1, wallet + sessions):** three rows became
> consumed config, all zod-bounded at load: `WALLETCONNECT_PROJECT_ID`
> (**amended into the client-safe allowlist** — public by design, riding in
> every pairing URI; null disables the WC transport while the injected
> extension keeps working), `DATABASE_URL` for the web tier (`app_writer`,
> server-only, optional with an in-memory dev/mock fallback), and
> `API_SERVICE_ASSERTION_KEY` (server-only, ≥ 32 chars, ADR-001 Decision 2
> minting key). **`SESSION_SECRET` is retired without ever being consumed:**
> the session cookie carries an opaque 256-bit random id resolved against a
> server-side row (§12.3), so there is nothing to sign and no key to hold —
> recorded here so the placeholder's disappearance from `.env.example` is a
> decision, not an omission.

### 8.0 Site map & global chrome

```
┌────────────────────────────────────────────────────────────────────┐
│ nvHASH  Learn · Stake · Portfolio · Market · Validators · Governance│  top nav
│                          [env badge] [alerts 🔔] [theme] [wallet]   │
├────────────────────────────────────────────────────────────────────┤
│ ⚠ banner slot: VAULT PAUSED / PROGRAM HALTED / DATA DEGRADED        │  (only when true)
├────────────────────────────────────────────────────────────────────┤
│                            page content                             │
├────────────────────────────────────────────────────────────────────┤
│ footer: chain id · indexed to block N (Ns ago) · docs · console ↗   │
└────────────────────────────────────────────────────────────────────┘
```

- **Public-first.** Learn, Market, Validators, and the program-history views render fully with no wallet — the Evaluator's entire journey is anonymous. Portfolio and Governance prompt connection with an explanation, never a blank.
- **Banner slot** mirrors the program's true states, computed from live reads: vault paused (with reason and the plain-language consequence "deposits, redemption payouts, and new redemption requests are on hold"), contract halted, and **data degraded** (indexer lagging or reconciler alarm — the App's own honesty banner, §12).
- **Alerts bell** shows unread notifications for the connected address; anonymous users see the alerting feature advertised, not the bell.
- **Environment badge** is quiet on mainnet, loud (warning-tinted, labeled) on testnet/devnet.
- **Footer freshness line** is global: the indexed head vs chain head, always visible — the consumer-calm analogue of the console's freshness footer.
- Routes live under `$lang+` per the nuva i18n pattern; paths below omit the locale segment.

> **Revision 2026-07-21 (PR 4.1, global chrome):** the chrome above is
> implemented in `apps/web` (`app/chrome/chrome.server.ts` assembles the
> banner/freshness state in the root loader; components under
> `app/components/chrome/`). Deliberate deltas from the diagram, both recorded
> follow-ons rather than dead affordances: the footer **docs** link is omitted
> until a docs URL exists (no speculative config key), and the **wallet**
> header slot waits for M5. The alerts bell ships as the anonymous advert
> affordance only (M6 replaces it). Banner honesty is gated by
> `test/chrome-state.test.ts`: paused/halted render only from successful live
> reads (halted outranks paused), "data degraded" comes from the status
> endpoint's height lag or an open `reconciler_divergence`/`indexer_lag`
> incident, and a failed live read shows "program status unavailable" in the
> footer with NO banner, never an implied all-clear. Nav targets that have no
> real page yet (Stake, Portfolio, Market, Validators, Governance) are honest
> scaffold stubs so the nav never 404s; all are in the axe scan.

### 8.1 Learn (route `/`, the Evaluator's home)

The comprehension → due-diligence funnel (personas §5), and the program's public face. Progressive disclosure: each section answers one Evaluator question and expands into verifiable detail.

1. **Hero + mechanism explainer.** Plain-language "what this is": *deposit HASH → pooled and staked across reliable validators → rewards, validator commission, and tips flow back into the pool → your nvHASH is redeemable for more HASH over time*. An animated (reduced-motion-safe) flow diagram of exactly that pipeline. **Stepwise honesty is built into the first explanation** (register E4): "value lands in monthly steps when the epoch settles — between epochs your redemption value is flat, and that is normal," with the step chart right there.
2. **Live proof strip.** Current NAV, net APR (with gross in the caption, window-labeled, minimum-window rule applied), TVL, participant count, program age, eligible-validator count — each with a verify link. The participant count and age come from indexed history (register C3).
3. **Where the yield comes from.** The `Apr {}` decomposition presented for a lay reader: staking rewards + validator-paid commission + tips, minus the AUM fee — with the honest note that validators fund commission/TIP from their own pockets (contract §10.1), which is *why* the vault can out-yield self-staking. A "compare to self-staking" panel makes Dana's actual decision explicit (contract §17.2 R2 in consumer form).
4. **Security & trust posture.** Audit panel (§5.4): firm, scope, date, report links, covered build with its verify link; the multisig governance model in one paragraph; the risk register in plain words (smart-contract risk, validator slashing and how write-downs work, bridge trust boundary for cross-chain holders — contract §12). No marketing adjectives; the console's "numbers carry the enthusiasm" rule holds here too.
5. **Incident & slashing history.** The indexed incident feed (register C2), empty state proudly labeled ("No slash events or program incidents since launch — this list is generated from chain history, not curated").
6. **Exit explainer.** The two paths side by side: instant DEX trade at market price (with live premium/discount) vs native redemption at protocol rate (guaranteed ≤ 60 days, typically faster — the §8.4 framing, previewed here because "can I get out?" is a pre-deposit question).
7. **CTA:** "Connect wallet to stake" → §8.3. The funnel steps (arrive → scroll depth → due-diligence sections → connect → first deposit) are counted as the aggregate funnel-stage tallies §8.8 consumes (first-party, aggregate-only; §3 decision 14).

> **Revision 2026-07-22 (PR 4.2, Learn page):** delivered in `apps/web`
> (`app/learn/learn.server.ts` assembles the data; components under
> `app/components/learn/`), rendering inside the 4.1 chrome with every figure
> independently degradable to an honest "n/a"/cold-start state (gated by
> `test/learn-data.test.ts`). Deliberate deltas until their dependencies
> land: the CTA routes to the Stake page (a labeled stub until M5) since no
> wallet flow exists yet; the compare-to-self-staking panel is qualitative
> (no fabricated numeric baseline; a real one is a recorded follow-on);
> funnel counters stay with PR 7.6 (§14.10); the hero pipeline ships as a
> static SVG with a reduced-motion-safe CSS pulse. The APR minimum-window
> rule is `MIN_APR_EPOCHS = 2` in `learn.server.ts` (below it: "n/a
> (insufficient history)", never an annualized single epoch). Indexed
> figures (participants, program age, epoch chart, incidents) consume the
> §9.4 contract shapes frozen by this PR and render "n/a"/empty until M2/M3
> wire real data. **Vocabulary (PR 4.2 review, Ira):** consumer copy says
> "monthly settlement" for the cadence (the program targets calendar
> months); "epoch" appears exactly once, in the hero's mechanism sentence
> above, matching this section's own phrasing. Data identities (epoch
> indices, `EpochRow`) keep their names. **Resolved (E-CAL, 2026-07-22):**
> the contract's calendar-month rollover predicate has landed (§14.12;
> `liquid-staking-spec.md` §9), so the cadence is genuinely calendar-month
> on every network — an epoch is eligible only once block time enters a
> later civil month — and the "calendar month" / "monthly settlement" copy
> now matches the mechanism. Flip side to remember when testing: a devnet no
> longer produces sub-month epochs, so App epoch-history and
> time-to-payout displays are exercised against seeded/simulated data rather
> than rapid live devnet cranks.

Priya's home. Composes additional roles additively (register F1): operator and admin cards append below the holder view when the address qualifies.

- **Position summary:** nvHASH balance (on-chain live read), value in HASH at current NAV, value at market price (both labeled as what they are), accrued gain since first deposit, and cost basis — from indexed history (§9.5).
- **Effective yield panel:** her personal realized accrual annualized (§9.5 formula) charted against the program's advertised net APR per epoch. The two lines answering "am I getting what the headline says?" is the single highest-trust feature in the App; any systematic gap is explained inline (timing of deposits vs epoch steps).
- **Accrual tracker:** her position's HASH value over time — a step-after chart (her balance × NAV history), with deposit/redeem markers.
- **Active redemptions:** each pending `SwapOut` with escrowed shares, current estimate, the maturity countdown, funded state, and the expedite explanation; links to §8.4's tracker detail.
- **Transaction history:** every indexed event for her address (deposits, redemptions, transfers in/out, refunds), each row with amounts, NAV at the time, txhash → explorer, and verify link. **Exportable as CSV** (register D2) — raw per-event rows with the share price in HASH (NAV) at each swap (§14.11 decided; a separate operator export of commission/TIP payments lives in §8.6).
- **Alert settings:** per-address rules — NAV step posted, redemption matured/expedited/refunded, market premium/discount beyond X bps, vault paused/halted, validator-set incident — each deliverable in-app always, plus Web Push when opted in (register D1).

### 8.3 Stake (route `/stake`, wallet required to submit)

The guided `SwapIn` flow (§10.3 for the transaction mechanics):

- **Educate inline:** one screen states what will happen — HASH transfers into the vault, nvHASH mints at the current rate, value accrues at monthly epochs, exit paths exist — with the *next expected epoch step* date (the first of the calendar month after `EpochStatus.last_run` — the §14.12 calendar cadence; the contract's `RunEpoch` `too soon` error reports the same next-eligible instant).
- **Amount entry** with wallet balance, vault min/max limits (vault config), and a live preview: expected nvHASH out at current NAV `[VERIFY §14.2: estimate query]`, plus the plain sentence "your nvHASH amount stays fixed; its redemption value grows."
- **Vesting-HASH honesty:** unvested HASH cannot be deposited (contract §13); if the connected account holds locked HASH the flow says so rather than letting the transaction fail cryptically.
- **Preview → sign → track** per §10.2, then land on Portfolio with the new position and a first-timer explainer of the accrual model.

### 8.4 Redeem & Exit (route `/exit`)

The most communication-critical surface in the program (contract §17.1 "the 60-day headline number needs communication"). It opens with the **exit-path comparison**, not a form:

| | DEX trade (instant) | Native redemption (protocol rate) |
|---|---|---|
| You get | market price − slippage (live quote from indexed pool state) | full NAV at **maturity** (re-priced at payout, contract §8) |
| Timing | now (on Base/Ethereum, after bridging) | **guaranteed ≤ 60 days**; *typically* released early — the indexed median / p90 time-to-payout for recent epochs shown beside the guarantee |
| Risks | premium/discount, pool depth, bridge transit | none beyond the wait; unfunded maturity refunds shares (never a loss) |

- **The guaranteed-vs-typical framing is normative:** the 60-day ceiling is always the number in the promise position; the historical expedite distribution (§9.5) is always labeled "typical, not guaranteed." Reviewers should reject any layout that visually promotes the typical number into a promise.
- **Native redemption flow:** shares amount → payout estimate with the maturity re-pricing explained ("estimates rise if an epoch lands before payout") → preview/sign/track (§10.3) → the **redemption tracker**: queue position, live funded state, countdown, and what "expedited" means; subscribes the user to the matured/expedited/refunded alerts by default.
- **DEX path (v1): a labeled "coming soon" shell (§14.4 decided).** No bridged nvHASH exists at launch, so there is no live DEX quote; the DEX column renders as a **post-launch capability** — its honest quote + premium/discount + depth bands from `market_samples`, plus the destination pool link, activate when NUVA's bridge deliverable lands. In-app swap execution is out of v1 scope regardless. **v1 exit is native-redemption-only in practice.**
- **Direct-vault redemptions appear here too** — the tracker reads the on-chain queue, so a redemption made with any tool shows up (same property the contract guarantees, contract §8).

### 8.5 Market (route `/market`)

**v1 status (§14.4 decided): a labeled "coming soon" shell** — until nvHASH is bridged there is no secondary market to sample, so this page renders as a forthcoming surface; the description below is its post-bridge target state.

The secondary-market context page (register A3): NAV vs market price over time (two series, clearly named — the accrual step line vs the market line); current premium/discount with an explainer of *why* a spread exists (stepwise NAV creates a pre-/post-epoch seam — contract §17.1 — plus liquidity and bridge-transit costs); pool depth and where nvHASH supply lives (local vs bridged, §5.3). Alert hooks for spread thresholds. Every market figure is labeled with its venue and sample time — market data is the one plane with **no** chain-canonical version, so its freshness labeling works twice as hard.

> **Revision 2026-07-22 (PR 4.4, page delivered):** implemented in `apps/web`
> (`app/market/market.server.ts`; components under `app/components/market/`)
> as the labeled v1 shell over PR 3.2's real contract: three distinct states
> (unavailable / forthcoming / active sample), the premium rendered VERBATIM
> from the API (the §9.5(4) formula is not recomputed web-side; a null
> premium renders "n/a", never 0), depth and bridged rows always carrying
> venue-or-chain + sample time, and NO verify link on any market figure
> (§12.1 rule 4), all gated by `test/market-data.test.ts` +
> `e2e/market.spec.ts`. Local supply is composed from the live plane (vault
> `total_shares`) per the PR 3.2 amendment. The program-history views (NAV,
> TVV, net APR per settlement) render real `/epochs` data via a shared
> step-chart extracted from the Learn chart; the NAV-vs-market pairing
> activates by data presence when a market opens (the caption names the
> forthcoming line). Spread-threshold alert hooks are M6 machinery,
> deliberately absent here.

### 8.6 Validators (route `/validators`, public; `/validators/mine` for operators)

- **Public view:** the validator set as consumer-legible cards/table — moniker, eligibility, uptime vs threshold, program delegation, tenure — plus set-health aggregates (eligible count trend, churn from indexed history). Framing: "who is staking your HASH and are they reliable," not the console's operational table. Verify links land on the Console validators page.
> **Revision 2026-07-22 (PR 4.3, public view):** delivered in `apps/web`
> (`app/validators/validators.server.ts`; components under
> `app/components/validators/`), inside the 4.1 chrome. The uptime threshold
> is read live from `Config {}` (`performance_threshold_bps`); program
> delegation reads the asset-manager contract's x/staking delegations (the
> captured corpus shows the contract as delegator). Set-health aggregates
> consume PR 3.1's `/api/v1/validators` contract (`ValidatorsPayload`
> `set_health`, per the §9.4 ownership note); the page projects only the
> total/active/eligible counts to the client. The per-settlement
> eligible-count TREND and churn named above have no serving endpoint yet
> and are a recorded follow-on (a history endpoint or a `/validators`
> extension, with PR 3.1's owner). The client-crossing row is a CLOSED
> public projection: operator economics (commission, TIP, headroom, arrears)
> never leave the web server, gated by `test/validators-data.test.ts`. The
> operator view below is untouched and lands with its own milestone.

- **Operator view ("my validator"):** the participation economics in consumer form — current + historical program delegation, rewards earned on it, commission owed (with the one-epoch grace state made plain), TIP paid vs rank effect, eligibility headroom on each threshold, and net-benefit-after-fees (personas §7's core question). Historical earnings and peer-rank context come from `validator_epochs` — history the console cannot show. **Every operator action is a first-class App transaction flow** (§14.6 decided): pay commission/TIP, enroll/unregister, and jailed-validator purge are built, previewed, signed, and tracked in the App per §10.2 — the Console keeps the same actions as an engineering surface, no longer the required path. The App's job is that Owen never *discovers* an obligation late (arrears alert rule is on by default for operator sessions). A **commission/TIP payment-history CSV** (amounts + times) is exportable here for the operator's own tax analysis (§14.11).

### 8.7 Governance (route `/governance`, public read; member write)

The rich `x/group` workflow the boundary doc assigns to the App (boundary §3 governance split; the App is the primary home — §14.6 decided):

- **Proposal list & detail:** live + indexed proposals for the program's group policies — decoded messages (human-readable summary above the exact JSON), proposer, submitted/expiry times, tally vs threshold, per-member vote status (who, how, when), and outcome history (durable, indexed — the audit trail personas §8 requires).
- **Member actions:** cast vote and execute-when-passed, signed by the connected wallet (`MsgVote`, `MsgExec` on `cosmos.group.v1`), with the §10.2 preview/sign/track lifecycle and the decoded payload shown before signing (Grace's "what exactly does this do" question).
- **Proposal creation:** v1 scopes composition to **selecting from decoded templates of the program's admin actions** (config change with a diff view, halt/resume, pause/unpause, bridge config) rather than free-form message building — free-form compose stays a Console strength (§14.6 decided: template-scoped creation ships in v1).
- **Validator votes:** if register B2 resolves toward validator-elected admins, the voting surface is this page; the spec takes no position on B2 itself.

### 8.8 Admin Analytics (route `/admin`, admin only)

The cohort-satisfaction dashboard the no-backend console cannot render (register A4), fed by the indexer and the first-party aggregate analytics (§3 decision 14):

- **Program health header:** TVL trend, net APR trend, depositor count, net deposit flow per epoch — indexed, with verify links for the current values.
- **Holder cohort:** adoption (new depositors/epoch), retention (cohort curves by first-deposit epoch), redemption mix (expedited vs matured vs refunded), TVL concentration.
- **Validator cohort:** enrollment/churn timeline, eligibility trend, arrears frequency, TIP participation, purge events.
- **Evaluator funnel:** Learn-page conversion (visit → due-diligence depth → connect → first deposit) from the aggregate stage counters — totals per funnel stage only, never per-wallet or per-session web behavior.
- **Upkeep timeliness:** time-lag distributions for the permissionless cranks (epoch run after eligibility, capture-signal cadence gaps, service-redemption latency) — indexed from crank txs; this is the personas' "upkeep-action lag" signal and doubles as keeper monitoring.
- **Incident feed:** §9.6 incidents with severity, acknowledgment, and durable history.
- Support/complaint signals are out of scope for v1 (manual/off-tool) and said so explicitly.

---

## 9. Backend & Data Layer

### 9.1 Prisma schema (multi-file, one model per file)

Core tables (base-unit amounts as `Decimal @db.Decimal(39,0)`; all rows carry the ingestion height/txhash where applicable). Tables live in one of two role-owned schemas per ADR-001 Decision 1: **`indexed`** (written only by `services/indexer`; rebuildable from chain) or **`app`** (written only by `apps/web`; the backup-critical domain). Each domain has its own Prisma schema and migrations; there are no cross-schema foreign keys or joins.

- `users` (wallet address PK, first/last seen, locale), `sessions` (nonce-signature auth, expiry) — `app` schema. No off-chain identity columns, ever (`SECURITY.md`): adding one is a design-review event, not a migration.
- `transactions` (txhash + msg index PK; address; kind: `swap_in | swap_out_request | redemption_payout | redemption_refund | transfer_in | transfer_out`; amounts in shares and nhash; NAV at height; block time).
- `redemption_requests` (request id; owner; shares; estimates over time; enqueued/expedited/matured/refunded timestamps; terminal status) — the §9.5 time-to-payout source.
- `epoch_snapshots` (epoch_index PK; the full contract §9.10 decomposition; gross/net APR bps; txhash; height; observed_at) — canonical program history, backfilled from genesis-of-contract (§9.3).
- `validator_registry` (valoper; operator; moniker; enrolled_at; unregistered_at) and `validator_epochs` (valoper × epoch; uptime bps; eligible + failing reasons; tip; commission accrued/paid/due; program delegation; jailed events).
- `incidents` (kind; severity; opened/closed; payload) — §9.6, `indexed` schema (computed facts). The optional admin acknowledgment is an app action and lives in an `app`-schema `incident_acks` table referencing the incident id (ADR-001 Decision 1) — the web tier never writes `incidents`.
- `market_samples` (venue; pool; price; depth bands; sampled_at) and `bridge_supply_samples` (chain; remote supply; sampled_at).
- `gov_proposals` / `gov_votes` (indexed mirror of `x/group` state for history and per-member status).
- `alert_rules`, `notifications` (rule; address; channel; payload; delivered_at; read_at) — `app` schema, with Web Push subscriptions and the aggregate funnel counters (§14.10).
- `indexer_checkpoints` (stream name PK; cursor height/page; updated_at) — the nuva precedent, one row per worker stream.

### 9.2 Indexer workers

- **Transport:** dual-source per the §14.5 resolution (RESOLVED 2026-07-20, PR 2.1) — tx-search by height range for DeliverTx events, and `block_results` per height for EndBlocker payout/refund + the NAV marker (which never appear in tx-search, §14.2); paging to exhaustion per block window; RPC websocket subscription is a latency optimization, not a correctness dependency.
- **Idempotency:** all writes are upserts keyed by (txhash, event index) or natural keys; a worker can be restarted or re-pointed at height 0 and converge to the same state.
- **Ordering & finality:** workers trail the head by a small confirmation depth (~block-time-safe; Provenance ~5 s blocks, instant finality — **depth 0**, RESOLVED §14.5, PR 2.1); the cursor advances only after the full block window commits in one DB transaction.
- **Event shapes are contract-verified fixtures:** every event the indexer decodes (`RunEpoch` snapshot attributes, vault swap events, expedite events) is captured from devnet drills into MSW/unit fixtures, so a contract event change breaks tests, not production `[VERIFY §14.2]`.
- **Lag accounting:** each stream exposes `indexed_height` vs `chain_height`; the max lag drives the footer freshness line and the DATA DEGRADED banner threshold.

### 9.3 Backfill

On first deployment (and after any reset) the epoch-history and chain-events workers walk from the contract's instantiation height to the head. Devnet redeploys reset the database with the environment — histories never mix across (chain_id, contract) pairs, the same isolation rule as the console's ledger keying (console §9.3), enforced as a fail-closed boot check (PR 2.0, `services/indexer/src/runtime/streams.ts`).

**Epoch-history backfill mechanism (PR 2.2):** the contract retains only the *latest* epoch snapshot on chain (§13, contract §9.10), so history is recovered by a **height-pinned smart query at each `run_epoch` crank height** — querying `epoch_snapshot`/`apr` with `x-cosmos-block-height: H` returns the epoch that closed at H. Cranks are located by tx-search (`wasm action=run_epoch`); rows upsert by `epoch_index`, so replay from genesis and resume from a checkpoint converge to the same `epoch_snapshots`. **Retention caveat (documented, not silent):** height-pinned queries work for any past height on a full-state node; a node that has *pruned* state below a crank height cannot serve that epoch — a config/retention limit, surfaced rather than hidden.

### 9.4 API surface

Versioned JSON under `/api/v1/`, split across the two serving processes per ADR-001 (amended 2026-07-14; previously the nuva `api+/v1+` single-process convention):

- **`services/api`** serves everything derived from indexed data: public program endpoints (`/metrics`, `/epochs`, `/validators`, `/market`, `/incidents` — unauthenticated, read-only, rate-limited), address-scoped endpoints (`/portfolio`, `/transactions?format=csv`), and admin analytics endpoints. Address-scoped and admin endpoints are authorized **in-process** by a short-lived scoped service assertion minted by the web tier's session layer (HMAC, `exp − iat ≤ 60 s`, key `API_SERVICE_ASSERTION_KEY` from environment): an `address:<bech32>` scope must match the requested address exactly or the request is rejected (403; absent/expired/invalid → 401). This is an enforced mechanism, never a caller-topology assumption — the cross-address-rejection contract tests gate `services/api` CI (ADR-001 Decision 2, §12.3). A read-only `internal:notifier`-scoped surface serves the notifier's cross-address evaluation reads and grants nothing else.
- **`apps/web`** serves the app-state routes over its own schema: sessions, `/alerts` rule CRUD, the notification log, push-subscription management, and the aggregate counters. It never reads indexed tables directly; indexed history reaches it only through `services/api`.

Every response from either process carries the freshness envelope `{ data, meta: { chain_height, indexed_height, generated_at, source: "live" | "indexed" } }` — a shared response type (`@nvhash/api-types`) so the freshness contract is in the API shape, not just the UI. `chain_height`/`indexed_height` are `number | null`: `null` is the honest "height not yet known" state (a cold start, or the M1 scaffold before the M2/M3 workers and reader land) that the UI renders as "n/a" per §12.1 — never a fabricated number. `source` stays the closed `live | indexed` union; unwiredness is expressed by null heights, not a third source value.

> **Revision 2026-07-14 (PR 1.2, `services/api` scaffold):** `@nvhash/api-types` and the read-only serving shell now exist. The scaffold registers `/api/v1/status` (enveloped service descriptor), `/api/v1/incidents` (enveloped, zod-bounded `?limit=&offset=` pagination — the seam PR 3.1 fills with real derivation and heights), and `/api/v1/health` (operational liveness, deliberately un-enveloped). All routes are GET-only (any write verb → 405), rate-limited, and — being dataless until M3 — report null heights. The `api_reader` client (`@nvhash/db-indexed`) and address-scoped endpoints are **not** wired here; they land in M3 (PRs 3.1–3.3) with the cross-address-rejection gate.

> **Revision 2026-07-22 (PR 4.2, Learn-facing 3.1 contracts frozen):** the
> M3 contracts-first step is done for the Learn page's subset. Row shapes
> live in `@nvhash/api-types` (`ProgramMetrics`, `EpochRow`, `IncidentRow`
> with closed kind/severity unions mirroring the indexer's incident schema);
> `services/api` registers `/api/v1/metrics` (enveloped, all-null scaffold)
> and `/api/v1/epochs` (enveloped, paginated, empty scaffold) and types
> `/api/v1/incidents` rows accordingly, all gated by the registry-driven
> envelope-contract harness. PR 3.1 implements the real derivations against
> exactly these shapes (a field change is a revision here, never a silent
> edit) and adds `/validators` with PR 4.3.

> **Revision 2026-07-22 (PR 3.1, public program endpoints — working plan
> `docs/plans/2026-07-22-app-m3-query-api.md`):** the real derivations are
> live behind the frozen shapes. `services/api` reads the `indexed` schema
> through `@nvhash/db-indexed` — a client GENERATED from the indexer's
> canonical Prisma schema (no schema copy; read-only enforced by the
> `api_reader` role, not the client) — behind an injectable reader port, so
> the unit/contract suite stays Postgres-free while a DB-backed reader gate
> (`test:db`, in the app-ci `db-grants` job) proves the real queries and the
> Decimal→decimal-string round trip. Envelope heights come from the latest
> `reconciler_runs` row, falling back to the max non-`meta:` worker
> checkpoint (`chain_height: null`) when the reconciler has not run; cold
> start stays null/0, never fabricated. Recorded decisions: (a)
> `/validators` is OWNED by PR 3.1 (amending the 4.2 note above): rows are
> `ValidatorRow` + `ValidatorSetHealth` in `@nvhash/api-types` — registry
> enrollment joined to the validator's latest sampled epoch, per-epoch
> fields null before the first sample — with PR 4.3 consuming them; (b)
> `/metrics.participant_count` is **distinct addresses across all
> transaction kinds** (any participation, not depositors-only); (c)
> `EpochRow.nav` widened to `string | null` — an epoch settled with zero
> shares has no NAV and null is the honest state; (d) the NAV formula is the
> shared scale-then-floor helper `navHashPerShare` lifted into
> `@nvhash/api-types` and golden-pinned to the web implementation's fixture
> values (the web's switch to the shared copy is a recorded follow-on); (e)
> `/status.data_source` now reports what is wired (`api_reader` |
> `unwired`) with real heights — the §8.0 chrome's freshness source.
> `DATABASE_URL` (the `api_reader` role) is consumed as an OPTIONAL bounded
> config: absent, every route serves the honest empty/null state. `/market`
> remains PR 3.2; address-scoped endpoints and the cross-address gate remain
> PR 3.3.

> **Revision 2026-07-22 (PR 3.2, `/market` — shape-complete, honest-empty):**
> `/api/v1/market` is registered with its contract frozen in
> `@nvhash/api-types` (`MarketSummary` / `MarketSample` / `MarketDepthBand`
> / `BridgedSupplyRow`) AHEAD of the data: with the market sampler (plan PR
> 2.4) parked pending §14.3 and no bridged nvHASH in v1 (§13 decision 4), it
> serves the honest empty state (`sample: null`, `bridged_supply: []`) under
> the full contract gates — the "coming soon" shell is structural, never a
> fabrication. Recorded decisions: (a) venue + pool + `sampled_at` ride IN
> the payload — market data has no chain-canonical plane (§12.1), so a
> market figure is never served without where/when it was sampled; (b)
> `premium_discount_bps` is signed, truncated toward zero, and computed
> against the **NAV current at the sample's time** (the last epoch settled
> at or before `sampled_at`, per §9.5(4)) — a newer NAV never retroactively
> reprices an older sample; null when no epoch had settled (no NAV → no
> premium, never a fabricated 0); (c) `price` is pinned as **nhash per whole
> nvHASH** (base-unit integer, decimal string); (d) the supply split serves
> the **bridged side only** (latest `bridge_supply_samples` reading per
> chain) — LOCAL supply is a live chain read owned by the web tier (§5.1)
> and is deliberately not fabricated from indexed samples (amending §8.5's
> "local vs bridged" wording: the API provides bridged; the page composes
> local from the live plane); (e) `MarketDepthBand`
> (`side`/`slippage_bps`/`amount`) is a PROVISIONAL frozen shape — PR 2.4
> must write `market_samples.depthBands` in exactly this shape or amend it
> here; stored band JSON is boundary-validated on read and fails loudly on
> mismatch, never a best-effort passthrough.

> **Revision 2026-07-22 (PR 3.3, address-scoped endpoints + in-process
> authorization — M3 complete):** `/api/v1/portfolio?address=` and
> `/api/v1/transactions?address=` (+`&format=csv`) are live behind the
> ADR-001 Decision 2 mechanism, with the **cross-address-rejection contract
> suite** (`services/api/test/cross-address.test.ts`) standing in CI from
> this change on. The assertion wire format is recorded in the ADR-001
> Decision 2 amendment (Bearer `b64url(payload).b64url(hmac)`, HMAC-SHA256,
> `exp − iat ≤ 60 s`, 10 s forward-skew bound on `iat`, fail-closed without
> a configured key); routes declare `public`/`address`/`internal:notifier`
> in the route registry and the pipeline enforces credential validity
> before query validation and the scope↔target match after it (401 → 400 →
> 403). `?address=` is bounded by a bech32 schema (400 on malformed input).
> Frozen shapes: `TransactionRow` (per-event facts with the NAV marker at
> each height) and `PortfolioSummary`/`RedemptionRow`. Recorded decisions:
> (a) `PortfolioSummary` deliberately has **no balance field** — the nvHASH
> balance is the web tier's live read (§8.2); indexed transactions cannot
> see bank transfers, so a transactions-sum balance would misstate holdings
> (it serves first activity, event count, escrowed shares, and active
> redemptions; cost basis/effective yield remain the M6.1 service); (b) the
> chain's projected-payout `estimates` series is absent from
> `RedemptionRow` — no indexer worker writes it yet; adding it is a
> revision here when its producer lands; (c) the CSV export is the §14.11
> statement-of-fact (pinned columns `datetime_utc, block_height, txhash,
> msg_index, kind, shares, nhash, nav_at_height`, formula-injection
> guarded) and — a recorded deviation from the "every response carries the
> envelope" rule above — carries its freshness in `X-Chain-Height` /
> `X-Indexed-Height` / `X-Generated-At` response headers, since a CSV body
> cannot carry the JSON envelope.

### 9.5 Derived metrics (formulas)

All in integer/`BigInt` arithmetic with explicit scale-then-floor; percent/HASH conversion at render only.

1. **Cost basis & accrued gain (per address):** cost basis uses **average-cost** (§14.11 decided) — average deposit cost per share × remaining shares; accrued gain = current shares × current NAV − remaining (average-cost) basis, plus realized gains on completed redemptions. The CSV export is raw per-event rows (share price in HASH at each swap), not a computed lot-matched basis (§14.11).
2. **Effective yield (per address):** over window W, gain = Σ per-interval (shares held × ΔNAV at each epoch step inside W); effective APR = gain ÷ time-weighted average invested value, annualized. Rendered per epoch beside the program's `net_apr_bps` for the same window. Sub-day windows follow the shared minimum-window rule (render "n/a").
3. **Typical time-to-payout:** per recent-epoch cohort of terminal `redemption_requests`, the median and p90 of (`expedited_at ?? matured_at`) − `enqueued_at`. Displayed only with **≥ 10 terminal requests** in the cohort (§14.12 decided); below it, the flow shows the 60-day guarantee alone — a small-sample "typical" would be a lie with extra steps. The statistic is physically bounded to the **~21-to-60-day band** (unbonding floor to guarantee ceiling); labeling never implies precision outside that band.
4. **Premium/discount:** `(market_price − NAV) / NAV` in bps, computed at each market sample against the NAV current at that sample's time.
5. **Upkeep lag:** for each crank kind, actual execution time − earliest-eligible time (from config intervals + prior state), distribution per epoch.
6. **Reconciliation deltas (§12):** indexed vs live for NAV inputs, total shares, epoch index, queue length — the reconciler's inputs, stored with each run. **Per-metric tolerances live in code** (`services/indexer/src/reconciler/tolerances.ts`), reviewed like the schema allowlist and **not env-tunable** — a widened tolerance would silence the alarm, which §12.1.3 forbids (RESOLVED 2026-07-21, PR 2.5). The "live plane" the reconciler compares against is the chain's retained latest epoch snapshot (the authoritative current record); copied snapshot values use an exact (0) tolerance, so any indexed divergence trips `reconciler_divergence`. **Queue-length delta is deferred** to a fast-follow (it needs a vault `pending_swap_outs` decoder the indexer does not yet carry).

### 9.6 Incident derivation

Incidents are **computed from indexed facts, never hand-entered**: contract halted/resumed; vault paused/unpaused (with reason); slash write-down > 0 in an epoch; redemption refund observed (unfunded maturity — contract §8's "failure mode is a refund"); jail report opened/purged; epoch overdue (now − last_run > interval + slack); reconciler divergence; indexer lag beyond threshold. Each maps to a severity aligned with the console's status semantics (console §11.2) and feeds banners, the Learn-page history (C2), holder/admin alerts (D1), and the admin feed (A4). Closure is likewise computed (the condition clearing), with optional admin acknowledgment for the record.

> **PR 2.5 status (2026-07-21):** the reconciler is the **sole writer** of `incidents` (`services/indexer/src/reconciler/`). Delivered kinds: `reconciler_divergence` and `contract_halted` (closeable, live-derived), `indexer_lag` (closeable, from per-stream checkpoint lag), `slash_write_down` and `redemption_refund` (point-in-time, from indexed facts). The alarm is proven end-to-end by a Postgres-backed acceptance test (corrupt an indexed row → the incident opens; fix it → it closes). **Deferred to a fast-follow** (each needs an additional live decoder not yet built): `vault_paused` (vault query), `jail_report` (jail open/close lifecycle), `epoch_overdue` (keyed off the calendar-month rollover now that it has landed, `liquid-staking-spec.md` §9 — the `min_run_interval_secs` config interval it would have used is retired). Point-in-time kinds are opened once and not auto-closed; admin acknowledgment remains an `app`-schema concern.

---

## 10. Control Surfaces & Transaction Flows

### 10.1 Wallet integration

- **WalletConnect v2** is the confirmed interface across roles (personas §2): pairing, session, and `sign & broadcast` for Provenance messages. Wallet vendor set (decided §14.1): **Figure Wallet** (mobile pairing over WalletConnect v2, plus the Figure browser extension on desktop) **and Arculus** (WC v2 mobile) in v1, coordinated with the console's §14.1 (resolved the same day). The dual-vendor set is a conformance mechanism, not just coverage: the shared WC v2 path is built against the **standard pairing and Cosmos-namespace signing methods only**, must pass the §14.1 checklist against both vendors, and any vendor-specific workaround lives behind that vendor's adapter entry and is recorded in §14.1 — never in the shared path. Keplr/Leap ship only after passing the §14.1 certification checklist.
- The App performs **no server-side signing** of user transactions, holds no keys, and has no devnet key mode (that is a Console tool; the App's devnet build simply points WalletConnect at devnet).
- Session auth (§3.5) uses a one-time nonce signed by the wallet; the session cookie scopes personal reads and App-state writes only.

> **Revision 2026-07-23 (PR 5.1, delivered mechanism):** the wallet layer is
> a **closed vendor adapter registry** (`apps/web/app/wallet/adapter.ts`,
> `satisfies`-total; gated by `test/wallet-adapter.test.ts`) over a shared WC
> v2 core (`@walletconnect/sign-client`, standard pairing + Cosmos-namespace
> methods only — `cosmos_getAccounts`/`cosmos_signAmino`/`cosmos_signDirect`)
> and a per-vendor injected-extension adapter for desktop Figure; vendor
> workarounds may live only in that vendor's module (§14.1 mechanism (ii)).
> Session auth is concrete: server-minted single-use address-bound nonce
> (5 min TTL) → wallet signs the challenge over **ADR-36**
> (`sign/MsgSignData`, one construction site shared by client and server) →
> server verifies signature + pubkey→bech32 binding (`@noble`/`@scure`) →
> opaque 256-bit session id in an **HttpOnly / SameSite=Lax / Secure
> (non-dev) / Path=/** cookie over a server-side row (7 d absolute,
> 24 h sliding — plan §7 Q6 values). Roles are re-checked live per refresh
> (operator: `Validators {}` operator set; admin: `x/group` policy
> membership behind `Config.admin`, direct-equality fallback for a plain
> account) through a ≤ 60 s cache and are never persisted — the sessions
> schema has no role column, enforced by the app-schema allowlist gate.
> Gates: `test/session.test.ts`, `test/roles.test.ts`,
> `test/session-scope.test.ts` (standing), `test/assertion.test.ts` (golden
> vectors cross-pinned with services/api), `test/app-schema-allowlist.test.ts`.

> **Note 2026-07-23 (PR 5.2, e2e-live test-signer posture):** the "no devnet
> key mode" rule above is preserved **without a test-injection seam**: the
> e2e-live suite's throwaway devnet signer lives entirely in the Playwright
> test process (`apps/web/e2e-live/signer.ts`) and drives the App's own HTTP
> surface — nothing under `app/` imports it, the closed vendor registry is
> untouched, and `check:bundle` scans the client bundle for the signer's
> sentinel literal so even an accidental future import fails CI. Real-wallet
> flows are certified by the §14.1 checklist runbook, not by the test signer.

### 10.2 Transaction lifecycle (all flows)

1. **Build** client-side: typed Provenance messages (vault `MsgSwapIn` / `MsgSwapOut` `[VERIFY §14.2: exact msg names/fields on the deployed vault module]`; group `MsgSubmitProposal` / `MsgVote` / `MsgExec`).
2. **Preflight** from server-supplied context: vault not paused, amount within min/max, balance sufficient (incl. fee), vesting-lock check for deposits; disabled controls always carry the reason (the console's R1 rule adopted verbatim).
3. **Simulate** for gas; fee = gas × gas price with adjustment `[VERIFY: reuse console §14.3 result]`.
4. **Confirm:** consumer-worded consequence summary + the exact message JSON behind a disclosure + fee. Warning tier for redemptions ("shares escrow now; guaranteed release date D; typically sooner") and governance execution; **danger-tier confirmation for the program-ops now originated in the App** (halt/resume, pause/unpause, config change, bridge config, jailed-validator purge — §14.6 decided), with the decoded action and its consequence stated before signing.
5. **Sign & broadcast** via the wallet; **track** inclusion; toast lifecycle (sonner) with explorer link; on success the affected live reads refresh and an indexer fast-poll reconciles the user's history within seconds (an optimistic pending row bridges the gap, clearly marked pending).

> **Revision 2026-07-23 (PR 5.2, delivered mechanism):** the lifecycle is a
> typed pure reducer (`apps/web/app/tx/lifecycle.ts`): `idle → building →
> blocked(reasons[]) | ready → simulating → confirm → signing →
> broadcasting → pending → reconciling → confirmed | failed`. Structural
> guarantees, each CI-gated (`test/tx-lifecycle.test.ts`): transitions are
> total; **signing is unreachable except through the confirm step**;
> **confirmed is unreachable before chain inclusion**; an on-chain
> execution failure renders as failure with the chain's reason — no retry
> loop, no fabricated success. Step mechanics: message building +
> SIGN_MODE_DIRECT encoding via a ~150-line dependency-free proto layer,
> **byte-golden to the §14.2 corpus** (re-encoded fixture txs must hash to
> their captured chain tx ids — `test/tx-build.test.ts`); the step-4
> disclosure renders proto-JSON produced from the same object the sign doc
> encodes (**one serialization site**; `test/tx-confirm.test.ts` proves the
> disclosure equals the decoded sign-doc bytes). Preflight runs
> server-side from live reads with machine-readable reasons
> (`test/tx-preflight.test.ts` drives the reject-never-clamp boundary
> matrix); simulation prices fee = gas × 1905 nhash × 1.3 in integer math
> (the console's basis, still `[VERIFY §14.3]`). **Broadcast is the §12.3
> guarded relay** (amendment below); tracking polls inclusion through the
> web tier, then fast-polls `/api/v1/transactions` under a Decision-2
> assertion until the indexed row lands and the pending row drops (bounded
> wait — chain inclusion, the canonical plane, drives `confirmed`; history
> lag is carried by §12.1 freshness labels).

### 10.3 Flow-specific rules

- **SwapIn:** never enabled while the vault is paused (with the reason and the "deposits resume automatically when unpaused" note); preview shows shares at current NAV and states the mint is at the *execution-time* rate.
- **SwapOut:** confirmation restates the three timing facts in fixed order — guaranteed ceiling, typical-experience statistic (when sample-sufficient), and the refund-not-loss failure mode. Post-submit, the tracker owns expectations; the matured/expedited alert is opt-out, not opt-in.
- **Governance:** votes and executions show the decoded action and current tally at signing time; execution additionally simulates and surfaces would-fail states before the user signs.
- **Privileged writes are complete App flows (§14.6 decided):** validator chain-ops (commission/TIP, enroll/unregister, purge) and admin program-ops (halt/resume, pause/unpause, config, bridge config — originated as §8.7 governance templates) are **fully** built/preview/sign/tracked in the App per §10.2, never half-implemented and never a Console-only step in a normal workflow. The Console keeps these actions plus free-form composition as an engineering surface. All remain wallet-signed message-building; the App holds no keys and the contract stays the enforcement boundary (SECURITY.md).

### 10.4 Notifications

Alert rules (§8.2) evaluate on indexer ticks; deliveries record to `notifications` and fan out per channel opt-in. Channels are **in-app (always)** and **Web Push (per-browser opt-in)**; there is no email channel (`SECURITY.md`: no off-chain identity linked to wallets). A push subscription is stored as an opaque, revocable endpoint token and is deleted on opt-out or session deletion; push payloads are minimal (event + link into the App, no amounts). Every alert kind has an in-app rendering so users without push lose nothing but latency.

---

## 11. Design Language

The App is the **branded, consumer-register member of the family**; the boundary doc assigned the calm consumer surface here so the console could stay austere (console §1, boundary §6). Two normative sources compose:

1. **The nuva design system** (`Labs/nuva-app` `app.css` tokens, `app/lib/design-system/tokens.ts`, shadcn/ui `new-york` components) supplies the idiom: Tailwind 4 token definitions, component primitives, radii/spacing/type scales, and the brand register — **Funnel Sans** body, **Space Grotesk** display, **Geist Mono** for addresses/hashes/JSON, the NUVA mint-green accent treatment for primary CTAs, dark default with a first-class light theme. Program-specific token values (this product's accent tuning and semantic status set) are **established (PR 1.4, §14.8, web-local in `apps/web/app/theme/tokens.css`):** the NUVA mint-green accent drives the primary CTA and focus ring (`--primary`/`--ring`), with a dark green-black CTA label clearing WCAG AA in both themes, and a fixed four-role status set (`--status-good`/`-warning`/`-serious`/`-critical`) reserved for state and always shipped with icon + label. Both theme token sets are re-validated by the shared dataviz method on every change — the categorical chart palette via `check-palette.mjs`, and the accent/status contrast via `test/brand-tokens.test.ts` (both reuse `validate_palette.js`).
2. **The shared dataviz method** (the same references the console §11.6 instantiates) governs every chart regardless of register: NAV and position-value series are **step-after** (interpolation of stepwise accrual is a lie); signed measures (net deposits, premium/discount) use the diverging pair, unsigned use sequential; status colors are reserved for state and always ship icon + label; single series are titled not legended; every chart offers a table view; sub-3:1 contrast slots carry direct labels. Recharts renders; the method decides.

**Register rules (the consumer deltas from the console):**

- **Explanation is a first-class element.** Every economic figure a consumer sees has one plain-language sentence available at its point of use (caption or tooltip) — the App assumes *no* prior liquid-staking literacy on public pages.
- **Calm by default, honest always.** Larger type, more whitespace, fewer simultaneous numbers than the console — but the same refusal to hide state: freshness, paused/halted banners, and "typical vs guaranteed" labeling are never sacrificed to calm.
- **Verify links are quiet but omnipresent** on material numbers — an affordance, not a shout (§12.2).
- **Voice:** plain, concrete, no exclamation points, no yield hype; jargon that the console permits ("crank", "drain order") is translated or avoided on public pages. Numbers still carry the enthusiasm.
- **Motion:** 150–200 ms ease-out transitions, one optional explainer animation on Learn; `prefers-reduced-motion` disables all. Full keyboard operability and focus rings per the nuva/shadcn baseline; WCAG AA on both themes.

---

## 12. Trust & Security Model

This section encodes boundary §5 as build requirements.

### 12.1 Reconciliation & freshness (the App's honesty surface)

1. **Chain canonical.** For NAV, APR, TVV, shares, redemption status, validator state, and governance tallies, the live-read plane (§5.1) is authoritative in every screen where it is available; indexed values serve history and aggregates.
2. **Freshness labels are structural.** Every API envelope and every indexer-derived figure carries source + indexed height/time (§9.4); the UI renders staleness (dim + badge) rather than blanking, exactly the console's stale rule.
3. **The reconciler is the alarm.** Divergence between indexed and live beyond per-metric tolerance opens an incident, flips affected surfaces to live-read-only with a "history temporarily degraded" note, and notifies admins. The App must never present a chain-contradicting number as current — this is the boundary doc's hard rule, and it is enforced by machinery, not review.
4. **Market data is labeled as unprovable.** DEX figures carry venue + sample time and no verify link (there is nothing on Provenance to verify them against); the UI vocabulary keeps "market price" and "redemption value" visually and verbally distinct everywhere they co-occur.

### 12.2 Verify-on-chain deep links (boundary §7.3 resolved)

- Link shape: `{CONSOLE_URL}/{route}` with the console's own view addressing; `CONSOLE_URL` is per-environment config, so **a link can never cross environments** — the App refuses to render verify links if its configured console profile's chain id mismatches its own (checked at boot).
- Figure → console view mapping: NAV/APR/TVV → Overview; epoch decomposition → Epoch & Ops; a validator → Validators; a redemption → Redemptions; governance/config assertions → the relevant console panel. Entity-level anchors (e.g., a specific request id) require a small console addition — recorded as a console follow-on in §14.13, not silently assumed.

> **Revision 2026-07-21 (PR 4.1, verify-link component):** the figure→view map
> now exists as a CLOSED typed union in
> `apps/web/app/components/verify-link.tsx` (`overview` → `/`, `epoch-ops` →
> `/epoch`, `validators` → `/validators`, `redemptions` → `/redemptions`,
> confirmed against the console's router). Totality is a compile-time
> `satisfies` assertion, and `test/verify-link.test.ts` gates that every
> target's href stays strictly under the booted `CONSOLE_URL` (whose chain id
> the boot check verified). A `governance` target is deliberately absent: the
> console has no governance panel yet, and a verify link must never be a dead
> link; adding the panel and the target is a console follow-on alongside the
> §14.13 entity-level anchors.

### 12.3 Application security

- **No custody, no server signing, no fund-moving endpoints** (§10.1). A full backend compromise can lie (until reconciliation alarms) and leak App-state data; it cannot move funds. Stating this bound explicitly is the point of the two-surface split.

  > **Amendment 2026-07-23 (PR 5.2, decided by Ira 2026-07-23): the guarded
  > signed-tx relay is not a fund-moving endpoint.** The web tier exposes
  > `POST /tx/broadcast`, which relays a **fully user-signed** transaction
  > to the chain. This does not weaken the bound above: the server cannot
  > alter a signed transaction without invalidating its signature, so the
  > relay adds no signing or custody capability — a compromised backend
  > still cannot move funds, only refuse to relay (and the user can submit
  > the same signed bytes anywhere). The relay is narrowly guarded, each
  > guard an enforced mechanism (`test/broadcast-guard.test.ts`): session
  > required; size-capped; decodes as one-signer TxRaw; message types in
  > the **closed §10.2 allowlist** (the two vault msgs; governance types
  > join with M7 as a recorded amendment); vault address must match config;
  > every message owner AND the signer pubkey must resolve to the session
  > address (the pubkey→bech32 derivation is the cryptographic binding);
  > rate-limited per address. Alternatives were rejected: browser→LCD
  > contradicts §7 ("the browser never needs LCD CORS"); wallet-side
  > broadcast is non-standard beyond `cosmos_signDirect` and would fail the
  > §14.1 dual-vendor conformance gate.
- **Personal data minimization (`SECURITY.md` is normative):** wallet address (public by nature), first/last-seen timestamps (minimal operational metadata, retained deliberately for transparent and minimally intrusive usage measurement), locale/theme, alert rules, and — when opted in — an opaque Web Push subscription token (revocable, deleted on opt-out). No email or other off-chain identity, no KYC, and no IP-or-device linkage to addresses in persisted logs (scrub or aggregate). Data deletion on request removes the user row, rules, and push subscriptions; indexed *chain* history is public information and remains.
- **Sessions:** nonce-signature login, `HttpOnly`/`SameSite` cookies, address-scoped authorization on every personal endpoint; admin endpoints re-verify group membership on-chain per session refresh, not per cached role.
- **API hygiene:** rate limiting on public endpoints, zod-validated inputs at every route boundary (nuva convention), winston structured logging in services, no secrets in the client bundle (server config never serializes past the §7 client-safe subset).
- **Analytics are first-party and aggregate-only:** no third-party trackers; counters are never keyed by wallet address, session, or device; never amounts or balances — page classes and funnel-stage tallies only `[DECIDE §14.10]`.
- **Supply chain:** the team's standard dependency policy; the transacting pages must function with third-party scripts blocked (analytics is additive).

---

## 13. Constraints Summary

Protocol and platform facts this design must respect (chain constraints identical to console §13 unless noted):

- **Amount scales and types:** decimal-string `Uint128` → `BigInt`/`Decimal(39,0)`; bps rates; exponent 9/15 denominations; signed `net_deposits`.
- **Stepwise NAV** (contract §5): no interpolated NAV anywhere — charts, previews, or notifications; between-epoch flatness is a displayed fact, not smoothed away.
- **Single-snapshot retention on chain** (contract §9.10): program history exists only because the App indexes it; the indexer is therefore availability-critical for history but never for canonical current values (live reads survive an indexer outage).
- **Redemption facts** (contract §8): the 60-day ceiling is the only promise; expedites are marker-liquidity-gated UX; maturity re-prices at payout NAV; unfunded maturity refunds shares. The App's copy must be generatable from these four facts alone.
- **Vault pause blocks user swaps and payouts** — the paused banner explains both, and both flows disable with the reason.
- **Vesting HASH cannot be deposited** (contract §13) — preflight, not error message.
- **Governance is `x/group`** (contract §12.1): proposals/votes/execution follow group-module semantics; the App renders and signs, never emulates.
- **Bridge accounting cannot move NAV** (contract §11.5): cross-chain supply display never implies NAV risk from bridging; the bridge trust note (contract §12.2) is the Learn-page risk text's source.
- **DEX liquidity lives on Base/Ethereum** — market data is cross-chain by construction, read-only via `viem`, and unprovable from Provenance (§12.1.4). **In v1 there is no bridged nvHASH, so no DEX market exists yet; the Market/DEX surfaces ship as "coming soon" shells (§14.4).**
- **~5 s blocks, instant finality** size indexer cadence and the freshness thresholds; users pay gas on every signed action (no fee-grant in v1).

---

## 14. Open Decisions Before Build

1. **[DECIDED 2026-07-14, Ira] Wallet vendor set:** v1 certifies **Figure Wallet** — mobile pairing over WalletConnect v2, plus the Figure browser extension on desktop — the Provenance-native wallet requiring no custom chain config. Console §14.1 is resolved in the same change (Figure extension + devnet direct-key mode for engineering, compile-time excluded from production), so the program certifies one wallet story with a per-surface transport matrix (App: WC v2 mobile + extension; Console: extension only). **Keplr and Leap are fast-follow, not v1.** A vendor joins the certified set only by passing the **certification checklist** end-to-end on devnet, on both surfaces in the same change: (a) pairing/connection over its supported transport (WalletConnect v2 or injected extension); (b) Provenance chain support — chain id, bech32 prefix, coin type 505, nhash denom/gas — via custom chain config where not native; (c) arbitrary-nonce signing for §3.5 session auth; (d) sign & broadcast of the §10.2 message set with the decoded-preview behavior intact; (e) the §10.3 flow rules exercised against a full devnet drill cycle. The checklist is the gating test, not a caller assumption: it runs against Figure itself as an automated acceptance gate of the wallet/session PR (implementation plan PR 5.1) — if Figure fails an item (notably (c) over WC v2), that failure blocks the PR and reopens this decision rather than shipping a degraded session flow. Adding a vendor later is a spec-recorded amendment here, never a config toggle.
   **Amended 2026-07-14 (Ira): Arculus added as a second v1-certified vendor** (WC v2 mobile; App surface only — no browser extension, so the console set is unchanged and the transport matrix becomes App: Figure WC v2 mobile + extension, Arculus WC v2 mobile; Console: Figure extension + devnet key mode). The checklist's "both surfaces" rule reads per this matrix: a vendor certifies on every surface whose transports it supports. Purpose: **dual-vendor certification is the standards-conformance guard.** Passing the checklist against two independent vendors is what enforces that the shared WC v2 path uses only standard pairing and Cosmos-namespace signing methods and does not silently depend on non-standard Figure behavior that would block wider WC v2 wallet support later. Mechanism, gating PR 5.1: (i) checklist items (a)–(e) run against **both** Figure and Arculus as the PR's acceptance gate; (ii) a vendor-specific workaround may live only behind that vendor's adapter entry, recorded here — the shared WC v2 path absorbs nothing vendor-specific; (iii) either vendor failing an item blocks the PR and reopens this decision. Provenance of the Arculus choice: **firsthand-verified** — Arculus's `signArbitrary` support was tested directly by Ira, working with the Arculus dev team, on the retired `explorer.provenance.io` site, **without Privy** (other Provenance applications reached Arculus through the Privy framework; Privy is explicitly not a dependency here). Item (c) for Arculus is therefore **re-confirmation of a known-working capability, not an open question**. The PR 5.1 devnet run remains the enforced gate for two reasons: the original test surface is retired and wallet releases drift since that test; and the run must confirm the capability over the **standard WC v2 Cosmos-namespace method** specifically — explorer-era Provenance wallet tooling predates WC v2 and used earlier WalletConnect lineages with custom sign methods, so method-namespace equivalence is the one aspect the historical test does not pin.
   **Implementation note 2026-07-23 (PR 5.1):** the adapter architecture this decision requires is in place — closed vendor registry (`figure-mobile` WC, `figure-extension` injected, `arculus` WC; `apps/web/app/wallet/`), shared WC v2 core restricted to standard Cosmos-namespace methods, per-vendor modules as the only home for workarounds. The certification checklist runs from the runbook [`2026-07-23-m5.1-wallet-certification-runbook.md`](../plans/2026-07-23-m5.1-wallet-certification-runbook.md); with Tranche A delivered as one PR (plan §5), items (a)–(c) certify at the 5.1 commit and (d)–(e) after the 5.2 commit — **all five per vendor before the PR merges**, results transcribed into the table here. The Figure extension's injected surface is provisional until its checklist column passes (recorded in the adapter module).
2. **[VERIFY] Vault user-message surface:** exact `MsgSwapIn`/`MsgSwapOut` names/fields on the deployed module, swap estimate query shapes, and the event attributes for swap/expedite/payout/refund the indexer decodes (§9.2). Capture as devnet fixtures. **Note (2026-07-13, Ira): this verification is two-stage.** The settlement-era vault module (`AcceptAsset`) has no formal upstream release yet; devnet capture runs against a development build identified by **feature probe** (`AcceptAsset` present), so captured shapes pin assumptions for drift detection without certifying compatibility. When the vault module cuts its formal release, the fixture corpus and full test suite must be re-verified against the released build — **no App release is certified before that re-verification passes** (implementation plan PR 8.0). **Stage 1 executed 2026-07-14 (PR 0.2):** corpus captured to `packages/fixtures` from a feature-probed dev build with a completeness gate over all terminal states (swap in, enqueue, expedite, payout, refund, both `RunEpoch` settlement legs). Pinned facts consumers must honor: msg type URLs carry a `Request` suffix; vault event attribute values are JSON-encoded strings; **payout and refund are EndBlocker events** (`finalize_block_events` via RPC `block_results` — never visible to tx-search; consumed by the §14.5 transport decision in PR 2.1); vault LCD REST lives under `/vault/v1` (not `/provlabs/vault/v1`), and `estimate_swap_in` is gRPC/CLI-only (grpc-gateway rejects `Coin`/`math.Int` query parameters) while `estimate_swap_out` serves over REST with a bare share-integer parameter (corrected 2026-07-14, PR 0.3 — the initial capture wrongly pinned the whole vault query surface as REST-less). Stage 2 (release re-vet) remains PR 8.0.
3. **[VERIFY] DEX/bridge deployment facts:** Uniswap pool addresses, pair asset, fee tier per chain; bridged-nvHASH token contracts; NUVA bridge transit API/UX integration points.
4. **[DECIDED 2026-07-15, Ira] Bridge transit UX in v1: deferred; DEX/market surfaces ship as labeled "coming soon" shells.** No bridging system or interface is part of v1 — the initial App, contracts, and services deploy and establish nvHASH on Provenance mainnet **before** the token is bridged to other networks via NUVA. Consequence: with no bridged nvHASH there is no Base/Ethereum Uniswap market at launch, so the cross-chain plane (§5.3), the Market page (§8.5), and the DEX column of the §8.4 exit comparison have no live data. Rather than remove them, they ship as **labeled "coming soon" shells** — the two-column Exit comparison and the Market page render with the DEX/secondary-market side marked a post-launch capability, so the information architecture is stable when NUVA's bridge deliverable lands. `UNISWAP_POOL_*` config and the `[VERIFY §14.3]` DEX facts stay documented placeholders until then. **v1 exit is native-redemption-only in practice**; the DEX path is presented as forthcoming, never as an available action. Timing stays coupled to the NUVA Labs bridge deliverable (contract §15 bridge note); enabling the DEX/market surfaces is a spec-recorded amendment here, not a config toggle.
5. **[RESOLVED 2026-07-20, PR 2.1] Indexer transport details.** The chain-events worker ingests from **two sources behind one checkpoint**: (a) Tendermint **tx-search** by height range for DeliverTx events (swap in/out request, expedite), and (b) **`block_results` per height** for the EndBlocker events that never appear in tx-search — payout, refund, and the `EventSetNetAssetValue` NAV marker (§14.2 pinned fact). RPC websocket subscription is **not** used — it is a latency optimization, not a correctness dependency, and polling with a per-window cursor is the correctness baseline. **Confirmation depth is 0** (Provenance instant finality; configurable via `CONFIRMATION_DEPTH`). Paging: tx-search pages to exhaustion per window; the window span is bounded (`INDEX_WINDOW_SPAN`, default 500) so a single transaction stays small. block_search-based narrowing of EndBlocker heights is a later throughput optimization, not required for correctness. Attribute values are JSON-string-quoted and decoded through one shared helper (`services/indexer/src/decode/attributes.ts`).
6. **[DECIDED 2026-07-15, Ira] Governance home & composer scope: the App carries a complete action interface for every non-engineering persona; the Console is engineering-only and never a required step in a normal user workflow.** Rationale: the Console targets only the Protocol Engineer persona (§16.5), so forcing the Evaluator, Position Holder, Validator, or Administrator through it for a routine action is a mis-fit.
   - **Governance (§8.7):** template-scoped proposal creation **ships in v1** — decoded admin-action templates (config change with a diff view, halt/resume, pause/unpause, bridge config) plus vote and execute-when-passed. The App is **not** vote/execute-only. **Free-form / arbitrary message composition stays a Console strength**, not replicated in the App; the guardrailed template set is the App's ceiling for non-engineers.
   - **Validator operator actions (§8.6):** pay commission/TIP, enroll/unregister, and jailed-validator purge become **first-class App transaction flows** (preview/sign/track per §10.2), no longer Console deep-links.
   - **Admin program-ops** (halt/resume, pause/unpause, config, bridge config) are originated in the App via the §8.7 governance templates — these program-ops *are* group-policy proposals, so "admin actions in the App" and "template-scoped governance" are the same mechanism.
   - **Boundary amendment:** this supersedes the prior "§10.3 everything-else-is-a-link" rule and §8.6's "every action lands in the Console." The App now **fully** implements these privileged writes (no half-implementation) — all still wallet-signed, message-building only, **no key material** (SECURITY.md apps rules unchanged; the contract remains the enforcement boundary and UI preflight stays convenience only). The Console retains free-form compose, the devnet key mode, and raw engineering ops as an engineering surface, not a user dependency (console §14.6 keeps the composer).
   - **Register B2 (validator-elected admins):** unchanged — this decision takes no position; if B2 resolves toward validator voting, that surface is the §8.7 page.
7. **[DECIDED 2026-07-13, Ira] Notification channels:** Web Push is confirmed as the external channel — meaningful application functionality with minimal intersection with the security rules, acceptable given per-browser opt-in, available opt-out, and the opaque revocable token handling of §10.4. `SECURITY.md` records this accepted exception. Remaining `[DECIDE]`: which alert kinds default-on per role. Email remains excluded and is not an option.
8. **[DECIDED 2026-07-14, ADR-001 Decision 4]** Design-system packaging (boundary §7.4): design tokens are **web-local** (`apps/web`) for v1, not a shared package — the two surfaces deliberately wear different registers and the console is mid-migration. Family coherence is enforced where it matters: both surfaces run the same dataviz palette validation (`validate_palette.js`) in CI on every token change, both themes. Shared TypeScript code (fixtures, chain client, API types, read-only indexed DB client) lives in a root pnpm workspace under `packages/` (`@nvhash/*`); the console may join the workspace with its own migration. Revisit shared token packaging post-v1 if drift is observed. **Brand pass delivered (PR 1.4, 2026-07-17):** program-specific accent and status tokens set web-local in `apps/web/app/theme/tokens.css` over the nuva base — NUVA mint-green primary CTA / focus ring (dark green-black label, WCAG AA both themes) and the fixed good/warning/serious/critical status set (icon + label; `warning`/`serious` are sub-3:1 on the light surface only under that relief rule). Both theme token sets pass the shared validation method in CI: the categorical chart palette via `check:palette`, the accent/status contrast via `test/brand-tokens.test.ts` (both computed by `validate_palette.js`, never eyeballed). §14.8 is now fully resolved.
9. **[DECIDED 2026-07-15, Ira] Launch locale set: `en` only.** v1 ships a single English locale. Future locales (`zh`/`ko` precedents or others) are TBD and explicitly **not in v1**. The `$lang+` i18n routing/plumbing (§8.0, §15) is retained with a single `en` catalog so additional locales are additive without a routing change — adding one is a content+config change, not a re-architecture.
10. **[DECIDE] Aggregate-analytics event taxonomy:** which page classes and funnel stages are counted, and the consent posture for the counters — within the `SECURITY.md` constraint that analytics are first-party, aggregate-only, and never keyed by wallet, session, or device.
11. **[DECIDED 2026-07-15, Ira] CSV export & cost-basis method.** The export is a **statement of fact, not a computed tax position**, and splits into two role-scoped exports:
    - **Holder export (§8.2):** raw per-event rows — one per `SwapIn`/`SwapOut` — carrying the **share price in HASH (NAV) at the event**, so the holder (or their accountant) does their own cost-basis math. Proposed columns: `datetime_utc`, `block_height`, `event_type` (swap_in | swap_out | refund | transfer_in | transfer_out), `nvhash_amount`, `hash_amount`, `nav_hash_per_nvhash` (share price in HASH at event), `txhash`. No FIFO/average lot-matching is computed in the export.
    - **Validator/operator export (§8.6 `/validators/mine`):** a record of **commission/TIP payment amounts and times** so a participating validator has a complete fact set for their own tax analysis. Proposed columns: `datetime_utc`, `block_height`, `epoch_index`, `payment_type` (commission | tip), `hash_amount`, `txhash`.
    - **Displayed** cost basis / accrued gain (§8.2, §9.5.1) uses **average-cost** (not FIFO): average deposit cost per share × remaining shares; accrued gain = current shares × current NAV − remaining average-cost basis, plus realized gains on completed redemptions. The on-screen figure is labeled as an aid; the raw-event export is the authoritative record.
12. **[DECIDED 2026-07-15, Ira] Time-to-payout display threshold & epoch-metric cold-start.**
    - **Typical time-to-payout (§9.5.3):** show the median/p90 only once the cohort has **≥ 10 terminal (matured/expedited) redemption requests**; below that, the flow shows the **60-day guarantee alone** as the default/fallback. The statistic is physically bounded — a request cannot resolve faster than the ~21-day unbonding period nor slower than the 60-day ceiling — so the displayed "typical" settles into a **21–60-day band**; copy never implies precision or a range outside what the mechanism can deliver.
    - **Epoch-metric cold-start:** metrics that require an epoch step — NAV appreciation, net APR, effective yield, and time-to-payout — display only after **≥ 1 completed epoch**, rendering an explicit "first epoch not yet settled" state before that, never a zero. **Point-in-time facts are not gated** and render from block one: TVL, participant count, program age, and eligible-validator count (the Learn live-proof strip §8.1.2).
    - **Epoch cadence = calendar month, computed from block time (contract behavior, cross-referenced):** epochs align to **calendar-month boundaries derived from block time** (`env.block.time`, the consensus-agreed BFT timestamp — the only valid deterministic clock in the contract; Unix/UTC-based but authoritative by consensus, never a node's wall clock or an external UTC source). This is a *contract* fact, not an App display choice — it retires the `min_run_interval_secs` interval gate in favor of block-time month-rollover eligibility in `liquid-staking-spec.md`. The gate is an eligibility floor, not a trigger: the permissionless crank still ends the epoch, so durations remain variable as they always were; the change makes the earliest-valid boundary calendar-deterministic and caller-independent. **Implemented (E-CAL, 2026-07-22):** the contract-side change shipped — `min_run_interval_secs` is retired and `RunEpoch` is gated on `civil_month(env.block.time) > civil_month(last_run)` (`liquid-staking-spec.md` §9 and §14 item 12; implementation record [`docs/plans/2026-07-22-e-cal-calendar-month-implementation.md`](../plans/2026-07-22-e-cal-calendar-month-implementation.md), delivery ledger `IMPLEMENTATION-STATUS.md` §2). The App's "calendar month" copy now matches the contract.**
13. **[FOLLOW-ON, console] Entity-level deep-link anchors** (request id, valoper, epoch index) so App verify links can land on the exact row, not just the page — a small console addition to schedule with console §14.
14. **[DECIDED 2026-07-15, Ira] Product name & environment exposure; domain still open** (boundary §7.1).
    - **Name:** the product is **nvHASH** (the display brand everywhere), with the formal name **"Liquid Staking HASH Vault"** for titles/meta/first-reference. The prior working title "nvHASH App" is retired.
    - **Domain: still `[DECIDE]`.** Undetermined; the working concept is `nvhash.nuva.finance`. A **separate NUVA integration** will reflect the vault inside `app.nuva.finance` at a **post-launch date (TBD)** — a NUVA-team deliverable that imposes no v1 obligation on this App beyond not precluding it.
    - **Environment exposure:** the **testnet** pilot (§15.10) is **publicly reachable** with the loud env badge (§8.0); **devnet is private** (engineering-only); **mainnet** is the public production surface. The env badge stays quiet on mainnet, loud on testnet.

---

## 15. Build & Verification Plan (when greenlit)

1. **Scaffold** from the nuva reference shape: React Router 7 + TS + Vite + Tailwind 4 + shadcn; `$lang+` routing; Prisma multi-file schema; env config; CI with typecheck, Vitest, Playwright, and the palette validator.
2. **Chain clients + fixtures:** typed LCD client (contract + vault + staking + group), devnet fixture capture for every query/event shape (§14.2), MSW mocks so pages build offline.
3. **Indexer:** checkpointed workers + backfill against the repository's devnet drills (`contracts/drills/p2p-drill.sh` et al. as state generators — the same generators the console plan uses); reconciler + incident derivation; prove idempotent replay.
4. **Public read surfaces:** Learn → Market → Validators → program history, fully anonymous, freshness labels and verify links from the start.
5. **Wallet + sessions:** WalletConnect v2 pairing, nonce-signature sessions, role detection.
6. **Transacting flows on devnet:** Stake, then Redeem + tracker, exercised against full drill cycles including an expedite and an unfunded-maturity refund so every terminal state has been rendered from real chain history, not synthetic data.
7. **Portfolio + alerts + notifier;** CSV export; effective-yield math property-tested against simulated deposit/redeem sequences.
8. **Governance center;** admin analytics; first-party aggregate funnel counters (§14.10 taxonomy).
9. **Hardening pass:** reconciler alarm drills (feed the indexer a wrong row, watch the surface degrade honestly), accessibility walk on both themes, load test the public API.
10. **Testnet pilot** alongside the console (the verify-link contract is only testable with both deployed), then **mainnet** behind the §14 closures and the program's launch checklist.

---

## 16. Stakeholder Personas

> The canonical personas are in [`dashboard-personas.md`](./dashboard-personas.md);
> the App is the primary surface for the consumer side of each (boundary §4). "For / Against" below is
> deliberately honest about what this architecture does and does not give each of them.

### 16.1 Evaluator: "Casey" (primary)
*Deciding whether to trust the program with capital.*

- **For:** a comprehension-first home that answers mechanism, yield source, security, maturity, and exit paths without a wallet; live figures with proof links; an incident/slash history generated from chain data rather than curated; the stepwise-accrual honesty up front rather than discovered later.
- **Against:** some trust content (audit panel) is asserted by the operator, however well-linked — the skeptical tail must still follow the verify links to the Console; DEX depth for the "instant exit" story depends on real pool liquidity the program cannot promise.

### 16.2 Position Holder: "Priya" (primary)
*Managing a live position.*

- **For:** position, accrued gains, and *her own* effective yield against the advertised rate; guided deposit/redeem with the guaranteed-vs-typical framing and a live redemption tracker; durable exportable history; alerts that tell her when something matters instead of requiring vigil.
- **Against:** the 60-day ceiling is unchanged — the App communicates it well but cannot shorten it; DEX exit requires bridging in v1 (§14.4); indexed personal history is trustworthy but its authority is the chain, and on reconciler alarm her history view degrades to live-only until repaired.

### 16.3 Validator: "Owen"
*Reading the economics of participation.*

- **For:** net-benefit-after-fees answered directly with history the console cannot hold; standing and arrears made loud with default-on alerts; peer context; governance votes (if granted) in a workflow, not raw messages.
- **Against:** every chain action still requires the hop to the Console — deliberate, but a two-tool workflow; historical earnings attribution is the indexer's best reconstruction of contract events, labeled but not chain-provable at row level.

### 16.4 Administrator: "Grace"
*Steering the program.*

- **For:** the cohort dashboard that answers "is each cohort satisfied" with real longitudinal data; a computed incident feed with durable history; the full proposal/tally/vote/execute workflow with decoded payloads and an audit trail; and privileged program operations (config/halt/pause via decoded templates) executed **in the App itself** (§14.6), not handed off to the Console.
- **Against:** complaint/support signals are out of scope in v1; analytics quality depends on consented instrumentation she does not control; free-form (non-template) proposal composition still lives in the Console.

### 16.5 Protocol Engineer: "Theo" (secondary by design)

- **For:** the indexed program history and upkeep-lag distributions are genuinely useful telemetry even for him; every material number links back to his surface.
- **Against:** nothing here is provable in the App itself, and that is intentional — his tool is the Console; the App's `meta.source` envelope at least tells him instantly which plane a number came from.

---

## 17. Cross-Persona Review: Points to Consider & Recommended Refinements

### 17.1 Points to consider

- **The App's honesty machinery is its product, exactly as the console's is.** Freshness envelopes, reconciler alarms, guaranteed-vs-typical framing, and market-vs-NAV vocabulary discipline are what let a stateful consumer surface coexist with a zero-trust verifier without corroding it. Treat cuts here as scope cuts to the trust architecture, not polish.
- **The typical-time-to-payout statistic is powerful and dangerous.** It is the single best answer to the program's hardest UX problem (the 60-day headline) and the easiest number to accidentally promote into a promise. The §8.4 layout rule and §14.12 sample threshold exist for that reason; hold the line in review.
- **Cold start is a real state, not an edge case.** At launch there are no epochs, no redemption statistics, no incident history, and thin market samples. Every §9.5 metric specifies its below-threshold rendering; the Learn page must be persuasive on mechanism + posture alone before performance history exists.
- **The two-tool validator workflow is resolved in the App's favor (§14.6 decided).** The prior open question — whether operators would miss obligations because acting required a Console hop — is closed: commission/TIP payment, enroll/unregister, and purge are now first-class App transaction flows. The remaining design discipline is that these privileged writes carry the same preview/decoded-payload/danger-tier rigor as the Console did (§10.2), so graduating them to the consumer surface does not soften the confirmation contract.
- **The indexer is the App's availability soft spot.** Design reviews should keep the property that canonical current values survive an indexer outage (live reads) and only *history* degrades; that property is what makes the indexer an enhancement to trust rather than a dependency of it.

### 17.2 Recommended refinements (high-confidence, material)

- **R1: Ship the reconciler and freshness envelope in the first read-only milestone,** not with the transacting flows — retrofitting honesty machinery after pages exist is how silent-authority drift happens. *Confidence: high.*
- **R2: Default-on alerts for the two moments users feel abandoned** — redemption matured/expedited (holder) and arrears opened (operator) — with in-app delivery guaranteed and external channels additive. *Confidence: high.*
- **R3: Property-test the effective-yield and cost-basis math against the contract simulation suite's deposit/redeem traces** (contract §15.3) so personal-finance numbers inherit the program's verification culture. *Confidence: high.*

### 17.3 Deferred / future enhancements (post-v1)

- **In-app DEX execution and integrated bridge transit** (once §14.3/§14.4 facts and the NUVA transit deliverable land).
- **Commission/TIP payment flows for operators in the App** (per §17.1's measurement).
- **Public program API** (the `/api/v1` surface opened to third parties with keys/quotas) — the indexer already does the work.
- **Historical-NAV smoothing overlays for market analysis** (never for the accrual displays), and richer market analytics (pool fee APR for LPs).
- **Locale expansion** (`zh`, `ko` per nuva precedent) and notification digest modes.
- **Mobile wrapper** if WalletConnect mobile flows prove the demand.

---

## 18. References

- User personas (the design check for this App): [`dashboard-personas.md`](./dashboard-personas.md), especially §5–§8; open trade-offs in the [persona-review action register](../plans/persona-review-action-register.md) — this spec closes or hosts A1, A2, A3, A4, C1, C2, C3, D1, D2, E3, E4, F1.
- Console-vs-App division of responsibility (this spec's charter): [`../architecture/application-boundary.md`](../architecture/application-boundary.md) — §2 boundary rule, §5 trust model, §7 open items resolved here (§3, §12, §14).
- Chain-truth counterpart: [`console-spec.md`](./console-spec.md) (v2.0-RC1) — shared glossary/scales (§2, §13), wallet coordination (§14.1), verify-link target views (§8).
- Governing contract spec: [`liquid-staking-spec.md`](./liquid-staking-spec.md) (v1.0) — §5 accrual model, §8 redemptions, §9.10 snapshot/APR, §10 commission/TIP, §11 interface, §11.5/§12.2 bridge, §13 constraints, §17.1 communication mandates.
- Reference application (stack, layering, indexer precedent): `Labs/nuva-app` — `ARCHITECTURE.md` (three-layer rule), `CLAUDE.md` (conventions, i18n), `package.json` (dependency set), `prisma/` (multi-file schema incl. `indexer-checkpoints`), `app/lib/vault-client.ts` (typed LCD client pattern), `app/app.css` + `app/lib/design-system/tokens.ts` (design tokens).
- As-built contract interface: `contracts/src/msg.rs`, `contracts/src/state.rs`; JSON schema via `cargo schema` in `contracts/schema/`; devnet drills in `contracts/drills/`, dev-node tooling in `infra/devnet/`.
- Dataviz method (chart rules shared with the console): the repository's dataviz skill references and `validate_palette.js`.
- ProvLabs Vault module: https://github.com/ProvLabs/vault · Provenance docs: https://developer.provenance.io/ · Cosmos `x/group`: https://docs.cosmos.network/main/build/modules/group · WalletConnect v2: https://docs.walletconnect.network/ · viem: https://viem.sh/ · React Router: https://reactrouter.com/ · Prisma: https://www.prisma.io/docs

---

*v1.0-RC1, 2026-07-10: initial App specification per the two-application split (`../architecture/application-boundary.md` §7.1). Serves the Evaluator, Position Holder, Validator, and Administrator personas on the engineering team's `nuva-app` reference architecture; the Console remains the Protocol Engineer's chain-truth surface. Certified for implementation 2026-07-13 (revision note at top); unresolved §14 items gate their consuming PRs per the implementation plan.*

*2026-07-14 (ADR-001): §6 and §9.4 amended to the three-component architecture (`services/indexer` / `services/api` / `apps/web`) with role-owned database schemas, in-process scoped-assertion authorization for address-scoped reads, the notifier as an `apps/web` worker, and §14.8 resolved (web-local tokens, shared validation method, root pnpm workspace for shared packages). See `../architecture/2026-07-14-adr-001-app-component-architecture.md`.*

*2026-07-17 (PR 1.4): §14.8 fully closed — the §11 brand pass landed as web-local accent/status tokens in `apps/web/app/theme/tokens.css` (NUVA mint-green primary CTA / focus ring, fixed good/warning/serious/critical status set). Both themes are validated by the shared dataviz method on every token change: `check-palette.mjs` (categorical chart palette) and `test/brand-tokens.test.ts` (accent/status WCAG contrast, via `validate_palette.js`), both standing CI gates. The §11 type stack (Funnel Sans / Space Grotesk / Geist Mono) is not yet self-hosted — deferred to its own change to avoid committing font binaries.*
