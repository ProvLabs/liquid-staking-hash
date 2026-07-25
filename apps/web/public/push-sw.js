// nvHASH Web Push service worker (app plan 6.3 §2.2). Static, framework-free,
// served straight from `public/` with NO bundler involvement — auditable as
// one small file. It holds NO keys, performs NO fetches (no `fetch` handler),
// and caches NOTHING. Its only jobs:
//   * `push`             → render a notification from the minimal push payload
//   * `notificationclick` → focus an existing App tab or open the deep link
//
// The push payload is the closed `{ kind, url }` shape (plan §2.3, invariant 3
// — no amounts, no addresses, no identifiers beyond the kind). Title/body are
// GENERIC per-kind copy derived HERE, so the third-party push service never
// carries user-identifying text. v1 is `en`-only (app-spec §14.9); when a
// locale is added, this map is revisited alongside the deep-link locale-root
// note (the M6.2 precedent).

"use strict";

// Generic, identifier-free per-kind copy. Mirrors the `alerts.push.*` intent
// in app/i18n/locales/en.ts; kept static here because the SW has no catalog.
var KIND_COPY = {
  nav_step_posted: { title: "nvHASH", body: "A new epoch has settled — see your portfolio." },
  redemption_update: { title: "nvHASH", body: "A redemption update is waiting in your portfolio." },
  vault_status: { title: "nvHASH", body: "Program status changed — open nvHASH to see the current state." },
  validator_set_incident: { title: "nvHASH", body: "A validator-set update is available in nvHASH." },
  operator_arrears: { title: "nvHASH", body: "One of your validators still has commission owed." },
};
var FALLBACK = { title: "nvHASH", body: "You have a new nvHASH notification." };

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    data = {};
  }
  var kind = typeof data.kind === "string" ? data.kind : "";
  // App-relative deep links only, by the SAME character allowlist the server
  // enforces (pushPayloadSchema) — not a blocklist: URL canonicalization
  // treats "\" as "/", so "/\attacker.example" would otherwise resolve
  // off-origin. Anything not matching falls back to the App root.
  var url =
    typeof data.url === "string" && /^\/(?:[A-Za-z0-9_-][A-Za-z0-9/_-]*)?$/.test(data.url)
      ? data.url
      : "/";
  var copy = Object.prototype.hasOwnProperty.call(KIND_COPY, kind) ? KIND_COPY[kind] : FALLBACK;
  event.waitUntil(
    self.registration.showNotification(copy.title, {
      body: copy.body,
      // The click target; nothing identifying rides here (plan §2.3).
      data: { url: url },
      tag: kind || "nvhash",
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async function () {
      var windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (var i = 0; i < windows.length; i++) {
        var client = windows[i];
        if ("focus" in client) {
          try {
            if ("navigate" in client) await client.navigate(url);
          } catch (_err) {
            // Cross-origin or detached client: fall through to focus only.
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});
