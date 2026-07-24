// GET /portfolio/export (M6.1 §2.7, app-spec §14.11): the session address's
// FULL transaction history streamed as CSV: a statement of fact, not a
// computed tax position. Session-gated (the standing session-scope gate): the
// acting address comes ONLY from requireSession, never a query param. The
// browser never talks to the API directly and never sees the assertion.

import { getBootedConfig } from "~/config/config.server";
import { exportTransactionsCsv } from "~/portfolio/portfolio.server";
import type { Route } from "./+types/portfolio-export";

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  return exportTransactionsCsv(config, request);
}
