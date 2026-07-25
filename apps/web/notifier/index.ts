// The notifier worker (ADR-001 Decision 3; plan 6.2 §2.5). A SEPARATE
// entrypoint OUTSIDE `app/`, so the React Router build never bundles it — it
// shares the web tier's models layer (AlertStore) and services layer
// (the pure evaluation core) but is its own process (`pnpm notifier`).
//
// Discipline (the indexer runtime/worker.ts precedent):
//   * two-phase per stream — network I/O (mint assertion → fetch a bounded
//     fact page) happens OUTSIDE any DB transaction; the insert batch +
//     cursor advance happen INSIDE one transaction (AlertStore.commitTick).
//   * per-stream try/catch — one failing stream never blocks the others; an
//     API error leaves that stream's cursor unmoved and retries next tick (no
//     crash loop; the notifications unique constraint makes the re-scan safe).
//   * injectable clock/sleep/fetch/store — one tick is unit-testable without
//     Postgres or a network (test/notifier.test.ts).
//
// The notifier holds NO `indexed` credential (its `app_writer` DB role has no
// such grant); every indexed fact arrives through services/api under the
// `internal:notifier` scope. Logs carry no IP/device data (SECURITY.md scrub).

// Relative (not `~`) imports so this standalone node entrypoint resolves
// without the Vite bundler alias: every app module it loads at runtime has no
// runtime `~` import of its own (the models layer's `~` import is type-only,
// erased), so `node notifier/index.ts` runs directly (the services/* precedent).
import { mintInternalAssertion } from "../app/lib/services/assertion.server.ts";
import {
  alertArrearsEnvelopeSchema,
  alertIncidentsEnvelopeSchema,
  alertRedemptionsEnvelopeSchema,
  epochsEnvelopeSchema,
  fetchApiJson,
} from "../app/api/api.server.ts";
import {
  evaluateArrears,
  evaluateIncidents,
  evaluateNavSteps,
  evaluateRedemptions,
  type AlertKind,
  type Candidate,
} from "../app/lib/services/alerts.server.ts";
import { getAlertStore, type AlertStore } from "../app/lib/models/alerts.server.ts";
import { getPushStore, type PushStore } from "../app/lib/models/push.server.ts";
import { fanOutPush, webPushSender, type PushSender } from "./push.ts";
import { z } from "zod";

/** Retention windows (plan §7 Q4 proposal values; the mechanism is the commitment). */
export const RETENTION_READ_DAYS = 90;
export const RETENTION_ABSOLUTE_DAYS = 180;
/** One bounded delete batch per tick — minimization applied to our own table. */
export const SWEEP_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Bounded read timeout per fact fetch. */
export const NOTIFIER_READ_TIMEOUT_MS = 10_000;

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Structured stdout logger; addresses are public, no IP/device fields ever. */
export const consoleLogger: Logger = {
  info: (message, fields) => process.stdout.write(JSON.stringify({ level: "info", message, ...fields }) + "\n"),
  error: (message, fields) => process.stdout.write(JSON.stringify({ level: "error", message, ...fields }) + "\n"),
};

/** Injectable seams for one tick (production defaults in `main`). */
export interface NotifierDeps {
  store: AlertStore;
  /** GET a URL (optional headers) → parsed JSON body; throws on failure. */
  fetchJson: (url: string, headers?: Record<string, string>) => Promise<unknown>;
  assertionKey: string;
  /** services/api base origin, trailing slash trimmed. */
  apiBase: string;
  factLimit: number;
  now: () => Date;
  log: Logger;
  // ── Web Push fan-out (Commit B) ──
  /** Subscription reads + dead-endpoint pruning for the delivery phase. */
  pushStore: PushStore;
  /** The push transport, or undefined when Web Push is unconfigured (no VAPID)
   *  — fan-out then no-ops and in-app delivery stands alone (§10.4). */
  pushSender?: PushSender;
}

/** Deliver a stream's newly-inserted notifications to push (never throws). */
async function deliverPush(deps: NotifierDeps, inserted: readonly Candidate[]): Promise<void> {
  await fanOutPush({ inserted, pushStore: deps.pushStore, sender: deps.pushSender, log: deps.log });
}

/** A garbage/absent cursor merely re-scans (dedupe absorbs) — never a throw. */
const cursorSchema = z.coerce.number().int().nonnegative().catch(0);
function parseCursor(raw: string | null): number {
  return cursorSchema.parse(raw ?? "0");
}

/**
 * The redemptions stream cursors on a COMPOUND key `<height>:<request_id>`
 * (the API's `(since_height, after_id)` keyset), so a same-height burst larger
 * than one page — mass maturation at an epoch settlement — pages through
 * completely instead of being skipped by a height-only strictly-greater
 * cursor. A legacy plain-height or garbage cursor degrades to a re-scan
 * (dedupe absorbs); request ids may themselves contain `:`, so only the FIRST
 * separator splits.
 */
export function parseRedemptionsCursor(raw: string | null): { height: number; afterId: string } {
  const match = /^(\d+)(?::(.*))?$/.exec(raw ?? "");
  if (match === null) return { height: 0, afterId: "" };
  return { height: cursorSchema.parse(match[1]), afterId: match[2] ?? "" };
}

/** The public `/epochs` page cap (services/api MAX_PAGE_LIMIT); the nav-step
 * stream clamps its page to it — `factLimit` may lawfully exceed it (the
 * alert-facts ceiling is 500) and `/epochs` rejects, never clamps. */
export const EPOCHS_PAGE_LIMIT = 200;

function internalHeaders(deps: NotifierDeps): Record<string, string> {
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  return { Authorization: mintInternalAssertion(deps.assertionKey, nowSeconds) };
}

// ── Per-stream runners (each: fetch outside tx → evaluate → commitTick) ──────

/** `redemption_update` (default-on): owner present ∧ not opted out. */
export async function runRedemptions(deps: NotifierDeps): Promise<number> {
  const cursor = parseRedemptionsCursor(await deps.store.getCheckpoint("redemptions"));
  const url =
    `${deps.apiBase}/api/v1/internal/alert-facts/redemptions` +
    `?since_height=${cursor.height}&after_id=${encodeURIComponent(cursor.afterId)}&limit=${deps.factLimit}`;
  const body = await deps.fetchJson(url, internalHeaders(deps));
  const facts = alertRedemptionsEnvelopeSchema.parse(body).data;
  const owners = [...new Set(facts.map((f) => f.owner))];
  const [present, optedOut] = await Promise.all([
    deps.store.filterPresent(owners),
    deps.store.optedOutAddresses("redemption_update", owners),
  ]);
  const candidates = evaluateRedemptions(facts, present, optedOut);
  // The page is `(last_height, request_id)` ascending, so its LAST row is the
  // exact resume point — a full page inside a same-height burst continues at
  // the next request id, never skipping the height's overflow.
  const last = facts[facts.length - 1];
  const newCursor =
    last === undefined
      ? `${cursor.height}:${cursor.afterId}` // empty page: cursor unmoved
      : `${last.last_height}:${last.request_id}`;
  // Idle: nothing to insert and the cursor is unmoved — skip the commit
  // entirely (no empty checkpoint transaction per tick).
  if (candidates.length === 0 && newCursor === `${cursor.height}:${cursor.afterId}`) return 0;
  const inserted = await deps.store.commitTick("redemptions", newCursor, candidates);
  await deliverPush(deps, inserted); // outside the DB transaction (two-phase)
  return inserted.length;
}

/** `operator_arrears` (default-on): operator present ∧ not opted out. */
export async function runArrears(deps: NotifierDeps): Promise<number> {
  const cursor = parseCursor(await deps.store.getCheckpoint("arrears"));
  const url = `${deps.apiBase}/api/v1/internal/alert-facts/arrears`;
  const body = await deps.fetchJson(url, internalHeaders(deps));
  const facts = alertArrearsEnvelopeSchema.parse(body).data;
  const operators = [...new Set(facts.map((f) => f.operator))];
  const [present, optedOut] = await Promise.all([
    deps.store.filterPresent(operators),
    deps.store.optedOutAddresses("operator_arrears", operators),
  ]);
  const candidates = evaluateArrears(facts, present, optedOut);
  // Cursor is the latest epoch in arrears (informational; dedupe is correctness).
  const newCursor = facts.reduce((m, f) => Math.max(m, f.epoch_index), cursor);
  if (candidates.length === 0 && newCursor === cursor) return 0; // idle: skip the commit
  const inserted = await deps.store.commitTick("arrears", String(newCursor), candidates);
  await deliverPush(deps, inserted);
  return inserted.length;
}

/** `vault_status` / `validator_set_incident` (default-off): opt-in fan-out. */
export async function runIncidents(deps: NotifierDeps): Promise<number> {
  const cursor = parseCursor(await deps.store.getCheckpoint("incidents"));
  const url = `${deps.apiBase}/api/v1/internal/alert-facts/incidents?since_id=${cursor}&limit=${deps.factLimit}`;
  const body = await deps.fetchJson(url, internalHeaders(deps));
  const facts = alertIncidentsEnvelopeSchema.parse(body).data;
  const [vaultOptIns, validatorOptIns] = await Promise.all([
    deps.store.optInAddresses("vault_status"),
    deps.store.optInAddresses("validator_set_incident"),
  ]);
  const optInsForKind = (kind: AlertKind): ReadonlySet<string> =>
    kind === "vault_status" ? vaultOptIns : kind === "validator_set_incident" ? validatorOptIns : new Set();
  const candidates = evaluateIncidents(facts, optInsForKind);
  const newCursor = facts.reduce((m, f) => Math.max(m, f.id), cursor);
  if (candidates.length === 0 && newCursor === cursor) return 0; // idle: skip the commit
  const inserted = await deps.store.commitTick("incidents", String(newCursor), candidates);
  await deliverPush(deps, inserted);
  return inserted.length;
}

/** `nav_step_posted` (default-off): opt-in fan-out over newly-settled epochs. */
export async function runNavSteps(deps: NotifierDeps): Promise<number> {
  const cursor = parseCursor(await deps.store.getCheckpoint("nav_step"));
  // Public `/epochs` (newest first); no assertion needed. New = index > cursor.
  // Clamped to the public page cap: /epochs rejects (never clamps) limits
  // past MAX_PAGE_LIMIT, and factLimit may lawfully be up to 500.
  const url = `${deps.apiBase}/api/v1/epochs?limit=${Math.min(deps.factLimit, EPOCHS_PAGE_LIMIT)}`;
  const body = await deps.fetchJson(url);
  const rows = epochsEnvelopeSchema.parse(body).data;
  const newIndexes = rows.map((r) => r.epoch_index).filter((i) => i > cursor);
  const optIns = await deps.store.optInAddresses("nav_step_posted");
  const candidates = evaluateNavSteps(newIndexes, optIns);
  const newCursor = rows.reduce((m, r) => Math.max(m, r.epoch_index), cursor);
  if (candidates.length === 0 && newCursor === cursor) return 0; // idle: skip the commit
  const inserted = await deps.store.commitTick("nav_step", String(newCursor), candidates);
  await deliverPush(deps, inserted);
  return inserted.length;
}

const STREAM_RUNNERS: ReadonlyArray<{ name: string; run: (d: NotifierDeps) => Promise<number> }> = [
  { name: "nav_step", run: runNavSteps },
  { name: "redemptions", run: runRedemptions },
  { name: "incidents", run: runIncidents },
  { name: "arrears", run: runArrears },
];

/** Delete read-old / absolute-old notifications in one bounded batch. */
export async function runSweep(deps: NotifierDeps): Promise<number> {
  const now = deps.now().getTime();
  const readCutoff = new Date(now - RETENTION_READ_DAYS * DAY_MS);
  const absoluteCutoff = new Date(now - RETENTION_ABSOLUTE_DAYS * DAY_MS);
  return deps.store.sweep(readCutoff, absoluteCutoff, SWEEP_BATCH);
}

export interface TickResult {
  inserted: Record<string, number>;
  errors: Record<string, string>;
  swept: number;
}

/**
 * One full pass: every stream (isolated by try/catch — a failing stream leaves
 * its cursor unmoved and never blocks the others), then the retention sweep.
 */
export async function runTick(deps: NotifierDeps): Promise<TickResult> {
  const inserted: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const stream of STREAM_RUNNERS) {
    try {
      inserted[stream.name] = await stream.run(deps);
    } catch (err) {
      errors[stream.name] = err instanceof Error ? err.message : String(err);
      deps.log.error("notifier stream failed", { stream: stream.name, reason: errors[stream.name] });
    }
  }
  let swept = 0;
  try {
    swept = await runSweep(deps);
  } catch (err) {
    deps.log.error("notifier sweep failed", { reason: err instanceof Error ? err.message : String(err) });
  }
  return { inserted, errors, swept };
}

/** Drive `runTick` every `tickSeconds` until `signal` aborts. */
export async function runLoop(
  deps: NotifierDeps,
  tickSeconds: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    const result = await runTick(deps);
    deps.log.info("notifier tick", {
      inserted: result.inserted,
      swept: result.swept,
      failed: Object.keys(result.errors),
    });
    if (signal.aborted) return;
    await sleep(tickSeconds * 1000);
  }
}

// ── Production entrypoint ────────────────────────────────────────────────

async function main(): Promise<void> {
  const { loadNotifierConfig } = await import("./config.ts");
  const config = loadNotifierConfig(); // fail-fast on misconfig (loud exit)
  const store = await getAlertStore({ databaseUrl: config.databaseUrl, appEnv: "production" });
  const pushStore = await getPushStore({ databaseUrl: config.databaseUrl, appEnv: "production" });
  const apiBase = config.apiBaseUrl.replace(/\/+$/, "");

  // Web Push is OPTIONAL: with VAPID configured, fan-out delivers; without it,
  // the notifier still records every notification in-app (§10.4) and simply
  // sends no pushes (the honest "not configured" posture end-to-end).
  const pushSender =
    config.vapid === undefined
      ? undefined
      : webPushSender({
          subject: config.vapid.subject,
          publicKey: config.vapid.publicKey,
          privateKey: config.vapid.privateKey,
        });

  const deps: NotifierDeps = {
    store,
    fetchJson: (url, headers) => fetchApiJson(url, (u, init) => fetch(u, init), NOTIFIER_READ_TIMEOUT_MS, headers),
    assertionKey: config.apiServiceAssertionKey,
    apiBase,
    factLimit: config.factLimit,
    now: () => new Date(),
    log: consoleLogger,
    pushStore,
    pushSender,
  };

  const controller = new AbortController();
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  const stop = (signal: NodeJS.Signals): void => {
    consoleLogger.info("notifier stopping", { signal });
    controller.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  consoleLogger.info("notifier started", {
    apiBase,
    tickSeconds: config.tickSeconds,
    factLimit: config.factLimit,
    push: pushSender === undefined ? "not-configured" : "enabled",
  });
  await runLoop(deps, config.tickSeconds, controller.signal, sleep);
  process.exit(0);
}

// Only run when executed directly (never when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
