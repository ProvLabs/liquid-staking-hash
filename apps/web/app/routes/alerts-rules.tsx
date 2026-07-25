// GET/POST /alerts/rules (plan 6.2 §2.6): the session address's effective
// alert settings (closed kind list × effective enabled × is-default) and rule
// upsert. Session-gated (the standing gate): the acting address is the session
// address only. `is_operator` rides the GET so the settings UI can show the
// operator-only kind — a live role read (§4), UI convenience only; the
// notifier's server-side operator filter is the mechanism.

import { getBootedConfig } from "~/config/config.server";
import { requireSession } from "~/lib/services/session.server";
import { detectRoles } from "~/lib/services/roles.server";
import { loadEffectiveSettings, ruleUpsertBodySchema, setAlertRule } from "~/alerts/alerts.server";
import type { Route } from "./+types/alerts-rules";

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  const [settings, roles] = await Promise.all([
    loadEffectiveSettings(config, session.address),
    detectRoles(config, session.address),
  ]);
  return Response.json({ settings, is_operator: roles.operator });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const config = await getBootedConfig();
  const session = await requireSession(config, request);
  let body;
  try {
    body = ruleUpsertBodySchema.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const settings = await setAlertRule(config, session.address, body.kind, body.enabled);
  return Response.json({ settings });
}
