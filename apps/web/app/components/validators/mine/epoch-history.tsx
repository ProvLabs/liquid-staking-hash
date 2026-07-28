import type { OperatorEpochRowVM } from "~/validators/mine-types";
import { t, type Locale } from "~/i18n";

// §8.6 per-epoch history — "the history the console cannot show". Commission
// accrued/paid/due are CUMULATIVE lifetime totals at each epoch, while TIP is
// the per-epoch credit that resets at every rollover; the column captions say
// so, because the two columns look alike and mean different things.

export function EpochHistory({
  locale,
  epochs,
  truncated,
}: {
  locale: Locale;
  epochs: OperatorEpochRowVM[];
  truncated: boolean;
}) {
  return (
    <section aria-label={t(locale, "operator.epochs-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "operator.epochs-title")}</h2>
      <p className="text-xs text-muted-foreground">{t(locale, "operator.epochs-caption")}</p>

      {epochs.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.epochs-empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <caption className="sr-only">{t(locale, "operator.epochs-title")}</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.epoch-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.uptime-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.eligible-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.delegation-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.tip-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.accrued-header")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t(locale, "operator.due-header")}
                </th>
              </tr>
            </thead>
            <tbody>
              {epochs.map((row) => (
                <tr key={row.epochIndex} className="border-b last:border-0">
                  <td className="py-2 pr-4 tabular-nums">{row.epochIndex}</td>
                  <td className="py-2 pr-4 tabular-nums">{row.uptimePercent}</td>
                  <td className="py-2 pr-4">
                    {t(locale, row.eligible ? "operator.eligible-yes" : "operator.eligible-no")}
                    {row.failingReasons.length > 0 ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {row.failingReasons.join(", ")}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{row.programDelegationHash}</td>
                  <td className="py-2 pr-4 tabular-nums">{row.tipHash}</td>
                  <td className="py-2 pr-4 tabular-nums">{row.commissionAccruedHash}</td>
                  <td className="py-2 tabular-nums">{row.commissionDueHash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {truncated ? (
        <p className="text-xs text-muted-foreground">{t(locale, "operator.history-truncated")}</p>
      ) : null}
    </section>
  );
}
