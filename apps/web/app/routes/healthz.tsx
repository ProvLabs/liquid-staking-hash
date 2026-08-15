import { getBootedConfig } from "~/config/config.server";

// This server bundle's load time. Under the compose `web` command (build →
// start in one container run) it is strictly after the build that produced
// the bundle, which is what lets the stale-bundle gate
// (e2e-live/drills/stale-bundle.spec.ts) prove a green live run certifies the
// code it ran against: a `started_at` predating the run's prepared-at means a
// stale bundle is serving (web-design-notes "Live e2e re-run trap").
const STARTED_AT = new Date().toISOString();

// Operational readiness probe (full-stack wiring; reused by the
// Deploy configs). Resource route — no UI, so it sits OUTSIDE the `$lang+`
// i18n tree and takes no locale segment. Its loader awaits the same boot checks
// the server gates startup on (console chain-id match + vault-address
// cross-check against the contract's Config {}, app-spec §7/§12.2), so a 200
// means this web tier is correctly wired to its configured chain, and a 503
// means it is not — never a silent pass.
export async function loader() {
  try {
    await getBootedConfig();
  } catch {
    // getBootedConfig already logged the specific failure at boot; keep the
    // probe body terse and non-leaky (no config values in the response).
    return new Response(JSON.stringify({ status: "unhealthy", started_at: STARTED_AT }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ status: "ok", started_at: STARTED_AT }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
