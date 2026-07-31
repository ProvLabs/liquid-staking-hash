import { Link, useParams } from "react-router";

import { t, type Locale } from "~/i18n";

// §8.1.7 CTA. Honest about the milestone: wallet flows are M5, so this
// routes to the Stake page (today a stub that says so) rather than
// pretending a connect flow exists. Funnel counters (§14.10) are not built,
// deliberately absent here.
export function Cta({ locale }: { locale: Locale }) {
  const { lang } = useParams();
  const prefix = lang ? `/${lang}` : "";
  return (
    <section className="flex flex-col items-start gap-2 rounded-lg border bg-card p-6">
      <h2 className="text-xl font-semibold">{t(locale, "learn.cta-title")}</h2>
      <p className="text-sm text-muted-foreground">{t(locale, "learn.cta-body")}</p>
      <Link
        to={`${prefix}/stake`}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        {t(locale, "learn.cta-link")}
      </Link>
    </section>
  );
}
