# CLAUDE.md — web app

End-user web interface. Production quality.

## Conventions

- Audience is end users: clear language, guarded flows, and graceful error
  handling. Raw contract/debug detail belongs in `apps/console/`, not here.
- **Owns the `app` schema** (ADR-001 Decision 1,
  [`docs/architecture/2026-07-14-adr-001-app-component-architecture.md`](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)):
  sessions, users, alert rules, notifications, push subscriptions, aggregate
  counters, and incident acknowledgments, with their Prisma schema and
  migrations, running as the `app_writer` role — which has **no grants on the
  `indexed` schema**. Indexed history is read only through `services/api`;
  live LCD reads (the canonical plane) happen in this server directly.
- The **notifier** is a separate worker entrypoint in this codebase (ADR-001
  Decision 3); its indexed-fact reads go through `services/api` (public
  endpoints plus the `internal:notifier`-scoped read-only surface).
- The session layer mints the short-lived scoped service assertions
  `services/api` requires for address-scoped reads (ADR-001 Decision 2);
  `API_SERVICE_ASSERTION_KEY` is server-only and never reaches the client
  bundle.
- Design tokens are web-local for v1 (spec §14.8); every token change re-runs
  the shared palette validation on both themes in CI.
- Accessibility and responsive layout are requirements, not nice-to-haves.
- Security ([`SECURITY.md`](../../SECURITY.md)): never touch private keys or
  mnemonics — wallet adapters own signing; everything in the client bundle
  and `VITE_*` env is public; UI guards are convenience, the contract is the
  enforcement boundary.

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/web <script>`.
Playwright e2e runs in the official Playwright image on the same compose file:
`./dev pw --filter @nvhash/web run test:e2e` (image tag and the exact
`@playwright/test` pin move in lockstep — bump both in one change).

Package scripts (`./dev pnpm --filter @nvhash/web run <script>`):

- `typecheck` — `react-router typegen && tsc --noEmit` (strict).
- `test` — Vitest (node env): i18n key coverage, config bounding + boot-check
  behavior (against the MSW fixture harness), client-config allowlist, theme
  cookie parsing.
- `test:e2e` — production build + Playwright against `react-router-serve`
  with `NVHASH_MOCK=1` (chain reads served from `@nvhash/fixtures` via MSW —
  fully offline). Includes the axe accessibility scans on both themes and the
  runtime server-only-leak assertion. Run via `./dev pw`, not `./dev pnpm`
  (needs browsers).
- `check:palette` — the shared dataviz validation method
  (`scripts/validate_palette.js`) over both theme token sets in
  `app/theme/tokens.css` (ADR-001 Decision 4 gate).
- `check:bundle` — bundle-secret gate: builds with sentinel values in every
  server-only env var (`scripts/server-only-env.json`) and fails if any
  reaches `build/client`.
- `dev` / `build` / `start` — standard React Router dev server / build /
  serve. `NVHASH_MOCK=1` makes the server read chain state from the fixture
  corpus (dev without a devnet). There is no full-stack `./dev` wiring yet —
  that is PR 1.5.

Config is validated and bounded at the boundary (`app/config/config.server.ts`);
copy `.env.example` to `.env` for local values. Boot checks (console chain-id
match, vault-address cross-check against `Config {}`) run at server startup
and fail it loudly on mismatch.

### CI gates (standing from PR 1.3)

`pnpm -r run typecheck/test` in `app-ci` picks up the unit suite; the
`web-gates` job runs `check:palette` + `check:bundle`, and `web-e2e` runs the
Playwright suite in the pinned Playwright image. Security-executable gates
(SECURITY.md, plan §4), all CI-failing:

- **Bundle-secret check** (`check:bundle` + `test/client-config.test.ts` +
  `e2e/leaks.spec.ts`): nothing beyond the app-spec §7 client-safe subset
  (`app/config/client.ts` allowlist) appears in the client bundle or the
  served page. Adding an env var without classifying it in
  `scripts/server-only-env.json` fails the unit suite.
- **i18n key coverage** (`test/i18n-coverage.test.ts`): locale catalogs are
  key-identical to `en`; every `t()` call site resolves.
- **Palette validation** (`check:palette`): both theme token sets pass the
  shared dataviz method on every change.
- **axe** (`e2e/axe.spec.ts`): WCAG A/AA scans on both themes; new routes are
  added to its route list.

Later standing gates attach here per plan §4: personal-route session-scope
enforcement (PR 5.1), push-token deletion (PR 6.3), aggregate-counter keying
(PR 7.6).
