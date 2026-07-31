// Notifier configuration, validated and bounded at the process boundary
// (SECURITY.md: bound every input; a value that cannot be bounded is an error,
// never a best-effort continue). Secrets come from the environment only;
// `.env.example` carries placeholders.
//
// Fail-fast rules: DATABASE_URL is REQUIRED — a notifier
// without its store is pointless; API_SERVICE_ASSERTION_KEY is REQUIRED and
// ≥ 32 chars — without it no internal read can be authorized. A boot misconfig
// is a loud exit, never a half-running worker.

import { z } from "zod";

export const notifierConfigSchema = z.object({
  /** The `app` schema URL as `app_writer` (ADR-001 Decision 1). Required. */
  databaseUrl: z.string().regex(/^postgres(ql)?:\/\//, "expected a postgres:// URL"),
  /** HMAC key for minting `internal:notifier` assertions. Required, ≥ 32. */
  apiServiceAssertionKey: z.string().min(32).max(512),
  /** services/api base origin (no trailing slash needed; normalized on use). */
  apiBaseUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), "expected an http(s) URL"),
  /** Tick cadence in seconds (default 60, bounded 10–600). */
  tickSeconds: z.coerce.number().int().min(10).max(600).default(60),
  /** Fact page size per stream (default 200, ≤ 500 = the API's ceiling). */
  factLimit: z.coerce.number().int().min(1).max(500).default(200),
  /**
   * Web Push VAPID triple, OPTIONAL and ALL-OR-NONE: with all
   * three set the notifier fans out to push; with none set it records
   * notifications in-app only (the honest "not configured" posture). A PARTIAL
   * VAPID config is a boot error — the imperative check in loadNotifierConfig
   * (bound at entry, reject never continue). Push is never load-bearing
   * (§10.4), so absence is a valid, non-degraded deployment, not a failure.
   *
   * Value shapes mirror the web config's bounds (config.server.ts): a
   * malformed key/subject must fail HERE at boot, not at every send as a
   * scrubbed `status: null` drop that masquerades as transport trouble.
   */
  vapid: z
    .object({
      subject: z
        .string()
        .max(256)
        .refine(
          (s) => /^mailto:.+@.+/.test(s) || /^https:\/\//.test(s),
          "expected a mailto: or https:// VAPID subject",
        ),
      publicKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{80,200}$/, "expected a base64url VAPID public key"),
      privateKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{20,120}$/, "expected a base64url VAPID private key"),
    })
    .optional(),
});

export type NotifierConfig = z.infer<typeof notifierConfigSchema>;

/** Parse and bound the notifier config from an env map (defaults process.env). */
export function loadNotifierConfig(env: NodeJS.ProcessEnv = process.env): NotifierConfig {
  // VAPID is all-or-none: assemble the triple only when complete, and treat a
  // partial config as a boot error (bound at entry, reject never continue).
  const vapidParts = {
    subject: env.WEB_PUSH_VAPID_SUBJECT,
    publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY,
    privateKey: env.WEB_PUSH_VAPID_PRIVATE_KEY,
  };
  const vapidPresent = Object.values(vapidParts).filter((v) => v !== undefined && v !== "").length;
  if (vapidPresent !== 0 && vapidPresent !== 3) {
    throw new Error(
      "Invalid notifier configuration: WEB_PUSH_VAPID_* must be all set " +
        "(subject, public key, private key) or all unset — a partial Web Push config is refused.",
    );
  }
  const vapid = vapidPresent === 3 ? vapidParts : undefined;

  const parsed = notifierConfigSchema.safeParse({
    databaseUrl: env.DATABASE_URL,
    apiServiceAssertionKey: env.API_SERVICE_ASSERTION_KEY,
    apiBaseUrl: env.API_BASE_URL ?? env.API_URL,
    tickSeconds: env.NOTIFIER_TICK_SECONDS,
    factLimit: env.NOTIFIER_FACT_LIMIT,
    vapid,
  });
  if (!parsed.success) {
    // Fail loudly rather than starting half-configured (a notifier that cannot
    // read facts or persist notifications is worse than one that never boots).
    throw new Error(`Invalid notifier configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
