# nvHASH — Liquid Staking for Provenance HASH

nvHASH is a liquid staking vault for the Provenance Blockchain. You deposit
HASH and receive `nvHASH`, a share token whose redemption value (NAV) rises as
staking rewards, validator-paid program commission, and validator TIPs flow
into the vault. Your HASH is staked across a curated, performance-gated set of
validators by the program's CosmWasm contract, which acts as the vault's
**asset manager**. The share token stays liquid while the underlying HASH
earns: hold it, trade it, or (in a coordinated deliverable) bridge it to Base
and Ethereum.

The complete technical specification lives in
[`docs/specs/liquid-staking-spec.md`](docs/specs/liquid-staking-spec.md)
(v1.0, baselined). The program is delivered through two applications — a
chain-truth verification **console** and a consumer-grade **app** — whose
division of responsibility is pinned in
[`docs/architecture/application-boundary.md`](docs/architecture/application-boundary.md).

## How it works, briefly

- **Deposit HASH (`nhash`), receive `nvHASH` shares** at the current NAV via
  the vault's `SwapIn`; no lockup on the share token itself. **Redeem via
  `SwapOut`** with a 60-day worst-case delay, expedited the moment funds are
  actually liquid in the vault.
- **NAV steps up each monthly epoch** when realized rewards are deposited into
  vault principal — no rebasing, no synthetic rate. A permissionless crank
  (`RunEpoch`) executes the whole epoch as one atomic transaction: claim,
  service redemptions, settle, recognize losses, deposit, redeploy, rebalance.
- **Validator marketplace:** validators self-enroll and continuously earn
  their place via on-chain uptime, program commission (paid from their own
  pockets), and optional priority TIPs. Every eligible validator targets the
  same uniform slot size, leveling slashing risk across the set.
- **Machine-checked safety:** receipt conservation, immediate loss
  recognition, and exact NAV-movement identities are asserted by unit tests,
  scripted devnet drills, and a chain-free simulation soak. The safeguards and
  their verification story are detailed in the spec and in
  [`contracts/README.md`](contracts/README.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| [`contracts/`](contracts/) | CosmWasm staking contract (Rust workspace) and its e2e drills |
| [`apps/console/`](apps/console/) | Engineering console — chain-truth verification tool |
| [`apps/web/`](apps/web/) | General user interface (consumer app) |
| [`services/indexer/`](services/indexer/) | Backend chain-event indexer |
| [`services/api/`](services/api/) | Query API serving the web app |
| [`infra/`](infra/) | Infrastructure config; [`infra/devnet/`](infra/devnet/) is the shared local dev chain environment |
| [`docs/`](docs/) | Specifications, architecture (incl. design history), plans, and user docs |

## Status

This repository is the structured home for the nvHASH program, being migrated
in stages from the exploratory `nvhash-cosmos-contracts` repository.
Documentation, specifications, the staking contract, and the devnet tooling
have migrated; the console follows in a future tranche. Delivery status for
the contract is tracked in
[`contracts/IMPLEMENTATION-STATUS.md`](contracts/IMPLEMENTATION-STATUS.md).

## Security

See [`SECURITY.md`](SECURITY.md) for vulnerability reporting and the secure
development practices that apply across the contracts, services, and apps.

## License

[Apache 2.0](LICENSE)
