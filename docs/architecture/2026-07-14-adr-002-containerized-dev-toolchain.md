# ADR-002: Containerized dev toolchain

**Status:** Proposed — accepted when the PR carrying it merges after review
**Date:** 2026-07-14
**Deciders:** Ira (review/merge)
**Delivers:** app implementation plan M0 addendum (PR 0.4)
**Related:** [ADR-001](2026-07-14-adr-001-app-component-architecture.md) Decision 4 (pnpm workspace)

## Context

The repository already normalizes on Docker for its two hardest environments —
the Provenance dev node (`infra/devnet/`, a locally built image with the
pre-release vault module) and the contract build
(`contracts/scripts/build-artifact.sh`, the CosmWasm optimizer image). The
JavaScript toolchain, however, ran on whatever the host provides, and the leak
was visible immediately in M0: the development machine carries Node 26 with no
pnpm and no corepack, while the workspace targets Node ≥ 22 — producing ad-hoc
`npx pnpm@…` workarounds that would otherwise have hardened into convention.

The M1–M8 phases multiply the exposure: Prisma migrations against disposable
PostgreSQL (PRs 1.1, 1.5, and the grant-boundary test), Playwright e2e, and a
full-stack devnet wiring whose entire point is "one command up." Every one of
those needs versions the repo controls, not versions the host happens to have.

## Decision

**All JS task execution — installs, typecheck, tests, dev servers, one-off
node — runs in pinned containers, driven by a thin repo-root wrapper (`./dev`)
over a compose file (`infra/dev/compose.yaml`).** The host needs Docker and
bash; nothing else about the host is load-bearing.

Concretely:

1. **`tools` service** — `node:22-bookworm-slim` (the workspace's `engines`
   floor; major-pinned, upgrade is a one-line reviewed change). pnpm comes
   from the image's corepack honoring the root `packageManager` pin — no
   global installs anywhere. The repo is bind-mounted at `/repo`; a named
   volume carries the container HOME (corepack cache, tool config), while
   pnpm keeps its content-addressable store at the gitignored repo-root
   `.pnpm-store` — its same-device preference, giving hardlinked installs
   (~5 s cold on the dev machine).
2. **`postgres` service** — `postgres:17-alpine` behind a compose profile,
   published on host port **5433** (avoids colliding with any local
   PostgreSQL). Credentials are throwaway local-dev values per the
   `SECURITY.md` devnet rule; data lives in a named volume that
   `./dev pg reset` destroys. This is the substrate PR 1.1's migrations,
   the ADR-001 grant-boundary test, and PR 1.5's full stack build on.
3. **Shared docker network `nvhash-dev`.** Both the compose services and the
   dev node join it (`dev-node.sh` change), so containerized services address
   the chain as `http://dev-node:1317` instead of relying on published host
   ports — the exact wiring the M2 indexer needs.
4. **One execution plane.** `node_modules` installed from the Linux container
   contains Linux-native binaries; running tasks from the host against it is
   unsupported by design. Host editors keep full IntelliSense (they read
   sources and type packages, not native binaries). CI uses the same image,
   so "works in `./dev`" is "works in CI".

### Options considered

| Dimension | A: containerized plane (chosen) | B: host toolchain + version managers | C: devcontainer only |
| --- | --- | --- | --- |
| Version control | Image pin in-repo | Per-contributor (nvm/mise discipline) | Pin, but editor-coupled |
| CI parity | Same image | Divergent by default | Same image, but forces the IDE story |
| Extra services (postgres) | Same compose file | Still needs Docker anyway | Same |
| Cost | Bind-mount I/O on macOS; Linux-only node_modules | Recurring "works on my machine" | All of A plus IDE lock-in |

B keeps the leak this ADR exists to stop — the machine already demonstrated
it. C is A wearing an IDE contract we don't need to impose; nothing prevents a
contributor from layering a devcontainer over the same compose file later.

### Out of scope, deliberately

- **Devnet bash tooling** (`dev-node.sh`, drills, fixture capture) stays
  host-bash: it already requires the Docker CLI by nature (it orchestrates
  containers and `docker exec`s the node's keyring), and its only other
  dependencies are `jq`/`curl`. Wrapping it in a container would need a
  docker-socket mount for no version-drift benefit.
- **Contract toolchain** — already containerized via the optimizer image;
  `cargo test` host quirks are recorded in `contracts/CLAUDE.md` and are the
  contract area's own concern.
- **Playwright (M1)** — PR 1.3 should run e2e in the official
  `mcr.microsoft.com/playwright` image as an additional compose service;
  noted here so the scaffold lands on this substrate, decided there.

## Consequences

Easier: reproducible installs/tests for every contributor and CI from one
image pin; the PR 1.5 "one command up" stack is this compose file gaining
services (indexer, api, web) rather than a new mechanism; disposable Postgres
for migration and grant-boundary tests; the dev node reachable by service
name from every container.

Harder / accepted: macOS bind-mount I/O tax on installs (bounded by the
named-volume store); `node_modules` unusable from the host by design; Docker
becomes a hard prerequisite for JS work (it already was for chain and
contract work).

To revisit: image digest pinning at release hardening (M8); a devcontainer
layer if contributors want it; per-user UID mapping if Linux-host
contributors join.

## Action items

1. [x] This PR: compose file, `./dev` wrapper, `dev-node.sh` network join,
   CLAUDE.md command-section updates, plan M0 row.
2. [ ] PR 1.1/1.2/1.3: scaffolds define their scripts to run under `./dev`;
   CI uses the same images.
3. [ ] PR 1.3: Playwright service on this compose file.
4. [ ] PR 1.5: indexer/api/web services join `infra/dev/compose.yaml`;
   grant-boundary test runs against the `postgres` service.
