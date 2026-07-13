# Migration Tranche 1: Specs, READMEs, and Dev-Tooling Homes

**Status:** EXECUTED 2026-07-13, with two adjustments from Ira's review: the
old repo's "no em-dashes" convention is dropped (not carried into any
CLAUDE.md), and IMPLEMENTATION-STATUS.md was pruned on migration to the
delivered baseline + open work (historical tranche detail stays in the old
repo's ledger)
**Source:** `~/Projects/nvhash-cosmos-contracts` (exploratory nvHASH repo)
**Target:** this repository

## Scope

This tranche moves documentation only, and establishes (but does not populate)
the homes for the dev-environment scripts and tooling. Application and contract
code, and the scripts themselves, migrate in future tranches alongside the code
they exercise — moving scripts now would strand them without the contract
artifact and dev-node context they depend on.

## 1. Homes for dev-environment scripts and tooling

The old repo's `scripts/` directory mixes four distinct concerns. Proposed
homes, structured so each script lands next to what it serves:

| Concern | Old location | New home |
| --- | --- | --- |
| Dev chain lifecycle (reset/bootstrap/up/down, genesis patching) | `scripts/dev-node.sh`, `.devnet/` state | `infra/devnet/` (state under `infra/devnet/state/`, gitignored) |
| Vault + contract bootstrap for a fresh chain | `scripts/nvhash-deploy.sh`, `nvhash-deploy-p2p.sh` | `infra/devnet/bootstrap/` (Design B variant retired; only the p2p/Design C path carries forward) |
| One-shot operation wrappers (status, cranks, validator lifecycle, user flows, admin) | `scripts/actions/*.sh` | `infra/devnet/actions/` |
| Load/utility tools | `scripts/drone-swaps.sh` | `infra/devnet/tools/` |
| Contract e2e drills (assert contract invariants against live chain) | `scripts/p2p-drill.sh`, `scripts/jail-drill.sh` | `contracts/drills/` — these version with the contract, not the environment |
| Contract build/schema/optimizer | cargo run-scripts in `Cargo.toml` | `contracts/scripts/` (already exists) |
| One-time experiments (uint64 supply ceiling, gov bump) | `scripts/gov-bump-max-supply.sh`, `test-supply-above-uint64.sh` | **Leave behind.** Findings are already recorded in the spec and status ledger; the experiments are done. |

Rationale: the dev node is shared infrastructure — the console dev profile, the
future indexer, and the contract drills all point at it — so its lifecycle,
bootstrap, and operation wrappers belong under `infra/`, which the repo already
defines as "what wires services together." Drills are contract tests and move
with the contract.

**This tranche creates** the directories with a README each (`infra/devnet/`
documenting the lifecycle/bootstrap/actions model ported from the old root
README, `contracts/drills/` describing the drill suite) so the organization is
fixed now and future tranches just drop files in.

## 2. Documentation migration map

| Source | Destination | Treatment |
| --- | --- | --- |
| `docs/nvHASH-liquid-staking-spec.md` (v1.0 baselined) | `docs/specs/liquid-staking-spec.md` | Copy; update internal path references |
| `docs/nvHASH-console-spec.md` | `docs/specs/console-spec.md` | Copy; update references (`src/msg.rs` → `contracts/src/msg.rs`, `console/` → `apps/console/`) |
| `docs/nvHASH-app-spec.md` | `docs/specs/app-spec.md` | Copy; backend references point at `services/` |
| `docs/liquid-staking-dashboard-personas.md` | `docs/specs/dashboard-personas.md` | Copy (companion referenced by both UI specs) |
| `docs/nvHASH-application-boundary.md` | `docs/architecture/application-boundary.md` | Copy; it pins the console/app architecture seam — ADR-like, so architecture |
| `docs/history/*` (4 files: epoch-run design, POC flaw register, redemption-liquidity writeup, denom-collapse assessment) | `docs/architecture/history/` | Copy verbatim. Recommended: the CLAUDE.md and flaw-register hardening notes reference them as load-bearing rationale |
| `docs/persona-review-action-register.md` | `docs/plans/persona-review-action-register.md` | Copy (open action register, fits plans/) |
| `IMPLEMENTATION-STATUS.md` | `contracts/IMPLEMENTATION-STATUS.md` | Copy; update spec path references; note that code migration is pending |
| `docs/superpowers/specs/*`, `docs/superpowers/plans/*` | **Leave behind** | Superseded design lineage (v1.1 Design B is dead; v1.2 content is reflected in the baselined v1.0 spec and history docs). Old repo remains the archive |

Each migrated file gets a one-line provenance note at the top: source repo,
source path, migration date, and "paths updated for this repository's layout";
content is otherwise preserved, not rewritten.

## 3. README information

| Surface | Action |
| --- | --- |
| Root `README.md` (new repo) | Rewrite from the old root README's product overview: what nvHASH is, theory of operation, safeguards/verification story, repo map. Build/test/deploy detail moves down to `contracts/README.md` |
| `contracts/README.md` | Absorb the old README's build/test/deploy sections (optimize, `cargo test --lib`, simulation soak, drill workflow) with paths rewritten to the new homes, plus a "contract code not yet migrated" banner |
| `contracts/CLAUDE.md` | Fold in the durable facts from the old CLAUDE.md files: pinned stack (cosmwasm-std 2.2, provwasm-std 2.8.0, provwasm-test-tube 0.5.0), `GOTOOLCHAIN=go1.24.5` test note, overflow-checks/floor-math convention, receipt-marker Transfer bootstrap requirement, pointer to spec + status ledger |
| `apps/console/README.md` | Rewrite from `console/README.md`: purpose (chain-truth verifier, read-first/wallet-optional, guard preflight, honesty surface), spec pointer to `docs/specs/console-spec.md`, "code migrates in a future tranche" note. `DESIGN-NOTES.md` moves later with the code |
| `apps/web/README.md` | Expand the stub from the app spec's framing: stateful consumer product backed by `services/`, boundary-doc pointer, not yet built |
| `infra/devnet/README.md` | New; ports the old README's devnet workflow (one-time Docker image prerequisite, lifecycle commands, drills, actions catalog) with new paths |

## 4. Cross-cutting content updates

- All `docs/nvHASH-*.md` cross-references become the new `docs/specs/` /
  `docs/architecture/` paths; `scripts/` references become `infra/devnet/` or
  `contracts/drills/`; `console/` becomes `apps/console/`; contract source
  references become `contracts/src/…`.
- Where a doc references something that has not migrated yet (contract source,
  console code, dev-node script), the reference keeps the future path — the
  layout is fixed by this plan, so docs point where things will land.
- Old-repo convention check: the source repo mandates "no em-dashes in any
  prose." The stubs written in this repo so far do not follow it. **Decide:**
  adopt the convention repo-wide (and I sweep existing stubs), or drop it.

## 5. Out of scope (future tranches)

- Contract crate (`src/`, `Cargo.toml`, `schema/`, `artifacts/`) → `contracts/`
- Console app (`console/src/…`, config, DESIGN-NOTES.md) → `apps/console/`
- Script/tooling file moves into the homes established above
- `.vscode/`, `.cargo/`, CI — decided when the code that needs them arrives
- Indexer/API: nothing exists yet in the old repo to migrate

## Execution order (upon approval)

1. Create `infra/devnet/` (+ `bootstrap/`, `actions/`, `tools/`, `state/`) and
   `contracts/drills/` with READMEs; add `infra/devnet/state/` to `.gitignore`.
2. Copy + adapt the docs per §2 (specs, architecture, history, plans).
3. Rewrite the READMEs and CLAUDE.md updates per §3.
4. Cross-reference sweep per §4; verify every internal link resolves or points
   at a documented future home.
5. Single review pass, then present the diff for commit approval.
