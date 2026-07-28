# CLAUDE.md — engineering console

Internal testing/operations web console.

## Conventions

- Audience is engineers: expose raw contract messages, full query responses,
  and error details. Do not hide complexity behind simplified flows.
- It is acceptable for this app to depend on developer tooling (local chain
  nodes, unpublished contract schemas) that `apps/web/` must not.
- Keep shared UI or client code that both apps need in a shared package rather
  than importing across app boundaries.
- Security ([`SECURITY.md`](../../SECURITY.md)): same rules as the web app —
  no key material outside the wallet, client bundle is public, contract is
  the enforcement boundary. Never lie about state: the honesty-surface rules
  (spec §17) are load-bearing for a verification tool.

## Commands

- `npm run dev` — devnet profile on http://localhost:5273; `VITE_MOCK=true`
  renders every page from fixtures with no live node.
- `npm run typecheck` — `tsc -b` (project references; `noEmit` comes from
  tsconfig, do not pass `--noEmit` on the command line — TS 5.5 rejects it
  with `-b`).
- `npm run build` / `build:devnet` / `build:test` — typecheck + vite build
  per deployment profile (`.env.<profile>`, all client-public values).
- Against a real chain: stand up the dev node via `infra/devnet/dev-node.sh
  bootstrap`, then set `VITE_MOCK=false` with the devnet LCD/contract values.

## Conventions (as built)

- Amounts are `Uint128` decimal strings parsed to `BigInt`; display conversion
  (nhash → HASH, bps → %) happens at render only — no floating point on
  amounts.
- The TypeScript contract mirror (`src/lib/types.ts`) tracks
  `contracts/src/msg.rs` / `state.rs`; update it in the same change as any
  contract interface change, and keep guard preflight (`src/lib/guards.ts`)
  aligned with the contract's actual gates.
- Dependency surface is deliberately minimal (react, react-dom,
  react-router-dom only). The `@cosmjs/*` packages were removed 2026-07-13 as
  unused — they carried a critical `elliptic` advisory chain. When the
  extension-wallet adapter lands (spec §14.1), re-add only the needed cosmjs
  packages at a current, audited version.
- **Fees: never compute `gas × price`.** Under Provenance flat fees a tx's cost
  is a deterministic **per-message** amount (`x/flatfees` `CalculateMsgCost`),
  and `Simulate` returns **that fee amount** in the gas-wanted field — hence
  the chain's 1nhash guidance (provenance `internal/antewrapper/utils.go`
  `GetGasWanted`, which then substitutes a real gas limit). Use the simulate
  result **verbatim**: no configurable price, no adjustment factor, `gas_limit`
  == the fee amount. A tx priced off the old model is **rejected** by the
  protocol, not merely overpriced. This console carried
  `VITE_GAS_PRICE=1905nhash` with a ×1.3 until 2026-07-27 — including a confirm
  sheet that stated a fee it had never computed, a §17 honesty break — and both
  the knob and the claim are gone. `apps/web/app/tx/simulate.server.ts` is the
  reference implementation, gated by `apps/web/test/tx-fee.test.ts`; mirror it
  when wiring §14.1 rather than reinventing the math here.
- The index.html CSP pins `connect-src` to the known profile LCD hosts; a
  deployment on a different LCD updates that list — never widen it to a
  blanket `https:`.
