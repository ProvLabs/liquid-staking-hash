import { useRevalidator } from "react-router";

import { FunnelPanel } from "~/components/admin/funnel-panel";
import { HolderCohort } from "~/components/admin/holder-cohort";
import { IncidentFeed } from "~/components/admin/incident-feed";
import { ProgramHealth } from "~/components/admin/program-health";
import { UpkeepTimeliness } from "~/components/admin/upkeep-timeliness";
import { ValidatorCohort } from "~/components/admin/validator-cohort";
import { getBootedConfig } from "~/config/config.server";
import { t } from "~/i18n";
import { adminApiHeaders } from "~/lib/services/admin-auth.server";
import { getSessionContext } from "~/lib/services/session.server";
import { loadAdminViewData } from "~/admin/admin.server";
import { useLocale } from "~/root";
import type { Route } from "./+types/admin";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Admin analytics · nvHASH" }];
}

/**
 * Four honest states before any panel loads (plan invariant 17):
 *   anonymous       → the connect prompt, never blank and never a guess
 *   membership-unknown → the explicit "we could not check" state. NOT a denial:
 *                     a failed chain read is not evidence that the visitor is
 *                     not an admin, and saying so would state a fact we do not
 *                     have (SECURITY.md: never lie about state)
 *   not-admin       → the plain "this address is not a program administrator"
 *   unconfigured    → no assertion key, so no admin read is possible at all
 *
 * The GATE IS THE MINT, not this loader's branching. `adminApiHeaders` performs
 * a FRESH on-chain group-membership read that bypasses the 60 s role cache
 * (ADR-001 Decision 2, amendment 2026-07-28), and `services/api` independently
 * refuses any request without a valid `admin:` scope. Deleting the branches
 * below would make the page ugly, not insecure.
 *
 * Deliberately NOT a 404 for a non-admin. The route's existence is not a
 * secret — the gate is a capability gate, not a safety gate — and a 404 would
 * make a real permissions problem indistinguishable from a typo.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  if (session === null) return { state: "anonymous" } as const;

  const minted = await adminApiHeaders(config, session.address);
  if (!minted.ok) {
    return { state: minted.reason === "not-admin" ? "not-admin" : minted.reason } as const;
  }

  const data = await loadAdminViewData(config, { address: session.address }, minted.headers);
  return { state: "admin", data } as const;
}

export default function Admin({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const revalidator = useRevalidator();

  if (loaderData.state !== "admin") {
    const message =
      loaderData.state === "anonymous"
        ? "admin.connect-prompt"
        : loaderData.state === "not-admin"
          ? "admin.not-admin"
          : loaderData.state === "degraded"
            ? "admin.membership-unknown"
            : "admin.unconfigured";
    return (
      <Shell title={t(locale, "admin.title")}>
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, message)}
        </p>
      </Shell>
    );
  }

  const { data } = loaderData;
  return (
    <Shell title={t(locale, "admin.title")}>
      <p className="text-sm text-muted-foreground">
        {t(locale, "admin.viewing-address", { address: data.address })}
      </p>
      {/* The freshness line, surfaced rather than assumed: a stale indexed read
          is visibly stale instead of being presented as current (C5). */}
      {data.freshness === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t(locale, "admin.freshness", {
            height:
              data.freshness.indexed_height === null
                ? t(locale, "admin.panel-na")
                : String(data.freshness.indexed_height),
            at: data.freshness.generated_at.slice(0, 19).replace("T", " "),
          })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t(locale, "admin.derivable-note")}</p>

      <ProgramHealth locale={locale} state={data.programHealth} />
      <HolderCohort locale={locale} state={data.holderCohorts} />
      <ValidatorCohort locale={locale} state={data.validatorCohorts} />
      <FunnelPanel locale={locale} state={data.funnel} />
      <UpkeepTimeliness locale={locale} upkeep={data.upkeep} />
      <IncidentFeed
        locale={locale}
        state={data.incidents}
        // Re-run the loader after a write so the feed reflects the ack rather
        // than optimistically pretending — the acknowledgment state must come
        // from the database that just adjudicated the race, not from the click.
        onChanged={() => revalidator.revalidate()}
      />
      <p className="text-xs text-muted-foreground">{t(locale, "admin.support-out-of-scope")}</p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
