// ChromeState assembly (app-spec §8.0, §12.1). Runs in the root
// loader on every document request: live reads (vault `get` + contract
// `epoch_status`) drive the paused/halted banner; the indexed plane
// (`/api/v1/status`, `/api/v1/incidents`) drives the footer freshness line and
// the degraded banner.
//
// Honesty rules enforced here (SECURITY.md "never lie about state", §12.1),
// gated by test/chrome-state.test.ts:
// - A banner renders only from a true, successfully-read program state.
// - A failed live read is NOT health: liveStatusOk=false, no paused/halted
//   banner, and the footer says "program status unavailable".
// - A failed or unparseable API read only nulls `freshness` (footer "n/a") or
//   drops the incidents input; it never fabricates a banner and never crashes
//   the page.

import type { FreshnessMeta, IncidentRow } from "@nvhash/api-types";
import { LcdClient, NvhashContractClient, VaultClient, type FetchLike } from "@nvhash/chain-client";

import { fetchApiJson, incidentsEnvelopeSchema, statusEnvelopeSchema } from "~/api/api.server";
import type { WebConfig } from "~/config/config.server";
import type { ChromeBanner, ChromeState } from "./types";

/** Bounded timeout for each per-request chrome read (LCD and API alike). */
export const CHROME_READ_TIMEOUT_MS = 4_000;

/**
 * Degraded-banner display threshold: how many blocks the indexed head may
 * trail the chain head before the chrome calls the data degraded (§8.0). The
 * §7 reconciler cadence is ~1 min; at Provenance's ~4 s block time, 30 blocks
 * is ~2 min, i.e. 2x the cadence, so one late cycle of jitter never flips the
 * banner. Display-only, honestly inert until the reconciler and API report
 * real heights; revisit then.
 */
export const DEGRADED_LAG_BLOCKS = 30;

/**
 * Max age of `/status.reconciled_at` before the chrome calls the data
 * degraded (a dead indexer freezes both heights, so lag alone never trips).
 * 10× the reconciler cadence; in-code, not env-tunable — widening a threshold
 * from the environment would silence the alarm.
 */
export const DEGRADED_STALE_SECONDS = 300;

/**
 * Incident kinds whose open incidents flip the chrome to "data degraded"
 * (§8.0: indexer lagging or reconciler alarm; kinds per the indexer's
 * incident schema).
 */
export const DEGRADED_INCIDENT_KINDS = ["reconciler_divergence", "indexer_lag"] as const;

// Boundary validation lives in ~/api/api.server (shared with the Learn
// loader): envelope + row schemas pinned to @nvhash/api-types with
// `satisfies`, and the bounded-timeout transport. A shape failure still
// degrades to the null paths above, never a guess.

/** `/status` inputs. Null as a whole = API unreachable; `reconciledAt: null`
 * inside = cold start or older API — neither is a stale claim. */
export interface ChromeStatusFacts {
  meta: FreshnessMeta;
  reconciledAt: string | null;
}

/** The live-plane facts the banner may claim (only from a successful read). */
export interface ChromeLiveFacts {
  paused: boolean;
  pausedReason: string;
  halted: boolean;
}

function isDegraded(
  status: ChromeStatusFacts | null,
  incidents: IncidentRow[] | null,
  nowMs: number,
): boolean {
  const freshness = status?.meta ?? null;
  const lagging =
    freshness !== null &&
    freshness.chain_height !== null &&
    freshness.indexed_height !== null &&
    freshness.chain_height - freshness.indexed_height > DEGRADED_LAG_BLOCKS;
  // Heads present but the data's age exceeds the threshold. Cold start
  // (null heads, null reconciled_at) is deliberately not degraded.
  const reconciledMs =
    status?.reconciledAt === null ? null : Date.parse(status?.reconciledAt ?? "");
  const stale =
    status !== null &&
    status.meta.indexed_height !== null &&
    reconciledMs !== null &&
    Number.isFinite(reconciledMs) &&
    nowMs - reconciledMs > DEGRADED_STALE_SECONDS * 1000;
  const openIncident =
    incidents?.some(
      (incident) =>
        (DEGRADED_INCIDENT_KINDS as readonly string[]).includes(incident.kind) &&
        (incident.closed_at ?? null) === null,
    ) ?? false;
  return lagging || stale || openIncident;
}

/**
 * Pure decision core over the loader's inputs. Precedence: halted > paused >
 * degraded; paused/halted require a successful live read; degraded is the
 * indexed plane's own claim.
 */
export function deriveChromeState(
  live: ChromeLiveFacts | null,
  status: ChromeStatusFacts | null,
  incidents: IncidentRow[] | null,
  nowMs: number,
): ChromeState {
  let banner: ChromeBanner | null = null;
  if (live?.halted) {
    banner = { kind: "halted" };
  } else if (live?.paused) {
    banner = { kind: "paused", reason: live.pausedReason };
  } else if (isDegraded(status, incidents, nowMs)) {
    banner = { kind: "degraded" };
  }
  return {
    banner,
    liveStatusOk: live !== null,
    freshness: status?.meta ?? null,
    reconciledAt: status?.reconciledAt ?? null,
  };
}

export interface ChromeReadOptions {
  /** Injectable transport for the MSW-free unit paths; defaults to fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Assemble the chrome's state for one request. Never throws: every failed
 * input degrades its own surface and only its own.
 */
export async function loadChromeState(
  config: WebConfig,
  options: ChromeReadOptions = {},
): Promise<ChromeState> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  const vault = new VaultClient(lcd);
  const apiBase = config.apiUrl.replace(/\/+$/, "");

  // All reads run concurrently; each rejection resolves to null (degraded
  // surface) rather than failing the page.
  const [live, status, incidents] = await Promise.all([
    Promise.all([vault.getVault(config.vaultAddress), contract.epochStatus()])
      .then(([vaultState, epochStatus]) => ({
        paused: vaultState.vault.paused,
        pausedReason: vaultState.vault.pausedReason,
        halted: epochStatus.halted,
      }))
      .catch((cause: unknown) => {
        console.warn(
          `[nvhash-web] chrome live reads failed; footer will say "program status unavailable" ` +
            `(${cause instanceof Error ? cause.message : String(cause)})`,
        );
        return null;
      }),
    fetchApiJson(`${apiBase}/api/v1/status`, fetchImpl, CHROME_READ_TIMEOUT_MS)
      .then((body): ChromeStatusFacts => {
        const parsed = statusEnvelopeSchema.parse(body);
        return { meta: parsed.meta, reconciledAt: parsed.data.reconciled_at ?? null };
      })
      .catch(() => null),
    fetchApiJson(`${apiBase}/api/v1/incidents`, fetchImpl, CHROME_READ_TIMEOUT_MS)
      .then((body) => incidentsEnvelopeSchema.parse(body).data)
      .catch(() => null),
  ]);

  return deriveChromeState(live, status, incidents, Date.now());
}
