import type { NetBenefitVM } from "~/validators/mine-types";
import { t, type Locale } from "~/i18n";

// §8.6 net-benefit-after-fees — the personas §7 question ("is participating
// worth it?"). Every term is shown separately so the arithmetic is inspectable
// rather than asserted.
//
// The earnings term is an ESTIMATE and says so in its own label, not only in a
// footnote (§7 Q2, DECIDED 2026-07-27; §12.1 requires estimated values be
// labeled as such). The two paid terms are EXACT indexed facts. When the
// estimate is unavailable the net is "n/a" — a net computed from a missing
// term would be a fabrication, and a fabricated net is exactly the figure an
// operator would act on.

export function NetBenefitPanel({
  locale,
  netBenefit,
}: {
  locale: Locale;
  netBenefit: NetBenefitVM;
}) {
  const na = t(locale, "operator.na");
  const estimated = netBenefit.estimatedEarningsHash;

  return (
    <section aria-label={t(locale, "operator.net-benefit-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "operator.net-benefit-title")}</h2>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
          <dt className="text-xs text-muted-foreground">
            {t(locale, "operator.earnings-label")}
          </dt>
          <dd className="text-lg font-semibold tabular-nums">{estimated ?? na}</dd>
          <dd className="text-xs text-muted-foreground">{t(locale, "operator.earnings-estimate")}</dd>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
          <dt className="text-xs text-muted-foreground">
            {t(locale, "operator.commission-total-label")}
          </dt>
          <dd className="text-lg font-semibold tabular-nums">
            {netBenefit.commissionPaidTotalHash}
          </dd>
          <dd className="text-xs text-muted-foreground">{t(locale, "operator.exact-fact")}</dd>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
          <dt className="text-xs text-muted-foreground">{t(locale, "operator.tip-total-label")}</dt>
          <dd className="text-lg font-semibold tabular-nums">{netBenefit.tipPaidTotalHash}</dd>
          <dd className="text-xs text-muted-foreground">{t(locale, "operator.exact-fact")}</dd>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
          <dt className="text-xs text-muted-foreground">{t(locale, "operator.net-label")}</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {netBenefit.netBenefitHash ?? na}
          </dd>
          <dd className="text-xs text-muted-foreground">{t(locale, "operator.net-caption")}</dd>
        </div>
      </dl>

      <p className="text-xs text-muted-foreground">
        {estimated === null
          ? t(locale, "operator.earnings-unavailable")
          : t(locale, "operator.earnings-derivation", {
              rate: netBenefit.commissionRatePercent ?? na,
              epochs: String(netBenefit.epochsCovered),
            })}
      </p>
      {netBenefit.truncated ? (
        <p className="text-xs text-muted-foreground">{t(locale, "operator.history-truncated")}</p>
      ) : null}
    </section>
  );
}
