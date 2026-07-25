// GET/POST /alerts/notifications (plan 6.2 §2.6): the session address's
// in-app notifications and mark-read. Session-gated (the standing
// session-scope gate): the acting address comes ONLY from requireSession,
// never a query param. Registered OUTSIDE the `:lang?` segment (the
// portfolio-export / tx-* precedent).

import { getBootedConfig } from "~/config/config.server";
import { requireSession } from "~/lib/services/session.server";
import {
  loadNotifications,
  markNotificationsRead,
  markReadBodySchema,
  notificationsPageSchema,
} from "~/alerts/alerts.server";
import type { Route } from "./+types/alerts-notifications";

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  const raw = new URL(request.url).searchParams.get("page") ?? "0";
  const parsed = notificationsPageSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid page" }, { status: 400 });
  }
  return Response.json(await loadNotifications(config, session.address, parsed.data));
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  let body;
  try {
    body = markReadBodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  return Response.json(await markNotificationsRead(config, session.address, body));
}
