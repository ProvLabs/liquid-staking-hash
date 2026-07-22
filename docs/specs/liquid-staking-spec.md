# nvHASH Liquid Staking Vault — Technical Specification

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/nvHASH-liquid-staking-spec.md`. Paths updated for this repository's layout.

**Version:** 1.0 (2026-07-09; supersedes RC1 2026-06-17 and RC2 2026-07-08). **Baselined: the v1 engine is implemented and verified.**
**Owner:** Ira

**Status:** Baselined 1.0. Grounded against the live `ProvLabs/vault` and `provenance-io/provenance` module source (citations in §18), implemented as the `nvhash-staking` CosmWasm contract in this repository, and verified three ways: unit and integration tests, end-to-end devnet drills of the full money path against a real Provenance chain (deposit, deploy settlement, reward NAV step, redemption, burn, expedite, jail purge, slash write-down, uniform-slot rebalance), and a chain-free multi-epoch simulation suite that has executed hundreds of millions of invariant checks across hundreds of thousands of simulated years with zero violations. Remaining pre-mainnet items are launch parameters and process (see §14), not design questions.

**Revision history.** RC1 (2026-06-17) established the architecture. RC2 (2026-07-08) replaced the delay-equals-unbonding redemption model with the ~60-day standard delay plus marker-gated expedite (§8), closing the direct-vault swap-out gap. 1.0 (2026-07-09) baselines the design as built and verified: principal mobilization is delivered through exchange-module settlements rather than the pause-gated principal-funds path (§5.1), the epoch executes as a single atomic transaction with gas-chunked continuations rather than a pause-bracketed multi-transaction cursor (§9.9), and every previously open verification item has been resolved on a live chain or is carried as an explicit launch-parameter check (§14).

**How to read this:** §1 is the at-a-glance summary. §5–§13 are the design; §9 (rebalancing engine) and §5.1 + §9.9 (settlement-based deploy and the atomic epoch) are the load-bearing mechanisms. §14 is the resolution and launch-checklist record. §16–§17 give stakeholder context; §17.3 lists deferred v2+ items.

**Where review attention is most valuable:** (1) the §5.1 receipt-token deploy accounting (the one item still gated on a ProvLabs confirmation); (2) whether single-epoch uniform-slot convergence holds under the real redelegation/`MaxEntries` constraints (§9.3); (3) the pause-window liveness model and bounded-pause safeguard (§9.9); and (4) the economic model (§10, §16–§17).

---

## 1. Purpose & Approach

This document specifies a liquid staking program for Provenance Blockchain in which users deposit HASH into a vault, receive a liquid `nvHASH` share token, and the underlying HASH is staked across a curated set of validators by a permissioned smart contract acting as the vault's **asset manager**. Staking rewards and validator-paid commissions flow back into the vault, raising the redemption value (NAV) of `nvHASH` over time.

The program has **two primary objectives, both core to v1**: (1) **secure the network** by directing stake to a fair, reliability-weighted set of validators; and (2) **give HASH holders cross-chain mobility** — `nvHASH` is bridgeable to **Base and Ethereum** (via the NUVA Labs bridge, §11.5) where a Uniswap pool can provide liquidity. Bridging is therefore not optional or deferrable: cross-chain liquidity for nvHASH is a defining purpose of the vault.

**At a glance:**

- **Vault layer (existing).** The `ProvLabs/vault` Cosmos SDK module (live on Provenance via the `edelweiss` upgrade) provides share minting/redemption, a configurable redemption delay, NAV-based share pricing, and a delegated **asset-manager** role. We *configure and integrate* it — we do not build it. Its continuous interest-rate feature is intentionally **not** used (§5).
- **Staking program (to build).** A **CosmWasm/ProvWasm** Rust contract, registered as the vault's asset manager: validator enrollment, on-chain uptime gating, commission/TIP, and a deterministic **in-contract** rebalance that drives every eligible validator to a uniform slot size each monthly epoch.
- **Deploy mechanism.** HASH leaves the vault to be staked via value-neutral **exchange-module settlements** accepted under the vault's asset-manager authority; a **HASH-staked receipt token** held by the principal marker represents the deployed capital so TVV is preserved (§5.1).
- **Value accrual.** Stepwise: realized rewards/commission/TIP are deposited directly into principal each epoch, stepping NAV up (§5).

**Two things that shape the whole design:**

1. **The hard problems are economic and protocol-design, not coding.** The principal-mobilization mechanism (§5.1), single-epoch rebalancing under Cosmos redelegation limits (§9), and redemption/unbonding liquidity coordination (§8) are the decisions that determine correctness; this spec surfaces them explicitly.
2. **This custodies user funds and validator delegations, so a third-party security audit is mandatory before mainnet** — covering both the staking contract and the NUVA Labs bridge-adapter authorization.

Delivery path: *spec → reference contract + tests on testnet → audit → mainnet* (§15).

---

## 2. Glossary

| Term | Meaning |
|------|---------|
| **HASH / `nhash`** | Provenance's native staking token (base denom `nhash`). The vault's **underlying asset**. |
| **nvHASH** | The vault **share denom** issued to depositors. Value per share rises as the HASH pool grows. |
| **Vault** | An instance of the `ProvLabs/vault` module configured for this program. |
| **Asset Manager** | The address (here, the Staking Contract) granted delegated authority over the vault. Set by the vault admin via `SetAssetManager`. |
| **Staking Contract** | The CosmWasm contract this project builds; registered as the vault's asset manager. |
| **NAV / share price** | `Net TVV / total_shares` — the redemption value of one nvHASH. |
| **TVV** | Total Vault Value, expressed in the underlying (HASH). |
| **Reserves** | Vault funds used to pay positive interest into principal. |
| **Receipt token** | The restricted marker (the **HASH-staked receipt**) used as the vault's `payment_denom` to represent HASH that has left the vault to be staked, so it still counts toward TVV. |
| **Eligible validator** | An enrolled validator currently meeting the program's performance threshold. |
| **Epoch** | The monthly cadence on which the contract reconciles rewards, recomputes eligibility, and executes a full rebalance. |
| **TIP** | A voluntary contribution a validator operator pays *beyond* the required commission. TIP is the primary priority key (per epoch, non-cumulative); **uptime performance** is the secondary/default key. Since all eligible validators target the same uniform slot, priority mainly sets **drain order** — lowest priority is unbonded first for redemption liquidity (and breaks ties / allocates capped residual). |
| **Uptime performance** | Reliability metric read **directly on-chain** from the slashing module: signed-blocks ratio over the chain's signing window (`signed_blocks_window = 34560` ≈ 2 days). Drives both eligibility (threshold) and the default priority order (tie-break beyond TIP). No off-chain oracle (§10.3). |
| **Slot** | The uniform per-validator delegation size each epoch: `slot = stakeable_total / |eligible|`. Every eligible validator targets the same slot (§9.2). |

---

## 3. Confirmed Design Decisions

The following are settled design decisions:

1. **Value accrual:** Share-price appreciation, **stepwise** at each epoch. nvHASH balances are static; realized staking rewards, commission, and TIP are **deposited directly into vault principal** — raising TVV/NAV immediately — rather than smoothed through the vault's continuous interest-rate mechanism, which this design does not use (§5). (No rebasing; NAV steps up monthly.)
2. **Performance/uptime data source:** Read **directly on-chain** from the slashing module (`SigningInfo`) — no off-chain oracle (§10.3). Admin and program-config authority use the Cosmos SDK **`x/group`** module for multi-signer approval flows.
3. **Rebalancing trigger & cadence:** Monthly full rebalance, **computed and executed entirely in-contract** (no off-chain planner) — a deterministic, permissionless function of on-chain state (§9.0).
4. **Validator distribution policy:** **Uniform slot** — every eligible validator targets the same `slot = stakeable / |eligible|` (§9.2); validators below threshold receive zero. **TIP/uptime priority** (decision 11) orders only drain (which validators are unbonded first for redemption liquidity) and tie-breaks.
5. **Commission model & enforcement:** A program-wide configured percentage of the staking rewards earned on the delegations the program directs to a validator. Operators pay this commission (and any TIP) into the vault, increasing staker returns. **Enforcement:** a **one-epoch grace period** to remit commission and associated TIP; a validator still in arrears after grace is removed from the eligible set.
6. **Redemption servicing (no reserved buffer; safety by delay sizing, not caller gating):** Redemptions queue as on-chain `PendingSwapOut` entries and are released after `withdrawal_delay_seconds`, sized to the **worst-case liquidity-mobilization window** (time to next epoch run + ~21-day unbonding + buffer ≈ **60 days**). The guarantee holds regardless of whether a redemption is routed through the staking contract or squared off **directly against the vault**: the contract reads the on-chain pending-swap-out queue each run and funds every queued request, whoever initiated it. Liquidity comes from epoch inflows (claimed rewards + new deposits returned to the pool) first and, if insufficient, on-demand unbonding of the **lowest-ranked validators**. No idle buffer slots are reserved. Once the liquidity for a queued request is actually held by the vault's principal marker, the contract (as asset manager) calls `ExpeditePendingSwapOut` to release it ahead of the standard delay: the long delay is the safety guarantee, expedite is the UX optimization (§8).
7. **Reward handling:** Auto-claim each epoch; rewards return to the pool as excess liquidity, cover redemptions, then top validators to the uniform slot — raising NAV per share (§9.5).
8. **Deliverable for this phase:** This written specification.
9. **Principal mobilization:** A **HASH-staked receipt token**, held by the vault's principal marker as an internally-priced asset (seeded 1:1 to nHASH), represents HASH removed from the vault to be staked, preserving TVV (§5.1). Deploy and return legs are **x/exchange payment settlements** accepted by the vault under asset-manager authority (`AcceptAsset`), value-neutral at the recorded 1:1 NAV and executed unpaused; verified end to end on devnet.
10. **Single-epoch convergence:** The uniform-slot end-state is reached within one monthly epoch via redelegation (sources/destinations disjoint, and the monthly cadence exceeds the ~3-week lock so entries clear each epoch — §9.3).
11. **Validator priority:** A two-key per-epoch sort — **primary: TIP amount descending** (TIP = contributions beyond required commission, non-cumulative); **secondary/default: uptime performance descending** (signed-blocks ratio read on-chain from the slashing module, §10.3). Absent TIP differences, the most reliable validators rank highest. Highest priority receives delegations first; lowest priority is unbonded first when servicing redemptions.
12. **Internal concentration sub-cap:** Target the **live chain concentration cap** (§9.7) minus a small configurable **safety offset** (`concentration_safety_offset`), giving margin so a batch of rebalancing delegations doesn't inadvertently trip the protocol threshold mid-execution.
13. **Cross-chain bridging (in scope for v1):** nvHASH is portable to **Base and Ethereum** via the **NUVA Labs** infrastructure. A dedicated bridge-adapter contract is set as the vault's `bridge_address` and uses the vault's bridge accounting (`BridgeMintShares` / `BridgeBurnShares`); NUVA Labs operates the associated destination-network contracts. The full cross-chain transit flow is **out of scope** of this document beyond the integration points below (§11.5).

---

## 4. Actors & Roles

- **Liquid staker (user):** Deposits HASH, receives nvHASH, later redeems nvHASH for HASH. Interacts only with the vault's `SwapIn` / `SwapOut`.
- **Vault admin:** Holds top-level vault authority. Sets the asset manager, toggles swap-in/out, sets bridge config. Is an **`x/group` admin policy account** (multi-signer, threshold) — see §12.1.
- **Asset manager = Staking Contract:** Executes delegations/undelegations/redelegations, claims rewards, **deposits realized returns directly into vault principal** (raising TVV/NAV stepwise — no interest-rate mechanism), and processes/expedites redemptions. Holds vault asset-manager authority.
- **Program operations (`x/group` ops policy):** Updates program configuration/thresholds via governed multi-signer flows (§12.1). It does **not** submit uptime data or a rebalance plan — uptime is read on-chain (§10.3) and the rebalance is computed in-contract (§9.0). Its authority is limited to configuration.
- **Validator operators:** Register/unregister participation; pay program commission from the rewards earned on program-directed delegations; optionally pay **TIP** beyond commission to raise priority.

---

## 5. Key Dependency: the `ProvLabs/vault` Module

The vault module supplies the share/redemption/NAV machinery. The Staking Contract is the vault's asset manager and drives it. Relevant module facts (grounded in source — see References):

- **Share model:** `SwapIn` deposits underlying (HASH) and mints shares (nvHASH) to the depositor. `SwapOut` escrows shares and enqueues a withdrawal job processed in `EndBlocker` after `withdrawal_delay_seconds`; payout burns shares. `total_shares` is the canonical supply-of-record.
- **Redemption delay:** `withdrawal_delay_seconds` is configured at `CreateVault` and updatable via `UpdateWithdrawalDelay` (admin or asset manager). Set this to the worst-case liquidity-mobilization window (**~60 days** = next epoch run + unbonding period + buffer, §8), **not** to the unbonding period; `ExpeditePendingSwapOut` releases each request early once its funds are liquid in the principal marker.
- **Value accrual — direct principal deposit (this vault does *not* use the interest-rate mechanism):** the module offers a continuous interest-rate accrual feature (`UpdateInterestRate`, min/max bounds, `DepositInterestFunds` from reserves), but **this design deliberately does not use it**. Instead, realized returns (claimed staking rewards, commission, TIP) are **deposited directly into the vault principal** (`DepositPrincipalFunds`, inside the epoch transaction's atomic pause window), which raises TVV — and therefore NAV per share — **immediately and stepwise** at each epoch. The continuous interest-rate mechanism is designed for vaults with rapid swap-in/out where you want every depositor to earn a uniform rate over any holding interval; it is unnecessary here, where value is realized in monthly steps and there is no high-frequency churn to smooth. The consequence is intentional: **nvHASH NAV steps up at each monthly epoch** when rewards are claimed, rather than drifting up continuously. *(Using the interest-rate mechanism to distribute realized yield continuously between epochs — smoothing the monthly steps — is a candidate **v2+ enhancement**, §17.3, deliberately out of scope for v1.)*
- **Direct principal adjustment:** `DepositPrincipalFunds` / `WithdrawPrincipalFunds` change principal directly but **require the vault to be paused** — so they are administrative tools, not a per-epoch path.
- **Delegated authority:** `SetAssetManager` (admin-only) assigns the contract. Once set, **either admin or asset manager** may call the asset-manager-permitted messages. This design actually uses: `AcceptAsset` (the settlement deploy/return path, §5.1), `DepositPrincipalFunds` (paused — the reward NAV step), `ExpeditePendingSwapOut`, and `PauseVault` / `UnpauseVault`. The contract additionally holds the vault's **NAV authority** (`UpdateNAVAuthority`, admin-rotated at bootstrap) so slash losses can be written down automatically (§9.9). The interest-rate messages are **available but intentionally unused** (§5).
- **AUM fee:** A protocol AUM "technology fee" (15 bps annual, ProvLabs) is accrued continuously from principal and reduces net yield. Factor this into yield reporting.
- **Receipt-token accounting:** the vault values any asset **held by its principal marker** through its internal NAV table (`GetTVVInUnderlyingAsset`), so a restricted **receipt token** settled into the marker at a recorded 1:1 price to nHASH counts toward TVV exactly like the HASH it represents. This held-asset model is the module's settlement-native mechanism for "the assets left the vault to be put to work but still back the shares," and is forward-compatible with the module's `payment_denom == underlying` convergence.
- **Safety:** Failed withdrawals refund escrowed shares; unrecoverable errors auto-pause the vault with a recorded reason.

### 5.1 Principal Mobilization — Settlement-Based Receipt Model

Native Cosmos staking requires an **account** to hold and delegate the tokens. But the vault's TVV is computed from balances at the **principal (share marker) account**. If the Staking Contract simply pulled HASH out of the principal marker to delegate it, TVV — and thus NAV — would collapse, even though the HASH is still "ours," just staked.

**Mechanism: a HASH-staked receipt token, moved by exchange settlements.** The receipt (`nvhash.staked`) is a restricted marker that is **not** an accepted vault denom: it enters and leaves the principal marker exclusively through **x/exchange payment settlements** accepted by the vault under the contract's asset-manager authority (`AcceptAsset`), and is valued into TVV through the vault's internal NAV table at a **1:1 price to nHASH seeded at bootstrap**. The vault's exact-price guardrail enforces (by cross-multiplication against the recorded entry) that every settlement trades the receipt at precisely that price, so the legs are value-neutral and auditable by construction. Because the receipt is not an accepted denom, users can never redeem into it or acquire it: receipt-denom extraction is structurally impossible, with the `nvhash.pb` receiver attribute as defense-in-depth.

The closed accounting loop, maintained every epoch:

- **Deploy (stake):** the contract mints receipt and settles it into the principal marker for an equal amount of nHASH, which it then delegates. Net TVV unchanged at deploy time.
- **Return (unstake/redeem):** matured nHASH settles back into the marker against the same amount of receipt, which the contract transfers into the receipt marker account and burns. Value-neutral again.
- **Yield:** realized rewards (plus commission and TIP) are deposited **directly into principal** (§9.5), raising TVV and stepping NAV up at each epoch — no interest-rate accrual is used (§5).
- **Slash write-down (§9.9):** receipt no longer backed by anything on chain is extracted the same epoch it is detected via a zero-priced settlement under the contract's NAV authority and burned, marking TVV down immediately. Loss recognition is never deferred: `settle + write_down == matured` every epoch.
- **Invariant (verified continuously):** `receipt outstanding == receipt held by the principal marker == receipt bank supply == nhash out on chain (delegated + unbonding + pending deployment)`, exact to the base unit.

All settlement legs execute **unpaused**; the only pause-gated operation is the reward deposit, performed inside the same atomic epoch transaction (§9.9). The full deploy/return/burn/write-down cycle is exercised end to end by the repository's devnet drills and its multi-epoch simulation suite.

---

## 6. Architecture Overview

```
                ┌──────────────────────────────────────────────┐
   HASH         │                  Vault (x/vault)              │
 ┌──────┐ SwapIn│  underlying: nHASH    share: nvHASH           │
 │ User │──────▶│  held asset: HASH-staked receipt @ 1:1 NAV    │
 │      │◀──────│  withdrawal_delay_seconds = 60 days           │
 └──────┘SwapOut│  direct principal deposit  →  NAV ↑ (stepwise) │
   nvHASH       └───────▲───────────────────────────┬───────────┘
                        │ asset-manager + NAV        │ delegated HASH
                        │ authority (AcceptAsset     │ leaves via x/exchange
                        │  settlements, Deposit-      │ settlement (receipt
                        │  PrincipalFunds, Expedite-  ▼  settles in)
                        │  PendingSwapOut, Pause/) ┌──────────────────┐
                ┌───────┴───────────┐ Delegate │   x/staking      │
                │  Staking Contract │─────────▶│  validators      │
                │  (CosmWasm,       │◀─────────│  rewards (HASH)  │
                │   asset manager)  │ Redelegate└──────────────────┘
                │                   │ reads uptime  ┌──────────────┐
                │                   │◀──────────────│ x/slashing   │
                └───────▲───────────┘ SigningInfo   │ SigningInfo  │
                        │                            └──────────────┘
            config │                       commission + TIP (HASH)
                ┌───────┴────────┐                ┌────────┴────────┐
                │ x/group policy │                │ Validator        │
                │ (admin + ops)  │                │ operators        │
                └────────────────┘                └─────────────────┘
```

**Component summary:**

- **Vault (x/vault):** existing module, configured for this program.
- **Staking Contract (new, CosmWasm/ProvWasm Rust):** the asset manager. Owns enrollment, config, **in-contract computation and execution of the uniform-slot rebalance (§9.0)**, on-chain uptime reads (§10.3), reward compounding, commission/TIP accounting, and redemption-liquidity coordination. No off-chain planner.
- **x/group policies:** the admin authority (fund administration) and ops authority (program config). The contract authorizes these messages only from the configured policy addresses. Uptime is read on-chain and the rebalance is computed in-contract — neither is governed here (§9.0, §10.3).
- **x/slashing:** the on-chain source of validator uptime (`SigningInfo`), read directly by the contract — no oracle.
- **x/staking:** native delegation target, driven by the contract via CosmWasm `StakingMsg` (Delegate/Undelegate/Redelegate) and the distribution module for reward withdrawal.
- **Bridge adapter contract (NUVA Labs, in scope):** a separate contract set as the vault's `bridge_address`. It accepts user nvHASH designated for transit and invokes the vault's bridge accounting (`BridgeMintShares` / `BridgeBurnShares`) to move the local/remote split, with paired destination-network contracts on **Base** and **Ethereum** operated by NUVA Labs. It is distinct from the Staking Contract (asset manager) — different role, different authority. The full transit/relayer flow is out of scope here (§11.5, §12.2).

---

## 7. Vault Configuration (concrete values)

| Parameter | Value | Notes |
|-----------|-------|-------|
| `underlying_asset` | `nhash` | HASH base denom; the sole valuation base (TVV, NAV, fees all natively in nHASH). |
| `payment_denom` | unset (defaults to underlying) | Collapse-compatible with the vault module's `payment_denom == underlying` direction. |
| `share_denom` | `nvhash` | Liquid staking token. Set bank metadata via `SetShareDenomMetadata`. |
| Receipt (held asset) | `nvhash.staked` | Restricted marker, NOT an accepted vault denom (§5.1). Valued via the vault's internal NAV table at 1:1 to nHASH, seeded at bootstrap; moved only by settlements and the write-down leg. The contract holds Mint, Burn, Withdraw, Deposit and Transfer on it. |
| `withdrawal_delay_seconds` | `5,184,000` (60 days) | Ceiling for worst-case liquidity mobilization: next epoch run + unbonding period + buffer (§8). `ExpeditePendingSwapOut` restores UX for funded requests. Pin the final ceiling against the live `unbonding_time` and production epoch cadence at launch (§14). |
| `asset_manager` | Staking Contract address | Set after contract instantiation via `SetAssetManager`. |
| `nav_authority` | Staking Contract address | Rotated via `UpdateNAVAuthority` at bootstrap: enables the automatic slash write-down (§9.9). |
| interest rate | **unused** (left at zero/disabled) | This design accrues value by direct principal deposit, not the vault's continuous interest-rate mechanism (§5). No `min_rate`/`max_rate` tuning needed. |
| `min/max_swap_in_value`, `min/max_swap_out_value` | program limits in HASH | Optional anti-dust / risk limits. |
| admin | `x/group` policy account | Multisig governance for top-level authority. |
| `bridge_address` | NUVA Labs bridge-adapter contract | Set via `SetBridgeAddress` (admin/group). Authorized for `BridgeMintShares`/`BridgeBurnShares`. |
| `bridge_enabled` | `true` (v1) | Enabled via `ToggleBridgeEnabled` (admin/group). Bridging to Base/Ethereum is in scope (§11.5, §12.2). |

---

## 8. Redemption & Liquidity Management

**Goal:** guarantee every queued swap-out is funded by the time it matures, **regardless of who initiated it**, with **no reserved idle buffer**. Liquidity is generated from epoch inflows and, only when needed, on-demand unbonding.

**The gap this design closes: safety by delay sizing, never caller gating.** A user can square off **directly with the vault** (`SwapIn(nhash) → nvHASH → SwapOut`) without ever touching the staking contract, so any liquidity model that depends on redemptions being intercepted by the contract is unsound. Instead, the `PendingSwapOut` queue is **on-chain state**: every service pass (the permissionless `ServiceRedemptions` keeper, and each epoch run) reads the entire queue (paginated) and mobilizes liquidity for every queued request, whoever created it. Safety then reduces to sizing the delay so worst-case mobilization always completes before maturity.

**Delay sizing (~60 days).** Worst case for a redemption arriving just after an epoch run:

```text
withdrawal_delay >= (time to next epoch run) + (unbonding period) + buffer
                 ~=  ~31 days (monthly cadence) + ~21 days         + buffer
                 ~=  ~52 days + buffer  →  60-day standard delay
```

The buffer absorbs scheduling slack (keeper cadence, entry-capacity deferrals). A delay equal to the ~3-week unbonding period is **not** safe: it leaves zero slack for the wait until an unbond can actually be started.

**Expedite is UX, not safety.** The standard delay stays at the safe ceiling; when the liquidity for a queued request has actually been mobilized, the contract (as asset manager) calls `ExpeditePendingSwapOut` to release it early: users wait only as long as mobilization really took, not the worst-case window. **Expedites are gated on principal-marker liquidity only, never on the contract's own balance.** The vault EndBlocker pays from the principal marker, so an expedite issued against contract-held funds would mature unfunded and refund (i.e. cancel) the user's redemption; since service passes are permissionless, that would be a griefing vector anyone could trigger. Gating on the marker closes it by construction.

**Reserve sizing & maturity re-pricing.** Payouts re-price at maturity NAV (which steps up at each epoch), so each queued request is reserved at its current payout estimate **plus a 50 bps margin** (`reserve = Σ EstimateSwapOut × (1 + margin)`), and the same margin gates each individual expedite, so an expedited request cannot mature short after a NAV step.

**Liquidity sources (no buffer slots):**

1. **Organic reward residual.** The slot computation stakes the **entire available balance** (§9.2) — no liquidity is reserved up front. The working float is the **small residual** that each epoch's explicitly-claimed staking rewards (§9.5) leave in the vault as they flow in. In normal conditions this organic residual covers ordinary redemption activity.
2. **On-demand unbonding of lowest-ranked validators.** When demand exceeds the residual, the contract unbonds the shortfall from the **lowest-priority validators first** (§10.2 sort: lowest TIP, then least reliable), so the highest-ranked validators keep their full slot. The 60-day standard delay covers the ~3-week unbonding lock even when the unbond can only start at the next service pass or epoch run.
3. **Concentration-undeliverable residual.** Any HASH that cannot be legally delegated (a validator already at its cap, §9.7) simply **stays liquid** in the pool, adding to available liquidity at no extra mechanism.

**Redemption path.** A user `SwapOut` (through any interface, **including directly with the vault**) escrows nvHASH and enqueues a job maturing after the standard ~60-day delay. Each service pass covers the full queue from pool liquidity first, then initiates unbonding for any shortfall; once a request's margin-adjusted estimate is liquid in the principal marker, it is expedited. The permissionless `ServiceRedemptions` keeper runs **between** monthly epochs so mobilization and expedites are not gated on the rebalance cadence.

**Failure mode is a refund, not a loss.** If a request somehow matures unfunded, the vault refunds the escrowed shares to the owner (and may auto-pause): a degraded UX (a cancelled redemption), not a fund-safety loss. The delay ceiling, full-queue reads, the reserve margin, and the marker-gated expedite exist so this path is never exercised; the contract also reassesses required unbondings against the full pending-redemption schedule on every pass, not only at request time.

**Why no buffer is needed:** the 60-day delay already exceeds worst-case mobilization, and expedite already releases a request as soon as its funds are liquid; a reserved idle buffer could only shave the mobilization time itself, which the product does not promise. Removing it puts more HASH to work earning rewards.

**Pause-window note:** the epoch executes as a single atomic transaction (§9.9), and the only paused operation inside it is the reward deposit — the vault is paused and unpaused within that one transaction and can never be observed paused between blocks. There is no depositor-visible lockout and no stalled-pause failure mode: a failure anywhere in the epoch transaction reverts it whole, leaving the vault unpaused. (The delay buffer retains headroom for operational slack regardless.)

---

## 9. Rebalancing Engine

Runs on a **calendar-month cadence**: an epoch becomes eligible to end once consensus block time (`env.block.time`) enters a **strictly later civil `(year, month)`** than the last run (`civil_month(block_time) > civil_month(last_run)`). The boundary is a deterministic function of the BFT consensus timestamp — caller-independent, not a fixed-duration interval since the last crank — so no `RunEpoch` caller can choose the epoch's duration through the permissionless entrypoint. The crank is still permissionless and the cadence only floors *eligibility*; the run itself happens whenever a caller cranks after the rollover (keeper promptness is a liveness concern). Computed and executed **entirely in the contract** (no off-chain planner). Objective: within a single epoch session, drive **every eligible validator to the same uniform slot-sized delegation**. TIP/uptime priority (§10.2) governs only drain order (which validators are unbonded first for redemption liquidity) and tie-breaks.

### 9.0 In-contract, deterministic, permissionless

The rebalance is a **pure function of on-chain state**, computed by the contract during the paused epoch (§9.9) — there is no off-chain planner and no submitted plan.

- **Why in-contract is sufficient.** The expensive part of a rebalance is the *execution* — the staking transactions under the ~4M per-tx gas limit (§9.9) — not the *planning*. The validator set is **bounded: Provenance allows at most 100 validators**, and the program's eligible set is a subset of that. Computing targets is simple O(N≤100) arithmetic (`slot = stakeable / |eligible|`, clamp to headroom, diff against current delegation), and the contract must validate every move against live limits regardless. So computing the plan off-chain saves nothing.
- **Deterministic & permissionless.** Because the plan derives only from current chain state (delegations, total bond, slashing eligibility) and contract state (TIP, enrollment), **any caller** of `RunEpoch` produces the same plan. There is **no plan-submission authority and no staleness/snapshot machinery** — the contract reads fresh state at execution time, so a plan can never be stale.
- **Inputs gathered on-chain.** Eligibility/uptime from slashing `SigningInfo` (§10.3); per-validator total bonded and current delegation from `x/staking`; TVV from the vault. With N ≤ 100 these O(N) reads are cheap and, if needed, span the first couple of transactions of the paused window — the cursor (§9.9) accommodates it.

### 9.1 Inputs
- Eligible set + uptime from slashing `SigningInfo` (§10.3); TIP amounts for drain/tie ordering.
- Total HASH available to the program (all of it is staked to uniform slots — no liquidity reserve, §9.2; the residual is organic reward inflow, §8/§9.5).
- Per-validator current delegation and concentration headroom (§9.7).
- Commission-arrears status (validators past the one-epoch grace are excluded from `eligible`, §10.1).
- *(No buffer reservation — liquidity is handled per §8.)*

### 9.2 Uniform-slot target (concentration-aware)
- `eligible = { v : enrolled(v) ∧ meets_threshold(v) ∧ current-on-commission }`.
- **Uniform slot:** `slot = available_HASH / |eligible|`, where `available_HASH` is the **entire HASH balance available to the program** (deposits + claimed rewards + returned stake) — **nothing is held back** for liquidity. Every eligible validator targets the same `slot`. The working liquidity is then the **small organic residual** that this epoch's claimed staking rewards leave in the vault (§9.5), plus any concentration-undeliverable HASH; redemption demand beyond that residual is met by unbonding the lowest-priority validators (§8), never by reserving idle HASH.
- Each validator's effective target is `min(slot, headroom)`, where headroom uses the concentration cap minus `concentration_safety_offset` (§9.7).
- **Internal sub-cap (resolved):** the contract targets the live chain concentration cap (§9.7) reduced by a small configurable `concentration_safety_offset`, so a batch of delegations (or other delegators acting in nearby blocks) cannot inadvertently trip the protocol threshold. It tracks the chain cap automatically.
- A validator that cannot reach `slot` because it is at its cap stays below; the **undeliverable residual stays liquid** (§8) and is retried as caps move. Validators not in `eligible` target 0.

### 9.3 Single-epoch convergence via redelegation
The uniform-slot end-state is reached **within the one epoch session** — not over many epochs — because of two structural facts:

- **Source/destination roles are disjoint.** Each validator is either *above* `slot` (a **source** — redelegate/unbond away, never cap-blocked since power decreases) or *below* it (a **destination** — receives redelegation/fresh delegation). No validator is both, so the **no-transitive-redelegation** rule (can't redelegate from a validator that is itself a redelegation destination) is **never triggered** by the rebalance.
- **The calendar-month cadence normally clears the locks.** Redelegations lock for the ~3-week unbonding period, which is **shorter than a calendar month (28–31 days)**, so when cranks land promptly after each rollover the previous epoch's redelegation entries have matured before the next epoch begins — each epoch starts with clean `MaxEntries` capacity (the cap is per `(delegator, validator)` pair; one rebalance creates ≤1 entry per pair, far under the limit). Because the crank is permissionless and the cadence only floors eligibility, a **late** run near a month's end followed by a **prompt** run after the next rollover can compress the inter-crank gap below the unbonding period; that case is held safe by the plan-time defensive guards below (a compressed gap degrades that epoch's convergence with extra deferrals, never correctness — asserted across compressed-gap sequences in the simulation).

Execution: **redelegate** from sources to destinations (instant on the destination, keeps stake productive) and **delegate fresh inflow liquidity** to destinations until each reaches `slot`. **Unbonding is used only to raise redemption liquidity** (§8), never for rebalancing — so the staking distribution converges in-epoch while redemption draws follow the ~3-week unbonding path, which the ~60-day redemption delay comfortably covers (§8). The only case where uniformity is temporarily imperfect is a destination blocked by its concentration cap; that residual stays liquid until caps move.

The no-transitive-redelegation rule and MaxEntries route capacity are additionally enforced **defensively at plan time**: the contract reads its live redelegations each epoch, pins any validator with an in-flight inbound entry (it cannot legally be a source yet) and routes around any (src, dst) pair at entry capacity, deferring rather than emitting a move the chain would reject. Both behaviors are verified live on devnet (the transitivity deferral was asserted directly) and continuously by the simulation suite. Confirm the mainnet `unbonding_time` and `max_entries` values at launch (§14); the design only requires `unbonding_time < epoch` for prompt cranks, which holds with margin at the calendar-month cadence (~21 days vs 28–31). A compressed gap from a late-then-prompt crank is handled by the defensive deferral above, not by the spacing assumption.

### 9.7 Provenance validator concentration cap (hard protocol limit)

Provenance enforces a custom staking restriction (`StakingRestrictionHooks.AfterDelegationModified`) absent from stock Cosmos. It caps how much voting power any single validator may hold and **rejects** delegations/redelegations that would breach it.

- **Per-validator max bond:** `maxBond(v) = totalBondedTokens × maxValPct`.
- **`maxValPct = clamp( MaxConcentrationMultiple / activeValidatorCount , MinCap , MaxCap )`** with current defaults `MaxConcentrationMultiple = 5.5`, `MinCap = 0.05` (5%), `MaxCap = 0.33`. Examples: ≈8.1% at 68 validators; 5.5% at 100; the **5% floor** binds beyond ~110 validators. The cap therefore **moves as validator count and total bonded supply change**.
- **Trigger conditions:** enforced only when active validator count ≥ 4 (and not in simapp), and **only when the validator's power is increasing** (`newPower > oldPower`). Moves that hold power flat or reduce it are never blocked.
- **Cap is on the validator's *total* bonded tokens** across all delegators — so a popular validator may have near-zero headroom for this program regardless of how little we try to add.
- **Contract obligations:** before any inbound delegation/redelegation, query active validator set size, `TotalBondedTokens`, and the target validator's current bonded tokens; compute `maxBond`, subtract the `concentration_safety_offset` (§9.2), derive headroom; clamp (possibly to zero) and redistribute the remainder (§9.2). The safety offset is what keeps a near-cap validator from tripping the threshold when other delegators consume headroom in the same block.

The three restriction parameters are mirrored in contract config (`max_concentration_multiple_bps`, `min/max_bonded_cap_bps`, defaults 5.5x / 5% / 33%) and admin-updatable, so a governance change to the chain options is followed without redeployment; confirm the live mainnet values at launch (§14). The never-rejected-delegation property (every emitted move validated against the raw cap plus the safety offset) is asserted continuously by the simulation suite.

### 9.4 Eligibility transitions
- A validator dropping below threshold becomes ineligible and drops out of the uniform-slot set; its stake is **redelegated** to the remaining eligible validators within the epoch (it is a source — never cap-blocked), not crash-undelegated, so no yield is lost.
- A validator that becomes **jailed** is the urgent case (its stake is idle immediately) and is handled off-cycle by the permissionless `PurgeJailedValidator` flow (§9.8), not left until the next monthly epoch.
- A validator returning above threshold re-enters the eligible set; the next epoch's uniform `slot` simply includes it and the rebalance brings it up to `slot`.
- **TIP changes** between epochs re-order drain priority for the next monthly epoch; they do not trigger an intra-epoch rebalance.

### 9.5 Reward handling & liquidity (per epoch)
1. **Claim all staking rewards explicitly** — call `WithdrawDelegatorReward` for **every** program delegation, **including validators that need no delegation adjustment**. *This is a correctness requirement:* Cosmos auto-withdraws a validator's pending rewards only as a side effect of a delegation change, so a validator already at `slot` (no delegate/redelegate/undelegate) would otherwise have its rewards left unclaimed and accumulating off-pool. Explicitly claiming for unchanged validators ensures no rewards are missed during epoch processing. Claimed rewards return to the pool.
2. Account **commission/TIP** owed and paid by validators (validator-funded inflows, §10) — these also land in the pool and raise NAV.
3. **Stake to uniform slots:** bring every eligible validator to `slot` (redelegate sources → destinations; delegate available HASH to destinations). The slot computation stakes the **entire available balance** (§9.2) — nothing is held back — so the working liquidity is the **small organic residual** left by this epoch's claimed rewards plus any concentration-undeliverable HASH. Realized yield raises NAV by being **deposited directly into vault principal** (`DepositPrincipalFunds`, in the pause window) — a stepwise NAV increase, not interest-rate accrual (§5).
4. **Redemption demand beyond the residual** is met by unbonding the lowest-priority validators (§8) — the only use of unbonding in the engine. (Redemptions are primarily handled off-cycle by `ServiceRedemptions`, §8; the ~60-day standard delay covers the unbonding lock, and funded requests are expedited.)

### 9.6 Determinism
All math must use integer/decimal floor arithmetic (matching the vault's pro-rata convention) to prevent share inflation or over-distribution. No floating point. Sort validators by a stable deterministic key for reproducible plans.

### 9.8 Jailed-validator response — permissionless, validator-policed

Between monthly plans a validator can be jailed for downtime (on Provenance: ~10-minute jail, no slash). Program stake left on a jailed validator is unbonded/idle and earns nothing until moved. Rather than wait for the next monthly plan, the program exposes an incentive-aligned, **two-phase permissionless cleanup** — this is the uptime mechanism with real depositor-yield impact (§12), because idle stake on a dead validator is the failure mode large enough to move returns.

**Phase 1 — `ReportJailedValidator { valoper }` (permissionless):** anyone may flag that a program validator is jailed. The contract **verifies on-chain** that `valoper` is currently jailed (staking `Validator.jailed` / slashing `jailed_until > now`); if so it records `jailed_reported_at = now` (idempotent — the first report starts the cooldown clock; later reports while still jailed are no-ops). If the validator is **not** jailed, any existing report is cleared. This phase starts the `jail_unbond_delay` cooldown but moves no funds.

**Phase 2 — `PurgeJailedValidator { valoper, claimant_valoper? }` (permissionless):** after the cooldown, anyone may trigger the move.

- **Caller:** **anyone** — a validator operator, a vault depositor, or any third party. `claimant_valoper` is **optional**.
- **Preconditions:** (a) `valoper` is **still jailed** on-chain *now*, and (b) the cooldown has elapsed: `now − jailed_reported_at ≥ jail_unbond_delay` (default 8h). If the validator has **unjailed** in the interim, the report is cleared and the purge is rejected — the validator recovered and keeps its stake. This two-observation pattern (jailed at report, still jailed after the cooldown) is what establishes *sustained* downtime, cheaply and without continuous sampling.
- **Action:** let `D` = the program's current delegation on `valoper`.
  - **If `claimant_valoper` is supplied AND the caller is its operator AND it is enrolled, eligible, and not jailed:** redelegate `min(D, H)` to the claimant (where `H` is the claimant's concentration headroom per §9.7), and unbond any remainder that would exceed the power cap.
  - **Otherwise (claimant omitted, or caller not an eligible operator):** unbond the **full** program delegation `D` from the jailed validator. This lets a depositor — who cannot receive a delegation — still penalize a jailed/poorly-performing validator by pulling program stake off it.
  - Unbonded HASH returns to the liquidity pool after the unbonding period and is re-staked at the next epoch. Respect `MaxEntries` / redelegation transitivity; any portion a redelegation cannot legally carry is unbonded instead.
- **Idempotent / race-safe:** once moved, `D` is zero and further calls are no-ops; the first caller wins.

**Accepted consequence — epoch-boundary overlap:** an unbond (or redelegation lock) initiated by this flow may straddle the monthly epoch boundary. When it does, the affected stake is still unbonding/locked at plan time, so the jailed validator effectively **misses the following epoch as well** (its stake cannot be redirected back until the lock clears). This is **considered acceptable** — a mild, self-correcting penalty that further discourages downtime and resolves automatically once unbonding completes.

**Why this is sound:**

- **Fully decentralized & incentivized:** validators are incentivized to claim (they gain program stake up to their headroom), and *any* depositor or watcher can trigger a pure unbond to protect the pool even when no validator claims — so liveness cleanup never depends on a single keeper or a willing claimant.
- **Bounded by the same caps:** a claimant can only *gain* up to its concentration headroom; the excess (or the entire amount in pure-unbond mode) unbonds, so no voting power is acquired beyond the protocol cap.
- **Trustless trigger:** jailed status is read from chain state; the caller cannot fabricate it, and the worst a malicious caller can do is unbond stake off a genuinely-jailed validator — the desired action anyway.

**Why the two-phase design (cooldown guard):** Provenance jailing is brief (~10 min, no slash) but a pure unbond strands stake for ~3 weeks plus a missed epoch. Requiring the validator to be jailed at **both** the report and the post-cooldown purge cleanly distinguishes a genuine outage from a blip — a healthy validator self-unjails within ~10 minutes and the report is cleared. `jail_unbond_delay` (**default 8h**, configurable up to ~2 days) sets how much sustained downtime is required. This sidesteps the chain-counter mechanics entirely (the slashing `missed_blocks_counter` resets on jail and doesn't advance while jailed, so it can't measure sustained downtime — but the two-observation jailed-status check doesn't need it). The optional `claimant_valoper` redelegation keeps stake productive and could use a shorter cooldown than a pure unbond.

**Resolved:** a redelegation claimant must assess fully **eligible** (enrolled, bonded, unjailed, uptime-qualified, commission-current) at purge time, and both paths share the single `jail_unbond_delay` cooldown (a shorter claim-path cooldown remains a possible v2 refinement). The safety-net pure-unbond path is built in, not optional. Both paths, the cooldown gate, and the two-observation guard are verified live on devnet against real downtime jailing.

### 9.9 Epoch execution lifecycle — one atomic transaction, chunked continuations

The epoch crank (`RunEpoch`, permissionless, min-interval guarded) executes as **one transaction end to end**. A failure anywhere — a settlement leg, a delegation, the deposit — reverts messages and state together, so the vault can never be left paused, no exchange payment survives half-settled, and the receipt counter cannot desynchronize from the moves that justify it. The message sequence inside the transaction:

1. **Claim** rewards from every delegated validator with any (including unregistered ones), accruing program commission on the exact claimed amounts (§10.1).
2. **Service redemptions**: unbond the reserve shortfall in drain-priority order (§8, §10.2).
3. **Return settlement** (unpaused): matured nHASH settles into the principal marker against an equal amount of receipt at the recorded 1:1 NAV (§5.1).
4. **Slash write-down** (unpaused, only when needed): unbacked receipt is extracted via a zero-priced settlement under the contract's NAV authority — the 1:1 entry is marked for exactly the unbacked units, the extraction settles, and the 1:1 entry is restored — then burned, marking TVV down the same epoch the loss is detected.
5. **Atomic pause window** (only when there is a deposit): `PauseVault` → `DepositPrincipalFunds` (the NAV step-up) → `UnpauseVault`, all inside the same transaction.
6. **Burn**: settled and written-down receipt is transferred into the receipt marker account and burned.
7. **Deploy settlement** (unpaused): receipt is minted and settled into the marker for the fresh-deploy budget in nHASH.
8. **Rebalance moves**: redelegations toward uniform slots, then fresh delegations, in priority order.
9. **Expedites** for every funded queued redemption.

**Gas bounding.** Provenance's per-transaction gas budget cannot fit unbounded move counts, so steps 8's redelegations and delegations execute under a configurable per-crank budget (`max_delegations_per_run`); remainders persist to pending queues drained by **continuation cranks** (further permissionless `RunEpoch` calls that bypass the interval guard while a continuation is open). Convergence is therefore single-EPOCH even when it spans several transactions. The bounded validator set (`MAX_VALIDATORS = 100`) keeps every loop within budget.

**Liveness safeguards:**
- **Permissionless progress** — `RunEpoch` and its continuations are callable by anyone, so completion never depends on a single keeper.
- **Non-blocking moves** — a move that live re-validation shows the chain would reject (transitivity, entry capacity, concentration cap) is **deferred** at plan time rather than emitted, so a crank cannot brick on an illegal move; deferred stake is retried next epoch.
- **Recovery hatch** — the admin `ClearPendingDelegations` drops stuck continuation queues (withdrawn nHASH stays in the contract and settles back next epoch; dropped redelegations simply leave stake in place); the admin `SetHalted` stops the fund-moving cranks entirely in an emergency.

**Off-cycle interaction:** `ServiceRedemptions` and `PurgeJailedValidator` act between epochs on live chain state; funds earmarked for an open continuation are excluded from their liquidity accounting so they cannot race the epoch's deployment.

### 9.10 Epoch value snapshot (value-accrual analytics)

Share-price appreciation (`NAV = Net TVV / total_shares`) is the bottom-line proof of value accrual, but it does not show *where* the value came from. Each epoch the contract captures an **`EpochSnapshot`** into persisted, queryable state (§11.3) that decomposes the change.

**Why the attribution is exact:** the epoch is a single atomic transaction (§9.9), so no user `SwapIn`/`SwapOut` can interleave with it, and the crank knows its own value moves precisely: the reward deposit and the write-down are the only TVV-moving legs (settlements and deploys are value-neutral). The identity `tvv_after = tvv_before + rewards_deposited − write_down` therefore holds **to the base unit** — the repository's devnet drills assert strict equality. Value inflows are accumulated over the whole inter-epoch window at their exact intake points (every reward claim including undelegation auto-withdrawals, every commission and TIP payment), not observed after the fact.

**Captured per epoch:**

- **Identity/time:** `epoch_index`, `started_at`/`ended_at` (seconds), `end_height`.
- **Headline value:** `tvv_before`, `tvv_after` (exact, per the identity above), `total_shares`.
- **Value sources (window accumulators):** `rewards_claimed`, `tips_received`, `commission_received`, plus this crank's exact legs: `rewards_deposited` (the actual NAV step), `settled`, `write_down`, `deployed`, `rebalanced`.
- **Drag estimate:** `aum_fee_estimate`, derived from the admin's `aum_fee_bps` mirror over the window (the module exposes no fee fields to contracts).
- **Net principal flow (between epochs) — derived from TVV, not from watching events:** `net_deposits = tvv_before(this epoch) − tvv_after(last epoch)`, a signed value. Commission and TIP funds are held by the contract (outside TVV) until the next epoch's deposit leg, so the between-epoch TVV delta is purely user swap flow, understated only by the window's continuous AUM accrual. It cannot miss anything because it is a single before/after comparison.
- **Operational context:** `eligible_count`, `redemptions_expedited`, `unbonded_for_redemptions`, `validators_purged`.
- **Derived (at query time):** the `Apr {}` endpoint reports gross APR (rewards + commission + TIP annualized over the actual window against `tvv_before`) and net APR (gross minus the AUM estimate and slash write-downs), in basis points.

**Only the most recent epoch is retained** — a single `last_epoch_snapshot` overwritten each epoch (no growing history). Its `tvv_after` is the baseline the *next* epoch reads to derive `net_deposits`, so the one record both reports the last epoch and seeds the next. Queried via `EpochSnapshot {}` / `Apr {}` (§11.3); this is the concrete delivery of the **R2 net-APR transparency** recommendation.

---

## 10. Commission & TIP Priority

### 10.1 Commission (required)

**Protocol context:** Provenance enforces a **uniform 60% validator commission** on-chain via the `wisteria` upgrade (PR #2260): all validators at 60%, max rate 60%, network minimum commission 60% (§13). This is a Provenance-specific modification, not standard Cosmos. Two consequences flow from this:
1. A delegator (including this vault) keeps ~40% of gross staking rewards on any delegation, **whether it self-stakes or uses the program** — so the 60% is not a vault-specific drag; it applies to Dana's alternative (self-staking) identically.
2. Validators cannot compete on commission rate, so **access to delegations is their only growth lever** — which is exactly what this program offers, making it especially attractive to lower-power and new validators.

- **Rate:** `commission_bps`, program-wide, configured by governance. Charged as a percentage of the **rewards earned on program-directed delegations** to a validator.
- **Paid out-of-pocket by the validator (R3 resolved):** the operator pays the program commission (and any TIP) from **their own funds** via `PayCommission`/`PayTip` — it is **not** deducted from the depositor's reward share. Combined with the uniform protocol commission, this means depositors are **not** double-charged: they earn the standard ~40% delegator share *plus* the program commission and TIP the validators pay in. For the validator the net is `60% commission earned − program fee`, positive on stake they would not otherwise hold.
- **Accounting:** Each epoch the contract computes, per validator, the rewards attributable to program delegations and the commission owed = `rewards × commission_bps`.
- **Payment endpoint:** Validator operators call `PayCommission` to pay outstanding commission in HASH; the contract deposits it **directly into vault principal** so it raises NAV for all stakers. Track `commission_accrued` and `commission_paid` per operator.
- **Enforcement (resolved):** A **one-epoch grace period**. After commission accrues for an epoch, the operator has until the end of the next epoch to remit the owed commission (and any TIP). A validator still in arrears after the grace epoch is **removed from the eligible set**; the engine then redelegates its stake away (lowest-priority treatment) over subsequent epochs. Bringing the account current restores eligibility at the next plan.
- **Attribution (verified):** the accrual base is the distribution module's per-delegator rewards query for the contract itself, which by construction contains only the rewards on the contract's own delegations — the validator's other delegators and its operator commission are structurally outside the base. Verified by controlled experiment on devnet: with the contract holding 0.31% of a validator's stake, a known reward event credited the contract exactly its pro-rata share and the program charged exactly `commission_bps` of that share, not of the validator's total.

### 10.2 TIP (voluntary, sets priority)
- **Definition:** A TIP is a contribution an operator pays **beyond** the required commission. Like commission, TIP flows into the vault and raises NAV for stakers — but its purpose is to **buy priority** in the program.
- **Ranking method (resolved, v1) — two-key sort, per epoch:**
  1. **Primary: TIP amount, descending** — measured **per epoch**; TIP does **not** accumulate across epochs.
  2. **Secondary (tie-break and default basis): uptime performance, descending** — read **directly from the on-chain slashing module** (§10.3): rank by signed-blocks reliability (fewer `missed_blocks_counter` = higher). Uses the epoch-aggregated value when the optional capture-signal flow (§10.4) has contributed snapshots, otherwise a direct plan-time read.

  Because most validators will pay equal TIP (commonly zero), uptime is the *effective default order*: absent a TIP difference, the **most reliable validators rank highest**, and TIP only reorders validators relative to that reliability baseline. In the uniform-slot model every eligible validator targets the same `slot`, so priority does **not** decide who gets *more* stake; it governs **drain order** for redemption-driven undelegation — lowest priority (lowest TIP, then least reliable) is unbonded first (§8) — plus tie-breaks and which validators absorb any concentration-capped residual.
- **Payment endpoint:** `PayTip` (HASH attached) records the validator's TIP **for the current epoch** (`tip_epoch`) and forwards funds into the vault. TIP is non-refundable and resets each epoch for ranking purposes.
- **Final tie-break:** if both TIP and uptime are equal, fall back to a stable deterministic key (over-weight position, then earliest enrollment) so plans are reproducible.
- **Future evolution:** the per-epoch TIP-then-uptime ranking is intentionally minimal for v1; a richer "community-determined method" (e.g., normalization by program stake, multi-epoch uptime smoothing) can replace it later without changing the priority *interfaces*.
- **Transparency:** per-epoch TIP amounts and resulting priority ranks are queryable (§11.3) so the community can observe the ordering.

### 10.3 Uptime data source — on-chain slashing module only (no off-chain oracle)

**Decision:** uptime is sourced **entirely on-chain** from the slashing module. There is **no off-chain performance oracle and no `SubmitPerformance` flow** — the contract reads the data directly, so the largest remaining trust assumption for this input is eliminated.

**Why on-chain is sufficient (chain params confirmed 2026-06-17):**

- `slashing Params`: `signed_blocks_window = 34560`, `min_signed_per_window = 0.95`, `downtime_jail_duration = 10m`, `slash_fraction_downtime = 0`. The window of **34,560 blocks ≈ 2 days** (at Provenance's ~5s block time) is a large, robust liveness sample — the same window the chain itself uses to decide downtime jailing. Tens of thousands of blocks per validator is statistically more than adequate for a threshold-plus-ranking signal, which is all the program needs (it does not need an exact per-epoch tally).

**What the contract reads (whitelisted, contract-reachable):**

- `/cosmos.slashing.v1beta1.Query/SigningInfo` (one validator), `/SigningInfos` (all, paginated), `/cosmos.slashing.v1beta1.Query/Params`. `ValidatorSigningInfo` exposes `missed_blocks_counter`, `index_offset`, `jailed_until`, `tombstoned`, `start_height`. Reliability = `(window − missed_blocks_counter) / window`; rank by `missed_blocks_counter` ascending. **O(validators) queries, not O(blocks).**

**How it is used:**

- **Eligibility:** a validator is uptime-eligible when its signed-blocks ratio over the window ≥ `performance_threshold` (program-configurable; should be **≥ the chain's `min_signed_per_window` of 0.95** to be meaningful, e.g. 0.98). Any validator the chain reports as `jailed`/`tombstoned` is hard-failed immediately.
- **Priority key:** the same ratio is the secondary/default sort key (§10.2).
- **When read:** at plan time the contract reads `SigningInfo` directly as the default. Because the window (~2 days) is shorter than the monthly epoch, a lone plan-time read reflects *current* reliability, not a whole-month average. The optional **capture-signal flow (§10.4)** lets anyone contribute interim snapshots so the plan-time value is a fairer epoch-wide aggregate when available.

**Residual mechanics (unchanged from the data being on-chain):**

- **Consensus-address mapping:** map `valoper → consensus pubkey` (from the staking `Validator`) `→ cons address` to key the slashing lookup; handle validator key rotation.
- **Reset on jail:** counters zero on downtime jail; treat a jailed/tombstoned validator as ineligible directly (the reset is not a data-loss problem because jailed = ineligible anyway).
- **The ratio is only meaningful for bonded validators.** The chain advances `missed_blocks_counter` only for validators in the active (bonded) set, and zeroes it on a downtime jail, so the SigningInfo of a non-bonded or freshly jailed validator reads as a vacuous 100% signed-blocks ratio (observed live on devnet 2026-07-09: two unbonded, jailed validators sampled at 10000 bps). Eligibility is unaffected (jailed/unbonded hard-fail regardless), but any consumer of the ratio beyond the hard-fail, in particular the §10.4 capture accumulator, must treat non-bonded/jailed/tombstoned validators as having **no signal**, not a perfect one.

The `valoper → cons-address` derivation (ed25519 consensus key from the staking record, sha256 truncated to 20 bytes, valcons bech32) is implemented in-contract and verified against a live chain; because the key is read from the current staking record each time, a rotated consensus key is followed automatically. The block count of 34,560 is authoritative for the window; the ~2-day wall-clock framing assumes ~5s blocks.

### 10.4 Permissionless uptime aggregation ("capture signal") — retained for fair ordering

**Purpose — fairness in the ordering, which is required:** every epoch the validators must be put in a **deterministic order** (for drain priority and tie-breaks, §10.2). If that order were not based on a *merit* signal, non-tipping validators would always sort by some arbitrary fixed key (e.g., address) and the same validators would be **perpetually last — first to be unbonded on every liquidity demand** — an unfair, persistent penalty. Uptime is the merit signal that prevents this: among equal-TIP (commonly zero-TIP) validators, ordering by reliability is fair. A single plan-time read (§10.3) already gives a uptime-based order; **this flow improves its fairness** by averaging across the epoch so a validator is neither rewarded nor penalized by one lucky/unlucky snapshot moment, and it resists snapshot-timing gaming. This is why it is **retained**, not trimmed.

**Mechanism — `CaptureUptimeSignal {}` (permissionless):**

- **Anyone may call it.** The endpoint reads on-chain slashing `SigningInfo` for enrolled validators and folds each validator's current signed-blocks ratio into a per-validator epoch accumulator (`sum`, `count`, `last_capture_height`). No special role; independent parties (validators, depositors, watchers) can contribute to a better signal.
- **Validity filter (required).** A capture records a sample **only for validators currently bonded and not jailed or tombstoned**. For any other validator the slashing counter carries no liveness information (it advances only for the active set and resets on downtime jail, §10.3), so sampling it would fold a vacuous 100% into the epoch mean and flatter a recovered validator's priority for the rest of that epoch (defect observed on devnet 2026-07-09; fix tracked in `contracts/IMPLEMENTATION-STATUS.md` §2). A validator skipped this way simply accrues no sample; with zero valid captures it falls back to the plan-time direct read exactly as below.
- **Trustless by construction.** The data captured is authoritative chain state, so an honest and a dishonest caller produce identical results — a caller cannot inject false uptime. The endpoint only *triggers* a read.
- **Interval-gated to prevent weighting games / spam.** A capture is accepted only if at least `min_capture_interval_secs` has elapsed since the last accepted capture; earlier calls are no-ops (safe to call redundantly, caller pays gas). This bounds cadence so no party can over-sample a favorable instant to skew the average.
- **Cadence (defined requirement): daily captures.** The signed-blocks ratio is a *trailing* metric over `signed_blocks_window` (~2 days at mainnet params, §10.3), so one sample observes only the last ~2 days; gap-free coverage of a monthly epoch requires a capture interval no longer than that window, and the defined target is **half the window ≈ 1 day**: 2x overlap means one missed keeper run leaves no unobserved gap, and ~30 samples per epoch is ample for a threshold-plus-ranking signal. Set `min_capture_interval_secs` slightly below the target cadence (~0.9x, roughly 21-22 h for the daily keeper) so scheduler jitter never rejects a legitimate run. Schedule captures evenly across the epoch, and ensure one accepted capture lands **shortly before epoch completion** (the natural slot is alongside the keeper's pre-crank `ClaimRewards` call) so the final window is represented in the mean the plan consumes. If governance ever changes `signed_blocks_window`, re-derive the cadence and the gate together.
- **Graceful fallback (never required).** At plan time, the uptime value used for eligibility/priority is the epoch accumulator's mean **if `count > 0`**, otherwise the single direct plan-time read (§10.3). The system is fully correct with zero captures; captures only *improve* the signal. This satisfies the "improve but do not require" goal.
- **Reset at epoch rollover.** Accumulators clear when a new epoch begins so each monthly plan reflects that epoch's captures.
- *(The jail flow is independent — it uses the two-phase `ReportJailedValidator`/`PurgeJailedValidator` cooldown, §9.8, not these samples.)*

**Optional incentive (deferred, §17.3):** captures cost gas with no built-in reward, so contribution relies on aligned parties (validators wanting fair ranking, the program operator running a daily keeper). A small per-accepted-capture reward remains a v2+ candidate if voluntary participation proves insufficient; v1 ships without it.

---

## 11. Staking Contract Interface (CosmWasm)

Privileged endpoints check the caller against the configured `admin` authority (an `x/group` policy account, §12.1). Commission/TIP payment is open to **any payer**; validator (un)registration is operator-gated; `RunEpoch` / `ServiceRedemptions` / `ClaimRewards` / `CaptureUptimeSignal` / `ReportJailedValidator` / `PurgeJailedValidator` are permissionless endpoints anyone may call. Uptime is read on-chain and the rebalance is computed in-contract — neither is submitted (§9.0, §10.3).

### 11.1 State
- `config`: `{ admin, vault_address, underlying_denom, receipt_denom, max_delegations_per_run, aum_fee_bps (admin mirror of the vault fee), performance_threshold_bps, min_capture_interval_secs, max_concentration_multiple_bps / min_bonded_cap_bps / max_bonded_cap_bps (chain-restriction mirrors), concentration_safety_offset_bps, commission_bps, jail_unbond_delay_secs }` (bridge config — `bridge_address`, `bridge_enabled` — lives on the **vault**, not the staking contract). The epoch cadence is no longer a config value: `min_run_interval_secs` was **retired** in favor of the calendar-month rollover predicate (§9), which is derived from consensus block time and takes no parameter.
- `validators`: map `valoper → { operator, enrolled_at, uptime accumulator { sum_bps, count }, commission_accrued / commission_paid / commission_due / commission_billed (the one-epoch grace boundary, §10.1), tip_epoch }` — per-epoch fields reset at rollover; effective uptime = accumulator mean when captures exist, else a direct plan-time read; priority sorts by `tip_epoch` desc, then effective uptime desc, then enrollment age. Eligibility itself is never stored: it is assessed from live chain state at plan and query time.
- `jail_reports`: map `valoper → reported_at` (the §9.8 two-observation cooldown clock)
- `epoch_state`: `{ phase, last_run }` plus the pending redelegation and delegation queues for gas-chunked continuations (§9.9)
- `receipt_minted`: the §5.1 invariant counter (nHASH deployed out of the vault)
- `epoch_accum` + `epoch_index` + `last_epoch_snapshot`: the §9.10 analytics (window accumulators; the single most-recent snapshot, whose `tvv_after` seeds the next `net_deposits`)
- `halted`: the admin emergency stop for fund-moving cranks

### 11.2 Execute endpoints

| Endpoint | Caller | Behavior |
|----------|--------|----------|
| `RegisterParticipation { valoper }` | validator operator (bech32 payload proven against the valoper; on-chain existence checked) | Enroll a validator. Eligibility is evaluated live from chain state each epoch. |
| `UnregisterParticipation { valoper }` | operator or admin | Withdraw from the program; existing stake is redelegated away at the next epoch (§9.4), never crash-unbonded. Unpaid commission dies with the record (exposure bounded at ~2 epochs; the deterrent is losing the enrollment and the stake). |
| `PayCommission { valoper }` (nHASH attached) | **anyone** | Credit the validator's paid total (overpayment prepays; non-refundable). Funds are held by the contract and swept into vault principal at the next epoch's deposit leg, raising NAV. |
| `PayTip { valoper }` (nHASH attached) | **anyone** | Credit the CURRENT epoch's TIP (the primary priority key, §10.2; resets each epoch). Non-refundable; swept into principal like commission. |
| `UpdateConfig { ...optional fields }` | admin | Update rates, thresholds, cadence, cap mirrors, cooldowns. Only supplied fields change. |
| `RunEpoch {}` | **anyone** (permissionless; min-interval guarded; halt-gated) | The single-transaction epoch crank (§9.9): claim + accrue commission, service redemptions, return settlement, slash write-down, atomic pause-window deposit, burn, deploy settlement, uniform-slot rebalance moves (gas-chunked), expedites, snapshot. Continuation calls drain pending move queues. Deterministic from chain state. |
| `ClaimRewards {}` | **anyone** | Claim-only pass (with commission accrual). Keepers call it shortly before `RunEpoch` so the epoch's deposit includes the current epoch's rewards. |
| `ServiceRedemptions {}` | **anyone** (halt-gated) | Off-cycle: read the **full on-chain pending-swap-out queue** (paginated; includes requests made directly with the vault), cover it from pool liquidity, unbond the shortfall in drain-priority order (§8, §10.2), and `ExpeditePendingSwapOut` each request whose margin-adjusted estimate is already liquid **in the principal marker** (never gated on contract balance, §8). |
| `CaptureUptimeSignal {}` | **anyone** (interval-gated no-op when early) | Folds each enrolled validator's live signed-blocks ratio into the epoch accumulator, sampling **only bonded, non-jailed, non-tombstoned validators** (the §10.4 validity filter; others carry no liveness signal). Run daily (§10.4 cadence). Never required; plan time falls back to a direct read. |
| `ReportJailedValidator { valoper }` | **anyone** | Phase 1 of the jail flow (§9.8): verifies on-chain jailing and records the cooldown start (first report wins; an unjailed observation clears any report). Moves no funds. |
| `PurgeJailedValidator { valoper, claimant_valoper? }` | **anyone** (halt-gated); the redelegation path requires the eligible claimant's enrolled operator | Phase 2 (§9.8): requires the report, the elapsed cooldown, and the validator **still jailed**. With a claimant: redelegate up to its concentration headroom, unbond the excess. Without: unbond the full program stake. Idempotent once moved; the report clears on a full purge. |
| `SetHalted { halted }` | admin | Emergency stop / resume for the fund-moving cranks (`RunEpoch` incl. continuations, `ServiceRedemptions`, purge). |
| `ClearPendingDelegations {}` | admin | Recovery hatch: drop stuck continuation queues (§9.9). |
| `PauseVault { reason }` / `UnpauseVault {}` | admin | Manual vault pause/unpause through the contract's asset-manager authority. |

### 11.3 Query endpoints
`Config {}`; `Validators {}` (every enrolled validator with its live assessment — uptime, jailed/tombstoned, commission accrued/paid/due and arrears, TIP, eligibility, concentration headroom — sorted by program priority, the reverse of the drain order; this single endpoint carries the priority, commission and tip views); `EpochStatus {}` (phase, halted, last run, `receipt_minted`, pending continuation queues — the §5.1 invariant view); `JailReports {}` (open reports with their purge-ready times); `EpochSnapshot {}` (the last epoch's value decomposition, §9.10); `Apr {}` (gross and net-of-drags APR in bps with the full breakdown, §9.10 / §17 R2).

### 11.4 How the contract drives the vault
The contract emits vault and exchange module messages under its asset-manager (and NAV) authority as protobuf `CosmosMsg::Any` values, and reads vault, staking, slashing, distribution and marker state via the whitelisted query set. All message routing and authority gating is verified against a live chain by the repository's devnet drills: settlements (`MsgCreatePayment` + `AcceptAsset`), the paused `DepositPrincipalFunds`, `ExpeditePendingSwapOut`, `PauseVault`/`UnpauseVault`, `UpdateVaultNAV` (write-down sandwich), and the marker mint/transfer/burn cycle.

### 11.5 Bridge integration (NUVA Labs → Base/Ethereum) — scope boundary

Cross-chain nvHASH portability is a **core, non-negotiable v1 objective** (§1) — one of the program's defining purposes is to let HASH holders move value to Base/Ethereum where a Uniswap pool provides liquidity. It is **delivered by a separate NUVA Labs bridge-adapter contract** (and paired destination-network contracts), not by the Staking Contract. The boundary this document commits to:

- **Vault configuration:** the admin group sets the NUVA Labs adapter as `bridge_address` (`SetBridgeAddress`) and enables bridging (`ToggleBridgeEnabled`). These are admin/group-gated (§12.1).
- **Vault accounting hooks used:** the adapter calls `BridgeMintShares` (re-materialize remote shares locally, up to `total_shares − local_supply`) and `BridgeBurnShares` (reflect shares leaving for a remote chain). Per the vault model these move the **local/remote split only** — they never change `total_shares` and **cannot move NAV per share**, so bridging cannot dilute liquid stakers or affect the staking program's economics.
- **Interaction with the Staking Contract:** essentially decoupled. Bridging changes where shares live, not the size of the underlying HASH pool or the delegation set. The asset manager continues to stake the same principal regardless of how nvHASH is split across chains. The one cross-effect to track: `total_shares` remains the supply-of-record and NAV denominator, so the Staking Contract's NAV/yield math is unaffected by bridge mint/burn (verified by the vault's invariant that bridge ops preserve `Net TVV / total_shares`).
- **Out of scope here:** the user-facing transit UX, the relayer/messaging layer, the destination-chain contracts and their security, finality assumptions, and fee handling. Those live in the NUVA Labs bridge design. This spec only commits that a user can designate nvHASH for transit and that the adapter is authorized to use the vault's bridge accounting.

See §12.2 for the bridge trust assumptions now in scope.

---

## 12. Trust & Security Model

- **Uptime is trustless (no oracle).** Eligibility and the default ordering are derived from the chain's own slashing `SigningInfo` (§10.3), read directly by the contract. There is no off-chain performance oracle to trust or compromise — the previously-largest trust assumption in the design is eliminated. Jailed/tombstoned validators are hard-failed from the chain's own state.
- **Liveness response is decentralized and the real yield lever.** The fully permissionless `PurgeJailedValidator` flow (§9.8) lets any eligible validator's operator claim program stake off an on-chain-jailed validator, or **any depositor/watcher trigger a pure unbond**, between monthly plans — bounded by the concentration cap. This protects the one uptime-related outcome large enough to affect depositor returns — idle stake stranded on a dead validator — without relying on a single keeper, and without granting anyone power to fabricate the trigger.
- **Rebalance is deterministic and in-contract — no planner to trust.** The uniform-slot plan is computed by the contract from current chain state (§9.0), so there is no off-chain planner, no submitted plan, and no plan-submission authority. Any caller of `RunEpoch` produces the same plan, and every move is bounded by the protocol limits the contract enforces inline. There is no plan-trust surface and no staleness/snapshot machinery.
- **Asset-manager and NAV authority are powerful.** The contract can settle assets against the vault, deposit into principal, and (as the vault's NAV authority) reprice the receipt — the latter exists solely for the slash write-down sandwich (§9.9), which marks the entry, extracts exactly the unbacked units at zero price, and restores 1:1 within one atomic transaction. Mitigations: deterministic, auditable engine logic; the exact-price settlement guardrail (a settlement cannot trade off the recorded NAV); the receipt-accounting invariant (§5.1), continuously machine-checked; pause and halt controls; governance-held admin; and the unused interest-rate lever (§5). The NAV-authority grant is marginal on top of the contract's existing receipt mint/burn powers and is explicitly in scope for the audit.
- **Auto-pause & refunds** are inherited from the vault for failed withdrawals/unrecoverable errors.
- **Bridge introduces an off-chain operator-trust surface (now in scope, bounded).** See §12.2 — the exposure is bounded by `total_shares` and cannot move NAV per share, and is containable via `ToggleBridgeEnabled` / `SetBridgeAddress`.
- **Audit required** before mainnet, **covering the bridge-adapter authorization** as well as the staking contract. The implementation will include audit-prep artifacts (threat model, invariants, property tests).

### 12.1 Governance — all privileged authority via `x/group` policies

Every administrative and operations function in the system is gated behind **`x/group` group-policy accounts** (multi-signer, threshold-based), not single keys (uptime data is not governed — it is read on-chain, §10.3):

- **Vault admin** (top-level: `SetAssetManager`, swap toggles, bridge config `SetBridgeAddress`/`ToggleBridgeEnabled`) → an **admin group policy**.
- **Program config** (`UpdateConfig`: thresholds, commission rate, epoch length, safety offset, tolerances) → an **operations group policy** (a distinct group from admin, with its own membership and threshold). *(There is no plan submission — the rebalance is computed in-contract, §9.0.)*
- **Note:** uptime/performance is **not** a governed input — it is read on-chain (§10.3), so no group submits it. This removes a whole class of trusted data submission from the governance surface.
- The Staking Contract authorizes these calls by checking the caller against the configured group-policy address(es); proposals/votes/execution are handled by the group module.
- **On-chain verifiability:** the `x/group` queries (`GroupInfo`, `GroupPolicyInfo`, `GroupMembers`, …) are in the ProvWasm stargate whitelist, so the contract (or auditors/monitors) can verify policy membership and thresholds on-chain.
- **Benefits:** rotat­able membership without redeploying the contract, threshold approval for sensitive actions, full proposal/vote audit trail, and separation of duties between fund-administration (admin group) and operations (ops group).

**As built:** the contract accepts a single `admin` authority address, deployed as an `x/group` policy account so membership is rotatable and approvals are threshold-gated without redeployment. Splitting fund-administration from operations into two distinct policies (`admin` vs `ops`, with `UpdateConfig` moved to the ops policy and a tighter threshold on admin) is the one remaining v1.x hardening item; membership and thresholds for each are launch-operations parameters, not design questions.

### 12.2 Bridge trust model (NUVA Labs, in scope)

Enabling cross-chain nvHASH (§11.5) accepts the vault module's documented bridge trust assumption, scoped here:

- **What is trusted:** the NUVA Labs bridge operator keeps the local/remote share split honest. The vault gates `BridgeMintShares`/`BridgeBurnShares` solely on the configured `bridge_address`; there is **no on-chain reconciliation** that a local mint corresponds to a genuine remote burn (or vice-versa). A compromised bridge key could re-materialize local shares up to `total_shares` without real remote backing.
- **What bounds the exposure:** the cap is `total_shares` — bridging can **never inflate supply beyond the supply-of-record, and can never move NAV per share** (`Net TVV / total_shares` is invariant under bridge mint/burn). So liquid stakers' per-share value and the staking program's yield are insulated from bridge misbehavior; the risk is to cross-chain holders' backing, not to the on-chain vault's NAV.
- **Containment controls:** the admin group can disable bridging (`ToggleBridgeEnabled`) or rotate `bridge_address` to a new adapter to contain a compromised operator — both are `x/group`-gated admin actions (§12.1).
- **Separation from the asset manager:** the bridge adapter and the Staking Contract are distinct addresses with distinct authority. A bridge compromise does not grant asset-manager (delegation/principal) authority, and vice-versa.
- **Out of scope:** the security of NUVA Labs' destination-chain (Base/Ethereum) contracts and messaging layer — assessed in the NUVA Labs bridge design and its own audit, referenced but not covered here.

---

## 13. Cosmos / Provenance Constraints Summary

These are protocol facts the design must respect:

- Redemption delay is honored by the vault queue, but **liquidity must actually be present** at payout — the contract is responsible for undelegating in time (§8).
- Redelegations and unbondings are time-locked for the unbonding period and capped by `MaxEntries` per validator pair; no transitive redelegation. The design reaches the uniform-slot state **in a single epoch** by keeping source/destination roles disjoint and relying on the monthly cadence exceeding the lock (§9.3).
- **At most 100 validators** on Provenance, so the eligible set — and thus the per-epoch computation and number of delegation operations — is always bounded and small, which is what makes in-contract computation (§9.0) and single-epoch convergence practical.
- **Provenance validator concentration cap (§9.7):** delegations/inbound redelegations that would push a validator over ~`5.5 / activeValidatorCount` of total bond (clamped to 5%–33%) are **rejected at delegation time**. The rebalancer must compute headroom from the validator's *total* bonded tokens and clamp moves (possibly to zero), redistributing or leaving the remainder liquid. The cap only blocks power increases — moves away are unaffected.
- The AUM tech fee (15 bps) and program commission both affect reported net APR (§5, §10).
- **Uniform 60% validator commission — protocol-enforced (confirmed).** A Provenance-specific chain upgrade (the **`wisteria` upgrade**, PR [#2260](https://github.com/provenance-io/provenance/pull/2260), merged 2025-01-09) set every validator's commission to 60%, each validator's **max rate to 60%**, and the **network minimum commission rate to 60%**. This is a Provenance modification, *not* standard Cosmos behavior — existing validators are pinned at exactly 60% (rate = max = 60%) and the 60% floor binds any new validator, so a delegator keeps ~40% of gross rewards regardless of validator and cannot be undercut. Validators therefore compete only on **access to stake**, not on rate (§10.1) — durable unless changed by a future governance upgrade.
- **Vesting lockup limits the near-term addressable float.** A prior governance action locked a substantial share of the HASH free float into 4-year vesting accounts that began ~1 year ago, so **~75% of that amount remains locked** (declining over ~3 more years). Unvested HASH can be delegated directly but **cannot be transferred**, and `SwapIn` requires a transfer into the vault — so vesting HASH **cannot be deposited** into the program. The vault's addressable deposit base is the unlocked, transferable float; the TAM grows as vesting unwinds. *(Vesting-delegated stake still counts in total bonded, which keeps program-relevant concentration headroom ample early, since program deposits are small relative to total bonded — §9.7.)*
- TVV is computed from principal-marker balances, forcing the receipt-token (or equivalent) mechanism for staked capital (§5.1).
- **Vault pause gates user I/O and enables principal moves.** `SwapIn`/`SwapOut` work only when unpaused; `DepositPrincipalFunds` works only when paused. The epoch therefore opens and closes the pause inside its single atomic transaction for the reward deposit alone (§9.9); settlements run unpaused, and users never observe a paused vault between blocks.
- Aggregate validator signing data is contract-queryable via the whitelisted slashing queries (`SigningInfo`/`SigningInfos`/`Params`) — making uptime a **fully on-chain, trustless** input (§10.3), no oracle. `x/group` queries are whitelisted for on-chain verification of governance policies (§12.1). Useful staking/distribution queries (`Validators`, `Pool`, `ValidatorOutstandingRewards`, `Delegation`, `Redelegations`) are likewise whitelisted, supporting headroom and reward computations.

---

## 14. Resolution & Verification Record; Launch Checklist

Every design question RC1 and RC2 left open has been resolved and, where it touches chain behavior, verified against a live Provenance devnet running the current vault module. The record:

1. **Principal mobilization (§5.1)** — settlement-based receipt model, verified end to end on devnet: deploy and return legs settle at the recorded 1:1 NAV (guardrail-exact), the burn cycle works (transfer into the marker account, then burn), and TVV is value-neutral through every leg.
2. **Commission (§10.1)** — one-epoch grace via due/billed rollover snapshots; arrears assess ineligible live; payment restores at the next plan. Attribution verified by controlled experiment (charged exactly on the contract’s pro-rata rewards). Any payer may remit; rate default 10%, governance-tunable.
3. **TIP ranking (§10.2)** — per-epoch two-key sort implemented (TIP desc, uptime desc, enrollment age, valoper); deploy targets and drain order derive from it.
4. **Redemption liquidity (§8)** — 60-day standard delay + marker-gated expedite, drilled: matured and expedited payouts at stepped-up NAV, and the unfunded-maturity failure mode observed as a clean share refund (no pause, no loss). The fixed 50 bps reserve margin is the one calibration to revisit at high realized yields: simulation shows drift over the unbonding tail can exceed it (making the margin governance-tunable is a recommended v1.x refinement).
5. **Concentration sub-cap (§9.2/§9.7)** — live cap minus a configurable safety offset (default 5% of max bond); never-rejected-delegation is continuously machine-checked in simulation.
6. **In-contract rebalance (§9.0/§9.3)** — deterministic uniform-slot plan via level water-fill; redelegation-only convergence drilled to within one base unit; transitivity and MaxEntries guards defer illegal moves (asserted live).
7. **Uptime source (§10.3/§10.4)** — on-chain SigningInfo with the permissionless capture aggregation; cons-address derivation verified on chain. Amended 2026-07-09 after a devnet finding: the ratio is vacuous for non-bonded validators (counter frozen outside the active set, reset on jail), so capture now REQUIRES the §10.4 validity filter (sample only bonded, non-jailed, non-tombstoned validators; as-built contract fix tracked in `contracts/IMPLEMENTATION-STATUS.md` §2), and the capture cadence is DEFINED as daily (half the ~2-day signing window; derivation in §10.4).
8. **Jail response (§9.8)** — two-phase report/purge with an 8h default cooldown, eligible-claimant redelegation bounded by headroom, pure-unbond fallback; drilled against real downtime jailing and slashing.
9. **Slash recognition (§9.9)** — write-down the epoch of detection via the NAV-authority sandwich; drilled: TVV marked down by exactly the unbacked amount, invariant restored to equality.
10. **Governance (§12.1)** — single admin `x/group` policy as built; the admin/ops policy split is the remaining v1.x hardening item.
11. **Cross-chain (§11.5)** — in scope via the NUVA Labs adapter and the vault’s bridge accounting; transit flow out of scope here; adapter audit required before enabling.

12. **Calendar-month epoch alignment (§9)** — resolved 2026-07-22 (milestone E-CAL, [`docs/plans/2026-07-22-e-cal-calendar-month-implementation.md`](../plans/2026-07-22-e-cal-calendar-month-implementation.md); design in [`docs/plans/2026-07-15-calendar-month-epoch-alignment.md`](../plans/2026-07-15-calendar-month-epoch-alignment.md)). Per the App spec's §14.12 decision, `RunEpoch` eligibility was **retired** from the fixed-duration `min_run_interval_secs` interval and re-based on a calendar-month rollover of consensus block time (`civil_month(env.block.time) > civil_month(last_run)`; block time is the consensus-agreed BFT timestamp, the only deterministic clock in contract execution, and the civil `(year, month)` is a pure function of it). The boundary is deterministic and caller-independent — no `RunEpoch` caller can choose the epoch's duration — and the gate remains an eligibility floor, not a trigger (the epoch still ends only when a permissionless caller cranks after the rollover). `min_run_interval_secs` is removed from `config`/`InstantiateMsg`/`UpdateConfig` (schema regenerated) and the deploy-budget fee horizon re-based on a nominal-month constant. Run spacing is nominally 28–31 days; a late crank followed by a prompt one can compress the following gap below the unbonding period, held safe by the §9.3 plan-time deferral guards (a compressed gap adds deferrals, never an illegal move). Same change per `SECURITY.md`: the `month.rs` conversion carries a unit + proptest (no-panic over the full `u64` nanosecond domain) suite; the simulation gained a real block-time clock with keeper-promptness jitter, and compressed-gap / skipped-month / leap-February scenarios with per-epoch assertions for the never-rejected move under compression, skipped-month settlement, and redemption mobilization vs the withdrawal-delay ceiling. The `withdrawal_delay_seconds` re-pin against the calendar cadence and the keeper-runbook / launch-checklist rows land alongside as E-CAL.3.

**Launch checklist (parameters and process, not design):**

- Read the live mainnet values and set the config mirrors accordingly: staking `unbonding_time` and `max_entries`, the concentration restriction options, the slashing window, x/exchange payment-fee params, and the per-transaction gas limit (note: storing the current ~640KB artifact costs ~4.3M gas; confirm the upload path).
- Pin `withdrawal_delay_seconds` against the production epoch cadence and live unbonding time (the ~60-day ceiling holds at monthly cadence).
- Size `commission_bps`, `performance_threshold_bps`, and the redemption margin against launch economics. Capture cadence is defined (§10.4): daily `CaptureUptimeSignal` with `min_capture_interval_secs` ~0.9x the cadence (~21-22 h), re-derived from the live `signed_blocks_window`. Stand up the keeper (daily capture; ClaimRewards + a capture before each RunEpoch; ServiceRedemptions on a regular cadence) and monitoring on `EpochSnapshot`/`Apr`/`JailReports`.
- Vault share-denom metadata, `nvhash.pb` attribute grants, marker permissions (incl. the contract’s Transfer on the receipt), asset-manager and NAV-authority rotation: all scripted in `infra/devnet/bootstrap/nvhash-deploy-p2p.sh`.
- Third-party security audit (contract + bridge-adapter authorization) before mainnet; enable bridging only after the adapter audit.

## 15. Build & Verification Plan — Status

Delivered in this repository (steps 1–6 of the original plan, complete):

1. **Contract:** the `nvhash-staking` ProvWasm contract implementing the full v1 engine — enrollment, live eligibility, uniform-slot rebalance, reward compounding, commission/TIP, jail flow, redemption liquidity, slash recognition, epoch analytics.
2. **Unit + integration tests:** all planner math (floor arithmetic, level water-fill, commission, annualization), every authorization gate, and control-plane integration against a real embedded Provenance chain (provwasm-test-tube).
3. **Simulation harness (as specified):** the chain-free multi-epoch suite (`cargo run --release --bin simulate`) models deposits/redemptions/reward streams/eligibility churn/slashes/third-party bond drift across randomized multi-decade timelines, asserting per epoch: single-epoch convergence, the never-rejected-move invariant (cap, transitivity, MaxEntries, stake sufficiency), NAV never down absent slash, `settle + write_down == matured`, the exact TVV identity, receipt conservation, share conservation and no over-distribution. Deterministic seeds make every failure exactly reproducible; a fixed-seed smoke runs in CI.
4. **Devnet drills:** scripted, repeatable end-to-end verification against a dev chain running the current vault module (`infra/devnet/bootstrap/nvhash-deploy-p2p.sh` bootstrap, `contracts/drills/p2p-drill.sh` and `contracts/drills/jail-drill.sh`) covering the full money path, the jail flow against real downtime jailing, real slashes, and the write-down.

Remaining (partner and governance involvement):

5. **Testnet pilot** with a small validator set, on a chain build that ships the settlement-era vault module — which requires the vault module's **formal release** (none exists yet as of 2026-07-13; devnet compatibility is established by feature probe against vault `main` only, per the vault version gating item in `contracts/IMPLEMENTATION-STATUS.md`). When that release is cut, the drill and simulation suites are re-run against it before any release is certified.
6. **Audit** (contract + NAV-authority surface + bridge-adapter authorization), then **mainnet** with conservative caps, per the §14 launch checklist.

**Bridge note:** the NUVA Labs bridge-adapter and destination-chain (Base/Ethereum) contracts are a **separate, coordinated deliverable** (§11.5, §12.2), not built in this scope. This project's responsibility is limited to correct vault `bridge_address`/`bridge_enabled` configuration and ensuring the adapter's authorization is included in the security audit. Sequence the `bridge_address` handoff so bridging is enabled only after the adapter is audited.

---

## 16. Stakeholder Personas

> **Canonical personas & adversarial design check.** The build-usable persona set for this program and
> its console lives in [`dashboard-personas.md`](./dashboard-personas.md)
> — four personas (**Evaluator, Position Holder, Validator, Administrator**) written as goals /
> jobs-to-be-done / required data / permitted actions / success signals / failure modes. Those personas
> are used as an **adversarial check** on this spec: not every decision satisfies every persona, and the
> resulting trade-offs are tracked explicitly in the
> [persona-review action register](../plans/persona-review-action-register.md) (worked one item at a time).
> The spec-local sketches below map onto them: **Dana** ≈ **Position Holder** (with the pre-deposit
> **Evaluator** as her earlier due-diligence stage), **Pat** ≈ **Validator**, **Nia** is a
> non-participant foil with no persona-doc counterpart, and the program **Administrator** persona is
> represented here by the vault-admin / ops actors (§4, §12.1). Known seams — e.g. whether validators
> hold a governance vote (register item **B2**) and the fee-base definition (**E5**) — are register items,
> not settled facts.

### 16.1 HASH holder / liquid staker — "Dana, the yield-seeking HASH holder"
*Holds HASH, wants staking yield without giving up liquidity or managing validators.*

- **For:** keeps liquidity — nvHASH stays tradeable and bridgeable to Base/Ethereum while still earning; hands off validator selection, auto-compounding, and jailing response; diversified across reliable validators; **program commission and TIP — paid in by validators from their own funds — lift NAV on top of the standard staking yield**, so the vault can out-yield plain self-staking (both earn the same ~40% post-commission base, but the vault adds the fee/TIP inflows); one position instead of managing many delegations.
- **Against:** the guaranteed redemption window is **~60 days** (sized to worst-case liquidity mobilization, §8); in practice the program expedites a request as soon as its funds are liquid, typically far sooner, but only the ceiling is promised and there is no instant path; the 15 bps AUM fee trims yield (note: the ~60% protocol commission is *not* a vault-specific drag — it applies to self-staking too); exposure to smart-contract, receipt-token, and bridge risk; relies on asset-manager and ops competence; net yield is variable and program-dependent.

### 16.2 Participating validator — "Pat, the reliable mid-tier validator"
*Runs a dependable node but struggles to attract delegations against bigger brands.*

- **For:** access to a pool of stake it couldn't attract directly — and because Provenance commission is a **uniform ~60%**, access is the *only* competitive lever, so this program is one of the few ways a small/new validator can grow; equal-weight distribution rewards reliability over size; objective on-chain uptime means no favoritism; can buy priority with TIP; can grow stake by policing jailed peers (§9.8). Net economics are positive: it keeps its 60% commission on the new stake minus the program fee.
- **Against:** pays the program commission **and** TIP **out of its own funds** (§10.1) — a real cost, not a deduction from rewards; the concentration cap limits how much it can receive; TIP is a recurring per-epoch cost to rank; a jail — even a brief one — risks losing the delegation and the next epoch; equal-weight caps the upside it could earn from its own size.

### 16.3 Non-participating validator — "Nia, the large top-tier validator"
*A big, well-known validator that chooses not to enroll.*

- **Why she opts out:** already near the concentration cap, so the program can route her little or no new stake; the program commission erodes economics versus her direct delegations; equal-weight gives her no advantage for her size or brand; she has no appetite for per-epoch TIP competition or purge exposure; she prefers direct delegator relationships.
- **For the program:** her non-participation is acceptable and largely *by design* — the concentration cap and equal-weight policy intentionally steer stake toward smaller, reliable validators, which improves network decentralization. The program does not depend on the largest validators.

---

## 17. Cross-Persona Review — Points to Consider & Recommended Refinements

Reviewing the full spec through the three personas surfaces a few tensions and a short list of high-confidence refinements.

### 17.1 Points to consider

- **The depositor and participating-validator personas are coupled — and the uniform 60% commission strongly favors participation.** The product is only attractive to Dana if there is a healthy set of reliable enrolled validators; that set only exists if Pat's net economics are attractive. The uniform ~60% commission (§10.1) is decisive here: validators cannot compete on rate, so **access to delegations is their only growth lever**, and a program that routes stake to reliable small/new validators is structurally compelling to exactly the validators the equal-weight policy targets. This materially de-risks the "will enough quality validators enroll?" question. Still calibrate the program fee so `60% − program_fee` stays clearly positive, and use eligible-set size (not fee revenue) as the success metric.
- **Depositor yield is a balance of inflows and drags — and the big "fee" is not vault-specific.** The ~60% protocol commission applies to self-staking and to the vault identically, so it is *not* a reason to prefer self-staking. Inflows the vault adds on top (program commission and TIP, both validator-funded) *raise* NAV; the genuinely vault-specific drags are the 15 bps AUM fee, idle buffer slots, and concentration-undeliverable HASH. Net, the vault can out-yield self-staking; transparency (R2) is what lets Dana see it.
- **The jailed-purge power can over-react.** On Provenance a jail is ~10 minutes with no slash, but a pure unbond strands stake for ~3 weeks and a missed epoch. A permissionless full-unbond on a momentary blip is both a yield loss for depositors and a griefing vector against validators — see R1.
- **No idle buffer.** Redemptions are served from epoch inflows and on-demand unbonding under a ~60-day standard delay sized to worst-case mobilization, with the marker-gated expedite restoring UX (§8); no idle HASH is held back, one fewer tuning knob, more stake at work.
- **The 60-day headline number needs communication.** The guaranteed window is deliberately the *worst case* (a redemption arriving just after an epoch run, mobilized at the next run, plus the unbonding lock and scheduling slack); typical redemptions are expedited far sooner once funds are liquid. Surfacing expected-vs-guaranteed timing in the UX (and the `EpochSnapshot` transparency, §9.10) keeps the long ceiling from reading as the typical experience.
- **Stepwise NAV interacts with the Uniswap pool.** Because value accrues in monthly steps (direct principal deposit, not continuous interest — §5), nvHASH's redemption value jumps at each epoch. On the Base/Ethereum Uniswap pool (a core objective, §1) this means the fair price of nvHASH rises in discrete steps, creating a predictable pre-/post-epoch arbitrage seam that LPs and traders will price in. Not a flaw, but worth communicating — and a reason the `EpochSnapshot`/`Apr` transparency (§9.10) matters for off-chain pricing. *(If smooth accrual were ever wanted for market-pricing reasons, the vault's interest-rate mechanism is available — tracked as a v2+ enhancement, §17.3.)*
- **Large-validator non-participation is fine.** No mitigation needed; it aligns with the decentralization intent.
- **Addressable market is the unlocked float, and it grows over time.** ~75% of a substantial governance-locked HASH allotment remains in vesting for ~3 more years and **cannot be deposited** (unvested HASH is delegatable but not transferable, and `SwapIn` needs a transfer — §13). Near-term deposit TAM is therefore the unlocked, transferable float; it expands as vesting unwinds. A useful side effect: because vesting stake is largely delegated directly and counts in total bonded, the program's deposits stay small relative to total bonded early on, so the concentration cap rarely binds in the early phase (ample headroom, §9.7).

### 17.2 Recommended refinements (high-confidence, material)

- **R1 — Sustained-downtime guard on jail handling (§9.8).** Implemented as the two-phase flow: `ReportJailedValidator` starts a `jail_unbond_delay` cooldown (**default 8h**), and `PurgeJailedValidator` only unbonds if the validator is *still* jailed after it — so a ~10-minute blip never strands stake. Cheap (two on-chain checks, no sampling) and robust to the slashing counter's reset-on-jail. **Why it matters:** without it a brief jail could cost depositors ~3 weeks of idle stake and a missed epoch, and hand griefers a cheap attack. *Confidence: high.*
- **R2 — Publish an explicit net-APR breakdown (delivered by §9.10).** The per-epoch `EpochSnapshot` (§9.10) captures the full decomposition — rewards claimed, TIP, commission, AUM fee, NAV before/after, realized epoch APR — queryable via `Apr {}` / `EpochSnapshot {}`. The paused-window attribution makes it rigorous (in-epoch TVV change is purely program inflow). **Why it matters:** Dana's entire decision is "does this beat self-staking?" — a transparent, queryable breakdown builds trust and is honest about the drags. *Confidence: high. (Now specified, §9.10.)*
- **R3 — RESOLVED (no double-charge).** The new facts settle this: Provenance commission is a uniform ~60% and the program fee is paid **by the validator out-of-pocket**, not deducted from rewards (§10.1). So depositors earn the standard ~40% delegator share *plus* validator-funded program commission and TIP — no double-charge, and the ~60% is not a vault-specific disadvantage since it applies to self-staking too. The remaining task is just to confirm the uniform-commission *enforcement mechanism* persists (§13 / §14.14).

R1 and R2 are the high-confidence refinements expected to materially improve the product; R3 is resolved by the protocol facts.

### 17.3 Deferred / future enhancements (post-v1)

Ideas intentionally out of scope for v1, captured for the roadmap:

- **Continuous interest-rate distribution between epochs.** Use the vault's interest-rate mechanism (§5) to smooth the monthly NAV steps into continuous accrual — primarily a *market-pricing* improvement for the Base/Ethereum Uniswap pool (removes the pre-/post-epoch arbitrage seam, §17.1). Adds back the rate/reserve machinery this design dropped, so it earns its place only if smooth secondary-market pricing proves important. **(v2+.)**
- **TIP-volatility smoothing.** Dampen month-to-month priority swings from per-epoch, non-cumulative TIP (e.g., trailing-window TIP for drain order) if validator churn proves costly.
- **Richer TIP ranking.** Normalize TIP by program stake (TIP-per-HASH) or other community-determined weighting, replacing the simple descending-amount sort.
- **Capture-signal incentive.** A small reward per accepted `CaptureUptimeSignal` (§10.4) if voluntary participation proves insufficient for fair epoch-representative uptime.

---

## 18. References

- User personas (program + console, the adversarial design check): [`dashboard-personas.md`](./dashboard-personas.md); open persona trade-offs tracked in the [persona-review action register](../plans/persona-review-action-register.md).
- ProvLabs Vault module (source of vault facts): https://github.com/ProvLabs/vault — concepts: [`spec/01_concepts.md`](https://github.com/ProvLabs/vault/blob/main/spec/01_concepts.md), messages: [`spec/03_messages.md`](https://github.com/ProvLabs/vault/blob/main/spec/03_messages.md), block hooks: [`spec/06_blocker.md`](https://github.com/ProvLabs/vault/blob/main/spec/06_blocker.md), protos: [`proto/provlabs/vault/v1`](https://github.com/ProvLabs/vault/tree/main/proto/provlabs/vault/v1)
- Vault wired into Provenance (`edelweiss` upgrade, `github.com/provlabs/vault` dependency): https://github.com/provenance-io/provenance/blob/main/app/app.go
- Provenance validator concentration cap (source of §9.7): [`internal/handlers/staking_restrictions_hooks.go`](https://github.com/provenance-io/provenance/blob/main/internal/handlers/staking_restrictions_hooks.go) (issue [#1331](https://github.com/provenance-io/provenance/issues/1331))
- Uniform 60% validator commission (source of §10.1/§13): `wisteria` upgrade, PR [#2260](https://github.com/provenance-io/provenance/pull/2260) — sets all validators to 60%, max rate 60%, network minimum commission 60%
- ProvWasm stargate query whitelist (confirms slashing/group/staking/distribution queries reachable from contracts — §10.3, §12.1, §13): [`internal/provwasm/stargate_whitelist.go`](https://github.com/provenance-io/provenance/blob/main/internal/provwasm/stargate_whitelist.go)
- Cosmos SDK slashing module (`ValidatorSigningInfo`, `missed_blocks_counter`, `SignedBlocksWindow` — §10.3): https://github.com/cosmos/cosmos-sdk/blob/main/x/slashing/README.md
- ProvWasm (CosmWasm bindings for Provenance modules): https://github.com/provenance-io/provwasm
- Provenance smart contracts overview: https://developer.provenance.io/docs/sdk/z-smart-contracts/
- Provenance proto docs: https://github.com/provenance-io/provenance/blob/main/docs/proto-docs.md

---

*v1.0, 2026-07-09 (RC1 2026-06-17; RC2 2026-07-08). Baselined: the v1 engine is implemented in this repository and verified by unit tests, live devnet drills, and the multi-epoch simulation suite. Pre-mainnet work is the §14 launch checklist (parameters, keeper operations, audit); post-v1 enhancements are tracked in §17.3.*
