import type { ClientConfig } from "~/config/client";
import { t, type Locale } from "~/i18n";

// §8.0 environment badge: quiet on production, loud (warning-tinted, labeled)
// everywhere else. Status color never carries state alone: the non-production
// badge pairs the tint with an icon and the environment name.
export function EnvBadge({
  locale,
  appEnv,
  chainId,
}: {
  locale: Locale;
  appEnv: ClientConfig["appEnv"];
  chainId: string;
}) {
  if (appEnv === "production") {
    return <span className="text-xs text-muted-foreground">{chainId}</span>;
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium"
      style={{
        borderColor: "var(--status-warning)",
        backgroundColor: "color-mix(in srgb, var(--status-warning) 15%, transparent)",
      }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 16 16"
        className="h-3 w-3"
        style={{ fill: "var(--status-warning)" }}
      >
        <path d="M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5.5v1.5h1.5V11.5h-1.5Z" />
      </svg>
      {t(locale, `chrome.env-${appEnv}`)} · {chainId}
    </span>
  );
}
