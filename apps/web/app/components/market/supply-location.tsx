import { t, type Locale } from "~/i18n";
import { formatAgeSince } from "~/learn/duration";
import type { BridgedRowView } from "~/market/types";

// §8.5 supply location (PR 3.2's amendment): LOCAL supply is a live chain
// read composed here by the web tier; the API serves only the bridged side.
// Bridged rows carry chain + sample time; the empty state is the honest v1
// truth, not a placeholder.
export function SupplyLocation({
  locale,
  localSupply,
  bridged,
  nowMs,
}: {
  locale: Locale;
  localSupply: string | null;
  bridged: BridgedRowView[];
  nowMs: number;
}) {
  const na = t(locale, "learn.stat-na");
  return (
    <section aria-label={t(locale, "market.supply-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "market.supply-title")}</h2>
      <div className="flex flex-col gap-1 self-start rounded-lg border bg-card p-4">
        <span className="text-xs text-muted-foreground">{t(locale, "market.supply-local")}</span>
        <span className="text-2xl font-semibold tabular-nums">{localSupply ?? na}</span>
        <span className="text-xs text-muted-foreground">
          {t(locale, "market.supply-local-caption")}
        </span>
      </div>
      {bridged.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "market.supply-bridged-empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t(locale, "market.supply-col-chain")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "market.supply-col-supply")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "market.supply-col-sampled")}</th>
              </tr>
            </thead>
            <tbody>
              {bridged.map((row) => (
                <tr key={row.chain} className="border-b last:border-b-0">
                  <td className="px-3 py-2">{row.chain}</td>
                  <td className="px-3 py-2 tabular-nums">{row.supplyNvhash}</td>
                  <td className="px-3 py-2">{formatAgeSince(row.sampledAt, nowMs)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
