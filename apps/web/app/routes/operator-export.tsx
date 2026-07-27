// GET /operator/export?valoper= (M6.4 §2.3, app-spec §14.11): the session
// operator's FULL commission/TIP payment history streamed as CSV — a statement
// of fact for their own tax analysis. Session-gated (the standing session-scope
// gate): the acting address comes ONLY from requireSession. `valoper` selects
// among that operator's own validators and services/api enforces the ownership,
// so it cannot reach another operator's history. The browser never talks to the
// API and never sees the assertion.

import { getBootedConfig } from "~/config/config.server";
import { exportOperatorPaymentsCsv } from "~/validators/mine.server";
import type { Route } from "./+types/operator-export";

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  return exportOperatorPaymentsCsv(config, request);
}
