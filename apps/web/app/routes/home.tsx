import { Cta } from "~/components/learn/cta";
import { ExitExplainer } from "~/components/learn/exit-explainer";
import { Hero } from "~/components/learn/hero";
import { IncidentHistory } from "~/components/learn/incident-history";
import { NavStepChart } from "~/components/learn/nav-step-chart";
import { ProofStrip } from "~/components/learn/proof-strip";
import { TrustPosture } from "~/components/learn/trust-posture";
import { YieldSources } from "~/components/learn/yield-sources";
import { getBootedConfig } from "~/config/config.server";
import { loadLearnData } from "~/learn/learn.server";
import { recordFunnelEvent } from "~/lib/models/funnel-counters.server";
import { useLocale } from "~/root";
import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [{ title: "nvHASH" }];
}

// The Learn page (app-spec §8.1): the Evaluator's due-diligence
// funnel. Every figure degrades independently and honestly (learn.server.ts);
// the loader's clock rides along so SSR and hydration agree on ages.
export async function loader() {
  const config = await getBootedConfig();
  // §14.10 funnel counter, SERVER-SIDE and fire-and-forget. No client script,
  // no beacon, no cookie, no identifier — the call carries a closed stage and
  // page class and has no parameter through which anything else could arrive.
  // Not awaited: a counter must never add latency to a page, and it must never
  // fail one (invariant 9).
  recordFunnelEvent(config, { stage: "visit", pageClass: "learn_index" });
  return { learn: await loadLearnData(config), nowMs: Date.now() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { learn, nowMs } = loaderData;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-12">
      <Hero locale={locale} />
      <ProofStrip locale={locale} data={learn} nowMs={nowMs} />
      <NavStepChart locale={locale} epochs={learn.epochs} />
      <YieldSources locale={locale} live={learn.live} />
      <TrustPosture locale={locale} />
      <IncidentHistory locale={locale} incidents={learn.incidents} />
      <ExitExplainer locale={locale} />
      <Cta locale={locale} />
    </div>
  );
}
