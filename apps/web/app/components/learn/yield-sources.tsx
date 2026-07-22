import { t, type Locale } from "~/i18n";
import type { LearnLive } from "~/learn/types";

// §8.1.3 yield decomposition in a lay register, with the honest note that
// validators fund commission and tips themselves (contract §10.1). The
// compare-to-self-staking panel is qualitative until indexed history can
// support a real baseline (plan 4.2 open question 4: never a fabricated
// number).
export function YieldSources({ locale, live }: { locale: Locale; live: LearnLive }) {
  const rows =
    live.yieldSources === null
      ? null
      : ([
          ["learn.yield-rewards", live.yieldSources.rewards],
          ["learn.yield-commission", live.yieldSources.commission],
          ["learn.yield-tips", live.yieldSources.tips],
          ["learn.yield-fee", live.yieldSources.aumFee],
        ] as const);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "learn.yield-title")}</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">{t(locale, "learn.yield-body")}</p>
      {rows === null ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "learn.yield-unavailable")}
        </p>
      ) : (
        <div className="rounded-lg border">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-sm md:grid-cols-4">
            {rows.map(([key, value]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{t(locale, key)}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {t(locale, "learn.yield-window-note")}
          </p>
        </div>
      )}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-base font-medium">{t(locale, "learn.compare-title")}</h3>
        <p className="pt-1 text-sm text-muted-foreground">{t(locale, "learn.compare-body")}</p>
      </div>
    </section>
  );
}
