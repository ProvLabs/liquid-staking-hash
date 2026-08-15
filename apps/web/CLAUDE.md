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
- **Migration history is append-only from a frozen baseline** (PR 8.4a — the
  point at which incremental migrations start is behind us).
  `prisma/migrations/20260723000000_init_sessions` is frozen migration 0 —
  never regenerated or edited (`test/migration-freeze.test.ts` pins its
  SHA-256). A schema change edits the models, then appends a new timestamped
  migration produced with `prisma migrate diff --from-migrations
  --to-schema-datamodel prisma --script`, hand-written SQL included where the
  datamodel cannot express the constraint. The fold gate (app-ci "Migrations
  match the models", `--from-migrations … --exit-code`) fails a model edit
  without its appended migration and vice versa. This schema is NOT
  rebuildable from chain — sessions, notifications and push subscriptions
  exist only here — which is why history froze before the first deployed
  environment, not after. The frozen file's two hand-written blocks are
  frozen-baseline facts guarded by the freeze gate: the existence-checked
  schema-creation DO block (`CREATE SCHEMA IF NOT EXISTS` needs CREATE on the
  DATABASE, which `app_writer` must not hold) and the PARTIAL unique index on
  live incident acknowledgments (Prisma cannot express it; a plain unique
  would forbid re-acknowledging after a reversal).
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

The three `cosmos.group.v1` types are guarded **structurally**: type URL →
signer ↔ session binding (`voter`, `signer`, the single `proposers` entry) →
closed field set with bounded values → the `exec` pin → canonical re-encode. For
`MsgSubmitProposal` the re-encode covers the **envelope**; the inner `Any` bytes
ride verbatim.

**Read this before re-tightening the `MsgSubmitProposal` guard.** It once
carried three further conditions — a closed template match per inner message, a
per-element re-encode, and a live policy sweep that made `guardSignedTx` async
with a 503 failure mode — and they are deliberately gone. The reasoning they
rested on is backwards: an unguarded `MsgExecuteContract` executes **on
inclusion** under the signer's own authority, while a `MsgSubmitProposal`
executes **nothing** until the group's decision policy is satisfied by other
members voting. The group's threshold is the enforcement boundary, and what
protects members from a hostile proposal is **reading** it before voting —
7.2's decoder. `test/broadcast-guard.test.ts` asserts the permissive cases as
**acceptances** on purpose, so restoring the conditions means editing named test
cases rather than sliding them back in.

**The `exec` pin is a confirmation-rigor control, not an authorization one**
(`EXEC_UNSPECIFIED`, enforced as "field 5 absent" since proto3 omits a zero): it
makes executing a second, separately confirmed signature. It is not load-bearing
against an adversary — submit/vote/exec as three relayed txs reaches the same
state. The confirm disclosure shows `exec: EXEC_UNSPECIFIED` even though the
bytes omit it, deliberately.

**The preflight fact rule.** Every fact in `OperatorPreflightFacts` is nullable,
and a variant must short-circuit to `chain-unavailable` on every fact **it
consumes** — and is equally forbidden from blocking on one it does not. Skipping
a check on a null returns a green reason list for an action the contract then
rejects.

**Governance decoding is a closed union** — `MsgSend` plus `MsgExecuteContract`
against the configured contract, with the variant vocabulary **imported** from
`app/tx/build.ts`. Anything else is a tagged `unknown` carrying the exact JSON.

**`app/governance/templates.ts` is the COMPOSER's vocabulary, not a relay-guard
input** — one vocabulary, three consumers (the 7.2 decoder reads it, the confirm
step discloses through it, the composer builds from it). It stays **total in
both directions** against the committed `cargo schema` output, which is a
**product** completeness gate — a new admin capability must be reachable from
the composer — not a security one. Bridge config is **absent, not stubbed**
(§14.3 unresolved, no contract variant backs it). `build.ts` imports
`templateInnerJson` at runtime and keeps a narrow import surface because the
relay decodes untrusted bytes through it, so `templateSummaryKey` returns a
**key plus params**, never a string. Write-side wire bounds
(`MAX_PROPOSAL_MESSAGES`, `MAX_PROPOSAL_METADATA_LEN`, title/summary) are one
declaration in `packages/api-types/src/bounds.ts`.

**Governance affordances come from the LIVE plane alone** — decided in the
loader (`app/governance/actions.ts`), never in JSX. `ProposalDetailVM.liveState`
is **separate from `plane`**: `plane` says which read produced the figures (the
mirror, honestly, for anything closed), `liveState` says whether the chain just
confirmed the state an action would operate on. That is why
`loadGovernanceProposalData` live-reads **accepted** proposals too, and why a
failed read on an accepted proposal is itself evidence *not* to offer execute —
x/group prunes a successful exec in its own transaction.

The execution window is `submit_time + min_execution_period`, x/group's own
rule — **not** the voting-period end — and `min_execution_period` comes from the
**live policy**, which is why it sits inside `liveState`. The asymmetry to hold
in your head: `voting_period_end` **is** snapshotted on the chain's `Proposal`;
`min_execution_period` is **not**, so the module reads the policy account at exec
time. Taking the window from the mirror's `decision_policy` snapshot lets the
button and the preflight gating it disagree after a policy change; that snapshot
is for rendering a historical **threshold**, never the execution window. Not yet
drilled — devnet runs `min_execution_period: 0`.

**An unresolved window is not a zero window.** A policy with no waiting period
serializes `"0s"`, so `null` means only that it could not be determined (a policy
outside the discovered set, or a decision rule this build does not model). Both
preflight and the affordance treat null as *disabled, we cannot say when* —
never as executable. It is reachable: `/governance/:proposalId` accepts any
proposal id and the live read is unscoped, so another group's proposal resolves a
`liveState` with no policy in our set. Voting is member-only; **execution is
permissionless**, and the UI says so.

**Web Push is the one accepted SECURITY.md exception** — opt-in, opaque,
revocable. `public/push-sw.js` is served straight from `public/` with no bundler
involvement; it holds no keys, performs no fetches, and renders from the closed
`{ kind, url }` payload. No token outlives its session (four deletion paths, see
design notes).

**The `admin:` scope is the ONE scope with a precondition beyond the key.**
`mintAdminAssertion` is pure and unguarded (the golden vectors pin its bytes);
`app/lib/services/admin-auth.server.ts` holds the gate and is its only
sanctioned caller. Minting performs a **fresh on-chain group-membership read
that bypasses the 60 s role cache in both directions** — it neither consults nor
populates it — and a degraded read mints **nothing** rather than a hopeful
assertion (ADR-001 Decision 2, amendment 2026-07-28). The split into two modules
is load-bearing, not cosmetic: `notifier/` loads the minting module under Node's
strip-only TS and must not acquire a runtime chain-client dependency. Note what
this does NOT claim — the residual stale-admin window is the assertion's ≤ 60 s,
not zero.

**The membership read has THREE outcomes, not two.** Member, confirmed
non-member, and **unknown** — `AdminCheck` carries `degraded` for the third.
Only a **404** on the policy lookup is the fact "the admin is a plain account,
so address equality answers it"; every other policy failure and every
`groupMembers` failure is `degraded`, and `/admin` renders "we could not check"
rather than "not an administrator". The 404-only test is the
`governance.server.ts` `isNotFound` rule — x/group answers a missing proposal
with **500** on this build, so a status code is not a general "does not exist"
signal. `groupMembers` gets **no** equality fallback: the policy resolved, so a
group exists, and answering membership from address equality decides it from a
non-authoritative input. Collapsing unknown into a denial is fail-closed and
still a lie about state, and it locks a real admin out on a flicker.

**`Roles` carries TWO degradation flags because the two roles fail
independently.** `degraded` = the contract read failed, neither role known;
`adminDegraded` = the contract read succeeded and the x/group read did not, so
`operator` is a fact and `admin: false` is a safe default. `admin` is a finding
only when **neither** is set. Keep them separate: `validators-mine.tsx` gates its
"we could not check" state on `degraded` alone and needs only `Validators {}`,
so one combined flag would blank a working operator view whenever the unrelated
group query flickered. `detectRoles` caches only when both are clear.

**The admin gate is a CAPABILITY gate, never a safety gate** (`SECURITY.md`:
never gate a safety property on who calls). Nothing behind `/admin` writes
program state; every figure is derivable from public chain history, aggregated.
Do not reason "it is behind the admin gate, therefore it is safe to expose X."

**Funnel counters (§14.10) are aggregates BY CONSTRUCTION.** `FunnelCounter`'s
columns are exactly `{stage, day, count}` and may not grow — raise a column for
design review instead of adding one. `recordFunnelEvent` takes a closed event
and the store config and **nothing else**: no address, session, request or
headers appear in its signature, so the mistake is unavailable rather than
merely forbidden. Increments are **server-side in loaders**, fire-and-forget,
and swallowed on failure — a metrics table never takes a page down, and there is
no client script, beacon, pixel or cookie anywhere in the design. Totals are
**event totals, not unique people**, and the §8.8 panel says so; the
chain-derived terminal stage is kept structurally apart so the view cannot imply
uniform precision.

**The funnel vocabulary has ONE declaration.** `FUNNEL_STAGE_KEYS`,
`FUNNEL_RETENTION_DAYS` and `FUNNEL_WINDOW_DAYS` live in `@nvhash/api-types`;
`funnel.server.ts` re-exports them. The stage list is half the row ceiling
(`stages × retention days`), so restating it here made two numbers agree by luck
until someone added a stage. `test/funnel-counters.test.ts` also asserts the list
equals the Prisma enum's members, so schema and code cannot drift either.

**The funnel's two halves share ONE window.** Its upper stages are counters read
here; its terminal stage is chain-derived in `services/api`. Both use
`FUNNEL_WINDOW_DAYS` from `@nvhash/api-types` — one declaration, because two
agreeing constants in two packages can drift and produce a funnel whose bottom
counts a different span than its top. The terminal figure is
`first_deposits_in_window`, **never** `depositor_count`, which is all-time and
belongs to the header panel. The two differ in precision, which the copy
explains; they must not differ in period, which no copy could make honest.

**The incident feed's two inputs fail independently.** Incidents come from
`indexed` via the API, acknowledgments from this tier's `app` schema. A failed
ack read is `null`, never an empty map: `IncidentFeedVM.ackStateKnown` goes
false, **no row offers an affordance**, and the panel says so. An empty map
would render "unacknowledged" for incidents nobody could look up and re-offer
"acknowledge" on one another admin had handled.

**Reversal is a CONDITIONAL update, never find-then-update.**
`unacknowledge` puts `unacknowledgedAt: null` in the WHERE of an `updateMany`,
so the row is claimed in one statement and the loser of a concurrent reversal
sees `count === 0` — C3 forbids last-write-wins on that column by name.
`incidentId` is **BIGINT**, matching `indexed.incidents.id`; the app layer keeps
the safe-integer domain the wire is guarded to and converts at the store
boundary, so a narrower column can never refuse an acknowledgment the wire
accepted.

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
  unlocks the enroll/unregister leg, and `E2E_LIVE_GOV_MEMBER_KEY` the
  governance write leg — the latter must be a funded throwaway key that is
  **also a group member**, since proposing and voting are membership-gated and
  the generic signer key cannot reach them. Both keys are provisioned by
  `infra/devnet/actions/e2e-keys.sh` (eval its output; devnet-only by
  chain-id guard). Runs on the stack schedule (`live-lane.yaml`,
  dispatch-until-8.0), not offline CI.
  **Run live suites through `infra/devnet/stack.sh e2e`** — it restarts the
  compose `web` service (which builds at container start, so a long-running
  stack serves a stale bundle), exports `E2E_LIVE_STACK_PREPARED_AT`, and the
  `e2e-live/drills/stale-bundle.spec.ts` gate FAILS any prepared session
  served by an older bundle. The `e2e-live/drills/` family is driven by
  `infra/devnet/drills.sh` via `E2E_DRILL_PHASE` (unset, the specs skip clean;
  inside an active phase they FAIL rather than skip — a drill that skips is
  silence).
- `fetch:fonts` — the §11 type stack, self-hosted WITHOUT committing binaries
  (plan 8.4 §2.8): `scripts/fetch-fonts.mjs` fetches commit-pinned upstream
  files, verifies a pinned sha256 per file, and writes the gitignored
  `public/fonts/`. The PRODUCTION (image) build runs it with `--require` and
  FAILS CLOSED on a fetch failure or checksum mismatch; dev warns and falls
  back to the system stacks in `app/theme/fonts.css`. A checksum mismatch is
  never written to disk in any mode, and `test/no-tracked-fonts.test.ts`
  gates that no font binary is ever committed.
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
- **`test:db` runs `prisma generate` FIRST, and that is load-bearing.** The
  generated client is not committed, so it must exist before the suite runs —
  the same `prisma generate && …` idiom `typecheck` already uses, and it keeps
  the suite independent of job step order. **Do not remove it as redundant.**
  This schema is the repo's **sole default-output generator**: every generator
  in `services/indexer/prisma` declares an explicit `output` (gated by its
  `prisma-generator-output` test), so nothing else writes the hoisted
  `node_modules/@prisma/client`. A future schema anywhere in the repo must
  declare an explicit `output` too — two default-output generators race, and
  the last `prisma generate` in a process tree wins globally.
- **`app`-schema store gate** (`test:db`, `test/integration/app-stores.test.ts`)
  — the REAL Prisma stores as `app_writer` against a migrated Postgres. It is
  separate from the unit suites on purpose and it is **not** redundant with
  them: the unit suites drive the in-memory stand-ins, which cannot exhibit the
  behaviour the C3 remedies exist for. An in-memory `Map` write never loses an
  update however the SQL is written, and a find-then-set is atomic in
  single-threaded JS — so the `ON CONFLICT DO UPDATE SET count = count + 1`
  increment, the conditional `updateMany` reversal, the partial unique index's
  `AckConflict` (SQLSTATE 23505 / P2002) and the BIGINT `incidentId` are all
  only real here. Excluded from the default config so `pnpm -r run test` stays
  Postgres-free.
- **App-schema allowlist** (`test/app-schema-allowlist.test.ts`) — the
  data-minimization gate; forbids any role/identity/device column. It carries
  TWO gates: the global per-model allowlist, and a **funnel-specific identifier
  denylist** applied to `FunnelCounter` alone (`address` trips there though it
  is legitimate on `Session`). The second is the master plan §4
  security-executable check and gates CI from PR 7.5–7.6 on. Its limit is stated
  in the suite: it checks column NAMES, not cardinality.
- **Funnel counters** (`test/funnel-counters.test.ts`) — the code half of the
  same check: the write path has no identifier-shaped parameter, **every
  `recordFunnelEvent` call site is read from source** and asserted
  identifier-free (a new counted surface must join the expected list
  deliberately), a write failure is swallowed without failing a page, and the
  failure log carries the stage and nothing else.
- **Admin analytics** (`test/admin-data.test.ts`) — the §8.8 honesty matrix:
  every panel degrades individually with a stated reason, "withheld below the
  minimum cohort" stays distinguishable from "the horizon has not elapsed", and
  C4's incident state × affordance is exhaustive (an incident acknowledged by
  ANOTHER admin is never re-offered as if unacknowledged).
  `test/admin-auth.test.ts` pins the mint gate; `test/incident-acks.test.ts`
  pins the live-ack constraint, reversal-preserves-history, and that the store
  touches exactly one Prisma model.
- **Push-token deletion** (`test/push-token-deletion.test.ts`) — makes the
  SECURITY.md accepted exception's *condition* mechanical: a token is deleted on
  opt-out, logout, session expiry/removal, dead-endpoint (404/410) pruning, and
  the notifier tick's invariant sweep. `test/push-payload.test.ts` pins the
  closed `{ kind, url }` body — never amounts, addresses, or ids.
- **Broadcast guard** (`test/broadcast-guard.test.ts`) — the rejection matrix
  including every admin variant, mixed batches, duplicate proto fields, and
  non-canonical encodings, plus the governance blocks: the admitted
  `cosmos.group.v1` set pinned to **exactly** three, every other group type and
  the authz wrapper rejected by name, and the deliberately permissive
  `MsgSubmitProposal` cases asserted as acceptances.
  `test/tx-operator-build.test.ts` holds byte-goldens against captured devnet
  txs; `test/tx-confirm.test.ts` asserts the disclosure equals the signed bytes
  for every variant; `test/tx-preflight.test.ts` holds the predicate matrix in
  both directions.
- **Governance write path** — `test/governance-templates.test.ts` (totality
  against the committed `cargo schema` output, both directions) and
  `test/governance-flows.test.ts` (one case per affordance state, including
  membership-unknown as distinct from not-a-member, and
  disabled-with-an-unknown-time for an unresolvable waiting period). Offline
  `e2e/governance.spec.ts` sweeps affordances; `e2e-live/governance-write.spec.ts`
  skips clean without `E2E_LIVE_GOV_MEMBER_KEY`.
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
- **axe** (`e2e/axe.spec.ts`): WCAG A/AA. Since PR 8.3 the matrix is **derived
  from the route registry** (`e2e/support/routes.ts` enumerates the `:lang?`
  pages — a new page route is scanned by existing; a new `:param` route needs
  a `DYNAMIC_BINDINGS` entry or `test/a11y-routes.test.ts` fails) × both
  themes × three auth states (anonymous / holder / roles, fabricated through
  the app's own login path — `e2e/support/login.ts`, no seam in `app/`).
  Weakening the tag set or tolerating a violation requires the app-spec §11
  exception-ledger entry in the same change. Role-bearing offline renders come
  from **`NVHASH_MOCK_GRANT_ROLES`** (toolingOnly, beside
  `NVHASH_MOCK_LIVE_DOWN`): a fixture-derived grant — one appended group
  member, one appended validator row, the admin answering as a governed
  policy — provably inert when unset (`test/mock-role-grant.test.ts` asserts
  knob-off responses byte-identical to the fixtures). Populated authenticated
  surfaces ride the live lane (`e2e-live/axe.spec.ts`).
- **Motion / keyboard / labeled states** (`e2e/motion.spec.ts`,
  `e2e/keyboard.spec.ts`, `e2e/states.spec.ts`, PR 8.3): the reduced-motion
  kill switch with its non-vacuity case; the enumerated keyboard flows
  (popovers close on Escape AND return focus to their trigger); every §14.4
  shell, cold-start, below-threshold and LIVE_DOWN state visible in the
  accessibility tree — an inaccessible caveat is a caveat that does not exist
  for AT users. The confirm step's semantics are pinned at the component
  level (`test/tx-confirm-a11y.test.ts` — tier by text, never color alone);
  the manual screen-reader walk is an 8.5 pre-launch obligation, and a green
  axe suite is not a completed accessibility review.
- **No client-side analytics** (`e2e/admin.spec.ts`): the counted pages issue no
  request that looks like analytics and none that leaves the app's origin, and
  set no cookie beyond the theme preference. §14.10's "no beacon, no pixel, no
  cookie" as an observable property rather than a promise.
