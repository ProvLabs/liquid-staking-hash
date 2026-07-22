import type { ChromeBanner } from "~/chrome/types";
import { t, type Locale, type MessageKey } from "~/i18n";

// §8.0 banner slot, rendered only when ChromeState.banner is non-null (§12.1:
// a banner mirrors a true program state, never an assumption). Severity is
// aligned with console-spec §11.2: paused → --status-serious, halted →
// --status-critical, degraded → --status-warning. Every state ships icon +
// label + one plain-language consequence sentence (§11: explanation is
// first-class); color never carries the state alone.
const VARIANTS: Record<
  ChromeBanner["kind"],
  { token: string; labelKey: MessageKey; consequenceKey: MessageKey; iconPath: string }
> = {
  halted: {
    token: "var(--status-critical)",
    labelKey: "chrome.banner-halted-label",
    consequenceKey: "chrome.banner-halted-consequence",
    // octagon
    iconPath:
      "M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1L5.1 1Zm.7 4.9L7.1 8l-1.3 2.1 1.1 1.1L8 9.9l1.1 1.3 1.1-1.1L8.9 8l1.3-2.1-1.1-1.1L8 6.1 6.9 4.8 5.8 5.9Z",
  },
  paused: {
    token: "var(--status-serious)",
    labelKey: "chrome.banner-paused-label",
    consequenceKey: "chrome.banner-paused-consequence",
    // pause bars
    iconPath: "M4 2h3v12H4V2Zm5 0h3v12H9V2Z",
  },
  degraded: {
    token: "var(--status-warning)",
    labelKey: "chrome.banner-degraded-label",
    consequenceKey: "chrome.banner-degraded-consequence",
    // triangle
    iconPath: "M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5.5v1.5h1.5V11.5h-1.5Z",
  },
};

export function Banner({ locale, banner }: { locale: Locale; banner: ChromeBanner | null }) {
  if (banner === null) return null;
  const variant = VARIANTS[banner.kind];
  return (
    <div
      role="status"
      className="border-b px-6 py-3 text-sm"
      style={{
        borderLeft: `4px solid ${variant.token}`,
        backgroundColor: `color-mix(in srgb, ${variant.token} 12%, transparent)`,
      }}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          className="h-4 w-4 shrink-0"
          style={{ fill: variant.token }}
        >
          <path d={variant.iconPath} />
        </svg>
        <strong className="font-semibold">{t(locale, variant.labelKey)}</strong>
        <span className="text-muted-foreground">{t(locale, variant.consequenceKey)}</span>
        {banner.kind === "paused" && banner.reason ? (
          <span className="text-muted-foreground">
            {t(locale, "chrome.banner-paused-reason", { reason: banner.reason })}
          </span>
        ) : null}
      </p>
    </div>
  );
}
