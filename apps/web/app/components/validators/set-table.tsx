import { t, type Locale, type MessageKey } from "~/i18n";
import { formatAgeSince } from "~/learn/duration";
import type { ValidatorRow } from "~/validators/types";

// §8.6 consumer table: "who is staking your HASH and are they reliable",
// never the console's operational view. Reliability status ships icon +
// label on the console-§11.2 family (color never carries state alone);
// precedence tombstoned > jailed > ineligible > eligible. Narrow viewports
// scroll the table inside its own container (axe-safe th semantics kept).

type Reliability = "eligible" | "ineligible" | "jailed" | "tombstoned";

const STATUS: Record<
  Reliability,
  { labelKey: MessageKey; token: string; iconPath: string }
> = {
  eligible: {
    labelKey: "validators.status-eligible",
    token: "var(--status-good)",
    // filled circle
    iconPath: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z",
  },
  ineligible: {
    labelKey: "validators.status-ineligible",
    token: "var(--status-serious)",
    // triangle
    iconPath: "M8 1.5 15 14H1L8 1.5Z",
  },
  jailed: {
    labelKey: "validators.status-jailed",
    token: "var(--status-serious)",
    // pause bars
    iconPath: "M4 2h3v12H4V2Zm5 0h3v12H9V2Z",
  },
  tombstoned: {
    labelKey: "validators.status-tombstoned",
    token: "var(--status-critical)",
    // octagon
    iconPath: "M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1L5.1 1Z",
  },
};

function reliabilityOf(row: ValidatorRow): Reliability {
  if (row.tombstoned) return "tombstoned";
  if (row.jailed) return "jailed";
  return row.eligible ? "eligible" : "ineligible";
}

function truncateValoper(valoper: string): string {
  return valoper.length <= 20 ? valoper : `${valoper.slice(0, 14)}…${valoper.slice(-4)}`;
}

export function SetTable({
  locale,
  rows,
  nowMs,
}: {
  locale: Locale;
  rows: ValidatorRow[] | null;
  nowMs: number;
}) {
  if (rows === null) {
    return (
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t(locale, "validators.table-unavailable")}
      </p>
    );
  }

  // A brand-new program legitimately has zero enrollments; say so rather
  // than rendering a headers-only table (PR #12 review).
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t(locale, "validators.table-empty")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t(locale, "validators.col-validator")}</th>
            <th className="px-3 py-2 font-medium">{t(locale, "validators.col-status")}</th>
            <th className="px-3 py-2 font-medium">{t(locale, "validators.col-uptime")}</th>
            <th className="px-3 py-2 font-medium">{t(locale, "validators.col-delegation")}</th>
            <th className="px-3 py-2 font-medium">{t(locale, "validators.col-tenure")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = STATUS[reliabilityOf(row)];
            return (
              <tr key={row.valoper} className="border-b last:border-b-0">
                <td className="px-3 py-2">
                  {row.moniker !== null ? (
                    <span className="font-medium">{row.moniker}</span>
                  ) : (
                    <span className="font-mono text-xs">{truncateValoper(row.valoper)}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <svg
                      aria-hidden="true"
                      focusable="false"
                      viewBox="0 0 16 16"
                      className="h-3 w-3 shrink-0"
                      style={{ fill: status.token }}
                    >
                      <path d={status.iconPath} />
                    </svg>
                    {t(locale, status.labelKey)}
                  </span>
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {row.uptimePercent !== null
                    ? t(locale, "validators.uptime-vs-threshold", {
                        uptime: row.uptimePercent,
                        threshold: row.thresholdPercent,
                      })
                    : t(locale, "validators.uptime-na")}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {row.programDelegation ?? t(locale, "validators.na")}
                </td>
                <td className="px-3 py-2">{formatAgeSince(row.enrolledAt, nowMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
