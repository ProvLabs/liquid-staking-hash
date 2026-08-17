import { t, type Locale, type MessageKey } from "~/i18n";
import type { Completeness } from "~/api/completeness";
import type { RedemptionVM } from "~/portfolio/types";

// §8.2 active redemptions: self-contained status rows from the
// 3.3 PortfolioSummary. Status ships icon + label (never color alone,
// console-§11.2 family). No link to /exit until 5.4 ships that tracker; a
// recorded deferral note stands in. The VM carries no maturity estimate yet,
// so no countdown is fabricated.
//
// `completeness` renders the honesty state of the SET: "partial" says the
// producer trimmed to the newest N (never an unlabeled prefix), "unknown"
// (older API, no flag) withholds the completeness claim. Gated by
// test/portfolio-data.test.ts.

const STATUS: Record<
  RedemptionVM["status"],
  { labelKey: MessageKey; token: string; iconPath: string }
> = {
  enqueued: {
    labelKey: "portfolio.redemption-status-enqueued",
    token: "var(--status-warning)",
    // pause bars
    iconPath: "M4 2h3v12H4V2Zm5 0h3v12H9V2Z",
  },
  expedited: {
    labelKey: "portfolio.redemption-status-expedited",
    token: "var(--status-good)",
    // filled circle
    iconPath: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z",
  },
  matured: {
    labelKey: "portfolio.redemption-status-matured",
    token: "var(--status-good)",
    // filled circle
    iconPath: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z",
  },
  refunded: {
    labelKey: "portfolio.redemption-status-refunded",
    token: "var(--status-serious)",
    // triangle
    iconPath: "M8 1.5 15 14H1L8 1.5Z",
  },
};

function dateOf(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : iso;
}

export function ActiveRedemptions({
  locale,
  redemptions,
  completeness,
}: {
  locale: Locale;
  redemptions: RedemptionVM[];
  completeness: Completeness;
}) {
  return (
    <section aria-label={t(locale, "portfolio.redemptions-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "portfolio.redemptions-title")}</h2>
      {completeness === "partial" ? (
        <p className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
          {t(locale, "portfolio.redemptions-partial", { count: String(redemptions.length) })}
        </p>
      ) : completeness === "unknown" && redemptions.length > 0 ? (
        <p className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
          {t(locale, "portfolio.redemptions-completeness-unknown")}
        </p>
      ) : null}
      {redemptions.length === 0 ? (
        // An unknown-completeness empty set must not claim "none exist".
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(
            locale,
            completeness === "unknown"
              ? "portfolio.redemptions-completeness-unknown"
              : "portfolio.redemptions-empty",
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {redemptions.map((r) => {
            const status = STATUS[r.status];
            // Literal keys per branch so the i18n coverage test can check the
            // {time} param statically at each call site.
            const settledLabel =
              r.statusTimestamps.refundedAt !== null
                ? t(locale, "portfolio.redemption-refunded-at", {
                    time: dateOf(r.statusTimestamps.refundedAt),
                  })
                : r.statusTimestamps.maturedAt !== null
                  ? t(locale, "portfolio.redemption-matured-at", {
                      time: dateOf(r.statusTimestamps.maturedAt),
                    })
                  : r.statusTimestamps.expeditedAt !== null
                    ? t(locale, "portfolio.redemption-expedited-at", {
                        time: dateOf(r.statusTimestamps.expeditedAt),
                      })
                    : null;
            return (
              <li
                key={r.requestId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-4"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-medium tabular-nums">
                    {t(locale, "portfolio.redemption-shares", { shares: r.sharesDisplay })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(locale, "portfolio.redemption-enqueued-at", { time: dateOf(r.enqueuedAt) })}
                    {settledLabel !== null ? ` · ${settledLabel}` : ""}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1.5 text-sm">
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
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {t(locale, "portfolio.redemptions-tracker-note")}
      </p>
    </section>
  );
}
