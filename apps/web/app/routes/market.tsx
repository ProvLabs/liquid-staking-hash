import { Depth } from "~/components/market/depth";
import { History } from "~/components/market/history";
import { MarketStatus } from "~/components/market/market-status";
import { PremiumExplainer } from "~/components/market/premium-explainer";
import { SupplyLocation } from "~/components/market/supply-location";
import { getBootedConfig } from "~/config/config.server";
import { t } from "~/i18n";
import { recordFunnelEvent } from "~/lib/models/funnel-counters.server";
import { loadMarketData } from "~/market/market.server";
import { useLocale } from "~/root";
import type { Route } from "./+types/market";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Market · nvHASH" }];
}

// The Market page (app-spec §8.5): the labeled v1 shell over the
// real 3.2 contract, plus the real-data program history views. Every figure
// degrades independently (market.server.ts); the loader's clock rides along
// so SSR and hydration agree on sample ages.
export async function loader() {
  const config = await getBootedConfig();
  // Page class + the due-diligence stage, as on /validators.
  recordFunnelEvent(config, { stage: "visit", pageClass: "market" });
  recordFunnelEvent(config, { stage: "due_diligence_depth" });
  return { data: await loadMarketData(config), nowMs: Date.now() };
}

export default function Market({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { data, nowMs } = loaderData;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "market.title")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t(locale, "market.lede")}</p>
      </section>
      <MarketStatus locale={locale} market={data.market} nowMs={nowMs} />
      <PremiumExplainer locale={locale} />
      {data.market?.sample ? (
        <Depth locale={locale} sample={data.market.sample} nowMs={nowMs} />
      ) : null}
      <SupplyLocation
        locale={locale}
        localSupply={data.localSupply}
        bridged={data.market?.bridged ?? []}
        nowMs={nowMs}
      />
      <History locale={locale} epochs={data.epochs} />
    </div>
  );
}
