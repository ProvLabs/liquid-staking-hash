// $lang+ i18n routing (app-spec §8.0): every page lives under an optional
// locale segment — `/` serves the default locale, `/en/...` pins one, and an
// unsupported locale is a 404 (routes/locale.tsx). Paths in the spec omit the
// locale segment.
import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // Operational readiness probe (PR 1.5) — a static, locale-independent path,
  // declared before the `:lang?` segment so it is never parsed as a locale.
  route("healthz", "routes/healthz.tsx"),
  // Session resource routes (PR 5.1): locale-independent POST-only endpoints
  // for the nonce-signature login flow (app-spec §3 decision 5).
  route("session/nonce", "routes/session-nonce.tsx"),
  route("session/login", "routes/session-login.tsx"),
  route("session/logout", "routes/session-logout.tsx"),
  // Transaction lifecycle resource routes (PR 5.2, §10.2): all
  // session-gated; the browser never talks to the LCD or the API directly.
  route("tx/preflight", "routes/tx-preflight.tsx"),
  route("tx/simulate", "routes/tx-simulate.tsx"),
  route("tx/broadcast", "routes/tx-broadcast.tsx"),
  route("tx/status", "routes/tx-status.tsx"),
  route("tx/recent", "routes/tx-recent.tsx"),
  // Portfolio CSV export (M6.1 §2.7): a locale-independent, session-gated
  // resource route, declared outside `:lang?` like the session/tx routes.
  route("portfolio/export", "routes/portfolio-export.tsx"),
  // Alert resource routes (M6.2 §2.6): session-gated notification log +
  // mark-read and effective-settings CRUD, outside `:lang?` like the above.
  route("alerts/notifications", "routes/alerts-notifications.tsx"),
  route("alerts/rules", "routes/alerts-rules.tsx"),
  // Web Push subscription management (M6.3 §2.2): session-gated per-browser
  // opt-in/opt-out, outside `:lang?` like the alerts routes above.
  route("push/subscription", "routes/push-subscription.tsx"),
  // Operator payment CSV export (M6.4 §2.3, §14.11): session-gated, outside
  // `:lang?` like the portfolio export it follows.
  route("operator/export", "routes/operator-export.tsx"),
  route(":lang?", "routes/locale.tsx", [
    index("routes/home.tsx"),
    // §8.0 nav targets (plan 4.1): stubs until their real pages land in
    // 4.2–4.4 / M5 / M7, because the nav must never 404. New routes join the
    // axe scan route list (e2e/axe.spec.ts).
    route("stake", "routes/stake.tsx"),
    route("exit", "routes/exit.tsx"),
    route("portfolio", "routes/portfolio.tsx"),
    route("market", "routes/market.tsx"),
    route("validators", "routes/validators.tsx"),
    // Operator view (M6.4 §2.3, app-spec §8.6) — registered AFTER `validators`
    // so the public page keeps the bare path.
    route("validators/mine", "routes/validators-mine.tsx"),
    // Governance center (M7.2, app-spec §8.7). Public read; the detail route is
    // registered AFTER the list so the bare path stays the list.
    route("governance", "routes/governance.tsx"),
    route("governance/:proposalId", "routes/governance.$proposalId.tsx"),
  ]),
] satisfies RouteConfig;
