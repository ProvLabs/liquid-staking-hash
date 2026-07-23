import { t, type Locale } from "~/i18n";

// §8.5 premium/discount explainer (§11: explanation is first-class). Renders
// in both the shell and active states: the education is the point, whether
// or not a market exists yet.
export function PremiumExplainer({ locale }: { locale: Locale }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <h3 className="text-base font-medium">{t(locale, "market.explainer-title")}</h3>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t(locale, "market.explainer-body")}
      </p>
    </section>
  );
}
