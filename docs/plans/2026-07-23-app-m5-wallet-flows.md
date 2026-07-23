# App M5 — Wallet & transacting flows (PRs 5.1–5.4)

**Status:** PLANNED 2026-07-23 (master plan §2 M5; delivery shape per Ira:
**plan-first** — this document is commit 1 on `m5.x-wallet-flows`, before any
code. Delivery is tranched: **Tranche A = 5.1 + 5.2**, designed at full grain
and landed as two further commits on this branch, merged in a single GitHub
PR/CI cycle (the M3 precedent); **Tranche B = 5.3 + 5.4**, scoped here at
coarser grain and refined in a same-file revision before its build starts
(§7 Q7). The master plan's §5 rows for §14.4/§14.12 were stale — both are
DECIDED 2026-07-15 in app-spec §14 — and are corrected in this same change,
so Tranche B's gate is plan refinement, not open decisions.)
**Epic:** the nvHASH App — [`app-spec.md`](../specs/app-spec.md) (v1.0-RC1)
**Milestone:** M5 — Wallet & transacting flows (wallet lane; 5.1 independent
of both other lanes), [master plan](2026-07-13-app-implementation-plan.md) §2
**Companions:** [`SECURITY.md`](../../SECURITY.md),
[`apps/web/CLAUDE.md`](../../apps/web/CLAUDE.md),
[ADR-001](../architecture/2026-07-14-adr-001-app-component-architecture.md)
(Decisions 1–2), app-spec §3 (decisions 5–6) / §8.3–§8.4 (flows) /
§10.1–§10.3 (wallet, lifecycle) / §12.3 (application security) /
§14.1, §14.2, §14.4, §14.12

## 1. Origin & problem statement

Master plan §2 M5: WalletConnect v2 + sessions with the dual-vendor
certification gate (5.1), the transaction-lifecycle framework every
fund-moving flow rides (5.2), the stake flow (5.3), and redeem & exit with
the redemption tracker (5.4). 5.2 is the serial spine; 5.3 ∥ 5.4 follow it.
This milestone introduces the **e2e (live)** test layer (master plan §4):
Playwright against the 1.5 devnet stack + `contracts/drills/`.

What already exists on `main` (this plan builds on it, not around it):

- **`@nvhash/chain-client`** (PR 0.3): typed LCD reads the wallet lane
  needs — `VaultClient` (vault state incl. `swapInEnabled`/`swapOutEnabled`,
  swap min/max, `pending_swap_outs`, `estimateSwapOut` over REST;
  `estimateSwapIn` deliberately throws — gRPC-only, a §14.2 pinned fact),
  `NvhashContractClient` (`Config`, `EpochStatus`, `Validators` — the
  operator set role detection reads), `GroupClient` (admin membership),
  BigInt amount discipline throughout.
- **`@nvhash/fixtures`** (PR 0.2): `msgs/swap-in.json` / `swap-out.json` are
  full signed devnet transactions — `/provlabs.vault.v1.MsgSwapInRequest` /
  `MsgSwapOutRequest` proto-JSON with `SIGN_MODE_DIRECT` auth info — the
  golden references for 5.2's message builders (§14.2 stage 1).
- **The assertion verifier** (PR 3.3,
  [`services/api/src/auth.ts`](../../services/api/src/auth.ts)): wire format
  `Bearer <b64url(payload)>.<b64url(hmac)>`, HMAC-SHA256, `exp − iat ≤ 60 s`,
  bounded `iat` skew, scope `address:<bech32>`. 5.1 mints the other half of
  this one contract (ADR-001 Decision 2). `/portfolio` and `/transactions`
  (+CSV) are live behind it with the standing cross-address gate.
- **The `app` schema + `app_writer` role** exist in
  [`roles.sql`](../../infra/dev/postgres/roles.sql) with no grants on
  `indexed` — but the schema is empty and `apps/web` has no Prisma project.
- **Chrome + stubs** (M4.1–4.4): the wallet header slot is a recorded
  deferred delta ("waits for M5"); `/stake` and `/portfolio` are honest
  stubs already in the axe matrix; server-side API reads flow through
  `app/api/api.server.ts`; MSW makes every page buildable offline; standing
  gates run on every PR (`check:bundle`, `check:palette`, i18n coverage,
  axe both themes).
- **The e2e-live substrate** (PR 1.5): `infra/devnet/stack.sh` and
  `contracts/drills/` (`p2p-drill.sh` covers deposit → redeem → expedite →
  maturity; the refund leg is exercised by the 0.2 corpus completeness gate).
- **What does not exist:** any wallet/WalletConnect code, any session or
  cookie machinery, the app-schema Prisma project, the assertion minter, any
  transaction build/sign/broadcast/track code, the e2e-live Playwright
  project, and real `/stake` / `/exit` pages.

## 2. Mechanism (shared plumbing and posture)

1. **Layering follows app-spec §3 decision 2.** Routes (loaders/actions) →
   services (`app/lib/services/*.server.ts`) → models
   (`app/lib/models/*.server.ts`, the only Prisma import). Wallet UI state
   lives in `app/wallet/` (client), transaction machinery in `app/tx/`;
   everything touching the database or secrets is `*.server.ts`.
2. **The app-schema Prisma project** (`apps/web/prisma/`, multi-file, one
   model per file per §9.1) is created by 5.1 and owned by the web tier,
   connecting as **`app_writer`** — the role's grant boundary (no access to
   `indexed`) is already asserted by the standing grants gate. First
   migration: `sessions`, `session_nonces`, and the SECURITY.md-accepted
   per-address `first_seen_at`/`last_seen_at` — nothing else (§4.8).
3. **Broadcast posture (decided 2026-07-23, Ira):** after the wallet signs,
   the signed transaction is broadcast by a **guarded web-tier relay** — a
   resource route that accepts only a fully-signed tx whose **sole signer
   equals the session address**, whose msg types are in a **closed
   allowlist** (`MsgSwapInRequest`, `MsgSwapOutRequest`; governance types
   join in M7), size-capped and rate-limited, session required. The server
   cannot alter a signed transaction without invalidating its signature, so
   the relay adds no signing or custody capability — recorded as an app-spec
   §12.3 amendment in the 5.2 commit (§6). This keeps the LCD un-exposed to
   browsers (§7 config: "the browser never needs LCD CORS") and rejects the
   alternatives: browser→LCD direct (contradicts that posture) and
   wallet-side broadcast (non-standard beyond `cosmos_signDirect`; would
   fail the dual-vendor conformance gate).
4. **e2e-live staging (decided 2026-07-23, Ira):** 5.2 ships the Playwright
   e2e-live project (separate config; runs against `stack.sh` + drills) plus
   a **test-only signer adapter** — a throwaway devnet key implementing the
   `WalletAdapter` interface, living under `apps/web/e2e-live/` (never under
   `app/`), injected only when the e2e server flag is set, and **proven
   absent from the production client bundle** by `check:bundle` (§4.1).
   Fund-moving drill specs arrive with 5.3/5.4. Recorded as a §10.1/§10.2
   spec note in the 5.2 commit: the App itself still has no devnet key
   mode — the test signer is test infrastructure outside the App proper,
   bundle-gated.

## 3. Per-PR design

### 5.1 — WalletConnect v2 + sessions

**Wallet layer** (`apps/web/app/wallet/`):

- `adapter.ts` — a closed `WalletAdapter` interface: `connect()`,
  `disconnect()`, `getAccount(): { address, pubkey }`,
  `signArbitrary(bytes)` (ADR-36, for session nonces),
  `signDirect(signDoc)`; and a **closed vendor registry**
  `{ "figure-mobile": WC, "figure-extension": injected, "arculus": WC }` —
  a typed union with a compile-time `satisfies` totality assertion (the
  verify-link pattern). Vendor-specific workarounds live only inside that
  vendor's adapter module and are recorded in app-spec §14.1; the shared
  path absorbs nothing vendor-specific (§10.1).
- `wc.ts` — the shared WC v2 core over `@walletconnect/sign-client`
  (pinned): pairing URI + QR render, one session per tab, namespace
  `cosmos:<CHAIN_ID>` with **standard Cosmos-namespace methods only**
  (`cosmos_getAccounts`, `cosmos_signDirect`, `cosmos_signAmino`).
  Dependency set is the minimal one (§7 Q3): `sign-client` + a small QR
  renderer, no modal SDK.
- `figure-extension.ts` — injected-provider adapter for desktop Figure.
- `provider.tsx` / `useWallet()` — React context; fills the M4.1 deferred
  wallet slot in the chrome: connect/disconnect, truncated address in Geist
  Mono, vendor badge.

**Session** (app-spec §3 decision 5, §12.3):

- Schema (§2.2): `sessions` (`id` random 256-bit, `address`, `created_at`,
  `expires_at`, `last_refresh_at` — **no role column by design**),
  `session_nonces` (32-byte random `nonce`, `address`, `expires_at` ~5 min,
  single-use).
- `app/lib/services/session.server.ts` + `app/lib/models/session.server.ts`:
  mint nonce (POST resource route, address-bound) → wallet signs via
  **ADR-36** (`cosmos_signAmino` over a `MsgSignData` sign doc: empty
  `chain_id`, `account_number 0`, `sequence 0`) → server verifies the
  secp256k1 signature and the pubkey→bech32 address match (`@noble/curves`
  + `@noble/hashes` — audited, zero install scripts; dependency-review note
  per SECURITY.md) → nonce consumed (replay → 401) → session row + cookie.
  Cookie: **HttpOnly, Secure (non-dev), SameSite=Lax, Path=/**; the value
  is the opaque session id only, never a claims token.
- `app/lib/services/roles.server.ts` — role detection as **live chain reads
  per session refresh** (short-TTL cache, seconds): operator = address ∈
  the contract's `Validators {}` operator set; admin = address ∈ the
  `x/group` admin-policy members via `GroupClient`. Computed per refresh,
  never stored (§4: "the App stores no role list").
- `app/lib/services/assertion.server.ts` — mints the ADR-001 Decision 2
  assertion **exactly** as [`auth.ts`](../../services/api/src/auth.ts)
  verifies it (same payload schema, HMAC-SHA256, ≤ 60 s lifetime,
  `address:<bech32>` scope); `API_SERVICE_ASSERTION_KEY` server-only.
  Personal loaders thread it into `api.server.ts` fetches (first real
  consumers: 5.2 tracking, then 5.4/M6).
- `requireSession()` helper — the **only** path into personal loaders; the
  loader address is always the session address, never a query param. The
  personal-route session-scope check becomes a standing web CI gate from
  this PR on (master plan §4; promised in `apps/web/CLAUDE.md`).

**Config** (§7 amendments in the same commit): `WALLETCONNECT_PROJECT_ID`
joins the **client-safe allowlist** (WC project ids are public by design —
an explicit §7 allowlist amendment); `DATABASE_URL` is consumed by the web
tier (server-only); `API_SERVICE_ASSERTION_KEY` (server-only) — all
zod-bounded at load, all classified in the bundle-secret gate.

**Acceptance gate:** the §14.1 certification checklist (a)–(e) runs against
**both v1 vendors — Figure (WC v2 mobile + extension) and Arculus (WC v2
mobile)** — on devnet; per-vendor results are recorded in app-spec §14.1 in
the same change. Automatable items also run in e2e; the rest execute as a
scripted runbook with recorded results (§7 Q2). Either vendor failing an
item blocks the PR and reopens §14.1 rather than shipping a degraded flow.

*Delivery notes (5.1, 2026-07-23):*
- *Checklist staging:* items (d)/(e) exercise §10.2/§10.3 machinery that
  lands with 5.2 — with Tranche A as one GitHub PR, (a)–(c) certify at the
  5.1 commit and (d)–(e) after the 5.2 commit, all five per vendor before
  merge. Runbook:
  [`2026-07-23-m5.1-wallet-certification-runbook.md`](2026-07-23-m5.1-wallet-certification-runbook.md);
  the manual per-vendor run is the remaining human step for this commit.
- *`SESSION_SECRET` retired* (recorded in app-spec §7): the cookie carries
  an opaque random id over a server-side row — nothing to sign. Removed
  from `.env.example`/`server-only-env.json` rather than left as a phantom.
- *`DATABASE_URL` is optional* for the web tier (services/api precedent):
  absent → non-durable in-memory session store (dev/mock posture, loud
  warning outside development); the e2e/MSW suites run Postgres-free.
- *`GroupClient` extended* in `packages/chain-client` with
  `groupPolicyInfo`/`groupMembers` (standard x/group LCD) for admin
  detection; `Config.admin` resolving to a plain account (policy 404) falls
  back to direct address equality. The fixtures corpus has no group-policy
  captures (the capture devnet had no admin group) — roles tests override
  MSW handlers with standard x/group shapes; capturing real group fixtures
  rides with the §14.1 devnet run.
- *Dependencies added* (dependency-review note): `@walletconnect/sign-client`
  (pinned WC v2 core), `@noble/curves` + `@noble/hashes` + `@scure/base`
  (audited, zero-install-script crypto for server-side ADR-36 verify),
  `uqr` (zero-dep QR SVG for pairing), `@prisma/client`/`prisma` (already
  the indexer's toolchain).

### 5.2 — Transaction lifecycle framework

`apps/web/app/tx/` — the §10.2 machine every fund-moving flow rides
(5.3/5.4 here; M6.4/M7 privileged writes later):

- `lifecycle.ts` — the state machine as a typed reducer (ts-pattern):
  `idle → building → preflight{blocked(reasons[]) | ready} → simulating →
  confirm → signing → broadcasting → pending → confirmed | failed`.
  Transitions are total; `signing` is unreachable except through `confirm`;
  every `blocked` state carries machine-readable reasons (the console R1
  rule, §10.2 step 2).
- `build.ts` — typed builders for `MsgSwapInRequest` / `MsgSwapOutRequest`
  plus direct-sign protobuf encoding of the sign doc, **golden-locked
  against the `@nvhash/fixtures` corpus** (§14.2 stage-1 discipline: the
  fixtures pin assumptions; PR 8.0 re-vets against the formal vault
  release). The capture script gains a raw `body_bytes`/`auth_info_bytes`
  emission so encode tests are byte-golden, not JSON-golden (§7 Q1).
- `preflight.server.ts` — server-supplied guard context from live reads
  (§5.1 plane): vault paused (`swapInEnabled`/`swapOutEnabled`), amount
  within vault min/max, balance sufficient incl. fee, vesting-lock check
  for deposits (account-type query — a small `chain-client` addition).
- `simulate.server.ts` — LCD `POST /cosmos/tx/v1beta1/simulate`; fee =
  gas × gas price × adjustment (reuses the console §14.3 result, §10.2
  step 3).
- `confirm.tsx` — consumer-worded consequence summary, warning/danger
  tiers per §10.2 step 4, fee, and the **exact message JSON behind a
  disclosure** — the disclosure renders a serialization of the very object
  handed to the adapter (single serialization site; byte-equality gated,
  §4.2).
- `broadcast.server.ts` — the guarded relay (§2.3).
- `track.ts` — poll `GET /cosmos/tx/v1beta1/txs/{hash}` to inclusion →
  sonner toast lifecycle with explorer link → affected live reads refresh →
  **optimistic pending row** in client state (clearly labeled pending,
  never persisted) → fast-poll `/api/v1/transactions?address=` (assertion-
  scoped) until the indexed row lands, then reconcile and drop the
  optimistic row (§10.2 step 5).
- **e2e-live introduction** (§2.4): the Playwright e2e-live project, the
  bundle-gated test signer, and a live spec proving session establishment +
  a full lifecycle pass against devnet (sign with the test signer, relay,
  track to inclusion). Fund-moving *flow* specs (real pages) arrive with
  5.3/5.4.

### 5.3 — Stake flow (Tranche B; refine before build, §7 Q7)

`app/routes/stake.tsx` becomes real (replacing the 4.1 stub): the §8.3
sequence — inline education with the next-epoch date (first of the calendar
month after `EpochStatus.last_run`; E-CAL delivered), amount entry (live
wallet balance, vault min/max, zod + BigInt, reject-not-clamp), vesting
honesty, preview, then the 5.2 lifecycle. **Preview mechanism:**
`estimate_swap_in` is gRPC-only (§14.2 pinned fact), so the preview computes
expected shares from live `total_shares`/TVV with the shared floor math,
labeled as an execution-time-rate estimate (§10.3 SwapIn rule); e2e-live
cross-checks the preview against the actual `EventSwapIn` shares. Lands on
Portfolio per §8.3 — the landing shape before M6.1 exists is §7 Q5. First
fund-moving e2e-live drill spec rides here.

### 5.4 — Redeem & Exit (Tranche B; refine before build, §7 Q7)

`app/routes/exit.tsx` (+ nav entry): opens with the **exit-path comparison
table** — guaranteed-vs-typical framing is normative (§8.4); the 60-day
ceiling always occupies the promise position; the typical statistic renders
only at ≥ 10 terminal requests (§14.12, **decided 2026-07-15**), 60-day
guarantee alone below that. DEX column = the **labeled "coming soon" shell**
(§14.4, **decided 2026-07-15**: v1 exit is native-redemption-only in
practice). Native flow: shares entry → `estimateSwapOut` (REST, exists) with
maturity re-pricing copy → the 5.2 lifecycle with the §10.3 SwapOut
confirmation (three timing facts in fixed order) → **redemption tracker**:
queue position + funded state from live `pending_swap_outs`, countdown, and
terminal states (expedited / matured-paid / refunded) from `/api/v1/
portfolio` active redemptions + `/transactions`; direct-vault redemptions
appear because the tracker reads the chain queue. The matured/expedited
default-on alert is M6.2 machinery — 5.4 records the hook as deferred.
e2e-live must render **every terminal state from real drill history**
(p2p-drill expedite + maturity legs; the refund leg per the 0.2 corpus).
The typical-payout statistic needs a serving source the API does not yet
expose — resolved before Tranche B starts (§7 Q4).

## 4. Security & invariants (enforced mechanisms with gating tests)

1. **No key material, ever** (SECURITY.md apps rule; §10.1). Signing exists
   only behind the closed `WalletAdapter` registry; no mnemonic/key input
   fields anywhere; the e2e test signer lives outside `app/` and is excluded
   from the production bundle. *Gates:* `check:bundle` extended with a
   module-absence assertion for the test-signer, `test/wallet-adapter.test.ts`
   (closed registry, `satisfies`-total).
2. **The user signs exactly what they saw** (§10.2 step 4; master plan §6).
   One serialization site feeds both the confirm disclosure and the adapter
   call. *Gates:* `test/tx-confirm.test.ts` (disclosure byte-equals the
   signed payload); e2e asserts the disclosure is present before the sign
   step can fire.
3. **Session cookie properties** (§12.3). HttpOnly/Secure/SameSite=Lax
   opaque-id cookie over a server-side row, absolute + sliding expiry,
   logout destroys the row. *Gates:* `test/session.test.ts` (Set-Cookie flag
   assertions, expiry, logout); e2e (`document.cookie` cannot read it).
4. **Nonces are single-use, expiring, address-bound.** Consume-on-verify.
   *Gate:* `test/session.test.ts` replay case — a captured valid signature
   replayed → 401.
5. **Roles are re-checked on-chain per refresh and never persisted** (§4,
   §12.3). `roles.server.ts` live reads; the sessions schema has no role
   column. *Gates:* `test/roles.test.ts` (MSW: remove the address from the
   group fixture → next refresh loses admin), the schema lint of §4.8.
6. **Personal-route session scope — standing gate from 5.1 on** (master
   plan §4). `requireSession()` is the only path into personal loaders; the
   loader address is always the session address. *Gates:*
   `test/session-scope.test.ts`; e2e: personal routes without a session
   prompt-and-explain — never blank, never another address's data.
7. **Assertion minting matches the API verifier exactly** (ADR-001
   Decision 2 — one contract, two implementations). *Gates:*
   `test/assertion.test.ts` with **shared golden vectors cross-pinned in
   both packages' suites** (a vector change fails both until updated
   together); `check:bundle` covers `API_SERVICE_ASSERTION_KEY`.
8. **No PII; the app schema stays on the allowed-fields list**
   (SECURITY.md data minimization + accepted exceptions). Sessions, nonces,
   first/last-seen — nothing else; logging keeps IP/device identifiers away
   from addresses. *Gates:* an app-schema allowed-column lint test (the
   indexer schema-lint pattern) + a log-scrubbing unit test.
9. **The broadcast relay is not a fund-moving endpoint** (§3 decision 6;
   the §12.3 amendment of §2.3). Accepts only a fully-signed tx: sole
   signer = session address, msg types in the closed allowlist, size cap,
   rate limit, session required. *Gate:* `test/broadcast-guard.test.ts` —
   wrong signer → 403, non-allowlisted msg → 400, oversize → 413, no
   session → 401, tampered body → broadcast failure surfaces honestly.
10. **Amount inputs validated and bounded at the boundary; reject, never
    clamp** (SECURITY.md). zod + BigInt parse, vault min/max, balance incl.
    fee. *Gate:* `test/tx-preflight.test.ts` boundary matrix — 0, 1 base
    unit, min−1, max+1, > balance, non-numeric, float strings → rejected
    with reasons.
11. **UI preflight is convenience; the contract is the boundary**
    (SECURITY.md). *Gate (Tranche B, e2e-live):* race a vault pause between
    preflight and broadcast → the chain rejection renders as an honest
    failure state — no retry loop, no fabricated success.
12. **Never lie about state.** Optimistic rows are always labeled pending;
    tracker states derive only from chain/API reads. *Gates:* lifecycle
    unit tests (no path renders "confirmed" before inclusion); e2e
    pending-row labeling assertion.
13. **Standing gates continue on every commit:** axe (new routes + the
    confirm dialog focus trap, both themes), i18n coverage for all new
    copy, `check:palette` on any token change, `check:bundle` with every
    new env var classified.

## 5. PRs

Tranche A lands as two commits (after this plan doc) on `m5.x-wallet-flows`,
one GitHub PR/CI cycle. Tranche B follows on its own branch(es) after the
§7 Q7 refinement revision.

| PR | Scope | Depends on |
| --- | --- | --- |
| 5.1 [P] | Wallet layer (WC v2 core + Figure mobile/extension + Arculus adapters, closed registry), chrome wallet slot, app-schema Prisma project (sessions/nonces/first-last-seen), nonce-signature session (ADR-36 verify, HttpOnly cookie), live role re-check, assertion minter + `requireSession()`, §7 config amendments; **§14.1 checklist run against both vendors as the acceptance gate**; session-scope standing gate from here. | 1.3 (delivered); §14.1 DECIDED + amended 2026-07-14 |
| 5.2 | Lifecycle framework: state machine, msg builders + direct-sign encoding (fixture-golden), preflight/simulate, confirm with exact-JSON disclosure, guarded broadcast relay (§12.3 amendment), tracking with optimistic pending rows + API fast-poll reconcile; e2e-live project + bundle-gated test signer introduced. | 5.1, 0.3 (delivered); §14.2 stage 1 (captured; 8.0 re-vets) |
| 5.3 [P] | Stake flow (§8.3) on the 5.2 machinery; NAV-math preview (`estimate_swap_in` is gRPC-only) with e2e cross-check; first fund-moving e2e-live drill spec. | 5.2; Tranche B refinement (§7 Q7) |
| 5.4 [P] | Redeem & Exit (§8.4): comparison table (§14.12 threshold — decided), native flow + redemption tracker, DEX coming-soon shell (§14.4 — decided), every terminal state rendered from real drill history in e2e-live. | 5.2, 3.3 (delivered), 2.1 (delivered); §14.4/§14.12 DECIDED 2026-07-15; typical-payout source (§7 Q4); Tranche B refinement (§7 Q7) |

The tranche split adds no ordering beyond master plan §3 (`5.1 → 5.2 →
5.3 ∥ 5.4`); it pins the delivery boundary between 5.2 and 5.3.

## 6. Same-change doc updates

- **This commit (the plan itself):**
  `docs/plans/2026-07-13-app-implementation-plan.md` — correct the stale §5
  rows (§14.4 and §14.12 → DECIDED 2026-07-15, recorded in app-spec §14)
  and replace the bold decision-blocking clause in 5.4's §2 dependency cell
  with a pointer to the decided items.
- **5.1 commit:** app-spec §7 config table + client-safe allowlist
  amendment (`WALLETCONNECT_PROJECT_ID` client-visible; `DATABASE_URL`
  web-tier row; assertion-key cross-ref); §10.1 / §3 decision 5 revision
  note (adapter matrix, ADR-36 mechanism, cookie properties); **§14.1
  per-vendor checklist results recorded**; ADR-001 Decision 2 — the "PR 5.1
  mints assertions" item ticked, golden-vector cross-pin recorded;
  `apps/web/CLAUDE.md` — prisma/app-schema ownership and commands,
  wallet/session conventions, session-scope standing gate under CI gates.
- **5.2 commit:** app-spec §10.2 revision note (lifecycle machinery, the
  broadcast-relay mechanism) + the §12.3 amendment (signed-tx relay is not
  a fund-moving endpoint — the server cannot alter a signed tx without
  invalidating it) + the §10.1 test-signer note (test infrastructure
  outside the App proper, bundle-gated); `apps/web/CLAUDE.md` — tx-layer
  conventions, e2e-live project + how it runs (`stack.sh` + drills).
- **Tranche A merge:** master-plan revision-log line (5.1 + 5.2 delivered,
  this working plan, PR #NN).
- **5.3 / 5.4 commits (Tranche B):** app-spec §8.3 / §8.4 revision notes;
  master-plan revision-log line; this file's Status updated per the
  revision-log-only-for-merged-work convention.

## 7. Open questions

1. **Byte-golden builders:** the fixtures corpus stores proto-JSON, not raw
   sign-doc bytes — extend the 0.2 capture script to also emit
   `body_bytes`/`auth_info_bytes` so 5.2's encode tests are byte-golden
   (small `packages/fixtures` addition, re-vetted at 8.0). Confirm.
2. **§14.1 checklist mechanics:** which items (a)–(e) run automated in e2e
   vs scripted-manual with recorded results, and the §14.1 recorded-results
   format (proposal: a dated per-vendor table in the §14.1 entry).
3. **WC dependency set:** `@walletconnect/sign-client` + a minimal QR
   renderer, no modal SDK (proposal — smaller supply-chain surface per
   SECURITY.md; the modal SDK adds UI we re-skin anyway). Confirm at 5.1
   review.
4. **Typical-payout statistic source (5.4):** §9.5(3) median/p90 has no
   serving endpoint. Options: extend `/api/v1/metrics`, or a small
   `/redemptions/stats` addition. A services-lane change — decide whether it
   rides inside the 5.4 PR or lands as a small 3.x follow-up first. Must be
   resolved before Tranche B starts.
5. **Post-stake landing before M6.1:** §8.3 says land-on-Portfolio, but the
   real portfolio page is M6.1. Proposal: 5.3 upgrades the portfolio stub
   with a minimal position/pending strip. Resolve in the Q7 refinement.
6. **Session lifetimes:** absolute TTL, sliding-refresh cadence, and the
   role-re-check cache TTL (the spec pins the mechanisms, not the numbers).
   Proposal: 7-day absolute / 24 h sliding refresh / ≤ 60 s role cache.
7. **Tranche B refinement:** before 5.3/5.4 build starts, this file gains a
   revision expanding §3's 5.3/5.4 sections to 5.1/5.2 grain and resolving
   Q4/Q5 (same-file revision, the M3 precedent).
