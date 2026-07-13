# nvHASH Program Console

A chain-truth verification tool for the nvHASH liquid staking program on Provenance.
Static SPA, no backend: the chain is the database. Built to
[`docs/nvHASH-console-spec.md`](../docs/nvHASH-console-spec.md) v2.0-RC1, grounded on the
as-built contract interface (`src/msg.rs`, `src/state.rs`).

This rebuild's information architecture was derived with the `page-layout` skill before
any markup was written; the derivation (per-page task rankings, block roles, persona
triangulation) is in [`DESIGN-NOTES.md`](./DESIGN-NOTES.md).

## Run

```
npm install
npm run dev          # devnet profile; VITE_MOCK=true renders every page from fixtures
```

Open http://localhost:5273. In mock mode the app runs with no live node: connect a mock
identity (admin / operator / keeper) from the wallet button to see each role's write
surface. Point at a real node by setting `VITE_MOCK=false` and the LCD/contract values in
`.env.<profile>` (restore prior devnet values with `git show HEAD:console/.env.devnet`).

```
npm run typecheck
npm run build        # production profile
npm run build:devnet
```

## Shape

- **Read-first, wallet-optional** (spec §3.3). Every page renders without a wallet;
  connecting one unlocks the write surface the connected address qualifies for, derived
  from chain (role = admin/operator/keeper/observer).
- **Guard preflight** (`src/lib/guards.ts`, spec §10.3): each execute button computes its
  on-chain guard from polled data and renders enabled / disabled-with-reason / hidden.
  The contract remains the enforcement boundary.
- **Honesty surface** (spec §17.1): receipt-invariant and epoch-identity checks are
  first-class pills; freshness is ambient; "mirror, not measurement" values are labeled.
- **Client-side epoch ledger** (`src/data/ledger.ts`, spec §9.3): the contract keeps only
  the latest snapshot, so trend history is persisted per-browser to IndexedDB.
- **Design language** on the repo's validated dataviz palette; charts are hand-rolled SVG
  with table-view fallbacks; both themes are first-class (auto / light / dark).

## Layout

```
src/
  config.ts            build-time deployment config (spec §7)
  theme/               tokens.css (both palettes), global.css
  lib/                 types, format (BigInt/HASH/bps), derived metrics, guard preflight
  data/                fixtures, lcd client, IndexedDB ledger, store (poll tiers + hooks)
  tx/                  ExecuteMsg builders, wallet adapter, tx lifecycle + confirm/toast
  components/          ui primitives (tile, pill, chip, guard button, states), chrome
  charts/              step line, signed bars, stacked bar, history bars, dot strip
  pages/               Overview, Validators, EpochOps, Redemptions, Desk, JailWatch, Admin
```
