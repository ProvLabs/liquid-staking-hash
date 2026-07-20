// Web-tier configuration, validated and bounded at the process boundary
// (SECURITY.md: validate and bound every input; a value that cannot be bounded
// safely is an error, never a best-effort continue). Secrets come from the
// environment only; `.env.example` carries placeholders.
//
// The M1 scaffold consumes only what it uses: the client-safe identity subset
// (app-spec §7) plus the server-only LCD endpoint and console profile chain id
// needed by the boot checks. `DATABASE_URL` (the `app_writer` role),
// `SESSION_SECRET`, `API_SERVICE_ASSERTION_KEY`, `WALLETCONNECT_PROJECT_ID`,
// and `WEB_PUSH_VAPID_*` are documented in `.env.example` but deliberately NOT
// read here — they land with the PRs that consume them (5.1 / 3.3 / 6.3), so
// config never claims to consume a secret the code does not use.
//
// Boot checks (app-spec §7, §12.2) — both fail startup loudly:
//   1. Console chain-id match: the configured console profile must serve the
//      same chain this app is configured for; verify links may never cross
//      environments.
//   2. Vault-address cross-check: the contract's `Config {}` must report
//      exactly the configured `VAULT_ADDRESS`.

import { LcdClient, NvhashContractClient, type FetchLike } from "@nvhash/chain-client";
import { z } from "zod";
import { CLIENT_SAFE_CONFIG_KEYS, type ClientConfig } from "./client";

// Bech32-shaped Provenance address (SECURITY.md: addresses validated for
// bech32 shape at the boundary; existence is proven by the boot check's
// on-chain query, not by the regex).
const bech32Address = z
  .string()
  .regex(/^(tp|pb)1[02-9ac-hj-np-z]{38,90}$/, "expected a bech32 Provenance address");

export const configSchema = z.object({
  /** App environment, drives the environment badge (app-spec §7). */
  appEnv: z.enum(["development", "staging", "production"]).default("development"),
  /** Chain id this deployment serves; rendered in the footer and env badge. */
  chainId: z.string().min(1).max(64),
  /** LCD endpoint for server-side live reads (browser never needs LCD CORS). */
  lcdUrl: z.string().url(),
  /** nvHASH asset-manager contract address. */
  contractAddress: bech32Address,
  /** Vault marker address; cross-checked against `Config {}` at boot. */
  vaultAddress: bech32Address,
  /** Same-environment Console origin — verify-link base (app-spec §12.2). */
  consoleUrl: z.string().url(),
  /**
   * Chain id of the configured console profile (app-spec §7, revision
   * 2026-07-15). Must equal `chainId` or boot fails: one console per
   * environment, links never cross environments (§12.2).
   */
  consoleChainId: z.string().min(1).max(64),
});

export type WebConfig = z.infer<typeof configSchema>;

/** Parse and bound config from an environment map (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = configSchema.safeParse({
    appEnv: env.APP_ENV,
    chainId: env.CHAIN_ID,
    lcdUrl: env.LCD_URL,
    contractAddress: env.CONTRACT_ADDRESS,
    vaultAddress: env.VAULT_ADDRESS,
    consoleUrl: env.CONSOLE_URL,
    consoleChainId: env.CONSOLE_CHAIN_ID,
  });
  if (!parsed.success) {
    // Fail loudly rather than starting half-configured.
    throw new Error(`Invalid web configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** A failed boot check. The process must not serve traffic past one of these. */
export class BootCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootCheckError";
  }
}

/**
 * Run the app-spec §7 boot checks against a loaded config. Local checks run
 * first; the vault cross-check then queries the contract's `Config {}` over
 * LCD. Any mismatch (or an unreachable/undecodable LCD) throws — the caller
 * must treat that as a fatal startup error, never a warning.
 */
export async function runBootChecks(
  config: WebConfig,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  if (config.consoleChainId !== config.chainId) {
    throw new BootCheckError(
      `console chain-id mismatch: this app serves CHAIN_ID="${config.chainId}" but the ` +
        `configured console profile (CONSOLE_URL=${config.consoleUrl}) declares ` +
        `CONSOLE_CHAIN_ID="${config.consoleChainId}". Verify links must never cross ` +
        `environments (app-spec §12.2); fix the environment profile.`,
    );
  }

  const lcd = new LcdClient(
    config.lcdUrl,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
  );
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  let onChainVault: string;
  try {
    onChainVault = (await contract.config()).vaultAddress;
  } catch (cause) {
    throw new BootCheckError(
      `vault-address cross-check could not run: querying Config {} on ` +
        `${config.contractAddress} via ${config.lcdUrl} failed ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Refusing to start unverified.`,
    );
  }
  if (onChainVault !== config.vaultAddress) {
    throw new BootCheckError(
      `vault-address cross-check failed: VAULT_ADDRESS="${config.vaultAddress}" but the ` +
        `contract's Config {} reports vault_address="${onChainVault}". The environment ` +
        `profile points at the wrong vault or the wrong contract; refusing to start.`,
    );
  }
}

/** Project the client-safe subset (app-spec §7) for root-loader serialization. */
export function toClientConfig(config: WebConfig): ClientConfig {
  // Explicit projection, key by key: nothing crosses to the client that is not
  // named in CLIENT_SAFE_CONFIG_KEYS (enforced by test/client-config.test.ts
  // and the check:bundle gate).
  const client: ClientConfig = {
    appEnv: config.appEnv,
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    vaultAddress: config.vaultAddress,
    consoleUrl: config.consoleUrl,
  };
  for (const key of Object.keys(client)) {
    if (!(CLIENT_SAFE_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`client config key "${key}" is not in the §7 client-safe allowlist`);
    }
  }
  return client;
}

let booted: Promise<WebConfig> | undefined;

/**
 * Load config and run boot checks exactly once per process; every consumer
 * (entry.server, root loader) awaits the same promise. A rejection is sticky:
 * a failed boot never silently retries into serving traffic.
 */
export function getBootedConfig(): Promise<WebConfig> {
  booted ??= (async () => {
    const config = loadConfig();
    await runBootChecks(config);
    return config;
  })();
  return booted;
}
