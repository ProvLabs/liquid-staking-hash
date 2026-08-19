# Staking Contract — Audit Surface & Permissions Overview

## Abstract

This document provides an orientation for the third-party audit of the nvHASH
staking contract.  It describes the external surface of the contract and the
permissions model that secures it, with references to the governing documents
where full detail is recorded.  This document is descriptive rather than
normative; where any conflict exists the specification governs, followed by
the code and its committed schema.

## Scope

The subject of the audit is the CosmWasm staking contract.  This includes the
`contracts/` crate (`contracts/src/`), the committed schema under
`contracts/schema/`, and the authorities the contract holds over the vault.

Several adjacent components are excluded from scope.  The ProvLabs vault
module is audited upstream and is consumed by the contract as specified in
spec §5.  The web applications and backend services are separate systems that
hold no contract authority.  The NUVA Labs bridge destination-chain contracts
are covered by their own audit; the bridge trust model is bounded in spec
§12.2, and the bridge adapter is a distinct address holding no asset-manager
authority.

## Context

The staking contract acts as the asset manager for the nvHASH vault.  In this
role it delegates, undelegates, and redelegates program stake, claims staking
rewards, deposits realized returns directly into vault principal, and services
redemptions (spec §4, §6).  Carrying out these functions requires the contract
to hold three authorities, each of which is enumerated as a trust surface in
`SECURITY.md` and spec §12:

1.  **Vault asset-manager authority.** Permits settlements against the vault,
   principal deposits while paused, redemption expedites, and vault pause and
   unpause (spec §5, §11.4).
2.  **Receipt mint and burn.** The contract holds Transfer access on the
   restricted receipt marker along with marker mint and burn, supporting the
   settlement-based receipt model of spec §5.1.
3.  **Vault NAV authority.** This authority exists solely to support the slash
write-down sandwich described in spec §9.9.  It is explicitly identified as
   in scope for the audit in spec §12.

## Surface Area

The complete endpoint contracts are recorded in spec §11.2 (execute) and §11.3
(query).  Message types are defined in `contracts/src/msg.rs` and the
committed JSON schema lives under `contracts/schema/`.  The entry points fall
into the following permission tiers.

**Admin gated.** `UpdateConfig`, `SetHalted`, `ClearPendingDelegations`,
`PauseVault`, and `UnpauseVault` require the caller to match the configured
`Config.admin` address.  This check is performed by `assert_admin` in
`contracts/src/contract.rs`.

**Operator gated.** `RegisterParticipation` may only be called by the
operator account of the validator being enrolled; the caller's identity is
proven by matching the bech32 key payload against the valoper address, and the
validator's existence is verified on chain.  `UnregisterParticipation` accepts
either the operator or the admin.

**Permissionless with funds attached.** `PayCommission` and `PayTip` are open
to any payer.  Attached nhash is non-refundable and is swept into vault
principal at the next epoch's deposit leg.

**Permissionless cranks.** `RunEpoch`, `ClaimRewards`, `ServiceRedemptions`,
`CaptureUptimeSignal`, `ReportJailedValidator`, and `PurgeJailedValidator` may
be called by anyone.  The fund-moving cranks are subject to the admin halt.
`RunEpoch` is additionally guarded by the epoch interval, and a jail purge
requires a prior report, an elapsed cooldown, and live re-verification that
the validator remains jailed (spec §9.8).  The redelegation path of
`PurgeJailedValidator` further requires that the caller be the enrolled
operator of the claiming validator.

**Queries.** `Config`, `Validators`, `JailReports`, `EpochStatus`,
`EpochSnapshot`, `Apr`, and `ReceiptAccounting` are public and read-only, with
iteration bounded by the validator ceiling.

**Lifecycle.** `instantiate` runs once and sets the `admin` address; no
rotation variant exists in `ExecuteMsg`.  The `migrate` entry point is
authorized by wasmd rather than by contract code: only the contract's CosmWasm
admin may submit `MsgMigrateContract`.  An in-contract cw2 gate rejects
artifacts with a foreign contract name and rejects version downgrades (spec
§11.2, "Migration").

Note: the contract exports no `sudo` or `reply` entry point, and there are no
admin-submitted data paths.  Uptime is read from the chain's own slashing
`SigningInfo` records (spec §10.3) and the rebalance plan is computed inside
the contract (spec §9.0).  There is no oracle and no plan-submission authority
to review.

## Permissions Model

All privileged authority in the system is held by `x/group` policy accounts
rather than single keys.  The contract itself checks only that the caller
matches the configured `admin` address; proposal, vote, and execution
mechanics are handled by the group module and are verifiable on chain
(spec §12.1).  Group membership can be rotated without redeploying the
contract, and approvals are threshold gated.

Every non-devnet deployment creates two policies at bootstrap: a
fund-administration (admin) policy and an operations policy.  The deployment
record names which policy holds `Config.admin` and which holds the wasmd
migrate admin (spec §12.1, D25).  The contract deliberately keeps a single
`Config.admin` with no contract-side split, and consumers must treat the
policy set as 1..n.

Code migration is the superset power.  A migration can install code carrying
all three of the contract's authorities, so the wasmd migrate admin is the
admin group policy and is never left with a single key after bring-up
(spec §12.1).

The permissionless endpoints are required to be safe for any caller.  They
are idempotent, gas bounded, and griefing resistant; they can never move
value to the caller's benefit, and no safety property is gated on who calls
(`SECURITY.md`, "Smart contracts").

## Standing Guardrails

The following protections are in place independent of the audit and may be
relied upon when assessing the surface above.

- Every input is validated and bounded at the message boundary, and all
  arithmetic uses checked, saturating, or ratio operations with floor
  rounding.  The release profile enforces `overflow-checks = true`
  (`SECURITY.md`; `contracts/CLAUDE.md`).
- The core invariants are machine checked rather than narrative: receipt
  conservation (spec §5.1, observable in one consistent state read through
  the `ReceiptAccounting` query), the exact TVV identity, and immediate slash
  recognition are asserted by unit tests, devnet drills, and the
  seed-reproducible simulation soak (`SECURITY.md`).
- Two independent emergency stops exist: the admin halt over the contract's
  fund-moving cranks, and the vault pause.  The vault additionally
  auto-pauses on unrecoverable errors (spec §5, §12).
- The exact-price settlement guardrail and full-payment-terms approvals bound
  what the asset-manager authority is able to move (spec §12).
- The flaw-register hardenings F1 through F9 are retained fixes for real
  exploits found during the proof of concept and must not be removed
  (`docs/architecture/history/2026-07-02-poc-flaw-register.md`).

## References

1.  **[Trust & security model, governance](../specs/liquid-staking-spec.md)** — spec §12, §12.1
2.  **Interface contracts: state, execute, query, migrate** — spec §11; `contracts/schema/`
3.  **[Epoch engine, jail flow, redemptions]** — spec §8-§10
4.  **[Security requirements & audit-readiness practices](../../SECURITY.md)**
5.  **[Delivered baseline & open verification items](../../contracts/IMPLEMENTATION-STATUS.md)**
6.  **[Exploit history & retained hardenings](../architecture/history/2026-07-02-poc-flaw-register.md)**
7.  **[Toolchain pins, build & CI gates](../../contracts/CLAUDE.md)**
