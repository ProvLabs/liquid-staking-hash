# CLAUDE.md — engineering console

Internal testing/operations web console.

## Conventions

- Audience is engineers: expose raw contract messages, full query responses,
  and error details. Do not hide complexity behind simplified flows.
- It is acceptable for this app to depend on developer tooling (local chain
  nodes, unpublished contract schemas) that `apps/web/` must not.
- Keep shared UI or client code that both apps need in a shared package rather
  than importing across app boundaries.
- Security ([`SECURITY.md`](../../SECURITY.md)): same rules as the web app —
  no key material outside the wallet, client bundle is public, contract is
  the enforcement boundary. Never lie about state: the honesty-surface rules
  (spec §17) are load-bearing for a verification tool.

## Commands

To be filled in when the app scaffold lands.
