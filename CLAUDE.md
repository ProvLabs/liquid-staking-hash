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

## Where things are written down

Read the area's own `CLAUDE.md` before changing code there. Follow the pointer
into `docs/` when you need rationale — do not re-derive it, and do not copy it
back into source or into a `CLAUDE.md`.

| You need | Look in |
|---|---|
| Working conventions, commands, CI gates for an area | that area's `CLAUDE.md` |
| Why a design is the way it is; measured alternatives; recorded decisions | `docs/architecture/*-design-notes.md`, ADRs |
| Behavior a caller can depend on | `docs/specs/` |
| Measured chain/protocol behavior | [`docs/specs/chain-facts.md`](docs/specs/chain-facts.md) |
| What a PR delivered, in what order | `docs/plans/` |
| End-user and operator instructions | `docs/user/` |

`docs/plans/` is ephemeral and fine to leave in progress. `docs/specs/` and
`docs/architecture/` are durable — update them when behavior changes.

## Comment standard

Full rule: [`docs/architecture/comment-standard.md`](docs/architecture/comment-standard.md).
It is normative; this is the short form.

- **A comment must be verifiable against the source file as it exists today.**
  If understanding it requires knowing what the code used to be, it belongs in
  the commit message, an ADR, or an issue.
- **Required:** every exported symbol carries a doc comment specifying its
  *contract* — parameters and valid ranges, return, errors, side effects,
  nullability/ordering guarantees. A caller must not need to read the body.
- **Permitted in-body:** only what the code cannot express itself — an external
  constraint (spec section, protocol requirement, upstream bug), a deliberate
  deviation, or a correctness/performance requirement a reader would otherwise
  "clean up". Phrase as a present-tense constraint, not narrative.
- **Prohibited:** historical narrative; delivery provenance (`PR 6.4 commit A`,
  `M7.1 plan §2.2`, `added in the 2026-07-28 review`); roadmap and scaffold
  placeholders; restatement of the code; commented-out code; dated TODOs with
  no owning issue.
- **Cite durable authorities, not plans** — a spec section, an ADR, a
  `chain-facts` entry, or the gating test that pins the behavior.

When a lore comment encodes a real constraint, **rewrite it as the constraint**
rather than deleting it — deleting loses the constraint and invites the mistake
back.

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

- **JS tooling runs in containers, never on the host** (ADR-002 in
  `docs/architecture/`): use the repo-root `./dev` wrapper — `./dev pnpm …`,
  `./dev node …`, `./dev pg up|reset`. Host node/pnpm versions are
  deliberately not load-bearing, and `node_modules` contains Linux binaries
  that are not runnable from the host.
- Keep changes scoped to one area per branch where practical.
- This repo is in migration: when porting exploratory code in, restructure it to
  match this layout rather than copying old layouts wholesale.
