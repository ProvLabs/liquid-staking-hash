import { useRouteLoaderData } from "react-router";

import { t, type Locale } from "~/i18n";
import type { loader as rootLoader } from "~/root";

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
