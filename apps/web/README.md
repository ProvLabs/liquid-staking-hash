# nvHASH Program App

The full-featured, consumer-grade application for the nvHASH liquid staking
program: education, guided transactions, durable history, analytics, and
notifications. Specified in
[`docs/specs/app-spec.md`](../../docs/specs/app-spec.md).

**Status: M1 scaffold** (implementation plan PR 1.3) — React Router 7 SSR,
strict TypeScript, Tailwind 4 + shadcn/ui, `$lang+` i18n routing (`en`),
Auto/Light/Dark themes, bounded env config with startup boot checks
(vault-address cross-check, console chain-id match), and an MSW harness over
the [`@nvhash/fixtures`](../../packages/fixtures/README.md) corpus so tests
and e2e run offline. Standing CI gates from this PR: typecheck, Vitest,
Playwright + axe (both themes), the dataviz palette validator, and the
bundle-secret check. Program pages land in M4+; see [`CLAUDE.md`](CLAUDE.md)
for commands.

Unlike the [console](../console/) — a stateless chain-truth verifier — the app
holds its own state: it is backed by the indexer and query API under
[`services/`](../../services/) and integrates off-chain and cross-chain data.
The division of responsibility between the two surfaces is pinned in
[`docs/architecture/application-boundary.md`](../../docs/architecture/application-boundary.md),
and the personas both surfaces serve are defined in
[`docs/specs/dashboard-personas.md`](../../docs/specs/dashboard-personas.md).
