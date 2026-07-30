// Indexer configuration, validated and bounded at the process boundary
// (SECURITY.md: validate and bound every input; a value that cannot be bounded
// safely is an error, never a best-effort continue).
//
// Secrets come from the environment only (SECURITY.md); `.env.example` carries
// placeholders. `DATABASE_URL` resolves to the indexer's own role credential
// (`indexer_writer`, ADR-001 Decision 1) in real environments.

export interface IndexerConfig {
  databaseUrl: string;
  /** Provenance LCD base; reachable in the dev network as http://dev-node:1317. */
  lcdUrl: string;
  /** Tendermint RPC base (block_results/tx_search); dev network http://dev-node:26657. */
  rpcUrl: string;
  chainId: string;
  contractAddress: string;
  vaultAddress: string;
  /** vault share (receipt) denom — scopes NAV markers to this program. */
  receiptDenom: string;
  /** heights to trail the chain head by; 0 is safe (Provenance instant finality). */
  confirmationDepth: number;
  /** max heights processed per window transaction. */
  indexWindowSpan: number;
  /** delay between polls when a worker is caught up. */
  pollIntervalMs: number;
  /** reconciler pass cadence (slower than the workers; §12.1 honesty alarm). */
  reconcileIntervalMs: number;
  /**
   * Extra x/group policy addresses to mirror, ON TOP of what discovery finds
   * (`Config.admin` → policy → group → all policies on that group). Comma
   * separated; empty by default.
   *
   * This exists for a real deployment shape, not for convenience: the contract has
   * no admin-rotation message (`ExecuteMsg` has no variant that changes
   * `Config.admin`, `InstantiateMsg.admin` is set once), so on a chain whose
   * contract was instantiated before its group existed, discovery correctly
   * resolves to the empty set and the only way to mirror governance is to name the
   * policies. It never REPLACES discovery — the two are unioned — so it cannot be
   * used to pin the indexer to one policy and miss the pending admin/ops split.
   */
  govGroupPolicies: string[];
  /** first height the governance stream ingests (D13: 1, like the other streams). */
  govStartHeight: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Optional integer with a default and an inclusive lower bound; a present but
 * out-of-range/non-integer value is an error, never silently clamped. */
function boundedInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Invalid ${key}: expected an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Parse and validate config from an environment map (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    lcdUrl: required(env, "LCD_URL"),
    rpcUrl: required(env, "RPC_URL"),
    chainId: required(env, "CHAIN_ID"),
    contractAddress: required(env, "CONTRACT_ADDRESS"),
    vaultAddress: required(env, "VAULT_ADDRESS"),
    receiptDenom: required(env, "RECEIPT_DENOM"),
    confirmationDepth: boundedInt(env, "CONFIRMATION_DEPTH", 0, 0),
    indexWindowSpan: boundedInt(env, "INDEX_WINDOW_SPAN", 500, 1),
    pollIntervalMs: boundedInt(env, "POLL_INTERVAL_MS", 5000, 100),
    reconcileIntervalMs: boundedInt(env, "RECONCILE_INTERVAL_MS", 30000, 1000),
    govGroupPolicies: bech32List(env, "GOV_GROUP_POLICIES"),
    govStartHeight: boundedInt(env, "GOV_START_HEIGHT", 1, 1),
  };
}

/** Bech32 shape, bounded at the boundary. Shape only, not a checksum — a
 * well-formed address that does not exist simply resolves to no policy — but
 * malformed input is rejected before any read runs (SECURITY.md: validate and
 * bound every input; a value that cannot be bounded safely is an error). */
const BECH32_RE = /^[a-z]{1,10}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/;

/** Optional comma-separated bech32 list. An entry that is not a bech32 address is
 * a configuration ERROR, never silently dropped: a typo'd policy address would
 * otherwise present as "this policy has no proposals", which is indistinguishable
 * from honest-empty and would hide the misconfiguration indefinitely. */
function bech32List(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const part of parts) {
    if (part.length > 90 || !BECH32_RE.test(part)) {
      throw new Error(`Invalid ${key}: ${JSON.stringify(part)} is not a bech32 address`);
    }
  }
  return parts;
}
