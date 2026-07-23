# Drills

Scripted end-to-end verification of the staking contract against a live
Provenance dev node, with assertions after every phase. Drills version with
the contract because they assert its invariants; the dev chain they run
against is stood up from [`infra/devnet/`](../../infra/devnet/).

- `p2p-drill.sh` — the full money path: enroll → deposit → deploy settlement →
  reward claim + NAV step → redeem/unbond → maturity settle + burn → funded
  expedite → uniform-slot rebalance, asserting the four-way receipt invariant
  and TVV neutrality against live vault/marker state after each phase.
- `jail-drill.sh` — jail report/purge and slash write-down against real
  downtime jailing: two never-signing validators, real slashes, NAV marked
  down by exactly the unbacked amount in the detection epoch.
- `calendar-drill.sh` — calendar-month cadence gate (E-CAL): an eligible
  `RunEpoch` runs a full epoch end-to-end, then a second crank in the same
  calendar month is rejected with `too soon`, with the reported next-eligible
  instant in a strictly later month. Run against a fresh bootstrap (a devnet's
  `block.time` is real wall-clock and cannot be made to cross a month boundary
  in seconds, so the cross-boundary aligned epoch is covered by the
  embedded-chain `increase_time` test and the simulation, not here).
