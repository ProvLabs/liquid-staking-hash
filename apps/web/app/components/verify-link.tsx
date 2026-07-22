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
// `governance` is deliberately absent: the console has no governance panel
// yet, and a verify link must never be a dead link. Adding the target is a
// console follow-on alongside the §14.13 entity-level anchors.
export type VerifyTarget = "overview" | "epoch-ops" | "validators" | "redemptions";

export const CONSOLE_VIEW_PATHS = {
  overview: "",
  "epoch-ops": "epoch",
  validators: "validators",
  redemptions: "redemptions",
} as const satisfies Record<VerifyTarget, string>;

/** Resolve a verify target to its environment-locked console href. */
export function verifyHref(consoleUrl: string, target: VerifyTarget): string {
  return `${consoleUrl.replace(/\/+$/, "")}/${CONSOLE_VIEW_PATHS[target]}`;
}

/** Quiet §11 affordance: an inline "verify on the console" deep link. */
export function VerifyLink({ locale, target }: { locale: Locale; target: VerifyTarget }) {
  const data = useRouteLoaderData<typeof rootLoader>("root");
  if (!data) return null;
  return (
    <a
      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
      href={verifyHref(data.clientConfig.consoleUrl, target)}
      rel="noreferrer"
      target="_blank"
    >
      {t(locale, "chrome.console-link")} ↗
    </a>
  );
}
