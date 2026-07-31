// POST/DELETE /push/subscription: per-browser Web Push
// subscription management. Session-gated (the standing session-scope gate):
// the acting address AND the deletion-chain session id come ONLY from the
// session (requireSession + the HttpOnly cookie), never a body field. The body
// carries only the opaque W3C subscription triple, zod-bounded at entry.
// Registered OUTSIDE the `:lang?` segment (the alerts-* / portfolio-export
// precedent).
//
//   * POST   — opt-in: upsert the subscription for this session (replace-by-
//              session, per-address capped).
//   * DELETE — opt-out: remove this session's subscription(s).
//   * GET/other — 405 (no read surface; subscriptions are write-only tokens).

import { getBootedConfig } from "~/config/config.server";
import { requireSession, sessionIdFromCookieHeader } from "~/lib/services/session.server";
import {
  deleteSubscriptionsForSession,
  pushSubscriptionBodySchema,
  saveSubscription,
} from "~/push/push.server";
import type { Route } from "./+types/push-subscription";

export async function loader({ request }: Route.LoaderArgs) {
  // requireSession first: anonymous is 401 regardless of method. There is no
  // GET surface — a subscription is a write-only token, never read back.
  const config = await getBootedConfig();
  await requireSession(config, request);
  return Response.json({ error: "method not allowed" }, { status: 405 });
}

export async function action({ request }: Route.ActionArgs) {
  const config = await getBootedConfig();
  // 401 before any method dispatch — an anonymous DELETE is a 401, not a 405.
  const session = await requireSession(config, request);
  // requireSession passed, so the cookie carries a well-formed session id.
  const sessionId = sessionIdFromCookieHeader(request.headers.get("Cookie"));
  if (sessionId === null) {
    return Response.json({ error: "session required" }, { status: 401 });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = pushSubscriptionBodySchema.parse(await request.json());
    } catch {
      return Response.json({ error: "invalid subscription" }, { status: 400 });
    }
    await saveSubscription(config, session.address, sessionId, body);
    return Response.json({ ok: true });
  }

  if (request.method === "DELETE") {
    const deleted = await deleteSubscriptionsForSession(config, sessionId);
    return Response.json({ deleted });
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
}
