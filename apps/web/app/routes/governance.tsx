import { Link } from "react-router";

import { PolicyPanel } from "~/components/governance/policy-panel";
import { ProposalList } from "~/components/governance/proposal-list";
import { VerifyLink } from "~/components/verify-link";
import { getBootedConfig } from "~/config/config.server";
import { loadGovernanceListData } from "~/governance/governance.server";
import { parseStatusParam, GOV_STATUS_FILTERS } from "~/governance/params";
import { STATUS_KEYS } from "~/governance/labels";
import { parsePageParam } from "~/portfolio/page-param";
import { getSessionContext } from "~/lib/services/session.server";
import { t } from "~/i18n";
import { useLocale } from "~/root";
import type { Route } from "./+types/governance";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Governance · nvHASH" }];
}

/**
 * The §8.7 governance center — PUBLIC READ (loader + gating only, per the
 * layering rule; the composition seam is `app/governance/governance.server.ts`).
 *
 * There is no session gate here and there must not be one: proposals and votes
 * are public chain facts with no address keying, so this route does NOT join
 * the personal-route list. The session address is read for ONE purpose — to
 * highlight the connected member's own row on the detail page — and an
 * anonymous visitor gets the identical page minus that highlight.
 *
 * `?status=` and `?page=` are bounded at this boundary and REJECTED when
 * malformed, never clamped (SECURITY.md).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const url = new URL(request.url);
  const status = parseStatusParam(url.searchParams.get("status"));
  const page = parsePageParam(url.searchParams.get("page"));
  const session = await getSessionContext(config, request);
  const data = await loadGovernanceListData(config, {
    status,
    page,
    sessionAddress: session?.address ?? null,
  });
  return { data };
}

export default function Governance({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { data } = loaderData;
  const open = data.proposals.filter((p) => p.status === "submitted");
  const history = data.proposals.filter((p) => p.status !== "submitted");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t(locale, "governance.title")}</h1>
        <VerifyLink locale={locale} target="governance" />
      </div>
      <p className="text-sm text-muted-foreground">{t(locale, "governance.lede")}</p>
      {/* Said once, plainly, rather than implied by the presence of buttons.
          The composer is member-gated at the route, not hidden here: hiding a
          nav target is a different lie from explaining who it is for (§8.0). */}
      <p className="text-sm text-muted-foreground">{t(locale, "governance.write-note")}</p>
      <p>
        <Link className="text-sm underline underline-offset-4" to="/governance/new">
          {t(locale, "governance.new-proposal")}
        </Link>
      </p>

      <PolicyPanel
        locale={locale}
        state={data.state}
        policies={data.policies}
        group={data.group}
        truncated={data.truncated}
      />

      {/* A failed mirror read is NOT an empty history, and the two must not
          render the same way (§12.1). */}
      {data.indexedAvailable ? null : (
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.proposals-unavailable")}
        </p>
      )}

      <nav aria-label={t(locale, "governance.filter-label")} className="flex flex-wrap gap-2">
        <FilterLink
          locale={locale}
          label={t(locale, "governance.filter-all")}
          to="/governance"
          active={data.statusFilter === null}
        />
        {GOV_STATUS_FILTERS.map((status) => (
          <FilterLink
            key={status}
            locale={locale}
            label={t(locale, STATUS_KEYS[status])}
            to={`/governance?status=${status}`}
            active={data.statusFilter === status}
          />
        ))}
      </nav>

      {/* Open above history: what can still be influenced, then what
          happened. Both sections render even when empty, so an empty "open" is
          a statement rather than a missing section. */}
      <ProposalList
        locale={locale}
        heading={t(locale, "governance.open-heading")}
        proposals={open}
        emptyMessage={t(locale, "governance.proposals-empty")}
      />
      <ProposalList
        locale={locale}
        heading={t(locale, "governance.history-heading")}
        proposals={history}
        emptyMessage={t(locale, "governance.proposals-empty")}
      />

      {/* The mirror's reach. x/group prunes, so a proposal closed before this
          height is unrecoverable and the list must never imply otherwise. */}
      <p className="text-xs text-muted-foreground">
        {data.indexedFromHeight === null
          ? t(locale, "governance.indexed-from-unknown")
          : t(locale, "governance.indexed-from", { height: data.indexedFromHeight })}
      </p>

      {data.page > 0 || data.hasMore ? (
        <nav
          aria-label={t(locale, "governance.page-position", { page: data.page + 1 })}
          className="flex gap-3 text-sm"
        >
          {data.page > 0 ? (
            <Link
              className="underline underline-offset-4"
              to={pageHref(data.statusFilter, data.page - 1)}
            >
              {t(locale, "governance.page-previous")}
            </Link>
          ) : null}
          <span className="text-muted-foreground">
            {t(locale, "governance.page-position", { page: data.page + 1 })}
          </span>
          {data.hasMore ? (
            <Link
              className="underline underline-offset-4"
              to={pageHref(data.statusFilter, data.page + 1)}
            >
              {t(locale, "governance.page-next")}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function pageHref(status: string | null, page: number): string {
  const params = new URLSearchParams();
  if (status !== null) params.set("status", status);
  if (page > 0) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? "/governance" : `/governance?${query}`;
}

function FilterLink({
  label,
  to,
  active,
}: {
  locale: string;
  label: string;
  to: string;
  active: boolean;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-md border bg-card px-3 py-1.5 text-sm font-semibold"
          : "rounded-md border px-3 py-1.5 text-sm text-muted-foreground"
      }
    >
      {label}
    </Link>
  );
}
