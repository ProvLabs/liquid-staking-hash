// POST /session/nonce: mint an address-bound single-use login
// challenge. Locale-independent resource route (the healthz precedent).
// Input is zod-bounded at the boundary; a malformed body is a 400, never a
// best-effort continue (SECURITY.md).

import { z } from "zod";

import { getBootedConfig } from "~/config/config.server";
import { bech32AddressSchema, mintNonce } from "~/lib/services/session.server";
import type { Route } from "./+types/session-nonce";

const bodySchema = z.object({ address: bech32AddressSchema });

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const { nonce, challenge, expiresInSeconds } = await mintNonce(config, parsed.address);
  return Response.json({ nonce, challenge, expires_in_seconds: expiresInSeconds });
}

// Resource route: GET has nothing to serve.
export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
