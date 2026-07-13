# nvHASH Program Console

A chain-truth verification tool for the nvHASH liquid staking program on
Provenance. Static SPA, no backend: the chain is the database. Built to
[`docs/specs/console-spec.md`](../../docs/specs/console-spec.md), grounded on
the as-built contract interface (`contracts/src/msg.rs`,
`contracts/src/state.rs`).

> **Migration pending:** the console implementation (Vite/TypeScript app,
> `DESIGN-NOTES.md`, fixtures) still lives in the exploratory
> `nvhash-cosmos-contracts` repository under `console/` and migrates here in a
> future tranche.

The console is the engineering/verification half of the program's two-surface
split — the consumer experience is [`apps/web/`](../web/); the seam between
them is pinned in
[`docs/architecture/application-boundary.md`](../../docs/architecture/application-boundary.md).

## Shape

- **Read-first, wallet-optional** (spec §3.3). Every page renders without a
  wallet; connecting one unlocks the write surface the connected address
  qualifies for, derived from chain (role = admin/operator/keeper/observer).
- **Guard preflight** (spec §10.3): each execute button computes its on-chain
  guard from polled data and renders enabled / disabled-with-reason / hidden.
  The contract remains the enforcement boundary.
- **Honesty surface** (spec §17.1): receipt-invariant and epoch-identity
  checks are first-class pills; freshness is ambient; "mirror, not
  measurement" values are labeled.
- **Client-side epoch ledger** (spec §9.3): the contract keeps only the latest
  snapshot, so trend history is persisted per-browser to IndexedDB.
- **Design language** on the validated dataviz palette; charts are hand-rolled
  SVG with table-view fallbacks; both themes are first-class.
