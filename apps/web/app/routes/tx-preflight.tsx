// POST /tx/preflight (§10.2 step 2): session-scoped guard context.
// The acting address comes ONLY from the session (standing session-scope
// gate); the body carries just kind + amount, zod-bounded — reject, never
// clamp.

import { getBootedConfig } from "~/config/config.server";
import { requireSession } from "~/lib/services/session.server";
import {
  governancePreflightRequestSchema,
  operatorPreflightRequestSchema,
  preflightRequestSchema,
  runGovernancePreflight,
  runOperatorPreflight,
  runPreflight,
} from "~/tx/preflight.server";
import type { Route } from "./+types/tx-preflight";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  const payload: unknown = await request.json().catch(() => null);

  // Operator actions preflight through the same route and the same
  // session binding — a separate bounded schema, never a widened one.
  const operator = operatorPreflightRequestSchema.safeParse(payload);
  if (operator.success) {
    return Response.json(await runOperatorPreflight(config, session.address, operator.data));
  }
  // M7.3–7.4: the three governance actions, on the same terms.
  const governance = governancePreflightRequestSchema.safeParse(payload);
  if (governance.success) {
    return Response.json(await runGovernancePreflight(config, session.address, governance.data));
  }
  const swap = preflightRequestSchema.safeParse(payload);
  if (!swap.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  return Response.json(await runPreflight(config, session.address, swap.data));
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
