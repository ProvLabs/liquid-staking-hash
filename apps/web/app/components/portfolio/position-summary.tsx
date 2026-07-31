import type { ReactNode } from "react";

import type { PositionSummaryVM } from "~/portfolio/types";
import { t, type Locale, type MessageKey } from "~/i18n";

// §8.2 position summary (/§2.7): headline figures composed from the
// live and indexed planes. Every figure is n/a when null, never 0 (§12.1);
// the accrued gain carries an icon + sign word so state never rides color
// alone; the §2.7 divergence / history-state note and the §14.11 basis aid
// label are shown, never silently reconciled.

function StatCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: ReactNode;
  caption?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {caption !== undefined ? (
        <span className="text-xs text-muted-foreground">{caption}</span>
      ) : null}
    </div>
  );
}

/** Gain direction from a formatted HASH string: a genuine zero is neutral,
 * not an "up" (color never carries state alone; zero is neither gain nor loss). */
export function gainDirection(display: string): "up" | "down" | "flat" {
  if (/^-?0+(\.0+)?$/.test(display)) return "flat";
  return display.startsWith("-") ? "down" : "up";
}

/** Signed HASH gain with a direction icon + word (color never carries state alone). */
function GainValue({ locale, display }: { locale: Locale; display: string }) {
  const dir = gainDirection(display);
  const token =
    dir === "flat"
      ? "var(--color-muted-foreground)"
      : dir === "down"
        ? "var(--status-critical)"
        : "var(--status-good)";
  const word = t(
    locale,
    dir === "flat"
      ? "portfolio.gain-flat"
      : dir === "down"
        ? "portfolio.gain-down"
        : "portfolio.gain-up",
  );
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color: token }}>
      {dir === "flat" ? null : (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          className="h-4 w-4 shrink-0"
          style={{ fill: token }}
        >
          <path d={dir === "down" ? "M8 14 1 3h14L8 14Z" : "M8 2 15 13H1L8 2Z"} />
        </svg>
      )}
      <span className="tabular-nums">{display}</span>
      <span className="sr-only">{word}</span>
    </span>
  );
}

export function PositionSummary({
  locale,
  summary,
}: {
  locale: Locale;
  summary: PositionSummaryVM;
}) {
  const na = t(locale, "portfolio.na");
  const valueCaptionKey: MessageKey =
    summary.valuePlane === "indexed"
      ? "portfolio.value-caption-indexed"
      : "portfolio.value-caption-live";

  const inconsistent = summary.historyState === "inconsistent";
  const incomplete =
    !inconsistent &&
    (summary.divergent || (summary.historyState !== "complete" && summary.historyState !== null));

  return (
    <section aria-label={t(locale, "portfolio.summary-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "portfolio.summary-title")}</h2>

      {inconsistent ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.history-inconsistent")}
        </p>
      ) : incomplete ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.history-incomplete")}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={t(locale, "portfolio.balance-label")}
          value={summary.balanceHash ?? na}
          caption={t(locale, "portfolio.balance-caption")}
        />
        <StatCard
          label={t(locale, "portfolio.value-label")}
          value={summary.currentValueHash ?? na}
          caption={t(locale, valueCaptionKey)}
        />
        <StatCard
          label={t(locale, "portfolio.nav-label")}
          value={summary.currentNav ?? na}
          caption={t(locale, "portfolio.nav-caption")}
        />
        <StatCard
          label={t(locale, "portfolio.gain-label")}
          value={
            summary.accruedGainHash === null ? (
              na
            ) : (
              <GainValue locale={locale} display={summary.accruedGainHash} />
            )
          }
          caption={t(locale, "portfolio.gain-caption")}
        />
        <StatCard
          label={t(locale, "portfolio.basis-label")}
          value={summary.costBasisHash ?? na}
          caption={t(locale, "portfolio.basis-aid")}
        />
        <StatCard
          label={t(locale, "portfolio.realized-label")}
          value={summary.realizedGainHash ?? na}
          caption={t(locale, "portfolio.realized-caption")}
        />
        <StatCard
          label={t(locale, "portfolio.market-value-label")}
          value={na}
          caption={t(locale, "portfolio.market-value-soon")}
        />
      </div>
    </section>
  );
}
