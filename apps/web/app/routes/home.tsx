import { t } from "~/i18n";
import { useLocale } from "~/root";
import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [{ title: "nvHASH" }];
}

// Scaffold landing page (plan PR 1.3). The real Learn page is PR 4.2; this
// renders honestly as a scaffold — it claims no program state it cannot show.
export default function Home() {
  const locale = useLocale();
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "home.title")}</h1>
      <p className="text-lg text-muted-foreground">{t(locale, "home.lede")}</p>
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t(locale, "home.scaffold-note")}
      </p>
    </section>
  );
}
