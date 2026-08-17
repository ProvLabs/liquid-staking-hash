# Dependency-audit exceptions

The single register of every advisory the CI audit gates are allowed to
ignore, across all ecosystems this repo ships from: **cargo**
(`contracts/.cargo/audit.toml`), **pnpm** (`pnpm-workspace.yaml`
`auditConfig.ignoreCves` / `ignoreGhsas` — the pnpm-11 settings home; pnpm no
longer reads `package.json#pnpm`), and — once its audit job
exists — **npm** for `apps/console`, which is outside the pnpm workspace and
invisible to the root audit (coverage deferred to PR 8.4b per the 8.0b plan
§7.1 Q5, backstopped by the 8.5 pre-release security review).

`scripts/check-audit-exceptions.mjs` runs in both CI audit jobs and fails on
any id ignored by a machine list without a row here, **and** on any row here
absent from every machine list — the register cannot rot into fiction in
either direction. JSON and TOML carry the machine-readable ids; this file
carries what they cannot: an owner, a reason, and a review-by date per entry.
A blanket severity floor (`--audit-level`) or `continue-on-error` is never an
acceptable substitute — one inconvenient advisory must not silence every
future one.

## Exceptions

| Advisory ID | Ecosystem | Package | Owner | Reason | Review by |
| --- | --- | --- | --- | --- | --- |
| RUSTSEC-2026-0098 | cargo | rustls-webpki 0.101.7 | Carlton Hanna | Dev-dependency-only: reached solely through `provwasm-test-tube → cosmrs → tendermint-rpc → reqwest → rustls 0.21` (`cargo tree -i` verified 2026-08-14), the embedded-chain TEST harness — never compiled into the shipped wasm, which has no TLS stack. The fix requires rustls-webpki ≥0.103, a different major incompatible with the pinned rustls 0.21 chain; the pinned contract test stack does not move without design review (contracts/CLAUDE.md). Granted at PR 8.0b pending ratification. | 2026-10-01 (or the next provwasm-test-tube bump, whichever first) |
| RUSTSEC-2026-0099 | cargo | rustls-webpki 0.101.7 | Carlton Hanna | Same tree, same constraint, same posture as RUSTSEC-2026-0098. | 2026-10-01 (or the next provwasm-test-tube bump) |
| RUSTSEC-2026-0104 | cargo | rustls-webpki 0.101.7 | Carlton Hanna | Same tree, same constraint, same posture as RUSTSEC-2026-0098. | 2026-10-01 (or the next provwasm-test-tube bump) |

<!-- A new row requires: the exact
advisory id (RUSTSEC-*, CVE-* or GHSA-*), the ecosystem whose machine list
carries it, the affected package, a named owner, a reason stating why the
advisory does not apply (not merely that a fix is unavailable), and a
review-by date at which the entry must be re-justified or removed. -->
