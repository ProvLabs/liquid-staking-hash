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
