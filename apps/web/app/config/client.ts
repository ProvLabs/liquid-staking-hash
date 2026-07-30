// The client-safe configuration subset (app-spec §7): the ONLY config shape
// that may be serialized into the root loader and reach the browser. Everything
// here is public by construction (SECURITY.md: everything shipped to the
// browser is public; endpoints it names are treated as publicly known).
//
// Adding a key is a spec-level event: it must be added to the §7 client-safe
// subset, to this allowlist, and it must survive the bundle-secret gate
// (scripts/check-bundle-secrets.mjs) and test/client-config.test.ts.

export const CLIENT_SAFE_CONFIG_KEYS = [
  "appEnv",
  "chainId",
  "contractAddress",
  "vaultAddress",
  "consoleUrl",
  // §7 allowlist amendment: a WalletConnect v2 project id is public
  // by design — it rides in every pairing URI the user's wallet scans.
  "walletConnectProjectId",
  // §7 allowlist amendment: a block-explorer base URL is public by
  // construction (verify-link target for the Portfolio history).
  "explorerUrl",
  // §7 allowlist amendment: a VAPID public key is public by
  // construction — it ships in every `pushManager.subscribe` call. The private
  // key and subject stay server-only (scripts/server-only-env.json).
  "webPushVapidPublicKey",
] as const;

export type ClientSafeConfigKey = (typeof CLIENT_SAFE_CONFIG_KEYS)[number];

export interface ClientConfig {
  appEnv: "development" | "staging" | "production";
  chainId: string;
  contractAddress: string;
  vaultAddress: string;
  consoleUrl: string;
  /** null = WC transport unconfigured (extension vendors still work). */
  walletConnectProjectId: string | null;
  /** undefined = no explorer configured (history rows omit the verify-link). */
  explorerUrl: string | undefined;
  /** undefined = Web Push not configured for this environment (the honest
   *  "not configured" state; no subscribe path exists). Public by construction. */
  webPushVapidPublicKey: string | undefined;
}
