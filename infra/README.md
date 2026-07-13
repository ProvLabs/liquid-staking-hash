# Infrastructure

Deployment and infrastructure configuration that spans the services: local
development stacks (docker compose), deployment manifests, and environment
configuration.

Service-specific runtime code stays with each service under `services/`;
this directory holds what wires them together and deploys them.
