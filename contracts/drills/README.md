# Drills

Scripted end-to-end verification of the staking contract against a live
Provenance dev node, with assertions after every phase. Drills version with
the contract because they assert its invariants; the dev chain they run
against is stood up from [`infra/devnet/`](../../infra/devnet/).

- `p2p-drill.sh` — the full money path: enroll → deposit → deploy settlement →
  reward claim + NAV step → redeem/unbond → maturity settle + burn → funded
  expedite → uniform-slot rebalance, asserting the four-way receipt invariant
  and TVV neutrality against live vault/marker state after each phase. It also
  drives the three operator actions the App's fixture corpus pins —
  `register_participation` (phase 1), `pay_tip` (phase 2) and `pay_commission`
  (phase 8, clearing arrears) — so `packages/fixtures/` needs no separate
  operator drill.
- `jail-drill.sh` — jail report/purge and slash write-down against real
  downtime jailing: two never-signing validators, real slashes, NAV marked
  down by exactly the unbacked amount in the detection epoch.
- `gov-drill.sh` — the `x/group` governance lifecycle, and the App's governance
  state generator (App PR 7.1). Needs
  `infra/devnet/bootstrap/nvhash-group-bootstrap.sh` first. Produces every
  proposal state the §8.7 surfaces render — accepted+executed, accepted with a
  FAILED execution, accepted-but-unexecuted, rejected at voting-period end in a
  txless block, withdrawn, and both prune routes — **plus the multiplicity cases
  that can falsify this PR's natural keys**: two messages in one proposal, two
  proposals in one transaction (sharing a `voting_period_end`, so they transition
  in one block), two `MsgVote`s in one transaction at distinct `msg_index`es, a
  real two-page paginated read, and an attempted vote change. That last one is
  the measurement `(proposalId, voter)` rests on — the M6.4 review found a
  plan-level natural key that was wrong, named, and gated by a passing test, so
  the assumption is drilled rather than believed. Writes an observation record
  (`.gov-drill.json`, gitignored) that
  `packages/fixtures/scripts/capture-fixtures.sh --governance` folds into the
  corpus manifest's pinned facts. One state it CANNOT produce on the drilled
  build: `PROPOSAL_STATUS_ABORTED`, recorded as such rather than skipped
  silently.
- `migrate-drill.sh` — the migration entry point under the group-policy wasm
  admin: unauthorized `MsgMigrateContract` rejected while the policy is
  keyless; a group proposal executes the same migrate; a same-code-id migrate
  exercises the store probe; a version-bumped build migrates with a
  byte-for-byte state-dump diff clean except `contract_info`; a downgrade is
  accepted by the group but fails in its executor result (cw2 semver gate).
  Needs a fresh chain bootstrapped group-first.
- `migrate-drill.sh` — the migration entry point under the group-policy wasm
  admin: unauthorized `MsgMigrateContract` rejected while the policy is
  keyless; a group proposal executes the same migrate; a same-code-id migrate
  exercises the store probe; a version-bumped build migrates with a
  byte-for-byte state-dump diff clean except `contract_info`; a downgrade is
  accepted by the group but fails in its executor result (cw2 semver gate).
  Needs a fresh chain bootstrapped group-first.
- `calendar-drill.sh` — calendar-month cadence gate (E-CAL): an eligible
  `RunEpoch` runs a full epoch end-to-end, then a second crank in the same
  calendar month is rejected with `too soon`, with the reported next-eligible
  instant in a strictly later month. Run against a fresh bootstrap (a devnet's
  `block.time` is real wall-clock and cannot be made to cross a month boundary
  in seconds, so the cross-boundary aligned epoch is covered by the
  embedded-chain `increase_time` test and the simulation, not here).
