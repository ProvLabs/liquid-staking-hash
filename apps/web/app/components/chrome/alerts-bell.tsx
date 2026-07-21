import { t, type Locale } from "~/i18n";

// §8.0: anonymous users see the alerting feature advertised, not the bell.
// No wallet exists until M5, so this PR ships exactly the advert affordance;
// M6 replaces it with the real bell for connected addresses.
export function AlertsBell({ locale }: { locale: Locale }) {
  return (
    <span className="hidden text-xs text-muted-foreground sm:inline">
      {t(locale, "chrome.alerts-advert")}
    </span>
  );
}
