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
| `EXPLORER_URL` | block-explorer base URL | Portfolio transaction verify-links (§8.2). **Client-safe** (PR 6.1 allowlist amendment): an explorer URL is public by construction. Optional; absent, history rows render a plain truncated txhash rather than a broken link. |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | — | Web Push VAPID public key (§10.4, §14.7). **Client-safe** (PR 6.3 allowlist amendment): public by construction — it ships in every `pushManager.subscribe`. Optional; the three VAPID vars are **all-or-none** (a partial config fails boot), and absent config renders the honest "not configured" push state. |
| `WEB_PUSH_VAPID_PRIVATE_KEY` / `WEB_PUSH_VAPID_SUBJECT` | — | Web Push VAPID signing key and `sub` contact (`mailto:`/https). **Server-only** — never past the client-safe subset; consumed by the notifier fan-out (PR 6.3). |
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

> **Revision 2026-07-23 (PR 6.1 commit C, `EXPLORER_URL`):** the optional
> `EXPLORER_URL` becomes consumed config, zod-bounded to an http(s) URL at
> load (`apps/web/app/config/config.server.ts`) and **amended into the
> client-safe allowlist** (`apps/web/app/config/client.ts`): a block-explorer
> base URL is public by construction (it is the verify-link target for the §8.2
> Portfolio transaction history). Absent, history rows render a plain truncated
> txhash rather than a broken link. The client-visible addition is a spec-level
> event recorded here in the same change as the allowlist edit, and it stays
> subject to the standing bundle-secret gate (`check:bundle` +
> `test/client-config.test.ts`).

> **Revision 2026-07-24 (PR 6.3 commit A, `WEB_PUSH_VAPID_*`):** the three
> Web Push VAPID vars become consumed config (`apps/web/app/config/config.server.ts`),
> replacing the `[DECIDE §14.7]` placeholder. They are **all-or-none**: a
> deployment sets all three or none, and a partial config fails boot (a
> `superRefine` at the config boundary — SECURITY.md: bound at entry, reject
> never continue). `WEB_PUSH_VAPID_PUBLIC_KEY` is **amended into the client-safe
> allowlist** (`apps/web/app/config/client.ts`): a VAPID public key is public by
> construction — it ships in every `pushManager.subscribe` call, so it must
> cross to the browser to subscribe. `WEB_PUSH_VAPID_PRIVATE_KEY` (the signing
> key) and `WEB_PUSH_VAPID_SUBJECT` (the VAPID `sub` contact) stay **server-only**
> (`scripts/server-only-env.json`); `check:bundle` classifies all three and the
> service worker (`apps/web/public/push-sw.js`) holds no keys. Absent config
> renders the honest "not configured for this environment" push state (devnet
> default) and exposes no subscribe path. The client-visible addition is
> recorded here in the same change as the allowlist edit, and stays under the
> standing bundle-secret gate (`check:bundle` + `test/client-config.test.ts`).

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

> **Revision 2026-07-23 (PR 6.1 commit C, Portfolio page delivered):** built in
> `apps/web` (`app/routes/portfolio.tsx` + `app/portfolio/portfolio.server.ts`
> composing the live and indexed planes, components under
> `app/components/portfolio/`). The acting address is the session address only
> (`getSessionContext`; anonymous renders the connect prompt, never blank,
> never a query-param address; the standing session-scope gate). Delivered
> shape and deliberate honesty states: the **position summary** shows nvHASH
> balance, current value with its plane label (live vs indexed fallback),
> current NAV, signed accrued gain (icon + sign word, never color alone), the
> §14.11 average-cost basis under its "aid, not the authoritative record"
> label, and realized gain; every figure renders "n/a" when null, never 0
> (§12.1). **Value at market price is the §14.4 "coming soon" n/a** (no bridged
> market to price against). The **§2.7 divergence / history-state note** shows
> whenever the live and indexed share balances differ or `history_state !=
> "complete"`, and an `inconsistent` state states the basis-derived figures are
> unavailable rather than fabricating them. The **effective-yield panel** is
> §14.12 cold-gated ("first epoch not yet settled", never a zero) and charts
> the holder's per-settlement APR against the program's net APR (the extended
> StepChart `compare` series) with the systematic-gap explainer inline. The
> **accrual chart** is a step-after series with deposit/redeem markers (filled
> "in", hollow "out": shape, not color alone; the marker data also rides the
> table toggle) and flags a truncated marker set. **Active redemptions** are
> self-contained status rows (icon + label) with **no link to `/exit`** until
> 5.4 ships that tracker (a recorded deferral note stands in); the VM carries
> no maturity estimate yet, so no countdown is fabricated. The **transaction
> history** is a paginated table (time, kind, shares, HASH, NAV at event,
> txhash → explorer when `EXPLORER_URL` is set, else a plain truncated hash)
> with a session-gated **CSV export** (`GET /portfolio/export`, §14.11). When
> the indexed plane is unavailable (no minting key or the API is unreachable)
> the indexed sections degrade to an honest "temporarily unavailable" note
> while the live-plane summary still renders. **Alert settings are a recorded
> 6.2 deferral, not an empty shell.** Gates: `test/portfolio-data.test.ts` +
> `test/portfolio-compose.test.ts` (degradation and composition), the offline
> `e2e/portfolio.spec.ts` (anonymous connect-prompt, no personal data) with
> `/portfolio` in the axe route list (both themes), and the skip-clean
> `e2e-live/portfolio.spec.ts` (authenticated summary + CSV freshness headers).

> **Revision 2026-07-24 (PR 6.2 commit C, alert settings delivered):** the 6.1
> deferral above is closed — the Portfolio page carries an **Alert settings**
> section (`app/components/portfolio/alert-settings.tsx`, id `alert-settings`).
> One toggle per kind in the **closed §8.2 list**; the default-on kinds
> (redemption_update, operator_arrears — §14.7) are annotated "on by default"
> (rendered as ON from the effective-settings merge, **never a fake rule row** —
> absence means default). `operator_arrears` shows only when the live role read
> reports operator (UI convenience; the notifier's server-side operator filter
> is the mechanism). The **market-spread row is absent** (deferred with §14.4),
> not an empty shell. Toggles POST to `/alerts/rules` (a locale-independent,
> session-gated resource route outside `:lang?`, the `portfolio/export`
> precedent); the sibling `/alerts/notifications` serves the log + mark-read.
> The chrome **bell** (`chrome/alerts-bell.tsx`) keeps the anonymous advert
> verbatim (§8.0) and, for a session, renders the bell + unread badge (the count
> rides the root loader — only the integer crosses); opening the popover fetches
> the notifications, and mark-read is an explicit "Mark all read" action (never
> a silent side effect of opening), each item deep-linking to its surface
> (`/portfolio`, `/exit`; validator-set → `/validators` until 6.4 ships
> `/validators/mine`). Gates: `test/alerts-routes.test.ts` (mark-read scoping,
> body/query bounds, unknown kind → 400), `test/session-scope.test.ts`
> (anonymous `/alerts/*` → 401, session-wins), the offline `e2e/alerts.spec.ts`
> (advert unchanged, anonymous 401), and the skip-clean `e2e-live/alerts.spec.ts`
> (authenticated settings CRUD + the section renders). Offline e2e has no
> session, so the authenticated-only settings section is not in the offline axe
> route list (the portfolio precedent) — its accessibility rides the live suite
> and the semantic markup (labeled checkboxes, headings, aria-describedby).

### 8.3 Stake (route `/stake`, wallet required to submit)

The guided `SwapIn` flow (§10.3 for the transaction mechanics):

- **Educate inline:** one screen states what will happen — HASH transfers into the vault, nvHASH mints at the current rate, value accrues at monthly epochs, exit paths exist — with the *next expected epoch step* date (the first of the calendar month after `EpochStatus.last_run` — the §14.12 calendar cadence; the contract's `RunEpoch` `too soon` error reports the same next-eligible instant).
- **Amount entry** with wallet balance, vault min/max limits (vault config), and a live preview: expected nvHASH out at current NAV `[VERIFY §14.2: estimate query]`, plus the plain sentence "your nvHASH amount stays fixed; its redemption value grows."
- **Vesting-HASH honesty:** unvested HASH cannot be deposited (contract §13); if the connected account holds locked HASH the flow says so rather than letting the transaction fail cryptically.
- **Preview → sign → track** per §10.2, then land on Portfolio with the new position and a first-timer explainer of the accrual model.

> **Revision 2026-07-24 (PR 5.3, delivered):** `/stake` (`app/routes/stake.tsx`)
> is the guided SwapIn on the 5.2 lifecycle. Inline education states the four
> facts plus the **next-epoch date** — the first of the civil month after
> `EpochStatus.lastRunSeconds` (`nextEpochIso`, E-CAL cadence). Amount entry
> parses a decimal HASH string to base units at the boundary
> (`app/lib/amount.ts`, reject-never-clamp, no floats — `test/amount.test.ts`),
> shows spendable balance and vault min/max, and previews expected nvHASH via
> **`previewSharesOut`** (the vault's floor share-math from the live NAV pair;
> `estimate_swap_in` is gRPC-only, §14.2) **labeled an execution-time-rate
> estimate** (§10.3) — cross-checked against the real mint by the e2e-live
> stake drill (`e2e-live/stake.spec.ts`). Preflight reasons (paused, disabled,
> min/max, balance-incl-fee, vesting-lock) render as localized copy
> (`app/tx/reasons.ts`); the confirm step reuses the 5.2 exact-JSON disclosure;
> the flow is driven by `useTxFlow` (`app/tx/use-tx-flow.ts`). The wallet
> provider now surfaces `signDirect`/`pubkeyBase64`/`canSign` to pages and a
> `ReconnectToSignError` for the post-reload adapter-gone case. **Land-on-
> Portfolio** is a minimal live position strip (nvHASH balance + HASH value at
> NAV) on the `/portfolio` stub; the full §8.2 page remains M6.1. Gates:
> `test/amount.test.ts`, `test/stake-preview.test.ts`, `test/stake-data.test.ts`,
> `e2e/stake.spec.ts` (+ axe both themes), `e2e-live/stake.spec.ts`.

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

> **Revision 2026-07-24 (PR 5.4, delivered):** `/exit` (`app/routes/exit.tsx`)
> opens with the comparison table (`app/components/exit/comparison-table.tsx`),
> not a form. The **guaranteed-vs-typical framing is enforced**: the 60-day
> ceiling occupies the promise position unqualified; the typical median/p90 is
> shown only when the new endpoint reports it (below), always labeled "typical,
> not guaranteed" — `test/exit-typical.test.ts` + `e2e/exit.spec.ts` pin that
> the typical never fills the guarantee slot and that cold-start renders the
> guarantee alone. The DEX column is a static labeled "coming soon" shell
> (§14.4). The native flow reuses the 5.2 lifecycle (`useTxFlow`) with a
> **warning-tier** confirm restating the three §10.3 timing facts in fixed
> order (escrow-now, guaranteed-ceiling, refund-not-loss); the payout preview
> is NAV-math redemption value labeled "re-prices at payout" (§8.4). The
> **redemption tracker** (`app/components/exit/redemption-tracker.tsx`)
> composes three reads through web-tier loaders — live `pendingSwapOuts`
> (queue position + refund-moment countdown), `/portfolio` active redemptions,
> and `/transactions` `redemption_payout`/`redemption_refund` terminal legs —
> so direct-vault redemptions appear. Gates: `test/exit-data.test.ts`,
> `e2e-live/redeem.spec.ts` (terminal states from drill history). The
> default-on matured/expedited alert subscription is deferred to M6.2 (the
> tracker records the hook site).

> **Revision 2026-07-24 (PR 6.2 commit C, the §8.4 hook resolves to copy):**
> under absence-means-default (§9.1) the "subscribes by default" behavior needs
> **no write at SwapOut time** — the owner is covered the moment the redemption
> exists (a `redemption_update` alert has no rule row to create; it is on by
> default, §14.7). The recorded hook site is closed as a single sentence in the
> redemption tracker ("You'll be alerted here and in the bell when this matures
> or is expedited — manage in alert settings") linking to the Portfolio
> `#alert-settings` section. Payout-timing copy in the redemption notifications
> and the settings descriptions keeps the §14.12 guarantee-first framing: the
> 60-day guarantee is the promise position, "typical" language never a promise.

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

> **Revision 2026-07-27 (PR 6.4 commit C, the read view delivered):**
> `/validators/mine` ships (`app/routes/validators-mine.tsx` under `:lang?`,
> registered after `validators`; loader `app/validators/mine.server.ts`; the CSV
> proxy `/operator/export` outside `:lang?`, the `portfolio/export` precedent).
> Delivered shape, with three corrections to what this bullet assumed:
>
> **(1) Commission standing has THREE states, not two.** Verified against
> `contracts/src/validators.rs`: `epoch_rollover` resets the per-epoch TIP and
> advances the grace boundary, but NEVER resets `commission_paid` — program
> commission is cumulative, so an overpayment carries forward against future
> accrual indefinitely, while an over-TIP buys priority in the current epoch
> only and is then gone. The banner therefore renders *in arrears* (serious
> tier), *current*, or **prepaid by N**. The prepaid credit is read from the
> LIVE plane as `commission_paid − commission_accrued` and can only be: the
> `pay_commission` event's `outstanding` attribute is
> `accrued.saturating_sub(paid)`, so an overpayment reports 0 there, never a
> negative — anything derived from the payment history would call a prepaid
> validator merely "current".
>
> **(2) Net-benefit's earnings term is an ESTIMATE and is labeled in place**
> (§7 Q2, DECIDED 2026-07-27), not only in a footnote: the program's own
> realized per-epoch return is applied to this validator's delegation over each
> epoch and multiplied by the validator's CURRENT x/staking commission rate.
> The actual reward stream is not indexed and historical rate changes are not
> either; a negative program APR (a slash epoch) floors to zero rather than
> being subtracted, since the program losing value does not make a validator's
> staking commission negative. The two paid terms are exact. When the estimate
> cannot be computed the **net is withheld too** — a net built from a missing
> term is the fabrication an operator would act on.
>
> **(3) Peer-rank context is NOT delivered** (§7 Q5 unapproved, 2026-07-27):
> this bullet's "peer-rank context" is deferred, and the public `/validators`
> page remains where the set is seen. Everything else in the bullet ships:
> current + historical program delegation (a step-after `StepChart` with its
> table view — one series deliberately, since commission is orders of magnitude
> smaller and a second axis is never the answer), commission/TIP figures,
> eligibility headroom per threshold, the per-epoch history, the payment
> history with its §14.11 CSV export, and Console verify links on the standing
> block.
>
> Honesty states, gated by `test/operator-data.test.ts`: anonymous → connect
> prompt; roles `degraded: true` → an explicit "we could not check" note (never
> a privileged surface from a failed read); connected non-operator → the plain
> statement plus the enrollment path; live reads down → the indexed history with
> **null** standing, never a guessed "current"; indexed reads down → live
> standing alone. Every figure is "n/a" when null, never 0. A payment whose
> crediting epoch is still open renders "pending", never the latest epoch. The
> payment table labels a payer that is not the operator's own account, because
> payment is permissionless and a co-op partner paying is a normal fact.

### 8.7 Governance (route `/governance`, public read; member write)

The rich `x/group` workflow the boundary doc assigns to the App (boundary §3 governance split; the App is the primary home — §14.6 decided):

- **Proposal list & detail:** live + indexed proposals for the program's group policies — decoded messages (human-readable summary above the exact JSON), proposer, submitted/expiry times, tally vs threshold, per-member vote status (who, how, when), and outcome history (durable, indexed — the audit trail personas §8 requires).
- **Member actions:** cast vote and execute-when-passed, signed by the connected wallet (`MsgVote`, `MsgExec` on `cosmos.group.v1`), with the §10.2 preview/sign/track lifecycle and the decoded payload shown before signing (Grace's "what exactly does this do" question).
- **Proposal creation:** v1 scopes composition to **selecting from decoded templates of the program's admin actions** (config change with a diff view, halt/resume, pause/unpause, bridge config) rather than free-form message building — free-form compose stays a Console strength (§14.6 decided: template-scoped creation ships in v1).
- **Validator votes:** if register B2 resolves toward validator-elected admins, the voting surface is this page; the spec takes no position on B2 itself.

> **Revision 2026-07-30 (PR 7.2 delivered): the read surface, and the four
> places it refuses to guess.**
>
> `/governance` (list) and `/governance/:proposalId` (detail) ship as a **public
> read**. No signing path is added: `ALLOWED_MSG_TYPE_URLS` is unchanged and a
> governance message is still provably rejected by the relay's rejection matrix.
> Voting, execution and proposal creation are 7.3–7.4.
>
> **The division of planes is the design.** An OPEN proposal's status and tally
> are read live from `x/group` and are canonical (§12.1.1); anything CLOSED is
> served from the mirror, because a successfully executed proposal is pruned in
> its own transaction and the chain holds nothing. Four consequences are pinned
> here because each is a place a later change would plausibly get it wrong:
>
> - **A proposal's `final_tally_result` is ZEROS until the module tallies.** So
>   the state read cannot report where an open proposal stands, and the live
>   tally comes from x/group's own `TallyResult` query
>   (`GroupClient.tallyResult`). Rendering the state read's zeros would assert
>   that nobody has voted. When that read fails, the page falls back to the
>   mirror **with the height it was observed at**, never silently.
> - **A live read failure is never evidence of a prune.** The LCD answers a
>   missing proposal with HTTP 500 and a body identical for a pruned id, an id
>   that never existed, and an outage. `pruned_at_height` from the mirror is the
>   only source of "the chain no longer holds this", and a pruned proposal is
>   never live-read at all.
> - **Membership drift is stated.** A proposal whose `group_version` differs from
>   the group's current version was decided by a different electorate, so the
>   page shows recorded votes only plus an explicit note — and it uses the
>   `decision_policy` snapshotted at submit, never the live policy. The rule
>   holds for open proposals too: the 2026-07-29 drill measured that a mid-vote
>   members change does not abort an open proposal on this build.
> - **Decoded summaries come from a CLOSED union or say they do not.**
>   `MsgSend` (corpus-pinned) and `MsgExecuteContract` against the configured
>   program contract (pinned to `contracts/src/msg.rs`, with the variant
>   vocabulary imported from `app/tx/build.ts` so this reader and 7.4's composer
>   cannot diverge). Everything else — including a call to any other contract and
>   every x/group message — renders as "unrecognized" plus the exact payload,
>   which is shown for **every** message either way (D6).
>
> **Two live-plane failures are different answers**, and the page says which: a
> program admin that is not a group-policy account ("this deployment has no group
> behind it") versus a chain read that failed ("we could not check"). Only an
> LCD 404 decides the first; everything else is the second.
>
> Policy discovery is **set-valued** (D1) and paginated to exhaustion under a
> page cap; the live tally reads a list render makes are capped, with any
> proposal past the cap rendering on the mirror with its stale badge rather than
> on a different, quieter degradation.
>
> **No `governance` verify-link target** (D8, §12.2): the console has no
> governance panel, and a pruned proposal has nothing on chain left to link to.
>
> Standing gates added: `apps/web/test/governance-decode.test.ts` (golden
> summaries per variant, totality over the shared vocabulary, unknown/malformed
> arms), `governance-tally.test.ts`, `governance-data.test.ts` (the plane
> precedence matrix incl. the stale-but-successful cells), `governance-compose.test.ts`,
> offline `e2e/governance.spec.ts`, skip-clean `e2e-live/governance.spec.ts`, and
> both governance routes in the axe route list.

> **Revision 2026-07-30 (PRs 7.3–7.4 delivered): the write path — vote, execute,
> and template-scoped creation.**
>
> The three member actions above ship through the **unmodified** §10.2
> lifecycle. The relay amendment that carries them is recorded in §12.3 and is
> the whole of what makes them safe; this note records what the SURFACE does.
>
> **Which control appears is decided from the LIVE plane alone**, in the loader,
> as a value with a reason — never as a condition in JSX. `plane` (which read
> produced the figures) and the affordance plane (did the chain, just now,
> confirm the state we are about to act on) are **separate fields**, because for
> a closed proposal the honest display plane is the mirror while no action may
> be offered from it. A stale "accepted" that has since been executed would
> otherwise offer an execute button that always fails. When the live read is
> down, actions are **hidden with the reason stated**, never rendered
> optimistically. To make that possible, accepted-and-not-yet-executed proposals
> are now live-read as well as open ones.
>
> **Every hidden control says why**, and the one state that is *disabled* rather
> than hidden is the pending execution window — the user needs to know it is
> coming, with the eligible-at time, computed from `submit_time +
> min_execution_period` as x/group's own `Exec` computes it. A waiting period
> this build cannot parse leaves the control disabled with "we cannot say when",
> never offered — **as does a window that could not be resolved at all**. A
> policy with no waiting period serializes `"0s"`, so an absent value means
> "undetermined", never "none", and the App does not offer a privileged action
> on a window it could not read.
>
> **That period is read from the LIVE policy, and the UI and the preflight read
> it the same way** (corrected 2026-07-30 after a PR-review finding that they
> did not). The chain's `Proposal` carries **no decision policy**, so at
> execution time x/group has only the policy account to read it from — as it
> stands then, not as it stood at submit. **Note the asymmetry:**
> `voting_period_end` IS snapshotted on the proposal as an absolute instant,
> while the execution window is not, so neither "snapshot for both" nor "live
> for both" is correct. The §9.1 `decision_policy` snapshot exists to keep a
> historical proposal's THRESHOLD renderable once the live policy moves; it is
> never the source of the execution window.
>
> **Voting is member-only; execution is permissionless** (x/group's rule once a
> proposal has passed), and the page says so plainly rather than implying a
> permission the module does not enforce. A member who has already voted is told
> so: the 2026-07-29 drill measured that x/group records one vote per member and
> refuses a change.
>
> **Creation is template-scoped, and the templates are total against the
> contract**: one per admin-gated `ExecuteMsg` variant, each parameter bounded by
> the bound `Config::validate` enforces, **reject-never-clamp** on every numeric
> entry. This is a **composer** property — what the App offers to build, per this
> section's own "rather than free-form message building" — and NOT a relay
> restriction; the §12.3 correction of the same date explains why the guard does
> not enforce it. `UpdateConfig` gets the **diff view** this section names: all ten fields
> on every render, current → proposed, untouched fields visibly untouched, and a
> third state distinguishing "not supplied" from "supplied as the current value"
> — different messages on the wire even though the contract's merge makes them
> equivalent. A current value that could not be read renders as "could not be
> read", never `0`. **Bridge config has no template and is absent, not stubbed**
> (§14.3 unresolved; an absent template is honest, a disabled one invites
> "when").
>
> **The composer, the guard and 7.2's reader share ONE vocabulary.** A proposal
> built here and read back on its own detail page yields the same summary, gated
> by a round-trip case rather than by two tables that happen to agree.
>
> **Confirmation rigor** (§17.1): `MsgExec` discloses **what the proposal will
> execute**, message by message, not "execute proposal 12" — and a message this
> build cannot summarize is named as such rather than dropped from the list.
> Submission is framed accurately: proposing is not itself the dangerous act,
> passage and execution are, and the confirmation says so without using that
> framing to soften the disclosure. It also states that submission is **not
> idempotent** — signing twice creates two proposals — and re-submit is disabled
> after broadcast.
>
> Standing gates added: `apps/web/test/governance-templates.test.ts` (the
> both-directions totality against the committed `cargo schema` output, bounds,
> canonical output, and the compose↔decode round trip),
> `governance-flows.test.ts` (one case per state×affordance row plus the
> live-down cells), the governance blocks in `broadcast-guard.test.ts`,
> `tx-preflight.test.ts` and `tx-confirm.test.ts`, `/governance/new` in the axe
> route list, and skip-clean `e2e-live/governance-write.spec.ts`.

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

> **Revision 2026-07-24 (PR 6.2 commit B, the `app`-schema alert domain):**
> three tables land in the `app` schema (allowlist gate extended in the same
> change): **`alert_rules`** (`address, kind, enabled, createdAt, updatedAt`;
> PK `(address, kind)`), **`notifications`** (`id, address, kind, dedupeKey,
> payload, deliveredAt, readAt`), **`notifier_checkpoints`** (`stream, cursor,
> updatedAt`). Recorded decisions: (a) **`alert_rules` is preference
> OVERRIDES, not subscription rows** — absence-means-default (ON for the §14.7
> R2 set `{redemption_update, operator_arrears}`, OFF for the rest); a row is
> only ever an explicit opt-out (`enabled=false`) or opt-in (`enabled=true`),
> so a user who never touches settings has zero rows. **No params column** (the
> only parameterized kind, market-spread, is deferred with §14.4). (b)
> **`notifications` has NO `channel` column** — a deviation from this section's
> parenthetical `(rule; address; channel; payload; delivered_at; read_at)`:
> in-app is the always-on channel, so the row's creation IS the in-app delivery
> and `deliveredAt` records it; channel-specific state belongs to the channel
> that needs it (6.3 push keys off `notifications.id` with its own bookkeeping).
> `kind` is NOT a rule FK (default-on kinds have no rule row). The
> **`@@unique([address, kind, dedupeKey])`** is the exactly-once mechanism
> (§10.4). Payloads are closed per-kind zod shapes of identifiers/ordinals only
> — **never amounts** (a stored amount goes stale, §12.1). (c)
> **`notifier_checkpoints`** cursors are efficiency, not correctness (the
> unique constraint is): a stale/garbage cursor merely re-scans and the
> duplicates are absorbed.

> **Revision 2026-07-24 (PR 6.3 commit A/B, `push_subscriptions`):** a fourth
> `app`-schema table lands (allowlist gate extended in the same change):
> **`push_subscriptions`** (`id, address, sessionId, endpoint, p256dh, auth,
> createdAt`) — the ONE accepted SECURITY.md exception (opt-in, opaque,
> revocable Web Push tokens). The row is exactly the W3C
> `PushSubscription.toJSON()` triple (`endpoint`/`p256dh`/`auth` — opaque
> material the App derives nothing from and never logs) plus the recipient
> `address` (public), the creating `sessionId` (the deletion-chain key), and
> `createdAt` (minimal operational metadata; the per-address cap evicts
> oldest-first by insertion order). Nothing identity-, device-, or
> counter-shaped joins it. It is created ONLY on explicit opt-in and deleted on
> opt-out, logout, session expiry/removal (the deletion chain), and dead-endpoint
> (404/410) pruning; `endpoint` is `@unique` so a re-subscription replaces rather
> than accumulates, and a per-address cap bounds it. Confirming §9.1's earlier
> "with Web Push subscriptions" parenthetical, now delivered.

> **Revision 2026-07-27 (PR 6.4 commit A, `operator_payments`):** a thirteenth
> `indexed` table lands (allowlist gate extended in the same change):
> **`operator_payments`** (`txhash, msgIndex, ordinal, valoper, payer,
> paymentType, amount, epochIndex, height, occurredAt`; PK
> `(txhash, msgIndex, ordinal)`; index `(valoper, height, msgIndex, ordinal)`).
> `ordinal` is the payment's position within its `(txhash, msgIndex)` — 0 for
> the ordinary one-payment message, non-zero only when a caller batches several
> payments into one message, which is lawful because paying is permissionless.
> It is part of the natural key: without it batched siblings upsert onto the
> same row and all but the last are silently lost. It is also the export's
> sort-key tie-break, so it rides the index (the §14.11 CSV walks the history by
> keyset, and a range bound only enters the index condition when every sort
> column is present). It exists because the §14.11 operator CSV's rows are
> per-**payment** while `validator_epochs` holds only per-epoch cumulative
> totals with no txhash — the facts do not exist anywhere else. Every column is
> read straight off a public tx; `payer` is the message sender (a bech32
> account, already public in the tx body), which the permissionless
> "anyone may pay" design makes materially different from the valoper and worth
> keeping for the operator's own audit (decided, Ira 2026-07-27). **`epochIndex`
> is nullable and NOT written at ingest:** the epoch a payment credits closes at
> a later `run_epoch` crank, so deriving it in the worker would mean reading the
> epoch-history worker's table and making replay order-sensitive; `services/api`
> derives the CSV column by joining `epoch_snapshots` at read time (§9.4). The
> column stays so a later indexer-side derivation has somewhere to land.

> **Forward note 2026-07-28 (M7 planning; the migration lands with PR 7.1
> commit B): `gov_proposals`/`gov_votes` gain columns, and the addition is
> approved in advance as a design-review event.** Both tables have existed
> since the init migration and nothing has ever written them; standing up the
> `x/group` mirror shows the original nine and six columns cannot express what
> §8.7 requires. Recorded here so the migration executes an approved change
> rather than proposing one — the `test/security/allowed-fields.ts` edit is
> still what gates it.
>
> `gov_proposals` adds: `groupId`; `proposers String[]` **replacing**
> `proposer` (x/group permits several, and one column is a lie when there are
> two); `votingPeriodEnd` (the §8.7 countdown, and the only thing that explains
> a status change arriving with no transaction); the four tally counts
> `yesCount`/`noCount`/`abstainCount`/`noWithVetoCount` as `Decimal(39,0)`
> (weights are unbounded integers, so they join `AMOUNT_FIELDS`);
> `executorResult` (`NOT_RUN|SUCCESS|FAILURE` — "passed but execution failed"
> is invisible in `status`); `groupVersion`/`groupPolicyVersion` (x/group ABORTs
> a proposal when the group or policy changes, and without these the UI can
> assert an abort but not explain it); `decisionPolicy Json`, the threshold **in
> force at submit**, since the live policy can change and a historical
> tally-vs-threshold is otherwise unrenderable; `observedHeight`/`observedAt`,
> the AS-OF of the mirrored status and tally (the §12.1 freshness fact and the
> replay-monotonicity key — `height`/`txhash` keep their existing meaning of
> *submit* provenance); and `prunedAtHeight`.
>
> `gov_votes` adds `weight Decimal(39,0)?` (the voter's weight at the vote
> height; membership rotates, so a stored tally line is otherwise
> unexplainable — null means "not recoverable", never 0) and `metadata String?`
> (a public chain field, symmetric with `GovProposal.metadata`), and **widens
> `height`/`txhash` to nullable**, because a vote recovered from state has no
> transaction provenance and null is honest where a fabricated height is not.
>
> `prunedAtHeight` is the column worth understanding: `x/group` **prunes**
> rejected, aborted and executed proposals out of chain state, so the mirror
> routinely outlives the thing it mirrors. A 404 on re-read therefore
> **preserves** the stored row and stamps this column — never deletes, never
> nulls — and the read surfaces say the chain no longer holds it rather than
> offering a verify path that resolves to nothing (§12.2 revision). Every
> column above is public chain data; none is identity-, device- or IP-shaped.

> **Revision 2026-07-29 (PR 7.1 commit B): the forward note above is CORRECTED
> in three places by what the devnet actually does.** The columns it approved are
> unchanged and are delivered as written; what it got wrong is the mechanism, and
> the corrections are recorded here rather than left as a discrepancy between
> spec and code. All three were measured by `contracts/drills/gov-drill.sh` and
> are pinned in `packages/fixtures/fixtures/manifest.json`.
>
> 1. **"A 404 on re-read" — there is no 404.** The LCD answers a missing proposal
>    with **HTTP 500**, and the body is byte-identical for a proposal that was
>    pruned and one that never existed. An LCD outage and a wrong height pin
>    answer 500 as well. So a failed read can **never** justify stamping
>    `prunedAtHeight`: doing so would durably assert "the chain discarded this"
>    about live governance. Prune is established only by **absence from a
>    successful paginated policy sweep**, or by an observed
>    `EventProposalPruned`. The row-preserving, never-deleting behavior the note
>    describes is unchanged and correct.
> 2. **A successfully executed proposal is pruned in its OWN transaction**, so
>    `status = ACCEPTED` with `executorResult = SUCCESS` is a pair **no state
>    read can ever return**. `executorResult` therefore earns its place more
>    strongly than the note argued: it is not merely invisible in `status`, it is
>    unobtainable except from `EventExec.result` plus `EventProposalPruned`, which
>    carries the terminal status and the full tally.
> 3. **`gov_votes` is load-bearing for a reason the note did not state:** the
>    module **deletes a proposal's votes at its voting-period-end tally**, even
>    when the proposal passes, keeping only `final_tally_result`. Per-voter
>    history for any closed proposal exists solely in transaction history, so an
>    empty vote read must never delete stored rows. Two column consequences:
>    `GovVote.weight` is nullable because the module's `Vote` payload carries **no
>    weight field** at all (it must come from `group_members` at the vote height),
>    and `GovProposal.height`/`txhash` widen to **nullable** alongside
>    `GovVote`'s — a proposal first seen by the sweep has no submit transaction to
>    point at, and null is honest where a fabricated height is not.
>
> Two columns join the approved set: **`title` and `summary`** (SDK ≥ 0.50
> proposal fields, added by direction — Ira, 2026-07-29). They are public,
> author-supplied chain text and the only human-readable label a proposal has;
> for a pruned proposal that label exists nowhere else, so omitting them would
> make closed history unreadable. `proposer` is **removed** in favour of
> `proposers`, as the note specified.

### 9.2 Indexer workers

- **Transport:** dual-source per the §14.5 resolution (RESOLVED 2026-07-20, PR 2.1) — tx-search by height range for DeliverTx events, and `block_results` per height for EndBlocker payout/refund + the NAV marker (which never appear in tx-search, §14.2); paging to exhaustion per block window; RPC websocket subscription is a latency optimization, not a correctness dependency.
- **Idempotency:** all writes are upserts keyed by (txhash, event index) or natural keys; a worker can be restarted or re-pointed at height 0 and converge to the same state.
- **Ordering & finality:** workers trail the head by a small confirmation depth (~block-time-safe; Provenance ~5 s blocks, instant finality — **depth 0**, RESOLVED §14.5, PR 2.1); the cursor advances only after the full block window commits in one DB transaction.
- **Event shapes are contract-verified fixtures:** every event the indexer decodes (`RunEpoch` snapshot attributes, vault swap events, expedite events) is captured from devnet drills into MSW/unit fixtures, so a contract event change breaks tests, not production `[VERIFY §14.2]`.
- **Lag accounting:** each stream exposes `indexed_height` vs `chain_height`; the max lag drives the footer freshness line and the DATA DEGRADED banner threshold.

> **Revision 2026-07-27 (PR 6.4 commit A, operator-payment decode):** the
> chain-events worker gains a third decode provenance on the tx-search plane —
> the program **contract's own `wasm` events** for `PayCommission`/`PayTip`,
> scoped by the `_contract_address` attribute (the `wasm` type is shared by
> every CosmWasm contract on chain, so that attribute is the only thing that
> makes an event ours). Two verified facts (`[VERIFY §14.2]` Q1 resolved by
> devnet drill 2026-07-27, captured in `@nvhash/fixtures/operator/`):
> **(1)** contract `wasm` attribute values arrive **bare**, not JSON-quoted like
> the vault module's — `dequote` tolerates both, so the decode path is
> unchanged; **(2)** `pay_commission` emits the per-payment `amount`, but
> `pay_tip` emits only the epoch-**cumulative** `tip_epoch`, so a tip payment's
> own nhash is not in the contract's event at all. A payment's amount and payer
> are therefore decoded from the **pair**: the wasm event plus the bank
> `transfer` at the same `msg_index` whose recipient is the contract — the
> msg's attached funds, which `cw_utils::must_pay` bounds to exactly one coin in
> the underlying denom. This is the only pair decoder in the worker. Chain input
> stays untrusted: a missing, duplicated, or multi-coin funds transfer, or a
> `pay_commission` whose declared `amount` disagrees with the funds moved,
> raises `DecodeError` rather than storing a guess.

> **Revision 2026-07-29 (PR 7.1 commit B, the `governance` worker):** a fourth
> stream joins §9.2, and it is the first one whose AUTHORITY is a height-pinned
> state read rather than an event. Three planes, because `x/group` splits its
> truth across them and no two are substitutable:
>
> - **tx-search** — submit provenance, per-voter votes, and the terminal outcomes
>   the chain does not keep. `EventVote` carries only `proposal_id` and
>   `msg_index`, so voter and option come from the **`MsgVote` body** paired by
>   `msg_index` — never positionally and never by txhash, since one transaction may
>   legally carry several votes for different proposals.
> - **`block_results`** — `EventProposalPruned` and nothing else. It is the ONLY
>   x/group EndBlocker event on the drilled build (295 heights scanned), so
>   voting-period-end transitions are **eventless**.
> - **height-pinned reads** — authority for the status and tally of everything the
>   chain still holds, and consequently the only observer of that eventless
>   transition: a sweep returning REJECTED where the previous sweep returned
>   SUBMITTED is the sole evidence it happened.
>
> **Idempotency here is a property of the SQL, not of the reducer.** Unlike the
> other workers' natural-key upserts, this one carries a monotonic guard — a
> window observing height H must not overwrite a row observed at H′ > H — and it
> is written as `INSERT … ON CONFLICT DO UPDATE … WHERE observedHeight <
> EXCLUDED.observedHeight` rather than a read-compare-write, so convergence holds
> with a backfill running beside the live worker. Pagination follows to exhaustion
> and **fails the window at its page cap** instead of truncating: a short sweep is
> indistinguishable from a prune, and the write path treats absence from a
> successful sweep as evidence the chain dropped a proposal, so truncation would
> mark live proposals pruned. An empty policy set (a plain-account `Config.admin`)
> commits empty windows and concludes nothing absent — the honest no-governance
> state.
>
> **Lag accounting** picks the stream up automatically; a chain with no `x/group`
> substrate reports a caught-up `governance` cursor over an empty mirror, which is
> correct rather than degraded.

### 9.3 Backfill

On first deployment (and after any reset) the epoch-history and chain-events workers walk from the contract's instantiation height to the head. Devnet redeploys reset the database with the environment — histories never mix across (chain_id, contract) pairs, the same isolation rule as the console's ledger keying (console §9.3), enforced as a fail-closed boot check (PR 2.0, `services/indexer/src/runtime/streams.ts`).

**Epoch-history backfill mechanism (PR 2.2):** the contract retains only the *latest* epoch snapshot on chain (§13, contract §9.10), so history is recovered by a **height-pinned smart query at each `run_epoch` crank height** — querying `epoch_snapshot`/`apr` with `x-cosmos-block-height: H` returns the epoch that closed at H. Cranks are located by tx-search (`wasm action=run_epoch`); rows upsert by `epoch_index`, so replay from genesis and resume from a checkpoint converge to the same `epoch_snapshots`. **Retention caveat (documented, not silent):** height-pinned queries work for any past height on a full-state node; a node that has *pruned* state below a crank height cannot serve that epoch — a config/retention limit, surfaced rather than hidden.

### 9.4 API surface

Versioned JSON under `/api/v1/`, split across the two serving processes per ADR-001 (amended 2026-07-14; previously the nuva `api+/v1+` single-process convention):

- **`services/api`** serves everything derived from indexed data: public program endpoints (`/metrics`, `/epochs`, `/validators`, `/market`, `/incidents`, `/redemptions/stats` — unauthenticated, read-only, rate-limited; `/redemptions/stats` is the §9.5.3 typical time-to-payout, aggregate over all owners so it carries no PII, added PR 5.4), address-scoped endpoints (`/portfolio`, `/transactions?format=csv`), and admin analytics endpoints. Address-scoped and admin endpoints are authorized **in-process** by a short-lived scoped service assertion minted by the web tier's session layer (HMAC, `exp − iat ≤ 60 s`, key `API_SERVICE_ASSERTION_KEY` from environment): an `address:<bech32>` scope must match the requested address exactly or the request is rejected (403; absent/expired/invalid → 401). This is an enforced mechanism, never a caller-topology assumption — the cross-address-rejection contract tests gate `services/api` CI (ADR-001 Decision 2, §12.3). A read-only `internal:notifier`-scoped surface serves the notifier's cross-address evaluation reads and grants nothing else.
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

> **Revision 2026-07-23 (PR 6.1 commit B, derived portfolio metrics +
> CSV completeness):** `/api/v1/portfolio/metrics?address=` is live: a third
> address-scoped route (`auth: "address"`, enveloped, `?address=` bounded by
> the same bech32 schema) that serves the frozen `PortfolioMetrics` shape from
> `@nvhash/api-types` (cost basis, realized gain, effective yield, the
> per-epoch personal-vs-program series, and the accrual series) produced by
> the pure `derivePortfolioMetrics` fold (§9.5 items 1-2) over the address's
> full indexed history plus the epoch step series. It joins `/portfolio` and
> `/transactions` in the cross-address-rejection `PERSONAL_PATHS` (the standing
> CI gate holds it too). CSV amendment (§14.11): `/transactions?format=csv`
> now serves the COMPLETE indexed history ascending by `(height, msg_index)`,
> superseding the paginated slice recorded by PR 3.3 (a holder's export must
> never silently drop older events; `limit`/`offset` bound only the JSON
> view). The pinned columns, formula-injection guard, and the
> `X-Chain-Height` / `X-Indexed-Height` / `X-Generated-At` freshness headers
> are unchanged.

> **Revision 2026-07-24 (PR 6.2 commit A, internal alert-facts surface):** the
> `internal:notifier` scope (ADR-001 Decisions 2/3), scaffolded-but-dead since
> PR 3.3, is now **live** — the notifier's cross-address evaluation reads
> (ADR-001 checklist item 6). Three new `GET`, `auth: "internal:notifier"`,
> enveloped, zod-bounded routes under `services/api`, each auto-joined to the
> envelope/read-only/query-bounds/rate-limit harnesses by registry membership:
> - `/api/v1/internal/alert-facts/redemptions?since_height=&after_id=&limit=`
>   (`since_height` int ≥ 0 default 0; `after_id` string ≤ 128 default "" — the
>   requestId tie-break of a compound keyset cursor, so a same-height burst
>   larger than one page, e.g. mass maturation at an epoch settlement, pages
>   through completely; `limit` 1–500 default 200): redemptions with
>   `(lastHeight, requestId) > (since_height, after_id)`, ascending by
>   `(lastHeight, requestId)` —
>   `{ request_id, owner, status, enqueued_at, expedited_at, matured_at,
>   refunded_at, last_height }`. **No amount field** (the notifier stores none,
>   §10.4). Owner-keyed transitions have no public surface, so this is not
>   redundant with `/redemptions/stats` (aggregate) or `/portfolio`
>   (address-scoped).
> - `/api/v1/internal/alert-facts/incidents?since_id=&limit=` (same bounds):
>   incidents with `id > since_id`, ascending by id —
>   `{ id, kind, severity, dedupe_key, opened_at, opened_height }`. **No
>   payload passthrough** (identity, not detail): the notifier keys its
>   replay-stable dedupe on `(kind, dedupe_key)`, never the autoincrement id.
>   Public `/incidents` omits the dedupe identity, so this surface is distinct.
> - `/api/v1/internal/alert-facts/arrears` (no query): validators with
>   commission due in the latest sampled epoch, joined to their operator —
>   `{ valoper, operator, epoch_index, commission_due }` — active registry rows
>   only (unregistered excluded). Operator economics are excluded from public
>   `/validators`, so this surface is distinct.
>
> Mechanism, not topology: the handler pipeline enforces the registry `auth`
> declaration (401 without a valid assertion; 403 for an `address:` scope on an
> internal path; `internal:notifier` never grants a personal endpoint), gated
> by the registry-derived `INTERNAL_PATHS` matrix now standing in
> `services/api/test/cross-address.test.ts`. The `internal:notifier` assertion
> golden vector is cross-pinned in both assertion suites (the standing drift
> gate). `IndexedReader` gains `redemptionsChangedSince`/`incidentsSince`/
> `latestArrears`; the row shapes (`AlertRedemptionFact`/`AlertIncidentFact`/
> `AlertArrearsFact`) are frozen in `@nvhash/api-types`. An index-only indexer
> migration (`@@index([lastHeight])` on `redemption_requests`) rides this
> branch (no column, schema-allowlist unaffected, rebuildable).

> **Revision 2026-07-27 (PR 6.4 commit B, the operator surface):** three new
> `GET`, `auth: "address"`, enveloped, zod-bounded routes serve `/validators/mine`
> (§8.6). All three join the cross-address `PERSONAL_PATHS` gate — which this
> change makes **registry-derived** rather than hand-kept, so every future
> address-scoped route is covered automatically:
> - `/api/v1/operator/summary?address=` → `OperatorSummary`: every validator the
>   address operates, each with registry enrollment, the latest sampled epoch's
>   FULL economics (uptime, eligibility, failing reasons, program delegation,
>   tip, commission accrued/paid/due), and lifetime commission/TIP totals with a
>   payment count from `operator_payments`. Per-epoch fields null before the
>   first sample; totals are honest sums (0 over zero rows).
> - `/api/v1/operator/epochs?address=&valoper=&limit=&offset=` →
>   `OperatorEpochRow[]`, newest first — the per-epoch history the console
>   cannot show.
> - `/api/v1/operator/payments?address=&valoper=&limit=&offset=&format=` →
>   `OperatorPaymentRow[]`, newest first; `format=csv` serves the §14.11
>   operator export — the **complete** history ascending (the 6.1
>   completeness precedent: `limit`/`offset` bound only the JSON view), with
>   the pinned columns `datetime_utc, block_height, epoch_index, payment_type,
>   nhash_amount, txhash` (the [R4] §14.11 deviation: the served amount is
>   nhash base units, so the column is named for base units), the
>   formula-injection guard, and the [R3] freshness headers.
>
> **A second boundary, enforced as a mechanism.** These routes carry an
> ownership check the other personal routes do not need: the address→valoper
> mapping is resolved server-side from `validator_registry.operator`
> (`IndexedReader.operatorValopers`, the single source), and every other
> operator read is called only with a valoper that came from it (the pure
> `resolveOwnedValoper`). A valoper the caller does not operate is answered
> **honest-empty, never 403** — a 403 would confirm the valoper exists and
> belongs to another operator, an oracle on who operates what. The gate is
> `test/operator-endpoints.test.ts`, which asserts an unowned valoper and a
> well-formed nonexistent one produce byte-identical answers. `?valoper=` is
> bounded by a new `bech32ValoperSchema` (the `valoper` HRP required), so an
> account address cannot be passed where a valoper is meant.
>
> Two recorded shape decisions. **`payer` is served in the JSON row but not in
> the CSV:** payment is permissionless, so the payer is often not the operator
> and is needed for the operator's own audit (public tx data), while §14.11
> pins the six export columns — adding it there is a §14.11 amendment, not an
> implementation choice. **Peer context is absent:** the plan's proposed
> `rank_by_tip` / eligible / enrolled counts were not approved (§7 Q5,
> 2026-07-27), so no other validator's ordinal position is computed onto this
> personal surface; the public `/validators` page remains where the set is seen.
>
> `epoch_index` on a payment is **derived at read time**, not stored: the
> earliest epoch whose `endHeight >= payment.height` (`paymentEpochIndex` over
> `IndexedReader.epochBoundariesAsc`), null while the crediting epoch is still
> open — see the §9.1 `operator_payments` note for why the indexer cannot
> supply it. `IndexedReader` also gains `latestOperatorEpochs`,
> `validatorEpochsFor`, `operatorPaymentTotalsFor` (summed in SQL, never by
> materializing rows), `operatorPaymentsFor`, and `operatorPaymentsAscFor`
> (chunked). The full `validator_epochs` row is a NEW fact type
> (`OperatorEpochFacts`); the public projection's narrow `ValidatorEpochFacts`
> is untouched, so the closed public key set gated by
> `apps/web/test/validators-data.test.ts` cannot widen by accident.

> **Revision 2026-07-29 (PR 7.1 commit C): the §8.7 governance read surface, and
> one mechanism that outlives it.**
>
> Three PUBLIC enveloped routes join `services/api`: `/governance/proposals`
> (paginated, newest first, optional policy and status filters),
> `/governance/proposal?id=` and `/governance/policies`. Public is structural
> rather than a policy choice — proposals and votes are public chain facts with no
> address keying, so there is nothing to scope and no `PERSONAL_PATHS` entry
> exists.
>
> Four shape facts are pinned here because each is a place a later change would
> plausibly get it wrong:
>
> - **The proposal detail takes a QUERY PARAM, not a path segment.**
>   `services/api` has no path-parameter support: `findRoute` is an exact string
>   match. `/governance/proposal?id=` is therefore the surface, and the web tier's
>   own `/governance/:proposalId` URL is unrelated to it.
> - **`id` is a decimal STRING on the wire, in both directions.** x/group proposal
>   ids are uint64 and JSON numbers stop at 2^53, so a coerced number would
>   silently accept a corrupted id. Tally counts and member weights are decimal
>   strings for the adjacent reason: they are unbounded weight SUMS with no
>   protocol ceiling, so `Uint128` would be an invented bound.
> - **`indexed_from_height` rides the list payload.** `x/group` prunes, so a
>   proposal that closed before the indexer existed is unrecoverable; without this
>   field the list would imply a completeness it lacks. Null, never 0, when no
>   height certifies the window.
> - **The API serves the MIRROR, not the chain.** It has no chain client by design,
>   so `/governance/policies` is the HISTORICAL policy set observed in
>   `gov_proposals` — a policy that exists on chain but has never carried a
>   proposal is legitimately absent — and every figure is AS OF `observed_height`.
>   The live policy set, current membership and live tallies are web-tier reads at
>   7.2, the same division `/market` and `/portfolio` already use.
>
> **The mechanism that outlives this PR: wire bounds are one declaration.**
> `@nvhash/api-types/bounds.ts` now holds every bound that exists on both sides of
> the API↔web boundary, imported by both, with `test/bounds.test.ts` asserting
> producer ⊆ consumer for each registered pair. This closes the **PR #19 defect
> class** rather than another instance of it: that fix added a constant, while
> §9.1's row types went on coupling the two sides in a COMMENT with nothing
> importing or testing the pairing. The three M6.1 portfolio caps are adopted into
> the registry in the same change; the pre-7.1 collection bounds on `/validators`,
> `/portfolio.active_redemptions` and `/market` remain web-only and are named as
> not-yet-covered in that file rather than left to be discovered.
>
> Two truncations are FLAGGED rather than silent (`votes_truncated`,
> `messages_truncated`). The vote list is not page-controlled by the caller — the
> detail endpoint serves a proposal's whole vote set, whose size is a property of
> the group, and x/group puts no ceiling on membership — and a governance payload
> that quietly dropped a message would misstate what is being voted on.
>
> **Tally-vs-threshold is a shared pure helper** (`tally.ts`), not a per-consumer
> derivation: this is the `navHashPerShare` precedent recorded in this section's
> revision (d), which exists because a duplicated amount formula drifted once. It
> is BigInt-only and returns **null for undecidable** — an unrecognized policy
> type, a malformed count, or a percentage rule with no electorate weight. A
> boolean there would look authoritative while resting on a guess.

### 9.5 Derived metrics (formulas)

All in integer/`BigInt` arithmetic with explicit scale-then-floor; percent/HASH conversion at render only.

1. **Cost basis & accrued gain (per address):** cost basis uses **average-cost** (§14.11 decided) — average deposit cost per share × remaining shares; accrued gain = current shares × current NAV − remaining (average-cost) basis, plus realized gains on completed redemptions. The CSV export is raw per-event rows (share price in HASH at each swap), not a computed lot-matched basis (§14.11).
2. **Effective yield (per address):** over window W, gain = Σ per-interval (shares held × ΔNAV at each epoch step inside W); effective APR = gain ÷ time-weighted average invested value, annualized. Rendered per epoch beside the program's `net_apr_bps` for the same window. Sub-day windows follow the shared minimum-window rule (render "n/a").
3. **Typical time-to-payout:** per recent-epoch cohort of terminal `redemption_requests`, the median and p90 of (`expedited_at ?? matured_at`) − `enqueued_at`. Displayed only with **≥ 10 terminal requests** in the cohort (§14.12 decided); below it, the flow shows the 60-day guarantee alone — a small-sample "typical" would be a lie with extra steps. The statistic is physically bounded to the **~21-to-60-day band** (unbonding floor to guarantee ceiling); labeling never implies precision outside that band.
   > **Revision 2026-07-24 (PR 5.4, delivered):** served by the new public
   > **`GET /api/v1/redemptions/stats`** (`services/api`; `derivePayoutStats`).
   > Aggregate over all owners → **no PII, unauthenticated** (unlike the
   > address-scoped `/portfolio`). Since `redemption_requests` carries no
   > epoch-index column, "recent-epoch cohort" is delivered as a **recent
   > rolling terminal-request window** (`PAYOUT_STATS_WINDOW_DAYS`, default 90;
   > terminal = matured or expedited) — a literal per-epoch cohort is a later
   > indexer-decoder change. Payload `{ sample_count, median_seconds,
   > p90_seconds, band_floor_seconds, band_ceiling_seconds, cold_start }`: the
   > ≥ 10-terminal gate and the ≥ 1-completed-epoch cold-start gate null the
   > stats server-side (the web tier then shows the guarantee alone), and the
   > 21–60-day band bounds ride as data. Gates: `derive.test.ts` (percentile +
   > gates), `envelope-contract.test.ts` (honest cold-start + sufficient +
   > below-threshold), `integration/reader.test.ts` (real Prisma cohort query
   > as `api_reader`); a terminal-timestamp index was added
   > (`redemption_requests_maturedAt_idx` / `_expeditedAt_idx`).
4. **Premium/discount:** `(market_price − NAV) / NAV` in bps, computed at each market sample against the NAV current at that sample's time.
5. **Upkeep lag:** for each crank kind, actual execution time − earliest-eligible time (from config intervals + prior state), distribution per epoch.
6. **Reconciliation deltas (§12):** indexed vs live for NAV inputs, total shares, epoch index, queue length — the reconciler's inputs, stored with each run. **Per-metric tolerances live in code** (`services/indexer/src/reconciler/tolerances.ts`), reviewed like the schema allowlist and **not env-tunable** — a widened tolerance would silence the alarm, which §12.1.3 forbids (RESOLVED 2026-07-21, PR 2.5). The "live plane" the reconciler compares against is the chain's retained latest epoch snapshot (the authoritative current record); copied snapshot values use an exact (0) tolerance, so any indexed divergence trips `reconciler_divergence`. **Queue-length delta is deferred** to a fast-follow (it needs a vault `pending_swap_outs` decoder the indexer does not yet carry).

> **Revision 2026-07-23 (PR 6.1 commit B):** items 1 and 2 are implemented in
> `services/api/src/portfolio-metrics.ts` (the pure `derivePortfolioMetrics`
> fold behind `/portfolio/metrics`, §9.4). Pinned mechanics: average cost is
> carried as two pools (held, escrow) with basis moved by proportional
> floor-rounded amounts; escrowed shares keep participating in yield until the
> payout event (they re-price at each NAV step, then realize at payout);
> refunds realize nothing (they return shares and their basis to the held
> pool); `SECONDS_PER_YEAR = 31_536_000`; signed bps figures truncate toward
> zero; transfer kinds are excluded from basis and surface as
> `history_state: "has_transfers"` (the basis rule for transfers is decided
> when their producing worker lands). The R3 property and sim-trace-replay
> suites gate these formulas in CI (§2.8.2). Replay convention (plan §7 Q1,
> RESOLVED 2026-07-23): the chain-free traces tag events round-robin to
> synthetic addresses as documented metadata over single-pooled economics, so
> R3 replays each trace's full event stream as ONE pooled address (the fold is
> per-address by construction, so per-address decomposition adds no coverage
> the property suite does not already generate). The accrual series is capped
> server-side at `MAX_ACCRUAL_POINTS = 2000` (most recent kept, earlier history
> trimmed and flagged by `accrual_truncated`), so a high-event address never
> trips the web boundary bound and silently nulls the whole read. The
> per-epoch yield series carries the symmetric cap (`MAX_YIELD_POINTS = 2000`,
> flagged by `yield_truncated`; web wire bound 10x above), and the epoch-step
> read (`listEpochsAsc`) is chunked like the transaction read so no SELECT is
> unbounded (PR 6.1 follow-up, external review).

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
3. **Simulate**, and use the returned fee **verbatim** — `[RESOLVED 2026-07-27, Ira]`, replacing the earlier `[VERIFY §14.3]` "reuse the console's result" marker. Under Provenance's flat-fee model the required fee is a deterministic **per-message** cost (`x/flatfees` `CalculateMsgCost`), unrelated to gas consumed, and `Simulate` returns **that fee amount** in the gas-wanted field — which is why the chain's guidance is a gas price of exactly **1nhash** (provenance [`internal/antewrapper/utils.go`](https://github.com/provenance-io/provenance/blob/5e8f6b621e0d04dcd5531f56337d554cfb01aac1/internal/antewrapper/utils.go#L126) `GetGasWanted`; the antewrapper then substitutes a real gas limit for execution). Therefore: the price is 1nhash and is **not a tunable** — a tx priced off the old `price × gas estimate` model is **rejected** by the protocol, deliberately, so no client re-imports that assumption; there is **no adjustment buffer**, since padding a deterministic cost buys no out-of-gas headroom (the number is not gas); and `gas_limit` equals the fee amount, as captured devnet txs show (`fee: 2nhash`, `gas_limit: "2"`, ~201k gas actually consumed). Gated by `apps/web/test/tx-fee.test.ts`.
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
> matrix); simulation uses the chain's returned fee **verbatim** at a
> **1 nhash** price, with **no adjustment buffer** and `gas_limit` equal to the
> fee amount — the deterministic flat-fee basis, `[RESOLVED 2026-07-27, Ira]`
> and pinned by `test/tx-fee.test.ts`. A price other than 1 nhash, or any
> padding of the returned figure, is a defect: the protocol rejects the former
> and the latter inflates a deterministic cost for nothing. **Broadcast is the §12.3
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

> **Revision 2026-07-27 (PR 6.4 commit D, the operator flows delivered):** the
> validator chain-ops half of the bullet above ships. Five flows through the
> UNMODIFIED §10.2 lifecycle (`useTxFlow`: preflight → simulate → confirm →
> sign → broadcast → track), each a `MsgExecuteContract` on the program
> contract, all wallet-signed with no key material in the App:
>
> | Flow | Variant(s) | Funds | Tier |
> | --- | --- | --- | --- |
> | Pay commission | `pay_commission` | nhash | warning |
> | Pay TIP | `pay_tip` | nhash | warning |
> | Enroll | `register_participation` | none | warning |
> | Withdraw from program | `unregister_participation` | none | **serious** |
> | Purge jailed (two-phase) | `report_jailed_validator`, then `purge_jailed_validator` | none | **serious** |
>
> Confirm copy RESTATES the contract's own mechanics from the `msg.rs` doc
> comments rather than inventing product language, because the facts that
> matter to an operator are the counter-intuitive ones: a commission payment is
> non-refundable and an overpayment **carries forward** against future accrual,
> while a TIP credits the **current epoch only** and resets at completion;
> unregistering **unbonds** the program's stake at the next epoch AND is a clean
> break — `unregister` removes the record, so re-enrolling starts fresh and no
> commission/TIP history (including commission prepaid beyond accrual) carries
> over, which is the contract's intent, not an omission (confirmed Ira,
> 2026-07-27); and the purge
> is genuinely two-phase — reporting moves no stake, it starts a cooldown, and a
> validator that unjails in the interim clears its own report. Preflight
> restates every predicate the contract enforces as a machine-readable reason
> (`not-validator-operator`, `validator-not-found`, `already-enrolled`,
> `not-enrolled`, `validator-not-jailed`, `no-jail-report`, `purge-cooldown`
> with the ready instant, `program-halted`) and remains **convenience only**
> (§12.1) — notably, the payment flows carry NO operator check, because paying
> is permissionless and a UI rule saying otherwise would be invented. The
> enroll flow is also offered on the **non-operator** state: an operator becomes
> one by enrolling, so that state is a starting point, not a dead end.
>
> `claimant_valoper` on the purge defaults to another validator the caller
> operates when one exists, is always editable, and always appears in the
> exact-JSON disclosure — it can never be applied invisibly.

### 10.4 Notifications

Alert rules (§8.2) evaluate on indexer ticks; deliveries record to `notifications` and fan out per channel opt-in. Channels are **in-app (always)** and **Web Push (per-browser opt-in)**; there is no email channel (`SECURITY.md`: no off-chain identity linked to wallets). A push subscription is stored as an opaque, revocable endpoint token and is deleted on opt-out or session deletion; push payloads are minimal (event + link into the App, no amounts). Every alert kind has an in-app rendering so users without push lose nothing but latency.

> **Revision 2026-07-24 (PR 6.2 commit B, notifier delivered):** the notifier
> is a separate `apps/web` worker entrypoint (`notifier/index.ts`, `pnpm
> notifier`; ADR-001 Decision 3) that reads indexed facts ONLY through
> `services/api`'s `internal:notifier` surface (§9.4) — its `app_writer`
> credential holds no `indexed` grant. Recorded mechanisms: (a)
> **Evaluation population = app presence**, never "all indexed addresses": an
> in-app notification can only be seen by an address that has established a
> session, so the notifier notifies only addresses with an `address_activity`
> row (the accepted first/last-seen marker, `app`-schema-local — no API hop).
> Consequence, stated honestly: a holder's first login shows notifications only
> for events after that first presence; they could never have seen earlier
> ones. (b) **Exactly-once is two-layered**, correctness never resting on the
> cursor: the `notifications` unique constraint (`ON CONFLICT DO NOTHING` on
> every insert) plus a per-stream cursor advanced in the SAME transaction as
> the insert batch. The redemptions stream cursors on the compound
> `(height, request_id)` keyset (§9.4 `after_id`), so a same-height burst
> larger than one fact page — mass maturation at an epoch settlement — pages
> through completely rather than being skipped by a height-only cursor; the
> nav-step stream clamps its `/epochs` page to the public cap. Dedupe keys
> are replay-stable chain/indexed identities
> (`epoch:<i>`, `req:<id>:<event>`, `incident:<kind>:<dedupeKey>`,
> `arrears:<valoper>:<epoch>`), never autoincrement ids. (c) **Incident→kind
> mapping is a closed table**: `vault_status ← {vault_paused, contract_halted}`,
> `validator_set_incident ← {jail_report, slash_write_down}`; ops-facing kinds
> excluded; v1 sends no close/"resumed" notifications. (d) A **retention sweep**
> rides the tick (bounded batch): delete read > 90 days ago, and any > 180 days
> old (proposal values) — minimization applied to our own table. Per-stream
> try/catch isolates a failing stream (cursor unmoved, retry next tick); a boot
> misconfig is a loud exit.

> **Revision 2026-07-24 (PR 6.3, Web Push channel delivered):** the second
> channel ships, per-browser opt-in. **Subscription** is a user gesture in the
> alert-settings section → browser permission → `pushManager.subscribe` → POST
> to the session-gated `/push/subscription` route, storing the opaque W3C token
> (§9.1 `push_subscriptions`). The four browser states render honestly (no
> silent no-ops): unsupported, not-configured-for-this-environment, denied
> (points at browser settings), and enabled/subscribed. **Delivery:** after the
> notifier's evaluation transaction commits, the tick's delivery phase — OUTSIDE
> any DB transaction — sends each NEWLY-INSERTED notification (the set
> `commitTick` returns via `INSERT … ON CONFLICT DO NOTHING RETURNING`) to the
> recipient's subscriptions via the `web-push` package (VAPID + `aes128gcm`).
> The push body is the CLOSED **`{ kind, url }`** shape derived from the kind
> alone — no amounts, no addresses, no request ids reach the third-party push
> service; the service worker (`public/push-sw.js`, static, keyless, fetch-less)
> renders generic per-kind title/body from it. **Posture:** push is additive
> latency, never load-bearing — **at-most-once** (no `pushed_at` column, no retry
> queue: a crash between insert and fan-out loses only the nudge; in-app is the
> guaranteed channel). A failed send degrades silently (logged with the endpoint
> SCRUBBED, never the tick); a `404`/`410` **prunes** the dead subscription
> (revocability in reverse). **Deletion chain:** a token is deleted on opt-out,
> logout, session expiry/removal, and dead-endpoint pruning — the standing
> `test/push-token-deletion.test.ts` gate. The chain deletes push rows BEFORE
> the session row (a failure strands a harmless session remnant, never a
> token), and the notifier tick runs an **invariant sweep**
> (`PushStore.sweepOrphans`, one anti-join DELETE mirroring the session
> liveness rule): any token whose session is missing or expired is removed
> even if that browser never returns — the sweep runs whether or not VAPID is
> configured. Subscription upserts run **Serializable** (bounded P2034 retry),
> so concurrent POSTs cannot defeat replace-by-session or the per-address cap.
> VAPID config is all-or-none; absent,
> the notifier records in-app only and the settings block says "not configured".

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
>
> **Revision 2026-07-28 (M7 planning): the `governance` target stays absent
> through M7**, including the §8.7 pages that would most tempt someone to add
> it. Two reasons, and the second is new. The console still has no governance
> panel, so the target would be dead — and this section pins every verify href
> strictly under `{CONSOLE_URL}` with a chain-id boot check, so an external
> block explorer is not a substitute for one. Beyond that, `x/group` **prunes**:
> rejected, aborted and executed proposals leave chain state entirely, so a
> closed proposal frequently has nothing on chain to verify against at all. The
> indexed mirror is the durable record by design (§9.1), and PR 7.1 marks such
> rows `pruned` precisely so the UI can say the chain no longer holds it rather
> than offer a path that resolves to nothing. The panel and the target remain
> one pair, scheduled with the §14.13 console follow-on before 8.4.

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
  >
  > **Amendment 2026-07-27 (PR 6.4 commit D): the allowlist is now TWO-LEVEL
  > for `MsgExecuteContract`.** The operator actions (§14.6) ride that type
  > URL, and adding it as a plain allowlist entry would have opened the relay
  > to **arbitrary calls on any contract on chain** — the opposite of a closed
  > allowlist. It is therefore admitted only together with a second-level
  > **deep guard** that runs for that type URL and no other, replacing the
  > vault check for it (field 2 is the contract there) while the session
  > binding on field 1 still applies. Five conditions, each independently
  > sufficient to reject: **(1)** the target is the configured program
  > contract; **(2)** the inner payload is an object with exactly ONE
  > top-level key, drawn from the closed six-variant operator set — every
  > admin/keeper variant (`set_halted`, `update_config`, `pause_vault`,
  > `unpause_vault`, `clear_pending_delegations`, `run_epoch`,
  > `claim_rewards`, `service_redemptions`, `capture_uptime_signal`) is
  > absent and provably rejected; **(3)** the variant body carries only its
  > allowed keys, each a well-formed valoper (the `valoper` HRP is required,
  > so an account address cannot pass); **(4)** funds discipline — the two
  > payment variants carry exactly one coin of the program's underlying denom
  > with a bounded positive amount, every other variant carries none;
  > **(5)** the payload is **byte-identical** to the canonical
  > `operatorInnerJson` output for what was just validated.
  >
  > Condition (5) is what takes the guard out of a parser arms race: whatever
  > the guard believes it validated, the bytes reaching the chain are the bytes
  > the App's own builder would have produced, so duplicate JSON keys, key
  > reordering, padding whitespace, and escaped variant names all fail even
  > though they parse to something the structural checks would accept. That
  > canonical form is not asserted — it is proven equal to bytes the chain
  > accepted, by byte-goldens over three captured devnet transactions
  > (`test/tx-operator-build.test.ts`). **Extending either level is a
  > design-review event**, and the rejection matrix in
  > `test/broadcast-guard.test.ts` is the standing gate.
  >
  > **Amendment 2026-07-30 (PRs 7.3–7.4): the governance types are admitted,
  > all three at once, under this one amendment.** This is the design-review
  > event the 6.4 note anticipated, and it is what the M7 milestone means when
  > it says admin program-ops reach the chain **only** through governance.
  >
  > **The admitted set is exactly three:** `/cosmos.group.v1.MsgVote`,
  > `/cosmos.group.v1.MsgExec`, `/cosmos.group.v1.MsgSubmitProposal`. Every
  > other `cosmos.group.v1` type stays rejected — `MsgUpdateGroupMembers` in
  > particular, which changes **who governs** — as does `authz`'s own `MsgExec`.
  > The allowlist is asserted as an exact six-entry set, so a seventh is an edit
  > to a named test line.
  >
  > **All three are guarded STRUCTURALLY**, on the same terms as each other:
  > type URL → signer ↔ session-address binding (`voter`, `signer`, the single
  > `proposers` entry) → closed field set with bounded values → the `exec` pin
  > where the message has one → **canonical re-encode**. For
  > `MsgSubmitProposal` the re-encode covers the ENVELOPE, with the inner `Any`
  > bytes passed through verbatim.
  >
  > **The `exec` pin, on `MsgVote` and `MsgSubmitProposal`.** `EXEC_TRY`
  > attempts execution in the same transaction, which turns a vote — or a
  > submission — into a vote **plus** execution of whatever the proposal
  > contains. `exec` is pinned to the unspecified/no-try value; because proto3
  > omits a zero varint, the pin is enforced as "the field is absent", and the
  > canonical re-encode enforces it a second time. Execution is always a
  > separate, separately confirmed `MsgExec` with its own decoded-payload
  > disclosure (§17.1). **This is a confirmation-rigor control, not an
  > authorization control** — see the correction below.
  >
  > **CORRECTION, same date, and it is the substance of this amendment.** This
  > guard was first written with SIX conditions on `MsgSubmitProposal` — a
  > closed admin-action template set matched against every inner message, a
  > byte-identical re-encode per inner message, and a live sweep of the
  > program's group policies (which made the whole relay guard asynchronous and
  > added a 503 failure mode). The stated rationale was that carrying
  > `messages []Any` bound for the policy account — the contract's admin — was
  > *"strictly worse than the `MsgExecuteContract` hole 6.4 closed."*
  >
  > **That comparison was backwards, and the extra conditions have been
  > removed.** An unguarded `MsgExecuteContract` **executes on inclusion under
  > the signer's own authority** — nothing else has to happen. A
  > `MsgSubmitProposal` **executes nothing**: it is a request that does nothing
  > at all until the group's decision policy is satisfied by other members
  > voting. **The group's threshold is the enforcement boundary here**, exactly
  > as the contract is for `MsgExecuteContract`. Restricting what may be
  > *proposed* reduced no authority available to anyone, while costing a chain
  > read on every submission, an availability failure mode, and a template
  > registry the relay had to keep in lockstep with `contracts/src/msg.rs`.
  >
  > Two further facts made the original conditions redundant rather than merely
  > expensive. x/group declares `proposers` (and `voter`) its required signer,
  > so the chain already rejects a foreign proposer given this relay's
  > pre-existing sole-signer guard. And **what actually protects members from a
  > hostile proposal is being able to read it before they vote** — the §8.7
  > decoder, which summarizes a closed union and tags everything else
  > `unknown` with the exact JSON. That is a read-surface property, delivered
  > at 7.2, and it does not depend on this relay at all.
  >
  > **What the relay consequently does NOT check, deliberately:** a proposal's
  > inner messages (they ride verbatim to a vote the group must win), and
  > whether a vote's or a proposal's group policy belongs to this program (it
  > confers nothing either way; the composer still tells a proposer when they
  > have picked an address this program does not govern, as a courtesy).
  > `test/broadcast-guard.test.ts` asserts these as **acceptances**, so
  > re-tightening the guard is a deliberate edit to a named case rather than a
  > silent change.
  >
  > **The direct-admin path stays closed, and that is unchanged.** A *direct*
  > `MsgExecuteContract` carrying an admin variant is **still rejected** — the
  > 6.4 rejection rows are unchanged and re-asserted alongside the governance
  > matrix, adjacent to the case proving the same variant is carried as a
  > template-scoped proposal. **Extending the admitted set remains a
  > design-review event.**
- **Personal data minimization (`SECURITY.md` is normative):** wallet address (public by nature), first/last-seen timestamps (minimal operational metadata, retained deliberately for transparent and minimally intrusive usage measurement), locale/theme, alert rules, and — when opted in — an opaque Web Push subscription token (revocable, deleted on opt-out). No email or other off-chain identity, no KYC, and no IP-or-device linkage to addresses in persisted logs (scrub or aggregate). Data deletion on request removes the user row, rules, and push subscriptions; indexed *chain* history is public information and remains.
- **Sessions:** nonce-signature login, `HttpOnly`/`SameSite` cookies, address-scoped authorization on every personal endpoint; admin endpoints re-verify group membership on-chain per session refresh, not per cached role.
- **API hygiene:** rate limiting on public endpoints, zod-validated inputs at every route boundary (nuva convention), winston structured logging in services, no secrets in the client bundle (server config never serializes past the §7 client-safe subset).
- **Analytics are first-party and aggregate-only:** no third-party trackers; counters are never keyed by wallet address, session, or device; never amounts or balances — page classes and funnel-stage tallies only `[DECIDE §14.10]`.
- **Supply chain:** the team's standard dependency policy; the transacting pages must function with third-party scripts blocked (analytics is additive).

  > **Revision 2026-07-24 (PR 6.3, Web Push deletion chain delivered):** the
  > "deleted on opt-out" clause of the accepted exception is now an enforced,
  > CI-gated mechanism, not a promise. A push token (`push_subscriptions`, §9.1)
  > is deleted on **all** of: opt-out (the DELETE route), logout, session
  > expiry/removal (the session-lifecycle deletion chain), dead-endpoint
  > (`404`/`410`) pruning at send time, and the notifier tick's **invariant
  > sweep** — a per-tick anti-join DELETE removing any token whose session is
  > missing or expired, which covers browsers that never present their stale
  > cookie and any crash remnant of the two-step chain — all asserted by the
  > standing `test/push-token-deletion.test.ts` (master plan §4). The token triple
  > (`endpoint`/`p256dh`/`auth`) is opaque and NEVER logged (endpoint URLs can
  > fingerprint the browser vendor — treated as secrets-adjacent; the fan-out
  > scrubs them). The single new dependency is `web-push` (lockfile-pinned,
  > first-party-maintained), imported only in the notifier worker so it never
  > reaches the client bundle. This enumeration ("removes the user row, rules,
  > and push subscriptions") is now backed by the deletion chain end to end.

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
   - **[SCHEDULED 2026-07-28, M7 plan] Governance side sequenced across three PRs.** [7.1](../plans/2026-07-28-app-m7.1-governance-indexing.md) mirrors `x/group` proposals and votes durably and serves them read-only (no signing path; the relay is unchanged and a governance message is still provably rejected). [7.2](../plans/2026-07-28-app-m7.2-governance-read-ui.md) is the §8.7 read surface, also read-only. [**7.3–7.4**](../plans/2026-07-28-app-m7.3-7.4-governance-write-path.md) is the whole write path in one PR — `MsgVote`, `MsgExec` and `MsgSubmitProposal` admitted together under a **single** §12.3 amendment, because they are one guard and staging the third across an intervening PR bought nothing. Vote and exec are guarded structurally (closed scalar payloads); `MsgSubmitProposal` carries `messages []Any` and is guarded by **six** conditions — type URL → proposer↔session binding → program-policy check → each inner `Any` against a closed template set → **byte-identical canonical re-encode per inner message** → `exec` pinned so a submission cannot execute in the same transaction. That PR is the design-review event this item's 6.4 note anticipated. **Admin program-ops reach the chain only as §8.7 templates**: the direct-`MsgExecuteContract` admin variants stay rejected afterwards, and that rejection matrix is a standing gate, not a transitional state.
   - **[IMPLEMENTED 2026-07-27, PR 6.4 commit D] Validator chain-ops delivered.** All five operator flows ship as first-class App transaction flows through the unmodified §10.2 lifecycle: pay commission, pay TIP, enroll, unregister, and the two-phase jailed purge (report → cooldown → purge) — see the §10.3 revision for tiers and copy, and the §12.3 amendment for the two-level relay allowlist that makes carrying them safe. **Admin program-ops remain outstanding** (halt/resume, pause/unpause, config, bridge config, originating as §8.7 governance templates); they are NOT in the relay's variant set and are provably rejected by its rejection matrix, so delivering them later is a deliberate design-review event rather than a config change.
   - **[IMPLEMENTED 2026-07-30, PRs 7.3–7.4] Admin program-ops delivered, as governance templates and nothing else — and the constraint above is DISCHARGED.** That constraint scheduled a design-review event; the §12.3 amendment of the same date IS that event, and it admits `MsgVote`, `MsgExec` and `MsgSubmitProposal` together under one review. Four of the five named surfaces ship (halt/resume, pause/unpause, config change with the §8.7 diff view, and abort-a-stuck-continuation); **bridge config does not**, because no contract variant backs it while §14.3 is unresolved, and its template is **absent rather than stubbed**. The load-bearing half of the sentence above survives verbatim: the admin variants are still NOT carried as direct `MsgExecuteContract` calls and are still provably rejected by the 6.4 rejection matrix, which is re-asserted alongside the new one. What changed is that they now have a route to the chain at all — a template-scoped governance proposal — not that the direct path opened. **Note the §12.3 correction of the same date:** the templates scope what the App COMPOSES; the relay guard does not restrict a proposal's contents, because a proposal executes nothing until the group's threshold is met.
7. **[DECIDED 2026-07-13, Ira] Notification channels:** Web Push is confirmed as the external channel — meaningful application functionality with minimal intersection with the security rules, acceptable given per-browser opt-in, available opt-out, and the opaque revocable token handling of §10.4. `SECURITY.md` records this accepted exception. Email remains excluded and is not an option.
   **[DECIDED 2026-07-24, Ira] Default-on alert kinds = the R2 minimal set (PR 6.2 commit B).** Holders: `redemption_update` (matured | expedited | refunded — one settings row, §8.2/§8.4) is **on by default, opt-out** (§10.3). Operators: `operator_arrears` is **on by default** for sessions the live role read reports as operator (§8.6). Everything else — `nav_step_posted`, `vault_status`, `validator_set_incident` — is **opt-in** (off by default). The mechanism is **absence-means-default** (§9.1): no `alert_rules` row means the kind's default, so a user who never touches settings has zero rows and the default-on set costs no stored subscription (data minimization by construction). The market-spread kind is **deferred with §14.4** (no market data in v1) — enabling it later is an enum migration + allowlist review + a `thresholdBps` column, a spec-recorded amendment, not a config toggle.
8. **[DECIDED 2026-07-14, ADR-001 Decision 4]** Design-system packaging (boundary §7.4): design tokens are **web-local** (`apps/web`) for v1, not a shared package — the two surfaces deliberately wear different registers and the console is mid-migration. Family coherence is enforced where it matters: both surfaces run the same dataviz palette validation (`validate_palette.js`) in CI on every token change, both themes. Shared TypeScript code (fixtures, chain client, API types, read-only indexed DB client) lives in a root pnpm workspace under `packages/` (`@nvhash/*`); the console may join the workspace with its own migration. Revisit shared token packaging post-v1 if drift is observed. **Brand pass delivered (PR 1.4, 2026-07-17):** program-specific accent and status tokens set web-local in `apps/web/app/theme/tokens.css` over the nuva base — NUVA mint-green primary CTA / focus ring (dark green-black label, WCAG AA both themes) and the fixed good/warning/serious/critical status set (icon + label; `warning`/`serious` are sub-3:1 on the light surface only under that relief rule). Both theme token sets pass the shared validation method in CI: the categorical chart palette via `check:palette`, the accent/status contrast via `test/brand-tokens.test.ts` (both computed by `validate_palette.js`, never eyeballed). §14.8 is now fully resolved.
9. **[DECIDED 2026-07-15, Ira] Launch locale set: `en` only.** v1 ships a single English locale. Future locales (`zh`/`ko` precedents or others) are TBD and explicitly **not in v1**. The `$lang+` i18n routing/plumbing (§8.0, §15) is retained with a single `en` catalog so additional locales are additive without a routing change — adding one is a content+config change, not a re-architecture.
10. **[DECIDED 2026-07-28, Ira] Aggregate-analytics event taxonomy: counters are aggregates by construction, so there is no per-person record to restrain.** The question was which page classes and funnel stages are counted and what consent posture the counters carry, within the `SECURITY.md` constraint that analytics are first-party, aggregate-only, and never keyed by wallet, session, or device. The resolution answers it structurally rather than by policy.
    - **Storage:** one `app`-schema table, `funnel_counters`, keyed `(stage, day)` with an integer `count` and **no other columns**. There is no row per visit, per session, per wallet, or per device — the row *is* the aggregate. The `SECURITY.md` accepted-exceptions list (push tokens, first/last-seen) is unchanged; this adds nothing to it.
    - **Stages:** the closed §8.8 funnel — `visit`, `due_diligence_depth`, `connect`, `first_deposit` — plus a closed **page-class** enum on the `visit` stage, chosen so no class identifies a niche page a rare visitor would read. `first_deposit` is derived from public chain history rather than incremented from web behavior.
    - **Increment site:** **server-side, in the route loader.** No client script, no beacon, no pixel, **no cookie, no client identifier**. A beacon design would fight §12.3's requirement that transacting pages function with third-party scripts blocked, and a consent banner would be a surface asking permission for something that collects nothing about the person.
    - **Consent posture:** none is required or presented, because nothing personal is collected. That is a claim the schema makes, not a promise the code keeps.
    - **Honesty consequence, accepted:** without an identifier the counters cannot deduplicate visitors, so a returning reader increments `visit` again. These are **event totals, not unique people**, and the surfaces say so. The funnel's terminal stage is exact (chain-derived) while its top is not, and the view must not imply uniform precision across stages. Acquiring an identifier to make a prettier number is not an available trade.
    - **Retention:** a stated, enforced window recorded in the allowlist comment, after which day rows aggregate up or drop.
    - **Enforcement:** the master plan §4 security-executable check — analytics counters never keyed by wallet, session, or device — is `apps/web/test/app-schema-allowlist.test.ts`, extended with this model's exact column set and a domain-specific forbidden-substring denylist (`address`, `wallet`, `session`, `device`, `ip`, `user`, `fingerprint`), gating `apps/web` CI from PR 7.6 on. A migration without the allowlist edit fails CI; adding a column is a design-review event, not an implementation choice.
11. **[DECIDED 2026-07-15, Ira] CSV export & cost-basis method.** The export is a **statement of fact, not a computed tax position**, and splits into two role-scoped exports:
    - **Holder export (§8.2):** raw per-event rows — one per `SwapIn`/`SwapOut` — carrying the **share price in HASH (NAV) at the event**, so the holder (or their accountant) does their own cost-basis math. Proposed columns: `datetime_utc`, `block_height`, `event_type` (swap_in | swap_out | refund | transfer_in | transfer_out), `nvhash_amount`, `hash_amount`, `nav_hash_per_nvhash` (share price in HASH at event), `txhash`. No FIFO/average lot-matching is computed in the export.
    - **Validator/operator export (§8.6 `/validators/mine`):** a record of **commission/TIP payment amounts and times** so a participating validator has a complete fact set for their own tax analysis. Proposed columns: `datetime_utc`, `block_height`, `epoch_index`, `payment_type` (commission | tip), `hash_amount`, `txhash`.
      **[DELIVERED 2026-07-27, PR 6.4 commit B/C]** exactly those six columns, in that order, over the COMPLETE payment history ascending (pagination bounds the JSON view only), with the formula-injection guard and the [R3] freshness headers, proxied to the browser by the session-gated `/operator/export?valoper=`. Three recorded facts: `epoch_index` is **empty** when the crediting epoch has not closed yet (never a guessed epoch — see the §9.1 `operator_payments` note); the row's `payer` is served in the JSON view but deliberately **not** in the CSV, since payment is permissionless and the payer is often not the operator — adding that column is a §14.11 amendment, not an implementation choice; and **[R4] the amount column ships as `nhash_amount`, not the `hash_amount` proposed above.** The value served is the payment's nhash **base units**, so a column named for whole HASH would read 10⁹× too large in the spreadsheet this export exists for — and it would contradict `/validators/mine`, which formats the same fact to whole HASH. The holder export above carries the same correction (it serves `nhash`/`shares` for the proposed `hash_amount`/`nvhash_amount`), so base-unit content under a base-unit column name is the settled convention for both exports. Gated by the operator CSV assertions in `services/api/test/operator-endpoints.test.ts`.
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
