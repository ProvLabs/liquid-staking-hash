import { t, type Locale } from "~/i18n";
import { formatAgeSince } from "~/learn/duration";
import type { MarketData } from "~/market/types";

// §8.5 market price section: three honest states (§12.1, §13 decision 4):
// unavailable (/market unreachable), forthcoming (the real v1 shell: a live
// envelope with no sample), and an active sample. Every rendered market
// figure carries its venue + sample-time label, and NOTHING here carries a
// verify link — market data is the one plane with no chain-canonical version
// (§12.1 rule 4), asserted by e2e.
export function MarketStatus({
  locale,
  market,
  nowMs,
}: {
  locale: Locale;
  market: MarketData["market"];
  nowMs: number;
}) {
  return (
    <section aria-label={t(locale, "market.status-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "market.status-title")}</h2>
      {market === null ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "market.status-unavailable")}
        </p>
      ) : market.sample === null ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "market.status-forthcoming")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
              <span className="text-xs text-muted-foreground">
                {t(locale, "market.price-label")}
              </span>
              <span className="text-2xl font-semibold tabular-nums">{market.sample.priceHash}</span>
              <span className="text-xs text-muted-foreground">
                {t(locale, "market.price-caption")}
              </span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
              <span className="text-xs text-muted-foreground">
                {t(locale, "market.premium-label")}
              </span>
              <span className="text-2xl font-semibold tabular-nums">
                {market.sample.premiumPercent !== null
                  ? `${market.sample.premiumPercent}%`
                  : t(locale, "market.premium-na")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(locale, "market.premium-caption")}
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(locale, "market.sample-label", {
              venue: market.sample.venue,
              age: formatAgeSince(market.sample.sampledAt, nowMs),
            })}
          </p>
        </div>
      )}
    </section>
  );
}
