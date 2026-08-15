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
  renders every page from fixtures with no live node. **Mock and devnet key
  mode exist only in the devnet build profile** — the code is behind an
  `import.meta.env.MODE === "devnet"` static condition so test/production
  builds exclude it at compile time (spec §10.1), which
  `scripts/check-bundle.mjs` proves in CI by scanning the built `dist/` for
  the identity literals.
- `npm run typecheck` — `tsc -b` (project references; `noEmit` comes from
  tsconfig, do not pass `--noEmit` on the command line — TS 5.5 rejects it
  with `-b`). Gated by the `console` job in `.github/workflows/app-ci.yaml`:
  this app is outside the pnpm workspace, so `pnpm -r` reaches none of it and
  that job is the only thing compiling it.
- `npm test` — Vitest (node environment only; the gating tests are pure:
  anchor grammar goldens, the governance honesty matrix, tx byte-goldens,
  sign-binding decode-back, the CSP generator incl. a case over the built
  `dist/index.html`, so run `npm run build:test` first for that cell). Gated
  in the same CI job, which also builds the test profile and runs the bundle
  guard.
- Formatting and linting come from the repo-root Biome config (`biome.jsonc`),
  which covers this app despite the workspace boundary: `./dev pnpm run lint`
  from the repository root, gated in the same workflow.
- `npm run build` / `build:devnet` / `build:test` — typecheck + vite build
  per deployment profile (`.env.<profile>`, all client-public values).
- `npm audit` — gated in CI's `audit` job (lockfile-only, dev deps in scope,
  no floors or ignore flags): this package is outside the pnpm workspace, so
  the workspace `pnpm audit` cannot see it.
- Against a real chain: stand up the dev node via `infra/devnet/dev-node.sh
  bootstrap`, then set `VITE_MOCK=false` with the devnet LCD/contract values.

## Conventions (as built)

- Amounts are `Uint128` decimal strings parsed to `BigInt`; display conversion
  (nhash → HASH, bps → %) happens at render only — no floating point on
  amounts.
- The TypeScript contract mirror (`src/lib/types.ts`) tracks
  `contracts/src/msg.rs` / `state.rs`; update it in the same change as any
  contract interface change, and keep guard preflight (`src/lib/guards.ts`)
  aligned with the contract's actual gates. The same mirror-tracking rule
  binds the tx stack: `src/tx/proto.ts` / `build.ts` / `simulate.ts` and the
  Figure vendor module track `apps/web/app/tx/*` and
  `app/wallet/figure-extension.ts` (the sources of truth) — a divergence
  found by the vendor certification run is fixed in BOTH apps and recorded
  in app-spec §14.1.
- **Dependency surface is deliberately minimal** (react, react-dom,
  react-router-dom; vitest as the only devDependency-tier test tool). The
  extension-wallet adapter is FIRST-PARTY (PR 8.4b §7 Q3): the
  reviewed-dependency decision resolved to *"no dependency added"* — the
  `@cosmjs/*` packages carry a recorded critical `elliptic` advisory chain,
  and the App's ~450-line dependency-free tx stack is proven byte-golden
  against the real vendor. Adding ANY `@cosmjs/*` package (or any new
  runtime dependency) is a new SECURITY.md reviewed-dependency event, not an
  edit.
- **Fees: never compute `gas × price`.** The simulate result **is** the fee
  ([`chain-facts §flatfees`](../../docs/specs/chain-facts.md)) — use it
  verbatim: no configurable price, no adjustment factor, `gas_limit` == the fee
  amount. A tx priced off the old model is **rejected** by the protocol, not
  merely overpriced, and a confirm sheet stating a fee it did not compute is a
  §17 honesty break. `apps/web/app/tx/simulate.server.ts` is the reference
  implementation; the console's own `test/tx-fee.test.ts` gates the mirror
  beside the App's `apps/web/test/tx-fee.test.ts`.
- The index.html CSP `connect-src` is **generated per profile** from
  `VITE_LCD_URL` (`build/csp.ts` via `vite.config.ts`; gated by
  `test/csp.test.ts`) — one exact origin, `localhost` only on devnet, and the
  build throws on a wildcard or blanket scheme. Never hand-edit a host into
  `index.html`; a deployment on a different LCD changes the profile's
  `VITE_LCD_URL`, nothing else.
