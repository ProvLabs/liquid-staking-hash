// POST /admin/incidents/ack: acknowledge or reverse an incident
// acknowledgment (app-spec §8.8). A locale-independent, session-gated resource
// route outside `:lang?`, following the `alerts/rules` precedent.
//
// Everything load-bearing lives in `app/admin/ack.server.ts` — the session
// address as the sole actor, the FRESH admin membership read, the live incident
// check, and the database constraint that answers a concurrent double-ack. This
// file is the HTTP shell over it.

import { getBootedConfig } from "~/config/config.server";
import { ackBodySchema, applyIncidentAck } from "~/admin/ack.server";
import { requireSession } from "~/lib/services/session.server";
import type { Route } from "./+types/admin-incidents-ack";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  // 401 for an anonymous request (thrown by requireSession) — the resource-route
  // half of the standing session-scope gate.
  const session = await requireSession(config, request);

  let body;
  try {
    body = ackBodySchema.parse(await request.json());
  } catch {
    // Bounded at entry: an over-long note or an unknown action is rejected,
    // never clamped into something writable (SECURITY.md).
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const result = await applyIncidentAck(config, session.address, body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ acknowledged: result.acknowledged });
}
