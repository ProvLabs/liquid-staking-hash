# nvHASH — Redemption Liquidity & Vault-Level Setup (review note for §8 / Decision 6)

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/history/nvhash-redemption-liquidity-writeup.md`. Historical record, preserved verbatim; paths reference the exploratory repository.

**Author:** Carlton
**Context:** Follow-up to the §8 redemption-servicing thread. Grounded against the live `ProvLabs/vault` module source. Where a claim maps to code, the message/field name is cited so it can be confirmed against the deployed chain.

---

## 1. The problem, stated precisely

Redemption liquidity cannot assume users route through the staking contract. A user can square off **directly with the vault**:

`SwapIn(nhash) → nvHASH → SwapOut(nvHASH, redeem_denom=nhash)`

This never touches the staking contract. So any liquidity model that depends on swapouts being intercepted by the contract is unsound. The vault itself must guarantee that a queued redemption is funded by the time it matures, regardless of who initiated it.

## 2. The mechanism

Redemption safety comes from **delay sizing, not from gating the caller**. Two existing `ProvLabs/vault` mechanisms do the work:

- **`withdrawal_delay_seconds`** (`MsgUpdateWithdrawalDelayRequest`, module max ~2 years). A `SwapOut` enqueues a `PendingSwapOut` with `payout_time = block_time + withdrawal_delay_seconds`. The EndBlocker pays it out only after that time.
- **`ExpeditePendingSwapOut`** (`MsgExpeditePendingSwapOutRequest`). Releases a queued redemption ahead of its delay. Gated by `ValidateManagementAuthority`, so the asset manager can call it.

Set a long standard delay (the safety guarantee) and let the contract expedite once liquidity is actually mobilized (the UX optimization).

## 3. Why this is safe even for direct swapouts

The `PendingSwapOut` queue is **on-chain state**, so when the contract runs its monthly epoch it reads every queued redemption, including ones that bypassed it, and unbonds enough to cover them. As long as the delay exceeds the worst-case time to mobilize liquidity, the funds are present when the request matures. The initiator is irrelevant.

Two mechanics shape the sizing:

- **Pause blocks payout.** While the vault is paused (the epoch window), pending swapouts are skipped and do not pay out. The delay must absorb a full epoch pause window, not just the unbonding lock.
- **Failure is a refund, not a loss.** If a request matures unfunded, the payout path refunds the escrowed shares to the owner rather than losing funds. That is a degraded UX (failed redemption), so the delay is sized to avoid it, but it is not a fund-safety risk.

## 4. Vault-level setup

### 4.1 Register the staking contract as `asset_manager`

`MsgSetAssetManagerRequest` (admin-only). This single role grants the contract everything the program needs:

- `PauseVault` / `UnpauseVault` (the epoch pause window)
- `DepositPrincipalFunds` / `WithdrawPrincipalFunds` (the deploy/return path; both require the vault to be paused)
- `ExpeditePendingSwapOut` (release matured redemptions early)

All are gated by `ValidateManagementAuthority`, which admits **either the admin or the asset manager**. Point the asset manager at an `x/group` address if a multi-signer approval flow is wanted; the field is a role, not a person.

### 4.2 Size `withdrawal_delay_seconds` to worst-case mobilization

Set via `MsgUpdateWithdrawalDelayRequest`. Worst case for a redemption that arrives just after an epoch run:

```text
withdrawal_delay >= (time to next epoch run) + (unbonding period) + buffer
                 ~=   ~31 days (monthly cadence) + ~21 days        + buffer
                 ~=   ~52 days + buffer
```

"7 weeks worst case" (49 days) is in the right zone but slightly tight once the buffer and a full pause window are included. A **~60-day (two-month) standard delay** is the safe ceiling. Pin the exact number against the contract's real run cadence and how unbonding initiation lines up with the epoch (§9 / §9.9).

### 4.3 Use accelerate for UX, not for safety

Keep the standard delay at the safe ceiling. When the contract has already unbonded the liquidity for a queued request (funds are liquid in the principal marker), it calls `ExpeditePendingSwapOut(request_id)` to release that request early. Users then wait only as long as mobilization actually took, not the full worst-case window. The long delay is the guarantee; accelerate is the optimization layered on top.

## 5. Proposed replacement language for Decision 6 / §8

> **6. Redemption servicing (no reserved buffer).** Redemptions queue as `PendingSwapOut` entries and are released after a configured `withdrawal_delay_seconds` sized to the worst-case liquidity-mobilization window (next epoch run + unbonding period + buffer; ~60 days standard). This delay holds regardless of whether a redemption is routed through the staking contract or squared off directly against the vault: the contract reads the on-chain pending-swapout queue each epoch and unbonds the lowest-ranked validators to cover all queued redemptions. Liquidity comes from epoch inflows (claimed rewards + new deposits) first, then on-demand unbonding. No idle buffer slots are reserved. When liquidity for a queued request has already matured, the contract (as asset manager) may call `ExpeditePendingSwapOut` to release it ahead of the standard delay.

## 6. Open item for the consolidated §14 list

> **[VERIFY]** Confirm with ProvLabs against the deployed build: (a) `ExpeditePendingSwapOut` is callable by the asset-manager role (code path: `ValidateManagementAuthority`); (b) pending swapouts are skipped during pause; (c) the principal deploy/return accounting under `Withdraw/DepositPrincipalFunds` inside the pause window (the existing §5.1 open item).

---

### Module references (confirm against deployed source)

- `MsgSwapInRequest` / `MsgSwapOutRequest`, `redeem_denom`, `payment_denom`
- `withdrawal_delay_seconds`, `MsgUpdateWithdrawalDelayRequest`, `PendingSwapOut`, `PendingSwapOutQueue`
- `MsgExpeditePendingSwapOutRequest`, gated by `ValidateManagementAuthority` (admin or asset manager)
- `MsgSetAssetManagerRequest`; `DepositPrincipalFunds` / `WithdrawPrincipalFunds` (require pause)
- `MsgPauseVaultRequest` / `MsgUnpauseVaultRequest`; pending payouts skipped while `paused`
