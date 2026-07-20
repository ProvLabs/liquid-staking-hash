// Minimal structured (JSON) logger for the indexer.
//
// Data-minimization contract (SECURITY.md "Backend services"): the indexer
// logs only public chain data and operational fields. It must never log an IP
// address, device identifier, user-agent, or any off-chain identifier — not
// even alongside a wallet address. That rule is enforced statically by the
// log-scrubbing gate (test/log-scrubbing.test.ts), and encoded here at runtime
// as an allowlist: log context is restricted to `SafeField` keys, so an
// accidental IP/device key is both a type error and dropped at emit time.
//
// A first-party logger keeps the scaffold's dependency surface minimal
// (SECURITY.md dependency discipline). winston (app-spec §12.3) can be adopted
// when the workers land if structured transports are needed.

/**
 * The only keys permitted in log context. All are public chain data or
 * operational metadata — deliberately no IP/device/identity field exists.
 * Extending this set is a data-minimization design decision, like the schema
 * allowlist.
 */
export const SAFE_FIELDS = [
  "stream",
  "height",
  "chainHeight",
  "indexedHeight",
  "txhash",
  "msgIndex",
  "address",
  "valoper",
  "operator",
  "epochIndex",
  "requestId",
  "proposalId",
  "kind",
  "severity",
  "incidentId",
  "count",
  "durationMs",
  "error",
] as const;

export type SafeField = (typeof SAFE_FIELDS)[number];

export type LogContext = Partial<Record<SafeField, string | number | bigint | boolean | null>>;

type Level = "debug" | "info" | "warn" | "error";

const SAFE_SET = new Set<string>(SAFE_FIELDS);

function emit(level: Level, message: string, context: LogContext = {}): void {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context)) {
    // Defense in depth: even if a caller bypasses the type, only allowlisted
    // keys are ever serialized — never an IP/device/identity field.
    if (!SAFE_SET.has(key) || value === undefined) continue;
    safe[key] = typeof value === "bigint" ? value.toString() : value;
  }
  const line = JSON.stringify({ level, message, ...safe });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit("debug", message, context),
  info: (message: string, context?: LogContext) => emit("info", message, context),
  warn: (message: string, context?: LogContext) => emit("warn", message, context),
  error: (message: string, context?: LogContext) => emit("error", message, context),
};
