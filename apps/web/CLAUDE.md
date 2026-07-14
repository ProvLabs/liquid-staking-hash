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
Playwright e2e will run in the official Playwright image on the same compose
file (ADR-002 out-of-scope note; decided at PR 1.3). Concrete scripts land
with the PR 1.3 scaffold.
