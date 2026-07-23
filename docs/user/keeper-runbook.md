# nvHASH Keeper Runbook

Operational guide for the keeper that cranks the nvHASH liquid-staking contract.

**Status:** DRAFT 2026-07-22 (created with milestone E-CAL). Governs the
off-chain keeper's cadence and duties; the contract remains the enforcement
boundary. See [`docs/specs/liquid-staking-spec.md`](../specs/liquid-staking-spec.md)
§8 (redemptions), §9 (rebalance & cadence), §10.4 (uptime capture), §14
(launch checklist).

## What the keeper is (and is not)

Every fund-moving entrypoint (`RunEpoch`, `ServiceRedemptions`,
`CaptureUptimeSignal`, `ClaimRewards`) is **permissionless and idempotent** —
anyone may call it, and the contract validates and bounds everything at the
message boundary. The keeper is a **liveness** service, not a trust anchor: it
exists so these cranks happen promptly, not because they are privileged. A
missed or late crank degrades UX or convergence; it can never move value to the
caller or violate an invariant. Never build operational logic that assumes the
keeper is the only caller.

## Standing duties and cadence

| Duty | Cadence | Command (devnet reference) |
| --- | --- | --- |
| **Uptime capture** | Daily (~half the ~2-day signing window; `min_capture_interval_secs` ~0.9× the cadence, §10.4) | [`actions/capture-uptime.sh`](../../infra/devnet/actions/capture-uptime.sh) |
| **Claim rewards + capture, then epoch** | At each epoch crank (below) | [`actions/claim-rewards.sh`](../../infra/devnet/actions/claim-rewards.sh) → `capture-uptime.sh` → `run-epoch.sh` |
| **`RunEpoch`** | **Promptly after each calendar-month rollover** (see below) | [`actions/run-epoch.sh`](../../infra/devnet/actions/run-epoch.sh) |
| **`ServiceRedemptions`** | Regular, between epochs (e.g. daily) | [`actions/service-redemptions.sh`](../../infra/devnet/actions/service-redemptions.sh) |
| **Monitoring** | Continuous | `EpochStatus` / `EpochSnapshot` / `Apr` / `JailReports` queries; [`actions/status.sh`](../../infra/devnet/actions/status.sh) |

A crank is chunked: if `RunEpoch` leaves pending continuation work (large
rebalance under the per-tx gas limit), keep calling `RunEpoch` until
`EpochStatus.phase` returns to `Idle` before treating the epoch as complete.

## The epoch cadence: crank promptly after each month rollover

`RunEpoch` becomes eligible once consensus block time enters a **strictly later
calendar month** than the last run (`civil_month(block_time) >
civil_month(last_run)`, §9). Key operational facts:

- **The boundary is deterministic and caller-independent.** No one can crank
  early, and being "first" confers nothing — the epoch time is a property of
  consensus block time, not of who calls. There is no race to win.
- **Promptness is the whole job.** Crank as soon as the month rolls over. A
  late crank does not break correctness, but it has two costs:
  1. **Convergence.** A crank landing late in a month, followed by a prompt
     crank after the next rollover, *compresses* the inter-crank gap below the
     ~21-day unbonding period. The planner stays safe — it defers moves that
     would collide with in-flight unbonding/redelegation entries rather than
     emitting one the chain would reject (§9.3) — but that epoch converges less
     fully (more deferrals). Prompt cranks keep gaps ≥ the unbonding period and
     convergence clean.
  2. **Redemption mobilization.** The `withdrawal_delay_seconds` ceiling (~60
     days, §8) is sized against a full month to the next epoch + unbonding +
     buffer. Chronic late cranking eats the buffer; prompt cranking preserves
     it.
- **A skipped month is safe, and self-heals.** If no crank happens for a whole
  month, eligibility simply persists and one catch-up crank settles the entire
  accumulated gap — a longer gap is *safer* for lock-clearing, not less safe.
  Still, don't rely on it: a skipped month means a month with no rewards
  compounding into stake and no rebalance.

### Checking eligibility

- Read `EpochStatus.last_run_seconds` and compare its calendar month to the
  chain's current block time. If the block time is in a later month, a crank is
  eligible.
- A premature crank is rejected with `too soon: next run allowed at <unix>` —
  the `<unix>` is the first second of the next eligible month, so the keeper can
  schedule the next attempt exactly.

### Suggested schedule

Run a daily job that (a) captures uptime and services redemptions, and (b)
checks month rollover: if `civil_month(now) > civil_month(last_run)` and
`phase == Idle`, run `ClaimRewards`, a capture, then `RunEpoch` (repeating until
`Idle`). Cranking within the first day or two of each month keeps convergence
and mobilization well inside their margins.

## Verification

The calendar cadence is exercised end to end by
[`contracts/drills/calendar-drill.sh`](../../contracts/drills/calendar-drill.sh)
(an eligible crank runs; a same-month re-crank is rejected) and continuously by
the contract simulation (compressed-gap, skipped-month, and mobilization-ceiling
assertions).
