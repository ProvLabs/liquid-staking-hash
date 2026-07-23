import { t } from "~/i18n";
import { getBootedConfig } from "~/config/config.server";
import { getSessionContext } from "~/lib/services/session.server";
import { useLocale } from "~/root";
import type { Route } from "./+types/portfolio";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Portfolio · nvHASH" }];
}

// Personal-route session scope (PR 5.1, the standing gate): the loader's
// acting address comes ONLY from the session — there is no query param to
// read another address, and an anonymous request renders the connect prompt
// (prompt-and-explain, never blank, never someone else's data). The real
// Portfolio page arrives in M6.1; this stub is already session-shaped.
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  return { address: session?.address ?? null };
}

export default function Portfolio({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "portfolio.title")}</h1>
      {loaderData.address === null ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.connect-prompt")}
        </p>
      ) : (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.connected-as", { address: loaderData.address })}
        </p>
      )}
    </section>
  );
}
