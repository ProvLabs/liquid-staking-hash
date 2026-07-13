# Infrastructure

Deployment and infrastructure configuration that spans the services: local
development stacks, deployment manifests, and environment configuration.

- [`devnet/`](devnet/) — the shared local Provenance dev chain environment
  (lifecycle, vault/contract bootstrap, one-shot operation wrappers, tools).
  Used by the contract drills, the console's devnet profile, and the indexer.

Service-specific runtime code stays with each service under `services/`;
this directory holds what wires them together and deploys them.
