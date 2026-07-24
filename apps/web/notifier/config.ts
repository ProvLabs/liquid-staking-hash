// Notifier configuration, validated and bounded at the process boundary
// (SECURITY.md: bound every input; a value that cannot be bounded is an error,
// never a best-effort continue). Secrets come from the environment only;
// `.env.example` carries placeholders.
//
// Fail-fast rules (plan 6.2 §2.5): DATABASE_URL is REQUIRED — a notifier
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
  apiBaseUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), "expected an http(s) URL"),
  /** Tick cadence in seconds (default 60, bounded 10–600). */
  tickSeconds: z.coerce.number().int().min(10).max(600).default(60),
  /** Fact page size per stream (default 200, ≤ 500 = the API's ceiling). */
  factLimit: z.coerce.number().int().min(1).max(500).default(200),
});

export type NotifierConfig = z.infer<typeof notifierConfigSchema>;

/** Parse and bound the notifier config from an env map (defaults process.env). */
export function loadNotifierConfig(env: NodeJS.ProcessEnv = process.env): NotifierConfig {
  const parsed = notifierConfigSchema.safeParse({
    databaseUrl: env.DATABASE_URL,
    apiServiceAssertionKey: env.API_SERVICE_ASSERTION_KEY,
    apiBaseUrl: env.API_BASE_URL ?? env.API_URL,
    tickSeconds: env.NOTIFIER_TICK_SECONDS,
    factLimit: env.NOTIFIER_FACT_LIMIT,
  });
  if (!parsed.success) {
    // Fail loudly rather than starting half-configured (a notifier that cannot
    // read facts or persist notifications is worse than one that never boots).
    throw new Error(`Invalid notifier configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
