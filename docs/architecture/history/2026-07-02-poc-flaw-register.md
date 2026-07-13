> **HISTORICAL REFERENCE.** This is the flaw register and hardening plan for the original POC contract that lived in the team scratch repo. Part 2 (the flaw register) is the lasting reference; the tasks in Part 3 were written for that POC codebase and MUST NOT be executed against this repo (both greenfield plans already bake in every fix).

# nvHASH Staking Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness, liveness, and economic flaws found in the nvhash-staking POC contract so the epoch engine is safe to take past POC, and register the launch blockers that live outside the contract.

**Architecture:** The contract stays what it is: a permissioned CosmWasm asset manager for a ProvLabs vault (Design B: vault `underlying_asset` = receipt token, `payment_denom` = nhash), with a permissionless epoch crank that claims rewards, services redemptions, and deploys surplus principal behind a short atomic pause window. Every task below hardens an existing seam; none changes the architecture. Pure planning math stays in `src/plan.rs` (no chain access), chain reads and message assembly stay in `src/epoch.rs`.

**Tech Stack:** Rust 2021, cosmwasm-std 2.2, cw-storage-plus 2.0, provwasm-std 2.8.0 (`provlabs-all`, `provenance-marker`, `cosmos-staking`), provwasm-test-tube 0.5.0.

## Global Constraints

- Dependencies are pinned by `nvhash-staking/Cargo.toml`: `cosmwasm-std = "2.2"`, `provwasm-std = "2.8.0"`, `provwasm-test-tube = "0.5.0"`, `cw-storage-plus = "2.0"`. Do not bump them in this plan.
- The release profile sets `overflow-checks = true`: a bare `+`/`-` that overflows aborts the tx. All new arithmetic must use `saturating_*`, `checked_*`, or `multiply_ratio`.
- All commands run from `/Users/nullpointer0x00/code/slopbox/nvhash-staking`.
- Pure tests (no wasm needed): `cargo test --lib plan::` and `cargo test --lib contract::unit`.
- Integration tests read `artifacts/nvhash_staking.wasm`. After any contract change, rebuild before running them: `cargo run-script optimize-arm64` (Apple silicon) or `cargo run-script optimize`, then `cargo test`.
- Provenance's per-tx gas limit is 4M. Everything a single `RunEpoch` emits executes in one tx.
- Prose rule for this repo's docs: no em-dashes.

---

## Part 1: What the system is today (grounding)

For an engineer with zero context. Everything here is implemented and was exercised live on a fast devnet (see `docs/superpowers/specs/2026-06-23-nvhash-epoch-run-design.md` §9).

**The product.** nvHASH is a liquid staking token for HASH. Users `SwapIn` nhash to the ProvLabs vault and receive nvHASH shares. The vault itself never stakes anything; this contract, registered as the vault's `asset_manager`, moves principal out, delegates it across a configured validator set, and keeps the vault's total vault value (TVV) exact with a synthetic receipt token.

**Design B denoms** (from the resolved §5.1 item; wired by `vault-chain-setup/nvhash-deploy.sh`):
- Vault `underlying_asset` = `nvhash.staked` (a restricted marker, the receipt). It counts 1:1 toward TVV and represents staked-out principal.
- Vault `payment_denom` = `nhash`. Users deposit and redeem nhash; the AUM fee is charged in real nhash.
- Contract config (`src/state.rs:6`): `underlying_denom = nhash` (the staked asset), `receipt_denom = nvhash.staked`.

**The receipt invariant** (`src/state.rs:59`): `RECEIPT_MINTED == nhash currently deployed out of the vault`. Deploy leg: withdraw nhash from the principal marker, mint equal receipt, deposit the receipt back (TVV unchanged), then delegate the nhash. Return leg: deposit returned nhash, withdraw equal receipt, burn it. Rewards deposited without a matching burn are the NAV step-up.

**The epoch crank** (`src/epoch.rs:187`, permissionless, min-interval guarded):
- A: `WithdrawDelegatorReward` for every config validator with rewards.
- B: read the vault's `PendingSwapOut` queue (this catches redemptions that squared off directly with the vault, the thread's key insight), size the reserve as `Σ EstimateSwapOut × (1 + 50bps)`, and `Undelegate` largest-first only for the shortfall after counting liquid and in-flight unbonding.
- C: atomic pause window (pause, deposit contract liquid, withdraw receipt to burn, withdraw deployable surplus, mint+deposit receipt, unpause) in one message bundle, so a partial failure reverts and the vault is never left paused.
- D: delegate the withdrawn surplus (chunked to `max_delegations_per_run`; remainder persisted to `PENDING_DELEGATIONS` and drained by continuation cranks that bypass the interval guard), and `ExpeditePendingSwapOut` for funded requests.
- E: persist `RECEIPT_MINTED`, `PENDING_DELEGATIONS`, `EPOCH`.

**Redemption safety model** (from `nvhash-redemption-liquidity-writeup.md`): the vault's `withdrawal_delay_seconds` is sized to worst-case mobilization (~next epoch + 21d unbonding + buffer ≈ 60 days); expedite is UX on top. Payouts are re-priced at maturity NAV and paid by the vault EndBlocker **from the principal marker**, never by the contract directly. An unfunded matured request refunds the escrowed shares (degraded UX, not fund loss).

---

## Part 2: Flaw register

Severity is (impact × ease of hitting it). "Task" = fixed in Part 3. "Ops" = Part 4 launch blocker. Line references are to the current tree.

| # | Sev | Flaw | Where | Disposition |
|---|-----|------|-------|-------------|
| F1 | Critical | Expedites are gated on liquidity the payout account does not have; permissionlessly triggerable, cancels users' redemptions | `src/epoch.rs:143-159` | Task 1 |
| F2 | Critical | One bad valoper bricks the epoch forever; no way to clear `PENDING_DELEGATIONS` | `src/epoch.rs:192-194,433`, `src/contract.rs:93` | Task 2 |
| F3 | Critical | Share supply crosses uint64 at ~18,447 HASH TVL; marker max_supply and share-NAV publish break | vault module + marker params | Ops O1 |
| F4 | High | Slashing losses recognized late and only as rewards accrue; exiters escape at overstated NAV | `src/plan.rs:132-140` | Task 3 |
| F5 | High | Swap-outs redeeming in the receipt denom are valid to the module but invisible to the contract | `src/epoch.rs:117` | Ops O2 |
| F6 | Medium | Unpaginated reads truncate at the default page size: pending queue under-reserved, unbonding under-counted | `src/epoch.rs:31,113` | Task 4 |
| F7 | Medium | Repeated unbonds against the same validator hit the staking module's MaxEntries (7) and revert the whole crank | `src/plan.rs:30-46` | Task 5 |
| F8 | Medium | AUM-fee reserve has the wrong basis (bps of liquid, not fee accrual on TVV); observed live starving the fee | `src/epoch.rs:20,275` | Task 6 |
| F9 | Low | Rewards on delegations to removed validators are stranded (claim filters to config set) | `src/epoch.rs:59-71` | Task 7 |
| F10 | Low | No observability: epoch phase, receipt counter, pending delegations are unqueryable | `src/msg.rs:38-42` | Task 8 |
| F11 | Low | Dead state machine: `cursor`, `Settling`/`Servicing`/`PauseWindow` phases unused; phases A/B unchunked so a large validator set can push one `RunEpoch` tx past 4M gas | `src/state.rs:29-44` | Ops O4 (measure), decide later |
| F12 | Low | `min_run_interval_secs` serde-defaults to 0: an unset field silently allows crank spam | `src/msg.rs:11` | Noted; set explicitly in deploy scripts |

### F1: expedite gating counts money the payout account does not hold

`service_redemptions` (`src/epoch.rs:143`) passes `vault_liquid + contract_liquid` to `plan_service`, which uses that single number both to reduce the unbond shortfall (correct: contract liquid does eventually get deposited) and to gate expedites (wrong: payouts are made by the vault EndBlocker from the principal marker only, and standalone `ServiceRedemptions` never deposits the contract's balance).

Failure scenario: rewards accrue for a month; anyone calls `ClaimRewards {}` (contract balance grows) then `ServiceRedemptions {}`. Queued swap-outs up to the contract's balance are expedited even though the principal marker cannot fund them. When the expedited request is processed unfunded, the module refunds the escrowed shares to the owner: the user's redemption is cancelled and they must re-queue for another ~60 days. This is a zero-cost, permissionless griefing loop against every pending redemption. It is worse mid-`Releasing`: the contract balance then also contains withdrawn-but-undelegated principal, inflating the gate further.

(The same call also under-unbonds slightly during `Releasing`, since principal earmarked for delegation is counted as redemption coverage; splitting the two bases fixes both.)

### F2: a single bad valoper bricks the crank permanently

`SetValidators` (`src/contract.rs:93`) accepts arbitrary strings. `plan_deploy` targets whatever is configured. If any target is invalid (typo, tombstoned validator, account address instead of valoper), `StakingMsg::Delegate` fails and the whole continuation tx reverts. While `PENDING_DELEGATIONS` is non-empty every `RunEpoch` call routes to `continue_epoch` (`src/epoch.rs:192`), which retries the same bad list forever. `SetValidators` cannot help because the pending list was already computed. `last_run` only advances on completion, so no future epoch can ever run. Meanwhile receipt was already minted for the full deployable and the withdrawn nhash sits in the contract.

Fix: validate the shape of valopers on the way in, and give the admin `ClearPendingDelegations {}`. Clearing is safe because the return-leg math self-heals: the cleared nhash is contract liquid, and the next epoch burns the matching receipt and re-deposits the nhash (TVV preserved).

### F3: uint64 share-supply ceiling at ~18,447 HASH of TVL

Verified by `vault-chain-setup/test-supply-above-uint64.sh`: the vault mints `ShareScalar = 1e6` shares per underlying unit on first deposit. The underlying unit here is nhash (1e-9 HASH), so total shares cross `2^64 ≈ 1.84e19` at `1.84e13` nhash: **about 18,447 HASH**. Any real launch crosses this in week one. Two effects: (a) the share marker cannot mint past `x/marker` `max_supply` unless governance raises it above uint64 first; (b) `reconcile.go/setShareDenomNAV` sets a uint64 `volume` and, past the ceiling, logs and skips the share-NAV publish forever after. The experiment showed the chain and the swap survive, but anything downstream reading the share marker NAV (pricing, dashboards, the Base/Ethereum bridge rate?) goes permanently stale. Not fixable in this contract. See Ops O1.

### F4: slashing losses are recognized late, capped by reward flow

`plan_return` (`src/plan.rs:132`) computes `matured = receipt_minted − staked − unbonding` and burns `min(matured, liquid)`. A slash of S makes `matured` grow by S with no corresponding nhash arriving. If the epoch's liquid (returned principal M + rewards R) is at least M + S, the loss is correctly absorbed against rewards. But when S > R, the residual receipt stays in the principal marker, overstating TVV until enough future rewards accumulate to "back" the burn. Between epochs the NAV is always overstated by any unrecognized slash. Redemptions re-price at maturity NAV, so exiters during that window are paid too much and stayers eat the difference.

The liquid cap is unnecessary: `unbonding` is already subtracted, so `matured` is exactly (returned principal + slash losses), and both should be burned now. Burning receipt withdrawn from the marker without a matching deposit is precisely how a real loss should hit TVV. Fix: burn the full `matured`.

### F5: receipt-denom redemptions are valid and unmodeled

The module accepts swap-outs in either accepted denom, and the vault's `underlying_asset` is the receipt (provwasm `VaultAccount.payment_denom` docs: "swap-in/out accept either underlying_asset OR payment_denom"). `pending_redemptions` (`src/epoch.rs:117`) filters to `redeem_denom == nhash || empty`, so a swap-out with `redeem_denom = nvhash.staked` is never reserved for, and if paid, pulls receipt out of the principal marker with no burn: `RECEIPT_MINTED` then exceeds receipt-in-marker, the Task 3 return leg's withdraw can fail, and the holder owns a synthetic 1:1-TVV token the program never redeems. The `nvhash.pb` required-attribute gate limits who can receive it, but any attributed address (ops, bridge, market-maker accounts) can. Also note: if the module treats an **empty** `redeem_denom` as "default to underlying", the contract's estimate (priced in nhash) sizes the wrong asset. Not fixable purely in-contract. See Ops O2.

### F6, F7, F8, F9, F10, F12

Covered inline in their tasks below. F11 is a measurement item (Ops O4): don't build chunking for phases A/B until a gas profile of a realistic validator set (20 to 50) shows the single tx approaching 4M.

---

## Part 3: Tasks

Tasks 1, 3, 5 change pure-function signatures in `src/plan.rs`; do them in order.

### Task 1: Split expedite liquidity from coverage liquidity (F1)

**Files:**
- Modify: `src/plan.rs:86-109` (`plan_service`), plus its tests at `src/plan.rs:257-282`
- Modify: `src/epoch.rs:143-183` (`service_redemptions`), `src/epoch.rs:236-259` (inside `run_epoch`)

**Interfaces:**
- Consumes: existing `redemption_need(pending, margin_bps) -> Uint128`, `plan_unbond(delegations, shortfall) -> Vec<(String, Uint128)>`.
- Produces: `plan_service(pending: &[(u64, Uint128)], cover_liquid: Uint128, expedite_liquid: Uint128, unbonding: Uint128, delegations: &[DelegationView], margin_bps: u64) -> ServicePlan`. `cover_liquid` = everything that will end up in the marker (vault liquid + contract liquid), reduces the unbond shortfall. `expedite_liquid` = what the principal marker itself will hold when the expedited payout is processed. Task 5 extends this signature again (adds `at_capacity`).

- [ ] **Step 1: Write the failing tests** (append to `mod tests` in `src/plan.rs`)

```rust
    #[test]
    fn plan_service_expedites_only_from_marker_liquid() {
        let dels = vec![DelegationView { valoper: "valA".into(), staked: Uint128::new(500) }];
        // 300 total counts toward coverage (need = 200, so no unbond),
        // but only 50 is in the principal marker: nothing may be expedited.
        let plan = plan_service(
            &[(1, Uint128::new(100)), (2, Uint128::new(100))],
            Uint128::new(300),
            Uint128::new(50),
            Uint128::zero(),
            &dels,
            0,
        );
        assert!(plan.expedite_ids.is_empty());
        assert!(plan.undelegations.is_empty());
    }

    #[test]
    fn plan_service_expedite_gate_includes_margin() {
        // estimate 1000 at 50 bps needs 1005 in the marker; 1004 is not enough.
        let plan = plan_service(
            &[(1, Uint128::new(1000))],
            Uint128::new(10_000),
            Uint128::new(1004),
            Uint128::zero(),
            &[],
            50,
        );
        assert!(plan.expedite_ids.is_empty());
        let plan = plan_service(
            &[(1, Uint128::new(1000))],
            Uint128::new(10_000),
            Uint128::new(1005),
            Uint128::zero(),
            &[],
            50,
        );
        assert_eq!(plan.expedite_ids, vec![1]);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --lib plan::`
Expected: compile error (`plan_service` takes 5 arguments, tests pass 6). A signature-change failure is the expected TDD failure mode here.

- [ ] **Step 3: Implement** (replace `plan_service` in `src/plan.rs`)

```rust
/// Plan redemption servicing.
/// - `cover_liquid`: nhash that is in, or will be deposited into, the vault principal
///   (vault liquid + contract liquid); reduces how much must be unbonded.
/// - `expedite_liquid`: nhash the principal marker itself will hold when payouts run.
///   Payouts are made by the vault EndBlocker from the marker only, so expedites must
///   be gated on this, never on contract-held balance.
/// - `unbonding`: principal already unbonding back; subtracted so it is never re-unbonded.
pub fn plan_service(
    pending: &[(u64, Uint128)],
    cover_liquid: Uint128,
    expedite_liquid: Uint128,
    unbonding: Uint128,
    delegations: &[DelegationView],
    margin_bps: u64,
) -> ServicePlan {
    let need = redemption_need(pending, margin_bps);
    let shortfall = need.saturating_sub(cover_liquid + unbonding);
    let undelegations = plan_unbond(delegations, shortfall);

    let mut remaining = expedite_liquid;
    let mut expedite_ids = vec![];
    for (id, amt) in pending {
        // Payouts re-price at maturity NAV; hold each request to the same margin the
        // reserve uses so an expedited payout cannot outrun the marker.
        let covered = amt.multiply_ratio(10_000u128 + margin_bps as u128, 10_000u128);
        if covered <= remaining {
            expedite_ids.push(*id);
            remaining -= covered;
        }
    }
    ServicePlan {
        undelegations,
        expedite_ids,
    }
}
```

Update the three existing `plan_service` tests to the new signature by passing the old `liquid` value as **both** `cover_liquid` and `expedite_liquid` (their scenarios assume the funds are in the marker):
`plan_service(&[...], Uint128::new(100), Uint128::new(100), Uint128::zero(), &dels, 0)` and likewise for the other two.

In `src/epoch.rs`, `service_redemptions` (line 152): only the marker's own liquid gates expedites. The call becomes:

```rust
    let plan = plan_service(
        &pending,
        vault_liquid + liquid,
        vault_liquid,
        unbonding,
        &dels,
        REDEMPTION_MARGIN_BPS,
    );
```

In `run_epoch`, reorder so `deployable` is known before the service plan, then gate expedites on the marker balance as it will stand after this run's own moves (deposit of `liquid`, withdrawal of `deployable`). Replace the block from `// Redemption reserve:` (line 237) through the end of the old `deployable` computation (line 277) with:

```rust
        // Redemption reserve: payout estimates + a small over-cover margin.
        let need = redemption_need(&pending, REDEMPTION_MARGIN_BPS);
        let validators = cfg.validators.clone();

        // Deploy sizing: stake the vault principal's surplus beyond the redemption
        // reserve (`need`) and the fee buffer. Reserving the same `need` the service
        // leg targets means redemption funds are never staked out from under a
        // pending swap-out.
        let deployable = if validators.is_empty() {
            Uint128::zero()
        } else {
            let buffer = vault_liquid.multiply_ratio(DEPLOY_BUFFER_BPS, 10_000u128);
            vault_liquid.saturating_sub(need + buffer)
        };

        // Marker liquid once this run's moves land: current marker liquid, plus the
        // contract balance deposited in the pause window, minus the surplus withdrawn
        // for staking. Only this may gate expedites; payouts come from the marker.
        let marker_after = (vault_liquid + liquid).saturating_sub(deployable);

        // Phase B: service redemptions.
        let plan = plan_service(
            &pending,
            vault_liquid + liquid,
            marker_after,
            unbonding,
            &dels,
            REDEMPTION_MARGIN_BPS,
        );
        for (validator, amount) in plan.undelegations {
            msgs.push(
                StakingMsg::Undelegate {
                    validator,
                    amount: coin(amount.u128(), &cfg.underlying_denom),
                }
                .into(),
            );
        }
        deploy_targets = plan_deploy(deployable, &validators);
```

and delete the now-duplicated later `deployable`/`deploy_targets` block (old lines 266-278). The burn-leg line (`burn_amt = plan_return(...)`) stays where it is between the two.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --lib plan::`
Expected: PASS, including the two new tests and the three updated ones.

- [ ] **Step 5: Verify the contract still builds and integration tests pass**

Run: `cargo run-script optimize-arm64 && cargo test`
Expected: PASS (test-tube suite unchanged in behavior: no pending swap-outs exist in those tests).

- [ ] **Step 6: Commit**

```bash
git add nvhash-staking/src/plan.rs nvhash-staking/src/epoch.rs nvhash-staking/artifacts
git commit -m "fix: gate swap-out expedites on principal-marker liquidity only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Admin recovery for stuck continuations + validator-set validation (F2)

**Files:**
- Modify: `src/error.rs` (three new variants)
- Modify: `src/msg.rs:18-35` (new `ExecuteMsg` variant)
- Modify: `src/contract.rs` (dispatch arm, validation, recovery handler, new unit-test module)

**Interfaces:**
- Consumes: `PENDING_DELEGATIONS: Item<Vec<(String, Uint128)>>`, `EPOCH: Item<EpochState>`, `assert_admin`.
- Produces: `ExecuteMsg::ClearPendingDelegations {}` (admin-gated), `fn validate_valopers(valopers: &[String]) -> Result<(), ContractError>`, `pub const MAX_VALIDATORS: usize = 50`.

- [ ] **Step 1: Write the failing unit tests** (append to `src/contract.rs`)

```rust
#[cfg(test)]
mod unit {
    use super::*;
    use crate::msg::{ExecuteMsg, InstantiateMsg};
    use crate::state::{EpochPhase, EPOCH, PENDING_DELEGATIONS};
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::{Addr, Uint128};

    fn setup(deps: cosmwasm_std::DepsMut, admin: &Addr, vault: &Addr) {
        instantiate(
            deps,
            mock_env(),
            message_info(admin, &[]),
            InstantiateMsg {
                admin: admin.to_string(),
                vault_address: vault.to_string(),
                underlying_denom: "nhash".to_string(),
                receipt_denom: "nvhash.staked".to_string(),
                validators: vec![],
                min_run_interval_secs: 0,
                max_delegations_per_run: 0,
            },
        )
        .unwrap();
    }

    #[test]
    fn clear_pending_delegations_resets_state() {
        let mut deps = mock_dependencies();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        setup(deps.as_mut(), &admin, &vault);
        PENDING_DELEGATIONS
            .save(
                deps.as_mut().storage,
                &vec![("tpvaloper1badbadbad".to_string(), Uint128::new(5))],
            )
            .unwrap();
        EPOCH
            .update(deps.as_mut().storage, |mut e| -> Result<_, ContractError> {
                e.phase = EpochPhase::Releasing;
                Ok(e)
            })
            .unwrap();

        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::ClearPendingDelegations {},
        )
        .unwrap();

        assert!(PENDING_DELEGATIONS.load(&deps.storage).unwrap().is_empty());
        let epoch = EPOCH.load(&deps.storage).unwrap();
        assert_eq!(epoch.phase, EpochPhase::Idle);
        // last_run must NOT advance: the aborted epoch may re-run immediately.
        assert_eq!(epoch.last_run.seconds(), 0);
    }

    #[test]
    fn clear_pending_delegations_rejects_non_admin() {
        let mut deps = mock_dependencies();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        let stranger = deps.api.addr_make("stranger");
        setup(deps.as_mut(), &admin, &vault);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&stranger, &[]),
            ExecuteMsg::ClearPendingDelegations {},
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::Unauthorized {}));
    }

    #[test]
    fn set_validators_rejects_account_shaped_address() {
        let mut deps = mock_dependencies();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        setup(deps.as_mut(), &admin, &vault);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::SetValidators {
                valopers: vec![admin.to_string()], // account address, not a valoper
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::InvalidValoper { .. }));
    }

    #[test]
    fn set_validators_rejects_duplicates() {
        let mut deps = mock_dependencies();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        setup(deps.as_mut(), &admin, &vault);
        let v = "tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqu3rmtu".to_string();
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::SetValidators {
                valopers: vec![v.clone(), v],
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::DuplicateValoper { .. }));
    }
}
```

Note: `message_info` is the cosmwasm-std 2.x test helper taking `&Addr`. If the pinned 2.2 build does not export it, use `mock_info(addr.as_str(), &[])` instead.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --lib contract::unit`
Expected: compile error (`ClearPendingDelegations` variant and `InvalidValoper`/`DuplicateValoper` errors do not exist).

- [ ] **Step 3: Implement**

`src/error.rs`, add to the enum:

```rust
    #[error("invalid valoper address: {valoper}")]
    InvalidValoper { valoper: String },

    #[error("duplicate valoper address: {valoper}")]
    DuplicateValoper { valoper: String },

    #[error("too many validators: max {max}")]
    TooManyValidators { max: u32 },
```

`src/msg.rs`, add to `ExecuteMsg` after `SetMaxDelegationsPerRun`:

```rust
    /// Admin-gated: abort a stuck epoch continuation by dropping the persisted
    /// delegation targets and returning to Idle. Safe: the withdrawn nhash stays in
    /// the contract balance and the next epoch's return leg burns the matching
    /// receipt and re-deposits it (TVV preserved).
    ClearPendingDelegations {},
```

`src/contract.rs`, dispatch arm in `execute`:

```rust
        ExecuteMsg::ClearPendingDelegations {} => exec_clear_pending_delegations(deps, &info),
```

new items (import `EpochPhase` in the existing `crate::state` use, and add the functions):

```rust
/// Hard cap on the configured validator set. Bounds the claim/unbond/delegate loops
/// so one epoch tx stays inside the 4M gas budget.
pub const MAX_VALIDATORS: usize = 50;

fn validate_valopers(valopers: &[String]) -> Result<(), ContractError> {
    if valopers.len() > MAX_VALIDATORS {
        return Err(ContractError::TooManyValidators {
            max: MAX_VALIDATORS as u32,
        });
    }
    let mut seen = std::collections::BTreeSet::new();
    for v in valopers {
        // Provenance valoper HRPs end in "valoper" (pbvaloper1..., tpvaloper1...).
        // An account address here would brick the delegate leg, so reject early.
        if !v.contains("valoper1") {
            return Err(ContractError::InvalidValoper { valoper: v.clone() });
        }
        if !seen.insert(v.clone()) {
            return Err(ContractError::DuplicateValoper { valoper: v.clone() });
        }
    }
    Ok(())
}

fn exec_clear_pending_delegations(
    deps: DepsMut,
    info: &MessageInfo,
) -> Result<Response, ContractError> {
    assert_admin(deps.as_ref(), info)?;
    let pending = PENDING_DELEGATIONS.load(deps.storage)?;
    let dropped: Uint128 = pending
        .iter()
        .map(|(_, a)| *a)
        .fold(Uint128::zero(), |s, a| s + a);
    PENDING_DELEGATIONS.save(deps.storage, &vec![])?;
    EPOCH.update(deps.storage, |mut e| -> Result<_, ContractError> {
        e.phase = EpochPhase::Idle;
        Ok(e)
    })?;
    Ok(Response::new()
        .add_attribute("action", "clear_pending_delegations")
        .add_attribute("dropped_nhash", dropped.to_string()))
}
```

and make `exec_set_validators` call `validate_valopers(&valopers)?;` immediately after `assert_admin`.

Also update the existing test-tube test `admin_sets_validators` (`src/tests.rs:315`): it currently passes `admin.address()` as a valoper, which the new validation rightly rejects. Replace with a valoper-shaped string:

```rust
    let valoper = "tpvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqu3rmtu".to_string();
    wasm.execute(
        contract.as_str(),
        &ExecuteMsg::SetValidators {
            valopers: vec![valoper.clone()],
        },
        &[],
        admin,
    )
    .unwrap();
```

and assert `resp.validators == vec![valoper]`. (`SetValidators` checks shape, not on-chain existence, so the fixed string is fine.)

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --lib contract::unit && cargo test --lib plan::`
Expected: PASS.

- [ ] **Step 5: Rebuild wasm, run the full suite**

Run: `cargo run-script optimize-arm64 && cargo test`
Expected: PASS, including the updated `admin_sets_validators`.

- [ ] **Step 6: Commit**

```bash
git add nvhash-staking/src nvhash-staking/artifacts
git commit -m "fix: add ClearPendingDelegations escape hatch and valoper validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Immediate loss recognition in the return leg (F4)

**Files:**
- Modify: `src/plan.rs:126-140` (`plan_return`) and its test at `src/plan.rs:181-193`
- Modify: `src/epoch.rs:261-264` (call site)

**Interfaces:**
- Consumes: `RECEIPT_MINTED`, live `staked` and `unbonding` reads in `run_epoch`.
- Produces: `plan_return(receipt_minted: Uint128, staked: Uint128, unbonding: Uint128) -> Uint128` (the `liquid` parameter is removed).

- [ ] **Step 1: Rewrite the test** (replace `plan_return_burns_only_matured_and_liquid`)

```rust
    #[test]
    fn plan_return_burns_everything_no_longer_out() {
        // nothing out, nothing to burn.
        assert_eq!(
            plan_return(Uint128::zero(), Uint128::zero(), Uint128::zero()),
            Uint128::zero()
        );
        // all matured back: burn all.
        assert_eq!(
            plan_return(Uint128::new(1000), Uint128::zero(), Uint128::zero()),
            Uint128::new(1000)
        );
        // still unbonding: not matured, burn nothing.
        assert_eq!(
            plan_return(Uint128::new(1000), Uint128::zero(), Uint128::new(1000)),
            Uint128::zero()
        );
        // partial: 600 staked + 300 unbonding of 1000 out: burn the 100 that returned.
        assert_eq!(
            plan_return(Uint128::new(1000), Uint128::new(600), Uint128::new(300)),
            Uint128::new(100)
        );
    }

    #[test]
    fn plan_return_recognizes_slash_immediately() {
        // 1000 deployed, validator slashed 5%: 950 still staked, nothing unbonding,
        // no liquid returned. The 50 must burn NOW (unbacked burn = TVV marks the
        // loss down), not wait for rewards to cover it.
        assert_eq!(
            plan_return(Uint128::new(1000), Uint128::new(950), Uint128::zero()),
            Uint128::new(50)
        );
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --lib plan::`
Expected: compile error (`plan_return` takes 4 arguments).

- [ ] **Step 3: Implement** (replace `plan_return` in `src/plan.rs`)

```rust
/// Decide how much receipt to burn this run (the return leg). `receipt_minted` is the
/// outstanding receipt (principal represented as "out"); `staked` + `unbonding` is what
/// is still genuinely out. The difference is principal that either matured back (its
/// nhash is in the contract balance being deposited this run) or was slashed (its nhash
/// is gone). Both must burn now: the matured part is backed by the deposit, and the
/// slashed part must mark TVV down immediately so redemptions cannot exit at an
/// overstated NAV between epochs.
pub fn plan_return(receipt_minted: Uint128, staked: Uint128, unbonding: Uint128) -> Uint128 {
    receipt_minted.saturating_sub(staked + unbonding)
}
```

`src/epoch.rs` call site (line 264): `burn_amt = plan_return(receipt_minted, staked, unbonding);` and update the comment above it:

```rust
        // Return leg sizing: everything the receipt says is out but is neither staked
        // nor unbonding has either returned (deposited as `liquid` above) or been
        // slashed. Burn it all; an unbacked burn is exactly how a slash marks TVV down.
        burn_amt = plan_return(receipt_minted, staked, unbonding);
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --lib plan::`
Expected: PASS.

- [ ] **Step 5: Rebuild wasm, full suite, commit**

Run: `cargo run-script optimize-arm64 && cargo test`
Expected: PASS.

```bash
git add nvhash-staking/src nvhash-staking/artifacts
git commit -m "fix: burn full matured receipt so slashes hit NAV immediately

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: Paginate the pending-swap-out and unbonding reads (F6)

**Files:**
- Modify: `src/epoch.rs:29-39` (`unbonding_total`), `src/epoch.rs:110-124` (`pending_redemptions`)

**Interfaces:**
- Consumes: `provwasm_std::types::cosmos::base::query::v1beta1::PageRequest`.
- Produces: same function signatures, now looping `pagination.next_key` until exhausted. Malformed amounts now error instead of silently counting as zero.

- [ ] **Step 1: Implement** (no pure test is practical: the flaw is only visible with >100 on-chain records. Verification is compile + suite + the devnet check in step 3.)

Add imports to `src/epoch.rs`:

```rust
use cosmwasm_std::StdError;
use provwasm_std::types::cosmos::base::query::v1beta1::PageRequest;
```

Add a helper and rewrite both readers:

```rust
const PAGE_LIMIT: u64 = 100;

fn page(key: Vec<u8>) -> Option<PageRequest> {
    Some(PageRequest {
        key,
        offset: 0,
        limit: PAGE_LIMIT,
        count_total: false,
        reverse: false,
    })
}

/// Total principal currently unbonding (in-flight, not yet matured) for the contract,
/// summed across all unbonding entries. Paginated: truncating this read would make the
/// service leg re-unbond principal that is already on its way back.
fn unbonding_total(deps: Deps, env: &Env) -> StdResult<Uint128> {
    let sq = StakingQuerier::new(&deps.querier);
    let mut total = Uint128::zero();
    let mut key: Vec<u8> = vec![];
    loop {
        let resp =
            sq.delegator_unbonding_delegations(env.contract.address.to_string(), page(key))?;
        for u in resp.unbonding_responses {
            for e in u.entries {
                total += Uint128::from_str(&e.balance).map_err(|_| {
                    StdError::generic_err(format!("bad unbonding balance: {}", e.balance))
                })?;
            }
        }
        key = resp.pagination.map(|p| p.next_key).unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok(total)
}
```

```rust
/// Read pending swap-outs redeeming in the underlying denom, with their estimated nhash
/// needs. Paginated: a truncated read under-reserves and lets later requests mature
/// unfunded (refund = cancelled redemption).
fn pending_redemptions(deps: Deps, cfg: &Config) -> StdResult<Vec<(u64, Uint128)>> {
    let vq = VaultQuerier::new(&deps.querier);
    let mut out = vec![];
    let mut key: Vec<u8> = vec![];
    loop {
        let resp = vq.vault_pending_swap_outs(cfg.vault_address.to_string(), page(key))?;
        for e in resp.pending_swap_outs {
            if let Some(p) = e.pending_swap_out {
                if p.redeem_denom == cfg.underlying_denom || p.redeem_denom.is_empty() {
                    let est = estimate_redeem_nhash(deps, cfg, &p)?;
                    out.push((e.request_id, est));
                }
            }
        }
        key = resp.pagination.map(|p| p.next_key).unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok(out)
}
```

- [ ] **Step 2: Run the suite**

Run: `cargo test --lib && cargo run-script optimize-arm64 && cargo test`
Expected: PASS (behavior identical below 100 records).

- [ ] **Step 3: Devnet spot check (manual, once):** queue 101+ tiny swap-outs with `vault-chain-setup/drone-swaps.sh`, run `ServiceRedemptions`, confirm the emitted undelegations cover the whole queue, not the first page.

- [ ] **Step 4: Commit**

```bash
git add nvhash-staking/src nvhash-staking/artifacts
git commit -m "fix: paginate pending-swap-out and unbonding reads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: Respect the staking module's unbonding-entry limit (F7)

**Files:**
- Modify: `src/plan.rs:30-46` (`plan_unbond`), `plan_service` (thread the new argument), tests
- Modify: `src/epoch.rs` (`unbonding_total` becomes `unbonding_state`, both callers)

**Interfaces:**
- Consumes: `delegator_unbonding_delegations` responses (already paginated by Task 4).
- Produces: `pub const MAX_UNBOND_ENTRIES: usize = 7;`, `plan_unbond(delegations, shortfall, at_capacity: &[String])`, `plan_service(pending, cover_liquid, expedite_liquid, unbonding, delegations, at_capacity: &[String], margin_bps)` (final signature), `fn unbonding_state(deps, env) -> StdResult<(Uint128, Vec<String>)>` returning (total unbonding, valopers at entry capacity).

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn plan_unbond_skips_validators_at_entry_capacity() {
        let dels = vec![
            DelegationView { valoper: "valA".into(), staked: Uint128::new(300) },
            DelegationView { valoper: "valB".into(), staked: Uint128::new(100) },
        ];
        // valA has 7 in-flight unbonding entries: one more Undelegate against it would
        // fail the whole tx. Spill to valB and leave the rest uncovered (safe: the
        // shortfall retries next crank once entries mature).
        let plan = plan_unbond(&dels, Uint128::new(150), &["valA".to_string()]);
        assert_eq!(plan, vec![("valB".into(), Uint128::new(100))]);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --lib plan::`
Expected: compile error (`plan_unbond` takes 2 arguments).

- [ ] **Step 3: Implement**

`src/plan.rs`:

```rust
/// Cosmos SDK staking MaxEntries: at most this many concurrent unbonding entries per
/// (delegator, validator) pair; an Undelegate beyond it fails the whole tx.
/// [VERIFY] Provenance mainnet staking params still use the SDK default of 7.
pub const MAX_UNBOND_ENTRIES: usize = 7;

/// Unbond from the largest delegations first until `shortfall` is covered, skipping
/// validators whose unbonding-entry queue is full (`at_capacity`). Ties broken by
/// valoper string for determinism. Never unbonds more than a validator's staked amount.
/// May return less than `shortfall` if every candidate is at capacity; the uncovered
/// remainder is retried on later cranks as entries mature.
pub fn plan_unbond(
    delegations: &[DelegationView],
    shortfall: Uint128,
    at_capacity: &[String],
) -> Vec<(String, Uint128)> {
    let mut sorted: Vec<&DelegationView> = delegations
        .iter()
        .filter(|d| !at_capacity.contains(&d.valoper))
        .collect();
    sorted.sort_by(|a, b| b.staked.cmp(&a.staked).then(a.valoper.cmp(&b.valoper)));
    let mut remaining = shortfall;
    let mut out = vec![];
    for d in sorted {
        if remaining.is_zero() {
            break;
        }
        let take = remaining.min(d.staked);
        if !take.is_zero() {
            out.push((d.valoper.clone(), take));
            remaining -= take;
        }
    }
    out
}
```

`plan_service` gains `at_capacity: &[String]` between `delegations` and `margin_bps` and passes it through to `plan_unbond`. Update all `plan_service`/`plan_unbond` tests to pass `&[]` for `at_capacity` (except the new one above).

`src/epoch.rs`: rename `unbonding_total` to `unbonding_state` and collect capacity while summing:

```rust
/// Total principal currently unbonding for the contract, plus the validators whose
/// unbonding-entry queue is already at MAX_UNBOND_ENTRIES (planning another Undelegate
/// against them would revert the whole crank).
fn unbonding_state(deps: Deps, env: &Env) -> StdResult<(Uint128, Vec<String>)> {
    let sq = StakingQuerier::new(&deps.querier);
    let mut total = Uint128::zero();
    let mut at_capacity = vec![];
    let mut key: Vec<u8> = vec![];
    loop {
        let resp =
            sq.delegator_unbonding_delegations(env.contract.address.to_string(), page(key))?;
        for u in resp.unbonding_responses {
            if u.entries.len() >= MAX_UNBOND_ENTRIES {
                at_capacity.push(u.validator_address.clone());
            }
            for e in u.entries {
                total += Uint128::from_str(&e.balance).map_err(|_| {
                    StdError::generic_err(format!("bad unbonding balance: {}", e.balance))
                })?;
            }
        }
        key = resp.pagination.map(|p| p.next_key).unwrap_or_default();
        if key.is_empty() {
            break;
        }
    }
    Ok((total, at_capacity))
}
```

(import `MAX_UNBOND_ENTRIES` from `crate::plan`). Both callers become:

```rust
    let (unbonding, at_capacity) = unbonding_state(deps, env)?;
```

(in `run_epoch`: `unbonding_state(d, &env)?`), and both `plan_service` calls pass `&at_capacity`.

- [ ] **Step 4: Run to verify pass, rebuild, full suite, commit**

Run: `cargo test --lib plan:: && cargo run-script optimize-arm64 && cargo test`
Expected: PASS.

```bash
git add nvhash-staking/src nvhash-staking/artifacts
git commit -m "fix: skip validators at the unbonding MaxEntries limit when planning unbonds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: AUM-fee reserve on the right basis (F8)

The fee accrues on the whole TVV (`TVV × aum_fee_bps/10000 × elapsed/31,536,000`), not on the liquid slice, and it is skimmed from the marker's liquid nhash at each reconcile. provwasm-std 2.8.0's `VaultAccount` exposes **no fee fields** (verified against the crate source), so the rate cannot be queried; it becomes an admin-set config mirror of the vault's fee. [VERIFY] when a provwasm-std release exposes the vault fee fields, replace the config knob with the query.

**Files:**
- Modify: `src/state.rs` (`Config.aum_fee_bps`), `src/msg.rs` (instantiate field + setter + response field), `src/contract.rs` (wire all three), `src/plan.rs` (pure `fee_reserve`), `src/epoch.rs` (use it; extend the vault read to also return TVV)

**Interfaces:**
- Consumes: `QueryVaultResponse.total_vault_value: Option<Coin>` (denominated in the vault's underlying = receipt units = 1:1 nhash).
- Produces: `pub fn fee_reserve(tvv: Uint128, aum_fee_bps: u64, horizon_secs: u64) -> Uint128` in `src/plan.rs`; `fn vault_snapshot(deps, cfg) -> StdResult<(Uint128, Uint128)>` in `src/epoch.rs` returning (principal liquid nhash, TVV); `Config.aum_fee_bps: u64`; `ExecuteMsg::SetAumFeeBps { bps: u64 }`.

- [ ] **Step 1: Write the failing test** (`src/plan.rs`)

```rust
    #[test]
    fn fee_reserve_scales_with_tvv_and_time() {
        // 1e9 TVV at 15 bps over 30 days:
        // 1e9 * 15/10000 = 150_000 per year; * 2_592_000/31_536_000 = 12_328 (floor).
        assert_eq!(
            fee_reserve(Uint128::new(1_000_000_000), 15, 2_592_000),
            Uint128::new(12_328)
        );
        assert_eq!(fee_reserve(Uint128::new(1_000_000_000), 0, 2_592_000), Uint128::zero());
        assert_eq!(fee_reserve(Uint128::new(1_000_000_000), 15, 0), Uint128::zero());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --lib plan::`
Expected: FAIL, `fee_reserve` not found.

- [ ] **Step 3: Implement**

`src/plan.rs`:

```rust
/// Seconds per year used by the vault module's AUM accrual (365-day year).
const YEAR_SECONDS: u128 = 31_536_000;

/// nhash the deploy leg must leave liquid so the vault can pay the AUM fee that will
/// accrue over `horizon_secs`. The fee accrues on the whole TVV and is skimmed from the
/// principal marker's liquid nhash at each reconcile; deploying it away starves the fee
/// (observed live: fee went unpaid and was booked outstanding).
pub fn fee_reserve(tvv: Uint128, aum_fee_bps: u64, horizon_secs: u64) -> Uint128 {
    if aum_fee_bps == 0 || horizon_secs == 0 {
        return Uint128::zero();
    }
    tvv.multiply_ratio(aum_fee_bps as u128, 10_000u128)
        .multiply_ratio(horizon_secs as u128, YEAR_SECONDS)
}
```

`src/state.rs`, add to `Config` (after `max_delegations_per_run`):

```rust
    /// Mirror of the vault's AUM fee rate in bps. provwasm-std 2.8.0 cannot query the
    /// vault's fee fields, so the admin keeps this in sync; the deploy leg reserves the
    /// fee that will accrue on TVV before roughly the next two epochs.
    pub aum_fee_bps: u64,
```

`src/msg.rs`: add `#[serde(default)] pub aum_fee_bps: u64` to `InstantiateMsg`, `pub aum_fee_bps: u64` to `ConfigResponse`, and to `ExecuteMsg`:

```rust
    /// Admin-gated: set the mirror of the vault's AUM fee rate (bps) used to size the
    /// liquid fee reserve the deploy leg leaves behind.
    SetAumFeeBps { bps: u64 },
```

`src/contract.rs`: copy the field in `instantiate` (`aum_fee_bps: msg.aum_fee_bps,`) and `query` (`aum_fee_bps: c.aum_fee_bps,`), and add the setter (same shape as `exec_set_min_interval`):

```rust
        ExecuteMsg::SetAumFeeBps { bps } => exec_set_aum_fee_bps(deps, &info, bps),
```

```rust
fn exec_set_aum_fee_bps(
    deps: DepsMut,
    info: &MessageInfo,
    bps: u64,
) -> Result<Response, ContractError> {
    assert_admin(deps.as_ref(), info)?;
    CONFIG.update(deps.storage, |mut c| -> Result<_, ContractError> {
        c.aum_fee_bps = bps;
        Ok(c)
    })?;
    Ok(Response::new().add_attribute("action", "set_aum_fee_bps"))
}
```

`src/epoch.rs`: replace `vault_principal_liquid` with a snapshot that also returns TVV:

```rust
/// (liquid nhash in the vault's principal marker, total vault value). TVV is reported
/// in the vault's underlying denom (the receipt), which is valued 1:1 to nhash.
fn vault_snapshot(deps: Deps, cfg: &Config) -> StdResult<(Uint128, Uint128)> {
    let vq = VaultQuerier::new(&deps.querier);
    let resp = vq.vault(cfg.vault_address.to_string())?;
    let liquid = resp
        .principal
        .and_then(|p| {
            p.coins
                .into_iter()
                .find(|c| c.denom == cfg.underlying_denom)
                .map(|c| c.amount)
        })
        .unwrap_or_default();
    let tvv = resp
        .total_vault_value
        .map(|c| c.amount)
        .unwrap_or_default();
    Ok((
        Uint128::from_str(&liquid).unwrap_or_default(),
        Uint128::from_str(&tvv).unwrap_or_default(),
    ))
}
```

Callers: `let (vault_liquid, tvv) = vault_snapshot(deps, &cfg)?;` (in `service_redemptions` ignore `tvv` with `let (vault_liquid, _tvv) = ...`). In `run_epoch`, the buffer becomes the larger of the fee reserve over two epochs and the old 50 bps floor:

```rust
        let deployable = if validators.is_empty() {
            Uint128::zero()
        } else {
            // Reserve the AUM fee that accrues on TVV before roughly the next two
            // epochs, floored by a small fraction of liquid for reconcile races.
            let horizon = cfg.min_run_interval_secs.saturating_mul(2);
            let buffer = fee_reserve(tvv, cfg.aum_fee_bps, horizon)
                .max(vault_liquid.multiply_ratio(DEPLOY_BUFFER_BPS, 10_000u128));
            vault_liquid.saturating_sub(need + buffer)
        };
```

(import `fee_reserve` from `crate::plan`). Update `src/tests.rs` `setup_wasm`'s `InstantiateMsg` with `aum_fee_bps: 0,`.

- [ ] **Step 4: Regenerate schema, run everything, commit**

Run: `cargo run --bin schema && cargo test --lib && cargo run-script optimize-arm64 && cargo test`
Expected: PASS.

```bash
git add nvhash-staking/src nvhash-staking/schema nvhash-staking/artifacts
git commit -m "fix: reserve accrued AUM fee on TVV instead of a bps-of-liquid guess

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: Claim rewards from every delegated validator, not just the config set (F9)

**Files:**
- Modify: `src/plan.rs:49-55` (`plan_claim`) + test at `src/plan.rs:249-254`

**Interfaces:**
- Consumes: `validators_with_rewards` already queries rewards for ALL of the contract's delegations (`query_delegation_total_rewards`); only the `plan_claim` filter drops non-config validators.
- Produces: `plan_claim(validators, with_rewards) -> Vec<String>`: config-order validators first, then any other reward-bearing validators sorted for determinism.

- [ ] **Step 1: Write the failing test** (replace `plan_claim_filters_to_validators_with_rewards`)

```rust
    #[test]
    fn plan_claim_includes_removed_validators_with_rewards() {
        let vals = vec!["valA".to_string(), "valB".to_string()];
        // valZ was removed from config but still has a live delegation with rewards:
        // its rewards must keep being claimed or they strand until the next unbond.
        let with = vec!["valZ".to_string(), "valA".to_string()];
        assert_eq!(
            plan_claim(&vals, &with),
            vec!["valA".to_string(), "valZ".to_string()]
        );
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --lib plan::`
Expected: FAIL (current filter drops `valZ`).

- [ ] **Step 3: Implement**

```rust
/// Validators to claim from: config validators (config order) that have rewards, then
/// any other validator the contract still has reward-bearing delegations with (e.g.
/// removed from config but not yet unbonded), sorted for determinism.
pub fn plan_claim(validators: &[String], with_rewards: &[String]) -> Vec<String> {
    let mut out: Vec<String> = validators
        .iter()
        .filter(|v| with_rewards.contains(v))
        .cloned()
        .collect();
    let mut extras: Vec<String> = with_rewards
        .iter()
        .filter(|w| !validators.contains(w))
        .cloned()
        .collect();
    extras.sort();
    out.extend(extras);
    out
}
```

- [ ] **Step 4: Run, rebuild, full suite, commit**

Run: `cargo test --lib plan:: && cargo run-script optimize-arm64 && cargo test`
Expected: PASS.

```bash
git add nvhash-staking/src nvhash-staking/artifacts
git commit -m "fix: keep claiming rewards from validators removed from the config set

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Observability queries (F10)

**Files:**
- Modify: `src/msg.rs` (query variant + response types), `src/contract.rs` (query arm + unit test)

**Interfaces:**
- Consumes: `EPOCH`, `RECEIPT_MINTED`, `PENDING_DELEGATIONS`.
- Produces: `QueryMsg::EpochStatus {}` returning `EpochStatusResponse { phase: String, last_run_seconds: u64, receipt_minted: Uint128, pending_delegations: Vec<PendingDelegation> }` with `PendingDelegation { valoper: String, amount: Uint128 }`. The ops dashboard (`vault-sloppy-dash`) reads this instead of guessing from events.

- [ ] **Step 1: Write the failing unit test** (append to `mod unit` in `src/contract.rs`)

```rust
    #[test]
    fn epoch_status_query_reports_state() {
        let mut deps = mock_dependencies();
        let admin = deps.api.addr_make("admin");
        let vault = deps.api.addr_make("vault");
        setup(deps.as_mut(), &admin, &vault);
        PENDING_DELEGATIONS
            .save(
                deps.as_mut().storage,
                &vec![("tpvaloper1abc".to_string(), Uint128::new(7))],
            )
            .unwrap();

        let bin = query(deps.as_ref(), mock_env(), crate::msg::QueryMsg::EpochStatus {}).unwrap();
        let resp: crate::msg::EpochStatusResponse = cosmwasm_std::from_json(&bin).unwrap();
        assert_eq!(resp.phase, "Idle");
        assert_eq!(resp.last_run_seconds, 0);
        assert_eq!(resp.receipt_minted, Uint128::zero());
        assert_eq!(resp.pending_delegations.len(), 1);
        assert_eq!(resp.pending_delegations[0].valoper, "tpvaloper1abc");
        assert_eq!(resp.pending_delegations[0].amount, Uint128::new(7));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --lib contract::unit`
Expected: compile error (`EpochStatus` variant does not exist).

- [ ] **Step 3: Implement**

`src/msg.rs` (add `use cosmwasm_std::Uint128;`):

```rust
#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(EpochStatusResponse)]
    EpochStatus {},
}

#[cw_serde]
pub struct EpochStatusResponse {
    pub phase: String,
    pub last_run_seconds: u64,
    pub receipt_minted: Uint128,
    pub pending_delegations: Vec<PendingDelegation>,
}

#[cw_serde]
pub struct PendingDelegation {
    pub valoper: String,
    pub amount: Uint128,
}
```

`src/contract.rs` query arm (import `EpochStatusResponse`, `PendingDelegation`):

```rust
        QueryMsg::EpochStatus {} => {
            let e = EPOCH.load(deps.storage)?;
            let receipt_minted = RECEIPT_MINTED.load(deps.storage)?;
            let pending = PENDING_DELEGATIONS.load(deps.storage)?;
            to_json_binary(&EpochStatusResponse {
                phase: format!("{:?}", e.phase),
                last_run_seconds: e.last_run.seconds(),
                receipt_minted,
                pending_delegations: pending
                    .into_iter()
                    .map(|(valoper, amount)| PendingDelegation { valoper, amount })
                    .collect(),
            })
        }
```

- [ ] **Step 4: Regenerate schema, run everything, commit**

Run: `cargo run --bin schema && cargo test --lib && cargo run-script optimize-arm64 && cargo test`
Expected: PASS.

```bash
git add nvhash-staking/src nvhash-staking/schema nvhash-staking/artifacts
git commit -m "feat: add EpochStatus query for phase, receipt counter, pending delegations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Part 4: Launch blockers outside the contract (no code in this repo)

**O1 (F3, blocks any real TVL): uint64 share ceiling.** (a) **In flight (2026-07-02):** governance proposal raising `x/marker` max_supply to `1e24` (prior max_supply × the `1e6` share scalar; the `gov-bump-max-supply.sh` flow, proven on devnet). Note the implied program ceiling: `1e24` shares / `1e6` scalar = `1e18` nhash = ~1B HASH of TVL before another bump is needed. Verified against mainnet 2026-07-02: nhash supply is `9.5e19` (95B HASH) and the pre-bump marker `max_supply` param is `1e18+1`, so the post-bump ceiling is ~1.05% of total HASH supply: far away, but real, and a runbook item rather than a code change. (b) **Fix scheduled in vault module 1.2.x, not launch-gating:** once volume exceeds uint64, `setShareDenomNAV` will publish the share NAV as a reduced ratio instead of skipping. Launching before 1.2.x is acceptable: the skip only staleness the share marker's NAV record (a convenience record); vault pricing, TVV, and payouts read on-chain state directly. Until 1.2.x is deployed, consumers of that record (bridge rate source, indexers, UI) should price from the vault query instead; after 1.2.x, note the ratio-form `volume` is no longer the literal total share count.

**O2 (F5): receipt-denom redemptions.** Decide the policy with ProvLabs: ideally the vault gains a per-vault restriction of `redeem_denom` to the payment denom; otherwise keep `nvhash.pb` attribute grants strictly to program-controlled accounts and document that any attributed holder can extract receipt via SwapOut. Also [VERIFY] with ProvLabs: what denom an empty `redeem_denom` defaults to (if it defaults to the vault underlying, i.e. the receipt, the contract's `is_empty()` branch in `pending_redemptions` sizes the wrong asset and should be dropped or re-priced).

**O3: expedite-of-unfunded semantics.** Task 1 removes the trigger, but confirm the module behavior anyway (it is the failure mode's blast radius): an expedited `PendingSwapOut` that cannot be paid refunds the escrowed shares rather than staying queued. If it stays queued instead, F1's severity drops to "harmless"; if it refunds, F1 was user-facing cancellation. Check `payout.go` on the deployed build.

**O4 (F11): gas profile.** On devnet, run a full epoch (rewards on all validators + a queued redemption + a deploy) against a 50-validator set and record gas. If it approaches 4M, take the existing `EpochState.cursor`/phase machine out of dead-code status and chunk phases A and B the way D1 already is; if it stays comfortably under, delete the unused `cursor` and phases instead.

**O5: withdrawal-delay invariant.** Nothing on-chain ties the vault's `withdrawal_delay_seconds` to the contract's `min_run_interval_secs`. The invariant `withdrawal_delay >= min_run_interval + unbonding_period + pause windows + buffer` (~60 days for a monthly epoch) lives in ops. Add the check to `nvhash-deploy.sh` (it can read both values) and to the vault-manager runbook Steve is building for the in-cluster asset-manager work.

**O6: contract migration.** The contract has no `migrate` entry point. Fine for a POC; before mainnet decide whether the code should be migratable (add `#[entry_point] pub fn migrate` + admin on the code) or immutable by policy.

---

## Self-Review

- Spec coverage: F1 → Task 1, F2 → Task 2, F4 → Task 3, F6 → Task 4, F7 → Task 5, F8 → Task 6, F9 → Task 7, F10 → Task 8, F3/F5/F11 and the verify items → Part 4. F12 is a deployment-convention note.
- Signature consistency: `plan_service` ends at 7 parameters (`pending, cover_liquid, expedite_liquid, unbonding, delegations, at_capacity, margin_bps`) after Task 5; Task 1 introduces the 6-parameter intermediate form and Task 5 shows the final form and updates all callers and tests. `plan_return` drops to 3 parameters in Task 3; `plan_unbond` gains `at_capacity` in Task 5; `vault_snapshot` replaces `vault_principal_liquid` in Task 6 and `unbonding_state` replaces `unbonding_total` in Task 5 (Task 4 modifies `unbonding_total` in place; Task 5 renames it, both are shown in full).
- Known intentional deferrals: validator uptime/eligibility, uniform-slot rebalance, commission/TIP, and the bridge remain out of scope exactly as the POC spec (§8) deferred them.
