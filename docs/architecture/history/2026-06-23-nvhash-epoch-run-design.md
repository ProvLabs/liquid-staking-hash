# nvHASH Epoch Run — Design Spec

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/history/2026-06-23-nvhash-epoch-run-design.md`. Historical record, preserved verbatim; paths reference the exploratory repository.

**Date:** 2026-06-23 (findings appended 2026-06-24)
**Author:** Carlton (with Claude)
**Status:** **POC** — implemented and exercised on a fast devnet to iron out the mechanics. Magnitudes, the buffer/reserve models, and the ops dashboard are intentionally rough. A production spec + clean reimplementation will follow once the §9 items are settled.
**Builds on:** `docs/superpowers/plans/2026-06-23-nvhash-staking-contract.md` (Phase 1 shipped), `nvhash-redemption-liquidity-writeup.md`

---

## 1. Purpose

Phase 1 gave the `nvhash-staking` contract a single capability: pause / unpause the vault under its asset-manager authority. That is not the product. The contract must actively run the liquid-staking program.

This spec defines the **epoch run**: a single, condition-driven crank that, on each call, does whatever the on-chain state requires:

- claim accrued staking rewards,
- service redemptions (unbond to cover queued swap-outs, then release matured ones early),
- deploy net-new principal into validator delegations,
- keep the vault's total vault value (TVV) exact by minting / burning a receipt token,

while bracketing **only** the vault-principal moves in a short, atomic pause window. The vault is never left paused across transactions.

This spec covers the orchestration engine plus minimal validator handling. It deliberately defers validator uptime-eligibility (original plan Phase 3) and the uniform-slot rebalance engine (Phase 5) to their own specs.

## 2. Settled facts (from the vault module + redemption writeup)

- Only `MsgWithdrawPrincipalFundsRequest` / `MsgDepositPrincipalFundsRequest` require the vault to be **paused**. Claiming rewards, undelegating, delegating, and reading the pending-swap-out queue do **not**.
- Principal withdraw sends from the principal marker to `authority` (the contract); principal deposit sends from `authority` to the principal marker. Both gated by `ValidateManagementAuthority` (admits the asset manager).
- Redemptions are on-chain `PendingSwapOut` entries with `payout_time = block_time + withdrawal_delay_seconds`. They are **skipped while paused** and **refunded (not lost)** if they mature unfunded.
- `MsgExpeditePendingSwapOutRequest` releases a queued redemption early; gated by the asset-manager authority.
- Redemption safety = a long `withdrawal_delay_seconds` (~60 days, per the writeup) sized to `next-epoch + unbonding (~21d) + buffer`. Expedite is a UX optimization layered on top, not the safety mechanism.
- Base/bond denom is `nhash`; the vault `underlying_asset` is `nhash`.

## 3. Decisions (this spec)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Execution model | **Short atomic pause window; heavy per-validator work outside it.** Only principal moves + receipt mint/burn + NAV sit inside `pause→…→unpause` (one atomic message bundle). |
| D2 | Receipt accounting | **Mint receipt into the vault principal marker, valued 1:1 to nhash.** Invariant: `receipt_minted == nhash staked-out`; principal-marker value (and thus TVV) is unchanged by deploying principal. Rewards (real nhash) deposited as principal step NAV up; receipts never move NAV. |
| D3 | Validator scope | **Minimal:** configured validator set, even-spread delegation, largest-delegation-first unbond ranking. Uptime-eligibility and uniform-slot rebalance deferred to later specs. |
| D4 | Trigger / cadence | **Permissionless crank** `RunEpoch{}` with a stored `last_run` + configurable `min_run_interval_secs` guard. No-op when nothing to do. |
| D5 | Entrypoints | One primary `RunEpoch{}` doing phases A–E, **plus** side-effect-safe sub-phases `ClaimRewards{}` and `ServiceRedemptions{}` exposed as separately-callable permissionless entrypoints for ops/debugging. `PauseVault`/`UnpauseVault` retained as admin-gated manual overrides. |
| D6 | Gas chunking | **Include a resumable cursor** for the per-validator loops (phases A/B/D). The pause window (C) is always atomic and single-tx. |

## 4. Architecture

### 4.1 Entrypoints (`ExecuteMsg`)

- `RunEpoch {}` — permissionless; min-interval guarded; runs phases A–E (§4.2). The heart of the program.
- `ClaimRewards {}` — permissionless; phase A only (withdraw delegation rewards to the contract).
- `ServiceRedemptions {}` — permissionless; phases B + D2 (unbond to cover queued swap-outs; expedite funded ones).
- `PauseVault { reason }` / `UnpauseVault {}` — admin-gated manual overrides (safety hatch; retained from Phase 1).
- Admin config setters: `SetValidators { valopers }`, `AddValidator`/`RemoveValidator`, `SetMinRunInterval { secs }`.

`RunEpoch` is condition-driven: each phase is a no-op when its precondition is absent (no rewards → skip claim; no shortfall → skip unbond; no net-new deposits → skip deploy). Calling it with nothing to do, past the interval, is a cheap successful no-op.

### 4.2 The run algorithm

Phases A, B, D run **outside** pause. Phase C is the atomic pause window.

```
A. SETTLE (outside pause)
   A1. WithdrawDelegatorReward for each delegated validator  → realized nhash to contract
   A2. Sweep matured unbondings already in the contract balance
B. SERVICE REDEMPTIONS (outside pause)
   B1. Read PendingSwapOut queue (incl. direct-to-vault redemptions)
   B2. shortfall = queued_redemption_total − liquid_nhash_on_hand
   B3. If shortfall > 0: Undelegate lowest-ranked validators to cover it (~21d lag)
C. PAUSE WINDOW (atomic: pause → moves → unpause, one message bundle)
   C1. PauseVault
   C2. Return leg: DepositPrincipalFunds(realized nhash)        [NAV step-up];
       WithdrawPrincipalFunds(receipt) + MsgBurn(receipt) for principal returned liquid
   C3. Deploy leg: WithdrawPrincipalFunds(net-new nhash) to contract;
       MsgMint(receipt) + DepositPrincipalFunds(receipt)        [TVV preserved 1:1]
   C4. UnpauseVault

   net-new nhash = liquid nhash held in the vault principal marker (user swap-in deposits
   not yet staked) MINUS the amount reserved to cover queued redemptions this run. Only the
   surplus is deployed; if liquid principal is below redemption needs, the deploy leg is skipped.
D. RELEASE (outside pause)
   D1. Delegate the withdrawn net-new nhash across the validator set (even spread)
   D2. ExpeditePendingSwapOut for each queued redemption now fully funded
E. PERSIST last_run = block_time
```

**Why it is safe:**
- The pause and unpause are in the same atomic message bundle (C). If any message in C fails, the whole transaction reverts and the vault is never left paused by a partial run.
- The per-validator loops (A1, B3, D1) are the only unbounded work, and they are outside the pause window. If they exceed the per-tx gas budget for a large validator set, the resumable cursor (§4.4) lets phases A/B/D continue across calls without ever holding the vault paused.
- The unbonding lag is handled across runs: a run *initiates* unbonding to cover queued redemptions; a later run sweeps the matured nhash (A2) and expedites the now-funded requests (D2). The ~60-day delay guarantees funds are present by maturity.

### 4.3 Receipt / principal / NAV accounting (D2)

- **Invariant:** `receipt_minted == nhash currently staked-out`. The principal marker always holds `liquid_nhash + receipt(valued 1:1)`, so deploying principal leaves TVV unchanged.
- **Deploy leg** (nhash leaves vault to be staked): `WithdrawPrincipalFunds(nhash)` → `MsgMint(receipt, amount=nhash)` → `DepositPrincipalFunds(receipt)`. Then delegate the nhash (D1).
- **Return leg** (rewards realized or principal unbonded back): `DepositPrincipalFunds(nhash)` adds real value (NAV step-up); for principal that returned, `WithdrawPrincipalFunds(receipt)` → `MsgBurn(receipt)` to restore the invariant.
- **Separation:** rewards are real nhash deposited as principal and *do* raise NAV; receipts are pure 1:1 placeholders for staked principal and *never* move NAV.
- A `receipt → nhash` 1:1 NAV is seeded once at setup (the `nvhash-deploy.sh` path) so the vault values the receipt holding correctly.

### 4.4 State (`cw-storage-plus`)

- `CONFIG` (extended from Phase 1): adds `validators: Vec<Addr>`, `min_run_interval_secs: u64`. Existing: `admin`, `vault_address`, `underlying_denom` (`nhash`), `receipt_denom`.
- `EPOCH: Item<EpochState>` where `EpochState { phase: EpochPhase, cursor: u32, last_run: Timestamp, started_at: Timestamp }`, `EpochPhase ∈ { Idle, Settling, Servicing, PauseWindow, Releasing }`. Drives the resumable cursor; `RunEpoch` advances and persists it.
- Pure helpers (no chain access, exhaustively unit-tested): `split_even(amount, n) -> Vec<Uint128>` (largest-remainder), `unbond_plan(delegations, shortfall) -> Vec<(valoper, Uint128)>` (largest-first), `coverage(pending_total, liquid) -> shortfall`.

### 4.5 Errors / safety

- `TooSoon {}` — `block_time < last_run + min_run_interval_secs`.
- `NothingToDo` — benign early success return (not an error) when all phases are no-ops.
- Vault-module errors (not paused / already paused) surface through the message result.
- Atomic pause window (C) guarantees the vault cannot be left paused by a partial/failed run.
- `min_run_interval` + idempotent no-ops make the permissionless crank spam-safe.

## 5. Interfaces produced (consumed by later phases)

- `fn run_epoch(deps, env) -> Result<Response, ContractError>` orchestrator.
- Pure `split_even`, `unbond_plan`, `coverage` (stable signatures; the uptime/rebalance specs replace `unbond_plan`'s ranking and add a deploy planner behind the same seam).
- `EpochState` machine + cursor (reused by Phase 5 rebalance).

## 6. Testing strategy

- **Pure unit tests:** even split (sums, remainders), unbond plan (covers shortfall, no over-unbond, deterministic order), coverage math, receipt invariant arithmetic.
- **Integration (provwasm-test-tube):** full `RunEpoch` against a real vault + test-tube staking:
  1. TVV invariance across a deploy (withdraw principal + mint/deposit receipt).
  2. NAV step-up after a reward deposit.
  3. A queued swap-out covered by an unbond, then expedited once funded.
  4. The vault returns to **unpaused** after every run (including a forced mid-run failure → full revert).
- **Test risk:** test-tube's ability to stand up validators, accrue rewards, and drive unbonding deterministically (original plan §3 open item). If unavailable, the staking-dependent assertions fall back to unit tests on injected fixtures plus a thin integration smoke test.

## 7. Open items (resolve before / during planning)

- **[RESOLVED] §5.1** (read from `vendor/github.com/provlabs/vault`, 2026-06-23). The receipt model works **only when `receipt_denom == vault.payment_denom`**:
  - `DepositPrincipalFunds` calls `ValidateAcceptedCoin`; `AcceptedDenoms() = [underlying_asset, payment_denom]`. A receipt that is not the payment denom is rejected.
  - `GetTVVInUnderlyingAsset` sums only principal-marker balances where `IsAcceptedDenom`, converting each via its NAV (`UnitPriceFraction`). A payment-denom receipt with a 1:1 NAV counts exactly 1:1 toward TVV; a non-payment receipt is skipped (uncounted).
  - The principal-deposit `SendCoins` uses `markertypes.WithBypass`, so depositing the restricted receipt bypasses the required-attribute send restriction.
  - While paused, TVV short-circuits to the frozen `PausedBalance` snapshot and recomputes on unpause, so the withdraw-nhash / deposit-receipt swap nets to an unchanged TVV.
  - **Therefore the receipt must be an accepted denom (underlying or payment) with a 1:1 NAV.**
  - **Refined design (2026-06-23, verified live): vault `underlying_asset = receipt`, `payment_denom = nhash`.** Reasons: (a) the AUM/tech fee is charged in the *payment* denom, so payment=nhash means the fee is paid in real nhash, not the synthetic receipt; (b) `SwapIn` accepts either accepted denom (`ValidateAcceptedCoin`), so users still deposit nhash and redeem nhash; (c) nhash is unrestricted, so the `tech_fee_address` needs no marker permission (the earlier permissioning hack is gone). The contract's own config is unchanged (`underlying_denom = nhash` = the staked asset, `receipt_denom` = the receipt). One consequence the flip surfaces: since the fee skims liquid nhash on each reconcile, the deploy leg must leave a small liquid buffer (`DEPLOY_BUFFER_BPS`, default 0.5%) or the "withdraw 100% of liquid" races the skim and fails — implemented and verified (deployed 99.5%, fee paid in nhash, TVV preserved).
- **[VERIFY]** `MsgExpeditePendingSwapOut` callable by the asset-manager role; pending swap-outs skipped during pause (writeup §6). Confirm against the deployed build.
- **[VERIFY]** `MsgUpdateVaultNAV` availability in provwasm-std 2.8.0 — only needed if NAV must move without depositing principal; the current design avoids it, so this is a fallback note only.
- **[VERIFY]** Reward-balance read path: cosmwasm has no native pending-rewards query; confirm a Stargate `cosmos.distribution` query (or `WithdrawDelegatorReward` + post-balance delta) for computing claimable rewards.
- **[PARTIALLY RESOLVED] §9.9 redemption liquidity sizing (2026-06-24).** Swap-out payouts are re-priced at *maturity* NAV (`payout.go` re-runs `ConvertSharesToRedeemCoin`), and escrowed shares stay in `total_shares` and keep appreciating during the delay — so a payout can exceed what was unbonded at servicing time. Fix implemented: each run the contract sizes the redemption reserve as `Σ EstimateSwapOut(pending) × (1 + REDEMPTION_MARGIN_BPS)` (default 50 bps; the vault has no interest rate, so NAV drift is only the small deposited-reward step), targets the **vault principal** liquid (the pool payouts come from, not the contract balance), and **subtracts in-flight unbonding** (all of which is redemption-driven) so it tops up incrementally instead of re-unbonding each epoch. The same `need` is reserved by the deploy leg so principal is never staked out from under a pending swap-out. Remaining knob: promote `REDEMPTION_MARGIN_BPS` to a config setter if runtime tuning is wanted.
- **[DECIDE]** Magnitudes: `min_run_interval_secs` (~monthly) and `withdrawal_delay_seconds` (~60 days, writeup §4.2).
- **[DECIDE]** Reward withdraw-address: claim straight to the contract vs. `SetWithdrawAddress` optimization.

## 8. Out of scope (separate specs)

- Validator registry with operator-proven enrollment, commission/TIP (Phase 2).
- On-chain uptime eligibility + priority sort + jail cleanup (Phase 3).
- Uniform-slot rebalance / redelegation engine (Phase 5).
- Bridge hookup / cross-chain transit (Phase 7).

## 9. POC session findings (2026-06-24)

Everything below was learned by driving the contract + chain-setup scripts + ops dashboard live on a fast devnet (10-min unbonding, 15-bip AUM fee, Design B vault: `underlying_asset = receipt`, `payment_denom = nhash`). It refines or supersedes the earlier sizing notes and feeds the production spec.

### 9.1 Redemption liquidity — IMPLEMENTED

Confirmed from `payout.go`: the vault re-prices swap-out payouts at **maturity** NAV (re-runs `ConvertSharesToRedeemCoin`), and escrowed shares stay in `total_shares` (burned only at payout), so they keep appreciating during the withdrawal delay. A payout can therefore exceed what was unbonded at servicing time. The contract now sizes redemptions as:

- `need = Σ EstimateSwapOut(pending) × (1 + REDEMPTION_MARGIN_BPS)` — const **50 bps**. With the vault's interest rate at 0, the only NAV drift before payout is the deposited-reward step, so a few bips over-cover is sufficient.
- `shortfall = need − vault_principal_liquid − contract_liquid − in_flight_unbonding`; unbond only the shortfall.
- **All unbonding in this contract is redemption-driven** (the deploy leg only delegates), so the chain's total in-flight unbonding *is* the redemption unbonding and is subtracted directly — no per-request bookkeeping, no re-unbonding each epoch.
- The deploy leg reserves the same `need`, so principal is never staked out from under a pending swap-out.
- **Inflows-first:** liquid (swap-in deposits + claimed rewards) covers redemptions before any unbonding; in a growing vault little or nothing is unbonded.
- `REDEMPTION_MARGIN_BPS` is currently a const; promote to a config setter if runtime tuning is wanted.

### 9.2 AUM-fee liquidity — OPEN (proposed fix)

The AUM fee is charged in the **payment denom (nhash)** and skimmed from the principal marker's liquid nhash on each reconcile. Two findings:

- **The stored `vault.outstanding_aum_fee` is misleading** — it is only the fee *booked at the last reconcile* (reset to ~0 on collection). The real fee accrues continuously: `accrued = TVV × aum_fee_bips/10000 × (now − fee_period_start) / 31,536,000` (module `interest.CalculateAUMFee`, 365-day year). True net deployable = `principal_nhash − accrued − booked`.
- **The contract over-deploys and starves the fee.** Observed live: ~122 nhash left liquid while the fee accruing on the full TVV (~1e9) reached ~1040 nhash over a ~6h window — i.e. the vault could not cover its own AUM fee; the next reconcile collects what's there and books the remainder outstanding.
- **`DEPLOY_BUFFER_BPS` (% of liquid) is the wrong basis.** The fee accrues on the whole TVV, not on the liquid slice. The deploy leg should instead reserve the fee that will accrue before the next reconcile/epoch: `fee_reserve ≈ TVV × aum_fee_bips/10000 × (epoch_interval / year)`, querying `aum_fee_bips` / `fee_period_start` / TVV from the vault. **Proposed; not yet implemented.**

### 9.3 Economic properties (informational, no code)

- **Unbonding earns nothing.** Funds unbonded to service a redemption earn zero rewards for the unbonding period and stay idle until the swap-out matures (~the full withdrawal delay with the 1.5× sizing). Mitigated by inflows-first (§9.1) — only net-outflow forces unbonding.
- **Exiters keep earning; stayers subsidize.** Because escrowed shares stay in `total_shares` and the payout is re-priced at maturity, a swap-out holder keeps accruing value during the wait (unlike direct unbonding, which earns nothing). That extra is funded by the rest of the pool (the idle unbonded capital lowers total rewards, shared across all shares). Inherent LST cost; small in a healthy vault. Removing it would require the module to lock value at request time — out of contract scope.
- **The contract never pays redemptions directly.** The vault EndBlocker pays from the principal marker (`payout.go`); the contract's job is to keep that marker funded (claim rewards, unbond, deposit). "Contract liquidity" counts toward coverage only because it is deposited into the principal marker each run.

### 9.4 `0stake` in `withdraw_rewards` events (cosmetic)

A `withdraw_rewards` event with `amount=0stake` is a zero-reward placeholder: cosmos-sdk emits a single zero coin when a reward withdrawal nets nothing, and the denom falls back to `sdk.DefaultBondDenom` ("stake") because Provenance registers no global SDK base denom. Harmless (amount 0); it appears on the auto-withdraw that `delegate`/`undelegate` triggers after the explicit claim already took the real rewards.

### 9.5 POC ops dashboard (`vault-sloppy-dash`, `/nvhash`)

Built alongside to observe the program live (not a production artifact):

- Amounts in HASH (1 HASH = 1e9 nhash); rewards shown in **nhash** (sub-HASH on devnet with zero inflation).
- **Liquid principal** shown net of the *accrued* AUM fee (§9.2 formula), not the stored field.
- **Escrowed shares vs reserves**: the share-denom balance in the reserves account is split out as escrowed swap-out shares and checked against the total pending swap-out shares.
- **Contract events** table via CometBFT `tx_search` (the execute msg + full sub-event tree per run).
- **Swap-out history** (completed + refunded) via `block_search` + the persisted event store.
