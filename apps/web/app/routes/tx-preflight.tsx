// POST /tx/preflight (PR 5.2, §10.2 step 2): session-scoped guard context.
// The acting address comes ONLY from the session (standing session-scope
// gate); the body carries just kind + amount, zod-bounded — reject, never
// clamp.

import { getBootedConfig } from "~/config/config.server";
import { requireSession } from "~/lib/services/session.server";
import { preflightRequestSchema, runPreflight } from "~/tx/preflight.server";
import type { Route } from "./+types/tx-preflight";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  let body;
  try {
    body = preflightRequestSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  return Response.json(await runPreflight(config, session.address, body));
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
