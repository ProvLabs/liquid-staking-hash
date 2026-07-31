import { useState } from "react";

import { Button } from "~/components/ui/button";
import { t, type Locale } from "~/i18n";
import { applyTheme, nextTheme, type Theme } from "~/theme/theme";

/**
 * Cycles Auto → Light → Dark. SSR paints the cookie's theme; this control
 * updates the attribute live and persists the cookie for the next request.
 */
export function ThemeToggle({ locale, initialTheme }: { locale: Locale; initialTheme: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const label = {
    auto: t(locale, "theme.auto"),
    light: t(locale, "theme.light"),
    dark: t(locale, "theme.dark"),
  }[theme];

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={t(locale, "theme.toggle-label")}
      onClick={() => {
        const next = nextTheme(theme);
        setTheme(next);
        applyTheme(next);
      }}
    >
      {t(locale, "theme.toggle-label")}: {label}
    </Button>
  );
}
