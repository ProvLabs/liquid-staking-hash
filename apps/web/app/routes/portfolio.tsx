import { t } from "~/i18n";
import { getBootedConfig } from "~/config/config.server";
import { formatBaseAmount, HASH_EXPONENT, SHARE_EXPONENT } from "~/learn/amounts";
import { getSessionContext } from "~/lib/services/session.server";
import { loadPortfolioPosition } from "~/portfolio/portfolio.server";
import { useLocale } from "~/root";
import type { Route } from "./+types/portfolio";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Portfolio · nvHASH" }];
}

// Personal-route session scope (PR 5.1, the standing gate): the loader's
// acting address comes ONLY from the session — there is no query param to
// read another address, and an anonymous request renders the connect prompt
// (prompt-and-explain, never blank, never someone else's data). 5.3 lands
// the stake flow here with a minimal live position strip (Q5); the full
// §8.2 Portfolio page (yield panel, accrual chart, CSV) is M6.1.
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  if (session === null) return { address: null, position: null };
  const position = await loadPortfolioPosition(config, session.address);
  return { address: session.address, position };
}

export default function Portfolio({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { address, position } = loaderData;

  if (address === null) {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "portfolio.title")}</h1>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.connect-prompt")}
        </p>
      </section>
    );
  }

  const hasShares = position?.shares !== null && position?.shares !== undefined && BigInt(position.shares) > 0n;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "portfolio.title")}</h1>

      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-medium text-muted-foreground">{t(locale, "portfolio.position-title")}</h2>
        {position === null || position.shares === null ? (
          <p className="text-sm text-muted-foreground">{t(locale, "portfolio.value-unavailable")}</p>
        ) : !hasShares ? (
          <p className="text-sm text-muted-foreground">{t(locale, "portfolio.no-position")}</p>
        ) : (
          <>
            <p className="font-mono text-2xl">
              {t(locale, "portfolio.balance", {
                shares: formatBaseAmount(BigInt(position.shares), SHARE_EXPONENT, 4),
              })}
            </p>
            {position.valueNhash !== null ? (
              <p className="text-sm text-muted-foreground">
                {t(locale, "portfolio.value-at-nav", {
                  value: formatBaseAmount(BigInt(position.valueNhash), HASH_EXPONENT, 4),
                })}
              </p>
            ) : null}
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t(locale, "portfolio.full-page-note")}</p>
    </section>
  );
}
