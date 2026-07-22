// ChromeState assembly (plan 4.1 §2; app-spec §8.0, §12.1). Runs in the root
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
import {
  LcdClient,
  NvhashContractClient,
  VaultClient,
  type FetchLike,
} from "@nvhash/chain-client";

import {
  fetchApiJson,
  incidentsEnvelopeSchema,
  statusEnvelopeSchema,
} from "~/api/api.server";
import type { WebConfig } from "~/config/config.server";
import type { ChromeBanner, ChromeState } from "./types";

/** Bounded timeout for each per-request chrome read (LCD and API alike). */
export const CHROME_READ_TIMEOUT_MS = 4_000;

/**
 * Degraded-banner display threshold: how many blocks the indexed head may
 * trail the chain head before the chrome calls the data degraded (§8.0). The
 * §7 reconciler cadence is ~1 min; at Provenance's ~4 s block time, 30 blocks
 * is ~2 min, i.e. 2x the cadence, so one late cycle of jitter never flips the
 * banner (PR 4.1 review). Display-only, honestly inert until M2.5/M3 report
 * real heights; revisit then.
 */
export const DEGRADED_LAG_BLOCKS = 30;

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

function isDegraded(freshness: FreshnessMeta | null, incidents: IncidentRow[] | null): boolean {
  const lagging =
    freshness !== null &&
    freshness.chain_height !== null &&
    freshness.indexed_height !== null &&
    freshness.chain_height - freshness.indexed_height > DEGRADED_LAG_BLOCKS;
  const openIncident =
    incidents !== null &&
    incidents.some(
      (incident) =>
        (DEGRADED_INCIDENT_KINDS as readonly string[]).includes(incident.kind) &&
        (incident.closed_at ?? null) === null,
    );
  return lagging || openIncident;
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
  const [live, freshness, incidents] = await Promise.all([
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
      .then((body) => statusEnvelopeSchema.parse(body).meta)
      .catch(() => null),
    fetchApiJson(`${apiBase}/api/v1/incidents`, fetchImpl, CHROME_READ_TIMEOUT_MS)
      .then((body) => incidentsEnvelopeSchema.parse(body).data)
      .catch(() => null),
  ]);

  // Precedence: halted > paused > degraded. Paused/halted require a
  // successful live read; degraded is the indexed plane's own claim and does
  // not need (or assert) live health.
  let banner: ChromeBanner | null = null;
  if (live?.halted) {
    banner = { kind: "halted" };
  } else if (live?.paused) {
    banner = { kind: "paused", reason: live.pausedReason };
  } else if (isDegraded(freshness, incidents)) {
    banner = { kind: "degraded" };
  }

  return { banner, liveStatusOk: live !== null, freshness };
}
