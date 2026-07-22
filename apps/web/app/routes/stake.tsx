import { t } from "~/i18n";
import { useLocale } from "~/root";
import type { Route } from "./+types/stake";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Stake · nvHASH" }];
}

// Route stub (plan 4.1: the nav must never 404). The real Stake flow is M5;
// this renders honestly as a scaffold, claiming no capability it lacks.
export default function Stake() {
  const locale = useLocale();
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "stake.title")}</h1>
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t(locale, "stake.placeholder")}
      </p>
    </section>
  );
}
