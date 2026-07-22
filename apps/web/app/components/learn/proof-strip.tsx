import { VerifyLink } from "~/components/verify-link";
import { t, type Locale } from "~/i18n";
import { formatAgeSince, formatDuration } from "~/learn/duration";
import type { LearnData } from "~/learn/types";

// §8.1.2 live proof strip. Live figures come from this request's chain reads;
// indexed figures (participants, program age) render "n/a" while their plane
// reports nulls (§12.1: null is "not yet known", never a fabricated number).
// Every tile carries the quiet verify affordance (§11, §12.2).

function Tile({
  label,
  value,
  caption,
  verify,
}: {
  label: string;
  value: string;
  caption?: string;
  verify: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
      {verify}
    </div>
  );
}

export function ProofStrip({
  locale,
  data,
  nowMs,
}: {
  locale: Locale;
  data: LearnData;
  nowMs: number;
}) {
  const na = t(locale, "learn.stat-na");
  const verify = <VerifyLink locale={locale} target="overview" />;
  const metrics = data.metrics?.data ?? null;

  const aprValue = data.live.aprInsufficientHistory
    ? t(locale, "learn.stat-apr-na")
    : data.live.netAprPercent !== null
      ? `${data.live.netAprPercent}%`
      : na;
  const aprCaption =
    data.live.grossAprPercent !== null && data.live.aprWindowSeconds !== null
      ? t(locale, "learn.stat-apr-caption", {
          gross: data.live.grossAprPercent,
          window: formatDuration(data.live.aprWindowSeconds),
        })
      : undefined;

  return (
    <section aria-label={t(locale, "learn.proof-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "learn.proof-title")}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile
          label={t(locale, "learn.stat-nav")}
          value={data.live.nav ?? na}
          caption={t(locale, "learn.stat-nav-caption")}
          verify={verify}
        />
        <Tile
          label={t(locale, "learn.stat-apr")}
          value={aprValue}
          caption={aprCaption}
          verify={verify}
        />
        <Tile
          label={t(locale, "learn.stat-tvl")}
          value={data.live.tvl ?? na}
          caption={t(locale, "learn.stat-tvl-caption")}
          verify={verify}
        />
        <Tile
          label={t(locale, "learn.stat-participants")}
          value={metrics?.participant_count !== null && metrics?.participant_count !== undefined ? String(metrics.participant_count) : na}
          caption={t(locale, "learn.stat-indexed-caption")}
          verify={verify}
        />
        <Tile
          label={t(locale, "learn.stat-age")}
          value={
            metrics?.program_started_at
              ? formatAgeSince(metrics.program_started_at, nowMs)
              : na
          }
          caption={t(locale, "learn.stat-indexed-caption")}
          verify={verify}
        />
        <Tile
          label={t(locale, "learn.stat-validators")}
          value={
            data.live.eligibleValidators !== null ? String(data.live.eligibleValidators) : na
          }
          verify={<VerifyLink locale={locale} target="validators" />}
        />
      </div>
    </section>
  );
}
