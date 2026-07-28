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
  Concrete since PR 5.1: multi-file schema in `prisma/` (sessions,
  single-use session nonces, the accepted first/last-seen exception —
  nothing else; `test/app-schema-allowlist.test.ts` gates additions and
  forbids any role/identity/device column). `migrate:dev|deploy|status`
  scripts; dev database `./dev pg up` (port 5433). `DATABASE_URL` is
  optional — absent, sessions run on a non-durable in-memory store
  (dev/mock posture).
- **Wallet & session layer** (PR 5.1, app-spec §3 decision 5 / §10.1 /
  §12.3): signing exists only behind the closed vendor registry in
  `app/wallet/` (Figure WC v2 mobile + injected extension, Arculus WC v2
  mobile — §14.1; vendor workarounds live only in that vendor's adapter
  module). Session login is nonce → ADR-36 (`app/lib/adr36.ts` is the ONE
  sign-doc construction site for client and server) → HttpOnly opaque-id
  cookie over a server row; models layer (`app/lib/models/session.server.ts`)
  is the only Prisma import; services layer
  (`app/lib/services/{session,roles,assertion}.server.ts`) holds the logic.
  Roles are live chain reads per refresh, never persisted. Personal loaders
  reach the acting address ONLY through
  `getSessionContext`/`requireSession` — never a query param. The §14.1
  certification runbook
  ([`docs/plans/2026-07-23-m5.1-wallet-certification-runbook.md`](../../docs/plans/2026-07-23-m5.1-wallet-certification-runbook.md))
  is the per-vendor acceptance gate.
- **Transaction lifecycle** (PR 5.2, app-spec §10.2/§12.3): `app/tx/` —
  pure reducer (`lifecycle.ts`; signing only through confirm, confirmed
  only after inclusion), dependency-free proto layer (`proto.ts` +
  `build.ts`, **byte-golden to the fixtures corpus** — re-encoded fixture
  txs must hash to their captured tx ids), one serialization site for the
  confirm disclosure and the sign doc, server-side
  preflight/simulate/broadcast/status/recent resource routes (all
  session-gated; the browser never talks to the LCD or the API). Broadcast
  is the §12.3 **guarded signed-tx relay** — closed msg allowlist, sole
  signer must derive the session address, size + rate caps
  (`test/broadcast-guard.test.ts`). **Fee basis — read this before touching
  `simulate.server.ts`.** Under Provenance flat fees the required fee is a
  deterministic PER-MESSAGE cost, unrelated to gas consumed, and `Simulate`
  returns **that fee amount** in the gas-wanted field — hence the chain's
  1nhash guidance (provenance `internal/antewrapper/utils.go` `GetGasWanted`;
  the antewrapper substitutes a real gas limit for execution). So the simulate
  result is used **verbatim**: price 1nhash (**not a tunable** — the protocol
  rejects a tx priced off the old `price × gas estimate` model, on purpose),
  **no adjustment buffer** (padding a deterministic cost buys no out-of-gas
  headroom, because the number is not gas), and `gasLimit == amount`, matching
  captured devnet txs (`fee: 2nhash`, `gas_limit: "2"`, ~201k gas consumed).
  `FEE_PROVISION_NHASH` is only preflight's pre-simulation reserve and stays
  small, since an inflated reserve reports `insufficient-balance` for
  affordable transactions. Pinned by `test/tx-fee.test.ts` — this shipped wrong
  (1905nhash × 1.3, inherited from the pre-flat-fee console) precisely because
  no test held it. `[RESOLVED 2026-07-27, Ira]`, retiring `[VERIFY §14.3]`.
  `apps/console` was corrected in the same change (its `VITE_GAS_PRICE` knob is
  gone — see its `CLAUDE.md` and console-spec §7/§10.2).
- **Transacting pages** (PR 5.3, app-spec §8.3; PR 5.4, §8.4): pages drive
  the lifecycle through **`useTxFlow`** (`app/tx/use-tx-flow.ts`) —
  preflight → simulate → confirm → sign → broadcast → track — never calling
  the resource routes ad hoc. Signing reaches the wallet only via
  `useWallet().signDirect` (throws `ReconnectToSignError` when the cookie
  session outlived the in-memory adapter). User amounts parse through
  `app/lib/amount.ts` (decimal string → base-unit BigInt, float-rejecting);
  display uses `app/learn/amounts.ts`. Preflight block reasons localize via
  `app/tx/reasons.ts`; shared status/confirm surfaces are `app/tx/flow-status.tsx`.
  Live preview math is pure and testable (`app/stake/preview.ts`) — never
  `estimate_swap_in` (gRPC-only, §14.2). The `/exit` page (PR 5.4, §8.4)
  opens with the comparison table (normative guaranteed-vs-typical framing;
  `app/exit/typical.ts` decides whether a typical figure exists), a DEX
  coming-soon shell (§14.4), the native SwapOut flow (warning-tier confirm,
  three §10.3 timing facts), and the redemption tracker composed from live
  `pendingSwapOuts` + `/portfolio` + `/transactions` (`app/exit/exit.server.ts`).
- **Portfolio page** (PR 6.1 commit C, app-spec §8.2): `app/routes/portfolio.tsx`
  loads its data only for the session address (`getSessionContext`; anonymous
  renders the connect prompt, never blank; the standing session-scope gate)
  and zod-bounds `?page=` at entry (int 0–10 000; malformed → 400, reject
  never clamp). `app/portfolio/portfolio.server.ts` composes the live plane
  (canonical chain read) and the indexed plane (`services/api`) with §12.1
  honesty labels; components under `app/components/portfolio/` are
  presentation-only over the `types.ts` view models. Every figure is "n/a"
  when null, never 0. The **CSV export** is a plain `<a href="/portfolio/export">`
  to a resource route registered **outside** the `:lang?` segment
  (`app/routes/portfolio-export.tsx`, the `tx/*` precedent):
  `requireSession` → `personalApiHeaders` → the API's CSV streamed back with
  only its `content-type`/`content-disposition`/`x-*` freshness headers; the
  browser never sees the assertion or talks to the API. **StepChart extension**
  (`app/components/charts/step-chart.tsx`): optional `markers` (event dots on
  the primary series — filled "in", hollow ring "out", their data mirrored
  into the table toggle) and an optional `compare` second series in
  `--viz-cat-2` with a naming legend; all new props are optional so existing
  callers compile unchanged, and no new tokens are introduced (`check:palette`
  unaffected). Load the `dataviz` skill before touching the chart.
- **Operator view** (PR 6.4 commit C, app-spec §8.6): `/validators/mine`
  (`app/routes/validators-mine.tsx` under `:lang?`, registered AFTER
  `validators` so the public page keeps the bare path) over
  `app/validators/mine.server.ts`, with view models in `mine-types.ts` and
  presentation-only components under `app/components/validators/mine/`. The
  route gates on THREE states before any figure loads — anonymous (connect
  prompt), roles `degraded` (an explicit "we could not check"; the App never
  renders a privileged surface from a failed read), and connected non-operator —
  then loads for the session address only. `?valoper=` selects among the
  operator's OWN validators and is shape-bounded at the route; ownership is
  enforced by `services/api` against the asserted address.
  **The load-bearing fact** (verified against `contracts/src/validators.rs`,
  not assumed): program commission is CUMULATIVE and an overpayment carries
  forward indefinitely, while TIP resets at every epoch rollover — so the
  commission banner has THREE states (in-arrears / current / **prepaid**), and
  the prepaid credit comes from the LIVE plane alone (`commission_paid −
  commission_accrued`) because `pay_commission`'s `outstanding` attribute
  saturates at 0 and cannot express it. Net-benefit's earnings term is a
  labeled ESTIMATE (§7 Q2); when it cannot be computed the net is withheld too.
  Peer-rank context is deliberately absent (§7 Q5 unapproved). The CSV export is
  `app/routes/operator-export.tsx` outside `:lang?` (the `portfolio-export`
  precedent). New standing gates: `test/operator-data.test.ts` (degradation +
  honesty matrix incl. all three standing states), `test/operator-compose.test.ts`
  (BigInt goldens for the estimate; a missing input yields null, never 0),
  `test/session-scope.test.ts` (the export joins it), offline
  `e2e/validators-mine.spec.ts`, and `/validators/mine` in the axe route list.
- **Operator flows + the two-level broadcast allowlist** (PR 6.4 commit D,
  app-spec §10.3/§12.3/§14.6): the five operator actions run through the
  **unmodified** 5.2 lifecycle (`useTxFlow`) as `MsgExecuteContract` intents;
  `app/components/validators/mine/operator-flows.tsx` is the only UI, and the
  enroll flow is also offered on the non-operator state (an operator becomes
  one by enrolling). **THE convention to know: `ALLOWED_MSG_TYPE_URLS` is
  TWO-LEVEL.** `MsgExecuteContract` is in it only because
  `guardOperatorExecute` (in `app/tx/build.ts`, wired in
  `broadcast.server.ts`) runs for that type URL alone — on its own the entry
  would carry any call to any contract. The guard checks the configured
  contract, a single top-level key from the closed six-variant operator set
  (no admin/keeper variant), the per-variant body, funds discipline, and
  finally **canonical byte equality** with `operatorInnerJson`, which is what
  keeps it out of a parser arms race. **Extending either level — a new type
  URL or a new variant — is a design-review event, never an edit.** Gates:
  `test/broadcast-guard.test.ts` (the rejection matrix, incl. every admin
  variant, mixed batches, duplicate proto fields, and non-canonical
  encodings), `test/tx-operator-build.test.ts` (byte-goldens against three
  captured devnet txs — the proof the canonical form is the accepted form),
  `test/tx-confirm.test.ts` (the disclosure equals the signed bytes for every
  variant), `test/tx-preflight.test.ts` (the predicate matrix; note payments
  carry NO operator check — paying is permissionless).
  **The preflight fact rule:** every fact in `OperatorPreflightFacts` is
  nullable (a failed live read), and a variant MUST short-circuit to
  `chain-unavailable` on every fact IT consumes — `validators`/`chainValidator`
  up front for all variants, `spendableNhash` in the payment branch,
  `jailReports` + `halted` in the purge branch. Skipping a check on a null
  instead returns an empty (green) reason list for an action the contract then
  rejects, which is the "silently hiding it" the module forbids; a variant is
  equally forbidden from blocking on a fact it does NOT consume. Both
  directions are gated in `test/tx-preflight.test.ts`. The
  `register_participation` operator check needs no chain read: the contract's
  `is_operator` compares the decoded bech32 payloads of caller and valoper, so
  `sameBech32Payload` (in `lib/adr36-verify.server.ts`, which holds the app's
  bech32 primitives) restates it locally. `MAX_PROGRAM_VALIDATORS` mirrors the
  contract's `MAX_VALIDATORS` and moves with it in the same change.
- The **notifier** is a separate worker entrypoint in this codebase (ADR-001
  Decision 3); its indexed-fact reads go through `services/api` (public
  endpoints plus the `internal:notifier`-scoped read-only surface).
  **Delivered PR 6.2 commit B:** `notifier/index.ts` (`pnpm notifier` →
  `node notifier/index.ts`) lives **outside `app/`** so the React Router build
  never bundles it (`check:bundle` confirms). It uses **relative** imports, not
  the `~` alias, because `node`'s strip-only TS runs it directly — for the same
  reason, files it loads at runtime must avoid **parameter properties** (use
  explicit field assignment) and `enum`/`namespace`. Its config
  (`notifier/config.ts`) is zod-bounded and **fail-fast**: `DATABASE_URL` and
  `API_SERVICE_ASSERTION_KEY` (≥ 32) are required. **`app/lib/models/alerts.server.ts`**
  is the AlertStore port — the **sole new Prisma import site** (the
  `session.server.ts` split: Prisma + in-memory behind one contract, so routes
  and tests run storeless). The exactly-once mechanism is `commitTick` (insert
  `skipDuplicates` + cursor advance in one transaction). The redemptions
  stream cursors on the compound `<height>:<request_id>` keyset (the API's
  `after_id` tie-break) so a same-height burst larger than one fact page pages
  through completely; the nav-step stream clamps its public `/epochs` page to
  `EPOCHS_PAGE_LIMIT` (200) since `factLimit` may lawfully be up to 500. The pure evaluation
  core, effective-settings merge (absence-means-default), payload zod shapes,
  and incident→kind mapping live in **`app/lib/services/alerts.server.ts`** (no
  Prisma, no fetch, no clock). `mintInternalAssertion` (in
  `assertion.server.ts`) mints the `internal:notifier` scope, golden-vector
  cross-pinned with `services/api`. New standing gates: `test/notifier.test.ts`
  (exactly-once, presence filter, opt-out suppression, opt-in fan-out, incident
  mapping, failure isolation, retention sweep), `test/notification-payload.test.ts`
  (closed identifier-only payloads, no amount keys), `test/alerts-models.test.ts`
  (store contract, both impls), `test/notifier-config.test.ts` (config bounds);
  the app-schema allowlist now covers the three alert tables.
  **Bell + settings + rule CRUD (PR 6.2 commit C):** two session-gated resource
  routes **outside `:lang?`** (`app/routes/alerts-{notifications,rules}.tsx`,
  the `portfolio/export` precedent) over `app/alerts/alerts.server.ts` (the seam
  that wraps the store + the pure effective-settings merge, and holds the
  route boundary schemas). The acting address is ALWAYS `requireSession`'s
  address; mark-read is store-scoped by address. The chrome **bell**
  (`components/chrome/alerts-bell.tsx`) keeps the anonymous advert verbatim and,
  for a session, renders the bell + unread badge (the count rides the `root.tsx`
  loader — only the integer crosses; the popover fetches notifications via
  `useFetcher` on open). The Portfolio **Alert settings** section
  (`components/portfolio/alert-settings.tsx`, id `alert-settings`) toggles the
  closed kind list (default-on annotated, `operator_arrears` operator-only,
  market-spread absent). Both client components consume JSON with **string
  kinds** — they never import the `.server` alert modules — and every
  user-visible string is an `alerts.*` i18n key (hyphenated, no underscores).
  New standing gates: `test/alerts-routes.test.ts`, `test/session-scope.test.ts`
  (alerts join it), offline `e2e/alerts.spec.ts`, skip-clean
  `e2e-live/alerts.spec.ts`. Offline e2e has no session, so the authenticated
  settings section is not offline-axe'd (the portfolio precedent).
- **Web Push channel (PR 6.3, app-spec §10.4/§12.3/§14.7):** the ONE accepted
  SECURITY.md exception — opt-in, opaque, revocable push tokens. **Service
  worker** `public/push-sw.js` is a **static file served straight from `public/`
  with NO bundler involvement** (auditable as one small file): it holds no keys,
  performs **no fetches** (no `fetch` handler), caches nothing, and renders a
  notification from the closed `{ kind, url }` payload using a built-in generic
  per-kind copy map (identifier-free; v1 `en`-only, revisited with the first
  added locale). The `push_subscriptions` model (`prisma/push_subscriptions.prisma`)
  is exactly the W3C `PushSubscription.toJSON()` triple plus `address`/`sessionId`/
  `createdAt` — gated by `test/app-schema-allowlist.test.ts`; the triple is opaque
  and **never logged**. **Models port** `app/lib/models/push.server.ts` (`PushStore`,
  Prisma + in-memory) enforces opt-in-only creation, replace-by-session (never
  accumulate), and a per-address cap (oldest evicted). The session-gated resource
  route `app/routes/push-subscription.tsx` (outside `:lang?`, the `alerts-*`
  precedent) POST-upserts / DELETE-removes scoped to the session id; the acting
  address and session id come only from `requireSession` + the cookie, never a
  body field. **Config:** `WEB_PUSH_VAPID_PUBLIC_KEY` is client-safe (§7 allowlist);
  private key/subject stay server-only; the three are all-or-none at boot. New
  standing gates: `test/push-subscription.test.ts`, the extended allowlist +
  `session-scope` + `client-config` suites. **Notifier fan-out + deletion chain
  (PR 6.3 commit B):** after a stream's `commitTick` (now returning the
  NEWLY-INSERTED candidates via `createManyAndReturn` = `INSERT … ON CONFLICT DO
  NOTHING RETURNING`), the tick's delivery phase — OUTSIDE the DB transaction —
  fans them out (`notifier/push.ts`) to the recipient's subscriptions via the
  **`web-push`** package (the milestone's single new dependency, lockfile-pinned,
  imported ONLY in the notifier so it never bundles; the client is unaffected).
  The push body is the closed `{ kind, url }` from `toPushPayload(kind)` (derived
  from the kind alone — no amounts/addresses/ids can leak, invariant 3). Push is
  never load-bearing: a failed send logs (endpoint SCRUBBED) and drops (no retry
  queue, at-most-once); a `404`/`410` prunes the row. The **deletion chain** is
  wired in `app/lib/services/session.server.ts` (`destroySession`): logout and
  the stale-cookie expiry sweep remove the session's push subscriptions (a
  two-step delete, not one transaction — 5.1/6.2 use separate Prisma clients;
  push rows are deleted FIRST so a failure strands a session remnant, never a
  token). The "no token outlives its session" property is enforced by the
  notifier tick's **invariant sweep** (`PushStore.sweepOrphans`: one anti-join
  DELETE mirroring the session liveness rule) — it removes tokens of expired
  sessions whose browser never returns and any crash remnant, and runs whether
  or not VAPID is configured; subscription upserts run **Serializable** with a
  bounded P2034 retry so concurrent POSTs cannot defeat replace-by-session or
  the per-address cap. New standing gates:
  **`test/push-token-deletion.test.ts`** (all deletion paths incl. the sweep) and
  `test/push-payload.test.ts` (the closed `{ kind, url }` body); the notifier +
  notifier-config suites gain fan-out/VAPID cases.
- The session layer mints the short-lived scoped service assertions
  `services/api` requires for address-scoped reads (ADR-001 Decision 2);
  `API_SERVICE_ASSERTION_KEY` is server-only and never reaches the client
  bundle.
- Design tokens are web-local for v1 (spec §14.8); every token change re-runs
  the shared validation method on both themes in CI — the categorical chart
  palette via `check:palette` and the brand accent/status contrast via
  `test/brand-tokens.test.ts` (both call `scripts/validate_palette.js`). The
  program accent is the NUVA mint-green primary CTA / focus ring; the semantic
  UI status set (`--status-good`/`-warning`/`-serious`/`-critical`) is a fixed
  family, never themed, always paired with an icon + label. The §11 type stack
  (Funnel Sans / Space Grotesk / Geist Mono) is not yet self-hosted — its
  webfonts are a separate change (no committed binaries).
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
  cookie parsing, brand-token contrast (`test/brand-tokens.test.ts`),
  chrome-state banner/freshness honesty (`test/chrome-state.test.ts`, MSW
  harness with fixture overrides), the environment-locked verify-link map
  (`test/verify-link.test.ts`), Learn-page per-figure degradation and
  envelope bounding (`test/learn-data.test.ts`), BigInt amount display
  golden values (`test/amounts.test.ts`; floats never touch amounts), and
  the Validators public projection (`test/validators-data.test.ts`: honest
  degradation plus the closed no-operator-economics key set), and the Market
  shell honesty (`test/market-data.test.ts`: forthcoming vs unavailable,
  verbatim sample rendering, null premium never fabricated). Charts share
  `app/components/charts/step-chart.tsx` (presentation-only step-after,
  dataviz method).
- `test:e2e:live` — the **e2e (live)** layer (PR 5.2; master plan §4):
  Playwright against the REAL devnet stack. Bring it up first
  (`infra/devnet/stack.sh up`, app profile, migrated app schema), then run
  with `E2E_LIVE_BASE_URL` (web origin), `E2E_LIVE_VAULT_ADDRESS`,
  `E2E_LIVE_LCD_URL` (for the stake drill's balance cross-check), and
  `E2E_LIVE_SIGNER_KEY` (a funded THROWAWAY devnet key, 32 hex bytes —
  SECURITY.md devnet rules; specs skip cleanly when unset). The test signer
  lives only in the test process (`e2e-live/signer.ts`); `check:bundle`
  scans for its sentinel so it can never ship. Runs on the stack schedule,
  not in the offline CI lane.
- `test:e2e` — production build + Playwright against `react-router-serve`
  with `NVHASH_MOCK=1` (chain reads served from `@nvhash/fixtures` via MSW —
  fully offline). Includes the axe accessibility scans on both themes (route
  list covers `/` plus the PR 4.1 stub routes `/stake`, `/portfolio`,
  `/market`, `/validators`, `/governance`; new routes join the list), the
  runtime server-only-leak assertion, and a second server instance with
  `NVHASH_MOCK_LIVE_DOWN=1` that proves failed live reads degrade honestly
  (`e2e/chrome.spec.ts`). Run via `./dev pw`, not `./dev pnpm` (needs
  browsers).
- `check:palette` — the shared dataviz validation method
  (`scripts/validate_palette.js`) over both theme token sets in
  `app/theme/tokens.css` (ADR-001 Decision 4 gate).
- `check:bundle` — bundle-secret gate: builds with sentinel values in every
  server-only env var (`scripts/server-only-env.json`) and fails if any
  reaches `build/client`.
- `dev` / `build` / `start` — standard React Router dev server / build /
  serve. `NVHASH_MOCK=1` makes the server read chain state from the fixture
  corpus (dev without a devnet). The full stack against a real dev node is
  `infra/devnet/stack.sh up` (PR 1.5): it resolves the deployed contract/vault
  addresses from chain, points this tier at `http://dev-node:1317` with
  `NVHASH_MOCK` unset, and waits for the `GET /healthz` readiness probe —
  `app/routes/healthz.tsx`, a locale-independent resource route that runs the
  same boot checks (console chain-id match, vault-address cross-check) and
  returns 503 on failure.

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
  shared dataviz method (categorical chart palette) on every change.
- **Brand-token contrast** (`test/brand-tokens.test.ts`): the mint-green
  primary CTA / focus ring clear their WCAG floors and the fixed status set
  stays on its family values in both themes — computed with the shared
  `validate_palette.js` `contrast`, so a token edit that fails AA fails CI.
- **axe** (`e2e/axe.spec.ts`): WCAG A/AA scans on both themes; new routes are
  added to its route list.

- **Personal-route session scope** (standing from PR 5.1,
  `test/session-scope.test.ts` + `test/session.test.ts`): the acting address
  on personal surfaces comes only from the session (query params have no
  effect); anonymous requests prompt-and-explain (page) or 401 (resource
  route); cookie flags, nonce single-use/replay, and expiry bounds are
  pinned. `test/roles.test.ts` pins live role re-check (membership loss on
  refresh; degraded chain reads → no roles). `test/assertion.test.ts` holds
  the ADR-001 Decision 2 golden vectors cross-pinned with
  `services/api/test/assertion-vectors.test.ts`.
  `test/app-schema-allowlist.test.ts` is the app-schema data-minimization
  gate. `test/wallet-adapter.test.ts` keeps the vendor registry closed.

- **Push-token deletion** (standing from PR 6.3, `test/push-token-deletion.test.ts`):
  the SECURITY.md accepted exception's condition made mechanical — an opt-in,
  opaque, revocable Web Push token is deleted on ALL of opt-out, logout, session
  expiry/removal (the deletion chain), dead-endpoint (404/410) pruning, and the
  notifier tick's invariant sweep (any token whose session is missing or expired,
  covering never-returning browsers and crash remnants); the
  push body is the closed `{ kind, url }` (`test/push-payload.test.ts`), never
  amounts/addresses/ids.

Later standing gates attach here per plan §4: aggregate-counter keying (PR 7.6).
