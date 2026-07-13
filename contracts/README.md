# Contracts

CosmWasm smart contracts for the nvHASH liquid staking system.

## Layout

- `contracts/` — individual contracts, one directory per contract
  (e.g. staking hub, liquid token).
- `packages/` — shared Rust crates: common types, contract interfaces,
  and test utilities.
- `scripts/` — build, schema generation, and deployment scripts
  (e.g. wasm optimizer invocation).

## Getting started

A Cargo workspace root (`Cargo.toml`) will be added here when the first
contract is migrated in.
