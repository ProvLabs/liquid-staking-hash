import { t } from "~/i18n";
import { useLocale } from "~/root";
import type { Route } from "./+types/governance";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Governance · nvHASH" }];
}

// Route stub (plan 4.1: the nav must never 404). The real Governance page is
// M7; this renders honestly as a scaffold.
export default function Governance() {
  const locale = useLocale();
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "governance.title")}</h1>
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t(locale, "governance.placeholder")}
      </p>
    </section>
  );
}
