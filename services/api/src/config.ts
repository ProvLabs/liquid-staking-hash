// API configuration, validated and bounded at the process boundary
// (SECURITY.md: validate and bound every input; a value that cannot be bounded
// safely is an error, never a best-effort continue). Secrets come from the
// environment only; `.env.example` carries placeholders.
//
// PR 3.1 wires `DATABASE_URL` (the SELECT-only `api_reader` role, ADR-001
// Decision 1) as an OPTIONAL knob: absent, the server runs dataless with the
// honest empty reader (null heights — the scaffold behavior). The
// service-assertion key (`API_SERVICE_ASSERTION_KEY`, ADR-001 Decision 2)
// lands with the PR 3.3 address-scoped routes so config never claims to
// consume a secret the code does not use.

import { z } from "zod";

/** Bounded serving configuration. */
export const configSchema = z.object({
  /** App environment, drives the environment badge (app-spec §7). */
  appEnv: z.enum(["development", "staging", "production"]).default("development"),
  /**
   * `api_reader` connection string (postgres scheme only — bounded at the
   * boundary). Optional: absent means no data plane is wired and every route
   * reports the honest empty state; present, main() constructs the Prisma
   * reader. Never logged, never serialized into any response.
   */
  databaseUrl: z
    .string()
    .regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgresql:// connection URL")
    .optional(),
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
    databaseUrl: env.DATABASE_URL,
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
