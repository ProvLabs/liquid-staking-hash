// @nvhash/chain-client — typed LCD reads for the nvHASH App (plan PR 0.3).
// Every decoder validates shape at the boundary and returns bigint for every
// chain amount; shapes are locked to the @nvhash/fixtures corpus in test/.

export {
  DecodeError,
  I128_MAX,
  I128_MIN,
  U128_MAX,
  parseCoin,
  parseInt128,
  parseU64Number,
  parseU64String,
  parseUint128,
  type Coin,
} from "./amounts.ts";
export { LcdClient, LcdError, UnsupportedTransportError, type FetchLike, type LcdClientOptions, type QueryParams } from "./lcd.ts";
export { parsePagination, type Pagination } from "./types.ts";
export {
  VaultClient,
  parsePendingSwapOuts,
  parseSwapEstimate,
  parseVaultParams,
  parseVaultState,
  type PendingSwapOut,
  type SwapEstimate,
  type VaultAccount,
  type VaultParams,
  type VaultRecord,
  type VaultState,
} from "./vault.ts";
export {
  NvhashContractClient,
  parseApr,
  parseContractConfig,
  parseEpochSnapshot,
  parseEpochStatus,
  parseJailReport,
  parseValidatorStatus,
  type Apr,
  type ContractConfig,
  type EpochSnapshot,
  type EpochStatus,
  type JailReport,
  type PendingDelegation,
  type PendingRedelegation,
  type ValidatorStatus,
} from "./contract.ts";
export {
  StakingClient,
  parseStakingValidator,
  type Delegation,
  type StakingValidator,
} from "./staking.ts";
export { GroupClient, parseGroupInfo, type GroupInfo } from "./group.ts";
