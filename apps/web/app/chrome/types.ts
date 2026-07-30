// Chrome state (app-spec §8.0, §12.1): assembled server-side per
// request (app/chrome/chrome.server.ts) and crossed to the client as root
// loader data. Everything here is public chain data plus the public status
// endpoint. It is NOT config, and the §7 client-safe allowlist is untouched.

import type { FreshnessMeta } from "@nvhash/api-types";

/**
 * The banner slot's states (§8.0). Precedence when several are true:
 * halted > paused > degraded: a stopped program outranks a paused vault,
 * which outranks stale history.
 */
export type ChromeBanner =
  | { kind: "paused"; reason: string }
  | { kind: "halted" }
  | { kind: "degraded" };

export interface ChromeState {
  /** Non-null only when a true program state backs it (§12.1). */
  banner: ChromeBanner | null;
  /**
   * False when the live reads (vault get + epoch_status) failed this request.
   * A failed read is not health: the footer says "program status unavailable"
   * and the banner slot never renders an implicit all-clear it cannot back.
   */
  liveStatusOk: boolean;
  /** `/api/v1/status` freshness meta; null when the API was unreachable. */
  freshness: FreshnessMeta | null;
}
