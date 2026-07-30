import { t, type Locale } from "~/i18n";
import type { ProposalPlane } from "~/governance/types";

// WHICH READ produced the figures beside it (§12.1 freshness, §12.1.1
// live-canonical tallies). This badge is the mechanism that keeps a mirrored
// value from being presented as current: it is rendered wherever a status or a
// tally is, and the `indexed-fallback` case carries the HEIGHT the value was
// observed at rather than a vague "may be stale".
//
// M6.4's stale-registry P1 is the reason it is a component and not a comment: a
// successful-but-old read that looks identical to a fresh one is precisely the
// cell that leaked there.

export function PlaneBadge({
  locale,
  plane,
  observedHeight,
}: {
  locale: Locale;
  plane: ProposalPlane;
  observedHeight: number | null;
}) {
  const height = observedHeight === null ? t(locale, "governance.na") : String(observedHeight);
  const label =
    plane === "live"
      ? t(locale, "governance.plane-live")
      : plane === "live-only"
        ? t(locale, "governance.plane-live-only")
        : plane === "pruned"
          ? t(locale, "governance.plane-pruned")
          : plane === "indexed-fallback"
            ? t(locale, "governance.plane-indexed-fallback", { height })
            : t(locale, "governance.plane-indexed", { height });
  return (
    <span className="text-xs text-muted-foreground" data-plane={plane}>
      {label}
    </span>
  );
}
