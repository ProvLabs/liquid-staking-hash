import type { Locale } from "~/i18n";
import { t } from "~/i18n";
import type { Completeness } from "~/api/completeness";
import { VerifyLink } from "~/components/verify-link";
import type { SetHealthPublic } from "~/validators/types";
import type { FreshnessMeta } from "@nvhash/api-types";

// §8.6 set-health aggregates: the live eligible count plus the indexed
// set-health projection (total enrollments ever / active / eligible). A null
// projection (API unreachable or off-shape) renders "n/a" on the indexed
// tiles, never a number (§12.1). The per-settlement eligible-count TREND has
// no serving endpoint yet and is a recorded §8.6 follow-on.
//
// The indexed tiles' caption carries the completeness tri-state: "partial"
// says the registry outgrew the served set (never an unlabeled prefix), and
// "unknown" (older API, no flag) withholds the completeness claim rather than
// asserting totality. Gated by test/validators-data.test.ts.

function Tile({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
    </div>
  );
}

export function SetHealth({
  locale,
  eligibleCount,
  setHealth,
}: {
  locale: Locale;
  eligibleCount: number | null;
  setHealth: { data: SetHealthPublic; completeness: Completeness; meta: FreshnessMeta } | null;
}) {
  const na = t(locale, "validators.na");
  const indexedCaption =
    setHealth === null || setHealth.completeness === "complete"
      ? t(locale, "validators.health-indexed-caption")
      : setHealth.completeness === "partial"
        ? t(locale, "validators.health-partial")
        : t(locale, "validators.health-completeness-unknown");
  return (
    <section aria-label={t(locale, "validators.health-title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "validators.health-title")}</h2>
        <VerifyLink locale={locale} target="validators" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Tile
          label={t(locale, "validators.health-eligible-now")}
          value={eligibleCount !== null ? String(eligibleCount) : na}
        />
        <Tile
          label={t(locale, "validators.health-active")}
          value={setHealth !== null ? String(setHealth.data.active) : na}
          caption={indexedCaption}
        />
        <Tile
          label={t(locale, "validators.health-total")}
          value={setHealth !== null ? String(setHealth.data.total) : na}
          caption={indexedCaption}
        />
      </div>
    </section>
  );
}
