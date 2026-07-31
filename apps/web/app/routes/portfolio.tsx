import { AccrualChart } from "~/components/portfolio/accrual-chart";
import { ActiveRedemptions } from "~/components/portfolio/active-redemptions";
import { AlertSettings } from "~/components/portfolio/alert-settings";
import { EffectiveYieldPanel } from "~/components/portfolio/effective-yield-panel";
import { HistoryTable } from "~/components/portfolio/history-table";
import { PositionSummary } from "~/components/portfolio/position-summary";
import { getBootedConfig } from "~/config/config.server";
import { t } from "~/i18n";
import { parsePageParam } from "~/portfolio/page-param";
import { loadPortfolioData } from "~/portfolio/portfolio.server";
import { getSessionContext } from "~/lib/services/session.server";
import { useLocale } from "~/root";
import type { Route } from "./+types/portfolio";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Portfolio · nvHASH" }];
}

// Personal-route session scope (standing gate): the acting address
// comes ONLY from the session (there is no query param to read another
// address), and an anonymous request renders the connect prompt (never blank,
// never someone else's data). The page loads its data only for a real session.
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  if (session === null) return { data: null } as const;

  const page = parsePageParam(new URL(request.url).searchParams.get("page"));
  const data = await loadPortfolioData(config, { address: session.address }, page);
  return { data } as const;
}

export default function Portfolio({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { data } = loaderData;

  if (data === null) {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "portfolio.title")}</h1>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.connect-prompt")}
        </p>
      </section>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "portfolio.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(locale, "portfolio.viewing-address", { address: data.address })}
        </p>
      </section>

      <PositionSummary locale={locale} summary={data.summary} />

      {data.personalReadsAvailable ? (
        <>
          <EffectiveYieldPanel
            locale={locale}
            effectiveAprBps={data.effectiveAprBps}
            yieldByEpoch={data.yieldByEpoch}
            yieldTruncated={data.yieldTruncated}
          />
          <AccrualChart locale={locale} accrual={data.accrual} />
          <ActiveRedemptions locale={locale} redemptions={data.activeRedemptions} />
          {data.history !== null ? <HistoryTable locale={locale} history={data.history} /> : null}
        </>
      ) : (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.indexed-unavailable")}
        </p>
      )}

      {/* Alert settings (M6.2) — independent of the indexed plane, so it renders
          for any session even when the indexed reads degrade. */}
      <AlertSettings locale={locale} />
    </div>
  );
}
