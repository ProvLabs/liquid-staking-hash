# nvHASH Program App

The full-featured, consumer-grade application for the nvHASH liquid staking
program: education, guided transactions, durable history, analytics, and
notifications. Specified in
[`docs/specs/app-spec.md`](../../docs/specs/app-spec.md); not yet built.

Unlike the [console](../console/) — a stateless chain-truth verifier — the app
holds its own state: it is backed by the indexer and query API under
[`services/`](../../services/) and integrates off-chain and cross-chain data.
The division of responsibility between the two surfaces is pinned in
[`docs/architecture/application-boundary.md`](../../docs/architecture/application-boundary.md),
and the personas both surfaces serve are defined in
[`docs/specs/dashboard-personas.md`](../../docs/specs/dashboard-personas.md).
