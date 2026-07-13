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

Read [`SECURITY.md`](SECURITY.md) before changing contract, service, or app
code — it is the working security guidance for this repo. Non-negotiables:
all contract inputs validated and bounded at entry with simulation coverage
across the full allowed input domain; no user-identifiable information
collected or stored by backend services beyond public chain data; no key
material ever handled outside the user's wallet; spec, invariant assertions,
and status ledger updated in the same change as the behavior they describe.

## Working conventions

- Each area has its own `CLAUDE.md` with area-specific conventions and commands;
  read it before making changes in that area.
- Keep changes scoped to one area per branch where practical.
- This repo is in migration: when porting exploratory code in, restructure it to
  match this layout rather than copying old layouts wholesale.
