// POST /session/login: verify the ADR-36-signed challenge and
// establish the session. Every failure — unknown nonce, replayed nonce,
// expired nonce, address mismatch, bad signature, pubkey/address mismatch —
// is ONE undifferentiated 401 (the services/api auth.ts precedent: an
// attacker learns nothing about which check failed). Success sets the
// HttpOnly opaque-id cookie (test/session.test.ts gates the flags).

import { getBootedConfig } from "~/config/config.server";
import { login, loginBodySchema } from "~/lib/services/session.server";
import type { Route } from "./+types/session-login";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  let body;
  try {
    body = loginBodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const result = await login(config, body);
  if (!result.ok) {
    return Response.json({ error: "login failed" }, { status: 401 });
  }
  return Response.json(
    { address: result.address },
    { headers: { "Set-Cookie": result.setCookie } },
  );
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
