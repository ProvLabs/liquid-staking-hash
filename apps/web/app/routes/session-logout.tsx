// POST /session/logout (plan 5.1 §3): destroy the server-side session row
// (logout everywhere — the row IS the session) and clear the cookie.
// Idempotent: logging out an already-dead session is still a 200 with a
// cleared cookie.

import { getBootedConfig } from "~/config/config.server";
import { logout } from "~/lib/services/session.server";
import type { Route } from "./+types/session-logout";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const { setCookie } = await logout(config, request);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": setCookie } });
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
