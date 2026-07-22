import { SetHealth } from "~/components/validators/set-health";
import { SetTable } from "~/components/validators/set-table";
import { getBootedConfig } from "~/config/config.server";
import { t } from "~/i18n";
import { useLocale } from "~/root";
import { loadValidatorsData } from "~/validators/validators.server";
import type { Route } from "./+types/validators";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Validators · nvHASH" }];
}

// The Validators public page (plan 4.3, app-spec §8.6 public view). Every
// figure degrades independently and honestly (validators.server.ts); the
// loader's clock rides along so SSR and hydration agree on tenure.
export async function loader() {
  const config = await getBootedConfig();
  return { data: await loadValidatorsData(config), nowMs: Date.now() };
}

export default function Validators({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { data, nowMs } = loaderData;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          {t(locale, "validators.title")}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(locale, "validators.lede")}
        </p>
      </section>
      <SetHealth
        locale={locale}
        eligibleCount={data.eligibleCount}
        setHealth={data.setHealth}
      />
      <SetTable locale={locale} rows={data.rows} nowMs={nowMs} />
    </div>
  );
}
