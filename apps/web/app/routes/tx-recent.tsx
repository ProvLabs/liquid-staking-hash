// GET /tx/recent (PR 5.2, §10.2 step 5): the indexer fast-poll reconcile
// source — the session address's indexed transactions, read from
// services/api with a freshly minted address-scoped assertion (ADR-001
// Decision 2; the minter's first production consumer). The browser never
// calls the API directly and never sees the assertion.

import { getBootedConfig } from "~/config/config.server";
import { fetchApiJson } from "~/api/api.server";
import { personalApiHeaders } from "~/lib/services/assertion.server";
import { requireSession } from "~/lib/services/session.server";
import type { Route } from "./+types/tx-recent";

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await requireSession(config, request);

  const headers = personalApiHeaders(config, session.address);
  if (headers === null) {
    // No minting key configured: degrade honestly — reconciliation reports
    // unavailable rather than pretending the history plane answered.
    return Response.json({ available: false, txhashes: [] });
  }

  try {
    const url = `${config.apiUrl}/api/v1/transactions?address=${encodeURIComponent(session.address)}`;
    const payload = (await fetchApiJson(
      url,
      (input, init) => fetch(input, { ...init, headers }),
      3_000,
    )) as { data?: Array<{ txhash?: string }> };
    const txhashes = (payload.data ?? [])
      .map((row) => row.txhash)
      .filter((h): h is string => typeof h === "string");
    return Response.json({ available: true, txhashes });
  } catch {
    return Response.json({ available: false, txhashes: [] });
  }
}
