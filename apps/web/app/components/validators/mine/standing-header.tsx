import type { OperatorStandingVM } from "~/validators/mine-types";
import { t, type Locale } from "~/i18n";
import { VerifyLink } from "~/components/verify-link";

// §8.6 standing header: moniker, eligibility, uptime against the configured
// threshold with its signed headroom, jailed/tombstoned state, and any open
// jail report with the instant a purge becomes allowed. Every figure is "n/a"
// when null, never 0 (§12.1) — an unmeasured uptime is not 0%.

function Field({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {caption !== undefined ? (
        <span className="text-xs text-muted-foreground">{caption}</span>
      ) : null}
    </div>
  );
}

export function StandingHeader({
  locale,
  standing,
}: {
  locale: Locale;
  standing: OperatorStandingVM;
}) {
  const na = t(locale, "operator.na");
  const eligibility =
    standing.eligible === null
      ? na
      : t(locale, standing.eligible ? "operator.eligible-yes" : "operator.eligible-no");

  return (
    <section aria-label={t(locale, "operator.standing-title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">
          {standing.moniker ?? t(locale, "operator.unnamed-validator")}
        </h2>
        <VerifyLink locale={locale} target="validators" />
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">{standing.valoper}</p>

      {standing.jailed ? (
        <p
          role="status"
          className="rounded-lg border p-3 text-sm"
          style={{ borderLeft: "4px solid var(--status-critical)" }}
        >
          <strong className="font-semibold">{t(locale, "operator.jailed-label")}</strong>{" "}
          <span className="text-muted-foreground">{t(locale, "operator.jailed-consequence")}</span>
        </p>
      ) : null}

      {standing.tombstoned ? (
        <p
          role="status"
          className="rounded-lg border p-3 text-sm"
          style={{ borderLeft: "4px solid var(--status-critical)" }}
        >
          <strong className="font-semibold">{t(locale, "operator.tombstoned-label")}</strong>{" "}
          <span className="text-muted-foreground">
            {t(locale, "operator.tombstoned-consequence")}
          </span>
        </p>
      ) : null}

      {standing.jailReport !== null ? (
        <p
          role="status"
          className="rounded-lg border p-3 text-sm"
          style={{ borderLeft: "4px solid var(--status-serious)" }}
        >
          <strong className="font-semibold">{t(locale, "operator.jail-report-label")}</strong>{" "}
          <span className="text-muted-foreground">
            {t(locale, "operator.jail-report-consequence", {
              purgeReadyAt: standing.jailReport.purgeReadyAt,
            })}
          </span>
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label={t(locale, "operator.eligibility-label")}
          value={eligibility}
          caption={
            standing.failingReasons.length > 0
              ? t(locale, "operator.failing-reasons", {
                  reasons: standing.failingReasons.join(", "),
                })
              : t(locale, "operator.eligibility-caption")
          }
        />
        <Field
          label={t(locale, "operator.uptime-label")}
          value={standing.uptimePercent ?? na}
          caption={
            standing.thresholdPercent === null
              ? t(locale, "operator.uptime-caption")
              : t(locale, "operator.uptime-threshold", { threshold: standing.thresholdPercent })
          }
        />
        <Field
          label={t(locale, "operator.headroom-uptime-label")}
          value={standing.uptimeHeadroomPercent ?? na}
          caption={t(locale, "operator.headroom-uptime-caption")}
        />
        <Field
          label={t(locale, "operator.headroom-label")}
          value={standing.headroomHash ?? na}
          caption={t(locale, "operator.headroom-caption")}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t(locale, "operator.tip-epoch-label")}
          value={standing.tipEpochHash ?? na}
          caption={t(locale, "operator.tip-epoch-caption")}
        />
        <Field
          label={t(locale, "operator.enrolled-label")}
          value={standing.enrolledAt === "" ? na : standing.enrolledAt.slice(0, 10)}
          caption={t(
            locale,
            standing.active ? "operator.enrolled-caption" : "operator.unregistered-caption",
          )}
        />
      </div>
    </section>
  );
}
