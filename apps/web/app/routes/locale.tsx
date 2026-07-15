import { Outlet } from "react-router";

import { resolveLocale } from "~/i18n";
import type { Route } from "./+types/locale";

// Locale gate: the `:lang?` param is validated at the boundary — absent means
// the default locale, anything unsupported is a 404, never a silent fallback.
export function loader({ params }: Route.LoaderArgs) {
  const locale = resolveLocale(params.lang);
  if (locale === null) {
    throw new Response("Not Found", { status: 404 });
  }
  return { locale };
}

export default function LocaleLayout() {
  return <Outlet />;
}
