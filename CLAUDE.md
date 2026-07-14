# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

nvHASH liquid staking system — a monorepo with four legs:

1. **`contracts/`** — CosmWasm smart contracts (Rust). Cargo workspace with
   individual contracts under `contracts/contracts/` and shared crates under
   `contracts/packages/`.
2. **`apps/console/`** — engineering web console used for testing contracts and
   inspecting system state. Internal tool; favors capability over polish.
3. **`apps/web/`** — general user interface for end users. Production quality.
4. **`services/`** — backend indexer (`indexer/`) and query API (`api/`) that
   support the web app. Deployment configuration lives in top-level `infra/`.

## Documentation conventions

- `docs/specs/` — durable technical specifications (protocol behavior, contract
  interfaces, invariants). Update these when behavior changes.
- `docs/plans/` — working plans and design notes for Claude Code sessions.
  Ephemeral; fine to leave in-progress.
- `docs/architecture/` — system-level architecture docs and ADRs.
- `docs/user/` — end-user and operator documentation.

## Security

Read [`SECURITY.md`](SECURITY.md) in full before changing contract, service,
or app code, **and before writing or updating any spec or plan in `docs/` that
directs such changes** — plans and specs inherit the requirements of the code
they schedule, so a security control named in a spec must appear in a plan as
an enforced mechanism with a gating test, never as a topology or caller
assumption. Recording a decision that changes a spec's status (certification,
scope, accepted exceptions) amends the spec in the same change. Non-negotiables:
all contract inputs validated and bounded at entry with simulation coverage
across the full allowed input domain; no user-identifiable information
collected or stored by backend services beyond public chain data; no key
material ever handled outside the user's wallet; spec, invariant assertions,
and status ledger updated in the same change as the behavior they describe.

## Working conventions

- Each area has its own `CLAUDE.md` with area-specific conventions and commands;
  read it before making changes in that area.
- **JS tooling runs in containers, never on the host** (ADR-002 in
  `docs/architecture/`): use the repo-root `./dev` wrapper — `./dev pnpm …`,
  `./dev node …`, `./dev pg up|reset`. Host node/pnpm versions are
  deliberately not load-bearing, and `node_modules` contains Linux binaries
  that are not runnable from the host.
- Keep changes scoped to one area per branch where practical.
- This repo is in migration: when porting exploratory code in, restructure it to
  match this layout rather than copying old layouts wholesale.
