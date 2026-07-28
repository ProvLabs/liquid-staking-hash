// Web-tier configuration, validated and bounded at the process boundary
// (SECURITY.md: validate and bound every input; a value that cannot be bounded
// safely is an error, never a best-effort continue). Secrets come from the
// environment only; `.env.example` carries placeholders.
//
// This tier consumes only what it uses: the client-safe identity subset
// (app-spec §7) plus the server-only LCD endpoint and console profile chain id
// needed by the boot checks, the server-only services/api base URL for the
// chrome's indexed-plane reads (PR 4.1), and — since PR 5.1 — the wallet and
// session configuration: `WALLETCONNECT_PROJECT_ID` (client-safe: a WC v2
// project id is public by design, §7 allowlist amendment), plus the
// server-only `DATABASE_URL` (the `app_writer` role) and
// `API_SERVICE_ASSERTION_KEY` (ADR-001 Decision 2 minting key).
// `WEB_PUSH_VAPID_*` remains documented-but-unconsumed until PR 6.3, so
// config never claims to consume a secret the code does not use.
// (`SESSION_SECRET` was retired in PR 5.1: sessions are opaque random ids
// resolved against a server-side row — nothing to sign, no key to hold.)
//
// Boot checks (app-spec §7, §12.2) — both fail startup loudly:
//   1. Console chain-id match: the configured console profile must serve the
//      same chain this app is configured for; verify links may never cross
//      environments.
//   2. Vault-address cross-check: the contract's `Config {}` must report
//      exactly the configured `VAULT_ADDRESS`.

import { LcdClient, NvhashContractClient, type FetchLike } from "@nvhash/chain-client";
import { z } from "zod";
import { PROGRAM_UNDERLYING_DENOM } from "~/tx/build";
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
   * services/api base URL for indexed-plane reads (app-spec §7, PR 4.1).
   * Server-only: the browser reads indexed data only through this server's
   * loaders, never the API directly (classified in scripts/server-only-env.json).
   */
  apiUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), "expected an http(s) URL"),
  /**
   * Chain id of the configured console profile (app-spec §7, revision
   * 2026-07-15). Must equal `chainId` or boot fails: one console per
   * environment, links never cross environments (§12.2).
   */
  consoleChainId: z.string().min(1).max(64),
  /**
   * WalletConnect v2 project id (app-spec §7, PR 5.1) — CLIENT-SAFE: a WC
   * project id is public by design (it rides in every pairing URI), amended
   * into the §7 allowlist in the same change. Null disables the WC transport
   * (the injected Figure extension still works); the WC vendors render a
   * "not configured" state rather than a broken pairing flow.
   */
  walletConnectProjectId: z
    .string()
    .regex(/^[0-9a-zA-Z]{8,64}$/, "expected a WalletConnect project id")
    .nullable()
    .default(null),
  /**
   * Block-explorer base URL for transaction verify-links (M6.1 Portfolio
   * history). CLIENT-SAFE: an explorer URL is public by construction (§7
   * allowlist amendment). Optional: absent, history rows render without a
   * verify-link rather than a broken one.
   */
  explorerUrl: z.string().url().optional(),
  /**
   * PostgreSQL URL for the `app` schema, connecting as `app_writer`
   * (ADR-001 Decision 1; server-only). Optional: absent, the session layer
   * runs on a non-durable in-memory store (dev/mock posture, the services/api
   * optional-DATABASE_URL precedent) — production profiles set it.
   */
  databaseUrl: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "expected a postgres:// URL")
    .optional(),
  /**
   * HMAC key for minting the short-lived service assertions services/api
   * verifies (ADR-001 Decision 2; server-only, never past the client-config
   * projection). Optional: absent, no assertion can be minted and personal
   * indexed-plane reads degrade honestly (the API fails closed on its side).
   * Bounded below at 32 chars — a shorter key is a misconfiguration, not a
   * weaker deployment.
   */
  apiServiceAssertionKey: z.string().min(32).max(512).optional(),
  /**
   * Web Push VAPID credentials (app-spec §7, §10.4, §14.7; plan 6.3 §2.2).
   * The three are ALL-OR-NONE (the `.superRefine` below): a deployment either
   * configures push fully or renders the honest "not configured for this
   * environment" state — a partial VAPID config is a boot error, never a
   * best-effort continue (SECURITY.md: bound at the boundary; reject).
   *
   *   * `webPushVapidPublicKey`  — CLIENT-SAFE: a VAPID public key is public by
   *     construction (it ships in `pushManager.subscribe`); amended into the
   *     §7 client-safe allowlist in the same change (client.ts).
   *   * `webPushVapidPrivateKey` / `webPushVapidSubject` — SERVER-ONLY: the
   *     signing key and the VAPID `sub` contact, never past the client
   *     projection (classified in scripts/server-only-env.json).
   *
   * Devnet default is none (the honest not-configured state).
   */
  webPushVapidPublicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{80,200}$/, "expected a base64url VAPID public key")
    .optional(),
  webPushVapidPrivateKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{20,120}$/, "expected a base64url VAPID private key")
    .optional(),
  webPushVapidSubject: z
    .string()
    .max(256)
    .refine(
      (s) => /^mailto:.+@.+/.test(s) || /^https:\/\//.test(s),
      "expected a mailto: or https:// VAPID subject",
    )
    .optional(),
}).superRefine((cfg, ctx) => {
  // All-or-none: a partial VAPID config is a boot error (plan §2.2, §4.4).
  const present = [cfg.webPushVapidPublicKey, cfg.webPushVapidPrivateKey, cfg.webPushVapidSubject].filter(
    (v) => v !== undefined,
  ).length;
  if (present !== 0 && present !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "WEB_PUSH_VAPID_* must be all set (public key, private key, subject) or all unset — " +
        "a partial Web Push config is refused (plan 6.3 §2.2).",
      path: ["webPushVapidPublicKey"],
    });
  }
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
    apiUrl: env.API_URL,
    consoleChainId: env.CONSOLE_CHAIN_ID,
    walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID ?? null,
    explorerUrl: env.EXPLORER_URL,
    databaseUrl: env.DATABASE_URL,
    apiServiceAssertionKey: env.API_SERVICE_ASSERTION_KEY,
    webPushVapidPublicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY,
    webPushVapidPrivateKey: env.WEB_PUSH_VAPID_PRIVATE_KEY,
    webPushVapidSubject: env.WEB_PUSH_VAPID_SUBJECT,
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
  let onChainUnderlying: string;
  try {
    const onChain = await contract.config();
    onChainVault = onChain.vaultAddress;
    onChainUnderlying = onChain.underlyingDenom;
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
  // Underlying-denom cross-check (M6.4 §2.5, added 2026-07-28). The relay's
  // operator guard bounds a payment's denom against the CONSTANT
  // `PROGRAM_UNDERLYING_DENOM`, which is deliberately code and not
  // configuration — but a constant that must match chain reality and is never
  // checked against it is an assumption, not a control (SECURITY.md: enforced
  // mechanisms, never assumptions). This is the same `Config {}` read the
  // vault check already performs, so it costs no extra round-trip. Without it a
  // mismatch surfaces only as every operator payment being refused at the
  // relay, with no boot-time signal.
  if (onChainUnderlying !== PROGRAM_UNDERLYING_DENOM) {
    throw new BootCheckError(
      `underlying-denom cross-check failed: the relay guard bounds payments to ` +
        `"${PROGRAM_UNDERLYING_DENOM}" but the contract's Config {} reports ` +
        `underlying_denom="${onChainUnderlying}". Every operator payment would be ` +
        `rejected; refusing to start.`,
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
    walletConnectProjectId: config.walletConnectProjectId,
    explorerUrl: config.explorerUrl,
    // A VAPID public key is public by construction (it ships in
    // pushManager.subscribe); the private key/subject never cross (§7, §2.2).
    webPushVapidPublicKey: config.webPushVapidPublicKey,
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
