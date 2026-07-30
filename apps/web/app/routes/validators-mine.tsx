import { useState } from "react";

import { CommissionBanner } from "~/components/validators/mine/commission-banner";
import { DelegationChart } from "~/components/validators/mine/delegation-chart";
import { EpochHistory } from "~/components/validators/mine/epoch-history";
import { NetBenefitPanel } from "~/components/validators/mine/net-benefit-panel";
import { OperatorFlows } from "~/components/validators/mine/operator-flows";
import { PaymentHistory } from "~/components/validators/mine/payment-history";
import { StandingHeader } from "~/components/validators/mine/standing-header";
import { getBootedConfig } from "~/config/config.server";
import { isValoperAddress } from "~/lib/bech32";
import { t, type Locale } from "~/i18n";
import { detectRoles } from "~/lib/services/roles.server";
import { getSessionContext } from "~/lib/services/session.server";
import { loadOperatorViewData } from "~/validators/mine.server";
import { useLocale } from "~/root";
import type { Route } from "./+types/validators-mine";

export function meta(_: Route.MetaArgs) {
  return [{ title: "My validator · nvHASH" }];
}

// `?valoper=` is shape-bounded at this route boundary (SECURITY.md). It selects
// among the operator's OWN validators; services/api enforces ownership against
// the asserted address regardless, so this is a shape bound, not the control.

/**
 * Three honest states before any data loads:
 *   anonymous            → the connect prompt (never blank, never a guess)
 *   roles degraded       → an explicit "we could not check" note; the App never
 *                          renders a privileged surface from a failed read
 *   connected non-operator → the plain "this address does not operate a program
 *                          validator" state, WITH the enroll entry (§14.6): an
 *                          operator becomes one by enrolling, so this state is
 *                          a starting point, not a dead end.
 *
 * The acting address comes ONLY from the session (the standing session-scope
 * gate); `?valoper=` selects among the operator's own validators and is
 * shape-bounded here — a malformed value is dropped, never forwarded.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  if (session === null) return { state: "anonymous" } as const;

  const roles = await detectRoles(config, session.address);
  if (roles.degraded) return { state: "degraded" } as const;
  if (!roles.operator) {
    return { state: "not-operator", contractAddress: config.contractAddress } as const;
  }

  const raw = new URL(request.url).searchParams.get("valoper");
  const valoper = raw !== null && isValoperAddress(raw) ? raw : null;
  const data = await loadOperatorViewData(config, { address: session.address }, { valoper });
  // The contract address is client-safe config (§7 allowlist); the client needs
  // it to build the plan for the confirm disclosure. The relay's deep guard
  // re-checks it against config server-side regardless (§2.5 condition 1).
  return { state: "operator", data, contractAddress: config.contractAddress } as const;
}

export default function ValidatorsMine({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();

  if (loaderData.state === "anonymous") {
    return (
      <Shell title={t(locale, "operator.title")}>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.connect-prompt")}
        </p>
      </Shell>
    );
  }

  if (loaderData.state === "degraded") {
    return (
      <Shell title={t(locale, "operator.title")}>
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.roles-degraded")}
        </p>
      </Shell>
    );
  }

  if (loaderData.state === "not-operator") {
    return (
      <Shell title={t(locale, "operator.title")}>
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.not-operator")}
        </p>
        <p className="text-sm text-muted-foreground">{t(locale, "operator.enroll-hint")}</p>
        <NotOperatorEnroll locale={locale} contractAddress={loaderData.contractAddress} />
      </Shell>
    );
  }

  const { data, contractAddress } = loaderData;
  const activeValopers = data.owned.filter((v) => v.active).map((v) => v.valoper);

  return (
    <Shell title={t(locale, "operator.title")}>
      <p className="text-sm text-muted-foreground">
        {t(locale, "operator.viewing-address", { address: data.address })}
      </p>

      {data.owned.length === 0 ? (
        // The live role read said "operator" but the registry knows no valoper
        // for this address — a real state (enrolled this block, or the indexed
        // plane is behind), and one we state rather than paper over.
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.no-validators")}
        </p>
      ) : (
        <>
          {data.owned.length > 1 ? (
            <nav aria-label={t(locale, "operator.switch-validator")} className="flex flex-wrap gap-2">
              {data.owned.map((v) => (
                <a
                  key={v.valoper}
                  href={`?valoper=${encodeURIComponent(v.valoper)}`}
                  aria-current={v.valoper === data.selectedValoper ? "page" : undefined}
                  className={
                    v.valoper === data.selectedValoper
                      ? "rounded-md border bg-card px-3 py-1.5 text-sm font-semibold"
                      : "rounded-md border px-3 py-1.5 text-sm text-muted-foreground"
                  }
                >
                  {v.moniker ?? v.valoper.slice(0, 16)}
                  {/* An unregistered validator is kept for its history, so the
                      switcher must not present it as an enrolled one (§12.1). */}
                  {v.active ? null : (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      ({t(locale, "operator.unregistered-badge")})
                    </span>
                  )}
                </a>
              ))}
            </nav>
          ) : null}

          {data.standing !== null ? (
            <>
              <CommissionBanner locale={locale} standing={data.standing} />
              <StandingHeader locale={locale} standing={data.standing} />
            </>
          ) : null}

          {/* Actions render independently of the INDEXED plane: an operator
              must be able to clear arrears even when history is unavailable.
              But they are scoped to a validator that is STILL ENROLLED:
              an unregistered validator is kept in the list so its
              history stays reachable, and every program action except
              re-enrolling would be rejected by the contract for it. Offering
              them would be a UI that invites a transaction guaranteed to fail.
              `ownedValopers` seeds the purge claimant, which must itself be an
              enrolled validator, so it carries ACTIVE valopers only. */}
          {data.selectedValoper !== null ? (
            data.selectedActive ? (
              <OperatorFlows
                locale={locale}
                valoper={data.selectedValoper}
                contractAddress={contractAddress}
                ownedValopers={activeValopers}
              />
            ) : (
              <>
                <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                  {t(locale, "operator.inactive-validator")}
                </p>
                <OperatorFlows
                  locale={locale}
                  valoper={data.selectedValoper}
                  contractAddress={contractAddress}
                  ownedValopers={activeValopers}
                  only={["register_participation"]}
                />
              </>
            )
          ) : null}

          {data.personalReadsAvailable ? (
            <>
              {data.netBenefit !== null ? (
                <NetBenefitPanel locale={locale} netBenefit={data.netBenefit} />
              ) : null}
              <DelegationChart locale={locale} history={data.delegationHistory} />
              {data.selectedValoper !== null ? (
                <PaymentHistory
                  locale={locale}
                  payments={data.payments}
                  hasMore={data.paymentsHasMore}
                  valoper={data.selectedValoper}
                />
              ) : null}
              <EpochHistory locale={locale} epochs={data.epochs} truncated={data.epochsTruncated} />
            </>
          ) : (
            <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              {t(locale, "operator.indexed-unavailable")}
            </p>
          )}
        </>
      )}
    </Shell>
  );
}

/**
 * The enroll entry on the non-operator state (§14.6). The valoper is typed in
 * and shape-bounded here; the CONTRACT enforces that the signer is that
 * validator's operator account, so this is an affordance, never a claim of
 * authority — and preflight says so in advance when it is not.
 */
function NotOperatorEnroll({
  locale,
  contractAddress,
}: {
  locale: Locale;
  contractAddress: string;
}) {
  const [valoper, setValoper] = useState("");
  const trimmed = valoper.trim();
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span>{t(locale, "operator.enroll-valoper-label")}</span>
        <input
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
          value={valoper}
          onChange={(event) => setValoper(event.target.value)}
          placeholder="tpvaloper1…"
        />
      </label>
      {isValoperAddress(trimmed) ? (
        <OperatorFlows
          locale={locale}
          valoper={trimmed}
          contractAddress={contractAddress}
          ownedValopers={[]}
          only={["register_participation"]}
        />
      ) : null}
    </div>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
