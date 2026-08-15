# nvHASH Program Console: Web Front-End Technical Specification

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/nvHASH-console-spec.md`. Paths updated for this repository's layout.

**Version:** 2.0-RC1, re-baselined around the Protocol Engineer persona (2026-07-10). **Not yet certified for implementation.**
**Owner:** Ira
**Companion to:** `liquid-staking-spec.md` (v1.0, baselined 2026-07-09), the governing contract spec — section references of the form "contract §N" point there; `dashboard-personas.md` (the five personas); and `../architecture/application-boundary.md` (the Console-vs-App split this re-baseline implements).
**Revision (2026-07-10):** re-scoped from a four-audience dashboard to a **chain-truth verification tool** whose primary user is the **Protocol Engineer** (personas §9). Consumer-facing needs — education, guided transactions, DEX pricing, durable history, analytics, notifications — move to the separate App (boundary doc §3). The design language (§11) is **substantially simplified** to match: the NUVA/Zonescan visual-lineage program, the mint-teal brand accent, the self-hosted display typeface, and the "dim" dark variant are all removed. What remains is a lean, dense, honest operator UI on system fonts.
**Revision (2026-07-14):** §14.1 wallet support set **decided** (Ira): v1 ships the **Figure browser extension** plus the devnet direct-key mode for engineering; WalletConnect v2 is not a console v1 transport; Keplr/Leap fast-follow behind the certification checklist shared with app §14.1 (resolved the same day). §6 and §10.1 updated. **Amended same day:** the program vendor set gains **Arculus** as a second v1-certified vendor (app §14.1 amendment — a WC v2 standards-conformance guard); Arculus is App-surface only (WC v2 mobile, no browser extension), so the console v1 implementations are unchanged.

**Revision (2026-08-14, PR 8.4b — console testnet readiness):** §14 items 5, 6, 7 **decided** (no epoch backfill, labeled; compose-JSON admin path with address-match direct execute; real staking monikers, no identicons, explorer-on-expansion) and **new item 9** records the entity-anchor contract (the console-side record of app-spec §14.13), DECIDED+DELIVERED. §8.0/§8.8 gain the `/governance` route and panel (live plane only, honesty-matrix-gated); §11.2 gains the CO-24 severity-mapping note; §12's CSP is now generated per profile from `VITE_LCD_URL` (fails closed on anything wider); §15 step 5 is delivered — the tx layer is first-party (zero `@cosmjs/*`; the recorded re-add constraint resolved to "add nothing") and §10.1's devnet-mode compile-time exclusion is enforced by a CI bundle scan rather than stated.

**Status:** Release candidate for engineering review, *not baselined for implementation*. Grounded against the as-built contract interface (`contracts/src/msg.rs`, `contracts/src/state.rs`, verified 2026-07-09). The architecture is settled; the open items in **§14** must be closed before certification.

**How to read this:** §1 is the summary. §5 is the data contract the console consumes; §8 (pages), §9 (data layer), and §10 (control surfaces) are the build-defining sections. §11 is the (now short) design language. **§14 is the open-items list**: `[DECIDE]` = a decision to make, `[VERIFY]` = a fact to confirm against the deployed chain or wallet vendors. §16 and §17 give stakeholder context and refinements.

**Where review attention is most valuable:** (1) the no-backend decision and the client-side epoch ledger that compensates for the contract's single-snapshot retention (§5.3, §9.3); (2) the guard-preflight model that keeps controls honest against on-chain gating (§10.3); and (3) the trust boundary around the configured LCD endpoint (§12).

---

## 1. Purpose & Approach

This document specifies the **nvHASH Program Console**: a web front end for **verifying and operating** the nvHASH liquid staking program on Provenance Blockchain. The console makes the program's on-chain state legible (NAV, APR, validator participation, epoch status, redemption queue, invariants) and exposes its execute surface (permissionless cranks, validator operator actions, admin controls) behind a role-adaptive UI.

The console is a **chain-truth verification tool, not a consumer product.** Its primary user is the **Protocol Engineer** (personas §9): the engineer who builds and maintains the contract, drives a local devnet through its full lifecycle to verify a change, and monitors testnet/mainnet deployments for correct behavior. Keepers, validator operators, and the program admin are the same technical audience acting in narrower on-chain roles. Consumer-facing needs — education, guided transactions, DEX pricing, durable per-user history, analytics, notifications — are **out of scope** here and belong to the separate App (`../architecture/application-boundary.md`).

The console has **two objectives**: (1) **verification** — every material metric and invariant the contract tracks is visible and provable from the chain alone, without a wallet; and (2) **operations** — every contract endpoint is executable from the console with its on-chain guards (halt, min-interval, cooldowns, role checks) reflected in the UI before a transaction is attempted, identically across devnet, testnet, and mainnet.

**At a glance:**

- **Static single-page application, no custom backend.** The chain is the database: all reads are contract smart queries and module queries over the node's LCD/REST endpoint. Nothing to host but files; nothing off-chain to trust.
- **Read-first.** Every page renders fully without a wallet. Connecting a wallet only unlocks the write surface appropriate to the connected address (keeper / operator / admin), derived from on-chain facts.
- **Client-side epoch ledger.** The contract retains only the most recent `EpochSnapshot` (contract §9.10), so the console persists a local history of snapshots to power trend charts (§5.3, §9.3).
- **Lean design language.** §11 defines a small token set, components, chart specs, and interaction rules on system fonts — enough for an implementation agent to build without further design decisions, and deliberately no more.

**The one rule that shapes the whole design: the console must never lie about state.** Every displayed number carries a freshness contract (§9.4), every control reflects its on-chain guard before submission (§10.3), raw payloads sit behind every derived figure (§9.6), and the contract — not the UI — is the enforcement boundary (§12). A stale or wishful UI in front of a fund-moving contract is the primary failure mode this spec designs against. The audience is uniformly technical, so the UI is uniformly dense and exact — there is no "calm" consumer surface to maintain.

Delivery path: *spec → implementation against devnet → accessibility pass → testnet pilot → mainnet* (§15).

---

## 2. Glossary

| Term | Meaning |
|------|---------|
| **Console** | The web application this document specifies. |
| **Contract** | The nvHASH staking CosmWasm contract (the vault's asset manager), whose interface is contract §11. |
| **Vault** | The `ProvLabs/vault` module instance holding user funds; source of NAV, shares, and the pending swap-out queue. |
| **LCD** | The Provenance node's REST endpoint. The console's sole data transport for reads. |
| **Smart query** | A contract `QueryMsg` executed via the LCD's CosmWasm smart-query route (base64-encoded JSON). |
| **Crank** | A permissionless contract execute endpoint that advances program state (`RunEpoch`, `ClaimRewards`, `ServiceRedemptions`, `CaptureUptimeSignal`). |
| **Guard** | An on-chain precondition for an execute call (halt flag, min run interval, jail cooldown, role match). The console evaluates guards client-side to set button state, and the contract re-enforces them. |
| **Role** | The write surface available to the connected address: *observer* (none/any), *keeper* (permissionless cranks), *operator* (a `ValidatorStatus.operator` match), *admin* (the `Config.admin` match). |
| **Epoch ledger** | The console's client-persisted history of `EpochSnapshot` records (§9.3), compensating for single-snapshot retention on chain. |
| **Stat tile** | The headline-number component (§11.5): one value, one label, one optional delta. |
| **Status pill** | The compact state indicator (§11.5) mapping program states to the reserved status palette. |
| **bps** | Basis points, the contract's rate unit. 100 bps = 1%. All rates cross the wire in bps and are converted for display only. |
| **nhash / HASH** | Base denom and display denom: 1 HASH = 1,000,000,000 nhash (exponent 9). All amounts cross the wire in nhash as decimal strings. |
| **nvhash / nvHASH** | Share base denom and whole-share display unit. The vault mints `ShareScalar` = 1,000,000 base shares per nhash, so 1 nvHASH = 1e15 nvhash (exponent 15) and equals exactly 1 HASH at neutral NAV. On-chain bank metadata for this unit is set at bootstrap via the vault's `SetShareDenomMetadata` (vault-admin gated). |
| **Drain order** | The redemption unbonding order (contract §10.2): the reverse of the priority order the `Validators {}` query returns. |

---

## 3. Confirmed Design Decisions

The following are settled design decisions:

1. **No custom backend or indexer in v1.** The console is a static SPA served from any static host; all data comes from the configured LCD endpoint. This keeps the trust surface to "the chain plus one configurable node" and the deployment to file hosting. (An optional indexer is a deferred enhancement, §17.3.)
2. **Stack:** React 18 + TypeScript + Vite. Chain access via CosmJS (`@cosmjs/cosmwasm-stargate` for smart queries and execute, `@cosmjs/stargate` for module queries). No CSS framework: hand-written CSS on the token system of §11. No chart library: charts are hand-rolled SVG components per §11.6.
3. **Read-first, wallet-optional.** All pages render without a wallet. Wallet connection gates only the write surface, and the visible controls adapt to the connected address's role (§4, §10).
4. **Role detection is on-chain fact, not configuration.** Admin = connected address equals `Config.admin`. Operator = connected address equals some `ValidatorStatus.operator`. Everything else is observer/keeper. The console holds no role list of its own.
5. **Client-side epoch ledger.** `EpochSnapshot` records are persisted to IndexedDB keyed by `epoch_index` on every observed change, providing trend history the contract does not retain (§9.3). The ledger is best-effort per browser; charts degrade gracefully to single-point display.
6. **Tiered polling, no websockets in v1.** Three poll tiers (fast 10 s, medium 30 s, slow 300 s, §9.2) sized against the ~5 s block time. Every write triggers an immediate refresh of the queries it affects.
7. **Design language = the reference dataviz palette and method, kept lean.** Colors, status palette, mark specs, and interaction rules in §11 are the validated reference instance; any palette change re-runs the palette validator (§11.6) before shipping. The console uses hand-written CSS on a small token set, hand-rolled SVG charts, system fonts (no self-hosted webface), and no brand-accent color — it is an austere operator UI, not a branded product surface.
8. **All chain amounts are `BigInt`.** `Uint128`/`Int128` values arrive as decimal strings and are parsed to `BigInt`; display conversion (nhash → HASH, bps → %) is floor-formatted at render time only. No floating-point arithmetic on amounts.
9. **Guard preflight before every control.** Each execute button computes its on-chain guard state from already-polled data and renders enabled, disabled-with-reason, or hidden (§10.3). The contract remains the enforcement boundary; preflight exists to prevent doomed transactions and to explain state.
10. **Confirmation levels are tiered by consequence** (§10.4): cranks confirm inline; irreversible payments (`PayCommission`, `PayTip`) show an explicit "non-refundable" warning step; admin actions require a typed confirmation.
11. **Network configuration is build-time per deployment** (devnet/testnet/mainnet), a single JSON config (§7); no in-app network switcher in v1.
12. **Light, dark, and auto are an explicit three-way control.** Both themes are first-class; `auto` follows `prefers-color-scheme`, and `light`/`dark` are manual overrides persisted to `localStorage`. The dark palette is its own validated set of steps, not an automatic inversion (§11.2, §11.6).

---

## 4. Actors & Roles

> **Personas ground this section.** The console's actors are the operational projection of the program's
> four canonical user personas in
> [`dashboard-personas.md`](./dashboard-personas.md) — **Evaluator,
> Position Holder, Validator, Administrator** — which serve as the **adversarial design check** on this
> spec. The mapping is deliberately *not* one-to-one, and the seams are themselves review items in the
> [persona-review action register](../plans/persona-review-action-register.md): the persona-doc **Evaluator**
> has no dedicated console surface today (the Overview assumes an oriented reader — register **A1**); the
> **Position Holder** spans the observer **Dana** *plus* the create/redeem/unbond write surface this spec
> currently defers (**A2**; §8.1, §17.3); the persona-doc **Validator** folds in the permissionless-upkeep
> duties this spec assigns to a separate **Keeper (Kai)** (**B1/B3**) and asserts a governance vote this
> spec does not yet grant (**B2**); and **Administrator** ≈ **Ada**.

- **Protocol Engineer ("Theo") — primary user.** Builds and maintains the contract; verifies changes against a local devnet by driving the full epoch lifecycle; monitors testnet/mainnet deployments. Uses every page and every control. On devnet he typically holds all keys (direct-key mode, §10.1); against test/mainnet his write surface is whatever the connected address qualifies for. The console is designed for him first; the roles below are the narrower on-chain capacities he and others act in.
- **Keeper / watcher ("Kai"):** Runs the permissionless cranks, watches guard state and jail reports. Uses the Epoch & Operations and Jail Watch pages. Any connected wallet qualifies.
- **Validator operator ("Pat"):** Enrolls/unregisters their validator, monitors eligibility, uptime, arrears and priority, pays commission and TIP. Uses the Validators page and the Validator Desk.
- **Program admin ("Ada"):** The `Config.admin` group policy executor. Uses the Admin panel: config updates, halt/resume, vault pause/unpause, stuck-epoch recovery.
- **Technical depositor (verification tail):** A sophisticated holder verifying a number at the chain level. Reads the Overview and Redemptions pages. Consumer position-management lives in the App (boundary doc §4); the console serves only the "prove it against chain" need. No console-mediated writes.

| Role | Detected by | Visible write surface |
|------|-------------|----------------------|
| Observer | no wallet, or no match | none (all reads) |
| Keeper | any connected wallet | `RunEpoch`, `ClaimRewards`, `ServiceRedemptions`, `CaptureUptimeSignal`, `ReportJailedValidator`, `PurgeJailedValidator` (pure-unbond path), `PayCommission`, `PayTip` |
| Operator | address = a `ValidatorStatus.operator` | keeper surface + `RegisterParticipation`, `UnregisterParticipation` (own validator), `PurgeJailedValidator` with `claimant_valoper` (own eligible validator) |
| Admin | address = `Config.admin` | operator/keeper surface + `UpdateConfig`, `SetHalted`, `ClearPendingDelegations`, `PauseVault`, `UnpauseVault` |

Note: `PayCommission` / `PayTip` are **any payer** endpoints (contract §11.2); the console surfaces them on the Validator Desk for operators and behind a secondary action on each validator row for everyone else.

---

## 5. Key Dependency: the Staking Contract & Chain Query Surface

The console builds nothing the chain does not already answer. Its entire read model is the contract's query surface plus a small set of whitelisted module queries.

### 5.1 Contract smart queries (the primary read model)

| Query | Returns (key fields) | Console use |
|-------|----------------------|-------------|
| `Config {}` | `admin`, `vault_address`, denoms, `min_run_interval_secs`, `max_delegations_per_run`, `aum_fee_bps`, `performance_threshold_bps`, `min_capture_interval_secs`, concentration-cap mirrors, `commission_bps`, `jail_unbond_delay_secs` | Role detection, guard math, program-parameters panel, admin form defaults. |
| `EpochStatus {}` | `phase` (`"Idle"` \| `"Releasing"`), `halted`, `last_run_seconds`, `receipt_minted`, `pending_delegations[]`, `pending_redelegations[]` | Health strip, epoch lifecycle panel, `RunEpoch` guard, invariant view. |
| `Validators {}` | Per validator: `valoper`, `operator`, `enrolled_at_seconds`, `uptime_capture_count`, `uptime_bps?`, `jailed`, `tombstoned`, `tip_epoch`, `commission_accrued/paid/due`, `in_arrears`, `eligible`, `headroom`. **Sorted by program priority, highest first**; the drain order is this list reversed. | Validators table, Validator Desk, eligibility counts, drain-order display. |
| `JailReports {}` | `valoper`, `reported_at_seconds`, `purge_ready_at_seconds` | Jail Watch page, purge countdown, alert badge. |
| `EpochSnapshot {}` | The full contract §9.10 decomposition: `epoch_index`, window times, `tvv_before/after`, `total_shares`, `rewards_claimed`, `commission_received`, `tips_received`, `rewards_deposited`, `settled`, `write_down`, `deployed`, `rebalanced`, `unbonded_for_redemptions`, `redemptions_expedited`, `validators_purged`, `eligible_count`, `aum_fee_estimate`, `net_deposits` (signed) | Epoch decomposition panel, ledger append, identity cross-check. `None` before the first crank. |
| `Apr {}` | `epoch_index`, `window_seconds`, `tvv_before`, inflows (`rewards_claimed`, `commission_received`, `tips_received`), drags (`aum_fee_estimate`, `write_down`), `gross_apr_bps`, `net_apr_bps` | Headline APR tiles and the gross→net breakdown (contract §17 R2). `None` before the first crank. |

Smart queries go over the LCD route `GET /cosmwasm/wasm/v1/contract/{contract}/smart/{base64(json)}`. Response amounts are decimal strings (§13).

### 5.2 Module and vault queries (secondary reads)

| Data | Source | Console use |
|------|--------|-------------|
| Vault NAV, `total_shares`, paused state, `withdrawal_delay_seconds` | `provlabs.vault.v1` vault query for `Config.vault_address` **[VERIFY §14.2]** exact LCD path and field names on the deployed build | NAV tile, share supply, paused banner, redemption-delay display. |
| Pending swap-out queue | `provlabs.vault.v1` pending-swap-outs query (paginated) **[VERIFY §14.2]** | Redemptions page queue table, reserve math. |
| Per-request payout estimate | vault estimate-swap-out query **[VERIFY §14.2]** | Redemption estimates and the reserve = Σ estimate × (1 + 50 bps) display (contract §8). |
| Contract delegations (per validator, total) | `cosmos.staking.v1beta1` `DelegatorDelegations(contract)` | Deployment split, per-validator delegation column, invariant cross-check vs `receipt_minted`. |
| Validator monikers, bonded status | `cosmos.staking.v1beta1` `Validators` / `Validator` | Human-readable validator names beside valoper addresses. |
| Principal marker liquid balance | `cosmos.bank.v1beta1` `Balance(principal marker, nhash)` **[VERIFY §14.2]** marker address derivation | Expedite-funding display on the Redemptions page. |
| Latest block height/time | LCD node-info / latest-block | Freshness footer (§9.4). |

### 5.3 Data-retention gap the console must absorb

The contract keeps **only the most recent** `EpochSnapshot` (contract §9.10). Trend displays (NAV over time, APR history, net-deposit flow) therefore depend on the console's own **epoch ledger** (§9.3): snapshots are appended to IndexedDB whenever `epoch_index` advances. Consequences the design accepts: history begins when a given browser first loads the console; two browsers see different history depths; clearing site data clears history. Every trend chart must render correctly with 0, 1, or N points (§11.6). Backfilling the ledger from historical `RunEpoch` transaction events is a `[DECIDE §14.5]` enhancement.

---

## 6. Architecture Overview

```
            ┌────────────────────────────────────────────────────────┐
            │                Browser (static SPA)                     │
            │                                                        │
            │  Pages: Overview · Validators · Epoch/Ops · Redemptions │
            │         Validator Desk · Jail Watch · Admin             │
            │            │                          │                 │
            │      ┌─────┴──────┐            ┌──────┴──────┐          │
            │      │ Data layer │            │  Tx layer   │          │
            │      │ poll tiers │            │ build/sim/  │          │
            │      │ cache +    │            │ sign/track  │          │
            │      │ ledger(IDB)│            └──────┬──────┘          │
            │      └─────┬──────┘                   │ sign            │
            └────────────┼──────────────────────────┼─────────────────┘
                         │ HTTPS (LCD REST)         ▼
                         │                   ┌──────────────┐
                         │                   │ Wallet ext.  │
                         │                   │ (Provenance) │
                         ▼                   └──────┬───────┘
            ┌─────────────────────────┐             │ broadcast
            │  Provenance node (LCD)  │◀────────────┘
            │  /cosmwasm smart query ─┼──▶ Staking Contract (reads)
            │  /provlabs.vault ───────┼──▶ Vault (NAV, swap-out queue)
            │  /cosmos.staking, bank ─┼──▶ delegations, balances
            └─────────────────────────┘
```

**Component summary:**

- **Pages (React):** seven routes plus global chrome (§8). Purely presentational; all state comes from the data layer.
- **Data layer:** a typed query client wrapping the LCD routes of §5, a poll scheduler with three tiers (§9.2), an in-memory cache keyed by query, and the IndexedDB epoch ledger (§9.3). Exposes hooks (`useConfig()`, `useValidators()`, ...) returning `{ data, fetchedAt, error }`.
- **Tx layer:** message builders for every `ExecuteMsg` variant, gas simulation, wallet signing via the wallet adapter, broadcast, and inclusion tracking with a toast lifecycle (§10.2).
- **Wallet adapter:** a minimal interface (`connect`, `address`, `signAndBroadcast`) with implementations per supported wallet (v1: **Figure extension**, decided §14.1) plus a devnet direct-key mode that is compile-time excluded from production builds.
- **Node (LCD):** the single configured endpoint per deployment (§7). Its trust status is discussed in §12.

---

## 7. Application Configuration (concrete values)

One JSON document per deployment, baked at build time:

| Parameter | Value (mainnet profile) | Notes |
|-----------|------------------------|-------|
| `chain_id` | `pio-mainnet-1` | Devnet/testnet profiles substitute theirs. |
| `lcd_url` | program-operated node URL | **[VERIFY §14.2]** CORS enabled for the console origin. |
| `contract_address` | the deployed staking contract | Role and guard source of truth. |
| `vault_address` | from `Config {}` at runtime | Configured value is a bootstrap fallback only; runtime always prefers the contract's answer. |
| `denom_exponent` | `9` | 1 HASH = 1e9 nhash. |
| `display_denom` / `base_denom` | `HASH` / `nhash` | |
| `share_exponent` | `15` | 1 nvHASH = 1e15 base shares (= 1 HASH at neutral NAV; §2 share-scale row). |
| `share_display_denom` / `share_base_denom` | `nvHASH` / `nvhash` | |
| `poll_fast_secs` / `poll_med_secs` / `poll_slow_secs` | `10` / `30` / `300` | §9.2 tier assignment. |
| `stale_after_misses` | `3` | §9.4 freshness contract. |
| *(no `gas_price`)* | — | **Removed 2026-07-27** (was `1905nhash` **[VERIFY §14.3]**). Provenance flat fees make a tx's cost a deterministic per-message amount that `Simulate` returns directly, so there is no price to configure; a knob here invites `gas × price` math, which the protocol rejects. See §10.2 step 2. |
| `explorer_tx_base` / `explorer_account_base` | Provenance explorer URLs | Outbound links from toasts, addresses. |
| `redemption_margin_bps` | `50` | Mirror of the contract constant, display-only (contract §8). |
| `devnet_key_mode` | `false` | `true` only in the devnet profile; enables the direct-key signer for drills. |

---

## 8. Information Architecture & Pages

### 8.0 Site map & global chrome

```
┌──────────────────────────────────────────────────────────────────┐
│ nvHASH Console   [network badge]      [freshness] [theme] [wallet]│  top bar
├──────────────────────────────────────────────────────────────────┤
│ ⚠ banner slot: HALTED / VAULT PAUSED / JAIL REPORT OPEN / STALE   │  (only when true)
├──────────┬───────────────────────────────────────────────────────┤
│ MONITOR  │                                                       │
│ Overview │                                                       │
│ Validators                                                       │
│ Redemp.  │                 page content                          │
│ JailWatch│                                                       │
│          │                                                       │
│ OPERATE  │   (* Desk: wallet connected; Admin: admin only)       │
│ Epoch/Ops│                                                       │
│ Desk*    │                                                       │
│ Admin*   │                                                       │
├──────────┴───────────────────────────────────────────────────────┤
│ footer: block height · fetched Ns ago · contract addr · spec ver │
└──────────────────────────────────────────────────────────────────┘
```

- **Grouped section nav.** The left rail is grouped under two quiet caption headers: **Monitor** (Overview, Validators, Redemptions, Jail Watch, Governance: read surfaces anyone can use) and **Operate** (Epoch/Ops, Desk, Admin: the write surfaces). The grouping is visual only; role gating still hides entries per §4. The active entry carries an `--accent` left indicator and ink-1 label; inactive entries are ink-2. On 768-1279 the rail collapses to grouped icon clusters; below 768 it becomes the top drawer with the same two groups.
- **Top-bar theme control** is the explicit three-way Auto/Light/Dark toggle (§11.2), placed beside the freshness indicator.
- **Banner slot** stacks at most two, priority order: contract `halted` (critical), vault paused (serious, includes the pause reason when the vault exposes one), open jail report (warning, links to Jail Watch), data stale (warning, §9.4). Banners are computed, never dismissible while their condition holds.
- **Network badge** shows the chain id; on any non-mainnet profile it is high-visibility (warning-tinted) so screenshots are unambiguous.
- **Wallet button** shows connect state, then the truncated address with the detected role as a small caption (`observer`, `operator`, `admin`).
- Navigation entries marked `*` render only when their role condition holds; deep links to them render a "connect wallet" / "admin only" empty state rather than a 404.

### 8.1 Overview (route `/`)

The verification dashboard. Answers "is this instance healthy and are its invariants holding?" in one screen; contains **no write controls**.

```
┌ NAV ────────┐ ┌ Net APR ────┐ ┌ TVV ────────┐ ┌ Validators ─┐
│ 1.0432 HASH │ │ 8.41 %      │ │ 12.4M HASH  │ │ 27 eligible │
│ per share   │ │ gross 9.02% │ │ 12.40M shrs │ │ of 31       │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
┌ health strip ────────────────────────────────────────────────┐
│ epoch #14 · Idle · last run 3d 2h ago · next eligible in 27d │
│ vault: active · contract: active · jail reports: none        │
└──────────────────────────────────────────────────────────────┘
┌ NAV over time (step line) ──────────┐ ┌ Last epoch value ────┐
│                                     │ │ waterfall:           │
│        ______────                    │ │ rewards +2,140       │
│  ___──                               │ │ commission +214      │
│                                     │ │ tips +50             │
│                                     │ │ AUM est −38          │
│ (from epoch ledger, §9.3)           │ │ write-down −0        │
└─────────────────────────────────────┘ └──────────────────────┘
┌ Deployment split (one stacked bar) ──────────────────────────┐
│ delegated ▓▓▓▓▓▓▓▓▓▓▓▓ · unbonding ▓▓ · liquid ▓ · pending ▓ │
└──────────────────────────────────────────────────────────────┘
┌ Epoch history table (ledger) ────────────────────────────────┐
│ # · window · rewards · net APR · net deposits · eligible ... │
└──────────────────────────────────────────────────────────────┘
```

- **Metric tiles:** four stat tiles (§11.5), each one figure over a caption, in the standard panel treatment (no special hero radius, no accent hairline). The four figures: NAV as HASH per whole nvHASH (derived §9.5.1, 4 decimal places; reads 1.0000 at neutral NAV), Net APR with gross as the caption (from `Apr {}`, subject to the §9.5.2 minimum-window rule), TVV with total shares as the caption in whole nvHASH, eligible/enrolled counts (from `Validators {}`). No controls, no color beyond status pills.
- **Proof row (always on).** The program's on-chain proof surface is first-class, not behind a toggle: the receipt invariant (§9.5.4) and epoch identity check (§9.5.5) render as pills, and the deployment split carries its `receipt_minted` cross-check. Values the contract mirrors from config rather than measures carry the "mirror, not measurement" caption (§12). This is the honesty surface (§17.1) and the engineer's fastest read on correctness.
- **Health strip:** epoch index, `phase`, humanized time since `last_run_seconds`, next `RunEpoch` eligibility (`last_run + min_run_interval`), vault paused state, `halted` state, open jail report count. Each item is a status pill (§11.5).
- **NAV over time:** step-after line chart (§11.6.1) with time-range presets (all / last 30 epochs / last 12) in a row above the plot. NAV moves stepwise at epochs (contract §5), so interpolation would be a lie; the step form is load-bearing, and range filtering never recolors or reinterpolates the series.
- **Last epoch value decomposition:** signed horizontal bar (waterfall) of the `Apr {}` / `EpochSnapshot {}` inflows and drags (§11.6.2).
- **Deployment split:** one horizontal stacked bar: delegated (staking query), unbonding (delegator unbonding query), principal-marker liquid, pending deploy queues; caption shows the `receipt_minted` invariant check (§9.5.4).
- **Epoch history table:** the ledger, newest first; renders a single row (or an explanatory empty state) on a fresh browser.

### 8.2 Validators (route `/validators`)

The full participation table, one row per enrolled validator, in the **priority order the query returns** (rank 1 = highest priority = last drained).

Columns: priority rank; moniker + truncated valoper (address chip, §11.5); status pills (eligible / ineligible with reason, jailed, tombstoned, arrears); uptime (percentage with a threshold marker, dash when `uptime_bps` is null, capture count as tooltip detail); current-epoch TIP (HASH); commission accrued / paid / due with `in_arrears` highlighting; concentration headroom (HASH); program delegation (from the staking query).

- **Row expansion** reveals the full detail: operator address, enrolled-at date, the commission grace explanation when in arrears, uptime capture history count, and per-row secondary actions (`Pay commission…`, `Pay tip…`, `Report jailed` when `jailed` is true).
- **Filters** (one row above the table, §11.6.4): eligibility (all / eligible / ineligible), text search on moniker/valoper. Filtering never re-sorts or recolors; rank numbers stay those of the unfiltered list.
- **Drain-order note:** a caption under the table: "Redemption unbonding drains from the bottom of this list upward (contract §10.2)."
- Summary tiles above the table: enrolled, eligible, in arrears, jailed now.

### 8.3 Epoch & Operations (route `/epoch`)

The keeper's page: dense, exact, all four cranks.

- **Lifecycle panel:** `phase` with explanation ("Idle: no epoch in flight" / "Releasing: a deploy leg is draining continuation queues"), `last_run_seconds`, next-eligible countdown, `halted` state, `receipt_minted`, and the two pending queues as tables (`pending_delegations`: valoper + amount; `pending_redelegations`: src → dst + amount). When `phase = Releasing`, the panel foregrounds "continuation pending: RunEpoch may be called now to continue" (the interval guard is bypassed for continuations, contract §11.2).
- **Crank buttons** (§10.3 guard preflight): `Run epoch`, `Claim rewards`, `Service redemptions`, `Capture uptime signal`. Each renders its guard state and, when disabled, the reason and the time it becomes eligible. The keeper-cadence note from the contract (claim before run so the deposit includes current rewards, contract §11.2) appears as a hint between `Claim rewards` and `Run epoch`.
- **Last snapshot panel:** the full `EpochSnapshot` decomposition as a labeled figure set: value legs (rewards deposited, settled, write-down, deployed, rebalanced), redemption legs (unbonded for redemptions, expedited count), ops legs (validators purged, eligible count), and the **identity cross-check** `tvv_after = tvv_before + rewards_deposited − write_down` rendered as pass/fail (§9.5.5). A failing identity renders a critical pill; it is a monitoring feature, not decoration.
- **Program parameters panel:** the full `Config {}` readout (read-only here; editable in Admin).

### 8.4 Redemptions (route `/redemptions`)

- **Queue table** from the vault's paginated pending-swap-out query: request id, owner (address chip; rows owned by the connected wallet are highlighted and pinned first), escrowed shares, current payout estimate, enqueue time, maturity time (enqueue + `withdrawal_delay_seconds`) with countdown, and a funded/unfunded pill (estimate × 1.005 vs remaining marker liquidity, allocated in queue order, §9.5.6).
- **Reserve panel:** reserve need = Σ estimate × (1 + 50 bps) vs principal-marker liquid nhash, as two labeled figures and a single proportion bar; caption explains the expedite rule (funded requests release early on the next service pass; safety is the 60-day delay, contract §8).
- **`Service redemptions` button** repeated here (same guard component as §8.3).
- **Depositor framing:** a short static explainer at the top: the 60-day guarantee, the expedite behavior, and that redemptions made directly with the vault appear here too.

### 8.5 Validator Desk (route `/desk`, wallet required)

The operator's home. If the connected address operates no enrolled validator, the page offers enrollment.

- **Enrollment card:** valoper input (prefilled with the address's derived valoper when it exists on chain **[VERIFY §14.4]**), on-chain existence check, `Register participation` action. After enrollment: `Unregister…` behind a warning confirmation (stake is redelegated away at the next epoch; unpaid commission obligation dies with the record but so does the enrollment).
- **Own-validator card:** the §8.2 row detail writ large: eligibility with each failing condition listed explicitly (below uptime threshold / jailed / tombstoned / in arrears / not bonded), uptime vs threshold as a bullet-style figure, current priority rank and what drives it (TIP, uptime), headroom.
- **Commission panel:** accrued / paid / due figures; when `in_arrears`, a serious-status callout with the exact amount to clear and the consequence ("ineligible until paid"). `Pay commission…` opens the payment flow (§10.4) with the due amount prefilled and overpayment explained (prepays future accrual, non-refundable).
- **TIP panel:** current-epoch TIP, current rank neighbors ("500 HASH moves you above rank 6"; computed from the sorted list, display-only), `Pay tip…` flow with the per-epoch reset and non-refundability called out.

### 8.6 Jail Watch (route `/jail`)

- **Open reports table:** valoper + moniker, reported at, purge-ready countdown (`purge_ready_at_seconds`), live jailed status (staking query), and the purge action. The two-phase rule is explained inline: purge requires still-jailed at execution; an unjailed validator's report clears (contract §9.8).
- **Report card:** pick any enrolled validator observed jailed (the console pre-filters to `jailed = true` rows) and submit `ReportJailedValidator`.
- **Purge flow:** `PurgeJailedValidator` with optional `claimant_valoper`; the claimant selector lists only validators whose operator is the connected address and which are currently eligible, showing the claimant's headroom ("redelegates up to N HASH to you, unbonds the rest"). Without a claimant the button reads `Unbond full program stake` and is warning-styled.

### 8.7 Admin (route `/admin`, admin only)

Every control is danger- or warning-styled and confirm-gated (§10.4). The page opens with a reminder that authority is the `x/group` policy: the console builds the message, the group process executes it (**DECIDED §14.6**: compose-message-JSON for a group proposal is the production path, with the App's governance center linked as the acting surface; direct execute renders only when the connected address literally equals `Config.admin` — the devnet plain-account shape).

- **Config editor:** a form of every `UpdateConfig` field, prefilled from `Config {}`, with a **diff preview** (old → new, only changed fields are submitted) and per-field explanations and units (bps fields show the % equivalent live).
- **Halt / resume:** `SetHalted` toggle with the blast radius listed (stops `RunEpoch`, continuations, `ServiceRedemptions`, purge).
- **Vault pause / unpause:** with the reason input for pause; shows current vault paused state before acting.
- **Recovery:** `ClearPendingDelegations` with the §9.9 explanation (safe: withdrawn nhash stays in the contract; the next epoch's return settlement reconciles the receipt) and a typed confirmation.

### 8.8 Governance (route `/governance`, Monitor group; PR 8.4b)

Read-only; the LIVE plane only, which is precisely its engineering value next to the App's indexed mirror: "what does the chain hold *right now*", raw JSON behind every derived figure (§9.6). No write surface — proposal composition stays §17.3 deferred and the App owns the acting flow.

- **Header, three states never conflated** (chain-facts §x/group 8): a 404 on `group_policy_info(Config.admin)` is the plain-account FACT ("no group behind this deployment", a valid state); every other failure renders "could not check"; a governed topology renders group id, total weight, the policy set **as discovered** (set-valued, ≥2 under D25, no expected-count assertion) and members with weights.
- **Proposals** per discovered policy, paginated to exhaustion under an explicit page cap; a cap hit renders a "truncated" label, never a silent drop and never a prune inference (§x/group 3, 9).
- **Tallies:** an OPEN proposal's tally comes only from the Tally query — `final_tally_result` is zeros until the module tallies and rendering them would assert "nobody voted" (§x/group 7); a closed proposal shows its recorded final tally; a failed per-row tally read degrades that row with a reason, the list survives. Votes render only while SUBMITTED (deleted at the tally, §x/group 2). Voting-period-end countdowns per §11.5.
- **The pruning caveat is standing panel copy:** an executed/rejected proposal is pruned in its own transaction, so this panel structurally cannot show outcome history — the honest empty state names the App's governance center as the durable record (§17 honesty applied to absence).
- Gated by `apps/console/test/governance-state.test.ts` (the honesty matrix: 404 vs unavailable, zeros-tally, truncation labels).

---

## 9. Data Layer

### 9.1 Query → page mapping and poll tiers

| Query | Tier | Consumed by |
|-------|------|-------------|
| `EpochStatus {}` | fast (10 s) | health strip, banners, epoch page, guards |
| latest block | fast | freshness footer |
| `Validators {}` | medium (30 s) | validators page, desk, overview counts, jail pre-filter |
| `JailReports {}` | medium | jail watch, banner |
| vault pending swap-outs + estimates | medium | redemptions page, reserve panel |
| contract delegations / unbonding | medium | deployment split, validator delegation column |
| marker liquid balance | medium | reserve/expedite display |
| `EpochSnapshot {}` / `Apr {}` | slow (300 s), plus refresh on `epoch_index` change | overview charts, epoch page, ledger append |
| `Config {}` | slow | parameters, guards, role detection |
| vault config (NAV inputs, delay, paused) | fast for paused flag, slow for config | banners, NAV tile, redemption maturity |

Every successful execute triggers an immediate out-of-band refresh of the queries its action affects (e.g. `RunEpoch` → `EpochStatus`, `EpochSnapshot`, `Apr`, `Validators`, delegations).

### 9.2 Poll scheduler

One scheduler owns all polling: per-tier timers, jittered ±10% to avoid thundering herds against the LCD, paused when the tab is hidden (Page Visibility API) with an immediate full refresh on return. Failures retry on the next tick; consecutive-miss counts feed the freshness contract (§9.4). All in-flight requests for a query are deduplicated.

### 9.3 Epoch ledger (IndexedDB)

- One database per `chain_id` + `contract_address` (epoch indices restart on every deployment; devnet redeploys and multi-network use must never mix histories). Store `epochs`, key `epoch_index`, value = the raw `EpochSnapshot` plus `net_apr_bps`/`gross_apr_bps` captured from `Apr {}` at observation time and the console's `observed_at`.
- Append when a polled snapshot's `epoch_index` is not yet stored; snapshots are immutable once written (the contract overwrites its single slot; the console never does).
- The ledger is per-origin, per-browser, best-effort. Charts and the history table must handle 0 rows (explanatory empty state), 1 row (single point, no trend), and N rows.
- `[DECIDE §14.5]`: optional backfill by scanning historical `RunEpoch` transactions for snapshot events.

### 9.4 Freshness contract

Every hook exposes `fetchedAt`. The footer shows the oldest fast-tier age. When any fast-tier query misses `stale_after_misses` (3) consecutive polls, the STALE banner raises and every derived control's guard preflight degrades to disabled-with-reason ("data stale; refusing to submit against unknown state"). Numbers on screen never blank on staleness; they dim and carry the stale badge, because a stale-but-labeled number beats a spinner.

### 9.5 Derived metrics (formulas)

All arithmetic in `BigInt`; division renders via explicit scale-then-floor. `HASH(x) = x / 1e9` formatted with locale grouping and unit.

1. **NAV per share** = HASH per whole nvHASH: `tvv × 10^(share_exponent − denom_exponent) / total_shares` (= `tvv × 1e6 / total_shares`), displayed to 4 decimals; reads 1.0000 at neutral NAV. Vault query preferred (`total_vault_value` / `total_shares`, verified on devnet); fallback: `EpochSnapshot.tvv_after / total_shares`.
2. **APR display** = `net_apr_bps / 100` % (likewise gross). The tile caption carries the window: "annualized over the last `window_seconds` window". **Minimum-window rule:** when `window_seconds` < 86,400 (one day), render "n/a (window too short to annualize)" instead of the figure — sub-day windows (drill chains, off-cadence cranks) annualize to absurd numbers that erode trust in the honest ones.
3. **Next run eligibility** = `last_run_seconds + min_run_interval_secs`, rendered as a countdown; already-eligible renders "eligible now". When `phase = Releasing`, eligibility is immediate (continuation bypass).
4. **Receipt invariant** = `receipt_minted` vs (delegated total + unbonding total + undeposited contract-held deploy remainder). Rendered as matched/unmatched with the delta; a mismatch is a warning pill, not an error, since in-flight legs legitimately skew it between cranks (tooltip explains).
5. **Epoch identity check** = `tvv_after == tvv_before + rewards_deposited − write_down` (contract §9.10). Boolean pill on the epoch page.
6. **Funded/unfunded per redemption** = allocate the principal marker's liquid nhash across the queue in order, each request consuming `estimate × (10000 + 50) / 10000`; a request is funded when fully allocated. This mirrors `plan_service` (contract §8) for display only.
7. **Uptime display** = `uptime_bps / 100` % to 2 decimals; the threshold marker at `performance_threshold_bps`. Null renders a "no data" placeholder with a tooltip explaining that uptime could not be determined for this validator.

### 9.6 Error taxonomy

Network error (retry next tick, feed staleness), decode error (log, render the section's error state with the raw payload behind a disclosure), contract query error (render verbatim in the section error state), tx errors (§10.2). Section-level error states never take down the page; each panel fails independently.

---

## 10. Control Surfaces & Transaction Flows

### 10.1 Wallet integration

A minimal adapter interface: `connect() → address`, `disconnect()`, `signAndBroadcast(msgs, fee, memo) → txhash`. Implementations (decided §14.1): the **Figure browser extension** in v1 (Keplr/Leap fast-follow behind the §14.1 certification checklist), plus a devnet direct-key signer enabled only by the devnet build profile (§7) and visually marked (persistent warning chip "devnet key mode"). The console never handles mnemonics or keys outside that devnet mode; production signing happens entirely in the wallet extension.

### 10.2 Transaction lifecycle

1. **Build:** typed `ExecuteMsg` construction; funds attached only for `PayCommission`/`PayTip`.
2. **Simulate:** against the LCD, and use the returned fee **verbatim** — `[RESOLVED 2026-07-27, Ira]`, replacing "fee = gas × `gas_price` with a 1.3 adjustment factor". Under Provenance flat fees the required fee is a deterministic **per-message** cost (`x/flatfees` `CalculateMsgCost`), unrelated to gas consumed, and `Simulate` returns **that fee amount** in the gas-wanted field — which is why the chain's guidance is a gas price of exactly **1nhash** (provenance [`internal/antewrapper/utils.go`](https://github.com/provenance-io/provenance/blob/5e8f6b621e0d04dcd5531f56337d554cfb01aac1/internal/antewrapper/utils.go#L126) `GetGasWanted`; the antewrapper then substitutes a real gas limit). So: **no configurable price** (§7), **no adjustment factor** — padding a deterministic cost buys no out-of-gas headroom because the figure is not gas — and `gas_limit` equals the fee amount. A tx priced off the old `price × gas estimate` model is **rejected** by the protocol, not merely overpriced. `apps/web` implements this basis in `app/tx/simulate.server.ts`, gated by `test/tx-fee.test.ts`; mirror it when the §14.1 adapter lands here. Simulation failure surfaces the contract error *before* signing (most guard violations are caught here even if preflight missed them).
3. **Confirm:** the tiered confirmation of §10.4 shows the human-readable action, the exact message JSON behind a disclosure, and the fee.
4. **Sign & broadcast** via the adapter.
5. **Track:** poll for inclusion; toast progresses pending → success (with explorer link) or failed (with the raw log behind a disclosure). Success triggers the §9.1 targeted refresh.

### 10.3 Guard preflight (per action)

Buttons render one of: **enabled**, **disabled with reason** (the reason is always specific and, when temporal, carries the time it clears), or **hidden** (role not met). The contract remains the enforcement boundary; preflight is UX.

| Action | Preflight (all must hold to enable) |
|--------|--------------------------------------|
| `RunEpoch` | not `halted`; and (interval elapsed OR `phase = Releasing`); data fresh |
| `ClaimRewards` | data fresh (no other guard) |
| `ServiceRedemptions` | not `halted`; data fresh |
| `CaptureUptimeSignal` | always enabled (early calls are accepted no-ops; the button caption shows time until the next accepted capture) |
| `ReportJailedValidator` | target currently `jailed` per live data (otherwise the call is a clearing no-op; offered only from jailed rows) |
| `PurgeJailedValidator` | report exists; `now ≥ purge_ready_at`; target still `jailed`; not `halted`; claimant path additionally: claimant eligible and operated by the connected address |
| `PayCommission` / `PayTip` | validator enrolled; amount > 0; wallet balance ≥ amount + fee |
| `RegisterParticipation` | valoper exists on chain; not already enrolled; connected address matches the valoper key payload |
| `UnregisterParticipation` | enrolled; connected address is its operator (or admin) |
| Admin actions | connected address = `Config.admin`; plus action-specific state (e.g. `PauseVault` requires unpaused) |

### 10.4 Confirmation levels

- **Standard** (cranks, register, capture, report): single confirm sheet with message + fee.
- **Warning** (payments, unregister, claimant-less purge): confirm sheet adds an explicit consequence line in warning styling ("Non-refundable. Funds sweep into vault principal at the next epoch." / "Unbonds the full program stake for ~21 days.") and requires a checkbox acknowledgment.
- **Danger** (all admin actions): consequence list plus typed confirmation (the action name), danger styling throughout.

---

## 11. Design Language

The complete visual and interaction definition, kept deliberately small. Treat it as normative: where a value is given, use it; where a rule is given, do not improvise around it. The palette is the validated reference instance of the repository's dataviz method; **any palette change must re-run `validate_palette.js` for both themes before shipping** (§11.6.5).

The console is an austere operator UI: system fonts, a handful of ink and status colors, flat surfaces, dense tables, and a few hand-rolled charts. There is no brand color, no display typeface, and no decorative treatment. The audience is technical and the purpose is verification; the design gets out of the way of the numbers.

### 11.1 Principles

1. **Numbers are the interface.** The console is figures, tables, and a small number of charts. No decorative imagery, no gradients, no cards-for-cards'-sake.
2. **State is always visible.** Freshness, guard state, and program health are ambient (footer, pills, banners), never hidden behind interactions.
3. **Calm by default, loud only when true.** Status colors appear exclusively when their condition holds. A healthy console is almost monochrome.
4. **Both themes are first-class.** Light and dark are separately selected token sets (§11.2); components reference tokens only, never raw hex.
5. **Text wears text tokens.** Values, labels, and legends stay in ink colors; colored marks and pills carry state. Series/status color is never applied to prose.

### 11.2 Color tokens

Chrome and ink (from the reference palette):

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--page` | `#f9f9f7` | `#0d0d0d` | page plane |
| `--surface` | `#fcfcfb` | `#1a1a19` | panels, tables, charts |
| `--ink-1` | `#0b0b0b` | `#ffffff` | primary text, figures |
| `--ink-2` | `#52514e` | `#c3c2b7` | secondary text, captions |
| `--ink-3` | `#898781` | `#898781` | axis labels, muted meta |
| `--grid` | `#e1e0d9` | `#2c2c2a` | hairline gridlines, dividers |
| `--baseline` | `#c3c2b7` | `#383835` | chart axes, table header rule |
| `--border` | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` | hairline component rings |
| `--accent` | `#2a78d6` | `#3987e5` | links, primary buttons, focus ring, active-nav indicator (also chart categorical slot 1) |
| `--delta-up` | `#006300` | `#0ca30c` | positive delta text |

There is no brand-accent color: `--accent` (blue) carries links, primary actions, and active chrome, and doubles as chart categorical slot 1. Because status is always icon + label (§11.5), an accent-blue mark is never confused for a status.

Status palette (reserved for state, never for chart series):

| Token | Hex (both modes) | Program semantics |
|-------|------------------|-------------------|
| `--status-good` | `#0ca30c` | eligible, active, funded, identity-check pass, phase Idle |
| `--status-warning` | `#fab219` | in arrears, stale data, non-mainnet badge, open jail report, invariant skew, phase Releasing |
| `--status-serious` | `#ec835a` | jailed, vault paused, ineligible |
| `--status-critical` | `#d03b3b` | tombstoned, contract halted, identity-check fail, tx failed |

Status colors always ship with an icon and a text label (pill component, §11.5); color never carries state alone. On light surfaces, warning and serious are sub-3:1 by design; the icon + label pairing is the mitigation.

**Incident-severity mapping note (CO-24, confirmed 2026-08-14, PR 8.4b).** The indexer's incident vocabulary is three-valued (`info | warning | critical`) while this table is four-valued; the recorded rule is **serious-class conditions carry `warning` severity in the incident vocabulary** — the console's serious *rendering* stays a display concern. As built: `reconciler_divergence` and `contract_halted` are critical; `indexer_lag`, `slash_write_down` and `vault_paused` are warning; `redemption_refund` is info. Each maps to this table's class as its condition column already states.

**Theme selection is an explicit three-way control** in the top bar (§8.0): **Auto** (default, follows `prefers-color-scheme`), **Light**, and **Dark**. The choice persists to `localStorage`; Light/Dark set `data-theme` on the root, Auto clears it and lets the media query decide. Every token is defined once per theme; the dark set is separately validated steps, not an inversion.

### 11.3 Typography

- **Two families, by role:**
  - **System sans** `--font-sans: system-ui, -apple-system, "Segoe UI", sans-serif` for everything — figures, page and section titles, body, tables, captions, pills, and all prose. No web font, so text paints on the first frame.
  - **Monospace** `--font-mono: ui-monospace, "SF Mono", monospace` for addresses, hashes, and raw message JSON.
- **Scale:** 28/36 headline figure; 20/28 page title; 16/24 section title (600 weight); 14/20 body; 12/16 caption and axis; 11/16 pill label (600, +2% tracking, no uppercase-only text).
- **Figures:** `font-variant-numeric: tabular-nums` on every table numeric column, countdown, and axis tick; proportional figures in prose.
- **Number formatting:** locale grouping; HASH amounts to 2 decimals in tables and 4 in the NAV tile; bps → % to 2 decimals; timestamps as absolute local time with relative time ("3d 2h ago") as the primary display and absolute in the tooltip.

### 11.4 Layout, spacing, shape

- **Base unit 4px.** Component padding 12/16; panel padding 20; page gutter 24; section gap 24.
- **Panel heading spacing.** Every panel title (§11.3, the 16/24 section title) carries a **12px gap between the heading and the panel body**. That gap belongs to the panel **header row**, not to the title element: a panel title may sit alone, or share a header row with a right-aligned actions cluster (a chart's table toggle, a range selector). Both forms must space identically. This is a normative rule because it is a real defect class: if the 12px is hung on the title element via a direct-child selector (`.panel > h2`), it silently disappears the moment the title is nested inside a header-row wrapper for its actions, and the first line of body content (a pill row, the health strip) crowds the heading. Style the header wrapper, not the title, so the gap survives regardless of whether actions are present.
- **Grid:** 12-column, max content width 1280px centered. Breakpoints: ≥1280 full layout; 768–1279 the nav collapses to icons and tile rows wrap 2-up; <768 single column, nav becomes a top drawer, tables scroll horizontally inside their panel (`overflow-x: auto`; the page never scrolls sideways).
- **Shape:** radius 8px panels, 6px controls, 999px pills. Elevation is **flat**: panels are `--surface` + 1px `--border` ring; no drop shadows except the confirm sheet overlay (24px blur at 20% black).
- **Density:** tables are dense and scannable — 40px rows (36px on <768), 12px cell inline padding, a 600-weight header row with a `--baseline` bottom rule, a `--grid` hairline between rows, and a 4% ink hover wash (§11.7). Numeric columns are right-aligned tabular figures. The Overview uses the same density; there is no separate "calm" register to maintain.

### 11.5 Components

- **Stat tile:** label (caption, `--ink-2`), value (28px headline or 24px figure, `--ink-1`), optional caption line (delta or context, `--ink-2`; positive deltas may use `--delta-up` text). No borders between number and label; one tile = one number.
- **Status pill:** 11px 600 label + 12px icon, 999px radius, background = status color at 12% opacity, icon + text at the full status color (dark mode: 20% opacity background). Never color-only: the label states the condition ("eligible", "in arrears", "jailed").
- **Address chip:** monospace truncated middle (`pb1abc…xyz9`), copy-on-click with a transient "copied" caption, explorer link on the expansion.
- **Buttons:** primary (accent background, white label), secondary (surface + border, ink label), warning/danger (status color background at full strength, white label). Disabled = 40% opacity + `not-allowed` cursor + **always** an adjacent reason caption or tooltip (§10.3); a disabled control without a reason is a defect.
- **Countdown:** tabular figures, updates each second only while visible, switches to the "eligible now" / "ready" state inline.
- **Banner:** full-width, status-tinted background (12% opacity), icon + one sentence + optional action link; stacks at most two (§8.0).
- **Toast:** bottom-right, one per transaction, pending spinner → success/failed with explorer link; failed toasts persist until dismissed.
- **Confirm sheet:** centered modal, max 480px; title = action name; body = consequence lines, fee, message JSON behind a disclosure; §10.4 tier styling.
- **Empty / loading / error states:** every panel implements all three. Loading = skeleton blocks (no spinners inside panels); empty = one sentence + the reason ("No epochs recorded yet in this browser. History accrues as epochs run."); error = the section-level error card with retry.

### 11.6 Charts

Hand-rolled SVG, self-contained (no external assets), theme-aware via the tokens. Forms are fixed per metric; do not substitute.

#### 11.6.1 NAV over time: step-after line

NAV changes stepwise at epoch cranks (contract §5), so the line is **step-after** (horizontal to the next epoch, then vertical). 2px line in categorical slot 1 (`--accent` hue), no area fill, no markers except an 8px hover marker with a 2px `--surface` ring. Y axis does not start at zero (NAV lives near 1.0); the axis is labeled and the baseline de-emphasized to avoid implying a zero base. Single series: no legend box; the panel title names it.

#### 11.6.2 Epoch value decomposition: signed horizontal bars

One row per component (rewards, commission, TIP, AUM estimate, write-down), bars extending right for inflows and left for drags from a shared zero axis. Inflows use the sequential blue (`#2a78d6` light / `#3987e5` dark); drags use the diverging red pole (`#e34948` / `#e66767`); zero-valued rows render a hairline tick, not an invisible bar. Direct value labels at each bar end (ink tokens, never bar color). 4px rounded ends on the value end only, square at the zero baseline; 2px surface gap between bars.

#### 11.6.3 Deployment split: single stacked horizontal bar

Segments in fixed categorical order and hue: delegated (slot 1 blue), unbonding (slot 3 yellow), liquid (slot 2 aqua), pending deploy (slot 5 violet). 2px surface gaps between segments; a legend row beneath with the value beside each swatch (light-mode aqua/yellow are sub-3:1, so the visible labels are the mandated relief). Hover per segment.

#### 11.6.4 History charts (net APR by epoch, net deposits by epoch)

Vertical bars per epoch from the ledger. Net APR: single-hue sequential blue. Net deposits: **diverging**, blue above zero (net inflow), red below (net outflow), gray `#f0efec`/`#383835` midline. 4px rounded data ends anchored at the baseline, 2px gaps, ≥8px bar width; when the ledger exceeds ~40 epochs, aggregate to a coarser bucket rather than shrinking bars below 8px. Date-range filter (presets: all, last 12, last 6) in one row above the charts; filtering never recolors series.

#### 11.6.5 Chart rules (all charts)

- Hover layer by default: crosshair + tooltip on the line chart; per-mark tooltip on bars/dots. Tooltip = surface card, 12px padding, values in ink tokens with the series swatch beside each entry. Hit targets at least 24px wide regardless of mark size.
- Legends present for ≥2 series; single series titled, not legended. Direct labels for ≤4 series where space allows; never a number printed on every point.
- One value axis per chart. Never dual-axis; two measures = two charts.
- Grid: horizontal hairlines only (`--grid`), 4–6 ticks, no vertical gridlines on time axes.
- Categorical hues assigned in the fixed slot order above, following the entity, never re-assigned by filtering or rank. Dark mode uses the dark-column steps (§11.2), not a brightness flip.
- **Palette validation is a build gate:** any change to chart colors re-runs `validate_palette.js` against both surfaces (`#fcfcfb`, `#1a1a19`); adjacent-pair CVD ≥ 12 target, and any sub-3:1 contrast slot must carry direct labels or a table alternative.
- Every chart panel offers a **table-view toggle** (the same data as an accessible table); the universal fallback for CVD, print, and screen readers.

**Uptime strip (Validators page).** Per-validator dot strip: one row per validator, an 8px dot at its uptime percentage on a shared 90–100% scale, a 2px vertical threshold line at `performance_threshold_bps` in `--ink-3`, dots below threshold get the serious status ring + the row's ineligible pill (never color alone). Null uptime renders "no data" text in the plot gutter.

### 11.7 Motion & interaction

- Transitions 150ms ease-out, applied to hover washes, pill state changes, sheet entry (translate + fade). No chart entrance animation except an optional 200ms bar-grow; no looping or ambient motion anywhere. `prefers-reduced-motion` disables all transitions.
- Focus: 2px `--accent` ring, 2px offset, on every interactive element; full keyboard operability (tables row-navigable, sheets trap focus, Escape closes).
- Hover on table rows = 4% ink wash; on chart marks = the §11.6.5 tooltip layer.

### 11.8 Voice & microcopy

- One register: plain and exact. Program jargon ("crank", "drain order", "write-down") is fine — the audience is technical — with first-use tooltips for the rarer terms.
- Empty and disabled states always state the reason and, when temporal, the horizon ("Run epoch available in 26d 11h").
- Errors are verbatim from the chain behind a "details" disclosure, with a one-line human summary in front.
- No exclamation points, no marketing adjectives. Numbers carry the enthusiasm.

---

## 12. Trust & Security Model

- **The contract is the enforcement boundary.** Nothing in the console grants authority: admin controls are rendered for the admin address as a convenience, but every gate is enforced on chain. Hiding a button is UX, not security.
- **No key custody.** Production signing happens in the user's wallet extension; the console never sees key material. The devnet direct-key mode is compile-time excluded from production builds and visually marked when active.
- **The LCD endpoint is the trust root for reads.** A malicious or broken node can misrepresent state (it cannot move funds). Mitigations: the endpoint is program-operated and pinned per deployment (§7); the freshness contract (§9.4) refuses writes against stale data; the block-height footer makes a stalled node visible. Multi-endpoint cross-checking is a deferred enhancement (§17.3).
- **Transaction preview is total:** the exact message JSON and funds are shown before signing (§10.2); the console never signs anything it did not render.
- **Self-contained delivery:** no third-party CDNs, fonts, or analytics; a strict CSP (`default-src 'self'; connect-src <lcd_url>`) so the only network peer is the configured node. **The `connect-src` value is GENERATED per profile** (PR 8.4b): `index.html` carries a token that `vite.config.ts` replaces from `build/csp.ts`'s `connectSrcFor(mode, VITE_LCD_URL)` — one source shared with the data plane, exact origin only, `localhost` only in the devnet profile, and the build THROWS on a wildcard, blanket scheme, or unparseable URL (gated by `test/csp.test.ts`, including a case over the built HTML). 8.4's deploy profiles additionally emit the same policy as a response header. Typography is system fonts only (§11.3) — nothing to load, no `font-src` exposure. No cookies; `localStorage`/IndexedDB hold only theme (Auto/Light/Dark), ledger, and wallet-connection hints.
- **Display-only mirrors are labeled.** Values the contract itself mirrors from config rather than measuring (e.g. `aum_fee_bps`, the 50 bps margin) are captioned as such, matching the contract spec's honesty about them.

---

## 13. Constraints Summary

Protocol and platform facts the design must respect:

- **Smart queries over LCD** are `GET /cosmwasm/wasm/v1/contract/{addr}/smart/{base64url(json)}`; responses wrap the contract's JSON under `data`. The LCD must send CORS headers for the console origin **[VERIFY §14.2]**.
- **`Uint128`/`Int128` arrive as decimal strings** and exceed `Number.MAX_SAFE_INTEGER` in realistic TVV ranges; all amount math is `BigInt` (Decision 8). `net_deposits` is signed.
- **Rates are bps** end-to-end in the contract interface; percent is a display conversion only.
- **1 HASH = 1e9 nhash**; share amounts are a distinct scale (the vault's `ShareScalar` mints 1e6 base shares per nhash — verified against `utils/shares.go` and live devnet mints, 2026-07-09). Shares display as whole nvHASH at exponent 15 (1 nvHASH = 1 HASH at neutral NAV) and are never converted through NAV except where the spec says "estimate". On-chain bank metadata for the nvHASH unit is set at bootstrap through the vault's `SetShareDenomMetadata` operation (vault-admin gated; the share marker itself carries no ADMIN grant, so the bank-level route is the vault, not the marker module).
- **`phase` is the Debug string of the contract enum:** exactly `"Idle"` or `"Releasing"`; treat unknown values as a warning-pill state, not a crash.
- **`EpochSnapshot`/`Apr` are `None` before the first crank**; every consumer has a pre-first-epoch state.
- **Single-snapshot retention on chain** (§5.3): history is a client responsibility.
- **The pending swap-out queue is paginated**; the console must page to exhaustion (limit 100 per page, matching the contract's own reads) before computing reserve math, or label the computation partial.
- **Block time ~5s**; poll tiers (§9.2) are sized to that, and countdown displays tolerate ±1 block of skew.
- **Users pay gas**; there is no fee-grant mechanism in v1. Fee estimation per §10.2.
- **Vault pause blocks user swaps and pending payouts** (contract §8, §9.9): the paused banner explains both effects, since depositors will otherwise read a skipped payout as a failure.

---

## 14. Open Decisions Before Build

1. **[DECIDED 2026-07-14, Ira] Wallet support set.** Per the standing recommendation: v1 ships **one extension wallet — the Figure browser extension** (Provenance-native, no custom chain config) — **plus the devnet direct-key mode for engineering** (devnet build profile only, compile-time excluded from production, §10.1). **WalletConnect v2 is not a console v1 transport:** the console is a desktop engineering tool whose production signing path is the extension; the App carries WalletConnect v2 for mobile (app §10.1/§14.1, resolved the same day), so both surfaces certify the same vendor with a per-surface transport matrix. Keplr/Leap (with Provenance chain config) are fast-follow and join only by passing the certification checklist recorded in app §14.1 — pairing, chain config, sign & broadcast of the §10 message set, exercised against a full devnet drill — on both surfaces in the same change; the checklist runs against Figure itself as the acceptance gate of the adapter build step (§15.5). Adding a vendor later amends this item and app §14.1 together. **Amended 2026-07-14 (Ira):** the program vendor set gains **Arculus** (app §14.1 amendment) as a WC v2 standards-conformance guard. Arculus is **App-surface only** — a WC v2 mobile wallet with no browser extension — so the console v1 implementations (Figure extension + devnet key mode) and the WC-v2-not-in-console decision are unchanged; the program transport matrix in app §14.1 is the record. "Both surfaces" in the fast-follow rule reads per the matrix: a vendor certifies on every surface whose transports it supports.
2. **[VERIFY] LCD surface against the deployed chain:** exact vault REST paths and response field names for vault config/NAV, pending swap-outs, and estimate-swap-out; principal-marker address derivation for the balance query; CORS posture of the program-operated node. ~~`gas_price` for fee estimation~~ — **settled 2026-07-27:** there is no gas price to verify; Provenance flat fees make the cost a deterministic per-message amount returned by `Simulate`, used verbatim (§10.2 step 2), and the `gas_price` config was removed. *Partially settled on devnet (2026-07-09): the vault route is `GET /vault/v1/vaults/{addr}` (not `provlabs.vault.v1`-prefixed) and returns `vault`, `principal` (marker address + coins, removing the derivation question), and `total_vault_value` directly; pending swap-outs at `.../pending_swap_outs`. Re-confirm on the test/mainnet build.*
3. **[VERIFY] Gas envelopes** for each execute (notably `RunEpoch` continuations near the 4M limit) so simulation-failure UX and fee display are calibrated on devnet, not guessed.
4. **[VERIFY] valoper derivation** from a connected account address (same key payload, contract §11.2) for prefilling the enrollment card, including the case where the operator key differs from the account key.
5. **[DECIDED 2026-08-14, PR 8.4b] Epoch-ledger backfill: v1 ships WITHOUT backfill.** The history-poor consequence stays, LABELED — the §11.5 empty-state copy plus the epoch anchor-miss notice (item 9), which quotes the browser's actual ledger coverage at the point the gap bites. Rationale: backfill means unbounded historical `tx_search` scans from the browser against the pinned LCD — a cost profile the App's indexer already paid properly, and §17.3 already names indexer-backed history as the durable fix. Building a second, worse indexer inside a no-backend SPA to dodge a labeled limitation would trade honesty machinery for scan load.
6. **[DECIDED 2026-08-14, PR 8.4b] Admin execution path under `x/group`: compose-message-JSON is the production path; direct execute survives only behind the literal address match.** The mechanism decides this, not preference: on every non-devnet deployment the admin is a group POLICY ADDRESS created before instantiate (liquid-staking-spec D25), and a policy address is not a wallet — no connected extension can ever satisfy `address == Config.admin`. Admin program-ops reach the chain as governance proposals, and the App owns that flow (app-spec §8.7/§14.6). The Admin panel's terminal action is "copy encoded message JSON for a group proposal", with a link into the App's governance center as the acting surface — the console's link is *verify, not act*. The direct-execute button renders only when the connected address literally equals `Config.admin`, which devnet plain-account bootstraps still satisfy for drills; nothing role-gates on topology assumptions.
7. **[DECIDED 2026-08-14, PR 8.4b] Monikers: real, from `cosmos.staking.v1beta1/Validators` (§5.2's listed query); the fabricated `monikerOf` synthesis is deleted** — a synthesized name on a verification tool is a small standing lie. Fallback is the truncated valoper in the standing address-chip form; **no identicons** (fabricated visual identity invites recognition of noise). External explorer links: the valoper via `explorerAccountBase` on row expansion only — explorer links are supplements on expansion, never the primary verification path (the console *is* the verification path).
8. **[DECIDE] Hosting and domain**, plus whether devnet/testnet builds are publicly reachable or team-only. *Partially resolved by the program's D22 (testnet builds publicly reachable — honesty surfaces are load-bearing); hosting/domain lands with 8.4's deploy profiles, which also carry the two 8.4b handoffs: the CSP response header generated from the same profile values as the meta tag, and the SPA-fallback rewrite the anchor contract's page paths need.*
9. **[DECIDED+DELIVERED 2026-08-14, PR 8.4b] Entity-anchor contract** — the console-side record of app-spec §14.13, and the grammar AUTHORITY both codebases pin by golden strings (`apps/console/test/anchors.test.ts`, `apps/web/test/verify-link.test.ts` — they cannot share code, so drift fails whichever side moved). Anchors are URL **fragments** over the existing routes (zero new server-routing surface; the SPA-fallback rewrite for page paths is 8.4's hosting requirement):

   | Anchor | Grammar | Landing view | Entity source |
   | --- | --- | --- | --- |
   | redemption request | `#req-{request_id}` | `/redemptions` queue table row | vault pending-swap-out queue |
   | validator | `#val-{valoper}` | `/validators` table row (expanded) | `Validators {}` |
   | epoch | `#epoch-{epoch_index}` | `/` epoch-history table row | the IndexedDB ledger (§9.3) |
   | proposal | `#prop-{proposal_id}` | `/governance` proposal row (expanded) | x/group live state |

   The anchor-miss state is a first-class honesty surface: on a SUCCESSFUL read that lacks the entity, the page renders a labeled notice with the entity-specific reason (queue no longer holds the request; validator unregistered or never enrolled; this browser's ledger has no such epoch — item 5's caveat at its point of impact; the chain prunes executed/rejected proposals — the App is the durable record). A still-loading or failed owning read renders NO miss notice (absence is not yet a fact). Extending the grammar is a spec amendment, not a helper.

---

## 15. Build & Verification Plan (when greenlit)

1. **Scaffold:** Vite + React + TS; token stylesheet from §11.2–§11.4 (both themes); route shell with global chrome, banners, and role gating stubs.
2. **Data layer:** typed LCD client generated against `contracts/schema/` (from `cargo schema`); poll scheduler; hooks; the freshness contract; IndexedDB ledger. Mock-mode fixtures for every query so pages are buildable offline.
3. **Pages, read-only first,** in order: Overview → Validators → Epoch/Ops → Redemptions → Jail Watch (all fully functional without a wallet).
4. **Chart components:** step line, signed bars, stacked bar, history bars, dot strip, per §11.6; run the palette validator for both modes as a CI gate; verify every empty/1-point/N-point state.
5. **Tx layer + wallet adapter:** devnet key mode first, extension wallet second; guard preflights; confirmation tiers; toast lifecycle. **DELIVERED 2026-08-14 (PR 8.4b):** first-party proto/build/simulate/broadcast modules mirror-tracked against `apps/web/app/tx/*` (zero `@cosmjs/*` — the reviewed-dependency event resolved to the empty set), the Figure extension adapter on the App's certified injected surface (`signDirect` only, no amino fallback), the simulate-verbatim fee in the confirm sheet, and the devnet key mode's §10.1 "compile-time excluded" now ENFORCED (build-mode static condition + `scripts/check-bundle.mjs` in CI) rather than prose.
6. **Write surfaces:** Desk, Jail Watch actions, Admin panel.
7. **Devnet end-to-end:** run the console against the repository's dev-node docker environment through a full drill (enroll → capture → claim → run epoch → pay commission/TIP → jail report/purge → service redemptions), confirming every guard state transition renders correctly. Reuse the `contracts/drills/` scripts as the state generators.
8. **Accessibility & design pass:** keyboard walk of every flow, forced-colors and reduced-motion checks, table-view fallbacks, both themes screenshotted page by page.
9. **Testnet pilot, then mainnet** behind the §14 closures.

---

## 16. Stakeholder Personas

> The program's **canonical, build-usable personas** (the adversarial design check) are in
> [`dashboard-personas.md`](./dashboard-personas.md). This console serves
> the **Protocol Engineer** (primary) and the technical operator roles; the consumer personas
> (Evaluator, transacting Position Holder) are served by the separate App per
> [`../architecture/application-boundary.md`](../architecture/application-boundary.md). The "For / Against" framing below
> is deliberately honest about the remaining trade-offs within the console's own scope.

### 16.1 Protocol Engineer: "Theo" (primary)
*Builds and maintains the contract; verifies changes on a local devnet; monitors testnet/mainnet.*

- **For:** every number is provable from chain with a raw payload behind it; invariant and identity checks are first-class pills, not buried; every endpoint is executable with guard preflight and full message preview; the same tool serves devnet, testnet, and mainnet; a persistent environment badge and the devnet key mode make local drills fast and safe.
- **Against:** trend history is per-browser (a fresh device shows little) until §14.5; he still trusts the configured node for reads; the console is a cockpit, not automation — keepers still need their own schedulers.

### 16.2 Keeper: "Kai, the crank operator"
*Runs `ClaimRewards`/`RunEpoch`/`ServiceRedemptions` on cadence; watches for jailed validators.*

- **For:** every guard is pre-evaluated with the exact time it clears; continuation state is foregrounded so a `Releasing` epoch is never left stranded; the claim-before-run cadence hint is built into the page; jail reports carry purge countdowns.
- **Against:** the console does not schedule anything (keepers still need their own automation; the console is the cockpit, not the autopilot); simulation cannot perfectly predict gas on the largest continuation cranks until §14.3 closes.

### 16.3 Validator operator: "Pat, the reliable mid-tier validator"
*Enrolled in the program; manages eligibility and priority.*

- **For:** eligibility failures are itemized, not just a red pill; arrears show the exact amount and consequence; TIP shows what a payment buys in rank terms; enrollment is self-service with the key-payload check surfaced before signing.
- **Against:** payments are non-refundable and the UI says so loudly (a feature for the program, friction for Pat); uptime "no data" states depend on capture cadence he does not control. A friendlier consumer view of his economics, if wanted, is the App's job (boundary doc §4).

### 16.4 Admin: "Ada, the program administrator"
*Executes the `x/group` admin policy.*

- **For:** config edits show a diff, units, and % equivalents; halt/pause states and blast radii are explicit; recovery actions carry the contract-spec explanation of why they are safe.
- **Against:** group-proposal workflows may reduce the console to a message composer (§14.6); typed confirmations add friction by design. Cohort/business analytics are not here — they are the App's (boundary doc §3).

### 16.5 Technical depositor (verification tail)
*A sophisticated holder verifying a number at the chain level.*

- **For:** the console serves only the "prove it against chain" need — NAV, APR, redemption status, all from chain with raw payloads behind them; it is where the App's "verify on chain" links land.
- **Against:** consumer position-management (guided create/redeem, DEX price, history, alerts) is deliberately absent — that is the App's surface, not this one.

---

## 17. Cross-Persona Review: Points to Consider & Recommended Refinements

### 17.1 Points to consider

- **The console's honesty features are its product.** Freshness badges, guard reasons, identity-check pills, and "mirror, not measurement" captions are the whole point of a verification tool; they are load-bearing, not decoration.
- **No consumer surface to maintain.** The four-audience tension of the prior draft is gone: consumer needs moved to the App (boundary doc), so the console is uniformly dense and exact. Resist future pressure to re-add a "calm" depositor mode here — that belongs in the App.
- **The ledger asymmetry** (per-browser history) is acceptable for v1 but will confuse users comparing screenshots; the empty-state copy (§11.5) carries that explanation deliberately, and §14.5 is the durable fix.
- **A wallet-less admin viewing the Admin route** sees an access explanation, not a blank: the difference between "broken" and "not for you" is a sentence.

### 17.2 Recommended refinements (high-confidence, material)

- **R1: Guard reasons everywhere.** Ship the disabled-with-reason rule (§10.3, §11.5) as a lint-level convention: a disabled control with no reason string fails review. *Confidence: high.*
- **R2: The identity and invariant checks (§9.5.4, §9.5.5) render as first-class pills, not buried tooltips.** They are the cheapest continuous audit the program gets. *Confidence: high.*
- **R3: Table-view toggles on all charts** (§11.6.5) double as the accessibility fallback and the "give me the exact numbers" power-user path. *Confidence: high.*

### 17.3 Deferred / future enhancements (post-v1)

Console-appropriate (stay chain-truth):
- **Indexer-backed history** for cross-device trends and program-lifetime APR (backfills the client ledger; §14.5).
- **Multi-endpoint read cross-checking** (§12) and a user-configurable node field — directly useful to an engineer comparing instances.
- **Keeper automation guidance:** exportable cron/keeper configs matching the console's guard math.
- **Governance surface:** in-console `x/group` proposal composition and voting for the admin policy (§14.6).

Relocated to the App (no longer console concerns): guided swap flows, per-user notifications/alerts, DEX pricing, education, and cohort analytics (boundary doc §3).

---

## 18. References

- User personas (the adversarial design check for this console): [`dashboard-personas.md`](./dashboard-personas.md), especially §9 (Protocol Engineer); open persona trade-offs tracked in the [persona-review action register](../plans/persona-review-action-register.md).
- Console-vs-App division of responsibility (the two-surface split this spec implements): [`../architecture/application-boundary.md`](../architecture/application-boundary.md).
- Governing contract spec: `./liquid-staking-spec.md` (v1.0, baselined 2026-07-09), especially §8 (redemptions), §9.8–§9.10 (jail flow, epoch lifecycle, snapshot), §10 (commission/TIP), §11 (the full contract interface).
- As-built interface: `contracts/src/msg.rs` (`ExecuteMsg`, `QueryMsg`, response types), `contracts/src/state.rs` (`EpochSnapshot`, `EpochPhase`); JSON schema via `cargo schema` in `contracts/schema/`.
- Implementation status and verification record: `contracts/IMPLEMENTATION-STATUS.md`; devnet drills in `contracts/drills/`, dev-node tooling in `infra/devnet/`.
- Dataviz method and validated reference palette (the §11 source): the repository's dataviz skill references, including `references/palette.md`, `references/marks-and-anatomy.md`, `references/interaction.md`, and `scripts/validate_palette.js`.
- CosmJS: https://github.com/cosmos/cosmjs (`@cosmjs/cosmwasm-stargate`, `@cosmjs/stargate`).
- Provenance Blockchain docs (LCD/REST, explorer): https://developer.provenance.io/
- ProvLabs Vault module (queries the console consumes): https://github.com/ProvLabs/vault

---

*v2.0-RC1, 2026-07-10: re-baselined around the Protocol Engineer (personas §9) per the Console-vs-App split (`../architecture/application-boundary.md`). Design language substantially simplified — NUVA/Zonescan lineage, brand accent, display typeface, and dim dark variant removed (§11); consumer features relocated to the App (§17.3). Not yet certified for implementation; resolve §14 open items before certification.*
