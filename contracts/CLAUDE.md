# CLAUDE.md — contracts

CosmWasm smart contracts (Rust). This directory is a Cargo workspace once
contracts are migrated in.

## Conventions

- One contract per directory under `contracts/`; shared code goes in a crate
  under `packages/` rather than being duplicated between contracts.
- Follow standard CosmWasm project conventions (cw-plus style): `src/contract.rs`
  for entry points, `src/msg.rs` for messages, `src/state.rs` for storage,
  `src/error.rs` for errors.
- Generate and commit JSON schemas for contract messages.
- Security first: this code custodies staked funds. Flag any arithmetic that can
  overflow, unchecked external input, or missing access control rather than
  assuming it is handled elsewhere.

## Commands

To be filled in when the workspace lands (expected: `cargo build`, `cargo test`,
`cargo clippy`, and an optimizer script under `scripts/`).
