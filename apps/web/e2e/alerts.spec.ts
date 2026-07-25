import { expect, test } from "@playwright/test";

// Alerts, offline (plan 6.2 §3 commit C) against the fixture-backed server.
// Offline there is no session (no wallet), so the bell shows the 4.1 advert
// verbatim and the personal `/alerts/*` resource routes answer 401. The
// authenticated bell/settings/mark-read flow needs a real session — that is
// e2e-live/alerts.spec.ts's job, the portfolio.spec precedent.

test("the anonymous alerts advert is unchanged (no bell button)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Alerts arrive with wallet support")).toBeVisible();
  // The interactive bell only renders for a session; anonymous has no button.
  await expect(page.getByRole("button", { name: /Alerts,/ })).toHaveCount(0);
});

test("personal alert routes reject anonymous requests with 401", async ({ page }) => {
  const notifications = await page.request.get("/alerts/notifications");
  expect(notifications.status()).toBe(401);
  const rules = await page.request.get("/alerts/rules");
  expect(rules.status()).toBe(401);
  // POST is equally gated.
  const post = await page.request.post("/alerts/rules", {
    data: { kind: "vault_status", enabled: true },
  });
  expect(post.status()).toBe(401);
});

test("the push-subscription route rejects anonymous requests (M6.3)", async ({ page }) => {
  // The per-browser opt-in is session-gated: POST and DELETE both 401 without
  // a session. The authenticated opt-in states (unsupported/not-configured/
  // enable/disable) need a real session + browser push and ride the live lane
  // (the M6.2 authenticated-settings precedent — offline has no session).
  const post = await page.request.post("/push/subscription", {
    data: { endpoint: "https://push.example/ep", keys: { p256dh: "x", auth: "y" } },
  });
  expect(post.status()).toBe(401);
  const del = await page.request.delete("/push/subscription");
  expect(del.status()).toBe(401);
});
