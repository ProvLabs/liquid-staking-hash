import { useRouteLoaderData } from "react-router";

import { t, type Locale } from "~/i18n";
import type { loader as rootLoader } from "~/root";

// Per-figure console deep links (app-spec §12.2). The map is CLOSED and total:
// a target without a console path is a type error (the `satisfies` below),
// and every href is prefixed by the booted consoleUrl, whose chain id the
// boot check already proved matches ours, so a link can never cross
// environments. Gated by test/verify-link.test.ts.
//
// Paths confirmed against the console's router (apps/console/src/App.tsx).
// Entity anchors (app-spec §14.13; grammar authority: console-spec §14
// item 9) are URL FRAGMENTS appended after the path — they never reach the
// static host, so the environment lock is untouched. The anchor union is
// keyed by target so an anchor cannot attach to a target with no row for it:
// the impossible link is unrepresentable, not validated.
export type VerifyTarget = "overview" | "epoch-ops" | "validators" | "redemptions" | "governance";

export const CONSOLE_VIEW_PATHS = {
  overview: "",
  "epoch-ops": "epoch",
  validators: "validators",
  redemptions: "redemptions",
  governance: "governance",
} as const satisfies Record<VerifyTarget, string>;

/** The entity anchor each target's console view can land on. `epoch-ops` has
 *  no anchored entity, so no anchor type exists for it. */
export type VerifyAnchorFor<T extends VerifyTarget> = T extends "overview"
  ? { epochIndex: number }
  : T extends "validators"
    ? { valoper: string }
    : T extends "redemptions"
      ? { requestId: number }
      : T extends "governance"
        ? { proposalId: string }
        : never;

// The four golden fragments, cross-pinned with apps/console/test/anchors.test.ts
// (the two codebases cannot share code — ADR-001 Decision 4 — so both suites
// pin the same strings and drift fails whichever side moved).
function anchorFragment<T extends VerifyTarget>(
  target: T,
  anchor: VerifyAnchorFor<T>,
): string | null {
  switch (target) {
    case "overview": {
      const { epochIndex } = anchor as VerifyAnchorFor<"overview">;
      return Number.isSafeInteger(epochIndex) && epochIndex >= 0 ? `#epoch-${epochIndex}` : null;
    }
    case "validators": {
      const { valoper } = anchor as VerifyAnchorFor<"validators">;
      return /^[a-z][a-z0-9]{7,89}$/.test(valoper) ? `#val-${valoper}` : null;
    }
    case "redemptions": {
      const { requestId } = anchor as VerifyAnchorFor<"redemptions">;
      return Number.isSafeInteger(requestId) && requestId >= 0 ? `#req-${requestId}` : null;
    }
    case "governance": {
      const { proposalId } = anchor as VerifyAnchorFor<"governance">;
      return /^\d{1,20}$/.test(proposalId) ? `#prop-${proposalId}` : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve a verify target to its environment-locked console href, optionally
 * anchored to an entity row. A value outside the anchor grammar yields the
 * PLAIN view href rather than a malformed fragment — a page-level link is
 * honest; a broken anchor string is not.
 */
export function verifyHref<T extends VerifyTarget>(
  consoleUrl: string,
  target: T,
  anchor?: VerifyAnchorFor<T>,
): string {
  const base = `${consoleUrl.replace(/\/+$/, "")}/${CONSOLE_VIEW_PATHS[target]}`;
  if (anchor === undefined) return base;
  const fragment = anchorFragment(target, anchor);
  return fragment === null ? base : `${base}${fragment}`;
}

/** Quiet §11 affordance: an inline "verify on the console" deep link. */
export function VerifyLink<T extends VerifyTarget>({
  locale,
  target,
  anchor,
}: {
  locale: Locale;
  target: T;
  anchor?: VerifyAnchorFor<T>;
}) {
  const data = useRouteLoaderData<typeof rootLoader>("root");
  if (!data) return null;
  return (
    <a
      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
      href={verifyHref(data.clientConfig.consoleUrl, target, anchor)}
      rel="noreferrer"
      target="_blank"
    >
      {t(locale, "chrome.console-link")} ↗
    </a>
  );
}
