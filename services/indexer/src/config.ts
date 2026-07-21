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
  };
}
