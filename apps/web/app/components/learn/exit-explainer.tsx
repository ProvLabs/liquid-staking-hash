import { t, type Locale } from "~/i18n";

// §8.1.6 exit explainer, previewing the §8.4 guaranteed-vs-typical framing
// because "can I get out?" is a pre-deposit question. Honest about v1: no
// bridged nvHASH DEX exists, so the market path is described, not linked.
export function ExitExplainer({ locale }: { locale: Locale }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "learn.exit-title")}</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-base font-medium">{t(locale, "learn.exit-native-title")}</h3>
          <p className="pt-1 text-sm text-muted-foreground">
            {t(locale, "learn.exit-native-body")}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-base font-medium">{t(locale, "learn.exit-dex-title")}</h3>
          <p className="pt-1 text-sm text-muted-foreground">{t(locale, "learn.exit-dex-body")}</p>
        </div>
      </div>
    </section>
  );
}
