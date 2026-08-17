import { useEffect, useState } from "react";

import { describeFreshness, formatAge } from "~/chrome/freshness";
import type { ChromeState } from "~/chrome/types";
import { t, type Locale } from "~/i18n";

// §8.0 footer freshness line: chain id · "indexed to block N (Ns ago)" ·
// console link. A null height or null meta renders "n/a", never a number
// (§9.4/§12.1); a failed live read adds "program status unavailable" instead
// of pretending health. The docs link in the §8.0 diagram is deliberately
// absent: no docs URL exists yet (recorded follow-on).
export function FreshnessFooter({
  locale,
  chainId,
  consoleUrl,
  chrome,
}: {
  locale: Locale;
  chainId: string;
  consoleUrl: string;
  chrome: ChromeState;
}) {
  // SSR paints the age from the server clock; the client re-renders it live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const display = describeFreshness(chrome.freshness, nowMs, chrome.reconciledAt);

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-6 py-3 text-sm text-muted-foreground">
      <span>
        {t(locale, "chrome.chain-label")}: {chainId}
      </span>
      <span suppressHydrationWarning>
        {display.kind === "indexed"
          ? t(locale, "chrome.freshness-indexed", {
              height: display.height,
              age: formatAge(display.ageSeconds),
            })
          : t(locale, "chrome.freshness-na")}
      </span>
      {chrome.liveStatusOk ? null : <span>{t(locale, "chrome.status-unavailable")}</span>}
      <a
        className="underline underline-offset-4 hover:text-foreground"
        href={consoleUrl}
        rel="noreferrer"
        target="_blank"
      >
        {t(locale, "chrome.console-link")} ↗
      </a>
    </footer>
  );
}
