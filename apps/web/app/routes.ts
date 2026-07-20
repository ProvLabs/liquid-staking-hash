// $lang+ i18n routing (app-spec §8.0): every page lives under an optional
// locale segment — `/` serves the default locale, `/en/...` pins one, and an
// unsupported locale is a 404 (routes/locale.tsx). Paths in the spec omit the
// locale segment.
import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // Operational readiness probe (PR 1.5) — a static, locale-independent path,
  // declared before the `:lang?` segment so it is never parsed as a locale.
  route("healthz", "routes/healthz.tsx"),
  route(":lang?", "routes/locale.tsx", [index("routes/home.tsx")]),
] satisfies RouteConfig;
