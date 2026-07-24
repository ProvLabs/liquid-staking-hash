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
    route("governance", "routes/governance.tsx"),
  ]),
] satisfies RouteConfig;
