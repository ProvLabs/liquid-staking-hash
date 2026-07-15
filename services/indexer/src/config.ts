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
  chainId: string;
  contractAddress: string;
  vaultAddress: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Parse and validate config from an environment map (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    lcdUrl: required(env, "LCD_URL"),
    chainId: required(env, "CHAIN_ID"),
    contractAddress: required(env, "CONTRACT_ADDRESS"),
    vaultAddress: required(env, "VAULT_ADDRESS"),
  };
}
