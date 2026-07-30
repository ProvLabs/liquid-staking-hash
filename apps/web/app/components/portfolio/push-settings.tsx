import { useEffect, useState } from "react";
import { useRouteLoaderData } from "react-router";

import type { ClientConfig } from "~/config/client";
import { t, type Locale } from "~/i18n";

// Push settings (app-spec §10.4) — the per-browser "Push
// notifications on this device" block inside the alert-settings section. The
// browser permission states render HONESTLY (invariant 7): no
// silent no-ops.
//
//   * unsupported     — no Push/Notification API in this browser.
//   * not-configured  — no VAPID public key for this environment (devnet
//                       default; no subscribe path exists).
//   * denied          — blocked at the browser: say so, point at browser
//                       settings.
//   * prompt          — an Enable button (triggers the permission prompt).
//   * subscribed       — an on-state + a Disable button.
//
// Per-browser scope is stated in the copy: enabling here enables THIS browser
// only. The VAPID public key crosses via the root loader's client-safe config;
// the private key never reaches the browser (§7). The service worker
// (/push-sw.js) holds no keys and performs no fetches.

/** Decode a base64url VAPID public key to the bytes `subscribe` expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Construct over a fresh ArrayBuffer so the type is a plain (non-shared)
  // Uint8Array<ArrayBuffer>, which `applicationServerKey`'s BufferSource wants.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

type Support = "checking" | "supported" | "unsupported";

export function PushSettings({ locale }: { locale: Locale }) {
  const root = useRouteLoaderData("root") as { clientConfig?: ClientConfig } | undefined;
  const vapidKey = root?.clientConfig?.webPushVapidPublicKey;

  const [support, setSupport] = useState<Support>("checking");
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-only capability + current-state probe (SSR renders "checking").
  useEffect(() => {
    if (
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      typeof window === "undefined" ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setSupport("unsupported");
      return;
    }
    setSupport("supported");
    setPermission(Notification.permission);
    void navigator.serviceWorker
      .getRegistration("/push-sw.js")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setSubscribed(sub != null))
      .catch(() => setSubscribed(false));
  }, []);

  async function enable() {
    if (vapidKey === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
      const registration = await navigator.serviceWorker.register("/push-sw.js");
      await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const res = await fetch("/push/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        }),
      });
      if (!res.ok) throw new Error("subscription save failed");
      setSubscribed(true);
    } catch {
      setError(t(locale, "alerts.push.error"));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const registration =
        (await navigator.serviceWorker.getRegistration("/push-sw.js")) ??
        (await navigator.serviceWorker.ready);
      const sub = await registration?.pushManager.getSubscription();
      if (sub != null) await sub.unsubscribe();
      // Best-effort server delete; the row is also removed on logout/expiry.
      await fetch("/push/subscription", { method: "DELETE" });
      setSubscribed(false);
    } catch {
      setError(t(locale, "alerts.push.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <h3 className="font-medium">{t(locale, "alerts.push.title")}</h3>
      <p className="text-sm text-muted-foreground">{t(locale, "alerts.push.lede")}</p>
      {renderState()}
      {error !== null ? (
        <p className="text-sm text-[color:var(--status-serious)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );

  function renderState() {
    if (support === "checking") {
      return <p className="text-sm text-muted-foreground">{t(locale, "alerts.push.checking")}</p>;
    }
    if (support === "unsupported") {
      return <p className="text-sm text-muted-foreground">{t(locale, "alerts.push.unsupported")}</p>;
    }
    if (vapidKey === undefined) {
      return <p className="text-sm text-muted-foreground">{t(locale, "alerts.push.not-configured")}</p>;
    }
    if (permission === "denied") {
      return <p className="text-sm text-muted-foreground">{t(locale, "alerts.push.denied")}</p>;
    }
    if (subscribed) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{t(locale, "alerts.push.enabled")}</span>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            onClick={disable}
            disabled={busy}
          >
            {busy ? t(locale, "alerts.push.working") : t(locale, "alerts.push.disable")}
          </button>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{t(locale, "alerts.push.per-browser")}</span>
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          onClick={enable}
          disabled={busy}
        >
          {busy ? t(locale, "alerts.push.working") : t(locale, "alerts.push.enable")}
        </button>
      </div>
    );
  }
}
