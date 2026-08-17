import { t, type Locale } from "~/i18n";
import type { Completeness } from "~/api/completeness";
import { formatAgeSince } from "~/learn/duration";
import type { MarketSampleView } from "~/market/types";

// §8.5 pool depth, rendered only when a sample exists, carrying the same
// venue + sample-time label as every market figure. No verify link (§12.1
// rule 4). `completeness` renders the honesty state of the band set:
// "partial" says the producer trimmed it (never an unlabeled prefix),
// "unknown" (older API, no flag) withholds the completeness claim. Gated by
// test/market-data.test.ts.
export function Depth({
  locale,
  sample,
  completeness,
  nowMs,
}: {
  locale: Locale;
  sample: MarketSampleView;
  completeness: Completeness;
  nowMs: number;
}) {
  if (sample.depth.length === 0) return null;
  return (
    <section aria-label={t(locale, "market.depth-title")} className="flex flex-col gap-2">
      <h3 className="text-base font-medium">{t(locale, "market.depth-title")}</h3>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t(locale, "market.depth-col-side")}</th>
              <th className="px-3 py-2 font-medium">{t(locale, "market.depth-col-slippage")}</th>
              <th className="px-3 py-2 font-medium">{t(locale, "market.depth-col-size")}</th>
            </tr>
          </thead>
          <tbody>
            {sample.depth.map((band, index) => (
              <tr key={index} className="border-b last:border-b-0">
                <td className="px-3 py-2">
                  {band.side === "buy"
                    ? t(locale, "market.depth-side-buy")
                    : t(locale, "market.depth-side-sell")}
                </td>
                <td className="px-3 py-2 tabular-nums">{band.slippageBps}</td>
                <td className="px-3 py-2 tabular-nums">{band.sizeNvhash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {completeness === "partial" ? (
        <p className="text-xs text-muted-foreground">{t(locale, "market.depth-partial")}</p>
      ) : completeness === "unknown" ? (
        <p className="text-xs text-muted-foreground">
          {t(locale, "market.depth-completeness-unknown")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t(locale, "market.sample-label", {
          venue: sample.venue,
          age: formatAgeSince(sample.sampledAt, nowMs),
        })}
      </p>
    </section>
  );
}
