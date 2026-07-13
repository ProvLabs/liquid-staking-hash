# Vault module payment-denom collapse assessment (2026-07-02)

> Migrated 2026-07-13 from `nvhash-cosmos-contracts` @ dbce15e, source `docs/history/2026-07-02-vault-payment-denom-collapse-assessment.md`. Historical record, preserved verbatim; paths reference the exploratory repository.

> **HISTORICAL REFERENCE.** Internal assessment of collapsing `payment_denom == underlying_asset` in the ProvLabs vault module, transcribed from the team thread. A few lines were truncated in the source transcription and are marked `[...]`. This is the motivating document for Design C (spec v1.2): the receipt token moves from the payment-denom pattern to the settlement / held-asset model.

The sweep is done, and the short answer is: yes, this is possible, it actually strengthens the AUM protocol rather than fighting it, and the codebase has already quietly converged on the model you're describing. Here's my full assessment.

## Where the payment denom is actually load-bearing

The module already treats underlying_asset as the sole valuation base. Interest is settled exclusively in underlying (keeper/reconcile.go:235), TVV/net TVV/share NAV are all expressed in underlying, and the valuation engine has an identity fast-path when payment == underlying (keeper/valuation_engine.go:83). The payment denom only matters in three places:

1. Swap I/O allowlist: AcceptedDenoms() returns {underlying, payment} (types/vault.go:373), swap-in accepts either, and swap-out's redeem_denom defaults to the payment denom (keeper/vault.go:372).
2. AUM fee collection: the fee accrues on gross TVV in underlying, gets converted to payment denom for collection, and outstanding_aum_fee is stored in payment denom with an invariant enforcing that (keeper/reconcile.go:335, types/vault.go:294).
3. P2P settlement direction: exactly one leg of an AcceptAsset payment must carry the payment denom, which determines inbound vs outbound (keeper/msg_server.go:1015).

Notably, both underlying_asset and payment_denom are immutable after creation, and there is no message to rotate them. So "disallowing the two" is purely a creation-time validation change plus a one-time migration. There's no runtime mutation path to close off.

## Does it make sense with the AUM protocol? Yes, it simplifies it

Today the fee path round-trips: accrue in underlying → convert to payment denom via NAV for collection → store outstanding_aum_fee in payment denom → convert back to underlying to compute net TVV for share pricing. With payment == underlying, every one of those conversions hits the identity fast-path and becomes a no-op. You lose:

- The floor-rounding drift from the double conversion.
- A whole failure class: fee reconcile currently reschedules when the payment NAV conversion fails (the "missing NAV for denom conversion" transient in handleVaultFeeTimeouts). That can't happen with a single denom.
- A trust surface: right now the NAV authority moving the payment denom's price changes the real-world value of the fee being collected.

The one thing to watch: a composite vault holding mostly child-vault shares may not have much underlying liquidity in the principal marker, so the fee will accumulate as outstanding_aum_fee liability rather than being collected. The mechanism for that already exists (partial collection is a success, and the liability is netted out of share pricing), so pricing stays correct. It just means collection lags until the asset manager rebalances into underlying. Swap-outs have the same liquidity constraint, but that's already true today for receipt-token vaults, so it's no problem.

## "Use the payment system to host composite vaults" is coherent

The valuation side of composite vaults already works: GetTVVInUnderlyingAsset walks the internal NAV table and values any held denom at the principal marker (keeper/valuation_engine.go:239), and nothing forbids another vault's share denom (it's a registered marker; only the vault's own share denom is rejected, keeper/nav.go:30). With payment == underlying, settlement direction detection keeps working unchanged, since PaymentDenom already defaults to underlying. An inbound settlement becomes "vault pays underlying, receives child-vault shares," which is exactly your composite acquisition flow, and the exact-price guardrail plus price recording keeps it auditable.

Two things composite vaults still need that don't exist yet:

- Share-marker transfer plumbing. Vault share markers are restricted. Settling child-vault shares into a parent vault's principal marker has to clear the child share marker's send restrictions and transfer [...] feasibility question, and it's a marker-permission design problem, not a vault-module one. I'd verify this specific flow in the POC before committing to the direction.
- Pricing freshness. The parent vault never reads marker NAVs back, so the child's published share NAV (the recent #234 work) does not automatically flow into the parent's internal table. The parent's NAV [authority keeps the] share entry current via UpdateVaultNAV. Since both vaults live in the same keeper, there's a future opportunity here: derive a held vault-share denom's price live from the child's own net TVV / total shares instead of requiring manual NAV updates. That would make composite pricing self-consistent, but it's follow-on work, not a blocker.

## The testnet removal is the hairiest part, and I'd collapse

There is no existing delete-vault routine, and full deletion [...] can't be burned out of wallets (marker burn only burns from the marker account), and you'd have to clean the payout timeout queue, fee timeout queue, verification set, pending swap-out queue, NAV entries, and the share marker itself. The blocker code does tolerate missing [...], which helps, but orphaned share tokens in user wallets are ugly even on testnet.

A collapse migration is much safer: for each vault where Pa[ymentDenom differs], set PaymentDenom = UnderlyingAsset, convert outstanding_aum_fee to underlying via the existing NAV (to preserve the denom invariant at types/vault.go:294), and leave the old payment denom's NAV entry in place. The old payment-denom balances in the principal then just become "held assets" valued through the NAV walk, exactly like a settled asset, and TVV is unchanged. Pending swap-outs with the old payment denom as redeem denom will still convert (payout uses the stored NAV, not the accepted-denom check), or refund cleanly if you'd r[ather force that op]tion. The existing idempotent iterate-all-vaults migrations (keeper/migrations.go:41 and :101) are the template, and note that MigrateVaultAccountPaymentDenomDefaults isn't wired to any upgrade handler in this repo, so the wiring happens downstream on the chain si[de].

## Recommendation

Do it, staged:

1. Validation first: reject MsgCreateVault where payment_denom is set and differs from underlying, and require initial_payment_nav to be omitted. Cheap, reversible, stops new differing vaults immediately.
2. Collapse migration for existing testnet vaults (v2→v3), rather than deletion.
3. POC the composite settlement flow end to end on testnet, specifically the child-share marker transfer restrictions, before building anything more on top.
4. Proto cleanup later: deprecate payment_denom, initial_payment_nav, and the redeem_denom payment-default semantics once the field is uniformly equal to underlying. Removing the fields outright is state-[breaking, so defer].

What you give up: users can no longer redeem shares into a [different payment coin] (from a uylds vault, for instance), and the receipt-token-as-payment-denom pattern moves to the settlement/held-asset model instead, which I'd argue is where it belonged anyway. The uylds.fcc 1:1 peg special case for payment denoms also dies with this.

Confidence (as stated in the source): confident on the code structure and the AUM fee mechanics (verified against reconcile.go, valuation_engine.go, and the specs). The one inferred part: whether restricted [share markers] permit settlement transfers of child-vault shares into another vault's principal under current marker permissions. That depends on how the share markers' transfer authority and required attributes are configured; a small testnet POC of one AcceptAsset with a child-share leg would resolve it.
