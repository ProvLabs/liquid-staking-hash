# App M3 — Query API (PRs 3.1–3.3)

**Status:** DRAFT 2026-07-22 (master plan §2 M3; delivery shape per Ira: the
three PRs land as **three commits on one services-only branch**, merged in a
single GitHub PR/CI cycle. Reviewed 2026-07-22 against spec/code; the review
resolutions are folded in below, marked **[R1]–[R7]**.)
**Epic:** the nvHASH App — [`app-spec.md`](../specs/app-spec.md) (v1.0-RC1)
**Milestone:** M3 — Query API (services lane; contracts first),
[master plan](2026-07-13-app-implementation-plan.md) §2
**Companions:** [`SECURITY.md`](../../SECURITY.md),
[`services/api/CLAUDE.md`](../../services/api/CLAUDE.md),
[ADR-001](../architecture/2026-07-14-adr-001-app-component-architecture.md)
(Decisions 1–2), app-spec §9.4 (API surface) / §9.5 (derived metrics) /
§9.6 (incidents) / §12.1 (honesty)

## 1. Origin & problem statement

Master plan §2 M3: public program endpoints (3.1), market endpoints (3.2),
address-scoped endpoints with in-process authorization and the standing
cross-address-rejection CI gate (3.3). Endpoint contracts are defined first so
the web lane builds against MSW without waiting.

What already exists on `main` (this plan builds on it, not around it):

- **The serving shell** (PR 1.2): framework-free pure handler
  ([`handler.ts`](../../services/api/src/handler.ts), pipeline: rate-limit →
  path → read-only 405 → zod 400 → dispatch) over a `node:http` adapter; the
  **route registry** ([`routes.ts`](../../services/api/src/routes.ts)) is the
  single source of truth, and the registry-driven contract harness
  ([`envelope-contract.test.ts`](../../services/api/test/envelope-contract.test.ts))
  holds every route to the envelope/read-only/query-bounds gates automatically.
- **The Learn-facing 3.1 contracts are frozen** (PR 4.2): `ProgramMetrics`,
  `EpochRow`, `IncidentRow` in
  [`@nvhash/api-types`](../../packages/api-types/src/rows.ts); `/metrics`,
  `/epochs`, `/incidents` registered as honest all-null/empty scaffolds. 3.1
  fills the real derivations behind these shapes — a field change is an
  app-spec §9.4 revision, never a silent edit.
- **The indexed data has real producers** (M2.1–2.5): `transactions`,
  `redemption_requests`, `epoch_snapshots`, `validator_registry`,
  `validator_epochs`, `incidents`, `reconciler_runs`. The market sampler (2.4)
  stays **parked** (§14.3 + no bridged nvHASH in v1) — `market_samples` /
  `bridge_supply_samples` have schema but no producer.
- **What does not exist:** the `@nvhash/db-indexed` read-only client package
  (named in `services/api/CLAUDE.md` but never created), any DB read path in
  the API, `/validators`, `/market`, the address-scoped endpoints, and the
  assertion-verification machinery.

## 2. Mechanism (shared plumbing, lands with 3.1)

1. **`packages/db-indexed/` (`@nvhash/db-indexed`).** Generates a Prisma
   client from the indexer's **canonical** schema — no schema duplication, no
   migrations of its own: package `prisma.schema` points at
   `../../services/indexer/prisma`, with a custom generator `output` inside
   the package so it never collides with the indexer's default client (the
   seam [`services/indexer/src/db.ts`](../../services/indexer/src/db.ts)
   already names). The SELECT-only guarantee is the `api_reader` **role**
   ([`roles.sql`](../../infra/dev/postgres/roles.sql)), already asserted by
   the grant-boundary gate — the client adds types, not privileges.
   **[R7c]** Its `typecheck` runs `prisma generate` first (the indexer
   precedent — schema-only, no DB needed), and `services/api` declares the
   workspace dependency so `pnpm -r` topological order builds it before the
   API typechecks. `packages/*` is already in the workspace glob and Prisma
   build scripts are already allowlisted — no infra change.

2. **Reader port (`services/api/src/reader.ts`).** An `IndexedReader`
   interface exposing exactly the reads the endpoints need (`heads()`,
   `listEpochs`, `listIncidents`, `programMetrics`, `listValidators`,
   `latestMarket`, `transactionsFor(address)`, `redemptionsFor(address)`).
   Two implementations: Prisma-backed over `@nvhash/db-indexed`, and an
   **in-memory fake** for tests — the same abstract-`Store` pattern as the
   chain-events reducer. Injected via `HandlerDeps`/`RouteContext`; the
   default empty fake keeps `pnpm -r run test` Postgres-free and the existing
   honest-empty assertions green, while populated fakes drive the new
   endpoint tests.

3. **Envelope heights.** `reader.heads()` returns
   `{ chainHeight, indexedHeight }` from the latest `reconciler_runs` row
   (`ranAt` desc); fallback when the reconciler has never run: max
   non-`meta:` `indexer_checkpoints.cursorHeight` as `indexedHeight`, `null`
   `chainHeight`. Cold start reports `0`/`null` honestly — never a fabricated
   head (§12.1). **[R7a]** DB heights are `BigInt`; convert through an
   explicit safe-integer guard before `envelope()` (which throws `RangeError`
   on unsafe values) so a corrupt height is a loud error, not a serialized
   lie. **[R7b]** `/status` stops reporting `data_source: "unwired"` once the
   reader is wired — it reports the configured data source honestly.

4. **Config.** Add **optional** `databaseUrl` (3.1) and `assertionKey` (3.3)
   to [`config.ts`](../../services/api/src/config.ts), bounded at the
   boundary; the Prisma reader is constructed only when `databaseUrl` is
   present (else the empty fake), so existing default-config tests stay
   green. Wires the placeholders already documented in `.env.example`.

## 3. Per-PR design

### 3.1 — public program endpoints

- **Fill the frozen shapes with real derivations:**
  - `/metrics` → `ProgramMetrics`. **[R5]** `participant_count` is pinned as
    **distinct `address` values across all `transactions` rows** (any
    participation, not depositors-only — recorded in the §9.4 revision note);
    `program_started_at` = earliest `blockTime`; `epoch_count` = count of
    `epoch_snapshots`. Null only when genuinely un-indexed.
  - `/epochs` → `EpochRow[]`, newest first, `paginationSchema`-bounded, from
    `epoch_snapshots` (`ended_at` ← `endedAtSeconds`, `tvv` ← `tvvAfter`,
    `net_apr_bps` ← `netAprBps`). **[R1] NAV derivation:** `nav` must NOT be
    naive integer division (`tvvAfter / totalShares` floors to `"1"` and
    destroys all precision). The authoritative convention already exists as
    `navHashPerShare()` in
    [`apps/web/app/learn/amounts.ts`](../../apps/web/app/learn/amounts.ts)
    (scale by `10^(SHARE_EXPONENT − HASH_EXPONENT + 4)`, floor, format 4
    fraction digits). Because the API becomes the producer of the historical
    NAV series while the web computes the live current-NAV figure with the
    same math, drift would put two inconsistent NAVs on one chart. The pure
    helper is **lifted into `@nvhash/api-types`** (zero-runtime-dep pure
    function) and the API consumes it; a **golden test pins its output to the
    web implementation's golden values** (`apps/web/test/amounts.test.ts`).
    The web-side switch to the shared helper is a recorded follow-on (this
    branch stays services-only).
  - `/incidents` → `IncidentRow[]` from `incidents` (`opened_at`←`openedAt`,
    `closed_at`←`closedAt`, `height`←`openedHeight`).
- **Add `/validators`:** freeze `ValidatorRow` in `@nvhash/api-types` —
  `validator_registry` (valoper, moniker, active = `unregisteredAt IS NULL`)
  joined with each validator's latest `validator_epochs` row (uptimeBps,
  eligible, failingReasons, programDelegation, commissionDue as decimal
  strings), plus set-health aggregates (eligible/total, in-arrears count).
  §9.4's current phrasing assigns `/validators` to PR 4.3; master plan §2
  assigns it here — this PR owns the endpoint and row shape, 4.3 consumes
  them (see §7).
- **Contract-test evolution:** the "frozen 4.2 shapes" block gains a
  populated case (injected fake reader → real values, real heights) and
  keeps the honest-empty case (default fake → null/empty, null heights).
- **Postgres-backed reader gate** (`test/integration/`, separate vitest
  config like the indexer's `test:grants`): seed `indexed` rows as
  `indexer_writer`, read them as `api_reader` through the Prisma reader —
  proving the real queries and the Decimal→decimal-string serialization in
  the existing `db-grants` CI job, without touching the Postgres-free suite.

### 3.2 — market endpoint (shape-complete, honest-empty)

- Register `/market`; freeze `MarketSummary` in `@nvhash/api-types`: `price`
  (decimal string), `premium_discount_bps`, `depth_bands`, `supply_split`
  (local vs bridged from `bridge_supply_samples`), with **venue +
  `sampled_at` labeling in the payload** — market data has no chain-canonical
  plane, so its labeling works twice as hard (§8.5).
- **[R6]** The frozen contract records the §9.5(4) semantics **now**:
  premium/discount is computed against the **NAV current at the sample's
  time** — not the latest epoch NAV — so the future sampler PR inherits the
  correct rule even though today's honest-empty state makes it moot.
- With no producer, the reader returns empty/null and the envelope carries
  honest heights; "coming soon" is structural, never fabricated. Full
  contract tests (shape, empty state, bounds). The same-change spec note
  records the §14.3/§8.5 deferral and that the shape is stable ahead of the
  sampler.

### 3.3 — address-scoped endpoints + in-process authorization

- **`src/auth.ts`** (ADR-001 Decision 2): verify the web tier's short-lived
  HMAC-SHA256 assertion over `{ scope, iat, exp }` with
  `API_SERVICE_ASSERTION_KEY`. Proposed wire format (to be recorded in
  ADR-001/§12.3 in this change — see §7):
  `Authorization: Bearer <base64url(payload)>.<base64url(hmac)>`.
  Verification: **constant-time** signature compare, `exp` not passed,
  `exp − iat ≤ 60 s`, **[R7d]** `iat` not in the future beyond a small skew
  bound, then scope parse (`address:<bech32>` | `internal:notifier`). The
  assertion header threads through `RequestMeta` like `clientKey` — the
  transport drops headers today
  ([`http-server.ts`](../../services/api/src/http-server.ts)), and the pure
  core stays header-source-agnostic.
- **Registry auth field:** routes declare
  `auth: "public" | "address" | "internal:notifier"`, so enforcement is
  structural and registry-driven like the envelope gate. **[R4] Pipeline
  order is pinned:** rate-limit (429) → path (404) → method (405) →
  **credential validity (401)** → zod bounds (400) → **scope↔address match
  (403)** → dispatch. Credential validity precedes query validation so an
  unauthenticated probe learns nothing about parameter validity; the
  cross-address 403 necessarily follows zod because it compares the parsed
  `?address=`. The test matrix encodes this precedence.
- **`/portfolio`** (auth: address). **[R2] Scope corrected against §8.2:**
  the nvHASH **balance is an on-chain live read owned by the web tier** —
  this endpoint must NOT serve a transactions-sum as "current shares."
  Indexed `transactions` cannot see bank transfers (`transfer_in`/
  `transfer_out` exist in the enum with no producing worker), so such a sum
  would silently misstate holdings; additionally all stored `shares` are
  positive with `kind` labels and `redemption_payout` repeats the request's
  shares, making a naive signed sum double-count the escrow. 3.3 therefore
  serves the indexed facts only: first-activity time, transaction history
  summary, **active redemptions** (owner-indexed `redemption_requests` with
  status/estimates/maturity) and their **escrowed shares** total. If any
  indexed share aggregate ever ships, its sign convention (+`swap_in`,
  −`swap_out_request`, +`redemption_refund`, `redemption_payout` = 0) must be
  property-tested against the chain-events reducer. Average-cost basis,
  accrued gain, and effective yield remain **M6.1** (§14.11 gates it).
- **`/transactions`** (auth: address) + `?format=csv`: per-event rows for the
  address, height-ordered, paginated; JSON enveloped. CSV returns `text/csv`
  with freshness in response headers (`X-Chain-Height`, `X-Indexed-Height`,
  `X-Generated-At`). **[R3]** A CSV body cannot carry the JSON envelope, so
  this is a **deliberate, recorded deviation** from §9.4's "every response
  carries the envelope" — written into the §9.4 revision note in this
  change (the M4.1 recorded-deltas pattern), never shipped silently. Column
  set (a tested contract, plan §4): `datetime_utc, block_height, txhash,
  msg_index, kind, shares, nhash, nav_at_height`. CSV-injection guard on
  field values (defensive; all fields are numeric/enum/hash/bech32).
- **`?address=`** is bounded by a new bech32 zod schema in `query.ts`.

## 4. Security & invariants (enforced mechanisms with gating tests)

1. **Cross-address rejection is machinery, not topology** (ADR-001
   Decision 2). *Gate:* `test/cross-address.test.ts`, standing from 3.3:
   assertion for A requesting B → 403; absent/expired/bad-signature → 401;
   `internal:notifier` on a personal endpoint → 403; public endpoints accept
   credential-free requests. The [R4] pipeline order is part of the matrix.
2. **Every query param bounded (zod).** Pagination + the bech32 address
   schema; 400 on out-of-range, never a silent clamp. *Gate:* the
   registry-driven query-bounds harness (covers new routes automatically).
3. **Read-only.** The registry holds only GET; every write verb → 405.
   *Gate:* the existing envelope-contract read-only test.
4. **Never lie about state.** Heights are real (`reconciler_runs`) or honest
   null/empty; amounts are decimal strings, never floats; NAV uses the shared
   scale-then-floor helper. *Gates:* populated + empty contract cases; the
   [R1] golden test; the Postgres-backed reader gate for real serialization.
5. **No PII.** Only public chain data (bech32 addresses, txhashes, heights,
   amounts); `api_reader` is SELECT-only (grant-boundary gate already
   standing); rate-limit keys never linked to addresses.
6. **Secrets via environment only.** `DATABASE_URL`,
   `API_SERVICE_ASSERTION_KEY`; `.env.example` placeholders only.

## 5. PRs

Delivered as three commits on one services-only branch, one PR/CI cycle.

| PR | Scope | Depends on |
| --- | --- | --- |
| 3.1 [P] | `@nvhash/db-indexed` + reader port + heights; real `/metrics`, `/epochs` (shared NAV helper [R1]), `/incidents`; add `/validators` + `ValidatorRow`; contract-test evolution; Postgres-backed reader gate in `db-grants`. | 1.2, 2.1–2.3, 2.5 (heights) |
| 3.2 [P] | `/market` + `MarketSummary` frozen (NAV-at-sample-time semantics [R6]), honest-empty against parked 2.4; §14.3/§8.5 deferral recorded. | 1.2, 3.1 plumbing; §14.3 stays open |
| 3.3 [P] | `auth.ts` + registry auth field + pinned pipeline order [R4]; `/portfolio` (indexed facts only [R2]), `/transactions` + CSV (recorded envelope deviation [R3]); cross-address gate standing from here. | 1.2, 2.1, ADR-001 Decision 2 |

## 6. Same-change doc updates

- `docs/specs/app-spec.md` §9.4 → dated revision note per commit: 3.1 (real
  derivations behind the frozen shapes; `/validators` + `ValidatorRow`;
  heights from `reconciler_runs`; the [R5] `participant_count` definition),
  3.2 (`MarketSummary` frozen with [R6] semantics; "coming soon" recorded),
  3.3 (address-scoped endpoints live; the [R3] CSV envelope deviation; the
  assertion wire format cross-recorded with §12.3/ADR-001).
- `services/api/CLAUDE.md` → reader/`@nvhash/db-indexed` wiring, the
  cross-address gate now standing, the CSV column set, config additions.
- `docs/plans/2026-07-13-app-implementation-plan.md` → revision-log line
  marking 3.1/3.2/3.3 delivered.
- Follow-on recorded (not this branch): `apps/web` switches to the shared
  NAV helper lifted in [R1].

## 7. Open questions

- **`/validators` home** — master plan §2 places it in 3.1; app-spec §9.4's
  PR 4.2 note says "adds `/validators` with PR 4.3." This plan has 3.1 own
  endpoint + row shape (4.3 consumes). Confirm, and align the §9.4 wording in
  the 3.1 revision note.
- **Assertion wire format** — the proposed
  `Bearer <b64url(payload)>.<b64url(hmac)>` must match what the web session
  layer (M5.1) will mint. Record the exact format in ADR-001 Decision 2 and
  app-spec §12.3 in the 3.3 change so both sides implement one contract.
- **`participant_count` semantics** — pinned here as distinct addresses
  across all transaction kinds [R5]; flag at review if depositors-only
  (`swap_in`) is preferred.
