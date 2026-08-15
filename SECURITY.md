# Security

nvHASH custodies staked user funds through a CosmWasm contract holding
asset-manager, mint/burn, and NAV authority over a vault. Security is a design
requirement of every change in this repository, not a review step at the end.
This document is the working guidance for engineers and coding agents; the
protocol's trust and threat model is specified in
[`docs/specs/liquid-staking-spec.md`](docs/specs/liquid-staking-spec.md) §12.

## Reporting a vulnerability

Report vulnerabilities privately via GitHub Security Advisories on this
repository ("Report a vulnerability"). Do not open a public issue or pull
request for a suspected vulnerability. You should receive an acknowledgment
within a few business days; please allow coordinated disclosure before
publishing. There is no bounty program at this time.

## Project status

Pre-audit and pre-mainnet. A third-party audit of the staking contract is
mandatory before mainnet launch; open verification items are tracked honestly
in [`contracts/IMPLEMENTATION-STATUS.md`](contracts/IMPLEMENTATION-STATUS.md).

## Secure development practices

### Smart contracts (`contracts/`)

- **Validate and bound every input at the boundary.** Every `ExecuteMsg` and
  config parameter is checked on entry and clamped or rejected into its valid
  range — amounts, bps values, addresses (bech32 shape and existence),
  counts, and intervals. A value that cannot be bounded safely is an error,
  never a best-effort continue.
- **Checked arithmetic only.** The release profile enforces
  `overflow-checks = true`; use saturating/checked/`multiply_ratio` math with
  floor rounding, and round in the vault's favor so dust can never be
  extracted by iteration.
- **Simulation must cover the full allowed input domain.** The chain-free
  soak drives the production planners with randomized economies plus boundary
  values: zero and one base unit, empty vault, maximum validators, extreme
  TVL, and the uint64 share ceiling. When a change adds an input, parameter,
  or state dimension, extend the simulation domain and its per-epoch
  invariant assertions in the same change. Failures must stay
  seed-reproducible.
- **Invariants are machine-checked, not narrative.** Receipt conservation,
  the exact TVV identity, immediate slash recognition
  (`settle + write_down == matured`), and never-rejected chain moves are
  asserted by unit tests, devnet drills, and the soak. A change that touches
  an invariant updates the assertion and the spec together.
- **Permissionless endpoints must be safe for any caller.** Cranks are
  idempotent, gas-bounded, griefing-resistant, and can never move value to
  the caller's benefit. Never gate a safety property on who calls.
- **No unbounded work.** All chain reads paginate; iteration is capped
  (validator bound, chunked continuation cranks); a single bad entry must
  never brick a crank — provide an admin escape hatch and prefer deferring an
  illegal move over reverting the epoch.
- **Errors over panics.** No `unwrap`/`expect`/indexing panics in contract
  code paths; return typed errors.
- **Preserve the flaw-register hardenings.** F1–F9 in
  [`docs/architecture/history/2026-07-02-poc-flaw-register.md`](docs/architecture/history/2026-07-02-poc-flaw-register.md)
  are load-bearing fixes to real exploits; do not simplify them away.

### Backend services (`services/`)

- **Data minimization: no user-identifiable information.** Persist only what
  is already public on chain (addresses, transactions, events) plus minimal
  operational data. Do not collect or store emails, names, or any off-chain
  identity; do not persist IP addresses or device identifiers linked to
  wallet addresses (including in logs — scrub or aggregate); no third-party
  analytics that can deanonymize wallets. If a feature seems to need PII,
  raise it for explicit design review instead of adding a column.
  Accepted exceptions (Ira, 2026-07-13): opt-in **Web Push subscription
  tokens** (opaque, revocable, deleted on opt-out) as a notification channel,
  and minimal operational metadata such as per-address **first/last-seen
  timestamps** for transparent, minimally intrusive usage measurement.
- **No custody, no signing.** Services never hold private keys and never
  relay or construct transactions on a user's behalf; signing happens
  client-side in the wallet.
- **Chain is the source of truth.** Indexed and derived data must be
  rebuildable from chain; treat indexer input as untrusted (validate event
  shapes, handle reorgs/replays idempotently).
- **APIs are read-only and defensive.** Validate and bound all query
  parameters (pagination limits, address formats), rate-limit, and return
  nothing that is not derivable from public data.
- **Secrets via environment only.** Never commit credentials; `.env` files
  are gitignored, and `.env.example` carries placeholders only.

### Web applications (`apps/`)

- **Never touch key material.** No private keys, mnemonics, or seed input
  fields — ever. Wallet adapters own signing; the app only builds messages
  for the wallet to review.
- **Everything shipped to the browser is public.** Client env vars
  (`VITE_*`) and bundles carry no secrets. Endpoints they name are treated as
  publicly known.
- **Never lie about state.** Show chain-derived values with freshness; label
  mirrored or estimated values as such (the console's honesty-surface rules
  in [`docs/specs/console-spec.md`](docs/specs/console-spec.md) §17 apply).
  UI guard preflight is convenience only — the contract remains the
  enforcement boundary.

### Dependencies and supply chain

- Lockfiles are committed for every workspace; the contract stack stays
  pinned (see [`contracts/CLAUDE.md`](contracts/CLAUDE.md)) and the contract
  crate keeps its dependency surface minimal.
- Adding a dependency is a reviewed decision: prefer std/first-party, check
  maintenance and provenance, and avoid install-script-heavy packages.
- Dependency advisories are CI gates, not a release step: the `audit` job in
  `contracts-ci` runs `cargo audit` over `contracts/Cargo.lock`, and the
  `audit` job in `app-ci` runs `pnpm audit` over the workspace lockfile
  (production and dev — the build chain decides what reaches the served
  bundle). Both run on every PR and push, unguarded by change filters, since
  the input that moves is the advisory database. Exceptions are per-advisory
  and owned — `contracts/.cargo/audit.toml` / `pnpm-workspace.yaml`
  `auditConfig`, each id backed by an owner+reason+review-by row in
  [`docs/security/dependency-audit-exceptions.md`](docs/security/dependency-audit-exceptions.md),
  cross-checked both directions by `scripts/check-audit-exceptions.mjs`.
  Blanket allowances (`--audit-level` floors, `continue-on-error`,
  workflow-side ignore flags) are prohibited. `apps/console` sits outside the
  pnpm workspace, so its standalone `package-lock.json` gets its own
  `npm audit` step in the same CI job, under the same posture (dev
  dependencies in scope, no floors, no ignore flags).

### Development environment (`infra/devnet/`)

- Devnet keys and mnemonics are throwaway test material: never reuse them on
  a public network, and never place mainnet/testnet keys in scripts, env
  files, or the gitignored `state/` directory.
- Drill scripts assume a disposable local chain; point them at nothing else.

## Audit readiness

Practices that keep the formal audit cheap and the trail honest:

- **Spec/code parity.** A behavior change updates
  `docs/specs/liquid-staking-spec.md` in the same change; the spec's §14
  resolution record and `contracts/IMPLEMENTATION-STATUS.md` stay current,
  including known gaps (the "NOT covered" headline is kept truthful).
- **Enumerated trust surfaces.** The contract's authorities (asset manager,
  receipt mint/burn, NAV authority) and every admin capability are listed in
  the spec; adding one is a spec-level event, not a code detail.
- **Committed schemas.** `cargo schema` output is regenerated and committed
  with interface changes, so the reviewed interface is the shipped one.
- **Reproducible verification.** Simulation failures reproduce by seed;
  drills are scripted and repeatable; document verification results in the
  status ledger with dates.
- **Traceable rationale.** Commits and PRs reference the spec section or
  flaw-register item they implement, so auditors can walk requirement →
  code → test.
