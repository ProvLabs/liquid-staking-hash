// POST /tx/broadcast (PR 5.2, §12.3 amendment): the guarded signed-tx
// relay. Guard order and verdicts live in app/tx/broadcast.server.ts (each
// with a case in test/broadcast-guard.test.ts); this route contributes the
// session requirement (401) and the body bound.

import { z } from "zod";

import { getBootedConfig } from "~/config/config.server";
import { requireSession } from "~/lib/services/session.server";
import { guardSignedTx, relayBroadcast, SIZE_CAP_BYTES } from "~/tx/broadcast.server";
import type { Route } from "./+types/tx-broadcast";

const bodySchema = z.object({
  // base64 of TxRaw; cap sized to the decoded cap (4/3 expansion + padding).
  tx_raw: z
    .string()
    .max(Math.ceil((SIZE_CAP_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const txRawBytes = Uint8Array.from(Buffer.from(body.tx_raw, "base64"));

  // Async as of M7.3–7.4: `MsgSubmitProposal`'s condition 3 verifies the group
  // policy against the DISCOVERED policy set, which is a live read. It happens
  // only for a tx that carries a submission.
  const verdict = await guardSignedTx(config, session.address, txRawBytes);
  if (!verdict.ok) {
    return Response.json({ error: verdict.reason }, { status: verdict.status });
  }

  try {
    const result = await relayBroadcast(config, txRawBytes);
    return Response.json({
      txhash: result.txhash,
      code: result.code,
      raw_log: result.rawLog,
    });
  } catch (error) {
    // The chain refused at CheckTx (or the LCD failed): an honest failure —
    // no retry loop here; the user decides (SECURITY.md: never lie).
    return Response.json(
      { error: "broadcast failed", detail: error instanceof Error ? error.message : "unknown" },
      { status: 502 },
    );
  }
}

export async function loader(_: Route.LoaderArgs) {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
