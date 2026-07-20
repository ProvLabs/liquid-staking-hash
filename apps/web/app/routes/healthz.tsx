import { getBootedConfig } from "~/config/config.server";

// Operational readiness probe (app plan PR 1.5 full-stack wiring; reused by the
// M8 deploy configs). Resource route — no UI, so it sits OUTSIDE the `$lang+`
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
    return new Response(JSON.stringify({ status: "unhealthy" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
