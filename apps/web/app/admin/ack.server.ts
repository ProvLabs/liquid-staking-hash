// The incident-acknowledgment write path (app-spec §8.8, §9.6; ADR-001
// Decision 1). The ONE write behind `/admin`, and it writes only to `app`.
//
// THE ORDER OF CHECKS IS THE DESIGN, and each step exists for a reason the next
// one cannot cover:
//
//   1. SESSION. The acting address is the session address, never a
//      client-supplied actor — the standing session-scope gate. A body field
//      naming who acknowledged would be forgeable, so there is no such field.
//   2. FRESH ADMIN MEMBERSHIP. `adminApiHeaders` re-reads group membership on
//      chain, bypassing the 60 s role cache; a degraded read grants nothing
//      (invariant 2). Being logged in is not being an admin.
//   3. BOUNDED INPUT. The incident id and the optional note are zod-bounded at
//      entry — rejected, never clamped (SECURITY.md).
//   4. THE INCIDENT EXISTS. The id is validated against a LIVE READ of the
//      admin incident feed. There is no cross-schema foreign key to lean on
//      (ADR-001 Decision 1 forbids one), so this read is what stops an
//      acknowledgment row referring to an incident that never existed.
//   5. THE DATABASE DECIDES THE RACE. A duplicate live ack is refused by the
//      partial unique index and surfaces as 409 — never by an application-level
//      "already acked?" read followed by a write (plan §4b C3).

import { z } from "zod";

import { adminIncidentsEnvelopeSchema, fetchApiJson } from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import {
  AckConflict,
  getIncidentAckStore,
  MAX_ACK_NOTE_LENGTH,
} from "~/lib/models/incident-acks.server";
import { adminApiHeaders } from "~/lib/services/admin-auth.server";
import { INCIDENT_PAGE_SIZE } from "./admin.server";

/**
 * `POST /admin/incidents/ack` body.
 *
 * There is deliberately NO actor field: the acknowledging address comes from
 * the session and nowhere else. `incident_id` is a number because the wire
 * carries `AdminIncidentRow.id` as one, already guarded into the safe-integer
 * domain by the API's height/id guard.
 */
export const ackBodySchema = z.object({
  incident_id: z.number().int().nonnegative(),
  action: z.enum(["acknowledge", "unacknowledge"]),
  // Bounded at BOTH ends: rejected here rather than truncated, with the column
  // as the backstop. Absent and empty are the same thing — an empty note is
  // not a note.
  note: z.string().max(MAX_ACK_NOTE_LENGTH).optional(),
});

export type AckBody = z.infer<typeof ackBodySchema>;

export type AckResult =
  | { readonly ok: true; readonly acknowledged: boolean }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 403 | 404 | 409 | 503;
      readonly error: string;
    };

export interface AckDeps {
  fetchImpl?: typeof fetch;
  now?: Date;
}

/**
 * Apply an acknowledgment or its reversal for `sessionAddress`.
 *
 * Returns a typed result rather than throwing, so the route renders each
 * outcome as its own status without a catch-all 500 swallowing the difference
 * between "not an admin" and "we could not check".
 */
export async function applyIncidentAck(
  config: WebConfig,
  sessionAddress: string,
  body: AckBody,
  deps: AckDeps = {},
): Promise<AckResult> {
  const minted = await adminApiHeaders(config, sessionAddress);
  if (!minted.ok) {
    // Three distinct denials, three distinct answers. Collapsing "we could not
    // check" into "you are not an admin" would state a fact we do not have.
    if (minted.reason === "degraded") {
      return { ok: false, status: 503, error: "membership-unknown" };
    }
    if (minted.reason === "unconfigured") {
      return { ok: false, status: 503, error: "admin-unavailable" };
    }
    return { ok: false, status: 403, error: "not-admin" };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const apiBase = config.apiUrl.replace(/\/+$/, "");
  let known: Set<number>;
  try {
    const envelope = adminIncidentsEnvelopeSchema.parse(
      await fetchApiJson(
        `${apiBase}/api/v1/admin/incidents?limit=${INCIDENT_PAGE_SIZE}`,
        (url, init) => doFetch(url, { ...init, headers: minted.headers }),
        CHROME_READ_TIMEOUT_MS,
      ),
    );
    known = new Set(envelope.data.map((row) => row.id));
  } catch {
    // Without the live read we cannot establish the incident exists, and
    // writing anyway would be trusting the client's id. 503, not 404: the
    // incident may well be real.
    return { ok: false, status: 503, error: "incident-read-failed" };
  }
  if (!known.has(body.incident_id)) {
    return { ok: false, status: 404, error: "unknown-incident" };
  }

  const store = await getIncidentAckStore(config);
  const now = deps.now ?? new Date();
  if (body.action === "unacknowledge") {
    // Scoped to the session address inside the store, so this can never reverse
    // another admin's acknowledgment however the id was supplied.
    const reversed = await store.unacknowledge(body.incident_id, sessionAddress, now);
    if (reversed === null) return { ok: false, status: 404, error: "no-live-ack" };
    return { ok: true, acknowledged: false };
  }

  const note = body.note !== undefined && body.note.trim() !== "" ? body.note : null;
  try {
    await store.acknowledge(body.incident_id, sessionAddress, note, now);
    return { ok: true, acknowledged: true };
  } catch (error) {
    // The constraint, not a pre-check, is what answers the race.
    if (error instanceof AckConflict) return { ok: false, status: 409, error: "already-acked" };
    throw error;
  }
}
