# CLAUDE.md — web app

End-user web interface. Production quality. Rationale and recorded decisions:
[`docs/architecture/web-design-notes.md`](../../docs/architecture/web-design-notes.md).
Measured chain behavior: [`docs/specs/chain-facts.md`](../../docs/specs/chain-facts.md).
Read both before changing a session boundary, the tx lifecycle, the broadcast
allowlist, or a live/indexed composition.

## Conventions

- Audience is end users: clear language, guarded flows, graceful error handling.
  Raw contract/debug detail belongs in `apps/console/`.
- **Two planes.** The *live* plane is an LCD read from this server (canonical);
  the *indexed* plane is `services/api` (durable mirror, as of a height). Every
  composed figure carries a §12.1 honesty label; a mirrored figure is never
  shown as current. **Every figure is "n/a" when null, never 0.**
- **Live decides membership; indexed only enriches** — and decides membership
  only when the live read failed. A live read failure is never evidence of a
  prune.
- **The acting address comes only from the session.** Personal loaders use
  `getSessionContext` / `requireSession`, never a query param. Public surfaces
  (governance) deliberately do *not* join the personal-route list.
- **Layering is strict:** `app/lib/models/*.server.ts` are the only Prisma
  import sites; `app/lib/services/*.server.ts` hold logic with no Prisma, no
  fetch, no clock. Routes and tests run storeless.
- **Amounts never touch floats.** User input parses through `app/lib/amount.ts`
  (decimal string → base-unit BigInt, float-rejecting); display formats at
  render only.
- **Owns the `app` schema** (ADR-001 Decision 1,
  [ADR](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md))
  as `app_writer`, which has **no grants on `indexed`**. Indexed history is read
  only through `services/api`. `DATABASE_URL` is optional — absent, sessions run
  on a non-durable in-memory store. `test/app-schema-allowlist.test.ts` gates
  additions and forbids any role/identity/device column.
- **The schema is ONE baseline migration, not a history.** Nothing runs this
  schema outside dev and CI, so a schema change edits the models and is
  regenerated into `prisma/migrations/20260723000000_init_sessions` rather than
  appended to. Regenerate with `prisma migrate diff --from-empty
  --to-schema-datamodel prisma --script`, keeping the file's hand-written
  header, and rebuild the database (`./dev pg reset`, `migrate:deploy`).
  Unlike `indexed`, this schema is NOT rebuildable from chain — a rebuild drops
  sessions, notifications and push subscriptions — so the first environment
  whose contents must survive is the point at which incremental migrations
  start.
- Accessibility and responsive layout are requirements, not nice-to-haves.
- Security ([`SECURITY.md`](../../SECURITY.md)): never touch private keys or
  mnemonics — wallet adapters own signing; everything in the client bundle and
  `VITE_*` env is public; UI guards are convenience, the contract is the
  enforcement boundary.

## Layout

- **`app/wallet/`** — signing behind a **closed vendor registry** (Figure WC v2
  mobile + injected extension, Arculus WC v2 mobile). Vendor workarounds live
  only in that vendor's adapter module. Signing reaches the wallet only via
  `useWallet().signDirect`.
- **`app/lib/adr36.ts`** — the **one** sign-doc construction site for client and
  server. `app/lib/adr36-verify.server.ts` holds the app's bech32 primitives.
- **`app/tx/`** — the transaction lifecycle. `lifecycle.ts` is a pure reducer
  (signing only through confirm; confirmed only after inclusion);
  `proto.ts` + `build.ts` are dependency-free and **byte-golden to the fixtures
  corpus** — re-encoded fixture txs must hash to their captured tx ids. Pages
  drive it through **`useTxFlow`** (preflight → simulate → confirm → sign →
  broadcast → track), never calling the resource routes ad hoc.
- **`app/config/`** — `config.server.ts` validates and bounds at the boundary;
  `client.ts` is the §7 client-safe allowlist. Boot checks (chain-id match,
  vault-address cross-check) run at startup and fail loudly.
- **Feature seams** — `app/{portfolio,market,validators,exit,stake,governance,learn,chrome,alerts}/`
  each hold a `*.server.ts` composition seam, a `types.ts` of view models, and
  pure helpers. Components under `app/components/<feature>/` are
  presentation-only over those view models.
- **`notifier/`** — a separate worker entrypoint (ADR-001 Decision 3), **outside
  `app/`** so the React Router build never bundles it. Uses **relative** imports
  and avoids parameter properties, `enum`, and `namespace` (Node's strip-only TS
  runs it directly). Its indexed-fact reads go through `services/api`.
- **Resource routes** (CSV exports, alerts, push) are registered **outside the
  `:lang?` segment**. Detail routes register **after** their list route.

### Load-bearing rules

**Fee basis — read before touching `simulate.server.ts`.** The simulate result
**is** the fee (chain-facts §flatfees): used verbatim, price 1nhash and **not a
tunable**, **no adjustment buffer**, `gasLimit == amount`. A tx priced off the
old `price × gas` model is *rejected* by the protocol. Pinned by
`test/tx-fee.test.ts`.

**`ALLOWED_MSG_TYPE_URLS` is TWO-LEVEL.** `MsgExecuteContract` is in it only
because `guardOperatorExecute` runs for that type URL alone — on its own the
entry would authorize any call to any contract. The guard checks the configured
contract, a single top-level key from the closed six-variant operator set (no
admin/keeper variant), the per-variant body, funds discipline, and finally
**canonical byte equality** with `operatorInnerJson`. **Extending either level —
a new type URL or a new variant — is a design-review event, never an edit.**

**The preflight fact rule.** Every fact in `OperatorPreflightFacts` is nullable,
and a variant must short-circuit to `chain-unavailable` on every fact **it
consumes** — and is equally forbidden from blocking on one it does not. Skipping
a check on a null returns a green reason list for an action the contract then
rejects.

**Governance decoding is a closed union** — `MsgSend` plus `MsgExecuteContract`
against the configured contract, with the variant vocabulary **imported** from
`app/tx/build.ts`. Anything else is a tagged `unknown` carrying the exact JSON.

**Web Push is the one accepted SECURITY.md exception** — opt-in, opaque,
revocable. `public/push-sw.js` is served straight from `public/` with no bundler
involvement; it holds no keys, performs no fetches, and renders from the closed
`{ kind, url }` payload. No token outlives its session (four deletion paths, see
design notes).

**Load the `dataviz` skill before touching `app/components/charts/`.**

## Commands

Part of the root pnpm workspace (ADR-001 Decision 4); all JS tasks run in the
containerized toolchain (ADR-002): `./dev pnpm --filter @nvhash/web <script>`.
Playwright runs in the official Playwright image on the same compose file:
`./dev pw --filter @nvhash/web run test:e2e` — image tag and the
`@playwright/test` pin move in lockstep, bump both in one change.

- `typecheck` — `react-router typegen && tsc --noEmit` (strict).
- `test` — Vitest (node env), over the MSW fixture harness.
- `test:e2e` — production build + Playwright against `react-router-serve` with
  `NVHASH_MOCK=1` (fully offline, chain reads from `@nvhash/fixtures`). Includes
  the axe scans on both themes, the server-only-leak assertion, and a second
  instance with `NVHASH_MOCK_LIVE_DOWN=1` proving failed live reads degrade
  honestly. Run via `./dev pw`, not `./dev pnpm` (needs browsers).
- `test:e2e:live` — Playwright against the **real devnet stack**. Bring it up
  first (`infra/devnet/stack.sh up`, app profile, migrated app schema), then set
  `E2E_LIVE_BASE_URL`, `E2E_LIVE_VAULT_ADDRESS`, `E2E_LIVE_LCD_URL`, and
  `E2E_LIVE_SIGNER_KEY` (a funded **throwaway** devnet key, 32 hex bytes —
  SECURITY.md devnet rules; specs skip cleanly when unset). The test signer
  lives only in the test process (`e2e-live/signer.ts`) and `check:bundle` scans
  for its sentinel so it can never ship. Optional `E2E_LIVE_OPERATOR_KEY`
  unlocks the enroll/unregister leg. Runs on the stack schedule, not offline CI.
  **Restart the compose `web` service before trusting a green live run** — it
  builds at container start, so a long-running stack serves a stale bundle.
- `check:palette` — the shared dataviz validation method
  (`scripts/validate_palette.js`) over both theme token sets.
- `check:bundle` — builds with sentinel values in every server-only env var
  (`scripts/server-only-env.json`) and fails if any reaches `build/client`.
- `dev` / `build` / `start` — standard React Router. `NVHASH_MOCK=1` serves
  chain state from the fixture corpus (dev without a devnet). Full stack against
  a real dev node: `infra/devnet/stack.sh up`, which resolves deployed
  contract/vault addresses from chain and waits on `GET /healthz`
  (`app/routes/healthz.tsx`, locale-independent, runs the boot checks, 503 on
  failure).

Copy `.env.example` to `.env` for local values.

## CI gates

`app-ci` runs `pnpm -r run typecheck/test`; the `web-gates` job runs
`check:palette` + `check:bundle`; `web-e2e` runs Playwright in the pinned image.
All fail CI on violation.

- **Bundle-secret check** (`check:bundle` + `test/client-config.test.ts` +
  `e2e/leaks.spec.ts`): nothing beyond the §7 client-safe subset appears in the
  client bundle or the served page. Adding an env var without classifying it in
  `scripts/server-only-env.json` fails the unit suite.
- **Personal-route session scope** (`test/session-scope.test.ts` +
  `test/session.test.ts`): the acting address comes only from the session (query
  params have no effect); anonymous requests prompt-and-explain (page) or 401
  (resource route); cookie flags, nonce single-use/replay, and expiry bounds are
  pinned. **Every new personal or public-by-design route joins this suite.**
- **App-schema allowlist** (`test/app-schema-allowlist.test.ts`) — the
  data-minimization gate; forbids any role/identity/device column.
- **Push-token deletion** (`test/push-token-deletion.test.ts`) — makes the
  SECURITY.md accepted exception's *condition* mechanical: a token is deleted on
  opt-out, logout, session expiry/removal, dead-endpoint (404/410) pruning, and
  the notifier tick's invariant sweep. `test/push-payload.test.ts` pins the
  closed `{ kind, url }` body — never amounts, addresses, or ids.
- **Broadcast guard** (`test/broadcast-guard.test.ts`) — the rejection matrix
  including every admin variant, mixed batches, duplicate proto fields, and
  non-canonical encodings. `test/tx-operator-build.test.ts` holds byte-goldens
  against captured devnet txs; `test/tx-confirm.test.ts` asserts the disclosure
  equals the signed bytes for every variant; `test/tx-preflight.test.ts` holds
  the predicate matrix in both directions.
- **Assertion vectors** (`test/assertion.test.ts`) — ADR-001 Decision 2 golden
  vectors, cross-pinned with `services/api/test/assertion-vectors.test.ts`.
- **Wallet registry** (`test/wallet-adapter.test.ts`) — keeps the vendor
  registry closed. `test/roles.test.ts` pins live role re-check.
- **i18n key coverage** (`test/i18n-coverage.test.ts`): locale catalogs are
  key-identical to `en`; every `t()` call site resolves. User-visible strings
  are i18n keys, hyphenated.
- **Palette + brand-token contrast** (`check:palette`,
  `test/brand-tokens.test.ts`): both theme token sets pass the shared dataviz
  method; the mint-green CTA/focus ring clear their WCAG floors and the fixed
  status family stays on its values in both themes.
- **axe** (`e2e/axe.spec.ts`): WCAG A/AA on both themes. **New routes join its
  route list.**
