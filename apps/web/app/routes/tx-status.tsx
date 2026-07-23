// GET /tx/status?hash= (PR 5.2, §10.2 step 5): inclusion polling through
// the web tier (the browser never talks to the LCD). Session-gated so the
// route is not an open chain proxy; the hash is zod-bounded.

import { z } from "zod";

import { LcdClient, TxClient } from "@nvhash/chain-client";
import { getBootedConfig } from "~/config/config.server";
import { requireSession } from "~/lib/services/session.server";
import type { Route } from "./+types/tx-status";

const hashSchema = z.string().regex(/^[0-9A-Fa-f]{64}$/);

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  await requireSession(config, request);
  const raw = new URL(request.url).searchParams.get("hash") ?? "";
  const hash = hashSchema.safeParse(raw);
  if (!hash.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const tx = new TxClient(new LcdClient(config.lcdUrl));
  const inclusion = await tx.getTx(hash.data);
  if (inclusion === null) {
    return Response.json({ included: false });
  }
  return Response.json({
    included: true,
    height: inclusion.height.toString(),
    code: inclusion.code,
    raw_log: inclusion.rawLog,
    timestamp: inclusion.timestamp,
  });
}
