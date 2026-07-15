# API

Versioned read-only query API (`/api/v1`) serving indexed liquid-staking data
to [`apps/web/`](../../apps/web/) (and other clients). Reads from the store
maintained by [`services/indexer/`](../indexer/); serves **no write endpoint of
any kind**, holds no keys, and signs nothing (implementation plan §1).

## Shape (PR 1.2 scaffold)

Every data route carries the shared freshness envelope
([`@nvhash/api-types`](../../packages/api-types/README.md), app-spec §9.4):

```jsonc
{ "data": …, "meta": { "chain_height": null, "indexed_height": null,
                        "generated_at": "…Z", "source": "indexed" } }
```

Routes registered so far:

| Route | Enveloped | Notes |
| --- | --- | --- |
| `GET /api/v1/status` | yes | Service + freshness descriptor. Null heights (no data plane wired in the scaffold). |
| `GET /api/v1/incidents` | yes | zod-bounded `?limit=&offset=` pagination. Empty until PR 3.1 wires derivation + heights. |
| `GET /api/v1/health` | no | Operational liveness (`{ "status": "ok" }`); intentionally un-enveloped. |

Structural guarantees, all CI-gated (see [`CLAUDE.md`](CLAUDE.md)): read-only
(any write verb → 405), zod-bounded query params (out-of-range → 400), rate
limiting (over ceiling → 429 + `Retry-After`). Heights are `null` until the
`api_reader` client and workers land in M2/M3 — the honest "not certified
fresh" state (§12.1), never a fabricated number.

The real public program endpoints (`/metrics`, `/epochs`, `/validators`,
`/market`) and address-scoped endpoints (`/portfolio`, `/transactions`, with
in-process address authorization) land in M3 (PRs 3.1–3.3).

## Commands

```sh
./dev pnpm --filter @nvhash/api typecheck
./dev pnpm --filter @nvhash/api test
```

Copy `.env.example` to `.env` for local config (placeholders only —
`SECURITY.md`). Live invocation under `./dev` is wired with the PR 1.5
full-stack compose.
