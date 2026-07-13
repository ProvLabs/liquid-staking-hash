# nvHASH Liquid Staking

Liquid staking system for HASH, organized as a monorepo covering the four legs of
the system plus documentation.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`contracts/`](contracts/) | CosmWasm smart contracts (Rust workspace) |
| [`apps/console/`](apps/console/) | Engineering web console for testing and operations |
| [`apps/web/`](apps/web/) | General user interface (end-user web app) |
| [`services/indexer/`](services/indexer/) | Backend chain-event indexer |
| [`services/api/`](services/api/) | Query API serving the web app |
| [`infra/`](infra/) | Deployment and infrastructure configuration |
| [`docs/`](docs/) | Specifications, plans, architecture notes, and user docs |

## Status

This repository is a clean starting point for migrating exploratory nvHASH liquid
staking work into a structured project. Each area contains a README describing its
scope and a CLAUDE.md with conventions for that area.

## License

[Apache 2.0](LICENSE)
