// API configuration, validated and bounded at the process boundary
// (SECURITY.md: validate and bound every input; a value that cannot be bounded
// safely is an error, never a best-effort continue). Secrets come from the
// environment only; `.env.example` carries placeholders.
//
// The M1 scaffold consumes only serving knobs (port, rate limit, proxy trust).
// The indexed-data reader credential (`api_reader`, ADR-001 Decision 1) and the
// service-assertion key (`API_SERVICE_ASSERTION_KEY`, ADR-001 Decision 2) are
// deliberately NOT read here yet — there are no data or address-scoped routes
// in the scaffold. They land with PR 3.1 / PR 3.3 so config never claims to
// consume a secret the code does not use.

import { z } from "zod";

/** Bounded serving configuration. */
export const configSchema = z.object({
  /** App environment, drives the environment badge (app-spec §7). */
  appEnv: z.enum(["development", "staging", "production"]).default("development"),
  /** TCP port to listen on when run as a server. */
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Max requests per window per client, before 429 (rate limiting, §9.4). */
  rateLimitMax: z.coerce.number().int().min(1).max(100_000).default(120),
  /** Rate-limit window length in milliseconds (bounded 1s–1h). */
  rateLimitWindowMs: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  /**
   * Trust a front proxy's `x-forwarded-for` for client identity. Default OFF:
   * an untrusted client must not be able to spoof its rate-limit key by sending
   * the header. Enable only behind a proxy that overwrites it.
   */
  trustProxy: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type ApiConfig = z.infer<typeof configSchema>;

/** Parse and bound config from an environment map (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = configSchema.safeParse({
    appEnv: env.APP_ENV,
    port: env.PORT,
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    trustProxy: env.TRUST_PROXY,
  });
  if (!parsed.success) {
    // Fail loudly rather than starting half-configured.
    throw new Error(`Invalid API configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
