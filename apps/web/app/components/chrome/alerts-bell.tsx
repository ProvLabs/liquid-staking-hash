import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import { t, type Locale } from "~/i18n";

// §8.0 / M6.2: anonymous users see the alerting feature advertised (the 4.1
// advert, verbatim); a connected session sees the real bell + unread badge and
// a popover that fetches /alerts/notifications and posts mark-read. Only the
// unread integer arrives from the root loader; the notifications themselves are
// fetched on open (never eagerly serialized into every page).

interface NotificationView {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  delivered_at: string;
  read_at: string | null;
}

/** The surface each kind deep-links to (validator-set → /validators until 6.4). */
function linkFor(kind: string): string {
  switch (kind) {
    case "redemption_update":
      return "/exit";
    case "operator_arrears":
    case "validator_set_incident":
      return "/validators";
    default:
      return "/portfolio";
  }
}

function incidentWord(locale: Locale, incident: unknown): string {
  switch (incident) {
    case "vault_paused":
      return t(locale, "alerts.incident.vault-paused");
    case "contract_halted":
      return t(locale, "alerts.incident.contract-halted");
    case "jail_report":
      return t(locale, "alerts.incident.jail-report");
    case "slash_write_down":
      return t(locale, "alerts.incident.slash-write-down");
    default:
      return String(incident);
  }
}

/** Render a notification's copy from its identifiers + i18n (never a stored amount). */
function notificationText(locale: Locale, n: NotificationView): string {
  const p = n.payload;
  switch (n.kind) {
    case "nav_step_posted":
      return t(locale, "alerts.notif.nav-step-posted", { epoch: String(p.epoch_index) });
    case "redemption_update": {
      // Literal key per branch (not a computed key) so the i18n gate can verify
      // each message's {request} placeholder at the call site.
      const request = String(p.request_id);
      if (p.event === "expedited") return t(locale, "alerts.notif.redemption-expedited", { request });
      if (p.event === "refunded") return t(locale, "alerts.notif.redemption-refunded", { request });
      return t(locale, "alerts.notif.redemption-matured", { request });
    }
    case "vault_status":
      return t(locale, "alerts.notif.vault-status", { incident: incidentWord(locale, p.incident_kind) });
    case "validator_set_incident":
      return t(locale, "alerts.notif.validator-set-incident", { incident: incidentWord(locale, p.incident_kind) });
    case "operator_arrears":
      return t(locale, "alerts.notif.operator-arrears", { valoper: String(p.valoper), epoch: String(p.epoch_index) });
    default:
      return n.kind;
  }
}

export function AlertsBell({
  locale,
  sessionAddress,
  unreadCount,
}: {
  locale: Locale;
  sessionAddress: string | null;
  unreadCount: number | null;
}) {
  // Anonymous branch: the 4.1 advert, unchanged (§8.0).
  if (sessionAddress === null) {
    return (
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {t(locale, "chrome.alerts-advert")}
      </span>
    );
  }

  return <AlertsBellPopover locale={locale} initialUnread={unreadCount ?? 0} />;
}

function AlertsBellPopover({ locale, initialUnread }: { locale: Locale; initialUnread: number }) {
  const [open, setOpen] = useState(false);
  // TWO fetchers: the list survives a mark-read POST (one shared fetcher would
  // replace the list data with the mark-read result and blank the popover).
  const listFetcher = useFetcher();
  const markFetcher = useFetcher();
  const containerRef = useRef<HTMLDivElement>(null);

  const listData = listFetcher.data as { notifications?: NotificationView[]; unread?: number } | undefined;
  const markData = markFetcher.data as { unread?: number } | undefined;
  const notifications = listData?.notifications ?? [];
  // The freshest unread wins: a completed mark-read supersedes the list load,
  // which supersedes the loader's initial integer.
  const unread = markData?.unread ?? listData?.unread ?? initialUnread;

  // Load the list the first time the popover opens.
  useEffect(() => {
    if (open && listFetcher.state === "idle" && listData === undefined) {
      listFetcher.load("/alerts/notifications");
    }
  }, [open, listFetcher, listData]);

  // After a mark-read completes, refresh the list ONCE so read states are
  // honest (the ref guards against re-firing on the reload's own re-renders).
  const handledMark = useRef<unknown>(undefined);
  useEffect(() => {
    if (markFetcher.state === "idle" && markData !== undefined && handledMark.current !== markData) {
      handledMark.current = markData;
      listFetcher.load("/alerts/notifications");
    }
  }, [markFetcher.state, markData, listFetcher]);

  // Close on Escape / outside click (keyboard + pointer parity).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const markAllRead = () => {
    markFetcher.submit(JSON.stringify({ all: true }), {
      method: "post",
      action: "/alerts/notifications",
      encType: "application/json",
    });
  };

  const label = unread > 0 ? t(locale, "alerts.bell-aria", { count: unread }) : t(locale, "alerts.bell-aria-none");

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="relative inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
        aria-label={label}
        aria-expanded={open}
        aria-controls="alerts-popover"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        <span className="hidden sm:inline">{t(locale, "alerts.bell-label")}</span>
        {unread > 0 ? (
          <span className="ml-1 rounded-full bg-[var(--status-serious)] px-1.5 text-[10px] font-semibold text-white">
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id="alerts-popover"
          role="region"
          aria-label={t(locale, "alerts.bell-label")}
          className="absolute right-0 z-50 mt-2 flex w-80 max-w-[90vw] flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold">{t(locale, "alerts.bell-label")}</span>
            {notifications.some((n) => n.read_at === null) ? (
              <button type="button" className="text-xs underline" onClick={markAllRead}>
                {t(locale, "alerts.mark-all-read")}
              </button>
            ) : null}
          </div>

          {listFetcher.state !== "idle" && listData === undefined ? (
            <p className="text-muted-foreground">{t(locale, "alerts.loading")}</p>
          ) : notifications.length === 0 ? (
            <p className="text-muted-foreground">{t(locale, "alerts.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`rounded-md border p-2 ${n.read_at === null ? "border-[var(--status-serious)]" : "border-transparent bg-muted/40"}`}
                >
                  <Link to={linkFor(n.kind)} onClick={() => setOpen(false)} className="block">
                    <span>{notificationText(locale, n)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
